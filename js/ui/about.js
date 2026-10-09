// The version of the running app (docs/ARCHITECTURE.md 6.11): the chip at the bottom right of the window and the About dialog behind it.
//
//   const chip = createVersionChip(ctx, { signal });    // chip.el is a <button> ("v0.6.0", "v0.6.0 dev") that opens the dialog; the update watcher lives here
//   openAbout(ctx, dlg, { build });                     // called as ctx.dialogs.openAbout(): version, build, build time, where it runs, copy button, what is new
//   loadChangelog({ fetchFn }) -> Promise<entries>      // CHANGELOG.md next to index.html, read once and kept (the site build copies it)
//
// What it shows comes from js/build-info.js (what this copy IS) and, for the hint "Update available", from js/update-check.js (what the site serves now).
// The hint is passive: a dot and the word "Update" on the chip, a box with a Reload button in the dialog; nothing reloads by itself and nothing pops up.
//
// Safety. Everything fetched (CHANGELOG.md, version.json) is shown with textContent and element nodes only, never as markup; only **bold**, *italic*
// and `code` of a changelog line are understood (parseInline in js/version.js). The dialog uses the modal primitives of dialogs.js (focus trap, Escape,
// focus goes back to where it came from). Styles are scoped here (addStyles), tokens only, so both themes and the narrow layout follow the kit.
//
// The pure parts (texts, dates, the changelog parser, the update decision) are in js/version.js and tested in tests/version.*.test.js; the DOM
// behaviour is driven in a real browser by tests/e2e/about.mjs.

import { h } from '../util/dom.js';
import { BUILD } from '../build-info.js';
import { createUpdateWatcher } from '../update-check.js';
import {
  parseChangelog, parseInline, normalizeBuild, versionLabel, chipTooltip, chipAriaLabel, formatBuildDate, formatDay, whereItRuns, commitUrl,
  bugReportLine, compareVersions,
} from '../version.js';
import { icon } from './icons.js';
import { addStyles } from './ops-styles.js';

/** The site's list of changes, relative to the page like every other asset. */
export const CHANGELOG_URL = 'CHANGELOG.md';
const CHANGELOG_TIMEOUT_MS = 10_000;

const CSS = `
.versionchip{display:inline-flex;flex:none;align-items:center;gap:6px;height:24px;padding:0 var(--sp-2);border:0;border-radius:var(--radius-pill);background:transparent;
  color:var(--text-dim);font-size:var(--fs-sm);font-weight:var(--fw-medium);line-height:1;white-space:nowrap;font-variant-numeric:tabular-nums}
.versionchip:hover{background:var(--hover);color:var(--text)}
.versionchip:active{background:var(--pressed)}
@media (pointer:coarse){.versionchip{min-height:32px}}
.versionchip::after{right:0;left:auto;transform:none;max-width:min(240px,calc(100vw - var(--sp-4)))}
.versionchip::before{right:calc(var(--sp-2) + 8px);left:auto;transform:none}
.versionchip__dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--accent)}
.versionchip__hint{color:var(--accent-text);font-weight:var(--fw-semibold)}
.about{display:flex;flex-direction:column;gap:var(--sp-4);min-width:0}
.about__head{display:flex;align-items:center;gap:var(--sp-3)}
.about__logo{flex:none;display:block;border-radius:9px}
.about__name{font-size:var(--fs-xl);font-weight:var(--fw-semibold);line-height:var(--lh-tight)}
.about__tagline{color:var(--text-dim);font-size:var(--fs-sm);line-height:var(--lh)}
.about .kv dd{text-align:left;overflow-wrap:anywhere}
.about .kv dd .about__dim{color:var(--text-dim);font-weight:var(--fw-regular)}
.about__copy{display:flex;flex-direction:column;gap:var(--sp-2);align-items:flex-start}
.about__line{display:block;max-width:100%;padding:6px var(--sp-2);border-radius:var(--radius-md);background:var(--surface-2);color:var(--text);
  font-family:var(--font-mono);font-size:var(--fs-sm);line-height:1.4;overflow-wrap:anywhere;user-select:all}
.about__row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--sp-2)}
.about__title{margin:0;font-size:var(--fs-lg);font-weight:var(--fw-semibold)}
.about__news{display:flex;flex-direction:column;gap:var(--sp-2);min-width:0}
.about__entry{border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--surface)}
.about__toggle{display:flex;align-items:center;gap:var(--sp-2);width:100%;min-height:36px;padding:6px var(--sp-3);border:0;border-radius:var(--radius-lg);
  background:transparent;color:var(--text);text-align:left}
.about__toggle:hover{background:var(--hover)}
.about__toggle .icon{flex:none;color:var(--text-dim);transition:transform var(--t-fast) var(--ease)}
.about__toggle[aria-expanded="true"] .icon{transform:rotate(90deg)}
.about__version{font-weight:var(--fw-semibold)}
.about__date{color:var(--text-dim);font-size:var(--fs-sm)}
.about__body{padding:0 var(--sp-3) var(--sp-3) var(--sp-3);display:flex;flex-direction:column;gap:var(--sp-3)}
.about__sec{margin:0 0 4px;color:var(--text-dim);font-size:var(--fs-xs);font-weight:var(--fw-semibold);letter-spacing:.04em;text-transform:uppercase}
.about__list{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px;font-size:var(--fs-md);line-height:var(--lh)}
.about__list code{padding:0 4px;border-radius:var(--radius-xs);background:var(--surface-3);font-family:var(--font-mono);font-size:.92em}
.about__links{display:flex;flex-wrap:wrap;gap:var(--sp-2) var(--sp-4);font-size:var(--fs-sm)}
.about__update:not(:empty){margin-bottom:var(--sp-3)}
.about__hint{margin:0;color:var(--text-dim);font-size:var(--fs-sm);line-height:1.4}
`;

// ---------------------------------------------------------------------------------------------------------
// The list of changes
// ---------------------------------------------------------------------------------------------------------

let changelogOnce = null;

/** An error whose message is meant for the planner (anything else that goes wrong while loading is reported as "offline"). */
class ChangelogError extends Error {}

/**
 * Read CHANGELOG.md once and keep the answer (a failure is not kept, so the next call asks again).
 * @param {{ fetchFn?: Function, url?: string, force?: boolean }} [opts]
 * @returns {Promise<ReturnType<typeof parseChangelog>>} resolves with at least one entry, rejects with an Error whose message the planner can read
 */
export function loadChangelog({ fetchFn = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null, url = CHANGELOG_URL, force = false } = {}) {
  if (changelogOnce && !force) return changelogOnce;
  const attempt = (async () => {
    if (typeof fetchFn !== 'function') throw new ChangelogError('This browser cannot load the list of changes.');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), CHANGELOG_TIMEOUT_MS) : null;
    try {
      const res = await fetchFn(url, { cache: 'no-cache', signal: controller ? controller.signal : undefined });
      if (!res || !res.ok) throw new ChangelogError('The list of changes was not found.');
      const entries = parseChangelog(await res.text());
      if (!entries.length) throw new ChangelogError('The list of changes could not be read.');
      return entries;
    } catch (err) {
      throw err instanceof ChangelogError ? err : new ChangelogError('The list of changes could not be loaded. Are you offline?');
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  })();
  changelogOnce = attempt;
  attempt.catch(() => { if (changelogOnce === attempt) changelogOnce = null; });
  return attempt;
}

/** The nodes of one changelog line: text, <strong>, <em>, <code>; set with textContent only. */
function inlineNodes(text) {
  return parseInline(text).map((part) => (part.type === 'text' ? document.createTextNode(part.text) : h(part.type === 'strong' ? 'strong' : part.type === 'em' ? 'em' : 'code', null, part.text)));
}

/** Which entries start open: the newest release and, when there is one, the unreleased changes above it. */
export function openByDefault(entries) {
  const open = new Set();
  const firstRelease = entries.findIndex((e) => !e.unreleased);
  entries.forEach((e, i) => { if ((e.unreleased && e.sections.length) || i === firstRelease) open.add(i); });
  if (!open.size && entries.length) open.add(0);
  return open;
}

let entryCounter = 0;

/** The "What is new" list: one disclosure button per version (newest first), each opening its sections of bullet points. */
export function renderChangelog(entries, { currentVersion = null } = {}) {
  const open = openByDefault(entries);
  const list = h('div', { class: 'about__news' });
  entries.forEach((entry, i) => {
    const id = `about-entry-${++entryCounter}`;
    const isOpen = open.has(i);
    const day = entry.date ? formatDay(entry.date) : '';
    const mark = !entry.unreleased && currentVersion
      ? (compareVersions(entry.version, currentVersion) === 0 ? 'Your version' : compareVersions(entry.version, currentVersion) > 0 ? 'Newer than yours' : '')
      : '';
    const toggle = h('button', { class: 'about__toggle', type: 'button', 'aria-expanded': String(isOpen), 'aria-controls': id },
      icon('chevron-right', { size: 16 }),
      h('span', { class: 'about__version' }, entry.unreleased ? 'Latest changes' : `Version ${entry.version}`),
      day ? h('span', { class: 'about__date' }, day) : null,
      entry.unreleased ? h('span', { class: 'about__date' }, 'not in a numbered version yet') : null,
      h('span', { class: 'spacer' }),
      mark ? h('span', { class: `chip${mark === 'Newer than yours' ? ' chip--info' : ''}` }, mark) : null);
    const body = h('div', { class: 'about__body', id, hidden: !isOpen },
      entry.sections.map((section) => h('div', null,
        h('h4', { class: 'about__sec' }, section.title),
        h('ul', { class: 'about__list' }, section.items.map((item) => h('li', null, inlineNodes(item)))))));
    toggle.addEventListener('click', () => {
      const next = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(next));
      body.hidden = !next;
    });
    list.append(h('div', { class: 'about__entry' }, toggle, body));
  });
  return list;
}

// ---------------------------------------------------------------------------------------------------------
// Copying
// ---------------------------------------------------------------------------------------------------------

/** Put `text` on the clipboard: the clipboard API, then the old copy command on a temporary text field inside `host`. True when it worked. */
export async function copyText(text, host = document.body) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = h('textarea', { readonly: '', 'aria-hidden': 'true', tabindex: '-1', style: { position: 'fixed', left: '-9999px', top: '0', opacity: '0' } }, text);
    const before = document.activeElement;
    try {
      host.append(field);
      field.focus();
      field.select();
      return document.execCommand('copy') === true;
    } catch {
      return false;
    } finally {
      field.remove();
      if (before && typeof before.focus === 'function') before.focus({ preventScroll: true });
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// The chip
// ---------------------------------------------------------------------------------------------------------

const watchers = new WeakMap(); // ctx -> update watcher (so the dialog shows what the chip knows)

/**
 * The version chip: a button with the version number; it carries a dot and the word "Update" while the site serves a newer build.
 * Starts the update watcher (a development build never checks).
 * @param {object} ctx shared context (needs ctx.dialogs.openAbout)
 * @param {{ signal?: AbortSignal, build?: object, watcher?: object }} [opts] `signal` stops the watcher with the app
 * @returns {{ el: HTMLButtonElement, watcher: object }}
 */
export function createVersionChip(ctx, { signal, build = BUILD, watcher = createUpdateWatcher({ build }) } = {}) {
  addStyles('about-styles', CSS);
  watchers.set(ctx, watcher);
  const b = normalizeBuild(build);
  const label = h('span', null, versionLabel(b));
  const dot = h('span', { class: 'versionchip__dot', 'aria-hidden': 'true', hidden: true });
  const hint = h('span', { class: 'versionchip__hint', hidden: true }, 'Update');
  const el = h('button', { class: 'versionchip', type: 'button', 'aria-haspopup': 'dialog', onclick: () => ctx.dialogs.openAbout() }, label, dot, hint);
  const paint = (state) => {
    const update = state && state.available ? state.remote : null;
    dot.hidden = !update;
    hint.hidden = !update;
    el.dataset.tip = chipTooltip(b, { update });
    el.setAttribute('aria-label', chipAriaLabel(b, { update }));
    el.classList.toggle('is-update', Boolean(update));
  };
  paint(watcher.state());
  watcher.subscribe(paint);
  watcher.start({ document, signal });
  return { el, watcher };
}

// ---------------------------------------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------------------------------------

const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);

/** The facts of the build as the viewer reads them: rows of [label, node]. */
function factRows(b, host) {
  const when = b.builtAt ? formatBuildDate(b.builtAt) : null;
  const url = commitUrl(b.repository, b.commit);
  return [
    ['Version', b.version],
    ['Build', b.channel === 'dev' ? 'Development build (not deployed)' : b.channel === 'local' ? 'Local build (made by hand)' : url ? link(url, b.shortCommit) : b.shortCommit],
    ['Built', when ? h('span', null, when.local, h('span', { class: 'about__dim' }, ` (${when.utc})`)) : 'Not built: it runs from the source files'],
    ['Where it runs', h('span', null, whereItRuns(b, host), host ? h('span', { class: 'about__dim' }, ` (${host})`) : null)],
  ];
}

/**
 * Open the About dialog.
 * @param {object} ctx the shared context (store, toast)
 * @param {object} dlg the modal primitives of dialogs.js ({ show })
 * @param {{ build?: object, fetchFn?: Function }} [opts]
 * @returns the handle of dlg.show
 */
export function openAbout(ctx, dlg, { build = BUILD, fetchFn } = {}) {
  addStyles('about-styles', CSS);
  const b = normalizeBuild(build);
  const watcher = watchers.get(ctx) || null;
  const host = typeof location !== 'undefined' ? location.host : '';
  const rows = factRows(b, host);
  const facts = h('dl', { class: 'kv' }, rows.flatMap(([name, value]) => [h('dt', null, name), h('dd', null, value)]));

  // the update box: shown (and updated) while the site serves a newer build
  const updateBox = h('div', { 'aria-live': 'polite', class: 'about__update' });
  const paintUpdate = (state) => {
    const remote = state && state.available ? state.remote : null;
    if (!remote) { updateBox.replaceChildren(); return; }
    const reload = h('button', { class: 'btn btn--primary btn--sm', type: 'button', onclick: () => reloadPage(ctx) }, icon('reset', { size: 14 }), 'Reload now');
    updateBox.replaceChildren(h('div', { class: 'callout callout--info' },
      icon('info', { size: 16, class: 'callout__icon' }),
      h('div', { class: 'callout__body' },
        h('div', { class: 'callout__title' }, 'A newer version is available'),
        h('div', { class: 'callout__text' }, `Version ${remote.version} (build ${remote.shortCommit}) is on the site; this page is version ${b.version}. Reload to use the new one. Your plant is saved in this browser and is still there afterwards.`),
        h('div', { class: 'about__row', style: { marginTop: '8px' } }, reload),
        h('p', { class: 'about__hint', style: { marginTop: '6px' } }, 'Still the old version after reloading? Reload once more without the cache: Ctrl+Shift+R (Cmd+Shift+R on a Mac).'))));
  };
  paintUpdate(watcher ? watcher.state() : null);
  const unsubscribe = watcher ? watcher.subscribe(paintUpdate) : () => {};

  // the line for a bug report, with a copy button
  const line = bugReportLine(b, {
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    window: typeof window !== 'undefined' ? { width: window.innerWidth, height: window.innerHeight } : null,
    screen: typeof screen !== 'undefined' ? { width: screen.width, height: screen.height } : null,
  });
  const code = h('code', { class: 'about__line', 'data-role': 'about-line' }, line);
  const copied = h('span', { class: 'about__hint', 'data-role': 'about-copied' });
  const copy = h('button', {
    class: 'btn btn--sm', type: 'button',
    onclick: async () => {
      const ok = await copyText(line, copy.closest('[role="dialog"]') || document.body);
      if (ok) {
        copied.textContent = 'Copied.';
        ctx.toast('The version information was copied. Paste it into your bug report.', { kind: 'success' });
      } else {
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        copied.textContent = 'Copying is blocked by this browser. The line is selected: press Ctrl+C (Cmd+C on a Mac).';
        ctx.toast('The browser did not allow copying. The version line is selected: press Ctrl+C (Cmd+C on a Mac) to copy it.', { kind: 'warn', ms: 8000 });
      }
    },
  }, icon('copy', { size: 14 }), 'Copy version info');

  // what is new
  const news = h('div', { 'data-role': 'about-news' });
  const showNews = () => {
    news.replaceChildren(h('p', { class: 'about__hint' }, 'Loading the list of changes…'));
    loadChangelog({ fetchFn }).then(
      (entries) => news.replaceChildren(renderChangelog(entries, { currentVersion: b.version })),
      (err) => {
        const retry = h('button', { class: 'btn btn--sm', type: 'button', onclick: showNews }, 'Try again');
        const repoLink = b.repository ? h('span', { class: 'about__hint' }, ' It is also on ', link(`${b.repository}/blob/main/CHANGELOG.md`, 'GitHub'), '.') : null;
        news.replaceChildren(h('div', { class: 'callout callout--warn' }, icon('warning', { size: 16, class: 'callout__icon' }),
          h('div', { class: 'callout__body' }, h('div', { class: 'callout__text' }, err.message, repoLink), h('div', { class: 'about__row', style: { marginTop: '8px' } }, retry))));
      });
  };
  showNews();

  const links = b.repository
    ? h('div', { class: 'about__links' },
      link(`${b.repository}/blob/main/LICENSE`, 'Licence (MIT)'), link(b.repository, 'Source code on GitHub'), link(`${b.repository}/issues`, 'Report a problem'))
    : h('div', { class: 'about__links' }, h('span', null, 'Licence: MIT'));

  const body = h('div', { class: 'about' },
    h('div', { class: 'about__head' },
      h('img', { class: 'about__logo', src: 'assets/logo.svg', alt: '', width: '40', height: '40' }),
      h('div', null, h('div', { class: 'about__name' }, 'LogiPlan'), h('div', { class: 'about__tagline' }, 'Plan a factory layout and its in-plant logistics in the browser, then watch it run.'))),
    h('div', null, updateBox, facts),
    h('div', { class: 'about__copy' }, copy, code, copied),
    h('section', { class: 'stack', style: { '--gap': '8px' }, 'aria-labelledby': 'about-news-title' }, h('h3', { class: 'about__title', id: 'about-news-title' }, 'What is new'), news),
    links);

  const chip = document.querySelector('.versionchip');
  return dlg.show({
    title: 'About LogiPlan', size: 'md', body,
    actions: [{ label: 'Close', variant: 'primary', autofocus: true }],
    onClose: () => {
      unsubscribe();
      // Safari does not focus a button on click, so the dialog has nowhere to hand the keyboard back to: use the chip then
      const active = document.activeElement;
      if (chip && chip.isConnected && (!active || active === document.body)) chip.focus({ preventScroll: true });
    },
  });
}

/** Reload the page. The plant is saved first; when that fails the planner is told instead of losing work to a reload. */
function reloadPage(ctx) {
  const { store } = ctx;
  try {
    const saved = typeof store.persist === 'function' ? store.persist() : true;
    if (!saved && store.getState().dirty) {
      ctx.toast('Your plant could not be saved in this browser. Download the project file first, then reload.', { kind: 'warn', ms: 9000 });
      return;
    }
  } catch {
    // saving is best effort; the page asks before it is left when something is really unsaved
  }
  location.reload();
}
