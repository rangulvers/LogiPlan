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
// Shape, by field name:
//   sim.layout, sim.settings, sim.time, sim.dt
//   sim.graph      { cols, rows, cellSize, nodeCount, edges: [{ id }] }  + cx(id) cy(id) x(id) y(id)
//   sim.traffic    { vehicles: [], stats: { edgePasses: Int32Array, edgeWait, nodeWait: Float64Array,
//                    waitVehicle, waitJunction, waitBroken, deadlocks, totalWait, drivingTime } }
//   sim.logistics  { stations: StationRT[], stationById, vehicles: VehicleRT[], flows, liveLoads, completed }
//   sim.stations / sim.vehicles are aliases of logistics.stations / logistics.vehicles.
// StationRT carries the fields of 5.3 (state, fill, inCount, outCount, produced, consumed, arrivals, inQ, outQ,
// inbound; yard for sources; machines[] for processes; parked/charging/slots/chargers for depots).
// VehicleRT carries id ("<fleetId>#<n>"), fleetId, fleet, state, battery, tv { waiting, waitReason, ... },
// trips, loadedDistance, emptyDistance.

import { layoutFromAscii } from './ascii.js';
import { defaultFleet, defaultStation, defaultFlow, emptyLayout } from '../../js/model/defaults.js';

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
    rt.state = 'starved';
    rt.machines = Array.from({ length: def.params.machines }, () => ({ state: 'idle', remaining: 0, cycleTime: 0, progress: 0, holding: [] }));
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
    flows: layout.flows.map((def) => ({ id: def.id, def })), liveLoads: 0, completed: 0,
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

    /** Put loads into the output queue of `flowId` at its origin station (for backlog tests). */
    addReadyLoads(flowId, n, { readyAt = sim.time } = {}) {
      const flow = layout.flows.find((f) => f.id === flowId);
      for (let i = 0; i < n; i++) sim.st(flow.from).outQ.get(flowId).push({ id: `L${flowId}-${i}`, createdAt: 0, origin: flow.from, readyAt, claimed: false });
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
