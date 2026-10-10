// What the detail collector costs (docs/ENTITY-INSIGHTS-DESIGN.md 8, acceptance S1.5), with LOOSE bounds: a test that fails on a busy CI runner proves nothing, so the bounds
// are the design's gates where they are relative (CPU of the same code with the collector off) and a generous floor where they are absolute. The measured numbers of the build
// are in docs/ARCHITECTURE.md 5.8 and the report; this file logs what it measures.
//   * collector on: at least 500 x real time on the five examples (measured 17,000 to 60,000 x); at most +25 % CPU of "off" on Two lines (best of 9, measured +8 to +12 %)
//   * the 320 x 320 / 225 stations / 100 vehicles plant: collector on at least 200 x here (the gate of the design is 500 x; it is measured by hand, best of several
//     alternating rounds on a quiet machine, with `node scripts/perf-detail.mjs --gate`), at most +40 % over off, typed columns at most 3.5 MB after one simulated hour
//     and also with the leg log full
//   * the queries stay in the tenth-of-a-millisecond range on a full leg log (routesOf below 2 ms)
//   * the collector off is the untouched engine: no listener, no detail object, no extra work per tick other than a pointer test (checked by counting calls)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../js/sim/engine.js';
import { EXAMPLES } from '../js/model/examples.js';
import { Detail, LEG_CAP } from '../js/sim/detail.js';
import { bigPlant320 } from './helpers/big-plant.js';

const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1e6; };
const build = (id, warmup = 600) => { const layout = EXAMPLES.find((e) => e.id === id).build(); layout.settings.warmup = warmup; return layout; };
const log = (...parts) => console.log('    perf:', ...parts);

/** CPU seconds of advance(seconds) on a fresh simulation. */
function timed(layoutFn, on, seconds, seed = 1) {
  const sim = new Simulation(layoutFn(), { seed });
  if (on) sim.enableDetail();
  const t0 = cpu();
  sim.advance(seconds);
  return { cpu: cpu() - t0, sim };
}

test('the collector on runs at least 500 x real time on each of the five examples', () => {
  for (const e of EXAMPLES) {
    let best = Infinity;
    for (let k = 0; k < 3; k++) best = Math.min(best, timed(() => build(e.id), true, 3600).cpu);
    const factor = 3600 / best;
    log(`${e.id}: ${factor.toFixed(0)} x real time with the collector on`);
    assert.ok(factor >= 500, `${e.id}: ${factor.toFixed(0)} x real time with the collector on (gate 500 x)`);
  }
});

test('the collector on costs at most +25 % CPU over off on Two lines (best of 9, interleaved), and changes no figure', () => {
  const attempt = (rounds) => {
    let off = Infinity; let on = Infinity; let textOff = ''; let textOn = '';
    for (let r = 0; r < rounds; r++) {
      for (const which of r % 2 ? ['on', 'off'] : ['off', 'on']) {
        const run = timed(() => build('two-lines'), which === 'on', 3600);
        if (which === 'on') { on = Math.min(on, run.cpu); textOn = JSON.stringify(run.sim.kpis()); } else { off = Math.min(off, run.cpu); textOff = JSON.stringify(run.sim.kpis()); }
      }
    }
    assert.equal(textOn, textOff);
    return on / off - 1;
  };
  let over = attempt(9);
  if (over > 0.25) over = Math.min(over, attempt(12)); // a loaded machine: look again once with more rounds
  log(`Two lines: collector on is ${(over * 100).toFixed(1)} % over off (best of rounds)`);
  assert.ok(over <= 0.25, `+${(over * 100).toFixed(1)} % CPU over off on Two lines (gate +25 %)`);
});

test('the 320 x 320 plant with 225 stations and 100 vehicles: the collector costs at most +40 % over off, runs fast enough, and holds at most 3.5 MB of typed columns after an hour', () => {
  const { layout } = bigPlant320();
  const make = () => structuredClone(layout);
  // 5 minutes of warm-up and 5 measured; off, on, on, off: the best of two each, so that one run that met a busy moment of the machine decides nothing
  const runs = { off: [], on: [] };
  for (const which of ['off', 'on', 'on', 'off']) runs[which].push(timed(make, which === 'on', 600));
  const best = (list) => list.reduce((a, b) => (b.cpu < a.cpu ? b : a));
  const off = best(runs.off); const on = best(runs.on);
  assert.equal(JSON.stringify(runs.on[0].sim.kpis()), JSON.stringify(runs.off[0].sim.kpis()), 'no figure moves');
  const over = on.cpu / off.cpu - 1;
  log(`big plant: off ${(600 / off.cpu).toFixed(0)} x, on ${(600 / on.cpu).toFixed(0)} x real time (${(over * 100).toFixed(1)} % over off)`);
  assert.ok(600 / on.cpu >= 200, `${(600 / on.cpu).toFixed(0)} x real time with the collector on (a floor of 200 x here; the gate of the design is 500 x, measured by hand)`);
  assert.ok(over <= 0.4, `+${(over * 100).toFixed(1)} % over off`);
  const hour = timed(make, true, 3600);
  const det = hour.sim.detail;
  log(`big plant after 1 h: ${(det.memoryBytes / 1024).toFixed(0)} KiB typed columns, ${det.legs.count} legs, ${det.pool.size} paths, ${det.nV} vehicles, ${det.nS} stations`);
  assert.ok(det.memoryBytes <= 3.5 * 1024 * 1024, `${det.memoryBytes} bytes of typed columns`);
  const full = det.memoryBytes - det.legs.bytes + LEG_CAP * 36; // the leg log grows by doubling: the most it can ever hold is 32,768 rows of 36 bytes
  log(`big plant with the leg log full: ${(full / 1024).toFixed(0)} KiB`);
  assert.ok(full <= 3.5 * 1024 * 1024, `${full} bytes of typed columns once the leg log has reached its cap`);
  assert.equal(det.nV, 100); assert.equal(det.nS, 225);
  assert.ok(det.legs.count > 1000, 'and it really recorded the hour');
});

test('queries on a full leg log of 32,768 rows stay fast: routesOf below 2 ms, the others below 5 ms', () => {
  const sim = new Simulation(build('two-lines'), { seed: 1 });
  const det = sim.enableDetail();
  sim.advance(7200);
  const L = det.legs; const have = L.size;
  const rnd = (() => { let s = 12345; return (n) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s % n; }; })();
  L.clear();
  for (let k = 0; k < LEG_CAP; k++) L.push(rnd(det.nV), rnd(2), rnd(det.nS), rnd(det.nS), 0, rnd(Math.max(1, det.pool.size)), k * 0.2, 40, 3, 1, 1, 0);
  assert.equal(L.size, LEG_CAP); assert.ok(have > 0);
  const time = (fn, reps = 100) => { for (let i = 0; i < 10; i++) fn(); const t0 = performance.now(); for (let i = 0; i < reps; i++) fn(); return (performance.now() - t0) / reps; };
  const w = det.windowOf('start');
  const ms = {
    routesOf: time(() => det.routesOf(3, w, [1])), routesAll: time(() => det.routesOf(3, w, [0, 1, 2, 3])), roundOf: time(() => det.roundOf(3, w, 2)), queuesOf: time(() => det.queuesOf(3, w)),
    visitsTo: time(() => det.visitsTo(2, w)), busiest: time(() => det.busiestRoutes(w, 4)), cellUse: time(() => det.cellUse([5, 6, 7]), 20),
  };
  log('full log:', Object.entries(ms).map(([k, v]) => `${k} ${v.toFixed(2)} ms`).join(', '));
  assert.ok(ms.routesOf < 2 && ms.routesAll < 2, `routesOf ${ms.routesOf} / ${ms.routesAll} ms`);
  for (const [k, v] of Object.entries(ms)) assert.ok(v < 5, `${k} ${v} ms`);
  assert.equal(det.legCoverage().wrapped, false);
});

test('the collector off is the untouched engine: no collector, no listener of its own, and the poll is never called', () => {
  const sim = new Simulation(build('two-lines'), { seed: 1 });
  assert.equal(sim.detail, null);
  let polls = 0;
  const orig = Detail.prototype.afterTickSafe;
  Detail.prototype.afterTickSafe = function afterTickSafe(...args) { polls++; return orig.apply(this, args); };
  try {
    sim.advance(600);
    assert.equal(polls, 0, 'a plain simulation never calls the collector');
    sim.enableDetail(); sim.advance(10);
    assert.equal(polls, 100, 'and a collector is polled once per tick (10 s of 0.1 s ticks)');
  } finally { Detail.prototype.afterTickSafe = orig; }
  const quiet = new Simulation(build('two-lines'), { seed: 1 });
  assert.equal(quiet._listeners.size, 0);
});
