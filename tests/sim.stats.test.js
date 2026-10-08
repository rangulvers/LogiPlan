import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Stats, SampleSet, percentile, SERIES_INTERVAL, SERIES_MAX_POINTS, LEAD_SAMPLE_CAP, HOTSPOT_COUNT, DEADLOCK_EVENT_CAP, BACKLOG_INTERVAL,
} from '../js/sim/stats.js';
import { createFakeSim, standardPlant, syntheticLayout } from './helpers/fake-sim.js';

const close = (actual, expected, eps = 1e-9, what = 'value') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: expected ${expected}, got ${actual}`);

/** Standard plant + fake sim + attached Stats. Default fleets: v1 = 3 AGVs, v2 = 2 forklifts. */
function setup(plantOpts = {}, simOpts) {
  const layout = standardPlant(plantOpts);
  const sim = createFakeSim(layout, simOpts);
  const stats = (sim.stats = new Stats(sim));
  return { layout, sim, stats };
}

/** Fails on NaN, Infinity or undefined anywhere in a (nested) value, including typed arrays. */
function assertClean(value, path = 'report') {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `${path} is ${value}`);
  else if (Array.isArray(value) || ArrayBuffer.isView(value)) value.forEach((v, i) => assertClean(v, `${path}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) assertClean(v, `${path}.${k}`);
  else assert.notEqual(value, undefined, `${path} is undefined`);
}

const sum = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);

// ---- percentile and the lead-time sample store -----------------------------------------------------------

test('percentile interpolates linearly between ranks and clamps p', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.95), 7);
  const v = [10, 20, 30, 40];
  assert.equal(percentile(v, 0), 10);
  assert.equal(percentile(v, 1), 40);
  close(percentile(v, 0.5), 25); // rank 1.5
  close(percentile(v, 0.9), 37); // rank 2.7
  assert.equal(percentile(v, 3), 40);
  assert.equal(percentile(v, -1), 10);
});

test('SampleSet: exact moments and percentiles below the cap; the cache follows every new sample; non-finite ignored', () => {
  const s = new SampleSet();
  for (const x of [5, 1, 9, 3]) s.add(x);
  assert.equal(s.percentile(0.5), 4);
  assert.equal(s.percentile(0.5), 4, 'asking twice changes nothing');
  s.add(0);
  assert.equal(s.percentile(0.5), 3, 'a new sample is part of the next answer');
  assert.equal(s.percentile(0), 0);
  assert.equal(s.percentile(1), 9);
  assert.equal(s.add(NaN), false);
  assert.equal(s.add(Infinity), false);
  assert.equal(s.count, 5);
  assert.equal(s.size, 5);
  assert.deepEqual([s.sum, s.min, s.max], [18, 0, 9]);
  assert.equal(new SampleSet().percentile(0.5), null);
  s.clear();
  assert.deepEqual([s.count, s.size, s.percentile(0.5)], [0, 0, null]);
});

test('SampleSet compacts a full level by keeping every second sample of the sorted level (deterministic, hand-derived)', () => {
  const s = new SampleSet(4);
  for (let i = 0; i < 10; i++) s.add(i);
  // 0..4 overflow level 0: sorted pairs (0,1) (2,3) keep 0 and 2 (weight 2), 4 stays; 4..8 again: keep 5 and 7, 8 stays; then 9
  // retained: 0 2 5 7 (weight 2 each) and 8 9 (weight 1) = 10 observations standing for 0 0 2 2 5 5 7 7 8 9
  assert.equal(s.count, 10);
  assert.equal(s.size, 6);
  assert.deepEqual([s.min, s.max, s.sum], [0, 9, 45], 'moments stay exact even though most samples were compacted');
  assert.equal(s.percentile(0), 0);
  assert.equal(s.percentile(1), 9);
  assert.equal(s.percentile(0.5), 5);
  close(s.percentile(0.9), 8.1);
});

test('SampleSet percentiles do not depend on the order in which the samples arrive', () => {
  const n = 20000;
  const orders = {
    ascending: (i) => i,
    descending: (i) => n - 1 - i,
    zigzag: (i) => (i % 2 === 0 ? i / 2 : n - 1 - (i - 1) / 2),
    scattered: (i) => (i * 7919) % n, // a permutation of 0..n-1
    blocks: (i) => ((i % 8) * (n / 8)) + Math.floor(i / 8), // 8 interleaved ranges
  };
  for (const [name, at] of Object.entries(orders)) {
    const s = new SampleSet(500);
    for (let i = 0; i < n; i++) s.add(at(i));
    assert.equal(s.count, n, name);
    assert.ok(s.size <= 500 * 1.5 * 7, `${name}: bounded memory (${s.size})`);
    for (const p of [0.01, 0.1, 0.5, 0.9, 0.95, 0.99]) {
      const exact = p * (n - 1);
      assert.ok(Math.abs(s.percentile(p) - exact) <= 0.01 * n, `${name}: p${p * 100} is ${s.percentile(p)}, exact ${exact}`);
    }
  }
});

test('SampleSet keeps every class of a periodic arrival pattern (two products alternating)', () => {
  const s = new SampleSet(100);
  for (let i = 0; i < 20000; i++) s.add(i % 2 === 0 ? 100 : 500);
  assert.equal(s.percentile(0.1), 100);
  assert.equal(s.percentile(0.9), 500);
  assert.equal(s.percentile(0.95), 500);
  close(s.sum / s.count, 300);
  for (const period of [3, 4, 8, 16]) {
    const t = new SampleSet(64);
    for (let i = 0; i < 16000; i++) t.add((i % period) * 10);
    const top = (period - 1) * 10;
    assert.equal(t.percentile(1), top, `period ${period}`);
    assert.ok(t.percentile(0.99) >= top - 10, `period ${period}: the slowest class survives, p99 = ${t.percentile(0.99)}`);
    assert.ok(t.percentile(0.01) <= 10, `period ${period}: the fastest class survives`);
  }
});

test('SampleSet at the default cap: bounded memory, exact moments, percentiles stay representative', () => {
  assert.equal(LEAD_SAMPLE_CAP, 50000);
  const build = () => {
    const s = new SampleSet();
    for (let i = 0; i < 120000; i++) s.add(i);
    return s;
  };
  const s = build();
  assert.ok(s.size <= LEAD_SAMPLE_CAP * 3, `retained ${s.size}`);
  assert.equal(s.count, 120000);
  assert.equal(s.sum / s.count, 59999.5);
  assert.deepEqual([s.min, s.max], [0, 119999]);
  assert.ok(Math.abs(s.percentile(0.5) - 59999.5) <= 4);
  assert.ok(Math.abs(s.percentile(0.95) - 113999.05) <= 4);
  for (const p of [0.1, 0.5, 0.9]) assert.equal(s.percentile(p), build().percentile(p), 'same input, same answer');
});

test('SampleSet: reading percentiles of a large compacted set is cheap and repeatable', () => {
  const s = new SampleSet();
  for (let i = 0; i < 400000; i++) s.add((i * 7919) % 100003);
  const t0 = performance.now();
  const first = [0.5, 0.9, 0.95].map((p) => s.percentile(p));
  s.add(1);
  const second = [0.5, 0.9, 0.95].map((p) => s.percentile(p));
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `two sets of percentiles took ${ms.toFixed(0)} ms`);
  first.forEach((v, i) => assert.ok(Math.abs(v - second[i]) <= 50, 'one extra sample moves nothing'));
});

// ---- window, warm-up, reset -----------------------------------------------------------------------------

test('window: warmingUp until settings.warmup has passed; start/end/duration follow the sampled time', () => {
  const { sim, stats } = setup({ settings: { warmup: 120 } });
  assert.equal(stats.report().window.warmingUp, true);
  sim.advance(100);
  assert.deepEqual(stats.report().window, { start: 0, end: 100, duration: 100, warmingUp: true });
  sim.advance(20);
  assert.equal(stats.report().window.warmingUp, false, 'time 120 is not < warmup 120');
  stats.reset(); // the engine does this when the clock reaches the warm-up
  sim.advance(30);
  assert.deepEqual(stats.report().window, { start: 120, end: 150, duration: 30, warmingUp: false });
});

test('sample ignores invalid tick lengths', () => {
  const { stats } = setup();
  for (const dt of [0, -1, NaN, Infinity, undefined]) stats.sample(dt);
  assert.equal(stats.report().window.duration, 0);
});

test('a zero-length window reports zeros and nulls, never NaN or Infinity, and survives JSON', () => {
  const { stats } = setup({ fleets: [{ count: 2, battery: { enabled: true } }] });
  const r = stats.report();
  assertClean(r);
  assert.deepEqual(r.leadTime, { count: 0, mean: null, min: null, p50: null, p90: null, p95: null, max: null });
  assert.deepEqual([r.throughput.total, r.throughput.perHour, r.wip.mean], [0, 0, 0]);
  assert.deepEqual(r.throughput.bySink.D, { name: 'Shipping', count: 0, perHour: 0 });
  assert.equal(r.fleets.v1.utilization, 0);
  assert.deepEqual(r.fleets.v1.shares, { driving: 0, waiting: 0, loading: 0, unloading: 0, idle: 1, parked: 0, charging: 0, broken: 0 });
  assert.equal(r.fleets.v1.minBattery, null);
  assert.equal(r.fleets.v1.emptyShare, null);
  assert.equal(r.traffic.waitShare, 0);
  assert.deepEqual(r.series, { interval: SERIES_INTERVAL, t: [], throughput: [], wip: [], vehiclesWorking: [], vehiclesWaiting: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
  const h = stats.heat();
  assert.deepEqual([h.maxEdgePasses, h.maxEdgeWait, h.maxNodeWait], [0, 0, 0]);
});

test('a sim that has no logistics or traffic yet still yields a clean empty report', () => {
  const stats = new Stats({ time: 0, layout: standardPlant(), settings: {} });
  stats.sample(1);
  stats.onEvent('loadCompleted', { leadTime: 5 });
  const r = stats.report();
  assertClean(r);
  assert.deepEqual(r.stations, {});
  assert.equal(stats.heat().edgePasses.length, 0);
});

test('reset starts a fresh window: accumulators are zero, cumulative counters turn into deltas', () => {
  const { sim, stats } = setup({ params: { B: { machines: 2 } } });
  const B = sim.st('B');
  sim.setMachines('B', ['busy', 'busy']);
  sim.veh('v1#1').state = 'toPickup';
  B.produced = 10; B.consumed = 8; B.arrivals = 12;
  sim.advance(100, (s, i) => { if (i % 10 === 0) s.complete('D', 50); });
  sim.deliver('v1#1', 'f3', { waitForPickup: 5, transit: 6 });
  sim.drive('v1#1', 40, { loaded: true });
  sim.addWait({ vehicle: 4, driving: 50, node: 40, edge: 1 });
  sim.pass(1, 3);
  sim.deadlock({ nodes: [40], vehicles: ['v1#1'] });
  sim.setLive(5);
  assert.ok(stats.report().throughput.total > 0);

  stats.reset();
  const r = stats.report();
  assertClean(r);
  assert.equal(r.window.start, 100);
  assert.equal(r.window.duration, 0);
  assert.equal(r.throughput.total, 0);
  assert.equal(r.leadTime.count, 0);
  assert.deepEqual(r.wip, { mean: 0, max: 5, now: 5 }, 'max never drops below the live value');
  assert.equal(r.stations.B.utilization, 0);
  assert.equal(r.stations.B.produced, 0);
  assert.equal(r.fleets.v1.trips, 0);
  assert.equal(r.fleets.v1.distance, 0);
  assert.equal(r.fleets.v1.avgPickupWait, null);
  assert.equal(r.orders.completed, 0);
  assert.equal(r.flows.f3.trips, 0);
  assert.deepEqual(r.traffic.hotspots, []);
  assert.deepEqual(r.traffic.deadlockEvents, []);
  assert.deepEqual([r.traffic.vehicleWait, r.traffic.deadlocks], [0, 0]);
  assert.deepEqual(r.series.t, []);
  const h = stats.heat();
  assert.deepEqual([h.maxEdgePasses, h.maxEdgeWait, h.maxNodeWait], [0, 0, 0]);

  // activity after the reset is reported on its own
  B.produced += 5; B.consumed += 4; B.arrivals += 6;
  sim.deliver('v1#1', 'f3', { waitForPickup: 7, transit: 9 });
  sim.drive('v1#1', 10);
  sim.addWait({ vehicle: 1, driving: 10, node: 40, edge: 1 });
  sim.advance(20);
  const after = stats.report();
  assert.deepEqual([after.stations.B.produced, after.stations.B.consumed, after.stations.B.arrivals], [5, 4, 6]);
  assert.deepEqual([after.fleets.v1.trips, after.fleets.v1.distance, after.fleets.v1.emptyShare], [1, 10, 1]);
  assert.equal(after.fleets.v1.avgPickupWait, 7);
  assert.equal(after.traffic.vehicleWait, 1);
  assert.equal(stats.heat().nodeWait[40], 1);
});

// ---- stations ---------------------------------------------------------------------------------------------

test('workstation shares are exact machine-time fractions and every outage is counted once', () => {
  const { sim, stats } = setup({ params: { B: { machines: 2 } } });
  const B = sim.st('B');
  const phase = (seconds, states, inCount, outCount, fill) => {
    sim.setMachines('B', states);
    Object.assign(B, { inCount, outCount, fill });
    sim.advance(seconds);
  };
  phase(60, ['busy', 'idle'], 2, 0, 0.25);
  phase(40, ['busy', 'blocked'], 4, 1, 0.5);
  phase(60, ['down', 'busy'], 0, 3, 0);
  phase(20, ['busy', 'busy'], 0, 3, 0);
  phase(20, ['down', 'busy'], 0, 3, 0);
  // 200 s x 2 machines = 400 machine-seconds: busy 120 + 100, idle 60, blocked 40, down 60 + 20
  const b = stats.report().stations.B;
  close(b.utilization, 220 / 400, 1e-12);
  close(b.starved, 60 / 400, 1e-12);
  close(b.blocked, 40 / 400, 1e-12);
  close(b.down, 80 / 400, 1e-12);
  close(b.utilization + b.starved + b.blocked + b.down, 1, 1e-12);
  assert.equal(b.breakdowns, 2);
  close(b.avgIn, 1.4, 1e-12);
  assert.equal(b.maxIn, 4);
  close(b.avgOut, 1.7, 1e-12);
  assert.equal(b.maxOut, 3);
  close(b.avgFill, 0.175, 1e-12);
  assert.equal(b.maxFill, 0.5);
  assert.equal(b.type, 'process');
  assert.equal(b.name, 'Press');
});

test('a workstation without machines is down for the whole window, like the engine says, and its shares add up to 1', () => {
  const { sim, stats } = setup({ params: { B: { machines: 0 } } });
  assert.equal(sim.st('B').state, 'down', 'precondition: logistics reports a workstation without machines as down');
  sim.advance(10);
  const b = stats.report().stations.B;
  assert.deepEqual([b.utilization, b.starved, b.blocked, b.down, b.breakdowns], [0, 0, 0, 1, 0]);
  assertClean(stats.report());
});

test('a machine that is already down when the window starts is not a new breakdown', () => {
  const { sim, stats } = setup();
  sim.setMachines('B', ['down']);
  stats.reset();
  sim.advance(10);
  assert.equal(stats.report().stations.B.breakdowns, 0);
  assert.equal(stats.report().stations.B.down, 1);
  sim.setMachines('B', ['busy']);
  sim.advance(5);
  sim.setMachines('B', ['down']);
  sim.advance(5);
  assert.equal(stats.report().stations.B.breakdowns, 1);
});

test('source: blocked share, utilization and yard; storage: average fill and empty/full shares', () => {
  const { sim, stats } = setup();
  const A = sim.st('A');
  const S = sim.st('S');
  const phase = (seconds, sourceState, yard, fill) => {
    Object.assign(A, { state: sourceState, yard });
    S.fill = fill;
    sim.advance(seconds);
  };
  phase(20, 'normal', 0, 0);
  phase(20, 'normal', 0, 0.5);
  phase(20, 'blocked', 2, 0.5);
  phase(20, 'blocked', 5, 1);
  phase(20, 'blocked', 5, 1);
  A.yard = 3; // the live value is reported as yardNow, the peak as yardMax
  const r = stats.report().stations;
  close(r.A.blocked, 0.6, 1e-12);
  close(r.A.utilization, 0.4, 1e-12);
  assert.deepEqual([r.A.yardMax, r.A.yardNow], [5, 3]);
  close(r.S.avgFill, 0.6, 1e-12);
  close(r.S.utilization, 0.6, 1e-12);
  close(r.S.starved, 0.2, 1e-12);
  close(r.S.blocked, 0.4, 1e-12);
  assert.equal(r.S.maxFill, 1);
  assert.deepEqual([r.B.yardMax, r.B.yardNow], [0, 0], 'only sources have a yard');
});

test('wip is the time-weighted mean of live loads with its maximum and current value', () => {
  const { sim, stats } = setup();
  sim.setLive(2);
  sim.advance(50);
  sim.setLive(6);
  sim.advance(50);
  assert.deepEqual(stats.report().wip, { mean: 4, max: 6, now: 6 });
});

// ---- throughput, lead time, orders ----------------------------------------------------------------------

test('throughput and lead time come from loadCompleted events', () => {
  const { sim, stats } = setup();
  sim.advance(100, (s, i) => {
    if (i === 10) s.complete('D', 100);
    if (i === 50) s.complete('D', 200);
    if (i === 90) s.complete('D', 300);
  });
  const r = stats.report();
  assert.equal(r.throughput.total, 3);
  close(r.throughput.perHour, 108, 1e-9);
  assert.deepEqual(r.throughput.bySink.D, { name: 'Shipping', count: 3, perHour: r.throughput.perHour });
  assert.equal(r.leadTime.count, 3);
  close(r.leadTime.mean, 200);
  close(r.leadTime.min, 100);
  close(r.leadTime.p50, 200);
  close(r.leadTime.p90, 280);
  close(r.leadTime.p95, 290);
  close(r.leadTime.max, 300);
});

test('loadCompleted: lead time falls back to t - createdAt; unknown stations still count in the total', () => {
  const { stats } = setup();
  stats.onEvent('loadCompleted', { load: { createdAt: 40 }, station: 'D', t: 100 });
  stats.onEvent('loadCompleted', { station: { id: 'nowhere' }, leadTime: 10 });
  stats.onEvent('loadCompleted', { station: 'D' }); // no lead time derivable: counted as throughput, not as a sample
  const r = stats.report();
  assert.equal(r.throughput.total, 3);
  assert.equal(r.throughput.bySink.D.count, 2);
  assert.deepEqual([r.leadTime.count, r.leadTime.min, r.leadTime.max], [2, 10, 60]);
});

test('orderDelivered feeds order, fleet and flow averages; backlog counts loads that are ready', () => {
  const { sim, stats } = setup();
  sim.deliver('v1#1', 'f3', { qty: 1, waitForPickup: 10, transit: 20 });
  sim.deliver('v1#2', 'f3', { qty: 3, waitForPickup: 30, transit: 40 });
  sim.deliver('v2#1', 'f4', { qty: 2, waitForPickup: 50, transit: 60 });
  sim.addReadyLoads('f3', 3);
  sim.addReadyLoads('f3', 1, { readyAt: 9999 });
  sim.advance(10);
  const r = stats.report();
  assert.deepEqual(r.orders, { completed: 3, avgPickupWait: 30, avgTransit: 40 });
  assert.deepEqual([r.fleets.v1.avgPickupWait, r.fleets.v1.avgTransit], [20, 30]);
  assert.deepEqual([r.fleets.v2.avgPickupWait, r.fleets.v2.avgTransit], [50, 60]);
  assert.deepEqual(r.flows.f3, { from: 'B', to: 'C', delivered: 4, trips: 2, avgPickupWait: 20, avgTransit: 30, backlog: 3, avgBacklog: 3 });
  assert.deepEqual([r.flows.f4.delivered, r.flows.f4.trips], [2, 1]);
  assert.deepEqual([r.flows.f1.trips, r.flows.f1.avgPickupWait, r.flows.f1.backlog, r.flows.f1.avgBacklog], [0, null, 0, 0]);
});

test('backlog counts loads that are ready and that no vehicle has claimed; claimed loads already have a vehicle on the way', () => {
  const { sim, stats } = setup();
  sim.addReadyLoads('f3', 2);
  sim.addReadyLoads('f3', 3, { claimed: true });
  sim.addReadyLoads('f3', 4, { readyAt: 9999 }); // still in dwell
  sim.advance(1);
  assert.equal(stats.report().flows.f3.backlog, 2);
  sim.st('B').outQ.get('f3').forEach((load) => { load.claimed = true; }); // a vehicle takes the last two
  assert.equal(stats.report().flows.f3.backlog, 0);
});

test('avgBacklog is the mean of the readings taken every BACKLOG_INTERVAL seconds, and a short window falls back to the live value', () => {
  assert.equal(BACKLOG_INTERVAL, 5);
  const { sim, stats } = setup();
  sim.addReadyLoads('f3', 2);
  sim.advance(2);
  const early = stats.report().flows.f3;
  assert.deepEqual([early.backlog, early.avgBacklog], [2, 2], 'no reading yet: the live value');
  // readings at 5, 10 (two loads) and 15, 20 s (six loads)
  sim.advance(18, (s, i) => {
    if (i === 8) {
      s.clearReadyLoads('f3');
      s.addReadyLoads('f3', 6);
    }
  });
  const r = stats.report().flows.f3;
  assert.deepEqual([r.backlog, r.avgBacklog], [6, 4]);
  stats.reset();
  sim.advance(5);
  assert.equal(stats.report().flows.f3.avgBacklog, 6, 'a new window starts its own average');
  assert.equal(stats.report().flows.f1.avgBacklog, 0);
});

test('orderDelivered: waits are derived from the order when the payload omits them; junk payloads do not throw', () => {
  const { stats } = setup();
  stats.onEvent('orderDelivered', { order: { flowId: 'f3', vehicleId: 'v1#1', qty: 1, readySince: 100, pickedAt: 130, deliveredAt: 170 } });
  assert.deepEqual([stats.report().flows.f3.avgPickupWait, stats.report().flows.f3.avgTransit], [30, 40]);
  assert.doesNotThrow(() => {
    stats.onEvent('orderDelivered');
    stats.onEvent('orderDelivered', { order: { flowId: 'zzz', vehicleId: 'zzz', qty: -3 } });
    stats.onEvent('deadlock');
    stats.onEvent('loadCompleted');
    stats.onEvent('somethingElse', { a: 1 });
    stats.onEvent();
  });
  assertClean(stats.report());
});

// ---- fleets -----------------------------------------------------------------------------------------------

test('fleet shares are exact vehicle-time fractions and sum to 1', () => {
  const { sim, stats } = setup({ fleets: [{ count: 2 }] });
  const a = sim.veh('v1#1');
  sim.veh('v1#2').state = 'parked';
  const phase = (seconds, state, waiting = false) => {
    a.state = state;
    a.tv.waiting = waiting;
    sim.advance(seconds);
  };
  phase(30, 'toPickup');
  phase(10, 'toPickup', true);
  phase(12, 'loading');
  phase(30, 'toDrop');
  phase(12, 'unloading');
  phase(6, 'idle');
  // 100 s x 2 vehicles = 200 vehicle-seconds
  const f = stats.report().fleets.v1;
  const expected = { driving: 0.3, waiting: 0.05, loading: 0.06, unloading: 0.06, idle: 0.03, parked: 0.5, charging: 0, broken: 0 };
  for (const [key, value] of Object.entries(expected)) close(f.shares[key], value, 1e-12, key);
  close(sum(f.shares), 1, 1e-9);
  close(f.utilization, 0.47, 1e-12);
  assert.equal(f.count, 2);
  assert.equal(f.name, 'AGV');
});

test('a waiting flag only matters while driving; dead counts as broken; unknown states count as idle', () => {
  const { sim, stats } = setup({ fleets: [{ count: 4 }] });
  Object.assign(sim.veh('v1#1'), { state: 'loading' });
  sim.veh('v1#1').tv.waiting = true;
  sim.veh('v1#2').state = 'dead';
  sim.veh('v1#3').state = 'charging';
  sim.veh('v1#4').state = 'teleporting';
  sim.advance(10);
  const f = stats.report().fleets.v1;
  assert.deepEqual(f.shares, { driving: 0, waiting: 0, loading: 0.25, unloading: 0, idle: 0.25, parked: 0, charging: 0.25, broken: 0.25 });
  assert.equal(f.utilization, 0.25, 'charging and broken vehicles are not working');
});

test('trips, distances and the empty share are window deltas per fleet', () => {
  const { sim, stats } = setup({ fleets: [{ count: 2 }] });
  sim.deliver('v1#1', 'f3');
  sim.drive('v1#1', 45, { loaded: true });
  sim.drive('v1#1', 30);
  sim.drive('v1#2', 25);
  sim.advance(100);
  const f = stats.report().fleets.v1;
  assert.equal(f.trips, 1);
  close(f.tripsPerVehicleHour, 18, 1e-9); // 1 trip / (2 vehicles x 100 s / 3600)
  assert.equal(f.distance, 100);
  assert.equal(f.distancePerVehicle, 50);
  close(f.emptyShare, 0.55, 1e-12);
});

test('a fleet without vehicles is idle by definition, so its shares still sum to 1', () => {
  const { sim, stats } = setup({ fleets: [{ count: 0 }] });
  sim.advance(10);
  const f = stats.report().fleets.v1;
  assert.equal(f.count, 0);
  assert.equal(f.shares.idle, 1);
  assert.equal(f.utilization, 0);
  assert.equal(f.tripsPerVehicleHour, 0);
  assertClean(stats.report());
});

test('unplaced vehicles (no room on the road) are counted per fleet and are not part of count', () => {
  const { sim, stats } = setup({ fleets: [{ count: 2 }, { count: 1 }] });
  sim.logistics.unplaced = ['v1#3', 'v1#4', 'v2#2', 'ghost#1', 17];
  sim.advance(5);
  const f = stats.report().fleets;
  assert.deepEqual([f.v1.count, f.v1.unplaced, f.v2.count, f.v2.unplaced], [2, 2, 1, 1]);
  const none = setup({ fleets: [{ count: 1 }] });
  none.sim.advance(1);
  assert.equal(none.stats.report().fleets.v1.unplaced, 0);
});

test('before the first tick the fleet shares are the current vehicle states, so they already sum to 1', () => {
  const { sim, stats } = setup({ fleets: [{ count: 4 }, { count: 0 }] });
  ['toPickup', 'toDrop', 'loading', 'parked'].forEach((state, i) => { sim.veh(`v1#${i + 1}`).state = state; });
  sim.veh('v1#2').tv.waiting = true;
  const f = stats.report().fleets;
  assert.deepEqual(f.v1.shares, { driving: 0.25, waiting: 0.25, loading: 0.25, unloading: 0, idle: 0, parked: 0.25, charging: 0, broken: 0 });
  assert.equal(f.v1.utilization, 0.75);
  assert.equal(f.v2.shares.idle, 1);
  sim.advance(10);
  assert.equal(stats.report().fleets.v1.shares.waiting, 0.25, 'once time has been sampled the shares come from the samples');
});

test('minBattery is the lowest charge seen in the window, null when batteries are off', () => {
  const { sim, stats } = setup({ fleets: [{ count: 2, battery: { enabled: true } }, { count: 1 }] });
  const a = sim.veh('v1#1');
  a.battery = 0.9;
  sim.advance(10);
  a.battery = 0.15;
  sim.advance(10);
  a.battery = 1; // recharged: the minimum remembers the dip
  sim.advance(10);
  const r = stats.report();
  assert.equal(r.fleets.v1.minBattery, 0.15);
  assert.equal(r.fleets.v2.minBattery, null);
  stats.reset();
  sim.advance(5);
  assert.equal(stats.report().fleets.v1.minBattery, 1, 'a new window forgets the old dip');
});

// ---- traffic ---------------------------------------------------------------------------------------------

test('traffic KPIs and heat are window deltas; hot spots name the cells', () => {
  const { sim, stats } = setup();
  sim.addWait({ vehicle: 40, junction: 10, broken: 5, driving: 500, node: 20, edge: 2 }); // before the window
  sim.pass(2, 7);
  sim.deadlock({ nodes: [20], vehicles: ['v1#1'] });
  sim.advance(10);
  stats.reset();
  const cols = sim.graph.cols;
  const node = (cx, cy) => cy * cols + cx;
  sim.addWait({ vehicle: 6, junction: 3, broken: 1, driving: 100, node: node(14, 1), edge: 3 });
  sim.addWait({ vehicle: 2, node: node(13, 1) });
  sim.pass(3, 4);
  sim.pass(5, 1);
  sim.deadlock({ nodes: [node(14, 1), node(13, 1)], vehicles: ['v1#1', 'v1#2'], resolved: false });
  sim.advance(5);

  const t = stats.report().traffic;
  assert.deepEqual([t.vehicleWait, t.junctionWait, t.brokenWait], [8, 3, 1]);
  close(t.waitShare, 12 / 100, 1e-12);
  assert.equal(t.deadlocks, 1);
  assert.deepEqual(t.hotspots, [
    { node: node(14, 1), cx: 14, cy: 1, wait: 10 },
    { node: node(13, 1), cx: 13, cy: 1, wait: 2 },
  ]);
  assert.deepEqual(t.deadlockEvents, [{ t: 10, nodes: [node(14, 1), node(13, 1)], vehicles: ['v1#1', 'v1#2'], resolved: false }]);

  const h = stats.heat();
  assert.deepEqual([h.edgePasses[3], h.edgePasses[5], h.edgePasses[2]], [4, 1, 0]);
  assert.deepEqual([h.edgeWait[3], h.edgeWait[2]], [10, 0]);
  assert.deepEqual([h.nodeWait[node(14, 1)], h.nodeWait[node(13, 1)], h.nodeWait[20]], [10, 2, 0]);
  assert.deepEqual([h.maxEdgePasses, h.maxEdgeWait, h.maxNodeWait], [4, 10, 10]);
  assert.ok(h.edgePasses instanceof Int32Array && h.nodeWait instanceof Float64Array);
});

test('waitShare is capped at 1 and needs driving time', () => {
  const { sim, stats } = setup();
  sim.addWait({ vehicle: 10, driving: 5 });
  assert.equal(stats.report().traffic.waitShare, 1);
  stats.reset();
  sim.addWait({ vehicle: 10 });
  assert.equal(stats.report().traffic.waitShare, 0);
});

test('hot spots: top 10 by waiting, ties broken by the lower node id, zero-wait cells left out', () => {
  const { sim, stats } = setup();
  const waits = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9];
  waits.forEach((w, i) => sim.addWait({ vehicle: w, node: 20 + i }));
  const expected = waits.map((wait, i) => ({ node: 20 + i, wait }))
    .sort((a, b) => b.wait - a.wait || a.node - b.node)
    .slice(0, HOTSPOT_COUNT);
  const got = stats.report().traffic.hotspots;
  assert.equal(got.length, HOTSPOT_COUNT);
  assert.deepEqual(got.map((h) => [h.node, h.wait]), expected.map((h) => [h.node, h.wait]));
  assert.deepEqual(got.slice(0, 3).map((h) => h.node), [25, 32, 34]);
});

test('deadlock events are capped but the counter keeps counting', () => {
  const { sim, stats } = setup();
  for (let i = 0; i < DEADLOCK_EVENT_CAP + 10; i++) sim.deadlock({ nodes: [i], vehicles: ['v1#1'] });
  const t = stats.report().traffic;
  assert.equal(t.deadlockEvents.length, DEADLOCK_EVENT_CAP);
  assert.equal(t.deadlocks, DEADLOCK_EVENT_CAP + 10);
  assert.equal(t.deadlockEvents[0].nodes[0], 0, 'the first events are kept');
});

test('a deadlock that traffic reports twice is one entry; a new deadlock of the same vehicles is another', () => {
  const { sim, stats } = setup();
  const cycle = ['v1#1', 'v1#2'];
  sim.deadlock({ nodes: [3, 4], vehicles: cycle, resolved: false }); // counter 1
  sim.advance(2);
  // the follow-up report when relocation finally worked: same vehicles in another order, the counter does not move
  sim.emit('deadlock', { t: sim.time, nodes: [3, 4], vehicles: cycle.map((id) => sim.veh(id)).reverse(), resolved: true, victim: null });
  sim.deadlock({ nodes: [9], vehicles: ['v1#3'], resolved: false }); // counter 2
  sim.deadlock({ nodes: [3, 4], vehicles: cycle, resolved: true }); // counter 3: the same vehicles jam again later
  const t = stats.report().traffic;
  assert.equal(t.deadlocks, 3);
  assert.deepEqual(t.deadlockEvents.map((e) => [e.vehicles, e.resolved, e.t]), [
    [cycle, true, 0],
    [['v1#3'], false, 2],
    [cycle, true, 2],
  ]);
  assert.ok(t.deadlockEvents.length <= t.deadlocks);
});

test('the follow-up of an unresolved deadlock is applied even when the event list is full; unmatched resolutions are new entries', () => {
  const { sim, stats } = setup();
  for (let i = 0; i < DEADLOCK_EVENT_CAP; i++) sim.deadlock({ nodes: [i], vehicles: [`x#${i}`], resolved: false });
  sim.emit('deadlock', { nodes: [0], vehicles: ['x#0'], resolved: true });
  const events = stats.report().traffic.deadlockEvents;
  assert.equal(events.length, DEADLOCK_EVENT_CAP);
  assert.deepEqual([events[0].resolved, events[1].resolved], [true, false]);
  sim.emit('deadlock', { nodes: [1], vehicles: ['someone-else'], resolved: true });
  assert.equal(stats.report().traffic.deadlockEvents.length, DEADLOCK_EVENT_CAP, 'full: the new entry is dropped, the counter still counts');
});

test('deadlock nodes are non-negative integers inside the graph; junk values are dropped, not turned into node 0', () => {
  const { sim, stats } = setup();
  const outside = sim.graph.nodeCount;
  stats.onEvent('deadlock', { nodes: [null, '', true, [], 7, 'x', undefined, -3, 4.5, NaN, Infinity, outside, 3], vehicles: [], resolved: true });
  stats.onEvent('deadlock', { nodes: 'abc', vehicles: [], resolved: true });
  stats.onEvent('deadlock', { nodes: 12, vehicles: [], resolved: true });
  assert.deepEqual(stats.report().traffic.deadlockEvents.map((e) => e.nodes), [[7, 3], [], []]);
});

test('the report does not alias internal state', () => {
  const { sim, stats } = setup();
  sim.deadlock({ nodes: [1, 2], vehicles: ['v1#1'] });
  sim.advance(120);
  const r = stats.report();
  r.traffic.deadlockEvents[0].nodes.push(99);
  r.series.t.push(-1);
  const again = stats.report();
  assert.deepEqual(again.traffic.deadlockEvents[0].nodes, [1, 2]);
  assert.equal(again.series.t.includes(-1), false);
});

// ---- series ------------------------------------------------------------------------------------------------

test('series: trailing 10-minute throughput, interval means for wip and vehicles', () => {
  assert.equal(SERIES_INTERVAL, 60);
  const { sim, stats } = setup({ fleets: [{ count: 2 }] });
  const a = sim.veh('v1#1');
  sim.veh('v1#2').state = 'parked';
  sim.advance(900, (s, i) => {
    if (i < 300 && i % 20 === 0) s.complete('D', 100); // 15 loads in the first 5 minutes, none afterwards
    s.setLive(i < 150 ? 4 : 8);
    a.state = i < 90 ? 'toPickup' : 'idle';
    a.tv.waiting = i >= 10 && i < 20;
  });
  const s = stats.report().series;
  assert.equal(s.interval, 60);
  assert.deepEqual(s.t, Array.from({ length: 15 }, (_, k) => 60 * (k + 1)));
  const expectedThroughput = [180, 180, 180, 180, 180, 150, 15 / 420 * 3600, 112.5, 100, 90, 72, 54, 36, 18, 0];
  expectedThroughput.forEach((v, k) => close(s.throughput[k], v, 1e-9, `throughput[${k}]`));
  assert.deepEqual(s.wip, [4, 4, 6, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8]);
  close(s.vehiclesWorking[0], 1, 1e-12);
  close(s.vehiclesWorking[1], 0.5, 1e-12);
  assert.ok(s.vehiclesWorking.slice(2).every((v) => v === 0));
  close(s.vehiclesWaiting[0], 10 / 60, 1e-12);
  assert.ok(s.vehiclesWaiting.slice(1).every((v) => v === 0));
});

test('series times are absolute: they continue the window start after a reset, and reset clears the series', () => {
  const { sim, stats } = setup();
  sim.advance(130);
  assert.deepEqual(stats.report().series.t, [60, 120]);
  stats.reset();
  assert.deepEqual(stats.report().series.t, []);
  sim.advance(65);
  assert.deepEqual(stats.report().series.t, [190]);
});

test('series is decimated pairwise when it reaches its maximum and keeps equal spacing afterwards', () => {
  assert.equal(SERIES_MAX_POINTS, 2000);
  const { sim, stats } = setup({ fleets: [{ count: 1 }] }, { dt: 60 });
  const alternate = (s, i) => s.setLive(i % 2 === 0 ? 2 : 4); // tick n = i + 1: odd ticks 2, even ticks 4
  sim.advance(1999 * 60, alternate);
  let s = stats.report().series;
  assert.equal(s.t.length, 1999);
  assert.equal(s.interval, 60);
  assert.deepEqual(s.wip.slice(0, 4), [2, 4, 2, 4]);

  sim.advance(60, (sm) => sm.setLive(4)); // tick 2000 reaches the maximum
  s = stats.report().series;
  assert.equal(s.t.length, 1000);
  assert.equal(s.interval, 120);
  assert.equal(s.t[0], 120);
  assert.equal(s.t.at(-1), 120000);

  const rest = 2100;
  sim.advance(rest * 60, (sm, i) => sm.setLive((i + 2000) % 2 === 0 ? 2 : 4));
  s = stats.report().series;
  assert.equal(s.interval, 240, 'a second decimation happened at tick 4000');
  assert.ok(s.t.length <= SERIES_MAX_POINTS);
  assert.equal(s.t.length, 1000 + 25);
  assert.ok(s.t.every((t, i) => i === 0 || t - s.t[i - 1] === 240));
  assert.ok(s.wip.every((v) => v === 3), 'merged pairs average the interval means');
  assert.equal(s.t.at(-1), 4100 * 60);
});

// ---- robustness ---------------------------------------------------------------------------------------------

test('hostile runtime values never leak NaN, Infinity or undefined; the report survives JSON', () => {
  const { sim, stats } = setup({ params: { B: { machines: 2 } }, fleets: [{ count: 2, battery: { enabled: true } }] });
  const [A, S, B, , D] = sim.stations;
  Object.assign(A, { yard: NaN, state: 'blocked', inCount: Infinity });
  Object.assign(S, { fill: NaN, inCount: -5, outCount: Infinity });
  B.machines[0].state = undefined;
  B.produced = NaN;
  D.consumed = Infinity;
  sim.veh('v1#1').battery = NaN;
  sim.veh('v1#1').trips = NaN;
  sim.veh('v1#2').state = undefined;
  sim.traffic.stats.waitVehicle = NaN;
  sim.traffic.stats.nodeWait[3] = Infinity;
  sim.traffic.stats.drivingTime = -Infinity;
  sim.setLive(NaN);
  sim.advance(130);
  sim.emit('loadCompleted', { leadTime: NaN, t: NaN, station: 'D', load: {} });
  sim.emit('orderDelivered', { order: { qty: Infinity, flowId: 'f1', vehicleId: 'v1#1' }, waitForPickup: NaN, transit: -4 });
  const r = stats.report();
  assertClean(r);
  assertClean(stats.heat());
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test('fractions stay within [0, 1] and fleet shares sum to 1 over a long mixed run', () => {
  const { sim, stats } = setup({ params: { B: { machines: 3 } } });
  const states = ['busy', 'idle', 'blocked', 'down'];
  const vstates = ['idle', 'toPickup', 'loading', 'toDrop', 'unloading', 'parked', 'charging', 'broken', 'dead', 'toPark', 'toCharger'];
  sim.advance(1000, (s, i) => {
    s.setMachines('B', [states[i % 4], states[(i >> 2) % 4], states[(i * 7 >> 3) % 4]]);
    s.vehicles.forEach((v, n) => { v.state = vstates[(i + n * 3) % vstates.length]; v.tv.waiting = (i + n) % 5 === 0; });
    s.st('S').fill = (i % 11) / 10;
    s.st('A').state = i % 3 === 0 ? 'blocked' : 'normal';
  });
  const r = stats.report();
  for (const st of Object.values(r.stations)) {
    for (const key of ['utilization', 'starved', 'blocked', 'down', 'avgFill', 'maxFill']) {
      assert.ok(st[key] >= 0 && st[key] <= 1, `${st.name}.${key} = ${st[key]}`);
    }
  }
  for (const f of Object.values(r.fleets)) {
    close(sum(f.shares), 1, 1e-9);
    assert.ok(f.utilization >= 0 && f.utilization <= 1);
  }
  const b = r.stations.B;
  close(b.utilization + b.starved + b.blocked + b.down, 1, 1e-9);
});

test('a sim whose shape changes mid-run restarts the window instead of throwing', () => {
  const { sim, stats } = setup();
  sim.advance(20);
  sim.vehicles.push({ ...sim.veh('v1#1'), id: 'v1#9', tv: { waiting: false } });
  assert.doesNotThrow(() => sim.advance(10));
  const r = stats.report();
  assertClean(r);
  assert.equal(r.fleets.v1.count, 4);
  assert.equal(r.window.duration, 10, 'the window restarted when the shape changed and kept measuring afterwards');
});

test('dt granularity: 0.1 s ticks give the same shares as 1 s ticks up to rounding', () => {
  const run = (dt) => {
    const { sim, stats } = setup({ fleets: [{ count: 1 }] }, { dt });
    sim.veh('v1#1').state = 'toPickup';
    sim.advance(30);
    sim.veh('v1#1').state = 'loading';
    sim.advance(10);
    return stats.report().fleets.v1;
  };
  const coarse = run(1);
  const fine = run(0.1);
  close(fine.shares.driving, coarse.shares.driving, 1e-9);
  close(fine.shares.loading, 0.25, 1e-9);
});

// ---- performance -------------------------------------------------------------------------------------------

test('performance: 20,000 samples of 100 stations and 200 vehicles take well under 1.5 s', (t) => {
  const layout = syntheticLayout({ stations: 100, vehicles: 200 });
  const sim = createFakeSim(layout, { dt: 0.1 });
  const stats = new Stats(sim);
  const machineStates = ['busy', 'idle', 'blocked'];
  const vehicleStates = ['toPickup', 'loading', 'toDrop', 'unloading', 'idle', 'parked', 'charging'];
  sim.stations.forEach((st, i) => {
    if (st.machines) st.machines.forEach((m, j) => { m.state = machineStates[(i + j) % 3]; });
    Object.assign(st, { inCount: i % 7, outCount: i % 5, fill: (i % 10) / 10 });
  });
  sim.vehicles.forEach((v, i) => { v.state = vehicleStates[i % vehicleStates.length]; v.tv.waiting = i % 4 === 0; v.battery = 0.5; });
  sim.setLive(120);
  for (let i = 0; i < 2000; i++) stats.sample(0.1); // warm-up for the JIT
  stats.reset();
  const t0 = performance.now();
  for (let i = 0; i < 20000; i++) stats.sample(0.1);
  const ms = performance.now() - t0;
  t.diagnostic(`20000 samples in ${ms.toFixed(0)} ms (${((ms * 1000) / 20000).toFixed(1)} us per sample)`);
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
  const r = stats.report();
  close(r.window.duration, 2000, 1e-6);
  assertClean(r);
});
