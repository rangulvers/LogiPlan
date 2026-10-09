// Test helper for trucks and dock doors (docs/WAREHOUSE-DESIGN.md 6.3, milestone M1), used by tests/sim.trucks*.test.js.
//
//   microPlant(opts)              a tiny plant from an ASCII picture - Goods in A, optional Storage S, Goods out C on one road - on which the stub
//                                 traffic gives exactly computable times; returns a normalized layout
//   fuzzPlant(seed, opts)         a random small plant full of truck settings (doors 1..32, check-in 0, staging 0, no-shows, jitter, 500-row
//                                 timetables, trucks that never fill ...), reproducible per seed, normalized (so a timetable has its clock).
//                                 Two styles: 'busy' (a Manhattan grid of three roads, stations on both sides, workstations, storages, a depot,
//                                 forklifts: trucks and vehicles meet all the time) and 'hostile' (hostilePlant of logistics-review-gen.js: random
//                                 roads, one-way lines, hostile fleets and flows, with trucks added)
//   attachStats(world)            give a createWorld world a live Stats (the way the engine wires it), so that world.stats.report() has report.ops
//   runTrucks(world, seconds, opts)   step with ALL invariants (conservation + 6.3.5) asserted every tick, optionally with runtime what-if changes
//   truckDigest(events, opts)     a comparable text of the truck events (names, nominal times, ids, doors) of an event log
//
// The generators draw only from a seeded stream (createRng), never Math.random.

import { createRng } from '../../js/util/rng.js';
import { cellKey } from '../../js/util/grid.js';
import { defaultFleet, defaultFlow, defaultStation, dist, emptyLayout } from '../../js/model/defaults.js';
import { normalizeLayout } from '../../js/model/layout.js';
import { Stats } from '../../js/sim/stats.js';
import { layoutFromAscii } from './ascii.js';
import { assertInvariants } from './logistics-invariants.js';
import { hostilePlant, linkAllNeighbours } from './logistics-review-gen.js';

const pickOf = (rng, list) => list[rng.int(list.length)];
const KINDS = ['const', 'normal', 'uniform', 'exp'];

// ---- the micro plant ---------------------------------------------------------------------------------------------------------

/**
 * A micro plant: `AAA..SSS..CCC` over a two-way road. A is a Goods in (source), S a Storage, C a Goods out (sink); the stations you do not ask for
 * are left out of the picture. Flows: A -> S -> C with a storage, A -> C without one.
 * @param {{ inbound?: object, outbound?: object, storage?: boolean|object, goodsIn?: boolean, flows?: Array, fleet?: object|null, fleets?: object[], settings?: object, aParams?: object, cParams?: object }} [o]
 *   `inbound` / `outbound`: the `ops.trucks` patch of A / C (omitted: no trucks); `goodsIn: false` leaves A out (`SSS..CCC`: a Storage and a Goods out, whose supply is
 *   then exactly what a test puts into the storage); `fleet`: fields of the forklift fleet (count, loadTime ...), or null for none
 * @returns {object} a normalized layout
 */
export function microPlant({ inbound, outbound, storage = false, goodsIn = true, flows, fleet = {}, fleets, settings = {}, aParams = {}, cParams = {} } = {}) {
  const hasStorage = Boolean(storage);
  const picture = !goodsIn ? 'SSS..CCC' : hasStorage ? 'AAA..SSS..CCC' : 'AAA.....CCC';
  const stations = {
    C: { type: 'sink', params: cParams, ...(outbound ? { ops: { trucks: outbound } } : {}) },
  };
  if (goodsIn) stations.A = { type: 'source', params: aParams, ...(inbound ? { ops: { trucks: inbound } } : {}) };
  if (hasStorage) stations.S = { type: 'storage', params: { capacity: 1000, dwell: 0, ...(typeof storage === 'object' ? storage : {}) } };
  const defaultFlows = !goodsIn ? [['S', 'C']] : hasStorage ? [['A', 'S'], ['S', 'C']] : [['A', 'C']];
  const layout = layoutFromAscii([picture, '+'.repeat(picture.length)], {
    stations, flows: flows || defaultFlows, settings,
    fleets: fleets || (fleet === null ? [] : [{ preset: 'forklift', count: 2, loadTime: 5, unloadTime: 5, idle: 'stay', ...fleet }]),
  });
  return normalizeLayout(layout);
}

// ---- random plants -----------------------------------------------------------------------------------------------------------

/**
 * A random `ops.trucks` block (raw: the sanitizer clamps it). `window` = [first, last] seconds of the day in which timetable rows fall;
 * `hostile` draws from the extremes of every range, otherwise from values a planner would type.
 */
function randomTrucks(rng, window, role, hostile) {
  const mode = rng.next() < 0.35 ? 'schedule' : 'rate';
  const trucks = {
    doors: hostile ? pickOf(rng, [1, 1, 2, 3, 6, 32]) : 1 + rng.int(4),
    checkIn: pickOf(rng, hostile ? [0, 5, 60, 300] : [0, 20, 120, 300]),
    checkOut: pickOf(rng, hostile ? [0, 5, 60, 300] : [0, 20, 120, 300]),
    mode,
    interArrival: dist(pickOf(rng, KINDS), pickOf(rng, hostile ? [60, 75, 150, 400, 1e6] : [60, 90, 180, 400]), rng.next() * (hostile ? 1 : 0.5)),
    pallets: dist(pickOf(rng, KINDS), pickOf(rng, hostile ? [1, 2, 6, 24, 200] : [2, 5, 8, 14]), rng.next() * (hostile ? 1 : 0.6)),
    jitter: pickOf(rng, hostile ? [0, 0, 30, 600, 7200] : [0, 0, 60, 240]),
    noShow: pickOf(rng, hostile ? [0, 0, 0.2, 0.5] : [0, 0, 0.1]),
    maxDwell: role === 'out' ? pickOf(rng, hostile ? [0, 20, 120, 3600] : [0, 300, 900, 3600]) : 3600,
    staging: role === 'out' ? pickOf(rng, hostile ? [0, 0, 1, 4, 50] : [0, 2, 4, 6]) : 4,
  };
  if (mode === 'schedule') {
    const rows = pickOf(rng, hostile ? [0, 1, 5, 30, 500] : [2, 5, 12, 30]);
    trucks.schedule = Array.from({ length: rows }, () => ({
      at: Math.floor(window[0] + rng.next() * (window[1] - window[0])) % 86400,
      pallets: rng.next() < 0.3 ? null : 1 + rng.int(hostile && rng.next() < 0.1 ? 200 : 30),
    }));
  }
  return trucks;
}

/** The 'busy' base: a Manhattan grid (three rows of road, three columns), stations on both sides of the rows, a depot, one or two fleets. */
function busyBase(rng, seed) {
  const cols = 40;
  const rows = 22;
  const layout = emptyLayout({ grid: { cols, rows, cellSize: 2 }, settings: { seed, warmup: 0 } });
  const hRows = [3, 9, 15];
  for (const y of hRows) for (let x = 1; x < cols - 1; x++) layout.roads[cellKey(x, y)] = { out: 0 };
  for (const x of [1, 19, cols - 2]) for (let y = 3; y <= 15; y++) layout.roads[cellKey(x, y)] = { out: 0 };
  linkAllNeighbours(layout);
  const slots = [];
  for (const y of hRows) for (let x = 3; x + 4 < cols - 1; x += 6) {
    if ([1, 19, cols - 2].some((c) => c >= x - 1 && c <= x + 4)) continue;
    slots.push({ x, y: y + 1 }, { x, y: y - 2 });
  }
  const take = () => (slots.length > 0 ? slots.splice(rng.int(slots.length), 1)[0] : null);
  const kinds = ['source', 'sink'];
  for (let i = 0; i < 1 + rng.int(3); i++) kinds.push(pickOf(rng, ['source', 'sink', 'process', 'storage', 'storage', 'process']));
  const made = [];
  kinds.forEach((type, i) => {
    const slot = take();
    if (!slot) return;
    const params = {};
    if (type === 'source') Object.assign(params, { interArrival: dist('exp', pickOf(rng, [20, 60, 300])), batch: 1 + rng.int(3), outCap: pickOf(rng, [0, 3, 6, 12]), startDelay: pickOf(rng, [0, 0, 30]) });
    if (type === 'process') Object.assign(params, { cycle: dist('uniform', pickOf(rng, [5, 30, 90]), 0.3), machines: 1 + rng.int(2), inCap: 4, outCap: 4 });
    if (type === 'storage') Object.assign(params, { capacity: pickOf(rng, [4, 20, 200]), dwell: pickOf(rng, [0, 0, 30]) });
    const st = defaultStation(type, { id: 's' + (i + 1), name: type + (i + 1), x: slot.x, y: slot.y, w: 4, h: 2, params });
    layout.stations.push(st);
    made.push(st);
  });
  const depotSlot = take();
  const depot = depotSlot ? defaultStation('depot', { id: 'd1', name: 'Park', x: depotSlot.x, y: depotSlot.y, w: 4, h: 2, params: { slots: 8, chargers: 0 } }) : null;
  if (depot) layout.stations.push(depot);
  const from = made.filter((s) => s.type !== 'sink');
  const to = made.filter((s) => s.type !== 'source');
  const seen = new Set();
  const want = 2 + rng.int(6);
  for (let tries = 0; tries < 80 && layout.flows.length < want; tries++) {
    const a = pickOf(rng, from);
    const b = pickOf(rng, to);
    if (a === b || seen.has(a.id + '>' + b.id)) continue;
    seen.add(a.id + '>' + b.id);
    layout.flows.push(defaultFlow({ id: 'f' + (layout.flows.length + 1), from: a.id, to: b.id, weight: 1 + rng.int(3), priority: 1 + rng.int(3), batchMin: pickOf(rng, [1, 1, 1, 3]), batchMax: pickOf(rng, [0, 0, 2]) }));
  }
  for (let f = 0; f < 1 + rng.int(2); f++) {
    layout.fleets.push(defaultFleet(pickOf(rng, ['forklift', 'agv', 'tugger']), {
      id: 'v' + (f + 1), count: pickOf(rng, [1, 2, 3, 5]), capacity: pickOf(rng, [1, 1, 2, 4]), loadTime: pickOf(rng, [0, 4, 12]), unloadTime: pickOf(rng, [0, 4, 12]),
      idle: pickOf(rng, ['park', 'stay']), home: depot ? depot.id : null,
    }));
  }
  return layout;
}

/**
 * A random plant with trucks on most of its Goods in and Goods out: the base (see the header) gets `ops.trucks` on each source and sink with
 * probability 0.85 (the first of each kind always, in the busy style), and every truck station gets at least one flow. Normalized.
 * @param {number} seed
 * @param {{ style?: 'busy'|'hostile', horizon?: number }} [opts] `style` default: busy for an even seed, hostile for an odd one; `horizon`: simulated
 *   seconds the timetable rows are spread over (default 1500)
 */
export function fuzzPlant(seed, { style = seed % 2 === 0 ? 'busy' : 'hostile', horizon = 1500 } = {}) {
  const rng = createRng(seed * 7919 + 13);
  const hostile = style === 'hostile';
  const layout = hostile ? hostilePlant(seed) : busyBase(rng, seed);
  const startTod = pickOf(rng, [0, 21600, 86400 - 400, 86400 - 1200]);
  const window = [startTod, startTod + horizon];
  const sources = layout.stations.filter((s) => s.type === 'source');
  const sinks = layout.stations.filter((s) => s.type === 'sink');
  let timetable = false;
  for (const st of [...sources, ...sinks]) {
    const first = !hostile && (st === sources[0] || st === sinks[0]);
    if (first || rng.next() < 0.85) {
      st.ops = { trucks: randomTrucks(rng, window, st.type === 'sink' ? 'out' : 'in', hostile || rng.next() < 0.3) };
      if (st.ops.trucks.mode === 'schedule') timetable = true;
    }
  }
  // a plant with a timetable has a clock (the sanitizer would create one that starts at 00:00); the rows were drawn around `startTod`
  if (timetable || rng.next() < 0.5) layout.calendar = { startTod, startDay: rng.int(7) };
  const real = layout.stations.filter((s) => s.type !== 'depot');
  const have = (from, to) => layout.flows.some((f) => f.from === from && f.to === to);
  for (const st of [...sources, ...sinks]) {
    if (!st.ops) continue;
    const touches = layout.flows.some((f) => (st.type === 'source' ? f.from === st.id : f.to === st.id));
    if (touches) continue;
    const others = real.filter((o) => o !== st && (st.type === 'source' ? ['process', 'storage', 'sink'] : ['source', 'process', 'storage']).includes(o.type));
    for (const other of others) {
      const [from, to] = st.type === 'source' ? [st.id, other.id] : [other.id, st.id];
      if (have(from, to)) continue;
      layout.flows.push(defaultFlow({ id: 'f' + (layout.flows.length + 1), from, to }));
      break;
    }
  }
  layout.settings.demandFactor = pickOf(rng, [1, 1, 0.5, 3, 0]);
  return normalizeLayout(layout);
}

// ---- driving a world ---------------------------------------------------------------------------------------------------------

/**
 * Give a createWorld (stub traffic) world a live Stats the way the engine wires it: every event goes to `stats.onEvent`, `stats.sample(dt)` runs after
 * each tick. `world.stats.report()` then carries `report.ops` for a plant with trucks.
 * @returns {object} the world (the same object), with `world.stats`
 */
export function attachStats(world) {
  const sim = { time: 0, layout: world.layout, graph: world.graph, traffic: world.traffic, logistics: world.lg, settings: world.layout.settings, stats: null };
  const emit = world.lg.emit;
  const stepOne = world.step;
  world.stats = sim.stats = new Stats(sim);
  world.lg.emit = (name, payload) => { emit(name, payload); world.stats.onEvent(name, payload); };
  world.step = (n = 1) => {
    for (let i = 0; i < n; i++) {
      stepOne(1);
      sim.time = world.tick * world.dt;
      world.stats.sample(world.dt);
    }
  };
  return world;
}

/**
 * Step `seconds`, asserting every invariant (conservation, claims, capacities and the truck invariants of 6.3.5) after EVERY tick.
 * @param {object} world createWorld / createRealWorld
 * @param {number} seconds
 * @param {{ every?: number, whatIf?: Array<{ at: number, patch: object }> }} [opts] `every`: check every n-th tick (default 1); `whatIf`: runtime changes applied when the clock reaches `at`
 */
export function runTrucks(world, seconds, { every = 1, whatIf = [] } = {}) {
  const n = Math.round(seconds / world.dt);
  const pending = [...whatIf].sort((a, b) => a.at - b.at);
  for (let i = 1; i <= n; i++) {
    while (pending.length > 0 && pending[0].at <= world.t + 1e-9) world.lg.setRuntime(pending.shift().patch);
    world.step();
    if (every === 1 || i % every === 0 || i === n) assertInvariants(world.lg, `tick ${world.tick}`);
  }
}

/** The truck events of an event log as comparable text: name, station, nominal time, truck id and door. */
export function truckDigest(events, { only = null } = {}) {
  return events
    .filter((e) => e.name.startsWith('truck') && (only === null || e.payload.stationId === only))
    .map((e) => {
      const p = e.payload;
      const at = p.at ?? (p.truck && p.truck.at);
      return `${e.name}:${p.stationId}:${at === undefined ? '' : Number(at).toFixed(6)}:${p.truck ? p.truck.id : ''}:${p.door ?? ''}`;
    })
    .join('|');
}
