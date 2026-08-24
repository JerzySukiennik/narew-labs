/**
 * Boot, routing and the shell.
 *
 * The order here matters and is not accidental:
 *   1. capture a referral before anything can navigate it away;
 *   2. wire the chrome, which must work signed out;
 *   3. wait for Firebase to say who is signed in — the boot gate stays up until
 *      it does, because flashing the sign-in screen at a signed-in user is the
 *      single most obvious way to look broken;
 *   4. load the account, then the route.
 */

import {
  watchAuth, finishRedirectSignIn, explainAuthError, auth,
} from './firebase.js';
import { MacBridge, resolveClient } from './bridge.js';
import * as store from './store.js';
import { $, $$, toast, enterView, gsap, reduced, closeOverlay, enter } from './ui.js';
import { paletteOpen, closePalette } from './palette.js';

/* ------------------------------------------------------------- referral -- */
/* `/r/<uid>` is served by 404.html, which rewrites it to `/?ref=<uid>`. The id
   is parked in sessionStorage because sign-in with redirect leaves and comes
   back, and the query string does not survive the trip. */
const REF_KEY = 'narew.ref';
(function captureReferral() {
  const ref = new URLSearchParams(location.search).get('ref');
  if (ref && /^[A-Za-z0-9]{6,}$/.test(ref)) {
    sessionStorage.setItem(REF_KEY, ref);
    history.replaceState(null, '', location.pathname + location.hash);
  }
})();

/* ------------------------------------------------------------------ routes -- */

const ROUTES = {
  chat: { title: 'Chat', load: () => import('./views/chat.js') },
  image: { title: 'Image Studio', load: () => import('./views/image.js') },
  video: { title: 'Video Studio', load: () => import('./views/video.js') },
  settings: { title: 'Settings', load: () => import('./views/settings.js') },
  account: { title: 'Konto', load: () => import('./views/account.js') },
};

let current = null;      // { name, mod }
let bridge = null;

export const ctx = {
  get bridge() { return bridge; },
  go,
  refreshShell,
  store,
};

function routeName() {
  const raw = (location.hash || '').replace(/^#\/?/, '').split('/')[0];
  return ROUTES[raw] ? raw : 'chat';
}

function go(name) {
  if (location.hash === `#/${name}`) render();
  else location.hash = `#/${name}`;
}

async function render() {
  if (!store.state.user) return;      // the gate screen owns signed-out entirely
  const name = routeName();
  if (current?.name === name) return;

  if (current?.mod?.unmount) {
    try { current.mod.unmount(); } catch (e) { console.warn(e); }
  }
  closeOverlay();

  const host = $(`#view-${name}`);
  $$('.view').forEach((v) => { v.hidden = v !== host; });
  $('#view-title').textContent = ROUTES[name].title;
  $$('.nav__item').forEach((a) => {
    a.classList.toggle('is-active', a.dataset.nav === name);
    if (a.dataset.nav === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });

  const mod = await ROUTES[name].load();
  current = { name, mod };
  host.innerHTML = '';
  await mod.mount(host, ctx);
  enterView(host);
  closeSidebarOnMobile();
}

addEventListener('hashchange', render);

/* -------------------------------------------------------------- sidebar -- */

const SIDEBAR_KEY = 'narew.sidebar';
const app = $('#app');

function applySidebar(mode) {
  app.dataset.sidebar = mode;
  const collapsed = mode === 'collapsed';
  const toggle = $('#sidebar-toggle');
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', collapsed ? 'Rozwiń panel' : 'Zwiń panel');
  localStorage.setItem(SIDEBAR_KEY, mode);
}

function initSidebar() {
  /* A rail by default now, not a column. It used to hold 268px of every screen
     open forever to answer a question that is asked for about two seconds a
     session, and that shape - permanent left sidebar - is what every chat clone
     in the world looks like. Collapsed it is a strip of icons that widens under
     the pointer when you actually want it, and Cmd-K is the fast path for
     everyone who does not. Anyone who preferred it open still gets it open:
     the stored choice wins, only the default changed. */
  const stored = localStorage.getItem(SIDEBAR_KEY);
  applySidebar(stored === 'expanded' ? 'expanded' : 'collapsed');

  $('#sidebar-toggle').addEventListener('click', () => {
    applySidebar(app.dataset.sidebar === 'collapsed' ? 'expanded' : 'collapsed');
  });

  /* The same button means two different things, because the sidebar does. On a
     phone it is a drawer over the content and this opens it; on a desktop it is
     a column and this widens it back out. Wiring it to the drawer everywhere is
     what previously stranded a collapsed desktop sidebar at 68 px with a
     full-viewport scrim over the app and no way back. */
  $('#sidebar-open').addEventListener('click', () => {
    app.dataset.drawer = 'open';
    $('#sidebar-scrim').hidden = false;
  });
  $('#sidebar-scrim').addEventListener('click', closeSidebarOnMobile);
}

function closeSidebarOnMobile() {
  if (app.dataset.drawer === 'open') {
    app.dataset.drawer = 'closed';
    $('#sidebar-scrim').hidden = true;
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSidebarOnMobile();
});

/* ------------------------------------------------------------- palette -- */
/*
 * Navigation as something you summon, so the screens can stay bare. Cmd-K
 * because that is what it is everywhere else and this is not the place to be
 * original; slash is a second opening for anyone who never learned Cmd-K, but
 * only when nothing is being typed into - on a screen whose whole premise is a
 * blinking caret, stealing "/" would be unforgivable.
 */
function commands() {
  const icon = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none"
    stroke="currentColor" stroke-width="1.8" stroke-linecap="round"
    stroke-linejoin="round">${d}</svg>`;

  const list = [
    { group: 'Idź do', label: 'Chat', hint: 'rozmowa z G-Micro',
      icon: icon('<path d="M20 15a2 2 0 0 1-2 2H8l-4 3V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/>'),
      run: () => go('chat') },
    { group: 'Idź do', label: 'Image Studio', hint: 'obrazy',
      icon: icon('<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8.5" cy="9.5" r="1.6"/>'),
      run: () => go('image') },
    { group: 'Idź do', label: 'Settings', icon: icon('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
      run: () => go('settings') },
    { group: 'Idź do', label: 'Konto', icon: icon('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>'),
      run: () => go('account') },

    { group: 'Modele', label: 'G-Images', hint: 'przerabia zdjęcie',
      icon: icon('<rect x="3" y="4" width="18" height="16" rx="3"/>'),
      run: () => openStudio('images') },
    { group: 'Modele', label: 'G-Doodle', hint: 'rysuje z tekstu',
      icon: icon('<path d="M4 20s2-8 8-8 4 6 8 4"/>'), run: () => openStudio('doodle') },
    { group: 'Modele', label: 'G-Weird', hint: 'maluje z tekstu',
      icon: icon('<circle cx="12" cy="12" r="8"/><path d="M8 14c2 2 6 2 8 0"/>'),
      run: () => openStudio('weird') },

    { group: 'Zrób', label: 'Nowa rozmowa', hint: 'zaczyna od zera',
      icon: icon('<path d="M12 5v14M5 12h14"/>'),
      run: () => { go('chat'); $('#new-chat')?.click(); } },
    { group: 'Zrób', label: 'Zmień plan', hint: 'Płotka, Lin, Sum',
      icon: icon('<path d="M4 15c4-9 12-9 16 0"/>'), run: () => $('#nav-upgrade')?.click() },
    { group: 'Zrób', label: 'Rozwiń panel boczny',
      icon: icon('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>'),
      run: () => applySidebar(app.dataset.sidebar === 'collapsed' ? 'expanded' : 'collapsed') },
  ];

  const theme = document.documentElement.dataset.theme;
  list.push({
    group: 'Zrób',
    label: theme === 'light' ? 'Ciemny motyw' : 'Jasny motyw',
    icon: icon('<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>'),
    run: () => setTheme(theme === 'light' ? 'dark' : 'light'),
  });
  return list;
}

/** Image Studio, already open on one family. */
function openStudio(family) {
  go('image');
  /* The view mounts asynchronously, so the request is delivered as an event the
     view picks up whenever it is ready rather than by reaching into it. */
  setTimeout(() => document.dispatchEvent(
    new CustomEvent('narew:open-family', { detail: family })), 60);
}

async function summon() {
  if (paletteOpen()) { closePalette(); return; }
  const { openPalette } = await import('./palette.js');
  openPalette(commands());
}

$('#palette-open')?.addEventListener('click', summon);

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    summon();
    return;
  }
  if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
  const el = document.activeElement;
  if (el && el.closest('input, textarea, select, [contenteditable="true"]')) return;
  e.preventDefault();
  summon();
});

/* ---------------------------------------------------------------- theme -- */

export function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('narew.theme', theme);
  document.dispatchEvent(new CustomEvent('narew:theme', { detail: theme }));
}

/* The theme lives in Settings. It is a preference someone sets once, not a
   control that earns a permanent seat in the chrome of every screen. */

/* ------------------------------------------------------------- upgrade -- */
/* A decision, not a place: it opens over whatever screen you were on and
   closing it returns you there, so it never needs a route of its own. */
function initUpgrade() {
  $('#nav-upgrade').addEventListener('click', async (e) => {
    e.preventDefault();
    const mod = await import('./views/upgrade.js');
    mod.openAsOverlay(ctx);
  });
}

/* ---------------------------------------------------------------- avatar -- */

/**
 * Change the profile picture.
 *
 * Stored as a data URL on the account rather than uploaded anywhere: this app
 * has no file storage, and a 64 px square costs a few kilobytes in a document
 * that is already being written. Squared and shrunk here so a 4 MB photo from a
 * phone never reaches Firestore.
 */
function initAvatar() {
  const input = $('#avatar-input');
  $('#avatar-edit').addEventListener('click', (e) => {
    e.preventDefault();          // the chip around it is a link to the account
    e.stopPropagation();
    input.click();
  });

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file || !store.state.user) return;
    try {
      await store.saveProfile({ photoURL: await squareThumb(file) });
      refreshShell();
      toast('Zdjęcie zmienione.', 'ok');
    } catch (err) {
      toast(`Nie udało się: ${err.message}`, 'error', 6000);
    }
  });
}

/** Centre-cropped 128 px JPEG, small enough to live inside the account doc. */
function squareThumb(file, size = 128) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) return reject(new Error('to nie jest obrazek'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('nieczytelny plik'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('uszkodzony obrazek'));
      img.onload = () => {
        const side = Math.min(img.width, img.height);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        canvas.getContext('2d').drawImage(
          img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ------------------------------------------------------------- presence -- */

/**
 * The river in the sidebar footer is the presence indicator: it flows while the
 * Mac answers and stops when it does not. Views listen for the same event so a
 * composer can lock itself without polling.
 */
function initBridge() {
  bridge = new MacBridge(resolveClient(store.state.profile?.clientId), {
    onPresence: (online, models) => {
      const node = $('#bridge-state');
      node.dataset.state = online ? 'online' : 'offline';
      const names = models.filter((m) => m.available).map((m) => m.name);
      $('#bridge-text').textContent = online
        ? (names.length ? names.join(', ') : 'brak modeli')
        : 'Mac w domu śpi';
      document.dispatchEvent(new CustomEvent('narew:presence', { detail: { online, models } }));
      drawLink();
    },
  });
  /* The beat lands every 20 s, so the reading is refreshed between beats too —
     otherwise a Mac that died would keep showing its last good level. */
  setInterval(drawLink, 4000);
}

/**
 * Draw the link as a level, not as a light.
 *
 * The Mac writes a heartbeat every 20 seconds. How stale the newest one is says
 * something about the link that "online" cannot: a beat two seconds old means
 * the connection is keeping up, and one fifty seconds old means it is limping
 * even though nothing has formally gone offline yet. Four bars, from the age of
 * the last beat.
 */
function drawLink() {
  const node = $('#bridge-state');
  if (!bridge) return;
  const age = bridge.lastBeat ? (Date.now() - bridge.lastBeat) / 1000 : Infinity;
  const level = !bridge.online ? 0 : age < 25 ? 4 : age < 40 ? 3 : age < 55 ? 2 : 1;
  node.dataset.level = String(level);
  node.title = bridge.online
    ? `Sygnał ${level}/4 · ostatni puls ${Math.round(age)} s temu`
    : 'Mac w domu śpi';
}

/* ----------------------------------------------------------------- shell -- */

export function refreshShell() {
  const { user, profile } = store.state;
  const tier = store.activeTier();
  $('#nav-tier').textContent = tier.name;
  $('#nav-tier').dataset.tier = tier.id;

  const name = user ? (profile?.name || user.displayName || 'Bez imienia') : 'Gość';
  $('#user-name').textContent = name;
  $('#user-mail').textContent = user ? (user.email || 'zalogowany') : 'niezalogowany';

  const avatar = $('#user-avatar');
  avatar.textContent = name.slice(0, 1).toUpperCase();
  const photo = profile?.photoURL || user?.photoURL;
  avatar.style.backgroundImage = photo ? `url(${photo})` : '';
  avatar.classList.toggle('has-photo', Boolean(photo));

  /* Free plan does not see the doors it cannot open: Image Studio is simply
     absent from the list rather than shown locked. Video Studio has no entry at
     all - there is no model behind it, so a greyed-out row was advertising a
     screen whose only content is an apology. */
  $('[data-nav="image"]').closest('li').hidden = !store.can.image();

  renderSidebarUsage();
}

/* ------------------------------------------------------------------ usage -- */
/* Two thin bars in the sidebar footer, not a screen of their own — usage is
   ambient information you glance at, not a destination. */
function renderSidebarUsage() {
  const host = $('#sidebar-usage');
  if (!store.state.user) { host.innerHTML = ''; return; }
  const windows = store.usageWindows();
  host.innerHTML = windows.map((w) => {
    const pct = Math.min(100, Math.round((w.used / w.scale) * 100));
    const level = !w.capped ? 'free' : pct >= 90 ? 'high' : pct >= 60 ? 'mid' : 'low';
    return `
      <div class="sidebar-usage__row" data-level="${level}" title="${w.label}: ${w.used.toLocaleString('pl')} / ${w.capped ? w.scale.toLocaleString('pl') : 'bez limitu'}">
        <span class="sidebar-usage__label">${w.key === 'fiveHour' ? '5h' : '7d'}</span>
        <span class="sidebar-usage__track"><span class="sidebar-usage__fill" style="width:${pct}%"></span></span>
      </div>`;
  }).join('');
}

/* -------------------------------------------------------------- screens -- */
/* Three mutually exclusive full-bleed states: signed out (gate), signed in but
   unfinished (onboard), and the app itself. Exactly one is visible at a time. */

function showScreen(which) {
  $('#gate-host').classList.toggle('hidden', which !== 'gate');
  $('#onboard-host').classList.toggle('hidden', which !== 'onboard');
  $('#app').classList.toggle('hidden', which !== 'app');
}

/** Returns the tier picked during onboarding, or null if it did not run. */
async function maybeOnboard() {
  if (!store.needsOnboarding()) return null;
  const { showOnboarding } = await import('./views/onboarding.js');
  showScreen('onboard');
  return showOnboarding($('#onboard-host'));
}

/* ------------------------------------------------------------------ boot -- */

/**
 * Take the boot screen down - and take it down whatever happens.
 *
 * It was removed in the fade's onComplete, and the fade is driven by rAF, which
 * a background tab does not run. Load the app in a tab you are not looking at
 * and the gate froze part-way: a full-viewport layer at z-index 100, stuck at
 * about 8% opacity, still hit-testable. Every click in the app landed on it, and
 * the whole page sat under a faint veil that made flat colours read as slightly
 * different from each other. It never recovered, because the tween that was
 * supposed to finish the job was the thing that had stopped.
 *
 * So the removal no longer depends on the animation finishing. Nothing to look
 * at means nothing to animate: it just goes. Otherwise the fade runs and a
 * timer removes it regardless of whether the tween ever reports back.
 */
function fadeBoot() {
  const boot = $('#boot');
  if (!boot) return;
  /* Never interactive again from this moment, even mid-fade: it is on its way
     out and has no business catching a click on the way. */
  boot.style.pointerEvents = 'none';

  if (reduced() || document.hidden || typeof gsap === 'undefined') {
    boot.remove();
    return;
  }
  gsap.to(boot, { opacity: 0, duration: 0.3, onComplete: () => boot.remove() });
  /* The backstop. If the tab is hidden after this point the tween stops and
     onComplete never fires, so the element is removed on a timer as well -
     timers keep running when frames do not. */
  setTimeout(() => boot.remove(), 1200);
}

function revealShell() {
  if (reduced()) return;
  /* clearProps matters more than the animation does. Below 860 px the sidebar is
     a drawer held off-screen by a CSS transform, and an inline transform left
     behind by the tween outranks it — which parked the drawer open on every
     phone until the first toggle. */
  enter('#sidebar', { x: -12, opacity: 0, duration: 0.5 });
}

let revealed = false;
let appRevealed = false;

async function boot() {
  /* The annotation overlay is off. annotate.js is still in the tree and still
     works; it simply is not started, so no stored ?annotate=1 flag can bring it
     back either. Turning it on again is this one line. */
  // import('./annotate.js').then((m) => m.start()).catch(() => {});

  initSidebar();
  initBridge();
  initUpgrade();
  initAvatar();

  /* A redirect sign-in lands back here; surfacing its error is the only way the
     user learns that, say, the provider was never enabled. */
  finishRedirectSignIn().catch((e) => toast(explainAuthError(e), 'error', 6000));

  watchAuth(async (user) => {
    if (user) {
      try {
        await store.ensureUser(user, { referrer: sessionStorage.getItem(REF_KEY) });
        /* The bridge was built before Firebase said who was signed in, so it is
           sitting on whatever slot this browser had locally. The account may
           carry a different one — adopted from the first device that used it —
           and everything from here has to go there, or the Mac answers into a
           node nobody is listening to. */
        bridge?.setClient(store.state.profile?.clientId);
        sessionStorage.removeItem(REF_KEY);
      } catch (e) {
        toast(`Nie mogę wczytać konta: ${e.message}`, 'error', 8000);
      }
    } else {
      store.resetLocalState();
    }

    if (!revealed) { revealed = true; fadeBoot(); }

    if (!user) {
      const { mount } = await import('./views/login.js');
      showScreen('gate');
      mount($('#gate-host'));
      return;
    }

    const picked = await maybeOnboard();
    refreshShell();
    showScreen('app');
    if (!appRevealed) { appRevealed = true; revealShell(); }

    current = null;                     // force a re-render across sign-in
    if (!location.hash) location.hash = '#/chat';
    await render();

    /* A paid plan chosen during onboarding still has to be paid for. The
       checkout opens over the app the person just landed in, so backing out
       leaves them on the free plan rather than nowhere. */
    if (picked && store.TIERS[picked]?.price) {
      const { openCheckout } = await import('./views/upgrade.js');
      openCheckout(picked, ctx);
    }
  });

  /* If Firebase never answers — offline, blocked, misconfigured — the app still
     has to become usable rather than sitting on a splash screen forever. */
  setTimeout(async () => {
    if (!revealed) {
      revealed = true;
      fadeBoot();
      const { mount } = await import('./views/login.js');
      showScreen('gate');
      mount($('#gate-host'));
      toast('Firebase nie odpowiada. Logowanie może nie działać.', 'error', 8000);
    }
  }, 6000);
}

store.subscribe(() => { if (store.state.ready) refreshShell(); });

boot();

export { auth };
