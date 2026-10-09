// Vehicle runtime (VehicleRT) of the logistics layer: initial placement and the per-vehicle state machine
//   idle/parked -> toPickup -> loading -> toDrop -> unloading -> idle | toPark -> parked
//   (low battery) -> toCharger -> charging -> parked,   plus breakdowns ('broken') and dead batteries ('dead').
// What an idle vehicle does next (waiting, parking, charging, making room for others) is idle.js.
// See docs/ARCHITECTURE.md 5.3. Vehicles are driven through the TrafficSystem API only (drive, detach,
// attach); arrivals are flagged by traffic.onArrive and handled at the start of the next logistics step.
//
// A tick runs in two phases per vehicle so every state lasts exactly from the moment it is entered:
//   phase A (start of the tick, time t): react to arrivals, finished timers, repairs, finished charging,
//     re-plan after a deadlock relocation;
//   (stations step and dispatch run in between and may start new orders);
//   phase B: integrate the interval [t, t+dt) in the state the vehicle now has: timers, battery, failures.
//
// A leg ends at a dock of a station (`targetId`), or - for a vehicle that only makes room - at a road cell
// (`spot`); the latter runs in state 'toPark' without a depot.
// An order that cannot be served any more is given back (releaseOrder): when the vehicle's battery is dead,
// and when it has been broken for REASSIGN_AFTER seconds without having picked the loads up. Another vehicle
// then serves the flow.

import { acceptLoads, releaseInbound, unclaimLoads } from './stations.js';
import {
  DRIVING_STATES, EPS, IDLE_DRAIN_SHARE, MAX_FLEET, MIN_REPAIR, REASSIGN_AFTER, RETRY_INTERVAL, VEHICLE_STATES,
  atLeast, num, removeFromQueue, whole,
} from './common.js';

/** Sanitised, precomputed per-fleet settings shared by all of its vehicles. */
function fleetConfig(fleet) {
  const b = fleet.battery && typeof fleet.battery === 'object' ? fleet.battery : {};
  const runtimeMin = atLeast(b.runtimeMin, 0, 480);
  const chargeMin = atLeast(b.chargeTimeMin, 0, 90);
  const low = Math.min(1, atLeast(b.lowPct, 0, 25) / 100);
  const resume = Math.min(1, atLeast(b.resumePct, 0, 90) / 100);
  const mtbf = atLeast(fleet.mtbf, 0, 0);
  const mttr = atLeast(fleet.mttr, 0, 0);
  return {
    count: Math.min(MAX_FLEET, whole(fleet.count, 0, 0)),
    body: {
      length: atLeast(fleet.length, 0.1, 1.6),
      speed: atLeast(fleet.speed, 0.05, 1.5),
      accel: atLeast(fleet.accel, 0.05, 0.8),
      decel: atLeast(fleet.decel, 0.05, 1),
    },
    capacity: whole(fleet.capacity, 1, 1),
    loadTime: atLeast(fleet.loadTime, 0, 0),
    unloadTime: atLeast(fleet.unloadTime, 0, 0),
    batteryOn: b.enabled === true,
    drain: runtimeMin > 0 ? 1 / (runtimeMin * 60) : 0, // battery fraction per second of work
    charge: chargeMin > 0 ? 1 / (chargeMin * 60) : Infinity, // battery fraction per second on a charger
    low,
    resume: Math.max(low, resume),
    mtbf,
    mttr,
    failing: mtbf > 0 && mttr > 0,
    idle: fleet.idle === 'stay' ? 'stay' : 'park',
    home: typeof fleet.home === 'string' ? fleet.home : null,
  };
}

export class VehicleRT {
  /**
   * @param {object} lg the owning Logistics
   * @param {object} fleet the layout fleet
   * @param {object} cfg fleetConfig(fleet)
   * @param {number} n 1-based number within the fleet
   */
  constructor(lg, fleet, cfg, n) {
    this.id = `${fleet.id}#${n}`;
    this.fleetId = fleet.id;
    this.fleet = fleet;
    this.cfg = cfg;
    this.name = `${fleet.name || fleet.id} ${n}`;
    this.color = fleet.color;
    this.lg = lg;
    this.rng = lg.rng.fork('vehicle:' + this.id);
    /** The TrafficSystem vehicle (set right after construction). Its pose is mirrored by x/y/heading/prev*. */
    this.tv = null;
    this.state = 'idle';
    this.stateSince = 0;
    this.order = null;
    this.load = [];
    this.battery = 1;
    this.visible = true;
    this.trips = 0;
    this.loadedDistance = 0;
    this.emptyDistance = 0;
    /** Distance driven to depots, chargers and waiting places (not order work): neither loaded nor empty. */
    this.parkDistance = 0;
    this.breakdowns = 0;
    this.timeIn = Object.fromEntries(VEHICLE_STATES.map((s) => [s, 0]));
    /** Depot the vehicle is parked / charging in (null while on the road). */
    this.depot = null;
    /** Station the current leg drives to, or the road cell (`spot`, -1 if none) of a vehicle that only makes room. */
    this.targetId = null;
    this.spot = -1;
    /** The route of the current leg (nodes it passes), while the vehicle drives it. */
    this.route = null;
    this.arrived = false;
    this.replan = false;
    /** The vehicle's reservation at the dock it drives to (docks.js), null while it plans to stop at none. */
    this.dock = null;
    /** The dock cell the vehicle drove away from last (-1 once it has cleared the cell), when it left, and the station it served there. */
    this.leaving = -1;
    this.leftAt = 0;
    this.leaveStation = null;
    /** Leaving a depot: the first leg may start in any direction (no arrival edge). */
    this.freeChoice = false;
    this.retryAt = 0;
    /** An idle vehicle that held others up but found nowhere to go looks again at this time. */
    this.roomRetryAt = 0;
    this.timer = 0;
    /** The state to return to after a repair (while 'broken'), or the state a dead vehicle was in. */
    this.resumeState = null;
    this.repairLeft = 0;
    this.lastOdo = 0;
    this.ttf = cfg.failing ? this.rng.exp(cfg.mtbf) : Infinity; // operating time to the next breakdown
  }

  get x() { return this.tv.x; }
  get y() { return this.tv.y; }
  get heading() { return this.tv.heading; }
  get prevX() { return this.tv.prevX; }
  get prevY() { return this.tv.prevY; }
  get prevHeading() { return this.tv.prevHeading; }
}

// ---- creation & initial placement -----------------------------------------------------------------------------

/**
 * Create all vehicles. Fleets start parked in their home depot (then any depot with free slots); the rest
 * is spread deterministically over non-controlled, non-dock road cells of the part of the road network the fleet works in
 * (see startRegion). Vehicles that find no room are left out and returned as `unplaced` ids.
 * @returns {{ vehicles: VehicleRT[], unplaced: string[] }}
 */
export function createVehicles(lg) {
  const all = [];
  for (const fleet of lg.layout.fleets || []) {
    const cfg = fleetConfig(fleet);
    for (let n = 1; n <= cfg.count; n++) all.push(new VehicleRT(lg, fleet, cfg, n));
  }
  const onRoad = [];
  for (const vr of all) if (!parkInitially(lg, vr)) onRoad.push(vr);
  const regions = new Map();
  onRoad.forEach((vr, k) => {
    if (!regions.has(vr.fleetId)) regions.set(vr.fleetId, startRegion(lg, vr.fleetId));
    const { cells, spots } = regions.get(vr.fleetId);
    const start = Math.floor(((k + 0.5) * spots.length) / onRoad.length);
    for (let i = 0; i < spots.length && !vr.tv; i++) addToTraffic(lg, vr, spots[(start + i) % spots.length]);
    for (let i = 0; i < cells.length && !vr.tv; i++) addToTraffic(lg, vr, cells[i]); // crowded: any free cell
    if (vr.tv) vr.lastOdo = num(vr.tv.odometer, 0);
  });
  return { vehicles: all.filter((vr) => vr.tv), unplaced: all.filter((vr) => !vr.tv).map((vr) => vr.id) };
}

function addToTraffic(lg, vr, node) {
  vr.tv = lg.traffic.addVehicle({ id: vr.id, ...vr.cfg.body, node, owner: vr });
  return vr.tv;
}

/** Park a new vehicle in its home depot, else the first depot with a free slot and a dock. */
function parkInitially(lg, vr) {
  const home = lg.stationById.get(vr.cfg.home);
  const depots = home && home.type === 'depot' ? [home, ...lg.depots.filter((d) => d !== home)] : lg.depots;
  for (const depot of depots) {
    if (depot.freeSlots <= 0) continue;
    for (const dock of lg.graph.docks.get(depot.id) || []) {
      if (!addToTraffic(lg, vr, dock)) continue;
      lg.traffic.detach(vr.tv);
      vr.lastOdo = num(vr.tv.odometer, 0);
      vr.visible = false;
      vr.depot = depot;
      vr.state = 'parked';
      depot.parked.push(vr);
      return true;
    }
  }
  return false;
}

/**
 * The road cells a fleet may start on, and the preferred ones among them (no junction, no dock). Only parts of the network
 * that contain a dock of a station the fleet works for qualify: a vehicle placed on a one-way branch that leads away from
 * all of them can never do anything, and neither can one that has no way back. Without any such dock every cell qualifies.
 */
function startRegion(lg, fleetId) {
  const { graph } = lg;
  const parts = new Set();
  for (const flow of lg.flows) {
    if (flow.cfg.fleetId !== null && flow.cfg.fleetId !== fleetId) continue;
    for (const station of [flow.from, flow.to]) for (const dock of graph.docks.get(station.id) || []) parts.add(graph.scc[dock]);
  }
  const cells = parts.size > 0 ? graph.nodes.filter((n) => parts.has(graph.scc[n])) : graph.nodes;
  const free = cells.filter((n) => !graph.controlled[n] && !graph.stationsAt.has(n));
  const noDock = cells.filter((n) => !graph.stationsAt.has(n));
  return { cells, spots: free.length > 0 ? free : noDock.length > 0 ? noDock : cells };
}

// ---- availability for the dispatcher ---------------------------------------------------------------------------

/** Battery below the fleet's low threshold: the vehicle must charge before it takes new work. */
export function needsCharge(vr) {
  return vr.cfg.batteryOn && vr.battery < vr.cfg.low;
}

/** Can the vehicle get to any charger at all? (One that cannot keeps working: waiting would only waste it.) */
function canCharge(lg, vr) {
  const depots = lg.chargerDepots;
  if (depots.length === 0) return false;
  const ids = depots.map((d) => d.id);
  if (vr.state === 'parked') return (lg.graph.docks.get(vr.depot.id) || []).some((dock) => lg.routes.canReachAny(dock, -1, ids));
  return lg.routes.canReachAny(vr.tv.node, arrivalEdgeOf(lg, vr), ids);
}

/** Can the dispatcher give this vehicle an order now? */
export function isAvailable(lg, vr) {
  if (vr.state !== 'parked') {
    const tv = vr.tv;
    if (vr.state !== 'idle' || !tv.onRoad || tv.node < 0 || tv.driving || tv.disabled) return false;
  }
  return !(needsCharge(vr) && canCharge(lg, vr));
}

// ---- legs: driving to a station ----------------------------------------------------------------------------------

/** Enter a state (no-op if already in it). */
export function setState(vr, state, t) {
  if (vr.state === state) return;
  vr.state = state;
  vr.stateSince = t;
}

/** Edge the vehicle arrived over at its current node, or -1 when it may leave in any direction. */
export function arrivalEdgeOf(lg, vr) {
  if (vr.freeChoice) return -1;
  const e = vr.tv.lastEdge;
  return e >= 0 && lg.graph.edges[e] && lg.graph.edges[e].to === vr.tv.node ? e : -1;
}

/**
 * Enter a driving state and start driving to `targetId` (a station) or, with `spot` >= 0, to that road cell.
 * False when the leg could not be started (it is retried).
 */
export function startLeg(lg, vr, state, targetId, t, spot = -1) {
  setState(vr, state, t);
  vr.targetId = targetId;
  vr.spot = spot;
  vr.retryAt = 0;
  return planLeg(lg, vr, t);
}

function retryLater(vr, t) {
  vr.retryAt = t + RETRY_INTERVAL;
  return false;
}

/** Hand a route to the traffic system; the cells it passes are counted as used (see idle.js, waiting places). */
function driveRoute(lg, vr, route, t) {
  const from = vr.tv.node;
  lg.traffic.drive(vr.tv, route);
  if (!vr.tv.driving) return false;
  vr.route = route;
  for (const node of route.nodes) lg.routeUse[node]++;
  if (route.edges.length > 0) lg.docks.leaves(vr, from, t); // (the dock cell it drives away from stays taken for a moment)
  return true;
}

/**
 * The dock (or waiting cell) the current leg ends at, as seen from `entry`; null when there is none. Among the docks of a station the
 * dock book picks the one where service starts soonest (docks.js), not simply the cheapest.
 */
function legTarget(lg, vr, entry, t) {
  if (vr.spot >= 0) return entry.search.dist(vr.spot) < Infinity ? { node: vr.spot } : null;
  const toId = vr.state === 'toPickup' ? vr.order.flow.to.id : null;
  return lg.docks.choose(vr, entry, vr.targetId, toId, t);
}

/** Plan and start the route to the current leg's target; arrive at once if already there. */
function planLeg(lg, vr, t) {
  const tv = vr.tv;
  vr.replan = false;
  lg.docks.release(vr); // a new plan replaces the old reservation (deadlock relocation, retry)
  if (tv.node < 0) return retryLater(vr, t);
  const entry = lg.routes.get(tv.node, arrivalEdgeOf(lg, vr), t, true);
  if (entry === null) { vr.retryAt = t; return false; } // this tick's search budget is spent: first thing in the next tick
  const target = legTarget(lg, vr, entry, t);
  if (!target) {
    if (vr.spot < 0) return retryLater(vr, t);
    vr.spot = -1; // the waiting cell cannot be reached from here: stay where we are
    setState(vr, 'idle', t);
    return true;
  }
  if (target.node === tv.node) { arrive(lg, vr, t); return true; }
  const route = lg.routes.routeOfDock(entry, target);
  if (!driveRoute(lg, vr, route, t)) return retryLater(vr, t);
  vr.freeChoice = false;
  if (vr.spot < 0) lg.docks.reserve(vr, target.node, vr.targetId, t, lg.docks.travelAlong(vr, route, 0, route.edges.length), entry);
  return true;
}

/** The vehicle stands on a dock of its target station (or on its waiting cell). */
function arrive(lg, vr, t) {
  if (vr.spot >= 0) {
    if (vr.tv.node !== vr.spot) { planLeg(lg, vr, t); return; }
    vr.spot = -1;
    setState(vr, 'idle', t);
    lg.markDirty();
    return;
  }
  const here = lg.graph.stationsAt.get(vr.tv.node);
  if (!here || !here.includes(vr.targetId)) { planLeg(lg, vr, t); return; }
  lg.docks.arrived(vr, vr.tv.node, vr.targetId);
  switch (vr.state) {
    case 'toPickup': startLoading(lg, vr, t); break;
    case 'toDrop': startUnloading(lg, vr, t); break;
    case 'toPark': enterDepot(lg, vr, t, false); break;
    case 'toCharger': enterDepot(lg, vr, t, true); break;
    default: break;
  }
}

// ---- loading, unloading, delivery ----------------------------------------------------------------------------------

function startLoading(lg, vr, t) {
  setState(vr, 'loading', t);
  vr.timer = vr.cfg.loadTime;
  if (vr.timer <= EPS) finishLoading(lg, vr, t);
}

/** The loads leave the origin's output queue and ride with the vehicle. */
function finishLoading(lg, vr, t) {
  const order = vr.order;
  const flow = order.flow;
  const link = flow.outLink;
  removeFromQueue(link.queue, new Set(order.loads));
  link.claimed -= order.loads.length;
  vr.load = order.loads.slice();
  order.pickedAt = t;
  if (flow.from.type === 'storage') flow.from.produced += order.qty;
  if (flow.from.trucks !== null) flow.from.trucks.pickedUp(order.loads, t); // a Goods in with trucks: unloading is emergent, each pickup takes a pallet off its truck
  lg.markDirty();
  lg.emit('orderPickedUp', { order, vehicle: vr, t });
  startLeg(lg, vr, 'toDrop', flow.to.id, t);
}

function startUnloading(lg, vr, t) {
  setState(vr, 'unloading', t);
  vr.timer = vr.cfg.unloadTime;
  if (vr.timer <= EPS) finishUnloading(lg, vr, t);
}

/** Hand the loads to the destination, release its reservation and close the order. */
function finishUnloading(lg, vr, t) {
  const order = vr.order;
  const flow = order.flow;
  acceptLoads(flow, vr.load, t, lg);
  vr.load = [];
  order.deliveredAt = t;
  flow.delivered += order.qty;
  flow.trips++;
  vr.trips++;
  lg.closeOrder(order);
  vr.order = null;
  vr.targetId = null;
  vr.retryAt = 0;
  setState(vr, 'idle', t);
  lg.markDirty();
  lg.emit('orderDelivered', { order, vehicle: vr, waitForPickup: order.pickedAt - order.readySince, transit: t - order.pickedAt, t });
}

/**
 * The vehicle gives its order back: the destination's reserved places end and, if the loads are still at the
 * origin, they become available again. Loads that already ride with the vehicle stay on it (they are work in
 * progress that can no longer be delivered).
 */
function releaseOrder(lg, vr, t, reason) {
  const order = vr.order;
  if (!order) return;
  if (order.pickedAt === null) unclaimLoads(order.flow, order.loads);
  else for (const load of order.loads) load.claimed = false;
  releaseInbound(order.flow, order.qty);
  vr.order = null;
  lg.docks.release(vr); // the dock it drove to is no longer expected
  lg.cancelOrder(order, vr, reason, t);
}

// ---- depots: parking, leaving, charging -------------------------------------------------------------------------

/** Vehicle reached a depot dock: lift it off the road into a parking place or onto a charger. */
function enterDepot(lg, vr, t, charging) {
  const depot = lg.stationById.get(vr.targetId);
  lg.traffic.detach(vr.tv);
  vr.visible = false;
  vr.depot = depot;
  vr.targetId = null;
  vr.route = null;
  depot.reservedSlots--;
  if (charging) {
    depot.reservedChargers--;
    depot.charging.push(vr);
    setState(vr, 'charging', t);
  } else {
    depot.parked.push(vr);
    setState(vr, 'parked', t);
  }
  lg.markDirty();
}

/** Put a parked vehicle back on the road at `dock`; false when that dock cannot take it right now. */
export function leaveDepot(lg, vr, dock) {
  if (!lg.traffic.attach(vr.tv, dock)) return false;
  const parked = vr.depot.parked;
  parked.splice(parked.indexOf(vr), 1);
  vr.depot = null;
  vr.visible = true;
  vr.freeChoice = true;
  return true;
}

/** A parked vehicle with a low battery moves onto a free charger of its own depot. */
export function startCharging(lg, vr, t) {
  const parked = vr.depot.parked;
  parked.splice(parked.indexOf(vr), 1);
  vr.depot.charging.push(vr);
  setState(vr, 'charging', t);
}

function endCharging(lg, vr, t) {
  const depot = vr.depot;
  depot.charging.splice(depot.charging.indexOf(vr), 1);
  depot.parked.push(vr);
  setState(vr, 'parked', t);
  lg.markDirty();
}

/** Release the depot places a vehicle had reserved for a trip it will never finish. */
export function cancelDepotTrip(lg, vr) {
  const trip = vr.state === 'broken' ? vr.resumeState : vr.state;
  if ((trip !== 'toPark' && trip !== 'toCharger') || vr.targetId === null) return;
  const depot = lg.stationById.get(vr.targetId);
  depot.reservedSlots--;
  if (trip === 'toCharger') depot.reservedChargers--;
}

// ---- the two phases of a tick ---------------------------------------------------------------------------------------

/** Odometer progress since the last tick, booked as loaded, empty or depot/waiting-place driving. */
function trackDistance(vr) {
  const odo = num(vr.tv.odometer, vr.lastOdo);
  const d = odo - vr.lastOdo;
  vr.lastOdo = odo;
  if (d > 0) {
    if (vr.state === 'toPark' || vr.state === 'toCharger') vr.parkDistance += d;
    else if (vr.load.length > 0) vr.loadedDistance += d;
    else vr.emptyDistance += d;
  }
}

/** Phase A (start of the tick at time t): events that happened during the last interval. */
export function vehiclePhaseA(lg, vr, t) {
  trackDistance(vr);
  if (vr.state === 'dead') return;
  if (vr.state === 'broken') {
    if (vr.repairLeft > EPS) { reassignBroken(lg, vr, t); return; }
    repair(lg, vr, t);
  }
  if (vr.arrived && !DRIVING_STATES.has(vr.state)) vr.arrived = false;
  switch (vr.state) {
    case 'charging':
      if (vr.battery >= vr.cfg.resume - EPS) endCharging(lg, vr, t);
      break;
    case 'loading':
      if (vr.timer <= EPS) finishLoading(lg, vr, t);
      break;
    case 'unloading':
      if (vr.timer <= EPS) finishUnloading(lg, vr, t);
      break;
    case 'toPickup':
    case 'toDrop':
    case 'toCharger':
    case 'toPark':
      if (vr.arrived) {
        vr.arrived = false;
        arrive(lg, vr, t);
      } else if (!vr.tv.driving && !vr.tv.disabled && (vr.replan || vr.retryAt <= t + EPS)) {
        planLeg(lg, vr, t); // relocated by deadlock resolution, or an earlier plan failed
      } else if (vr.dock !== null && t + EPS >= vr.dock.nextCheck) {
        lg.docks.rebind(vr, t); // still on the way: is another dock of the station better by now?
      }
      break;
    default:
      break;
  }
}

/** Phase B (after dispatch): integrate the interval [t, t+dt) in the vehicle's current state. */
export function vehiclePhaseB(lg, vr, dt, t) {
  vr.timeIn[vr.state] += dt;
  switch (vr.state) {
    case 'parked':
    case 'dead':
      return;
    case 'charging':
      vr.battery = Math.min(1, vr.battery + dt * vr.cfg.charge);
      return;
    case 'loading':
    case 'unloading':
      vr.timer -= dt;
      break;
    case 'broken':
      vr.repairLeft -= dt;
      break;
    default:
      break;
  }
  const { cfg } = vr;
  if (cfg.batteryOn) {
    const share = vr.state === 'idle' || vr.state === 'broken' ? IDLE_DRAIN_SHARE : 1;
    vr.battery = Math.max(0, vr.battery - dt * cfg.drain * share);
    if (vr.battery <= 0) { die(lg, vr, t); return; }
  }
  if (cfg.failing && vr.state !== 'broken') {
    vr.ttf -= dt;
    if (vr.ttf <= EPS) breakDown(lg, vr, t);
  }
}

/**
 * The battery is empty: the vehicle stops where it is and blocks its lane for good. Its order goes back to the
 * dispatcher: a flow must not stop because one of its vehicles died on the way to the pickup.
 */
function die(lg, vr, t) {
  cancelDepotTrip(lg, vr);
  lg.docks.release(vr);
  if (vr.state !== 'broken') vr.resumeState = vr.state;
  vr.spot = -1; // a dead vehicle no longer needs its waiting cell
  releaseOrder(lg, vr, t, 'vehicle-dead');
  setState(vr, 'dead', t);
  vr.tv.disabled = true;
  lg.emit('vehicleDead', { vehicle: vr, vehicleId: vr.id, t });
}

/**
 * Take a vehicle out of the simulation (Logistics.removeVehicle): its order goes back to the dispatcher, the depot places and the dock it
 * had reserved end, and it leaves the road. Loads it carries are scrapped: they leave the work in progress as consumed.
 */
export function removeVehicle(lg, vr, t) {
  cancelDepotTrip(lg, vr);
  lg.docks.forget(vr);
  vr.spot = -1;
  releaseOrder(lg, vr, t, 'vehicle-removed');
  if (vr.load.length > 0) lg.retireInputs(vr.load.length);
  vr.load = [];
  if (vr.depot) {
    for (const list of [vr.depot.parked, vr.depot.charging]) {
      const i = list.indexOf(vr);
      if (i >= 0) list.splice(i, 1);
    }
    vr.depot = null;
  }
  vr.targetId = null;
  vr.route = null;
  vr.state = 'dead';
  lg.traffic.removeVehicle(vr.tv);
  lg.markDirty();
}

function breakDown(lg, vr, t) {
  vr.resumeState = vr.state;
  setState(vr, 'broken', t);
  vr.repairLeft = Math.max(MIN_REPAIR, vr.rng.exp(vr.cfg.mttr));
  vr.breakdowns++;
  vr.tv.disabled = true;
  lg.emit('vehicleDown', { vehicle: vr, vehicleId: vr.id, t });
}

/** A vehicle that stays broken for REASSIGN_AFTER seconds gives back an order whose loads it has not picked up. */
function reassignBroken(lg, vr, t) {
  const order = vr.order;
  if (!order || order.pickedAt !== null || t - vr.stateSince < REASSIGN_AFTER - EPS) return;
  releaseOrder(lg, vr, t, 'vehicle-broken');
  vr.resumeState = 'idle'; // after the repair it finishes its drive (if any) and is free for new orders
  vr.targetId = null;
  vr.spot = -1;
}

function repair(lg, vr, t) {
  setState(vr, vr.resumeState, t);
  vr.resumeState = null;
  vr.tv.disabled = false;
  vr.ttf = vr.rng.exp(vr.cfg.mtbf);
  lg.emit('vehicleUp', { vehicle: vr, vehicleId: vr.id, t });
}
