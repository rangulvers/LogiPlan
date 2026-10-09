// Milestone M0 of the warehouse module (docs/WAREHOUSE-DESIGN.md 5.4, F10, 9.1): the simulation seams. They are present but inert:
//   * the fixed shapes of loads and orders (ty, tk, at, slot / pickAt, dropAt, pickExtra, dropExtra) and of StationRT, Logistics and Stats
//   * the ONE accessor for the capacity of a storage (st.capacity) in the six places that read it
//   * the extension hooks: Logistics.ext, the five call sites in Stats, the extension lists of insights and validation
//   * the optional `trucks` field in the logistics invariants helper
// Behaviour is not tested here (the golden tests do that); these tests pin the SHAPES and prove that each seam is really wired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Simulation } from '../js/sim/engine.js';
import { Stats } from '../js/sim/stats.js';
import { EXTENSION_RULES } from '../js/sim/insights.js';
import { bufferSize } from '../js/ui/render/jobs.js';
import { flowCapacity, flowSpace } from '../js/sim/logistics/stations.js';
import { EXAMPLES } from '../js/model/examples.js';
import { validateLayout } from '../js/model/validate.js';
import { OPS_CHECKS, validateOps } from '../js/model/validate-ops.js';
import { dist } from '../js/model/defaults.js';
import { layoutFromAscii } from './helpers/ascii.js';
import { checkInvariants, createWorld, injectLoads } from './helpers/logistics-invariants.js';
import { createAuditor } from './helpers/engine-review-gen.js';

const OFF = dist('const', 0);
const starter = () => EXAMPLES.find((e) => e.id === 'starter').build();

const LOAD_KEYS = 'id,createdAt,origin,readyAt,claimed,ty,tk,at,slot';
const ORDER_KEYS = 'id,flowId,from,to,qty,vehicleId,loads,createdAt,readySince,pickedAt,deliveredAt,pickAt,dropAt,pickExtra,dropExtra';
const REPORT_KEYS = 'window,throughput,leadTime,wip,stations,fleets,flows,traffic,orders,series';

// ---------------------------------------------------------------------------------------------------------------------------
// Fixed shapes (5.4)
// ---------------------------------------------------------------------------------------------------------------------------

test('loads and orders have the fixed shape of 5.4, keys in a fixed order, new fields inert', () => {
  const sim = new Simulation(starter(), { seed: 1 });
  const loads = [];
  const orders = [];
  sim.on('loadCreated', ({ load }) => loads.push(load));
  sim.on('orderAssigned', ({ order }) => orders.push(order));
  sim.advance(900);
  assert.ok(loads.length >= 3 && orders.length >= 3, 'the plant made loads and orders');
  for (const load of loads) {
    assert.equal(Object.keys(load).join(), LOAD_KEYS);
    assert.deepEqual([load.ty, load.tk, load.at, load.slot], [0, -1, -1, -1]);
  }
  for (const order of orders) {
    assert.equal(Object.keys(order).join(), ORDER_KEYS, 'order.flow stays a non-enumerable property');
    assert.deepEqual([order.pickAt, order.dropAt, order.pickExtra, order.dropExtra], [-1, -1, 0, 0]);
    assert.equal(typeof order.flow, 'object');
    assert.equal(Object.keys(order).includes('flow'), false);
  }
});

test('StationRT, Logistics and Stats carry the inert fields of 5.4', () => {
  const sim = new Simulation(starter(), { seed: 1 });
  for (const st of sim.logistics.stations) {
    assert.deepEqual([st.trucks, st.rack, st.cal], [null, null, null], st.id);
  }
  assert.equal(sim.logistics.ext, null);
  assert.equal(sim.logistics.clock, null);
  assert.equal(sim.stats.ext, null);
  sim.advance(900);
  assert.equal(Object.keys(sim.kpis()).join(), REPORT_KEYS, 'a legacy report has no ops key');
});

// ---------------------------------------------------------------------------------------------------------------------------
// st.capacity (F10)
// ---------------------------------------------------------------------------------------------------------------------------

test('st.capacity answers params.capacity for a storage and nothing for the other types', () => {
  const layout = layoutFromAscii(['A..S..D', '+++++++'], { stations: { A: { type: 'source', params: { interArrival: OFF } }, S: { type: 'storage', params: { capacity: 13 } }, D: 'sink' }, flows: [['A', 'S'], ['S', 'D']] });
  const w = createWorld(layout);
  const by = (id) => w.lg.stationById.get(id);
  assert.equal(by('S').capacity, 13);
  assert.equal(by('A').capacity, undefined);
  assert.equal(by('D').capacity, undefined);
  by('S').params.capacity = 5;
  assert.equal(by('S').capacity, 5, 'follows params.capacity');
});

test('the capacity of a storage is read through st.capacity in all six places of F10', () => {
  // S is a storage with a stated capacity of 40; the accessor is overridden on the instance to 7, so every place that still read
  // params.capacity would show 40 instead.
  const build = ({ batchMin = 1 } = {}) => layoutFromAscii(['A...S...D', '+++++++++'], {
    stations: { A: { type: 'source', params: { interArrival: OFF } }, S: { type: 'storage', params: { capacity: 40 } }, D: 'sink' },
    flows: [['A', 'S'], ['S', 'D', { batchMin }]], fleets: [{ count: 1, capacity: 10 }],
  });
  const w = createWorld(build(), { dt: 0.5, check: true });
  const st = w.lg.stationById.get('S');
  Object.defineProperty(st, 'capacity', { get: () => 7 });
  const [intoStorage] = w.lg.flows;
  assert.equal(st.params.capacity, 40, 'the parameter itself is untouched');
  assert.equal(flowSpace(intoStorage), 7, 'flowSpace');
  assert.equal(flowCapacity(intoStorage), 7, 'flowCapacity');
  assert.equal(st.fill, 0);
  assert.equal(st.fillLabel, '0/7', 'fillLabel');
  injectLoads(w.lg, 'f2', 3);
  assert.equal(flowSpace(intoStorage), 4);
  assert.equal(st.fillLabel, '3/7');
  assert.ok(Math.abs(st.fill - 3 / 7) < 1e-12, 'fill');
  assert.equal(st.state, 'normal');
  injectLoads(w.lg, 'f2', 4);
  assert.equal(st.state, 'full', 'state: full at 7 loads although params.capacity is 40');
  assert.equal(flowSpace(intoStorage), 0);
});

test('the seventh reader: the jobs overlay sizes a storage buffer through st.capacity too (render/jobs.js bufferSize)', () => {
  const layout = layoutFromAscii(['A...S...D', '+++++++++'], {
    stations: { A: { type: 'source', params: { interArrival: OFF } }, S: { type: 'storage', params: { capacity: 40 } }, D: 'sink' },
    flows: [['A', 'S'], ['S', 'D']], fleets: [{ count: 1, capacity: 10 }],
  });
  const st = createWorld(layout, { dt: 0.5 }).lg.stationById.get('S');
  assert.equal(bufferSize(st), 40, 'a real runtime station: the same number as params.capacity');
  Object.defineProperty(st, 'capacity', { get: () => 7 });
  assert.equal(bufferSize(st), 7, 'and when the station answers something else, the overlay follows it');
});

test('ledger of the reads of a storage capacity: the runtime asks the station, the layout-level readers are the ones M3 has to route through a helper', () => {
  // A new `params.capacity` read anywhere in js/ fails this test, so that it is decided on the spot: ask the station (st.capacity) at run time,
  // and at layout level use the helper M3 adds next to the rack mathematics (the readers below are the ones it replaces). The patterns are
  // `params.capacity`, `params?.capacity` and `paramsOf(x).capacity`; report.js reads the same value through a local `p` (js/ui/report.js, stationParams).
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');
  const pattern = /params\??\.capacity|paramsOf\([^)]*\)\.capacity/g;
  const found = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.js')) {
        const n = (readFileSync(file, 'utf8').match(pattern) || []).length;
        if (n) found[path.relative(root, file)] = n;
      }
    }
  };
  walk(root);
  assert.deepEqual(found, {
    'model/validate.js': 5, // layout level: the buffer between two stations, the smallest limit on a flow, storage-small (M3: helper)
    'sim/experiments.js': 1, // layout level: the sweep of a storage capacity (M3: helper; a sweep of a rack changes its geometry, not this number)
    'sim/insights.js': 1, // layout level: the storage-filling rules read the definition (M3: helper)
    'sim/logistics/stations.js': 2, // the accessor `get capacity()` itself (one in its comment)
    'ui/render/jobs.js': 1, // the fallback for a plain stand-in that has no `capacity` (bufferSize)
  });
});

test('the dispatcher limits the smallest worthwhile batch by st.capacity of the origin (dispatcher.js line 79)', () => {
  // batchMin 5, but the origin can never hold more than 2 loads: the batch is clamped to 2 and goes. With the real capacity (40) it waits.
  const layout = layoutFromAscii(['S.......D', '+++++++++'], { stations: { S: { type: 'storage', params: { capacity: 40 } }, D: 'sink' }, flows: [['S', 'D', { batchMin: 5 }]], fleets: [{ count: 1, capacity: 10 }] });
  const run = (capacity) => {
    const w = createWorld(layout, { dt: 0.5, check: true });
    if (capacity !== undefined) Object.defineProperty(w.lg.stationById.get('S'), 'capacity', { get: () => capacity });
    injectLoads(w.lg, 'f1', 2);
    w.run(10);
    return [...w.lg.activeOrders.values()].map((o) => o.qty).concat(w.lg.ordersDelivered > 0 ? ['delivered'] : []);
  };
  assert.deepEqual(run(undefined), [], 'capacity 40: two loads wait for a batch of five');
  assert.deepEqual(run(2).slice(0, 1), [2], 'capacity 2: the batch is clamped to the two loads and a vehicle takes them');
});

// ---------------------------------------------------------------------------------------------------------------------------
// The extension hooks
// ---------------------------------------------------------------------------------------------------------------------------

test('Stats calls the extension hooks of Logistics.ext at its five call sites, and only a report with an extension has `ops`', () => {
  const sim = new Simulation(starter(), { seed: 1 });
  const calls = [];
  sim.logistics.ext = {
    stats(stats) {
      calls.push(['stats', stats]);
      return {
        reset() { calls.push(['reset']); },
        sample(dt) { calls.push(['sample', dt]); },
        onEvent(name) { calls.push(['onEvent', name]); },
        report(report) { calls.push(['report']); report.ops = { hello: 'world' }; },
      };
    },
  };
  const stats = new Stats(sim); // builds its accumulators (hook 1, `stats`) and starts a window (hook 2, `reset`)
  assert.deepEqual(calls.map((c) => c[0]), ['stats', 'reset']);
  assert.equal(calls[0][1], stats, 'the extension gets the Stats it belongs to');
  assert.notEqual(stats.ext, null);
  stats.sample(0.1);
  stats.onEvent('orderAssigned', {});
  stats.onEvent('loadCompleted', { leadTime: 5 });
  assert.deepEqual(calls.slice(2).map((c) => c.join(':')), ['sample:0.1', 'onEvent:orderAssigned', 'onEvent:loadCompleted'], 'sample and every event reach the extension');
  stats.sample(0);
  stats.sample(NaN);
  assert.equal(calls.length, 5, 'a tick that Stats ignores is not passed on');
  stats.reset();
  const report = stats.report();
  assert.deepEqual(calls.slice(5).map((c) => c[0]), ['reset', 'report']);
  assert.deepEqual(report.ops, { hello: 'world' });
  assert.equal(Object.keys(report).join(), `${REPORT_KEYS},ops`, 'ops is the last key');
  assert.doesNotThrow(() => JSON.stringify(report));
  // and the same Stats without an extension: no hook, no key
  sim.logistics.ext = null;
  const plain = new Stats(sim);
  assert.equal(plain.ext, null);
  assert.equal(Object.keys(plain.report()).join(), REPORT_KEYS);
});

test('insights: rules of an extension run after the built-in rules; the list holds the five rules of M1 (trucks and doors), which are silent for a legacy plant', () => {
  assert.deepEqual(EXTENSION_RULES.map((r) => r.name), ['gateQueueLong', 'doorsBottleneck', 'unloadLimitedByVehicles', 'doorsIdle', 'outboundShort']);
  const sim = new Simulation(starter(), { seed: 1 });
  sim.advance(1800);
  const before = sim.insights();
  assert.ok(before.length > 0 && !before.some((i) => i.id === 'ext-test'));
  const rule = (ctx) => [{ magnitude: 1e9, insight: { id: 'ext-test', severity: 'warning', title: 'Extension rule', detail: `window ${ctx.duration}`, refs: {} } }];
  EXTENSION_RULES.push(rule);
  try {
    const after = sim.insights();
    assert.ok(after.some((i) => i.id === 'ext-test'), 'the rule contributed an insight');
    assert.equal(after[0].id, 'ext-test', 'and it is ordered like any other warning (highest magnitude first)');
    assert.ok(!after.some((i) => i.id === 'good'), 'a warning from an extension replaces the good-news insight');
  } finally {
    EXTENSION_RULES.splice(EXTENSION_RULES.indexOf(rule), 1);
  }
  assert.deepEqual(sim.insights().map((i) => i.id), before.map((i) => i.id), 'removed again: the insights are the old ones');
});

test('validation: validateLayout calls validateOps once; checks of an extension add their issues; the list holds the four checks of M1 (trucks and doors), which are silent for a legacy plant', () => {
  assert.deepEqual(OPS_CHECKS.map((c) => c.name), ['checkDoorsTooFew', 'checkDoorsExceedDocks', 'checkDocksShareLane', 'checkTimetableEmpty']);
  assert.equal(typeof validateOps, 'function');
  const layout = starter();
  const before = validateLayout(layout).map((i) => i.id);
  let calls = 0;
  const check = (ctx, add) => {
    calls++;
    assert.ok(ctx.layout === layout && typeof add === 'function', 'the same context the built-in checks get');
    add('warning', 'ext-test', 'layout', 'An extension check.', 'Nothing to do.');
  };
  OPS_CHECKS.push(check);
  try {
    const issues = validateLayout(layout);
    assert.equal(calls, 1);
    const mine = issues.find((i) => i.code === 'ext-test');
    assert.deepEqual([mine.id, mine.severity, mine.message], ['ext-test:layout', 'warning', 'An extension check.']);
  } finally {
    OPS_CHECKS.splice(OPS_CHECKS.indexOf(check), 1);
  }
  assert.deepEqual(validateLayout(layout).map((i) => i.id), before);
});

// ---------------------------------------------------------------------------------------------------------------------------
// Test helper: the optional `trucks` field
// ---------------------------------------------------------------------------------------------------------------------------

test('logistics-invariants counts the loads that trucks hold (pending at the gate and at a door, staged) as live and present', () => {
  const layout = layoutFromAscii(['A..D', '++++'], { stations: { A: { type: 'source', params: { interArrival: OFF } }, D: 'sink' }, flows: [['A', 'D']] });
  const w = createWorld(layout, { dt: 0.5 });
  const src = w.lg.stationById.get('A');
  const held = w.lg.createLoad(src, 0, 0, 'source'); // created and live, but in no queue: where a truck keeps it until check-in is over
  assert.ok(checkInvariants(w.lg).some((m) => /liveLoads 1 != physical 0/.test(m)), 'without a trucks field the load is lost');
  src.trucks = { gate: [{ id: 't1', pending: [held] }], docked: [], staged: [] };
  assert.deepEqual(checkInvariants(w.lg), [], 'waiting at the gate');
  src.trucks = { gate: [], docked: [{ id: 't1', pending: [held] }], staged: [] };
  assert.deepEqual(checkInvariants(w.lg), [], 'at a door');
  src.trucks = { gate: [], docked: [], staged: [held] };
  assert.deepEqual(checkInvariants(w.lg), [], 'staged at a Goods out');
  src.trucks = { gate: [{ id: 't1', pending: [held] }], docked: [{ id: 't2', pending: [held] }], staged: [] };
  assert.ok(checkInvariants(w.lg).some((m) => /exists twice/.test(m)), 'a pallet on two trucks is caught');
  src.trucks = {};
  assert.ok(checkInvariants(w.lg).length > 0, 'a trucks field without lists holds nothing');
  src.trucks = null;
  assert.ok(checkInvariants(w.lg).length > 0);
  w.lg.completeLoad(held, src, 0); // tidy up: the load leaves the system
  assert.deepEqual(checkInvariants(w.lg), []);
});

test('the engine-review auditor (tests/helpers/engine-review-gen.js) counts the loads that trucks hold, and asks st.capacity for the capacity of a storage', () => {
  const layout = layoutFromAscii(['A..S..D', '+++++++'], {
    stations: { A: { type: 'source', params: { interArrival: OFF } }, S: { type: 'storage', params: { capacity: 4 } }, D: 'sink' }, flows: [['A', 'S'], ['S', 'D']],
  });
  const sim = new Simulation(layout, { seed: 1 });
  const auditor = createAuditor(sim);
  const src = sim.stations.find((st) => st.type === 'source');
  const held = sim.logistics.createLoad(src, 0, 0, 'source'); // exists, but is in no queue: where a truck keeps it until check-in is over
  assert.ok(auditor.full().some((m) => /live loads: found 0 in the plant/.test(m)), 'without a trucks field the load is lost');
  src.trucks = { gate: [{ id: 't1', pending: [held] }], docked: [], staged: [] };
  assert.deepEqual(auditor.full(), [], 'waiting at the gate');
  src.trucks = { gate: [], docked: [{ id: 't1', pending: [held] }], staged: [] };
  assert.deepEqual(auditor.full(), [], 'at a door');
  src.trucks = { gate: [], docked: [], staged: [held] };
  assert.deepEqual(auditor.full(), [], 'staged');
  src.trucks = { gate: [{ id: 't1', pending: [held] }], docked: [], staged: [held] };
  assert.ok(auditor.full().some((m) => /found twice/.test(m)), 'a pallet in two places is caught');
  src.trucks = null;
  sim.logistics.completeLoad(held, src, 0);
  const store = sim.stations.find((st) => st.type === 'storage');
  Object.defineProperty(store, 'capacity', { get: () => 0 }); // a storage that answers 0 while it holds nothing is fine; one that holds more than it answers is not
  assert.deepEqual(auditor.full(), []);
  const stored = sim.logistics.createLoad(src, 0, 0, 'source');
  store.pool.push(stored);
  assert.ok(auditor.full().some((m) => /holds 1 > capacity 0/.test(m)), 'the auditor reads st.capacity, not params.capacity (4)');
});
