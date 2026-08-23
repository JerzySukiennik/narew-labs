/**
 * G-Weird: an empty screen, a caret, and whatever you type.
 *
 * There is no form here on purpose. A label, a bordered input and a button say
 * "fill this in correctly and I will consider it"; this model takes one line of
 * English and paints something soft and frequently wrong, and the screen should
 * feel like that - you write into nothing, the words are the interface, and the
 * only chrome that ever appears is the queue you have already created.
 *
 * The typing itself is mirrored rather than native: a real <input> sits over the
 * text at zero opacity and does the unglamorous work - the mobile keyboard on
 * iOS, paste, autocorrect, IME - while the letters you see are our own spans,
 * each arriving out of focus and settling. A contenteditable would have looked
 * the same and quietly broken all four.
 *
 * Everything after Enter is one continuous object: the line drawn around the
 * prompt is the same rectangle that shrinks into the queue tile, which is the
 * same tile that becomes the picture. Nothing is created or destroyed on the way
 * down, because a thing that keeps its identity is a thing you can follow.
 *
 * The queue lives at module scope, not in `ui`. Leaving G-Weird for G-Images and
 * coming back unmounts this panel, and a queue that evaporated on a glance
 * elsewhere would be a queue nobody would risk using. It does not survive a
 * reload - deliberately: these are base64 PNGs of a 0.9 test model, and neither
 * the browser's storage nor the account is the right home for them yet.
 */

import { $, esc, reduced, enter } from './ui.js';

/* One picture is ~256 sampled tokens at roughly 25 ms, so about seven seconds
   of Mac. The timeout is generous against a cold model load, which happens once
   and takes considerably longer than the painting does. */
const IDLE_TIMEOUT = 180000;

let ui = null;
let queue = [];
let nextId = 1;

const TEMPLATE = `
  <section class="weird" data-enter>
    <div class="weird__stage">
      <div class="weird__line" id="weird-line">
        <span class="weird__text" id="weird-text"></span><span class="weird__caret" id="weird-caret"></span>
      </div>
      <p class="weird__hint muted" id="weird-hint">pisz po angielsku · G-Weird 0.9, test</p>

      <!-- Invisible, but the real one: it owns focus, the caret position, the
           mobile keyboard and paste. What you see are spans mirroring it. -->
      <label class="sr-only" for="weird-ghost">Co namalować</label>
      <input class="weird__ghost" id="weird-ghost" type="text" maxlength="200"
             autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
    </div>

    <div class="weird__queue" id="weird-queue" role="list" aria-label="Kolejka obrazów"></div>
  </section>`;

/* ----------------------------------------------------------------- type -- */

/**
 * Mirror the input into spans, animating only what is genuinely new.
 *
 * Re-rendering every character on every keystroke would restart the blur on the
 * whole line, so the text would pulse as you typed. Only the tail that was not
 * there a moment ago gets the animation class.
 */
function syncText() {
  const value = $('#weird-ghost', ui.host).value;
  const node = $('#weird-text', ui.host);
  const shown = ui.shown;

  if (value === shown) return;

  /* A deletion, or a paste that replaced the middle: rebuild without animating,
     because nothing here is arriving. */
  if (!value.startsWith(shown)) {
    node.textContent = value;
    ui.shown = value;
    updateHint();
    return;
  }

  [...value.slice(shown.length)].forEach((ch, i) => {
    const span = document.createElement('span');
    /* Faster than the chat transcript's reveal: there the words are being read
       as they arrive, here they are being typed, and anything slower than the
       fingers feels like lag rather than motion. */
    span.className = 'char-in weird__char';
    span.textContent = ch === ' ' ? ' ' : ch;
    if (reduced()) span.style.animation = 'none';
    else span.style.animationDelay = `${i * 12}ms`;
    node.append(span);
  });
  ui.shown = value;
  updateHint();
}

function updateHint() {
  $('#weird-hint', ui.host).hidden = ui.shown.length > 0;
}

function clearText() {
  $('#weird-ghost', ui.host).value = '';
  $('#weird-text', ui.host).textContent = '';
  ui.shown = '';
  updateHint();
}

/* ---------------------------------------------------------------- commit -- */

/**
 * Enter: draw a line around what was written, then shrink it into the queue.
 *
 * The rectangle is measured from the text, not from a fixed box, so it is the
 * size of what you actually wrote - which is the whole point of drawing it at
 * all. Then the same rectangle travels: a FLIP from where the words are to where
 * the tile will be, scaling to a square on the way.
 *
 * The job is submitted before the animation finishes. Waiting would spend half a
 * second of the Mac's time on decoration.
 */
function commit() {
  const prompt = $('#weird-ghost', ui.host).value.trim();
  if (!prompt) return;
  if (!ui.ctx?.bridge) { flashHint('Brak połączenia z Makiem.'); return; }

  const item = {
    id: nextId++, prompt, status: 'pending', image: null, handle: null,
  };
  queue.push(item);
  renderQueue();
  start(item);

  const line = $('#weird-line', ui.host);
  const tile = $(`[data-item="${item.id}"]`, ui.host);
  flyToQueue(line, tile);
  clearText();
}

/**
 * The prompt's own outline, drawn and then flown into place.
 *
 * A clone travels rather than the text itself: the line has to keep taking
 * keystrokes the moment Enter is released, and an element mid-flight cannot also
 * be the thing you are typing into.
 */
function flyToQueue(line, tile) {
  if (!tile) return;
  const from = line.getBoundingClientRect();
  const to = tile.getBoundingClientRect();
  if (reduced() || !from.width || !to.width) return;

  const ghost = document.createElement('div');
  ghost.className = 'weird__flight';
  ghost.textContent = ui.shown;
  Object.assign(ghost.style, {
    left: `${from.left}px`, top: `${from.top}px`,
    width: `${from.width}px`, height: `${from.height}px`,
  });
  document.body.append(ghost);

  /* Synchronous reflow rather than a rAF callback: rAF does not run in a
     background tab, and an animation that never starts leaves this fixed-
     position clone parked over the page forever. */
  void ghost.offsetHeight;
  ghost.dataset.drawn = 'true';

  const settle = () => {
    ghost.style.transition = 'transform 480ms cubic-bezier(0.4, 0, 0.2, 1), opacity 200ms ease 300ms';
    ghost.style.transformOrigin = 'top left';
    ghost.style.transform =
      `translate(${to.left - from.left}px, ${to.top - from.top}px) `
      + `scale(${to.width / from.width}, ${to.height / from.height})`;
    ghost.style.opacity = '0';
    setTimeout(() => ghost.remove(), 700);
  };
  /* Let the outline finish drawing before it starts moving - the two reading as
     one gesture is the reason the line is there at all. */
  setTimeout(settle, 260);
}

function flashHint(text) {
  const hint = $('#weird-hint', ui.host);
  hint.hidden = false;
  hint.textContent = text;
  clearTimeout(ui.hintTimer);
  ui.hintTimer = setTimeout(() => {
    hint.textContent = 'pisz po angielsku · G-Weird 0.9, test';
    updateHint();
  }, 4000);
}

/* ----------------------------------------------------------------- queue -- */

function start(item) {
  item.handle = ui.ctx.bridge.run(
    { model: 'g-weird', text: item.prompt },
    (out) => {
      if (out.image) { item.image = out.image; item.status = 'done'; }
      if (out.done) {
        item.handle = null;
        if (!item.image) {
          /* A finish with no picture is the case worth naming: the job is over,
             so silence would read as "still working" for good. */
          item.status = item.status === 'cancelled' ? 'cancelled' : 'error';
          item.note = out.text || 'Model nie zwrócił obrazu.';
        }
        paint(item);
      }
    },
    { idleTimeout: IDLE_TIMEOUT },
  );
}

function renderQueue() {
  const host = $('#weird-queue', ui.host);
  host.innerHTML = queue.map((item) => `
    <div class="weird__tile" role="listitem" data-item="${item.id}"
         data-status="${item.status}" title="${esc(item.prompt)}">
      <div class="weird__tile-shimmer" aria-hidden="true"></div>
      <img class="weird__tile-img" alt="${esc(item.prompt)}" hidden>
      <button type="button" class="weird__tile-stop" data-stop="${item.id}"
              aria-label="Przerwij">×</button>
    </div>`).join('');
  queue.forEach(paint);
}

/**
 * Push one item's state into its tile, without rebuilding the row.
 *
 * Tolerates the panel being gone: jobs outlive an unmount on purpose, so this
 * runs for a picture whose tile is not on the page at the moment it lands. The
 * item keeps the result either way, and the tile is rebuilt from it on return.
 */
function paint(item) {
  if (!ui) return;
  const tile = $(`[data-item="${item.id}"]`, ui.host);
  if (!tile) return;
  tile.dataset.status = item.status;

  if (item.status === 'done' && item.image) {
    const img = $('.weird__tile-img', tile);
    if (img.src !== item.image) {
      img.src = item.image;
      img.hidden = false;
      /* The glow underneath is taken from the picture itself, so the reveal is
         the colours of this image arriving rather than a generic flourish. */
      img.addEventListener('load', () => {
        const [a, b] = paletteOf(img);
        tile.style.setProperty('--tile-a', a);
        tile.style.setProperty('--tile-b', b);
        tile.dataset.revealed = 'true';
      }, { once: true });
    }
  }
  if (item.note) tile.title = `${item.prompt} — ${item.note}`;
}

/**
 * Two colours out of the finished picture.
 *
 * Downscaling to 4x4 and reading two cells is not clever, and does not need to
 * be: at that size each cell is already the average of a whole quadrant, which
 * is exactly the "roughly what colour is this" the glow wants. The image is a
 * data URL from our own Mac, so the canvas stays untainted and readable.
 */
function paletteOf(img) {
  try {
    const c = document.createElement('canvas');
    c.width = 4; c.height = 4;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 4, 4);
    const d = ctx.getImageData(0, 0, 4, 4).data;
    const at = (i) => `rgb(${d[i * 4]}, ${d[i * 4 + 1]}, ${d[i * 4 + 2]})`;
    return [at(5), at(10)];
  } catch {
    return ['var(--accent)', 'var(--surface-3)'];
  }
}

function stop(id) {
  const item = queue.find((q) => q.id === Number(id));
  if (!item) return;
  if (item.handle) {
    item.status = 'cancelled';
    item.note = 'Przerwane.';
    item.handle.cancel();
    item.handle = null;
    paint(item);
    return;
  }
  /* Nothing running: the × is a "remove this" instead. */
  queue = queue.filter((q) => q !== item);
  renderQueue();
}

/* ---------------------------------------------------------------- viewer -- */

function openViewer(item) {
  if (!item?.image) return;
  const node = document.createElement('div');
  node.className = 'weird__viewer';
  node.innerHTML = `
    <button type="button" class="weird__viewer-close" id="wv-close" aria-label="Zamknij">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>
    <figure class="weird__viewer-figure">
      <img src="${esc(item.image)}" alt="${esc(item.prompt)}">
      <figcaption class="muted">${esc(item.prompt)}</figcaption>
    </figure>
    <div class="weird__viewer-actions">
      <a class="btn" id="wv-save" download="g-weird.png" href="${esc(item.image)}">Pobierz</a>
      <button type="button" class="btn" id="wv-share" hidden>Udostępnij</button>
    </div>`;
  document.body.append(node);
  enter(node, { opacity: 0, duration: 0.2 });

  const close = () => {
    node.remove();
    document.removeEventListener('keydown', onKey);
    $('#weird-ghost', ui.host)?.focus({ preventScroll: true });
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  $('#wv-close', node).addEventListener('click', close);
  node.addEventListener('click', (e) => { if (e.target === node) close(); });

  /* Sharing is offered only where it can actually carry the picture. A button
     that opens a share sheet without the image in it is worse than no button,
     and on desktop that is exactly what the file-less path does. */
  const file = toFile(item);
  if (file && navigator.canShare?.({ files: [file] })) {
    const share = $('#wv-share', node);
    share.hidden = false;
    share.addEventListener('click', async () => {
      try { await navigator.share({ files: [file], text: item.prompt }); }
      catch { /* dismissed, which is not an error */ }
    });
  }
  $('#wv-close', node).focus({ preventScroll: true });
}

function toFile(item) {
  try {
    const [head, b64] = item.image.split(',');
    const type = head.match(/:(.*?);/)[1];
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new File([bytes], 'g-weird.png', { type });
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- mount -- */

export function mountPanel(host, ctx) {
  host.innerHTML = TEMPLATE;
  ui = { host, ctx, shown: '', hintTimer: null, handlers: [] };

  const on = (target, type, fn) => {
    target.addEventListener(type, fn);
    ui.handlers.push([target, type, fn]);
  };

  const ghost = $('#weird-ghost', host);
  on(ghost, 'input', syncText);
  on(ghost, 'keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    commit();
  });

  /* Anywhere on the empty half is the writing surface. Clicking a queue tile is
     not: that opens the picture. */
  on($('.weird__stage', host), 'click', () => ghost.focus({ preventScroll: true }));

  on($('#weird-queue', host), 'click', (e) => {
    const stopBtn = e.target.closest('[data-stop]');
    if (stopBtn) { stop(stopBtn.dataset.stop); return; }
    const tile = e.target.closest('[data-item]');
    if (tile) openViewer(queue.find((q) => q.id === Number(tile.dataset.item)));
  });

  /* Whatever was queued before leaving for another model is still here. */
  renderQueue();
  if (!reduced()) ghost.focus({ preventScroll: true });
}

export function unmountPanel() {
  /* Jobs are deliberately left running: leaving G-Weird for a moment should not
     throw away seven seconds of Mac that is already half spent, and the queue
     these belong to is still here when you come back. */
  clearTimeout(ui?.hintTimer);
  ui?.handlers.forEach(([t, ty, fn]) => t.removeEventListener(ty, fn));
  ui = null;
}
