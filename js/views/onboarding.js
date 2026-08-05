/**
 * Onboarding — two questions, once, right after the first sign-in.
 *
 * It asks for a name because the chat screen greets you by it, and for what you
 * came for because that is the only thing worth personalising later. It cannot
 * be dismissed, because a half-made account is worse than one more tap.
 */

import * as store from '../store.js';
import { overlay, closeOverlay, el, esc, gsap, reduced, toast } from '../ui.js';

const INTERESTS = [
  { id: 'chat', label: 'Rozmowa', note: 'pytania, listy, gadanie' },
  { id: 'images', label: 'Obrazy', note: 'przeróbki zdjęć' },
  { id: 'testing', label: 'Testuję modele', note: 'ciekawi mnie, co potrafią' },
  { id: 'other', label: 'Coś innego', note: 'jeszcze nie wiem' },
];

export function showOnboarding() {
  return new Promise((resolve) => {
    const chosen = new Set();
    let step = 1;

    const node = el(`
      <div class="onboard">
        <div class="onboard__bar"><span class="onboard__bar-fill" style="width:50%"></span></div>
        <p class="label onboard__step">Krok <span id="ob-step">1</span> z 2</p>

        <section class="onboard__panel" id="ob-1">
          <h2 class="title">Jak mam do ciebie mówić?</h2>
          <p class="muted">Tym imieniem przywita cię ekran rozmowy.</p>
          <label class="sr-only" for="ob-name">Imię</label>
          <input class="field onboard__input" id="ob-name" maxlength="40" placeholder="Imię" autocomplete="given-name">
          <p class="onboard__error" id="ob-error" hidden>Wpisz imię — od 1 do 40 znaków.</p>
        </section>

        <section class="onboard__panel" id="ob-2" hidden>
          <h2 class="title">Po co tu jesteś?</h2>
          <p class="muted">Można zaznaczyć kilka. Nic to nie blokuje — pomaga później dobrać, co pokazać najpierw.</p>
          <div class="onboard__grid">
            ${INTERESTS.map((i) => `
              <button type="button" class="onboard__tile" data-interest="${esc(i.id)}" aria-pressed="false">
                <span class="onboard__tile-label">${esc(i.label)}</span>
                <span class="onboard__tile-note muted">${esc(i.note)}</span>
              </button>`).join('')}
          </div>
        </section>

        <footer class="onboard__foot">
          <button type="button" class="btn btn--ghost" id="ob-back" hidden>Wstecz</button>
          <button type="button" class="btn btn--primary" id="ob-next">Dalej</button>
        </footer>
      </div>`);

    const q = (sel) => node.querySelector(sel);
    const nameInput = q('#ob-name');
    nameInput.value = (store.state.user?.displayName || '').split(' ')[0] || '';

    const show = (next) => {
      const from = q(`#ob-${step}`);
      const to = q(`#ob-${next}`);
      step = next;
      q('#ob-step').textContent = String(next);
      q('.onboard__bar-fill').style.width = next === 1 ? '50%' : '100%';
      q('#ob-back').hidden = next === 1;
      q('#ob-next').textContent = next === 2 ? 'Gotowe' : 'Dalej';

      if (reduced()) { from.hidden = true; to.hidden = false; return; }
      gsap.timeline()
        .to(from, { opacity: 0, x: next > 1 ? -16 : 16, duration: 0.22, ease: 'power2.in' })
        .set(from, { display: 'none' })
        .set(to, { display: '', opacity: 0, x: next > 1 ? 16 : -16 })
        .call(() => { from.hidden = true; to.hidden = false; })
        .to(to, { opacity: 1, x: 0, duration: 0.32, ease: 'power3.out' });
    };

    q('.onboard__grid').addEventListener('click', (e) => {
      const tile = e.target.closest('[data-interest]');
      if (!tile) return;
      const id = tile.dataset.interest;
      if (chosen.has(id)) chosen.delete(id); else chosen.add(id);
      tile.setAttribute('aria-pressed', String(chosen.has(id)));
      tile.classList.toggle('is-on', chosen.has(id));
    });

    q('#ob-back').addEventListener('click', () => show(1));

    q('#ob-next').addEventListener('click', async () => {
      if (step === 1) {
        const name = nameInput.value.trim();
        if (name.length < 1 || name.length > 40) {
          q('#ob-error').hidden = false;
          nameInput.focus();
          return;
        }
        q('#ob-error').hidden = true;
        show(2);
        return;
      }
      const btn = q('#ob-next');
      btn.disabled = true;
      try {
        await store.completeOnboarding({ name: nameInput.value.trim(), interests: [...chosen] });
        closeOverlay();
        resolve();
      } catch (e) {
        btn.disabled = false;
        toast(`Nie zapisałem: ${e.message}`, 'error', 6000);
      }
    });

    overlay(node, { dismissible: false, label: 'Powitanie' });
  });
}
