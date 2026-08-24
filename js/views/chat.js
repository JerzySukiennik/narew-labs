/**
 * Chat.
 *
 * One screen with two states: the empty one, which is a greeting and a box, and
 * the running one, which is a transcript with the box pinned under it. The move
 * between them happens once per conversation and is the only orchestrated
 * moment here.
 *
 * The answer arrives as whole-text snapshots from the Mac, never as deltas, so
 * the transcript diffs against what it has already shown. See js/bridge.js.
 */

import * as store from '../store.js';
import { CHAT_MODELS } from '../bridge.js';
import { $, $$, el, esc, toast, overlayOpen, gsap, reduced, enter, problem } from '../ui.js';

const SUGGESTIONS = [
  'Kim jesteś?', 'Wymień trzy owoce.', 'Czym jest Warszawa?',
  'Podaj dwa polskie miasta.', 'Opowiedz o Krakowie.', 'Wymień cztery pory roku.',
  'Wymień trzy zwierzęta.', 'Co to jest rower?',
];

/**
 * A greeting that knows what time it is.
 *
 * Only the clock, because only the clock is actually known here: the app has no
 * location and no weather source, and inventing "ładny dzień" for someone
 * sitting in the rain would be the same kind of lie the rest of this product
 * refuses to tell. The hours are drawn where they change for a person rather
 * than where a calendar puts them - 5 is still night, 22 is already late.
 */
function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Jeszcze nie śpisz';
  if (h < 10) return 'Dzień dobry';
  if (h < 13) return 'Cześć';
  if (h < 18) return 'Dobre popołudnie';
  if (h < 22) return 'Dobry wieczór';
  return 'Późno już';
}

const MODEL_HINT = {
  'g-micro': 'G-Micro ma 110M parametrów i często się myli.',
  'g-mini': 'G-Mini rozbija liczby na cyfry, więc przepisuje je wierniej niż G-Micro.',
};

/*
 * Two watchdogs, because the far end is a laptop in a house and the near end
 * has no way to ask it anything. Both exist to make sure the composer is always
 * given back — nothing here is allowed to end a generation that is merely slow.
 *
 * SILENCE_LIMIT — the Mac writes the *whole* answer so far on every token, so a
 *   healthy generation touches the job node several times a second. The symptom
 *   of a dead Mac is silence, not slowness, which is why this timer is reset by
 *   any update at all. 90 s sits far past every honest wait we know of: a cold
 *   first token runs into the tens of seconds and G-Images answers in a single
 *   write after roughly 35 s.
 * STOP_GRACE — cancel is a flag written into the job the Mac is already
 *   streaming, so it normally lands within a token or two. 6 s is many tokens of
 *   margin; past that the composer belongs to the user again, whether or not
 *   the Mac ever agrees.
 */
const SILENCE_LIMIT = 90_000;
const STOP_GRACE = 6_000;

/* Nine dots lighting and fading in turn. A blinking block reads as a terminal
   waiting for input, which is the opposite of what is happening: the Mac is
   busy, and nobody is being asked to type. */
const DOTS = `<span class="thinking" role="status" aria-label="Model pracuje">${
  Array.from({ length: 9 }, (_, i) => `<i style="--d:${i * 90}ms"></i>`).join('')
}</span>`;

let ui = null;      // everything this view owns, so unmount can let go of it

export async function mount(root, ctx) {
  root.innerHTML = `
    <div class="chat">
      <div class="chat__scroll" id="chat-scroll">
        <div class="chat__hero" id="chat-hero" data-enter>
          <h2 class="display chat__greeting"><span id="chat-greeting">Hej</span>, <span id="chat-name">Ty</span></h2>
        </div>
        <div class="chat__transcript" id="chat-transcript" role="log" aria-live="polite" aria-label="Rozmowa"></div>
      </div>

      <div class="composer-dock" id="composer-dock" data-enter>
        <div class="suggestions" id="suggestions"></div>

        <p class="composer-block" id="composer-block" hidden></p>

        <form class="composer" id="composer" autocomplete="off">
          <div class="composer__attach" id="attach-preview" hidden>
            <img id="attach-img" alt="Załączony obrazek">
            <button type="button" class="composer__attach-x" id="attach-remove" aria-label="Usuń załącznik">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </div>

          <div class="composer__pill">
            <!-- The plus and the panel it opens are one surface: a 40px circle
                 that grows into the menu rather than a button that reveals a
                 box somewhere else. Anchored so it expands upward out of the
                 pill instead of pushing the composer around. -->
            <span class="composer__plus-anchor">
              <div class="t-morph" id="plus-morph" data-open="false">
                <div class="t-morph-menu">
                  <button type="button" class="plus-panel__item" id="pick-file">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m3.5 17 4.8-4.5a2 2 0 0 1 2.7 0L20.5 21"/></svg>
                    <span>Dodaj plik lub zdjęcie</span>
                  </button>
                  <input type="file" id="file-input" accept="image/*" class="sr-only">
                </div>
                <button type="button" class="t-morph-plus composer__plus" id="plus-btn"
                        aria-label="Dodaj załącznik" aria-expanded="false">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
                </button>
              </div>
            </span>

            <label class="sr-only" for="chat-input">Wiadomość</label>
            <textarea id="chat-input" class="composer__input" rows="1" placeholder="Napisz wiadomość…"></textarea>

            <button type="submit" class="composer__send" id="send-btn" aria-label="Wyślij">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M12 5l-6 6M12 5l6 6"/></svg>
            </button>
          </div>

          <div class="composer__foot">
            <p class="composer__hint" id="composer-hint"></p>
            <div class="picker" id="picker">
              <button type="button" class="picker__button" id="picker-btn" aria-haspopup="listbox" aria-expanded="false">
                <span class="picker__dot" id="picker-dot"></span>
                <span id="picker-name">G-Micro</span>
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
              </button>
              <ul class="picker__menu" id="picker-menu" role="listbox" hidden></ul>
            </div>
          </div>
        </form>

      </div>
    </div>`;

  ui = {
    ctx,
    root,
    chatEl: $('.chat', root),
    scroll: $('#chat-scroll', root),
    hero: $('#chat-hero', root),
    transcript: $('#chat-transcript', root),
    input: $('#chat-input', root),
    send: $('#send-btn', root),
    form: $('#composer', root),
    hint: $('#composer-hint', root),
    block: $('#composer-block', root),
    suggestions: $('#suggestions', root),
    messages: [],
    convId: null,
    model: localStorage.getItem('narew.model') || 'g-micro',
    models: chatModels(ctx.bridge),
    image: null,
    active: null,
    session: null,
    timers: { silence: 0, stop: 0 },
    generating: false,
    handlers: [],
  };

  $('#chat-name', root).textContent = store.firstName();
  $('#chat-greeting', root).textContent = greeting();
  fillSuggestions();
  renderPicker();
  wire();
  syncComposer();

  const pending = sessionStorage.getItem('narew.openConv');
  if (pending) {
    sessionStorage.removeItem('narew.openConv');
    await openConversation(pending);
  }
}

export function unmount() {
  ui?.handlers.forEach(([target, type, fn]) => target.removeEventListener(type, fn));
  abandon();
  ui = null;
}

/**
 * Let go of a running job: tell the Mac, stop listening, stop counting.
 *
 * `dispose` is what detaches the database listener; older bridges only offer
 * `cancel`, so both are optional and the session flag is what actually stops
 * late writes from painting into a transcript nobody is looking at any more.
 */
function abandon(tellMac = true) {
  if (!ui) return;
  clearTimeout(ui.timers.silence);
  clearTimeout(ui.timers.stop);
  if (ui.session) ui.session.closed = true;
  /* No point flagging a cancel on a job the Mac has already finished — that is
     a write to the database for an answer that is already on screen. */
  if (tellMac) ui.active?.cancel?.();
  ui.active?.dispose?.();
  ui.active = null;
  ui.session = null;
}

/**
 * The conversation models, and only those.
 *
 * The Mac announces everything it can run in one list — G-Images and its
 * versions sit in it beside G-Micro — so without this filter the chat dropdown
 * offered picture models, and choosing one sent a sentence to a network that
 * only edits photographs.
 */
function chatModels(bridge) {
  return bridge.modelList().filter((m) => CHAT_MODELS.includes(m.id));
}

const on = (target, type, fn, opts) => {
  target.addEventListener(type, fn, opts);
  ui.handlers.push([target, type, fn]);
};

/* ------------------------------------------------------------------ wiring -- */

function wire() {
  const { root } = ui;

  on(ui.form, 'submit', (e) => { e.preventDefault(); ui.generating ? stop() : send(); });

  on(ui.input, 'input', () => { grow(); syncComposer(); });
  on(ui.input, 'keydown', (e) => {
    /* Enter sends on a keyboard. On a phone there is no shift key in reach and
       the send button is right there, so Enter is a newline. */
    if (e.key === 'Enter' && !e.shiftKey && !matchMedia('(pointer: coarse)').matches) {
      e.preventDefault();
      if (!ui.generating) send();
    }
  });

  on(ui.suggestions, 'click', (e) => {
    const chip = e.target.closest('.suggestion');
    if (!chip) return;
    ui.input.value = chip.dataset.text;
    grow();
    send();
  });

  /* attachments */
  const plusBtn = $('#plus-btn', root);
  const morphEl = $('#plus-morph', root);
  on(plusBtn, 'click', () => togglePlus(!plusBtn.getAttribute('aria-expanded').includes('true')));
  on($('#pick-file', root), 'click', () => $('#file-input', root).click());
  on($('#file-input', root), 'change', (e) => attach(e.target.files?.[0]));
  on($('#attach-remove', root), 'click', () => setImage(null));
  on(document, 'pointerdown', (e) => {
    if (morphEl.dataset.open === 'true' && !morphEl.contains(e.target)) togglePlus(false);
  });

  /* model picker */
  const pickerBtn = $('#picker-btn', root);
  const pickerMenu = $('#picker-menu', root);
  on(pickerBtn, 'click', () => togglePicker());
  on(pickerMenu, 'click', (e) => {
    const item = e.target.closest('[data-model]');
    if (!item) return;
    ui.model = item.dataset.model;
    localStorage.setItem('narew.model', ui.model);
    /* renderPicker replaces the list, so a keyboard user's focus would land on
       nothing. Hand it back to the button that opened the menu. */
    const fromKeyboard = pickerMenu.contains(document.activeElement);
    togglePicker(false);
    renderPicker();
    syncComposer();
    if (fromKeyboard) pickerBtn.focus();
  });
  on(pickerMenu, 'keydown', pickerKeys);
  on(document, 'pointerdown', (e) => {
    if (!$('#picker', root).contains(e.target)) togglePicker(false);
  });

  on(document, 'narew:presence', () => {
    ui.models = chatModels(ui.ctx.bridge);
    renderPicker();
    syncComposer();
  });

  on(window, 'narew:open-conversation', (e) => openConversation(e.detail.id));

  const newChat = $('#new-chat');
  if (newChat) on(newChat, 'click', reset);

  /*
   * Escape peels one layer at a time, innermost first. An overlay is handled by
   * ui.js and is the innermost thing on screen, so this view keeps its hands
   * off while one is open — otherwise a single press would close the dialog and
   * the menu behind it.
   */
  on(document, 'keydown', (e) => {
    if (e.key !== 'Escape' || !ui) return;
    if (overlayOpen()) return;

    if (!$('#picker-menu', ui.root).hidden) {
      e.stopPropagation();
      togglePicker(false);
      $('#picker-btn', ui.root).focus();
      return;
    }
    if ($('#plus-morph', ui.root)?.dataset.open === 'true') {
      e.stopPropagation();
      togglePlus(false);
      $('#plus-btn', ui.root).focus();
      return;
    }
    if (ui.generating) stop();
  });
}

/* ---------------------------------------------------------------- composer -- */

function grow() {
  ui.input.style.height = 'auto';
  ui.input.style.height = `${Math.min(180, ui.input.scrollHeight)}px`;
}

function currentModel() {
  return ui.models.find((m) => m.id === ui.model) || { id: ui.model, name: ui.model, available: false };
}

/**
 * Decide, in one place, whether the box accepts input — and if it does not, say
 * exactly why. Every refusal here is a real one; nothing pretends to work.
 */
function syncComposer() {
  const model = currentModel();
  const allowance = store.sendAllowance();
  let reason = '';

  if (!store.state.user) reason = 'Zaloguj się, żeby zacząć rozmowę.';
  else if (!model.available) {
    reason = ui.ctx.bridge.online
      ? `${model.name} nie jest teraz publikowany przez Maca.`
      : `${model.name} śpi - włącz Maca w domu.`;
  } else if (!allowance.ok) reason = allowance.reason;

  ui.block.hidden = !reason;
  ui.block.textContent = reason;
  ui.input.disabled = Boolean(reason);
  ui.hint.textContent = reason ? '' : (MODEL_HINT[ui.model] || '');

  /* Between the stop request and the Mac noticing it there is nothing useful to
     press, and the button says which of the two it is. */
  const stopping = Boolean(ui.session?.stopping);
  const canSend = !reason && ui.input.value.trim().length > 0;
  ui.send.disabled = stopping || (!ui.generating && !canSend);
  ui.send.classList.toggle('is-stopping', ui.generating);
  ui.send.setAttribute('aria-label', ui.generating ? (stopping ? 'Zatrzymuję…' : 'Zatrzymaj') : 'Wyślij');
  ui.send.innerHTML = ui.generating
    ? '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2.5" fill="currentColor"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M12 5l-6 6M12 5l6 6"/></svg>';

  ui.input.placeholder = reason ? 'Chwilowo nie da się pisać' : 'Napisz wiadomość…';
}

function togglePlus(open) {
  const btn = $('#plus-btn', ui.root);
  const morph = $('#plus-morph', ui.root);
  const next = open ?? morph.dataset.open !== 'true';
  morph.dataset.open = String(next);
  btn.setAttribute('aria-expanded', String(next));
  /* The surface animates itself in CSS; focus follows it in so the keyboard
     lands on the one thing inside rather than behind it. */
  if (next) $('.plus-panel__item', morph)?.focus({ preventScroll: true });
  else btn.focus({ preventScroll: true });
}

function togglePicker(open) {
  const btn = $('#picker-btn', ui.root);
  const menu = $('#picker-menu', ui.root);
  const next = open ?? menu.hidden;
  btn.setAttribute('aria-expanded', String(next));
  if (!next) {
    menu.hidden = true;
    if (ui.pickerStale) renderPicker();     // catch up on what arrived while open
    return;
  }
  menu.hidden = false;
  /* The listbox takes focus so the arrow keys have somewhere to start; the
     roving tabindex set by renderPicker says where. */
  const items = pickerOptions();
  (items.find((o) => o.tabIndex === 0) || items[0])?.focus({ preventScroll: true });
  enter(menu, { opacity: 0, y: 6, scale: 0.96, duration: 0.24 });
}

const pickerOptions = () => $$('.picker__item', $('#picker-menu', ui.root));

/**
 * Move the one tabbable option, then focus it — a roving tabindex rather than
 * `aria-activedescendant`, because these options really are buttons and Enter
 * and Space should keep working the way a button does without any help.
 */
function focusOption(items, index) {
  const next = (index + items.length) % items.length;
  items.forEach((o, i) => { o.tabIndex = i === next ? 0 : -1; });
  items[next].focus();
}

function pickerKeys(e) {
  const items = pickerOptions();
  if (!items.length) return;
  const here = items.indexOf(document.activeElement);
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); focusOption(items, here + 1); break;
    case 'ArrowUp': e.preventDefault(); focusOption(items, (here < 0 ? 0 : here) - 1); break;
    case 'Home': e.preventDefault(); focusOption(items, 0); break;
    case 'End': e.preventDefault(); focusOption(items, items.length - 1); break;
    /* Tabbing away is a decision not to choose; leaving the menu open behind
       the focus would strand it. */
    case 'Tab': togglePicker(false); break;
    default: break;
  }
}

function renderPicker() {
  const model = currentModel();
  $('#picker-name', ui.root).textContent = model.name;
  $('#picker-dot', ui.root).dataset.state = model.available ? 'online' : 'offline';

  /* Exactly one option is reachable by Tab, and it is the current one — or the
     first, when the stored model is not on the Mac's list at all. */
  /* Only models that can answer right now. A list of things you cannot pick is
     a list of disappointments, and presence already says the Mac is asleep. The
     current one stays regardless, so the menu never contradicts the button. */
  const offered = ui.models.filter((m) => m.available || m.id === ui.model);
  const found = offered.findIndex((m) => m.id === ui.model);
  const roving = found < 0 ? 0 : found;

  /* The Mac's heartbeat fires narew:presence about once a second, and this used
     to rewrite the list every time - including while the menu was open, which
     replaced the options under the pointer and threw away whatever had focus.
     That was the flicker. Rebuild only when the list actually reads differently,
     and never while it is open: the DOM the user is pointing at stays put, and
     an update that arrives meanwhile is applied on the next open. */
  const menu = $('#picker-menu', ui.root);
  const signature = offered.map((m) => `${m.id}:${m.available}:${m.name}`).join('|') + `#${ui.model}`;
  if (menu.dataset.signature === signature) return;
  if (!menu.hidden) { ui.pickerStale = true; return; }
  ui.pickerStale = false;
  menu.dataset.signature = signature;

  menu.innerHTML = offered.map((m, i) => `
    <li role="presentation">
      <button type="button" role="option" data-model="${esc(m.id)}"
              aria-selected="${m.id === ui.model}" tabindex="${i === roving ? '0' : '-1'}"
              class="picker__item ${m.id === ui.model ? 'is-current' : ''}">
        <span class="picker__dot" data-state="${m.available ? 'online' : 'offline'}"></span>
        <span class="picker__body">
          <span class="picker__title">${esc(m.name)}</span>
          <span class="picker__desc">${esc(m.desc || '')}</span>
        </span>
        <span class="picker__state">${m.available ? 'gotowy' : 'śpi'}</span>
      </button>
    </li>`).join('');
}

function fillSuggestions() {
  const pool = [...SUGGESTIONS];
  const pick = [];
  while (pick.length < 4 && pool.length) pick.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  ui.suggestions.innerHTML = pick
    .map((s) => `<button type="button" class="suggestion" data-text="${esc(s)}">${esc(s)}</button>`)
    .join('');
}

/* ------------------------------------------------------------- attachment -- */

/* The database rules cap an image at 400 000 characters of data URL, so the
   file is shrunk here rather than rejected at the far end. */
const MAX_IMAGE_CHARS = 400_000;

async function attach(file) {
  togglePlus(false);
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    toast('Na razie umiem przyjąć tylko obrazek.', 'error');
    return;
  }
  try {
    setImage(await shrink(file));
  } catch (e) {
    toast(`Nie wczytałem tego pliku. ${problem(e, 'Spróbuj innego zdjęcia.')}`, 'error', 5000);
  }
}

function shrink(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('nieczytelny plik'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('to nie jest obrazek'));
      img.onload = () => {
        const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        /* Step the quality down until it fits; give up honestly rather than
           silently sending something the rules will bounce. */
        for (const q of [0.85, 0.7, 0.55, 0.4]) {
          const url = canvas.toDataURL('image/jpeg', q);
          if (url.length <= MAX_IMAGE_CHARS) return resolve(url);
        }
        reject(new Error('zdjęcie jest za duże, spróbuj mniejszym'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function setImage(url) {
  ui.image = url;
  const box = $('#attach-preview', ui.root);
  box.hidden = !url;
  if (url) $('#attach-img', ui.root).src = url;
  syncComposer();
}

/* -------------------------------------------------------------- transcript -- */

function nearBottom() {
  const s = ui.scroll;
  return s.scrollHeight - s.scrollTop - s.clientHeight < 120;
}

function scrollDown(force) {
  if (force || nearBottom()) ui.scroll.scrollTop = ui.scroll.scrollHeight;
}

/** Paragraphs and simple lists. Model output is text; it is escaped first. */
function format(text) {
  return esc(text)
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n').filter(Boolean);
      const bullets = lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l));
      if (bullets && lines.length > 1) {
        const items = lines.map((l) => `<li>${l.replace(/^\s*([-*•]|\d+[.)])\s+/, '')}</li>`).join('');
        return /^\s*\d/.test(lines[0]) ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
      }
      return `<p>${lines.join('<br>')}</p>`;
    })
    .join('');
}

/** `hadImage` is the reopened-from-history case: the picture is gone, the fact
 *  that there was one is not. See `forStorage`. */
function addUser(text, image, hadImage) {
  const node = el(`
    <article class="msg msg--user">
      ${image ? `<img class="msg__image" src="${esc(image)}" alt="Załączony obrazek">` : ''}
      <div class="msg__body">${format(text)}</div>
      ${!image && hadImage ? '<p class="msg__note">Było tu zdjęcie. Historia zapisuje tekst rozmowy, nie obrazy.</p>' : ''}
    </article>`);
  ui.transcript.appendChild(node);
  scrollDown(true);
}

function beginAssistant() {
  const node = el(`
    <article class="msg msg--model is-waiting">
      <div class="msg__who label">${esc(currentModel().name)}</div>
      <div class="msg__body">${DOTS}</div>
    </article>`);
  ui.transcript.appendChild(node);
  scrollDown(true);
  return node;
}

/* -------------------------------------------------------------------- send -- */

async function send() {
  const text = ui.input.value.trim();
  if (!text || ui.generating) return;
  if (!store.state.user) { ui.ctx.go('account'); return; }

  const model = currentModel();
  if (!model.available) { syncComposer(); return; }

  const allowance = store.sendAllowance();
  if (!allowance.ok) {
    toast(allowance.reason, 'error', 6000);
    ui.ctx.go('upgrade');
    return;
  }

  const image = ui.image;
  ui.input.value = '';
  grow();
  setImage(null);
  await leaveHero();

  ui.messages.push({ role: 'user', text, image: image || null });
  addUser(text, image);

  const node = beginAssistant();
  const body = $('.msg__body', node);
  ui.generating = true;
  syncComposer();

  /* One previous exchange, same as the desktop app: this model's context is
     1024 tokens, so more history costs more than it buys. */
  const past = [];
  for (let i = ui.messages.length - 3; i >= 0 && past.length < 1; i -= 2) {
    const u = ui.messages[i];
    const a = ui.messages[i + 1];
    if (u?.role === 'user' && a?.role === 'assistant' && a.text) past.unshift({ user: u.text, assistant: a.text });
  }

  /* One object per generation, so a late write from an abandoned job can tell
     that it is talking about a conversation that has already ended. */
  const session = { node, body, prompt: text, shown: '', closed: false };
  ui.session = session;

  /*
   * The Mac's partial writes are collected, not painted.
   *
   * It streams the whole answer so far several times a second, and rendering
   * each snapshot made the text stutter: words landed at the speed of a laptop
   * under load, the paragraph reflowed on every write, and stopping mid-way
   * left a half sentence. Holding the text until it is complete and then
   * replaying it at a steady pace costs the same total wait and reads as one
   * smooth arrival. The caret keeps the wait honest in the meantime.
   */
  ui.active = ui.ctx.bridge.run({ model: ui.model, text, image, history: past }, (out) => {
    if (session.closed) return;
    armSilence(session);
    if (typeof out.text === 'string') session.shown = out.text;
    if (out.done) finish(session);
  });

  armSilence(session);
}

/** Restart the silence watchdog. Any update at all counts as a sign of life. */
function armSilence(session) {
  clearTimeout(ui.timers.silence);
  ui.timers.silence = setTimeout(() => {
    finish(session, 'Mac przestał odpowiadać w trakcie pisania. Spróbuj jeszcze raz.');
  }, SILENCE_LIMIT);
}

/**
 * Ask the Mac to stop — and promise the user it will stop regardless.
 *
 * The cancel flag is a request: the Mac may be asleep, mid-crash, or simply not
 * reading. So the request goes out and a deadline goes with it; when the
 * deadline passes the view ends the generation on its own and says so.
 */
function stop() {
  const session = ui.session;
  if (!session || session.closed) return;
  ui.active?.cancel?.();
  session.stopping = true;
  syncComposer();
  clearTimeout(ui.timers.stop);
  /* No caption. Pressing stop is a decision the person just made, so telling
     them it happened is telling them what they already know - and it left a
     grey "Przerwane." glued under an answer they may well want to keep. */
  ui.timers.stop = setTimeout(() => finish(session), STOP_GRACE);
}

/**
 * The single exit from a generation.
 *
 * Everything that can end one comes through here — the Mac saying it is done,
 * the stop deadline, the silence watchdog — which is what guarantees the
 * composer is always handed back. `note` is the honest reason when the ending
 * was not the Mac's idea.
 */
async function finish(session, note) {
  if (!ui || session.closed) return;
  const { node, body, prompt } = session;
  const answer = session.shown;

  /* A note means this ending was ours, not the Mac's, so the Mac is told. */
  abandon(Boolean(note));    // closes the session, kills both timers, drops the job
  ui.generating = false;
  node.classList.remove('is-waiting');
  syncComposer();

  if (answer) await reveal(body, answer);
  else body.innerHTML = `<p class="muted">${esc(note || 'Bez odpowiedzi.')}</p>`;

  ui.messages.push({ role: 'assistant', text: answer });

  const tokens = store.estimateTokens(prompt) + store.estimateTokens(answer);
  store.recordUsage(tokens, ui.model);

  try {
    ui.convId = await store.saveConversation({
      id: ui.convId,
      title: ui.messages[0]?.text || 'Bez tytułu',
      model: ui.model,
      messages: forStorage(ui.messages),
    });
  } catch (e) {
    /* A failed save used to be a console line nobody reads, which meant a
       conversation could quietly not exist. Say it out loud instead. */
    toast(`Nie zapisałem tej rozmowy. ${problem(e)}`, 'error', 6000);
  }
}

/**
 * Play the finished answer in, word by word, each one arriving out of focus.
 *
 * The blur is doing real work rather than decorating: a word that fades from
 * unreadable to readable is legible the whole way through, where one that slides
 * or pops draws the eye to the movement instead of the sentence. The pace is
 * fixed here rather than inherited from the Mac, so a laptop under load and an
 * idle one read identically.
 *
 * Long answers speed up: 300 words at a comfortable 18 ms each would be five
 * seconds of waiting for text that is already sitting in memory, so the step
 * shrinks as the answer grows and the whole reveal stays under about a second
 * and a half.
 */
function reveal(body, answer) {
  body.innerHTML = format(answer);
  const words = splitWords(body);
  if (!words.length) return Promise.resolve();

  /* Reduced motion means no reveal at all: the text is already there, and the
     honest equivalent of a gentle animation is simply showing it. */
  if (reduced()) return Promise.resolve();

  const step = Math.max(6, Math.min(20, 1400 / words.length));
  words.forEach((w, i) => {
    w.style.animationDelay = `${Math.round(i * step)}ms`;
    w.classList.add('word-in');
  });

  return new Promise((resolve) => {
    setTimeout(() => {
      /* The classes come off once they have played, so a re-render of the
         transcript later never replays an old animation. */
      words.forEach((w) => w.replaceWith(...w.childNodes));
      body.normalize();
      resolve();
    }, Math.round(words.length * step) + 420);
  });
}

/** Wrap every word in the rendered answer, leaving the markup structure alone. */
function splitWords(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n);

  const spans = [];
  for (const node of texts) {
    const parts = node.textContent.split(/(\s+)/).filter((t) => t !== '');
    if (!parts.length) continue;
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(part)); continue; }
      const span = document.createElement('span');
      span.textContent = part;
      frag.appendChild(span);
      spans.push(span);
    }
    node.replaceWith(frag);
  }
  return spans;
}

/* ------------------------------------------------------------- persistence -- */

/*
 * Firestore keeps a whole conversation in one document and caps a document at
 * 1 MiB. An attached photo is up to 400 000 characters of data URL, so two of
 * them put the write over the line and it throws — the picture would cost the
 * user the entire history it was attached to. The picture is worth having on
 * screen while the chat is open; it is not worth that. What goes to the
 * database is the fact that there was one.
 *
 * The budget is in characters and the cap is in bytes, which is the right way
 * round to be wrong: Polish diacritics cost two bytes each, and 700 000 leaves
 * room for a conversation made of nothing else.
 */
const STORE_BUDGET = 700_000;

function forStorage(messages) {
  const clean = messages.map(({ role, text, image, hasImage }) => (
    image || hasImage ? { role, text, hasImage: true } : { role, text })
  );
  /* Still too long after that? Drop from the front, in whole exchanges, so the
     end of the conversation — the part anyone reopens it for — survives. */
  while (clean.length > 2 && JSON.stringify(clean).length > STORE_BUDGET) clean.splice(0, 2);
  return clean;
}

/* --------------------------------------------------------------- states -- */

/**
 * The one orchestrated moment: the greeting leaves and the box settles at the
 * bottom. It happens once per conversation, so it can afford to be a sequence
 * rather than a fade.
 */
function leaveHero() {
  const dock = $('#composer-dock', ui.root);
  if (ui.chatEl.dataset.state === 'running') return Promise.resolve();
  ui.chatEl.dataset.state = 'running';
  ui.suggestions.innerHTML = '';

  if (reduced()) { ui.hero.hidden = true; return Promise.resolve(); }

  const played = new Promise((resolve) => {
    gsap.timeline({ onComplete: resolve })
      .to(ui.hero, { opacity: 0, y: -18, duration: 0.32, ease: 'power2.in' })
      .set(ui.hero, { display: 'none' })
      .from(dock, { y: 10, duration: 0.34, ease: 'power3.out' }, '-=0.1');
  });

  /* Never let the message wait on the animation.
   *
   * GSAP runs off requestAnimationFrame, which a browser pauses in a background
   * tab - so sending and switching away meant onComplete never fired, the await
   * below never returned, and the message was not drawn at all until the tab
   * came back. The tween is still worth playing; it is just not allowed to be
   * load-bearing. Whichever finishes first wins, and the hero is hidden either
   * way so the transcript cannot open underneath it. */
  return Promise.race([
    played,
    new Promise((resolve) => setTimeout(() => { ui.hero.hidden = true; resolve(); }, 700)),
  ]);
}

function reset() {
  if (!ui) return;
  abandon();
  ui.generating = false;
  ui.messages = [];
  ui.convId = null;
  ui.transcript.innerHTML = '';
  ui.chatEl.dataset.state = 'empty';
  ui.hero.hidden = false;
  gsap.set(ui.hero, { display: '', opacity: 1, y: 0 });
  $('#chat-name', ui.root).textContent = store.firstName();
  fillSuggestions();
  setImage(null);
  syncComposer();
}

async function openConversation(id) {
  try {
    const conv = await store.loadConversation(id);
    if (!conv) { toast('Nie ma takiej rozmowy.', 'error'); return; }
    reset();
    await leaveHero();
    ui.convId = conv.id;
    ui.messages = conv.messages || [];
    ui.model = conv.model || ui.model;
    renderPicker();
    for (const m of ui.messages) {
      if (m.role === 'user') addUser(m.text, m.image, m.hasImage);
      else {
        const node = beginAssistant();
        node.classList.remove('is-waiting');
        $('.msg__body', node).innerHTML = format(m.text || '');
      }
    }
    scrollDown(true);
    syncComposer();
  } catch (e) {
    toast(`Nie otworzyłem tej rozmowy. ${problem(e)}`, 'error', 5000);
  }
}
