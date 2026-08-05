/**
 * Video Studio — the same room as Image Studio, with the lights off.
 *
 * There is no video model. Not trained, not started, not scheduled. So this
 * screen shows the shape the tool would have and says exactly that, with no
 * countdown, no waiting list and no date invented to look busy.
 */

import { esc } from '../ui.js';

const PRESETS = ['Ożyw zdjęcie', 'Przedłuż ujęcie', 'Zmień porę dnia', 'Zapętl ruch'];

export async function mount(root) {
  root.innerHTML = `
    <div class="page page--wide studio studio--off" aria-describedby="video-note">
      <header class="page__head" data-enter>
        <span class="label">Video Studio</span>
        <h2 class="title">Jeszcze nie istnieje</h2>
        <p class="page__lede" id="video-note">
          Nie ma modelu wideo — ani wytrenowanego, ani trenowanego, ani zaplanowanego na konkretny termin.
          Gdyby powstał, byłby czwarty w rodzinie G i robiłby krótkie ujęcia z jednego zdjęcia.
          Do tego czasu ten ekran pokazuje tylko kształt, jaki by miał.
        </p>
      </header>

      <div class="presets" data-enter aria-hidden="true">
        ${PRESETS.map((p) => `
          <div class="preset preset--ghost">
            <span class="preset__title">${esc(p)}</span>
            <span class="preset__prompt muted">niedostępne</span>
          </div>`).join('')}
      </div>

      <div class="studio__grid" data-enter>
        <div class="drop drop--off" aria-disabled="true">
          <div class="drop__empty">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="5.5" width="13" height="13" rx="3"/><path d="m15.5 10.5 6-3.5v10l-6-3.5z"/></svg>
            <p>Wgrywanie wyłączone</p>
            <p class="muted">Nie ma czego uruchomić po drugiej stronie.</p>
          </div>
        </div>

        <div class="studio__panel">
          <span class="label">Co mam zmienić</span>
          <textarea class="field studio__prompt" rows="3" disabled aria-disabled="true" placeholder="niedostępne"></textarea>
          <button class="btn" disabled aria-disabled="true">Przerób</button>
          <p class="studio__hint muted">Wróci tu przycisk, kiedy będzie model, który go obsłuży.</p>
        </div>
      </div>
    </div>`;
}

export function unmount() {}
