/**
 * The gate — a standalone screen, no sidebar, no chrome. Signed out is not a
 * view among views; it is the only thing the app can honestly show before it
 * knows who is asking.
 *
 * Built as one card rather than centred loose text. A card gives the buttons an
 * edge to sit against, keeps the fine print from competing with the headline,
 * and carries the river at its foot — the same mark the sidebar uses once you
 * are inside, so the first screen already belongs to the product.
 */

import { signIn, signInAsGuest, explainAuthError } from '../firebase.js';
import { $ } from '../ui.js';

let handlers = [];

export function mount(root) {
  root.innerHTML = `
    <div class="gate">
      <div class="gate__card" data-enter>
        <span class="gate__mark" aria-hidden="true">
          <svg viewBox="0 0 32 32" width="34" height="34" fill="none" stroke="currentColor"
               stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M7 26V6"/><path d="M25 26V6"/>
            <path d="M7 6c4.2 3.6 3.4 7.8 6.6 9.4 3.2 1.6 5-1 7 2.2 1.5 2.4 2.3 5.2 4.4 8.4"/>
          </svg>
        </span>

        <h1 class="gate__title">Narew Labs</h1>
        <p class="gate__lede">
          Modele językowe wytrenowane od zera w Gzowie. Odpowiada na nie laptop
          stojący w domu — więc kiedy ma zamkniętą klapę, aplikacja mówi to wprost.
        </p>

        <div class="gate__actions">
          <button class="btn btn--primary gate__btn" id="login-google">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M21.6 12.2c0-.7-.06-1.4-.18-2.05H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.24c1.9-1.75 3-4.32 3-7.35Z"/><path fill="currentColor" d="M12 22c2.7 0 4.97-.9 6.63-2.44l-3.23-2.5c-.9.6-2.05.96-3.4.96-2.6 0-4.8-1.76-5.6-4.13H3.07v2.6A10 10 0 0 0 12 22Z" opacity=".75"/><path fill="currentColor" d="M6.4 13.9a6 6 0 0 1 0-3.82v-2.6H3.07a10 10 0 0 0 0 9.02l3.33-2.6Z" opacity=".5"/><path fill="currentColor" d="M12 5.98c1.47 0 2.79.5 3.83 1.5l2.86-2.86C16.96 2.98 14.7 2 12 2a10 10 0 0 0-8.93 5.48l3.33 2.6C7.2 7.72 9.4 5.98 12 5.98Z" opacity=".85"/></svg>
            Zaloguj przez Google
          </button>
          <button class="btn gate__btn" id="login-guest">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8.5" r="3.6"/><path d="M4.8 20a7.2 7.2 0 0 1 14.4 0"/></svg>
            Wejdź jako gość
          </button>
        </div>

        <p class="gate__error" id="login-error" hidden></p>

        <p class="gate__fine">
          Gość działa tak samo, ale żyje tylko w tej przeglądarce — wyczyszczenie
          danych strony kasuje go bezpowrotnie. Konto trzyma imię, zużycie
          i historię rozmów; nic z tego nie wychodzi poza Firebase tego projektu.
        </p>

        <svg class="gate__river" viewBox="0 0 300 20" preserveAspectRatio="none" aria-hidden="true">
          <path d="M0 10c18-8 32 8 50 0s32-8 50 0 32 8 50 0 32-8 50 0 32 8 50 0 32-8 50 0"
                fill="none" stroke="currentColor" stroke-width="1.4"/>
        </svg>
      </div>
    </div>`;

  const attempt = (id, run) => bind($(id, root), 'click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await run();
    } catch (err) {
      const message = explainAuthError(err);
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
