// Integration tests of the whole simulation: the three example plants and 40 seeded random plants are run through the real
// Simulation with every invariant checked after EVERY tick (tests/helpers/sim-invariants.js), the examples are held to the
// outcomes they promise, throughput scales sensibly with the number of vehicles, and the engine is fast enough to simulate
// shifts in seconds. (That the tips printed with the examples are true is tested in tests/sim.experiments.test.js.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../js/sim/engine.js';
import { generateInsights } from '../js/sim/insights.js';
import { EXAMPLES } from '../js/model/examples.js';
import * as L from '../js/model/layout.js';
import { validateLayout } from '../js/model/validate.js';
import {
  assertAllFinite, createSimChecker, exampleLayout, lineLayout, measureRuns, randomPlant, variantOf,
} from './helpers/sim-invariants.js';

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const stationNamed = (layout, name) => layout.stations.find((s) => s.name === name);
const reportStation = (report, layout, name) => report.stations[stationNamed(layout, name).id];
/** Ids of the insights that tell the planner something is wrong. */
const problems = (report, layout) => generateInsights(report, layout).filter((i) => i.severity === 'critical' || i.severity === 'warning').map((i) => i.id);

// ---------------------------------------------------------------------------------------------------------------------
// Invariants on every tick
// ---------------------------------------------------------------------------------------------------------------------

/** Step a simulation tick by tick, checking everything after each tick and the KPI report once a simulated minute. */
function runChecked(layout, seconds, seed) {
  const sim = new Simulation(layout, { seed });
  const checker = createSimChecker(sim);
  const ticks = Math.round(seconds / sim.dt);
  const reportEvery = Math.round(60 / sim.dt);
  for (let i = 1; i <= ticks; i++) {
    sim.step();
    checker.check();
    if (i % reportEvery === 0) checker.checkReport();
  }
  checker.checkReport();
  return { sim, checker };
}

for (const e of EXAMPLES) {
  test(`invariants: ${e.name}: 30 simulated minutes, every invariant after every tick`, () => {
    const { sim, checker } = runChecked(e.build(), 1800, 7);
    assert.ok(sim.logistics.completed > 0, 'the plant produced something');
    assert.ok(checker.ledger.created > 0 && checker.ledger.delivered > 0);
    assert.ok(Math.abs(sim.time - 1800) < 1e-6);
  });
}

test('invariants: 40 seeded random plants, 30 simulated minutes each, every invariant after every tick', () => {
  let live = 0;
  let vehicles = 0;
  const dts = new Set();
  for (let seed = 1; seed <= 40; seed++) {
    try {
      const { sim } = runChecked(randomPlant(seed), 1800);
      if (sim.logistics.completed > 0) live++;
      vehicles += sim.vehicles.length;
      dts.add(sim.dt);
    } catch (err) {
      err.message = `random plant ${seed}: ${err.message}`;
      throw err;
    }
  }
  assert.ok(live >= 20, `${live} of 40 random plants delivered loads: the generator must produce plants that actually work`);
  assert.ok(vehicles >= 100, `${vehicles} vehicles over all plants`);
  assert.ok(dts.size >= 3, 'several time steps were exercised');
});

test('invariants: the random plant generator is deterministic and always valid', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const layout = randomPlant(seed);
    assert.deepEqual(layout, randomPlant(seed));
    assert.deepEqual(L.checkInvariants(layout), []);
    assert.deepEqual(L.normalizeLayout(layout), layout);
  }
  assert.notDeepEqual(randomPlant(1), randomPlant(2));
});

// ---------------------------------------------------------------------------------------------------------------------
// The examples deliver what they promise (2 simulated hours, several seeds)
// ---------------------------------------------------------------------------------------------------------------------

test('Starter: healthy - it delivers, nothing piles up, no deadlock, the AGVs have spare capacity but are not idle', async () => {
  const layout = exampleLayout('starter');
  for (const [i, report] of (await measureRuns(layout)).entries()) {
    const where = `seed ${i + 1}`;
    assert.ok(report.throughput.perHour > 17 && report.throughput.perHour < 23, `${where}: ${report.throughput.perHour.toFixed(1)} pallets/h (one arrives every 3 minutes)`);
    const source = reportStation(report, layout, 'Goods receiving');
    assert.ok(source.yardMax <= 3 && source.yardNow <= 3, `${where}: the source yard stays small (max ${source.yardMax})`);
    assert.equal(report.traffic.deadlocks, 0, where);
    const agv = report.fleets.v1;
    assert.ok(agv.utilization >= 0.2 && agv.utilization <= 0.85, `${where}: AGV utilization ${agv.utilization.toFixed(2)}`);
    assert.ok(report.traffic.waitShare < 0.1, `${where}: wait share ${report.traffic.waitShare.toFixed(3)}`);
    const assembly = reportStation(report, layout, 'Assembly');
    assert.ok(assembly.utilization > 0.5 && assembly.utilization < 0.8, `${where}: assembly ${assembly.utilization.toFixed(2)}`);
    assert.ok(report.leadTime.p95 < 600, `${where}: lead time p95 ${report.leadTime.p95.toFixed(0)} s`);
    assert.deepEqual(problems(report, layout), [], where);
    assertAllFinite(report);
  }
});

test('Two lines + warehouse: busy but feasible - a visible bottleneck workstation, no deadlock, batteries and chargers in use', async () => {
  const layout = exampleLayout('two-lines');
  for (const [i, report] of (await measureRuns(layout)).entries()) {
    const where = `seed ${i + 1}`;
    const util = (name) => reportStation(report, layout, name).utilization;
    const press = util('Press line'); // every product takes two pressings
    const others = [util('Final assembly'), util('Machining')];
    assert.ok(press >= 0.6 && press >= 1.15 * Math.max(...others), `${where}: Press line ${press.toFixed(2)} against ${others.map((x) => x.toFixed(2))}`);
    assert.ok(press < 0.85, `${where}: the bottleneck is visible but not overloaded (${press.toFixed(2)})`);
    assert.equal(report.traffic.deadlocks, 0, where);
    for (const id of ['v1', 'v2']) assert.ok(report.fleets[id].utilization > 0.3 && report.fleets[id].utilization < 0.8, `${where}: ${id} ${report.fleets[id].utilization.toFixed(2)}`);
    const rate = 3600 / 57 / 3; // three raw pallets make one product
    assert.ok(report.throughput.perHour > 0.9 * rate && report.throughput.perHour < 1.1 * rate, `${where}: ${report.throughput.perHour.toFixed(1)} products/h against ${rate.toFixed(1)} arriving`);
    const agvs = report.fleets.v2;
    assert.ok(agvs.shares.charging >= 0.02, `${where}: the AGVs spend ${(agvs.shares.charging * 100).toFixed(1)} % of their time on the chargers`);
    assert.ok(agvs.minBattery > 0.1 && agvs.minBattery < 0.6, `${where}: lowest battery ${agvs.minBattery.toFixed(2)}`);
    assert.equal(agvs.shares.broken, 0, `${where}: no AGV ran empty`);
    assert.equal(report.fleets.v1.minBattery, null, 'the forklifts have no battery');
    assert.deepEqual(problems(report, layout), [], where);
  }
});

test('Congestion lab: queues without a deadlock - the wait share is high, hot spots are reported, the Results tab says so', async () => {
  const layout = exampleLayout('congestion-lab');
  const docks = L.docksOf(layout, stationNamed(layout, 'Packing').id);
  for (const [i, report] of (await measureRuns(layout)).entries()) {
    const where = `seed ${i + 1}`;
    assert.ok(report.traffic.waitShare >= 0.12, `${where}: vehicles wait ${(report.traffic.waitShare * 100).toFixed(1)} % of their driving time`);
    assert.equal(report.traffic.deadlocks, 0, where);
    assert.ok(report.traffic.hotspots.length >= 3 && report.traffic.hotspots[0].wait > 100, `${where}: ${JSON.stringify(report.traffic.hotspots.slice(0, 2))}`);
    const hot = report.traffic.hotspots[0];
    const distance = Math.min(...docks.map(([cx, cy]) => Math.abs(cx - hot.cx) + Math.abs(cy - hot.cy)));
    assert.ok(distance <= 2, `${where}: the hottest cell (${hot.cx},${hot.cy}) is ${distance} cells from a Packing dock`);
    const insights = generateInsights(report, layout);
    assert.ok(insights.some((x) => x.id === 'traffic'), `${where}: ${insights.map((x) => x.id)}`);
    assert.ok(!insights.some((x) => x.severity === 'good'), where);
    assert.ok(report.throughput.perHour > 30, `${where}: the plant still delivers ${report.throughput.perHour.toFixed(1)} loads/h`);
  }
});

test('every example validates cleanly, simulates without NaN and gives the same numbers when run twice', () => {
  for (const e of EXAMPLES) {
    const layout = e.build();
    assert.deepEqual(validateLayout(layout), [], e.id);
    const a = new Simulation(layout, { seed: 3 });
    const b = new Simulation(layout, { seed: 3 });
    a.advance(1800);
    b.advance(1800);
    assertAllFinite(a.kpis());
    assert.equal(JSON.stringify(a.kpis()), JSON.stringify(b.kpis()), e.id);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Scaling and speed
// ---------------------------------------------------------------------------------------------------------------------

test('scaling: on a transport-limited plant more vehicles never reduce the output by more than noise, and the first ones help a lot', async () => {
  const outputs = [];
  for (let n = 1; n <= 7; n++) {
    const layout = lineLayout({ vehicles: n, gap: 16, arrival: 8, cycle: 5, source: { outCap: 200 } });
    outputs.push((await measureRuns(layout, { hours: 1 })).map((r) => r.throughput.perHour));
  }
  for (let n = 1; n < outputs.length; n++) {
    outputs[n].forEach((value, i) => assert.ok(value >= 0.97 * outputs[n - 1][i], `seed ${i + 1}: ${outputs[n - 1][i].toFixed(1)} -> ${value.toFixed(1)} loads/h with vehicle ${n + 1}`));
  }
  const m = outputs.map(mean);
  assert.ok(m[2] > 2.2 * m[0] && m[6] > 2.5 * m[0], `${m.map((x) => x.toFixed(1))} loads/h with 1..7 vehicles`);
});

test('scaling: on the congested lab more vehicles never reduce the output by more than noise either', async () => {
  const output = {};
  for (const n of [6, 8, 10, 12]) {
    const layout = variantOf('congestion-lab', (l) => {
      L.updateStation(l, stationNamed(l, 'AGV parking').id, { params: { slots: 12 } });
      L.updateFleet(l, 'v1', { count: n });
    });
    output[n] = (await measureRuns(layout, { hours: 1 })).map((r) => r.throughput.perHour);
  }
  for (const [a, b] of [[6, 8], [8, 10], [10, 12]]) assert.ok(mean(output[b]) >= 0.97 * mean(output[a]), `${a} -> ${b} AGVs: ${mean(output[a]).toFixed(1)} -> ${mean(output[b]).toFixed(1)} loads/h`);
});

/** Simulated seconds per real second for `seconds` of a plant: the best of three runs, after a warm-up of the JIT. */
function speedFactor(layout, seconds = 3600) {
  new Simulation(layout).advance(600);
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const sim = new Simulation(layout);
    const start = performance.now();
    sim.advance(seconds);
    best = Math.min(best, performance.now() - start);
  }
  return seconds / (best / 1000);
}

test('performance: the engine simulates the Starter plant at least 400x and the Two-lines plant at least 250x real time', (t) => {
  const starter = speedFactor(exampleLayout('starter'));
  const two = speedFactor(exampleLayout('two-lines'));
  const lab = speedFactor(exampleLayout('congestion-lab'));
  t.diagnostic(`simulated time per real second: Starter ${Math.round(starter)}x, Two lines ${Math.round(two)}x, Congestion lab ${Math.round(lab)}x`);
  assert.ok(starter >= 400, `Starter ${Math.round(starter)}x`);
  assert.ok(two >= 250, `Two lines ${Math.round(two)}x`);
  assert.ok(lab >= 250, `Congestion lab ${Math.round(lab)}x`);
});
