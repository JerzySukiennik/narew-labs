/**
 * Account — the sign-in screen, and afterwards the account card.
 *
 * This is the first thing a stranger sees, so it says the two things that are
 * actually true and unusual about this product: the models were trained from
 * scratch, and the machine answering you is a laptop in a house.
 */

import { signIn, signInAsGuest, signOutNow, explainAuthError } from '../firebase.js';
import * as store from '../store.js';
import { $, esc, toast, confirmDestructive, relativeTime } from '../ui.js';

let handlers = [];

export async function mount(root, ctx) {
  const { user, profile } = store.state;
  root.innerHTML = user ? signedIn(user, profile) : signedOut();

  if (user) {
    bind($('#sign-out', root), 'click', async () => {
      /* A guest account cannot be signed back into, so signing out of one is a
         deletion wearing another word. It asks like a deletion. */
      if (user.isAnonymous) {
        confirmDestructive({
          title: 'Wyloguj gościa',
          body: 'Konta gościa nie da się odzyskać po wylogowaniu — znikną rozmowy, plan i zużycie. Chcesz je zachować? Przypnij je do Google w Ustawieniach.',
          word: 'wyloguj',
          action: async () => { await signOutNow(); ctx.go('account'); },
        });
        return;
      }
      await signOutNow();
      ctx.go('account');
    });
    return;
  }

  const attempt = (id, run) => bind($(id, root), 'click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await run();
    } catch (err) {
      const message = explainAuthError(err);
      toast(message, 'error', 7000);
      $('#login-error', root).textContent = message;
      $('#login-error', root).hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  attempt('#login-google', () => signIn('google'));
  attempt('#login-guest', () => signInAsGuest());
}

export function unmount() {
  handlers.forEach(([t, ty, fn]) => t.removeEventListener(ty, fn));
  handlers = [];
}

function bind(target, type, fn) {
  if (!target) return;
  target.addEventListener(type, fn);
  handlers.push([target, type, fn]);
}

/* ------------------------------------------------------------- signed out -- */

function signedOut() {
  return `
    <div class="page gate">
      <div class="gate__mark" data-enter aria-hidden="true">
        <svg viewBox="0 0 32 32" width="46" height="46" fill="none" stroke="currentColor"
             stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M7 26V6"/><path d="M25 26V6"/>
          <path d="M7 6c4.2 3.6 3.4 7.8 6.6 9.4 3.2 1.6 5-1 7 2.2 1.5 2.4 2.3 5.2 4.4 8.4"/>
        </svg>
      </div>

      <h2 class="display gate__title" data-enter>Modele znad Narwi</h2>
      <p class="gate__lede muted" data-enter>
        G-Micro i G-Mini zostały wytrenowane od zera — nie dostrojone, nie wypożyczone.
        Odpowiada na nie laptop stojący w domu w Gzowie, więc kiedy ma zamkniętą klapę,
        aplikacja mówi to wprost zamiast udawać, że myśli.
      </p>

      <div class="gate__actions" data-enter>
        <button class="btn btn--primary" id="login-google">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M21.6 12.2c0-.7-.06-1.4-.18-2.05H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.24c1.9-1.75 3-4.32 3-7.35Z"/><path fill="currentColor" d="M12 22c2.7 0 4.97-.9 6.63-2.44l-3.23-2.5c-.9.6-2.05.96-3.4.96-2.6 0-4.8-1.76-5.6-4.13H3.07v2.6A10 10 0 0 0 12 22Z" opacity=".75"/><path fill="currentColor" d="M6.4 13.9a6 6 0 0 1 0-3.82v-2.6H3.07a10 10 0 0 0 0 9.02l3.33-2.6Z" opacity=".5"/><path fill="currentColor" d="M12 5.98c1.47 0 2.79.5 3.83 1.5l2.86-2.86C16.96 2.98 14.7 2 12 2a10 10 0 0 0-8.93 5.48l3.33 2.6C7.2 7.72 9.4 5.98 12 5.98Z" opacity=".85"/></svg>
          Zaloguj przez Google
        </button>
        <button class="btn" id="login-guest">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8.5" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/></svg>
          Wejdź jako gość
        </button>
      </div>

      <p class="gate__error" id="login-error" hidden></p>

      <p class="gate__fine muted" data-enter>
        Konto trzyma tylko imię, wybrane zainteresowania, zużycie i historię rozmów —
        nic z tego nie wychodzi poza Firebase tego projektu.
        Gość działa tak samo, ale żyje wyłącznie w tej przeglądarce: wyczyszczenie
        danych strony albo wylogowanie kasuje go bezpowrotnie. W Ustawieniach można
        go w każdej chwili przypiąć do konta Google, zachowując rozmowy.
      </p>
    </div>`;
}

/* -------------------------------------------------------------- signed in -- */

function signedIn(user, profile) {
  const tier = store.activeTier();
  const until = store.tierExpiresAt();
  const joined = profile?.createdAt?.toMillis ? profile.createdAt.toMillis() : null;

  return `
    <div class="page">
      <header class="page__head" data-enter>
        <span class="label">Konto</span>
        <h2 class="title">${esc(profile?.name || user.displayName || 'Bez imienia')}</h2>
        <p class="page__lede">${esc(user.email || (user.isAnonymous ? 'konto gościa — bez adresu e-mail' : 'brak adresu e-mail'))}</p>
      </header>

      <div class="card account" data-enter>
        <dl class="account__list">
          <div><dt class="label">Plan</dt><dd>${esc(tier.name)}${until ? ` · do ${new Date(until).toLocaleDateString('pl')}` : ''}</dd></div>
          <div><dt class="label">Sposób logowania</dt><dd>${user.isAnonymous ? 'gość' : esc(user.providerData?.[0]?.providerId || 'nieznany')}</dd></div>
          <div><dt class="label">Konto od</dt><dd>${joined ? esc(relativeTime(joined)) : 'przed chwilą'}</dd></div>
          <div><dt class="label">Polecenia</dt><dd>${profile?.referrals || 0}</dd></div>
        </dl>
        <div class="account__actions">
          <a class="btn" href="#/settings">Ustawienia</a>
          <button class="btn btn--ghost" id="sign-out">Wyloguj</button>
        </div>
      </div>
    </div>`;
}
