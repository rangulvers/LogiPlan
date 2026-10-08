// Test helper for the integrated simulation (js/sim/engine.js): invariants that must hold after EVERY tick of a Simulation,
// a seeded generator of random plants and small ASCII plants for the engine, experiment and integration tests.
//
//   const sim = new Simulation(layout);
//   const checker = createSimChecker(sim);
//   for (let i = 0; i < 18000; i++) { sim.step(); checker.check(); }       // throws an Error naming the first violation
//   checker.checkReport();                                                  // KPI report sanity (every ~60 s is plenty)
//
// What check() asserts (on top of the traffic and logistics checkers, which it runs unless switched off):
//   Time          sim.time grows by exactly one dt per tick.
//   Vehicles      every pose (x, y, heading and the previous pose used for render interpolation) is finite; `visible`
//                 mirrors tv.onRoad; footprints never overlap, lanes/locks/headways are consistent (traffic-invariants.js).
//   Loads         created = live + completed + consumed, nothing exists twice, queues respect their capacities, claims and
//                 inbound reservations match the active orders, depots are not over-booked (logistics-invariants.js).
//   Event ledger  the events seen through sim.on('*') agree with the counters of the logistics layer.
//   Deadlocks     sim.deadlocks stays within its cap and holds well-formed entries.
// checkReport() asserts: no NaN / Infinity anywhere in the KPI report, every state share of a fleet sums to 1, workstation
// time shares sum to 1 (once the window has any length), fractions lie in 0..1, lead-time percentiles are ordered, the window length matches the clock.
//
// exampleLayout / variantOf / measureRuns / pairedDiffs support what-if experiments on the example plants (a fresh copy of an example
// edited through the model API, simulated with consecutive seeds, compared seed by seed).
//
// randomPlant(seed) builds a complete, valid plant through the layout.js mutators: a loop with cross streets and spurs (partly
// one-way), stations placed next to the roads, flows between them, one to three fleets (some with batteries and breakdowns),
// randomly chosen dispatch / routing / handedness / dt. Some plants are awkward by chance (stations no vehicle can reach, flows
// that cannot be driven because of one-way parts, up to 15 vehicles on a few roads), the way a planner's first drafts are.
// lineLayout(opts) is a small straight production line (source, workstation, sink) for tests that need known numbers.

import assert from 'node:assert/strict';
import { createRng } from '../../js/util/rng.js';
import { lPath } from '../../js/util/grid.js';
import {
  addFleet, addFlow, addObstacle, addStation, checkInvariants as checkLayout, createLayout, paintRoadPath, updateSettings,
} from '../../js/model/layout.js';
import { EXAMPLES } from '../../js/model/examples.js';
import { DEADLOCK_HISTORY } from '../../js/sim/engine.js';
import { runReplications } from '../../js/sim/experiments.js';
import { createInvariantChecker } from './traffic-invariants.js';
import { checkInvariants as logisticsViolations } from './logistics-invariants.js';
import { layoutFromAscii } from './ascii.js';

const TOL = 1e-6;

function fail(sim, message) {
  throw new Error(`simulation invariant violated at t=${sim.time.toFixed(2)}: ${message}`);
}

/** Every number found anywhere inside `value` (objects, arrays, typed arrays), with its path. */
function* numbersIn(value, path = 'report') {
  if (typeof value === 'number') yield [path, value];
  else if (ArrayBuffer.isView(value)) for (let i = 0; i < value.length; i++) yield [`${path}[${i}]`, value[i]];
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i++) yield* numbersIn(value[i], `${path}[${i}]`);
  else if (value !== null && typeof value === 'object') for (const [k, v] of Object.entries(value)) yield* numbersIn(v, `${path}.${k}`);
}

/** Throws if a number anywhere in `value` is NaN or infinite. */
export function assertAllFinite(value, label = 'report') {
  for (const [path, x] of numbersIn(value, label)) assert.ok(Number.isFinite(x), `${path} is ${x}`);
}

/**
 * Checker for one Simulation. Call check() after every sim.step().
 * @param {object} sim
 * @param {{ traffic?: boolean, logistics?: boolean }} [opts] switch off the traffic / logistics checkers (default: both run)
 */
export function createSimChecker(sim, { traffic = true, logistics = true } = {}) {
  const trafficChecker = traffic ? createInvariantChecker(sim.traffic) : null;
  const ledger = { created: 0, completed: 0, delivered: 0 };
  sim.on('loadCreated', () => { ledger.created++; });
  sim.on('loadCompleted', () => { ledger.completed++; });
  sim.on('orderDelivered', () => { ledger.delivered++; });
  let last = sim.time;

  function checkTime() {
    if (Math.abs(sim.time - last - sim.dt) > TOL) fail(sim, `time moved from ${last} to ${sim.time}, expected a step of ${sim.dt}`);
    last = sim.time;
  }

  function checkVehicles() {
    for (const v of sim.vehicles) {
      for (const key of ['x', 'y', 'heading', 'prevX', 'prevY', 'prevHeading', 'battery']) {
        if (!Number.isFinite(v[key])) fail(sim, `${v.id}.${key} is ${v[key]}`);
      }
      if (v.visible !== v.tv.onRoad) fail(sim, `${v.id} visible=${v.visible} but onRoad=${v.tv.onRoad}`);
    }
  }

  function checkLedger() {
    const lg = sim.logistics;
    const created = lg.createdBySources + lg.createdByProcesses;
    if (ledger.created !== created) fail(sim, `${ledger.created} loadCreated events but ${created} loads created`);
    if (ledger.completed !== lg.completed) fail(sim, `${ledger.completed} loadCompleted events but ${lg.completed} loads completed`);
    if (ledger.delivered !== lg.ordersDelivered) fail(sim, `${ledger.delivered} orderDelivered events but ${lg.ordersDelivered} orders delivered`);
  }

  function checkDeadlocks() {
    if (sim.deadlocks.length > DEADLOCK_HISTORY) fail(sim, `${sim.deadlocks.length} deadlock reports kept`);
    for (const d of sim.deadlocks) {
      if (!Number.isFinite(d.t) || !Array.isArray(d.nodes) || !Array.isArray(d.vehicles) || typeof d.resolved !== 'boolean') fail(sim, `malformed deadlock report ${JSON.stringify(d)}`);
    }
  }

  return {
    ledger,
    check() {
      checkTime();
      checkVehicles();
      if (trafficChecker) trafficChecker.check();
      if (logistics) {
        const bad = logisticsViolations(sim.logistics);
        if (bad.length > 0) fail(sim, `logistics: ${bad.slice(0, 5).join('; ')}`);
      }
      checkLedger();
      checkDeadlocks();
    },
    /** KPI report sanity (see the header). */
    checkReport(report = sim.kpis()) {
      assertAllFinite(report);
      const w = report.window;
      if (Math.abs(w.start + w.duration - w.end) > 1e-6) fail(sim, 'window start + duration != end');
      if (w.end > sim.time + 1e-6) fail(sim, `window ends at ${w.end}, after the clock (${sim.time})`);
      for (const [id, f] of Object.entries(report.fleets)) {
        const sum = Object.values(f.shares).reduce((a, b) => a + b, 0);
        if (Math.abs(sum - 1) > TOL) fail(sim, `fleet ${id}: state shares sum to ${sum}`);
        for (const [k, v] of Object.entries(f.shares)) if (v < -TOL || v > 1 + TOL) fail(sim, `fleet ${id}: share ${k} = ${v}`);
        if (f.utilization < -TOL || f.utilization > 1 + TOL) fail(sim, `fleet ${id}: utilization ${f.utilization}`);
      }
      for (const [id, s] of Object.entries(report.stations)) {
        for (const k of ['utilization', 'starved', 'blocked', 'down', 'avgFill', 'maxFill']) {
          if (s[k] < -TOL || s[k] > 1 + TOL) fail(sim, `station ${id}: ${k} = ${s[k]}`);
        }
        if (s.type === 'process' && w.duration > 0 && Math.abs(s.utilization + s.starved + s.blocked + s.down - 1) > TOL) {
          fail(sim, `workstation ${id}: busy + starved + blocked + down = ${s.utilization + s.starved + s.blocked + s.down}`);
        }
      }
      const t = report.traffic;
      if (t.waitShare < -TOL || t.waitShare > 1 + TOL) fail(sim, `traffic wait share ${t.waitShare}`);
      const lead = report.leadTime;
      if (lead.count > 0) {
        const chain = [lead.min, lead.p50, lead.p90, lead.p95, lead.max];
        for (let i = 1; i < chain.length; i++) if (chain[i] < chain[i - 1] - TOL) fail(sim, `lead-time percentiles out of order: ${chain}`);
      }
      if (report.throughput.total < 0 || report.throughput.perHour < 0) fail(sim, 'negative throughput');
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Random plants
// ---------------------------------------------------------------------------------------------------------------

const arrivals = (mean, spread = 0.15) => ({ kind: 'normal', mean, spread });

/** Paint a polyline of corner points; legs that run into something are painted as far as possible. */
function paint(layout, points, oneWay = false) {
  const cells = points.slice(1).reduce((acc, p, i) => acc.concat(lPath(...points[i], ...p).slice(1)), [points[0]]);
  paintRoadPath(layout, cells, { oneWay });
}

/** Road cells of the layout as [cx, cy] pairs. */
const roadCells = (layout) => Object.keys(layout.roads).map((k) => k.split(',').map(Number));

/** Try to put a station of a type next to a random road cell; null if nothing fits. */
function placeNextToRoad(layout, rng, type, params) {
  const cells = roadCells(layout);
  for (let attempt = 0; attempt < 60 && cells.length > 0; attempt++) {
    const [cx, cy] = cells[rng.int(cells.length)];
    const w = 2 + rng.int(2);
    const h = 2 + rng.int(2);
    const side = rng.int(4);
    const x = side === 1 ? cx + 1 : side === 3 ? cx - w : cx - rng.int(w);
    const y = side === 2 ? cy + 1 : side === 0 ? cy - h : cy - rng.int(h);
    const station = addStation(layout, { type, x, y, w, h, params });
    if (station) return station;
  }
  return null;
}

function randomRoads(layout, rng) {
  const { cols, rows } = layout.grid;
  const x0 = 2 + rng.int(3);
  const y0 = 2 + rng.int(3);
  const x1 = cols - 3 - rng.int(3);
  const y1 = rows - 3 - rng.int(3);
  paint(layout, [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], rng.next() < 0.35);
  for (let k = rng.int(3); k > 0; k--) {
    const x = x0 + 3 + rng.int(x1 - x0 - 5);
    paint(layout, [[x, y0], [x, y1]], rng.next() < 0.3);
  }
  for (let k = rng.int(3); k > 0; k--) {
    const y = y0 + 3 + rng.int(y1 - y0 - 5);
    paint(layout, [[x0, y], [x1, y]], rng.next() < 0.3);
  }
  for (let k = rng.int(4); k > 0; k--) { // short spurs off the loop: dead ends
    const x = x0 + 2 + rng.int(x1 - x0 - 3);
    paint(layout, rng.next() < 0.5 ? [[x, y0], [x, y0 + 2 + rng.int(2)]] : [[x, y1], [x, y1 - 2 - rng.int(2)]]);
  }
}

/**
 * A complete random plant (valid by construction) for seed `seed`.
 * @param {number} seed
 * @returns {object} layout
 */
export function randomPlant(seed) {
  const rng = createRng(seed * 7919 + 13);
  const layout = createLayout({ name: `Random plant ${seed}`, cols: 26 + rng.int(12), rows: 18 + rng.int(8), cellSize: rng.pick([1.5, 2, 2, 3]) });
  updateSettings(layout, {
    seed: 1 + rng.int(100000),
    dt: rng.pick([0.1, 0.1, 0.2, 0.25]),
    warmup: rng.pick([0, 120, 300]),
    dispatch: rng.pick(['nearest', 'oldest', 'balanced']),
    routing: rng.pick(['shortest', 'shortest', 'congestion']),
    handedness: rng.pick(['right', 'left']),
    deadlock: rng.next() < 0.85 ? 'resolve' : 'ignore',
    demandFactor: rng.pick([1, 1, 1.5, 2]),
  });
  randomRoads(layout, rng);
  const place = (count, type, params) => Array.from({ length: count }, () => placeNextToRoad(layout, rng, type, params())).filter(Boolean);
  const storages = place(rng.int(2), 'storage', () => ({ capacity: 4 + rng.int(30), dwell: rng.pick([0, 0, 30]) }));
  const sources = place(1 + rng.int(2), 'source', () => ({ interArrival: arrivals(40 + rng.int(160)), batch: 1 + rng.int(3), outCap: 2 + rng.int(8) }));
  const processes = place(1 + rng.int(3), 'process', () => ({
    cycle: arrivals(30 + rng.int(120), 0.1), machines: 1 + rng.int(2), inCap: 2 + rng.int(6), outCap: 2 + rng.int(6),
    mtbf: rng.next() < 0.2 ? 1800 : 0, mttr: rng.next() < 0.2 ? 200 : 0,
  }));
  const sink = placeNextToRoad(layout, rng, 'sink');
  const depot = rng.next() < 0.7 ? placeNextToRoad(layout, rng, 'depot', { slots: 2 + rng.int(6), chargers: rng.int(3) }) : null;
  if (rng.next() < 0.5) addObstacle(layout, { x: 1 + rng.int(layout.grid.cols - 3), y: 1 + rng.int(layout.grid.rows - 3), w: 1 + rng.int(2), h: 1, kind: 'wall' });

  const fleets = Array.from({ length: 1 + rng.int(3) }, () => addFleet(layout, rng.pick(['agv', 'forklift', 'tugger', 'custom']), {
    count: 1 + rng.int(5), capacity: 1 + rng.int(3), home: depot && rng.next() < 0.8 ? depot.id : null, idle: rng.pick(['park', 'stay']),
    length: rng.pick([0.8, 1.2, 1.2, 1.5]),
    mtbf: rng.next() < 0.15 ? 900 : 0, mttr: rng.next() < 0.15 ? 90 : 0,
    battery: rng.next() < 0.3 ? { enabled: true, runtimeMin: 20 + rng.int(60), chargeTimeMin: 10 + rng.int(20), lowPct: 30, resumePct: 80 } : {},
  }));
  const link = (from, to) => {
    if (from && to) {
      addFlow(layout, from.id, to.id, {
        weight: 1 + rng.int(3), perCycle: 1 + rng.int(2), batchMin: 1 + rng.int(2), maxWait: rng.pick([0, 60]), priority: 1 + rng.int(3),
        fleetId: rng.next() < 0.25 ? fleets[rng.int(fleets.length)].id : null,
      });
    }
  };
  const first = storages[0] || processes[0] || sink;
  for (const s of sources) link(s, first);
  if (storages[0] && processes[0]) link(storages[0], processes[0]);
  for (let i = 0; i + 1 < processes.length; i++) link(processes[i], processes[i + 1]);
  link(processes[processes.length - 1] || storages[0], sink);
  if (processes.length > 1 && sources.length > 0 && rng.next() < 0.5) link(sources[0], processes[processes.length - 1]);
  assert.deepEqual(checkLayout(layout), [], `generator produced an invalid layout for seed ${seed}`);
  return layout;
}

// ---------------------------------------------------------------------------------------------------------------
// Small ASCII plants
// ---------------------------------------------------------------------------------------------------------------

/**
 * A straight production line: source A, process B, sink C along a two-way road of `length` cells, with `vehicles` AGVs.
 * Transport-limited when the source is fast and the road long.
 * @param {{ vehicles?: number, gap?: number, arrival?: number, cycle?: number, settings?: object, fleet?: object, source?: object, process?: object }} [opts]
 */
export function lineLayout({ vehicles = 1, gap = 12, arrival = 30, cycle = 20, settings = {}, fleet = {}, source = {}, process = {} } = {}) {
  const road = '+'.repeat(2 * gap + 8);
  const top = `AAA${'.'.repeat(gap - 1)}BBB${'.'.repeat(gap - 1)}CCC`.padEnd(road.length, '.');
  return layoutFromAscii([top, road], {
    settings: { warmup: 0, ...settings },
    stations: {
      A: { type: 'source', params: { interArrival: { kind: 'const', mean: arrival, spread: 0 }, batch: 1, outCap: 50, ...source } },
      B: { type: 'process', params: { cycle: { kind: 'const', mean: cycle, spread: 0 }, inCap: 8, outCap: 8, ...process } },
      C: 'sink',
    },
    flows: [['A', 'B'], ['B', 'C']],
    fleets: [{ count: vehicles, ...fleet }],
  });
}

// ---------------------------------------------------------------------------------------------------------------
// What-if experiments on the examples
// ---------------------------------------------------------------------------------------------------------------

/** A fresh copy of an example plant. */
export const exampleLayout = (id) => EXAMPLES.find((e) => e.id === id).build();

/** A fresh copy of an example with `edit(layout)` applied (through the model API); the result must still be a valid layout. */
export function variantOf(id, edit) {
  const layout = exampleLayout(id);
  edit(layout);
  assert.deepEqual(checkLayout(layout), [], `${id} variant is a valid layout`);
  return layout;
}

/**
 * KPI reports of `replications` runs of a layout, simulated for `hours` with the seeds seed0, seed0 + 1, ...
 * Variants measured with the same seeds can be compared run by run (pairedDiffs), which cancels most of the random noise.
 */
export async function measureRuns(layout, { replications = 3, seed0 = 1, hours = 2 } = {}) {
  const { runs } = await runReplications(layout, { replications, seed0, duration: hours * 3600 });
  return runs;
}

/** Per-seed differences other - base of a metric `fn(report)`. */
export const pairedDiffs = (base, other, fn) => other.map((report, i) => fn(report) - fn(base[i]));
