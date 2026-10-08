// Test helper of the adversarial review of the integrated simulation (tests/sim.engine.review.test.js).
//
// Written independently of tests/helpers/sim-invariants.js, traffic-invariants.js and logistics-invariants.js: it reads only the
// PUBLIC surface of a Simulation (sim.time, sim.vehicles, sim.stations, sim.flows, sim.traffic.vehicles, sim.graph and the
// event bus; queues and machines of the stations as the renderer sees them), never a traffic internal, and re-derives every figure
// it checks by walking the data itself. A reviewer that reuses the checker of the builder inherits its blind spots.
//
//   hostilePlant(seed)        a complete layout made through the layout.js mutators, deliberately nasty: one-way dead ends,
//                             stations without a dock, flows between road islands, 1x1 stations, empty fleets, batteries
//                             without charger, crawling vehicles, huge batches, dense street grids ...
//   createAuditor(sim)        audit.tick() after every step: time, poses on the road, no overlapping bodies, speed limit, load
//                             conservation (created = live + completed + consumed, found by walking every container), queue and
//                             depot capacities, order bookkeeping; audit.report() for the KPI report; audit.stuck() a watchdog
//                             for vehicles that do not move, with the cause found by following the chain of blockers. Each
//                             returns a list of violation strings.
//   fingerprint(sim)          a digest of the complete state, to compare runs bit for bit
//   jamPlant, bridgePlant, tuggerTwoLines, blockPlant, emptyRoad   engineered plants (deadlock, a trap region, long vehicles, size)
//   handCheck(id, seed, h)    the napkin checks of a long example run (supply, capacity, lead-time floor, distance, trips ...)
//   runParallel(job, args)    runs the heavy loops on worker threads (this file is also the worker script)
//
import assert from 'node:assert/strict';
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createRng } from '../../js/util/rng.js';
import { lPath } from '../../js/util/grid.js';
import { FLEET_PRESETS } from '../../js/model/defaults.js';
import {
  addFleet, addFlow, addObstacle, addStation, createLayout, paintRoadPath, updateFleet, updateSettings, updateStation,
} from '../../js/model/layout.js';
import { EXAMPLES } from '../../js/model/examples.js';
import { Simulation } from '../../js/sim/engine.js';
import { layoutFromAscii } from './ascii.js';

// ---------------------------------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------------------------------

/** Index of the cell containing a world point, as { cx, cy }. */
export function cellOf(graph, x, y) {
  return { cx: Math.floor(x / graph.cellSize), cy: Math.floor(y / graph.cellSize) };
}

function corners(v, shrinkLength, shrinkWidth) {
  const hl = (v.length * shrinkLength) / 2;
  const hw = (v.width * shrinkWidth) / 2;
  const c = Math.cos(v.heading);
  const s = Math.sin(v.heading);
  return [[hl, hw], [hl, -hw], [-hl, -hw], [-hl, hw]].map(([a, b]) => [v.x + a * c - b * s, v.y + a * s + b * c]);
}

/** Largest gap on a separating axis of two convex polygons: > 0 apart, < 0 interpenetration depth. */
function separation(pa, pb) {
  let best = -Infinity;
  for (const poly of [pa, pb]) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % poly.length];
      const nx = y1 - y2;
      const ny = x2 - x1;
      const norm = Math.hypot(nx, ny);
      let minA = Infinity;
      let maxA = -Infinity;
      let minB = Infinity;
      let maxB = -Infinity;
      for (const [x, y] of pa) { const p = (x * nx + y * ny) / norm; minA = Math.min(minA, p); maxA = Math.max(maxA, p); }
      for (const [x, y] of pb) { const p = (x * nx + y * ny) / norm; minB = Math.min(minB, p); maxB = Math.max(maxB, p); }
      best = Math.max(best, minB - maxA, minA - maxB);
    }
  }
  return best;
}

/**
 * How deep two vehicle bodies (oriented rectangles of their length x width, shrunk to `shrink` of their size so that the
 * rigid-body approximation on a curve is not mistaken for a collision) penetrate each other; <= 0 when they are apart.
 */
export function bodyPenetration(a, b, shrink = 0.8) {
  return -separation(corners(a, shrink, shrink), corners(b, shrink, shrink));
}

// ---------------------------------------------------------------------------------------------------------------------
// Fingerprint
// ---------------------------------------------------------------------------------------------------------------------

const r9 = (x) => (Number.isFinite(x) ? x.toPrecision(15) : String(x));

/** Digest of everything a run has produced so far (clock, vehicles, stations, counters, the KPI report). Equal runs, equal strings. */
export function fingerprint(sim) {
  const parts = [r9(sim.time)];
  for (const v of sim.vehicles) {
    parts.push([v.id, v.state, r9(v.x), r9(v.y), r9(v.heading), r9(v.battery), v.trips, r9(v.loadedDistance), r9(v.emptyDistance), v.load.length, v.visible].join(','));
  }
  for (const s of sim.stations) {
    parts.push([s.id, s.state, s.produced, s.consumed, s.arrivals, s.fillLabel].join(','));
  }
  const lg = sim.logistics;
  parts.push([lg.liveLoads, lg.completed, lg.createdBySources, lg.createdByProcesses, lg.loadsConsumed, lg.ordersDelivered, lg.deadlocks, lg.activeOrders.size].join(','));
  parts.push(JSON.stringify(sim.kpis()));
  return parts.join('|');
}

// ---------------------------------------------------------------------------------------------------------------------
// The auditor
// ---------------------------------------------------------------------------------------------------------------------

const DRIVING = new Set(['toPickup', 'toDrop', 'toCharger', 'toPark']);
const EPS = 1e-6;
/** Above this many live loads the conservation walk is skipped (the counters are still compared with the event ledger). */
const WALK_LIMIT = 5000;

/** Every load found in the containers of the plant, with where it was found. Walks yards, queues, storage pools, machines, vehicles. */
function loadsOf(sim) {
  const found = [];
  let inCycles = 0;
  for (const st of sim.stations) {
    if (st.yardQ) for (const l of st.yardQ) found.push([l, `${st.id}.yard`]);
    for (const link of st.outLinks || []) for (const l of link.queue) found.push([l, `${st.id}.out(${link.flow.id})`]);
    for (const link of st.inLinks || []) for (const l of link.queue) found.push([l, `${st.id}.in(${link.flow.id})`]);
    if (st.pool) for (const l of st.pool) found.push([l, `${st.id}.pool`]);
    for (const m of st.machines || []) {
      for (const l of m.holding) found.push([l, `${st.id}.held`]);
      inCycles += m.inputs;
    }
  }
  for (const v of sim.vehicles) for (const l of v.load) found.push([l, `${v.id}.load`]);
  return { found, inCycles };
}

/**
 * Independent auditor for one Simulation. Call tick() after every sim.step(); report() now and then; stuck() at checkpoints.
 * @param {object} sim
 * @param {{ shrink?: number, penetration?: number, bendShrink?: number, bendPenetration?: number }} [opts]
 *   On straight road two bodies shrunk to `shrink` of their size (nearly the full rectangles) may not penetrate each other by more
 *   than `penetration` metres; within reach of a bend or junction, where a rigid rectangle on a curved path swings wide, the same
 *   with `bendShrink` and `bendPenetration`.
 */
export function createAuditor(sim, { shrink = 0.95, penetration = 0.005, bendShrink = 0.7, bendPenetration = 0.1 } = {}) {
  const ev = { created: 0, completed: 0, assigned: 0, delivered: 0, cancelled: 0, deadlock: 0, loadIds: new Set(), dupCreate: 0 };
  sim.on('loadCreated', (p) => { ev.created++; if (ev.loadIds.has(p.load.id)) ev.dupCreate++; ev.loadIds.add(p.load.id); });
  sim.on('loadCompleted', () => { ev.completed++; });
  sim.on('orderAssigned', () => { ev.assigned++; });
  sim.on('orderDelivered', () => { ev.delivered++; });
  sim.on('orderCancelled', () => { ev.cancelled++; });
  sim.on('deadlock', () => { ev.deadlock++; });
  const g = sim.graph;
  // cells where the road turns or branches: rigid rectangles on a curved path overlap a little there, which is not a collision
  const bends = [];
  for (const node of g.nodes) {
    const axes = new Set([...g.in[node], ...g.out[node]].map((e) => g.edges[e].dir & 1));
    if (axes.size > 1) bends.push([g.x(node), g.y(node)]);
  }
  const nearBend = (tv) => bends.some(([bx, by]) => Math.hypot(tv.x - bx, tv.y - by) <= g.cellSize + tv.length / 2);
  let lastTime = sim.time;
  let ticks = 0;
  let maxFactor = sim.settings.speedFactor;
  const odo = new Map(sim.vehicles.map((v) => [v.id, { at: sim.time, value: v.tv.odometer, state: v.state, since: sim.time }]));
  let lastCompleted = 0;
  let lastProgress = sim.time;

  function onRoadCell(x, y) {
    const { cx, cy } = cellOf(g, x, y);
    if (cx < 0 || cy < 0 || cx >= g.cols || cy >= g.rows) return false;
    return g.isNode[cy * g.cols + cx] === 1;
  }

  /** The cheap per-tick checks. */
  function checkTick(out) {
    if (Math.abs(sim.time - lastTime - sim.dt) > 1e-9) out.push(`clock moved ${lastTime} -> ${sim.time}, dt ${sim.dt}`);
    lastTime = sim.time;
    maxFactor = Math.max(maxFactor, sim.settings.speedFactor);
    const on = [];
    for (const v of sim.vehicles) {
      const tv = v.tv;
      for (const k of ['x', 'y', 'heading', 'prevX', 'prevY', 'prevHeading']) if (!Number.isFinite(v[k])) out.push(`${v.id}.${k} = ${v[k]}`);
      if (!(v.battery >= 0 && v.battery <= 1)) out.push(`${v.id} battery ${v.battery}`);
      if (v.load.length > v.cfg.capacity) out.push(`${v.id} carries ${v.load.length} > capacity ${v.cfg.capacity}`);
      if (v.visible !== tv.onRoad) out.push(`${v.id} visible=${v.visible} onRoad=${tv.onRoad}`);
      if (!tv.onRoad) {
        if ((v.state !== 'parked' && v.state !== 'charging')) out.push(`${v.id} is off the road in state ${v.state}`);
        continue;
      }
      if (v.state === 'parked' || v.state === 'charging') out.push(`${v.id} is ${v.state} but on the road`);
      if (!Number.isFinite(tv.v) || tv.v < -EPS) out.push(`${v.id} speed ${tv.v}`);
      else if (tv.v > tv.vmax * Math.max(maxFactor, 1e-9) + 1e-6) out.push(`${v.id} speed ${tv.v} above vmax ${tv.vmax} x factor ${maxFactor}`);
      if (!onRoadCell(tv.x, tv.y)) out.push(`${v.id} left the road network at (${tv.x.toFixed(2)}, ${tv.y.toFixed(2)})`);
      on.push(tv);
    }
    // overlapping bodies: cheap grid broad phase
    const hash = new Map();
    const reach = Math.max(1, ...on.map((tv) => tv.length)) + 1;
    for (const tv of on) {
      const key = `${Math.floor(tv.x / reach)},${Math.floor(tv.y / reach)}`;
      if (!hash.has(key)) hash.set(key, []);
      hash.get(key).push(tv);
    }
    for (const tv of on) {
      const bx = Math.floor(tv.x / reach);
      const by = Math.floor(tv.y / reach);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const other of hash.get(`${bx + dx},${by + dy}`) || []) {
            if (other.id <= tv.id) continue;
            if (Math.hypot(other.x - tv.x, other.y - tv.y) > (tv.length + other.length + tv.width + other.width)) continue;
            const bend = nearBend(tv) || nearBend(other);
            const depth = bodyPenetration(tv, other, bend ? bendShrink : shrink);
            if (depth > (bend ? bendPenetration : penetration)) out.push(`${tv.id} and ${other.id} overlap by ${depth.toFixed(3)} m at (${tv.x.toFixed(2)}, ${tv.y.toFixed(2)})`);
          }
        }
      }
    }
    // counters: events versus the logistics' own books
    const lg = sim.logistics;
    if (ev.created !== lg.createdBySources + lg.createdByProcesses) out.push(`loadCreated events ${ev.created} vs counters ${lg.createdBySources + lg.createdByProcesses}`);
    if (ev.completed !== lg.completed) out.push(`loadCompleted events ${ev.completed} vs counter ${lg.completed}`);
    if (ev.delivered !== lg.ordersDelivered) out.push(`orderDelivered events ${ev.delivered} vs counter ${lg.ordersDelivered}`);
    if (ev.dupCreate > 0) out.push(`${ev.dupCreate} load ids created twice`);
    if (ev.assigned - ev.delivered - ev.cancelled !== lg.activeOrders.size) {
      out.push(`orders: ${ev.assigned} assigned - ${ev.delivered} delivered - ${ev.cancelled} cancelled != ${lg.activeOrders.size} active`);
    }
  }

  /** The thorough checks: conservation by walking every container, capacities, orders and depots. */
  function checkFull(out) {
    const lg = sim.logistics;
    if (lg.liveLoads > WALK_LIMIT) return; // an overloaded source: walking 100k loads per check would cost more than the simulation
    const { found, inCycles } = loadsOf(sim);
    const seen = new Map();
    for (const [load, where] of found) {
      if (seen.has(load)) out.push(`load ${load.id} found twice: ${seen.get(load)} and ${where}`);
      seen.set(load, where);
    }
    let consumed = 0;
    for (const st of sim.stations) if (st.type === 'process') consumed += st.consumed;
    const live = found.length + inCycles;
    if (live !== lg.liveLoads) out.push(`live loads: found ${live} in the plant, logistics says ${lg.liveLoads}`);
    if (ev.created !== live + ev.completed + consumed) {
      out.push(`conservation: created ${ev.created} != live ${live} + completed ${ev.completed} + consumed by workstations ${consumed}`);
    }
    for (const st of sim.stations) checkStation(st, out);
    // orders: claims match active orders
    const claimedByOrders = new Map();
    for (const order of lg.activeOrders.values()) {
      claimedByOrders.set(order.flowId, (claimedByOrders.get(order.flowId) || 0) + order.qty);
      if (order.loads.length !== order.qty) out.push(`order ${order.id}: qty ${order.qty} but ${order.loads.length} loads`);
      const owner = sim.vehicles.find((v) => v.id === order.vehicleId);
      if (!owner || owner.order !== order) out.push(`order ${order.id} is not held by vehicle ${order.vehicleId}`);
    }
    for (const flow of sim.flows) {
      const inbound = flow.to.inbound.get(flow.id);
      if (inbound !== (claimedByOrders.get(flow.id) || 0)) out.push(`flow ${flow.id}: inbound reservation ${inbound} vs ${claimedByOrders.get(flow.id) || 0} loads in active orders`);
      if (flow.delivered < 0 || flow.trips < 0) out.push(`flow ${flow.id} negative counters`);
    }
    for (const v of sim.vehicles) {
      if (v.order && !lg.activeOrders.has(v.order.id)) out.push(`${v.id} holds order ${v.order.id} which is not active`);
      if (v.load.length > 0 && !v.order && v.state !== 'dead') out.push(`${v.id} carries ${v.load.length} loads without an order in state ${v.state}`);
    }
    // the books are updated at the start of a tick, so they may lag the odometer by the distance of one tick
    const roadDist = sim.vehicles.reduce((a, v) => a + v.loadedDistance + v.emptyDistance + v.parkDistance, 0);
    const odometer = sim.vehicles.reduce((a, v) => a + v.tv.odometer, 0);
    const oneTick = sim.vehicles.reduce((a, v) => a + v.tv.vmax * maxFactor * sim.dt, 0);
    if (Math.abs(roadDist - odometer) > 1 + oneTick) {
      out.push(`distance: loaded + empty + park ${roadDist.toFixed(2)} vs odometer ${odometer.toFixed(2)}`);
    }
  }

  function checkStation(st, out) {
    const label = `${st.type} ${st.id}`;
    if (st.type === 'source') {
      for (const link of st.outLinks) if (link.queue.length > link.cap) out.push(`${label}: output buffer ${link.queue.length} > outCap ${link.cap}`);
    } else if (st.type === 'process') {
      if (st.machines.length > st.params.machines) out.push(`${label}: ${st.machines.length} machines > ${st.params.machines}`);
      for (const link of st.outLinks) if (link.queue.length > link.cap) out.push(`${label}: output buffer ${link.queue.length} > outCap ${link.cap}`);
      for (const link of st.inLinks) {
        const inbound = st.inbound.get(link.flow.id);
        if (link.queue.length + inbound > st.params.inCap) out.push(`${label}: input ${link.queue.length} + inbound ${inbound} > inCap ${st.params.inCap}`);
        if (inbound < 0) out.push(`${label}: negative inbound`);
      }
      for (const m of st.machines) {
        if (m.state === 'blocked' && m.holding.length === 0) out.push(`${label}: blocked machine holds nothing`);
        if (m.state === 'idle' && (m.holding.length > 0 || m.inputs > 0)) out.push(`${label}: idle machine holds loads`);
        if (m.state === 'busy' && !(m.remaining >= -EPS && m.cycleTime > 0)) out.push(`${label}: busy machine remaining ${m.remaining} cycle ${m.cycleTime}`);
      }
    } else if (st.type === 'storage') {
      if (st.outCount > st.params.capacity) out.push(`${label}: holds ${st.outCount} > capacity ${st.params.capacity}`);
      if (st.outCount + st.inboundTotal > st.params.capacity) out.push(`${label}: holds ${st.outCount} + inbound ${st.inboundTotal} > capacity ${st.params.capacity}`);
    } else if (st.type === 'depot') {
      if (st.parked.length + st.charging.length > st.slots) out.push(`${label}: ${st.parked.length} parked + ${st.charging.length} charging > ${st.slots} slots`);
      if (st.charging.length > st.chargers) out.push(`${label}: ${st.charging.length} charging > ${st.chargers} chargers`);
      if (st.reservedSlots < 0 || st.reservedChargers < 0) out.push(`${label}: negative reservation`);
    }
    for (const k of ['produced', 'consumed', 'arrivals']) if (!(st[k] >= 0)) out.push(`${label}: ${k} = ${st[k]}`);
  }

  /** Why a waiting vehicle does not move: follow the blockers to the end of the chain. */
  function causeOf(v) {
    const seen = new Set();
    let tv = v.tv;
    while (tv && !seen.has(tv)) {
      seen.add(tv);
      if (tv.disabled) return 'broken';
      if (!tv.waiting || !tv.blockedBy) {
        const owner = tv.owner;
        if (!tv.waiting && tv === v.tv) return 'free';
        return owner && owner.state === 'idle' ? 'idle' : 'other';
      }
      tv = tv.blockedBy;
    }
    return 'cycle';
  }

  return {
    ev,
    /** Cheap checks after every tick, the thorough ones every `fullEvery` ticks (default 10). Returns violation strings. */
    tick(fullEvery = 10) {
      const out = [];
      ticks++;
      checkTick(out);
      if (ticks % fullEvery === 0) checkFull(out);
      return out;
    },
    full() {
      const out = [];
      checkFull(out);
      return out;
    },
    /** Sanity of a KPI report: finite, fractions in range, shares add up, consistency with the plant. */
    report(report = sim.kpis()) {
      const out = [];
      const bad = (path, v) => out.push(`${path} = ${v}`);
      (function walk(value, path) {
        if (typeof value === 'number') { if (!Number.isFinite(value)) bad(path, value); } else if (Array.isArray(value)) value.forEach((x, i) => walk(x, `${path}[${i}]`));
        else if (value && typeof value === 'object') for (const [k, x] of Object.entries(value)) walk(x, `${path}.${k}`);
      }(report, 'report'));
      const unit = (path, v) => { if (!(v >= -EPS && v <= 1 + EPS)) bad(path, v); };
      for (const [id, f] of Object.entries(report.fleets)) {
        unit(`fleet ${id} utilization`, f.utilization);
        let sum = 0;
        for (const [k, v] of Object.entries(f.shares)) { unit(`fleet ${id} share ${k}`, v); sum += v; }
        if (Math.abs(sum - 1) > 1e-6) bad(`fleet ${id} shares sum`, sum);
        if (f.emptyShare !== null) unit(`fleet ${id} emptyShare`, f.emptyShare);
        if (f.minBattery !== null) unit(`fleet ${id} minBattery`, f.minBattery);
      }
      for (const [id, s] of Object.entries(report.stations)) {
        for (const k of ['utilization', 'starved', 'blocked', 'down', 'avgFill', 'maxFill']) unit(`station ${id} ${k}`, s[k]);
        if (s.type === 'process' && report.window.duration > 0) {
          const total = s.utilization + s.starved + s.blocked + s.down;
          if (Math.abs(total - 1) > 1e-6) bad(`workstation ${id} time shares sum`, total);
        }
      }
      unit('traffic.waitShare', report.traffic.waitShare);
      const lead = report.leadTime;
      if (lead.count > 0) {
        const chain = [lead.min, lead.p50, lead.p90, lead.p95, lead.max];
        for (let i = 1; i < chain.length; i++) if (chain[i] < chain[i - 1] - EPS) bad('lead-time percentiles', chain.join(' <= '));
        if (!(lead.mean >= lead.min - EPS && lead.mean <= lead.max + EPS)) bad('lead mean outside min..max', lead.mean);
      }
      const w = report.window;
      if (Math.abs(w.start + w.duration - w.end) > 1e-6) bad('window start + duration - end', w.start + w.duration - w.end);
      if (w.end > sim.time + 1e-6) bad('window end beyond the clock', w.end - sim.time);
      return out;
    },
    /**
     * Watchdog. A vehicle that is in a driving state, not broken, and has not moved for `vehicleSeconds` is stuck. Each message
     * starts with the cause found by following the chain of blockers: [broken] a breakdown or dead battery ahead (legitimate: the
     * plant did what it was told), [cycle] a ring of vehicles waiting for each other (a deadlock that was not resolved),
     * [idle] an idle vehicle that never makes room, [free] nothing in the way at all, [other] anything else (e.g. a loading vehicle).
     */
    stuck({ vehicleSeconds = 900 } = {}) {
      const out = [];
      for (const v of sim.vehicles) {
        const rec = odo.get(v.id);
        const moved = v.tv.odometer > rec.value + 1e-9;
        if (moved || v.state !== rec.state || !DRIVING.has(v.state) || v.tv.disabled || !v.tv.onRoad) {
          rec.value = v.tv.odometer;
          rec.state = v.state;
          rec.since = sim.time;
        } else if (sim.time - rec.since > vehicleSeconds) {
          out.push(`[${causeOf(v)}] ${v.id} has been ${v.state} for ${(sim.time - rec.since).toFixed(0)} s without moving (waiting=${v.tv.waiting}, blockedBy=${v.tv.blockedBy && v.tv.blockedBy.id})`);
          rec.since = sim.time;
        }
      }
      if (sim.logistics.completed > lastCompleted) { lastCompleted = sim.logistics.completed; lastProgress = sim.time; }
      return out;
    },
    /** Seconds since the plant last completed a load. */
    idleFor() { return sim.time - lastProgress; },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Hostile plants
// ---------------------------------------------------------------------------------------------------------------------

const dist = (mean, spread = 0.1, kind = 'normal') => ({ kind, mean, spread });

function paint(layout, points, oneWay = false) {
  const cells = points.slice(1).reduce((acc, p, i) => acc.concat(lPath(...points[i], ...p).slice(1)), [points[0]]);
  paintRoadPath(layout, cells, { oneWay });
}

/** The object without its undefined entries (a patch with `undefined` would overwrite a default). */
const definedOnly = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

const roadCells = (layout) => Object.keys(layout.roads).map((k) => k.split(',').map(Number));

/** A station of `type` next to a random road cell (so it has a dock), or null if nothing fits. */
function dockedStation(layout, rng, type, params, size) {
  const cells = roadCells(layout);
  for (let attempt = 0; attempt < 80 && cells.length > 0; attempt++) {
    const [cx, cy] = cells[rng.int(cells.length)];
    const w = size ? size[0] : 1 + rng.int(3);
    const h = size ? size[1] : 1 + rng.int(3);
    const side = rng.int(4);
    const x = side === 1 ? cx + 1 : side === 3 ? cx - w : cx - rng.int(w);
    const y = side === 2 ? cy + 1 : side === 0 ? cy - h : cy - rng.int(h);
    const st = addStation(layout, { type, x, y, w, h, params });
    if (st) return st;
  }
  return null;
}

/** A station of `type` anywhere free, whether or not it touches a road (it usually does not). */
function looseStation(layout, rng, type, params) {
  for (let attempt = 0; attempt < 80; attempt++) {
    const w = 1 + rng.int(3);
    const h = 1 + rng.int(3);
    const st = addStation(layout, { type, x: rng.int(layout.grid.cols - w), y: rng.int(layout.grid.rows - h), w, h, params });
    if (st) return st;
  }
  return null;
}

function roadsFor(layout, rng, style) {
  const { cols, rows } = layout.grid;
  const x0 = 2;
  const y0 = 2;
  const x1 = cols - 3;
  const y1 = rows - 3;
  switch (style) {
    case 'ring':
      paint(layout, [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], rng.next() < 0.4);
      if (rng.next() < 0.6) paint(layout, [[Math.floor((x0 + x1) / 2), y0], [Math.floor((x0 + x1) / 2), y1]], rng.next() < 0.3);
      break;
    case 'grid':
      for (let x = x0; x <= x1; x += 4) paint(layout, [[x, y0], [x, y1]]);
      for (let y = y0; y <= y1; y += 4) paint(layout, [[x0, y], [x1, y]]);
      break;
    case 'comb':
      paint(layout, [[x0, y0 + 3], [x1, y0 + 3]]);
      for (let x = x0 + 2; x < x1; x += 4) {
        paint(layout, [[x, y0 + 3], [x, y0 + 3 + 3 + rng.int(4)]]);
        paint(layout, [[x + 1, y0 + 3], [x + 1, y0]], false);
      }
      break;
    case 'oneway-spurs': // a loop with one-way spurs: a vehicle that drives into one cannot come back
      paint(layout, [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]);
      for (let x = x0 + 3; x < x1 - 2; x += 5) paint(layout, [[x, y0], [x, y0 + 3]], true);
      break;
    case 'islands': { // two separate rings
      const mid = Math.floor((x0 + x1) / 2);
      paint(layout, [[x0, y0], [mid - 2, y0], [mid - 2, y1], [x0, y1], [x0, y0]]);
      paint(layout, [[mid + 2, y0], [x1, y0], [x1, y1], [mid + 2, y1], [mid + 2, y0]]);
      break;
    }
    case 'line':
      paint(layout, [[x0, Math.floor(rows / 2)], [x1, Math.floor(rows / 2)]], false);
      break;
    case 'bottleneck': // two halves joined by a one-cell one-way link
      paint(layout, [[x0, y0], [Math.floor(cols / 2) - 1, y0], [Math.floor(cols / 2) - 1, y1], [x0, y1], [x0, y0]]);
      paint(layout, [[Math.floor(cols / 2) + 1, y0], [x1, y0], [x1, y1], [Math.floor(cols / 2) + 1, y1], [Math.floor(cols / 2) + 1, y0]]);
      paint(layout, [[Math.floor(cols / 2) - 1, y0], [Math.floor(cols / 2) + 1, y0]], true);
      break;
    default: // 'none'
      break;
  }
}

const STYLES = ['ring', 'ring', 'ring', 'grid', 'comb', 'bottleneck', 'line'];

/** A feature switched on with probability `p`; `kind` decides which of the nasty features a plant has. */
const chance = (rng, p) => rng.next() < p;

/**
 * A complete random plant, nasty on purpose. Always valid for the model (the generator only uses the layout.js mutators). Most
 * plants work; each of the following is switched on independently with a probability of 10 to 25 %: one-way dead ends with a
 * station at the end, a station without dock, a station on a road island of its own (flows that can never be driven), 1x1
 * stations, an empty fleet, batteries without charger (and tiny batteries), crawling vehicles, huge batches and demand, long
 * vehicles (up to 1.75 cells, the verified limit of the traffic engine), coarse time steps, breakdowns everywhere.
 * @param {number} seed
 * @param {{ style?: string, longVehicles?: boolean }} [opts]
 * @returns {object} layout
 */
export function hostilePlant(seed, opts = {}) {
  const rng = createRng(seed * 15485863 + 101);
  const style = opts.style || rng.pick(STYLES);
  const cellSize = rng.pick([1, 1.5, 2, 2, 2, 3]);
  const layout = createLayout({
    name: `Hostile ${seed} (${style})`,
    cols: 18 + rng.int(24), rows: 14 + rng.int(14), cellSize,
  });
  const f = {
    deadEnd: chance(rng, 0.2), noDock: chance(rng, 0.12), island: chance(rng, 0.12), tiny: chance(rng, 0.15), emptyFleet: chance(rng, 0.12),
    batteryNoCharger: chance(rng, 0.15), crawl: chance(rng, 0.1), huge: chance(rng, 0.12), longVehicles: opts.longVehicles ?? chance(rng, 0.2),
    coarse: chance(rng, 0.15), failures: chance(rng, 0.25), noSink: chance(rng, 0.05), oversizedBom: chance(rng, 0.1),
  };
  updateSettings(layout, {
    seed: 1 + rng.int(1000000),
    dt: f.coarse ? rng.pick([0.25, 0.5]) : rng.pick([0.05, 0.1, 0.1, 0.1]),
    warmup: rng.pick([0, 0, 60, 300]),
    dispatch: rng.pick(['nearest', 'oldest', 'balanced']),
    routing: rng.pick(['shortest', 'congestion']),
    handedness: rng.pick(['right', 'left']),
    deadlock: chance(rng, 0.8) ? 'resolve' : 'ignore',
    demandFactor: f.huge ? 10 : rng.pick([1, 1, 1.5]),
    speedFactor: rng.pick([1, 1, 1, 0.3, 3]),
    processFactor: rng.pick([1, 1, 0.5, 2]),
  });
  roadsFor(layout, rng, style);
  if (f.island) paint(layout, [[layout.grid.cols - 3, layout.grid.rows - 3], [layout.grid.cols - 3, layout.grid.rows - 6]]);
  if (f.deadEnd) { // a one-way spur off the first road row: in, but never out
    const y = 2;
    for (let x = 4; x < layout.grid.cols - 4; x += 1) { if (layout.roads[`${x},${y}`]) { paint(layout, [[x, y], [x, y + 3]], true); break; } }
  }
  if (chance(rng, 0.4)) addObstacle(layout, { x: 1 + rng.int(layout.grid.cols - 4), y: 1 + rng.int(layout.grid.rows - 4), w: 1 + rng.int(3), h: 1 + rng.int(2), kind: 'wall' });

  const size = f.tiny ? [1, 1] : null;
  const place = (type, params) => (f.noDock && type === 'process' && chance(rng, 0.5) ? looseStation(layout, rng, type, params) : dockedStation(layout, rng, type, params, size));
  const arrivalMean = f.huge ? rng.pick([0.5, 1]) : rng.pick([40, 90, 150]);
  const sources = Array.from({ length: 1 + rng.int(2) }, () => place('source', {
    interArrival: dist(arrivalMean, 0.2, rng.pick(['normal', 'exp', 'uniform', 'const'])),
    batch: f.huge ? rng.pick([20, 100]) : 1 + rng.int(3),
    outCap: rng.pick([2, 6, 20]),
    startDelay: rng.pick([0, 0, 50]),
  })).filter(Boolean);
  const processes = Array.from({ length: rng.int(4) }, () => place('process', {
    cycle: dist(rng.pick([5, 30, 60, 90]), 0.3, rng.pick(['normal', 'exp', 'uniform', 'const'])),
    machines: 1 + rng.int(3), outPerCycle: rng.pick([1, 1, 1, 2]),
    inCap: rng.pick([2, 4, 8]), outCap: rng.pick([2, 4, 8]),
    mtbf: f.failures && chance(rng, 0.5) ? rng.pick([60, 600]) : 0, mttr: f.failures && chance(rng, 0.5) ? rng.pick([5, 120]) : 0,
  })).filter(Boolean);
  const storages = Array.from({ length: rng.int(3) }, () => place('storage', { capacity: rng.pick([1, 3, 10, 50]), dwell: rng.pick([0, 0, 20]) })).filter(Boolean);
  const sinks = f.noSink ? [] : Array.from({ length: 1 + rng.int(2) }, () => place('sink', {})).filter(Boolean);
  const depot = chance(rng, 0.7) ? place('depot', { slots: rng.pick([1, 2, 6]), chargers: f.batteryNoCharger ? 0 : rng.pick([0, 1, 2, 6]) }) : null;
  if (f.deadEnd) { // a station at the end of the one-way spur
    const spur = Object.keys(layout.roads).map((k) => k.split(',').map(Number)).filter(([cx, cy]) => cy === 5);
    if (spur.length > 0 && layout.roads[`${spur[0][0]},5`]) dockedStation(layout, rng, 'sink', {}, [2, 2]);
  }

  const link = (a, b) => {
    if (a && b && a !== b) {
      addFlow(layout, a.id, b.id, {
        weight: rng.pick([1, 1, 3]), perCycle: f.oversizedBom ? rng.pick([1, 5, 9]) : rng.pick([1, 1, 2]), batchMin: rng.pick([1, 1, 2, f.oversizedBom ? 50 : 1]), batchMax: rng.pick([0, 0, 2]),
        maxWait: rng.pick([0, 0, 40]), priority: 1 + rng.int(3),
      });
    }
  };
  // a backbone source -> storages / workstations -> sink, then extra sources joining the first step and extra sinks fed by the last
  const mids = [...storages, ...processes];
  const backbone = [sources[0], ...mids, sinks[0]];
  for (let i = 0; i + 1 < backbone.length; i++) link(backbone[i], backbone[i + 1]);
  for (const extra of sources.slice(1)) link(extra, backbone[1]);
  for (const extra of sinks.slice(1)) link(backbone[backbone.length - 2], extra);
  if (chance(rng, 0.3) && mids.length > 1) link(mids[0], mids[mids.length - 1]); // a bypass

  const fleetCount = f.emptyFleet && chance(rng, 0.5) ? 0 : 1 + rng.int(3);
  const longest = cellSize * 1.75;
  for (let i = 0; i < fleetCount; i++) {
    const preset = rng.pick(['agv', 'agv', 'forklift', 'tugger', 'custom']);
    const base = { agv: 1.2, forklift: 2.6, tugger: 3.5, custom: 1.6 }[preset];
    addFleet(layout, preset, definedOnly({
      count: f.emptyFleet && chance(rng, 0.3) ? 0 : 1 + rng.int(chance(rng, 0.2) ? 14 : 5),
      capacity: rng.pick([1, 1, 2, 5]),
      speed: f.crawl ? rng.pick([0.1, 0.12, 0.3]) : undefined,
      length: f.longVehicles ? longest : Math.min(base, longest),
      loadTime: rng.pick([undefined, 0, 3, 30]), unloadTime: rng.pick([undefined, 0, 3, 30]),
      home: depot && chance(rng, 0.8) ? depot.id : null,
      idle: rng.pick(['park', 'stay']),
      mtbf: f.failures && chance(rng, 0.5) ? rng.pick([120, 1800]) : 0, mttr: f.failures && chance(rng, 0.5) ? rng.pick([10, 200]) : 0,
      battery: f.batteryNoCharger || chance(rng, 0.2)
        ? { enabled: true, runtimeMin: f.batteryNoCharger ? rng.pick([1, 3, 20]) : rng.pick([20, 120]), chargeTimeMin: rng.pick([1, 10, 60]), lowPct: rng.pick([0, 30, 60]), resumePct: rng.pick([50, 90, 100]) }
        : {},
    }));
  }
  layout.name = `Hostile ${seed} (${style}${Object.keys(f).filter((k) => f[k]).map((k) => `, ${k}`).join('')})`;
  return layout;
}

// ---------------------------------------------------------------------------------------------------------------------
// Engineered plants
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A small plant that deadlocks by itself: a comb of two-way roads with side stubs, a source A feeding a storage B that feeds a
 * workstation C, one AGV and three 1.6 m trucks that stay where their last job ended. Two vehicles meet on the junction cells
 * in front of the storage and the source and wait for each other (all of them well within the cell size: 1.2 and 1.6 m on 2 m
 * cells). With deadlock 'ignore' the jam stands for good (11 of 12 seeds within two hours); with 'resolve' it is relocated away
 * after 20 s and the plant keeps delivering about 110 loads/h.
 * @param {'resolve'|'ignore'} mode
 * @param {object} [settings] more settings
 */
export function jamPlant(mode, settings = {}) {
  return layoutFromAscii([
    '...................',
    '...................',
    '.....+...+...+.....',
    '....B+...+AAA+.....',
    '....B+...+AAA+.....',
    '..+++++++++++++++..',
    '....+...+...+......',
    '.CCC+...+...+......',
    '.CCC+...+...+......',
    '........+...+......',
    '........+..........',
    '........+..........',
  ], {
    settings: { deadlock: mode, warmup: 0, dt: 0.05, ...settings },
    stations: {
      A: { type: 'source', params: { interArrival: { kind: 'const', mean: 40, spread: 0 }, batch: 2, outCap: 20, startDelay: 50 } },
      B: { type: 'storage', params: { capacity: 10, dwell: 0 } },
      C: { type: 'process', params: { cycle: { kind: 'uniform', mean: 30, spread: 0.3 }, inCap: 4, outCap: 8 } },
    },
    flows: [['A', 'B', { batchMin: 2, batchMax: 2, maxWait: 40 }], ['B', 'C']],
    fleets: [
      { count: 1, speed: 1.5, length: 1.2, capacity: 1, idle: 'stay' },
      { count: 3, speed: 2, length: 1.6, capacity: 2, loadTime: 30, idle: 'stay' },
    ],
  });
}

/**
 * Two rings joined by a one-way bridge: the left ring (source A, storage B, optional depot D) is the working area, the right
 * ring can be entered over the bridge but never left again. Nothing is wrong with it for the validator.
 * @param {{ vehicles?: number, depot?: boolean, arrival?: number, settings?: object }} [opts] `depot`: the fleet starts in a depot on the left
 */
export function bridgePlant({ vehicles = 3, depot = false, arrival = 30, settings = {} } = {}) {
  return layoutFromAscii([
    depot ? '...AAA.DD.........' : '...AAA............',
    '.++++++++>++++++++',
    '.+......+.+......+',
    '.+.....B+.+......+',
    '.+.....B+.+......+',
    '.+......+.+......+',
    '.++++++++.++++++++',
  ], {
    settings: { warmup: 0, ...settings },
    stations: {
      A: { type: 'source', params: { interArrival: { kind: 'normal', mean: arrival, spread: 0.1 }, batch: 1, outCap: 6 } },
      B: { type: 'storage', params: { capacity: 5000, dwell: 0 } },
      D: { type: 'depot', params: { slots: 12, chargers: 0 } },
    },
    flows: [['A', 'B']],
    fleets: [{ count: vehicles, speed: 1.5, length: 1.2, capacity: 1, idle: 'stay', loadTime: 10, unloadTime: 10, home: depot ? 'D' : null }],
  });
}

/** The 'Two production lines' example with every vehicle as long as a tugger train (3.5 m on 2 m cells, the limit of the traffic engine). */
export function tuggerTwoLines(deadlock) {
  const layout = EXAMPLES.find((e) => e.id === 'two-lines').build();
  for (const fleet of layout.fleets) updateFleet(layout, fleet.id, { length: FLEET_PRESETS.tugger.length });
  updateSettings(layout, { deadlock, warmup: 0 });
  return layout;
}

/**
 * A big plant made of street blocks: streets every `step` cells, a 2x2 station in every block (source, two workstations, sink,
 * ...), a source -> workstation -> workstation -> sink chain per source, and `fleets` fleets (AGVs and forklifts alternating)
 * of `perFleet` vehicles without depot. At 160 x 160 cells this is the largest plant the editor allows.
 */
export function blockPlant(cols, rows, step, perFleet, fleets) {
  const layout = createLayout({ name: `Block plant ${cols}x${rows}`, cols, rows, cellSize: 2 });
  for (let x = 2; x < cols - 2; x += step) paint(layout, [[x, 2], [x, rows - 3]]);
  for (let y = 2; y < rows - 2; y += step) paint(layout, [[2, y], [cols - 3, y]]);
  const sources = [];
  const processes = [];
  const sinks = [];
  let i = 0;
  for (let by = 3; by + 2 < rows - 3 && i < 300; by += step) {
    for (let bx = 3; bx + 2 < cols - 3; bx += step) {
      const type = ['source', 'process', 'process', 'sink'][i % 4];
      const params = type === 'source' ? { interArrival: dist(15, 0.1) } : type === 'process' ? { cycle: dist(40, 0.1), machines: 2 } : {};
      const station = addStation(layout, { type, x: bx, y: by, w: 2, h: 2, params });
      if (station) (type === 'source' ? sources : type === 'sink' ? sinks : processes).push(station);
      i++;
    }
  }
  sources.forEach((source, j) => {
    const first = processes[(j * 2) % processes.length];
    const second = processes[(j * 2 + 1) % processes.length];
    const sink = sinks[j % sinks.length];
    if (first) addFlow(layout, source.id, first.id, {});
    if (first && second && first !== second) addFlow(layout, first.id, second.id, {});
    if (second && sink) addFlow(layout, second.id, sink.id, {});
  });
  for (let f = 0; f < fleets; f++) addFleet(layout, ['agv', 'forklift'][f % 2], { count: perFleet, home: null });
  return layout;
}

/**
 * A straight two-way road of `cells` cells without stations or vehicles, for tests that drive traffic vehicles by hand.
 * @param {number} cells
 */
export function emptyRoad(cells = 16) {
  return layoutFromAscii(['+'.repeat(cells), '.'.repeat(cells)], { settings: { warmup: 0 }, fleets: [{ count: 0 }] });
}

// ---------------------------------------------------------------------------------------------------------------------
// Edits by name (so that a recipe can cross a thread boundary) and example variants
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Apply a list of edits through the model API: { fleet: name, patch }, { station: name, patch }, { settings: patch },
 * { road: { cells, oneWay } }. Returns the layout.
 */
export function applyEdits(layout, edits = []) {
  for (const edit of edits) {
    if (edit.fleet) {
      const fleet = layout.fleets.find((f) => f.name === edit.fleet);
      assert.ok(updateFleet(layout, fleet.id, edit.patch), `edit fleet ${edit.fleet}`);
    } else if (edit.station) {
      const station = layout.stations.find((s) => s.name === edit.station);
      assert.ok(updateStation(layout, station.id, edit.patch), `edit station ${edit.station}`);
    } else if (edit.settings) {
      updateSettings(layout, edit.settings);
    } else if (edit.road) {
      paintRoadPath(layout, edit.road.cells, { oneWay: edit.road.oneWay === true });
    }
  }
  return layout;
}

/** A fresh example plant with edits applied. */
export const exampleVariant = (id, edits = []) => applyEdits(EXAMPLES.find((e) => e.id === id).build(), edits);

// ---------------------------------------------------------------------------------------------------------------------
// Hand checks of a long run of an example (the numbers a planner would check on a napkin)
// ---------------------------------------------------------------------------------------------------------------------

const unitsNear = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1e-9, Math.abs(b));

/** Shortest cycle a workstation can ever sample (s), `mean` for the average. */
function cycleBounds(station, processFactor) {
  const { kind, mean, spread } = station.params.cycle;
  const floor = { const: mean, uniform: mean * (1 - spread), normal: 0.1 * mean, exp: 0 }[kind] ?? 0;
  return { floor: floor * processFactor, mean: mean * processFactor };
}

/**
 * Fastest conceivable end-to-end time of a load (s): the cheapest chain of flows from a source to a sink, each hand-over taking
 * at least the shortest load + unload time of a fleet that may serve the flow, each workstation at its shortest possible cycle
 * (`floor`) or at its mean cycle (`mean`), each storage at its dwell time.
 * @returns {{ floor: number, mean: number }}
 */
export function leadTimeBounds(layout) {
  const fleetsFor = (flow) => layout.fleets.filter((f) => f.count > 0 && (flow.fleetId === null || flow.fleetId === f.id));
  const handling = (flow) => Math.min(Infinity, ...fleetsFor(flow).map((f) => f.loadTime + f.unloadTime));
  const stage = (station, which) => {
    if (station.type === 'process') return cycleBounds(station, layout.settings.processFactor)[which];
    return station.type === 'storage' ? station.params.dwell : 0;
  };
  const result = {};
  for (const which of ['floor', 'mean']) {
    const best = new Map(layout.stations.filter((s) => s.type === 'source').map((s) => [s.id, 0]));
    for (let round = 0; round < layout.stations.length; round++) {
      for (const flow of layout.flows) {
        if (!best.has(flow.from)) continue;
        const to = layout.stations.find((s) => s.id === flow.to);
        const cost = best.get(flow.from) + handling(flow) + stage(to, which);
        if (!(best.get(flow.to) <= cost)) best.set(flow.to, cost);
      }
    }
    result[which] = Math.min(Infinity, ...layout.stations.filter((s) => s.type === 'sink' && best.has(s.id)).map((s) => best.get(s.id)));
  }
  return result;
}

/**
 * Simulate an example for `hours` (warm-up 600 s) and check everything a planner could verify by hand against the layout.
 * @returns {{ problems: string[], facts: object }} `problems` is empty when the run is plausible
 */
export function handCheck(id, seed, hours) {
  const layout = EXAMPLES.find((e) => e.id === id).build();
  layout.settings.warmup = 600;
  const sim = new Simulation(layout, { seed });
  const problems = [];
  const check = (condition, message) => { if (!condition) problems.push(`${id}/${seed}: ${message}`); };
  sim.advance(layout.settings.warmup);
  const sources = sim.stations.filter((s) => s.type === 'source');
  const producedAtStart = new Map(sources.map((s) => [s.id, s.produced]));
  const wipAtStart = sim.logistics.liveLoads;
  const odometerAtStart = sim.vehicles.map((v) => v.tv.odometer);
  sim.advance(hours * 3600 - sim.time);
  const report = sim.kpis();
  const dur = report.window.duration;
  check(Math.abs(dur - (sim.time - layout.settings.warmup)) < 1, `window ${dur} s but the measured time is ${sim.time - layout.settings.warmup} s`);

  // throughput can never exceed the supply of the window plus what was in the plant when it started
  const supply = sources.reduce((sum, s) => sum + s.produced - producedAtStart.get(s.id), 0);
  check(report.throughput.total <= supply + wipAtStart, `throughput ${report.throughput.total} loads exceeds supply ${supply} + initial WIP ${wipAtStart}`);
  check(Math.abs(report.throughput.perHour - (report.throughput.total * 3600) / dur) < 1e-9, 'perHour is not total / window');
  check(report.leadTime.count === report.throughput.total, `${report.leadTime.count} lead times for ${report.throughput.total} loads`);
  const bySink = Object.values(report.throughput.bySink);
  check(bySink.reduce((sum, b) => sum + b.count, 0) === report.throughput.total, 'the sinks do not add up to the throughput');
  check(bySink.every((b) => unitsNear(b.perHour, (b.count * 3600) / dur, 1e-9)), 'a sink\'s loads/h is not count / window');

  // no workstation can produce more than its machines allow, and its busy time explains its output
  for (const st of sim.stations.filter((s) => s.type === 'process')) {
    const s = report.stations[st.id];
    const { floor, mean } = cycleBounds(st.def, layout.settings.processFactor);
    const p = st.params;
    check(s.produced <= p.machines * (dur / Math.max(floor, 0.01) + 1) * p.outPerCycle, `${st.id} produced ${s.produced}, more than its machines can`);
    check(s.produced <= (p.machines * p.outPerCycle * dur * 1.05) / mean + p.machines * p.outPerCycle, `${st.id} produced ${s.produced} at an average cycle of ${mean} s`);
    const cycles = s.produced / p.outPerCycle;
    const explained = (s.utilization * p.machines * dur) / mean;
    check(Math.abs(cycles - explained) <= Math.max(5, 0.2 * explained), `${st.id}: ${cycles} cycles but busy time explains ${explained.toFixed(1)}`);
  }

  // lead time is at least the time the work takes
  const bounds = leadTimeBounds(layout);
  check(report.leadTime.min >= bounds.floor - 1e-6, `shortest lead time ${report.leadTime.min} s is below the physical floor ${bounds.floor} s`);
  check(report.leadTime.mean >= 0.97 * bounds.mean, `mean lead time ${report.leadTime.mean} s is below the mean path time ${bounds.mean} s`);

  // fleets: distance, speed, handling time, trips and loads hang together
  let flowTrips = 0;
  let fleetTrips = 0;
  for (const fleet of layout.fleets) {
    const f = report.fleets[fleet.id];
    fleetTrips += f.trips;
    check(f.count === fleet.count, `fleet ${fleet.id} reports ${f.count} of ${fleet.count} vehicles`);
    check(f.distance <= f.count * fleet.speed * dur + 1, `fleet ${fleet.id} drove ${f.distance.toFixed(0)} m, more than ${f.count} vehicles at ${fleet.speed} m/s can in ${dur} s`);
    const moving = (f.shares.driving + f.shares.waiting) * f.count * dur;
    check(f.distance <= fleet.speed * moving + 1, `fleet ${fleet.id}: ${f.distance.toFixed(0)} m in ${moving.toFixed(0)} vehicle-seconds of driving exceeds ${fleet.speed} m/s`);
    check(f.trips * (fleet.loadTime + fleet.unloadTime) <= f.count * dur + 1, `fleet ${fleet.id}: ${f.trips} trips need more hand-over time than exists`);
    check(f.trips * fleet.loadTime <= f.shares.loading * f.count * dur + f.count * fleet.loadTime + 1, `fleet ${fleet.id}: loading share too small for ${f.trips} trips`);
    check(f.utilization >= 0 && f.utilization <= 1, `fleet ${fleet.id} utilization ${f.utilization}`);
  }
  const mostCarried = Math.max(...layout.fleets.map((f) => f.capacity));
  let delivered = 0;
  for (const flow of Object.values(report.flows)) {
    flowTrips += flow.trips;
    delivered += flow.delivered;
    check(flow.delivered >= flow.trips && flow.delivered <= flow.trips * mostCarried, `flow ${flow.from}->${flow.to}: ${flow.delivered} loads in ${flow.trips} trips`);
  }
  check(flowTrips === fleetTrips && flowTrips === report.orders.completed, `trips: flows ${flowTrips}, fleets ${fleetTrips}, orders ${report.orders.completed}`);
  check(delivered >= report.throughput.total || flowTrips === 0, `${delivered} loads delivered but ${report.throughput.total} left the plant`);

  // the odometer, which nobody can argue with
  const driven = sim.vehicles.reduce((sum, v, i) => sum + v.tv.odometer - odometerAtStart[i], 0);
  check(driven <= layout.fleets.reduce((sum, f) => sum + f.count * f.speed, 0) * dur + 1, `odometer ${driven.toFixed(0)} m is more than the fleets can drive`);

  const auditor = createAuditor(sim);
  for (const message of auditor.report(report)) problems.push(`${id}/${seed}: ${message}`);
  return {
    problems,
    facts: {
      id, seed, perHour: report.throughput.perHour, supplyPerHour: (supply * 3600) / dur, leadMin: report.leadTime.min, leadMean: report.leadTime.mean,
      leadFloor: bounds.floor, fleetUtilization: Object.values(report.fleets).map((f) => f.utilization), driven,
      reported: Object.values(report.fleets).reduce((sum, f) => sum + f.distance, 0),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Jobs for the worker pool (plain data in, plain data out)
// ---------------------------------------------------------------------------------------------------------------------

/** Run a plant tick by tick with the auditor and return what went wrong (first few messages) plus a few facts. */
function audited(layout, seconds, { seed, perTick, mutate } = {}) {
  const sim = new Simulation(layout, seed === undefined ? {} : { seed });
  const auditor = createAuditor(sim);
  const violations = new Set();
  const steps = Math.round(seconds / sim.dt);
  const reportEvery = Math.max(1, Math.round(30 / sim.dt));
  for (let i = 1; i <= steps; i++) {
    if (mutate) mutate(sim, i);
    sim.step();
    for (const message of auditor.tick()) violations.add(message);
    if (perTick) perTick(sim, i, auditor);
    if (i % reportEvery === 0) for (const message of auditor.report()) violations.add(`report: ${message}`);
    if (violations.size >= 5) break;
  }
  return { sim, auditor, violations: [...violations].slice(0, 5) };
}

/** Job 'fuzz': one hostile plant, `seconds` of simulated time, every invariant after every tick. */
function fuzzJob({ seed, seconds }) {
  const layout = hostilePlant(seed);
  const { sim, violations } = audited(layout, seconds);
  return { seed, name: layout.name, violations, completed: sim.logistics.completed, vehicles: sim.vehicles.length, time: sim.time };
}

/** Job 'scaled': an example with its fleets and its demand scaled, audited, with the stuck-vehicle watchdog. */
function scaledJob({ id, fleetFactor, demand, seconds, seed }) {
  const layout = EXAMPLES.find((e) => e.id === id).build();
  for (const fleet of layout.fleets) updateFleet(layout, fleet.id, { count: Math.max(1, Math.round(fleet.count * fleetFactor)) });
  updateSettings(layout, { demandFactor: demand, warmup: 0 });
  const stuck = [];
  const { sim, auditor, violations } = audited(layout, seconds, {
    seed,
    perTick: (s, i, auditor) => { if (i % 300 === 0) for (const m of auditor.stuck({ vehicleSeconds: 600 })) stuck.push(m); },
  });
  return { id, fleetFactor, demand, violations, stuck: stuck.slice(0, 3), completed: sim.logistics.completed, vehicles: sim.vehicles.length, deadlocks: sim.traffic.stats.deadlocks };
}

/** Length of the calm period at the end of an example's runtime fuzz (s). */
const RECOVERY_SECONDS = 1200;
/** Speed factors the runtime fuzz draws from. */
const SPEED_STEPS = [0.05, 0.05, 0.1, 0.5, 1, 5, 20, 20];

/**
 * Job 'runtime': change the what-if settings every 5 to 30 s of simulated time while the auditor watches. `mode` 'speed': only the
 * vehicle speed (0.05 .. 20); 'all': every runtime key. An example gets a calm start (600 s), a stormy middle and a calm end (1200 s
 * with everything back at 1); the result tells how much it delivered in the calm end compared with the same minutes of an
 * undisturbed run of the same seed.
 */
function runtimeJob({ example, seed, seconds, mode, rngSeed }) {
  const layout = example ? EXAMPLES.find((e) => e.id === example).build() : hostilePlant(seed);
  const rng = createRng(rngSeed);
  const calmStart = example ? 600 : 0;
  const stormEnd = example ? seconds - RECOVERY_SECONDS : seconds;
  let nextChange = calmStart + 10;
  let completedAtStormEnd = null;
  const mutate = (sim) => {
    if (sim.time >= stormEnd) {
      if (completedAtStormEnd === null) {
        sim.setRuntime({ speedFactor: 1, demandFactor: 1, processFactor: 1 });
        completedAtStormEnd = sim.logistics.completed;
      }
      return;
    }
    if (sim.time < nextChange) return;
    nextChange = sim.time + 5 + rng.next() * 25;
    if (mode === 'speed') sim.setRuntime({ speedFactor: rng.pick(SPEED_STEPS) });
    else {
      sim.setRuntime({
        speedFactor: rng.pick(SPEED_STEPS), demandFactor: rng.pick([0.05, 0.5, 1, 4, 20]), processFactor: rng.pick([0.05, 0.5, 1, 4, 20]),
        dispatch: rng.pick(['nearest', 'oldest', 'balanced']), routing: rng.pick(['shortest', 'congestion']),
      });
    }
  };
  const stuck = [];
  const watch = (s, i, auditor) => {
    if (!example || i % Math.max(1, Math.round(30 / s.dt)) !== 0) return;
    const found = auditor.stuck({ vehicleSeconds: 300 });
    if (s.time >= stormEnd + 400) stuck.push(...found); // five minutes after everything is back to normal nobody may stand still
  };
  const { sim, violations } = audited(layout, seconds, { seed: example ? seed : undefined, mutate, perTick: watch });
  const result = { example, seed, mode, violations, time: sim.time, speedFactor: sim.settings.speedFactor, stuck: stuck.slice(0, 3), deliveredAfterStorm: null, controlDelivered: null };
  if (example) {
    result.deliveredAfterStorm = sim.logistics.completed - completedAtStormEnd;
    const control = new Simulation(EXAMPLES.find((e) => e.id === example).build(), { seed });
    control.advance(stormEnd);
    const before = control.logistics.completed;
    control.advance(RECOVERY_SECONDS);
    result.controlDelivered = control.logistics.completed - before;
  }
  return result;
}

/** Job 'tips': mean figures of a variant of an example over `seeds` runs of `hours` hours (default warm-up). */
function tipJob({ id, edits, seeds, hours, fleet, station }) {
  const layout = exampleVariant(id, edits);
  const fleetId = fleet ? layout.fleets.find((f) => f.name === fleet).id : null;
  const stationId = station ? layout.stations.find((s) => s.name === station).id : null;
  const sums = { throughput: 0, lead: 0, wip: 0, fleetUtilization: 0, charging: 0, pickupWait: 0, stationUtilization: 0, yardMax: 0, waitShare: 0 };
  for (let seed = 1; seed <= seeds; seed++) {
    const sim = new Simulation(layout, { seed });
    sim.advance(hours * 3600);
    const k = sim.kpis();
    sums.throughput += k.throughput.perHour;
    sums.lead += k.leadTime.mean ?? 0;
    sums.wip += k.wip.mean;
    sums.pickupWait += k.orders.avgPickupWait ?? 0;
    sums.waitShare += k.traffic.waitShare;
    if (fleetId) { sums.fleetUtilization += k.fleets[fleetId].utilization; sums.charging += k.fleets[fleetId].shares.charging; }
    if (stationId) sums.stationUtilization += k.stations[stationId].utilization;
    sums.yardMax += Math.max(0, ...Object.values(k.stations).filter((s) => s.type === 'source').map((s) => s.yardMax));
  }
  return Object.fromEntries(Object.entries(sums).map(([key, sum]) => [key, sum / seeds]));
}

/** Job 'dt': KPIs of an example at a given time step. */
function dtJob({ id, dt, seed, hours }) {
  const layout = EXAMPLES.find((e) => e.id === id).build();
  layout.settings.dt = dt;
  layout.settings.warmup = 600;
  const sim = new Simulation(layout, { seed });
  sim.advance(hours * 3600);
  const k = sim.kpis();
  const fleets = Object.values(k.fleets);
  return {
    throughput: k.throughput.perHour, lead: k.leadTime.mean, waitShare: k.traffic.waitShare,
    utilization: fleets.reduce((sum, f) => sum + f.utilization * f.count, 0) / fleets.reduce((sum, f) => sum + f.count, 0),
  };
}

const JOBS = { handCheck: ({ id, seed, hours }) => handCheck(id, seed, hours), fuzz: fuzzJob, scaled: scaledJob, runtime: runtimeJob, tips: tipJob, dt: dtJob };

if (!isMainThread && workerData && workerData.engineReviewWorker === true) {
  parentPort.on('message', (msg) => {
    try {
      parentPort.postMessage({ id: msg.id, result: JOBS[msg.job](msg.args) });
    } catch (error) {
      parentPort.postMessage({ id: msg.id, error: String((error && error.stack) || error) });
    }
  });
}

/**
 * Run `job` once per entry of `argsList` on a small pool of worker threads (this file is the worker script). Results come back
 * in the order of `argsList`; a throwing job rejects the promise with its stack.
 * @param {'handCheck'|'fuzz'|'scaled'|'runtime'|'tips'|'dt'} job
 * @param {object[]} argsList
 * @returns {Promise<object[]>}
 */
export async function runParallel(job, argsList) {
  const results = new Array(argsList.length);
  let next = 0;
  const size = Math.max(1, Math.min(4, availableParallelism(), argsList.length));
  const pool = Array.from({ length: size }, () => new Worker(new URL(import.meta.url), { workerData: { engineReviewWorker: true } }));
  try {
    await Promise.all(pool.map((worker) => new Promise((resolve, reject) => {
      worker.on('error', reject);
      const feed = () => {
        if (next >= argsList.length) { resolve(); return; }
        const id = next++;
        worker.once('message', (msg) => {
          if (msg.error) reject(new Error(msg.error));
          else { results[msg.id] = msg.result; feed(); }
        });
        worker.postMessage({ id, job, args: argsList[id] });
      };
      feed();
    })));
  } finally {
    await Promise.all(pool.map((worker) => worker.terminate()));
  }
  return results;
}
