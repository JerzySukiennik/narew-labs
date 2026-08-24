/**
 * The browser end of the link to the Mac at home.
 *
 * Deliberately the same mechanism G-Micro already runs on, node for node: the
 * page pushes a job under `open/<client>/jobs`, the Mac picks it up and writes
 * the growing answer to `open/<client>/out/<jobId>`, and a heartbeat under
 * `status/mac` says whether anyone is home. Both ends only make outgoing
 * connections, so nothing at home is exposed.
 *
 * Two things are worth knowing before changing anything here:
 *
 *   1. Every write from the Mac carries the *whole* answer so far, not a delta.
 *      A dropped or reordered message therefore cannot leave half a sentence on
 *      screen — but it also means the view has to be replaced, not appended to.
 *   2. The Mac stops writing when the lid closes; it does not write "offline".
 *      Presence has to expire on a timer as well as on a value change.
 */

import { rtdb } from './firebase.js';
import { problem } from './ui.js';
import {
  ref, push, set, remove, onValue, off,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

/*
 * Every job this page has posted and not yet seen finish.
 *
 * Kept so that closing the tab can take them back out of the queue. A job
 * nobody is waiting for still costs the Mac minutes of work, and it used to
 * outlive the page that asked for it: shut the laptop mid-edit and the picture
 * was still rendered, ahead of whoever was actually waiting.
 */
const inFlight = new Set();

/* pagehide rather than beforeunload: Safari on iOS never fires beforeunload
   when an app is swiped away, and this is the one moment that matters most -
   the phone leaves and nothing else will ever clean up after it. */
addEventListener('pagehide', () => {
  for (const drop of inFlight) {
    try { drop(); } catch { /* the page is going away; nothing to report to */ }
  }
});

/* Three missed 20 s beats. Long enough not to call it asleep over one hiccup. */
const STALE_AFTER = 70_000;

const CLIENT_KEY = 'narew.client';

/**
 * This browser's slot in the database.
 *
 * It is not an identity — the account is — but the rules cannot list the tree,
 * so a 128-bit id is what keeps one device's jobs out of another's reach. It is
 * kept in localStorage and mirrored onto the account so a second device can
 * adopt it instead of starting a stranded conversation.
 *
 * The account wins over localStorage, and that order is the whole point. A page
 * load always mints a local id before Firebase says who is signed in, so if the
 * saved value took precedence the adoption branch could never run and every
 * browser would sit in its own slot.
 */
export function resolveClient(adopted) {
  const saved = (localStorage.getItem(CLIENT_KEY) || '').trim();
  if (adopted && adopted.length >= 20) {
    if (adopted !== saved) localStorage.setItem(CLIENT_KEY, adopted);
    return adopted;
  }
  if (saved.length >= 20) return saved;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const id = [...bytes].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 26);
  localStorage.setItem(CLIENT_KEY, id);
  return id;
}

/*
 * The models Chat may offer. The Mac publishes one flat list of everything it
 * can run — text and pictures together — and without this the image versions
 * leaked into the conversation dropdown, where picking one would send a chat
 * message to a model that only edits photographs.
 */
export const CHAT_MODELS = ['g-micro', 'g-mini'];

/** What the app offers when the Mac has never said what it can run. */
export const FALLBACK_MODELS = [
  { id: 'g-micro', name: 'G-Micro', desc: '110M · rozmowa', available: false },
  { id: 'g-mini', name: 'G-Mini', desc: '178M · liczby i dom', available: false },
];

/*
 * The name the image model answers to on the wire, as opposed to the version
 * names below. The Mac routes on this string and the database rules accept
 * only it, `g-micro` and `g-mini` — a job carrying a version id is rejected
 * with PERMISSION_DENIED before the Mac ever sees it. One checkpoint exists
 * today, so version and protocol are not the same axis and should not share
 * an identifier.
 */
export const IMAGE_WIRE_MODEL = 'g-images';

/*
 * Image models, newest first. `legacy` keeps a version in the picker without
 * putting it in the way — superseded models stay reachable because a newer one
 * is not automatically better at everything, but the default should be the one
 * we would recommend.
 */
/*
 * `wire` is what the Mac is asked for, and its absence means the version does
 * not exist yet — no checkpoint has been trained, so it can never be ready and
 * must never be submitted. Only versions carrying a wire name can go online.
 *
 * Today every real version maps to the same wire name, because there is one
 * checkpoint. When a second one is trained the Mac will publish a second id and
 * this table gains a row; nothing else has to change.
 */
/*
 * The three things this screen can be, before any version is chosen.
 *
 * A version number is an answer to "which G-Images", never to "what do I want
 * to do here" - and the second question comes first. Someone arriving wants to
 * edit a photo, draw, or paint from words; that they will then be served by
 * checkpoint 2.1 rather than 1 is a detail of the first answer, so it belongs
 * one level down rather than flattened into the same list.
 */
export const MODEL_FAMILIES = [
  { id: 'images', name: 'G-Images', tagline: 'Zmienia zdjęcie, które wgrasz.' },
  { id: 'doodle', name: 'G-Doodle', tagline: 'Rysuje kreską to, co nazwiesz.' },
  { id: 'weird', name: 'G-Weird', tagline: 'Maluje obraz z samego tekstu.' },
];

export const IMAGE_MODELS = [
  /* The file landed on 2026-08-19, so the wire is restored exactly as the note
     below prescribed. The 68000-step checkpoint was slimmed on Kaggle to the EMA
     weights alone - 393 MB instead of 1573 MB, since the optimizer state only
     matters for resuming training, which happens there and never here - then
     registered in the bridge as its own version with base_channels 152.
     Its OWN wire name, like G-Image 1 and for the same reason: 98.3M weights do
     not fit the 70.5M network, so sharing a wire would hand back one model's
     output labelled as another.
     Previously, and correctly at the time: no wire, because every ckpt.pt under
     G-Images/kaggle-run was read on 2026-08-18 and the largest was 70.5M. Giving
     it a wire then left it permanently "asleep", which says "wake the Mac and it
     will work" about a model the Mac had never had. */
  /* Not an editor at all: it takes no photo and returns strokes, so picking it
     swaps the whole screen rather than changing which model answers. It sits in
     the same chooser anyway because that is where someone looks to ask "what can
     this page do", and a second picker for one model would be worse. */
  { id: 'g-doodle', name: 'G-Doodle', desc: 'rysuje z tekstu', available: false,
    wire: 'g-doodle', draws: true, family: 'doodle' },

  /* Not an editor either: text in, picture out, no photo at any point — so it
     swaps the screen like G-Doodle rather than changing who answers. Labelled
     0.9 because that is what it is: one training run, soft pictures, frequent
     misses. Calling it 1.0 would present a test as a finished model. */
  /* Two versions of ONE model. The transformer and the codebook are identical;
     only the decoder that turns codes into pixels differs, so the same prompt and
     seed give the same picture rendered two ways. They are listed separately
     because the version slider is how this page expresses exactly that — a
     ladder within a family — and 1 is not a different painter, just a steadier
     hand.

     1 is 8000 steps of adversarial fine-tuning with the encoder and codebook
     frozen: reconstruction error 10.3/255 against 15.7, real detail where there
     was smear, at the cost of a fine crackle. 0.9 is the original — softer, more
     oil-painted, and kept because which one reads better is taste. */
  { id: 'g-weird-1', name: 'G-Weird 1', desc: '62M · ostrzejszy dekoder',
    available: false, wire: 'g-weird-1', generates: true, family: 'weird',
    short: '1' },

  { id: 'g-weird', name: 'G-Weird 0.9', desc: '62M · miękki, malowany',
    available: false, wire: 'g-weird', generates: true, family: 'weird',
    short: '0.9' },

  { id: 'g-image-2-1', name: 'G-Image 2.1', desc: '98M · najnowszy', available: false,
    wire: 'g-image-2-1', family: 'images', short: '2.1' },

  /* Bigger, and better at exactly one thing this screen does not do. Both
     versions edited the same photo on 2026-08-19: G-Image 2 got black-and-white
     right and answered the other four presets by pasting a hallucinated object
     into an otherwise untouched frame - a coloured smudge in the reeds for
     "pencil", the whole picture destroyed for "brighter". Its strength is object
     addition, which is why it stays offered and no longer leads. */
  { id: 'g-image-2', name: 'G-Image 2', desc: '70M · lepszy w dodawaniu obiektów',
    available: false, wire: IMAGE_WIRE_MODEL, family: 'images', short: '2' },

  /* Recommended, on measurement rather than on age. The templates here are
     filters, and on filters the 22.4M network is plainly the better model: its
     "pencil" reads as a drawing, its "sunset" as warm evening light, and where
     it fails it restyles the whole scene instead of dropping junk into it. It is
     also about 2.5x faster - two minutes an edit against five.
     Its own wire name, not the shared one: 22.4M weights do not fit the 70.5M
     network, so routing it on `g-images` would hand back G-Image 2's output
     under the wrong name. Not `legacy` any more, because a version buried behind
     "older versions" is a strange place to keep the default. */
  { id: 'g-image-1', name: 'G-Image 1', desc: '22M · najlepszy w filtrach',
    available: false, wire: 'g-image-1', recommended: true, family: 'images', short: '1' },
];

/*
 * The version the app should land on. This used to be "newest that exists",
 * which was the same thing while only one existed. It stopped being the same
 * thing on 2026-08-11: G-Image 2.1 is newer and measurably WORSE on the edits we
 * can score, so landing on it by position would recommend the weaker model. The
 * choice is explicit now, and falls back to newest-with-a-wire.
 */
export const DEFAULT_IMAGE_MODEL =
  (IMAGE_MODELS.find((m) => m.recommended && m.wire)
    || IMAGE_MODELS.find((m) => m.wire)
    || IMAGE_MODELS[0]).id;

export class MacBridge {
  constructor(client, { onPresence } = {}) {
    this.client = client;
    this.onPresence = onPresence;
    this.online = false;
    this.lastBeat = 0;
    this.models = null;

    /* Presence sits outside the per-client tree because a device has to learn
       whether the Mac is awake before it has written anything of its own. */
    onValue(ref(rtdb, 'status/mac'), (snap) => {
      const v = snap.val() || {};
      this.lastBeat = v.at || 0;
      this.models = Array.isArray(v.models) && v.models.length ? v.models : null;
      this._set(Boolean(v.online) && Date.now() - this.lastBeat < STALE_AFTER);
    }, () => this._set(false));

    this._timer = setInterval(() => {
      if (this.online && Date.now() - this.lastBeat > STALE_AFTER) this._set(false);
    }, 10_000);
  }

  /* Always announces the first answer, even when it is "no". Until the database
     replies once, the app genuinely does not know, and a UI stuck on "checking"
     is indistinguishable from a UI that is broken. */
  _set(value) {
    const changed = value !== this.online || !this.answered;
    this.answered = true;
    this.online = value;
    if (changed || this.models) this.onPresence?.(value, this.modelList());
  }

  /** The Mac's list when it has published one, otherwise the known family. */
  modelList() {
    if (!this.models) {
      return FALLBACK_MODELS.map((m) => ({ ...m, available: false }));
    }
    return this.models.map((m) => ({ ...m, available: this.online && m.available !== false }));
  }

  isAvailable(modelId) {
    return this.modelList().some((m) => m.id === modelId && m.available);
  }

  /**
   * Move this bridge onto another slot.
   *
   * The bridge is built at boot, before Firebase has said who is signed in, so
   * it starts on whatever id this browser had locally. Once the account turns
   * out to carry a different one, everything from then on has to go there —
   * otherwise the Mac answers into a node nobody is reading.
   *
   * Jobs already in flight keep their own refs and are unaffected.
   */
  setClient(id) {
    if (!id || id.length < 20 || id === this.client) return false;
    this.client = id;
    return true;
  }

  /**
   * Post a job and stream its answer.
   *
   * `onUpdate` gets the accumulated state each time, never a delta.
   *
   * `idleTimeout` (ms) is an opt-in dead man's switch: if nothing arrives for
   * that long the handle closes itself and reports it. It is off by default on
   * purpose — a 110M model on a busy laptop can be silent for minutes and still
   * be working, and cutting a real answer off is worse than waiting.
   */
  run(job, onUpdate, { idleTimeout = 0 } = {}) {
    const base = `open/${this.client}`;
    const jobRef = push(ref(rtdb, `${base}/jobs`));
    const id = jobRef.key;
    const outRef = ref(rtdb, `${base}/out/${id}`);

    let settled = false;
    let latest = '';
    let idle = null;

    /* Take the job back out of the queue. The Mac watches for the removal and
       forgets anything it has not started; a job already running is stopped by
       the cancel flag beside it. */
    const drop = () => { remove(jobRef); inFlight.delete(drop); };
    inFlight.add(drop);

    /* Explicit, because `done` used to be the only path that ever detached. A
       cancelled or abandoned generation left a live onValue on the node for the
       rest of the session. */
    const detach = () => {
      if (idle) { clearTimeout(idle); idle = null; }
      off(outRef);
    };

    /* Whoever gets here first owns the ending; everyone after is a no-op. */
    const settle = () => {
      if (settled) return false;
      settled = true;
      detach();
      remove(outRef);
      inFlight.delete(drop);
      return true;
    };

    const end = (text) => { if (settle()) onUpdate({ text, done: true }); };

    const arm = () => {
      if (!idleTimeout) return;
      clearTimeout(idle);
      idle = setTimeout(() => {
        end(latest
          ? `${latest}\n\nMac zamilkł w połowie odpowiedzi - reszty nie będzie.`
          : `Mac nie odezwał się przez ${Math.round(idleTimeout / 1000)} s. Zadanie poszło, odpowiedź nie wróciła.`);
      }, idleTimeout);
    };

    onValue(outRef, (snap) => {
      if (settled) return;
      const v = snap.val();
      if (!v) return;
      arm();
      if (typeof v.text === 'string') latest = v.text;
      onUpdate(v);
      if (v.done) settle();
    }, (e) => end(`Straciłem połączenie w trakcie odpowiedzi. ${problem(e)}`));

    set(jobRef, {
      model: job.model,
      text: job.text,
      at: Date.now(),
      ...(job.image ? { image: job.image } : {}),
      ...(job.history?.length ? { history: job.history } : {}),
    }).catch((e) => end(`Nie wysłałem zadania do Maca. ${problem(e)}`));

    arm();

    return {
      id,
      /* For a view that goes away mid-generation: let go of the node without
         pretending the job ended. */
      /* For a view that goes away mid-generation: let go of the node, and take
         the job with it. Leaving it queued would render a picture into a screen
         that no longer exists. */
      dispose: () => { settled = true; detach(); drop(); },
      /**
       * Written into the job itself, because the Mac is already streaming that
       * node — a cancel lands mid-generation instead of waiting for a poll.
       *
       * The handle closes as soon as the write is issued rather than when it
       * lands: waiting would leave the stream free to deliver more text after
       * the view has already been told the answer is over. The returned promise
       * still carries the real failure, so a caller can say so out loud.
       */
      cancel: () => {
        /* The flag first, then the node. The flag is what stops a generation
           already under way; removing the node is what keeps a job that never
           started from being run later, and what stops a restarted bridge from
           finding it again in the tree and answering a question nobody asked
           any more. */
        const written = set(ref(rtdb, `${base}/jobs/${id}/cancel`), true);
        written.catch((e) => console.warn('Nie zapisałem anulowania:', e.message));
        written.finally(drop);
        /* Whatever had arrived stays, and nothing is added. The person who
           pressed stop knows they pressed stop; captioning it replaces a
           half-answer they might want to keep with a word they already knew. */
        end(latest);
        return written;
      },
    };
  }
}
