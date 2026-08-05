/**
 * Upgrade — three tiers named after the fish you can actually pull out of the
 * Narew, a checkout that is openly a prop, a promo field and a referral link.
 *
 * The checkout deliberately has no card fields at all. A realistic-looking form
 * that quietly does nothing is the one thing here that would be dishonest, so
 * the summary is real, the button is real, and the payment is named as absent.
 */

import * as store from '../store.js';
import { $, $$, el, esc, fmt, toast, overlay, closeOverlay, copyText, gsap, reduced } from '../ui.js';

/* One-stroke silhouettes. Drawn to scale against each other: the płotka is
   slight, the lin is deep-bodied, the sum is long and has barbels. */
const FISH = {
  plotka: `<svg viewBox="0 0 72 34" class="fish" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 17c8-7 24-7 34 0-10 7-26 7-34 0Z"/>
      <path d="M46 17l10-6v12z"/><path d="M26 10.5c2-3 5-4 7-3.5"/><circle cx="19" cy="16" r="1.1" fill="currentColor" stroke="none"/>
    </svg>`,
  lin: `<svg viewBox="0 0 72 34" class="fish" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 17c9-11 28-11 38 0-10 11-29 11-38 0Z"/>
      <path d="M47 17l12-7v14z"/><path d="M24 6.6c3-2.5 8-2.5 11 0"/><path d="M24 27.4c3 2.5 8 2.5 11 0"/>
      <circle cx="17" cy="15.6" r="1.2" fill="currentColor" stroke="none"/>
    </svg>`,
  sum: `<svg viewBox="0 0 72 34" class="fish" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M6 18c12-9 33-10 46-3-11 9-34 9-46 3Z"/>
      <path d="M52 15.4l14-6.4v14z"/>
      <path d="M8 14.5c-2.5-3.5-4-5.5-6.5-6.5M8 20c-2.5 1.5-4 3.5-5.5 6.5"/>
      <path d="M26 8.2c4-2.2 10-2 14 .4"/>
      <circle cx="13" cy="16.4" r="1.3" fill="currentColor" stroke="none"/>
    </svg>`,
};

let handlers = [];
let context = null;

export async function mount(root, ctx) {
  context = ctx;
  render(root);
}

/** Upgrade is a decision, not a place — it opens over whatever screen you were
 *  already on and hands you back to it when you close it. */
export function openAsOverlay(ctx) {
  const node = el('<div class="upgrade-sheet"></div>');
  overlay(node, { label: 'Plany' });
  mount(node, ctx);
}

export function unmount() {
  handlers.forEach(([t, ty, fn]) => t.removeEventListener(ty, fn));
  handlers = [];
  context = null;
}

function bind(target, type, fn) {
  if (!target) return;
  target.addEventListener(type, fn);
  handlers.push([target, type, fn]);
}

function render(root) {
  const current = store.activeTier();
  const until = store.tierExpiresAt();

  root.innerHTML = `
    <div class="page page--wide">
      <header class="page__head" data-enter>
        <span class="label">Plany</span>
        <h2 class="title">Trzy ryby</h2>
        <p class="page__lede">
          Masz teraz <strong>${esc(current.name)}</strong>${until ? ` — do ${new Date(until).toLocaleDateString('pl')}` : ''}.
          Płatności są atrapą: to projekt domowy, nic nie jest pobierane.
        </p>
      </header>

      <div class="tiers" data-enter>
        ${Object.values(store.TIERS).map((t) => card(t, current)).join('')}
      </div>

      <section class="card referral" data-enter>
        <div class="referral__body">
          <h3 class="subtitle">Poleć znajomemu</h3>
          <p class="muted">
            Kto założy konto z twojego linku, dostaje 7 dni planu Lin — i ty razem z nim.
            Do tej pory poleceń: <strong>${store.state.profile?.referrals || 0}</strong>.
          </p>
        </div>
        <button class="btn btn--river" id="ref-btn">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 13a4 4 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1.5 1.5"/><path d="M15 11a4 4 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1.5-1.5"/></svg>
          Weź swój link
        </button>
      </section>
    </div>`;

  $$('[data-buy]', root).forEach((btn) => bind(btn, 'click', () => checkout(btn.dataset.buy, root)));
  bind($('#ref-btn', root), 'click', showReferral);

  if (!reduced()) {
    gsap.from($$('.tier', root), { y: 18, opacity: 0, stagger: 0.07, duration: 0.5, ease: 'power3.out' });
  }
}

function card(tier, current) {
  const isCurrent = tier.id === current.id;
  const cheaper = ['plotka', 'lin', 'sum'].indexOf(tier.id) < ['plotka', 'lin', 'sum'].indexOf(current.id);

  return `
    <article class="tier ${isCurrent ? 'is-current' : ''}" data-tier="${esc(tier.id)}">
      <div class="tier__fish">${FISH[tier.id]}</div>
      <h3 class="tier__name">${esc(tier.name)}</h3>
      <p class="tier__blurb muted">${esc(tier.blurb)}</p>
      <p class="tier__price mono">${tier.price ? `${tier.price} zł<span class="tier__per">/mies.</span>` : 'za darmo'}</p>
      <ul class="tier__perks">
        ${tier.perks.map((p) => `<li>${esc(p)}</li>`).join('')}
      </ul>
      ${isCurrent
        ? '<p class="tier__badge">Twój plan</p>'
        : cheaper
          ? `<button class="btn btn--ghost" data-buy="${esc(tier.id)}">Zejdź na ${esc(tier.name)}</button>`
          : `<button class="btn ${tier.id === 'sum' ? 'btn--accent' : 'btn--primary'}" data-buy="${esc(tier.id)}">Wybieram ${esc(tier.name)}</button>`}
    </article>`;
}

/* ------------------------------------------------------------- checkout -- */

function checkout(tierId, root) {
  const tier = store.TIERS[tierId];
  if (!tier) return;

  const node = el(`
    <div class="checkout">
      <h2 class="title">Podsumowanie</h2>

      <div class="checkout__row"><span>Plan</span><span class="mono">${esc(tier.name)}</span></div>
      <div class="checkout__row"><span>Rozliczenie</span><span class="mono">${tier.price ? 'miesięcznie' : 'brak'}</span></div>
      <div class="checkout__row checkout__row--total"><span>Do zapłaty</span><span class="mono">${tier.price ? `${tier.price},00 zł` : '0,00 zł'}</span></div>

      ${tier.price ? `
      <div class="checkout__card">
        <label class="label" for="co-card-number">Numer karty</label>
        <input class="field mono" id="co-card-number" inputmode="numeric" placeholder="4242 4242 4242 4242" maxlength="19" autocomplete="off">
        <div class="checkout__card-row">
          <div>
            <label class="label" for="co-card-exp">Ważna do</label>
            <input class="field mono" id="co-card-exp" inputmode="numeric" placeholder="MM/RR" maxlength="5" autocomplete="off">
          </div>
          <div>
            <label class="label" for="co-card-cvv">CVV</label>
            <input class="field mono" id="co-card-cvv" inputmode="numeric" placeholder="123" maxlength="3" autocomplete="off">
          </div>
        </div>
      </div>` : ''}

      <div class="checkout__actions">
        <button class="btn btn--ghost" id="co-cancel">Anuluj</button>
        <button class="btn btn--primary" id="co-pay">${tier.price ? 'Zapłać' : 'Przełącz'}</button>
      </div>
      <p class="checkout__fine">Atrapa — pola karty nigdzie nie są wysyłane.</p>

      <details class="promo">
        <summary class="label">Mam kod promocyjny</summary>
        <form class="promo__form" id="promo-form">
          <label class="sr-only" for="promo-input">Kod promocyjny</label>
          <input class="field" id="promo-input" placeholder="wpisz kod" autocomplete="off" spellcheck="false">
          <button class="btn" type="submit">Sprawdź</button>
        </form>
        <p class="promo__result" id="promo-result" hidden></p>
      </details>
    </div>`);

  node.querySelector('#co-cancel').addEventListener('click', closeOverlay);
  node.querySelector('#co-pay').addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    try {
      await store.grantTier(tierId);
      closeOverlay();
      toast(`Masz teraz plan ${tier.name}.`, 'ok');
      context?.refreshShell();
      render(root);
    } catch (err) {
      e.currentTarget.disabled = false;
      toast(`Nie udało się zmienić planu: ${err.message}`, 'error', 6000);
    }
  });
  node.querySelector('#promo-form').addEventListener('submit', (e) => redeem(e, node, root));

  overlay(node, { label: 'Podsumowanie zamówienia' });
}

/* ---------------------------------------------------------------- promo -- */

async function redeem(e, node, root) {
  e.preventDefault();
  const input = node.querySelector('#promo-input');
  const out = node.querySelector('#promo-result');
  const btn = e.target.querySelector('button');

  btn.disabled = true;
  out.hidden = false;
  out.textContent = 'Sprawdzam…';
  out.dataset.state = 'pending';

  const result = await store.redeemPromo(input.value);
  out.textContent = result.message;
  out.dataset.state = result.ok ? 'ok' : 'error';
  btn.disabled = false;

  if (result.ok) {
    input.value = '';
    context?.refreshShell();
    closeOverlay();
    toast(result.message, 'ok');
    render(root);
  }
}

/* ------------------------------------------------------------- referral -- */

function showReferral() {
  const link = store.referralLink();
  const node = el(`
    <div class="checkout">
      <h2 class="title">Twój link</h2>
      <p class="muted">Kto założy z niego konto, dostanie 7 dni planu Lin. Ty dostajesz tyle samo, kiedy następny raz otworzysz aplikację.</p>
      <p class="referral__link mono" id="ref-link">${esc(link)}</p>
      <div class="checkout__actions">
        <button class="btn btn--ghost" id="ref-close">Zamknij</button>
        <button class="btn btn--river" id="ref-copy">Kopiuj link</button>
      </div>
    </div>`);

  node.querySelector('#ref-close').addEventListener('click', closeOverlay);
  node.querySelector('#ref-copy').addEventListener('click', async (e) => {
    const ok = await copyText(link);
    e.currentTarget.textContent = ok ? 'Skopiowane' : 'Zaznacz i skopiuj ręcznie';
    if (!ok) {
      const range = document.createRange();
      range.selectNodeContents(node.querySelector('#ref-link'));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
  });

  overlay(node, { label: 'Link polecający' });
}
