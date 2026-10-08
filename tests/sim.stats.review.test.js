// Adversarial review of js/sim/stats.js, js/sim/insights.js and tests/helpers/fake-sim.js.
//
// Everything below was derived independently of the builder's tests, in four groups:
//   1. hand-derived numbers on scripted fake sims (every expectation is arithmetic done on paper, see comments);
//   2. cross-checks against the REAL graph + TrafficSystem + Logistics (no engine exists yet, so a small one is wired here
//      the way docs/ARCHITECTURE.md 5.5 describes it) - Stats must agree with counters the other modules keep themselves;
//   3. properties of the insights on hand-built reports and on real runs (advice must not contradict itself);
//   4. defects: tests whose name starts with "DEFECT" failed when the review was written (each describes behaviour a planner
//      would be misled by). The fixes are in, so they now run as regression tests; the prefix stays so that the history is clear.
//
// Tests without that prefix guarded behaviour that was verified correct during the review.
//
// Three of the defect tests and the exact field list were adjusted when the defects were fixed, because the reviewer's own
// suggested fixes change what they assert: the report gained flows[].avgBacklog and fleets[].unplaced (exact key lists), the
// battery plant is no longer reported as "oversized" at all (so its precondition could not hold any more) and the deadlock
// insight test must feed a report that is past the warm-up (insights ignore warm-up reports).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stats, SampleSet, SERIES_INTERVAL, SERIES_MAX_POINTS, LEAD_SAMPLE_CAP } from '../js/sim/stats.js';
import { generateInsights } from '../js/sim/insights.js';
import { createFakeSim, syntheticLayout } from './helpers/fake-sim.js';
import { layoutFromAscii } from './helpers/ascii.js';
import { buildGraph } from '../js/sim/graph.js';
import { TrafficSystem } from '../js/sim/traffic.js';
import { Logistics } from '../js/sim/logistics.js';
import { EXAMPLES } from '../js/model/examples.js';
import { dist } from '../js/model/defaults.js';
import { createRng } from '../js/util/rng.js';

const close = (actual, expected, eps = 1e-9, what = 'value') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${what}: expected ${expected}, got ${actual}`);

/** Fails on NaN, Infinity or undefined anywhere in a (nested) value, including typed arrays. */
function assertClean(value, path = 'report') {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `${path} is ${value}`);
  else if (Array.isArray(value) || ArrayBuffer.isView(value)) value.forEach((v, i) => assertClean(v, `${path}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) assertClean(v, `${path}.${k}`);
  else assert.notEqual(value, undefined, `${path} is undefined`);
}

const sumOf = (obj) => Object.values(obj).reduce((a, b) => a + b, 0);

// ---- scripted fake plants -------------------------------------------------------------------------------------------

/** source A -> process P -> sink D along one road (10 x 8 grid). Extra station specs / fleets / settings are merged in. */
function lineLayout({ stations = {}, fleets = [], settings } = {}) {
  return layoutFromAscii(['AA..PP..DD', '++++++++++'], {
    stations: { A: 'source', P: 'process', D: 'sink', ...stations },
    flows: [['A', 'P'], ['P', 'D']],
    fleets,
    settings,
  });
}

/** Fake sim with Stats attached. dt defaults to 1 s so that sums are exact. */
function lineSim(opts, dt = 1) {
  const sim = createFakeSim(lineLayout(opts), { dt });
  sim.stats = new Stats(sim);
  return sim;
}

// =========================================================================================================================
// 1. Hand-derived numbers
// =========================================================================================================================

test('three parallel machines over 10 s: busy/starved/blocked/down shares and outage count (hand-derived)', () => {
  const sim = lineSim({ stations: { P: { type: 'process', params: { machines: 3 } } } });
  // seconds 0-3: [busy, busy, idle]; 4-5: [busy, down, blocked]; 6-9: [down, down, down]
  const script = [
    ...Array(4).fill(['busy', 'busy', 'idle']),
    ...Array(2).fill(['busy', 'down', 'blocked']),
    ...Array(4).fill(['down', 'down', 'down']),
  ];
  sim.advance(10, (s, i) => {
    s.setMachines('P', script[i]);
    Object.assign(s.st('P'), { inCount: i, outCount: 2, fill: i / 10 });
  });
  const p = sim.stats.report().stations.P;
  // machine-seconds: 30 = busy 4*2 + 2*1 = 10, idle 4 (counted as starved), blocked 2, down 2 + 12 = 14
  close(p.utilization, 10 / 30);
  close(p.starved, 4 / 30);
  close(p.blocked, 2 / 30);
  close(p.down, 14 / 30);
  close(p.utilization + p.starved + p.blocked + p.down, 1);
  // machine 1 fails at s4, machines 0 and 2 at s6; machine 1 was still down at s6 and is not counted twice
  assert.equal(p.breakdowns, 3);
  close(p.avgIn, 4.5); // mean of 0..9
  assert.equal(p.maxIn, 9);
  assert.deepEqual([p.avgOut, p.maxOut], [2, 2]);
  close(p.avgFill, 0.45);
  close(p.maxFill, 0.9);
});

test('a machine that repairs and fails again counts two outages; a long outage counts one', () => {
  const sim = lineSim();
  const states = ['busy', 'down', 'down', 'down', 'busy', 'down', 'busy'];
  sim.advance(states.length, (s, i) => s.setMachines('P', [states[i]]));
  assert.equal(sim.stats.report().stations.P.breakdowns, 2);
});

test('source blocked by a full yard: blocked share, utilization, yard peak and live yard (hand-derived)', () => {
  const sim = lineSim();
  const yard = [0, 0, 2, 5, 5, 3, 0, 0, 0, 0, 1, 4];
  sim.advance(yard.length, (s, i) => {
    const a = s.st('A');
    a.yard = yard[i];
    a.state = yard[i] > 0 ? 'blocked' : 'normal';
    a.fill = yard[i] > 0 ? 1 : 0.5;
  });
  const a = sim.stats.report().stations.A;
  // blocked in seconds 2,3,4,5,10,11 = 6 of 12
  close(a.blocked, 0.5);
  close(a.utilization, 0.5);
  assert.deepEqual([a.yardMax, a.yardNow], [5, 4]);
  close(a.avgFill, (6 * 1 + 6 * 0.5) / 12);
  assert.deepEqual([a.starved, a.down], [0, 0]);
});

test('storage: average fill, share of time empty (starved) and completely full (blocked), peak fill (hand-derived)', () => {
  const layout = layoutFromAscii(['AA..SS..DD', '++++++++++'], {
    stations: { A: 'source', S: { type: 'storage', params: { capacity: 8 } }, D: 'sink' },
    flows: [['A', 'S'], ['S', 'D']],
    fleets: [],
  });
  const sim = createFakeSim(layout);
  sim.stats = new Stats(sim);
  const fill = [0, 0, 0.5, 1, 1, 0.25];
  sim.advance(fill.length, (s, i) => { s.st('S').fill = fill[i]; });
  const s = sim.stats.report().stations.S;
  close(s.avgFill, 2.75 / 6);
  close(s.utilization, 2.75 / 6);
  close(s.starved, 2 / 6);
  close(s.blocked, 2 / 6);
  assert.deepEqual([s.maxFill, s.down], [1, 0]);
});

test('traffic section adds the three kinds of waiting and divides by the driving time; the counter is not the event list', () => {
  const sim = lineSim({ fleets: [{ count: 2 }] });
  sim.addWait({ vehicle: 10, junction: 20, broken: 30, driving: 240 });
  sim.traffic.stats.deadlocks = 5; // five deadlocks counted by traffic, only two of them reported through events
  sim.emit('deadlock', { vehicles: ['v1#1'], nodes: [1], resolved: true });
  sim.emit('deadlock', { vehicles: ['v1#2'], nodes: [2], resolved: false });
  sim.advance(1);
  const t = sim.stats.report().traffic;
  assert.deepEqual([t.vehicleWait, t.junctionWait, t.brokenWait], [10, 20, 30]);
  close(t.waitShare, 60 / 240);
  assert.equal(t.deadlocks, 5);
  assert.equal(t.deadlockEvents.length, 2);
  // the event list is capped, the counter keeps counting
  for (let i = 0; i < 60; i++) sim.emit('deadlock', { vehicles: ['v1#1'], nodes: [i], resolved: true });
  sim.traffic.stats.deadlocks = 65;
  const capped = sim.stats.report().traffic;
  assert.equal(capped.deadlocks, 65);
  assert.ok(capped.deadlockEvents.length <= 50);
});

test('hot spots: top 10 of 12 waiting cells, ties broken by the lower node id (hand-derived)', () => {
  const sim = lineSim();
  for (let node = 1; node <= 12; node++) sim.addWait({ vehicle: (node % 3) + 1, driving: 100, node });
  sim.advance(1);
  // waits: 3 at nodes 2, 5, 8, 11; 2 at nodes 1, 4, 7, 10; 1 at nodes 3, 6, 9, 12
  const spots = sim.stats.report().traffic.hotspots;
  assert.deepEqual(spots.map((h) => h.node), [2, 5, 8, 11, 1, 4, 7, 10, 3, 6]);
  assert.deepEqual(spots.map((h) => h.wait), [3, 3, 3, 3, 2, 2, 2, 2, 1, 1]);
  assert.deepEqual([spots[0].cx, spots[0].cy, spots[3].cx, spots[3].cy], [2, 0, 1, 1]); // node 11 on 10 columns is (1, 1)
});

test('backlog counts loads that are ready now, not loads still in dwell', () => {
  const sim = lineSim();
  sim.addReadyLoads('f1', 2);
  sim.addReadyLoads('f1', 3, { readyAt: 1e9 });
  sim.advance(1);
  assert.equal(sim.stats.report().flows.f1.backlog, 2);
});

test('the report has exactly the fields of docs/ARCHITECTURE.md 5.4 (plus traffic.brokenWait, flows[].avgBacklog, fleets[].unplaced)', () => {
  const sim = lineSim({ fleets: [{ count: 1, battery: { enabled: true } }] });
  sim.veh('v1#1').state = 'toPickup';
  sim.complete('D', 90);
  sim.deliver('v1#1', 'f1');
  sim.addWait({ vehicle: 1, driving: 10, node: 11, edge: 1 });
  sim.advance(70);
  const r = sim.stats.report();
  const keys = (o) => Object.keys(o).sort();
  assert.deepEqual(keys(r), ['fleets', 'flows', 'leadTime', 'orders', 'series', 'stations', 'throughput', 'traffic', 'window', 'wip']);
  assert.deepEqual(keys(r.window), ['duration', 'end', 'start', 'warmingUp']);
  assert.deepEqual(keys(r.throughput), ['bySink', 'perHour', 'total']);
  assert.deepEqual(keys(r.throughput.bySink.D), ['count', 'name', 'perHour']);
  assert.deepEqual(keys(r.leadTime), ['count', 'max', 'mean', 'min', 'p50', 'p90', 'p95']);
  assert.deepEqual(keys(r.wip), ['max', 'mean', 'now']);
  assert.deepEqual(keys(r.stations.P), [
    'arrivals', 'avgFill', 'avgIn', 'avgOut', 'blocked', 'breakdowns', 'consumed', 'down', 'maxFill', 'maxIn', 'maxOut', 'name',
    'produced', 'starved', 'type', 'utilization', 'yardMax', 'yardNow',
  ]);
  assert.deepEqual(keys(r.fleets.v1), [
    'avgPickupWait', 'avgTransit', 'count', 'distance', 'distancePerVehicle', 'emptyShare', 'minBattery', 'name', 'shares', 'trips',
    'tripsPerVehicleHour', 'unplaced', 'utilization',
  ]);
  assert.deepEqual(keys(r.fleets.v1.shares), ['broken', 'charging', 'driving', 'idle', 'loading', 'parked', 'unloading', 'waiting']);
  assert.deepEqual(keys(r.flows.f1), ['avgBacklog', 'avgPickupWait', 'avgTransit', 'backlog', 'delivered', 'from', 'to', 'trips']);
  assert.deepEqual(keys(r.traffic), ['brokenWait', 'deadlockEvents', 'deadlocks', 'hotspots', 'junctionWait', 'vehicleWait', 'waitShare']);
  assert.deepEqual(keys(r.traffic.hotspots[0]), ['cx', 'cy', 'node', 'wait']);
  assert.deepEqual(keys(r.orders), ['avgPickupWait', 'avgTransit', 'completed']);
  assert.deepEqual(keys(r.series), ['interval', 't', 'throughput', 'vehiclesWaiting', 'vehiclesWorking', 'wip']);
  const sim2 = lineSim();
  sim2.deadlock({ nodes: [1], vehicles: [] });
  assert.deepEqual(keys(sim2.stats.report().traffic.deadlockEvents[0]), ['nodes', 'resolved', 't', 'vehicles']);
});

test('a fleet with all eleven logistics states: eight shares, waiting flag only splits driving states (hand-derived)', () => {
  const layout = lineLayout({ fleets: [{ count: 11, battery: { enabled: true } }, { count: 1 }] });
  const sim = createFakeSim(layout, { dt: 1 });
  sim.stats = new Stats(sim);
  const states = ['toPickup', 'toDrop', 'toCharger', 'toPark', 'loading', 'unloading', 'idle', 'parked', 'charging', 'broken', 'dead'];
  states.forEach((state, k) => { sim.veh(`v1#${k + 1}`).state = state; });
  // the traffic layer only sets waiting on driving vehicles, but a stale flag on others must not matter
  for (const k of [2, 5, 7]) sim.veh(`v1#${k}`).tv.waiting = true; // toDrop, loading, idle
  const battery = [0.9, 0.5, 0.2, 0.6, 0.8, 1, 1];
  sim.advance(7, (s, i) => { s.veh('v1#4').battery = battery[i]; });
  const f = sim.stats.report().fleets;
  const shares = f.v1.shares;
  close(shares.driving, 3 / 11); // toPickup, toCharger, toPark
  close(shares.waiting, 1 / 11); // toDrop with a blocked traffic vehicle
  for (const key of ['loading', 'unloading', 'idle', 'parked', 'charging']) close(shares[key], 1 / 11, 1e-12, key);
  close(shares.broken, 2 / 11); // broken + dead
  close(sumOf(shares), 1);
  close(f.v1.utilization, 6 / 11); // driving + waiting + loading + unloading
  assert.equal(f.v1.count, 11);
  close(f.v1.minBattery, 0.2); // the lowest value seen in the window, not the last one
  assert.equal(f.v2.shares.idle, 1);
  assert.equal(f.v2.utilization, 0);
  assert.equal(f.v2.minBattery, null, 'batteries are off for the second fleet');
});

test('waiting vs driving: a vehicle blocked for 6 of 10 s is waiting 60 % and driving 40 %', () => {
  const sim = lineSim({ fleets: [{ count: 1 }] });
  sim.veh('v1#1').state = 'toPickup';
  sim.advance(10, (s, i) => { s.veh('v1#1').tv.waiting = i < 6; });
  const f = sim.stats.report().fleets.v1;
  close(f.shares.waiting, 0.6);
  close(f.shares.driving, 0.4);
  close(f.utilization, 1);
});

test('series vehiclesWorking / vehiclesWaiting are means of the vehicle counts, not fractions', () => {
  const sim = lineSim({ fleets: [{ count: 4 }] });
  // per second: vehicle 1 loading (working), vehicle 2 driving and waiting, vehicle 3 driving, vehicle 4 parked
  sim.veh('v1#1').state = 'loading';
  sim.veh('v1#2').state = 'toDrop';
  sim.veh('v1#2').tv.waiting = true;
  sim.veh('v1#3').state = 'toPickup';
  sim.veh('v1#4').state = 'parked';
  sim.advance(120);
  const { series } = sim.stats.report();
  assert.deepEqual(series.vehiclesWorking, [3, 3]);
  assert.deepEqual(series.vehiclesWaiting, [1, 1]);
});

test('a window reset mid-run turns every cumulative counter into a delta and clears every accumulator', () => {
  const sim = lineSim({ fleets: [{ count: 2, battery: { enabled: true } }], settings: { warmup: 100 } });
  const P = sim.st('P');
  const v = sim.veh('v1#1');
  const lead = [100, 200, 300];
  sim.advance(130, (s, i) => { if (i < 3) s.complete('D', lead[i]); });
  P.produced = 10; P.consumed = 8; P.arrivals = 12;
  v.trips = 5; v.loadedDistance = 100; v.emptyDistance = 50; v.battery = 0.2;
  sim.deliver('v1#1', 'f1', { waitForPickup: 11, transit: 22 });
  sim.pass(0, 5); sim.pass(1, 2);
  sim.addWait({ vehicle: 100, driving: 400, node: 9, edge: 0 });
  sim.deadlock({ nodes: [3], vehicles: ['v1#1', 'v1#2'] });
  sim.setLive(10);
  sim.setMachines('P', ['down']);
  sim.advance(1); // a sample must see the outage
  const before = sim.stats.report();
  assert.equal(before.throughput.total, 3);
  assert.equal(before.series.t.length, 2);
  assert.equal(before.stations.P.breakdowns, 1);

  sim.stats.reset();
  const t0 = sim.time;
  v.battery = 0.9;
  v.trips += 2; v.loadedDistance += 30; v.emptyDistance += 10;
  P.produced += 3; P.consumed += 2; P.arrivals += 4;
  sim.pass(0, 1); sim.pass(1, 3);
  sim.addWait({ vehicle: 12, driving: 48, node: 9, edge: 0 });
  sim.addWait({ vehicle: 3, driving: 12, node: 10 });
  sim.setLive(4);
  sim.deliver('v1#1', 'f1', { waitForPickup: 33, transit: 44 });
  sim.deadlock({ nodes: [12], vehicles: ['v1#2'], resolved: false });
  sim.advance(65, (s, i) => {
    if (i === 5) s.complete('D', 50);
    if (i === 6) s.complete('D', 150);
    s.setLive(4); // complete() lowers the live count; the scenario keeps 4 loads in the plant
  });
  const r = sim.stats.report();

  assertClean(r);
  assert.deepEqual(r.window, { start: t0, end: t0 + 65, duration: 65, warmingUp: false });
  assert.deepEqual([r.stations.P.produced, r.stations.P.consumed, r.stations.P.arrivals], [3, 2, 4]);
  assert.deepEqual([r.fleets.v1.trips, r.fleets.v1.distance], [3, 40]);
  close(r.fleets.v1.emptyShare, 10 / 40);
  assert.equal(r.fleets.v1.minBattery, 0.9, 'the 0.2 seen before the reset is forgotten');
  assert.equal(r.stations.P.breakdowns, 0, 'P was already down at the reset');
  assert.deepEqual(r.orders, { completed: 1, avgPickupWait: 33, avgTransit: 44 });
  assert.equal(r.throughput.total, 2);
  assert.deepEqual([r.leadTime.count, r.leadTime.mean, r.leadTime.min, r.leadTime.p50, r.leadTime.max], [2, 100, 50, 100, 150]);
  assert.deepEqual(r.wip, { mean: 4, max: 4, now: 4 });
  assert.deepEqual([r.traffic.vehicleWait, r.traffic.deadlocks], [15, 1]);
  close(r.traffic.waitShare, 15 / 60);
  assert.deepEqual(r.traffic.deadlockEvents.map((e) => [e.nodes, e.vehicles, e.resolved]), [[[12], ['v1#2'], false]]);
  // node 9 -> (9, 0), node 10 -> (0, 1) on a 10-column grid
  assert.deepEqual(r.traffic.hotspots, [{ node: 9, cx: 9, cy: 0, wait: 12 }, { node: 10, cx: 0, cy: 1, wait: 3 }]);
  assert.equal(r.series.t.length, 1);
  assert.equal(r.series.t[0], t0 + SERIES_INTERVAL, 'series times continue from the window start');

  const h = sim.stats.heat();
  assert.deepEqual([...h.edgePasses.slice(0, 2)], [1, 3]);
  assert.deepEqual([h.maxEdgePasses, h.maxEdgeWait, h.maxNodeWait], [3, 12, 12]);
  assert.deepEqual([h.nodeWait[9], h.nodeWait[10], h.edgeWait[0]], [12, 3, 12]);
  assert.ok(h.edgePasses instanceof Int32Array && h.edgeWait instanceof Float64Array && h.nodeWait instanceof Float64Array);
});

test('heat() hands out fresh arrays: scribbling on one result changes neither the next result nor the report', () => {
  const sim = lineSim();
  sim.pass(0, 4);
  sim.addWait({ vehicle: 2, driving: 8, node: 9, edge: 0 });
  sim.advance(2);
  const first = sim.stats.heat();
  first.edgePasses[0] = 99;
  first.nodeWait[9] = 99;
  const second = sim.stats.heat();
  assert.notEqual(second.edgePasses, first.edgePasses);
  assert.equal(second.edgePasses[0], 4);
  assert.equal(second.nodeWait[9], 2);
  assert.equal(sim.stats.report().traffic.hotspots[0].wait, 2);
});

test('report() before any sample: zero window, live values still shown, nothing NaN', () => {
  const layout = lineLayout({ fleets: [{ count: 2 }], settings: { warmup: 0 } });
  const sim = createFakeSim(layout);
  sim.stats = new Stats(sim);
  sim.st('A').yard = 3;
  sim.setLive(5);
  sim.addReadyLoads('f1', 2);
  const r = sim.stats.report();
  assertClean(r);
  assert.deepEqual(r.window, { start: 0, end: 0, duration: 0, warmingUp: false });
  assert.deepEqual(r.wip, { mean: 0, max: 5, now: 5 });
  assert.deepEqual([r.stations.A.yardNow, r.stations.A.yardMax], [3, 3]);
  assert.equal(r.flows.f1.backlog, 2);
  assert.equal(r.throughput.perHour, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test('warm-up flag: true while time < warmup, false from the tick that reaches it; 0 or missing warmup never warms up', () => {
  const sim = lineSim({ settings: { warmup: 5 } }, 0.5);
  const flags = [];
  flags.push(sim.stats.report().window.warmingUp);
  sim.advance(4.5);
  flags.push(sim.stats.report().window.warmingUp); // time 4.5
  sim.advance(0.5);
  flags.push(sim.stats.report().window.warmingUp); // time 5.0
  sim.advance(2);
  flags.push(sim.stats.report().window.warmingUp);
  assert.deepEqual(flags, [true, true, false, false]);

  const none = lineSim({ settings: { warmup: 0 } });
  assert.equal(none.stats.report().window.warmingUp, false);
  const bare = new Stats({ time: 3, layout: lineLayout(), settings: {} });
  assert.equal(bare.report().window.warmingUp, false);
});

test('lead-time percentiles, small sets (R-7 interpolation derived by hand)', () => {
  const sim = lineSim();
  [30, 10, 50, 20, 40].forEach((x) => sim.complete('D', x));
  sim.advance(1);
  const l = sim.stats.report().leadTime;
  // sorted 10 20 30 40 50: rank = p * 4 -> p50 = 30, p90 = rank 3.6 = 40 + 0.6 * 10, p95 = rank 3.8 = 48
  assert.deepEqual([l.count, l.mean, l.min, l.p50, l.max], [5, 30, 10, 30, 50]);
  close(l.p90, 46);
  close(l.p95, 48);

  const two = lineSim();
  two.complete('D', 200);
  two.complete('D', 100);
  two.advance(1);
  const t = two.stats.report().leadTime;
  assert.deepEqual([t.p50, t.mean], [150, 150]);
  close(t.p90, 190);
  close(t.p95, 195);

  const one = lineSim();
  one.complete('D', 7);
  one.advance(1);
  const o = one.stats.report().leadTime;
  assert.deepEqual([o.min, o.p50, o.p90, o.p95, o.max, o.mean], [7, 7, 7, 7, 7, 7]);
});

test('lead-time percentiles beyond the 50,000-sample cap stay close to the exact ones for an unordered full-period sequence', () => {
  // x_i = (i * 7919 mod 60000) + 1 is a permutation of 1..60000: mean 30000.5, p50 30000.5, p90 54000.1, p95 57000.05
  const sim = lineSim();
  const n = 60000;
  assert.ok(n > LEAD_SAMPLE_CAP);
  for (let i = 0; i < n; i++) sim.stats.onEvent('loadCompleted', { station: 'D', leadTime: ((i * 7919) % n) + 1 });
  const l = sim.stats.report().leadTime;
  assert.equal(l.count, n);
  assert.deepEqual([l.min, l.max], [1, n]);
  close(l.mean, 30000.5, 1e-6);
  close(l.p50, 30000.5, 2);
  close(l.p90, 54000.1, 2);
  close(l.p95, 57000.05, 2);
});

test('the series is capped, decimated pairwise and stays equally spaced (hand-derived ramp)', () => {
  // dt = 60 s so every tick closes one interval. Tick j (1-based) completes c_j = 1 + j % 3 loads and holds j live loads.
  const sim = lineSim({}, 60);
  const completed = [0]; // completed[k] after k ticks
  const trailing = (k) => ((completed[k] - completed[Math.max(0, k - 10)]) / (Math.min(10, k) * 60)) * 3600;
  const run = (ticks) => {
    sim.advance(ticks * 60, (s) => {
      const j = completed.length;
      const c = 1 + (j % 3);
      completed.push(completed[j - 1] + c);
      s.complete('D', 100, { count: c });
      s.setLive(j);
    });
  };
  run(2001);
  let s = sim.stats.report().series;
  assert.equal(s.interval, 120);
  assert.equal(s.t.length, 1000, 'one decimation: 2000 points -> 1000');
  assert.ok(s.t.length <= SERIES_MAX_POINTS);
  for (let i = 0; i < s.t.length; i++) {
    const k = 2 * (i + 1);
    assert.equal(s.t[i], 60 * k, `t[${i}]`);
    close(s.throughput[i], trailing(k), 1e-6, `throughput[${i}]`);
    close(s.wip[i], k - 0.5, 1e-9, `wip[${i}]`); // mean of the live counts of ticks k-1 and k
  }

  run(2003); // up to tick 4004: a second decimation happened at tick 4000, tick 4004 starts the next block
  s = sim.stats.report().series;
  assert.equal(s.interval, 240);
  assert.equal(s.t.length, 1001);
  for (let i = 0; i < s.t.length; i++) {
    const k = 4 * (i + 1);
    assert.equal(s.t[i], 60 * k, `t[${i}]`);
    close(s.throughput[i], trailing(k), 1e-6, `throughput[${i}]`);
    close(s.wip[i], k - 1.5, 1e-9, `wip[${i}]`); // mean of the live counts of ticks k-3 .. k
  }
});

// ---- degenerate plants ------------------------------------------------------------------------------------------------

test('a plant without stations, vehicles or flows produces a clean, empty report', () => {
  const sim = createFakeSim(layoutFromAscii(['+++'], { fleets: [] }));
  sim.stats = new Stats(sim);
  sim.advance(5);
  const r = sim.stats.report();
  assertClean(r);
  assert.deepEqual([r.stations, r.fleets, r.flows, r.throughput.bySink], [{}, {}, {}, {}]);
  assert.equal(r.window.duration, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
  assert.ok(sim.stats.heat().edgePasses.length > 0);
});

test('fleets with count 0: shares are all idle, no division by zero anywhere', () => {
  const sim = lineSim({ fleets: [{ count: 0, battery: { enabled: true } }] });
  sim.advance(30);
  const f = sim.stats.report().fleets.v1;
  assertClean(f);
  assert.equal(f.count, 0);
  assert.equal(f.shares.idle, 1);
  assert.deepEqual([f.utilization, f.trips, f.tripsPerVehicleHour, f.distance, f.distancePerVehicle], [0, 0, 0, 0, 0]);
  assert.deepEqual([f.emptyShare, f.avgPickupWait, f.avgTransit, f.minBattery], [null, null, null, null]);
});

test('a plant without a sink: loads that leave through a workstation count as throughput of that workstation', () => {
  const layout = layoutFromAscii(['AA..PP', '++++++'], { stations: { A: 'source', P: 'process' }, flows: [['A', 'P']], fleets: [] });
  const sim = createFakeSim(layout);
  sim.stats = new Stats(sim);
  sim.advance(10);
  const idle = sim.stats.report().throughput;
  assert.deepEqual([idle.total, idle.perHour, idle.bySink], [0, 0, {}]);
  sim.complete('P', 40);
  sim.advance(10);
  const r = sim.stats.report().throughput;
  assert.equal(r.total, 1);
  assert.deepEqual(r.bySink.P, { name: 'P', count: 1, perHour: 180 });
});

test('vehicles that only exist for some fleets: missing fleets are idle, orphans are ignored', () => {
  const layout = lineLayout({ fleets: [{ count: 2 }, { count: 3 }] });
  const sim = createFakeSim(layout);
  // fleet v2 never got a vehicle placed; a stray vehicle of an unknown fleet is in the list
  sim.vehicles.splice(2, 3);
  sim.vehicles.push({ ...sim.vehicles[0], id: 'ghost#1', fleetId: 'ghost', state: 'loading', tv: { waiting: false } });
  sim.vehicles[0].state = 'toPickup';
  sim.vehicles[1].state = 'parked';
  sim.stats = new Stats(sim);
  sim.advance(10);
  const f = sim.stats.report().fleets;
  assert.deepEqual(Object.keys(f), ['v1', 'v2']);
  assert.equal(f.v1.count, 2);
  close(f.v1.shares.driving, 0.5);
  close(f.v1.shares.parked, 0.5);
  assert.equal(f.v1.shares.loading, 0, 'the ghost vehicle must not leak into v1');
  assert.deepEqual([f.v2.count, f.v2.shares.idle, f.v2.utilization], [0, 1, 0]);
});

test('events with missing or odd payloads never throw and never poison the report', () => {
  const sim = lineSim({ fleets: [{ count: 2 }] });
  assert.doesNotThrow(() => {
    sim.stats.onEvent('loadCompleted', { station: 'ghost', leadTime: -4 });
    sim.stats.onEvent('loadCompleted', { station: 'D', leadTime: '120' });
    sim.stats.onEvent('loadCompleted', { station: 'D', load: { createdAt: 5 } });
    sim.stats.onEvent('orderDelivered', { order: { flowId: 'f1', vehicleId: 'v1#1', qty: 2 }, waitForPickup: NaN, transit: Infinity });
    sim.stats.onEvent('orderDelivered', { order: null });
    sim.stats.onEvent('deadlock', { nodes: 'abc', vehicles: 5 });
    sim.stats.onEvent('deadlock', { vehicles: [null, undefined, {}, 'v1#1', { id: 'v1#2' }], nodes: [4.5] });
    sim.stats.onEvent('machineDown', { stationId: 'P' });
    sim.stats.onEvent('', 17);
    sim.stats.onEvent(null, null);
  });
  sim.advance(10);
  const r = sim.stats.report();
  assertClean(r);
  assert.equal(r.throughput.total, 3, 'every loadCompleted counts as throughput');
  assert.equal(r.leadTime.count, 0, 'no usable lead time among them');
  assert.equal(r.flows.f1.delivered, 2);
  assert.deepEqual(r.traffic.deadlockEvents.map((e) => e.vehicles), [[], ['v1#1', 'v1#2']]);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test('Stats never writes to the simulation it observes (sample, events, report, heat, reset)', () => {
  const readOnly = (obj) => new Proxy(obj, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return value && typeof value === 'object' && !(value instanceof Map) && !ArrayBuffer.isView(value) ? readOnly(value) : value;
    },
    set(_t, key) { throw new Error(`Stats wrote ${String(key)}`); },
    defineProperty(_t, key) { throw new Error(`Stats defined ${String(key)}`); },
    deleteProperty(_t, key) { throw new Error(`Stats deleted ${String(key)}`); },
  });
  const raw = createFakeSim(lineLayout({ stations: { P: { type: 'process', params: { machines: 2 } } }, fleets: [{ count: 2, battery: { enabled: true } }] }));
  const sim = { time: 0, layout: readOnly(raw.layout), settings: readOnly(raw.settings), graph: readOnly(raw.graph), traffic: readOnly(raw.traffic), logistics: readOnly(raw.logistics) };
  const stats = new Stats(sim);
  raw.stats = { sample: (dt) => { sim.time = raw.time; stats.sample(dt); }, onEvent: (name, payload) => stats.onEvent(name, payload) };
  raw.setMachines('P', ['busy', 'down']);
  raw.veh('v1#1').state = 'toDrop';
  raw.veh('v1#1').tv.waiting = true;
  raw.addReadyLoads('f1', 2);
  raw.addWait({ vehicle: 1, driving: 5, node: 9, edge: 0 });
  raw.advance(130, (s, i) => { if (i % 10 === 0) s.complete('D', 60); });
  raw.deliver('v1#1', 'f1');
  raw.deadlock({ nodes: [3], vehicles: ['v1#1'] });
  assert.doesNotThrow(() => { stats.report(); stats.heat(); stats.reset(); stats.report(); });
});

test('a Stats created before the logistics exist picks the sim up as soon as it is complete', () => {
  const full = createFakeSim(lineLayout({ fleets: [{ count: 1 }] }));
  const sim = { time: 0, layout: full.layout, settings: full.settings };
  const stats = new Stats(sim);
  full.stats = { sample: (dt) => stats.sample(dt), onEvent: (name, payload) => stats.onEvent(name, payload) };
  stats.sample(1);
  assert.deepEqual(stats.report().stations, {});
  Object.assign(sim, { graph: full.graph, traffic: full.traffic, logistics: full.logistics }); // the engine finishes construction
  full.veh('v1#1').state = 'loading';
  full.advance(10, () => { sim.time = full.time; });
  const r = stats.report();
  assert.deepEqual(Object.keys(r.stations), ['A', 'P', 'D']);
  assert.equal(r.fleets.v1.shares.loading, 1);
  assert.ok(r.window.duration >= 10 && r.window.duration <= 11, `window restarted when the sim became complete: ${r.window.duration}`);
});

// ---- cost of the hot path ----------------------------------------------------------------------------------------------

/** Wrap every station and vehicle of a fake sim so that each property read is counted by name. */
function countReads(sim) {
  const reads = new Map();
  const wrap = (obj) => new Proxy(obj, {
    get(target, key, receiver) {
      reads.set(key, (reads.get(key) || 0) + 1);
      return Reflect.get(target, key, receiver);
    },
  });
  const { stations, vehicles } = sim.logistics;
  stations.forEach((s, i) => { stations[i] = wrap(s); });
  vehicles.forEach((v, i) => { vehicles[i] = wrap(v); });
  return reads;
}

test('sample() reads each station and vehicle a constant number of times and never walks load queues', () => {
  const total = (n, m) => {
    const sim = createFakeSim(syntheticLayout({ stations: n, vehicles: m }), { dt: 1 });
    sim.stats = new Stats(sim);
    sim.addReadyLoads('f1', 50); // a long queue must not make sampling slower
    const reads = countReads(sim);
    sim.stats.sample(1);
    return { reads, sum: [...reads.values()].reduce((a, b) => a + b, 0) };
  };
  const small = total(20, 40);
  const large = total(40, 80);
  close(large.sum / small.sum, 2, 0.05, 'reads grow linearly with stations + vehicles');
  for (const forbidden of ['inQ', 'outQ', 'inbound', 'def']) {
    assert.equal(small.reads.get(forbidden) || 0, 0, `sample() must not read ${forbidden}`);
  }
});

// =========================================================================================================================
// 2. Cross-checks against the real graph + TrafficSystem + Logistics
// =========================================================================================================================

/** The engine of docs/ARCHITECTURE.md 5.5, reduced to what Stats needs. dt should be binary-exact (0.25, 0.5). */
function realWorld(layout, { dt = 0.25 } = {}) {
  const graph = buildGraph(layout);
  const traffic = new TrafficSystem(graph, { handedness: layout.settings.handedness, resolveDeadlocks: layout.settings.deadlock !== 'ignore' });
  const sim = { time: 0, layout, graph, traffic, settings: layout.settings, logistics: null, stats: null, dt, tick: 0 };
  const emit = (name, payload) => { if (sim.stats) sim.stats.onEvent(name, payload); };
  sim.logistics = new Logistics({ layout, graph, traffic, rng: createRng(layout.settings.seed), emit });
  traffic.onDeadlock = (info) => {
    sim.logistics.handleDeadlock(info);
    emit('deadlock', { ...info, t: sim.time });
  };
  sim.stats = new Stats(sim);
  sim.step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      sim.logistics.step(dt, sim.tick * dt);
      traffic.step(dt);
      sim.tick++;
      sim.time = sim.tick * dt;
      sim.stats.sample(dt);
    }
  };
  sim.run = (seconds) => sim.step(Math.round(seconds / dt));
  return sim;
}

/** A plant that exercises everything: breakdowns (machines and vehicles), batteries, a depot, a buffer, parallel machines. */
function busyPlant() {
  return layoutFromAscii(['AA..PP..SS..DD..EE', '++++++++++++++++++'], {
    stations: {
      A: { type: 'source', name: 'Goods in', params: { interArrival: dist('const', 25), outCap: 3 } },
      P: { type: 'process', name: 'Press', params: { cycle: dist('uniform', 40, 0.3), machines: 2, mtbf: 400, mttr: 60, inCap: 3, outCap: 2 } },
      S: { type: 'storage', name: 'Buffer', params: { capacity: 4, dwell: 5 } },
      D: { type: 'sink', name: 'Shipping' },
      E: { type: 'depot', name: 'Bay', params: { slots: 3, chargers: 1 } },
    },
    flows: [['A', 'P'], ['P', 'S'], ['S', 'D']],
    fleets: [{ count: 3, mtbf: 900, mttr: 90, home: 'E', battery: { enabled: true, runtimeMin: 12, chargeTimeMin: 6, lowPct: 40, resumePct: 80 } }],
    settings: { seed: 7, warmup: 300 },
  });
}

/** A shipped example by id (falling back to its position in the gallery: starter, two-lines, congestion-lab). */
const example = (id, index) => (EXAMPLES.find((e) => e.id === id) || EXAMPLES[index]).build();

const REAL_PLANTS = [
  ['busy plant', busyPlant],
  ...EXAMPLES.map((ex) => [`example "${ex.id}"`, () => ex.build()]),
];

test('real engine: after a mid-run reset every KPI agrees with the counters the engine keeps itself', () => {
  for (const [label, build] of REAL_PLANTS) {
    const layout = build();
    const sim = realWorld(layout);
    const lg = sim.logistics;
    sim.run(500);
    sim.stats.reset();
    const at = {
      completed: lg.completed,
      orders: lg.ordersDelivered,
      deadlocks: sim.traffic.stats.deadlocks,
      totalWait: sim.traffic.stats.totalWait,
      flows: new Map(lg.flows.map((f) => [f.id, { delivered: f.delivered, trips: f.trips }])),
      stations: new Map(lg.stations.map((s) => [s.id, { produced: s.produced, consumed: s.consumed, arrivals: s.arrivals, breakdowns: s.breakdowns }])),
    };
    sim.run(1000);
    const r = sim.stats.report();
    const w = `${label}`;
    assertClean(r, w);
    assert.equal(r.window.duration, 1000, w);
    assert.equal(r.throughput.total, lg.completed - at.completed, `${w}: throughput`);
    assert.equal(r.leadTime.count, r.throughput.total, `${w}: one lead time per completed load`);
    assert.equal(sumOf(Object.fromEntries(Object.entries(r.throughput.bySink).map(([k, v]) => [k, v.count]))), r.throughput.total, `${w}: bySink`);
    assert.equal(r.orders.completed, lg.ordersDelivered - at.orders, `${w}: orders`);
    assert.equal(sumOf(Object.fromEntries(Object.entries(r.flows).map(([k, v]) => [k, v.trips]))), r.orders.completed, `${w}: flow trips`);
    assert.equal(sumOf(Object.fromEntries(Object.entries(r.fleets).map(([k, v]) => [k, v.trips]))), r.orders.completed, `${w}: fleet trips`);
    for (const f of lg.flows) {
      assert.equal(r.flows[f.id].delivered, f.delivered - at.flows.get(f.id).delivered, `${w}: flow ${f.id} delivered`);
      assert.equal(r.flows[f.id].trips, f.trips - at.flows.get(f.id).trips, `${w}: flow ${f.id} trips`);
    }
    for (const s of lg.stations) {
      const was = at.stations.get(s.id);
      const k = r.stations[s.id];
      assert.deepEqual([k.produced, k.consumed, k.arrivals], [s.produced - was.produced, s.consumed - was.consumed, s.arrivals - was.arrivals], `${w}: ${s.id} counters`);
      if (s.type === 'process') assert.equal(k.breakdowns, s.breakdowns - was.breakdowns, `${w}: ${s.id} breakdowns`);
    }
    const ts = sim.traffic.stats;
    assert.equal(r.traffic.deadlocks, ts.deadlocks - at.deadlocks, `${w}: deadlocks`);
    close(r.traffic.vehicleWait + r.traffic.junctionWait + r.traffic.brokenWait, ts.totalWait - at.totalWait, 1e-6, `${w}: waiting`);
    // the vehicle-time spent waiting by the fleets is exactly the waiting the traffic layer accumulated
    const fleetWaiting = Object.values(r.fleets).reduce((a, f) => a + f.shares.waiting * f.count * r.window.duration, 0);
    close(fleetWaiting, r.traffic.vehicleWait + r.traffic.junctionWait + r.traffic.brokenWait, 1e-6, `${w}: fleet waiting vs traffic waiting`);
  }
});

test('real engine: structural invariants of the report hold on every plant, with and without a reset', () => {
  for (const [label, build] of REAL_PLANTS) {
    const sim = realWorld(build());
    for (const phase of ['whole run', 'after reset']) {
      sim.run(600);
      if (phase === 'after reset') sim.stats.reset();
      sim.run(600);
      const r = sim.stats.report();
      const w = `${label} (${phase})`;
      assertClean(r, w);
      assert.deepEqual(JSON.parse(JSON.stringify(r)), JSON.parse(JSON.stringify(r)), w);
      for (const [id, f] of Object.entries(r.fleets)) {
        close(sumOf(f.shares), 1, 1e-9, `${w}: fleet ${id} shares`);
        assert.ok(f.utilization >= 0 && f.utilization <= 1 + 1e-12, `${w}: fleet ${id} utilization`);
      }
      for (const [id, s] of Object.entries(r.stations)) {
        for (const key of ['utilization', 'starved', 'blocked', 'down', 'avgFill', 'maxFill']) {
          assert.ok(s[key] >= 0 && s[key] <= 1 + 1e-12, `${w}: ${id}.${key} = ${s[key]}`);
        }
        assert.ok(s.maxIn >= s.avgIn - 1e-12 && s.maxOut >= s.avgOut - 1e-12 && s.maxFill >= s.avgFill - 1e-12, `${w}: ${id} max >= avg`);
        if (s.type === 'process') close(s.utilization + s.starved + s.blocked + s.down, 1, 1e-9, `${w}: ${id} machine shares`);
        if (s.type === 'source') assert.ok(s.yardMax >= s.yardNow, `${w}: ${id} yard`);
      }
      const l = r.leadTime;
      if (l.count > 0) {
        const order = [l.min, l.p50, l.p90, l.p95, l.max];
        assert.deepEqual(order, [...order].sort((a, b) => a - b), `${w}: lead-time order`);
        assert.ok(l.mean >= l.min && l.mean <= l.max, `${w}: mean within range`);
      }
      assert.ok(r.wip.max >= r.wip.mean && r.wip.max >= r.wip.now, `${w}: wip`);
      const waits = r.traffic.hotspots.map((h) => h.wait);
      assert.deepEqual(waits, [...waits].sort((a, b) => b - a), `${w}: hot spots sorted`);
      assert.ok(r.traffic.waitShare >= 0 && r.traffic.waitShare <= 1, `${w}: waitShare`);
      assert.ok(r.traffic.deadlockEvents.length <= Math.max(r.traffic.deadlocks, 0) || r.traffic.deadlocks === 0 && r.traffic.deadlockEvents.length === 0, `${w}: events vs counter`);
      assert.equal(r.series.t.length, Math.floor(r.window.duration / SERIES_INTERVAL), `${w}: one series point per minute`);
    }
  }
});

test('real engine: the sampled shares equal an independent per-tick sampler for vehicles and machines', () => {
  const slot = { toPickup: 'driving', toDrop: 'driving', toCharger: 'driving', toPark: 'driving', loading: 'loading', unloading: 'unloading', idle: 'idle', parked: 'parked', charging: 'charging', broken: 'broken', dead: 'broken' };
  for (const [label, build] of REAL_PLANTS) {
    const sim = realWorld(build(), { dt: 0.5 });
    const fleetTime = {};
    const machineTime = {};
    for (let i = 0; i < 2400; i++) {
      sim.step();
      for (const v of sim.logistics.vehicles) {
        let key = slot[v.state];
        if (key === 'driving' && v.tv.waiting) key = 'waiting';
        const t = (fleetTime[v.fleetId] ||= {});
        t[key] = (t[key] || 0) + sim.dt;
      }
      for (const st of sim.logistics.stations) {
        if (st.type !== 'process') continue;
        const t = (machineTime[st.id] ||= { busy: 0, idle: 0, blocked: 0, down: 0 });
        for (const m of st.machines) t[m.state] += sim.dt;
      }
    }
    const r = sim.stats.report();
    for (const [id, t] of Object.entries(fleetTime)) {
      const total = sumOf(t);
      for (const [key, share] of Object.entries(r.fleets[id].shares)) close(share, (t[key] || 0) / total, 1e-9, `${label}: fleet ${id} ${key}`);
    }
    for (const [id, t] of Object.entries(machineTime)) {
      const total = sumOf(t);
      if (total === 0) continue;
      const s = r.stations[id];
      close(s.utilization, t.busy / total, 1e-9, `${label}: ${id} utilization`);
      close(s.starved, t.idle / total, 1e-9, `${label}: ${id} starved`);
      close(s.blocked, t.blocked / total, 1e-9, `${label}: ${id} blocked`);
      close(s.down, t.down / total, 1e-9, `${label}: ${id} down`);
    }
  }
});

test('real engine: heat() and the hot spots are exactly the growth of the traffic arrays since the reset', () => {
  const layout = busyPlant();
  layout.fleets[0].count = 6;
  layout.fleets[0].battery.enabled = false;
  const sim = realWorld(layout);
  sim.run(400);
  sim.stats.reset();
  const ts = sim.traffic.stats;
  const was = { passes: Int32Array.from(ts.edgePasses), edge: Float64Array.from(ts.edgeWait), node: Float64Array.from(ts.nodeWait) };
  sim.run(900);
  const h = sim.stats.heat();
  const diff = (now, before) => Float64Array.from(now, (x, i) => x - before[i]);
  const passes = diff(ts.edgePasses, was.passes);
  const edgeWait = diff(ts.edgeWait, was.edge);
  const nodeWait = diff(ts.nodeWait, was.node);
  assert.deepEqual([...h.edgePasses], [...passes]);
  assert.deepEqual([...h.edgeWait], [...edgeWait]);
  assert.deepEqual([...h.nodeWait], [...nodeWait]);
  assert.deepEqual([h.maxEdgePasses, h.maxEdgeWait, h.maxNodeWait], [Math.max(...passes), Math.max(...edgeWait), Math.max(...nodeWait)]);
  assert.ok(h.maxEdgePasses > 0 && h.maxNodeWait > 0, 'the scenario must actually produce traffic and waiting');
  const cols = layout.grid.cols;
  const expected = [...nodeWait.keys()].filter((n) => nodeWait[n] > 0)
    .sort((a, b) => nodeWait[b] - nodeWait[a] || a - b).slice(0, 10)
    .map((node) => ({ node, cx: node % cols, cy: Math.floor(node / cols), wait: nodeWait[node] }));
  assert.deepEqual(sim.stats.report().traffic.hotspots, expected);
});

// =========================================================================================================================
// 3. Insights: properties on hand-built reports
// =========================================================================================================================

const ADD_VEHICLES = /\badd (?:a |an |[\d.]+ )?(?:spare )?vehicles?\b/i;
const CUT_VEHICLES = /reduce the number of vehicles|fewer vehicles|try [\d.]+ vehicles? instead/i;

/** Lists every pair of recommendations that tell the planner to do opposite things with the number of vehicles. */
function vehicleAdviceConflicts(insights) {
  const adds = insights.filter((i) => ADD_VEHICLES.test(i.suggestion || ''));
  const cuts = insights.filter((i) => CUT_VEHICLES.test(i.suggestion || ''));
  if (!adds.length || !cuts.length) return [];
  return [`"add vehicles" from ${adds.map((i) => i.id).join(', ')} contradicts "fewer vehicles" from ${cuts.map((i) => i.id).join(', ')}`];
}

const merge = (base, over) => {
  if (over === undefined) return base;
  if (!over || typeof over !== 'object' || Array.isArray(over) || !base || typeof base !== 'object' || Array.isArray(base)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
};

/** Layout behind the hand-built reports: Goods in (A) -> Press (P) -> Shipping (D), one AGV fleet. */
function insightLayout(count = 4) {
  return layoutFromAscii(['AA..PP..DD', '++++++++++'], {
    stations: { A: { type: 'source', name: 'Goods in' }, P: { type: 'process', name: 'Press' }, D: { type: 'sink', name: 'Shipping' } },
    flows: [['A', 'P'], ['P', 'D']],
    fleets: [{ count }],
  });
}

const station = (type, name, over) => merge({
  type, name, utilization: 0, starved: 0, blocked: 0, down: 0, avgIn: 0, maxIn: 0, avgOut: 0, maxOut: 0, avgFill: 0, maxFill: 0,
  produced: 100, consumed: 100, arrivals: 100, yardMax: 0, yardNow: 0, breakdowns: 0,
}, over);

/** A healthy hour: nothing to complain about. Pass overrides to break one thing at a time. */
function healthyReport(over = {}) {
  return merge({
    window: { start: 0, end: 3600, duration: 3600, warmingUp: false },
    throughput: { total: 100, perHour: 100, bySink: { D: { name: 'Shipping', count: 100, perHour: 100 } } },
    leadTime: { count: 100, mean: 300, min: 250, p50: 300, p90: 340, p95: 350, max: 380 },
    wip: { mean: 5, max: 9, now: 5 },
    stations: {
      A: station('source', 'Goods in', { utilization: 1, avgFill: 0.2 }),
      P: station('process', 'Press', { utilization: 0.75, starved: 0.25, avgIn: 0.5 }),
      D: station('sink', 'Shipping'),
    },
    fleets: {
      v1: {
        name: 'AGV', count: 4, utilization: 0.6,
        shares: { driving: 0.4, waiting: 0.05, loading: 0.075, unloading: 0.075, idle: 0.1, parked: 0.3, charging: 0, broken: 0 },
        trips: 200, tripsPerVehicleHour: 50, distance: 5000, distancePerVehicle: 1250, emptyShare: 0.5, avgPickupWait: 40, avgTransit: 50, minBattery: null,
      },
    },
    flows: {
      f1: { from: 'A', to: 'P', delivered: 100, trips: 100, avgPickupWait: 40, avgTransit: 50, backlog: 0 },
      f2: { from: 'P', to: 'D', delivered: 100, trips: 100, avgPickupWait: 40, avgTransit: 50, backlog: 0 },
    },
    traffic: { waitShare: 0.02, vehicleWait: 50, junctionWait: 20, brokenWait: 0, deadlocks: 0, hotspots: [], deadlockEvents: [] },
    orders: { completed: 200, avgPickupWait: 40, avgTransit: 50 },
    series: { interval: 60, t: [], throughput: [], wip: [], vehiclesWorking: [], vehiclesWaiting: [] },
  }, over);
}

const ids = (list) => list.map((i) => i.id);
const describe = (list) => list.map((i) => `${i.severity} ${i.id}: ${i.title} -> ${i.suggestion || '-'}`).join('\n');

test('the healthy baseline report yields exactly one good insight', () => {
  assert.deepEqual(ids(generateInsights(healthyReport(), insightLayout())), ['good']);
});

test('insights are consistent across a grid of 4,600 plausible reports', () => {
  const layout = insightLayout();
  const procs = [];
  for (const util of [0.3, 0.6, 0.93]) for (const down of [0, 0.1]) for (const avgIn of [0.2, 3]) procs.push({ util, down, avgIn });
  const fleets = [
    { count: 3, util: 0.2, pickup: 30 }, { count: 3, util: 0.5, pickup: 150 }, { count: 3, util: 0.9, pickup: 200 }, { count: 6, util: 0.3, pickup: null },
  ];
  let reports = 0;
  for (const P of procs) for (const Q of procs) for (const fl of fleets) for (const backlog of [0, 3]) for (const wait of [0, 0.4]) for (const yard of [0, 12]) {
    reports++;
    const process = (name, p) => station('process', name, {
      utilization: p.util, down: p.down, starved: Math.max(0, 1 - p.util - p.down), avgIn: p.avgIn, maxIn: p.avgIn * 2, avgFill: Math.min(1, p.avgIn / 4), maxFill: 1, breakdowns: p.down > 0 ? 3 : 0,
    });
    const report = healthyReport({
      stations: { A: station('source', 'Goods in', { blocked: yard ? 0.6 : 0, utilization: yard ? 0.4 : 1, yardNow: yard, yardMax: yard }), P: process('Press', P), Q: process('Cutter', Q) },
      fleets: { v1: { count: fl.count, utilization: fl.util, avgPickupWait: fl.pickup, shares: { driving: fl.util * 0.7, waiting: fl.util * 0.1, loading: fl.util * 0.1, unloading: fl.util * 0.1, idle: (1 - fl.util) / 2, parked: (1 - fl.util) / 2 } } },
      flows: { f1: { backlog } },
      traffic: { waitShare: wait, vehicleWait: wait * 1000, hotspots: wait ? [{ node: 20, cx: 6, cy: 1, wait: 100 }] : [] },
    });
    const lay = insightLayout(fl.count);
    lay.stations.push({ ...lay.stations[1], id: 'Q', name: 'Cutter', x: 6, w: 2 });
    lay.flows = [{ ...lay.flows[0] }, { ...lay.flows[1], id: 'f2', from: 'P', to: 'Q' }, { ...lay.flows[1], id: 'f3', from: 'Q', to: 'D' }];
    const result = generateInsights(report, lay);
    const where = `P=${JSON.stringify(P)} Q=${JSON.stringify(Q)} fleet=${JSON.stringify(fl)} backlog=${backlog} wait=${wait} yard=${yard}`;
    const names = ids(result);
    assert.equal(new Set(names).size, names.length, `unique ids: ${where}`);
    if (names.includes('good')) assert.ok(result.every((i) => i.severity !== 'critical' && i.severity !== 'warning'), `good only without warnings: ${where}`);
    const rank = { critical: 0, warning: 1, info: 2, good: 3 };
    assert.deepEqual(result.map((i) => rank[i.severity]), result.map((i) => rank[i.severity]).sort((a, b) => a - b), `sorted by severity: ${where}`);
    assert.ok(!(names.includes('fleet-saturated:v1') && names.includes('fleet-oversized:v1')), `saturated and oversized together: ${where}`);
    for (const i of result) {
      assert.ok(!/NaN|undefined|null|Infinity/.test(`${i.title} ${i.detail} ${i.suggestion || ''}`), `bad text in ${i.id}: ${where}`);
      if (i.id.startsWith('bottleneck:')) assert.ok(report.stations[i.id.split(':')[1]].starved <= 0.1 + 1e-9, `a starved station is called the bottleneck: ${where}`);
      const fix = /Fix (\w+) first/.exec(i.suggestion || '');
      if (fix) assert.ok(names.includes(`bottleneck:${fix[1] === 'Press' ? 'P' : 'Q'}`), `"fix ${fix[1]} first" points at a station that is not reported as the bottleneck: ${where}`);
      for (const id of [...(i.refs.stationIds || []), ...(i.refs.fleetIds || []), ...(i.refs.flowIds || [])]) {
        assert.ok(report.stations[id] || report.fleets[id] || report.flows[id], `dangling ref ${id} in ${i.id}: ${where}`);
      }
    }
  }
  assert.equal(reports, 4608);
});

test('boundary thresholds: just below the limit stays silent, at the limit it speaks', () => {
  const layout = insightLayout();
  const quiet = (over) => ids(generateInsights(healthyReport(over), layout));
  assert.deepEqual(quiet({ stations: { P: { utilization: 0.89, starved: 0.11, avgIn: 3 } } }), ['good']);
  assert.ok(quiet({ stations: { P: { utilization: 0.9, starved: 0.1, avgIn: 3 } } }).includes('bottleneck:P'));
  assert.deepEqual(quiet({ traffic: { waitShare: 0.119 } }), ['good']);
  assert.ok(quiet({ traffic: { waitShare: 0.12, hotspots: [] } }).includes('traffic'));
  assert.deepEqual(quiet({ fleets: { v1: { utilization: 0.84 } } }), ['good']);
  assert.ok(quiet({ fleets: { v1: { utilization: 0.85 } } }).includes('fleet-saturated:v1'));
  assert.ok(quiet({ fleets: { v1: { utilization: 0.34 } } }).includes('fleet-oversized:v1'));
  assert.ok(!quiet({ fleets: { v1: { utilization: 0.35 } } }).includes('fleet-oversized:v1'));
  assert.deepEqual(generateInsights(healthyReport({ window: { duration: 299 } }), layout).map((i) => i.id), ['not-enough-data']);
  assert.deepEqual(generateInsights(healthyReport({ window: { duration: 300 } }), layout).map((i) => i.id), ['good']);
});

test('a workstation that is broken down counts as loaded; a lone vehicle is never "oversized"', () => {
  const layout = insightLayout();
  const worn = generateInsights(healthyReport({ stations: { P: { utilization: 0.8, down: 0.15, starved: 0.05, avgIn: 4, maxIn: 4, breakdowns: 4 } } }), layout);
  const bottleneck = worn.find((i) => i.id === 'bottleneck:P');
  assert.ok(bottleneck, describe(worn));
  assert.match(bottleneck.title, /busy 80 % and broken down 15 % of the time/);
  assert.ok(!ids(generateInsights(healthyReport({ stations: { P: { utilization: 0.8, down: 0, starved: 0.2, avgIn: 4, maxIn: 4 } } }), layout)).includes('bottleneck:P'));
  const lone = (count) => ids(generateInsights(healthyReport({ fleets: { v1: { count, utilization: 0.1 } } }), insightLayout(count)));
  assert.ok(!lone(1).includes('fleet-oversized:v1'));
  assert.ok(lone(2).includes('fleet-oversized:v1'));
});

test('insights are ordered by severity, then by how far past its limit each finding is, then by id', () => {
  const layout = insightLayout();
  const result = generateInsights(healthyReport({
    stations: {
      A: station('source', 'Goods in', { blocked: 0.95, utilization: 0.05, yardNow: 6, yardMax: 6 }), // warning, magnitude 0.95
      P: station('process', 'Press', { utilization: 0.91, starved: 0.09, avgIn: 3 }), // warning, magnitude 0.91 (id sorts first)
    },
    traffic: { waitShare: 0.5 }, // critical
    fleets: { v1: { count: 4, utilization: 0.2 } }, // info
  }), layout);
  assert.deepEqual(ids(result), ['traffic', 'supply:A', 'bottleneck:P', 'fleet-oversized:v1']);
});

test('a valid-but-odd report (no layout, no fleets, no stations, no throughput) is handled without throwing', () => {
  const bare = { window: { start: 0, end: 600, duration: 600, warmingUp: false }, throughput: { total: 0, perHour: 0, bySink: {} }, leadTime: {}, wip: {}, stations: {}, fleets: {}, flows: {}, traffic: {}, orders: {}, series: {} };
  const result = generateInsights(bare, null);
  assert.deepEqual(ids(result), ['no-output']);
  assert.doesNotThrow(() => generateInsights(bare, undefined));
  assert.doesNotThrow(() => generateInsights({ window: { duration: 1000 } }, {}));
  assert.deepEqual(ids(generateInsights(null, null)), ['not-enough-data']);
});

// =========================================================================================================================
// 4. DEFECTS (failed when the review was written, fixed since)
// =========================================================================================================================

test('DEFECT backlog counts loads a vehicle has already claimed, so "waiting for a vehicle" advice is wrong', () => {
  const sim = lineSim({ fleets: [{ count: 3 }] });
  sim.addReadyLoads('f1', 3);
  const queue = sim.st('A').outQ.get('f1');
  queue[0].claimed = true; // a vehicle is already on its way for these two
  queue[1].claimed = true;
  sim.advance(1);
  assert.equal(sim.stats.report().flows.f1.backlog, 1, 'only the load nobody has claimed is waiting for transport');
});

test('DEFECT real engine: backlog is mostly loads that already have a vehicle on the way', () => {
  const layout = layoutFromAscii(['AA..DD', '++++++'], {
    stations: { A: { type: 'source', params: { interArrival: dist('const', 30) } }, D: 'sink' },
    flows: [['A', 'D']],
    fleets: [{ count: 2 }],
    settings: { seed: 3 },
  });
  const sim = realWorld(layout, { dt: 0.5 });
  const mismatches = [];
  for (let i = 0; i < 1200; i++) {
    sim.step();
    const ready = sim.logistics.stationById.get('A').outQ.get('f1').filter((l) => !(l.readyAt > sim.time));
    const unclaimed = ready.filter((l) => !l.claimed).length;
    const reported = sim.stats.report().flows.f1.backlog;
    if (reported !== unclaimed) mismatches.push(`t=${sim.time}: backlog ${reported}, unclaimed ${unclaimed}, claimed ${ready.length - unclaimed}`);
  }
  assert.equal(mismatches.length, 0, `${mismatches.length} of 1200 ticks report claimed loads as waiting, e.g. ${mismatches[0]}`);
});

test('DEFECT a deadlock that traffic reports twice (unresolved, then resolved) is one event and ends resolved', () => {
  const sim = lineSim({ fleets: [{ count: 2 }] });
  sim.traffic.stats.deadlocks = 1; // the traffic layer counts it once ...
  const cycle = [sim.veh('v1#1'), sim.veh('v1#2')];
  sim.emit('deadlock', { vehicles: cycle, nodes: [3], resolved: false, victim: null });
  sim.advance(1);
  sim.emit('deadlock', { vehicles: cycle, nodes: [3], resolved: true, victim: cycle[0] }); // ... but reports it again once relocation worked
  sim.advance(1);
  const report = sim.stats.report();
  assert.equal(report.traffic.deadlocks, 1);
  assert.deepEqual(report.traffic.deadlockEvents.map((e) => e.resolved), [true], 'one deadlock, finally resolved');
  // pretend ten minutes were measured after the warm-up (insights ignore warm-up reports)
  const insight = generateInsights({ ...report, window: { ...report.window, duration: 600, warmingUp: false } }, insightLayout()).find((i) => i.id === 'deadlocks');
  assert.equal(insight.severity, 'warning', 'a resolved deadlock is not a critical "jam left standing"');
});

test('DEFECT lead-time percentiles collapse on periodic data once more than 50,000 loads completed', () => {
  // two products alternate (e.g. weighted round-robin to two flows): 100 s and 500 s lead time, 60,000 of each
  const sim = lineSim();
  const n = 120000;
  for (let i = 0; i < n; i++) sim.stats.onEvent('loadCompleted', { station: 'D', leadTime: i % 2 === 0 ? 100 : 500 });
  const l = sim.stats.report().leadTime;
  assert.equal(l.count, n);
  close(l.mean, 300, 1e-6);
  assert.equal(l.max, 500);
  // exact: p50 = 300 (between the two blocks), p90 = p95 = 500
  assert.ok(l.p90 >= 450, `p90 is ${l.p90} but half of all loads took 500 s`);
  assert.ok(l.p95 >= 450, `p95 is ${l.p95} while the mean is ${l.mean} and the max ${l.max}`);
});

test('DEFECT a workstation with no machines is "down" in the engine, but its machine-time shares add up to 0', () => {
  const sim = realWorld(lineLayout({ stations: { P: { type: 'process', params: { machines: 0 } } }, fleets: [{ count: 1 }] }));
  sim.run(60);
  assert.equal(sim.logistics.stationById.get('P').state, 'down', 'precondition: with no machines the engine calls the workstation down');
  const p = sim.stats.report().stations.P;
  close(p.utilization + p.starved + p.blocked + p.down, 1, 1e-9, 'machine-time shares must add up to 1');
  assert.equal(p.down, 1);
});

test('DEFECT deadlock events turn junk node values into node 0', () => {
  const sim = lineSim();
  sim.stats.onEvent('deadlock', { nodes: [null, '', true, [], 7, 'x', undefined], vehicles: [], resolved: true });
  assert.deepEqual(sim.stats.report().traffic.deadlockEvents[0].nodes, [7]);
});

test('DEFECT insights run on warm-up data: the first minutes of a cold plant produce warnings', () => {
  const layout = insightLayout();
  const cold = healthyReport({
    window: { duration: 400, end: 400, warmingUp: true },
    throughput: { total: 0, perHour: 0, bySink: {} },
    stations: { P: { utilization: 0.1, starved: 0.9, avgIn: 0 } },
  });
  const result = generateInsights(cold, layout);
  assert.deepEqual(result.filter((i) => i.severity === 'critical' || i.severity === 'warning').map((i) => i.id), [], `warm-up transients reported as problems:\n${describe(result)}`);
  // the same numbers after the warm-up are real findings and must still be reported
  const warm = generateInsights({ ...cold, window: { ...cold.window, warmingUp: false } }, layout);
  assert.ok(warm.some((i) => i.severity === 'warning'), 'guard: no-output / starved are reported once the warm-up is over');
});

test('DEFECT real engine: the shipped two-lines example shows warnings while it is still warming up', () => {
  const layout = example('two-lines', 1);
  layout.settings.warmup = 900;
  const sim = realWorld(layout);
  sim.run(400);
  const report = sim.stats.report();
  assert.equal(report.window.warmingUp, true);
  const result = generateInsights(report, layout);
  assert.deepEqual(result.filter((i) => i.severity === 'critical' || i.severity === 'warning').map((i) => i.id), [], describe(result));
});

test('DEFECT "fleet is mostly idle: try fewer vehicles" together with "add a vehicle" (battery plant, loads waiting)', () => {
  // numbers taken from a real run of the two-lines example with 20-minute batteries: most vehicle time is charging or parked
  const layout = insightLayout(6);
  const report = healthyReport({
    stations: {
      A: station('source', 'Goods in', { blocked: 0.5, utilization: 0.5, avgFill: 0.66, yardNow: 27, yardMax: 27 }),
      P: station('process', 'Press', { utilization: 0.21, starved: 0.74, down: 0.05, avgIn: 0.2 }),
    },
    fleets: {
      v1: {
        name: 'AGV', count: 6, utilization: 0.27, minBattery: 0.15, avgPickupWait: 54,
        shares: { driving: 0.21, waiting: 0.02, loading: 0.02, unloading: 0.02, idle: 0, parked: 0.41, charging: 0.32, broken: 0 },
      },
    },
    flows: { f1: { backlog: 6 } },
  });
  const result = generateInsights(report, layout);
  // a third of the vehicle time is charging: the vehicles are not available for work, so the fleet is not "mostly idle"
  assert.ok(!ids(result).includes('fleet-oversized:v1'), `charging time is not idle time:\n${describe(result)}`);
  assert.deepEqual(vehicleAdviceConflicts(result), [], describe(result));
});

test('DEFECT congestion advice says "fewer vehicles" while supply/starved advice says "add a vehicle"', () => {
  // a gridlocked plant (real run: congestion lab with 20 vehicles): 99 % of the driving time is waiting
  const layout = insightLayout(20);
  const report = healthyReport({
    throughput: { total: 0, perHour: 0, bySink: {} },
    stations: {
      A: station('source', 'Goods in', { blocked: 0.73, utilization: 0.27, avgFill: 0.83, yardNow: 25, yardMax: 25 }),
      P: station('process', 'Press', { utilization: 0, starved: 1 }),
    },
    fleets: { v1: { count: 20, utilization: 0.43, shares: { driving: 0.01, waiting: 0.42, loading: 0, unloading: 0, idle: 0.22, parked: 0.35, charging: 0, broken: 0 }, avgPickupWait: null } },
    flows: { f1: { backlog: 6 } },
    traffic: { waitShare: 0.987, vehicleWait: 50000, junctionWait: 20000, hotspots: [{ node: 20, cx: 6, cy: 1, wait: 9000 }] },
  });
  const result = generateInsights(report, layout);
  assert.ok(ids(result).includes('traffic'), 'precondition: congestion is reported');
  assert.deepEqual(vehicleAdviceConflicts(result), [], describe(result));
});

test('DEFECT a saturated fleet is told to add vehicles while traffic is told to remove them (consistent figures)', () => {
  // fleet busy 90 % of the time: driving 50 %, waiting in traffic 10 %, loading and unloading 15 % each.
  // Traffic waitShare = waiting / (driving + waiting) = 0.1 / 0.6, so the two rules see the same congestion.
  const layout = insightLayout(3);
  const report = healthyReport({
    fleets: { v1: { count: 3, utilization: 0.9, avgPickupWait: 60, shares: { driving: 0.5, waiting: 0.1, loading: 0.15, unloading: 0.15, idle: 0.1, parked: 0, charging: 0, broken: 0 } } },
    traffic: { waitShare: 0.1 / 0.6, vehicleWait: 3 * 3600 * 0.1, junctionWait: 0, hotspots: [{ node: 20, cx: 6, cy: 1, wait: 400 }] },
  });
  const result = generateInsights(report, layout);
  assert.ok(ids(result).includes('fleet-saturated:v1') && ids(result).includes('traffic'), 'precondition');
  assert.deepEqual(vehicleAdviceConflicts(result), [], describe(result));
});

test('DEFECT the advice flips when the instantaneous backlog moves by one load', () => {
  const layout = insightLayout();
  const at = (backlog) => generateInsights(healthyReport({
    stations: { P: { utilization: 0.4, starved: 0.6 } },
    flows: { f1: { backlog } },
  }), layout).find((i) => i.id === 'starved:P');
  const calm = at(0);
  const one = at(1);
  assert.ok(calm && one);
  assert.equal(one.suggestion, calm.suggestion, 'a single ready load at the instant of the report must not change the recommendation');
  assert.deepEqual(one.refs, calm.refs);
});

/** A starter-like plant: Goods in -> Press, two AGVs 75 % busy, loads waiting ~4 minutes for pickup. `pressBusy` makes the Press the bottleneck. */
function longPickupWaitReport(pressBusy) {
  return healthyReport({
    stations: {
      A: station('source', 'Goods in', { blocked: 0.42, utilization: 0.58, avgFill: 0.63, yardNow: 5, yardMax: 5 }),
      P: pressBusy
        ? station('process', 'Press', { utilization: 0.79, down: 0.19, starved: 0.02, avgIn: 2.8, maxIn: 4, avgFill: 0.7, breakdowns: 11 })
        : station('process', 'Press', { utilization: 0.5, starved: 0.5 }),
    },
    fleets: { v1: { count: 2, utilization: 0.75, avgPickupWait: 231, shares: { driving: 0.5, waiting: 0.05, loading: 0.1, unloading: 0.1, idle: 0.05, parked: 0.2, charging: 0, broken: 0 } } },
    flows: { f1: { avgPickupWait: 300, backlog: 0 }, f2: { avgPickupWait: 60, backlog: 0 } },
  });
}

test('a long pickup wait with a fleet at 75 % and no saturated workstation still points at the fleet', () => {
  const result = generateInsights(longPickupWaitReport(false), insightLayout(2));
  assert.ok(ids(result).includes('fleet-saturated:v1'), describe(result));
});

test('DEFECT a fleet is blamed for long pickup waits that a saturated workstation at the destination explains', () => {
  // real run (starter plant, demand x2, Press breaks down): the AGVs are 75-82 % busy and loads wait 4 minutes because
  // the machine they deliver to has no room, not because vehicles are missing
  const result = generateInsights(longPickupWaitReport(true), insightLayout(2));
  assert.ok(ids(result).includes('bottleneck:P'), 'precondition: the machine is reported as the bottleneck');
  assert.ok(!ids(result).includes('fleet-saturated:v1'), `the fleet has spare capacity (75 % < 85 %); the wait is caused by the machine:\n${describe(result)}`);
});

// ---- the same contradictions on real runs ----------------------------------------------------------------------------

/** Insights every 10 s between the end of the warm-up and `seconds`; returns the conflicts found, with the time. */
function conflictsInRun(layout, seconds = 1800) {
  const sim = realWorld(layout);
  const found = [];
  sim.run(layout.settings.warmup);
  sim.stats.reset();
  for (let t = layout.settings.warmup + 10; t <= seconds; t += 10) {
    sim.run(10);
    const report = sim.stats.report();
    if (report.window.duration < 300) continue;
    const conflicts = vehicleAdviceConflicts(generateInsights(report, layout));
    if (conflicts.length) found.push(`t=${t}: ${conflicts[0]}`);
  }
  return found;
}

test('DEFECT real engine: shipped starter plant with 5 AGVs gives "add a vehicle" and "fewer vehicles" at the same time', () => {
  const layout = example('starter', 0);
  layout.fleets[0].count = 5;
  const found = conflictsInRun(layout);
  assert.equal(found.length, 0, `${found.length} contradicting reports, first: ${found[0]}`);
});

test('DEFECT real engine: congestion lab with 20 AGVs gives "add a vehicle" and "reduce the number of vehicles" at the same time', () => {
  const layout = example('congestion-lab', 2);
  layout.fleets[0].count = 20;
  const found = conflictsInRun(layout);
  assert.equal(found.length, 0, `${found.length} contradicting reports, first: ${found[0]}`);
});
