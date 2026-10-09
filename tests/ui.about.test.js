// The parts of js/ui/about.js that need no DOM (loading and keeping the changelog, which entries start open) and the version in the footer of the
// HTML report (js/ui/report.js). The chip and the dialog themselves are driven in a real browser by tests/e2e/about.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/store/store.js';
import { EXAMPLES } from '../js/model/examples.js';
import { validateLayout } from '../js/model/validate.js';
import { exportReportHtml } from '../js/ui/report.js';
import { loadChangelog, openByDefault, CHANGELOG_URL } from '../js/ui/about.js';
import { BUILD } from '../js/build-info.js';

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
