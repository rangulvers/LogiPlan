// The test tiers (scripts/test-tiers.mjs): CI runs the fast tier as the gate of a deploy and the heavy tier in parallel shards. This file makes
// sure that no test can fall out of that: the tiers together are exactly tests/*.test.js (a sliced file: every one of its tests), and both
// workflows run every shard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HEAVY_SHARDS, SHARD_COUNT, SLICED_FILES, allTestFiles, fastFiles, heavyFiles, filesFor, nodeArgs, parseArgs, runsFor, describeSlice } from '../scripts/test-tiers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = path.join(ROOT, 'tests');
const read = (...parts) => readFileSync(path.join(ROOT, ...parts), 'utf8');
const workflow = (name) => read('.github', 'workflows', name);
const cli = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'test-tiers.mjs'), ...args], { encoding: 'utf8' });

/** What `node --test "tests/*.test.js"` runs, found without the code under test: the *.test.js files directly inside tests/. */
const globbed = () => readdirSync(TESTS, { withFileTypes: true }).filter((e) => e.isFile() && /^[^/]+\.test\.js$/.test(e.name)).map((e) => e.name).sort();

/** The titles of the top-level tests of a file: `test('title', ...)` / `test("title", ...)` at the start of a line. */
function topLevelTitles(file) {
  const source = read('tests', file);
  assert.doesNotMatch(source, /^(?:describe|suite)\(/m, `${file}: a sliced file must not use suites: name patterns would match their tests by the suite name`);
  return [...source.matchAll(/^(?:test|it)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/gm)].map((m) => m[2]);
}

test('the tiers cover every tests/*.test.js exactly once', () => {
  const all = globbed();
  assert.deepEqual(allTestFiles(), all, 'allTestFiles() must list what the glob lists');
  const fast = fastFiles();
  const heavy = heavyFiles();
  assert.deepEqual(fast.filter((name) => heavy.includes(name)), [], 'a file in both tiers would run twice');
  assert.deepEqual([...fast, ...heavy].sort(), all, 'fast + heavy must be exactly the files of tests/');
  assert.deepEqual(filesFor('all').sort(), all);
  assert.ok(fast.includes('test-tiers.test.js'), 'this guard itself is part of the fast tier, the gate of every deploy');
});

test('the heavy shards name real test files; a whole file is in one shard only, a sliced file in all of its slices', () => {
  assert.ok(SHARD_COUNT >= 1);
  const shardsOf = new Map();
  HEAVY_SHARDS.forEach((shard, i) => {
    assert.ok(shard.files.length > 0, `heavy shard ${i + 1} has no files: its CI job would pass without running a test`);
    if (shard.only || shard.skip.length) assert.equal(shard.files.length, 1, `heavy shard ${i + 1}: a slice (name pattern) applies to one file only, the other files would run nothing`);
    for (const name of shard.files) {
      assert.match(name, /^[A-Za-z0-9._-]+\.test\.js$/, `${name}: file names only, no directory`);
      assert.ok(existsSync(path.join(TESTS, name)), `${name} (heavy shard ${i + 1}) does not exist: renamed or deleted? Update HEAVY_SHARDS in scripts/test-tiers.mjs`);
      shardsOf.set(name, [...(shardsOf.get(name) ?? []), i + 1]);
    }
  });
  for (const [name, shards] of shardsOf) {
    if (name in SLICED_FILES) {
      const slices = shards.map((n) => HEAVY_SHARDS[n - 1]);
      assert.equal(slices.length, SLICED_FILES[name].length + 1, `${name} has ${SLICED_FILES[name].length} patterns, so it has that many slices plus the rest, one shard each`);
      for (const pattern of SLICED_FILES[name]) assert.equal(slices.filter((s) => s.only === pattern).length, 1, `${name}: no shard (or two) for the slice ${pattern}`);
      assert.equal(slices.filter((s) => s.only === null && s.skip.length === SLICED_FILES[name].length && s.skip.every((p, i) => p === SLICED_FILES[name][i])).length, 1, `${name}: the rest slice is missing`);
    } else assert.deepEqual(shards, [shards[0]], `${name} is listed in several shards (${shards.join(', ')}) and would run more than once`);
  }
  for (const name of Object.keys(SLICED_FILES)) assert.ok(shardsOf.has(name), `${name} is described as sliced but no shard runs it`);
});

for (const [file, patterns] of Object.entries(SLICED_FILES)) {
  test(`${file}: its slices together run each test of the file exactly once`, () => {
    const titles = topLevelTitles(file);
    assert.ok(titles.length >= 10, `found only ${titles.length} test titles: did the file change its style?`);
    assert.equal(new Set(titles).size, titles.length, 'duplicate test titles cannot be told apart by a name pattern');
    const matching = (pattern) => titles.filter((t) => new RegExp(pattern).test(t));
    for (const pattern of patterns) {
      assert.ok(pattern.startsWith('^'), `${pattern}: a slice pattern starts with ^ (the whole title is not searched)`);
      assert.ok(matching(pattern).length >= 1, `the slice ${pattern} matches no test of ${file}: renamed? Its shard would run nothing`);
    }
    const counts = titles.map((t) => patterns.filter((p) => new RegExp(p).test(t)).length);
    assert.ok(counts.every((n) => n <= 1), `these tests match two slices and would run twice: ${titles.filter((_, i) => counts[i] > 1).join(' | ')}`);
    const rest = titles.filter((_, i) => counts[i] === 0);
    assert.ok(rest.length >= 1, 'the rest slice is empty');
    assert.equal(rest.length + patterns.reduce((n, p) => n + matching(p).length, 0), titles.length);
  });
}

test('every heavy shard is a subset of the heavy tier, and the shards add up to it', () => {
  assert.deepEqual([...new Set(HEAVY_SHARDS.flatMap((_, i) => heavyFiles(i + 1)))].sort(), [...heavyFiles()].sort());
  for (const bad of [0, SHARD_COUNT + 1, 1.5, -1]) assert.throws(() => heavyFiles(bad), /no heavy shard/);
});

test('nodeArgs builds a node --test command with repository-relative paths, extra flags first, then the name filters', () => {
  assert.deepEqual(nodeArgs(['a.test.js', 'b.test.js']), ['--test', 'tests/a.test.js', 'tests/b.test.js']);
  assert.deepEqual(nodeArgs(['a.test.js'], { extra: ['--test-reporter=spec'] }), ['--test', '--test-reporter=spec', 'tests/a.test.js']);
  assert.deepEqual(nodeArgs(['a.test.js'], { only: '^X' }), ['--test', '--test-name-pattern=^X', 'tests/a.test.js']);
  assert.deepEqual(nodeArgs(['a.test.js'], { skip: ['^X', '^Y'] }), ['--test', '--test-skip-pattern=^X', '--test-skip-pattern=^Y', 'tests/a.test.js']);
  assert.equal(describeSlice({ only: null, skip: [] }), '');
  assert.match(describeSlice({ only: '^X', skip: [] }), /only .*\^X/);
  assert.match(describeSlice({ only: null, skip: ['^X', '^Y'] }), /except .*\^X or \^Y/);
});

test('runsFor: one run for the fast tier, one per shard for the heavy tier, each with files', () => {
  assert.equal(runsFor('fast').length, 1);
  assert.deepEqual(runsFor('fast')[0].files, fastFiles());
  assert.equal(runsFor('heavy').length, SHARD_COUNT);
  assert.equal(runsFor('heavy', 1).length, 1);
  assert.equal(runsFor('all').length, SHARD_COUNT + 1);
  for (const run of runsFor('all')) assert.ok(run.files.length > 0, `${run.label} has no files`);
  assert.throws(() => runsFor('slow'), /Unknown tier/);
});

test('parseArgs: tiers, shard, extra flags, and plain-language errors', () => {
  assert.deepEqual(parseArgs(['fast']), { command: 'run', tier: 'fast', shard: null, extra: [] });
  assert.deepEqual(parseArgs(['heavy', '--shard', '1']), { command: 'run', tier: 'heavy', shard: 1, extra: [] });
  assert.deepEqual(parseArgs(['heavy', `--shard=${SHARD_COUNT}`, '--', '--test-reporter=spec']), { command: 'run', tier: 'heavy', shard: SHARD_COUNT, extra: ['--test-reporter=spec'] });
  assert.deepEqual(parseArgs(['list']), { command: 'list', tier: null, shard: null, extra: [] });
  assert.deepEqual(parseArgs(['list', 'heavy', '--shard', '1']), { command: 'list', tier: 'heavy', shard: 1, extra: [] });
  assert.deepEqual(parseArgs(['timings', 'fast']), { command: 'timings', tier: 'fast', shard: null, extra: [] });
  assert.throws(() => parseArgs([]), /Say what to do/);
  assert.throws(() => parseArgs(['everything']), /Unexpected argument/);
  assert.throws(() => parseArgs(['fast', '--shard', '1']), /--shard belongs to the heavy tier/);
  assert.throws(() => parseArgs(['heavy', '--shard']), /--shard needs a number/);
  assert.throws(() => parseArgs(['heavy', '--shard', 'x']), /--shard needs a number/);
  assert.throws(() => parseArgs(['heavy', '--shard', '0']), /no heavy shard 0/);
  assert.throws(() => parseArgs(['heavy', '--shard', String(SHARD_COUNT + 1)]), /no heavy shard/);
  assert.throws(() => parseArgs(['fast', '--nope']), /Unknown option/);
});

test('the command line lists the same files as the module, and refuses a shard that does not exist', () => {
  const names = (out) => out.stdout.trim().split('\n').map((line) => line.split('  (')[0]);
  const fast = cli('list', 'fast');
  assert.equal(fast.status, 0);
  assert.deepEqual(names(fast), fastFiles());
  for (let shard = 1; shard <= SHARD_COUNT; shard++) {
    const out = cli('list', 'heavy', '--shard', String(shard));
    assert.equal(out.status, 0);
    assert.deepEqual(names(out), heavyFiles(shard));
  }
  const missing = cli('heavy', '--shard', String(SHARD_COUNT + 1));
  assert.equal(missing.status, 2, 'a matrix leg for a shard that does not exist must fail, not pass with no tests');
  assert.match(missing.stderr, /no heavy shard/);
  assert.equal(cli().status, 2);
});

test('package.json: test and test:quiet run everything, test:fast and test:heavy run the tiers', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  assert.match(scripts.test, /^node --test .*"tests\/\*\.test\.js"$/);
  assert.match(scripts['test:quiet'], /^node --test "tests\/\*\.test\.js"$/);
  assert.equal(scripts['test:fast'], 'node scripts/test-tiers.mjs fast');
  assert.equal(scripts['test:heavy'], 'node scripts/test-tiers.mjs heavy');
  assert.equal(scripts.check, 'node scripts/check-imports.mjs');
  assert.equal(scripts['test:e2e'], 'node tests/e2e/run.mjs');
});

/** The text of one top-level job of a workflow file (from "  name:" up to the next job or the end). */
function jobBlock(text, job) {
  const match = text.match(new RegExp(`^  ${job}:\\n([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:\\n|(?![\\s\\S]))`, 'm'));
  assert.ok(match, `job "${job}" not found`);
  return match[1];
}

/** The shard numbers a workflow's matrix lists: `shard: [1, 2, 3]`. */
function matrixShards(block) {
  const match = block.match(/^\s*shard:\s*\[([\d,\s]+)\]\s*$/m);
  assert.ok(match, 'no `shard: [1, 2, ...]` matrix');
  return match[1].split(',').map((s) => Number(s.trim()));
}

for (const file of ['ci.yml', 'pages.yml']) {
  test(`${file}: runs the fast tier and every heavy shard (a shard missing from the matrix would silently drop its tests)`, () => {
    const text = workflow(file);
    assert.match(text, /^\s+(?:- )?run: npm run test:fast\s*$/m, 'the fast tier is not run');
    const heavy = jobBlock(text, 'heavy');
    assert.match(heavy, /^\s+(?:- )?run: npm run test:heavy -- --shard \$\{\{ matrix\.shard \}\}\s*$/m);
    assert.deepEqual(matrixShards(heavy), Array.from({ length: SHARD_COUNT }, (_, i) => i + 1), `the matrix must list the shards 1 to ${SHARD_COUNT} of scripts/test-tiers.mjs`);
    assert.match(heavy, /fail-fast:\s*false/, 'a failing shard must not hide the result of the others');
    const named = heavy.match(/name:.*\$\{\{ matrix\.shard \}\}\/(\d+)/);
    assert.ok(named && Number(named[1]) === SHARD_COUNT, `the job name says "n/${SHARD_COUNT}"`);
  });
}

test('pages.yml: the deploy waits for the fast gate only; the heavy tier runs beside it and never gates it', () => {
  const text = workflow('pages.yml');
  const verify = jobBlock(text, 'verify');
  assert.match(verify, /npm run check/);
  assert.match(verify, /npm run test:fast/);
  assert.match(verify, /build-site\.mjs _site\b/);
  const deploy = jobBlock(text, 'deploy');
  assert.match(deploy, /^    needs:\s*\[?\s*verify\s*\]?\s*$/m, 'deploy needs the verify job');
  assert.doesNotMatch(deploy, /heavy/, 'the deploy must not wait for the heavy tier');
  assert.match(deploy, /group:\s*pages\b/);
  assert.match(deploy, /cancel-in-progress:\s*false/);
  assert.doesNotMatch(jobBlock(text, 'heavy'), /continue-on-error/, 'a failing heavy tier on main has to show red');
  assert.doesNotMatch(text.split(/^jobs:/m)[0], /^concurrency:/m, 'workflow-level concurrency would make the next deploy wait for the heavy tier of the previous run');
});

test('ci.yml: check, fast and heavy jobs run in parallel (no needs between them) and one job gathers the verdict', () => {
  const text = workflow('ci.yml');
  for (const job of ['check', 'fast', 'heavy']) assert.doesNotMatch(jobBlock(text, job), /^    needs:/m, `${job} must not wait for another job`);
  assert.match(text, /^on:\s*\n\s+pull_request:/m);
  assert.match(text, /cancel-in-progress:\s*true/);
  const gate = jobBlock(text, 'ci');
  assert.match(gate, /needs:\s*\[check, fast, heavy\]/);
  assert.match(gate, /if:\s*\$\{\{\s*!cancelled\(\)\s*\}\}/, 'the verdict job must run even when a job failed (a skipped required check counts as passed)');
});

test('e2e.yml: browser tests run on demand and weekly, not on pull requests, and keep their screenshots when they fail', () => {
  const text = workflow('e2e.yml');
  const triggers = text.split(/^jobs:/m)[0];
  assert.match(triggers, /workflow_dispatch:/);
  assert.match(triggers, /schedule:/);
  assert.doesNotMatch(triggers, /pull_request|push:/);
  assert.match(text, /npm run test:e2e/);
  assert.match(text, /npx playwright install --with-deps chromium/);
  assert.match(text, /upload-artifact@v4[\s\S]*path:\s*e2e-output/);
});
