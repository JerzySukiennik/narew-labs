/**
 * Settings — theme, account, history.
 *
 * Only two things here are destructive, and both ask first. Everything else
 * applies immediately, because a settings screen with a Save button is a screen
 * that can be left in a state the user did not intend.
 */

import { signOutNow, linkGoogle, explainAuthError } from '../firebase.js';
import * as store from '../store.js';
import { $, $$, esc, toast, confirmDestructive, relativeTime, problem } from '../ui.js';

let handlers = [];
let ctxRef = null;

export async function mount(root, ctx) {
  ctxRef = ctx;
  const { user } = store.state;
  const tier = store.activeTier();
  const theme = document.documentElement.dataset.theme;

  root.innerHTML = `
    <div class="page">
      <header class="page__head" data-enter>
        <h2 class="title">Ustawienia</h2>
      </header>

      <section class="card setting" data-enter>
        <div class="setting__head">
          <h3 class="subtitle">Motyw</h3>
          <p class="muted">Ciemny jest domyślny. Zmiana działa od razu.</p>
        </div>
        <div class="segmented" role="group" aria-label="Motyw">
          <button class="segmented__opt ${theme === 'dark' ? 'is-on' : ''}" data-theme="dark" aria-pressed="${theme === 'dark'}">Ciemny</button>
          <button class="segmented__opt ${theme === 'light' ? 'is-on' : ''}" data-theme="light" aria-pressed="${theme === 'light'}">Jasny</button>
        </div>
      </section>

      ${user?.isAnonymous ? `
      <section class="card setting setting--warn" data-enter>
        <div class="setting__head">
          <h3 class="subtitle">Jesteś gościem</h3>
          <p class="muted">
            To konto istnieje tylko w tej przeglądarce. Wyczyszczenie danych strony albo
            wylogowanie kasuje je razem z historią rozmów. Przypięcie do Google zachowuje
            wszystko, co już masz - te same rozmowy, ten sam plan.
          </p>
        </div>
        <div class="setting__actions">
          <button class="btn btn--primary" id="link-google">Przypnij do Google</button>
        </div>
      </section>` : ''}

      <section class="card setting" data-enter>
        <div class="setting__head">
          <h3 class="subtitle">Konto</h3>
          <p class="muted">${esc(user?.email || (user?.isAnonymous ? 'gość' : 'niezalogowany'))} · plan ${esc(tier.name)}</p>
        </div>
        <div class="setting__actions">
          <button class="btn" id="sign-out">Wyloguj</button>
          <button class="btn btn--ghost setting__danger" id="delete-account">Usuń konto</button>
        </div>
      </section>

      <section class="card setting setting--stack" data-enter>
        <div class="setting__head">
          <h3 class="subtitle">Historia rozmów</h3>
          <p class="muted">Rozmowy leżą na twoim koncie, więc widać je na każdym urządzeniu.</p>
        </div>
        <div id="history"><p class="muted">Wczytuję…</p></div>
        <div class="setting__actions">
          <button class="btn btn--ghost setting__danger" id="clear-history">Wyczyść całą historię</button>
        </div>
      </section>
    </div>`;

  $$('[data-theme]', root).forEach((btn) => bind(btn, 'click', async () => {
    /* Imported here rather than at module load: main.js imports this view, so a
       static import would close the cycle. */
    const { setTheme } = await import('../main.js');
    setTheme(btn.dataset.theme);
    $$('[data-theme]', root).forEach((b) => {
      const on = b === btn;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  }));

  bind($('#link-google', root), 'click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      await linkGoogle();
      toast('Konto przypięte do Google. Rozmowy zostały na miejscu.', 'ok', 5000);
      await mount(root, ctx);
    } catch (err) {
      e.currentTarget.disabled = false;
      toast(explainAuthError(err), 'error', 7000);
    }
  });

  bind($('#sign-out', root), 'click', async () => {
    if (store.state.user?.isAnonymous) {
      confirmDestructive({
        title: 'Wyloguj gościa',
        body: 'Konto gościa żyje tylko w tej przeglądarce - po wylogowaniu nie da się do niego wrócić. Znikną rozmowy, plan i zużycie.',
        word: 'wyloguj',
        action: async () => { await signOutNow(); ctx.go('account'); },
      });
      return;
    }
    await signOutNow();
    ctx.go('account');
  });

  bind($('#delete-account', root), 'click', () => confirmDestructive({
    title: 'Usuń konto',
    body: 'Znikną: imię, plan, zużycie i cała historia rozmów. Tego nie da się cofnąć.',
    word: 'usuwam',
    action: async () => {
      await store.deleteAccount();
      toast('Konto usunięte.', 'ok');
      ctx.go('account');
    },
  }));

  bind($('#clear-history', root), 'click', () => confirmDestructive({
    title: 'Wyczyść historię',
    body: 'Wszystkie zapisane rozmowy zostaną skasowane. Konto i plan zostają.',
    word: 'czyszczę',
    action: async () => {
      await store.clearConversations();
      toast('Historia wyczyszczona.', 'ok');
      await renderHistory(root);
    },
  }));

  await renderHistory(root);
}

export function unmount() {
  handlers.forEach(([t, ty, fn]) => t.removeEventListener(ty, fn));
  handlers = [];
  ctxRef = null;
}

function bind(target, type, fn) {
  if (!target) return;
  target.addEventListener(type, fn);
  handlers.push([target, type, fn]);
}

/* -------------------------------------------------------------- history -- */

async function renderHistory(root) {
  const host = $('#history', root);
  const items = await store.listConversations();

  if (!items.length) {
    host.innerHTML = '<p class="muted">Pusto. <a href="#/chat">Zacznij rozmowę</a>.</p>';
    return;
  }

  host.innerHTML = `
    <ul class="history">
      ${items.map((c) => `
        <li class="history__row">
          <button class="history__open" data-open="${esc(c.id)}">
            <span class="history__title">${esc(c.title || 'Bez tytułu')}</span>
            <span class="history__meta muted">${esc(c.model || '')} · ${esc(relativeTime(c.updatedAt || Date.now()))}</span>
          </button>
          <button class="icon-btn history__del" data-del="${esc(c.id)}" aria-label="Usuń rozmowę">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M5 7h14M10 7V5h4v2M8 7l1 12h6l1-12"/></svg>
          </button>
        </li>`).join('')}
    </ul>`;

  $$('[data-open]', host).forEach((btn) => bind(btn, 'click', () => {
    const id = btn.dataset.open;
    sessionStorage.setItem('narew.openConv', id);
    window.dispatchEvent(new CustomEvent('narew:open-conversation', { detail: { id } }));
    ctxRef?.go('chat');
  }));

  $$('[data-del]', host).forEach((btn) => bind(btn, 'click', async () => {
    try {
      await store.deleteConversation(btn.dataset.del);
      await renderHistory(root);
    } catch (e) {
      toast(`Nie usunąłem tej rozmowy. ${problem(e)}`, 'error', 6000);
    }
  }));
}
