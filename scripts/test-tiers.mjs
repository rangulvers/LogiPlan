#!/usr/bin/env node
// Test tiers: which tests/*.test.js run in which CI job, so that a pull request and a deploy do not wait for the slowest tests.
//
//   FAST   every test file that is not listed below (pure logic, small plants, UI helpers). It is the gate of a deploy.
//   HEAVY  the shards listed in HEAVY_SHARDS: seeded fuzz runs, performance bounds, long simulations, whole-plant integration.
//          CI runs one job per shard, all at the same time, so the wait is the slowest shard, not the sum.
//
// A file that is in no shard is FAST, so a new test file can never fall out of CI. tests/test-tiers.test.js proves that the tiers cover
// tests/*.test.js exactly once, that no shard names a missing file, and that both workflows run every shard.
// Needs Node 22.1 or later (the slices of a long file use --test-skip-pattern); CI uses Node 22.
//
//   node scripts/test-tiers.mjs fast                 run the fast tier             (npm run test:fast)
//   node scripts/test-tiers.mjs heavy                run every heavy shard         (npm run test:heavy)
//   node scripts/test-tiers.mjs heavy --shard 2      run heavy shard 2 of SHARD_COUNT (what a CI matrix job does)
//   node scripts/test-tiers.mjs all                  run fast + heavy in one go    (the same tests as npm run test:quiet)
//   node scripts/test-tiers.mjs list [tier] [--shard N]   print the files of a tier (without a tier: every file with its tier)
//   node scripts/test-tiers.mjs timings [tier]       run every file of a tier alone and print the wall time of each (npm run test:timings)
//   ... -- --test-reporter=spec                      everything after `--` goes to `node --test` unchanged
//
// Re-balance after tests were added or became slower: run `npm run test:timings` on a quiet machine, move the slowest fast files into
// a heavy shard (keep the shards about equally long), update the seconds in the comments. The seconds are CPU seconds of one file run
// alone (median of three runs, 4 cores, 2026-10-08); they are for the reviewer, nothing reads them.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TESTS_DIR = path.join(ROOT, 'tests');

/**
 * A very long file is cut into slices that run in different shards: the same file, run with `--test-name-pattern` (only the tests whose
 * name matches). A slice is a regular expression for the names of its tests and must start with `^`. The tests that match none of the
 * patterns of a file are its last slice, run with one `--test-skip-pattern` per pattern (Node 22.1 or later; CI uses 22), so a test
 * added to the file runs in that one and nothing can be skipped. tests/test-tiers.test.js checks that every pattern matches at least
 * one test of the file, that no test matches two patterns, and that the last slice is not empty.
 */
export const SLICED_FILES = Object.freeze({
  // The engine review is the longest file by far: about 110 s on four idle cores according to its own header (about 165 s measured here,
  // beside other work). Its heavy loops run on worker threads, so a slice that has its runner to itself uses all four cores.
  'sim.engine.review.test.js': Object.freeze([
    '^ENG-7', // 5 tests (~50 s here): ENG-7a..e share one "tips" measurement that the first of them pays for, so they stay together
    '^ENG-(?:KPI-1|MEM-1|FUZZ-1):', // 3 tests (~50 s here): the long runs, e.g. each example for 8 simulated hours x 10 seeds
  ]),
});

const whole = (...files) => Object.freeze({ files: Object.freeze(files), only: null, skip: Object.freeze([]) });
/** Slice number `which` (0-based) of a sliced file, or `'rest'`: every test that matches none of its patterns. */
const slice = (file, which) => {
  const patterns = SLICED_FILES[file];
  if (!patterns) throw new Error(`${file} is not a sliced file.`);
  return Object.freeze({ files: Object.freeze([file]), only: which === 'rest' ? null : patterns[which], skip: which === 'rest' ? patterns : Object.freeze([]) });
};

/**
 * The heavy tier, one entry per CI job: { files, only, skip }. `only` (a name pattern) and `skip` (name patterns) cut one file into slices.
 * Whole files are in exactly one shard, a sliced file is in as many shards as it has slices (its patterns + 1).
 */
export const HEAVY_SHARDS = Object.freeze([
  // 1-3: the engine review in three slices (about 50 to 60 s each here), see SLICED_FILES; each has a runner to itself.
  slice('sim.engine.review.test.js', 0),
  slice('sim.engine.review.test.js', 1),
  slice('sim.engine.review.test.js', 'rest'),
  // 4-5: whole files, ~94 CPU s each (median of three runs of each file alone), biggest first.
  whole(
    'ui.runner.warm.review.test.js', // 30.4  warm restart, attacked
    'sim.experiments.test.js', //       12.1  sweeps and variant comparison
    'model.review.test.js', //          10.5
    'sim.traffic.fuzz1.test.js', //      9.1  seeded traffic fuzz, 8 files of the same kind
    'sim.traffic.fuzz3.test.js', //      9.0
    'sim.traffic.fuzz2.test.js', //      8.7
    'sim.traffic.fuzz7.test.js', //      7.6
    'sim.traffic.fuzz6.test.js', //      7.1
    'm0.review.test.js', //             ~10  the adversarial review of milestone M0 (warehouse seams): digests of the pre-M0 tree, hostile documents, stand-in sanitizers; its expensive checks are opt-in (M0_REVIEW_HEAVY=1)
    'model.ops-trucks.fuzz.test.js', // ~13  M1: 4,000 documents with ops and calendar junk (the fast checks of the same keys are in model.ops-trucks.test.js)
    'sim.trucks.fuzz.test.js', //       ~51  M1: 200 random plants with trucks, every invariant on every tick, report.ops, dt and fork independence at scale (A1.3, A1.4, A1.8, A1.9)
  ),
  whole(
    'sim.integration.test.js', //       27.4  examples end to end, performance bound
    'sim.docks.integration.test.js', // 23.6
    'sim.docks.review.test.js', //      ~75  the dock book attacked: 200 random plants x 20 min, 36 tests (measured by its reviewer, not by test:timings)
    'sim.traffic.fuzz4.test.js', //      9.3
    'sim.logistics.review.test.js', //   9.1
    'sim.largegrid.test.js', //          8.8  320 x 320 cells, performance bound
    'sim.traffic.fuzz5.test.js', //      7.8
    'sim.traffic.fuzz8.test.js', //      7.5
  ),
]);
export const SHARD_COUNT = HEAVY_SHARDS.length;

/** Every tests/*.test.js, sorted; independent of the shards above (this is what `node --test "tests/*.test.js"` runs). */
export function allTestFiles(dir = TESTS_DIR) {
  return readdirSync(dir).filter((name) => name.endsWith('.test.js')).sort();
}

/** The shard (1-based) as { files, only, skip }. */
export function shardOf(shard) {
  if (!Number.isInteger(shard) || shard < 1 || shard > SHARD_COUNT) throw new Error(`There is no heavy shard ${shard}: the shards are 1 to ${SHARD_COUNT}.`);
  return HEAVY_SHARDS[shard - 1];
}

/** The files of one heavy shard, or (no argument) every file that any shard runs, each once. */
export function heavyFiles(shard = null) {
  if (shard !== null) return [...shardOf(shard).files];
  return [...new Set(HEAVY_SHARDS.flatMap((s) => s.files))];
}

/** The fast tier: every test file that no heavy shard runs. */
export function fastFiles(all = allTestFiles()) {
  const heavy = new Set(heavyFiles());
  return all.filter((name) => !heavy.has(name));
}

/** Files of a tier: 'fast' | 'heavy' (optionally one shard) | 'all'. */
export function filesFor(tier, { shard = null, all = allTestFiles() } = {}) {
  if (tier === 'fast') return fastFiles(all);
  if (tier === 'heavy') return heavyFiles(shard);
  if (tier === 'all') return [...fastFiles(all), ...heavyFiles()];
  throw new Error(`Unknown tier "${tier}": use fast, heavy or all.`);
}

/** Arguments of the `node` process that runs these files (paths relative to the repository root, so the logs are short). */
export function nodeArgs(files, { extra = [], only = null, skip = [] } = {}) {
  return ['--test', ...extra, ...(only ? [`--test-name-pattern=${only}`] : []), ...skip.map((p) => `--test-skip-pattern=${p}`), ...files.map((name) => `tests/${name}`)];
}

/** The runs of a tier: one { label, files, only, skip } for the fast tier or one shard, one per shard for the whole heavy tier. */
export function runsFor(tier, shard = null) {
  if (tier === 'fast') return [{ label: 'fast tier', files: fastFiles(), only: null, skip: [] }];
  if (tier === 'heavy') {
    const shards = shard === null ? HEAVY_SHARDS.map((_, i) => i + 1) : [shard];
    return shards.map((n) => ({ label: `heavy shard ${n}/${SHARD_COUNT}`, ...shardOf(n) }));
  }
  if (tier === 'all') return [...runsFor('fast'), ...runsFor('heavy')];
  throw new Error(`Unknown tier "${tier}": use fast, heavy or all.`);
}

/** Parse the command line: { command, tier, shard, extra }. Throws a plain-language Error on a bad one. */
export function parseArgs(argv) {
  const dash = argv.indexOf('--');
  const own = dash < 0 ? argv : argv.slice(0, dash);
  const extra = dash < 0 ? [] : argv.slice(dash + 1);
  const opts = { command: null, tier: null, shard: null, extra };
  for (let i = 0; i < own.length; i++) {
    const arg = own[i];
    if (arg === '--shard' || arg.startsWith('--shard=')) {
      const raw = arg === '--shard' ? own[++i] : arg.slice('--shard='.length);
      if (!/^\d+$/.test(raw ?? '')) throw new Error(`--shard needs a number from 1 to ${SHARD_COUNT}, got "${raw ?? ''}".`);
      opts.shard = Number(raw);
    } else if (arg.startsWith('-')) throw new Error(`Unknown option ${arg}.`);
    else if (['fast', 'heavy', 'all'].includes(arg) && opts.command === null) { opts.command = 'run'; opts.tier = arg; }
    else if (['list', 'timings'].includes(arg) && opts.command === null) opts.command = arg;
    else if (['fast', 'heavy', 'all'].includes(arg) && opts.tier === null) opts.tier = arg;
    else throw new Error(`Unexpected argument "${arg}".`);
  }
  if (opts.command === null) throw new Error('Say what to do: fast, heavy, all, list or timings.');
  if (opts.shard !== null && opts.tier !== 'heavy') throw new Error('--shard belongs to the heavy tier: node scripts/test-tiers.mjs heavy --shard 2');
  if (opts.shard !== null && (opts.shard < 1 || opts.shard > SHARD_COUNT)) throw new Error(`There is no heavy shard ${opts.shard}: the shards are 1 to ${SHARD_COUNT}.`);
  return opts;
}

const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;

/** Add one line to the job summary page when running in GitHub Actions. Never fails the run. */
function summarise(text) {
  try {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  } catch { /* the summary is a courtesy */ }
}

/** "only the tests matching ^ENG-7" / "all tests except those matching ..." for a slice of a file, '' for whole files. */
export function describeSlice({ only, skip }) {
  if (only) return `only the tests matching ${only}`;
  if (skip.length) return `all tests except those matching ${skip.join(' or ')}`;
  return '';
}

/** Run one node --test process and resolve its exit code. */
function runOnce(run, extra) {
  return new Promise((resolve) => {
    if (run.files.length === 0) {
      console.error(`test-tiers: ${run.label} has no test files; refusing to report success for nothing.`);
      resolve(2);
      return;
    }
    console.log(`test-tiers: ${run.label}: ${run.files.length} test file${run.files.length === 1 ? '' : 's'}${describeSlice(run) && `, ${describeSlice(run)}`}`);
    const started = Date.now();
    const child = spawn(process.execPath, nodeArgs(run.files, { extra, only: run.only, skip: run.skip }), { cwd: ROOT, stdio: 'inherit' });
    const forward = (signal) => child.kill(signal);
    process.on('SIGINT', forward);
    process.on('SIGTERM', forward);
    child.on('error', (err) => { console.error(`test-tiers: could not start node: ${err.message}`); resolve(2); });
    child.on('close', (code, signal) => {
      const status = code === 0 ? 'passed' : 'FAILED';
      console.log(`test-tiers: ${run.label} ${status} in ${seconds(Date.now() - started)}`);
      summarise(`- **${run.label}**: ${status} in ${seconds(Date.now() - started)} (${run.files.length} file${run.files.length === 1 ? '' : 's'}${describeSlice(run) && `, ${describeSlice(run)}`})`);
      resolve(code === 0 ? 0 : (code ?? (signal ? 1 : 2)));
    });
  });
}

/** Run a tier: the fast tier, one shard, or the shards of the heavy tier one after the other (stops at nothing: all of them run). */
async function run(opts) {
  let worst = 0;
  for (const one of runsFor(opts.tier, opts.shard)) worst = Math.max(worst, await runOnce(one, opts.extra));
  return worst;
}

function list(opts) {
  if (opts.tier) {
    for (const one of runsFor(opts.tier, opts.shard)) {
      const note = describeSlice(one);
      for (const name of one.files) console.log(note ? `${name}  (${note})` : name);
    }
    return 0;
  }
  const all = allTestFiles();
  const where = new Map();
  HEAVY_SHARDS.forEach((s, i) => s.files.forEach((name) => where.set(name, [...(where.get(name) ?? []), i + 1])));
  for (const name of all) console.log(`${(where.has(name) ? `heavy ${where.get(name).join('+')}` : 'fast').padEnd(10)}${name}`);
  console.log(`${all.length} files: ${fastFiles(all).length} fast, ${heavyFiles().length} heavy in ${SHARD_COUNT} shards`);
  return 0;
}

/** Run each file alone (one after the other) and print its wall time, slowest first. Meant for a quiet machine. */
function timings(opts) {
  const tier = opts.tier ?? 'all';
  const rows = [];
  for (const name of filesFor(tier)) {
    const started = Date.now();
    const result = spawnSync(process.execPath, nodeArgs([name], { extra: opts.extra }), { cwd: ROOT, stdio: 'ignore' });
    rows.push({ name, ms: Date.now() - started, ok: result.status === 0 });
    process.stderr.write('.');
  }
  process.stderr.write('\n');
  const heavy = new Set(heavyFiles());
  const sum = (items) => items.reduce((total, row) => total + row.ms, 0);
  for (const row of rows.sort((a, b) => b.ms - a.ms)) console.log(`${seconds(row.ms).padStart(8)}  ${heavy.has(row.name) ? 'heavy' : 'fast '}  ${row.ok ? '' : 'FAILED '}${row.name}`);
  console.log(`\n${rows.length} files, ${seconds(sum(rows))} one after the other; fast ${seconds(sum(rows.filter((r) => !heavy.has(r.name))))}, heavy ${seconds(sum(rows.filter((r) => heavy.has(r.name))))}.`);
  console.log('Divide by the number of test files node runs at once (cores - 1) for the time of a tier on a CI runner.');
  return rows.every((row) => row.ok) ? 0 : 1;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.command === 'list') return list(opts);
  if (opts.command === 'timings') return timings(opts);
  return run(opts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { console.error(`test-tiers: ${err.message}`); process.exitCode = 2; });
}
