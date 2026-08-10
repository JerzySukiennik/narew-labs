/**
 * Image Studio.
 *
 * The UI is complete; the model behind it is not. G-Images exists as a spec and
 * a training pipeline that has never been run, so this screen sends real jobs
 * down the same bridge as chat *when the Mac publishes the model*, and says
 * plainly that it cannot when it does not. There is no placeholder generation.
 */

import * as store from '../store.js';
import { IMAGE_MODELS, DEFAULT_IMAGE_MODEL } from '../bridge.js';
import { $, $$, esc, toast, gsap, reduced } from '../ui.js';

const PRESETS = [
  { title: 'Czarno-białe', prompt: 'zrób to czarno-białe' },
  { title: 'Ołówek', prompt: 'zamień na rysunek ołówkiem' },
  { title: 'Zima', prompt: 'dodaj śnieg' },
  { title: 'Stara fotografia', prompt: 'zrób to jak stara fotografia' },
  { title: 'Rozjaśnij', prompt: 'rozjaśnij zdjęcie' },
  { title: 'Zachód nad Narwią', prompt: 'zrób ciepłe światło zachodu' },
];

const MAX_IMAGE_CHARS = 400_000;

let ui = null;

export async function mount(root, ctx) {
  root.innerHTML = `
    <div class="page page--wide studio">
      <header class="page__head" data-enter>
        <span class="label">Image Studio</span>
        <h2 class="title">Przerabianie zdjęć</h2>
        <p class="page__lede">Wgraj zdjęcie, powiedz, co zmienić. Robi to G-Images — model dyfuzyjny z tej samej rodziny, uruchamiany na Macu w domu.</p>
      </header>

      <div class="presets" data-enter role="list" aria-label="Gotowe przeróbki">
        ${PRESETS.map((p) => `
          <button type="button" class="preset" role="listitem" data-prompt="${esc(p.prompt)}">
            <span class="preset__title">${esc(p.title)}</span>
            <span class="preset__prompt muted">„${esc(p.prompt)}”</span>
          </button>`).join('')}
      </div>

      <p class="studio__state" id="studio-state" data-enter hidden></p>

      <div class="studio__grid" data-enter>
        <div class="drop" id="drop" tabindex="0" role="button" aria-label="Wgraj zdjęcie">
          <input type="file" id="file" accept="image/*" class="sr-only">
          <div class="drop__empty" id="drop-empty">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
            <p>Upuść zdjęcie albo kliknij</p>
            <p class="muted">JPG lub PNG. Duże pliki zmniejszę sam.</p>
          </div>
          <img class="drop__img" id="drop-img" alt="Wgrane zdjęcie" hidden>
        </div>

        <div class="studio__panel">
          <label class="label" for="prompt">Co mam zmienić</label>
          <textarea class="field studio__prompt" id="prompt" rows="3" placeholder="np. zrób to czarno-białe"></textarea>

          <div class="studio__progress" id="progress" hidden>
            <div class="bar__track"><span class="bar__fill" id="progress-fill" style="width:0%"></span></div>
            <p class="muted" id="progress-text">Pracuję…</p>
          </div>

          <div class="picker studio__picker" id="picker">
            <button type="button" class="picker__button" id="picker-btn"
                    aria-haspopup="listbox" aria-expanded="false">
              <span class="picker__dot" id="picker-dot" data-state="offline"></span>
              <span id="picker-name">G-Image 2.1</span>
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                   aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
            </button>
            <ul class="picker__menu" id="picker-menu" role="listbox"
                aria-label="Wersja modelu" hidden></ul>
          </div>

          <button class="btn btn--accent studio__go" id="go">Przerób</button>
          <p class="studio__hint muted" id="hint"></p>
        </div>
      </div>

      <figure class="studio__result" id="result" hidden data-enter>
        <img id="result-img" alt="Wynik przeróbki">
        <figcaption class="studio__result-foot">
          <span class="label" id="result-label"></span>
          <span class="studio__result-actions">
            <a class="btn btn--ghost" id="result-download" download="narew-labs.png">Pobierz</a>
            <button class="btn" id="result-reuse">Użyj jako wejścia</button>
          </span>
        </figcaption>
      </figure>
    </div>`;

  ui = {
    root, ctx, image: null, busy: false, active: null, handlers: [],
    /* Remembered across visits: someone who deliberately picked an older
       version did so for a reason, and should not have to pick it again. */
    model: localStorage.getItem('narew.imageModel') || DEFAULT_IMAGE_MODEL,
    subOpen: false,
  };
  renderPicker();

  wire();
  syncState();
}

export function unmount() {
  ui?.handlers.forEach(([t, ty, fn]) => t.removeEventListener(ty, fn));
  /* Let go of the node without ending the job: cancelling calls back
     synchronously, which would toast "cancelled" at someone who is simply
     walking to another screen. */
  const active = ui?.active;
  ui = null;
  active?.dispose?.();
}

const on = (t, ty, fn) => { t.addEventListener(ty, fn); ui.handlers.push([t, ty, fn]); };

function wire() {
  /* picker */
  const pickerBtn = $('#picker-btn', ui.root);
  const pickerMenu = $('#picker-menu', ui.root);
  on(pickerBtn, 'click', () => togglePicker());
  on(pickerMenu, 'click', (e) => {
    /* The parent row opens the submenu instead of choosing anything — it is a
       container, not a model. */
    if (e.target.closest('#legacy-btn')) {
      ui.subOpen = !ui.subOpen;
      renderPicker();
      return;
    }
    const item = e.target.closest('[data-model]');
    if (!item) return;
    ui.model = item.dataset.model;
    localStorage.setItem('narew.imageModel', ui.model);
    togglePicker(false);
    renderPicker();
  });
  on(document, 'pointerdown', (e) => {
    const p = $('#picker', ui.root);
    if (p && !p.contains(e.target)) togglePicker(false);
  });
  on(document, 'keydown', (e) => {
    if (e.key === 'Escape' && !$('#picker-menu', ui.root).hidden) {
      togglePicker(false);
      pickerBtn.focus();
    }
  });
  /* Availability changes when the Mac wakes or sleeps. */
  on(document, 'narew:presence', () => renderPicker());

  const { root } = ui;
  const drop = $('#drop', root);
  const file = $('#file', root);

  on(drop, 'click', () => file.click());
  on(drop, 'keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); file.click(); } });
  on(file, 'change', (e) => load(e.target.files?.[0]));

  on(drop, 'dragover', (e) => { e.preventDefault(); drop.classList.add('is-over'); });
  on(drop, 'dragleave', () => drop.classList.remove('is-over'));
  on(drop, 'drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    load(e.dataTransfer.files?.[0]);
  });

  $$('.preset', root).forEach((btn) => on(btn, 'click', () => {
    $('#prompt', root).value = btn.dataset.prompt;
    $('#prompt', root).focus();
    syncState();
  }));

  on($('#prompt', root), 'input', syncState);
  on($('#go', root), 'click', run);
  on($('#result-reuse', root), 'click', () => {
    const src = $('#result-img', root).src;
    setImage(src);
    $('#result', root).hidden = true;
  });

  on(document, 'narew:presence', syncState);
}

/* --------------------------------------------------------------- state -- */

/**
 * Why the panel is or is not usable, in one place. Every branch here is a
 * different real cause and gets a different sentence — "coś poszło nie tak" is
 * exactly what this app is not allowed to say.
 */
function reasonBlocked() {
  if (!store.state.user) return 'Zaloguj się, żeby korzystać ze Studia.';
  if (!store.can.image()) return 'lock';
  if (!ui.ctx.bridge.online) return 'Mac w domu śpi — Image Studio potrzebuje go do pracy.';
  if (!ui.ctx.bridge.isAvailable('g-images')) {
    return 'G-Images nie jest jeszcze wytrenowany — na razie istnieje jako specyfikacja i pipeline treningowy, więc Mac go nie publikuje.';
  }
  return '';
}

function syncState() {
  if (!ui) return;
  const { root } = ui;
  const blocked = reasonBlocked();
  const state = $('#studio-state', root);
  const go = $('#go', root);

  if (blocked === 'lock') {
    state.hidden = false;
    state.dataset.kind = 'lock';
    state.innerHTML = 'Image Studio jest w planie <strong>Lin</strong>. Widok zostawiam otwarty, żeby było widać, co się dostaje. <a href="#/upgrade">Zobacz plany</a>.';
  } else if (blocked) {
    state.hidden = false;
    state.dataset.kind = 'off';
    state.textContent = blocked;
  } else {
    state.hidden = true;
  }

  const ready = !blocked && ui.image && $('#prompt', root).value.trim() && !ui.busy;
  go.disabled = !ready;
  $('#hint', root).textContent = ui.busy
    ? ''
    : !ui.image ? 'Najpierw wgraj zdjęcie.'
    : !$('#prompt', root).value.trim() ? 'Napisz, co zmienić — albo wybierz gotowy prompt u góry.'
    : '';
}

/* ---------------------------------------------------------------- upload -- */

async function load(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('To nie jest obrazek.', 'error'); return; }
  try {
    setImage(await shrink(file));
  } catch (e) {
    toast(`Nie mogę wczytać zdjęcia: ${e.message}`, 'error', 6000);
  }
}

/* The database rules cap an image at 400 000 characters of data URL, so it is
   scaled down here instead of being bounced at the far end. */
function shrink(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('nieczytelny plik'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('uszkodzony obrazek'));
      img.onload = () => {
        const scale = Math.min(1, 1024 / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        for (const q of [0.85, 0.7, 0.55, 0.4]) {
          const url = canvas.toDataURL('image/jpeg', q);
          if (url.length <= MAX_IMAGE_CHARS) return resolve(url);
        }
        reject(new Error('nawet po zmniejszeniu jest za duże — spróbuj innym zdjęciem'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function setImage(url) {
  ui.image = url;
  const img = $('#drop-img', ui.root);
  img.src = url || '';
  img.hidden = !url;
  $('#drop-empty', ui.root).hidden = Boolean(url);
  syncState();
}

/* ------------------------------------------------------------------- run -- */

function run() {
  if (ui.busy || reasonBlocked()) return;
  const prompt = $('#prompt', ui.root).value.trim();
  if (!prompt || !ui.image) return;

  /* A planned version carries no wire name, so there is nothing to ask the Mac
     for. Refuse here rather than sending a job the rules would bounce. */
  const wire = currentImageModel().wire;
  if (!wire) {
    toast('Ta wersja modelu jeszcze nie istnieje — wybierz G-Image 1.');
    return;
  }

  ui.busy = true;
  syncState();
  const progress = $('#progress', ui.root);
  const fill = $('#progress-fill', ui.root);
  progress.hidden = false;
  fill.style.width = '2%';

  /* One edit is roughly 35 s of work on the Mac, so the dead man's switch is
     generous — it exists to catch a Mac that died, not one that is busy. */
  /* `ui.model` is which *version* the picker shows — g-image-2-1, g-image-1 and
     so on. The wire protocol has one name for the image model, `g-images`, and
     it is the only one the Mac routes on and the only one the database rules
     accept; sending a version id instead was rejected outright with
     PERMISSION_DENIED, before the Mac ever saw the job. The version stays a
     local preference until there is more than one checkpoint to choose from. */
  ui.active = ui.ctx.bridge.run({ model: wire, text: prompt, image: ui.image }, (out) => {
    if (!ui) return;
    if (typeof out.progress === 'number') {
      fill.style.width = `${Math.round(out.progress * 100)}%`;
      $('#progress-text', ui.root).textContent = `Pracuję… ${Math.round(out.progress * 100)}%`;
    }
    if (out.image) showResult(out.image, out.label);
    if (out.done) {
      ui.busy = false;
      ui.active = null;
      progress.hidden = true;
      if (!out.image) toast(out.text || 'Model nie zwrócił obrazka.', 'error', 6000);
      /* One edit is roughly 35 s of the Mac's time; charging it as ~1500 tokens
         is a stand-in, and the Usage screen says the numbers are estimates. */
      else store.recordUsage(1500, 'g-images');
      syncState();
    }
  }, { idleTimeout: 300_000 });
}

function showResult(dataUrl, label) {
  const box = $('#result', ui.root);
  $('#result-img', ui.root).src = dataUrl;
  $('#result-label', ui.root).textContent = label || 'wynik';
  $('#result-download', ui.root).href = dataUrl;
  box.hidden = false;
  if (!reduced()) gsap.from(box, { opacity: 0, y: 16, duration: 0.45, ease: 'power3.out' });
  box.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'nearest' });
}


/* ---------------------------------------------------------------- picker -- */

/** Availability comes from the Mac's published list; the versions are ours. */
function models() {
  const live = ui.ctx.bridge.modelList();
  return IMAGE_MODELS.map((m) => ({
    ...m,
    /* Match on the wire name, not the version id. Comparing version ids against
       what the Mac publishes could never match — it announces `g-images`, never
       `g-image-1` — so every version showed as asleep even with the bridge up.
       A version with no wire name is planned and stays offline by definition. */
    available: Boolean(m.wire) && live.some((l) => l.id === m.wire && l.available),
  }));
}

function currentImageModel() {
  const all = models();
  return all.find((m) => m.id === ui.model) || all[0];
}

/*
 * Current versions sit in the menu; superseded ones live one level in, behind
 * "Starsze wersje". A newer model is not automatically better at every edit, so
 * the old ones stay reachable — just not in the way of the recommended choice.
 */
function renderPicker() {
  const all = models();
  const current = currentImageModel();
  const btn = $('#picker-name', ui.root);
  if (!btn) return;
  btn.textContent = current.name;
  $('#picker-dot', ui.root).dataset.state = current.available ? 'online' : 'offline';

  const row = (m) => `
    <li role="presentation">
      <button type="button" role="option" data-model="${esc(m.id)}"
              aria-selected="${m.id === ui.model}"
              class="picker__item ${m.id === ui.model ? 'is-current' : ''}">
        <span class="picker__dot" data-state="${m.available ? 'online' : 'offline'}"></span>
        <span class="picker__body">
          <span class="picker__title">${esc(m.name)}</span>
          <span class="picker__desc">${esc(m.desc || '')}</span>
        </span>
        <span class="picker__state">${m.available ? 'gotowy' : 'śpi'}</span>
      </button>
    </li>`;

  const legacy = all.filter((m) => m.legacy);
  const sub = legacy.length ? `
    <li role="presentation" class="picker__submenu ${ui.subOpen ? 'is-open' : ''}">
      <button type="button" class="picker__item picker__item--parent" id="legacy-btn"
              aria-haspopup="true" aria-expanded="${ui.subOpen}">
        <span class="picker__body">
          <span class="picker__title">Starsze wersje</span>
          <span class="picker__desc">${legacy.length} ${legacy.length === 1 ? 'model' : 'modele'}</span>
        </span>
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
             aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>
      </button>
      <ul class="picker__sub" role="listbox" aria-label="Starsze wersje">
        ${legacy.map(row).join('')}
      </ul>
    </li>` : '';

  $('#picker-menu', ui.root).innerHTML = all.filter((m) => !m.legacy).map(row).join('') + sub;
}

function togglePicker(open) {
  const menu = $('#picker-menu', ui.root);
  const next = open === undefined ? menu.hidden : open;
  menu.hidden = !next;
  $('#picker-btn', ui.root).setAttribute('aria-expanded', String(next));
  if (!next) { ui.subOpen = false; renderPicker(); }
}
