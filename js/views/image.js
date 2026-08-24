/**
 * Image Studio.
 *
 * The UI is complete; the model behind it is not. G-Images exists as a spec and
 * a training pipeline that has never been run, so this screen sends real jobs
 * down the same bridge as chat *when the Mac publishes the model*, and says
 * plainly that it cannot when it does not. There is no placeholder generation.
 */

import * as store from '../store.js';
import { IMAGE_MODELS, MODEL_FAMILIES, DEFAULT_IMAGE_MODEL } from '../bridge.js';
import { $, $$, esc, toast, reduced, enter, revealText, problem } from '../ui.js';
import { mountPanel, unmountPanel } from '../doodle-panel.js';
import { mountPanel as mountWeird, unmountPanel as unmountWeird,
         setVersion as setWeirdVersion } from '../weird-panel.js';
import { mountNav, unmountNav } from '../pill-nav.js';
import { mountSlider, unmountSlider } from '../version-slider.js';

/*
 * Each preset carries a `look`: a CSS treatment applied to the sample flower so
 * the card shows the change instead of describing it. The previews are drawn,
 * not generated — no checkpoint has ever run — so they promise a direction, and
 * the note under the row says exactly that rather than letting a drawing pass
 * for model output.
 */

/**
 * Everything G-Images can actually do, in its own words.
 *
 * The model does not read sentences. It was trained on a closed set of edit
 * types and matches typed text against their names, so "dodaj gnoma" is not a
 * hard request - it is a request in a language the model does not have. No
 * prompt phrasing fixes that; only training a model that generates freely
 * would, which is a different model. So the honest thing is to put the whole
 * vocabulary on screen before anything is typed, as buttons: the limit stops
 * being a rejection after the click and becomes a menu before it.
 *
 * Mirrors LABELS in AIe/G-Micro/runtime/images.py. The server stays the
 * authority - it answers with this same list when a prompt misses.
 */
const VOCAB = [
  'czarno-białe', 'sepia', 'jaśniej', 'ciemniej', 'mocniejsze kolory',
  'słabsze kolory', 'rozmyte tło', 'wyostrzenie', 'cieplejsze barwy',
  'chłodniejsze barwy', 'negatyw', 'większy kontrast', 'mniejszy kontrast',
  'obraz olejny', 'deszcz', 'śnieg', 'kreskówka', 'pustynia', 'ogień', 'noc',
  'zachód słońca', 'kosmos', 'szkic ołówkiem',
];

const PRESETS = [
  { title: 'Czarno-białe', prompt: 'zrób to czarno-białe', look: 'mono' },
  { title: 'Ołówek', prompt: 'zamień na rysunek ołówkiem', look: 'pencil' },
  { title: 'Zima', prompt: 'dodaj śnieg', look: 'winter' },
  { title: 'Stara fotografia', prompt: 'zrób to jak stara fotografia', look: 'old' },
  { title: 'Rozjaśnij', prompt: 'rozjaśnij zdjęcie', look: 'bright' },
  { title: 'Zachód nad Narwią', prompt: 'zrób ciepłe światło zachodu', look: 'dusk' },
];

/*
 * One flower, drawn once and reused by every card.
 *
 * A photograph would have been easier and worse: it would need loading, it
 * would not survive a theme change, and it would look like a stock asset in a
 * product whose whole point is that everything in it was made here.
 */
const FLOWER = `
  <svg viewBox="0 0 120 120" class="shot__art" aria-hidden="true">
    <rect width="120" height="120" fill="#dfe7ea"/>
    <circle cx="92" cy="26" r="13" fill="#f2e2bd"/>
    <path d="M0 96c18-7 30-4 44 1s28 9 44 3 24-9 32-13v33H0z" fill="#8c9b5a"/>
    <path d="M60 118V58" stroke="#6f7f45" stroke-width="4" stroke-linecap="round" fill="none"/>
    <path d="M60 92c-11-2-17-9-18-18 10-1 17 5 18 18Z" fill="#7d8f4e"/>
    <path d="M60 78c10-2 16-9 17-17-10-1-16 5-17 17Z" fill="#8c9b5a"/>
    <g>
      <ellipse cx="60" cy="30" rx="11" ry="17" fill="#e0913a"/>
      <ellipse cx="60" cy="30" rx="11" ry="17" fill="#e0913a" transform="rotate(60 60 46)"/>
      <ellipse cx="60" cy="30" rx="11" ry="17" fill="#d8813a" transform="rotate(120 60 46)"/>
      <ellipse cx="60" cy="30" rx="11" ry="17" fill="#e0913a" transform="rotate(180 60 46)"/>
      <ellipse cx="60" cy="30" rx="11" ry="17" fill="#d8813a" transform="rotate(240 60 46)"/>
      <ellipse cx="60" cy="30" rx="11" ry="17" fill="#e0913a" transform="rotate(300 60 46)"/>
    </g>
    <circle cx="60" cy="46" r="9" fill="#8a5a1e"/>
  </svg>`;

/*
 * Split down the middle: untouched on the left, treated on the right, so the
 * card carries the comparison rather than the caption.
 *
 * Two sources, and which one is used is not a style choice. If
 * `assets/previews/<wire>/<look>.jpg` exists, it is a real photograph that this
 * exact checkpoint really edited (see tools/make-previews.py) and the card shows
 * the model's own output. If it does not, the card falls back to a drawing that
 * only suggests the direction — and says so underneath, because a drawing
 * presented as model output would be the one lie this screen cannot afford.
 */
const shot = (look) => `
  <span class="shot" data-look="${look}">
    <span class="shot__half shot__half--before">${FLOWER}</span>
    <span class="shot__half shot__half--after">${FLOWER}<span class="shot__wash"></span></span>
    <span class="shot__seam"></span>
  </span>`;

const realShot = (look, wire) => `
  <span class="shot shot--real">
    <span class="shot__half shot__half--before">
      <img class="shot__art" src="assets/previews/base-shot.jpg" alt="" loading="lazy">
    </span>
    <span class="shot__half shot__half--after">
      <img class="shot__art" src="assets/previews/${wire}/${look}.jpg" alt="" loading="lazy">
    </span>
    <span class="shot__seam"></span>
  </span>`;

/**
 * Which of this checkpoint's previews exist on disk.
 *
 * Asked per preset rather than once for the set, because the set is not
 * all-or-nothing: "stara fotografia" maps to no trained edit type, so no model
 * has ever produced one and no model ever will until it is trained. One probe
 * for the whole row would have pointed that card at a file that is not there.
 * A failed load is the answer, not an error - the drawn fallback is a
 * legitimate state, not a fault.
 */
function probePreview(wire, look) {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = `assets/previews/${wire}/${look}.jpg`;
  });
}

/** Swap the drawn cards for real ones once we know they exist. */
async function upgradePreviews() {
  const wire = currentImageModel()?.wire;
  const host = ui?.root;
  if (!wire || !host) return;
  const found = await Promise.all(PRESETS.map((p) => probePreview(wire, p.look)));
  if (!ui || ui.root !== host) return;          // the view went away while we asked
  host.querySelectorAll('.preset').forEach((card, i) => {
    const look = PRESETS[i]?.look;
    if (!look) return;
    card.querySelector('.shot')?.remove();
    card.insertAdjacentHTML('afterbegin', found[i] ? realShot(look, wire) : shot(look));
    card.classList.toggle('preset--drawn', !found[i]);
  });

  const real = found.filter(Boolean).length;
  const note = host.querySelector('.presets__note');
  if (note) {
    note.textContent = real === 0
      ? 'Podglądy są rysunkiem poglądowym - pokazują kierunek przeróbki, nie wynik modelu.'
      : real === found.length
        ? `Prawdziwe zdjęcie przerobione przez ${currentImageModel().name} - po lewej oryginał, po prawej wynik.`
        : `Prawdziwe zdjęcie przerobione przez ${currentImageModel().name}. Karty bez wyniku to rysunek poglądowy - tej przeróbki model nie zna.`;
  }
}

const MAX_IMAGE_CHARS = 400_000;

let ui = null;
let nav = null;
let slider = null;

/* The Mac announces wire names; the pill is grouped by family. */
const familyOfWire = (wire) =>
  (IMAGE_MODELS.find((m) => m.wire === wire) || {}).family || wire;

/**
 * The stored version, but only if it can still be served. A version that lost
 * its wire name (retired when the model was rescaled) would otherwise stay
 * selected forever and refuse every job.
 */
function rememberedModel() {
  const saved = localStorage.getItem('narew.imageModel');
  const known = IMAGE_MODELS.find((m) => m.id === saved);
  if (known && known.wire) return saved;
  if (saved) localStorage.removeItem('narew.imageModel');
  return DEFAULT_IMAGE_MODEL;
}

export async function mount(root, ctx) {
  root.innerHTML = `
    <div class="page page--wide studio">
      <header class="studio__head" data-enter>
        <div class="studio__where">
          <!-- On its own line above the title, and it says where it goes.
               Inline it pushed the title 46px right of every other left edge on
               the page, and a bare arrow only tells you that back exists, not
               back to what. Hidden on the chooser: there is nothing behind it,
               and a dead control is worse than no control. -->
          <button type="button" class="studio__back" id="studio-back" hidden>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
                 stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"
                 aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
            <span>Wybierz model</span>
          </button>
          <h2 class="title" id="studio-title">Image Studio</h2>
        </div>
        <!-- The version belongs to the screen, not to one button: it decides
             what every edit here is answered by, so it sits with the title
             rather than beside the action. -->
        <div class="studio__version" id="version-host" hidden></div>
      </header>

      <!-- The whole first screen: the question, and an arrow at the thing that
           answers it. The three models used to be cards here and are now in the
           pill at the bottom, which is on every screen - so a second, different
           way to pick them would be two controls for one job, and the one that
           only exists on the landing screen would be the one nobody learns. -->
      <section class="chooser" id="chooser">
        <h2 class="chooser__title" id="chooser-title"></h2>
        <div class="chooser__point" aria-hidden="true">
          <svg viewBox="0 0 24 64" fill="none" stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 4v50" class="chooser__point-stem"/>
            <path d="m5 47 7 7 7-7" class="chooser__point-head"/>
          </svg>
        </div>
      </section>

      <p class="studio__state" id="studio-state" data-enter hidden></p>

      <!-- G-Doodle mounts itself here. It shares the screen but not the state
           machine: it runs entirely in the browser and keeps working when the
           Mac that answers everything else is asleep. -->
      <div id="doodle-host"></div>
      <div id="weird-host" hidden></div>

      <section class="studio__step" data-enter>
        <h3 class="studio__step-title"><span class="studio__step-n">1</span> Gotowe przeróbki</h3>
        <div class="presets" role="list" aria-label="Gotowe przeróbki">
          ${PRESETS.map((p) => `
            <button type="button" class="preset" role="listitem" data-prompt="${esc(p.prompt)}">
              ${shot(p.look)}
              <span class="preset__text">
                <span class="preset__title">${esc(p.title)}</span>
                <span class="preset__prompt muted">„${esc(p.prompt)}”</span>
              </span>
            </button>`).join('')}
        </div>
        <p class="presets__note muted">
          Podglądy są rysunkiem poglądowym - pokazują kierunek przeróbki, nie wynik modelu.
        </p>
      </section>

      <section class="studio__step" data-enter>
        <h3 class="studio__step-title"><span class="studio__step-n">2</span> Dodaj zdjęcie i uruchom</h3>
        <div class="studio__grid">
          <div class="drop" id="drop" tabindex="0" role="button" aria-label="Wgraj zdjęcie">
            <input type="file" id="file" accept="image/*" class="sr-only">
            <div class="drop__empty" id="drop-empty">
              <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>
              <p>Upuść zdjęcie albo kliknij</p>
              <p class="muted">JPG lub PNG. Duże pliki zmniejszę sam.</p>
            </div>
            <img class="drop__img" id="drop-img" alt="Wgrane zdjęcie" hidden>
            <button type="button" class="drop__swap" id="drop-swap" hidden>Zmień</button>
            <button type="button" class="drop__clear" id="drop-clear" hidden aria-label="Usuń zdjęcie">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </div>

          <div class="studio__panel">
            <textarea class="field studio__prompt" id="prompt" rows="3" placeholder="np. zrób to czarno-białe"></textarea>

            <div class="studio__progress" id="progress" hidden>
              <div class="bar__track"><span class="bar__fill" id="progress-fill" style="width:0%"></span></div>
              <p class="muted" id="progress-text">Pracuję…</p>
            </div>

            <button class="btn btn--accent studio__go" id="go">Przerób</button>
            <p class="studio__hint muted" id="hint"></p>

            <div class="studio__said" id="studio-said" hidden>
              <p id="studio-said-text"></p>
              <button type="button" class="btn btn--ghost" id="studio-said-close">Rozumiem</button>
            </div>

            <details class="vocab">
              <summary class="label">Co model umie (${VOCAB.length})</summary>
              <div class="vocab__list">
                ${VOCAB.map((v) => `<button type="button" class="vocab__chip" data-vocab="${esc(v)}">${esc(v)}</button>`).join('')}
              </div>
            </details>
          </div>
        </div>
      </section>

      <figure class="studio__result" id="result" hidden data-enter>
        <figcaption class="studio__result-foot">
          <span class="label" id="result-label"></span>
          <span class="studio__result-actions">
            <a class="btn btn--ghost" id="result-download" download="narew-labs.png">Pobierz</a>
            <button class="btn" id="result-reuse">Użyj jako wejścia</button>
          </span>
        </figcaption>
        <img id="result-img" alt="Wynik przeróbki">
      </figure>
    </div>
    <div id="nav-host"></div>`;

  ui = {
    root, ctx, image: null, busy: false, active: null, handlers: [],
    /* Remembered across visits: someone who deliberately picked an older
       version did so for a reason, and should not have to pick it again —
       unless that version has since been withdrawn, in which case the
       remembered choice would leave the screen permanently refusing to run. */
    model: rememberedModel(),
    /* null means the chooser. Kept in memory rather than in the hash so that
       switching families does not remount the view: the editor keeps a photo
       already dropped on it and G-Weird keeps its queue. */
    family: null,
  };

  /* The pill goes up before anything else, because it is the one control that
     is on every screen here - including the chooser, which is now just a label
     and an arrow pointing at it. */
  nav = mountNav($('#nav-host', root), MODEL_FAMILIES, {
    current: MODEL_FAMILIES[0].id,
    onPick: openFamily,
  });
  renderPicker();

  wire();
  syncState();
  upgradePreviews();
  mountPanel($('#doodle-host', root), ctx);
  mountWeird($('#weird-host', root), ctx);
  applyMode();
  showChooser();
}

export function unmount() {
  unmountPanel();
  unmountWeird();
  unmountNav();
  unmountSlider();
  nav = null;
  slider = null;
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
  on($('#studio-back', ui.root), 'click', showChooser);

  /* Delegated, because the banner is rewritten on every state change and a
     handler bound to the button inside it would be thrown away with it. */
  on($('#studio-state', ui.root), 'click', (e) => {
    if (e.target.closest('#see-plans')) ui.ctx.openUpgrade();
  });

  /* The palette can ask for a family directly, so "G-Weird" typed into Cmd-K
     lands on the screen rather than on the chooser in front of it. Delivered as
     an event because the palette has no business knowing this view exists. */
  on(document, 'narew:open-family', (e) => openFamily(e.detail));

  /* Availability changes when the Mac wakes or sleeps, and both new controls
     show it: the pill's dots and the slider's own state. */
  on(document, 'narew:presence', () => {
    const live = ui.ctx.bridge.modelList();
    nav?.presence(live.filter((l) => l.available).map((l) => familyOfWire(l.id)));
    slider?.refresh(live);
    renderPicker();
  });

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
  on($('#drop-swap', root), 'click', (e) => { e.stopPropagation(); file.click(); });
  on($('#drop-clear', root), 'click', (e) => { e.stopPropagation(); setImage(null); });
  on($('#result-reuse', root), 'click', () => {
    const src = $('#result-img', root).src;
    setImage(src);
    $('#result', root).hidden = true;
  });

  on($('#studio-said-close', root), 'click', () => { $('#studio-said', root).hidden = true; });
  on(root, 'click', (e) => {
    const chip = e.target.closest('[data-vocab]');
    if (!chip) return;
    const box = $('#prompt', root);
    /* The label alone, not "zrób to ${label}" - that reads as broken Polish for
       half the list ("zrób to kreskówka") and the model matches on the label
       either way. */
    box.value = chip.dataset.vocab;
    box.focus();
    $('#studio-said', root).hidden = true;
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
  /* A version with no checkpoint can never answer, and that is true whether or
     not the Mac is awake — so it is reported before presence, and reported at
     all times rather than only once someone has pressed the button. */
  const picked = currentImageModel();
  if (!picked.wire) return unservableReason(picked);
  if (!ui.ctx.bridge.online) return 'Mac w domu śpi - Image Studio potrzebuje go do pracy.';
  /* The version actually chosen, not a hardcoded wire name. Every family has
     its own now, so standing in G-Weird with a published g-weird-1 used to
     produce a paragraph about G-Images. */
  if (!ui.ctx.bridge.isAvailable(picked.wire)) {
    return `${picked.name} nie jest teraz publikowany przez Maca. Wybierz inną wersję albo spróbuj później.`;
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
    state.innerHTML = 'Image Studio jest w planie <strong>Lin</strong>. Widok zostawiam otwarty, żeby było widać, co się dostaje. <button type="button" class="linkish" id="see-plans">Zobacz plany</button>.';
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
    : !$('#prompt', root).value.trim() && ui.image ? 'Napisz, co zmienić albo wybierz template u góry.'
    : '';
}

/** Show what the model said, and keep it on screen until it is dismissed. */
function said(text) {
  if (!ui) return;
  const box = $('#studio-said', ui.root);
  $('#studio-said-text', ui.root).textContent = text;
  box.hidden = false;
  box.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'nearest' });
}

/* ---------------------------------------------------------------- upload -- */

async function load(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) { toast('To nie jest obrazek.', 'error'); return; }
  try {
    setImage(await shrink(file));
  } catch (e) {
    toast(`Nie wczytałem tego zdjęcia. ${problem(e, 'Spróbuj innego pliku.')}`, 'error', 6000);
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
        reject(new Error('nawet po zmniejszeniu jest za duże - spróbuj innym zdjęciem'));
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
  $('#drop-swap', ui.root).hidden = !url;
  $('#drop-clear', ui.root).hidden = !url;
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
    toast(unservableReason(currentImageModel()), 'error', 7000);
    return;
  }

  ui.busy = true;
  $('#studio-said', ui.root).hidden = true;
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
      if (!out.image) said(out.text || 'Model nie zwrócił obrazka.');
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
  enter(box, { opacity: 0, y: 16, duration: 0.45 });
  box.scrollIntoView({ behavior: reduced() ? 'auto' : 'smooth', block: 'nearest' });
}


/**
 * Why a version cannot run, and what to use instead.
 *
 * Two different absences look identical in the picker and are not the same
 * thing: one version has not been built yet, another was built and no longer
 * fits the network the Mac assembles. Naming the working version is the point —
 * the old copy told people to pick the retired one.
 */
function unservableReason(model) {
  const servable = IMAGE_MODELS.find((m) => m.wire);
  const instead = servable ? ` Działa ${servable.name}.` : '';
  return model.legacy
    ? `${model.name} jest wycofany - jego wagi nie pasują już do sieci, którą składa Mac, więc nie da się go uruchomić.${instead}`
    : `${model.name} jeszcze nie istnieje - nie ma wytrenowanego checkpointu.${instead}`;
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
/* G-Doodle is not a different model answering the same screen — it takes no
   photo and returns strokes — so selecting it swaps what the screen IS, rather
   than leaving an upload box that nothing will read. Everything stays mounted
   and merely hidden: the panel keeps its canvas and the editor keeps a photo you
   already dropped, so flipping back and forth costs nothing. */
/** Land on the chooser, with the heading arriving a letter at a time. */
function showChooser() {
  ui.family = null;
  revealText($('#chooser-title', ui.root), 'Wybierz model', { by: 'char', step: 34 });
  applyMode();
}

function openFamily(id) {
  if (!MODEL_FAMILIES.some((f) => f.id === id)) return;
  ui.family = id;
  /* Land on the family's own default rather than on whatever was picked last:
     arriving at G-Images from the chooser should not silently serve G-Doodle
     because that is what the previous visit left behind. */
  const inFamily = models().filter((m) => m.family === id && m.wire);
  if (!inFamily.some((m) => m.id === ui.model)) {
    const pick = inFamily.find((m) => m.recommended) || inFamily[0];
    if (pick) { ui.model = pick.id; localStorage.setItem('narew.imageModel', pick.id); }
  }
  renderPicker();
  applyMode();
  syncState();
}

/*
 * Which of the four screens is showing: the chooser, or one of the three
 * families. Everything stays mounted and is merely hidden, so going back and
 * forth costs nothing and loses nothing - the editor keeps a photo already
 * dropped on it, G-Weird keeps its queue.
 */
function applyMode() {
  /* renderPicker runs before ui exists on the first paint, so this has to
     tolerate being called too early rather than throwing - a throw here would
     abort the rest of the caller and leave the picker half-rendered. */
  const host = ui?.root && $('#doodle-host', ui.root);
  if (!host) return;
  const weirdHost = $('#weird-host', ui.root);
  const choosing = ui.family === null;
  const drawing = ui.family === 'doodle';
  const painting = ui.family === 'weird';
  const editing = ui.family === 'images';

  $('#chooser', ui.root).hidden = !choosing;
  host.hidden = !drawing;
  if (weirdHost) weirdHost.hidden = !painting;
  /* The slider writes ui.model; the panel submits jobs, so it has to be told
     which wire the current version maps to. */
  if (painting) {
    const picked = models().find((m) => m.id === ui.model && m.family === 'weird');
    setWeirdVersion(picked?.wire);
  }

  /* Both panels are built as .studio__step too - they share the heading and
     spacing - so hiding the class wholesale would hide the very thing being
     switched to. Each panel's own subtree is excluded. */
  $$('.studio__step', ui.root)
    .filter((el) => !host.contains(el) && !(weirdHost && weirdHost.contains(el)))
    .forEach((el) => { el.hidden = !editing; });

  const family = MODEL_FAMILIES.find((f) => f.id === ui.family);
  /* On the chooser the heading is "Wybierz model" and the top bar already says
     Image Studio, so a second "Image Studio" here is the same word three times
     on one screen. Inside a family the title earns its place: it is the only
     thing naming which model you are looking at. */
  $('#studio-title', ui.root).textContent = family ? family.name : '';
  $('#studio-title', ui.root).hidden = choosing;
  $('#studio-back', ui.root).hidden = choosing;

  /* The version picker answers "which G-Images". On a family with one version
     it would be a menu of one, and on the chooser it would be answering a
     question that has not been asked yet. */
  const versions = models().filter((m) => m.family === ui.family && m.wire);
  $('#version-host', ui.root).hidden = choosing || versions.length < 2;

  /* The pill is the one place a model is chosen, so it follows whatever changed
     the family - a card, the back link, or the pill itself. */
  nav?.select(ui.family || MODEL_FAMILIES[0].id);
}

/**
 * Build the version slider for whichever family is open.
 *
 * Rebuilt on a family change rather than updated, because the ladder itself is
 * different: three rungs for G-Images, one for the others, and a slider with one
 * position is not a slider - it is hidden, the way the dropdown was.
 */
function renderPicker() {
  applyMode();
  const host = ui?.root && $('#version-host', ui.root);
  if (!host) return;

  /* Ascending, which the registry is not: it lists newest first, so the slider
     read 2.1 - 2 - 1 and the ladder ran downhill. Sorted by the version number
     itself so a future 3 lands to the right of 2.1 rather than beside it
     alphabetically. */
  const versions = models()
    .filter((m) => m.family === ui.family && m.wire)
    .sort((a, b) => parseFloat(a.short ?? '0') - parseFloat(b.short ?? '0'));
  const signature = versions.map((v) => v.id).join('|');
  if (host.dataset.signature === signature) { slider?.select(ui.model); return; }
  host.dataset.signature = signature;

  unmountSlider();
  slider = null;
  if (versions.length < 2) { host.innerHTML = ''; return; }

  slider = mountSlider(host, versions, {
    current: ui.model,
    onPick: (id) => {
      ui.model = id;
      localStorage.setItem('narew.imageModel', id);
      /* A different checkpoint edited different pictures. */
      upgradePreviews();
      applyMode();
      syncState();
    },
  });
}


