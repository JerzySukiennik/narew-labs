/**
 * The pill at the bottom of Image Studio: which of the three models you are in.
 *
 * A sliding toggle rather than a row of buttons, because the three are not three
 * destinations - they are three positions of one thing, and a thumb that travels
 * between them says that in a way three separate highlights cannot. You can also
 * simply drag it, which is the honest test of whether a control is an object:
 * if the only way to move it is to click the far end, it was never a toggle.
 *
 * It is present on every screen here, including the chooser, where it is the
 * whole point - the chooser is a giant label and an arrow pointing at this.
 *
 * Built on the shared springs in spring.js: tight while the finger is down so
 * the thumb stays under it, loose on release so a throw overshoots and settles.
 */

import { $, $$, esc, reduced } from './ui.js';
import { makeSpring, drag, project, stretch, TIGHT, LOOSE } from './spring.js';

let ui = null;

export function mountNav(host, items, { onPick, current }) {
  host.innerHTML = `
    <div class="pillnav" role="radiogroup" aria-label="Model">
      <div class="pillnav__track" id="pn-track">
        <div class="pillnav__thumb" id="pn-thumb" aria-hidden="true"></div>
        ${items.map((it, i) => `
          <button type="button" class="pillnav__slot" role="radio" data-i="${i}"
                  data-id="${esc(it.id)}" aria-checked="${it.id === current}"
                  tabindex="${it.id === current ? '0' : '-1'}">
            <span class="pillnav__dot" data-state="offline" data-slot-dot="${esc(it.id)}"></span>
            <span class="pillnav__label">${esc(it.name)}</span>
          </button>`).join('')}
      </div>
    </div>`;

  const track = $('#pn-track', host);
  const thumb = $('#pn-thumb', host);
  const slots = $$('.pillnav__slot', host);
  track.style.setProperty('--pn-count', items.length);

  let index = Math.max(0, items.findIndex((it) => it.id === current));

  /* The thumb is positioned in slot units rather than pixels, so a resize or a
     font change costs nothing: the same 1.5 still means "between the second and
     third", whatever the pill happens to measure at the time. */
  const paint = (pos, velocity) => {
    const w = track.clientWidth / items.length;
    const s = reduced() ? { x: 1, y: 1 } : stretch(velocity * w);
    thumb.style.transform = `translateX(${pos * w}px) scaleX(${s.x}) scaleY(${s.y})`;
    slots.forEach((slot, i) => {
      /* The label inverts as the thumb arrives under it rather than at the
         moment the value changes, so the colour is a consequence of where the
         thumb actually is - including mid-drag, where there is no value yet. */
      slot.style.setProperty('--on', String(Math.max(0, 1 - Math.abs(pos - i))));
    });
  };

  const spring = makeSpring(index, paint);
  const settle = (i) => {
    index = Math.min(items.length - 1, Math.max(0, i));
    spring.to(index, LOOSE);
    slots.forEach((s, n) => {
      s.setAttribute('aria-checked', String(n === index));
      s.tabIndex = n === index ? 0 : -1;
    });
    return items[index];
  };

  /* Reported on every deliberate pick, not only when the index changes. The
     pill shows a slot as current from the moment it is built, but the screen
     behind it starts on the chooser with no family open at all - so tapping the
     slot that was already highlighted looked like a dead control, and the only
     way off the landing screen was to pick one of the other two. */
  const pick = (i, { silent = false } = {}) => {
    const before = index;
    const item = settle(i);
    if (silent || !item) return;
    if (before !== index) navigator.vibrate?.(8);
    onPick?.(item.id);
  };

  /* ------------------------------------------------------------- gesture -- */
  let dragged = false;
  const stopDrag = drag(track, {
    onStart: () => { dragged = false; track.dataset.dragging = 'true'; },
    onMove: (e) => {
      const w = track.clientWidth / items.length;
      const rect = track.getBoundingClientRect();
      const raw = (e.clientX - rect.left) / w - 0.5;
      /* Resistance past the ends rather than a wall: the pill keeps answering
         the finger, it just stops promising there is anything further. */
      const clamped = raw < 0 ? raw * 0.3
        : raw > items.length - 1 ? items.length - 1 + (raw - (items.length - 1)) * 0.3
          : raw;
      spring.set(clamped);
    },
    onEnd: (e, moved) => {
      delete track.dataset.dragging;
      if (!moved) {
        /* A tap is left to the click handler below. Real pointers fire click
           right after pointerup, so handling it here as well would pick twice;
           handling it ONLY here would mean anything that produces a click
           without a pointer - a screen reader, a keyboard activation - could
           never choose anything. Click is the one both paths share. */
        return;
      }
      /* Where the throw is going, not where the finger stopped. A drag that
         ends over a slot also produces a click, which must not then re-pick. */
      dragged = true;
      const landing = spring.value + project(spring.velocity * 60);
      pick(Math.round(landing));
    },
  });

  const onClick = (e) => {
    const slot = e.target.closest('.pillnav__slot');
    if (!slot) return;
    if (dragged) { dragged = false; return; }   // the drag already chose
    pick(Number(slot.dataset.i));
  };
  track.addEventListener('click', onClick);

  const onKey = (e) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    pick(index + step);
    slots[index].focus();
  };
  track.addEventListener('keydown', onKey);

  /* A tight spring while a finger is down keeps the thumb glued to it; the
     paint above still runs from the same value either way. */
  track.addEventListener('pointerdown', () => spring.to(spring.value, TIGHT));

  const onResize = () => paint(spring.value, 0);
  addEventListener('resize', onResize);

  paint(index, 0);

  ui = {
    host,
    destroy() {
      stopDrag();
      track.removeEventListener('click', onClick);
      track.removeEventListener('keydown', onKey);
      removeEventListener('resize', onResize);
      spring.stop();
    },
    /* Follow a change made somewhere else - a card on the chooser, say - without
       reporting it back as a new choice. */
    select(id) {
      const i = items.findIndex((it) => it.id === id);
      if (i >= 0 && i !== index) pick(i, { silent: true });
    },
    presence(live) {
      $$('[data-slot-dot]', host).forEach((dot) => {
        dot.dataset.state = live.includes(dot.dataset.slotDot) ? 'online' : 'offline';
      });
    },
  };
  return ui;
}

export function unmountNav() {
  ui?.destroy();
  ui = null;
}
