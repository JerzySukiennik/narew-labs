/**
 * The annotation overlay — Agentation, loaded on request only.
 *
 * Agentation is a React component and this app has no React, no bundler and no
 * build step, which is the whole point of it. Rather than give that up for a
 * tool only one person uses, React and the component are pulled from a CDN at
 * runtime and mounted into a throwaway root — but only when the URL asks for
 * it.
 *
 *   ai.gzowo.fun/?annotate=1     turn it on (remembered until turned off)
 *   ai.gzowo.fun/?annotate=0     turn it off
 *   Alt+Shift+A                  toggle from anywhere in the app
 *
 * Nobody else ever pays for it: without the flag not one byte of React is
 * fetched, and the import below never runs.
 */

const KEY = 'narew.annotate';

/**
 * Whether the overlay was asked for.
 *
 * Remembered in localStorage rather than for the tab: annotating is something
 * you switch on for a stretch of work, not for one page load, and keeping it in
 * sessionStorage meant closing the tab silently turned it off again. Only
 * `?annotate=0` or the shortcut turns it off now.
 */
export function wanted() {
  const flag = new URLSearchParams(location.search).get('annotate');
  if (flag === '1') { localStorage.setItem(KEY, '1'); return true; }
  if (flag === '0') { localStorage.removeItem(KEY); return false; }
  /* Old sessions stored the same flag per tab; honour it once so turning it on
     before this change does not appear to have been forgotten. */
  if (sessionStorage.getItem(KEY) === '1') {
    localStorage.setItem(KEY, '1');
    return true;
  }
  return localStorage.getItem(KEY) === '1';
}

/**
 * Toggle without touching the URL.
 *
 * Alt+Shift+A, because the overlay is a tool for one person and typing a query
 * string every time is friction that adds up. A reload is the honest way to
 * apply it: the component mounts at boot, and pretending it can be torn down
 * cleanly mid-session would be a guess about someone else's React tree.
 */
export function installShortcut() {
  addEventListener('keydown', (e) => {
    if (!e.altKey || !e.shiftKey || e.key.toLowerCase() !== 'a') return;
    e.preventDefault();
    const on = localStorage.getItem(KEY) === '1';
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, '1');
    location.reload();
  });
}

export async function start() {
  installShortcut();
  if (!wanted()) return;
  try {
    /* Pinned versions, and `deps` so the component resolves against the same
       React instance rather than fetching its own copy. */
    const [React, ReactDOM, agentation] = await Promise.all([
      import('https://esm.sh/react@18.3.1'),
      import('https://esm.sh/react-dom@18.3.1/client'),
      import('https://esm.sh/agentation@3.0.2?deps=react@18.3.1,react-dom@18.3.1'),
    ]);

    const host = document.createElement('div');
    host.id = 'agentation-root';
    document.body.appendChild(host);

    ReactDOM.createRoot(host).render(
      React.createElement(agentation.Agentation, { projectName: 'Narew Labs' }),
    );
    console.info('Agentation włączone. Przełącznik: Alt+Shift+A, albo ?annotate=0');
  } catch (e) {
    /* An annotation tool that fails should be a footnote, never a broken app. */
    console.warn('Nie udało się wczytać Agentation:', e.message);
  }
}
