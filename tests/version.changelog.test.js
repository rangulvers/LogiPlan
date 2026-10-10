// The real CHANGELOG.md: the history planners read in the About dialog. It must agree with package.json and js/build-info.js, every entry must be
// dated and in order, nothing may be empty, and an unwritten release (the TODO stub of scripts/bump-version.mjs) must not reach main.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChangelog, latestRelease, parseDay, compareVersions, parseVersion, CHANGELOG_LIMITS } from '../js/version.js';
import { BUILD } from '../js/build-info.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const text = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const entries = parseChangelog(text);
const released = entries.filter((e) => !e.unreleased);
const SECTION_TITLES = ['Added', 'Improved', 'Fixed'];

test('the newest released entry is the version of package.json and of js/build-info.js', () => {
  assert.ok(released.length >= 1, 'at least one released version');
  assert.equal(latestRelease(entries).version, pkg.version);
  assert.equal(BUILD.version, pkg.version);
  assert.equal(released[0], latestRelease(entries), 'the newest release is the first one under [Unreleased]');
});

test('[Unreleased], when there is one, stands on top and has no date', () => {
  const at = entries.findIndex((e) => e.unreleased);
  if (at < 0) return;
  assert.equal(at, 0, 'the unreleased changes come first');
  assert.equal(entries.filter((e) => e.unreleased).length, 1, 'only one [Unreleased]');
  assert.equal(entries[0].date, null);
});

test('every released entry has a valid date, and dates never increase going down the file', () => {
  for (const e of released) {
    assert.ok(e.date, `[${e.version}] needs a date (## [x.y.z] - YYYY-MM-DD)`);
    assert.ok(parseDay(e.date), `[${e.version}]: ${e.date} is not a real day`);
  }
  for (let i = 1; i < released.length; i++) {
    assert.ok(released[i - 1].date >= released[i].date, `[${released[i - 1].version}] (${released[i - 1].date}) is listed above [${released[i].version}] (${released[i].date}): the newest goes first`);
  }
});

test('versions are real, unique and strictly older going down the file', () => {
  for (const e of released) assert.ok(parseVersion(e.version), `${e.version} is not a version`);
  assert.equal(new Set(released.map((e) => e.version)).size, released.length, 'no version twice');
  for (let i = 1; i < released.length; i++) {
    assert.equal(compareVersions(released[i - 1].version, released[i].version), 1, `[${released[i - 1].version}] must be newer than [${released[i].version}] below it`);
  }
  assert.equal(released.at(-1).version, '0.1.0', 'the history starts at the first usable version');
});

test('no empty entry, no empty section, no empty or unwritten item', () => {
  for (const e of entries) {
    if (e.unreleased) continue; // [Unreleased] may be empty right after a release
    assert.ok(e.sections.length > 0, `[${e.version}] has no items`);
  }
  for (const e of entries) {
    for (const s of e.sections) {
      assert.ok(s.items.length > 0, `[${e.version}] ${s.title}: empty section`);
      assert.ok(SECTION_TITLES.includes(s.title), `[${e.version}]: "${s.title}" is not one of ${SECTION_TITLES.join(', ')} (the changelog is written for planners: three headings)`);
      for (const item of s.items) {
        assert.ok(item.trim().length >= 10, `[${e.version}] ${s.title}: an item that short says nothing: "${item}"`);
        assert.ok(item.length < CHANGELOG_LIMITS.item, `[${e.version}] ${s.title}: an item is cut off at ${CHANGELOG_LIMITS.item} characters`);
        assert.ok(!/\bTODO\b/.test(item), `[${e.version}] ${s.title}: unwritten item "${item}"`);
      }
    }
  }
});

test('the headings of one version follow the order Added, Improved, Fixed, each once', () => {
  for (const e of entries) {
    const titles = e.sections.map((s) => s.title);
    assert.equal(new Set(titles).size, titles.length, `[${e.version}]: a heading twice`);
    assert.deepEqual(titles, SECTION_TITLES.filter((t) => titles.includes(t)), `[${e.version}]: the order is Added, Improved, Fixed`);
  }
});

test('the file is plain text for planners: no HTML, no references to code files in the items', () => {
  for (const e of entries) {
    for (const s of e.sections) {
      for (const item of s.items) {
        assert.ok(!/<\/?[a-z][^>]*>/i.test(item), `[${e.version}]: HTML in "${item.slice(0, 60)}"`);
        assert.ok(!/\bjs\/[\w/.-]+\.js\b|\bscripts\/[\w.-]+\.mjs\b/.test(item), `[${e.version}]: a file path in "${item.slice(0, 60)}": planners do not read code`);
      }
    }
  }
});

test('the parser reads every version heading of the file (none is lost to a typo)', () => {
  const headings = [...text.matchAll(/^## .*$/gm)].map((m) => m[0]);
  assert.equal(entries.length, headings.length, `the file has ${headings.length} "## " headings but ${entries.length} entries were read: ${headings.join(' | ')}`);
});
