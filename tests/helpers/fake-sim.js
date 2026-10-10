// Test helper: a scriptable fake of the Simulation object that Stats (js/sim/stats.js) reads.
//
// It exposes exactly the runtime fields documented in docs/ARCHITECTURE.md 5.2-5.5, but nothing moves by
// itself: a test sets the state it wants, lets time pass and computes the expected KPIs by hand.
//
//   const sim = createFakeSim(standardPlant({ fleets: [{ count: 2 }] }));   // dt = 1 s, time = 0
//   const stats = (sim.stats = new Stats(sim));      // optional: the fake then drives the stats object for you
//   sim.setMachines('B', ['busy', 'idle']);          // script state ...
//   sim.advance(60);                                 // ... and let 60 s pass
//   sim.complete('D', 420);                          // a load with lead time 420 s leaves through sink D
//   stats.report();
//
// Per tick (advance): the optional `onTick(sim, tickIndex)` callback runs first (use it to change state over
// time), then `sim.time += dt`, then `sim.stats.sample(dt)` - the same order the real engine uses
// (logistics, traffic, clock, stats). Events are forwarded to `sim.stats.onEvent` when stats are attached.
//
// Things to know when scripting state (they are easy to trip over):
//   * complete() lowers logistics.liveLoads like the real sink does (never below 0): call setLive() after it when
//     a scenario keeps a fixed number of loads in the plant.
//   * A workstation's aggregate `state` follows setMachines(); assigning machine states by hand leaves it as it was
//     ('starved' at the start, 'down' for a workstation without machines). Stats reads the machine states, not the aggregate.
//   * addReadyLoads() creates loads that nobody has claimed; pass { claimed: true } for loads a vehicle is already
//     on its way to (those do not count as backlog).
//   * `unplaced` (ids of vehicles that found no room on the road) starts empty; set sim.logistics.unplaced.
//
// Shape, by field name:
//   sim.layout, sim.settings, sim.time, sim.dt
//   sim.graph      { cols, rows, cellSize, nodeCount, edges: [{ id }] }  + cx(id) cy(id) x(id) y(id)
//   sim.traffic    { vehicles: [], stats: { edgePasses: Int32Array, edgeWait, nodeWait: Float64Array,
//                    waitVehicle, waitJunction, waitBroken, deadlocks, totalWait, drivingTime } }
//   sim.logistics  { stations: StationRT[], stationById, vehicles: VehicleRT[], flows, liveLoads, completed, unplaced: [] }
//   sim.stations / sim.vehicles are aliases of logistics.stations / logistics.vehicles.
// StationRT carries the fields of 5.3 (state, fill, inCount, outCount, produced, consumed, arrivals, inQ, outQ,
// inbound; yard for sources; machines[] for processes; parked/charging/slots/chargers for depots).
// VehicleRT carries id ("<fleetId>#<n>"), fleetId, fleet, state, battery, tv { waiting, waitReason, ... },
// trips, loadedDistance, emptyDistance.

import { layoutFromAscii } from './ascii.js';
import { defaultFleet, defaultStation, defaultFlow, emptyLayout } from '../../js/model/defaults.js';
import { buildGraph } from '../../js/sim/graph.js';
import { Detail } from '../../js/sim/detail.js';

/**
 * The reference plant used by the stats and insights tests (ASCII-built, so no model API needed):
 * source A "Goods in" -> storage S "Supermarket" -> process B "Press" -> process C "Final assembly" -> sink D
 * "Shipping", plus depot E "Charging bay" (flows f1..f4 in that order; nothing flows to the depot).
 * Default fleets: v1 = 3 AGVs, v2 = 2 forklifts.
 * @param {{ fleets?: object[], settings?: object, params?: Record<string, object> }} [opts]
 *   `params` merges station params by station id, e.g. `{ B: { machines: 2 } }`
 */
export function standardPlant({ fleets, settings, params = {} } = {}) {
  const layout = layoutFromAscii(['AA.SS.BB.CC.DD.EE', '+++++++++++++++++'], {
    name: 'Standard plant',
    settings,
    stations: {
      A: { type: 'source', name: 'Goods in' },
      S: { type: 'storage', name: 'Supermarket', params: { capacity: 20 } },
      B: { type: 'process', name: 'Press' },
      C: { type: 'process', name: 'Final assembly' },
      D: { type: 'sink', name: 'Shipping' },
      E: { type: 'depot', name: 'Charging bay', params: { slots: 4, chargers: 1 } },
    },
    flows: [['A', 'S'], ['S', 'B'], ['B', 'C'], ['C', 'D']],
    fleets: fleets || [{ count: 3 }, { count: 2, preset: 'forklift' }],
  });
  for (const [id, patch] of Object.entries(params)) Object.assign(layout.stations.find((s) => s.id === id).params, patch);
  return layout;
}

/**
 * A big layout for performance tests: one source, a chain of processes and storages, one sink, and
 * `vehicles` vehicles split over two fleets. Geometry is irrelevant (no roads); only the counts matter.
 * @param {{ stations?: number, vehicles?: number }} [opts]
 */
export function syntheticLayout({ stations = 100, vehicles = 200 } = {}) {
  const layout = emptyLayout({ grid: { cols: 160, rows: 160, cellSize: 2 } });
  for (let i = 0; i < stations; i++) {
    const type = i === 0 ? 'source' : i === stations - 1 ? 'sink' : i % 5 === 0 ? 'storage' : 'process';
    layout.stations.push(defaultStation(type, { id: 's' + i, name: 'Station ' + i, x: (i % 40) * 4, y: Math.floor(i / 40) * 4, params: type === 'process' ? { machines: 2 } : {} }));
    if (i > 0) layout.flows.push(defaultFlow({ id: 'f' + i, from: 's' + (i - 1), to: 's' + i }));
  }
  const half = Math.floor(vehicles / 2);
  layout.fleets.push(defaultFleet('agv', { id: 'v1', count: half }), defaultFleet('forklift', { id: 'v2', count: vehicles - half, battery: { enabled: true } }));
  return layout;
}

const popcount = (n) => { let c = 0; for (let m = n; m; m >>= 1) c += m & 1; return c; };

function stationRT(def, layout) {
  const rt = {
    id: def.id, type: def.type, def, state: 'normal', fill: 0, fillLabel: '0', inCount: 0, outCount: 0,
    produced: 0, consumed: 0, arrivals: 0, inQ: new Map(), outQ: new Map(), inbound: new Map(),
  };
  for (const f of layout.flows) {
    if (f.to === def.id) rt.inQ.set(f.id, []);
    if (f.from === def.id) rt.outQ.set(f.id, []);
  }
  if (def.type === 'source') rt.yard = 0;
  if (def.type === 'process') {
    rt.machines = Array.from({ length: def.params.machines }, () => ({ state: 'idle', remaining: 0, cycleTime: 0, progress: 0, holding: [] }));
    rt.state = aggregateState(rt.machines); // 'starved', or 'down' for a workstation without machines
  }
  if (def.type === 'depot') Object.assign(rt, { parked: [], charging: [], slots: def.params.slots, chargers: def.params.chargers });
  return rt;
}

function vehicleRT(fleet, n) {
  return {
    id: `${fleet.id}#${n}`, fleetId: fleet.id, fleet, name: `${fleet.name} ${n}`, color: fleet.color,
    state: 'idle', order: null, load: [], battery: 1, visible: true, stateSince: 0, timeIn: {},
    tv: { waiting: false, waitReason: null, driving: false, disabled: false },
    trips: 0, loadedDistance: 0, emptyDistance: 0,
  };
}

/** Aggregate machine state of a workstation as defined in 5.3. */
function aggregateState(machines) {
  const has = (s) => machines.some((m) => m.state === s);
  if (machines.every((m) => m.state === 'down')) return 'down';
  if (has('busy')) return 'busy';
  return has('blocked') ? 'blocked' : 'starved';
}

/**
 * Build the fake simulation for a layout.
 * @param {object} layout a complete layout (e.g. from standardPlant or layoutFromAscii)
 * @param {{ dt?: number }} [opts] `dt` is the tick length used by advance() (default 1 s; use binary-exact
 *   values such as 1, 0.5 or 0.25 when a test asserts exact floating-point sums)
 */
export function createFakeSim(layout, { dt = 1 } = {}) {
  const { cols, rows, cellSize } = layout.grid;
  const edgeCount = Object.values(layout.roads).reduce((n, cell) => n + popcount(cell.out), 0);
  const traffic = {
    vehicles: [],
    stats: {
      edgePasses: new Int32Array(edgeCount), edgeWait: new Float64Array(edgeCount), nodeWait: new Float64Array(cols * rows),
      waitVehicle: 0, waitJunction: 0, waitBroken: 0, deadlocks: 0, totalWait: 0, drivingTime: 0,
    },
  };
  const stations = layout.stations.map((def) => stationRT(def, layout));
  const vehicles = layout.fleets.flatMap((fleet) => Array.from({ length: fleet.count }, (_, i) => vehicleRT(fleet, i + 1)));
  const logistics = {
    stations, stationById: new Map(stations.map((s) => [s.id, s])), vehicles,
    flows: layout.flows.map((def) => ({ id: def.id, def })), liveLoads: 0, completed: 0, unplaced: [],
  };

  const sim = {
    layout, settings: layout.settings, time: 0, dt, stats: null, traffic, logistics, stations, vehicles,
    graph: {
      cols, rows, cellSize, nodeCount: cols * rows, edges: Array.from({ length: edgeCount }, (_, id) => ({ id })),
      cx: (id) => id % cols, cy: (id) => Math.floor(id / cols),
      x: (id) => ((id % cols) + 0.5) * cellSize, y: (id) => (Math.floor(id / cols) + 0.5) * cellSize,
    },

    /** Forward an engine event to the attached stats object (no-op without one). */
    emit(name, payload) {
      if (sim.stats) sim.stats.onEvent(name, payload);
    },

    /** Let `seconds` pass in ticks of `dt`; `onTick(sim, i)` may script state changes before each tick. */
    advance(seconds, onTick) {
      const ticks = Math.round(seconds / sim.dt);
      for (let i = 0; i < ticks; i++) {
        if (onTick) onTick(sim, i);
        sim.time += sim.dt;
        if (sim.stats) sim.stats.sample(sim.dt);
      }
    },

    /** StationRT by id. */
    st: (id) => logistics.stationById.get(id),
    /** VehicleRT by id ("v1#2"). */
    veh: (id) => vehicles.find((v) => v.id === id),

    /** Set the number of live loads (WIP). */
    setLive(n) {
      logistics.liveLoads = n;
    },

    /** Set machine states of a workstation, e.g. setMachines('B', ['busy', 'down']); the aggregate state follows. */
    setMachines(id, states) {
      const st = sim.st(id);
      st.machines.forEach((m, i) => { m.state = states[i]; });
      st.state = aggregateState(st.machines);
    },

    /**
     * Put loads into the output queue of `flowId` at its origin station (for backlog tests). `claimed` loads already
     * have a vehicle on the way; `readyAt` in the future models a load still in dwell.
     */
    addReadyLoads(flowId, n, { readyAt = sim.time, claimed = false } = {}) {
      const flow = layout.flows.find((f) => f.id === flowId);
      const queue = sim.st(flow.from).outQ.get(flowId);
      for (let i = 0; i < n; i++) queue.push({ id: `L${flowId}-${queue.length}`, createdAt: 0, origin: flow.from, readyAt, claimed });
    },

    /** Empty the output queue of `flowId` (its loads were taken away). */
    clearReadyLoads(flowId) {
      const flow = layout.flows.find((f) => f.id === flowId);
      sim.st(flow.from).outQ.get(flowId).length = 0;
    },

    /** A load with the given lead time leaves the system at a sink: bookkeeping plus a loadCompleted event. */
    complete(stationId, leadTime, { count = 1 } = {}) {
      for (let i = 0; i < count; i++) {
        logistics.completed++;
        logistics.liveLoads = Math.max(0, logistics.liveLoads - 1);
        sim.st(stationId).consumed++;
        sim.emit('loadCompleted', { load: { id: 'L', createdAt: sim.time - leadTime, origin: 'A', readyAt: 0, claimed: true }, station: sim.st(stationId), leadTime, t: sim.time });
      }
    },

    /** A transport order finishes: bumps the vehicle's trip counter and emits orderDelivered. */
    deliver(vehicleId, flowId, { qty = 1, waitForPickup = 0, transit = 0 } = {}) {
      const flow = layout.flows.find((f) => f.id === flowId);
      sim.veh(vehicleId).trips++;
      const order = { id: 'o', flowId, from: flow.from, to: flow.to, qty, vehicleId, loads: [], createdAt: 0, readySince: 0, pickedAt: waitForPickup, deliveredAt: waitForPickup + transit };
      sim.emit('orderDelivered', { order, waitForPickup, transit });
    },

    /** Add driven distance to a vehicle's odometer counters. */
    drive(vehicleId, metres, { loaded = false } = {}) {
      sim.veh(vehicleId)[loaded ? 'loadedDistance' : 'emptyDistance'] += metres;
    },

    /**
     * Add cumulative waiting (veh*s) to the traffic statistics, optionally attributed to a node and/or edge.
     * `driving` is the veh*s of driving time to add (it already contains the waiting, as in the real traffic module).
     */
    addWait({ vehicle = 0, junction = 0, broken = 0, driving = 0, node = -1, edge = -1 } = {}) {
      const s = traffic.stats;
      s.waitVehicle += vehicle;
      s.waitJunction += junction;
      s.waitBroken += broken;
      s.totalWait += vehicle + junction + broken;
      s.drivingTime += driving;
      if (node >= 0) s.nodeWait[node] += vehicle + junction + broken;
      if (edge >= 0) s.edgeWait[edge] += vehicle + junction + broken;
    },

    /** Count `n` vehicles passing an edge. */
    pass(edge, n = 1) {
      traffic.stats.edgePasses[edge] += n;
    },

    /** A deadlock is detected: bumps the traffic counter and emits the 'deadlock' event. */
    deadlock({ nodes = [], vehicles: ids = [], resolved = true } = {}) {
      traffic.stats.deadlocks++;
      sim.emit('deadlock', { t: sim.time, nodes, vehicles: ids.map((id) => sim.veh(id) || id), resolved, victim: null });
    },
  };
  return sim;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The detail collector (js/sim/detail.js) on a fake simulation, and a fake collector that answers from a fixture
// ---------------------------------------------------------------------------------------------------------------------------------------------
//
//   createFakeDetailSim(layout, { dt })   a createFakeSim with the extra surface the collector reads: the REAL road graph (edges with a direction, stationsAt), scriptable
//                                         vehicles (state, stateSince, order, targetId, spot, route, dock, depot, battery, trips, parkDistance, tv.waiting / driving /
//                                         teleports / node / edge / s), `traffic.waitNodeOf`, a `logistics.docks.waitsForDock` stub, an event bus (`sim.on`, `sim.emit`)
//                                         and enableDetail() / disableDetail() / dropDetail() / detail / detailError exactly as the engine has them. advance() calls
//                                         detail.afterTickSafe(dt, fresh) after stats.sample, like Simulation.step; `sim.fresh = true` makes the next tick the one that
//                                         ends the warm-up.
//     sim.node(x, y)                      node id of a cell;   sim.route([x, y], [x, y], ...)  a route { nodes, edges } over the real graph (consecutive cells must be linked)
//     sim.go(vehicle, state, patch)       the vehicle enters `state` NOW (stateSince = sim.time); patch: fields of the VehicleRT (order, targetId, route, dock, ...) and
//                                         `tv: { ... }` for the traffic vehicle. A route in the patch makes the vehicle `tv.driving`.
//     sim.order(flowId, qty, extra)       an order object { id, flowId, from, to, qty, loads, ... } the way the collector reads it
//     sim.deliveries(vehicle, n)          the engine counted n deliveries: vr.trips += n (and an orderDelivered event for `order`, if given)
//   createFakeDetail(fixture)             a stand-in for sim.detail that answers every query of the API from a fixture of tests/fixtures/stats (tests/helpers/detail-snapshot.js)
//   fixtureDetailSim(fixture)             a minimal `sim` around it: { detail, time, kpis(), insights(), ... } for code that wants a simulation-shaped object

/** Fields the collector reads from a VehicleRT and its traffic vehicle that the plain fake does not have. */
function scriptable(vr) {
  Object.assign(vr, { parkDistance: 0, targetId: null, spot: -1, route: null, dock: null, depot: null, leaveStation: null, breakdowns: 0 });
  Object.assign(vr.tv, { teleports: 0, node: -1, edge: -1, s: 0, onRoad: true, blockedBy: null, _blk: 0, _blkNode: -1, _cell: -1 });
  return vr;
}

export function createFakeDetailSim(layout, { dt = 0.5 } = {}) {
  const sim = createFakeSim(layout, { dt });
  const graph = buildGraph(layout);
  sim.graph = graph;
  for (const vr of sim.vehicles) scriptable(vr);
  for (const st of sim.stations) { st.outLinks = []; st.inLinks = []; }
  sim.traffic.waitNodeOf = (tv) => (tv._blk === 2 ? tv._blkNode : tv._cell);
  sim.logistics.docks = { waitsForDock: (vr, res) => res !== null && res.queue === true };
  sim.logistics.flows = layout.flows.map((def) => ({ id: def.id, def, from: sim.st(def.from), to: sim.st(def.to) }));
  sim.flows = sim.logistics.flows;

  // the event bus: statistics first (when attached), then the listeners, as Simulation.emit
  const listeners = new Map();
  sim.on = (name, fn) => {
    const entry = { fn };
    listeners.set(name, [...(listeners.get(name) || []), entry]);
    return () => listeners.set(name, (listeners.get(name) || []).filter((e) => e !== entry));
  };
  sim.emit = (name, payload) => {
    if (sim.stats) sim.stats.onEvent(name, payload);
    for (const entry of listeners.get(name) || []) entry.fn(payload, name);
  };
  sim.listenerCount = (name) => (listeners.get(name) || []).length;

  sim.detail = null;
  sim.detailError = null;
  sim.fresh = false;
  sim.enableDetail = (opts) => { if (sim.detail === null) { sim.detail = new Detail(sim, opts); sim.detailError = null; } return sim.detail; };
  sim.dropDetail = () => { sim.detailError = sim.detail.error || null; sim.detail.detach(); sim.detail = null; };
  sim.disableDetail = () => { if (sim.detail !== null) { sim.detail.detach(); sim.detail = null; } };
  sim.advance = (seconds, onTick) => {
    const ticks = Math.round(seconds / sim.dt);
    for (let i = 0; i < ticks; i++) {
      if (onTick) onTick(sim, i);
      sim.time += sim.dt;
      if (sim.stats) sim.stats.sample(sim.dt);
      const fresh = sim.fresh;
      sim.fresh = false;
      if (sim.detail !== null && !sim.detail.afterTickSafe(sim.dt, fresh)) sim.dropDetail();
    }
  };

  sim.node = (x, y) => y * graph.cols + x;
  sim.route = (...cells) => {
    const nodes = cells.map(([x, y]) => y * graph.cols + x);
    const edges = [];
    for (let k = 0; k + 1 < nodes.length; k++) {
      const e = graph.edgeBetween(nodes[k], nodes[k + 1]);
      if (e < 0) throw new Error(`fake route: cells ${cells[k]} and ${cells[k + 1]} are not linked`);
      edges.push(e);
    }
    return { nodes, edges };
  };
  sim.order = (flowId, qty = 1, extra = {}) => {
    const flow = layout.flows.find((f) => f.id === flowId);
    return { id: `o${flowId}-${Math.random().toString(36).slice(2, 6)}`, flowId, from: flow.from, to: flow.to, qty, vehicleId: null, loads: [], createdAt: 0, readySince: 0, pickedAt: null, deliveredAt: null, ...extra };
  };
  sim.go = (vehicle, state, patch = {}) => {
    const vr = typeof vehicle === 'string' ? sim.veh(vehicle) : vehicle;
    const { tv: tvPatch, ...rest } = patch;
    vr.state = state;
    vr.stateSince = sim.time;
    Object.assign(vr, rest);
    if (rest.route) { vr.tv.driving = true; vr.tv.node = -1; } else if (['idle', 'parked', 'charging', 'loading', 'unloading', 'broken', 'dead'].includes(state)) vr.tv.driving = false;
    if (tvPatch) Object.assign(vr.tv, tvPatch);
    return vr;
  };
  sim.deliveries = (vehicle, n = 1, order = null) => {
    const vr = typeof vehicle === 'string' ? sim.veh(vehicle) : vehicle;
    vr.trips += n;
    if (order) for (let k = 0; k < n; k++) sim.emit('orderDelivered', { order, vehicle: vr, waitForPickup: 0, transit: 0, t: sim.time });
  };
  return sim;
}

/** A histogram stand-in (LogHist / SampleSet shape) from a fixture summary: n, sum, max and the stored percentiles. */
function histFrom(summary) {
  const at = (p) => (p <= 0.5 ? summary.p50 : p <= 0.9 ? summary.p90 : summary.p95);
  return { n: summary.n, count: summary.n, sum: summary.sum, max: summary.max, min: summary.min, percentile: (p) => (summary.n === 0 ? null : at(p)) };
}

/**
 * A collector stand-in that answers the whole query API from a fixture of tests/fixtures/stats (see tests/helpers/detail-snapshot.js for its shape). Windows are the fixture's;
 * a query for an index the fixture does not hold answers like the real collector does for a bad index. Results are copies: a caller may change them.
 */
export function createFakeDetail(fixture) {
  const copy = (x) => (x === undefined ? x : structuredClone(x));
  const wk = (w) => (w && w.kind === 'last30' ? 'last30' : 'start');
  const vq = (i, w) => fixture.queries[wk(w)].vehicles[i];
  const sq = (i, w) => fixture.queries[wk(w)].stations[i];
  const stIndex = new Map(fixture.stations.map((s) => [s.id, s.index]));
  const hist = (group) => new Map(Object.entries(fixture.hist[group]).map(([k, v]) => [Number(k), histFrom(v)]));
  const emptySplit = { seconds: 0, driving: 0, waiting: 0, dockQueue: 0, loading: 0, unloading: 0, idle: 0, parked: 0, charging: 0, broken: 0, drivingLoaded: 0, drivingEmpty: 0, drivingDepot: 0 };
  return {
    fixture,
    sim: null,
    failed: false,
    error: null,
    // state
    windowStart: fixture.detail.windowStart, version: fixture.detail.version, notices: copy(fixture.detail.notices), whatIf: copy(fixture.detail.whatIf),
    memoryBytes: 0, nV: fixture.detail.nV, nS: fixture.detail.nS, bCount: fixture.detail.bucketCount,
    legs: { ...fixture.detail.legs, count: fixture.detail.legs.count, size: fixture.detail.legs.rows },
    V: fixture.vehicles.map((v) => ({ ...v })),
    stations: fixture.stations.map((s) => ({ ...s })),
    stIndex,
    graph: { ...fixture.graph },
    cell: fixture.graph.cellSize,
    // engine surface
    afterTickSafe: () => true, reset() {}, detach() {},
    vehicleIndex: (id) => fixture.vehicles.findIndex((v) => v.id === id),
    windowOf: (kind = 'start') => ({ ...fixture.windows[wk({ kind })] }),
    legCoverage: () => ({ rows: fixture.detail.legs.rows, cap: fixture.detail.legs.cap, wrapped: fixture.detail.legs.count > fixture.detail.legs.cap, since: fixture.detail.windowStart }),
    // vehicles
    timeSplit: (i, w) => copy(vq(i, w)?.timeSplit ?? emptySplit),
    counts: (i, w) => copy(vq(i, w)?.counts ?? { trips: 0, loaded: 0, empty: 0, park: 0, qty: 0 }),
    workingSeries: (i, n = 60) => copy((fixture.series.working[i] || []).slice(-n)),
    batteryOf: (i, w) => copy(vq(i, w)?.batteryOf ?? { now: 1, min: 1, stops: [] }),
    routesOf: (i, w, kinds = [1]) => copy((vq(i, w)?.routes ?? []).filter((r) => kinds.includes(r.kind))),
    roundOf: (i, w) => copy(vq(i, w)?.round ?? null),
    queuesOf: (i, w) => copy(vq(i, w)?.queues ?? []),
    hotspots: (i) => copy(fixture.queries.start.vehicles[i]?.hotspots ?? { cells: [], total: 0, folded: 0 }),
    idleSpots: (i) => copy(fixture.queries.start.vehicles[i]?.idleSpots ?? []),
    metresToGo: (i) => fixture.live.vehicles[i]?.metresToGo ?? null,
    // stations and routes
    stationWindow: (i, w) => copy(sq(i, w)?.stationWindow ?? { seconds: 0, fill: 0, inQ: 0, outQ: 0, busy: 0, starved: 0, blocked: 0, down: 0, arrivals: 0, produced: 0, consumed: 0, orders: 0, bufferWait: null, pallets: 0, yardWait: null, intakeWait: null }),
    queueNow: (i) => copy(fixture.live.stations[i]?.queueNow ?? { loads: 0, oldest: 0 }),
    visitsTo: (i, w) => copy(sq(i, w)?.visitsTo ?? { visits: 0, meanApproach: null, meanDockQueue: null, byVehicle: [] }),
    loadedRoutes: ({ from = -1, to = -1 } = {}, w) => copy(fixture.queries[wk(w)].loadedRoutes.filter((r) => (from < 0 || r.from === from) && (to < 0 || r.to === to))),
    busiestRoutes: (w) => copy(fixture.queries[wk(w)].busiestRoutes),
    cellUse: () => ({ legs: 0, byFlow: [] }),
    pickWait: hist('pickWait'), yardWait: hist('yardWait'), sinkLead: hist('sinkLead'),
    pool: {
      get size() { return Object.keys(fixture.paths).length; },
      nodes: (id) => Int32Array.from(fixture.paths[id] || []),
      len: new Proxy([], { get: (_, id) => (fixture.paths[id] ? fixture.paths[id].length - 1 : undefined) }),
      start: new Proxy([], { get: (_, id) => (fixture.paths[id] ? fixture.paths[id][0] : undefined) }),
    },
  };
}

/** A minimal simulation-shaped object around a fixture: the fake collector, the report and the insights as the Results tab shows them. */
export function fixtureDetailSim(fixture) {
  const detail = createFakeDetail(fixture);
  const sim = { time: fixture.time, settings: { warmup: fixture.source?.warmup ?? 0 }, detail, detailError: null, kpis: () => structuredClone(fixture.report), insights: () => structuredClone(fixture.insights) };
  detail.sim = sim;
  return sim;
}
