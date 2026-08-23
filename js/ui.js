/**
 * Small shared UI machinery: toasts, overlays, motion.
 *
 * Motion policy for the whole app, in one place so it cannot drift:
 *  - GSAP animates orchestrated, non-gesture moments (a view arriving, the
 *    onboarding steps, the tier cards landing). Timelines are the right tool
 *    when several things have to happen in a known order.
 *  - Anything the user can grab — the sidebar, sheets — is CSS transform with a
 *    settle curve, so it can be interrupted by another class change instead of
 *    fighting a running tween.
 *  - `reduced` is checked live, not cached, because the setting can change while
 *    the tab is open.
 */

export const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/** Escape text going into innerHTML. Model output is text, never markup. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/* --------------------------------------------------------------- motion -- */
/*
 * GSAP comes off a CDN, and a CDN is a thing that can be down, blocked by a
 * network, or simply slow. Importing it statically made that outage fatal:
 * every module here imports `ui.js`, so a failed fetch took the whole app with
 * it — and `enterView` had already set the page to opacity 0 by then, so the
 * best case was a blank screen.
 *
 * So the export starts as a stand-in that applies the *end* state of a tween
 * immediately, and the real library replaces it in place when (if) it arrives.
 * `export { gsap }` on a `let` is a live binding, so every importer follows the
 * swap without knowing it happened. Callers keep their `gsap.to(...)` lines and
 * a missing CDN costs the animation, never the page.
 */

/** Only the properties the app actually animates; anything else is motion. */
function applyVars(targets, vars = {}) {
  const list = typeof targets === 'string'
    ? $$(targets)
    : (Array.isArray(targets) ? targets : [targets]);
  for (const node of list) {
    if (!node?.style) continue;
    if (vars.opacity !== undefined) node.style.opacity = String(vars.opacity);
    if (vars.display !== undefined) node.style.display = vars.display;
  }
}

/**
 * The stand-in. `from` is deliberately a no-op: a from-tween ends where the
 * element already is, so doing nothing lands on the right frame.
 */
function fallbackGsap() {
  const done = (vars) => { if (vars?.onComplete) queueMicrotask(() => vars.onComplete()); };
  const api = {
    isFallback: true,
    defaults() {},
    set: (t, v) => { applyVars(t, v); return api; },
    to: (t, v) => { applyVars(t, v); done(v); return api; },
    from: (t, v) => { done(v); return api; },
    fromTo: (t, from, to) => { applyVars(t, to); done(to); return api; },
    timeline(cfg) {
      /* Chained calls run synchronously, so a microtask is the first moment the
         timeline is provably complete. */
      if (cfg?.onComplete) queueMicrotask(() => cfg.onComplete());
      const tl = {
        to: (t, v) => { applyVars(t, v); return tl; },
        from: () => tl,
        fromTo: (t, f, v) => { applyVars(t, v); return tl; },
        set: (t, v) => { applyVars(t, v); return tl; },
        call: (fn) => { fn?.(); return tl; },
        kill: () => tl,
      };
      return tl;
    },
  };
  return api;
}

let gsap = fallbackGsap();
export { gsap };

const DEFAULTS = { duration: 0.45, ease: 'power3.out' };

const loadGsap = import('https://cdn.jsdelivr.net/npm/gsap@3.12.5/+esm')
  .then((mod) => {
    const real = mod.default || mod.gsap;
    if (!real?.timeline) throw new Error('gsap bundle without a timeline');
    real.defaults(DEFAULTS);
    gsap = real;
  })
  .catch(() => { /* the stand-in stays; the app is merely still */ });

/* Waiting a moment keeps the animation on a normal load, and the ceiling keeps
   a hanging CDN from holding the first paint hostage. 2.5 s is past a warm
   jsdelivr fetch by an order of magnitude and still under the point where a
   blank screen reads as broken. A late arrival still swaps itself in. */
await Promise.race([loadGsap, new Promise((r) => setTimeout(r, 2500))]);

/* ----------------------------------------------------------------- toast -- */


/**
 * An entrance animation that cannot leave anything invisible.
 *
 * `gsap.from()` writes the start state to the element and depends on the next
 * frame to walk it back. A hidden tab does not paint frames: rAF stops, the
 * tween never ticks, and the element keeps the start state - opacity 0 - while
 * being focusable and clickable. That is how a checkout can end up invisible
 * but live, and how the model picker ended up open at opacity 0.
 *
 * So: never touch the element unless a frame is actually coming, and when one
 * is, animate to an explicit end state and drop the inline styles afterwards
 * so an interrupted tween still lands somewhere legible.
 */
export function enter(target, vars = {}) {
  if (reduced() || document.hidden || typeof gsap === 'undefined') return null;
  const { duration = 0.35, ease = 'power3.out', stagger, ...from } = vars;
  const to = Object.fromEntries(Object.keys(from).map((k) => [k, k === 'opacity' ? 1 : 0]));
  return gsap.fromTo(target, from, {
    ...to, duration, ease, stagger, clearProps: Object.keys(from).join(','),
  });
}


/**
 * Text that arrives out of focus and settles, one piece at a time.
 *
 * The chat transcript reveals whole words because it is reading material and a
 * word is the unit the eye takes in. A short heading, or something being typed,
 * wants letters: at that size a word is one gulp and the reveal never reads as
 * arriving at all. Both share the blur - text that sharpens stays readable the
 * whole way through, where text that slides pulls the eye to the motion.
 *
 * Returns the container so a caller can measure it straight away; the animation
 * is CSS, so nothing here depends on a frame being painted.
 */
export function revealText(node, text, { by = 'char', step = 22 } = {}) {
  const parts = by === 'word' ? String(text).split(/(\s+)/) : [...String(text)];
  node.textContent = '';
  parts.forEach((part, i) => {
    if (/^\s+$/.test(part)) { node.append(part); return; }
    const span = document.createElement('span');
    span.className = 'char-in';
    span.textContent = part;
    /* Reduced motion still gets the text, just all at once and already sharp. */
    if (!reduced()) span.style.animationDelay = `${i * step}ms`;
    else span.style.animation = 'none';
    node.append(span);
  });
  return node;
}

export function toast(message, kind = 'info', ms = 3600) {
  const host = $('#toasts');
  if (!host) return;
  const node = el(`<div class="toast toast--${kind}"><span>${esc(message)}</span></div>`);
  host.appendChild(node);

  if (reduced()) {
    gsap.set(node, { opacity: 1 });
  } else {
    enter(node, { y: 12, opacity: 0, duration: 0.3 });
  }

  setTimeout(() => {
    gsap.to(node, {
      opacity: 0, y: reduced() ? 0 : -6, duration: 0.25,
      onComplete: () => node.remove(),
    });
  }, ms);
}

/* --------------------------------------------------------------- overlay -- */
/*
 * One overlay at a time, dimmed behind, dismissible by Escape and by the scrim.
 * A modal is a task the user must finish or leave; anything that does not block
 * belongs in the page, not here.
 */

let openOverlayState = null;

/* What a keyboard can land on. `aria-modal` tells a screen reader the rest of
   the page is inert; it does not stop Tab, so the trap below has to. */
const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])',
  'textarea:not([disabled])', 'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const focusables = (panel) => $$(FOCUSABLE, panel).filter((n) => (
  !n.hidden && n.offsetParent !== null
));

export function overlay(node, { dismissible = true, onClose, label = 'Okno' } = {}) {
  /* Read before closing whatever is open: closing restores focus, and the
     element that opened *this* overlay is the one we want to come back to. */
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  closeOverlay();
  const host = $('#overlay-host');
  const shell = el(`
    <div class="overlay" role="dialog" aria-modal="true" aria-label="${esc(label)}">
      <div class="overlay__scrim"></div>
      <div class="overlay__panel"></div>
    </div>`);
  shell.querySelector('.overlay__panel').appendChild(node);
  host.innerHTML = '';
  host.appendChild(shell);
  host.hidden = false;

  const panel = shell.querySelector('.overlay__panel');
  if (reduced()) {
    gsap.set([shell.querySelector('.overlay__scrim'), panel], { opacity: 1 });
  } else {
    /* The surface materialises — scale and blur together — rather than fading
       in flat, so it reads as something arriving rather than appearing. */
    enter(shell.querySelector('.overlay__scrim'), { opacity: 0, duration: 0.25 });
    enter(panel, { opacity: 0, y: 18, scale: 0.97, duration: 0.42 });
  }

  const close = () => closeOverlay();
  if (dismissible) shell.querySelector('.overlay__scrim').addEventListener('click', close);

  /* The trap. Tab is cycled inside the panel, and a focus that gets in anyway —
     the address bar, a stray programmatic focus — is pulled back on the way in
     rather than left outside a dialog the reader cannot see past. */
  const onKeydown = (e) => {
    if (e.key !== 'Tab') return;
    const items = focusables(panel);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !panel.contains(active))) {
      e.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
      e.preventDefault();
      first.focus({ preventScroll: true });
    }
  };
  const onFocusIn = (e) => {
    if (!panel.contains(e.target)) focusables(panel)[0]?.focus({ preventScroll: true });
  };
  shell.addEventListener('keydown', onKeydown);
  document.addEventListener('focusin', onFocusIn);

  openOverlayState = { host, shell, onClose, dismissible, opener, onFocusIn };

  /* Focus the first thing worth typing into, so the keyboard lands inside. */
  const first = panel.querySelector('input, textarea, button, [tabindex]');
  first?.focus({ preventScroll: true });

  return { close };
}

export function closeOverlay() {
  if (!openOverlayState) return;
  const { host, onClose, opener, onFocusIn } = openOverlayState;
  openOverlayState = null;
  document.removeEventListener('focusin', onFocusIn);
  host.hidden = true;
  host.innerHTML = '';
  /* Back where it came from: focus lands nowhere when the element holding it is
     deleted, and "nowhere" means the next Tab restarts at the top of the page. */
  if (opener?.isConnected) opener.focus({ preventScroll: true });
  onClose?.();
}

export const overlayOpen = () => Boolean(openOverlayState);

/*
 * This listener is registered first — every view imports this module before it
 * mounts — so it is also the first to see Escape. That makes
 * stopImmediatePropagation the load-bearing call: a view's own Escape handler
 * sits on `document` too, and by the time it ran the overlay state would
 * already be cleared, so it would happily close its menu as well and one press
 * would peel two layers.
 */
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openOverlayState) {
    /* Swallowed either way: a modal that refuses to be dismissed still owns the
       key, and the page behind it must not act on it. */
    e.stopImmediatePropagation();
    if (openOverlayState.dismissible) closeOverlay();
  }
});

/* ---------------------------------------------------------------- confirm -- */

/**
 * The only kind of dialog in the app, reserved for things that cannot be undone.
 * Typing the word is not theatre: every caller here destroys data that is not
 * recoverable, and a misfired click should not be enough.
 */
export function confirmDestructive({ title, body, word, action }) {
  const node = el(`
    <div class="confirm">
      <h2 class="title">${esc(title)}</h2>
      <p class="muted">${esc(body)}</p>
      <label class="confirm__label" for="confirm-word">Wpisz <strong>${esc(word)}</strong>, żeby potwierdzić</label>
      <input class="field" id="confirm-word" autocomplete="off" spellcheck="false">
      <p class="confirm__error" id="confirm-error" hidden></p>
      <div class="checkout__actions">
        <button class="btn btn--ghost" id="confirm-no">Anuluj</button>
        <button class="btn setting__danger" id="confirm-yes" disabled>${esc(title)}</button>
      </div>
    </div>`);

  const input = node.querySelector('#confirm-word');
  const yes = node.querySelector('#confirm-yes');
  input.addEventListener('input', () => { yes.disabled = input.value.trim().toLowerCase() !== word; });
  node.querySelector('#confirm-no').addEventListener('click', closeOverlay);

  yes.addEventListener('click', async () => {
    yes.disabled = true;
    try {
      await action();
      closeOverlay();
    } catch (e) {
      yes.disabled = false;
      const err = node.querySelector('#confirm-error');
      err.hidden = false;
      err.textContent = e?.code === 'auth/requires-recent-login'
        ? 'Ze względów bezpieczeństwa trzeba się najpierw zalogować jeszcze raz, a potem spróbować ponownie.'
        : `Nie udało się: ${e.message}`;
    }
  });

  overlay(node, { label: title });
}

/* ---------------------------------------------------------------- drawer -- */
/*
 * A bottom sheet you can throw away with your thumb.
 *
 * Vaul was the ask, and Vaul is a React component with a Radix dialog inside
 * it: adopting it would put React in the purchase path of an app that has none,
 * for one screen. The behaviour is the part that matters and it is not much
 * code, so it is here instead - the same shape and the same feel, on the
 * platform this app already uses.
 *
 * The feel is the point, so it follows the rules that make a sheet read as a
 * physical object rather than an animation: it tracks the finger 1:1 from
 * wherever it was grabbed, resists rather than stops at the top, decides on
 * release by where the throw is *going* rather than where it ended, and hands
 * its release velocity to the settle so there is no seam between dragging and
 * animating.
 */

let openDrawer = null;

/** Where a flick would come to rest. Apple's projection, not the textbook one. */
const project = (velocity, deceleration = 0.998) =>
  (velocity / 1000) * deceleration / (1 - deceleration);

export function drawer(node, { label = 'Panel', onClose } = {}) {
  closeDrawer();
  closeOverlay();

  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const host = $('#overlay-host');
  const shell = el(`
    <div class="drawer" role="dialog" aria-modal="true" aria-label="${esc(label)}">
      <div class="drawer__scrim"></div>
      <div class="drawer__sheet">
        <div class="drawer__grip" aria-hidden="true"><span></span></div>
        <div class="drawer__body"></div>
      </div>
    </div>`);
  shell.querySelector('.drawer__body').appendChild(node);
  host.innerHTML = '';
  host.appendChild(shell);
  host.hidden = false;

  const sheet = shell.querySelector('.drawer__sheet');
  const scrim = shell.querySelector('.drawer__scrim');
  const app = $('#app');

  /* Reading offsetHeight forces the browser to commit the closed transform
     before the open state is set, which is the whole reason a frame was being
     waited for. Doing it synchronously matters: requestAnimationFrame does not
     run in a background tab, so a sheet opened there stayed shut until the tab
     came back - the same trap that once swallowed the first chat message.
     Pushing the page back is what makes the sheet read as being in front of
     something rather than drawn on top of it. */
  void sheet.offsetHeight;
  shell.dataset.open = 'true';
  app?.classList.add('is-behind-drawer');

  let dragging = false;
  let startY = 0;
  let offset = 0;
  let history = [];

  const setY = (y, animate) => {
    sheet.style.transition = animate
      ? 'transform 420ms cubic-bezier(0.32, 0.72, 0, 1)'
      : 'none';
    sheet.style.transform = `translateY(${y}px)`;
  };

  /* Past the top the sheet gives less than it is given, so the boundary reads
     as resistance rather than as a broken drag. */
  const rubber = (over, height) => (over * height * 0.55) / (height + 0.55 * Math.abs(over));

  const onDown = (e) => {
    if (e.target.closest('input, textarea, button, a, select')) return;
    dragging = true;
    startY = e.clientY;
    history = [{ y: e.clientY, t: performance.now() }];
    sheet.setPointerCapture(e.pointerId);
    sheet.style.transition = 'none';
  };

  const onMove = (e) => {
    if (!dragging) return;
    const raw = e.clientY - startY;
    offset = raw >= 0 ? raw : rubber(raw, sheet.offsetHeight);
    setY(offset, false);
    history.push({ y: e.clientY, t: performance.now() });
    if (history.length > 5) history.shift();
  };

  const onUp = () => {
    if (!dragging) return;
    dragging = false;

    const first = history[0];
    const last = history[history.length - 1];
    const dt = Math.max(1, last.t - first.t);
    const velocity = ((last.y - first.y) / dt) * 1000;      // px per second

    /* Decide on the projection, not the position: a short fast flick should
       dismiss, a long slow drag that stopped halfway should not. */
    const projected = offset + project(velocity);
    if (projected > sheet.offsetHeight * 0.4) {
      dismiss(velocity);
    } else {
      setY(0, true);
      offset = 0;
    }
  };

  const dismiss = (velocity = 0) => {
    const distance = Math.max(1, sheet.offsetHeight - offset);
    const duration = velocity > 0
      ? Math.max(140, Math.min(420, (distance / velocity) * 1000))
      : 320;
    sheet.style.transition = `transform ${Math.round(duration)}ms cubic-bezier(0.32, 0.72, 0, 1)`;
    sheet.style.transform = `translateY(${sheet.offsetHeight}px)`;
    shell.dataset.open = 'false';
    setTimeout(closeDrawer, reduced() ? 0 : Math.round(duration));
  };

  sheet.addEventListener('pointerdown', onDown);
  sheet.addEventListener('pointermove', onMove);
  sheet.addEventListener('pointerup', onUp);
  sheet.addEventListener('pointercancel', onUp);
  scrim.addEventListener('click', () => dismiss());

  openDrawer = { host, onClose, opener, app };
  (node.querySelector('input, button, [tabindex]') || sheet).focus?.({ preventScroll: true });

  return { close: () => dismiss() };
}

export function closeDrawer() {
  if (!openDrawer) return;
  const { host, onClose, opener, app } = openDrawer;
  openDrawer = null;
  app?.classList.remove('is-behind-drawer');
  host.hidden = true;
  host.innerHTML = '';
  opener?.focus?.({ preventScroll: true });
  onClose?.();
}

export const drawerOpen = () => Boolean(openDrawer);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openDrawer) {
    e.stopPropagation();
    closeDrawer();
  }
});

/* --------------------------------------------------------------- entrance -- */

/**
 * The one entrance every view shares.
 *
 * Keeping it here — rather than in each view — is what stops the app from
 * feeling like seven pages glued together.
 */
export function enterView(root) {
  const parts = $$('[data-enter]', root);
  if (!parts.length) return;
  /* Through enter(), which declines to touch anything when no frame is coming.
     Calling gsap.fromTo here directly wrote opacity 0 onto every section of the
     view and depended on the ticker to walk it back - and the ticker is rAF,
     which a background tab does not run. Open the app in a tab you are not
     looking at, come back, and the entire screen was blank: present, focusable,
     and invisible. clearProps only listed transform, so even a finished tween
     left the opacity behind. */
  enter(parts, { opacity: 0, y: 14, duration: 0.5, stagger: 0.045 });
}

/* ------------------------------------------------------------------ misc -- */

export const fmt = new Intl.NumberFormat('pl-PL');

export function relativeTime(ms) {
  const diff = Date.now() - ms;
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'przed chwilą';
  if (min < 60) return `${min} min temu`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} godz. temu`;
  const d = Math.round(h / 24);
  return d === 1 ? 'wczoraj' : `${d} dni temu`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* Safari refuses the clipboard outside a user gesture and in some embedded
       contexts. Falling back to a selection is better than a silent failure. */
    const input = el(`<input class="sr-only" value="${esc(text)}">`);
    document.body.appendChild(input);
    input.select();
    const ok = document.execCommand?.('copy');
    input.remove();
    return Boolean(ok);
  }
}
