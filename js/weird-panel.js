/**
 * The "type it and it paints something" panel — G-Weird.
 *
 * A separate module for the same reason doodle-panel.js is one: the screen it
 * lives on is a working photo editor with its own state machine, and this is a
 * different task that merely shares the room. Mounting costs the editor a few
 * lines and adds no failure modes to it.
 *
 * Unlike every other model in the chooser, this one takes no photo. It is
 * text-in, picture-out, which is why picking it swaps the screen instead of
 * changing who answers.
 *
 * The panel says plainly that this is 0.9 and a test. The pictures are soft and
 * often wrong, and that is where the model actually is right now — dressing it
 * up as a finished thing would misrepresent it.
 */

import { $, esc, toast } from './ui.js';

const SUGGESTIONS = [
  'a horse', 'moon in space', 'a blue kite flying in the air',
  'a big city with two big skyscrapers, black and white style',
  'a crowd of people with no faces standing in a field',
  'a man with too many teeth smiling at the camera',
];

let ui = null;

const TEMPLATE = `
  <section class="studio__step doodle" data-enter>
    <h3 class="studio__step-title">Napisz, a namaluję</h3>
    <p class="doodle__lede muted">
      Wersja <strong>0.9</strong> — testowa. Obrazy wychodzą miękkie i często
      nietrafione; rozpoznaje pojedyncze rzeczy i style, gubi się przy dwóch
      obiektach naraz. Prompty po angielsku.
    </p>

    <div class="doodle__grid">
      <div class="doodle__stage">
        <img class="doodle__canvas" id="weird-img" alt="" hidden
             style="width:100%;border-radius:10px;display:block">
        <p class="doodle__placeholder muted" id="weird-placeholder">
          Tu pojawi się obraz
        </p>
      </div>

      <div class="doodle__panel">
        <label class="sr-only" for="weird-prompt">Co namalować</label>
        <input class="field" id="weird-prompt" type="text" autocomplete="off"
               placeholder="np. a horse" maxlength="200">

        <div class="doodle__chips" id="weird-chips">
          ${SUGGESTIONS.map((s) => `
            <button type="button" class="doodle__chip" data-word="${esc(s)}">${esc(s)}</button>
          `).join('')}
        </div>

        <button class="btn btn--accent doodle__go" id="weird-go">Rysuj</button>
        <p class="doodle__status muted" id="weird-status"></p>
      </div>
    </div>
  </section>`;

function setStatus(html) {
  const node = $('#weird-status', ui.host);
  if (node) node.innerHTML = html;
}

function setBusy(on) {
  ui.busy = on;
  const go = $('#weird-go', ui.host);
  if (go) { go.disabled = on; go.textContent = on ? 'Maluję…' : 'Rysuj'; }
}

function run() {
  if (ui.busy) return;
  const prompt = $('#weird-prompt', ui.host).value.trim();
  if (!prompt) { setStatus('Napisz, co namalować.'); return; }

  const bridge = ui.ctx?.bridge;
  if (!bridge) { setStatus('Brak połączenia z Makiem.'); return; }

  setBusy(true);
  setStatus('Mac maluje — to potrwa kilka sekund.');

  ui.active = bridge.run({ model: 'g-weird', text: prompt }, (out) => {
    if (out.image) {
      const img = $('#weird-img', ui.host);
      const ph = $('#weird-placeholder', ui.host);
      img.src = out.image;
      img.alt = prompt;
      img.hidden = false;
      if (ph) ph.hidden = true;
    }
    if (out.done) {
      setBusy(false);
      ui.active = null;
      /* An ending with no picture is the case worth naming: the job completed,
         so silence here would read as "still working" forever. */
      setStatus(out.image ? '' : (out.text || 'Model nie zwrócił obrazu.'));
    }
  }, { idleTimeout: 180000 });
}

export function mountPanel(host, ctx) {
  host.innerHTML = TEMPLATE;
  ui = { host, ctx, busy: false, active: null, handlers: [] };

  const on = (target, type, fn) => {
    target.addEventListener(type, fn);
    ui.handlers.push([target, type, fn]);
  };

  on($('#weird-go', host), 'click', run);
  on($('#weird-prompt', host), 'keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); run(); }
  });
  on($('#weird-chips', host), 'click', (e) => {
    const b = e.target.closest('[data-word]');
    if (!b) return;
    $('#weird-prompt', host).value = b.dataset.word;
    run();
  });
}

export function unmountPanel() {
  ui?.active?.cancel?.();
  ui?.handlers.forEach(([t, ty, fn]) => t.removeEventListener(ty, fn));
  ui = null;
}
