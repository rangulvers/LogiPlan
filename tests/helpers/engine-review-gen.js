// Test helper of the adversarial review of the integrated simulation (tests/sim.engine.review.test.js).
//
// Written independently of tests/helpers/sim-invariants.js, traffic-invariants.js and logistics-invariants.js: it reads only the
// PUBLIC surface of a Simulation (sim.time, sim.vehicles, sim.stations, sim.flows, sim.traffic.vehicles, sim.graph and the
// event bus), never an underscore field, and re-derives every figure it checks by walking the data itself.
//
//   hostilePlant(seed)        a complete layout made through the layout.js mutators, deliberately nasty: one-way dead ends,
//                             stations without a dock, flows between road islands, 1x1 stations, empty fleets, batteries
//                             without charger, crawling vehicles, huge batches, dense street grids ...
//   createAuditor(sim)        audit.tick() after every step: time, poses on the road, no overlapping bodies, speed limit, load
//                             conservation (created = live + completed + consumed, found by walking every container), queue and
//                             depot capacities, order bookkeeping; audit.report() for the KPI report; audit.stuck() for a
//                             watchdog on vehicles and on the plant as a whole. Each returns a list of violation strings.
//   fingerprint(sim)          a digest of the complete state, to compare runs bit for bit
//   cellOf, bodiesOverlap     geometry helpers
//
// Why own helpers: a reviewer that reuses the checker of the builder inherits its blind spots.

import { createRng } from '../../js/util/rng.js';
import { lPath } from '../../js/util/grid.js';
import {
  addFleet, addFlow, addObstacle, addStation, createLayout, paintRoadPath, updateSettings,
} from '../../js/model/layout.js';

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
 * @param {{ shrink?: number, penetration?: number, speedSlack?: number }} [opts]
 *   `shrink`/`penetration`: bodies shrunk to this share of their size may not penetrate deeper than `penetration` metres
 */
export function createAuditor(sim, { shrink = 0.8, penetration = 0.02 } = {}) {
  const ev = { created: 0, completed: 0, assigned: 0, delivered: 0, cancelled: 0, deadlock: 0, loadIds: new Set(), dupCreate: 0 };
  sim.on('loadCreated', (p) => { ev.created++; if (ev.loadIds.has(p.load.id)) ev.dupCreate++; ev.loadIds.add(p.load.id); });
  sim.on('loadCompleted', () => { ev.completed++; });
  sim.on('orderAssigned', () => { ev.assigned++; });
  sim.on('orderDelivered', () => { ev.delivered++; });
  sim.on('orderCancelled', () => { ev.cancelled++; });
  sim.on('deadlock', () => { ev.deadlock++; });
  const g = sim.graph;
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
            const depth = bodyPenetration(tv, other, shrink);
            if (depth > penetration) out.push(`${tv.id} and ${other.id} overlap by ${depth.toFixed(3)} m at (${tv.x.toFixed(2)}, ${tv.y.toFixed(2)})`);
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
    const roadDist = sim.vehicles.reduce((a, v) => a + v.loadedDistance + v.emptyDistance + v.parkDistance, 0);
    const odometer = sim.vehicles.reduce((a, v) => a + v.tv.odometer, 0);
    if (Math.abs(roadDist - odometer) > 1 + sim.vehicles.length * sim.settings.speedFactor * 20 * sim.dt * 2) {
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
