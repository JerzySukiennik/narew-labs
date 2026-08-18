/**
 * Account — the sign-in screen, and afterwards the account card.
 *
 * This is the first thing a stranger sees, so it says the two things that are
 * actually true and unusual about this product: the models were trained from
 * scratch, and the machine answering you is a laptop in a house.
 */

import { signOutNow } from '../firebase.js';
import * as store from '../store.js';
import { $, esc, confirmDestructive, relativeTime } from '../ui.js';

let handlers = [];

/* Signed-out is handled entirely by views/login.js as a standalone screen —
   this view only ever mounts while a user exists. */
export async function mount(root, ctx) {
  const { user, profile } = store.state;
  root.innerHTML = signedIn(user, profile);

  bind($('#sign-out', root), 'click', async () => {
    /* A guest account cannot be signed back into, so signing out of one is a
       deletion wearing another word. It asks like a deletion. */
    if (user.isAnonymous) {
      confirmDestructive({
        title: 'Wyloguj gościa',
        body: 'Konta gościa nie da się odzyskać po wylogowaniu - znikną rozmowy, plan i zużycie. Chcesz je zachować? Przypnij je do Google w Ustawieniach.',
        word: 'wyloguj',
        action: async () => { await signOutNow(); ctx.go('chat'); },
      });
      return;
    }
    await signOutNow();
  });
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
        <p class="page__lede">${esc(user.email || (user.isAnonymous ? 'konto gościa - bez adresu e-mail' : 'brak adresu e-mail'))}</p>
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
