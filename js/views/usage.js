/**
 * Usage — two rolling windows, and one admission.
 *
 * The bridge streams text, not token counts, so every number here is estimated
 * from character length. That is said on the page rather than hidden, because a
 * counter that looks exact and is not is worse than one that says so.
 */

import * as store from '../store.js';
import { $, esc, fmt, relativeTime } from '../ui.js';

export async function mount(root) {
  const tier = store.activeTier();
  const windows = store.usageWindows();
  const events = [...store.state.usage.events].sort((a, b) => b.at - a.at).slice(0, 12);

  root.innerHTML = `
    <div class="page">
      <header class="page__head" data-enter>
        <span class="label">Zużycie</span>
        <h2 class="title">Ile już przepłynęło</h2>
        <p class="page__lede">Plan ${esc(tier.name)}. Dwa okna, oba przesuwane — liczy się to, co zużyłeś w ostatnich pięciu godzinach i w ostatnich siedmiu dniach.</p>
      </header>

      <div class="bars" data-enter>
        ${windows.map(bar).join('')}
      </div>

      <p class="note" data-enter>
        Tokeny są <strong>szacowane</strong> z długości tekstu (mniej więcej 3,6 znaku na token).
        Most zwraca odpowiedź, nie licznik, więc dokładnej liczby nie da się tu pokazać bez zmyślania.
      </p>

      <section class="recent" data-enter>
        <h3 class="label">Ostatnie odpowiedzi</h3>
        ${events.length ? `
          <ul class="recent__list">
            ${events.map((e) => `
              <li>
                <span class="mono">${fmt.format(e.tokens || 0)}</span>
                <span class="muted">${esc(e.model || 'model')}</span>
                <span class="muted recent__when">${esc(relativeTime(e.at))}</span>
              </li>`).join('')}
          </ul>` : `
          <p class="muted">Nic jeszcze nie przepłynęło. <a href="#/chat">Zacznij rozmowę</a>.</p>`}
      </section>
    </div>`;

  /* Fill the bars after the markup lands, so the width animates from zero
     rather than snapping to its value on first paint. */
  requestAnimationFrame(() => {
    windows.forEach((w) => {
      const fill = $(`#bar-${w.key} .bar__fill`, root);
      if (fill) fill.style.width = `${Math.min(100, (w.used / w.scale) * 100)}%`;
    });
  });
}

export function unmount() {}

function bar(w) {
  const pct = Math.min(100, Math.round((w.used / w.scale) * 100));
  /* Colour is a warning, not decoration: it only leaves green when a real cap
     is actually approaching. */
  const level = !w.capped ? 'free' : pct >= 90 ? 'high' : pct >= 60 ? 'mid' : 'low';

  return `
    <div class="bar" id="bar-${w.key}" data-level="${level}">
      <div class="bar__head">
        <span class="label">${esc(w.label)}</span>
        <span class="mono bar__value">${fmt.format(w.used)} / ${fmt.format(w.scale)}</span>
      </div>
      <div class="bar__track" role="progressbar" aria-valuemin="0" aria-valuemax="${w.scale}"
           aria-valuenow="${w.used}" aria-label="Zużycie: ${esc(w.label)}">
        <span class="bar__fill" style="width:0%"></span>
      </div>
      <p class="bar__note muted">${w.capped
        ? `Limit twojego planu. Po jego wyczerpaniu chat czeka, aż okno się przesunie.`
        : `Bez limitu — ta skala to <strong>punkt odniesienia</strong>, nie próg. Nic się nie zatrzyma.`}</p>
    </div>`;
}
