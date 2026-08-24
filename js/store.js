/**
 * The account: profile, tier, usage, referrals and saved conversations.
 *
 * Everything a view needs to know about the signed-in person lives in `state`,
 * and every change goes through this module so there is exactly one place where
 * a tier can be granted or a token counted. Views subscribe; they never write
 * Firestore directly.
 *
 * Two shapes here exist because of the security rules, not because of taste:
 *
 *   users/{uid}/grants  — a mailbox. A referrer cannot be given a week of Lin by
 *                         someone else writing to their account, so the referred
 *                         user drops a grant into this subcollection and the
 *                         referrer's own client applies it on the next load.
 *   usage/{autoId}      — one document per reply, not a running counter. Both
 *                         windows (5 hours and 7 days) are rolling, and you
 *                         cannot roll a counter backwards.
 */

import {
  db, auth, doc, collection, getDoc, getDocs, setDoc, updateDoc, addDoc,
  deleteDoc, query, where, orderBy, limit, serverTimestamp, writeBatch,
} from './firebase.js';
import { resolveClient } from './bridge.js';
import { problem } from './ui.js';

/* ------------------------------------------------------------------ tiers -- */

export const TIERS = {
  plotka: {
    id: 'plotka',
    name: 'Płotka',
    price: 0,
    blurb: 'Mała, szybka, wszędzie jej pełno.',
    /* The middle line used to read "Limit tygodniowy i pięciogodzinny", which
       names a restriction as though it were a feature and gives no number. If
       there is a ceiling, say where it is: someone deciding between plans is
       asking exactly that, and a plan list that dodges the question reads as
       hiding something. */
    perks: ['Chat z G-Micro i G-Mini', 'Ok. 70 tys. znaków na 5 godzin, 430 tys. na tydzień',
            'Historia rozmów zapisana'],
    chat: true,
    image: false,
    video: false,
    limits: { fiveHour: 20_000, week: 120_000 },
  },
  lin: {
    id: 'lin',
    name: 'Lin',
    price: 19,
    blurb: 'Siedzi przy dnie, ale wyciąga więcej.',
    perks: ['Chat bez limitu', 'Image Studio - G-Images, G-Doodle, G-Weird',
            'Historia bez ograniczeń'],
    chat: true,
    image: true,
    video: false,
    limits: { fiveHour: null, week: null },
  },
  sum: {
    id: 'sum',
    name: 'Sum',
    price: 49,
    blurb: 'Największy w tej rzece.',
    perks: ['Wszystko z Lina, bez limitów', 'Video Studio, kiedy powstanie',
            'Pierwszeństwo w kolejce do Maca'],
    chat: true,
    image: true,
    video: true,
    limits: { fiveHour: null, week: null },
  },
};

/* A bar needs a scale even when there is no cap. These are reference points, and
   the UI says so — they never block anything. */
export const REFERENCE = { fiveHour: 60_000, week: 500_000 };

export const WINDOW_MS = { fiveHour: 5 * 60 * 60 * 1000, week: 7 * 24 * 60 * 60 * 1000 };

/** Rough, and labelled as rough wherever it is shown. The bridge streams text,
 *  not token counts, so this is characters divided by an average Polish token. */
export const estimateTokens = (text) => Math.max(1, Math.ceil((text || '').length / 3.6));

/* ------------------------------------------------------------------ state -- */

/**
 * Both totals are read off the clock, never stored.
 *
 * The windows roll continuously, so a sum computed when an event was recorded is
 * already wrong a minute later — an event that aged out of the five hours would
 * keep counting until the page reloaded. Getters keep the old shape
 * (`state.usage.fiveHour`) while making every single read use the current time.
 */
function freshUsage(events = []) {
  const usage = {
    events,
    get fiveHour() { return within(usage.events, WINDOW_MS.fiveHour); },
    get week() { return within(usage.events, WINDOW_MS.week); },
  };
  return usage;
}

function within(events, span) {
  const now = Date.now();
  return (events || [])
    .filter((e) => now - e.at < span)
    .reduce((a, e) => a + (e.tokens || 0), 0);
}

export const state = {
  user: null,          // Firebase user or null
  profile: null,       // Firestore users/{uid} document
  usage: freshUsage(),
  ready: false,
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
}
function emit() { listeners.forEach((fn) => fn(state)); }

/* ---------------------------------------------------------------- helpers -- */

const userRef = () => doc(db, 'users', state.user.uid);
const ms = (v) => (v?.toMillis ? v.toMillis() : typeof v === 'number' ? v : 0);

/** The tier actually in force right now — a grant that ran out is not a tier. */
export function activeTier() {
  const p = state.profile;
  if (!p) return TIERS.plotka;
  const until = ms(p.tierUntil);
  if (until && until < Date.now()) return TIERS[p.baseTier] || TIERS.plotka;
  return TIERS[p.tier] || TIERS.plotka;
}

export function tierExpiresAt() {
  const until = ms(state.profile?.tierUntil);
  return until && until > Date.now() ? until : null;
}

export const can = {
  chat: () => activeTier().chat,
  image: () => activeTier().image,
  video: () => activeTier().video,
};

/**
 * Whether another message is allowed, and if not, why in plain words.
 * Returning the reason here keeps the composer from having to guess.
 */
export function sendAllowance() {
  const tier = activeTier();
  const lim = tier.limits;
  if (lim.fiveHour && state.usage.fiveHour >= lim.fiveHour) {
    return { ok: false, reason: `Limit ${tier.name.toLowerCase()}: ${lim.fiveHour.toLocaleString('pl')} tokenów na 5 godzin. Poczekaj albo wejdź wyżej.` };
  }
  if (lim.week && state.usage.week >= lim.week) {
    return { ok: false, reason: `Limit tygodniowy wyczerpany (${lim.week.toLocaleString('pl')} tokenów).` };
  }
  return { ok: true, reason: '' };
}

/* ------------------------------------------------------------- onboarding -- */

/**
 * Load or create the account document.
 *
 * Runs on every sign-in, so it has to be safe to run twice: the create path is
 * guarded by an existence check, and everything after it is idempotent.
 */
export async function ensureUser(user, { referrer } = {}) {
  state.user = user;
  const ref = doc(db, 'users', user.uid);
  let snap = await getDoc(ref);

  if (!snap.exists()) {
    await setDoc(ref, {
      email: user.email || '',
      photoURL: user.photoURL || '',
      name: '',
      interests: [],
      onboarded: false,
      tier: 'plotka',
      baseTier: 'plotka',
      tierUntil: null,
      clientId: resolveClient(),
      referredBy: null,
      referrals: 0,
      createdAt: serverTimestamp(),
    });
    snap = await getDoc(ref);
    if (referrer && referrer !== user.uid) await claimReferral(referrer);
  }

  state.profile = snap.data();

  /* A second device adopts the first one's bridge slot, so the Mac keeps
     answering into one place instead of two. The account is the source of
     truth here: this browser has already minted a local id by now (the bridge
     is built before auth resolves), and letting that win would mean the slot
     never gets shared. An account that predates the field gets this browser's
     id written up, so the next device has something to adopt. */
  const clientId = resolveClient(state.profile.clientId);
  if (clientId !== state.profile.clientId) {
    await updateDoc(ref, { clientId }).catch((e) => {
      console.warn('Nie zapisałem identyfikatora klienta:', e.message);
    });
    state.profile.clientId = clientId;
  }

  await applyGrants();
  await refreshUsage();
  state.ready = true;
  emit();
  return state.profile;
}

export async function saveProfile(patch) {
  await updateDoc(userRef(), patch);
  state.profile = { ...state.profile, ...patch };
  emit();
}

export const needsOnboarding = () => Boolean(state.user && state.profile && !state.profile.onboarded);

export async function completeOnboarding({ name, interests }) {
  await saveProfile({ name: name.trim().slice(0, 40), interests, onboarded: true });
}

export const firstName = () => (state.profile?.name || state.user?.displayName || '').split(' ')[0] || 'Ty';

/* ----------------------------------------------------------------- tiers -- */

/** Grant a tier for a number of days, or permanently when `days` is null. */
export async function grantTier(tier, days = null) {
  const patch = { tier };
  patch.tierUntil = days ? Date.now() + days * 86_400_000 : null;
  if (!days) patch.baseTier = tier;
  await saveProfile(patch);
}

export const PROMO_CODE_HINT = 'Kod dostaje się od Jurka.';

/**
 * Redeem a promo code.
 *
 * The code is checked against Firestore rather than against a constant in this
 * file, so a code can be turned off without a deploy — and so a wrong answer is
 * a real "no such code" rather than a typo in the bundle.
 */
export async function redeemPromo(raw) {
  const code = (raw || '').trim().toLowerCase();
  if (!code) return { ok: false, message: 'Wpisz kod.' };
  try {
    const snap = await getDoc(doc(db, 'promoCodes', code));
    if (!snap.exists() || snap.data().active === false) {
      return { ok: false, message: 'Nie znam takiego kodu.' };
    }
    const { tier = 'sum', days = null } = snap.data();
    await grantTier(tier, days);
    return { ok: true, message: `Kod przyjęty - masz teraz ${TIERS[tier]?.name || tier}.`, tier };
  } catch (e) {
    return { ok: false, message: `Nie sprawdziłem kodu. ${problem(e)}` };
  }
}

/* -------------------------------------------------------------- referral -- */

export const referralLink = () =>
  `${location.origin}/r/${state.user?.uid || ''}`;

/**
 * Record that this account arrived through someone's link, and pay both sides.
 *
 * The referrer's account is not writable from here, so their week of Lin is
 * left in their grants mailbox instead. The relation itself is a top-level
 * document keyed by the referred user, which is what makes it impossible to
 * claim twice.
 */
async function claimReferral(referrer) {
  try {
    const relation = doc(db, 'referrals', state.user.uid);
    if ((await getDoc(relation)).exists()) return;

    const batch = writeBatch(db);
    batch.set(relation, { referrer, referred: state.user.uid, at: serverTimestamp() });
    batch.set(doc(collection(db, 'users', referrer, 'grants')), {
      tier: 'lin', days: 7, from: state.user.uid, at: serverTimestamp(),
    });
    await batch.commit();

    await updateDoc(userRef(), { referredBy: referrer });
    await grantTier('lin', 7);
  } catch (e) {
    /* A broken referral must never block a sign-in. */
    console.warn('Nie udało się zapisać polecenia:', e.message);
  }
}

/** Apply and clear anything waiting in the grants mailbox. */
async function applyGrants() {
  try {
    const snaps = await getDocs(collection(db, 'users', state.user.uid, 'grants'));
    if (snaps.empty) return;
    let best = null;
    const batch = writeBatch(db);
    snaps.forEach((s) => {
      const g = s.data();
      if (!best || (g.days || 0) > (best.days || 0)) best = g;
      batch.delete(s.ref);
    });
    batch.update(userRef(), { referrals: (state.profile.referrals || 0) + snaps.size });
    await batch.commit();

    state.profile.referrals = (state.profile.referrals || 0) + snaps.size;
    /* A grant never demotes: it only lifts, and only past what is already held. */
    if (best && rank(best.tier) > rank(activeTier().id)) await grantTier(best.tier, best.days);
  } catch (e) {
    console.warn('Nie udało się odebrać nagród:', e.message);
  }
}

const rank = (id) => ['plotka', 'lin', 'sum'].indexOf(id);

/* ----------------------------------------------------------------- usage -- */

export async function recordUsage(tokens, model) {
  if (!state.user || !tokens) return;
  const at = Date.now();
  try {
    await addDoc(collection(db, 'users', state.user.uid, 'usage'), { tokens, model, at });
  } catch (e) {
    console.warn('Nie zapisałem zużycia:', e.message);
  }
  state.usage.events.push({ tokens, at });
  emit();
}

export async function refreshUsage() {
  if (!state.user) return;
  const since = Date.now() - WINDOW_MS.week;
  try {
    const snaps = await getDocs(query(
      collection(db, 'users', state.user.uid, 'usage'),
      where('at', '>=', since), orderBy('at', 'desc'), limit(1000),
    ));
    state.usage.events = snaps.docs.map((d) => d.data());
  } catch (e) {
    console.warn('Nie odczytałem zużycia:', e.message);
    state.usage.events = [];
  }
}

/** What the two bars should draw: how much, out of what, and whether it caps. */
export function usageWindows() {
  const lim = activeTier().limits;
  return [
    {
      key: 'fiveHour', label: '5 godzin',
      used: state.usage.fiveHour,
      scale: lim.fiveHour || REFERENCE.fiveHour,
      capped: Boolean(lim.fiveHour),
    },
    {
      key: 'week', label: 'tydzień',
      used: state.usage.week,
      scale: lim.week || REFERENCE.week,
      capped: Boolean(lim.week),
    },
  ];
}

/* --------------------------------------------------------- conversations -- */

export async function listConversations(max = 60) {
  if (!state.user) return [];
  try {
    const snaps = await getDocs(query(
      collection(db, 'users', state.user.uid, 'conversations'),
      orderBy('updatedAt', 'desc'), limit(max),
    ));
    return snaps.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.warn('Nie odczytałem historii:', e.message);
    return [];
  }
}

export async function loadConversation(id) {
  const snap = await getDoc(doc(db, 'users', state.user.uid, 'conversations', id));
  return snap.exists() ? { id, ...snap.data() } : null;
}

export async function saveConversation({ id, title, model, messages }) {
  if (!state.user || !messages?.length) return id;
  const payload = { title: title.slice(0, 80), model, messages, updatedAt: Date.now() };
  if (id) {
    await setDoc(doc(db, 'users', state.user.uid, 'conversations', id), payload, { merge: true });
    return id;
  }
  const created = await addDoc(collection(db, 'users', state.user.uid, 'conversations'), {
    ...payload, createdAt: Date.now(),
  });
  return created.id;
}

export async function deleteConversation(id) {
  await deleteDoc(doc(db, 'users', state.user.uid, 'conversations', id));
}

/* A Firestore batch takes 500 writes and refuses the 501st, so anything that
   clears a whole subcollection has to go in slices. Nobody's history is that
   long yet; usage is one document per reply, and that one gets there. */
const BATCH_LIMIT = 500;

async function clearSubcollection(name) {
  const snaps = await getDocs(collection(db, 'users', state.user.uid, name));
  for (let i = 0; i < snaps.docs.length; i += BATCH_LIMIT) {
    const batch = writeBatch(db);
    snaps.docs.slice(i, i + BATCH_LIMIT).forEach((s) => batch.delete(s.ref));
    await batch.commit();
  }
}

export async function clearConversations() {
  await clearSubcollection('conversations');
}

/**
 * Remove everything the delete dialog promises will go, then the account.
 *
 * Subcollections do not disappear with their parent document — deleting
 * `users/{uid}` leaves `usage` and `grants` behind as orphans, still holding the
 * token counts the dialog says are gone. They go first, and in that order:
 * whatever fails, fails before the account document is unreachable.
 *
 * Nothing here is swallowed. A half-deleted account that reported success is
 * worse than one that says which step broke, so the error travels up to the
 * confirmation dialog that started it.
 */
export async function deleteAccount() {
  await clearSubcollection('conversations');
  await clearSubcollection('usage');
  await clearSubcollection('grants');
  await deleteDoc(userRef());
  await auth.currentUser.delete();
}

export function resetLocalState() {
  state.user = null;
  state.profile = null;
  state.usage = freshUsage();
  state.ready = false;
  emit();
}
