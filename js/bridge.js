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
import {
  ref, push, set, remove, onValue, off,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js';

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
export const IMAGE_MODELS = [
  /* Trained to 68000 steps on 2026-08-11 and evaluated against G-Image 2 at the
     same budget, so it exists and gets a wire name. Its OWN name, like G-Image 1
     and for the same reason: 98.3M weights do not fit the 70.5M network, and
     sharing a wire name would hand back one model's output labelled as another. */
  { id: 'g-image-2-1', name: 'G-Image 2.1', desc: '98M · najnowszy', available: false,
    wire: 'g-image-2-1' },
  /* Recommended, and not merely because it is older. Measured head to head at
     68000 steps each: G-Image 2 is better on the edits that have a ground truth
     (black_and_white error 24.3 vs 32.4, inverted 21.5 vs 40.4) and costs 864 ms
     per forward pass against 2.1's 1314 ms. 2.1 wins on some object additions —
     a recognizable balloon where 2 leaves a smudge — which is why it is offered,
     not why it should be the default. */
  { id: 'g-image-2', name: 'G-Image 2', desc: '70M · sprawdzony', available: false,
    wire: IMAGE_WIRE_MODEL, recommended: true },
  /* Chosen deliberately by the owner, and given its OWN wire name rather than
     the shared one. G-Images was rescaled to 70.5M and retrained from scratch on
     2026-08-02, so the 22M weights no longer fit the network the Mac builds.
     Routing this on `g-images` would quietly hand back G-Image 2's output under
     the wrong name; routing it on `g-image-1` means it shows as asleep until the
     Mac actually publishes that checkpoint, and never lies about whose output
     you are looking at. */
  { id: 'g-image-1', name: 'G-Image 1', desc: '22M · pierwsza wersja', available: false,
    wire: 'g-image-1', legacy: true },
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
    }, (e) => end(`Straciłem nasłuch na odpowiedzi: ${e.message}`));

    set(jobRef, {
      model: job.model,
      text: job.text,
      at: Date.now(),
      ...(job.image ? { image: job.image } : {}),
      ...(job.history?.length ? { history: job.history } : {}),
    }).catch((e) => end(`Nie mogę wysłać zadania: ${e.message}`));

    arm();

    return {
      id,
      /* For a view that goes away mid-generation: let go of the node without
         pretending the job ended. */
      dispose: () => { settled = true; detach(); },
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
        const written = set(ref(rtdb, `${base}/jobs/${id}/cancel`), true);
        written.catch((e) => console.warn('Nie zapisałem anulowania:', e.message));
        end(latest || 'Anulowane.');
        return written;
      },
    };
  }
}
