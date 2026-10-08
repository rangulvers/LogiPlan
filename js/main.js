// Bootstrap (docs/ARCHITECTURE.md 6.7): build the app, bring back the saved project, open a shared plant from the address, show the
// welcome screen on a first visit, and make sure a bug somewhere never leaves the planner staring at a dead page.
//
//   window.__logiplan = { store, runner, ctx }   for debugging and the browser tests (tests/e2e/app.mjs)

import { createApp } from './ui/app.js';
import { hasWork } from './ui/dialogs.js';
import { decodeShare } from './model/serialize.js';

const ERROR_TOAST_GAP_MS = 10000;

/** Is this window 'error' event one of ours? Script errors of browser extensions and the benign ResizeObserver notice are not. */
function isOurError(event) {
  if (/ResizeObserver loop/.test(event.message || '')) return false;
  return !event.filename || event.filename.startsWith(location.origin);
}

/** Tell the planner once (not once per error: an error storm must not become a toast storm) that something broke. */
function installErrorHandler(ctx) {
  let lastShown = -Infinity;
  const report = (event) => {
    if (event.type === 'error' && !isOurError(event)) return;
    const now = performance.now();
    if (now - lastShown < ERROR_TOAST_GAP_MS) return;
    lastShown = now;
    const kept = ctx.store.lastPersistError ? 'Download the project file to be safe.' : 'Your work is saved in this browser.';
    try {
      ctx.toast(`Something went wrong. ${kept} If the page stops responding, reload it.`, { kind: 'error', ms: 10000 });
    } catch {
      // the toast itself is broken: nothing left to say, and no second error to loop on
    }
  };
  window.addEventListener('error', report);
  window.addEventListener('unhandledrejection', report);
}

/** The app could not even be built: say so where "Loading..." stands, instead of leaving it there forever. */
function showStartFailure(err) {
  console.error('[LogiPlan] The app could not start.', err);
  const box = document.querySelector('[data-region="loading"]');
  if (!box) return;
  const title = document.createElement('strong');
  title.textContent = 'LogiPlan could not start.';
  const detail = document.createElement('span');
  detail.textContent = `${err && err.message ? err.message : err} Reload the page; if this keeps happening, try another browser.`;
  box.replaceChildren(title, detail);
}

/** Open the project in a `#p=` share link, if the address holds one. Resolves true when a project was opened. */
async function openSharedProject({ store, toast, dialogs }) {
  const link = location.hash;
  if (!/^#p=/.test(link)) return false;
  history.replaceState(null, '', location.pathname + location.search); // a reload must not ask again
  try {
    const project = await decodeShare(link);
    if (store.getState().dirty) {
      const ok = await dialogs.confirm({
        title: 'Open the shared plant?', text: 'It replaces the plant you are working on. Changes you have not downloaded are lost.', confirmLabel: 'Open shared plant', danger: true,
      });
      if (!ok) return false;
    }
    store.loadProject(project);
    toast(`Opened “${project.name}” from a share link.`, { kind: 'success' });
    if (project.warnings && project.warnings.length) toast(project.warnings.join(' '), { kind: 'warn', ms: 9000 });
    return true;
  } catch (err) {
    toast(err.message || 'This share link could not be opened.', { kind: 'error' });
    return false;
  }
}

/** Bring back the project the autosave holds. True when there was one. */
function restoreProject({ store, toast }) {
  const restored = store.restore();
  if (!restored && store.lastRestoreError) {
    toast('The plant saved in this browser could not be read, so you are starting with an empty one.', { kind: 'warn', ms: 8000 });
  } else if (restored && store.lastRestoreWarnings.length) {
    toast(store.lastRestoreWarnings.join(' '), { kind: 'warn', ms: 9000 });
  }
  return restored;
}

async function start() {
  let app;
  try {
    app = createApp(document.getElementById('app'));
  } catch (err) {
    showStartFailure(err);
    return;
  }
  const { store, runner, ctx } = app;
  window.__logiplan = { store, runner, ctx };
  installErrorHandler(ctx);
  const restored = restoreProject(ctx) && hasWork(store.getState()); // a saved but empty plant is still a first visit
  const shared = await openSharedProject(ctx);
  window.addEventListener('hashchange', () => { void openSharedProject(ctx); });
  if (new URLSearchParams(location.search).has('welcome')) ctx.dialogs.openWelcome();
  else if (!restored && !shared) ctx.dialogs.openWelcome({ auto: true });
}

start();
