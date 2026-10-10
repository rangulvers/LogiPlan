// The parts of js/ui/about.js that need no DOM (loading and keeping the changelog, which entries start open) and the version in the footer of the
// HTML report (js/ui/report.js). The chip and the dialog themselves are driven in a real browser by tests/e2e/about.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/store/store.js';
import { EXAMPLES } from '../js/model/examples.js';
import { validateLayout } from '../js/model/validate.js';
import { exportReportHtml } from '../js/ui/report.js';
import { loadChangelog, openByDefault, createVersionChip, openAbout, refreshLoadedFiles, CHANGELOG_URL } from '../js/ui/about.js';
import { BUILD } from '../js/build-info.js';
import * as H from './helpers/version-review-gen.js';

const LOG = '# Changelog\n\n## [Unreleased]\n- Something new.\n\n## [0.2.0] - 2026-10-08\n### Added\n- Two.\n\n## [0.1.0] - 2026-10-07\n### Added\n- One.\n';
const res = (text, over = {}) => ({ ok: true, status: 200, text: async () => text, ...over });

// ---- loadChangelog --------------------------------------------------------------------------------------------------

test('loadChangelog reads CHANGELOG.md next to the page, revalidated, and keeps the answer', async () => {
  const calls = [];
  const fetchFn = async (url, options) => { calls.push({ url, options }); return res(LOG); };
  const entries = await loadChangelog({ fetchFn, force: true });
  assert.deepEqual(entries.map((e) => e.version), ['Unreleased', '0.2.0', '0.1.0']);
  assert.equal(calls[0].url, CHANGELOG_URL);
  assert.equal(CHANGELOG_URL, 'CHANGELOG.md', 'relative, so it works under /<repo>/ on GitHub Pages');
  assert.equal(calls[0].options.cache, 'no-cache');
  const again = await loadChangelog({ fetchFn: async () => { throw new Error('must not be asked again'); } });
  assert.equal(again, entries, 'the second call is the kept answer');
  assert.equal(calls.length, 1);
});

test('loadChangelog says what went wrong in words a planner can read, and asks again next time', async () => {
  const attempts = [
    [async () => res('', { ok: false, status: 404 }), /not found/],
    [async () => { throw new TypeError('Failed to fetch'); }, /offline/],
    [async () => res('just some text, no versions'), /could not be read/],
    [async () => res('## [banana]\n- x'), /could not be read/],
    [async () => ({ ok: true, text: async () => { throw new Error('broken body'); } }), /offline/],
    [async () => undefined, /not found/],
    [null, /cannot load/],
  ];
  for (const [fetchFn, message] of attempts) {
    await assert.rejects(loadChangelog({ fetchFn, force: true }), (err) => message.test(err.message) && !/TypeError|broken body/.test(err.message));
  }
  let calls = 0;
  const flaky = async () => (++calls === 1 ? res('', { ok: false, status: 503 }) : res(LOG));
  await assert.rejects(loadChangelog({ fetchFn: flaky, force: true }));
  const entries = await loadChangelog({ fetchFn: flaky });
  assert.equal(entries.length, 3, 'a failure is not kept: the next call asks again');
  assert.equal(calls, 2);
});

test('loadChangelog keeps hostile text as text and never throws on a huge file', async () => {
  const hostile = `## [1.0.0] - 2026-01-01\n### <img src=x onerror=alert(1)>\n- <script>alert(1)</script> and [x](javascript:alert(1))\n${'- filler line\n'.repeat(50000)}`;
  const entries = await loadChangelog({ fetchFn: async () => res(hostile), force: true });
  assert.equal(entries[0].sections[0].title, '<img src=x onerror=alert(1)>');
  assert.equal(entries[0].sections[0].items[0], '<script>alert(1)</script> and [x](javascript:alert(1))', 'still plain text: about.js sets it with textContent');
  assert.ok(entries[0].sections[0].items.length <= 200);
});

// ---- which entries start open ---------------------------------------------------------------------------------------

test('the newest release starts open, and so do the unreleased changes above it when there are any', () => {
  const e = (version, items = 1, unreleased = false) => ({ version, date: unreleased ? null : '2026-10-08', unreleased, sections: items ? [{ title: 'Added', items: Array(items).fill('x') }] : [] });
  assert.deepEqual([...openByDefault([e('Unreleased', 1, true), e('0.6.0'), e('0.5.0')])], [0, 1]);
  assert.deepEqual([...openByDefault([e('Unreleased', 0, true), e('0.6.0'), e('0.5.0')])], [1], 'an empty [Unreleased] stays closed');
  assert.deepEqual([...openByDefault([e('0.6.0'), e('0.5.0')])], [0]);
  assert.deepEqual([...openByDefault([e('Unreleased', 0, true)])], [0], 'with nothing else the one entry is shown');
  assert.deepEqual([...openByDefault([])], []);
});

// ---- the footer of the HTML report ---------------------------------------------------------------------------------

function reportOf(opts) {
  const store = createStore({ storage: undefined });
  store.newProject(EXAMPLES[0].build());
  const ctx = {
    store, runner: { sim: null, kpis: () => null, insights: () => [] }, renderer: { sim: null, toDataURL: () => null }, issues: () => validateLayout(store.getState().layout), toast() {},
  };
  return exportReportHtml(ctx, { now: new Date(2026, 9, 8, 14, 5), ...opts });
}
const footerOf = (doc) => /<footer>(.*?)<\/footer>/s.exec(doc)[1];

test('the report footer names the version and the build that made it', () => {
  const live = { version: '0.6.0', commit: 'a45ce493dfd9ca7440743e6931042fca39642504', channel: 'live' };
  assert.match(footerOf(reportOf({ build: live })), /^<span>Generated with LogiPlan v0\.6\.0 \(a45ce49\)<\/span><span>8 October 2026, 14:05<\/span>$/);
  assert.match(footerOf(reportOf()), new RegExp(`Generated with LogiPlan v${BUILD.version.replace(/\./g, '\\.')} \\(development build\\)`), 'the running build (js/build-info.js) by default');
  assert.match(footerOf(reportOf({ build: { ...live, commit: 'local', channel: 'local' } })), /v0\.6\.0 \(local build\)/);
});

test('a hostile build identity cannot break the footer', () => {
  const doc = reportOf({ build: { version: '<script>alert(1)</script>', commit: '"><img src=x>', channel: 'live', shortCommit: '<b>' } });
  assert.match(footerOf(doc), /Generated with LogiPlan v0\.0\.0 \(development build\)/);
  assert.ok(!/<script|<img src=x/.test(doc));
  const real = reportOf({ build: { version: '0.6.0', commit: 'a45ce49', channel: 'live', repository: 'javascript:alert(1)' } });
  assert.ok(!/https?:\/\/|javascript:/i.test(real), 'the report stays free of links and external addresses');
  assert.ok(!real.includes('undefined') && !real.includes('NaN'));
});

// ---- the fixes of the review: what the dialog and the chip do, on the fake DOM -----------------------------------------------------------------------------

const LIVE = H.LIVE;
const SMALL_LOG = '## [Unreleased]\n### Added\n- Soon.\n\n## [0.6.0] - 2026-10-09\n### Added\n- The version is shown in the app.\n';
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
const UPDATE = { available: true, remote: { version: '0.7.0', commit: H.SHA_B, shortCommit: 'b3c4d5e', builtAt: '2026-10-10T08:00:00Z' }, checkedAt: 1 };
const SAME_VERSION_UPDATE = { available: true, remote: { version: '0.6.0', commit: H.SHA_B, shortCommit: 'b3c4d5e', builtAt: '2026-10-10T08:00:00Z' }, checkedAt: 1 };

/** A watcher whose answer the test sets. */
function standIn(initial = { available: false, remote: null, checkedAt: null }) {
  const subscribers = new Set();
  let state = initial;
  return {
    watcher: { state: () => state, subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); }, start() {} },
    publish(next) { state = next; for (const fn of [...subscribers]) fn(next); },
  };
}

function rig(store) {
  const toasts = [];
  const shown = [];
  const actions = { downloads: 0, exportJson() { this.downloads++; } };
  const ctx = { store, toast: (...a) => toasts.push(a), dialogs: { openAbout() {} }, actions };
  const dlg = { show: (spec) => { shown.push(spec); return { close() {}, el: null }; } };
  return { ctx, dlg, shown, toasts, actions };
}

const buttonOf = (dom, root, pattern) => dom.elements(root).find((e) => e.localName === 'button' && pattern.test(e.textContent));

test('the chip shows the number and the build id, keeps a hidden id for a development copy, and marks the root while an update waits', async () => {
  const dom = H.installFakeDom();
  try {
    const stand = standIn();
    const { ctx } = rig({});
    const chip = createVersionChip(ctx, { build: LIVE, watcher: stand.watcher });
    const [label, id] = chip.el.children;
    assert.deepEqual([label.textContent, id.textContent, id.hidden], ['v0.6.0', 'a45ce49', false]);
    assert.equal(dom.document.documentElement.hasAttribute('data-update'), false);
    stand.publish(UPDATE);
    assert.equal(dom.document.documentElement.hasAttribute('data-update'), true, 'the More button of a window without a status line shows the dot');
    stand.publish({ available: false, remote: null, checkedAt: 2 });
    assert.equal(dom.document.documentElement.hasAttribute('data-update'), false);
    const dev = createVersionChip(rig({}).ctx, { build: H.DEV });
    assert.deepEqual([dev.el.children[0].textContent, dev.el.children[1].textContent, dev.el.children[1].hidden], ['v0.6.0 dev', '', true]);
  } finally {
    dom.restore();
  }
});

test('while an update waits the More button of the top bar says so (a window without a status line has no chip), and its own name comes back afterwards', () => {
  const dom = H.installFakeDom();
  try {
    const more = dom.document.createElement('button');
    more.className = 'btn topbar__more';
    more.setAttribute('aria-label', 'More actions');
    dom.document.body.append(more);
    const stand = standIn();
    createVersionChip(rig({}).ctx, { build: LIVE, watcher: stand.watcher });
    assert.equal(more.getAttribute('aria-label'), 'More actions', 'nothing changes while there is no update');
    stand.publish(UPDATE);
    assert.equal(more.getAttribute('aria-label'), 'More actions. An update is available');
    stand.publish(UPDATE);
    assert.equal(more.getAttribute('aria-label'), 'More actions. An update is available', 'again: not doubled');
    stand.publish({ available: false, remote: null, checkedAt: 3 });
    assert.equal(more.getAttribute('aria-label'), 'More actions');
  } finally {
    dom.restore();
  }
});

test('the update box says "build" when only the build differs and "version" when the number is higher, and tells what a reload does not keep', async () => {
  const dom = H.installFakeDom();
  try {
    const fetchFn = async () => res(SMALL_LOG);
    for (const [state, headline, detail] of [
      [UPDATE, 'A newer version is available', 'Version 0.7.0 (build b3c4d5e) is on the site; this page is version 0.6.0.'],
      [SAME_VERSION_UPDATE, 'A newer build is available', 'Build b3c4d5e of version 0.6.0 is on the site; this page is build a45ce49.'],
    ]) {
      const stand = standIn(state);
      const { ctx, dlg, shown } = rig({ persist: () => true, getState: () => ({ dirty: false }) });
      createVersionChip(ctx, { build: LIVE, watcher: stand.watcher });
      openAbout(ctx, dlg, { build: LIVE, fetchFn });
      await settle();
      const box = shown[0].body.querySelector('.about__update').textContent;
      assert.ok(box.startsWith(headline), box);
      assert.ok(box.includes(detail), box);
      assert.match(box, /Your plant is saved in this browser and is still there afterwards; a running simulation, its results and the undo history start again\./);
      assert.equal(shown[0].settleMs, 400, 'a double click on the chip must not close the dialog it opened');
    }
  } finally {
    dom.restore();
  }
});

test('the note under "Latest changes" says whether those changes are in the build that runs, as far as is known', async () => {
  const dom = H.installFakeDom();
  try {
    const fetchFn = async () => res(SMALL_LOG);
    const noteFor = async (build, state) => {
      const stand = standIn(state);
      const { ctx, dlg, shown } = rig({});
      createVersionChip(ctx, { build, watcher: stand.watcher });
      openAbout(ctx, dlg, { build, fetchFn });
      await settle();
      return shown[0].body.querySelector('[data-role="about-unreleased-note"]').textContent;
    };
    assert.equal(await noteFor(H.DEV, undefined), 'You are running the source files, so all of these changes are in this copy.');
    assert.equal(await noteFor(LIVE, UPDATE), 'Some of these changes are not in this build yet: the site has a newer one. Reload to get them.');
    assert.equal(await noteFor(LIVE, { available: false, remote: null, checkedAt: 5 }), 'These changes are in this build: it is the one the site serves now.');
    assert.equal(await noteFor(LIVE, { available: false, remote: null, checkedAt: null }), 'Your build is a45ce49, made 9 Oct 2026.', 'before the first check nothing is claimed');
  } finally {
    dom.restore();
  }
});

test('"Reload now" is refused, with a button for the project file, when only part of the project fitted the storage or an unsaved change could not be saved', async () => {
  const dom = H.installFakeDom();
  try {
    const fetchFn = async () => res(SMALL_LOG);
    const cases = [
      ['saved in full', { persist: () => true, dirty: true, lastPersistError: null }, true, null],
      ['saved in part (the other variants would be gone)', { persist: () => true, dirty: true, lastPersistError: new Error('too big') }, false, /does not fit in this browser's storage.*Download the project file first/],
      ['saved in part and nothing changed since (the storage holds the part)', { persist: () => true, dirty: false, lastPersistError: new Error('too big') }, false, /does not fit/],
      ['not saved, unsaved changes', { persist: () => false, dirty: true, lastPersistError: new Error('quota') }, false, /could not be saved.*Download the project file first/],
      ['not saved, nothing to lose', { persist: () => false, dirty: false, lastPersistError: new Error('no storage') }, true, null],
    ];
    for (const [name, { persist, dirty, lastPersistError }, reloads, message] of cases) {
      const stand = standIn(UPDATE);
      const { ctx, dlg, shown, toasts, actions } = rig({ persist, getState: () => ({ dirty }), lastPersistError });
      dom.location.reloads = 0;
      createVersionChip(ctx, { build: LIVE, watcher: stand.watcher });
      openAbout(ctx, dlg, { build: LIVE, fetchFn });
      await settle();
      const button = buttonOf(dom, shown[0].body, /Reload now/);
      await button.click();
      await settle();
      assert.equal(dom.location.reloads, reloads ? 1 : 0, name);
      if (message) {
        assert.equal(toasts.length, 1, name);
        assert.equal(toasts[0][1].kind, 'warn');
        assert.match(toasts[0][0], message, name);
        assert.equal(toasts[0][1].action.label, 'Download project file');
        toasts[0][1].action.onClick();
        assert.equal(actions.downloads, 1, 'the toast button downloads the project file');
        assert.equal(button.attrs.has('disabled') || button.disabled === true, false, 'the button works again after a refusal');
      } else assert.deepEqual(toasts, [], name);
    }
  } finally {
    dom.restore();
  }
});

test('refreshLoadedFiles fetches the page and the files it loaded past the cache, never version.json or CHANGELOG.md, and gives up on a slow network', async () => {
  const dom = H.installFakeDom();
  const realEntries = performance.getEntriesByType;
  try {
    dom.location.origin = 'https://example.github.io';
    dom.location.href = 'https://example.github.io/LogiPlan/?x=1#plan';
    const names = [
      'https://example.github.io/LogiPlan/js/main.js', 'https://example.github.io/LogiPlan/css/layout.css', 'https://example.github.io/LogiPlan/assets/logo.svg',
      'https://example.github.io/LogiPlan/js/main.js', // twice: once
      'https://example.github.io/LogiPlan/version.json?t=1791558480', 'https://example.github.io/LogiPlan/CHANGELOG.md',
      'https://fonts.example.com/font.woff2', 'http://example.github.io/LogiPlan/js/other.js', 'data:text/plain,x', 'blob:https://example.github.io/abc',
    ];
    performance.getEntriesByType = (type) => (type === 'resource' ? names.map((name) => ({ name })) : []);
    const seen = [];
    let bodies = 0;
    const fetchFn = async (url, options) => { seen.push([url, options.cache]); return { ok: true, arrayBuffer: async () => { bodies++; return new ArrayBuffer(0); } }; };
    const count = await refreshLoadedFiles({ fetchFn });
    assert.equal(bodies, 4, 'every body is read to the end: a response still arriving when the page reloads is cut off and the cache keeps nothing of it');
    assert.deepEqual(seen.map(([url]) => url).sort(), [
      'https://example.github.io/LogiPlan/?x=1', // the page itself, without the fragment
      'https://example.github.io/LogiPlan/js/main.js', 'https://example.github.io/LogiPlan/css/layout.css', 'https://example.github.io/LogiPlan/assets/logo.svg',
    ].sort());
    assert.ok(seen.every(([, cache]) => cache === 'reload'), 'every request skips the HTTP cache and replaces its entry');
    assert.equal(count, 4);

    // a network that never answers: given up after the timeout, and the timer is gone
    const t0 = performance.now();
    await refreshLoadedFiles({ fetchFn: () => new Promise(() => {}), timeoutMs: 30 });
    assert.ok(performance.now() - t0 < 1000);
    // failing requests and a failing entry list never throw
    assert.equal(await refreshLoadedFiles({ fetchFn: async () => { throw new TypeError('offline'); } }), 4);
    performance.getEntriesByType = () => { throw new Error('no resource timing'); };
    assert.equal(await refreshLoadedFiles({ fetchFn }), 0);
    assert.equal(await refreshLoadedFiles({ fetchFn: null }), 0, 'no fetch');
  } finally {
    performance.getEntriesByType = realEntries;
    dom.restore();
  }
});

test('"Reload now" fetches the files of the new build past the cache BEFORE it reloads (GitHub Pages lets a browser keep them for ten minutes)', async () => {
  const dom = H.installFakeDom();
  const realEntries = performance.getEntriesByType;
  const realFetch = globalThis.fetch;
  try {
    dom.location.origin = 'https://example.github.io';
    dom.location.href = 'https://example.github.io/LogiPlan/';
    performance.getEntriesByType = () => [{ name: 'https://example.github.io/LogiPlan/js/main.js' }, { name: 'https://example.github.io/LogiPlan/css/layout.css' }];
    const events = [];
    globalThis.fetch = async (url, options) => { events.push(`fetch ${url} ${options && options.cache}`); return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) }; };
    dom.location.reload = () => { events.push('reload'); };
    const stand = standIn(UPDATE);
    const { ctx, dlg, shown } = rig({ persist: () => { events.push('persist'); return true; }, getState: () => ({ dirty: true }), lastPersistError: null });
    createVersionChip(ctx, { build: LIVE, watcher: stand.watcher });
    openAbout(ctx, dlg, { build: LIVE, fetchFn: async () => res(SMALL_LOG) });
    await settle();
    await buttonOf(dom, shown[0].body, /Reload now/).click();
    await settle();
    assert.equal(events[0], 'persist', 'the plant is saved first');
    assert.deepEqual(events.filter((e) => e.startsWith('fetch ')).sort(), [
      'fetch https://example.github.io/LogiPlan/ reload', // the page itself
      'fetch https://example.github.io/LogiPlan/css/layout.css reload',
      'fetch https://example.github.io/LogiPlan/js/main.js reload',
    ], 'the page and the files it loaded, each with cache: reload');
    const lastFetch = Math.max(...events.map((e, i) => (e.startsWith('fetch ') ? i : -1)));
    assert.ok(events.indexOf('reload') > lastFetch, 'and only then the page reloads');
    assert.equal(events.filter((e) => e === 'reload').length, 1);
  } finally {
    performance.getEntriesByType = realEntries;
    globalThis.fetch = realFetch;
    dom.restore();
  }
});
