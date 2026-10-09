#!/usr/bin/env node
// Performance baseline of the simulation: CPU seconds per simulated hour of the three example plants (docs/WAREHOUSE-DESIGN.md 10.5).
//
//   node scripts/perf-baseline.mjs                      measure the tree this script lives in and print a table
//   node scripts/perf-baseline.mjs --write              ... and record it in tests/fixtures/golden/perf-baseline.json
//   node scripts/perf-baseline.mjs --compare            ... and print the change against the recorded numbers
//   node scripts/perf-baseline.mjs --root A --root B    measure several checkouts in turn within the same rounds (order alternates, so a
//                                                       busy moment hits both) and print the ratio of each to the first. Use it for
//                                                       "before" (a pristine copy, e.g. git archive HEAD | tar -x -C DIR) against "after".
//   --runs N       rounds per example (default 9); the figure is the BEST round (the least disturbed by other work on the machine)
//   --hours H      simulated hours per round (default 8, the default run length of a plant; a run of 1 hour of the Starter takes 60 ms of CPU, too short to resolve 2 %)
//   --seed S       seed of the runs (default 1)
//   --json         print the measurements of every --root as JSON instead of the table (for scripts that run several processes)
//
// What is timed: Simulation#advance(3600 * hours) of a freshly built Simulation, in CPU time of this process (process.cpuUsage, user +
// system, all threads including the garbage collector), the way tests/sim.traffic.perf.test.js times. Wall clock is meaningless on a
// busy machine. Building the Simulation is not timed. Each round runs the three examples in turn.
//
// The gate (10.5): within 10 % of the recorded figures for the legacy examples (manual line of the pull request); milestone M0 itself
// was held to +-2 %. CPU time still moves by a few percent between runs of the same code on a shared machine, which is why the best of
// several rounds is used and why a before/after comparison should use --root with both trees in one run.
import os from 'node:os';
import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { GOLDEN_DIR, PERF_FILE, ROOT, loadTree, writeGolden } from '../tests/helpers/golden.js';

function parseArgs(argv) {
  const opts = { runs: 9, hours: 8, seed: 1, roots: [], write: false, compare: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write') opts.write = true;
    else if (arg === '--compare') opts.compare = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--runs') opts.runs = Number(argv[++i]);
    else if (arg === '--hours') opts.hours = Number(argv[++i]);
    else if (arg === '--seed') opts.seed = Number(argv[++i]);
    else if (arg === '--root') opts.roots.push(path.resolve(argv[++i]));
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!(opts.runs >= 1 && opts.hours > 0)) throw new Error('--runs needs a number of at least 1 and --hours a positive number');
  if (!opts.roots.length) opts.roots.push(ROOT);
  if (opts.write && opts.roots.length > 1) throw new Error('--write records one tree: give at most one --root');
  return opts;
}

const cpuNow = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1e6;
};
const median = (list) => {
  const s = [...list].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** One timed run: CPU seconds and wall seconds of advance() on a freshly built simulation. */
function timeOne(tree, example, seed, seconds) {
  const sim = new tree.Simulation(example.build(), { seed });
  const wall0 = performance.now();
  const cpu0 = cpuNow();
  sim.advance(seconds);
  return { cpu: cpuNow() - cpu0, wall: (performance.now() - wall0) / 1000 };
}

async function measure(opts) {
  const trees = [];
  for (const root of opts.roots) trees.push({ root, tree: await loadTree(root), runs: new Map() });
  const ids = trees[0].tree.EXAMPLES.map((e) => e.id);
  const seconds = 3600 * opts.hours;
  // one untimed hour of each example per tree: the first run of fresh code is slower than all that follow
  for (const t of trees) for (const ex of t.tree.EXAMPLES) timeOne(t.tree, ex, opts.seed, 3600);
  for (let round = 0; round < opts.runs; round++) {
    const order = round % 2 ? [...trees].reverse() : trees;
    for (const id of ids) {
      for (const t of order) {
        const ex = t.tree.EXAMPLES.find((e) => e.id === id);
        if (!t.runs.has(id)) t.runs.set(id, []);
        t.runs.get(id).push(timeOne(t.tree, ex, opts.seed, seconds));
      }
    }
  }
  return trees.map((t) => ({
    root: t.root,
    examples: Object.fromEntries(ids.map((id) => {
      const cpu = t.runs.get(id).map((r) => r.cpu);
      const wall = t.runs.get(id).map((r) => r.wall);
      const perHour = (x) => Number((x / opts.hours).toFixed(5));
      return [id, {
        cpuSecondsPerSimulatedHour: perHour(Math.min(...cpu)),
        cpuSecondsMedian: perHour(median(cpu)),
        cpuSecondsWorst: perHour(Math.max(...cpu)),
        wallSecondsBest: perHour(Math.min(...wall)),
        timesRealTime: Math.round(3600 / (Math.min(...cpu) / opts.hours)),
      }];
    })),
  }));
}

const fmt = (x, d = 3) => x.toFixed(d);
const signed = (x, d = 1) => `${x >= 0 ? '+' : ''}${x.toFixed(d)} %`;
const change = (now, ref) => (now / ref - 1) * 100;
function printTable(result, base, baseLabel) {
  console.log(`${path.relative(process.cwd(), result.root) || '.'}`);
  console.log(`  example          best CPU s/h   median   worst    x real time${base ? `   best vs ${baseLabel}   median vs ${baseLabel}` : ''}`);
  for (const [id, r] of Object.entries(result.examples)) {
    const ref = base && base.examples[id];
    const vs = ref ? `   ${signed(change(r.cpuSecondsPerSimulatedHour, ref.cpuSecondsPerSimulatedHour)).padStart(14)}   ${signed(change(r.cpuSecondsMedian, ref.cpuSecondsMedian)).padStart(16)}` : '';
    console.log(`  ${id.padEnd(16)} ${fmt(r.cpuSecondsPerSimulatedHour, 4).padStart(8)}   ${fmt(r.cpuSecondsMedian, 4).padStart(6)}   ${fmt(r.cpuSecondsWorst, 4).padStart(6)}   ${String(Math.round(3600 / r.cpuSecondsPerSimulatedHour)).padStart(8)}${vs}`);
  }
}

const opts = parseArgs(process.argv.slice(2));
const load0 = os.loadavg()[0];
const results = await measure(opts);
if (opts.json) {
  console.log(JSON.stringify(results));
  process.exit(0);
}
console.log(`Node ${process.version}, ${os.cpus().length} x ${os.cpus()[0].model.trim()}, load average at start ${fmt(load0, 2)}, best of ${opts.runs} rounds, ${opts.hours} simulated hour(s), seed ${opts.seed}\n`);
results.forEach((r, i) => printTable(r, i ? results[0] : null, 'first tree'));

if (opts.compare) {
  const file = path.join(GOLDEN_DIR, PERF_FILE);
  if (!existsSync(file)) throw new Error(`${PERF_FILE} has not been recorded yet: run with --write on a known good tree`);
  const recorded = JSON.parse(readFileSync(file, 'utf8'));
  console.log(`\nAgainst the recorded numbers (${recorded.recordedOn}, load average ${recorded.machine.loadAverageAtStart}):`);
  printTable(results[0], { examples: Object.fromEntries(Object.entries(recorded.examples).map(([id, r]) => [id, r])) }, 'recorded');
}

if (opts.write) {
  const record = {
    what: 'CPU seconds per simulated hour of the three example plants, seed 1, best of the rounds (scripts/perf-baseline.mjs). For people: no test reads these numbers.',
    caveat: 'Measured with process.cpuUsage (user + system, all threads) on a shared machine: the same code moves by a few percent between runs, and the absolute figures depend on the machine and its load at the time. Compare trees with --root in one run, or re-measure both on the machine you use; do not compare these figures with another machine.',
    recordedOn: new Date().toISOString().slice(0, 10),
    recordedAt: 'milestone M0, before any change of production code (the tree with the dock work merged)',
    node: process.version,
    machine: { cpus: os.cpus().length, model: os.cpus()[0].model.trim(), platform: `${os.platform()} ${os.release()}`, loadAverageAtStart: Number(load0.toFixed(2)) },
    method: { runs: opts.runs, simulatedHoursPerRun: opts.hours, seed: opts.seed, timed: 'Simulation#advance(3600 * simulatedHoursPerRun) on a freshly built simulation (KPI warm-up 600 s), after one untimed run of 1 simulated hour per example; the figure is the best round, per simulated hour' },
    examples: results[0].examples,
  };
  writeGolden(PERF_FILE, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`\nRecorded in tests/fixtures/golden/${PERF_FILE}`);
}
