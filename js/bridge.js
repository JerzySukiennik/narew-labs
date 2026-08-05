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
          ? `${latest}\n\nMac zamilkł w połowie odpowiedzi — reszty nie będzie.`
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
