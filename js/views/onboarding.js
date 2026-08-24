/**
 * Onboarding — three steps, once, right after the first sign-in. A full screen
 * like the gate, not an overlay: this is the first thing an account does, not
 * an interruption to something else.
 */

import * as store from '../store.js';
import { $, el, esc, gsap, reduced, toast, problem } from '../ui.js';

const INTERESTS = [
  { id: 'chat', label: 'Rozmowa', note: 'pytania, listy, gadanie' },
  { id: 'images', label: 'Obrazy', note: 'przeróbki zdjęć' },
  { id: 'testing', label: 'Testuję modele', note: 'ciekawi mnie, co potrafią' },
  { id: 'other', label: 'Coś innego', note: 'jeszcze nie wiem' },
];

const TIERS_ORDER = ['plotka', 'lin', 'sum'];

export function showOnboarding(root) {
  return new Promise((resolve) => {
    const chosen = new Set();
    let step = 1;
    let pickedTier = 'plotka';

    const node = el(`
      <div class="onboard onboard--screen">
        <div class="onboard__bar"><span class="onboard__bar-fill" style="width:33%"></span></div>
        <p class="label onboard__step">Krok <span id="ob-step">1</span> z 3</p>

        <section class="onboard__panel" id="ob-1">
          <h2 class="title">Jak mam do ciebie mówić?</h2>
          <label class="sr-only" for="ob-name">Imię</label>
          <input class="field onboard__input" id="ob-name" maxlength="40" placeholder="Imię" autocomplete="given-name">
          <p class="onboard__error" id="ob-error" hidden>Wpisz imię - od 1 do 40 znaków.</p>
        </section>

        <section class="onboard__panel" id="ob-2" hidden>
          <h2 class="title">Po co tu jesteś?</h2>
          <p class="muted">Można zaznaczyć kilka. Nic to nie blokuje - pomaga później dobrać, co pokazać najpierw.</p>
          <div class="onboard__grid">
            ${INTERESTS.map((i) => `
              <button type="button" class="onboard__tile" data-interest="${esc(i.id)}" aria-pressed="false">
                <span class="onboard__tile-label">${esc(i.label)}</span>
                <span class="onboard__tile-note muted">${esc(i.note)}</span>
              </button>`).join('')}
          </div>
        </section>

        <section class="onboard__panel" id="ob-3" hidden>
          <h2 class="title">Który plan?</h2>
          <p class="muted">Płotka wystarczy na start. Plan zmienisz kiedy chcesz.</p>
          <div class="onboard__tiers">
            ${TIERS_ORDER.map((id) => {
              const t = store.TIERS[id];
              return `
                <button type="button" class="onboard__tier" data-tier="${id}" aria-pressed="${id === 'plotka'}">
                  <span class="onboard__tier-name">${esc(t.name)}</span>
                  <span class="onboard__tier-price mono">${t.price ? `${t.price} zł/mies.` : 'za darmo'}</span>
                  <span class="onboard__tier-blurb muted">${esc(t.blurb)}</span>
                </button>`;
            }).join('')}
          </div>
        </section>

        <footer class="onboard__foot">
          <button type="button" class="btn btn--ghost" id="ob-back" hidden>Wstecz</button>
          <button type="button" class="btn btn--primary" id="ob-next">Dalej</button>
        </footer>
      </div>`);

    root.innerHTML = '';
    root.appendChild(node);

    const q = (sel) => node.querySelector(sel);
    const nameInput = q('#ob-name');
    nameInput.value = (store.state.user?.displayName || '').split(' ')[0] || '';

    const show = (next) => {
      const from = q(`#ob-${step}`);
      const to = q(`#ob-${next}`);
      step = next;
      q('#ob-step').textContent = String(next);
      q('.onboard__bar-fill').style.width = `${Math.round((next / 3) * 100)}%`;
      q('#ob-back').hidden = next === 1;
      q('#ob-next').textContent = next === 3 ? 'Gotowe' : 'Dalej';

      if (reduced()) { from.hidden = true; to.hidden = false; return; }
      gsap.timeline()
        .to(from, { opacity: 0, x: next > step - 1 ? -16 : 16, duration: 0.22, ease: 'power2.in' })
        .set(from, { display: 'none' })
        .set(to, { display: '', opacity: 0, x: 16 })
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

    q('.onboard__tiers').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tier]');
      if (!btn) return;
      pickedTier = btn.dataset.tier;
      q('.onboard__tiers').querySelectorAll('[data-tier]').forEach((b) => {
        b.setAttribute('aria-pressed', String(b === btn));
        b.classList.toggle('is-on', b === btn);
      });
      /* The button says where it goes: a paid plan leads to a checkout, not
         straight into the app. */
      if (step === 3) q('#ob-next').textContent = store.TIERS[pickedTier].price ? 'Dalej do płatności' : 'Gotowe';
    });

    q('#ob-back').addEventListener('click', () => show(step - 1));

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
      if (step === 2) { show(3); return; }

      const btn = q('#ob-next');
      btn.disabled = true;
      try {
        await store.completeOnboarding({ name: nameInput.value.trim(), interests: [...chosen] });
        /* The plan is only *chosen* here — it is handed back so the app can put
           it through the same checkout as everywhere else. Granting it outright
           would make onboarding the one screen where a paid tier costs nothing. */
        resolve(pickedTier);
      } catch (e) {
        btn.disabled = false;
        toast(`Nie zapisałem ustawień. ${problem(e)}`, 'error', 6000);
      }
    });
  });
}
