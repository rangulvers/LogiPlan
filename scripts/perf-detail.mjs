#!/usr/bin/env node
// What the detail collector (js/sim/detail.js, docs/ARCHITECTURE.md 5.8) costs: the by-hand measurement of acceptance S1.5 of docs/ENTITY-INSIGHTS-DESIGN.md.
//
//   node scripts/perf-detail.mjs                    the five examples and the biggest plant the app allows, collector off against on
//   node scripts/perf-detail.mjs --gate             ... and exit 1 when a gate is missed (collector on below 500 x real time, Two lines more than +25 % over off, columns above 3.5 MB)
//   --rounds N     rounds per plant (default 7 for the examples, 8 for the big plant); the figure is the BEST round (the least disturbed by other work), the median is printed beside it;
//                  the order of "off" and "on" alternates
//   --hours H      simulated hours per example round (default 2: the Starter takes 30 ms of CPU per simulated hour, too short to resolve a few percent in less)
//   --seconds S    simulated seconds per big-plant round (default 1200)
//   --skip-big     only the examples
//
// What is timed: Simulation#advance of a freshly built Simulation in CPU time of this process (process.cpuUsage: user + system, all threads), the way scripts/perf-baseline.mjs
// does; building it is not timed. "Off" is the same tree with `sim.detail === null` (the collector is optional); to compare the off path with an OLDER tree use
// `scripts/perf-baseline.mjs --root`. The machine is shared and the same code moves by +-10 % between runs: read the best round, look at the spread, repeat when the load is high.
// The big plant is tests/helpers/big-plant.js: 320 x 320 cells, about 17,000 road cells, 225 stations, 100 vehicles.
import os from 'node:os';
import { Simulation } from '../js/sim/engine.js';
import { EXAMPLES } from '../js/model/examples.js';
import { LEG_CAP } from '../js/sim/detail.js';
import { bigPlant320 } from '../tests/helpers/big-plant.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const num = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : fallback; };
const GATE_X = 500;
const GATE_OVER_TWO_LINES = 0.25;
const GATE_BYTES = 3.5 * 1024 * 1024;
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1e6; };
const problems = [];

/** CPU seconds of advance(seconds) on a fresh simulation, with or without the collector, and the KPI text (it must not depend on the collector). */
function once(makeLayout, on, seconds) {
  const sim = new Simulation(makeLayout(), { seed: 1 });
  if (on) sim.enableDetail();
  const t0 = cpu();
  sim.advance(seconds);
  return { secs: cpu() - t0, text: JSON.stringify(sim.kpis()), sim };
}

/** Best CPU seconds of `rounds` interleaved rounds of off and on. */
function compare(makeLayout, seconds, rounds) {
  const best = { off: Infinity, on: Infinity }; const text = {}; const all = { off: [], on: [] };
  once(makeLayout, true, Math.min(seconds, 300)); // one short untimed run: the first run of fresh code is slower than all that follow
  for (let r = 0; r < rounds; r++) {
    for (const which of r % 2 ? ['on', 'off'] : ['off', 'on']) {
      const run = once(makeLayout, which === 'on', seconds);
      best[which] = Math.min(best[which], run.secs); all[which].push(run.secs); text[which] = run.text;
    }
  }
  const median = (list) => { const t = [...list].sort((a, b) => a - b); return t.length % 2 ? t[(t.length - 1) / 2] : (t[t.length / 2 - 1] + t[t.length / 2]) / 2; };
  return { best, all, same: text.off === text.on, over: best.on / best.off - 1, overMedian: median(all.on) / median(all.off) - 1 };
}

console.log(`Node ${process.version}, ${os.cpus().length} x ${os.cpus()[0].model.trim()}, load average at start ${os.loadavg()[0].toFixed(2)}\n`);

const hours = num('--hours', 2);
const rounds = num('--rounds', 7);
console.log(`examples, ${hours} simulated hour(s) per round, best of ${rounds} rounds`);
console.log('  example               off x real time   on x real time   on over off (best / median)   KPIs equal');
for (const e of EXAMPLES) {
  const r = compare(() => { const layout = e.build(); layout.settings.warmup = 600; return layout; }, 3600 * hours, rounds);
  const fx = (secs) => String(Math.round(3600 * hours / secs)).padStart(10);
  console.log(`  ${e.id.padEnd(20)} ${fx(r.best.off)}   ${fx(r.best.on)}   ${`${(r.over * 100).toFixed(1)} % / ${(r.overMedian * 100).toFixed(1)} %`.padStart(24)}   ${r.same}`);
  if (3600 * hours / r.best.on < GATE_X) problems.push(`${e.id}: ${Math.round(3600 * hours / r.best.on)} x real time with the collector on (gate ${GATE_X} x)`);
  if (e.id === 'two-lines' && r.over > GATE_OVER_TWO_LINES) problems.push(`two-lines: +${(r.over * 100).toFixed(1)} % over off (gate +${GATE_OVER_TWO_LINES * 100} %)`);
  if (!r.same) problems.push(`${e.id}: the KPI report changed with the collector on`);
}

if (!flag('--skip-big')) {
  const seconds = num('--seconds', 1200);
  const big = num('--rounds', 8);
  const { layout, stations, roadCells } = bigPlant320();
  console.log(`\nbiggest plant (320 x 320 cells, ${roadCells} road cells, ${stations} stations, 100 vehicles), ${seconds} simulated s per round, best of ${big} rounds`);
  const r = compare(() => structuredClone(layout), seconds, big);
  const spread = (list) => list.map((s) => Math.round(seconds / s)).sort((a, b) => b - a).join(' ');
  console.log(`  collector off  ${Math.round(seconds / r.best.off)} x real time    (rounds: ${spread(r.all.off)})`);
  console.log(`  collector on   ${Math.round(seconds / r.best.on)} x real time    (rounds: ${spread(r.all.on)})   ${(r.over * 100).toFixed(1)} % over off by the best round, ${(r.overMedian * 100).toFixed(1)} % by the median; KPIs equal: ${r.same}`);
  if (seconds / r.best.on < GATE_X) problems.push(`big plant: ${Math.round(seconds / r.best.on)} x real time with the collector on (gate ${GATE_X} x; build the sample-and-hold lever of the design, section 8)`);
  const hour = once(() => structuredClone(layout), true, 3600).sim.detail;
  const full = hour.memoryBytes - hour.legs.bytes + LEG_CAP * 36;
  console.log(`  after 1 simulated hour: ${(hour.memoryBytes / 1024).toFixed(0)} KiB of typed columns (${hour.legs.count} legs, ${hour.pool.size} paths); with the leg log full (${LEG_CAP} rows) ${(full / 1024).toFixed(0)} KiB (gate ${GATE_BYTES / 1024} KiB)`);
  if (full > GATE_BYTES) problems.push(`big plant: ${Math.round(full / 1024)} KiB of typed columns with a full leg log (gate ${GATE_BYTES / 1024} KiB)`);
}

console.log(problems.length ? `\nGates missed:\n  ${problems.join('\n  ')}` : '\nAll gates met.');
if (flag('--gate') && problems.length) process.exit(1);
