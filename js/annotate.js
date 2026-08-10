/**
 * The annotation overlay — Agentation, loaded on request only.
 *
 * Agentation is a React component and this app has no React, no bundler and no
 * build step, which is the whole point of it. Rather than give that up for a
 * tool only one person uses, React and the component are pulled from a CDN at
 * runtime and mounted into a throwaway root — but only when the URL asks for
 * it.
 *
 *   ai.gzowo.fun/?annotate=1     turn it on (remembered for the tab)
 *   ai.gzowo.fun/?annotate=0     turn it off
 *
 * Nobody else ever pays for it: without the flag not one byte of React is
 * fetched, and the import below never runs.
 */

const KEY = 'narew.annotate';

/** Whether the overlay was asked for, by URL now or by this tab earlier. */
export function wanted() {
  const flag = new URLSearchParams(location.search).get('annotate');
  if (flag === '1') { sessionStorage.setItem(KEY, '1'); return true; }
  if (flag === '0') { sessionStorage.removeItem(KEY); return false; }
  return sessionStorage.getItem(KEY) === '1';
}

export async function start() {
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
    console.info('Agentation włączone. Wyłącz: ?annotate=0');
  } catch (e) {
    /* An annotation tool that fails should be a footnote, never a broken app. */
    console.warn('Nie udało się wczytać Agentation:', e.message);
  }
}
