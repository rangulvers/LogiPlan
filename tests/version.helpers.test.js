// js/version.js: version numbers, build dates, the changelog parser, the update decision and the texts of the chip and the bug report line.
// Pure functions, no DOM. Everything that comes from outside (a fetched version.json, the text of CHANGELOG.md) is attacked here with junk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVersion, compareVersions, isNewer, bumpVersion, isCommitId, shortCommit, normalizeBuild, isReleaseBuild, normalizeRepositoryUrl, commitUrl,
  versionLabel, buildSummary, whereItRuns, formatBuildDate, parseDay, formatDay, parseChangelog, latestRelease, parseInline, readRemoteBuild, sameCommit,
  updateVerdict, chipTooltip, chipAriaLabel, chipBuildId, chipText, updateNotice, hostName, browserName, bugReportLine, CHANGELOG_LIMITS, MAX_TEXT,
} from '../js/version.js';

const SHA = 'a45ce493dfd9ca7440743e6931042fca39642504';
const NEWER_SHA = 'b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6';
const LIVE = { version: '0.6.0', commit: SHA, shortCommit: 'a45ce49', builtAt: '2026-10-09T15:08:00Z', channel: 'live', repository: 'https://github.com/rangulvers/LogiPlan' };
const DEV = { version: '0.6.0', commit: 'dev', shortCommit: 'dev', builtAt: null, channel: 'dev', repository: 'https://github.com/rangulvers/LogiPlan' };

// ---- versions -------------------------------------------------------------------------------------------------------

test('parseVersion reads x.y.z, a leading v, a pre-release and build metadata, and nothing else', () => {
  assert.deepEqual(parseVersion('0.6.0'), { major: 0, minor: 6, patch: 0, pre: [] });
  assert.deepEqual(parseVersion('v1.20.300'), { major: 1, minor: 20, patch: 300, pre: [] });
  assert.deepEqual(parseVersion(' 1.0.0-beta.2+build.5 '), { major: 1, minor: 0, patch: 0, pre: ['beta', '2'] });
  for (const bad of ['', '1', '1.2', '1.2.3.4', '01.2.3', '1.02.3', 'a.b.c', '1.2.x', '1.2.3-', '1.2.3-a..b', '1.2.3 beta', '-1.0.0', '1e3.0.0', '9999999999.0.0', 'latest', 'dev', 'NaN.0.0']) {
    assert.equal(parseVersion(bad), null, JSON.stringify(bad));
  }
  for (const wrong of [undefined, null, 6, {}, [], ['1.2.3'], true, () => '1.2.3', Symbol('x'), 1n]) assert.equal(parseVersion(wrong), null, String(typeof wrong));
  assert.equal(parseVersion(`1.0.0-${'a'.repeat(MAX_TEXT)}`), null, 'a huge version is junk');
});

test('compareVersions follows semantic versioning', () => {
  const ascending = ['0.0.1', '0.1.0', '0.1.1', '0.2.0', '0.6.0', '0.10.0', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0', '10.0.0'];
  for (let i = 0; i < ascending.length; i++) {
    for (let j = 0; j < ascending.length; j++) assert.equal(compareVersions(ascending[i], ascending[j]), Math.sign(i - j), `${ascending[i]} vs ${ascending[j]}`);
  }
  assert.equal(compareVersions('v0.6.0', '0.6.0'), 0, 'a leading v does not count');
  assert.equal(compareVersions('1.0.0+a', '1.0.0+b'), 0, 'build metadata does not count');
  assert.equal(compareVersions('1.0.0-01', '1.0.0-1'), 0, 'numeric identifiers compare as numbers');
  assert.equal(compareVersions('1.0.0-alpha.9', '1.0.0-alpha.10'), -1, 'numbers are not compared as text');
  assert.equal(compareVersions('0.6.0', '0.10.0'), -1, 'minor 6 is older than minor 10');
});

test('text that is no version sorts before every version, and sorting with it is stable', () => {
  assert.equal(compareVersions('junk', '0.0.1'), -1);
  assert.equal(compareVersions('0.0.1', undefined), 1);
  assert.equal(compareVersions('junk', 'other junk'), 0);
  assert.equal(compareVersions(null, undefined), 0);
  const sorted = ['1.0.0', 'junk', '0.9.0', null, '2.0.0', '0.10.0'].sort(compareVersions);
  assert.deepEqual(sorted.filter(Boolean), ['junk', '0.9.0', '0.10.0', '1.0.0', '2.0.0']);
});

test('isNewer is false for anything that is no version', () => {
  assert.equal(isNewer('0.7.0', '0.6.0'), true);
  assert.equal(isNewer('0.6.0', '0.6.0'), false);
  assert.equal(isNewer('0.5.9', '0.6.0'), false);
  assert.equal(isNewer('1.0.0', '1.0.0-rc.1'), true);
  assert.equal(isNewer('junk', '0.6.0'), false);
  assert.equal(isNewer(undefined, '0.6.0'), false);
  assert.equal(isNewer({ toString: () => '9.9.9' }, '0.6.0'), false, 'an object is not a version text');
  assert.equal(isNewer('0.6.0', 'junk'), true, 'a version is newer than junk');
});

test('bumpVersion computes the next patch, minor and major version', () => {
  assert.equal(bumpVersion('0.6.0', 'patch'), '0.6.1');
  assert.equal(bumpVersion('0.6.3', 'minor'), '0.7.0');
  assert.equal(bumpVersion('0.6.3', 'major'), '1.0.0');
  assert.equal(bumpVersion('1.2.3-beta.1', 'patch'), '1.2.3', 'the release of a pre-release');
  assert.equal(bumpVersion('junk', 'patch'), null);
  assert.equal(bumpVersion('0.6.0', 'huge'), null);
});

// ---- the identity of a build ----------------------------------------------------------------------------------------

test('commit ids: 7 to 64 hex characters; the short form is 7 lower-case characters', () => {
  assert.equal(isCommitId(SHA), true);
  assert.equal(isCommitId('A45CE49'), true);
  for (const bad of ['a45ce4', 'a45ce49g', 'dev', 'local', '', ' a45ce49', `${SHA}${SHA}a`, null, 4545454, {}]) assert.equal(isCommitId(bad), false, String(bad));
  assert.equal(shortCommit(SHA.toUpperCase()), 'a45ce49');
  assert.equal(shortCommit('dev'), 'dev');
  assert.equal(shortCommit('local'), 'local');
  assert.equal(shortCommit('<script>'), '');
  assert.equal(shortCommit(undefined), '');
});

test('normalizeBuild makes any input safe and falls back to the development values', () => {
  assert.deepEqual(normalizeBuild(LIVE), { ...LIVE });
  assert.deepEqual(normalizeBuild(DEV), { ...DEV });
  const junk = normalizeBuild({ version: '<img>', commit: '"; alert(1)', builtAt: 'yesterday', channel: 'prod', repository: 'javascript:alert(1)', shortCommit: 'zzz' });
  assert.deepEqual(junk, { version: '0.0.0', commit: 'dev', shortCommit: 'dev', builtAt: null, channel: 'dev', repository: null });
  for (const wrong of [undefined, null, 'v1', 7, [], () => 1]) assert.equal(normalizeBuild(wrong).commit, 'dev');
  assert.equal(normalizeBuild({ ...LIVE, channel: undefined }).channel, 'live', 'a commit without a channel is a deployed build');
  assert.equal(normalizeBuild({ ...LIVE, commit: 'local', channel: undefined }).channel, 'local');
  assert.equal(normalizeBuild({ ...LIVE, commit: 'dev', channel: 'live' }).channel, 'dev', 'a build without a commit cannot call itself live');
  assert.equal(normalizeBuild({ ...LIVE, channel: 'dev' }).channel, 'dev', 'a real commit that says dev is believed');
  assert.equal(normalizeBuild({ ...LIVE, version: 'v0.7.1' }).version, '0.7.1', 'a leading v is dropped');
  assert.equal(Object.getPrototypeOf(normalizeBuild(LIVE)), Object.prototype);
});

test('only a deployed build with a real commit compares itself with the site', () => {
  assert.equal(isReleaseBuild(LIVE), true);
  assert.equal(isReleaseBuild(DEV), false);
  assert.equal(isReleaseBuild({ ...LIVE, commit: 'local', channel: 'local' }), false);
  assert.equal(isReleaseBuild({ ...LIVE, commit: 'dev' }), false);
  assert.equal(isReleaseBuild({ ...LIVE, channel: 'dev' }), false);
  assert.equal(isReleaseBuild(undefined), false);
});

test('repository and commit links: https GitHub only, built from validated parts', () => {
  assert.equal(normalizeRepositoryUrl('https://github.com/rangulvers/LogiPlan'), 'https://github.com/rangulvers/LogiPlan');
  assert.equal(normalizeRepositoryUrl('git+https://github.com/rangulvers/LogiPlan.git'), 'https://github.com/rangulvers/LogiPlan');
  assert.equal(normalizeRepositoryUrl({ type: 'git', url: 'https://github.com/rangulvers/LogiPlan.git' }), 'https://github.com/rangulvers/LogiPlan');
  assert.equal(normalizeRepositoryUrl('https://GitHub.com/a/b/'), 'https://github.com/a/b');
  for (const bad of ['http://github.com/a/b', 'javascript:alert(1)', 'https://github.com/a', 'https://github.com/a/b/c', 'https://github.com/../b', 'https://evil.com/a/b" onclick="x', '', null, 5, {}, [], 'https://github.com/a/b?x=1', `https://github.com/${'a'.repeat(300)}/b`]) {
    assert.equal(normalizeRepositoryUrl(bad), null, JSON.stringify(bad));
  }
  assert.equal(commitUrl('https://github.com/rangulvers/LogiPlan', SHA), `https://github.com/rangulvers/LogiPlan/commit/${SHA}`);
  assert.equal(commitUrl('https://github.com/rangulvers/LogiPlan', 'dev'), null, 'no commit page for a development build');
  assert.equal(commitUrl('https://github.com/rangulvers/LogiPlan', 'a45ce49/../../x'), null);
  assert.equal(commitUrl('https://gitlab.com/a/b', SHA), null, 'the link format is GitHub\'s');
  assert.equal(commitUrl(null, SHA), null);
});

test('the texts of the chip, the report footer and "where it runs"', () => {
  assert.equal(versionLabel(LIVE), 'v0.6.0');
  assert.equal(versionLabel(DEV), 'v0.6.0 dev');
  assert.equal(versionLabel({ ...LIVE, commit: 'local', channel: 'local' }), 'v0.6.0 local');
  assert.equal(versionLabel(undefined), 'v0.0.0 dev');
  assert.equal(buildSummary(LIVE), 'v0.6.0 (a45ce49)');
  assert.equal(buildSummary(DEV), 'v0.6.0 (development build)');
  assert.equal(buildSummary({ ...LIVE, commit: 'local', channel: 'local' }), 'v0.6.0 (local build)');
  assert.equal(whereItRuns(LIVE, 'rangulvers.github.io'), 'Live site');
  assert.equal(whereItRuns(LIVE, 'localhost'), 'Built site on this computer');
  assert.equal(whereItRuns(LIVE, '127.0.0.1'), 'Built site on this computer');
  assert.equal(whereItRuns(LIVE, 'laptop.local'), 'Built site on this computer');
  assert.equal(whereItRuns(DEV, 'rangulvers.github.io'), 'Local development');
  assert.equal(whereItRuns({ ...LIVE, commit: 'local', channel: 'local' }, 'example.org'), 'Built site on this computer');
  assert.equal(whereItRuns(LIVE), 'Live site');
});

// ---- dates ----------------------------------------------------------------------------------------------------------

test('formatBuildDate shows the moment in the viewer\'s zone and in UTC', () => {
  const berlin = formatBuildDate('2026-10-09T15:08:00Z', { timeZone: 'Europe/Berlin' });
  assert.equal(berlin.day, '9 Oct 2026');
  assert.equal(berlin.local, '9 Oct 2026, 17:08 CEST');
  assert.equal(berlin.utc, '2026-10-09 15:08 UTC');
  assert.equal(berlin.zone, 'CEST');
  const winter = formatBuildDate('2026-12-31T23:30:00Z', { timeZone: 'Europe/Berlin' });
  assert.equal(winter.day, '1 Jan 2027', 'the local day is the next one');
  assert.match(winter.local, /^1 Jan 2027, 00:30 /);
  assert.equal(winter.utc, '2026-12-31 23:30 UTC');
  assert.equal(formatBuildDate('2026-10-09T17:08:00+02:00', { timeZone: 'UTC' }).utc, '2026-10-09 15:08 UTC', 'an offset is converted');
  assert.equal(formatBuildDate('2026-10-09T15:08:00.123Z', { timeZone: 'UTC' }).local, '9 Oct 2026, 15:08 UTC');
  assert.equal(formatBuildDate('2026-10-09T15:08Z', { timeZone: 'UTC' }).utc, '2026-10-09 15:08 UTC');
  const fallback = formatBuildDate('2026-10-09T15:08:00Z', { timeZone: 'Not/AZone' });
  assert.equal(fallback.utc, '2026-10-09 15:08 UTC', 'an unknown zone name falls back to the viewer\'s own');
  assert.ok(fallback.local.startsWith('9 Oct 2026, ') || fallback.local.startsWith('10 Oct 2026, '));
});

test('formatBuildDate refuses everything that is not a precise ISO moment', () => {
  for (const bad of ['', 'yesterday', '2026-10-09', '2026-10-09T15:08:00', '2026-13-09T15:08:00Z', '2026-02-30T15:08:00Z', '2026-10-09T25:08:00Z', '1999-12-31T23:59:00Z', '2300-01-01T00:00:00Z',
    '+275760-09-13T00:00:00.000Z', `2026-10-09T15:08:00Z${' '.repeat(100)}`, 'Fri, 09 Oct 2026 15:08:00 GMT', 1791558480000, null, undefined, {}, new Date(), []]) {
    assert.equal(formatBuildDate(bad), null, String(bad));
  }
});

test('parseDay and formatDay only accept real calendar days', () => {
  assert.equal(formatDay('2026-10-09'), '9 October 2026');
  assert.equal(formatDay(' 2024-02-29 '), '29 February 2024');
  assert.equal(parseDay('2026-10-09').toISOString(), '2026-10-09T00:00:00.000Z');
  for (const bad of ['2026-02-29', '2026-00-10', '2026-10-32', '2026-1-9', '09.10.2026', '', 'x', null, 20261009, '1999-12-31', '2200-01-01']) {
    assert.equal(parseDay(bad), null, String(bad));
    assert.equal(formatDay(bad), '', String(bad));
  }
});

// ---- the changelog --------------------------------------------------------------------------------------------------

const SAMPLE = `# Changelog

Some words about this file.

## [Unreleased]

### Added
- A new thing that is not released yet.

## [0.2.0] - 2026-10-08

### Added
- **Big** feature with a long line
  that goes on over two lines.
* Second item with a star
### Fixed
- A fix

## [0.1.0] - 2026-10-07
### Added
- First
`;

test('parseChangelog reads entries, dates, sections and items, newest first as in the file', () => {
  const entries = parseChangelog(SAMPLE);
  assert.deepEqual(entries.map((e) => [e.version, e.date, e.unreleased]), [['Unreleased', null, true], ['0.2.0', '2026-10-08', false], ['0.1.0', '2026-10-07', false]]);
  assert.deepEqual(entries[0].sections, [{ title: 'Added', items: ['A new thing that is not released yet.'] }]);
  assert.deepEqual(entries[1].sections, [
    { title: 'Added', items: ['**Big** feature with a long line that goes on over two lines.', 'Second item with a star'] },
    { title: 'Fixed', items: ['A fix'] },
  ]);
  assert.equal(latestRelease(entries).version, '0.2.0');
  assert.equal(latestRelease(parseChangelog('## [Unreleased]\n- x')), null);
});

test('parseChangelog accepts the common spellings of a heading', () => {
  const entries = parseChangelog('## 1.2.3 - 2026-01-02\n- a\n## [v1.2.2]\n- b\n## [1.2.1] – 2026-01-01 [YANKED]\n- c\n## [UNRELEASED]\n- d\n## [1.2.0]-2025-12-31\n- e');
  assert.deepEqual(entries.map((e) => [e.version, e.date]), [['1.2.3', '2026-01-02'], ['1.2.2', null], ['1.2.1', '2026-01-01'], ['Unreleased', null], ['1.2.0', '2025-12-31']]);
  assert.equal(entries[0].sections[0].title, 'Changes', 'items without a heading go to one called Changes');
});

test('parseChangelog ignores junk and drops what it cannot use: bad headings, bad dates, empty sections, text between entries', () => {
  const entries = parseChangelog(`
## [banana] - 2026-10-08
### Added
- belongs to nothing
## [0.3.0] - 2026-02-31
### Added
### Fixed
- real
Text between things.
#### too deep
- also real, still in Fixed
## Footnotes
- not an entry
## [0.2.0] - 2026-10-08
`);
  assert.deepEqual(entries.map((e) => [e.version, e.date]), [['0.3.0', null], ['0.2.0', '2026-10-08']], 'an impossible date is dropped, the entry stays');
  assert.deepEqual(entries[0].sections, [{ title: 'Fixed', items: ['real', 'also real, still in Fixed'] }], 'the empty section Added is gone');
  assert.deepEqual(entries[1].sections, []);
});

test('parseChangelog never throws and caps what it keeps', () => {
  for (const wrong of [undefined, null, 5, {}, [], () => '', Symbol('x'), 1n, new String('## [1.0.0]')]) assert.deepEqual(parseChangelog(wrong), [], String(typeof wrong));
  assert.deepEqual(parseChangelog(''), []);
  assert.deepEqual(parseChangelog('\0\0## ‮[1.0.0]\r\n\r\n- \uD800 lone surrogate'), []);
  const L = CHANGELOG_LIMITS;
  const many = parseChangelog(Array.from({ length: L.entries + 50 }, (_, i) => `## [1.0.${i}] - 2026-01-01\n- x`).join('\n'));
  assert.equal(many.length, L.entries);
  const items = parseChangelog(`## [1.0.0]\n### Added\n${Array.from({ length: L.items + 50 }, () => '- x').join('\n')}`);
  assert.equal(items[0].sections[0].items.length, L.items);
  const long = parseChangelog(`## [1.0.0]\n### Added\n- ${'y'.repeat(L.item * 3)}`);
  assert.equal(long[0].sections[0].items[0].length, L.item);
  const sections = parseChangelog(`## [1.0.0]\n${Array.from({ length: L.sections + 20 }, (_, i) => `### S${i}\n- x`).join('\n')}`);
  assert.equal(sections[0].sections.length, L.sections);
  const t0 = performance.now();
  parseChangelog(`## [1.0.0]\n${'- x\n  continued '.repeat(100000)}`);
  parseChangelog('#'.repeat(1_000_000));
  assert.ok(performance.now() - t0 < 1500, 'a huge file is cut off, not parsed for ever');
  assert.deepEqual(parseChangelog('## [1.0.0]\n### <script>alert(1)</script>\n- <img src=x onerror=alert(1)>')[0].sections[0].items, ['<img src=x onerror=alert(1)>'], 'text stays text (the UI sets textContent)');
});

test('parseInline keeps **bold**, *italic* and `code` and leaves everything else as text', () => {
  assert.deepEqual(parseInline('**Add dock doors** on a *Goods out*, see `x`.'), [
    { type: 'strong', text: 'Add dock doors' }, { type: 'text', text: ' on a ' }, { type: 'em', text: 'Goods out' }, { type: 'text', text: ', see ' }, { type: 'code', text: 'x' }, { type: 'text', text: '.' },
  ]);
  assert.deepEqual(parseInline('3 * 4 = 12 and 5*'), [{ type: 'text', text: '3 * 4 = 12 and 5*' }], 'a lone star is not italic');
  assert.deepEqual(parseInline('<b>x</b> [a](http://x)'), [{ type: 'text', text: '<b>x</b> [a](http://x)' }], 'no markup, no links');
  assert.deepEqual(parseInline(''), []);
  assert.deepEqual(parseInline(42), []);
  assert.deepEqual(parseInline('**unclosed'), [{ type: 'text', text: '**unclosed' }]);
});

// ---- is a newer version live? ---------------------------------------------------------------------------------------

/** A label for a failure message that never throws, whatever `value` is (a Proxy that throws, a symbol ...). */
function describe(value) {
  try {
    return typeof value === 'symbol' || typeof value === 'bigint' || typeof value === 'function' ? typeof value : String(JSON.stringify(value)).slice(0, 80);
  } catch {
    return 'an object that throws';
  }
}

const remote = (over = {}) => ({ name: 'logiplan', version: '0.6.0', commit: NEWER_SHA, shortCommit: 'b3c4d5e', builtAt: '2026-10-10T08:00:00Z', channel: 'live', builtFrom: 'main', ...over });

test('updateVerdict: a different commit with the same or a newer version is an update', () => {
  const same = updateVerdict(LIVE, remote());
  assert.equal(same.available, true);
  assert.equal(same.reason, 'newer');
  assert.deepEqual(same.remote, { version: '0.6.0', commit: NEWER_SHA, shortCommit: 'b3c4d5e', builtAt: '2026-10-10T08:00:00Z' });
  assert.equal(updateVerdict(LIVE, remote({ version: '0.7.0' })).available, true);
  assert.equal(updateVerdict(LIVE, remote({ version: '1.0.0' })).remote.version, '1.0.0');
  assert.equal(updateVerdict(LIVE, remote({ commit: NEWER_SHA.toUpperCase() })).remote.commit, NEWER_SHA, 'the commit is lower-cased');
});

test('updateVerdict: the same commit, an older version, a development build and a junk answer are all silent', () => {
  assert.deepEqual(updateVerdict(LIVE, remote({ commit: SHA })), { available: false, reason: 'same', remote: null });
  assert.equal(updateVerdict(LIVE, remote({ commit: SHA.slice(0, 7) })).reason, 'same', 'a short id of the same commit');
  assert.equal(updateVerdict(LIVE, remote({ commit: SHA.toUpperCase() })).reason, 'same');
  assert.equal(updateVerdict(LIVE, remote({ version: '0.5.0' })).reason, 'older', 'a cache that serves an older site is not an update');
  assert.equal(updateVerdict(DEV, remote()).reason, 'not-deployed');
  assert.equal(updateVerdict({ ...LIVE, commit: 'local', channel: 'local' }, remote()).reason, 'not-deployed');
  assert.equal(updateVerdict(undefined, remote()).available, false);
  assert.equal(updateVerdict(LIVE, undefined).reason, 'unreadable');
});

test('updateVerdict survives hostile version.json content', () => {
  const huge = 'f'.repeat(1_000_000);
  const hostile = [
    undefined, null, 0, 1, '', 'string', true, [], [remote()], () => remote(), Symbol('s'), 10n, new Date(), /x/, new Map(), {},
    { commit: NEWER_SHA }, { version: '0.7.0' }, { commit: 5, version: '0.7.0' }, { commit: NEWER_SHA, version: 7 }, { commit: [NEWER_SHA], version: '0.7.0' }, { commit: { toString: () => NEWER_SHA }, version: '0.7.0' },
    { commit: NEWER_SHA, version: { toString: () => '0.7.0' } }, { commit: 'not hex at all', version: '0.7.0' }, { commit: 'dev', version: '0.7.0' }, { commit: 'local', version: '0.7.0' },
    { commit: huge, version: '0.7.0' }, { commit: NEWER_SHA, version: `0.7.${'0'.repeat(10000)}` }, { commit: NEWER_SHA, version: 'x'.repeat(1_000_000) }, { commit: NEWER_SHA, version: '0.7' },
    { commit: `${NEWER_SHA}<script>`, version: '0.7.0' }, { commit: NEWER_SHA, version: '0.7.0<img>' }, { commit: ' ' + NEWER_SHA, version: '0.7.0' }, { commit: NEWER_SHA + '\n', version: '0.7.0' },
    Object.create(remote()), Object.create({ commit: NEWER_SHA, version: '0.7.0' }), Object.assign(Object.create(null), { commit: 'zz', version: '0.7.0' }),
    new Proxy({}, { get() { throw new Error('boom'); }, has() { throw new Error('boom'); }, getOwnPropertyDescriptor() { throw new Error('boom'); } }),
  ];
  for (const bad of hostile) {
    const verdict = updateVerdict(LIVE, bad);
    assert.equal(verdict.available, false, describe(bad));
    assert.equal(verdict.remote, null);
  }
});

test('updateVerdict does not read prototype keys and is not fooled by __proto__ in the JSON', () => {
  const polluted = JSON.parse(`{"__proto__":{"commit":"${NEWER_SHA}","version":"9.9.9"},"constructor":{"prototype":{"commit":"${NEWER_SHA}"}}}`);
  assert.equal(updateVerdict(LIVE, polluted).available, false);
  assert.equal(({}).commit, undefined, 'nothing leaked into Object.prototype');
  const withOwn = JSON.parse(`{"__proto__":{"x":1},"commit":"${NEWER_SHA}","version":"0.6.1"}`);
  assert.equal(updateVerdict(LIVE, withOwn).available, true, 'a valid answer with an extra key still counts');
  assert.deepEqual(Object.keys(updateVerdict(LIVE, withOwn).remote).sort(), ['builtAt', 'commit', 'shortCommit', 'version'], 'only the four known fields are handed on');
  const hostileBuild = [undefined, null, 5, 'live', [], { commit: NEWER_SHA }, { ...LIVE, channel: 'dev' }, JSON.parse('{"__proto__":{"commit":"abcdef1","channel":"live"}}')];
  for (const build of hostileBuild) assert.equal(updateVerdict(build, remote()).available, false, describe(build));
});

test('readRemoteBuild keeps a build time only when it is a real moment', () => {
  assert.equal(readRemoteBuild(remote()).builtAt, '2026-10-10T08:00:00Z');
  assert.equal(readRemoteBuild(remote({ builtAt: 'soon' })).builtAt, null);
  assert.equal(readRemoteBuild(remote({ builtAt: { toString: () => '2026-10-10T08:00:00Z' } })).builtAt, null);
  assert.equal(readRemoteBuild(remote({ version: 'v0.7.0' })).version, '0.7.0');
  assert.equal(readRemoteBuild(JSON.parse('{"commit":"a45ce49","version":"1.0.0"}')).shortCommit, 'a45ce49');
  assert.equal(sameCommit(SHA, 'a45ce49'), true);
  assert.equal(sameCommit('a45ce49', SHA), true);
  assert.equal(sameCommit(SHA, NEWER_SHA), false);
  assert.equal(sameCommit('dev', 'dev'), false, 'only real commits are ever the same');
});

// ---- chip, tooltip and the bug report line --------------------------------------------------------------------------

test('the tooltip names the build and the day; it says so when an update is waiting', () => {
  assert.equal(chipTooltip(LIVE, { timeZone: 'Europe/Berlin' }), 'Build a45ce49, 9 Oct 2026 – click for what is new');
  assert.equal(chipTooltip({ ...LIVE, builtAt: null }), 'Build a45ce49 – click for what is new');
  assert.equal(chipTooltip(DEV), 'Development build, not deployed – click for what is new');
  assert.equal(chipTooltip({ ...LIVE, commit: 'local', channel: 'local', builtAt: '2026-10-09T15:08:00Z' }, { timeZone: 'UTC' }), 'Local build, 9 Oct 2026 – click for what is new');
  // an update: ONE "click", the number it brings (or the build when the number is the same), and what the planner has now
  const text = chipTooltip(LIVE, { timeZone: 'UTC', update: { version: '0.7.0' } });
  assert.equal(text, 'Update available (v0.7.0) – click for details and to reload. Your build: a45ce49, 9 Oct 2026');
  assert.equal((text.match(/click/gi) || []).length, 1);
  const same = chipTooltip(LIVE, { timeZone: 'UTC', update: { version: '0.6.0', commit: NEWER_SHA, shortCommit: 'b3c4d5e' } });
  assert.equal(same, 'Update available (build b3c4d5e) – click for details and to reload. Your build: a45ce49, 9 Oct 2026', 'the same number is not called a version');
  assert.ok(!/v0\.6\.0/.test(same));
  assert.equal(chipTooltip(DEV, { update: { version: '0.7.0' } }), 'Update available (v0.7.0) – click for details and to reload. Your copy');
});

test('the chip shows the number and the id of the build; "dev" and "local" take the place of the id', () => {
  assert.equal(chipBuildId(LIVE), 'a45ce49');
  assert.equal(chipBuildId(DEV), '');
  assert.equal(chipBuildId({ ...LIVE, commit: 'local', channel: 'local' }), '');
  assert.equal(chipBuildId(undefined), '');
  assert.equal(chipText(LIVE), 'v0.6.0 a45ce49');
  assert.equal(chipText(LIVE, { update: {} }), 'v0.6.0 a45ce49 Update');
  assert.equal(chipText(DEV), 'v0.6.0 dev');
  assert.equal(chipText({ ...LIVE, commit: 'local', channel: 'local' }), 'v0.6.0 local');
  // two deploys of one version number differ in what the chip shows
  assert.notEqual(chipText(LIVE), chipText({ ...LIVE, commit: NEWER_SHA, shortCommit: 'b3c4d5e' }));
});

test('the spoken name of the chip starts with what the eye reads (label in name, WCAG 2.5.3) and then says what it does', () => {
  assert.equal(chipAriaLabel(LIVE), 'v0.6.0 a45ce49. Show version information and what is new');
  assert.equal(chipAriaLabel(DEV), 'v0.6.0 dev. Development build. Show version information and what is new');
  assert.equal(chipAriaLabel({ ...LIVE, commit: 'local', channel: 'local' }), 'v0.6.0 local. Local build. Show version information and what is new');
  assert.equal(chipAriaLabel(LIVE, { update: { version: '0.7.0' } }), 'v0.6.0 a45ce49 Update. An update is available. Show version information and what is new');
  for (const [build, update] of [[LIVE, null], [LIVE, {}], [DEV, null], [{ ...LIVE, commit: 'local', channel: 'local' }, null], [undefined, null]]) {
    const name = chipAriaLabel(build, { update });
    for (const word of chipText(build, { update }).split(' ')) assert.ok(name.includes(word), `"${word}" is part of "${name}"`);
    assert.ok(name.startsWith(chipText(build, { update })), 'and it starts with the visible text');
  }
  assert.ok(!/update/i.test(chipAriaLabel(LIVE)), 'nothing about an update while there is none');
});

test('updateNotice: a higher number is a new version, the same number a new build; it always names both builds', () => {
  const remote = { version: '0.7.0', commit: NEWER_SHA, shortCommit: 'b3c4d5e' };
  assert.deepEqual(updateNotice(LIVE, remote), {
    kind: 'version', headline: 'A newer version is available', detail: 'Version 0.7.0 (build b3c4d5e) is on the site; this page is version 0.6.0.', short: 'v0.7.0',
  });
  assert.deepEqual(updateNotice(LIVE, { ...remote, version: '0.6.0' }), {
    kind: 'build', headline: 'A newer build is available', detail: 'Build b3c4d5e of version 0.6.0 is on the site; this page is build a45ce49.', short: 'build b3c4d5e',
  });
  assert.equal(updateNotice(LIVE, { version: 'v1.0.0', commit: NEWER_SHA }).detail, 'Version 1.0.0 (build b3c4d5e) is on the site; this page is version 0.6.0.', 'the short id is made from the commit');
  assert.equal(updateNotice(LIVE, { version: '0.7.0' }).detail, 'Version 0.7.0 is on the site; this page is version 0.6.0.', 'without an id nothing is invented');
  assert.equal(updateNotice(LIVE, { version: '0.6.0' }).detail, 'A newer build of version 0.6.0 is on the site; this page is build a45ce49.');
  for (const junk of [null, undefined, 5, 'x', [], { version: { x: 1 }, commit: ['a'] }, { version: '<b>', shortCommit: '<img>' }]) {
    const n = updateNotice(LIVE, junk);
    assert.equal(n.kind, 'build');
    assert.ok(!/undefined|NaN|\[object|<|>/.test(JSON.stringify(n)), JSON.stringify(n));
  }
});

test('browserName reads the common user agents and survives junk', () => {
  assert.equal(browserName('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'), 'Chrome 126');
  assert.equal(browserName('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.7390.37 Safari/537.36'), 'Chrome 141');
  assert.equal(browserName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.81'), 'Edge 126');
  assert.equal(browserName('Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0'), 'Firefox 127');
  assert.equal(browserName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'), 'Safari 17');
  for (const junk of ['', undefined, null, 5, 'curl/8', 'x'.repeat(100000)]) assert.equal(browserName(junk), 'an unknown browser');
});

test('the bug report line: version, build, build time in UTC, browser and sizes', () => {
  const env = { userAgent: 'Mozilla/5.0 Chrome/126.0.0.0 Safari/537.36', window: { width: 1440, height: 900 }, screen: { width: 1920, height: 1080 } };
  assert.equal(bugReportLine(LIVE, env), 'LogiPlan v0.6.0 (a45ce49, built 2026-10-09 15:08 UTC), Chrome 126, window 1440 x 900 on a 1920 x 1080 screen');
  assert.equal(bugReportLine(DEV, { ...env, screen: null }), 'LogiPlan v0.6.0 (development build), Chrome 126, window 1440 x 900');
  assert.equal(bugReportLine({ ...LIVE, builtAt: null }, {}), 'LogiPlan v0.6.0 (a45ce49)');
  assert.equal(bugReportLine(LIVE, { window: { width: NaN, height: 5 }, screen: { width: 800.4, height: 600.6 } }), 'LogiPlan v0.6.0 (a45ce49, built 2026-10-09 15:08 UTC), screen 800 x 601');
  assert.equal(bugReportLine(undefined), 'LogiPlan v0.0.0 (development build)');
  assert.ok(!/undefined|NaN|\[object/.test(bugReportLine(LIVE, { userAgent: 5, window: 'x', screen: [] })));
});

// ---- the fixes of the review: the verdict knows the build time, the host has no port, a zone has a name, a changelog line is read in linear time ------------------

test('updateVerdict: for the SAME version number the build time says which deploy is newer; equal or missing times leave it to the commit', () => {
  const mine = { ...LIVE, builtAt: '2026-10-09T15:08:00Z' };
  const site = (builtAt, version = '0.6.0') => ({ version, commit: NEWER_SHA, builtAt });
  assert.deepEqual([updateVerdict(mine, site('2026-10-10T08:00:00Z')).available, updateVerdict(mine, site('2026-10-10T08:00:00Z')).reason], [true, 'newer']);
  assert.deepEqual([updateVerdict(mine, site('2026-10-01T00:00:00Z')).available, updateVerdict(mine, site('2026-10-01T00:00:00Z')).reason], [false, 'older'], 'an older deploy that finished last is no update');
  assert.equal(updateVerdict(mine, site('2026-10-09T15:07:59Z')).reason, 'older', 'even one second older');
  assert.equal(updateVerdict(mine, site('2026-10-09T15:08:00Z')).available, true, 'equal build times say nothing about the direction');
  assert.equal(updateVerdict(mine, site('2026-10-09T17:08:00+02:00')).available, true, 'the same instant written with an offset');
  assert.equal(updateVerdict(mine, site(undefined)).available, true, 'the site gives no build time: the commit decides');
  assert.equal(updateVerdict(mine, site('soon')).available, true, 'a build time that is no date is not looked at');
  assert.equal(updateVerdict({ ...mine, builtAt: null }, site('2026-10-01T00:00:00Z')).available, true, 'this build has none');
  // a higher number wins whatever the times say; a lower number is a rollback and is not announced
  assert.equal(updateVerdict(mine, site('2026-10-01T00:00:00Z', '0.7.0')).available, true);
  assert.equal(updateVerdict(mine, site('2026-10-20T00:00:00Z', '0.5.0')).reason, 'older');
});

test('hostName drops the port and keeps everything else; whereItRuns calls a local host local with or without a port', () => {
  for (const [host, name] of [['localhost:8080', 'localhost'], ['127.0.0.1:41234', '127.0.0.1'], ['[::1]:8080', '[::1]'], ['[::1]', '[::1]'], ['::1', '::1'], ['laptop.local:3000', 'laptop.local'],
    ['Example.COM', 'example.com'], ['example.com:', 'example.com'], ['', ''], [undefined, ''], [null, ''], ['  localhost:80  ', 'localhost']]) {
    assert.equal(hostName(host), name, String(host));
  }
  for (const host of ['localhost:8080', '127.0.0.1:8080', '127.0.0.1:41234', '[::1]:8080', 'laptop.local:3000', 'app.localhost:8080', 'localhost', 'LOCALHOST:3000']) {
    assert.equal(whereItRuns(LIVE, host), 'Built site on this computer', host);
  }
  for (const host of ['rangulvers.github.io', 'logiplan.test:8080', 'localhost.evil.com:8080', 'xlocalhost:8080', 'example.com:3000']) assert.equal(whereItRuns(LIVE, host), 'Live site', host);
  assert.equal(whereItRuns(DEV, 'rangulvers.github.io'), 'Local development');
});

test('a time zone is named when it has a name: EDT for New York, CEST for Berlin, the offset where no abbreviation exists', () => {
  const at = '2026-10-09T15:08:00Z';
  assert.equal(formatBuildDate(at, { timeZone: 'Europe/Berlin' }).local, '9 Oct 2026, 17:08 CEST');
  assert.equal(formatBuildDate(at, { timeZone: 'America/New_York' }).local, '9 Oct 2026, 11:08 EDT');
  assert.equal(formatBuildDate(at, { timeZone: 'America/Los_Angeles' }).zone, 'PDT');
  assert.equal(formatBuildDate(at, { timeZone: 'UTC' }).local, '9 Oct 2026, 15:08 UTC');
  assert.match(formatBuildDate(at, { timeZone: 'Asia/Tokyo' }).local, /^10 Oct 2026, 00:08 GMT\+9$/);
  assert.equal(formatBuildDate('2026-01-09T15:08:00Z', { timeZone: 'America/New_York' }).zone, 'EST');
});

test('parseChangelog reads a long run of blanks in linear time (a regular expression like /\\s+$/ took 5 s for 80,000)', () => {
  const t0 = performance.now();
  for (const n of [20_000, 80_000, 390_000]) {
    parseChangelog(`## [1.0.0]\n- a${' '.repeat(n)}b\n`);
    parseChangelog(`## [1.0.0]${' '.repeat(n)}x\n`);
    parseChangelog(`## [1.0.0] - 2026-01-01${' '.repeat(n)}\n### Added\n-${' '.repeat(n)}x\n${' '.repeat(n)}\n  more\n`);
    parseChangelog(`${' '.repeat(n)}\n${'\t'.repeat(n)}`);
  }
  assert.ok(performance.now() - t0 < 1500, `took ${(performance.now() - t0).toFixed(0)} ms`);
  // a line is cut at CHANGELOG_LIMITS.line before anything reads it, and the result is the same as before for every normal line
  assert.equal(CHANGELOG_LIMITS.line, 2000);
  const [entry] = parseChangelog(`## [1.0.0]\n- ${'x'.repeat(5000)}\n`);
  assert.equal(entry.sections[0].items[0].length, CHANGELOG_LIMITS.item);
  assert.deepEqual(parseChangelog('## [1.0.0]  \n- a   \n  b  \n')[0].sections[0].items, ['a b'], 'trailing blanks are dropped');
});
