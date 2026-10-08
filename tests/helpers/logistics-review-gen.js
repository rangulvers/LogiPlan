// Test helper for the adversarial logistics review (tests/sim.logistics.review.test.js).
//
//   gridPlant({ cols, rows, stations, flows, vehicles, seed })   a large reproducible Manhattan-grid plant (more than the 26
//                                                                 stations tests/helpers/ascii.js can express, dozens of flows)
//   hostilePlant(seed)                                           a small random plant full of hostile settings (see below)
//   createRealWorld(layout, opts)                                graph + the REAL TrafficSystem + Logistics (+ optional Stats),
//                                                                 wired the way the engine will wire them
//   runChecked(world, seconds, every)                            step with the logistics invariants asserted every few ticks
//   waitBehindIdle(world)                                        longest wait of a vehicle queued behind a standing vehicle
//
// Plants are plain layouts (JSON): stations, flows and fleets are drawn from a seeded stream, so every seed is reproducible.

import { createRng } from '../../js/util/rng.js';
import { cellKey, DIR_BIT, DX, DY } from '../../js/util/grid.js';
import { defaultFleet, defaultFlow, defaultStation, dist, emptyLayout } from '../../js/model/defaults.js';
import { buildGraph } from '../../js/sim/graph.js';
import { TrafficSystem } from '../../js/sim/traffic.js';
import { Logistics } from '../../js/sim/logistics.js';
import { Stats } from '../../js/sim/stats.js';
import { assertInvariants } from './logistics-invariants.js';

const TYPES = ['source', 'process', 'storage', 'sink'];
const FROM_OK = new Set(['source', 'process', 'storage']);
const TO_OK = new Set(['process', 'storage', 'sink']);

/** Two-way links between every pair of adjacent road cells of `layout.roads`. */
export function linkAllNeighbours(layout) {
  for (const key of Object.keys(layout.roads)) {
    const [x, y] = key.split(',').map(Number);
    let out = 0;
    for (let d = 0; d < 4; d++) if (layout.roads[cellKey(x + DX[d], y + DY[d])]) out |= DIR_BIT[d];
    layout.roads[key].out = out;
  }
}

/**
 * A reproducible Manhattan-grid plant.
 * @param {{ cols?: number, rows?: number, stations?: number, flows?: number, vehicles?: number, seed?: number,
 *   interArrival?: number, cycle?: number, capacity?: number, depots?: number, settings?: object }} [opts]
 */
export function gridPlant({
  cols = 60, rows = 40, stations = 50, flows = 60, vehicles = 100, seed = 1,
  interArrival = 40, cycle = 20, capacity = 1, depots = 2, settings = {},
} = {}) {
  const rng = createRng(seed);
  const layout = emptyLayout({ grid: { cols, rows, cellSize: 2 }, settings: { seed, ...settings } });
  const hRows = [];
  for (let y = 3; y < rows - 3; y += 7) hRows.push(y);
  const vCols = [1, Math.floor(cols / 3), Math.floor((2 * cols) / 3), cols - 2];
  for (const y of hRows) for (let x = 1; x < cols - 1; x++) layout.roads[cellKey(x, y)] = { out: 0 };
  for (const x of vCols) for (let y = hRows[0]; y <= hRows[hRows.length - 1]; y++) layout.roads[cellKey(x, y)] = { out: 0 };
  linkAllNeighbours(layout);

  const slots = [];
  for (const y of hRows) for (let x = 3; x + 3 < cols - 1; x += 5) {
    if (vCols.some((c) => c >= x - 1 && c <= x + 3)) continue;
    slots.push({ x, y: y + 1 }, { x, y: y - 2 });
  }
  const chosen = [];
  while (chosen.length < stations + depots && slots.length > 0) chosen.push(slots.splice(rng.int(slots.length), 1)[0]);
  const made = [];
  chosen.forEach((slot, i) => {
    const isDepot = i >= stations;
    const type = isDepot ? 'depot' : i < 4 ? TYPES[i] : rng.pick(TYPES);
    const params = {};
    if (type === 'source') Object.assign(params, { interArrival: dist('exp', interArrival), outCap: 4 });
    if (type === 'process') Object.assign(params, { cycle: dist('uniform', cycle, 0.3), inCap: 4, outCap: 4 });
    if (type === 'storage') Object.assign(params, { capacity: 12, dwell: 5 });
    if (type === 'depot') Object.assign(params, { slots: Math.ceil(vehicles / Math.max(1, depots)), chargers: 2 });
    const st = defaultStation(type, { id: 's' + (i + 1), name: type + (i + 1), x: slot.x, y: slot.y, w: 3, h: 2, params });
    layout.stations.push(st);
    made.push(st);
  });
  const real = made.filter((s) => s.type !== 'depot');
  const seen = new Set();
  for (let tries = 0; layout.flows.length < flows && tries < flows * 40; tries++) {
    const from = rng.pick(real.filter((s) => FROM_OK.has(s.type)));
    const to = rng.pick(real.filter((s) => TO_OK.has(s.type)));
    if (!from || !to || from === to || seen.has(from.id + '>' + to.id)) continue;
    seen.add(from.id + '>' + to.id);
    layout.flows.push(defaultFlow({ id: 'f' + (layout.flows.length + 1), from: from.id, to: to.id, weight: 1 + rng.int(3), priority: 1 + rng.int(3) }));
  }
  const dep = made.find((s) => s.type === 'depot');
  layout.fleets.push(defaultFleet('agv', { id: 'v1', count: vehicles, capacity, home: dep ? dep.id : null }));
  return layout;
}

// ---- worlds on the real traffic engine --------------------------------------------------------------------------------------

/**
 * Like createWorld (tests/helpers/logistics-invariants.js) but on the real TrafficSystem: graph + TrafficSystem + Logistics,
 * `traffic.onDeadlock` forwarded to `logistics.handleDeadlock` the way the engine does. With `check: true` the logistics
 * invariants are asserted after every tick. With `stats: true` a live Stats (js/sim/stats.js) is attached the way the engine
 * does it: every event is forwarded to `stats.onEvent`, `stats.sample(dt)` runs after `traffic.step`, `world.sim` is the object
 * Stats reads (time, layout, graph, traffic, logistics, settings).
 * @returns {{ layout, graph, traffic, lg, events, tick, dt, t, step, run, runUntil, named, sim, stats }}
 */
export function createRealWorld(layout, { seed = layout.settings.seed, dt = 0.1, check = false, runtime = null, stats = false, trafficOpts = {} } = {}) {
  const graph = buildGraph(layout);
  const traffic = new TrafficSystem(graph, { handedness: layout.settings.handedness, resolveDeadlocks: layout.settings.deadlock !== 'ignore', ...trafficOpts });
  const events = [];
  const sim = { time: 0, layout, graph, traffic, logistics: null, settings: layout.settings, stats: null };
  const world = {
    layout, graph, traffic, dt, tick: 0, events, lg: null, sim, stats: null,
    get t() { return this.tick * dt; },
    step(n = 1) {
      for (let i = 0; i < n; i++) {
        world.lg.step(dt, world.tick * dt);
        traffic.step(dt);
        world.tick++;
        sim.time = world.tick * dt;
        if (world.stats) world.stats.sample(dt);
        if (check) assertInvariants(world.lg, `tick ${world.tick}`);
      }
    },
    run(seconds) { world.step(Math.round(seconds / dt)); },
    runUntil(pred, maxSeconds) {
      const end = world.tick + Math.round(maxSeconds / dt);
      while (world.tick < end) {
        if (pred(world)) return true;
        world.step();
      }
      return pred(world);
    },
    named(name) { return events.filter((e) => e.name === name).map((e) => e.payload); },
  };
  const emit = (name, payload) => {
    events.push({ name, payload, tick: world.tick });
    if (world.stats) world.stats.onEvent(name, payload);
  };
  world.lg = new Logistics({ layout, graph, traffic, rng: createRng(seed), emit });
  sim.logistics = world.lg;
  traffic.onDeadlock = (info) => {
    world.lg.handleDeadlock(info);
    emit('deadlock', { ...info, t: sim.time });
  };
  if (stats) world.stats = sim.stats = new Stats(sim);
  if (runtime) world.lg.setRuntime(runtime);
  return world;
}

// ---- hostile random plants --------------------------------------------------------------------------------------------------

const pickOf = (rng, list) => list[rng.int(list.length)];

/** Cells (x, y) of the straight road lines of a small Manhattan grid, with a one-way direction (or 0 = two-way) per line. */
function hostileRoads(rng, cols, rows) {
  const layout = emptyLayout({ grid: { cols, rows, cellSize: 2 } });
  const lines = [];
  for (const y of [3, 9, 15, 21].filter((v) => v < rows - 2)) lines.push({ horizontal: true, at: y, from: 1, to: cols - 2, dir: rng.next() < 0.25 ? pickOf(rng, [1, 3]) : -1 });
  for (const x of [1, Math.floor(cols / 2), cols - 2]) lines.push({ horizontal: false, at: x, from: 3, to: 21, dir: rng.next() < 0.2 ? pickOf(rng, [0, 2]) : -1 });
  const allowed = new Map(); // cell key -> bitmask of exit directions allowed by the lines through the cell
  const note = (x, y, mask) => { const k = cellKey(x, y); layout.roads[k] = layout.roads[k] || { out: 0 }; allowed.set(k, (allowed.get(k) || 0) | mask); };
  for (const l of lines) {
    for (let i = l.from; i <= l.to; i++) {
      const x = l.horizontal ? i : l.at;
      const y = l.horizontal ? l.at : i;
      if (x >= cols || y >= rows) continue;
      const axis = l.horizontal ? [1, 3] : [0, 2];
      note(x, y, axis.reduce((m, d) => m | (l.dir < 0 || l.dir === d ? DIR_BIT[d] : 0), 0));
    }
  }
  for (const [k, mask] of allowed) {
    const [x, y] = k.split(',').map(Number);
    let out = 0;
    for (let d = 0; d < 4; d++) if ((mask & DIR_BIT[d]) && layout.roads[cellKey(x + DX[d], y + DY[d])]) out |= DIR_BIT[d];
    layout.roads[k].out = out;
  }
  return layout;
}

/**
 * A random small plant with hostile settings: one-way lines, perCycle above inCap, zero weights, zero-length cycles, tiny and huge
 * breakdown times, big batches, 0..6 machines, outputs larger than the buffers, depots without chargers, batteries that run
 * flat, vehicles of capacity 1..6 and fleets of 0..6. Reproducible per seed. No configuration is "invalid" in the sense
 * of the layout schema: everything is something a planner could type into the inspector.
 */
export function hostilePlant(seed) {
  const rng = createRng(seed);
  const cols = 36;
  const rows = 24;
  const layout = hostileRoads(rng, cols, rows);
  layout.settings = { ...layout.settings, seed, handedness: rng.next() < 0.5 ? 'right' : 'left', dispatch: pickOf(rng, ['nearest', 'oldest', 'balanced']), routing: pickOf(rng, ['shortest', 'congestion']) };
  const free = [];
  for (const y of [3, 9, 15, 21]) for (let x = 3; x + 3 < cols - 1; x += 5) { free.push({ x, y: y + 1 }); free.push({ x, y: y - 2 }); }
  const take = () => (free.length > 0 ? free.splice(rng.int(free.length), 1)[0] : null);
  const kinds = ['source', 'process', 'process', 'storage', 'sink', 'process', 'source', 'sink', 'storage', 'process'];
  const stations = [];
  for (let i = 0; i < kinds.length; i++) {
    const slot = take();
    if (!slot || layout.roads[cellKey(slot.x, slot.y)] || layout.roads[cellKey(slot.x, slot.y + 1)]) continue;
    const type = kinds[i];
    const params = {};
    if (type === 'source') {
      Object.assign(params, {
        interArrival: dist(pickOf(rng, ['exp', 'normal', 'uniform', 'const']), pickOf(rng, [0, 3, 12, 40]), rng.next()),
        batch: pickOf(rng, [1, 1, 2, 5, 50]), outCap: pickOf(rng, [0, 1, 3, 6]), startDelay: pickOf(rng, [0, 5, 100]),
      });
    } else if (type === 'process') {
      Object.assign(params, {
        cycle: dist(pickOf(rng, ['exp', 'normal', 'uniform', 'const']), pickOf(rng, [0, 0.5, 8, 60]), rng.next()),
        machines: pickOf(rng, [0, 1, 1, 2, 5]), outPerCycle: pickOf(rng, [0, 1, 1, 3]), inCap: pickOf(rng, [0, 1, 2, 6]), outCap: pickOf(rng, [0, 1, 2, 6]),
        mtbf: pickOf(rng, [0, 0, 0.01, 50, 1e9]), mttr: pickOf(rng, [0, 0.01, 30, 1e9]),
      });
    } else if (type === 'storage') {
      Object.assign(params, { capacity: pickOf(rng, [0, 1, 3, 20]), dwell: pickOf(rng, [0, 0, 7, 400]) });
    }
    const st = defaultStation(type, { id: 's' + (i + 1), name: type + (i + 1), x: slot.x, y: slot.y, w: 3, h: 2, params });
    layout.stations.push(st);
    stations.push(st);
  }
  for (let d = 0; d < rng.int(3); d++) {
    const slot = take();
    if (!slot || layout.roads[cellKey(slot.x, slot.y)] || layout.roads[cellKey(slot.x, slot.y + 1)]) continue;
    const slots = pickOf(rng, [0, 1, 2, 6]);
    layout.stations.push(defaultStation('depot', { id: 'd' + (d + 1), name: 'depot' + (d + 1), x: slot.x, y: slot.y, w: 3, h: 2, params: { slots, chargers: pickOf(rng, [0, 1, 6]) } }));
  }
  const depots = layout.stations.filter((s) => s.type === 'depot');
  const fleets = 1 + rng.int(3);
  for (let f = 0; f < fleets; f++) {
    layout.fleets.push(defaultFleet(pickOf(rng, ['agv', 'forklift', 'tugger', 'custom']), {
      id: 'v' + (f + 1), count: pickOf(rng, [0, 1, 2, 3, 6]), capacity: pickOf(rng, [1, 1, 2, 4, 6]), loadTime: pickOf(rng, [0, 3, 12]), unloadTime: pickOf(rng, [0, 3, 12]),
      idle: pickOf(rng, ['park', 'stay']), home: depots.length > 0 && rng.next() < 0.7 ? pickOf(rng, depots).id : null,
      mtbf: pickOf(rng, [0, 0, 80, 1e9]), mttr: pickOf(rng, [0, 25]),
      battery: { enabled: rng.next() < 0.4, runtimeMin: pickOf(rng, [0, 2, 10, 480]), chargeTimeMin: pickOf(rng, [0, 1, 20]), lowPct: pickOf(rng, [0, 25, 60, 100]), resumePct: pickOf(rng, [10, 50, 90, 100]) },
    }));
  }
  const from = stations.filter((s) => FROM_OK.has(s.type));
  const to = stations.filter((s) => TO_OK.has(s.type));
  const seen = new Set();
  for (let tries = 0; tries < 60 && layout.flows.length < 3 + rng.int(8) && from.length > 0 && to.length > 0; tries++) {
    const a = pickOf(rng, from);
    const b = pickOf(rng, to);
    if (a === b || seen.has(a.id + '>' + b.id)) continue;
    seen.add(a.id + '>' + b.id);
    layout.flows.push(defaultFlow({
      id: 'f' + (layout.flows.length + 1), from: a.id, to: b.id, weight: pickOf(rng, [0, 1, 1, 3, 100]), perCycle: pickOf(rng, [1, 1, 2, 9]),
      batchMin: pickOf(rng, [1, 1, 3, 50]), batchMax: pickOf(rng, [0, 0, 1, 2]), maxWait: pickOf(rng, [0, 0, 20]), priority: pickOf(rng, [1, 2, 3]),
      fleetId: rng.next() < 0.3 ? pickOf(rng, layout.fleets).id : null,
    }));
  }
  return layout;
}

// ---- liveness helpers -------------------------------------------------------------------------------------------------------

/** Step `seconds` of sim time, asserting the logistics invariants every `every` ticks (and at the end). */
export function runChecked(world, seconds, every = 4) {
  const n = Math.round(seconds / world.dt);
  for (let i = 1; i <= n; i++) {
    world.step();
    if (i % every === 0 || i === n) assertInvariants(world.lg, `tick ${world.tick}`);
  }
}

/**
 * The longest time (s) any vehicle has been waiting in a queue whose head is a vehicle that is itself standing without
 * work: not waiting, not broken, not dead - an idle vehicle parked on a dock or in an aisle. That is a jam only the logistics
 * layer can end (the traffic engine's wait-for graph has no cycle in it, so it never reports a deadlock).
 */
export function waitBehindIdle(world) {
  let worst = 0;
  for (const vr of world.lg.vehicles) {
    const tv = vr.tv;
    if (!tv.onRoad || !tv.waiting) continue;
    let head = tv;
    for (let hops = 0; head.blockedBy && head.blockedBy.waiting && hops < 200; hops++) head = head.blockedBy;
    const blocker = head.blockedBy && head.blockedBy.owner;
    if (blocker && blocker.state === 'idle' && tv.waitTime > worst) worst = tv.waitTime;
  }
  return worst;
}
