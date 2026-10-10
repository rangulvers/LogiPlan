// The version of the running app (docs/ARCHITECTURE.md 6.11): the chip at the bottom right of the window and the About dialog behind it.
//
//   const chip = createVersionChip(ctx, { signal });    // chip.el is a <button> ("v0.6.0 a45ce49", "v0.6.0 dev") that opens the dialog; the update watcher lives here
//   openAbout(ctx, dlg, { build });                     // called as ctx.dialogs.openAbout(): version, build, build time, where it runs, copy button, what is new
//   loadChangelog({ fetchFn, force }) -> Promise<entries>   // CHANGELOG.md next to index.html, read once and kept (the site build copies it); read again while an update waits
//   refreshLoadedFiles()                                // fetch the page and its files past the HTTP cache, so that "Reload now" really brings the new build
//
// What it shows comes from js/build-info.js (what this copy IS) and, for the hint "Update available", from js/update-check.js (what the site serves now).
// The hint is passive: a dot and the word "Update" on the chip (and a dot on the More button, for a window without a status line), a box with a Reload button
// in the dialog; nothing reloads by itself and nothing pops up.
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
  parseChangelog, parseInline, normalizeBuild, versionLabel, chipBuildId, chipTooltip, chipAriaLabel, updateNotice, formatBuildDate, formatDay, whereItRuns, commitUrl,
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
@media (pointer:coarse){.versionchip{min-height:40px;margin:-8px 0}}
.versionchip::after{right:0;left:auto;transform:none;max-width:min(240px,calc(100vw - var(--sp-4)))}
.versionchip::before{right:calc(var(--sp-2) + 8px);left:auto;transform:none}
.versionchip__id{font-family:var(--font-mono);font-size:var(--fs-xs);font-weight:var(--fw-regular);letter-spacing:0}
/* a phone has no room to spare in the status line (the hint on its left is clipped by what the chip takes): the number and a dot, no build id and no word */
@media (max-width:600px){.versionchip__id,.versionchip__hint{display:none}.versionchip{padding:0 2px;margin-left:calc(var(--sp-2) * -1)}}
.versionchip__dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--accent)}
.versionchip__hint{color:var(--accent-text);font-weight:var(--fw-semibold)}
/* the More button's ::before and ::after are its tooltip, so the dot is a background */
:root[data-update] .topbar__more{background-image:radial-gradient(circle 4px at calc(100% - 7px) 7px,var(--accent) 3.5px,transparent 4px)}
.about{display:flex;flex-direction:column;gap:var(--sp-4);min-width:0}
.about__head{display:flex;align-items:center;gap:var(--sp-3)}
.about__logo{flex:none;display:block;border-radius:9px}
.about__name{font-size:var(--fs-xl);font-weight:var(--fw-semibold);line-height:var(--lh-tight)}
.about__tagline{color:var(--text-dim);font-size:var(--fs-sm);line-height:var(--lh)}
.about .kv dd{text-align:left;overflow-wrap:anywhere}
.about .kv dd .about__dim{color:var(--text-dim);font-weight:var(--fw-regular)}
.about .kv dd .about__nowrap{white-space:nowrap}
.about__copy{display:flex;flex-direction:column;gap:var(--sp-2);align-items:flex-start}
.about__line{display:block;max-width:100%;padding:6px var(--sp-2);border-radius:var(--radius-md);background:var(--surface-2);color:var(--text);
  font-family:var(--font-mono);font-size:var(--fs-sm);line-height:1.4;overflow-wrap:anywhere;user-select:all}
.about__row{display:flex;flex-wrap:wrap;align-items:center;gap:var(--sp-2)}
.about__title{margin:0;font-size:var(--fs-lg);font-weight:var(--fw-semibold)}
.about__news{display:flex;flex-direction:column;gap:var(--sp-2);min-width:0}
.about__entry{border:1px solid var(--border);border-radius:var(--radius-lg);background:var(--surface);container-type:inline-size}
.about__entryhead{margin:0;font:inherit}
.about__toggle{display:flex;flex-wrap:wrap;align-items:center;gap:2px var(--sp-2);width:100%;min-height:36px;padding:6px var(--sp-3);border:0;border-radius:var(--radius-lg);
  background:transparent;color:var(--text);text-align:left}
.about__toggle:hover{background:var(--hover)}
.about__toggle .icon{flex:none;color:var(--text-dim);transition:transform var(--t-fast) var(--ease)}
.about__toggle[aria-expanded="true"] .icon{transform:rotate(90deg)}
.about__version{font-weight:var(--fw-semibold);white-space:nowrap}
.about__date{color:var(--text-dim);font-size:var(--fs-sm);white-space:nowrap}
.about__toggle .chip{white-space:nowrap}
/* a narrow entry (a phone) puts the date on a row of its own, so that the number, the mark and the date never fight for one line */
@container (max-width:460px){.about__toggle .about__date{order:3;flex:0 0 100%;padding-left:24px}}
.about__body{padding:0 var(--sp-3) var(--sp-3) var(--sp-3);display:flex;flex-direction:column;gap:var(--sp-3)}
.about__sec{margin:0 0 4px;color:var(--text-dim);font-size:var(--fs-xs);font-weight:var(--fw-semibold);letter-spacing:.04em;text-transform:uppercase}
.about__list{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px;font-size:var(--fs-md);line-height:var(--lh)}
.about__list li{overflow-wrap:anywhere}
.about__note{margin:0;color:var(--text-dim);font-size:var(--fs-sm);line-height:1.4}
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

/**
 * The "What is new" list: one disclosure button per version (newest first, each inside a heading, so that a screen reader's heading list names the versions),
 * each opening its sections of bullet points. `unreleasedNote` says whether the latest, not yet numbered changes are in the build that runs.
 */
export function renderChangelog(entries, { currentVersion = null, unreleasedNote = '' } = {}) {
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
      entry.unreleased && unreleasedNote ? h('p', { class: 'about__note', 'data-role': 'about-unreleased-note' }, unreleasedNote) : null,
      entry.sections.map((section) => h('div', null,
        h('h5', { class: 'about__sec' }, section.title),
        h('ul', { class: 'about__list' }, section.items.map((item) => h('li', null, inlineNodes(item)))))));
    toggle.addEventListener('click', () => {
      const next = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(next));
      body.hidden = !next;
    });
    list.append(h('div', { class: 'about__entry' }, h('h4', { class: 'about__entryhead' }, toggle), body));
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
 * A window without a status line (a short window, a phone held sideways) has no chip, and a narrow one has the More button next to it: while an update waits, the
 * More button gets a dot (css, keyed on the root attribute) and says so in its name, so that "About and what is new" is not the only place that knows.
 */
function markMoreButton(update) {
  if (document.documentElement && typeof document.documentElement.toggleAttribute === 'function') document.documentElement.toggleAttribute('data-update', update);
  const more = document.querySelector('.topbar__more');
  if (!more || !more.dataset) return;
  if (more.dataset.baseLabel === undefined) more.dataset.baseLabel = more.getAttribute('aria-label') || '';
  more.setAttribute('aria-label', update ? `${more.dataset.baseLabel}. An update is available` : more.dataset.baseLabel);
}

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
  // "v0.6.0" and the short id of the build ("a45ce49"): the number is raised by hand, so most deploys share it, and the id is what changes with every deploy
  // (it is left out on a narrow screen); a development or hand-made copy says "dev" or "local" instead of an id
  const label = h('span', { class: 'versionchip__label' }, versionLabel(b));
  const id = h('span', { class: 'versionchip__id', hidden: !chipBuildId(b) }, chipBuildId(b));
  const dot = h('span', { class: 'versionchip__dot', 'aria-hidden': 'true', hidden: true });
  const hint = h('span', { class: 'versionchip__hint', hidden: true }, 'Update');
  const el = h('button', { class: 'versionchip', type: 'button', 'aria-haspopup': 'dialog', onclick: () => ctx.dialogs.openAbout() }, label, id, dot, hint);
  const paint = (state) => {
    const update = state && state.available ? state.remote : null;
    dot.hidden = !update;
    hint.hidden = !update;
    el.dataset.tip = chipTooltip(b, { update });
    el.setAttribute('aria-label', chipAriaLabel(b, { update }));
    el.classList.toggle('is-update', Boolean(update));
    markMoreButton(Boolean(update));
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

/** The facts of the build as the viewer reads them: rows of [label, node]. `host` is location.host (shown), `hostname` location.hostname (decides "Live site"). */
function factRows(b, host, hostname) {
  const when = b.builtAt ? formatBuildDate(b.builtAt) : null;
  const url = commitUrl(b.repository, b.commit);
  return [
    ['Version', b.version],
    ['Build', b.channel === 'dev' ? 'Development build (not deployed)' : b.channel === 'local' ? 'Local build (made by hand)' : url ? link(url, b.shortCommit) : b.shortCommit],
    ['Built', when ? h('span', null, when.local, ' ', h('span', { class: 'about__dim about__nowrap' }, `(${when.utc})`)) : 'Not built: it runs from the source files'],
    ['Where it runs', h('span', null, whereItRuns(b, hostname), host ? h('span', { class: 'about__dim' }, ` (${host})`) : null)],
  ];
}

/** Does the list of latest changes belong to the build that runs? Says only what is known: the update check, or the source files of a development copy. */
function latestChangesNote(b, watcher) {
  const state = watcher ? watcher.state() : null;
  if (state && state.available) return 'Some of these changes are not in this build yet: the site has a newer one. Reload to get them.';
  if (b.channel === 'dev') return 'You are running the source files, so all of these changes are in this copy.';
  if (state && state.checkedAt) return 'These changes are in this build: it is the one the site serves now.';
  const when = b.builtAt ? formatBuildDate(b.builtAt) : null;
  return `Your build is ${b.shortCommit}${when ? `, made ${when.day}` : ''}.`;
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
  const hostname = typeof location !== 'undefined' ? location.hostname : '';
  const rows = factRows(b, host, hostname);
  const facts = h('dl', { class: 'kv' }, rows.flatMap(([name, value]) => [h('dt', null, name), h('dd', null, value)]));

  // the update box: shown (and updated) while the site serves a newer build
  const updateBox = h('div', { 'aria-live': 'polite', class: 'about__update' });
  const paintUpdate = (state) => {
    const remote = state && state.available ? state.remote : null;
    if (!remote) { updateBox.replaceChildren(); return; }
    const notice = updateNotice(b, remote);
    const reload = h('button', { class: 'btn btn--primary btn--sm', type: 'button' }, icon('reset', { size: 14 }), 'Reload now');
    reload.addEventListener('click', async () => {
      reload.disabled = true;
      const going = await reloadPage(ctx);
      if (!going) reload.disabled = false; // refused (the plant could not be saved): the planner can try again
    });
    updateBox.replaceChildren(h('div', { class: 'callout callout--info' },
      icon('info', { size: 16, class: 'callout__icon' }),
      h('div', { class: 'callout__body' },
        h('div', { class: 'callout__title' }, notice.headline),
        h('div', { class: 'callout__text' }, `${notice.detail} Reload to use the new one. Your plant is saved in this browser and is still there afterwards; a running simulation, its results and the undo history start again.`),
        h('div', { class: 'about__row', style: { marginTop: '8px' } }, reload),
        h('p', { class: 'about__hint', style: { marginTop: '6px' } }, 'Still the old one after reloading? Wait a minute and reload again, or press Ctrl+Shift+R (Cmd+Shift+R on a Mac).'))));
  };
  paintUpdate(watcher ? watcher.state() : null);

  // the line for a bug report, with a copy button. The answer stands under the line (a polite live region): a toast would cover the Close button of the dialog.
  const line = bugReportLine(b, {
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    window: typeof window !== 'undefined' ? { width: window.innerWidth, height: window.innerHeight } : null,
    screen: typeof screen !== 'undefined' ? { width: screen.width, height: screen.height } : null,
  });
  const code = h('code', { class: 'about__line', 'data-role': 'about-line' }, line);
  const copied = h('span', { class: 'about__hint', 'data-role': 'about-copied', role: 'status' });
  const copy = h('button', {
    class: 'btn btn--sm', type: 'button',
    onclick: async () => {
      const ok = await copyText(line, copy.closest('[role="dialog"]') || document.body);
      if (ok) {
        copied.textContent = 'Copied. Paste it into your bug report.';
      } else {
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        copied.textContent = 'Copying is blocked by this browser. The line is selected: press Ctrl+C (Cmd+C on a Mac).';
      }
    },
  }, icon('copy', { size: 14 }), 'Copy version info');

  // what is new. While an update is waiting the list is read again, so that it shows what the update brings (the first reading may be older than the site)
  const news = h('div', { 'data-role': 'about-news' });
  const showNews = (force = false) => {
    // the button the keyboard is on (Try again) is replaced by the answer: the keyboard must not be dropped on the page behind the dialog
    const hadFocus = typeof news.contains === 'function' && news.contains(document.activeElement);
    const keepFocus = (target) => { if (hadFocus && target && typeof target.focus === 'function' && (!document.activeElement || document.activeElement === document.body)) target.focus({ preventScroll: true }); };
    news.replaceChildren(h('p', { class: 'about__hint', role: 'status' }, 'Loading the list of changes…'));
    loadChangelog({ fetchFn, force }).then(
      (entries) => {
        news.replaceChildren(renderChangelog(entries, { currentVersion: b.version, unreleasedNote: latestChangesNote(b, watcher) }));
        keepFocus(news.querySelector('.about__toggle'));
      },
      (err) => {
        const retry = h('button', { class: 'btn btn--sm', type: 'button', onclick: () => showNews(true) }, 'Try again');
        const repoLink = b.repository ? h('span', { class: 'about__hint' }, ' It is also on ', link(`${b.repository}/blob/main/CHANGELOG.md`, 'GitHub'), '.') : null;
        news.replaceChildren(h('div', { class: 'callout callout--warn', role: 'status' }, icon('warning', { size: 16, class: 'callout__icon' }),
          h('div', { class: 'callout__body' }, h('div', { class: 'callout__text' }, err.message, repoLink), h('div', { class: 'about__row', style: { marginTop: '8px' } }, retry))));
        keepFocus(retry);
      });
  };
  showNews(Boolean(watcher && watcher.state().available));
  let announced = Boolean(watcher && watcher.state().available);
  const onUpdate = (state) => {
    paintUpdate(state);
    const available = Boolean(state && state.available);
    if (available !== announced || available) { announced = available; showNews(available); }
  };
  const unsubscribe = watcher ? watcher.subscribe(onUpdate) : () => {};

  const howLink = () => h('a', { href: 'how/' }, 'How LogiPlan works'); // the landing page next to the app (how/index.html): relative, so it works under any path prefix
  const links = b.repository
    ? h('div', { class: 'about__links' }, howLink(),
      link(`${b.repository}/blob/main/LICENSE`, 'Licence (MIT)'), link(b.repository, 'Source code on GitHub'), link(`${b.repository}/issues`, 'Report a problem'))
    : h('div', { class: 'about__links' }, howLink(), h('span', null, 'Licence: MIT'));

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
    title: 'About LogiPlan', size: 'md', body, settleMs: 400, // the second click of a double click on the chip lands on the backdrop and must not close what the first one opened
    actions: [{ label: 'Close', variant: 'primary', autofocus: true }],
    onClose: () => {
      unsubscribe();
      // Safari does not focus a button on click, so the dialog has nowhere to hand the keyboard back to: use the chip then
      const active = document.activeElement;
      if (chip && chip.isConnected && (!active || active === document.body)) chip.focus({ preventScroll: true });
    },
  });
}

/**
 * Fetch again, past the HTTP cache, the page and every file of this site that it loaded (scripts, styles, images). GitHub Pages lets a browser keep every file
 * for ten minutes (max-age=600) and a plain reload only revalidates the page itself, so without this the reload that follows would start the OLD modules again and
 * the chip would still say "Update". The new answers replace the cached ones, so the reload finds the new build. Gives up after `timeoutMs`; never throws.
 */
export async function refreshLoadedFiles({ timeoutMs = 4000, fetchFn = typeof fetch === 'function' ? fetch.bind(globalThis) : null } = {}) {
  try {
    if (!fetchFn || typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function' || typeof location === 'undefined' || typeof location.origin !== 'string') return 0;
    const urls = new Set([location.href.split('#')[0]]);
    for (const entry of performance.getEntriesByType('resource')) {
      const url = String(entry && entry.name);
      // this site's own files only; version.json and CHANGELOG.md are never read from the cache anyway
      if (url.startsWith(`${location.origin}/`) && !/\/(?:version\.json|CHANGELOG\.md)(?:\?|$)/.test(url)) urls.add(url);
    }
    let timer = null;
    const giveUp = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
    try {
      // the body is read to the end: a response that is still arriving when the page reloads is cut off and the cache keeps nothing of it
      const refresh = async (url) => {
        const res = await fetchFn(url, { cache: 'reload', credentials: 'same-origin' });
        if (res && typeof res.arrayBuffer === 'function') await res.arrayBuffer();
      };
      await Promise.race([Promise.allSettled([...urls].map(refresh)), giveUp]);
    } finally {
      clearTimeout(timer);
    }
    return urls.size;
  } catch {
    return 0; // the plain reload is the fallback
  }
}

/**
 * Reload the page. The plant is saved first, and the reload is REFUSED (with a message and a button for the project file) when that would lose work: the save
 * failed while there are unsaved changes, or only part of the project fitted the browser's storage (store.lastPersistError), so a reload would keep only the
 * variant on screen. Then the files of the new build are fetched past the cache (refreshLoadedFiles) and the page reloads.
 * @returns {Promise<boolean>} true when the page is reloading, false when it was refused
 */
async function reloadPage(ctx) {
  const { store } = ctx;
  const download = ctx.actions && typeof ctx.actions.exportJson === 'function' ? { label: 'Download project file', onClick: () => ctx.actions.exportJson() } : undefined;
  try {
    const saved = typeof store.persist === 'function' ? store.persist() : true;
    const dirty = Boolean(store.getState().dirty);
    if (!saved && dirty) {
      ctx.toast('Your plant could not be saved in this browser. Download the project file first, then reload.', { kind: 'warn', ms: 12000, action: download });
      return false;
    }
    if (saved && store.lastPersistError) { // only part of the project fitted: the other variants would be gone after the reload
      ctx.toast('The whole plant does not fit in this browser\'s storage, so a reload would keep only the variant on screen. Download the project file first, then reload.', { kind: 'warn', ms: 12000, action: download });
      return false;
    }
  } catch {
    // saving is best effort; the page asks before it is left when something is really unsaved
  }
  await refreshLoadedFiles();
  location.reload();
  return true;
}
