/**
 * The version control in Image Studio's header: a slider, not a menu.
 *
 * Versions are a ladder, and a dropdown flattens a ladder into a list - three
 * unrelated things you pick one of. A slider says the thing that is actually
 * true: they are ordered, they run in one direction, and moving along them is a
 * move rather than a choice. It reads left to right as 1, 2, 2.1.
 *
 * One honest caveat lives in the caption rather than in the geometry: further
 * along means newer, and newer is not automatically better at everything. On
 * this app's own measurements G-Image 1 is the better model on filters and
 * G-Image 2 the better one at dropping an object into a scene. The slider says
 * where you are on the ladder; the line under it says what that version is for.
 *
 * Springs from spring.js, same as the pill nav: tight under the finger, loose
 * on release, snapped to whole steps because half a version does not exist.
 */

import { $, $$, esc, reduced } from './ui.js';
import { makeSpring, drag, project, stretch, TIGHT, LOOSE } from './spring.js';

let ui = null;

export function mountSlider(host, versions, { onPick, current }) {
  /* Any previous instance goes first, unconditionally. Both of these keep a
     module-level singleton and register a window resize listener, so a mount
     that skipped the unmount left the old one alive - painting into detached
     nodes on every resize, for the rest of the session. Owning that here means
     no caller can forget. */
  unmountSlider();
  if (!versions.length) { host.innerHTML = ''; return null; }

  host.innerHTML = `
    <div class="vslider" role="slider" tabindex="0"
         aria-label="Wersja modelu" aria-valuemin="1"
         aria-valuemax="${versions.length}" aria-valuenow="1" aria-valuetext="">
      <div class="vslider__channel" id="vs-channel">
        <div class="vslider__fill" id="vs-fill"></div>
        ${versions.map(() => '<span class="vslider__tick"></span>').join('')}
        <div class="vslider__thumb" id="vs-thumb"><span id="vs-thumb-label"></span></div>
      </div>
      <p class="vslider__caption muted" id="vs-caption"></p>
    </div>`;

  const root = $('.vslider', host);
  const channel = $('#vs-channel', host);
  const thumb = $('#vs-thumb', host);
  const label = $('#vs-thumb-label', host);
  const fill = $('#vs-fill', host);
  const caption = $('#vs-caption', host);

  const last = Math.max(1, versions.length - 1);
  let index = Math.max(0, versions.findIndex((v) => v.id === current));

  /* Travel is measured in whole steps, so the thumb's own width is subtracted
     once here rather than being wrong at both ends. */
  /* The thumb sits INSET_X from the left, so its travel is the channel minus
     its own width minus that inset twice — once at each end. Subtracting the
     inset only once let the thumb finish 3px past the right edge, where the
     channel's overflow:hidden sliced a crescent off it. */
  const INSET_X = 3;
  const span = () =>
    Math.max(1, channel.clientWidth - thumb.offsetWidth - INSET_X * 2);

  /* Ticks were placed at i/(n-1)*100%, which puts the LAST one's left edge
     exactly on the channel's right edge — so the whole dot fell outside and was
     clipped away. They are rungs under the thumb, so they belong at the thumb's
     centre positions and nowhere else. */
  const layoutTicks = () => {
    const ticks = channel.querySelectorAll('.vslider__tick');
    ticks.forEach((t, i) => {
      t.style.left = `${INSET_X + thumb.offsetWidth / 2 + (i / last) * span()}px`;
    });
  };

  const paint = (pos, velocity) => {
    const x = (pos / last) * span();
    const s = reduced() ? { x: 1, y: 1 } : stretch(velocity * span(), 0.012, 0.18);
    thumb.style.transform = `translateX(${x}px) scaleX(${s.x}) scaleY(${s.y})`;
    fill.style.width = `${x + thumb.offsetWidth / 2}px`;
    /* The label reads the live position, so a drag shows the version you are
       currently over rather than the one you last committed to. */
    const near = versions[Math.min(versions.length - 1, Math.max(0, Math.round(pos)))];
    if (near && label.textContent !== near.short) label.textContent = near.short || near.name;
  };

  const spring = makeSpring(index, paint);

  const describe = () => {
    const v = versions[index];
    /* Written here as well as from the spring's paint loop. paint only runs on
       a frame, and a background tab paints none - so a version committed by
       keyboard while the tab was hidden left the thumb reading the old number. */
    label.textContent = v.short || v.name;
    caption.textContent = v.desc || '';
    root.setAttribute('aria-valuenow', String(index + 1));
    root.setAttribute('aria-valuetext', `${v.name}${v.desc ? `, ${v.desc}` : ''}`);
    root.dataset.state = v.available ? 'online' : 'offline';
  };

  const commit = (i, { silent = false } = {}) => {
    const before = index;
    index = Math.min(versions.length - 1, Math.max(0, i));
    spring.to(index, LOOSE);
    describe();
    if (!silent && before !== index) {
      navigator.vibrate?.(8);
      onPick?.(versions[index].id);
    }
  };

  const stopDrag = drag(channel, {
    onStart: () => { root.dataset.dragging = 'true'; spring.to(spring.value, TIGHT); },
    onMove: (e) => {
      const rect = channel.getBoundingClientRect();
      const raw = ((e.clientX - rect.left - thumb.offsetWidth / 2) / span()) * last;
      /* Resistance rather than a hard stop at either end. */
      const clamped = raw < 0 ? raw * 0.3
        : raw > last ? last + (raw - last) * 0.3 : raw;
      spring.set(clamped);
    },
    onEnd: (e, moved) => {
      delete root.dataset.dragging;
      if (!moved) {
        /* A tap on the track goes to the nearest step, which is what a tap on a
           ladder means. */
        const rect = channel.getBoundingClientRect();
        const raw = ((e.clientX - rect.left - thumb.offsetWidth / 2) / span()) * last;
        commit(Math.round(raw));
        return;
      }
      commit(Math.round(spring.value + project(spring.velocity * span() * 0.6)));
    },
  });

  const onKey = (e) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1
      : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    commit(index + step);
  };
  root.addEventListener('keydown', onKey);

  /* Hover grows the thumb from 26px to 30px, which changes its travel — so the
     rungs, which are placed at thumb-centre positions, have to be re-placed
     with it. Without this they drift 2px away from the thumb on hover. */
  const grow = (on) => {
    if (reduced()) return;
    thumb.dataset.big = String(on);
    layoutTicks();
    paint(spring.value, 0);
  };
  channel.addEventListener('pointerenter', () => grow(true));
  channel.addEventListener('pointerleave', () => grow(false));

  const onResize = () => { layoutTicks(); paint(spring.value, 0); };
  addEventListener('resize', onResize);

  layoutTicks();
  paint(index, 0);
  describe();

  ui = {
    destroy() {
      stopDrag();
      root.removeEventListener('keydown', onKey);
      removeEventListener('resize', onResize);
      spring.stop();
    },
    select(id) {
      const i = versions.findIndex((v) => v.id === id);
      if (i >= 0 && i !== index) commit(i, { silent: true });
    },
    refresh(live) {
      versions.forEach((v) => { v.available = live.some((l) => l.id === v.wire && l.available); });
      describe();
    },
  };
  return ui;
}

export function unmountSlider() {
  ui?.destroy();
  ui = null;
}
