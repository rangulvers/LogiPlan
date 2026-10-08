// Unit tests of the Simulation engine (js/sim/engine.js): construction, determinism, stepping and time budgets, warm-up,
// live what-if settings, the event bus, deadlock wiring and the results API - on small plants whose behaviour is known.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation, MIN_FACTOR, MAX_FACTOR, CLOCK_CHECK_TICKS, DEADLOCK_HISTORY } from '../js/sim/engine.js';
import { EXAMPLES } from '../js/model/examples.js';
import { cloneLayout, createLayout, addStation, addFlow, addFleet, paintRoadPath, updateSettings } from '../js/model/layout.js';
import { defaultSettings, RUNTIME_KEYS } from '../js/model/defaults.js';
import { layoutFromAscii } from './helpers/ascii.js';
import { createRng } from '../js/util/rng.js';
import { assertAllFinite, lineLayout, randomPlant } from './helpers/sim-invariants.js';

const starter = () => EXAMPLES.find((e) => e.id === 'starter').build();
const json = (sim) => JSON.stringify(sim.kpis());

/** A recorded list of [name, t] pairs of all events of a simulation. */
function record(sim) {
  const log = [];
  sim.on('*', (payload, name) => log.push([name, payload.t]));
  return log;
}

// ---------------------------------------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------------------------------------

test('construction: the simulation works on its own normalised copy and never touches the caller\'s layout', () => {
  const layout = starter();
  const before = structuredClone(layout);
  const sim = new Simulation(layout);
  sim.advance(600);
  assert.deepEqual(layout, before, 'the input layout is untouched');
  assert.notEqual(sim.layout, layout);
  assert.notEqual(sim.layout.stations, layout.stations);
  assert.equal(sim.settings, sim.layout.settings);
  layout.stations.length = 0;
  layout.settings.dt = 0.5;
  assert.equal(sim.stations.length, 4, 'later edits of the input do not reach the running simulation');
  assert.equal(sim.settings.dt, 0.1);
});

test('construction: exposes the parts, the runtime lists and the clock', () => {
  const sim = new Simulation(starter());
  assert.equal(sim.time, 0);
  assert.equal(sim.dt, sim.settings.dt);
  assert.equal(sim.stations, sim.logistics.stations);
  assert.equal(sim.vehicles, sim.logistics.vehicles);
  assert.equal(sim.flows, sim.logistics.flows);
  assert.equal(sim.stations.length, 4);
  assert.equal(sim.vehicles.length, 2);
  assert.equal(sim.flows.length, 2);
  assert.equal(sim.graph.nodes.length, Object.keys(sim.layout.roads).length);
  assert.equal(sim.traffic.vehicles.length, 2);
  assert.deepEqual(sim.deadlocks, []);
  assert.deepEqual(sim.runtime, { demandFactor: 1, speedFactor: 1, processFactor: 1, dispatch: 'nearest', routing: 'shortest' });
});

test('construction: tolerates junk layouts, rejects non-objects', () => {
  for (const junk of [{}, { stations: 'nope', grid: { cols: 'x' } }, { roads: { 'a,b': 3 }, fleets: [null, 7], flows: [{}] }]) {
    const sim = new Simulation(junk);
    sim.advance(60);
    assertAllFinite(sim.kpis());
  }
  for (const bad of [null, undefined, 5, 'layout']) assert.throws(() => new Simulation(bad), TypeError);
});

test('construction: the seed option overrides settings.seed (32-bit, junk ignored)', () => {
  const layout = starter();
  updateSettings(layout, { seed: 11 });
  assert.equal(new Simulation(layout).seed, 11);
  assert.equal(new Simulation(layout, { seed: 42 }).settings.seed, 42);
  assert.equal(new Simulation(layout, { seed: 42.9 }).seed, 42);
  assert.equal(new Simulation(layout, { seed: -1 }).seed, 4294967295);
  for (const junk of [undefined, NaN, Infinity, '7', null]) assert.equal(new Simulation(layout, { seed: junk }).seed, 11);
  assert.equal(layout.settings.seed, 11, 'the caller\'s layout keeps its seed');
});

// ---------------------------------------------------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------------------------------------------------

test('determinism: the same layout and seed give bit-identical KPIs and events, another seed does not', () => {
  const run = (seed) => {
    const sim = new Simulation(starter(), { seed });
    const log = record(sim);
    sim.advance(1800);
    return { kpis: json(sim), log: JSON.stringify(log), sim };
  };
  const a = run(5);
  const b = run(5);
  assert.equal(a.kpis, b.kpis);
  assert.equal(a.log, b.log);
  assert.ok(JSON.parse(a.log).length > 20, 'the run produced events');
  assert.notEqual(run(6).kpis, a.kpis);
  const viaLayout = starter();
  updateSettings(viaLayout, { seed: 5 });
  const c = new Simulation(viaLayout);
  c.advance(1800);
  assert.equal(json(c), a.kpis, 'the seed option and settings.seed are equivalent');
});

test('determinism: results do not depend on how a run is cut into advance() calls or time budgets', () => {
  const whole = new Simulation(starter(), { seed: 3 });
  whole.advance(900);
  const chunks = new Simulation(starter(), { seed: 3 });
  for (let i = 0; i < 90; i++) chunks.advance(10);
  const budgeted = new Simulation(starter(), { seed: 3 });
  let calls = 0;
  while (budgeted.time < 900 - 1e-6) {
    budgeted.advance(900 - budgeted.time, { maxMillis: 0, now: () => 0 });
    calls++;
  }
  const stepped = new Simulation(starter(), { seed: 3 });
  while (stepped.time < 900 - 1e-6) stepped.step();
  assert.ok(calls > 1, 'the budget really cut the run into pieces');
  for (const other of [chunks, budgeted, stepped]) {
    assert.equal(other.time, whole.time);
    assert.equal(json(other), json(whole));
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// step / advance
// ---------------------------------------------------------------------------------------------------------------------

test('step: one tick of settings.dt (or the given dt); junk steps do nothing', () => {
  const sim = new Simulation(lineLayout({ settings: { dt: 0.25 } }));
  sim.step();
  assert.equal(sim.time, 0.25);
  sim.step(0.5);
  assert.equal(sim.time, 0.75);
  for (const junk of [0, -1, NaN, Infinity, 'x']) {
    sim.step(junk);
    assert.equal(sim.time, 0.75, `step(${junk}) is ignored`);
  }
});

test('advance: whole ticks only; a request is rounded up to the next tick and returns the time really advanced', () => {
  const sim = new Simulation(lineLayout());
  assert.ok(Math.abs(sim.advance(1) - 1) < 1e-9);
  assert.equal(sim.time.toFixed(6), '1.000000');
  assert.equal(sim.advance(0.25).toFixed(6), '0.300000', '0.25 s need three 0.1 s ticks');
  assert.equal(sim.advance(0.001).toFixed(6), '0.100000', 'any positive request advances at least one tick');
  assert.equal(sim.time.toFixed(6), '1.400000');
});

test('advance: non-positive and non-finite requests advance nothing', () => {
  const sim = new Simulation(lineLayout());
  for (const junk of [0, -5, NaN, Infinity, -Infinity, '10', null, undefined]) assert.equal(sim.advance(junk), 0);
  assert.equal(sim.time, 0);
});

test('advance: the clock is read once per CLOCK_CHECK_TICKS ticks and only when a budget is given', () => {
  assert.equal(CLOCK_CHECK_TICKS, 32);
  const sim = new Simulation(lineLayout());
  let reads = 0;
  const now = () => { reads++; return 0; };
  sim.advance(60, { now });
  assert.equal(reads, 0, 'no budget, no clock');
  assert.equal(sim.time.toFixed(6), '60.000000');
  const start = sim.time;
  const advanced = sim.advance(1000, { maxMillis: 0, now });
  assert.equal(reads, 2, 'one reading at the start, one after the first batch of ticks');
  assert.equal(Math.round(advanced / sim.dt), CLOCK_CHECK_TICKS, 'a budget of nothing still makes progress: exactly one batch');
  assert.ok(Math.abs(sim.time - start - CLOCK_CHECK_TICKS * sim.dt) < 1e-9);
});

test('advance: a budget stops a long request after the batch in which it ran out, never earlier', () => {
  const sim = new Simulation(lineLayout());
  let clock = 0;
  const now = () => (clock += 3); // every reading is 3 ms later
  const advanced = sim.advance(1000, { maxMillis: 10, now });
  // readings: start 3, then 6 (3 ms used), 9 (6 ms), 12 (9 ms), 15 (12 ms >= 10): four batches
  assert.equal(Math.round(advanced / sim.dt), 4 * CLOCK_CHECK_TICKS);
  const short = new Simulation(lineLayout());
  assert.equal(short.advance(2, { maxMillis: 0, now: () => 0 }).toFixed(6), '2.000000', 'a request shorter than a batch is completed');
});

test('advance: the default clock is a real one (a generous budget does not cut anything)', () => {
  const sim = new Simulation(lineLayout());
  assert.ok(Math.abs(sim.advance(120, { maxMillis: 60000 }) - 120) < 1e-9);
});

// ---------------------------------------------------------------------------------------------------------------------
// Warm-up
// ---------------------------------------------------------------------------------------------------------------------

test('warm-up: statistics are reset exactly once, in the tick in which the clock reaches settings.warmup', () => {
  const sim = new Simulation(lineLayout({ settings: { warmup: 100 } }));
  let resets = 0;
  const original = sim.stats.reset.bind(sim.stats);
  sim.stats.reset = () => { resets++; original(); };
  sim.advance(99);
  assert.equal(resets, 0);
  assert.equal(sim.kpis().window.warmingUp, true);
  sim.advance(1);
  assert.equal(resets, 1, 'reset in the tick that makes the clock reach 100 s');
  assert.equal(sim.kpis().window.warmingUp, false);
  assert.ok(Math.abs(sim.kpis().window.start - 100) < 1e-6, 'the window starts at the end of the warm-up');
  assert.equal(sim.kpis().window.duration, 0);
  sim.advance(400);
  assert.equal(resets, 1, 'never again');
  const w = sim.kpis().window;
  assert.ok(Math.abs(w.duration - 400) < 1e-6 && Math.abs(w.end - 500) < 1e-6);
});

test('warm-up: loads that finish during the warm-up are not counted, the plant itself keeps them', () => {
  const sim = new Simulation(lineLayout({ vehicles: 2, settings: { warmup: 300 } }));
  sim.advance(300);
  const doneAtReset = sim.logistics.completed;
  assert.ok(doneAtReset > 0, 'the plant produced something during the warm-up');
  assert.equal(sim.kpis().throughput.total, 0);
  sim.advance(600);
  assert.equal(sim.kpis().throughput.total, sim.logistics.completed - doneAtReset);
  assert.equal(sim.kpis().leadTime.count, sim.kpis().throughput.total);
});

test('warm-up: with warmup 0 the measurement window starts at time 0 and nothing is reset', () => {
  const sim = new Simulation(lineLayout({ settings: { warmup: 0 } }));
  let resets = 0;
  const original = sim.stats.reset.bind(sim.stats);
  sim.stats.reset = () => { resets++; original(); };
  assert.equal(sim.kpis().window.warmingUp, false);
  sim.advance(60);
  assert.equal(resets, 0);
  const w = sim.kpis().window;
  assert.equal(w.start, 0);
  assert.ok(Math.abs(w.duration - 60) < 1e-6);
});

// ---------------------------------------------------------------------------------------------------------------------
// Live what-if settings
// ---------------------------------------------------------------------------------------------------------------------

test('setRuntime: only RUNTIME_KEYS are accepted, the rest is ignored', () => {
  const sim = new Simulation(starter());
  const before = structuredClone(sim.settings);
  const applied = sim.setRuntime({ dt: 1, seed: 9, warmup: 5, handedness: 'left', deadlock: 'ignore', duration: 100, count: 7, fleets: [] });
  assert.deepEqual(sim.settings, before);
  assert.deepEqual(applied, sim.runtime);
  assert.equal(sim.dt, 0.1);
  const all = sim.setRuntime({ demandFactor: 1.5, speedFactor: 2, processFactor: 0.5, dispatch: 'oldest', routing: 'congestion', dt: 1 });
  assert.deepEqual(all, { demandFactor: 1.5, speedFactor: 2, processFactor: 0.5, dispatch: 'oldest', routing: 'congestion' });
  assert.deepEqual(Object.keys(sim.runtime), RUNTIME_KEYS);
  for (const key of RUNTIME_KEYS) assert.equal(sim.settings[key], all[key], `sim.settings.${key} follows`);
  assert.equal(sim.traffic.speedFactor, 2, 'the traffic system sees the speed factor at once');
  assert.deepEqual(sim.logistics.runtime, all, 'and so does the logistics layer');
});

test('setRuntime: factors are clamped to the allowed range, junk values keep the current setting', () => {
  assert.deepEqual([MIN_FACTOR, MAX_FACTOR], [0.05, 20]);
  const sim = new Simulation(starter());
  sim.setRuntime({ demandFactor: 1000, speedFactor: 0, processFactor: -3 });
  assert.deepEqual([sim.runtime.demandFactor, sim.runtime.speedFactor, sim.runtime.processFactor], [20, 0.05, 0.05]);
  sim.setRuntime({ demandFactor: Infinity, speedFactor: -Infinity });
  assert.deepEqual([sim.runtime.demandFactor, sim.runtime.speedFactor], [20, 0.05]);
  sim.setRuntime({ demandFactor: 1.25, speedFactor: 1.5, processFactor: 0.8, dispatch: 'balanced', routing: 'congestion' });
  const kept = sim.runtime;
  for (const junk of [NaN, '2', null, undefined, {}, [], true]) sim.setRuntime({ demandFactor: junk, speedFactor: junk, processFactor: junk });
  sim.setRuntime({ dispatch: 'telepathy', routing: 42 });
  sim.setRuntime({ dispatch: 'constructor' });
  assert.deepEqual(sim.runtime, kept);
  for (const patch of [null, undefined, 5, 'x', []]) assert.deepEqual(sim.setRuntime(patch), kept);
  sim.advance(60);
  assertAllFinite(sim.kpis());
});

test('setRuntime: demand factor 2 doubles the arrivals of a source from then on', () => {
  const sim = new Simulation(lineLayout({ arrival: 60, vehicles: 2 }));
  const created = [];
  sim.on('loadCreated', (p) => { if (p.stationId === 'A') created.push(p.t); });
  sim.advance(1200);
  const first = created.length;
  assert.ok(first >= 20 && first <= 21, `${first} arrivals in the first 1200 s`);
  sim.setRuntime({ demandFactor: 2 });
  sim.advance(1200);
  const second = created.length - first;
  assert.ok(Math.abs(second - 2 * first) <= 2, `${second} arrivals in the next 1200 s, expected about ${2 * first}`);
  sim.setRuntime({ demandFactor: 0.5 });
  sim.advance(1200);
  const third = created.length - first - second;
  assert.ok(Math.abs(third - first / 2) <= 2, `${third} arrivals at half the rate`);
});

test('setRuntime: speed factor 2 doubles the speed vehicles reach and shortens the drive of a delivery, immediately', () => {
  const sim = new Simulation(lineLayout({ arrival: 150, vehicles: 1, gap: 30 }));
  const driving = [];
  sim.on('orderDelivered', (p) => driving.push({ at: p.t, drive: p.transit - p.vehicle.fleet.unloadTime }));
  const topSpeed = (seconds) => {
    let top = 0;
    for (let i = 0; i < seconds / sim.dt; i++) {
      sim.step();
      top = Math.max(top, ...sim.traffic.vehicles.map((tv) => tv.v));
    }
    return top;
  };
  const slowTop = topSpeed(1500);
  const slow = driving.filter((d) => d.at < 1500).map((d) => d.drive);
  sim.setRuntime({ speedFactor: 2 });
  topSpeed(100); // the vehicle that is on its way takes up the new limit
  const mark = sim.time;
  const fastTop = topSpeed(1500);
  const fast = driving.filter((d) => d.at > mark).map((d) => d.drive);
  assert.ok(Math.abs(slowTop - 1.5) < 1e-9, `top speed ${slowTop}`);
  assert.ok(fastTop > 2.9 && fastTop <= 3 + 1e-9, `top speed ${fastTop} at speed factor 2`);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(slow.length >= 5 && fast.length >= 5);
  assert.ok(mean(fast) < 0.75 * mean(slow), `driving ${mean(fast).toFixed(1)} s against ${mean(slow).toFixed(1)} s`);
});

test('setRuntime: process factor 2 halves the output of a process-bound workstation', () => {
  const sim = new Simulation(lineLayout({
    arrival: 4, cycle: 20, vehicles: 4, gap: 6, fleet: { capacity: 4, loadTime: 1, unloadTime: 1 }, source: { outCap: 100 }, process: { inCap: 30, outCap: 30 },
  }));
  sim.advance(600);
  const windowOutput = () => sim.stations.find((s) => s.id === 'B').produced;
  const first = windowOutput();
  sim.setRuntime({ processFactor: 2 });
  sim.advance(60); // let the cycles that run at the moment of the change finish
  const base = windowOutput();
  sim.advance(600);
  const second = windowOutput() - base;
  assert.ok(first >= 28 && first <= 31, `${first} cycles in 600 s of 20 s cycles`);
  assert.ok(second >= 14 && second <= 16, `${second} cycles in 600 s of 40 s cycles`);
  assert.ok(Math.abs(second / first - 0.5) < 0.06);
});

test('setRuntime: dispatch and routing can be switched while the plant runs', () => {
  const sim = new Simulation(starter());
  sim.advance(300);
  const before = sim.logistics.completed;
  sim.setRuntime({ dispatch: 'oldest', routing: 'congestion' });
  assert.equal(sim.logistics.routes.mode, 'congestion');
  sim.advance(1800);
  assert.ok(sim.logistics.completed > before, 'the plant keeps working');
  assertAllFinite(sim.kpis());
});

// ---------------------------------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------------------------------

test('events: on() returns an unsubscribe function; listeners get (payload, name)', () => {
  const sim = new Simulation(lineLayout({ vehicles: 2 }));
  const seen = [];
  const off = sim.on('loadCompleted', (payload, name) => seen.push([name, payload.leadTime, payload.stationId, payload.t]));
  sim.advance(600);
  assert.ok(seen.length >= 3);
  for (const [name, leadTime, stationId, t] of seen) {
    assert.equal(name, 'loadCompleted');
    assert.ok(leadTime > 0 && Number.isFinite(leadTime));
    assert.equal(stationId, 'C');
    assert.ok(t > 0 && t <= 600.1);
  }
  const count = seen.length;
  off();
  off(); // idempotent
  sim.advance(600);
  assert.equal(seen.length, count, 'no events after unsubscribing');
  assert.throws(() => sim.on('x', 'not a function'), TypeError);
  assert.throws(() => sim.on('*', null), TypeError);
});

test('events: the wildcard sees every event, after the named listeners; the same function may subscribe twice', () => {
  const sim = new Simulation(lineLayout({ vehicles: 2 }));
  const order = [];
  const all = [];
  sim.on('*', (payload, name) => { all.push(name); if (name === 'orderDelivered') order.push('wild'); });
  const twice = () => order.push('named');
  const offA = sim.on('orderDelivered', twice);
  const offB = sim.on('orderDelivered', twice);
  sim.advance(900);
  assert.deepEqual([...new Set(all)].sort(), ['loadCompleted', 'loadCreated', 'orderAssigned', 'orderDelivered', 'orderPickedUp']);
  const delivered = all.filter((n) => n === 'orderDelivered').length;
  assert.ok(delivered >= 3);
  assert.deepEqual(order.slice(0, 3), ['named', 'named', 'wild']);
  assert.equal(order.filter((x) => x === 'named').length, 2 * delivered);
  offA();
  order.length = 0;
  sim.advance(900);
  assert.equal(order.filter((x) => x === 'named').length, order.filter((x) => x === 'wild').length, 'one subscription is left');
  offB();
});

test('events: the statistics see an event before any listener does', () => {
  const sim = new Simulation(lineLayout({ vehicles: 2 }));
  const totals = [];
  sim.on('loadCompleted', () => totals.push(sim.kpis().throughput.total));
  sim.advance(600);
  assert.ok(totals.length >= 3);
  totals.forEach((total, i) => assert.equal(total, i + 1, 'the load that triggered the event is already counted'));
});

test('events: a listener may unsubscribe itself or others while an event is delivered', () => {
  const sim = new Simulation(lineLayout({ vehicles: 2 }));
  const calls = { a: 0, b: 0, c: 0 };
  const offA = sim.on('loadCreated', () => { calls.a++; offA(); offB(); });
  const offB = sim.on('loadCreated', () => { calls.b++; });
  sim.on('loadCreated', () => { calls.c++; });
  sim.advance(120);
  assert.equal(calls.a, 1);
  assert.equal(calls.b, 1, 'the delivery in progress reaches the listener that was removed meanwhile, later events do not');
  assert.ok(calls.c >= 2);
});

test('events: a throwing listener cannot leave the simulation half-stepped; step() rethrows after the tick', () => {
  const sim = new Simulation(lineLayout({ vehicles: 2 }));
  let later = 0;
  let boom = true;
  sim.on('loadCreated', () => { if (boom) { boom = false; throw new RangeError('listener bug'); } });
  sim.on('loadCreated', () => { later++; });
  let thrown = null;
  let ticks = 0;
  try {
    while (thrown === null && ticks < 1000) { ticks++; sim.step(); }
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof RangeError && thrown.message === 'listener bug');
  assert.ok(Math.abs(sim.time - ticks * 0.1) < 1e-9, 'the tick was completed and the clock advanced');
  assert.equal(later, 1, 'the other listeners still received the event');
  sim.advance(300);
  assert.ok(sim.logistics.completed > 0, 'the simulation carries on normally');
});

// ---------------------------------------------------------------------------------------------------------------------
// Deadlocks
// ---------------------------------------------------------------------------------------------------------------------

/** The report the traffic system hands to onDeadlock. */
function trafficReport(sim, { resolved = false, a = 0, b = 1 } = {}) {
  const [va, vb] = [sim.traffic.vehicles[a], sim.traffic.vehicles[b]];
  return { vehicles: [va, vb], nodes: [sim.graph.nodes[2], sim.graph.nodes[3]], resolved, victim: resolved ? va : null };
}

test('deadlock: a traffic report becomes an event, a history entry, a logistics re-plan and a KPI entry', () => {
  const sim = new Simulation(lineLayout({ vehicles: 2 }));
  sim.advance(30);
  const events = [];
  sim.on('deadlock', (payload, name) => events.push({ payload, name }));
  sim.traffic.onDeadlock(trafficReport(sim, { resolved: true }));
  assert.equal(events.length, 1);
  const { payload } = events[0];
  assert.equal(events[0].name, 'deadlock');
  assert.deepEqual(payload.vehicles, ['v1#1', 'v1#2']);
  assert.equal(payload.victim, 'v1#1');
  assert.equal(payload.resolved, true);
  assert.equal(payload.t, sim.time, 'stamped with the end of the last tick');
  assert.deepEqual(payload.nodes, [sim.graph.nodes[2], sim.graph.nodes[3]]);
  assert.equal(sim.logistics.deadlocks, 1);
  assert.equal(sim.vehicles[0].replan, true, 'the relocated victim plans its leg again');
  assert.equal(sim.vehicles[1].replan, false);
  assert.deepEqual(sim.deadlocks, [payload]);
  JSON.stringify(sim.deadlocks); // plain data
  const entries = sim.kpis().traffic.deadlockEvents;
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].vehicles, ['v1#1', 'v1#2']);
  assert.equal(entries[0].resolved, true);
});

test('deadlock: a jam reported unresolved and resolved later is one history entry', () => {
  const sim = new Simulation(lineLayout({ vehicles: 2 }));
  sim.advance(10);
  sim.traffic.onDeadlock(trafficReport(sim));
  assert.equal(sim.deadlocks.length, 1);
  assert.equal(sim.deadlocks[0].resolved, false);
  assert.equal(sim.deadlocks[0].victim, null);
  assert.equal(sim.vehicles[0].replan, false, 'no re-plan while the jam stands');
  const reportedAt = sim.deadlocks[0].t;
  sim.advance(20);
  sim.traffic.onDeadlock(trafficReport(sim, { resolved: true }));
  assert.equal(sim.deadlocks.length, 1);
  assert.equal(sim.deadlocks[0].resolved, true);
  assert.equal(sim.deadlocks[0].victim, 'v1#1');
  assert.equal(sim.deadlocks[0].t, reportedAt, 'it keeps the time it was first seen');
  assert.equal(sim.kpis().traffic.deadlockEvents.length, 1);
  assert.equal(sim.kpis().traffic.deadlockEvents[0].resolved, true);
});

test('deadlock: sim.deadlocks keeps the most recent DEADLOCK_HISTORY reports', () => {
  assert.equal(DEADLOCK_HISTORY, 50);
  const sim = new Simulation(lineLayout({ vehicles: 3 }));
  sim.advance(5);
  const [x, y, z] = sim.traffic.vehicles;
  const pairs = [[x, y], [y, z], [x, z]];
  for (let i = 0; i < 120; i++) {
    sim.step();
    sim.traffic.onDeadlock({ vehicles: pairs[i % 3], nodes: [sim.graph.nodes[i % 5]], resolved: true, victim: pairs[i % 3][0] });
    sim.deadlocks[sim.deadlocks.length - 1].tag = i; // tell the entries apart
  }
  assert.equal(sim.deadlocks.length, DEADLOCK_HISTORY);
  assert.equal(sim.deadlocks[0].tag, 120 - DEADLOCK_HISTORY);
  assert.equal(sim.deadlocks[DEADLOCK_HISTORY - 1].tag, 119);
  assert.equal(sim.logistics.deadlocks, 120);
});

// ---------------------------------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------------------------------

test('results: kpis() is a JSON-safe report of the window, insights() reads it, heat() matches the graph', () => {
  const sim = new Simulation(starter(), { seed: 2 });
  sim.advance(2400);
  const report = sim.kpis();
  assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  assert.equal(report.window.warmingUp, false);
  assert.ok(report.throughput.total > 0);
  const insights = sim.insights();
  assert.ok(Array.isArray(insights) && insights.length > 0);
  for (const i of insights) assert.ok(['critical', 'warning', 'info', 'good'].includes(i.severity) && i.title && i.refs);
  const warming = { window: { warmingUp: true, duration: 0 } };
  assert.equal(sim.insights(warming).length, 1, 'insights(report) analyses the report it is given');
  assert.deepEqual(sim.insights(report), insights);

  const heat = sim.heat();
  assert.ok(heat.edgePasses instanceof Int32Array && heat.edgePasses.length === sim.graph.edges.length);
  assert.ok(heat.edgeWait instanceof Float64Array && heat.edgeWait.length === sim.graph.edges.length);
  assert.ok(heat.nodeWait instanceof Float64Array && heat.nodeWait.length === sim.graph.nodeCount);
  assert.ok(heat.maxEdgePasses > 0);
  assert.equal(heat.maxEdgePasses, Math.max(...heat.edgePasses));
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const t = report.traffic;
  const waited = t.vehicleWait + t.junctionWait + (t.brokenWait ?? 0);
  assert.ok(Math.abs(sum(heat.edgeWait) - waited) < 1e-6, 'the heat map accounts for all waiting of the window');
  assert.ok(Math.abs(sum(heat.nodeWait) - waited) < 1e-6);
});

test('results: heat() is relative to the measurement window (the reset at the end of the warm-up clears it)', () => {
  const sim = new Simulation(lineLayout({ vehicles: 3, gap: 4, arrival: 15, settings: { warmup: 300 } }));
  sim.advance(299);
  assert.ok(sim.heat().maxEdgePasses > 0, 'the warm-up already has traffic');
  sim.advance(1);
  const fresh = sim.heat();
  assert.equal(fresh.maxEdgePasses, 0);
  assert.equal(fresh.maxEdgeWait, 0);
  assert.equal(fresh.maxNodeWait, 0);
  sim.advance(300);
  assert.ok(sim.heat().maxEdgePasses > 0);
});

test('results: the renderer finds what it needs (vehicles, stations, flows, deadlock list, heat) in the shapes it expects', () => {
  const sim = new Simulation(EXAMPLES.find((e) => e.id === 'two-lines').build());
  sim.advance(900);
  for (const v of sim.vehicles) {
    for (const key of ['x', 'y', 'heading', 'prevX', 'prevY', 'prevHeading', 'battery']) assert.ok(Number.isFinite(v[key]), `${v.id}.${key}`);
    assert.equal(typeof v.visible, 'boolean');
    assert.equal(typeof v.state, 'string');
    assert.equal(typeof v.color, 'string');
    assert.equal(typeof v.tv.waiting, 'boolean');
    assert.ok(v.fleet && v.fleetId);
  }
  assert.ok(sim.vehicles.some((v) => v.visible) && sim.vehicles.some((v) => !v.visible), 'some vehicles drive, some are parked inside a depot');
  for (const s of sim.stations) {
    assert.ok(['source', 'process', 'storage', 'sink', 'depot'].includes(s.type));
    assert.equal(typeof s.state, 'string');
    assert.equal(typeof s.fillLabel, 'string');
    assert.ok(s.fill >= 0 && s.fill <= 1);
  }
  for (const s of sim.stations) {
    if (s.type === 'source') assert.equal(typeof s.yard, 'number');
    if (s.type === 'sink') assert.equal(typeof s.consumed, 'number');
    if (s.type === 'process') {
      assert.ok(Array.isArray(s.machines) && s.machines.length === s.def.params.machines);
      for (const m of s.machines) assert.ok(['idle', 'busy', 'blocked', 'down'].includes(m.state) && m.progress >= 0 && m.progress <= 1);
    }
    if (s.type === 'depot') {
      assert.ok(Array.isArray(s.parked) && Array.isArray(s.charging));
      assert.ok(Number.isInteger(s.slots) && Number.isInteger(s.chargers) && s.chargers <= s.slots);
    }
  }
  assert.ok(sim.stations.some((s) => s.type === 'depot' && (s.charging.length > 0 || s.parked.length > 0)), 'vehicles are parked in a depot');
  assert.equal(sim.logistics.stationById.get(sim.stations[0].id), sim.stations[0]);
  assert.ok(sim.flows.length === 6 && sim.flows.every((f) => Number.isFinite(f.delivered)));
  assert.ok(Array.isArray(sim.traffic.activeDeadlocks) && typeof sim.traffic.activeDeadlocks[Symbol.iterator] === 'function');
  assert.equal(typeof sim.graph.cols, 'number');
  assert.equal(typeof sim.graph.cellSize, 'number');
  assert.ok(sim.graph.edges.every((e, i) => e.id === i));
  assert.equal(typeof sim.heat, 'function');
});

// ---------------------------------------------------------------------------------------------------------------------
// Awkward plants: nothing throws, nothing is NaN
// ---------------------------------------------------------------------------------------------------------------------

/** Run a layout for ten minutes and look at everything a UI might ask for. */
function exercise(layout, minutes = 10) {
  const sim = new Simulation(layout);
  sim.advance(minutes * 60);
  const report = sim.kpis();
  assertAllFinite(report);
  assertAllFinite(sim.heat(), 'heat');
  JSON.stringify(report);
  assert.ok(Array.isArray(sim.insights(report)));
  assert.ok(sim.time >= minutes * 60 - 1e-9);
  return { sim, report };
}

const stationOnly = () => {
  const layout = createLayout({ cols: 20, rows: 12 });
  addStation(layout, { type: 'source', x: 1, y: 1 });
  addStation(layout, { type: 'sink', x: 10, y: 5 });
  return layout;
};

test('awkward plants: an empty layout, no roads, no flows, no vehicles, no stations', () => {
  const { report: empty } = exercise(createLayout());
  assert.equal(empty.throughput.total, 0);
  assert.deepEqual(empty.fleets, {});
  assert.deepEqual(empty.stations, {});
  assert.equal(empty.traffic.waitShare, 0);

  const noRoads = stationOnly();
  addFlow(noRoads, 's1', 's2');
  addFleet(noRoads, 'agv', { count: 2 });
  const { sim, report } = exercise(noRoads);
  assert.equal(report.throughput.total, 0);
  assert.equal(sim.logistics.unplaced.length, 2, 'the vehicles found no road to stand on');
  assert.equal(sim.vehicles.length, 0);
  assert.ok(sim.logistics.liveLoads > 0, 'the source keeps producing');

  const noFleet = stationOnly();
  paintRoadPath(noFleet, [[1, 3], [12, 3], [12, 5]]);
  addFlow(noFleet, 's1', 's2');
  assert.equal(exercise(noFleet).report.throughput.total, 0);

  const zeroCount = cloneLayout(noFleet);
  addFleet(zeroCount, 'agv', { count: 0 });
  const zero = exercise(zeroCount);
  assert.equal(zero.sim.vehicles.length, 0);
  assert.equal(zero.report.fleets.v1.count, 0);
  assert.equal(zero.report.fleets.v1.shares.idle, 1);

  const noFlows = cloneLayout(noFleet);
  addFleet(noFlows, 'agv', { count: 2 });
  noFlows.flows = [];
  assert.equal(exercise(noFlows).report.throughput.total, 0);
});

test('awkward plants: a flow that cannot be driven (disconnected roads, a pickup dock out of reach) is simply never served', () => {
  const split = layoutFromAscii([
    'AA...........BB',
    '++++.......++++',
  ], { stations: { A: 'source', B: 'sink' }, flows: [['A', 'B']], fleets: [{ count: 2 }] });
  const { report, sim } = exercise(split);
  assert.equal(report.throughput.total, 0);
  assert.equal(sim.logistics.orderSeq, 0, 'no order was ever created for the unreachable flow');
  assert.ok(report.stations.A.yardMax >= 0);

  const deadEnd = layoutFromAscii([
    'AA.....BB',
    '>>>>>>>>>',
  ], { stations: { A: 'source', B: 'sink' }, flows: [['A', 'B']], fleets: [{ count: 1 }] });
  const dead = exercise(deadEnd, 20);
  assert.equal(dead.sim.logistics.orderSeq, 0, 'the vehicle stands downstream of the only pickup dock of the one-way road and can never reach it');
  assert.equal(dead.sim.vehicles[0].state, 'idle');
});

test('awkward plants: more vehicles than the road can hold, very fast sources, tiny buffers, huge batches', () => {
  const crowded = layoutFromAscii([
    'AA..BB',
    '++++++',
  ], { stations: { A: 'source', B: 'sink' }, flows: [['A', 'B']], fleets: [{ count: 40, length: 1.8 }] });
  const { sim } = exercise(crowded);
  assert.ok(sim.logistics.unplaced.length > 0 && sim.vehicles.length + sim.logistics.unplaced.length === 40);

  const flood = lineLayout({ arrival: 0.5, vehicles: 2, source: { outCap: 1, batch: 50 }, process: { inCap: 1, outCap: 1 } });
  const { report } = exercise(flood);
  assert.ok(report.stations.A.yardMax > 10, 'the yard of the overloaded source grows');

  const huge = lineLayout({ arrival: 5, vehicles: 1, fleet: { capacity: 100 }, source: { batch: 100 } });
  exercise(huge);
});

test('awkward plants: zero-length cycles and arrival intervals, no road limit surprises, extreme dt', () => {
  const fast = lineLayout({ arrival: 0.5, cycle: 0.5, vehicles: 2, settings: { dt: 0.5 } });
  const { sim } = exercise(fast);
  assert.equal(sim.dt, 0.5);

  const quick = lineLayout({ settings: { dt: 0.01 }, vehicles: 1 });
  const q = new Simulation(quick);
  q.advance(20);
  assertAllFinite(q.kpis());
  assert.equal(q.time.toFixed(6), '20.000000');

  const slow = lineLayout();
  for (const cell of Object.values(slow.roads)) cell.limit = 0.1;
  exercise(slow);
});

test('awkward plants: breakdowns, batteries and chargers together do not produce NaN', () => {
  const layout = EXAMPLES.find((e) => e.id === 'two-lines').build();
  for (const fleet of layout.fleets) { fleet.mtbf = 600; fleet.mttr = 120; }
  layout.fleets[1].battery.runtimeMin = 5;
  const { report } = exercise(layout, 20);
  assert.ok(report.fleets.v2.minBattery !== null && report.fleets.v2.minBattery >= 0);
});

test('robustness: layouts with randomly corrupted fields never throw and never produce NaN', () => {
  const rng = createRng(2024);
  const junk = [NaN, Infinity, -Infinity, -1, 0, 1e9, -1e9, null, undefined, 'x', '12', true, [], {}, 0.0001, 3.7];
  const slotsOf = (value) => {
    const found = [];
    if (value !== null && typeof value === 'object') {
      for (const key of Object.keys(value)) found.push([value, key], ...slotsOf(value[key]));
    }
    return found;
  };
  const bases = [starter(), lineLayout({ vehicles: 3 }), randomPlant(3), randomPlant(11)];
  for (let i = 0; i < 80; i++) {
    const layout = structuredClone(bases[i % bases.length]);
    const slots = slotsOf(layout);
    for (let k = 1 + rng.int(6); k > 0; k--) {
      const [owner, key] = slots[rng.int(slots.length)];
      if (rng.next() < 0.15) delete owner[key];
      else owner[key] = junk[rng.int(junk.length)];
    }
    const sim = new Simulation(layout);
    sim.advance(240);
    sim.setRuntime({ demandFactor: junk[rng.int(junk.length)], speedFactor: junk[rng.int(junk.length)] });
    sim.advance(60);
    assertAllFinite(sim.kpis(), `corruption ${i}`);
    assertAllFinite(sim.heat(), `heat ${i}`);
    assert.ok(Array.isArray(sim.insights()));
  }
});

test('defaults: a simulation built from default settings advances with the default time step', () => {
  const sim = new Simulation(lineLayout());
  assert.equal(sim.dt, defaultSettings().dt);
  sim.step();
  assert.ok(Math.abs(sim.time - defaultSettings().dt) < 1e-12);
});
