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

import { $, $$, esc, reduced, enter } from './ui.js';

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
      <p class="weird__hint muted" id="weird-hint"></p>

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

  /* A deletion, or a paste that replaced the middle: rebuilt without animating,
     because nothing here is arriving - but still one span per letter. Plain text
     here used to leave the line with nothing for the gather to pick up, so
     anything typed, partly deleted and re-typed collapsed into an empty ball. */
  if (!value.startsWith(shown)) {
    node.textContent = '';
    [...value].forEach((ch) => {
      const span = document.createElement('span');
      span.className = 'weird__char';
      span.textContent = ch;
      node.append(span);
    });
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
    /* Set below, and only if the flight actually starts. The tile is the ball
       once it lands, so until then it must not be on screen - but a tile hidden
       for a flight that never ran would never come back. */
    incoming: false,
  };
  /* Newest at the front. The one you just wrote is the one you are waiting on,
     so it belongs where the eye already is rather than at the end of a row that
     grows away from you. */
  queue.unshift(item);
  renderQueue();
  start(item);
  restHint();

  const line = $('#weird-line', ui.host);
  const tile = $(`[data-item="${item.id}"]`, ui.host);
  if (flyToQueue(line, tile)) {
    item.incoming = true;
    tile.setAttribute('data-incoming', '');
    /* Cleared on the item as well as the tile: renderQueue rebuilds from the
       array, and a later rebuild would otherwise hide a tile that landed long
       ago. */
    setTimeout(() => { item.incoming = false; }, 980);
  }
  clearText();
}

/**
 * Enter, in three beats: outline, gather, throw.
 *
 * The first version scaled a copy of the text straight into the tile's box, and
 * because a line of words and a small square have nothing like the same
 * proportions that meant scaling X by about a fifth and Y by about a twentieth.
 * Letters do not survive that: they smeared. Non-uniform scale is never a morph,
 * it is a squash, and text is the worst possible thing to squash.
 *
 * So nothing is scaled non-uniformly any more, and the text does not travel at
 * all. It gathers: every letter runs at the centre of the line, shrinking and
 * blurring out - the arrival animation played backwards - while the outline
 * closes around them into a ball. Only then does the ball move, and a ball can
 * be flung anywhere without distorting, because it has no inside left to
 * distort. What lands is a shape, and the shape becomes the tile.
 */
function flyToQueue(line, tile) {
  if (!tile || reduced()) return false;
  const from = line.getBoundingClientRect();
  const to = tile.getBoundingClientRect();
  if (!from.width || !to.width) return false;

  const BALL = 44;
  const ghost = document.createElement('div');
  ghost.className = 'weird__flight';
  Object.assign(ghost.style, {
    left: `${from.left}px`, top: `${from.top}px`,
    width: `${from.width}px`, height: `${from.height}px`,
  });

  /* The letters are re-created rather than cloned so each can be told where the
     centre is; a clone would carry the arrival animation and start over. */
  const cx = from.width / 2;
  const cy = from.height / 2;
  [...$$('.weird__char', line)].forEach((src) => {
    const r = src.getBoundingClientRect();
    const ch = document.createElement('span');
    ch.className = 'weird__flight-char';
    ch.textContent = src.textContent;
    ch.style.left = `${r.left - from.left}px`;
    ch.style.top = `${r.top - from.top}px`;
    /* Each letter's own path to the middle, so they converge instead of all
       sliding the same way. */
    ch.style.setProperty('--dx', `${cx - (r.left - from.left) - r.width / 2}px`);
    ch.style.setProperty('--dy', `${cy - (r.top - from.top) - r.height / 2}px`);
    ghost.append(ch);
  });
  document.body.append(ghost);

  /* Synchronous reflow rather than a rAF callback: rAF does not run in a
     background tab, and an animation that never starts would leave this
     fixed-position clone parked over the page for good. */
  void ghost.offsetHeight;
  ghost.dataset.phase = 'outline';

  const at = (ms, fn) => setTimeout(fn, ms);

  /* Beat two: letters run to the middle, the outline closes into a ball around
     the same point it was already centred on, so nothing appears to jump. */
  at(200, () => {
    ghost.dataset.phase = 'gather';
    Object.assign(ghost.style, {
      left: `${from.left + cx - BALL / 2}px`,
      top: `${from.top + cy - BALL / 2}px`,
      width: `${BALL}px`, height: `${BALL}px`,
    });
  });

  /* Beat three: thrown to the tile. Transform only, and uniform - the ball is
     round, so the one scale factor is the whole story. */
  at(520, () => {
    const ball = ghost.getBoundingClientRect();
    ghost.dataset.phase = 'throw';
    ghost.style.transform =
      `translate(${to.left + to.width / 2 - (ball.left + ball.width / 2)}px, `
      + `${to.top + to.height / 2 - (ball.top + ball.height / 2)}px) `
      + `scale(${to.width / BALL})`;
  });

  at(980, () => {
    ghost.remove();
    /* The ball stops being the ball and starts being the tile in the same
       frame: one disappears exactly where the other appears, so they read as
       the same object rather than a handover. */
    delete tile.dataset.incoming;
    tile.dataset.landed = 'true';
    at(360, () => { delete tile.dataset.landed; });
  });
  return true;
}

function flashHint(text) {
  const hint = $('#weird-hint', ui.host);
  hint.hidden = false;
  hint.textContent = text;
  clearTimeout(ui.hintTimer);
  ui.hintTimer = setTimeout(() => {
    restHint();
    updateHint();
  }, 4000);
}

/* --------------------------------------------------------------- version -- */

/* Which decoder renders the codes. Both versions share one transformer and one
   codebook — only the decoder differs, so the same prompt and seed give the same
   picture drawn two ways. The page owns the choice (the same version slider
   G-Images uses), so the panel is told rather than deciding, and a version
   switched mid-draw applies to the next picture instead of corrupting this one. */
let wire = 'g-weird-1';

export function setVersion(next) {
  if (!next || next === wire) return;
  wire = next;
  /* The resting hint names the version, so it has to follow the slider rather
     than stay at whatever was hardcoded when the panel was written. */
  if (ui) restHint();
}

function versionLabel() {
  return wire === 'g-weird' ? '0.9' : '1';
}

function restHint() {
  const hint = $('#weird-hint', ui.host);
  if (!hint) return;
  /* While anything is being painted the hint reports that instead of the usual
     advice. The tile with the spinner lands at the bottom of a tall page, far
     below the line you just typed into, so after pressing Enter there was
     nothing where the eye actually was — measured, not guessed: the spinner
     renders correctly and is simply off-screen.
     The count matters because jobs run one at a time: three in the queue is
     three times the wait, and saying so beats looking stuck. */
  const busy = queue.filter((i) => i.status === 'pending').length;
  hint.textContent = busy
    ? (busy === 1 ? 'maluję… (~7 s)' : `maluję… ${busy} w kolejce`)
    : `pisz po angielsku · G-Weird ${versionLabel()}, test`;
}

/* ----------------------------------------------------------------- queue -- */

function start(item) {
  item.handle = ui.ctx.bridge.run(
    { model: wire, text: item.prompt },
    (out) => {
      /* Repaint the moment the picture lands, not when the job is later marked
         finished. Those are two separate messages, and in the gap between them
         the item already had its image - so the tile went on spinning while
         clicking it opened the finished picture full screen. */
      if (out.image) {
        item.image = out.image; item.status = 'done'; paint(item); restHint();
      }
      if (out.done) {
        item.handle = null;
        if (!item.image) {
          /* A finish with no picture is the case worth naming: the job is over,
             so silence would read as "still working" for good. */
          item.status = item.status === 'cancelled' ? 'cancelled' : 'error';
          item.note = out.text || 'Model nie zwrócił obrazu.';
        }
        paint(item);
        /* Also on the failure path: a job that ended without a picture must
           still clear "maluję…", or the line claims work that stopped. */
        restHint();
      }
    },
    { idleTimeout: IDLE_TIMEOUT },
  );
}

function renderQueue() {
  const host = $('#weird-queue', ui.host);
  host.innerHTML = queue.map((item) => `
    <div class="weird__tile" role="listitem" data-item="${item.id}"
         data-status="${item.status}" ${item.incoming ? 'data-incoming' : ''}
         title="${esc(item.prompt)}">
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
      /* The reveal used to be skipped entirely. The image went from hidden -
         display:none - straight to its revealed state, and an element that was
         not rendered a moment ago has no previous value to transition from, so
         the browser simply painted the end. It is unhidden first, the start
         state is committed with a forced reflow, and only then does it arrive.
         A data URL can also be complete before a load listener is attached, so
         both paths are handled. */
      const show = () => {
        /* The glow underneath is taken from the picture itself, so the reveal is
           the colours of this image arriving rather than a generic flourish. */
        const [a, b] = paletteOf(img);
        tile.style.setProperty('--tile-a', a);
        tile.style.setProperty('--tile-b', b);
        img.hidden = false;
        void img.offsetHeight;
        tile.dataset.revealed = 'true';
      };
      if (img.complete && img.naturalWidth) show();
      else img.addEventListener('load', show, { once: true });
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

function openViewer(item, origin) {
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

  /* The picture grows out of the tile that was clicked and shrinks back into
     it. A thing that appears from nowhere has to be located all over again on
     the way back; a thing that comes from a place you were already looking at
     keeps its identity, and closing it puts it back where you know it lives. */
  const figure = $('.weird__viewer-figure', node);
  const big = $('img', node);
  const from = origin?.getBoundingClientRect();

  /* The picture is what travels, not the figure around it. Both the tile and
     the full view are square - the model paints squares - so one scale factor
     covers both axes exactly, and nothing is squashed on the way. Scaling the
     figure instead meant including the caption, whose height belongs to no
     square at all: that came out 0.33 wide by 0.29 tall, which is the same
     distortion the prompt text used to suffer. The caption fades instead. */
  const flip = (open) => {
    if (reduced() || !from?.width) { node.dataset.open = String(open); return; }
    const to = big.getBoundingClientRect();
    if (!to.width) { node.dataset.open = String(open); return; }
    const scale = from.width / to.width;
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const shut = `translate(${dx}px, ${dy}px) scale(${scale})`;

    big.style.transition = 'none';
    big.style.transform = open ? shut : 'none';
    /* Committed with a forced reflow rather than in a rAF callback, which does
       not run in a background tab - the same trap that once swallowed the first
       chat message. */
    void big.offsetHeight;
    big.style.transition =
      'transform 440ms cubic-bezier(0.32, 0.72, 0, 1), border-radius 440ms ease';
    big.style.transform = open ? 'none' : shut;
    /* The tile's corner radius on the way out, the picture's on the way in. */
    big.style.borderRadius = open ? '' : '18px';
    figure.style.transition = 'opacity 200ms ease';
    node.dataset.open = String(open);
  };
  flip(true);

  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    document.removeEventListener('keydown', onKey);
    flip(false);
    setTimeout(() => {
      node.remove();
      $('#weird-ghost', ui.host)?.focus({ preventScroll: true });
    }, reduced() ? 0 : 380);
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

/**
 * Take focus the moment this screen becomes the visible one.
 *
 * The panel is mounted once and hidden by the family switcher rather than being
 * created on arrival, so there is no mount to hook: arriving from G-Images is an
 * attribute change on a div. Without this, landing here left the caret blinking
 * at a field that was not actually focused, and typing did nothing until you
 * found the right place to click.
 */
function focusWhenShown(host, ghost) {
  const obs = new MutationObserver(() => {
    if (!host.hidden) ghost.focus({ preventScroll: true });
  });
  obs.observe(host, { attributes: true, attributeFilter: ['hidden'] });
  ui.observer = obs;
}

/* ----------------------------------------------------------------- mount -- */

export function mountPanel(host, ctx) {
  host.innerHTML = TEMPLATE;
  ui = { host, ctx, shown: '', hintTimer: null, handlers: [] };
  restHint();

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

  /* And you should never have to find the field at all. On a screen whose whole
     premise is "write something", a keystroke IS the intent to write, so any
     key typed while nothing else is focused goes to the prompt - the first
     character included, which is why focus is taken on keydown rather than
     after. Modifier combinations are left alone so copy, paste, reload and
     every other shortcut still belong to the browser. */
  on(document, 'keydown', (e) => {
    if (host.hidden || !host.isConnected) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('.weird__viewer')) return;      // the picture is open
    const el = document.activeElement;
    if (el === ghost) return;
    if (el && el.closest('input, textarea, select, [contenteditable="true"]')) return;
    /* Only keys that mean text. Tab, arrows and Escape still navigate. */
    if (e.key.length !== 1 && e.key !== 'Backspace') return;
    ghost.focus({ preventScroll: true });
  });

  on($('#weird-queue', host), 'click', (e) => {
    const stopBtn = e.target.closest('[data-stop]');
    if (stopBtn) { stop(stopBtn.dataset.stop); return; }
    const tile = e.target.closest('[data-item]');
    if (tile) openViewer(queue.find((q) => q.id === Number(tile.dataset.item)), tile);
  });

  /* Whatever was queued before leaving for another model is still here. */
  renderQueue();
  focusWhenShown(host, ghost);
  if (!host.hidden) ghost.focus({ preventScroll: true });
}

export function unmountPanel() {
  /* Jobs are deliberately left running: leaving G-Weird for a moment should not
     throw away seven seconds of Mac that is already half spent, and the queue
     these belong to is still here when you come back. */
  clearTimeout(ui?.hintTimer);
  ui?.observer?.disconnect();
  ui?.handlers.forEach(([t, ty, fn]) => t.removeEventListener(ty, fn));
  ui = null;
}
