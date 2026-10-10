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
import { DETAIL_IMPORT, DETAIL_OWNERS, detailStrays, stripComments as _stripComments } from './helpers/detail-ledger.js';

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

// ---------------------------------------------------------------------------------------------------------------------------
// The detail collector (docs/ENTITY-INSIGHTS-DESIGN.md 6.1, acceptance S1.1 and S1.15): a second seam, separate from stats.ext. Two ledgers:
//   1. who touches the collector: `.detail`, enableDetail, ... may appear only in the files that own it
//   2. which internals of the simulation the collector reads (~70 chains), each probed against a live plant, and the source of detail.js scanned for any read that is not listed,
//      so that an in-flight change to one of them fails a NAMED test instead of silently changing the statistics
// ---------------------------------------------------------------------------------------------------------------------------

const JS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');
const jsFiles = () => {
  const out = [];
  const walk = (dir) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else if (entry.name.endsWith('.js')) out.push(file); } };
  walk(JS_ROOT);
  return out.map((file) => ({ rel: path.relative(JS_ROOT, file).split(path.sep).join('/'), source: readFileSync(file, 'utf8') }));
};
const stripComments = _stripComments;

test('ledger of the readers of the collector: only detail.js, engine.js, runner.js, the stats-*.js panels and render/routes.js touch it', () => {
  // the rules are tests/helpers/detail-ledger.js (shared with the review that attacks them): the seam names, an import of detail.js in any quote or as import(), and a property
  // `detail` read in any form (x.detail, this.detail, x['detail'], const { detail } = x) unless the receiver is a known text (an insight, a notice, the preference ui.detail ...)
  const strays = [];
  let owners = 0;
  for (const { rel, source } of jsFiles()) {
    if (DETAIL_OWNERS(rel)) { if (/\.detail\b|\b(?:enableDetail|disableDetail|dropDetail|detailError|afterTickSafe)\b/.test(stripComments(source))) owners++; continue; }
    for (const stray of detailStrays(rel, source)) strays.push(`${rel}: ${stray}`);
  }
  assert.deepEqual(strays, [], 'only detail.js, engine.js, runner.js, ui/panels/stats-*.js and ui/render/routes.js may touch sim.detail: hand the data over instead (a prop, a frame field); a text called detail goes into TEXT_RECEIVERS / TEXT_READS of tests/helpers/detail-ledger.js');
  assert.ok(owners >= 2, 'the owners are found (engine.js and detail.js at least), or the patterns are wrong');
});

test('ledger of the readers: the engine is the only core file that knows the collector, and js/sim never imports ui or store', () => {
  const importers = jsFiles().filter(({ source }) => DETAIL_IMPORT.test(stripComments(source))).map(({ rel }) => rel);
  assert.deepEqual(importers, ['sim/engine.js']);
  for (const { rel, source } of jsFiles()) if (rel === 'sim/detail.js') assert.doesNotMatch(source, /from '\.\.\/(ui|store)\//, 'js/sim imports nothing from ui or store');
});

/** The chains of simulation internals detail.js reads, with what a live value must look like. `nonnull`: must be observed with a value (it is null most of the time). */
const T = {
  num: (v) => typeof v === 'number' && Number.isFinite(v), int: (v) => Number.isInteger(v), str: (v) => typeof v === 'string', bool: (v) => typeof v === 'boolean',
  arr: (v) => Array.isArray(v) || ArrayBuffer.isView(v), obj: (v) => v !== null && typeof v === 'object', fn: (v) => typeof v === 'function',
  strOrNull: (v) => v === null || typeof v === 'string', objOrNull: (v) => v === null || (typeof v === 'object'),
};
const LEDGER = {
  // VehicleRT (js/sim/logistics/vehicles.js)
  'vr.id': [T.str], 'vr.state': [T.str], 'vr.stateSince': [T.num], 'vr.order': [T.objOrNull, 'nonnull'], 'vr.order.from': [T.str, 'nonnull'], 'vr.targetId': [T.strOrNull, 'nonnull'], 'vr.spot': [T.int],
  'vr.route': [T.objOrNull, 'nonnull'], 'vr.dock': [T.objOrNull, 'nonnull'], 'vr.depot': [T.objOrNull, 'nonnull'], 'vr.depot.id': [T.str, 'nonnull'], 'vr.leaveStation': [T.strOrNull, 'nonnull'],
  'vr.battery': [T.num], 'vr.trips': [T.int], 'vr.loadedDistance': [T.num], 'vr.emptyDistance': [T.num], 'vr.parkDistance': [T.num], 'vr.tv': [T.obj], 'vr.tv.driving': [T.bool], 'vr.tv.teleports': [T.int],
  // the traffic vehicle (js/sim/traffic/vehicle.js) and the traffic system
  'tv.waiting': [T.bool], 'tv.driving': [T.bool], 'tv.teleports': [T.int], 'tv.node': [T.int], 'tv.edge': [T.int], 'tv.s': [T.num], 'traffic.waitNodeOf': [T.fn],
  // the route of a leg (js/sim/graph.js route objects)
  'route.nodes': [T.arr, 'nonnull'], 'route.edges': [T.arr, 'nonnull'],
  // StationRT (js/sim/logistics/stations.js)
  'st.id': [T.str], 'st.type': [T.str], 'st.arrivals': [T.int], 'st.produced': [T.int], 'st.consumed': [T.int], 'st.fill': [T.num], 'st.inCount': [T.int], 'st.outCount': [T.int], 'st.state': [T.str],
  'st.machines': [(v) => v === undefined || Array.isArray(v), 'nonnull'], 'st.inLinks': [T.arr], 'st.outLinks': [T.arr], 'mach.state': [T.str, 'nonnull'],
  'link.queue': [T.arr], 'link.perCycle': [T.num, 'nonnull'], 'link.claimed': [T.int, 'nonnull'], 'load.createdAt': [T.num, 'nonnull'], 'load.readyAt': [T.num, 'nonnull'], 'load.tk': [T.int, 'nonnull'],
  // orders (js/sim/logistics.js)
  'ord.flowId': [T.str, 'nonnull'], 'ord.from': [T.str, 'nonnull'], 'ord.to': [T.str, 'nonnull'], 'ord.qty': [T.num, 'nonnull'],
  // events: payloads of loadCompleted, orderPickedUp, orderDelivered, truckReady, truckDeparted
  'ev.leadTime': [T.num, 'nonnull'], 'ev.station': [T.obj, 'nonnull'], 'ev.station.id': [T.str, 'nonnull'], 'ev.stationId': [T.str, 'nonnull'], 'ev.order': [T.obj, 'nonnull'], 'ev.order.from': [T.str, 'nonnull'],
  'ev.order.loads': [T.arr, 'nonnull'], 'ev.vehicle': [T.obj, 'nonnull'], 'ev.waitForPickup': [T.num, 'nonnull'], 'ev.truck.id': [T.num, 'nonnull'], 'ev.t': [T.num, 'nonnull'],
  // the logistics layer, the graph and the simulation
  'lg.vehicles': [T.arr], 'lg.stations': [T.arr], 'lg.flows': [T.arr], 'this.lg.docks': [T.obj], 'this.graph.cols': [T.int], 'this.graph.nodeCount': [T.int], 'this.graph.edges': [T.arr], 'this.graph.stationsAt': [(v) => v instanceof Map],
  'this.sim.time': [T.num], 'this.sim.settings': [T.obj], 'sim.graph': [T.obj], 'sim.logistics': [T.obj], 'sim.traffic': [T.obj], 'sim.time': [T.num], 'sim.on': [T.fn],
};
const CHAIN_TAIL = /\.(?:length|indexOf|get|map)$/;

test('ledger of the simulation internals the collector reads: detail.js reads exactly the chains in LEDGER (a new read must be listed, a dropped one removed)', () => {
  const code = stripComments(readFileSync(path.join(JS_ROOT, 'sim', 'detail.js'), 'utf8'));
  const seen = new Set();
  for (const m of code.matchAll(/(?<![\w.])(vr|tv|st|link|load|mach|ord|route|ev|lg|traffic)((?:\.[A-Za-z_]\w*)+)/g)) seen.add(m[0].replace(CHAIN_TAIL, '').replace(CHAIN_TAIL, ''));
  for (const m of code.matchAll(/\bthis\.(lg|graph|sim|traffic)((?:\.[A-Za-z_]\w*)+)/g)) seen.add(`this.${m[1]}${m[2]}`.replace(CHAIN_TAIL, '').replace(CHAIN_TAIL, ''));
  for (const m of code.matchAll(/(?<![\w.])sim\.([A-Za-z_]\w*)/g)) seen.add(`sim.${m[1]}`);
  // reads that are not simulation internals: the collector's own members and the query results
  for (const own of ['sim.detail', 'sim.detailError', 'sim.kpis', 'sim.vehicles', 'sim.stations']) seen.delete(own);
  const listed = new Set(Object.keys(LEDGER));
  const unlisted = [...seen].filter((c) => !listed.has(c)).sort();
  const unread = [...listed].filter((c) => !seen.has(c)).sort();
  assert.deepEqual(unlisted, [], 'detail.js reads simulation internals that the ledger does not list: add them to LEDGER with a probe');
  assert.deepEqual(unread, [], 'LEDGER lists internals that detail.js no longer reads: remove them');
});

test('ledger of the simulation internals: every chain exists on a live plant with the type the collector assumes (Two lines for vehicles, machines and links; Warehouse first day for trucks)', () => {
  const observed = new Map(); // chain -> { ok, bad: [], nonnull }
  const note = (chain, value) => {
    const [check] = LEDGER[chain];
    const o = observed.get(chain) || { bad: [], nonnull: false };
    if (!check(value)) o.bad.push(String(typeof value === 'object' ? JSON.stringify(Object.keys(value ?? {})) : value));
    if (value !== null && value !== undefined) o.nonnull = true;
    observed.set(chain, o);
  };
  const walkPlant = (id, seconds, captureTrucks) => {
    const layout = EXAMPLES.find((e) => e.id === id).build();
    layout.settings.warmup = 0;
    const sim = new Simulation(layout, { seed: 1 });
    const lg = sim.logistics;
    const onPayload = (ev) => {
      if (ev.leadTime !== undefined) { note('ev.leadTime', ev.leadTime); note('ev.station', ev.station); note('ev.station.id', ev.station.id); note('ev.stationId', ev.stationId); }
      if (ev.truck !== undefined) { note('ev.truck.id', ev.truck.id); note('ev.t', ev.t); if (ev.stationId !== undefined) note('ev.stationId', ev.stationId); }
      if (ev.order !== undefined) {
        note('ev.order', ev.order); note('ev.order.from', ev.order.from); note('ev.order.loads', ev.order.loads);
        if (ev.vehicle !== undefined) note('ev.vehicle', ev.vehicle);
        if (ev.waitForPickup !== undefined) note('ev.waitForPickup', ev.waitForPickup);
        for (const l of ev.order.loads) { note('load.createdAt', l.createdAt); note('load.readyAt', l.readyAt); note('load.tk', l.tk); }
      }
    };
    for (const name of ['loadCompleted', 'orderPickedUp', 'orderDelivered', ...(captureTrucks ? ['truckReady', 'truckDeparted'] : [])]) sim.on(name, onPayload);
    note('sim.graph', sim.graph); note('sim.logistics', sim.logistics); note('sim.traffic', sim.traffic); note('sim.on', sim.on);
    note('this.graph.cols', sim.graph.cols); note('this.graph.nodeCount', sim.graph.nodeCount); note('this.graph.edges', sim.graph.edges); note('this.graph.stationsAt', sim.graph.stationsAt); note('this.lg.docks', lg.docks); assert.equal(typeof lg.docks.waitsForDock, 'function', 'DockBook.waitsForDock (a pure read the collector calls for every held-up vehicle)');
    note('traffic.waitNodeOf', sim.traffic.waitNodeOf);
    for (const key of ['demandFactor', 'speedFactor', 'processFactor']) assert.equal(typeof sim.settings[key], 'number', `settings.${key}`);
    for (const key of ['dispatch', 'routing']) assert.equal(typeof sim.settings[key], 'string', `settings.${key}`);
    for (let t = 0; t < seconds; t += 5) {
      sim.advance(5);
      note('sim.time', sim.time); note('this.sim.time', sim.time); note('this.sim.settings', sim.settings);
      note('lg.vehicles', lg.vehicles); note('lg.stations', lg.stations); note('lg.flows', lg.flows);
      for (const vr of lg.vehicles) {
        for (const key of ['id', 'state', 'stateSince', 'order', 'targetId', 'spot', 'route', 'dock', 'depot', 'leaveStation', 'battery', 'trips', 'loadedDistance', 'emptyDistance', 'parkDistance', 'tv']) note(`vr.${key}`, vr[key]);
        if (vr.order) { note('ord.flowId', vr.order.flowId); note('ord.from', vr.order.from); note('ord.to', vr.order.to); note('ord.qty', vr.order.qty); note('vr.order.from', vr.order.from); }
        if (vr.depot) note('vr.depot.id', vr.depot.id);
        const tv = vr.tv;
        for (const key of ['waiting', 'driving', 'teleports', 'node', 'edge', 's']) note(`tv.${key}`, tv[key]);
        note('vr.tv.driving', tv.driving); note('vr.tv.teleports', tv.teleports);
        if (vr.route) { note('route.nodes', vr.route.nodes); note('route.edges', vr.route.edges); }
      }
      for (const st of lg.stations) {
        for (const key of ['id', 'type', 'arrivals', 'produced', 'consumed', 'fill', 'inCount', 'outCount', 'state', 'inLinks', 'outLinks']) note(`st.${key}`, st[key]);
        note('st.machines', st.machines);
        for (const m of st.machines || []) note('mach.state', m.state);
        for (const link of st.inLinks) { note('link.queue', link.queue); note('link.perCycle', link.perCycle); }
        for (const link of st.outLinks) { note('link.queue', link.queue); note('link.claimed', link.claimed); for (const l of link.queue) { note('load.createdAt', l.createdAt); note('load.readyAt', l.readyAt); } }
      }
    }
  };
  walkPlant('two-lines', 2400, false);
  walkPlant('warehouse-first-day', 5400, true);
  const problems = [];
  for (const [chain, [, required]] of Object.entries(LEDGER)) {
    const o = observed.get(chain);
    if (!o) { problems.push(`${chain}: never observed`); continue; }
    if (o.bad.length) problems.push(`${chain}: unexpected value(s) ${[...new Set(o.bad)].slice(0, 3).join(' | ')}`);
    if (required === 'nonnull' && !o.nonnull) problems.push(`${chain}: observed only as null/undefined, so its type was not checked`);
  }
  assert.deepEqual(problems, []);
});

test('ledger of the vehicle states: the collector puts every state of the engine into the time slot Stats gives it, and knows exactly the driving states', async () => {
  const { VEHICLE_STATES, DRIVING_STATES } = await import('../js/sim/logistics/common.js');
  const { BASE_SLOT, DRIVING_STATE, SLOT_KEYS } = await import('../js/sim/detail.js');
  const table = stripComments(readFileSync(path.join(JS_ROOT, 'sim', 'stats.js'), 'utf8')).match(/const STATE_SLOT = [\s\S]*?\}\);/);
  assert.ok(table, 'stats.js still has its STATE_SLOT table (or this ledger must follow it)');
  const stats = Object.fromEntries([...table[0].matchAll(/(\w+):\s*([A-Z]+)/g)].map((m) => [m[1], m[2].toLowerCase()]));
  assert.deepEqual(Object.keys(BASE_SLOT).sort(), [...VEHICLE_STATES].sort(), 'a state added to (or removed from) VEHICLE_STATES must get a slot in detail.js, or its seconds would be filed as idle');
  assert.deepEqual(Object.keys(DRIVING_STATE).sort(), [...DRIVING_STATES].sort());
  for (const state of VEHICLE_STATES) assert.equal(SLOT_KEYS[BASE_SLOT[state]], stats[state], `${state}: detail.js files it as ${SLOT_KEYS[BASE_SLOT[state]]}, Stats as ${stats[state]}`);
});

test('the collector reads the five runtime settings by name (the what-if check): they exist on a live simulation', () => {
  const sim = new Simulation(starter(), { seed: 1 });
  const det = sim.enableDetail();
  assert.deepEqual(Object.keys(det.rt), ['demandFactor', 'speedFactor', 'processFactor', 'dispatch', 'routing']);
  for (const [key, value] of Object.entries(det.rt)) assert.equal(value, sim.settings[key], key);
});

test('insights.js exports the one source of "more vehicles do not help": fleetWaitShare and congested agree with the fleet-saturated suggestion', async () => {
  const { fleetWaitShare, congested, TRAFFIC_WAIT_SHARE, generateInsights } = await import('../js/sim/insights.js');
  assert.equal(typeof fleetWaitShare, 'function'); assert.equal(typeof congested, 'function');
  assert.equal(fleetWaitShare({ shares: { driving: 0.5, waiting: 0.1 } }), 0.1 / 0.6);
  assert.equal(fleetWaitShare({ shares: { driving: 0, waiting: 0 } }), 0);
  assert.equal(fleetWaitShare({}), 0);
  const calm = { traffic: { waitShare: 0.01 } };
  assert.equal(congested(calm, { shares: { driving: 0.5, waiting: 0.01 } }), false);
  assert.equal(congested(calm, { shares: { driving: 0.5, waiting: 0.5 * TRAFFIC_WAIT_SHARE / (1 - TRAFFIC_WAIT_SHARE) } }), true, 'the fleet\'s own waiting is enough at exactly the threshold');
  assert.equal(congested({ traffic: { waitShare: TRAFFIC_WAIT_SHARE } }, { shares: { driving: 1, waiting: 0 } }), true, 'so is the plant\'s');
  // parity with the insight on a real report (Warehouse first day: the forklifts are saturated), and with the two congested variants of it
  const layout = EXAMPLES.find((e) => e.id === 'warehouse-first-day').build();
  layout.settings.warmup = 600;
  const sim = new Simulation(layout, { seed: 1 });
  sim.advance(3 * 3600);
  const base = JSON.parse(JSON.stringify(sim.kpis()));
  const variants = {
    'calm': (r) => r,
    'the fleet waits in traffic': (r) => { for (const f of Object.values(r.fleets)) { f.shares.waiting = 0.2; f.shares.driving = 0.3; } return r; },
    'the plant waits in traffic': (r) => { r.traffic.waitShare = 0.2; return r; },
  };
  let compared = 0; let congestedCount = 0;
  for (const [name, change] of Object.entries(variants)) {
    const report = change(JSON.parse(JSON.stringify(base)));
    const insights = generateInsights(report, sim.layout);
    for (const [fid, f] of Object.entries(report.fleets)) {
      const saturated = insights.find((i) => i.id.startsWith('fleet-saturated') && i.refs?.fleetIds?.includes(fid));
      if (!saturated) continue;
      compared++;
      const isCongested = congested({ traffic: report.traffic }, { id: fid, ...f });
      if (isCongested) congestedCount++;
      assert.equal(/relieve the congestion/i.test(saturated.suggestion || ''), isCongested, `${name}, fleet ${fid}: congested() = ${isCongested}, suggestion "${saturated.suggestion}"`);
    }
  }
  assert.ok(compared >= 3, `${compared} comparisons`);
  assert.ok(congestedCount >= 1 && congestedCount < compared, 'both outcomes were compared');
});
