// Logistics: the "brain" of the simulation (docs/ARCHITECTURE.md 5.3). It simulates sources, workstations,
// buffers, sinks and depots, turns waiting loads into transport orders and runs every vehicle's state machine.
// It drives a TrafficSystem (5.2) only through its public API and knows nothing about the road geometry
// beyond graph searches. Pure and DOM-free; all randomness comes from forked streams of `rng`, so the same
// layout and seed always replay identically.
//
// Parts: logistics/stations.js (StationRT), logistics/vehicles.js (VehicleRT), logistics/idle.js (what idle
// vehicles do), logistics/dispatcher.js (orders), logistics/routing.js (cached route searches and docks),
// logistics/swrr.js (output splitting).
//
// Where docs/ARCHITECTURE.md 5.3 leaves room (or is ambiguous), this implementation reads it as follows:
//  * Time: step(dt, t) handles everything due by time t. Source arrivals are scheduled on nominal time, so rates do
//    not drift with dt, and a load's createdAt is its exact nominal arrival time. Orders, loading and delivery
//    happen on tick boundaries; loads leave the origin queue when loading *ends* and enter the destination when
//    unloading ends (the places stay occupied / reserved in between). order.pickedAt is the end of loading.
//  * Load bookkeeping: created (sources + workstation outputs) = liveLoads + completed + consumed, where liveLoads
//    (the WIP) also counts the inputs of running cycles and `consumed` = inputs of *finished* cycles (stations.js).
//  * Flows: a flow whose endpoints are missing, equal or of the wrong type (4.3), or whose id repeats, is ignored.
//    maxWait = 0 means "wait for batchMin without a time limit"; batchMin is clamped to what the vehicle, batchMax
//    and the buffers at both ends can ever hold, so an over-ambitious batchMin cannot starve a flow (dispatcher.js).
//  * Workstations without incoming flows run on their own; without outgoing flows their outputs complete at once.
//    `yard` is the number of waiting loads of a source (the loads are in `yardQ`); `fill` of a workstation is its
//    input-buffer fill.
//  * Vehicles: machine breakdowns run on calendar time (at their exact time inside a tick), vehicle breakdowns on
//    operating time (parked or charging vehicles do not fail). A dead vehicle gives its order back at once, a broken
//    one after REASSIGN_AFTER seconds if it has not picked the loads up (event 'orderCancelled'; loads already on a
//    dead vehicle stay there as WIP). A vehicle below lowPct takes no new orders as long as it can reach a charger.
//    'park' goes to the home depot if it has a free slot, else the nearest depot, after IDLE_GRACE seconds without
//    work - and never to a depot without chargers if it would arrive below lowPct. An idle vehicle that holds others
//    up makes room (idle.js): state 'toPark' without a depot, driving to a waiting cell. Distance driven to depots,
//    chargers and waiting cells is `parkDistance`, neither loaded nor empty: loaded + empty + park = odometer.
//  * Dispatch: priority ages by one level per PRIORITY_AGING seconds the oldest ready load has waited, so no flow
//    starves for ever; the dispatcher also wakes up when a load becomes ready or a maxWait runs out, not only
//    every 0.5 s. A pickup dock must lead on to the drop, and docks a vehicle cannot return from come last.
//  * Orders carry station ids in `from`/`to`; the FlowRT is the (non-enumerable) `order.flow`. Events carry both
//    the object and its id (`station`/`stationId`, `vehicle`/`vehicleId`) and the tick time `t`.
//  * Searches: a graph search costs time in proportion to the size of the plant, so each tick only starts as many new
//    ones as routing.js allows (searchBudget); a vehicle that has to wait for its search is looked at again in the next tick.
//    Whether a station can be reached at all is answered without searching. On the examples the budget is never reached.
//  * Initial placement: vehicles start only in parts of the road network that contain a dock of a station their fleet works
//    for (vehicles.js startRegion), so a one-way branch that leads away from all of them never holds a vehicle.

import { createRng } from '../util/rng.js';
import { DISPATCH_STRATEGIES, ROUTING_MODES, defaultSettings } from '../model/defaults.js';
import { makeClock } from '../model/calendar.js';
import { BLOCKED_RETRY, DISPATCH_INTERVAL, EPS, atLeast, num, whole } from './logistics/common.js';
import { dispatch } from './logistics/dispatcher.js';
import { DockBook } from './logistics/docks.js';
import { applyIdlePolicy } from './logistics/idle.js';
import { RouteCache, searchBudget } from './logistics/routing.js';
import { StationRT, finalizeStation, rescaleArrivals, rescaleCycles, stepStation } from './logistics/stations.js';
import { setupTrucks } from './logistics/trucks.js';
import { createOpsStats } from './stats-ops.js';
import { createVehicles, removeVehicle, vehiclePhaseA, vehiclePhaseB } from './logistics/vehicles.js';

const FLOW_FROM = new Set(['source', 'process', 'storage']);
const FLOW_TO = new Set(['process', 'storage', 'sink']);
const noop = () => {};

/** Sanitised runtime settings: unknown or junk values keep the current ones. */
function cleanRuntime(patch, current) {
  const p = patch && typeof patch === 'object' ? patch : {};
  const positive = (key) => (num(p[key], 0) > 0 ? p[key] : current[key]);
  return {
    dispatch: Object.hasOwn(DISPATCH_STRATEGIES, p.dispatch) ? p.dispatch : current.dispatch,
    routing: Object.hasOwn(ROUTING_MODES, p.routing) ? p.routing : current.routing,
    demandFactor: num(p.demandFactor, -1) >= 0 ? p.demandFactor : current.demandFactor,
    speedFactor: positive('speedFactor'),
    processFactor: positive('processFactor'),
  };
}

/** Per-flow settings, sanitised once. */
function flowConfig(def) {
  return {
    weight: num(def.weight, 1),
    perCycle: whole(def.perCycle, 1, 1),
    batchMin: whole(def.batchMin, 1, 1),
    batchMax: whole(def.batchMax, 0, 0),
    maxWait: atLeast(def.maxWait, 0, 0),
    priority: Math.min(3, whole(def.priority, 1, 1)),
    fleetId: typeof def.fleetId === 'string' && def.fleetId ? def.fleetId : null,
  };
}

export class Logistics {
  /**
   * @param {{ layout: object, graph: object, traffic: object, rng?: object, emit?: (name: string, payload: object) => void }} opts
   *   `traffic` is a TrafficSystem (5.2); Logistics takes over `traffic.onArrive` and sets `traffic.speedFactor`.
   */
  constructor({ layout, graph, traffic, rng, emit }) {
    const settings = { ...defaultSettings(), ...(layout.settings || {}) };
    this.layout = layout;
    this.graph = graph;
    this.traffic = traffic;
    this.rng = rng || createRng(num(settings.seed, 1));
    this.emit = typeof emit === 'function' ? (name, payload) => emit(name, payload) : noop;
    /** Live-adjustable settings (see setRuntime). */
    this.runtime = cleanRuntime(settings, { dispatch: 'nearest', routing: 'shortest', demandFactor: 1, speedFactor: 1, processFactor: 1 });
    this.routes = new RouteCache(graph, traffic, this.runtime.routing);
    this.routes.budget = searchBudget(graph);
    /** How many routes have passed each node (idle vehicles prefer waiting cells that routes seldom use). */
    this.routeUse = new Uint32Array(graph.nodeCount);

    /** Start of the last tick and the time the simulation has reached (end of the last tick). */
    this.time = 0;
    this.now = 0;
    this.dirty = true;
    this.nextDispatch = 0;
    this.loadSeq = 0;
    this.orderSeq = 0;
    /** Number of existing loads (WIP, including inputs of running cycles). */
    this.liveLoads = 0;
    /** Loads that left the system: sink consumption + output of workstations without outgoing flow. */
    this.completed = 0;
    this.createdBySources = 0;
    this.createdByProcesses = 0;
    /** Input loads of finished cycles (retired together with the creation of the outputs). */
    this.loadsConsumed = 0;
    this.ordersDelivered = 0;
    /** Orders assigned and not yet delivered, by id. */
    this.activeOrders = new Map();
    /** Deadlock reports received through handleDeadlock. */
    this.deadlocks = 0;
    /** Seams of the warehouse module (docs/WAREHOUSE-DESIGN.md 5.4), present but inert: the optional extension object, null unless a layout uses an extension, and the clock of a plant with `layout.calendar`. */
    this.ext = null;
    this.clock = layout.calendar ? makeClock(layout.calendar) : null;
    /** Ids of the trucks of the plant (the `tk` of their pallets), see logistics/trucks.js. */
    this.truckSeq = 0;

    this.buildStations(layout);
    this.buildFlows(layout);
    for (const st of this.stations) finalizeStation(st);
    this.depots = this.stations.filter((s) => s.type === 'depot');
    this.chargerDepots = this.depots.filter((d) => d.chargers > 0 && (graph.docks.get(d.id) || []).length > 0);
    /** Who stands on and who is on the way to each dock; which dock a vehicle drives to (logistics/docks.js). */
    this.docks = new DockBook(this);
    for (const st of this.stations) if (st.type === 'source' && !(this.runtime.demandFactor > 0)) st.nextArrival = Infinity;
    // Goods in / Goods out with `ops.trucks` (milestone M1): their trucks, and the extension object that adds `report.ops.trucks` to the statistics
    if (setupTrucks(this)) this.ext = { stats: (stats) => createOpsStats(stats, this) };

    traffic.onArrive = (tv) => this.handleArrive(tv);
    traffic.speedFactor = this.runtime.speedFactor;
    /** `unplaced`: ids of vehicles that found no room on the road at start (they do not exist in the simulation). */
    ({ vehicles: this.vehicles, unplaced: this.unplaced } = createVehicles(this));
  }

  buildStations(layout) {
    this.stations = [];
    this.stationById = new Map();
    for (const def of layout.stations || []) {
      if (!def || this.stationById.has(def.id) || !['source', 'process', 'storage', 'sink', 'depot'].includes(def.type)) continue;
      const st = new StationRT(def, this.rng.fork('station:' + def.id));
      this.stations.push(st);
      this.stationById.set(def.id, st);
    }
  }

  buildFlows(layout) {
    this.flows = [];
    this.flowById = new Map();
    for (const def of layout.flows || []) {
      const from = this.stationById.get(def.from);
      const to = this.stationById.get(def.to);
      if (!from || !to || from === to || !FLOW_FROM.has(from.type) || !FLOW_TO.has(to.type) || this.flowById.has(def.id)) continue;
      const cfg = flowConfig(def);
      const flow = { id: def.id, def, cfg, from, to, delivered: 0, trips: 0, outLink: null, inLink: null };
      flow.outLink = { flow, queue: [], cap: from.type === 'storage' ? Infinity : from.params.outCap, claimed: 0 };
      from.outLinks.push(flow.outLink);
      from.outQ.set(flow.id, flow.outLink.queue);
      to.inbound.set(flow.id, 0);
      if (to.type === 'process') {
        flow.inLink = { flow, queue: [], perCycle: cfg.perCycle };
        to.inLinks.push(flow.inLink);
        to.inQ.set(flow.id, flow.inLink.queue);
      }
      this.flows.push(flow);
      this.flowById.set(flow.id, flow);
    }
  }

  /**
   * Advance the brain by one tick.
   * @param {number} dt tick length (s)
   * @param {number} [t] sim time at the start of the tick (defaults to where the last tick ended)
   */
  step(dt, t = this.now) {
    if (!(dt > 0) || !Number.isFinite(t)) return;
    this.time = t;
    this.routes.beginTick();
    this.docks.tick(dt, t);
    for (const vr of this.vehicles) vehiclePhaseA(this, vr, t);
    for (const st of this.stations) stepStation(st, dt, t, this);
    if (this.dirty || t + EPS >= this.nextDispatch) {
      this.dirty = false;
      const round = dispatch(this, t);
      this.nextDispatch = Math.min(t + (round.blockedDepots.size > 0 ? BLOCKED_RETRY : DISPATCH_INTERVAL), round.wake);
      applyIdlePolicy(this, t, round.blockedDepots);
    }
    for (const vr of this.vehicles) vehiclePhaseB(this, vr, dt, t);
    this.now = t + dt;
  }

  /**
   * Change the live-adjustable settings; junk values are ignored. speedFactor goes straight to the
   * traffic system; demand and process factors also rescale pending arrivals and running cycles.
   * @param {{ demandFactor?: number, speedFactor?: number, processFactor?: number, dispatch?: string, routing?: string }} patch
   */
  setRuntime(patch) {
    const old = { ...this.runtime };
    const next = cleanRuntime(patch, old);
    Object.assign(this.runtime, next);
    if (next.speedFactor !== old.speedFactor) this.traffic.speedFactor = next.speedFactor;
    if (next.routing !== old.routing) this.routes.setMode(next.routing);
    if (next.dispatch !== old.dispatch) this.markDirty();
    for (const st of this.stations) {
      if ((st.type === 'source' || st.trucks !== null) && next.demandFactor !== old.demandFactor) rescaleArrivals(st, old.demandFactor, next.demandFactor, this.now, this);
      else if (st.type === 'process' && next.processFactor !== old.processFactor) rescaleCycles(st, old.processFactor, next.processFactor, this.now - this.time);
    }
  }

  /**
   * The engine forwards traffic.onDeadlock here. A victim that was relocated has lost its route; it plans
   * its current leg again from the new node at the start of the next tick.
   * @param {{ victim?: object, resolved?: boolean }} info
   */
  handleDeadlock(info) {
    this.deadlocks++;
    const victim = info && info.victim;
    const vr = victim && (victim.owner || (typeof victim === 'string' ? this.vehicles.find((v) => v.id === victim) : victim));
    if (vr && vr.lg === this && info.resolved !== false) vr.replan = true;
  }

  /**
   * Take a vehicle out of the simulation for good (a vehicle sold or scrapped while the plant runs; also what tests use to check that
   * nothing is left behind). Its order goes back to the dispatcher, its dock reservation and depot places end and it leaves the road.
   * @param {object} vr a VehicleRT of this Logistics
   * @param {number} [t] sim time (default: the end of the last tick)
   * @returns {boolean} false when the vehicle is not one of ours
   */
  removeVehicle(vr, t = this.now) {
    const i = this.vehicles.indexOf(vr);
    if (i < 0) return false;
    removeVehicle(this, vr, t);
    this.vehicles.splice(i, 1);
    return true;
  }

  // ---- services used by the parts ------------------------------------------------------------------------------

  /** Something changed that may create demand or free a vehicle: dispatch on the next tick. */
  markDirty() {
    this.dirty = true;
  }

  handleArrive(tv) {
    const vr = tv && tv.owner;
    if (vr && vr.lg === this) vr.arrived = true;
  }

  /** A new load: made by a source (kind 'source') or as workstation output (kind 'process'). */
  createLoad(station, createdAt, readyAt, kind) {
    // ty: type index, tk: truck id, at: aisle index, slot: slot id - fixed here so the shape never changes, nothing reads them yet (5.4)
    const load = { id: ++this.loadSeq, createdAt, origin: station.id, readyAt, claimed: false, ty: 0, tk: -1, at: -1, slot: -1 };
    this.liveLoads++;
    if (kind === 'source') this.createdBySources++;
    else this.createdByProcesses++;
    this.emit('loadCreated', { load, station, stationId: station.id, t: this.time });
    return load;
  }

  /** A load leaves the system (sink, or workstation without outgoing flow). */
  completeLoad(load, station, t) {
    this.liveLoads--;
    this.completed++;
    this.emit('loadCompleted', { load, station, stationId: station.id, leadTime: Math.max(0, t - load.createdAt), t });
  }

  /** The inputs of a finished cycle disappear (their outputs are created by the caller). */
  retireInputs(n) {
    this.liveLoads -= n;
    this.loadsConsumed += n;
  }

  openOrder(flow, vehicle, loads, t) {
    const order = {
      id: 'o' + ++this.orderSeq,
      flowId: flow.id,
      from: flow.from.id,
      to: flow.to.id,
      qty: loads.length,
      vehicleId: vehicle.id,
      loads,
      createdAt: t,
      readySince: loads[0].readyAt,
      pickedAt: null,
      deliveredAt: null,
      pickAt: -1, dropAt: -1, pickExtra: 0, dropExtra: 0, // aisle hints and extra service seconds there; inert until M3 (5.4)
    };
    Object.defineProperty(order, 'flow', { value: flow });
    this.activeOrders.set(order.id, order);
    this.emit('orderAssigned', { order, vehicle, t });
    return order;
  }

  closeOrder(order) {
    this.activeOrders.delete(order.id);
    this.ordersDelivered++;
  }

  /** An order ends without delivery: its vehicle died, or stayed broken (reason 'vehicle-dead' | 'vehicle-broken'). */
  cancelOrder(order, vehicle, reason, t) {
    this.activeOrders.delete(order.id);
    this.markDirty();
    this.emit('orderCancelled', { order, vehicle, vehicleId: vehicle.id, reason, t });
  }
}
