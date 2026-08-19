/**
 * The "type it and watch it draw" panel.
 *
 * Kept out of image.js on purpose. That screen is a working, deployed photo
 * editor with its own state machine; this is a different task that happens to
 * share a room with it, and a self-contained module means adding it costs the
 * editor five lines and no new failure modes.
 *
 * The panel is honest about three separate situations, because they are three
 * different things and collapsing them would mislead: the weights are not on
 * the server yet, the word you typed is not one of the 345 the model knows, or
 * it is drawing right now.
 */

import * as doodle from './doodle.js';
import { $, esc, toast, reduced } from './ui.js';

const SUGGESTIONS = ['smok', 'kot', 'ośmiornica', 'zamek', 'pizza', 'pingwin',
                     'wieża eiffla', 'gitara'];

let ui = null;

const TEMPLATE = `
  <section class="studio__step doodle" data-enter>
    <h3 class="studio__step-title">
      <!-- No step number: this panel is the whole screen when G-Doodle is picked,
           and a lone "0" above nothing to follow reads as a numbering bug. -->
      Napisz, a narysuję
    </h3>
    <p class="doodle__lede muted">
      Rysuje kreska po kresce to, co nazwiesz. Zna 345 rzeczy i mówi wprost,
      kiedy czegoś nie zna.
    </p>

    <div class="doodle__grid">
      <div class="doodle__stage">
        <canvas class="doodle__canvas" id="doodle-canvas" width="420" height="420"
                role="img" aria-label="Rysunek modelu"></canvas>
        <p class="doodle__placeholder muted" id="doodle-placeholder">
          Tu pojawi się rysunek
        </p>
      </div>

      <div class="doodle__panel">
        <label class="sr-only" for="doodle-prompt">Co narysować</label>
        <input class="field" id="doodle-prompt" type="text" autocomplete="off"
               placeholder="np. smok" maxlength="60">

        <div class="doodle__chips" id="doodle-chips">
          ${SUGGESTIONS.map((s) => `
            <button type="button" class="doodle__chip" data-word="${esc(s)}">${esc(s)}</button>
          `).join('')}
        </div>

        <button class="btn btn--accent doodle__go" id="doodle-go">Rysuj</button>
        <p class="doodle__status muted" id="doodle-status"></p>
      </div>
    </div>
  </section>`;

function setStatus(html, kind = '') {
  const node = $('#doodle-status', ui.host);
  if (!node) return;
  node.innerHTML = html;
  node.dataset.kind = kind;
}

/** Ask for the weights, reporting megabytes rather than spinning silently. */
async function ensureModel() {
  if (doodle.isReady()) return true;

  setStatus('Pobieram model…');
  try {
    await doodle.load((seen, total) => {
      setStatus(`Pobieram model… ${(seen / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(0)} MB`);
    });
    setStatus('Model gotowy. Rysuje się u Ciebie, nie na serwerze.', 'ok');
    return true;
  } catch (err) {
    if (doodle.state.status === 'missing') {
      setStatus('Model jeszcze się uczy — wagi nie są jeszcze na serwerze. '
                + 'Nic tu nie udaje rysowania.', 'warn');
    } else {
      setStatus(`Nie udało się wczytać modelu: ${esc(err.message)}`, 'warn');
    }
    return false;
  }
}

function describeMiss(result) {
  const alts = (result.alternatives || []).map(doodle.labelOf).filter(Boolean);
  const tail = alts.length
    ? ` Najbliższe, które znam: ${alts.slice(0, 3).map((a) => `<b>${esc(a)}</b>`).join(', ')}.`
    : '';
  return result.match === 'missing'
    ? `Tego nie ma w moich 345 rzeczach.${tail}`
    : `Nie rozpoznaję tego słowa.${tail}`;
}

async function run() {
  if (ui.busy) {
    ui.active?.cancel?.();
    ui.busy = false;
    ui.active = null;
    $('#doodle-go', ui.host).textContent = 'Rysuj';
    setStatus('Przerwane.');
    return;
  }

  const text = $('#doodle-prompt', ui.host).value.trim();
  if (!text) {
    setStatus('Napisz, co mam narysować.');
    return;
  }

  if (!(await ensureModel())) return;

  const resolved = doodle.resolvePrompt(text);
  if (!resolved.category) {
    setStatus(describeMiss(resolved), 'warn');
    return;
  }
  if (resolved.match !== 'exact') {
    setStatus(`Rozumiem to jako <b>${esc(resolved.label)}</b>. Rysuję…`);
  } else {
    setStatus(`Rysuję <b>${esc(resolved.label)}</b>…`);
  }

  ui.busy = true;
  ui.abort = new AbortController();
  const go = $('#doodle-go', ui.host);
  go.textContent = 'Przerwij';
  $('#doodle-placeholder', ui.host).hidden = true;
  ui.painter.clear();

  const started = performance.now();

  /* Drawn on the Mac, not here. In the browser this meant a 17 MB int8 download
     whose progress bar read "17.3 / 14 MB" — Pages reports the gzipped length
     while the stream decompresses larger — and then a frozen tab, because
     building the ONNX session blocks the main thread. The Mac samples the same
     model in about five seconds and the page stays responsive.
     Cost, stated plainly: this no longer works while the Mac sleeps, which had
     been G-Doodle's one advantage over the other two models. */
  ui.active = ui.ctx.bridge.run({ model: 'g-doodle', text }, (out) => {
    if (!ui) return;

    /* Every flush carries the whole drawing so far, not an append, so a dropped
       or reordered update costs nothing. Repainting ~50 points is cheaper than
       tracking which ones are new. */
    if (Array.isArray(out.strokes)) {
      ui.painter.clear();
      for (const stroke of out.strokes) {
        stroke.forEach(([x, y], i) => ui.painter.add(x, y, i > 0));
      }
      ui.points = out.strokes.reduce((n, st) => n + st.length, 0);
    }

    if (out.done) {
      const seconds = (performance.now() - started) / 1000;
      if (ui.points) {
        setStatus(`<b>${esc(out.label || resolved.label)}</b> — ${ui.points} punktów `
                  + `w ${seconds.toFixed(1)} s, narysowane na Macu.`, 'ok');
      } else {
        setStatus(esc(out.text || 'Mac nie zwrócił rysunku.'), 'warn');
      }
      ui.busy = false;
      ui.active = null;
      ui.points = 0;
      go.textContent = 'Rysuj';
    }
  }, { idleTimeout: 120_000 });
}

export function mountPanel(host, ctx) {
  host.innerHTML = TEMPLATE;
  ui = { host, busy: false, abort: null, handlers: [], painter: null };

  const canvas = $('#doodle-canvas', host);
  ui.ctx = ctx;
  ui.painter = doodle.painter(canvas, { width: reduced() ? 3 : 3.2 });

  const on = (target, type, fn) => {
    target.addEventListener(type, fn);
    ui.handlers.push([target, type, fn]);
  };

  on($('#doodle-go', host), 'click', run);
  on($('#doodle-prompt', host), 'keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); run(); }
  });
  on($('#doodle-chips', host), 'click', (e) => {
    const chip = e.target.closest('.doodle__chip');
    if (!chip) return;
    $('#doodle-prompt', host).value = chip.dataset.word;
    run();
  });
  /* The canvas rescales its contents to its own box, so a resize has to
     repaint rather than stretch what is already there. */
  on(window, 'resize', () => ui.painter.repaint());

  if (doodle.state.status === 'missing') {
    setStatus('Model jeszcze się uczy — wagi nie są jeszcze na serwerze.', 'warn');
  }
}

export function unmountPanel() {
  ui?.abort?.abort();
  ui?.handlers.forEach(([t, ty, fn]) => t.removeEventListener(ty, fn));
  ui = null;
}
