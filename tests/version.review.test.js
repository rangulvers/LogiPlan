// Adversarial review of the version display (docs/ARCHITECTURE.md 6.11): js/version.js, js/build-info.js, js/update-check.js, js/ui/about.js, the footer of
// js/ui/report.js, scripts/build-site.mjs, scripts/bump-version.mjs and CHANGELOG.md. Angle: ROBUSTNESS, SECURITY and the BUILD PIPELINE. The reviewer's brief:
// try to BREAK it and prove it. Helpers (a fake DOM, seeded generators, hostile documents, script plumbing): tests/helpers/version-review-gen.js.
//
//   1  hostile version.json   wrong types, arrays, prototype keys, 10 MB commits, '1e999', '0.6.0-<script>', control characters; 4,000 seeded random documents against the
//                             invariants of updateVerdict; parseVersion against an oracle written from semver.org; compareVersions is a total preorder
//   2  stale-cache logic      the running build against the deployed one: equal version with another commit, the same commit, an older version, short and upper-case commits
//   3  the update watcher     offline, 404, 500, HTML, junk, a body that is too large, a fetch that throws at once, never answers, a response that arrives after stop():
//                             never an unhandled rejection, never a request at start-up, the throttle, the last verdict stands
//   4  hostile CHANGELOG.md   5,000 versions, 10 MB, unterminated sections, nested bullets, CRLF, BOM, markdown links, HTML, prototype keys; parse time measured on
//                             the adversarial shapes; 600 seeded random documents against the structural invariants
//   5  nothing is HTML        the source is grepped; the changelog, the update box and the dialog are built on a FAKE DOM that throws on any markup parsing and records
//                             every attribute; the report footer; the links
//   6  clipboard              refused in every way a browser can refuse; the dialog's button says so and selects the line
//   7  time and locale        builtAt null / invalid / far future, other zones (DST, +13:45, +14), the viewer's own zone, calendar edges, against an independent oracle
//   8  where it runs         the dialog on the live host, a development copy, hosts with a port
//   9  the build pipeline     build-site into a temp dir with and without GITHUB_SHA, with hostile values, twice, from another directory; the repository untouched; the
//                             old shape of version.json; the workflows' contract with the script; a failed build leaves the old site alone
//   10 bump-version           every argument form, bad input, nothing changed on a refusal, CRLF, a round trip, always on temp copies
//   11 consistency, layering  package.json / build-info.js / CHANGELOG.md / README / ARCHITECTURE numbers; the import rules (version.js DOM-free and importable from
//                             Node, no model / sim / store / util module can reach the build identity); exports, autosave and share links hold no build identity
//   12 real browser           opt-in (VER_REVIEW_BROWSER=1): the built site served to Chromium, the traffic of the start (own origin only, one version.json, no CHANGELOG.md
//                             before the dialog is opened), version.json that never answers, junk, a hostile changelog
//   13 the chip and the dialog on the fake DOM   what the builder's unit tests leave to the browser and a mutation run showed to be unguarded in the fast tier: the watcher is
//                             started with the app's signal, the update box follows the watcher and is unsubscribed on close, "Reload now" saves first and refuses a
//                             reload that would lose work
//
// Run in other time zones and with the environment of a CI run (GITHUB_SHA, GITHUB_REPOSITORY, SOURCE_DATE_EPOCH, LANG=de_DE): the result must not change
// (one test here used to depend on the zone: it now accepts the 9th and the 10th of October for a build time of 15:08 UTC).
//
// The defects the review found, each with a test named "VER-REV-n" that failed when it was found and passes now (the fix pass fixed all of them, at the root):
//   VER-REV-1  parseChangelog took QUADRATIC time on a run of whitespace inside a line (`raw.replace(/\s+$/, '')`): 80,000 spaces took 5.6 s, the 400,000 characters
//              the parser accepts took 193 s - the About dialog froze the tab. Fixed: a line is cut at CHANGELOG_LIMITS.line and trimmed with trimEnd().
//   VER-REV-2  scripts/build-site.mjs and scripts/bump-version.mjs started only `if (process.argv[1] === fileURLToPath(import.meta.url))`: reached through a symlink they did
//              NOTHING and exited 0. Fixed: both compare real paths (realpathSync).
//   VER-REV-3  updateVerdict ignored builtAt: the same version with another commit was "an update" even when the site's build was OLDER than the running one.
//              Fixed: for the same version number an older build time is 'older'. A lower version number (a rollback) is still not announced, on purpose.
//   VER-REV-4  the dialog said "Live site" for a deployed build on localhost:8080: openAbout passed location.host (with the port). Fixed: it passes the host name,
//              and whereItRuns (hostName) ignores a port in any case.
//   VER-REV-5  assertSafeOutput refused the repository and its parents but not its own folders (docs, .git, js ...). Fixed: inside the repository only _site* is allowed.
//   VER-REV-6  SOURCE_DATE_EPOCH was not validated (' ' meant 1970, 1e20 crashed). Fixed: whole seconds only, a year from 2000 to 2199, else the clock.
//   VER-REV-7  bump-version accepted ' 0.7.0' and crashed on '0.7.0\n'. Fixed: a target with any blank is refused (exit 2).
//   VER-REV-8  the list of changes was read once per page load. Fixed: it is read again while an update is waiting (when the dialog opens and when the update arrives).
//   VER-REV-9  "Reload now" could bring the old code back (GitHub Pages: max-age=600); real browser only (VER_REVIEW_BROWSER=1). Fixed: refreshLoadedFiles() fetches the
//              page and every file it loaded with { cache: 'reload' } before location.reload().
//   VER-REV-10 bump-version said it updated js/build-info.js (exit 0) when its version line was not in the expected form. Fixed: all three texts are made first; one that
//              cannot be made refuses with exit 2 and writes nothing.
//   VER-REV-11 the 5-minute throttle of the update check read the wall clock: after the clock was set back no check was made. Fixed: a negative age counts as old.
//   VER-REV-12 bump-version threw away what stood under [Unreleased] when it had no "-" bullet. Fixed: the text moves with the heading (with a warning), only an empty
//              body gets the stub.
//   VER-REV-13 the update box said "A newer version is available" and then gave two equal version numbers. Fixed: updateNotice() says "newer build" when the number is the same.
//
// Tests named "DISCREPANCY" pin a place where the code differs from a standard or from the document: they pass, and say what is different.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as V from '../js/version.js';
import { createUpdateWatcher, CHECK_EVERY_MS, CHECK_TIMEOUT_MS, MAX_BODY_CHARS, START_DELAY_MS } from '../js/update-check.js';
import { BUILD } from '../js/build-info.js';
import { createVersionChip, loadChangelog, openAbout, openByDefault, renderChangelog, copyText } from '../js/ui/about.js';
import { exportReportHtml } from '../js/ui/report.js';
import { createStore } from '../js/store/store.js';
import { EXAMPLES } from '../js/model/examples.js';
import { validateLayout } from '../js/model/validate.js';
import { encodeShare, decodeShare, exportProject } from '../js/model/serialize.js';
import { buildIdentity, renderBuildInfo, renderVersionJson, assertSafeOutput } from '../scripts/build-site.mjs';
import { run as bump, checkFiles } from '../scripts/bump-version.mjs';
import * as H from './helpers/version-review-gen.js';

const { SHA_A, SHA_B, LIVE, DEV, ROOT } = H;
const REPO_URL_FOR_TESTS = H.REPO_URL;
const read = H.read;
const pkg = JSON.parse(read('package.json'));

const ms = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };
const seeds = (n, base = 1) => Array.from({ length: n }, (_, i) => base + i);

// =============================================================================================================================================================
// 1  hostile version.json
// =============================================================================================================================================================

const SAFE_VERSION = /^[0-9A-Za-z.+-]+$/;

test('1.1 parseVersion refuses hostile texts and wrong types, and only ever returns numbers and safe identifiers', () => {
  const refuse = [
    '', ' ', 'x', '1e999', '0.6.0-<script>', '0.6.0-<img src=x onerror=1>', '0.6.0\u0000', '0.6.0\n0.7.0', '0.6.0\u200b', 'v0.6.0\u0000', '0.6', '0.6.0.0', '0.6.0+', '0.6.0-a..b', '0.6.0-.',
    '٠.٦.٠', '０.６.０', '0.06.0', '00.6.0', '-1.0.0', '1.-1.0', '9999999999.0.0', '1.0.0 junk', '__proto__', 'constructor', 'x'.repeat(65), `1.0.0-${'a'.repeat(100)}`, `0.6.0${' '.repeat(100)}`,
    null, undefined, 6, 0.6, true, {}, [], ['0.6.0'], { toString: () => '0.6.0' }, new String('0.6.0'), Symbol.iterator, () => '0.6.0',
  ];
  for (const v of refuse) assert.equal(V.parseVersion(typeof v === 'symbol' ? v : v), null, `${String(typeof v === 'symbol' ? 'symbol' : JSON.stringify(v)).slice(0, 40)} is no version`);
  assert.equal(V.parseVersion('1'.repeat(1e6)), null, 'a million characters');
  for (const [text, want] of [['0.6.0', [0, 6, 0, []]], ['v0.6.0', [0, 6, 0, []]], [' 0.6.0 ', [0, 6, 0, []]], ['0.6.0-rc.1', [0, 6, 0, ['rc', '1']]], ['1.0.0+build.5', [1, 0, 0, []]], ['999999999.999999999.999999999', [999999999, 999999999, 999999999, []]], ['\t0.6.0\n', [0, 6, 0, []]], ['0.6.0\u2028', [0, 6, 0, []]]]) {
    const p = V.parseVersion(text);
    assert.deepEqual([p.major, p.minor, p.patch, p.pre], want, text);
  }
});

/** The official regular expression of semver.org (section "Is there a suggested regular expression"), with an optional leading v and trimmed input. */
const SEMVER_ORG = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

test('1.2 parseVersion against the oracle of semver.org on 6,000 generated texts (the differences are the two documented ones)', () => {
  const tokens = ['0', '1', '7', '12', '007', '10', '.', '.', '.', '-', '+', 'v', 'rc', 'a', 'x-y', ' ', '<', '\n', '1e5', '9999999999'];
  let agree = 0;
  for (const seed of seeds(6000)) {
    const rng = H.makeRng(seed);
    const text = Array.from({ length: H.int(rng, 1, 14) }, () => H.pick(rng, tokens)).join('');
    const mine = V.parseVersion(text) !== null;
    const oracle = text.length <= V.MAX_TEXT && SEMVER_ORG.test(text.trim());
    if (mine === oracle) { agree++; continue; }
    // allowed: the oracle accepts a number of 10+ digits (the app stops at 9), and the app accepts a numeric pre-release identifier with a leading zero
    const known = (mine === false && /\d{10,}/.test(text)) || (mine === true && /-(?:[0-9A-Za-z-]*\.)*0\d/.test(text.trim().split('+')[0]));
    assert.ok(known, `seed ${seed}: ${JSON.stringify(text)} app=${mine} oracle=${oracle}`);
  }
  assert.ok(agree > 4000, 'the generator mostly produced decidable cases');
});

test('DISCREPANCY: a numeric pre-release identifier with a leading zero is accepted and compares equal to the same number', () => {
  // semver.org forbids "1.0.0-01"; the app takes it and treats it as 1.0.0-1. Harmless (nobody writes it), pinned so that nobody relies on it.
  assert.ok(V.parseVersion('1.0.0-01'));
  assert.equal(V.compareVersions('1.0.0-01', '1.0.0-1'), 0);
  assert.equal(SEMVER_ORG.test('1.0.0-01'), false);
});

test('1.3 compareVersions is a total preorder, follows the precedence chain of semver.org, ignores build metadata and sorts junk first', () => {
  const chain = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0', '10.0.0'];
  for (let i = 0; i < chain.length; i++) {
    for (let j = 0; j < chain.length; j++) assert.equal(V.compareVersions(chain[i], chain[j]), Math.sign(i - j), `${chain[i]} vs ${chain[j]}`);
  }
  assert.equal(V.compareVersions('1.0.0+a', '1.0.0+b'), 0);
  assert.equal(V.compareVersions('v1.2.3', '1.2.3'), 0);
  const pool = [...chain, '0.0.0', '0.6.0', 'v0.6.0', '0.6.0+x', 'junk', '', null, undefined, {}, '1e999', '999999999.0.0'];
  for (const a of pool) {
    assert.equal(V.compareVersions(a, a), 0, 'reflexive');
    for (const b of pool) {
      assert.equal(V.compareVersions(a, b) + 0, 0 - V.compareVersions(b, a), `antisymmetric ${JSON.stringify(a)} ${JSON.stringify(b)}`);
      for (const c of pool) {
        if (V.compareVersions(a, b) <= 0 && V.compareVersions(b, c) <= 0) assert.ok(V.compareVersions(a, c) <= 0, `transitive ${JSON.stringify([a, b, c])}`);
      }
    }
  }
  for (const junk of ['junk', '', null, undefined, {}, '1e999']) {
    for (const v of ['0.0.0', '0.6.0']) assert.equal(V.compareVersions(junk, v), -1, 'junk sorts before every version');
    assert.equal(V.isNewer(junk, '0.0.0'), false, 'a candidate that is no version is never newer');
  }
  assert.deepEqual([...pool.filter((x) => typeof x === 'string' && V.parseVersion(x))].sort(V.compareVersions).slice(0, 3), ['0.0.0', '0.6.0', 'v0.6.0'].map((x) => x), 'sort() accepts it as a comparator');
});

const HOSTILE_REMOTES = [
  null, undefined, 0, 1, 'x', true, [], [{ commit: SHA_B, version: '0.7.0' }], {}, { commit: SHA_B }, { version: '0.7.0' }, { commit: [SHA_B], version: '0.7.0' }, { commit: SHA_B, version: ['0.7.0'] },
  { commit: { toString: () => SHA_B }, version: '0.7.0' }, { commit: SHA_B, version: '1e999' }, { commit: SHA_B, version: '0.6.0-<script>' }, { commit: '<img src=x onerror=1>', version: '0.7.0' },
  { commit: 'x'.repeat(1e7), version: '0.7.0' }, { commit: SHA_B, version: '9'.repeat(1e6) }, { commit: SHA_B.repeat(100), version: '0.7.0' }, { commit: `${SHA_B}\u0000`, version: '0.7.0' },
  JSON.parse(`{"__proto__":{"commit":"${SHA_B}","version":"0.7.0"}}`), JSON.parse(`{"commit":"${SHA_B}","version":"0.7.0","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}`),
  Object.create({ commit: SHA_B, version: '0.7.0' }), Object.assign(Object.create(null), { commit: SHA_B, version: '0.7.0' }),
  { get commit() { throw new Error('boom'); }, version: '0.7.0' }, new Proxy({}, { get() { throw new Error('proxy'); }, has() { throw new Error('proxy'); }, getOwnPropertyDescriptor() { throw new Error('proxy'); } }),
  { commit: SHA_B, version: '0.7.0', builtAt: { toString() { throw new Error('toString'); } } }, { commit: SHA_B, version: '0.7.0', builtAt: 'x'.repeat(1e6) },
];

test('1.4 updateVerdict never throws on a hostile version.json, and what it accepts holds only safe characters', () => {
  const polluted = () => ({}).polluted;
  for (const [i, remote] of HOSTILE_REMOTES.entries()) {
    let verdict;
    assert.doesNotThrow(() => { verdict = V.updateVerdict(LIVE, remote); }, `hostile document #${i}`);
    assert.equal(typeof verdict.available, 'boolean');
    if (verdict.available) {
      assert.match(verdict.remote.version, SAFE_VERSION, `#${i}`);
      assert.match(verdict.remote.commit, /^[0-9a-f]{7,64}$/, `#${i}`);
      assert.deepEqual(Object.keys(verdict.remote).sort(), ['builtAt', 'commit', 'shortCommit', 'version'], 'nothing else is carried along');
    }
    assert.equal(polluted(), undefined, `#${i} polluted Object.prototype`);
  }
  // the documents that ARE a valid newer build are found
  assert.equal(V.updateVerdict(LIVE, { commit: SHA_B, version: '0.7.0' }).available, true);
  assert.equal(V.updateVerdict(LIVE, Object.assign(Object.create(null), { commit: SHA_B, version: '0.7.0' })).available, true, 'a null-prototype object is fine');
  assert.equal(V.updateVerdict(LIVE, Object.create({ commit: SHA_B, version: '0.7.0' })).available, false, 'inherited fields are not read');
  assert.equal(V.updateVerdict(LIVE, JSON.parse(`{"__proto__":{"commit":"${SHA_B}","version":"0.7.0"}}`)).available, false, 'an own "__proto__" key is not a commit');
  const frozen = Object.freeze({ commit: SHA_B, version: '0.7.0', builtAt: '2026-10-10T08:00:00Z' });
  assert.equal(V.updateVerdict(LIVE, frozen).available, true, 'a frozen document is only read');
});

test('1.5 4,000 random version.json documents: the verdict obeys its own rules', () => {
  let available = 0;
  for (const seed of seeds(4000, 100)) {
    const remote = H.randomRemote(H.makeRng(seed));
    const v = V.updateVerdict(LIVE, remote);
    const why = `seed ${seed}: ${JSON.stringify(remote)?.slice(0, 160)}`;
    assert.ok(['newer', 'same', 'older', 'unreadable'].includes(v.reason), why);
    assert.equal(v.available, v.reason === 'newer', why);
    if (!v.available) { assert.equal(v.remote, null, why); continue; }
    available++;
    assert.ok(!V.sameCommit(LIVE.commit, v.remote.commit), `${why}: an update has another commit`);
    assert.ok(V.compareVersions(v.remote.version, LIVE.version) >= 0, `${why}: an update is not an older version`);
    assert.match(v.remote.shortCommit, /^[0-9a-f]{7}$/, why);
    assert.ok(v.remote.builtAt === null || V.formatBuildDate(v.remote.builtAt), why);
    assert.deepEqual(V.updateVerdict(LIVE, remote), v, `${why}: deterministic`);
  }
  assert.ok(available > 100, `the generator produced real updates (${available})`);
  // a development build and a local build never find an update, whatever the document says
  for (const mine of [DEV, { ...DEV, version: '9.9.9' }, { ...LIVE, commit: 'local', channel: 'local' }, null, undefined, {}, 'x']) {
    assert.equal(V.updateVerdict(mine, { commit: SHA_B, version: '99.0.0' }).reason, 'not-deployed', JSON.stringify(mine));
  }
});

// =============================================================================================================================================================
// 2  the stale-cache logic: the running build against the deployed one
// =============================================================================================================================================================

test('2.1 the running build against what the site serves, case by case', () => {
  const live = (over = {}) => ({ ...LIVE, ...over });
  const rows = [
    // [name, mine, remote, available, reason]
    ['same commit, same version', live(), { version: '0.6.0', commit: SHA_A }, false, 'same'],
    ['same commit, the site says a higher version (a re-numbered build)', live(), { version: '0.9.0', commit: SHA_A }, false, 'same'],
    ['same commit, the site says a lower version', live(), { version: '0.1.0', commit: SHA_A }, false, 'same'],
    ['another commit, equal version (a merge that did not release)', live(), { version: '0.6.0', commit: SHA_B }, true, 'newer'],
    ['another commit, higher version', live(), { version: '0.7.0', commit: SHA_B }, true, 'newer'],
    ['another commit, higher major version', live(), { version: '1.0.0', commit: SHA_B }, true, 'newer'],
    ['another commit, LOWER version (a rollback or a stale edge)', live(), { version: '0.5.9', commit: SHA_B }, false, 'older'],
    ['another commit, the release of the running pre-release', live({ version: '0.7.0-rc.1' }), { version: '0.7.0', commit: SHA_B }, true, 'newer'],
    ['another commit, a pre-release of the running release', live(), { version: '0.6.0-rc.1', commit: SHA_B }, false, 'older'],
    ['the site serves the full commit, the build knows the 7-character one', live({ commit: SHA_A.slice(0, 7), shortCommit: SHA_A.slice(0, 7) }), { version: '0.6.0', commit: SHA_A }, false, 'same'],
    ['the site serves the short commit, the build the full one', live(), { version: '0.6.0', commit: SHA_A.slice(0, 7) }, false, 'same'],
    ['upper-case commits on either side', live({ commit: SHA_A.toUpperCase() }), { version: '0.6.0', commit: SHA_A.toUpperCase() }, false, 'same'],
    ['commits that share only a 6-character start', live(), { version: '0.6.0', commit: `${SHA_A.slice(0, 6)}${'f'.repeat(34)}` }, true, 'newer'],
    ['a 6-character remote commit is no commit', live(), { version: '0.6.0', commit: SHA_A.slice(0, 6) }, false, 'unreadable'],
    ['a version with a v and blanks', live(), { version: ' v0.7.0 ', commit: SHA_B }, true, 'newer'],
    ['builtAt that is not a date does not matter', live(), { version: '0.7.0', commit: SHA_B, builtAt: 'soon' }, true, 'newer'],
    ['a build time in the far future does not matter either', live(), { version: '0.7.0', commit: SHA_B, builtAt: '2199-12-31T23:59:59Z' }, true, 'newer'],
  ];
  for (const [name, mine, remote, available, reason] of rows) {
    const v = V.updateVerdict(mine, remote);
    assert.deepEqual([v.available, v.reason], [available, reason], name);
  }
});

test('VER-REV-3 an older deploy with the same version is reported as "Update available" (updateVerdict ignores builtAt)', () => {
  // The site is allowed to go back: pages.yml says that a run whose freshness check cannot read the branch deploys anyway, so an older commit that finishes last
  // replaces a newer one. The page of the newer build is then told to "update" to the older one. Both ends know when they were built.
  const mine = { ...LIVE, builtAt: '2026-10-09T15:08:00Z' };
  const olderDeploy = { version: '0.6.0', commit: SHA_B, builtAt: '2026-10-01T00:00:00Z' };
  const v = V.updateVerdict(mine, olderDeploy);
  assert.deepEqual([v.available, v.reason], [false, 'older'], `the site's build (${olderDeploy.builtAt}) is older than the running one (${mine.builtAt}) but the verdict is ${JSON.stringify(v)}`);
  // guards for the fix: a later or an equal or an unknown build time stays an update
  assert.equal(V.updateVerdict(mine, { ...olderDeploy, builtAt: '2026-10-10T00:00:00Z' }).available, true);
  assert.equal(V.updateVerdict(mine, { ...olderDeploy, builtAt: mine.builtAt }).available, true, 'equal build times say nothing about the direction');
  assert.equal(V.updateVerdict(mine, { version: '0.6.0', commit: SHA_B }).available, true, 'without a build time the commit decides');
  assert.equal(V.updateVerdict({ ...mine, builtAt: null }, olderDeploy).available, true, 'a running build without a time cannot be compared');
});

// =============================================================================================================================================================
// 3  the update watcher
// =============================================================================================================================================================

const NEWER_BODY = JSON.stringify({ name: 'logiplan', version: '0.7.0', commit: SHA_B, shortCommit: 'b3c4d5e', builtAt: '2026-10-10T08:00:00Z', channel: 'live', builtFrom: 'main' });
const okResponse = (text) => ({ ok: true, status: 200, text: async () => text });

function rig(answers, { build = LIVE, ...extra } = {}) {
  const queue = [...answers];
  const calls = [];
  const fetchFn = (url, options) => {
    calls.push({ url, options });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    return typeof next === 'function' ? next(url, options) : next;
  };
  const clock = { t: 5_000_000, now: () => clock.t };
  const timers = [];
  const watcher = createUpdateWatcher({
    build, fetchFn, now: clock.now, startDelayMs: 1500, setTimer: (fn, delay) => { timers.push({ fn, delay, live: true }); return timers.length - 1; }, clearTimer: (id) => { if (timers[id]) timers[id].live = false; }, ...extra,
  });
  return { watcher, calls, clock, timers, fetchFn };
}

/** Run `fn` and report every unhandled rejection that happens while it runs and a little after. */
async function unhandledDuring(fn) {
  const seen = [];
  const on = (reason) => seen.push(reason);
  process.on('unhandledRejection', on);
  try {
    await fn();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    process.off('unhandledRejection', on);
  }
  return seen;
}

test('3.1 every way a request can go wrong is silent: no throw, no unhandled rejection, no state change', async () => {
  const failures = {
    'fetch throws at once': () => { throw new TypeError('Failed to fetch'); },
    'fetch rejects': () => Promise.reject(new TypeError('NetworkError')),
    'fetch resolves undefined': () => undefined,
    'fetch resolves null': () => null,
    'fetch resolves a string': () => 'oops',
    '404': () => ({ ok: false, status: 404, text: async () => NEWER_BODY }),
    '500 with a good body': () => ({ ok: false, status: 500, text: async () => NEWER_BODY }),
    'ok without text()': () => ({ ok: true }),
    'text() rejects': () => ({ ok: true, text: async () => { throw new Error('body'); } }),
    'text() throws': () => ({ ok: true, text: () => { throw new Error('body'); } }),
    'text() is a number': () => ({ ok: true, text: async () => 42 }),
    'text() is an object': () => ({ ok: true, text: async () => ({ commit: SHA_B, version: '0.7.0' }) }),
    'ok is a getter that throws': () => ({ get ok() { throw new Error('ok'); } }),
    'HTML from a captive portal': () => okResponse('<html><script>alert(1)</script></html>'),
    'truncated JSON': () => okResponse(NEWER_BODY.slice(0, 30)),
    'JSON null': () => okResponse('null'),
    'JSON array': () => okResponse(`[${NEWER_BODY}]`),
    'a body one character too large': () => okResponse(JSON.stringify({ commit: SHA_B, version: '0.7.0', pad: 'x'.repeat(MAX_BODY_CHARS) })),
    'a 10 MB body': () => okResponse(`{"commit":"${SHA_B}","version":"0.7.0","pad":"${'x'.repeat(1e7)}"}`),
    'valid JSON that is no version.json': () => okResponse('{"hello":"world"}'),
    'a version.json of another app': () => okResponse('{"version":"1.2.3"}'),
  };
  for (const [name, fail] of Object.entries(failures)) {
    const { watcher } = rig([fail]);
    let state;
    const seen = await unhandledDuring(async () => { state = await watcher.check({ force: true }); });
    assert.deepEqual(seen, [], `${name}: unhandled rejection`);
    assert.deepEqual([state.available, state.remote], [false, null], `${name}: no update`);
  }
  // the one that works, to prove the rig finds an update at all
  const good = rig([okResponse(NEWER_BODY)]);
  const state = await good.watcher.check({ force: true });
  assert.equal(state.available, true);
  assert.equal(state.remote.shortCommit, 'b3c4d5e');
});

test('3.2 the last verdict stands through failures, and is withdrawn when the site says "same" or "older"', async () => {
  const seen = [];
  const { watcher, clock } = rig([okResponse(NEWER_BODY), () => { throw new Error('offline'); }, okResponse('<html>'), { ok: false, status: 503 }, okResponse(JSON.stringify({ commit: SHA_A, version: '0.6.0' })), okResponse(NEWER_BODY), okResponse(JSON.stringify({ commit: SHA_B, version: '0.1.0' }))]);
  watcher.subscribe((s) => seen.push(s.available));
  const step = async () => { clock.t += CHECK_EVERY_MS; return (await watcher.check()).available; };
  assert.equal(await step(), true, 'newer');
  assert.equal(await step(), true, 'offline: still newer');
  assert.equal(await step(), true, 'junk: still newer');
  assert.equal(await step(), true, '503: still newer');
  assert.equal(await step(), false, 'the site serves this very commit again: no update');
  assert.equal(await step(), true, 'newer again');
  assert.equal(await step(), false, 'a lower version: withdrawn');
  assert.deepEqual(seen, [true, false, true, false], 'listeners hear only the changes');
});

test('3.3 start-up: nothing is requested before the delay, never while hidden, and a development build never asks at all', async () => {
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  const { watcher, calls, timers } = rig([okResponse(NEWER_BODY)]);
  watcher.start({ document: doc });
  assert.equal(calls.length, 0, 'start() itself requests nothing');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, START_DELAY_MS);
  assert.ok(START_DELAY_MS >= 1000, 'the first request waits for the app to settle');
  timers[0].fn();
  await Promise.resolve();
  assert.equal(calls.length, 1, 'one request after the delay');
  assert.match(calls[0].url, /^version\.json\?t=\d+$/, 'relative to the page (GitHub Pages serves under /<repo>/), with a changing query');
  assert.equal(calls[0].options.cache, 'no-store');

  const hidden = rig([okResponse(NEWER_BODY)]);
  const hiddenDoc = new EventTarget();
  hiddenDoc.visibilityState = 'hidden';
  hidden.watcher.start({ document: hiddenDoc });
  hidden.timers[0].fn();
  await Promise.resolve();
  assert.equal(hidden.calls.length, 0, 'a tab opened in the background does not ask');
  hiddenDoc.visibilityState = 'visible';
  hiddenDoc.dispatchEvent(new Event('visibilitychange'));
  await Promise.resolve();
  assert.equal(hidden.calls.length, 1, 'it asks when the tab is shown');

  for (const mine of [DEV, { ...LIVE, commit: 'local', channel: 'local' }, null, 'x']) {
    const dev = rig([okResponse(NEWER_BODY)], { build: mine });
    assert.equal(dev.watcher.enabled, false);
    const d = new EventTarget();
    d.visibilityState = 'visible';
    dev.watcher.start({ document: d });
    assert.equal(dev.timers.length, 0, 'no timer for a build that cannot compare');
    assert.deepEqual(await dev.watcher.check({ force: true }), { available: false, remote: null, checkedAt: null });
    assert.equal(dev.calls.length, 0);
  }
  const noFetch = createUpdateWatcher({ build: LIVE, fetchFn: null });
  assert.equal(noFetch.enabled, false, 'a browser without fetch');
});

test('3.4 the throttle: three visibility changes in a row make one request; five minutes later the next one', async () => {
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  const { watcher, calls, clock } = rig([okResponse(JSON.stringify({ commit: SHA_A, version: '0.6.0' }))]);
  watcher.start({ document: doc });
  for (let i = 0; i < 3; i++) { doc.dispatchEvent(new Event('visibilitychange')); await Promise.resolve(); clock.t += 1000; }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  clock.t += CHECK_EVERY_MS - 3000 - 1;
  doc.dispatchEvent(new Event('visibilitychange'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, 'one millisecond short of five minutes');
  clock.t += 1;
  doc.dispatchEvent(new Event('visibilitychange'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(CHECK_EVERY_MS, 300_000);
  // two checks at once share one request
  const shared = rig([() => new Promise((resolve) => setTimeout(() => resolve(okResponse(NEWER_BODY)), 20))]);
  const [a, b] = await Promise.all([shared.watcher.check({ force: true }), shared.watcher.check({ force: true })]);
  assert.equal(shared.calls.length, 1);
  assert.deepEqual(a, b);
});

test('VER-REV-11 the 5-minute throttle reads the wall clock: after the clock is set back, no check is made until it has caught up again', async () => {
  // Date.now() is not monotonic: an NTP step, a manual change or a virtual machine resumed from a snapshot can set it back. `now() - lastAttempt` is then negative,
  // which is "less than five minutes", and the page does not look again until the clock is where it was (an hour later in this example). A monotonic clock
  // (performance.now()) or "a negative age counts as old" fixes it.
  const { watcher, calls, clock } = rig([okResponse(NEWER_BODY)]);
  await watcher.check();
  assert.equal(calls.length, 1);
  clock.t -= 3_600_000; // the clock is set back by an hour
  clock.t += CHECK_EVERY_MS + 60_000; // and the planner comes back to the tab six minutes later (by the clock's own count)
  await watcher.check();
  assert.equal(calls.length, 2, `the clock reads ${(5_000_000 - clock.t) / 60_000} minutes BEFORE the last request: the age of that request is negative, so it counts as "fresh"`);
});

test('3.5 a request that never answers is abandoned after the timeout and never blocks anything; an answer after stop() is ignored', async () => {
  // a fetch that honours AbortSignal like the real one
  let aborted = false;
  const hang = (url, options) => new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); }); });
  const watcher = createUpdateWatcher({ build: LIVE, fetchFn: hang, timeoutMs: 30 });
  const t0 = performance.now();
  const seen = await unhandledDuring(async () => { assert.deepEqual(await watcher.check({ force: true }), { available: false, remote: null, checkedAt: null }); });
  assert.deepEqual(seen, []);
  assert.ok(aborted, 'the request was aborted');
  assert.ok(performance.now() - t0 < 1500, 'and the check came back');
  assert.equal(CHECK_TIMEOUT_MS, 10_000, 'the documented 10 s');

  // start() with real timers and a fetch that never answers: the app is not held up
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  const lazy = createUpdateWatcher({ build: LIVE, fetchFn: hang, timeoutMs: 20, startDelayMs: 5 });
  const t1 = performance.now();
  lazy.start({ document: doc });
  assert.ok(performance.now() - t1 < 50, 'start() returns at once');
  lazy.stop();

  // the answer arrives after stop(): no listener is called
  let release;
  const late = rig([() => new Promise((resolve) => { release = resolve; })]);
  const heard = [];
  late.watcher.subscribe((s) => heard.push(s));
  const pending = late.watcher.check({ force: true });
  const d2 = new EventTarget();
  d2.visibilityState = 'visible';
  late.watcher.start({ document: d2 });
  late.watcher.stop();
  release(okResponse(NEWER_BODY));
  await pending;
  assert.deepEqual(heard, []);
  assert.equal(late.watcher.state().available, false);
});

test('3.6 one throwing listener neither stops the others nor produces an unhandled rejection; a listener can unsubscribe', async () => {
  const { watcher } = rig([okResponse(NEWER_BODY)]);
  const heard = [];
  watcher.subscribe(() => { throw new Error('listener'); });
  const off = watcher.subscribe((s) => heard.push(s.available));
  const seen = await unhandledDuring(async () => { await watcher.check({ force: true }); });
  assert.deepEqual(heard, [true]);
  assert.deepEqual(seen, []);
  off();
  assert.equal(typeof off, 'function');
});

test('3.7 the signal of the app stops the watcher: the listener is removed and nothing is requested afterwards', async () => {
  const added = [];
  const removed = [];
  const doc = { visibilityState: 'visible', addEventListener: (t, f) => added.push([t, f]), removeEventListener: (t, f) => removed.push([t, f]) };
  const { watcher, calls, timers } = rig([okResponse(NEWER_BODY)]);
  const controller = new AbortController();
  watcher.start({ document: doc, signal: controller.signal });
  assert.equal(added.length, 1);
  controller.abort();
  assert.deepEqual(removed, added, 'the same listener is removed');
  assert.equal(timers[0].live, false, 'the start timer is cleared');
  await watcher.check({ force: true });
  assert.equal(calls.length, 0);
  // a signal that is already aborted
  const again = rig([okResponse(NEWER_BODY)]);
  const doc2 = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  const dead = new AbortController();
  dead.abort();
  again.watcher.start({ document: doc2, signal: dead.signal });
  await again.watcher.check({ force: true });
  assert.equal(again.calls.length, 0);
});

test('3.8 4,000 random version.json bodies through the whole watcher: only a valid newer build is ever reported', async () => {
  let reported = 0;
  for (const seed of seeds(1500, 9000)) {
    const remote = H.randomRemote(H.makeRng(seed));
    let body;
    try { body = JSON.stringify(remote) ?? 'undefined'; } catch { body = 'cyclic'; }
    const { watcher } = rig([okResponse(body)]);
    const state = await watcher.check({ force: true });
    const expected = V.updateVerdict(LIVE, (() => { try { return JSON.parse(body); } catch { return undefined; } })());
    assert.equal(state.available, expected.available, `seed ${seed}: ${body.slice(0, 120)}`);
    if (state.available) { reported++; assert.match(state.remote.version, SAFE_VERSION); }
  }
  assert.ok(reported > 20);
});

// =============================================================================================================================================================
// 4  hostile CHANGELOG.md
// =============================================================================================================================================================

const CAP = V.CHANGELOG_LIMITS;

/** Adversarial documents, each of at most `n` characters; none of them has a long run of whitespace inside a line (that one is VER-REV-1). */
const SHAPES = {
  '5,000 versions': (n) => Array.from({ length: Math.floor(n / 40) }, (_, i) => `## [${i}.0.0] - 2026-01-01\n### Added\n- x\n`).join(''),
  'one heading, unterminated bracket': (n) => `## [${'1'.repeat(n)}`,
  'a heading of dots': (n) => `## ${'1.'.repeat(n / 2)}`,
  'a heading of dashes': (n) => `## [1.0.0]${' -'.repeat(n / 2)}x`,
  'a heading of dates': (n) => `## [1.0.0] - 2026-01-01${' 2026-01-01'.repeat(n / 11)}`,
  'asterisk run': (n) => `## [1.0.0]\n- ${'*'.repeat(n)}`,
  'alternating asterisks': (n) => `## [1.0.0]\n- ${'*a'.repeat(n / 2)}`,
  'backticks': (n) => `## [1.0.0]\n- ${'`a'.repeat(n / 2)}`,
  'bold openers': (n) => `## [1.0.0]\n- ${'**a'.repeat(n / 3)}`,
  'continuation lines': (n) => `## [1.0.0]\n- a\n${'  b\n'.repeat(n / 4)}`,
  'a million bullets': (n) => `## [1.0.0]\n${'- b\n'.repeat(n / 4)}`,
  'many sections': (n) => `## [1.0.0]\n${'### s\n- b\n'.repeat(n / 9)}`,
  'nested bullets 200 deep, repeated': (n) => Array.from({ length: n / 20000 + 1 }, () => Array.from({ length: 200 }, (_, i) => `${' '.repeat(i)}- x\n`).join('')).join('## [1.0.0]\n'),
  'CRLF': (n) => `## [1.0.0]\r\n${'- b\r\n'.repeat(n / 5)}`,
  'lone CR': (n) => '## [1.0.0]\r- b'.repeat(n / 14),
  'HTML and markdown links': (n) => `## [1.0.0]\n- <img src=x onerror=1>${'[a](javascript:1)<script>'.repeat(n / 25)}`,
  'long lines of letters': (n) => `## [1.0.0]\n- ${'a'.repeat(n)}\n`,
  'blank lines': (n) => `## [1.0.0]\n${'\n'.repeat(n)}- a\n`,
  'whitespace-only lines': (n) => `## [1.0.0]\n${'   \t \n'.repeat(n / 6)}- a\n`,
  'alternating word and blank': (n) => `## [1.0.0]\n- a${' b'.repeat(n / 2)}\n`,
};

test('4.1 parse time on adversarial documents of the size the parser accepts (400,000 characters): well under 1.5 s each', () => {
  const slow = [];
  for (const [name, make] of Object.entries(SHAPES)) {
    const text = make(CAP.chars).slice(0, CAP.chars);
    let entries;
    const t = ms(() => { entries = V.parseChangelog(text); });
    if (t > 1500) slow.push(`${name}: ${t.toFixed(0)} ms`);
    assert.ok(entries.length <= CAP.entries, name);
  }
  assert.deepEqual(slow, []);
  // 10 MB and 50 MB of text: the parser looks at the first 400,000 characters only
  for (const size of [1e7, 5e7]) {
    const text = '## [1.0.0]\n'.concat('- a normal line of changelog text\n'.repeat(size / 34));
    let entries;
    const t = ms(() => { entries = V.parseChangelog(text); });
    assert.ok(t < 1500, `${size} characters: ${t.toFixed(0)} ms`);
    assert.equal(entries[0].sections[0].items.length, CAP.items);
  }
});

test('4.2 the caps hold: entries, sections per entry, items per section, characters per item and per title', () => {
  const many = Array.from({ length: 5000 }, (_, i) => `## [${i}.0.0] - 2026-01-01\n### Added\n- item number ${i}\n`).join('');
  const entries = V.parseChangelog(many);
  assert.equal(entries.length, CAP.entries);
  assert.equal(entries[0].version, '0.0.0', 'the first ones in file order are kept');
  const sections = V.parseChangelog(`## [1.0.0]\n${Array.from({ length: 100 }, (_, i) => `### S${i}\n- item ${i}\n`).join('')}`);
  assert.equal(sections[0].sections.length, CAP.sections);
  const items = V.parseChangelog(`## [1.0.0]\n### Added\n${'- item\n'.repeat(1000)}`);
  assert.equal(items[0].sections[0].items.length, CAP.items);
  const long = V.parseChangelog(`## [1.0.0]\n### ${'T'.repeat(500)}\n- ${'x'.repeat(5000)}\n  ${'y'.repeat(5000)}\n`);
  assert.equal(long[0].sections[0].title.length, CAP.title);
  assert.equal(long[0].sections[0].items[0].length, CAP.item, 'an item and its continuation lines stay within the cap');
  assert.equal(V.parseChangelog(`${'x'.repeat(CAP.chars)}\n## [9.9.9]\n- hidden beyond the cap\n`).length, 0, 'text beyond the character cap is not read');
});

test('4.3 line ends and byte-order marks: CRLF reads like LF; a lone CR is not a line end; a BOM before the first heading is a Node-only blind spot', () => {
  const lf = '# Changelog\n\n## [Unreleased]\n- Something new here.\n  and a continuation\n\n## [0.2.0] - 2026-10-08\n### Added\n- Two things.\n';
  assert.deepEqual(V.parseChangelog(lf.replace(/\n/g, '\r\n')), V.parseChangelog(lf));
  assert.deepEqual(V.parseChangelog(`﻿${lf}`), V.parseChangelog(lf), 'a BOM in front of "# Changelog" is harmless');
  assert.equal(V.parseChangelog(lf)[0].sections[0].items[0], 'Something new here. and a continuation');
  assert.deepEqual(V.parseChangelog('## [1.0.0]\r- a\r- b\r'), [], 'a lone CR (old Mac files) is no line end: the heading is not a heading and nothing is invented');
});

test('DISCREPANCY: a BOM in front of the FIRST heading hides it (browsers strip the BOM in Response.text(); a Node reader such as bump-version does not)', () => {
  const entries = V.parseChangelog('﻿## [Unreleased]\n- Something new here.\n\n## [0.2.0] - 2026-10-08\n### Added\n- Two things.\n');
  assert.deepEqual(entries.map((e) => e.version), ['0.2.0'], 'the first entry is lost');
});

test('4.4 unterminated and misplaced structure: nothing is invented, nothing throws, the rest is still read', () => {
  const cases = {
    'bullets before any heading': ['- stray\n- more\n## [1.0.0]\n### Added\n- real\n', ['1.0.0']],
    'a section before any entry': ['### Added\n- stray\n## [1.0.0]\n- real\n', ['1.0.0']],
    'an entry that is no version': ['## [banana]\n- x\n## [1.0.0]\n- y\n', ['1.0.0']],
    'an entry with an impossible date': ['## [1.0.0] - 2026-02-30\n- y\n', ['1.0.0']],
    'EOF in the middle of a continuation': ['## [1.0.0]\n- a\n  and', ['1.0.0']],
    'a heading marker with nothing': ['##\n## \n###\n### \n', []],
    'a version heading twice': ['## [1.0.0]\n- a\n## [1.0.0]\n- b\n', ['1.0.0', '1.0.0']],
    'text that is not a string': [null, []],
    'numbers and objects': [42, []],
  };
  for (const [name, [text, versions]] of Object.entries(cases)) {
    let entries;
    assert.doesNotThrow(() => { entries = V.parseChangelog(text); }, name);
    assert.deepEqual(entries.map((e) => e.version), versions, name);
  }
  assert.equal(V.parseChangelog('## [1.0.0] - 2026-02-30\n- y\n')[0].date, null, 'an impossible date is dropped, the entry stays');
  assert.deepEqual(V.parseChangelog('## [1.0.0]\n### Added\n- x\n### Empty\n### Fixed\n- y\n')[0].sections.map((s) => s.title), ['Added', 'Fixed'], 'empty sections are dropped');
});

test('4.5 hostile text stays text: HTML, markdown links, prototype keys, control characters', () => {
  const entries = V.parseChangelog(H.hostileChangelog());
  const all = entries.flatMap((e) => e.sections.flatMap((s) => [s.title, ...s.items]));
  for (const s of H.HOSTILE_STRINGS) assert.ok(all.some((x) => x.includes(s)), `kept verbatim: ${JSON.stringify(s)}`);
  assert.deepEqual(entries.map((e) => e.version), ['Unreleased', '1.0.0'], 'the two entries with a hostile version are dropped');
  for (const e of entries) assert.match(e.version, /^(Unreleased|[0-9A-Za-z.+-]+)$/);
  // parseInline understands bold, italic and code, and nothing else: no link, no tag, no entity
  const parts = V.parseInline('see [x](javascript:alert(1)) and <b>**bold**</b> and `<img src=x>` and *it*');
  assert.deepEqual(parts.map((p) => p.type), ['text', 'strong', 'text', 'code', 'text', 'em']);
  assert.ok(parts.every((p) => ['text', 'strong', 'em', 'code'].includes(p.type)));
  assert.equal(parts[0].text, 'see [x](javascript:alert(1)) and <b>', 'the link and the tag are plain text');
  assert.deepEqual([parts[1].text, parts[3].text], ['bold', '<img src=x>'], 'markup inside bold or code is text too');
  assert.deepEqual(V.parseInline(null), []);
  assert.deepEqual(V.parseInline({}), []);
  for (const bad of ['## [__proto__]\n- a\n', '## [constructor]\n- a\n', '## [1.0.0]\n### __proto__\n- __proto__\n- constructor\n']) {
    const out = V.parseChangelog(bad);
    assert.equal(Object.getPrototypeOf(out[0] ?? {}), Object.prototype);
  }
  assert.equal(({}).polluted, undefined);
  assert.equal(V.parseChangelog('## [1.0.0]\n### __proto__\n- toString\n')[0].sections[0].title, '__proto__');
});

test('4.6 600 random documents: the structure is always valid, CRLF reads like LF, and the parser is deterministic', () => {
  for (const seed of seeds(600, 3000)) {
    const rng = H.makeRng(seed);
    const lf = H.randomChangelog(rng, { eol: '\n' });
    const entries = V.parseChangelog(lf);
    const why = `seed ${seed}`;
    assert.ok(entries.length <= CAP.entries, why);
    for (const e of entries) {
      assert.ok(e.unreleased ? e.version === 'Unreleased' : V.parseVersion(e.version) !== null && SAFE_VERSION.test(e.version), `${why}: version ${e.version}`);
      assert.ok(e.date === null || V.formatDay(e.date) !== '', `${why}: date ${e.date}`);
      assert.ok(e.sections.length <= CAP.sections, why);
      for (const s of e.sections) {
        assert.ok(s.title.length > 0 && s.title.length <= CAP.title && s.title === s.title.trim(), `${why}: title ${JSON.stringify(s.title)}`);
        assert.ok(s.items.length >= 1 && s.items.length <= CAP.items, why);
        for (const item of s.items) assert.ok(typeof item === 'string' && item.length <= CAP.item && !item.includes('\n'), `${why}: item`);
      }
    }
    assert.deepEqual(V.parseChangelog(lf), entries, `${why}: deterministic`);
    assert.deepEqual(V.parseChangelog(lf.replace(/\n/g, '\r\n')), entries, `${why}: CRLF`);
    for (const e of entries) for (const s of e.sections) for (const item of s.items) V.parseInline(item);
  }
});

test('VER-REV-1 parseChangelog takes quadratic time on a run of whitespace inside a line (a hostile or careless CHANGELOG.md freezes the About dialog)', () => {
  // `raw.replace(/\s+$/, '')` is retried at every start of the run and scans to the end of it each time. Measured here: 80,000 spaces 5.6 s, 160,000 about 22 s,
  // and the 400,000 characters the parser accepts (CHANGELOG_LIMITS.chars) 193 s - the tab is frozen for three minutes when the user clicks the version number.
  const n = 20_000;
  const shapes = {
    'spaces inside a bullet': `## [1.0.0]\n- a${' '.repeat(n)}b\n`,
    'spaces inside a version heading': `## [1.0.0]${' '.repeat(n)}x\n`,
  };
  const slow = [];
  for (const [name, text] of Object.entries(shapes)) {
    const t = ms(() => V.parseChangelog(text));
    if (t > 150) slow.push(`${name}: ${t.toFixed(0)} ms for ${n} blanks (a linear parser needs about 1 ms)`);
  }
  assert.deepEqual(slow, []);
});

// =============================================================================================================================================================
// 5  nothing fetched is ever HTML
// =============================================================================================================================================================

const SOURCES = ['js/ui/about.js', 'js/update-check.js', 'js/version.js', 'js/build-info.js'];

test('5.1 grep: no innerHTML, outerHTML, insertAdjacentHTML, document.write, eval, new Function, srcdoc, on* attribute or javascript: address in the version code', () => {
  const banned = [/\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write\b/, /\beval\s*\(/, /\bnew\s+Function\b/, /\bsrcdoc\b/, /\bsetAttribute\(\s*['"`]on/i, /\bDOMParser\b/, /\bcreateContextualFragment\b/, /\bsetTimeout\(\s*['"`]/, /javascript:/i];
  for (const rel of SOURCES) {
    const code = H.stripComments(read(rel));
    for (const re of banned) assert.ok(!re.test(code), `${rel}: ${re}`);
  }
  // the report: the one new interpolation is the footer text, produced by buildSummary (made of the safe fields of normalizeBuild)
  const report = H.stripComments(read('js/ui/report.js'));
  const uses = [...report.matchAll(/\$\{(?:buildSummary|BUILD|build)[^}]*\}/g)].map((m) => m[0]);
  assert.deepEqual(uses, ['${buildSummary(build)}']);
  // everything the dialog sets as text goes through h() children (text nodes) or textContent
  const about = H.stripComments(read('js/ui/about.js'));
  assert.ok(!/\bhref:\s*[a-zA-Z_.]*(?:remote|entry|item|text|body)/.test(about), 'no address comes from a fetched file');
  const hrefs = [...about.matchAll(/\blink\(([^,]+),/g)].map((m) => m[1].trim());
  for (const arg of hrefs) assert.match(arg, /^(?:url|`\$\{b\.repository\}[^`]*`|b\.repository)$/, `link target ${arg} must come from the build identity`);
});

const ALLOWED_TAGS = new Set(['div', 'button', 'span', 'svg', 'path', 'h4', 'h5', 'p', 'ul', 'li', 'strong', 'em', 'code']);
const ALLOWED_ATTRS = new Set(['class', 'id', 'type', 'role', 'aria-expanded', 'aria-controls', 'hidden', 'aria-haspopup', 'aria-label', 'data-tip', 'data-role', 'aria-live', 'xmlns', 'width', 'height', 'viewBox', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'aria-hidden', 'focusable', 'd']);

/** Walk a tree built from a hostile changelog and fail on anything that could run or load something. */
function assertInert(dom, root, { tags = ALLOWED_TAGS, attrs = ALLOWED_ATTRS } = {}) {
  for (const el of dom.elements(root)) {
    assert.ok(tags.has(el.localName), `unexpected element <${el.localName}>`);
    for (const [name, value] of el.attrs) {
      assert.ok(attrs.has(name) || name.startsWith('style:'), `unexpected attribute ${name} on <${el.localName}>`);
      assert.ok(!/<|javascript:|window\.__pwned|onerror|onload/i.test(value), `${name}=${JSON.stringify(value)} carries markup from the file`);
      assert.ok(!/^on/i.test(name), name);
    }
  }
}

test('5.2 the changelog built on a fake DOM that throws on markup: inert elements only, every hostile string is a text node', async () => {
  const dom = H.installFakeDom();
  try {
    const entries = V.parseChangelog(H.hostileChangelog());
    const list = renderChangelog(entries, { currentVersion: '0.6.0' });
    assertInert(dom, list);
    const texts = dom.textNodes(list).join('\u0001');
    for (const s of H.HOSTILE_STRINGS) assert.ok(texts.includes(s), `shown as text: ${JSON.stringify(s)}`);
    assert.deepEqual(dom.innerHtmlWrites.filter((w) => w.tag !== 'template'), [], 'no innerHTML on a real element');
    for (const w of dom.innerHtmlWrites) assert.ok(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" class="icon icon--[\w-]+"/.test(w.value) && !/__pwned|<script|onerror/.test(w.value), 'only our own icon markup');
    assert.equal(dom.elements(list).filter((e) => ['a', 'img', 'script', 'iframe', 'style', 'link', 'form', 'input', 'object', 'embed'].includes(e.localName)).length, 0);
  } finally {
    dom.restore();
  }
});

/** The ctx and the dialog primitive that openAbout needs, recorded. */
function aboutRig() {
  const toasts = [];
  const shown = [];
  const ctx = { store: { persist: () => true, getState: () => ({ dirty: false }) }, toast: (...a) => toasts.push(a), dialogs: { openAbout() {} } };
  const dlg = { show: (spec) => { shown.push(spec); return { close() {}, el: null }; } };
  return { ctx, dlg, shown, toasts };
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); };
const inertWatcher = () => ({ state: () => ({ available: false, remote: null }), subscribe: () => () => {}, start() {} });
const factsOf = (dom, body) => {
  const dl = body.querySelector('dl');
  const kids = dl.children;
  return Object.fromEntries(kids.filter((_, i) => i % 2 === 0).map((dt, i) => [dt.textContent, kids[i * 2 + 1].textContent]));
};

test('5.3 the whole About dialog with a hostile changelog, a live build and a hostile version.json: inert, and every address is the repository\'s', async () => {
  const dom = H.installFakeDom({ host: 'logiplan.test:8080' });
  try {
    await loadChangelog({ fetchFn: async () => okResponse(H.hostileChangelog()), force: true });
    const { ctx, dlg, shown } = aboutRig();
    // a version.json that is valid enough to raise the update box, with hostile extras that must be ignored
    const watcher = createUpdateWatcher({
      build: LIVE, now: () => 1, setTimer: () => 0, clearTimer: () => {},
      fetchFn: async () => okResponse(JSON.stringify({ commit: SHA_B, version: '0.7.0', builtAt: '2026-10-10T08:00:00Z', shortCommit: '<img src=x onerror=1>', channel: '<b>', builtFrom: '"><script>', name: '<script>' })),
    });
    await watcher.check({ force: true });
    const chip = createVersionChip(ctx, { build: LIVE, watcher });
    assertInert(dom, chip.el);
    assert.match(chip.el.getAttribute('aria-label'), /^v0\.6\.0 a45ce49 Update\. An update is available/);
    // the build time is 15:08 UTC on the 9th: in the viewer's own zone that is the 9th or, east of UTC+8:52, the 10th - the test must not depend on the zone it runs in
    assert.match(chip.el.getAttribute('data-tip'), /^Update available \(v0\.7\.0\) – click for details and to reload\. Your build: a45ce49, (?:9|10) Oct 2026$/);
    openAbout(ctx, dlg, { build: LIVE });
    await settle();
    const { body } = shown[0];
    assertInert(dom, body, { tags: new Set([...ALLOWED_TAGS, 'dl', 'dt', 'dd', 'a', 'img', 'section', 'h3', 'p']), attrs: new Set([...ALLOWED_ATTRS, 'href', 'target', 'rel', 'src', 'alt', 'aria-labelledby']) });
    for (const a of dom.elements(body).filter((e) => e.localName === 'a')) {
      if (a.getAttribute('href') === 'how/') continue; // the one link of the dialog to the landing page next to the app (relative, same tab)
      assert.match(a.getAttribute('href'), /^https:\/\/github\.com\/rangulvers\/LogiPlan(\/[A-Za-z0-9/._-]*)?$/, 'every address is the repository\'s');
      assert.equal(a.getAttribute('target'), '_blank');
      assert.match(a.getAttribute('rel'), /noopener/);
    }
    assert.deepEqual(dom.elements(body).filter((e) => e.localName === 'img').map((e) => e.getAttribute('src')), ['assets/logo.svg'], 'the one image is the logo');
    const box = body.querySelector('.about__update').textContent;
    assert.match(box, /A newer version is available.*Version 0\.7\.0 \(build b3c4d5e\) is on the site; this page is version 0\.6\.0/);
    assert.ok(!/<|onerror|script/.test(box), 'nothing of the hostile extras reached the box');
    assert.deepEqual(dom.innerHtmlWrites.filter((w) => w.tag !== 'template'), []);
    assert.equal(factsOf(dom, body)['Where it runs'], 'Live site (logiplan.test:8080)');
  } finally {
    dom.restore();
  }
});

test('5.4 a changelog that cannot be loaded says so in words, as text; a failing "Try again" and a missing fetch do not throw', async () => {
  const dom = H.installFakeDom();
  try {
    for (const [fetchFn, expect] of [[async () => ({ ok: false, status: 404 }), /not found/], [async () => { throw new TypeError('<img src=x onerror=1>'); }, /offline/], [null, /cannot load/], [async () => okResponse('nothing to see'), /could not be read/]]) {
      await loadChangelog({ fetchFn, force: true }).catch(() => {});
      await settle();
      const { ctx, dlg, shown } = aboutRig();
      openAbout(ctx, dlg, { build: DEV, fetchFn });
      await settle();
      const news = shown[0].body.querySelector('[data-role="about-news"]');
      assert.match(news.textContent, expect);
      assert.ok(!/<img|onerror|TypeError/.test(news.textContent), 'the error text of the browser is never shown');
      assertInert(dom, news, { tags: new Set([...ALLOWED_TAGS, 'a', 'p']), attrs: new Set([...ALLOWED_ATTRS, 'href', 'target', 'rel']) });
    }
  } finally {
    dom.restore();
  }
});

test('5.5 the report footer: hostile build identities cannot add markup, and the real one names the version', () => {
  const store = createStore({ storage: undefined });
  store.newProject(EXAMPLES[0].build());
  const ctx = { store, runner: { sim: null, kpis: () => null, insights: () => [] }, renderer: { sim: null, toDataURL: () => null }, issues: () => validateLayout(store.getState().layout), toast() {} };
  const footer = (build) => /<footer>(.*?)<\/footer>/s.exec(exportReportHtml(ctx, { now: new Date(2026, 9, 8, 14, 5), build }))[1];
  const hostile = [
    { version: '<script>alert(1)</script>', commit: SHA_A, channel: 'live' }, { version: '0.6.0', commit: '"><img src=x onerror=1>', channel: 'live' }, { version: '0.6.0', commit: SHA_A, channel: '<b>' },
    { version: '0.6.0\u0000', commit: SHA_A }, { version: '0.6.0-<b>', commit: SHA_A }, { version: ['0.6.0'], commit: [SHA_A] }, { version: { toString: () => '<i>' } }, null, undefined, 'x', 7, [],
    JSON.parse('{"__proto__":{"version":"<b>"}}'),
  ];
  for (const build of hostile) {
    const text = footer(build);
    assert.ok(!/<(?!\/?span>)/.test(text.replace(/<\/?span>/g, '')), `markup in the footer for ${JSON.stringify(build)}: ${text}`);
    assert.match(text, /^<span>Generated with LogiPlan v[0-9A-Za-z.+-]+ \([0-9a-z ]+\)<\/span><span>8 October 2026, 14:05<\/span>$/, JSON.stringify(build));
  }
  assert.match(footer(LIVE), /Generated with LogiPlan v0\.6\.0 \(a45ce49\)/);
});

test('VER-REV-8 "What is new" is read once per page load: after an update is announced the dialog still shows the old list', async () => {
  // The planner opens About early (to see the version); hours later the chip says "Update"; the box says "Version 0.7.0 is on the site" - and the list below
  // still ends at 0.6.0 because loadChangelog keeps its first answer for ever. Reading the list again when an update is waiting would show what the update brings.
  const dom = H.installFakeDom();
  try {
    const before = '## [0.6.0] - 2026-10-09\n### Added\n- The version is shown in the app.\n';
    const after = '## [0.7.0] - 2026-10-12\n### Added\n- A brand new thing planners can do.\n\n' + before;
    await loadChangelog({ fetchFn: async () => okResponse(before), force: true }); // the first time About was opened
    const { ctx, dlg, shown } = aboutRig();
    const watcher = createUpdateWatcher({ build: LIVE, now: () => 1, setTimer: () => 0, clearTimer: () => {}, fetchFn: async () => okResponse(NEWER_BODY) });
    await watcher.check({ force: true });
    assert.equal(watcher.state().available, true);
    createVersionChip(ctx, { build: LIVE, watcher });
    openAbout(ctx, dlg, { build: LIVE, fetchFn: async () => okResponse(after) }); // the second time, with the update announced; the site now serves the new list
    await settle();
    const news = shown[0].body.querySelector('[data-role="about-news"]').textContent;
    assert.match(news, /Version 0\.7\.0/, `the update box announces 0.7.0 but the list shows: ${news.replace(/\s+/g, ' ').slice(0, 120)}`);
  } finally {
    dom.restore();
  }
});

// =============================================================================================================================================================
// 6  clipboard
// =============================================================================================================================================================

test('6.1 copyText survives every way a browser refuses, leaves no text field behind and gives the focus back', async () => {
  let dummy;
  const cases = [
    ['the clipboard API works', { writeText: async () => {} }, () => false, true],
    ['no clipboard API (an insecure page), the copy command works', undefined, () => true, true],
    ['the clipboard API rejects (permission denied), the copy command works', { writeText: async () => { throw new DOMException('denied', 'NotAllowedError'); } }, () => true, true],
    ['the clipboard API throws at once', { writeText: () => { throw new TypeError('x'); } }, () => true, true],
    ['writeText is not a function', { writeText: 5 }, () => true, true],
    ['both refuse', { writeText: async () => { throw new Error('denied'); } }, () => false, false],
    ['the copy command throws', undefined, () => { throw new Error('not allowed'); }, false],
    ['the copy command answers something odd', undefined, () => 'yes', false],
  ];
  for (const [name, clipboard, execCommand, expected] of cases) {
    const dom = H.installFakeDom({ clipboard, execCommand });
    try {
      dummy = dom.document.createElement('button');
      dom.document.body.append(dummy);
      dummy.focus();
      const host = dom.document.body;
      let result;
      const seen = await unhandledDuring(async () => { result = await copyText('LogiPlan v0.6.0 (a45ce49)', host); });
      assert.deepEqual(seen, [], name);
      assert.equal(result, expected, name);
      assert.deepEqual(host.children, [dummy], `${name}: the temporary text field is gone`);
      assert.equal(dom.document.activeElement, dummy, `${name}: focus is back`);
    } finally {
      dom.restore();
    }
  }
});

test('6.2 the Copy button of the dialog: success says so; a refusal selects the line and says what to press; neither throws, and no toast covers the dialog', async () => {
  for (const refuse of [false, true]) {
    const dom = H.installFakeDom({ clipboard: refuse ? { writeText: async () => { throw new Error('denied'); } } : { writeText: async () => {} }, execCommand: () => false });
    try {
      const { ctx, dlg, shown, toasts } = aboutRig();
      await loadChangelog({ fetchFn: async () => okResponse('## [1.0.0] - 2026-01-01\n### Added\n- Something.\n'), force: true });
      openAbout(ctx, dlg, { build: LIVE });
      const { body } = shown[0];
      const button = dom.elements(body).find((e) => e.localName === 'button' && /Copy version info/.test(e.textContent));
      assert.ok(button);
      const seen = await unhandledDuring(async () => { await button.click(); });
      assert.deepEqual(seen, []);
      assert.deepEqual(toasts, [], 'the answer stands in the dialog (a polite live region), not in a toast that would cover the Close button');
      const noteEl = body.querySelector('[data-role="about-copied"]');
      assert.equal(noteEl.getAttribute('role'), 'status', 'announced to a screen reader');
      const note = noteEl.textContent;
      if (refuse) {
        assert.match(note, /Copying is blocked/);
        assert.equal(dom.selection.ranges.length, 1, 'the line is selected');
        assert.equal(dom.selection.ranges[0].node, body.querySelector('[data-role="about-line"]'));
      } else {
        assert.equal(note, 'Copied. Paste it into your bug report.');
      }
      const line = body.querySelector('[data-role="about-line"]').textContent;
      assert.match(line, /^LogiPlan v0\.6\.0 \(a45ce49, built 2026-10-09 15:08 UTC\), Chrome 126, window 1440 x 900 on a 1920 x 1080 screen$/);
    } finally {
      dom.restore();
    }
  }
});

// =============================================================================================================================================================
// 7  time and locale
// =============================================================================================================================================================

/** Independent oracle: the day and the time of an instant in a zone, from the 'sv-SE' format ("2026-10-09 17:08:00"). */
function oracle(iso, timeZone) {
  const text = new Date(iso).toLocaleString('sv-SE', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const [, y, mo, d, hh, mm] = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)/.exec(text);
  return { day: `${Number(d)} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(mo) - 1]} ${y}`, time: `${hh}:${mm}` };
}
const ZONES = ['UTC', 'Europe/Berlin', 'America/St_Johns', 'Pacific/Kiritimati', 'Pacific/Chatham', 'Asia/Kolkata', 'America/Los_Angeles', 'Australia/Lord_Howe', 'Pacific/Apia', 'Asia/Kathmandu'];

test('7.1 formatBuildDate against an independent oracle: 400 random instants in ten zones (DST, +14:00, +13:45, +5:45, half-hour DST)', () => {
  for (const seed of seeds(40, 500)) {
    const rng = H.makeRng(seed);
    const date = new Date(Date.UTC(H.int(rng, 2000, 2199), H.int(rng, 0, 11), H.int(rng, 1, 28), H.int(rng, 0, 23), H.int(rng, 0, 59), H.int(rng, 0, 59)));
    const iso = date.toISOString().replace(/\.\d{3}Z$/, 'Z');
    for (const zone of ZONES) {
      const got = V.formatBuildDate(iso, { timeZone: zone });
      const want = oracle(iso, zone);
      assert.ok(got, `${iso} ${zone}`);
      assert.equal(got.day, want.day, `${iso} in ${zone}`);
      assert.ok(got.local.startsWith(`${want.day}, ${want.time}`), `${iso} in ${zone}: ${got.local} vs ${want.day}, ${want.time}`);
      assert.equal(got.utc, `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 16)} UTC`);
      assert.equal(got.iso, iso);
    }
  }
});

test('7.2 daylight saving: the two 02:30 of the night the clocks go back are told apart by the zone name; the hour that does not exist is skipped', () => {
  const first = V.formatBuildDate('2026-10-25T00:30:00Z', { timeZone: 'Europe/Berlin' });
  const second = V.formatBuildDate('2026-10-25T01:30:00Z', { timeZone: 'Europe/Berlin' });
  assert.ok(first.local.startsWith('25 Oct 2026, 02:30') && second.local.startsWith('25 Oct 2026, 02:30'));
  assert.notEqual(first.zone, second.zone, `the zone name tells ${first.zone} from ${second.zone}`);
  assert.equal(first.utc, '2026-10-25 00:30 UTC');
  assert.equal(second.utc, '2026-10-25 01:30 UTC');
  const spring = V.formatBuildDate('2026-03-29T01:30:00Z', { timeZone: 'Europe/Berlin' });
  assert.ok(spring.local.startsWith('29 Mar 2026, 03:30'), spring.local);
  assert.equal(V.formatBuildDate('2026-10-09T23:30:00Z', { timeZone: 'Pacific/Kiritimati' }).day, '10 Oct 2026', 'the next day in +14:00');
  assert.equal(V.formatBuildDate('2026-10-09T00:00:00Z', { timeZone: 'UTC' }).local, '9 Oct 2026, 00:00 UTC', 'midnight is 00:00, not 24:00');
  assert.equal(V.formatBuildDate('2026-10-09T15:08:00+02:00', { timeZone: 'UTC' }).utc, '2026-10-09 13:08 UTC', 'an offset in the file is converted');
});

test('7.3 the viewer\'s own zone is used when none is given (TZ of the process), and a zone the browser does not know falls back to it', () => {
  const script = `import('${path.join(ROOT, 'js/version.js').replace(/\\/g, '/')}').then((V) => { console.log(JSON.stringify(['2026-10-09T15:08:00Z', '2026-12-31T23:30:00Z', '2026-06-30T23:30:00Z'].map((iso) => [V.formatBuildDate(iso), V.formatBuildDate(iso, { timeZone: 'Mars/Olympus' }), V.formatBuildDate(iso, { timeZone: '../etc/passwd' }), V.formatBuildDate(iso, { timeZone: 42 }), V.formatBuildDate(iso, { timeZone: '' })]))); });`;
  for (const [tz, zone] of [['Pacific/Kiritimati', 'Pacific/Kiritimati'], ['America/Los_Angeles', 'America/Los_Angeles'], ['Asia/Kolkata', 'Asia/Kolkata']]) {
    const res = H.runNode(['-e', script], { env: { TZ: tz } });
    assert.equal(res.status, 0, res.stderr);
    const rows = JSON.parse(res.stdout);
    for (const [i, iso] of ['2026-10-09T15:08:00Z', '2026-12-31T23:30:00Z', '2026-06-30T23:30:00Z'].entries()) {
      const want = oracle(iso, zone);
      for (const variant of rows[i]) {
        assert.ok(variant, `${tz}: a bad zone name must not make the date vanish`);
        assert.equal(variant.day, want.day, `${tz} ${iso}`);
        assert.equal(variant.utc, `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`, `${tz} ${iso}: the UTC text is UTC whatever zone the process runs in (a half-hour zone shows a wrong minute otherwise)`);
        assert.ok(variant.local.startsWith(`${want.day}, ${want.time}`), `${tz} ${iso}: ${variant.local}`);
      }
    }
  }
});

test('7.4 builtAt that is null, invalid, in the far future, a number or an object: no throw, no "undefined", no "Invalid Date"', () => {
  const values = [null, undefined, '', 'x', 'soon', '2026-02-30T10:00:00Z', '2026-10-09', '2026-10-09T15:08:00', '2199-12-31T23:59:59Z', '2200-01-01T00:00:00Z', '1970-01-01T00:00:00Z', 1791558480, {}, [], '9'.repeat(1e6), '2026-10-09T15:08:00Z\n'];
  for (const builtAt of values) {
    const build = { ...LIVE, builtAt };
    let texts;
    assert.doesNotThrow(() => {
      texts = [V.chipTooltip(build), V.chipAriaLabel(build), V.bugReportLine(build, { userAgent: 'Chrome/126' }), V.versionLabel(build), V.buildSummary(build), JSON.stringify(V.normalizeBuild(build))];
    }, String(builtAt).slice(0, 30));
    for (const text of texts) assert.ok(!/undefined|NaN|Invalid|\[object/.test(text), `${String(builtAt).slice(0, 30)}: ${text}`);
  }
  assert.equal(V.normalizeBuild({ ...LIVE, builtAt: '2199-12-31T23:59:59Z' }).builtAt, '2199-12-31T23:59:59Z', 'the far future up to 2199 is accepted as written');
  assert.equal(V.normalizeBuild({ ...LIVE, builtAt: '2200-01-01T00:00:00Z' }).builtAt, null);
  assert.equal(V.normalizeBuild({ ...LIVE, builtAt: '2026-10-09T15:08:00Z\n' }).builtAt, null, 'a trailing newline makes it no date');
  assert.match(V.chipTooltip({ ...LIVE, builtAt: null }), /^Build a45ce49 – click for what is new$/);
});

test('7.5 calendar days: leap years, month ends, formats', () => {
  const real = ['2026-10-09', '2028-02-29', '2000-02-29', '2000-01-01', '2199-12-31', '2026-12-31', ' 2026-10-09 '];
  const fake = ['2026-02-29', '2100-02-29', '2026-04-31', '2026-06-31', '2026-00-10', '2026-13-01', '2026-10-00', '2026-10-32', '2026-1-1', '26-10-09', '1999-12-31', '2200-01-01', '2026/10/09', '2026-10-09T00:00:00Z', '', null, 20261009, {}];
  for (const d of real) assert.ok(V.parseDay(d), d);
  for (const d of fake) assert.equal(V.parseDay(d), null, String(d));
  assert.equal(V.formatDay('2028-02-29'), '29 February 2028');
  assert.equal(V.formatDay('2026-02-29'), '');
  assert.equal(V.formatDay('2026-10-09'), '9 October 2026');
});

// =============================================================================================================================================================
// 8  where it runs
// =============================================================================================================================================================

async function whereItRunsInDialog(host, build = LIVE) {
  const dom = H.installFakeDom({ host });
  try {
    const { ctx, dlg, shown } = aboutRig();
    await loadChangelog({ fetchFn: async () => okResponse('## [1.0.0] - 2026-01-01\n- Something.\n'), force: true });
    openAbout(ctx, dlg, { build });
    const where = factsOf(dom, shown[0].body)['Where it runs'];
    await settle(); // the list of changes arrives after openAbout returns: let it finish while the fake DOM is still installed
    return where;
  } finally {
    dom.restore();
  }
}

test('8.1 where it runs: the pure function, with host names (no port)', () => {
  assert.equal(V.whereItRuns(DEV, 'localhost'), 'Local development');
  assert.equal(V.whereItRuns(LIVE, 'rangulvers.github.io'), 'Live site');
  assert.equal(V.whereItRuns(LIVE, ''), 'Live site');
  assert.equal(V.whereItRuns(LIVE, 'localhost'), 'Built site on this computer');
  assert.equal(V.whereItRuns(LIVE, '127.0.0.1'), 'Built site on this computer');
  assert.equal(V.whereItRuns(LIVE, '::1'), 'Built site on this computer');
  assert.equal(V.whereItRuns(LIVE, 'laptop.local'), 'Built site on this computer');
  assert.equal(V.whereItRuns({ ...LIVE, commit: 'local', channel: 'local' }, 'rangulvers.github.io'), 'Built site on this computer');
  assert.equal(V.whereItRuns(LIVE, 'localhost.evil.com'), 'Live site', 'only the real local names are local');
  assert.equal(V.whereItRuns(LIVE, 'xlocalhost'), 'Live site');
});

test('8.2 the dialog on the live host and on a development copy says the right thing', async () => {
  assert.match(await whereItRunsInDialog('rangulvers.github.io'), /^Live site \(rangulvers\.github\.io\)$/);
  assert.match(await whereItRunsInDialog('logiplan.test:8080'), /^Live site \(logiplan\.test:8080\)$/, 'a live host with a port (a staging server) is still the live site');
  assert.match(await whereItRunsInDialog('localhost:8080', DEV), /^Local development \(localhost:8080\)$/);
});

test('VER-REV-4 a deployed build served from localhost:PORT is called "Live site" (openAbout passes location.host, with the port, to whereItRuns)', async () => {
  // This is how a planner looks at the Pages artifact before it goes out (`npx serve _site`, `python -m http.server`): the build carries a real commit, so the
  // channel is 'live', and the dialog claims to be the live site. whereItRuns knows "localhost", "127.x.x.x", "::1" and "*.local" but only without a port.
  const wrong = [];
  for (const host of ['localhost:8080', '127.0.0.1:8080', '[::1]:8080', 'laptop.local:3000', '127.0.0.1:41234']) {
    const text = await whereItRunsInDialog(host);
    if (/^Live site/.test(text)) wrong.push(`${host} -> "${text}"`);
  }
  assert.deepEqual(wrong, [], 'the dialog calls these local hosts the live site');
});

// =============================================================================================================================================================
// 9  the build pipeline
// =============================================================================================================================================================

const buildSite = (out, env = {}, opts = {}) => H.runNode([path.join(ROOT, 'scripts/build-site.mjs'), out], { env, ...opts });
const repoHash = () => H.treeHash(path.join(ROOT, 'js')) + H.treeHash(path.join(ROOT, 'scripts')) + readFileSync(path.join(ROOT, 'package.json'), 'utf8') + readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');

test('9.1 GITHUB_SHA battery: a real commit makes a live build, anything else a local one; what is written is code that says the same when imported and read by the app', async () => {
  const cases = [
    [SHA_A, 'live', SHA_A], [SHA_A.toUpperCase(), 'live', SHA_A], [` ${SHA_A}\n`, 'live', SHA_A], [SHA_A.slice(0, 7), 'live', SHA_A.slice(0, 7)], ['a'.repeat(64), 'live', 'a'.repeat(64)],
    ['', 'local', 'local'], [' ', 'local', 'local'], ['abc', 'local', 'local'], ['a'.repeat(65), 'local', 'local'], ['main', 'local', 'local'], ['xyz'.repeat(14), 'local', 'local'],
    ['"; process.exit(7); //', 'local', 'local'], ['`touch /tmp/pwned`', 'local', 'local'], ['$(id)', 'local', 'local'], [`${SHA_A}"; throw 1; "`, 'local', 'local'], [`${SHA_A}\nexport const X = 1;`, 'local', 'local'],
    ['</script><script>1</script>', 'local', 'local'], ['\u2028\u2029', 'local', 'local'], ['0'.repeat(7), 'live', '0'.repeat(7)],
  ];
  for (const [value, channel, commit] of cases) {
    const id = buildIdentity({ pkg, env: { GITHUB_SHA: value } });
    assert.deepEqual([id.channel, id.commit], [channel, commit], JSON.stringify(value));
    const dir = H.tmpDir('ver-bi-');
    mkdirSync(path.join(dir, 'js'));
    const text = renderBuildInfo(id);
    writeFileSync(path.join(dir, 'js/build-info.js'), text);
    const build = await H.importSiteBuild(dir);
    assert.deepEqual({ ...build }, { version: id.version, commit: id.commit, shortCommit: id.shortCommit, builtAt: id.builtAt, channel: id.channel, repository: id.repository });
    assert.deepEqual(V.normalizeBuild(build), { ...build }, `${JSON.stringify(value)}: the app reads the build exactly as written`);
    assert.equal(V.isReleaseBuild(build), channel === 'live');
    assert.equal(JSON.parse(renderVersionJson(id)).commit, commit, 'version.json keeps its old meaning: the commit, or "local"');
    assert.equal(text.split('\n').length, 10, 'a comment, the opening, six properties, the closing and the end of the file: nothing could be smuggled in as an extra statement');
    assert.ok(text.split('\n').slice(2, 8).every((line) => /^  \w+: ("[^"\n]*"|null),$/.test(line.replace(/\\./g, 'x'))), 'one JSON value per line');
  }
});

test('9.2 a site built twice from the same inputs is byte for byte the same; stale files in the output are gone; a new commit changes only the two identity files', () => {
  const env = { GITHUB_SHA: SHA_A, GITHUB_REF_NAME: 'main', GITHUB_REPOSITORY: 'rangulvers/LogiPlan', SOURCE_DATE_EPOCH: '1791558480' };
  const out = path.join(H.tmpDir('ver-site-'), 'site');
  assert.equal(buildSite(out, env).status, 0);
  const first = H.treeHash(out);
  mkdirSync(path.join(out, 'junk'), { recursive: true });
  writeFileSync(path.join(out, 'junk', 'stale.txt'), 'left over');
  writeFileSync(path.join(out, 'js', 'old-module.js'), 'export {}');
  assert.equal(buildSite(out, env).status, 0);
  assert.equal(H.treeHash(out), first, 'the second build is identical (stale files removed)');
  const other = path.join(H.tmpDir('ver-site-'), 'site');
  assert.equal(buildSite(other, { ...env, GITHUB_SHA: SHA_B }).status, 0);
  const a = H.tree(out);
  const b = H.tree(other);
  assert.deepEqual(a, b);
  const changed = a.filter((rel) => readFileSync(path.join(out, rel), 'utf8') !== readFileSync(path.join(other, rel), 'utf8'));
  assert.deepEqual(changed, ['js/build-info.js', 'version.json']);
  // the output holds what the site needs and nothing from the repository's working files
  for (const needed of ['index.html', '.nojekyll', 'CHANGELOG.md', 'version.json', 'js/build-info.js', 'js/version.js', 'js/update-check.js', 'js/ui/about.js', 'css/tokens.css', 'assets/logo.svg', 'favicon.svg']) assert.ok(existsSync(path.join(out, needed)), needed);
  for (const never of ['package.json', 'tests', 'scripts', 'docs', 'node_modules', '.git', 'e2e-output', '_site']) assert.ok(!existsSync(path.join(out, never)), never);
});

test('9.3 the repository is untouched by a build, with and without a commit, and no output directory appears in it', () => {
  const before = repoHash();
  const info = readFileSync(path.join(ROOT, 'js/build-info.js'), 'utf8');
  const hadSite = existsSync(path.join(ROOT, '_site'));
  for (const env of [{ GITHUB_SHA: SHA_A, GITHUB_REF_NAME: 'main' }, {}, { GITHUB_SHA: 'x"; //' }]) {
    const res = buildSite(path.join(H.tmpDir('ver-site-'), 'out'), env);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(readFileSync(path.join(ROOT, 'js/build-info.js'), 'utf8'), info);
  }
  assert.equal(repoHash(), before);
  assert.equal(existsSync(path.join(ROOT, '_site')), hadSite);
  assert.equal(BUILD.commit, 'dev', 'and the module the tests imported is still the development default');
});

test('9.4 version.json: the old fields keep their old meaning, the new ones are additive, and a consumer of the old shape still works', () => {
  const read2 = (env) => {
    const out = path.join(H.tmpDir('ver-site-'), 'site');
    assert.equal(buildSite(out, env).status, 0);
    return { text: readFileSync(path.join(out, 'version.json'), 'utf8'), json: JSON.parse(readFileSync(path.join(out, 'version.json'), 'utf8')) };
  };
  const live = read2({ GITHUB_SHA: SHA_A, GITHUB_REF_NAME: 'main', SOURCE_DATE_EPOCH: '1791558480' });
  assert.ok(live.text.endsWith('}\n'), 'a file that ends with a newline, two-space indent, as before');
  assert.ok(live.text.startsWith('{\n  "name": "logiplan"'));
  // the shape the old build-site.mjs wrote: { name, version, commit, builtFrom }
  for (const key of ['name', 'version', 'commit', 'builtFrom']) assert.ok(Object.hasOwn(live.json, key), key);
  assert.deepEqual([live.json.name, live.json.version, live.json.commit, live.json.builtFrom], ['logiplan', pkg.version, SHA_A, 'main']);
  assert.deepEqual(Object.keys(live.json), ['name', 'version', 'commit', 'shortCommit', 'builtAt', 'channel', 'builtFrom']);
  assert.ok(V.formatBuildDate(live.json.builtAt), 'a build time the app can show');
  const local = read2({});
  assert.deepEqual([local.json.commit, local.json.builtFrom], ['local', 'local'], 'without GITHUB_SHA and GITHUB_REF_NAME: "local", as before');
  const ref = read2({ GITHUB_SHA: SHA_A, GITHUB_REF_NAME: 'release/ü\u0007x'.padEnd(300, 'y') });
  assert.match(ref.json.builtFrom, /^[\x20-\x7e]{1,120}$/, 'a branch name is cut and made printable');
});

test('9.5 the build does not depend on the working directory, accepts an absolute output path and a trailing slash', () => {
  const elsewhere = H.tmpDir('ver-cwd-');
  const out = path.join(H.tmpDir('ver-site-'), 'site');
  const res = buildSite(`${out}${path.sep}`, { GITHUB_SHA: SHA_A }, { cwd: elsewhere });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(path.join(out, 'version.json')));
  assert.match(res.stdout, /site assembled/);
  assert.deepEqual(H.tree(elsewhere), [], 'nothing was written into the working directory');
});

test('9.6 a build that cannot start leaves the old site alone and says why; a broken package.json version is refused', () => {
  const repo = H.repoCopy();
  const bad = JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8'));
  bad.version = 'banana';
  writeFileSync(path.join(repo, 'package.json'), JSON.stringify(bad));
  const out = path.join(H.tmpDir('ver-site-'), 'site');
  mkdirSync(out);
  writeFileSync(path.join(out, 'index.html'), 'the site that is live');
  const res = H.runNode([path.join(repo, 'scripts/build-site.mjs'), out], { env: { GITHUB_SHA: SHA_A }, cwd: repo });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no valid "version"/);
  assert.equal(readFileSync(path.join(out, 'index.html'), 'utf8'), 'the site that is live', 'the old output is not emptied by a build that cannot succeed');
});

test('9.7 the workflows\' contract with the script: the output folders are ignored by git and safe to empty, the artifact is the folder that was built, GITHUB_SHA is what the freshness check compares', () => {
  const pages = read('.github/workflows/pages.yml');
  const ci = read('.github/workflows/ci.yml');
  const ignore = read('.gitignore').split('\n').map((l) => l.trim());
  for (const [name, text] of [['pages.yml', pages], ['ci.yml', ci]]) {
    const builds = [...text.matchAll(/node scripts\/build-site\.mjs\s+(\S+)/g)].map((m) => m[1]);
    assert.ok(builds.length >= 1, `${name} builds the site`);
    for (const dir of builds) {
      assert.ok(ignore.includes(`/${dir}/`), `${name}: ${dir} is in .gitignore`);
      assert.doesNotThrow(() => assertSafeOutput(path.join(ROOT, dir), ROOT), `${name}: ${dir}`);
    }
  }
  assert.match(pages, /uses: actions\/upload-pages-artifact@v3\s+with:\s+path: _site\b/, 'the artifact is the folder that was built');
  assert.match(pages, /\[ "\$latest" != "\$GITHUB_SHA" \]/, 'the freshness check compares the same GITHUB_SHA that the build writes into version.json');
  assert.ok(pages.indexOf('node scripts/build-site.mjs _site') < pages.indexOf('Is this still the newest commit?'), 'the site is assembled before the freshness check');
  assert.ok(!/version\.json|bump-version|build-info/.test(pages + ci), 'the workflows need no change: the script does the work');
  assert.ok(pages.indexOf('npm run test:fast') < pages.indexOf('node scripts/build-site.mjs'), 'the tests run before the site is built, so no test can see a generated build-info.js');
});

test('9.8 the branch name is trimmed and a blank one is "local"; the commit page address is lower-case whatever the case of the commit', () => {
  for (const [value, want] of [['  main \n', 'main'], ['', 'local'], ['   ', 'local'], ['\t\n', 'local'], ['release/1.0', 'release/1.0']]) {
    assert.equal(buildIdentity({ pkg, env: { GITHUB_SHA: SHA_A, GITHUB_REF_NAME: value } }).builtFrom, want, JSON.stringify(value));
  }
  assert.equal(V.commitUrl(REPO_URL_FOR_TESTS, SHA_A.toUpperCase()), `${REPO_URL_FOR_TESTS}/commit/${SHA_A}`);
  assert.equal(V.commitUrl(`${REPO_URL_FOR_TESTS}.git`, SHA_A), `${REPO_URL_FOR_TESTS}/commit/${SHA_A}`, 'a .git address is the same repository');
  assert.equal(V.commitUrl(REPO_URL_FOR_TESTS, 'dev'), null);
  assert.equal(V.commitUrl('https://gitlab.com/a/b', SHA_A), null, 'only GitHub has this address scheme');
});

test('VER-REV-2 build-site.mjs and bump-version.mjs do nothing, silently and with exit 0, when they are started through a symlink', () => {
  // `process.argv[1] === fileURLToPath(import.meta.url)`: node resolves the symlinks of the main module for import.meta.url but not for argv[1]. A checkout under a
  // linked directory (or macOS /tmp -> /private/tmp) therefore never reaches the code. The old build-site.mjs ran unconditionally; this is a regression.
  const holder = H.tmpDir('ver-link-');
  const link = path.join(holder, 'LogiPlan');
  try { symlinkSync(ROOT, link, 'dir'); } catch (err) { return void console.log(`# cannot make a symlink here (${err.code}); not checked`); }
  const out = path.join(holder, 'site');
  const failures = [];
  const build = H.runNode([path.join(link, 'scripts/build-site.mjs'), out], { env: { GITHUB_SHA: SHA_A }, cwd: holder });
  if (build.status !== 0 || !existsSync(path.join(out, 'version.json'))) failures.push(`build-site via a symlink: exit ${build.status}, ${existsSync(out) ? 'output exists' : 'NO output'}, stdout ${JSON.stringify(build.stdout)}`);
  const check = H.runNode([path.join(link, 'scripts/bump-version.mjs'), '--check'], { cwd: holder });
  if (!/agree/.test(check.stdout)) failures.push(`bump-version --check via a symlink: exit ${check.status}, stdout ${JSON.stringify(check.stdout)} - it checked nothing and said nothing`);
  assert.deepEqual(failures, []);
});

test('VER-REV-5 the build empties any folder of the repository it is told to write to (docs, .git, js, css ...), not only the repository itself', () => {
  const repo = path.join(path.sep, 'work', 'LogiPlan');
  const unsafe = ['docs', '.git', 'js', 'css', 'tests', 'scripts', 'assets', 'node_modules', '.github'].filter((name) => {
    try { assertSafeOutput(path.join(repo, name), repo); return true; } catch { return false; }
  });
  assert.deepEqual(unsafe, [], 'assertSafeOutput accepts these folders as an output (they would be emptied)');
  // and the real thing, on a scratch copy: the design documents are gone after `node scripts/build-site.mjs docs`
  const copy = H.repoCopy();
  const res = H.runNode([path.join(copy, 'scripts/build-site.mjs'), 'docs'], { cwd: copy });
  assert.ok(existsSync(path.join(copy, 'docs', 'DESIGN.md')) || res.status !== 0, `exit ${res.status}; docs/DESIGN.md ${existsSync(path.join(copy, 'docs', 'DESIGN.md')) ? 'survived' : 'was deleted'}`);
});

test('VER-REV-6 SOURCE_DATE_EPOCH is not validated: a blank means 1970 (the app then shows a live build as "Not built"), 1e20 crashes the build with "Invalid time value"', () => {
  const now = new Date('2026-10-09T15:08:09Z');
  const bad = [];
  for (const value of [' ', '\t', '1e20', '-5', '0x10', '99999999999999', 'NaN', 'Infinity']) {
    let id;
    try { id = buildIdentity({ pkg, env: { GITHUB_SHA: SHA_A, SOURCE_DATE_EPOCH: value }, now }); } catch (err) { bad.push(`${JSON.stringify(value)} throws "${err.message}"`); continue; }
    if (!V.formatBuildDate(id.builtAt)) bad.push(`${JSON.stringify(value)} -> builtAt ${id.builtAt}, a time the app refuses to show`);
  }
  assert.deepEqual(bad, [], 'an invalid value should be ignored like an invalid GITHUB_SHA is ("soon" already falls back to the clock)');
});

// =============================================================================================================================================================
// 10  bump-version
// =============================================================================================================================================================

const quiet = () => { const lines = []; return { lines, log: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)) }; };
const filesOf = (dir) => ({ pkg: readFileSync(path.join(dir, 'package.json'), 'utf8'), info: readFileSync(path.join(dir, 'js/build-info.js'), 'utf8'), log: readFileSync(path.join(dir, 'CHANGELOG.md'), 'utf8') });
const problemsOf = (dir) => { const f = filesOf(dir); return checkFiles({ pkgText: f.pkg, buildInfoText: f.info, changelogText: f.log }).problems; };

test('10.1 argument forms: every refusal exits 2 and changes nothing; every acceptance leaves the three files in agreement', () => {
  const refusals = [
    [[], 'no target'], [['banana'], 'junk'], [['v1.0.0'], 'a leading v'], [['1.0'], 'two parts'], [['1.0.0.0'], 'four parts'], [['1.0.0+build'], 'build metadata'], [['0.6.0'], 'the same version'], [['0.5.0'], 'an older version'],
    [['0.6.0-rc.1'], 'older than the current release'], [['01.0.0'], 'a leading zero'], [['MINOR'], 'upper case'], [['patch '], 'a blank after the word'], [['minor', 'major'], 'two targets'],
    [['minor', '--date'], 'a missing date'], [['minor', '--date', '2026-02-30'], 'an impossible date'], [['minor', '--date', 'today'], 'a word as date'], [['minor', '--date=2026-10-10'], 'the = form is not supported'],
    [['minor', '--root'], 'a missing root'], [['minor', '--nope'], 'an unknown option'], [['--help'], 'help'], [['-h'], 'short help'], [['٠.٧.٠'], 'Arabic-Indic digits'], [['1e1.0.0'], 'an exponent'],
  ];
  for (const [args, why] of refusals) {
    const dir = H.miniRepo();
    const before = filesOf(dir);
    const out = quiet();
    assert.equal(bump([...args, '--root', dir], out), 2, `${why}: ${JSON.stringify(args)} -> ${out.lines[0]}`);
    assert.deepEqual(filesOf(dir), before, `${why}: nothing was changed`);
    assert.ok(out.lines.length >= 1 && /✗/.test(out.lines[0]), `${why}: it says what is wrong`);
  }
  const accepts = [[['patch'], '0.6.1'], [['minor'], '0.7.0'], [['major'], '1.0.0'], [['0.6.1'], '0.6.1'], [['0.9.0'], '0.9.0'], [['1.0.0-rc.1'], '1.0.0-rc.1'], [['patch', '--dry-run'], '0.6.0'], [['minor', '--date', '2028-02-29'], '0.7.0']];
  for (const [args, version] of accepts) {
    const dir = H.miniRepo();
    assert.equal(bump([...args, '--root', dir, ...(args.includes('--date') ? [] : ['--date', '2026-10-10'])], quiet()), 0, JSON.stringify(args));
    assert.equal(JSON.parse(filesOf(dir).pkg).version, version, JSON.stringify(args));
    assert.deepEqual(problemsOf(dir), [], `${JSON.stringify(args)}: the three files agree afterwards`);
  }
});

test('10.2 a bump is a round trip: bump, check, bump again (older is refused), pre-release to release, and no other file is touched', () => {
  const dir = H.miniRepo();
  writeFileSync(path.join(dir, 'README.md'), 'readme');
  writeFileSync(path.join(dir, 'js/other.js'), 'export {}');
  const others = H.treeHash(dir, ['package.json', 'js/build-info.js', 'CHANGELOG.md']);
  assert.equal(bump(['1.0.0-rc.1', '--root', dir, '--date', '2026-10-10'], quiet()), 0);
  assert.equal(bump(['--check', '--root', dir], quiet()), 0);
  assert.equal(bump(['1.0.0-rc.1', '--root', dir], quiet()), 2, 'the same version again');
  assert.equal(bump(['0.9.0', '--root', dir], quiet()), 2, 'an older one');
  assert.equal(bump(['patch', '--root', dir, '--date', '2026-10-11'], quiet()), 0);
  assert.equal(JSON.parse(filesOf(dir).pkg).version, '1.0.0', 'patch of a pre-release is the release');
  assert.deepEqual(problemsOf(dir), []);
  assert.equal(H.treeHash(dir, ['package.json', 'js/build-info.js', 'CHANGELOG.md']), others, 'nothing else was written');
  const entries = V.parseChangelog(filesOf(dir).log);
  assert.deepEqual(entries.slice(0, 4).map((e) => [e.version, e.date]), [['Unreleased', null], ['1.0.0', '2026-10-11'], ['1.0.0-rc.1', '2026-10-10'], ['0.6.0', '2026-10-09']]);
});

test('10.3 line ends: CRLF in package.json survives byte for byte; a CRLF changelog is read and rewritten with LF', () => {
  const crlfPkg = read('package.json').replace(/\n/g, '\r\n');
  const dir = H.miniRepo({ pkg: crlfPkg, changelog: read('CHANGELOG.md').replace(/\n/g, '\r\n') });
  assert.equal(bump(['minor', '--root', dir, '--date', '2026-10-10'], quiet()), 0);
  const f = filesOf(dir);
  assert.equal(f.pkg, crlfPkg.replace('"version": "0.6.0"', '"version": "0.7.0"'), 'only the version changed');
  assert.deepEqual(problemsOf(dir), []);
  assert.ok(!f.log.includes('\r'));
});

test('10.4 the real files pass --check from the command line, and a copy with each kind of drift fails with exit 1', () => {
  const res = H.runNode([path.join(ROOT, 'scripts/bump-version.mjs'), '--check']);
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, new RegExp(`version ${pkg.version.replace(/\./g, '\\.')}`));
  const drift = (edit) => { const dir = H.miniRepo(); edit(dir); return H.runNode([path.join(ROOT, 'scripts/bump-version.mjs'), '--check', '--root', dir]); };
  const sub = (dir, file, from, to) => writeFileSync(path.join(dir, file), readFileSync(path.join(dir, file), 'utf8').replace(from, to));
  assert.equal(drift((d) => sub(d, 'package.json', '"version": "0.6.0"', '"version": "0.6.1"')).status, 1);
  assert.equal(drift((d) => sub(d, 'js/build-info.js', "channel: 'dev'", "channel: 'live'")).status, 1);
  assert.equal(drift((d) => sub(d, 'CHANGELOG.md', '## [0.6.0] - 2026-10-09', '## [0.6.0]')).status, 1);
  assert.equal(drift((d) => sub(d, 'js/build-info.js', /version: '0.6.0'/, 'version: "0.6.0"')).status, 1, 'a re-formatted build-info.js is reported, not silently accepted');
  assert.equal(H.runNode([path.join(ROOT, 'scripts/bump-version.mjs'), '--check', '--root', path.join(H.tmpDir(), 'nowhere')]).status, 2);
});

test('VER-REV-7 bump-version writes a blank-padded version into package.json and crashes with a stack trace on a trailing newline', () => {
  // parseVersion trims its input (right for the fetched texts), but bump-version checks only /^v/ and /\+/ before it writes the text it was given.
  const problems = [];
  for (const target of [' 0.7.0', '0.7.0 ', '\t0.7.0', '0.7.0\n']) {
    const dir = H.miniRepo();
    const before = filesOf(dir);
    let code;
    try { code = bump([target, '--root', dir, '--date', '2026-10-10'], quiet()); } catch (err) { code = `throws ${err.name}`; }
    const after = filesOf(dir);
    if (code !== 2) problems.push(`${JSON.stringify(target)} -> ${code}${JSON.stringify(after) !== JSON.stringify(before) ? `, package.json now says ${JSON.stringify(JSON.parse(after.pkg.replace(/\n/g, '')).version ?? null)}` : ''}`);
  }
  assert.deepEqual(problems, [], 'expected exit 2 and nothing changed for each');
});

test('10.5 a package.json whose version line cannot be found is never half-written; a lower-case [unreleased] heading is found like the parser finds it', () => {
  const minified = JSON.stringify(JSON.parse(read('package.json'))); // one line: `"version"` does not start a line, the text replacement finds nothing
  const dir = H.miniRepo({ pkg: minified });
  const before = filesOf(dir);
  let code;
  try { code = bump(['minor', '--root', dir, '--date', '2026-10-10'], quiet()); } catch (err) { code = `throws ${err.message}`; }
  assert.notEqual(code, 0, 'it must not claim success');
  assert.deepEqual(filesOf(dir), before, 'and it must not leave build-info.js and CHANGELOG.md changed while package.json is not');
  // the heading in lower case (parseChangelog reads it case-insensitively, so must the tool)
  const dir2 = H.miniRepo({ changelog: read('CHANGELOG.md').replace('## [Unreleased]', '## [unreleased]') });
  assert.equal(bump(['minor', '--root', dir2, '--date', '2026-10-10'], quiet()), 0);
  const after = filesOf(dir2).log;
  assert.equal((after.match(/^## \[?unreleased\]?\s*$/gim) || []).length, 1, 'exactly one Unreleased heading afterwards');
  assert.deepEqual(problemsOf(dir2), []);
  const entries = V.parseChangelog(after);
  assert.deepEqual(entries.slice(0, 2).map((e) => e.version), ['Unreleased', '0.7.0']);
  assert.ok(entries[1].sections.flatMap((x) => x.items).length >= 1, 'the lines that stood under [unreleased] are under 0.7.0 now');
});

test('VER-REV-10 bump-version says it updated js/build-info.js (exit 0) when the version line of that file is not in the expected form: the three files then disagree', () => {
  // writeBuildInfoVersion is a String.replace that does nothing when `version: '...'` is not found, and run() never looks at the result (writePackageVersion, in
  // contrast, re-parses what it wrote). The tool prints "Made version 0.7.0 ...: package.json, js/build-info.js, CHANGELOG.md", has changed package.json and
  // CHANGELOG.md, and leaves build-info.js at the old version; only a later `--check` notices. A refusal BEFORE anything is written (exit 2) is the other good answer.
  const info = read('js/build-info.js');
  const forms = {
    'double quotes (a formatter)': info.replace("version: '0.6.0'", 'version: "0.6.0"'),
    'a template literal': info.replace("version: '0.6.0'", 'version: `0.6.0`'),
    'a computed value': info.replace("version: '0.6.0'", "version: ['0', '6', '0'].join('.')"),
    'the key quoted': info.replace("version: '0.6.0'", "'version': '0.6.0'"),
  };
  const problems = [];
  for (const [name, text] of Object.entries(forms)) {
    assert.notEqual(text, info, name);
    const dir = H.miniRepo({ buildInfo: text });
    const before = filesOf(dir);
    const out = quiet();
    const code = bump(['minor', '--root', dir, '--date', '2026-10-10'], out);
    const after = filesOf(dir);
    const refusedCleanly = code === 2 && JSON.stringify(after) === JSON.stringify(before);
    const doneAndConsistent = code === 0 && problemsOf(dir).length === 0;
    if (!refusedCleanly && !doneAndConsistent) problems.push(`${name}: exit ${code} "${out.lines[0]}" - build-info.js ${after.info === before.info ? 'unchanged' : 'changed'}, package.json says ${JSON.parse(after.pkg).version}; afterwards: ${problemsOf(dir)[0] || 'consistent'}`);
  }
  assert.deepEqual(problems, [], 'either refuse before writing anything (exit 2) or leave the three files in agreement');
});

test('VER-REV-12 bump-version throws away what stands under [Unreleased] when it has no "-" bullet (prose, a numbered list) and puts the TODO stub in its place, without a word', () => {
  // `content = body.some(isBullet) ? body : ['### Added', STUB_LINE]`: a body without a bullet counts as empty. parseChangelog does not show such text either, so
  // the app and the tool agree - but the tool destroys text a person wrote, and its output ("Made version ...") does not say so. Keeping the lines under the new
  // heading (the changelog test then fails on the entry with no items and the author notices), or refusing with exit 2, are both acceptable.
  const lost = [];
  const bodies = {
    'prose': 'Planners can now copy a whole plant to another browser.\n\nSee the Share window.',
    'a numbered list': '### Added\n1. Copy a plant to another browser.\n2. Pick a start time.',
    'a bullet in unicode': '### Added\n• Copy a plant to another browser.',
    'bullets indented by four spaces': '### Added\n    - Copy a plant to another browser.',
  };
  for (const [name, body] of Object.entries(bodies)) {
    const log = read('CHANGELOG.md').replace(/## \[Unreleased\][\s\S]*?(?=\n## \[0\.6\.0\])/, `## [Unreleased]\n\n${body}\n`);
    assert.ok(log.includes(body), `${name}: the fixture was built`);
    const dir = H.miniRepo({ changelog: log });
    const before = filesOf(dir);
    const out = quiet();
    const code = bump(['minor', '--root', dir, '--date', '2026-10-10'], out);
    const after = filesOf(dir);
    const kept = body.split('\n').filter((l) => l.trim() && !l.startsWith('###')).every((l) => after.log.includes(l));
    const refusedCleanly = code === 2 && JSON.stringify(after) === JSON.stringify(before);
    if (!kept && !refusedCleanly) lost.push(`${name}: exit ${code}, "${body.split('\n').find((l) => l.trim() && !l.startsWith('###'))}" is gone from CHANGELOG.md`);
  }
  assert.deepEqual(lost, [], 'text under [Unreleased] must survive a bump (or the bump must refuse)');
});

test('DISCREPANCY: bumpVersion("1.2.0-rc.1", "minor") is 1.3.0, where npm\'s semver (inc minor) gives 1.2.0', () => {
  // Only matters for a pre-release of a minor or major version, which this project does not use (it stays 0.x). patch IS handled like npm.
  assert.equal(V.bumpVersion('1.2.0-rc.1', 'minor'), '1.3.0');
  assert.equal(V.bumpVersion('2.0.0-rc.1', 'major'), '3.0.0');
  assert.equal(V.bumpVersion('1.2.3-rc.1', 'patch'), '1.2.3');
  assert.equal(V.bumpVersion('banana', 'patch'), null);
  assert.equal(V.bumpVersion('1.2.3', 'huge'), null);
});

// =============================================================================================================================================================
// 11  consistency, layering, golden
// =============================================================================================================================================================

test('11.1 the places that name the version and its rules agree: package.json, build-info.js, CHANGELOG.md, README, ARCHITECTURE, the code\'s constants', () => {
  const log = V.parseChangelog(read('CHANGELOG.md'));
  assert.equal(V.latestRelease(log).version, pkg.version);
  assert.equal(BUILD.version, pkg.version);
  assert.equal(BUILD.repository, V.normalizeRepositoryUrl(pkg.repository));
  // the live-site address in the README is the one GitHub Pages derives from the repository
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(BUILD.repository);
  assert.ok(m);
  assert.ok(read('README.md').includes(`https://${m[1].toLowerCase()}.github.io/${m[2]}/`), 'the README names the Pages address of this repository');
  assert.match(read('LICENSE'), /MIT License/, 'the dialog says "Licence (MIT)" and links to LICENSE');
  assert.equal(pkg.license, 'MIT');
  assert.ok(existsSync(path.join(ROOT, 'CHANGELOG.md')));
  // the numbers the documents quote are the numbers of the code
  const arch = read('docs/ARCHITECTURE.md');
  const section = arch.slice(arch.indexOf('### 6.11'), arch.indexOf('## 7. Visual design'));
  assert.ok(section.includes('every 5 minutes') && CHECK_EVERY_MS === 5 * 60 * 1000, 'ARCHITECTURE: 5 minutes');
  assert.ok(section.includes('10 s timeout') && CHECK_TIMEOUT_MS === 10_000, 'ARCHITECTURE: 10 s');
  assert.ok(section.includes(`${MAX_BODY_CHARS.toLocaleString('en-US')} character cap`), 'ARCHITECTURE: the body cap');
  assert.ok(read('README.md').includes('at most every 5 minutes'));
  // e2e script registered, tests exist
  assert.match(read('tests/e2e/run.mjs'), /about/);
  for (const f of ['version.helpers', 'version.update', 'version.build', 'version.changelog']) assert.ok(existsSync(path.join(ROOT, `tests/${f}.test.js`)), f);
  // the CHANGELOG\'s released dates are real days and not in the future of the repository\'s own history
  for (const e of log.filter((x) => !x.unreleased)) assert.ok(V.parseDay(e.date), e.version);
});

test('11.2 layering: version.js and build-info.js import nothing; update-check.js only those two; nothing below the UI can reach the build identity', () => {
  const imp = (rel) => H.importsOf(read(rel));
  assert.deepEqual(imp('js/version.js'), []);
  assert.deepEqual(imp('js/build-info.js'), []);
  assert.deepEqual(imp('js/update-check.js').sort(), ['./build-info.js', './version.js']);
  const about = imp('js/ui/about.js');
  for (const spec of about) assert.ok(/^(\.\.\/(util\/dom|build-info|update-check|version)\.js|\.\/(icons|ops-styles)\.js)$/.test(spec), `about.js imports ${spec}`);
  const reach = /(?:^|\/)(?:version|build-info|update-check)\.js$|(?:^|\/)ui\/about\.js$/;
  const offenders = [];
  for (const layer of ['util', 'model', 'sim', 'store']) {
    for (const file of H.jsFiles(path.join(ROOT, 'js', layer))) {
      for (const spec of H.importsOf(readFileSync(file, 'utf8'))) if (reach.test(spec)) offenders.push(`${path.relative(ROOT, file)} imports ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], 'the layers below the UI never see the version');
  // who may import the identity: exactly the version UI, the update check and the report footer
  const importers = H.jsFiles(path.join(ROOT, 'js')).filter((f) => H.importsOf(readFileSync(f, 'utf8')).some((s) => /build-info\.js$/.test(s))).map((f) => path.relative(ROOT, f)).sort();
  assert.deepEqual(importers, ['js/ui/about.js', 'js/ui/report.js', 'js/update-check.js']);
  // dialogs.js and app.js use the About dialog; nothing else in the UI does
  const users = H.jsFiles(path.join(ROOT, 'js', 'ui')).filter((f) => H.importsOf(readFileSync(f, 'utf8')).some((s) => /(^|\/)about\.js$/.test(s))).map((f) => path.relative(ROOT, f)).sort();
  assert.deepEqual(users, ['js/ui/app.js', 'js/ui/dialogs.js']);
});

test('11.3 js/version.js, build-info.js and update-check.js are DOM-free and importable from a bare Node process', () => {
  for (const rel of ['js/version.js', 'js/build-info.js']) {
    const code = H.codeOnly(read(rel));
    for (const word of ['document', 'window', 'navigator', 'location', 'localStorage', 'sessionStorage', 'HTMLElement', 'alert', 'requestAnimationFrame', 'fetch']) {
      // a property or option NAME (`window: win`) is not the global
      assert.ok(!new RegExp(`(?<![\\w.$])${word}\\b(?!\\s*:)`).test(code), `${rel} uses ${word}`);
    }
  }
  const watcher = H.codeOnly(read('js/update-check.js'));
  assert.deepEqual([...new Set([...watcher.matchAll(/\b(document|window|navigator|location|localStorage|sessionStorage|HTMLElement)\b/g)].map((m) => m[1]))], ['document'], 'only the injected document (default globalThis.document)');
  assert.ok(/globalThis\.document/.test(watcher));
  const script = ['js/version.js', 'js/build-info.js', 'js/update-check.js'].map((rel) => `await import(${JSON.stringify(path.join(ROOT, rel))});`).join('\n')
    + 'console.log(JSON.stringify([typeof document, typeof window, typeof globalThis.localStorage]));';
  const res = H.runNode(['--input-type=module', '-e', script]);
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout), ['undefined', 'undefined', 'undefined']);
});

test('11.4 exports, the autosave text and share links hold no build identity, and a share link round-trips unchanged', async () => {
  const forbidden = /^(build|commit|builtAt|channel|shortCommit|appVersion|logiplanVersion|buildInfo|BUILD|repository)$/;
  const keysOf = (value, found = []) => {
    if (Array.isArray(value)) value.forEach((v) => keysOf(v, found));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { found.push(k); keysOf(v, found); }
    return found;
  };
  let checked = 0;
  for (const example of EXAMPLES) {
    const store = createStore({ storage: undefined });
    store.newProject(example.build());
    const project = store.getState().project;
    const text = exportProject(project);
    const doc = JSON.parse(text);
    assert.deepEqual(Object.keys(doc), ['app', 'schema', 'name', 'active', 'scenarios'], example.id);
    assert.deepEqual(keysOf(doc).filter((k) => forbidden.test(k)), [], `${example.id}: no build key in the project file`);
    assert.ok(!text.includes(SHA_A) && !text.includes(BUILD.commit === 'dev' ? '"commit"' : BUILD.commit));
    const link = await encodeShare(project);
    assert.ok(/^[zp]\.[A-Za-z0-9_-]+$/.test(link), 'a link is only the payload');
    const back = await decodeShare(link);
    assert.equal(exportProject(back), text, `${example.id}: the link round-trips byte for byte`);
    // the autosave text of the store
    const written = [];
    const saving = createStore({ storage: { getItem: () => null, setItem: (k, v) => written.push(v), removeItem() {} } });
    saving.newProject(example.build());
    saving.persist();
    assert.ok(written.length >= 1);
    assert.deepEqual(keysOf(JSON.parse(written.at(-1))).filter((k) => forbidden.test(k)), [], `${example.id}: no build key in the autosave`);
    checked++;
  }
  assert.ok(checked >= 3);
});

// =============================================================================================================================================================
// 12  the real browser (opt-in)
// =============================================================================================================================================================

test('12.1 real Chromium: the built site with a version.json that never answers, answers junk, or is hostile; a hostile CHANGELOG.md; "Live site" on 127.0.0.1', { skip: H.BROWSER ? false : 'opt-in: VER_REVIEW_BROWSER=1 (needs Playwright; about a minute)', timeout: 300_000 }, async () => {
  const report = await H.runBrowserChecks();
  for (const note of report.notes) console.log(`# known defect seen in the browser: ${note}`);
  assert.deepEqual(report.problems, []);
});

test('VER-REV-9 "Reload now" can bring the same old code back for up to ten minutes (GitHub Pages sends max-age=600 for every file)', { skip: H.BROWSER ? false : 'opt-in: VER_REVIEW_BROWSER=1 (needs Playwright)', timeout: 120_000 }, async () => {
  // A normal reload revalidates the page but takes the modules (js/*.js) from the HTTP cache while they are fresh, so the page that comes back is the old build and
  // the chip still says "Update". The dialog's hint (Ctrl+Shift+R) is the workaround; reloadPage() could refresh the cache itself first: fetch every script the page
  // loaded (performance.getEntriesByType('resource')) with { cache: 'reload' }, then location.reload(). No hashed file names needed.
  const { before, after, runningCommit } = await H.runReloadCacheScenario();
  assert.equal(before.update, true, 'the mark was shown before the reload');
  assert.equal(after.update, false, `after "Reload now" the page runs commit ${runningCommit.slice(0, 7)} and the chip still says ${JSON.stringify(after.text)}`);
  assert.equal(runningCommit, SHA_B);
});

// =============================================================================================================================================================
// 13  the chip and the dialog on the fake DOM
// =============================================================================================================================================================
// A mutation run over the builder's tests and the tests above showed what only the real-browser script (tests/e2e/about.mjs, not part of CI) guarded: that the chip
// starts the watcher at all, that the update box follows it, that the dialog stops listening when it closes, and what "Reload now" does with unsaved work. These tests
// guard it in the fast tier, with the watcher replaced by a recording stand-in.

/** A stand-in for the update watcher that records start() and lets the test publish an answer. */
function standInWatcher() {
  const subscribers = new Set();
  const started = [];
  let state = { available: false, remote: null, checkedAt: null };
  return {
    started,
    subscribers,
    watcher: { state: () => state, subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); }, start: (opts) => started.push(opts) },
    publish(next) { state = next; for (const fn of [...subscribers]) fn(next); },
  };
}
const UPDATE = Object.freeze({ available: true, remote: Object.freeze({ version: '0.7.0', commit: SHA_B, shortCommit: 'b3c4d5e', builtAt: '2026-10-10T08:00:00Z' }), checkedAt: 1 });
const NO_UPDATE = Object.freeze({ available: false, remote: null, checkedAt: 2 });
const SMALL_LOG = '## [0.6.0] - 2026-10-09\n### Added\n- The version is shown in the app.\n';

test('13.1 the chip starts the watcher once, on the document and with the signal of the app; paints the answer as it changes; opens the dialog when clicked', async () => {
  const dom = H.installFakeDom();
  try {
    const stand = standInWatcher();
    const { ctx } = aboutRig();
    let opened = 0;
    ctx.dialogs.openAbout = () => { opened++; };
    const controller = new AbortController();
    const chip = createVersionChip(ctx, { build: LIVE, watcher: stand.watcher, signal: controller.signal });
    assert.equal(stand.started.length, 1, 'start() is called once');
    assert.equal(stand.started[0].document, dom.document, 'on the document');
    assert.equal(stand.started[0].signal, controller.signal, 'with the signal of the app, so that the watcher stops with it');
    assert.equal(chip.el.localName, 'button');
    assert.equal(chip.el.getAttribute('type'), 'button');
    const parts = () => { const [label, id, dot, hint] = chip.el.children; return { label: label.textContent, id: id.textContent, idHidden: id.hidden, dotHidden: dot.hidden, hintHidden: hint.hidden, hint: hint.textContent, marked: chip.el.classList.contains('is-update') }; };
    assert.deepEqual(parts(), { label: 'v0.6.0', id: 'a45ce49', idHidden: false, dotHidden: true, hintHidden: true, hint: 'Update', marked: false }, 'quiet while nothing is new');
    assert.ok(!/update/i.test(chip.el.getAttribute('aria-label')), 'and the spoken name says nothing about an update');
    assert.ok(chip.el.getAttribute('aria-label').startsWith('v0.6.0 a45ce49'), 'it starts with what the eye reads (label in name)');
    assert.match(chip.el.getAttribute('data-tip'), /^Build a45ce49, /);
    stand.publish(UPDATE);
    assert.deepEqual(parts(), { label: 'v0.6.0', id: 'a45ce49', idHidden: false, dotHidden: false, hintHidden: false, hint: 'Update', marked: true }, 'a dot and the word, not colour alone');
    assert.match(chip.el.getAttribute('aria-label'), /An update is available/);
    assert.match(chip.el.getAttribute('data-tip'), /^Update available \(v0\.7\.0\)/);
    stand.publish(NO_UPDATE);
    assert.deepEqual(parts(), { label: 'v0.6.0', id: 'a45ce49', idHidden: false, dotHidden: true, hintHidden: true, hint: 'Update', marked: false }, 'withdrawn when the site says so');
    assert.ok(!/update/i.test(chip.el.getAttribute('aria-label')));
    await chip.el.click();
    assert.equal(opened, 1, 'a click opens the About dialog');

    // a development copy: the plain label, and a watcher that can never ask
    const dev = createVersionChip(aboutRig().ctx, { build: DEV });
    assert.equal(dev.el.children[0].textContent, 'v0.6.0 dev');
    assert.equal(dev.el.children[1].hidden, true, 'a development copy has no build id to show');
    assert.equal(dev.watcher.enabled, false);
    assert.match(dev.el.getAttribute('data-tip'), /^Development build, not deployed/);
  } finally {
    dom.restore();
  }
});

test('13.2 the update box follows the watcher while the dialog is open, is empty without an update, and stops listening when the dialog closes', async () => {
  const dom = H.installFakeDom();
  try {
    const fetchFn = async () => okResponse(SMALL_LOG); // given to every opening: a dialog that re-reads the list (VER-REV-8) must not reach for the real fetch
    await loadChangelog({ fetchFn, force: true });
    const stand = standInWatcher();
    const { ctx, dlg, shown } = aboutRig();
    createVersionChip(ctx, { build: LIVE, watcher: stand.watcher }); // registers the watcher for this ctx; the chip itself listens too
    const chipListeners = stand.subscribers.size;
    assert.equal(chipListeners, 1);
    openAbout(ctx, dlg, { build: LIVE, fetchFn });
    await settle();
    const { body, onClose } = shown[0];
    const box = () => body.querySelector('.about__update');
    const reloadButtons = () => dom.elements(box()).filter((e) => e.localName === 'button' && /Reload now/.test(e.textContent));
    assert.equal(stand.subscribers.size, chipListeners + 1, 'the dialog listens while it is open');
    assert.equal(box().textContent, '', 'no update: the box is empty');
    assert.equal(reloadButtons().length, 0);
    stand.publish(UPDATE);
    assert.match(box().textContent, /A newer version is available/);
    assert.match(box().textContent, /Version 0\.7\.0 \(build b3c4d5e\) is on the site; this page is version 0\.6\.0/);
    assert.equal(reloadButtons().length, 1, 'with the one button');
    assert.equal(box().getAttribute('aria-live'), 'polite', 'announced politely, never as an alert');
    stand.publish(NO_UPDATE);
    assert.equal(box().textContent, '', 'withdrawn while the dialog is open');
    stand.publish(UPDATE);
    assert.equal(reloadButtons().length, 1);
    onClose();
    assert.equal(stand.subscribers.size, chipListeners, 'closing the dialog removes its listener (no leak per opening)');
    stand.publish(NO_UPDATE);
    assert.match(box().textContent, /A newer version is available/, 'and the closed dialog is left alone');

    // opened while an update is already waiting: the box is there from the start
    stand.publish(UPDATE);
    openAbout(ctx, dlg, { build: LIVE, fetchFn });
    await settle();
    assert.match(shown[1].body.querySelector('.about__update').textContent, /A newer version is available/);
    shown[1].onClose();
    for (let i = 0; i < 5; i++) { openAbout(ctx, dlg, { build: LIVE, fetchFn }); shown.at(-1).onClose(); }
    await settle(); // the lists of the openings arrive while the fake DOM is still installed
    assert.equal(stand.subscribers.size, chipListeners + 0, 'six openings and closings leave one listener (the chip\'s)');
  } finally {
    dom.restore();
  }
});

test('13.3 "Reload now" saves first and reloads once; a failed save with unsaved work is refused with a message; a failed save with nothing to lose still reloads', async () => {
  const cases = [
    ['the save works', { persist: () => true, dirty: true }, ['persist', 'reload'], 0],
    ['the save fails, nothing is unsaved', { persist: () => false, dirty: false }, ['persist', 'reload'], 0],
    ['the save fails, there is unsaved work', { persist: () => false, dirty: true }, ['persist'], 1],
    ['the store has no persist()', { persist: undefined, dirty: true }, ['reload'], 0],
  ];
  for (const [name, { persist, dirty }, expectedEvents, warnings] of cases) {
    const dom = H.installFakeDom();
    try {
      const fetchFn = async () => okResponse(SMALL_LOG);
      await loadChangelog({ fetchFn, force: true });
      const events = [];
      const stand = standInWatcher();
      const { ctx, dlg, shown, toasts } = aboutRig();
      ctx.store = { getState: () => ({ dirty }), ...(persist ? { persist: () => { events.push('persist'); return persist(); } } : {}) };
      dom.location.reload = () => { events.push('reload'); };
      createVersionChip(ctx, { build: LIVE, watcher: stand.watcher });
      stand.publish(UPDATE);
      openAbout(ctx, dlg, { build: LIVE, fetchFn });
      await settle();
      const button = dom.elements(shown[0].body).find((e) => e.localName === 'button' && /Reload now/.test(e.textContent));
      assert.ok(button, `${name}: the button is there`);
      const seen = await unhandledDuring(async () => { await button.click(); });
      assert.deepEqual(seen, [], name);
      await settle();
      assert.deepEqual(events, expectedEvents, name);
      const warned = toasts.filter((t) => t[1] && t[1].kind === 'warn');
      assert.equal(warned.length, warnings, name);
      if (warnings) assert.match(warned[0][0], /could not be saved.*Download the project file/, 'it says what to do instead');
    } finally {
      dom.restore();
    }
  }
});

test('13.4 the list of changes marks the version the planner runs and the newer ones, and starts with the latest changes and the newest release open; the headings toggle', () => {
  const dom = H.installFakeDom();
  try {
    const entries = V.parseChangelog('## [Unreleased]\n### Added\n- soon\n\n## [0.7.0] - 2026-10-12\n### Added\n- seven\n\n## [0.6.0] - 2026-10-09\n### Added\n- six\n\n## [0.5.0] - 2026-10-01\n### Added\n- five\n');
    const list = renderChangelog(entries, { currentVersion: '0.6.0' });
    const rows = list.children.map((entry) => { const toggle = entry.children[0].children[0]; assert.equal(entry.children[0].localName, 'h4', 'each version button sits in a heading'); return { text: toggle.textContent, open: toggle.getAttribute('aria-expanded'), hidden: entry.children[1].hidden, toggle, body: entry.children[1] }; });
    assert.equal(rows.length, 4);
    assert.match(rows[0].text, /^Latest changesnot in a numbered version yet$/, 'no mark on the unreleased changes');
    assert.match(rows[1].text, /^Version 0\.7\.012 October 2026Newer than yours$/);
    assert.match(rows[2].text, /^Version 0\.6\.09 October 2026Your version$/);
    assert.match(rows[3].text, /^Version 0\.5\.01 October 2026$/, 'no mark on an older version');
    assert.deepEqual(rows.map((r) => r.open), ['true', 'true', 'false', 'false'], 'the latest changes and the newest release start open');
    assert.deepEqual(rows.map((r) => r.hidden), [false, false, true, true]);
    rows[2].toggle.click();
    assert.equal(rows[2].toggle.getAttribute('aria-expanded'), 'true');
    assert.equal(rows[2].body.hidden, false, 'a click opens it');
    rows[2].toggle.click();
    assert.equal(rows[2].body.hidden, true, 'and closes it again');
    assert.equal(rows[2].toggle.getAttribute('aria-controls'), rows[2].body.id, 'the button names the region it controls');
    assert.equal(new Set(rows.map((r) => r.body.id)).size, 4, 'ids are unique');
    // nothing released yet: the first entry is open whatever it is
    assert.deepEqual([...openByDefault([{ unreleased: true, sections: [] }])], [0]);
  } finally {
    dom.restore();
  }
});

test('13.5 a list of changes that could not be loaded offers "Try again", and the second try shows the list', async () => {
  const dom = H.installFakeDom();
  try {
    await loadChangelog({ fetchFn: async () => { throw new TypeError('offline'); }, force: true }).catch(() => {}); // forget any list read before
    let calls = 0;
    const fetchFn = async () => { calls++; if (calls === 1) throw new TypeError('offline'); return okResponse(SMALL_LOG); };
    const { ctx, dlg, shown } = aboutRig();
    openAbout(ctx, dlg, { build: DEV, fetchFn });
    await settle();
    const news = shown[0].body.querySelector('[data-role="about-news"]');
    assert.match(news.textContent, /offline/i);
    const retry = dom.elements(news).find((e) => e.localName === 'button' && /Try again/.test(e.textContent));
    assert.ok(retry, 'a button that asks again');
    assert.equal(calls, 1);
    await retry.click();
    await settle();
    assert.equal(calls, 2, 'the second try asks again (a failure is not remembered)');
    assert.match(news.textContent, /Version 0\.6\.0/);
    assert.ok(!/Try again/.test(news.textContent), 'and the message is gone');
  } finally {
    dom.restore();
  }
});

test('13.6 a list of changes that never answers is given up after ten seconds and says so: the dialog is not stuck on "Loading"', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let aborted = false;
    const hang = (url, options) => new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('aborted', 'AbortError')); }); });
    const outcome = loadChangelog({ fetchFn: hang, force: true }).then(() => 'resolved', (err) => err.message);
    await Promise.resolve();
    mock.timers.tick(9_999);
    assert.equal(aborted, false, 'still waiting at 9.999 s');
    mock.timers.tick(1);
    const message = await outcome;
    assert.equal(aborted, true, 'the request was aborted at 10 s');
    assert.match(message, /could not be loaded.*offline/i);
  } finally {
    mock.timers.reset();
  }
});

test('13.7 the timeout of a request is always cleared: a good, a failed, a refused and a junk answer leave no timer behind', async () => {
  for (const answer of [okResponse(NEWER_BODY), () => { throw new Error('offline'); }, { ok: false, status: 404 }, okResponse('junk'), okResponse('{"commit":"x"}')]) {
    const { watcher, timers } = rig([answer]);
    await watcher.check({ force: true });
    assert.equal(timers.length, 1, 'one timeout was armed for the request');
    assert.deepEqual(timers.map((t) => t.live), [false], 'and cleared');
  }
});

test('VER-REV-13 the update box says "A newer version is available" and then "Version 0.6.0 is on the site; this page is version 0.6.0" when only the build differs (every merge to main between two releases)', async () => {
  // The common case: main moves on without a release, so the site serves another commit of the SAME version number. The answer is right (there is something new to load,
  // the list of changes calls it "Latest changes") but the headline talks about a newer version and the next sentence gives two equal version numbers.
  // "A newer build is available" / "LogiPlan was updated", with the build names, would be true.
  const dom = H.installFakeDom();
  try {
    const fetchFn = async () => okResponse(SMALL_LOG);
    await loadChangelog({ fetchFn, force: true });
    const stand = standInWatcher();
    const { ctx, dlg, shown } = aboutRig();
    createVersionChip(ctx, { build: LIVE, watcher: stand.watcher });
    stand.publish({ available: true, remote: { version: '0.6.0', commit: SHA_B, shortCommit: 'b3c4d5e', builtAt: '2026-10-10T08:00:00Z' }, checkedAt: 1 });
    openAbout(ctx, dlg, { build: LIVE, fetchFn });
    await settle();
    const text = shown[0].body.querySelector('.about__update').textContent;
    assert.match(text, /b3c4d5e/, 'the box names the build that is on the site');
    assert.doesNotMatch(text, /newer version/i, `the version number did not change, but the box says: ${text.slice(0, 170)}`);
  } finally {
    dom.restore();
  }
});
