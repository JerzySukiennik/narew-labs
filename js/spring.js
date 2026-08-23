/**
 * The physics behind the pill nav and the version slider.
 *
 * Both are springs rather than transitions for the reason a spring is ever
 * worth the extra code: a transition cannot be grabbed. Its duration is decided
 * before it starts and nothing that happens afterwards can change it, so an
 * element mid-flight either ignores you or jumps. A spring only ever knows a
 * current value, a velocity and a target - change the target mid-flight and the
 * motion stays continuous, which is what makes these feel like objects rather
 * than animations of objects.
 *
 * Two stiffness/damping pairs are used throughout, and the split matters more
 * than the numbers: while a finger is down the spring is tight, so the thing
 * chases the pointer closely and stays under your control; on release it is
 * loose, so it overshoots and settles. Bounce is only ever the consequence of a
 * throw, never a decoration on something that merely appeared.
 */

export const TIGHT = { stiffness: 0.45, damping: 0.58 };   // pointer is down
export const LOOSE = { stiffness: 0.14, damping: 0.78 };   // released, settling
export const SOFT = { stiffness: 0.25, damping: 0.7 };     // hover and press scale

const REST_V = 0.0006;
const REST_D = 0.0006;

/**
 * A single scalar that chases a target frame by frame.
 *
 * The loop stops when it has both arrived and stopped moving, and restarts on
 * the next nudge - a permanently running rAF costs a frame of work forever for
 * a thing that is usually still.
 */
export function makeSpring(initial, onFrame) {
  let value = initial;
  let target = initial;
  let velocity = 0;
  let cfg = LOOSE;
  let raf = 0;

  const tick = () => {
    raf = 0;
    const force = (target - value) * cfg.stiffness;
    velocity = (velocity + force) * cfg.damping;
    value += velocity;

    const settled = Math.abs(velocity) < REST_V && Math.abs(target - value) < REST_D;
    if (settled) { value = target; velocity = 0; }
    onFrame(value, velocity);
    if (!settled) raf = requestAnimationFrame(tick);
  };

  const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };

  return {
    /* Retarget without touching velocity: a spring redirected mid-flight keeps
       the speed it already had, which is what stops a reversal reading as a
       brick wall. */
    to(next, config = LOOSE) { target = next; cfg = config; kick(); },
    /* Follow a pointer exactly. No spring, no lag - during a drag the thing
       under the finger IS the finger. */
    set(next) {
      cancelAnimationFrame(raf); raf = 0;
      velocity = next - value;
      value = next; target = next;
      onFrame(value, velocity);
    },
    get value() { return value; },
    get velocity() { return velocity; },
    stop() { cancelAnimationFrame(raf); raf = 0; velocity = 0; },
  };
}

/**
 * Where a flick is heading, rather than where the finger happened to stop.
 *
 * The same exponential-decay projection scroll deceleration uses, so a throw
 * lands where the gesture was going. Snapping from the release point instead
 * makes a fast flick and a slow drag behave identically, which is the one thing
 * a flick is not supposed to do.
 */
export function project(velocity, deceleration = 0.995) {
  return (velocity / 1000) * deceleration / (1 - deceleration);
}

/**
 * Squash and stretch from speed alone.
 *
 * Fast motion smears in the real world, and a shape that stays rigid at speed
 * reads as teleporting. Bounded hard, because past a point this stops being
 * physics and starts being a cartoon.
 */
export function stretch(velocity, gain = 0.018, cap = 0.22) {
  const s = Math.min(Math.abs(velocity) * gain, cap);
  return { x: 1 + s, y: 1 - s * 0.55 };
}

/**
 * Pointer tracking with the two details that separate 1:1 dragging from
 * approximate dragging: the grab offset is respected, so nothing jumps under
 * the finger on contact, and the pointer is captured, so the drag survives
 * leaving the element.
 */
export function drag(el, { onStart, onMove, onEnd, threshold = 4 }) {
  let id = null;
  let startX = 0;
  let moved = false;

  const down = (e) => {
    if (id !== null || e.button > 0) return;
    id = e.pointerId;
    startX = e.clientX;
    moved = false;
    el.setPointerCapture(id);
    onStart?.(e);
  };

  const move = (e) => {
    if (e.pointerId !== id) return;
    const dx = e.clientX - startX;
    /* Hysteresis before committing to a drag, so a tap with a shaky finger is
       still a tap. */
    if (!moved && Math.abs(dx) < threshold) return;
    moved = true;
    onMove?.(e, dx);
  };

  const up = (e) => {
    if (e.pointerId !== id) return;
    try { el.releasePointerCapture(id); } catch { /* already gone */ }
    id = null;
    onEnd?.(e, moved);
  };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
  };
}
