/**
 * The command palette: everything this app can do, one keystroke away.
 *
 * This exists so the chrome does not have to. A permanent sidebar is the most
 * generic shape an AI tool can take - it is what every chat clone looks like -
 * and it costs 268px of every screen forever to answer a question ("where do I
 * go next?") that is asked for about two seconds a session. G-Weird is the best
 * screen in this app precisely because it has no chrome at all, and the way to
 * extend that to the rest of it is not to delete navigation but to make it
 * arrive when summoned and leave when finished.
 *
 * So the rail stays as a thin strip for the eye and the pointer, and this is the
 * fast path: Cmd-K, type three letters, Enter. Same idea as Raycast or Linear,
 * and for the same reason - once an interface has more than a handful of places,
 * naming the place you want beats hunting for it.
 *
 * Matching is subsequence, not substring, so "ims" finds "Image Studio" and
 * "gwe" finds G-Weird. Anyone who knows what they want types the initials of it.
 */

import { $, $$, el, esc, reduced, enter } from './ui.js';

let open = null;

/**
 * Does every letter of `q` appear in `text`, in order?
 *
 * Deliberately not a fuzzy score with weights and tuning. A subsequence test is
 * predictable - you can tell from looking at the query why something matched -
 * and predictable beats clever in a control people use with their eyes closed.
 */
function matches(text, q) {
  if (!q) return true;
  const hay = text.toLowerCase();
  let i = 0;
  for (const ch of q.toLowerCase()) {
    i = hay.indexOf(ch, i);
    if (i === -1) return false;
    i += 1;
  }
  return true;
}

export function openPalette(commands) {
  if (open) return;

  /* Read before the palette takes focus, so dismissing it puts the keyboard
     back on whatever opened it rather than at the top of the document. */
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  const node = el(`
    <div class="palette" role="dialog" aria-modal="true" aria-label="Polecenia">
      <div class="palette__scrim" data-close></div>
      <div class="palette__panel">
        <div class="palette__search">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>
          </svg>
          <label class="sr-only" for="pal-input">Szukaj polecenia</label>
          <!-- Focus never leaves this field, so it is the field that has to
               report which row is current. Without the combobox contract a
               screen reader hears nothing as the highlight moves and Enter
               runs a command it was never told about. -->
          <input id="pal-input" class="palette__input" autocomplete="off"
                 spellcheck="false" placeholder="Dokąd?"
                 role="combobox" aria-expanded="true" aria-controls="pal-list"
                 aria-autocomplete="list">
          <kbd class="palette__kbd">esc</kbd>
        </div>
        <ul class="palette__list" id="pal-list" role="listbox" aria-label="Wyniki"></ul>
        <p class="palette__empty" id="pal-empty" hidden>Nic takiego tu nie ma.</p>
      </div>
    </div>`);

  document.body.append(node);
  const input = $('#pal-input', node);
  const list = $('#pal-list', node);
  const empty = $('#pal-empty', node);

  let shown = commands;
  let cursor = 0;

  const draw = () => {
    const q = input.value.trim();
    shown = commands.filter((c) => matches(`${c.label} ${c.group || ''} ${c.hint || ''}`, q));
    cursor = Math.min(cursor, Math.max(0, shown.length - 1));
    empty.hidden = shown.length > 0;

    let group = null;
    list.innerHTML = shown.map((c, i) => {
      /* The heading is printed by the first row that belongs to it rather than
         precomputed, so filtering never leaves a group label with nothing
         under it. */
      const head = c.group && c.group !== group
        ? `<li class="palette__group" role="presentation">${esc(c.group)}</li>` : '';
      group = c.group || group;
      return `${head}
        <li role="presentation">
          <button type="button" class="palette__row" role="option" data-i="${i}"
                  id="pal-opt-${i}" aria-selected="${i === cursor}">
            <span class="palette__icon" aria-hidden="true">${c.icon || ''}</span>
            <span class="palette__label">${esc(c.label)}</span>
            ${c.hint ? `<span class="palette__hint">${esc(c.hint)}</span>` : ''}
          </button>
        </li>`;
    }).join('');
    mark();
  };

  /* The selection lives in three places - the array index, the row's
     aria-selected, and the input's aria-activedescendant - and they are only
     ever written together, here. */
  const mark = () => {
    $$('.palette__row', list).forEach((r, i) => r.setAttribute('aria-selected', String(i === cursor)));
    const row = $(`[data-i="${cursor}"]`, list);
    if (row) input.setAttribute('aria-activedescendant', row.id);
    else input.removeAttribute('aria-activedescendant');
    row?.scrollIntoView({ block: 'nearest' });
  };

  const move = (step) => {
    if (!shown.length) return;
    cursor = (cursor + step + shown.length) % shown.length;
    mark();
  };

  let ran = false;
  const run = (i) => {
    const cmd = shown[i];
    if (!cmd) return;
    ran = true;
    close();
    /* After the palette is gone, so a command that opens something else is not
       fighting this for focus. */
    setTimeout(() => cmd.run(), 0);
  };

  function close() {
    if (!open) return;
    open = null;
    document.removeEventListener('keydown', onKey, true);
    node.dataset.closing = 'true';
    setTimeout(() => node.remove(), reduced() ? 0 : 160);
    /* Only when nothing ran: a command that navigates somewhere should be
       allowed to decide where the keyboard lands. */
    if (!ran) opener?.focus?.({ preventScroll: true });
  }

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (e.key === 'Enter') { e.preventDefault(); run(cursor); return; }
    /* Nothing else escapes: while this is open it owns the keyboard, so Tab
       cannot walk into the page behind it. */
    if (e.key === 'Tab') e.preventDefault();
  };

  /* Capture phase, because the screens underneath listen for plain keystrokes -
     G-Weird takes any letter as the start of a prompt - and they must not hear
     what is being typed in here. */
  document.addEventListener('keydown', onKey, true);
  input.addEventListener('input', draw);
  list.addEventListener('click', (e) => {
    const row = e.target.closest('[data-i]');
    if (row) run(Number(row.dataset.i));
  });
  list.addEventListener('pointermove', (e) => {
    const row = e.target.closest('[data-i]');
    if (!row || Number(row.dataset.i) === cursor) return;
    cursor = Number(row.dataset.i);
    mark();
  });
  $('[data-close]', node).addEventListener('click', close);

  open = { close };
  draw();
  input.focus({ preventScroll: true });
  enter($('.palette__panel', node), { opacity: 0, y: -8, scale: 0.98, duration: 0.22 });
  return open;
}

export const paletteOpen = () => Boolean(open);
export const closePalette = () => open?.close();
