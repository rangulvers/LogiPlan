// The dock book: which dock of a station a vehicle drives to, and who is using or going to use which dock.
//
// A station has one dock per road cell that touches it. Choosing the dock by route cost alone sends every vehicle to the same
// one (the cheapest) while the others stand free, so vehicles queue on the road in front of it. The book knows for every dock
//   * its OCCUPANT: the vehicle standing on the cell now (loading, unloading, waiting to start, an idle vehicle that stayed, a broken
//     one) or still pulling out of it, and how long that is expected to last;
//   * its RESERVATIONS: the vehicles that have planned a route to stop there (FIFO by the time they planned), with the service time each
//     will need (load or unload time of its fleet plus the turnaround of the cell) and when it is expected to arrive.
// From that, `choose` ranks the docks a vehicle may use by the ESTIMATED TIME TO START SERVICE (`estimate`):
//   travel time along the route
//   + blocking delay: a stopped vehicle (a docked one, an idle 'stay' vehicle) on a cell of the route holds the vehicle up until it
//     has gone - a vehicle cannot pass it in a single lane (this is how several docks lined up on one through lane block each other); one in
//     the other lane of a two-way road does not, one that overhangs a junction cell and holds its lock does
//   + expected wait: what the occupant still needs (an idle vehicle only makes room once the first follower has waited YIELD_AFTER seconds),
//     plus the service times of the reservations that reach the dock before this vehicle,
// and (`rank`) adds the WAY OUT: a farther dock is driven away from again, and a wait on the junction in front of a one-cell spur counts
// double (common.js DOCK_EXIT_WEIGHT / DOCK_BLOCK_WEIGHT / DOCK_MIN_GAIN). A free dock therefore beats an occupied cheaper one whenever the detour
// there and back is shorter than the wait. Ties go to the cheaper route, then the lower node id, so the choice is deterministic. A station with a
// single usable dock is not evaluated at all: behaviour is unchanged. So is a vehicle longer than a cell on docks one cell off the road (`overhangs`).
//
// A reservation is made when the vehicle plans a leg that ends at a dock (vehicles.js planLeg), replaced when it plans again (deadlock
// relocation, charging detour), and released when it arrives (the vehicle is then the occupant), when its order is given back, when it dies
// or is removed. A reservation of a broken or dead vehicle is ignored when estimating (that vehicle will not come soon); a broken vehicle
// that stands on a dock is still the occupant, and the dock counts as taken until it is repaired (dead: for ever).
//
// LATE REBINDING (`rebind`): a vehicle that still drives to its dock looks again every REBIND_INTERVAL seconds, from the first cell of its
// route that lies beyond its braking distance, and switches when another dock reaches service sooner by more than the hysteresis
// (REBIND_MIN_GAIN seconds and REBIND_GAIN_SHARE of its own estimate), at most REBIND_MAX_SWITCHES times per approach. It never turns
// round: the new route continues from that cell over the edge the old route arrived by (TrafficSystem.reroute).
//
// Statistics live here too, as cumulative counters per (station, dock): visits (services started), busy time (a vehicle SERVED on the
// cell: loading, unloading, pulling out), held time (an idle, broken or dead vehicle only stood on it) and wait time (vehicle-seconds that
// vehicles with a reservation for it stood in a queue behind a vehicle on a dock of the same station). js/sim/stats.js reports their window
// deltas.
//
// The book never changes the plant by being looked at: refreshOccupants / status (the renderer calls them every frame) only read the
// vehicles, and `vr.leaving` is forgotten by the simulation itself (forgetLeavers, once per tick).

import {
  DOCK_AHEAD_SLACK, DOCK_CRUISE_SHARE, DOCK_BLOCK_WEIGHT, DOCK_DEAD_WAIT, DOCK_EXIT_WEIGHT, DOCK_MIN_GAIN, DOCK_SHORT_STOP, DOCK_REFERENCE_LENGTH, DOCK_TURNAROUND_DEAD_END,
  DOCK_TURNAROUND_THROUGH, DRIVING_STATES, REBIND_GAIN_SHARE, REBIND_INTERVAL, REBIND_MAX_SWITCHES, REBIND_MIN_GAIN, YIELD_AFTER, num,
} from './common.js';

/** The dock statistics are booked once this many seconds have gone by (every tick for ticks of a second or more), the safety net sweep every SWEEP_EVERY bookings. */
const ACCOUNT_SPAN = 1;
const SWEEP_EVERY = 3;
/** Longest blocking chain followed when looking for the vehicle that holds a queue up. */
const CHAIN_LIMIT = 8;
/** Estimates closer than this (s) are a tie. */
const TIE = 1e-6;

/** What a reservation is for, by the state of the vehicle. */
const KIND_OF_STATE = Object.freeze({ toPickup: 'pickup', toDrop: 'drop', toPark: 'park', toCharger: 'charge' });

export class DockBook {
  /** @param {object} lg the owning Logistics (stations, graph, traffic, routes and vehicles are read lazily) */
  constructor(lg) {
    this.lg = lg;
    /** false: the old static ranking (cheapest returnable dock, no reservations, no rebinding): for comparisons and tests. */
    this.enabled = true;
    this.rebinding = true;
    /** Choice (see common.js): the way out of a farther dock, the weight of a wait on a junction, and the gain needed to leave the cheapest dock (s). */
    this.exitWeight = DOCK_EXIT_WEIGHT;
    this.minGain = DOCK_MIN_GAIN;
    this.blockWeight = DOCK_BLOCK_WEIGHT;
    /** false: vehicles longer than a cell are given the choice on docks one cell off a junction too (see overhangs). */
    this.overhangRule = true;
    /** dock node -> { node, queue: reservation[], occupant: VehicleRT|null }: one per dock cell, shared by the stations that touch it. */
    this.cells = new Map();
    /** station id -> [{ station, node, cell, visits, busy, wait }] in node order (the order of graph.docks): the statistics per dock. */
    this.byStation = new Map();
    for (const st of lg.stations) {
      const list = [];
      for (const node of lg.graph.docks.get(st.id) || []) {
        let cell = this.cells.get(node);
        if (cell === undefined) this.cells.set(node, (cell = { node, queue: [], occupant: null, records: [] }));
        const record = { station: st.id, node, cell, visits: 0, busy: 0, held: 0, wait: 0 };
        cell.records.push(record);
        list.push(record);
      }
      this.byStation.set(st.id, list);
    }
    this.cellList = [...this.cells.values()];
    /** node -> index in cellList (or -1): a typed lookup for the per-tick scan; and the cells that had an occupant at the last tick. */
    this.cellOf = new Int32Array(lg.graph.nodeCount).fill(-1);
    this.cellList.forEach((cell, i) => { this.cellOf[cell.node] = i; });
    /** Per node: 1 = a dock cell, 2 = somebody stands (or pulls out) there at this tick, 4 = a standing vehicle holds its lock; estimates only look at cells that can hold a vehicle up. */
    this.mark = new Uint8Array(lg.graph.nodeCount);
    for (const cell of this.cellList) this.mark[cell.node] = 1;
    this.occupied = [];
    /** node -> the vehicle standing on it (or still pulling out of it) at the start of this tick; built when an estimate needs it (sync). */
    this.standing = new Map();
    /** node -> the vehicle that stands somewhere else but holds the lock of this cell (a vehicle longer than a cell overhangs its neighbours). */
    this.held = new Map();
    /** The vehicles that have left a dock cell and have not yet cleared it (vr.leaving >= 0); the simulation, never the renderer, forgets them. */
    this.leavers = [];
    /** edge -> the broken or dead vehicle stopped on it (nobody passes it until it is repaired). */
    this.stuck = new Map();
    this.now = 0;
    this.tickNo = 0;
    this.pending = 0;
    this.books = 0;
    this.syncedAt = -1;
    this.occupantsAt = -1;
    /** Switches made by late rebinding, in total. */
    this.switches = 0;
    this.scratch = [];
  }

  // ---- bookkeeping per tick ---------------------------------------------------------------------------------------

  /**
   * Start of a logistics tick (before the vehicles act). The statistics of the dock book - busy time and queue time per dock - are booked
   * about once a simulated second for the whole time since the last booking (sample and hold: a second against occupations of tens of
   * seconds). That pass also gives up reservations of vehicles that no longer plan to stop (a safety net: every path that ends a plan
   * releases). The picture of the road that estimates need is built on demand (sync).
   */
  tick(dt, t) {
    this.now = t;
    this.tickNo++;
    this.forgetLeavers();
    this.pending += dt;
    if (this.pending < ACCOUNT_SPAN - 1e-9 || this.cellList.length === 0) return;
    const span = this.pending;
    this.pending = 0;
    const sweep = ++this.books % SWEEP_EVERY === 0;
    const vehicles = this.lg.vehicles;
    for (let i = 0; i < vehicles.length; i++) {
      const vr = vehicles[i];
      const res = vr.dock;
      if (res === null) continue;
      if (sweep && !isPlanning(vr)) this.release(vr);
      else if (vr.tv.waiting && this.waitsForDock(vr, res)) this.slot(res.station, res.node).wait += span;
    }
    this.refreshOccupants(true);
    const { occupied } = this;
    const { graph } = this.lg;
    for (let i = 0; i < occupied.length; i++) {
      const u = occupied[i].occupant;
      const record = this.recordOf(occupied[i], u);
      if (serves(graph, u)) record.busy += span;
      else record.held += span;
    }
  }

  /**
   * A vehicle that has left a dock cell is 'leaving' until its body has cleared the cell. The simulation forgets that at the start of
   * every tick; everything that only looks (refreshOccupants, status, the renderer) tests the same condition without touching the vehicle,
   * so looking at the plant never changes it.
   */
  forgetLeavers() {
    const { leavers } = this;
    if (leavers.length === 0) return;
    const { graph } = this.lg;
    for (let i = leavers.length - 1; i >= 0; i--) {
      const vr = leavers[i];
      if (vr.leaving >= 0 && stillLeaving(graph, vr)) continue;
      vr.leaving = -1;
      leavers[i] = leavers[leavers.length - 1];
      leavers.pop();
    }
  }

  /**
   * Who stands on (or still pulls out of) each dock cell: `cell.occupant` and the list `occupied` of the cells that have one (a cell once, also when
   * a vehicle stands in each lane of it). Done once per tick on demand; `force` looks again (the renderer asks once per frame, the vehicles have moved
   * since the tick began). It only reads the vehicles.
   */
  refreshOccupants(force = false) {
    if (!force && this.occupantsAt === this.tickNo) return;
    this.occupantsAt = this.tickNo;
    const { cellList, cellOf, occupied } = this;
    if (cellList.length === 0) return;
    for (let i = 0; i < occupied.length; i++) occupied[i].occupant = null;
    occupied.length = 0;
    const vehicles = this.lg.vehicles;
    const { graph } = this.lg;
    for (let i = 0; i < vehicles.length; i++) {
      const vr = vehicles[i];
      const tv = vr.tv;
      if (!tv.onRoad) continue;
      let at = -1;
      if (tv.node >= 0) at = cellOf[tv.node];
      else if (vr.leaving >= 0 && stillLeaving(graph, vr)) at = cellOf[vr.leaving];
      if (at >= 0) {
        const cell = cellList[at];
        if (cell.occupant === null) {
          cell.occupant = vr;
          occupied.push(cell);
        } else if (!serves(graph, cell.occupant) && serves(graph, vr)) cell.occupant = vr; // (both lanes of a two-way cell can hold a vehicle: the one in service counts)
      }
    }
  }

  /**
   * The picture of the whole road that estimates need - who stands where (also off the docks) and which broken vehicle stops an edge -
   * built from the vehicles the first time it is asked for in a tick.
   */
  sync() {
    if (this.syncedAt === this.tickNo) return;
    this.syncedAt = this.tickNo;
    this.refreshOccupants();
    const { standing, held, stuck, mark } = this;
    for (const node of standing.keys()) mark[node] &= 1;
    for (const node of held.keys()) mark[node] &= 3;
    standing.clear();
    held.clear();
    stuck.clear();
    const { graph } = this.lg;
    for (const vr of this.lg.vehicles) {
      const tv = vr.tv;
      if (!tv.onRoad) continue;
      if (tv.node >= 0) {
        standing.set(tv.node, vr);
        // a vehicle that stands still holds the locks of the junction cells its body reaches into: nobody passes those either
        const locks = tv._held;
        if (locks !== undefined) for (let k = 0; k < locks.length; k++) if (locks[k] !== tv.node && !held.has(locks[k])) held.set(locks[k], vr);
      } else if (tv.disabled && tv.edge >= 0) stuck.set(tv.edge, vr);
      else if (vr.leaving >= 0 && stillLeaving(graph, vr)) standing.set(vr.leaving, vr);
    }
    for (const node of standing.keys()) mark[node] |= 2;
    for (const node of held.keys()) mark[node] |= 4;
  }

  /** The statistics record of (station, dock node). */
  slot(stationId, node) {
    const cell = this.cells.get(node);
    if (cell !== undefined) for (const r of cell.records) if (r.station === stationId) return r;
    return DUMMY;
  }

  /** The record of a dock cell for the station its occupant works for: its target, else the station it served last, else the first one there. */
  recordOf(cell, u) {
    const records = cell.records;
    if (records.length === 1) return records[0];
    for (const r of records) if (r.station === u.targetId) return r;
    for (const r of records) if (r.station === u.leaveStation) return r;
    return records[0];
  }

  /**
   * Does this vehicle with a reservation stand in a queue for the dock of its station? It is held up (tv.waiting) behind a vehicle
   * that stands on a dock of the same station, directly or through a chain of vehicles that wait in turn.
   */
  waitsForDock(vr, res) {
    const tv = vr.tv;
    if (!tv.onRoad || !tv.waiting) return false;
    const { stationsAt } = this.lg.graph;
    let b = tv.blockedBy;
    for (let k = 0; b && k < CHAIN_LIMIT; k++) {
      // a vehicle on a dock of the station - standing there, or still pulling out of it
      const at = b.node >= 0 ? b.node : b.owner && b.owner.leaving >= 0 && stillLeaving(this.lg.graph, b.owner) ? b.owner.leaving : -1;
      if (at >= 0) {
        const here = stationsAt.get(at);
        if (here !== undefined && here.includes(res.station)) return true;
      }
      b = b.waiting ? b.blockedBy : null;
    }
    return false;
  }

  // ---- reservations -------------------------------------------------------------------------------------------------

  /**
   * The vehicle has planned a route to the dock `node` of `stationId` (it replaces its earlier reservation) and will need `travel` seconds.
   * @returns {object|null} the reservation, or null when `node` is not a dock
   */
  reserve(vr, node, stationId, t, travel, entry = null) {
    this.release(vr);
    const cell = this.cells.get(node);
    const kind = KIND_OF_STATE[vr.state];
    if (cell === undefined || kind === undefined) return null;
    // a station with several docks keeps what the vehicle planned from (the search and the docks it chose between): late rebinding needs
    // no new search, it takes the other routes of the same search tree
    const toId = kind === 'pickup' && vr.order ? vr.order.flow.to.id : null;
    let choices = null;
    if (entry !== null && (this.byStation.get(stationId) || []).length > 1) {
      choices = this.lg.routes.dockChoices(entry, stationId, toId);
      if (this.overhangRule && this.overhangs(vr, entry, choices)) choices = null; // (it keeps to the old rule: nothing to switch to)
    }
    const res = {
      vr, node, station: stationId, kind, service: this.serviceTime(vr, kind, node), eta: t + travel, since: t, nextCheck: t + REBIND_INTERVAL, switches: 0, at: -1, route: null,
      entry: choices !== null ? entry : null, choices,
    };
    vr.dock = res;
    cell.queue.push(res);
    return res;
  }

  /** The vehicle no longer plans to stop at its dock. */
  release(vr) {
    const res = vr.dock;
    if (res === null) return;
    vr.dock = null;
    const queue = this.cells.get(res.node).queue;
    const i = queue.indexOf(res);
    if (i >= 0) queue.splice(i, 1);
  }

  /** The vehicle has reached a dock of its station and starts its service there: one visit, the reservation ends. */
  arrived(vr, node, stationId) {
    this.release(vr);
    this.slot(stationId, node).visits++;
    vr.leaveStation = stationId;
  }

  /** The vehicle's service at the dock under it is over and it is about to leave. */
  leaves(vr, node, t) {
    if (!this.cells.has(node)) return;
    if (vr.leaving < 0) this.leavers.push(vr);
    vr.leaving = node;
    vr.leftAt = t;
  }

  /** The vehicle disappears (removed, or it can never come: released like a finished plan). */
  forget(vr) {
    this.release(vr);
    if (vr.leaving >= 0) {
      vr.leaving = -1;
      const i = this.leavers.indexOf(vr);
      if (i >= 0) this.leavers.splice(i, 1);
    }
  }

  /** Seconds a vehicle needs at the dock once it stands there: the load or unload time plus the turnaround of the cell. */
  serviceTime(vr, kind, node) {
    switch (kind) {
      case 'pickup': return vr.cfg.loadTime + this.turnaround(vr, node);
      case 'drop': return vr.cfg.unloadTime + this.turnaround(vr, node);
      default: return 0; // parking and charging: the vehicle leaves the road on arrival
    }
  }

  /**
   * Seconds the cell stays taken once the service is over: the vehicle pulls away (a dead end: reverses out) and the next one takes its place.
   * Measured as the gap between "service over" and "next vehicle stands" at a saturated dock: it grows with the length of the vehicle, a dead end
   * takes longer than a through lane (AGV 1.2 m: 3.4 s and 8.6 s on a spur of two cells; forklift 2.6 m: 8.4 s and 13 s; tugger 3.5 m: 13 s and 21 s).
   * The constants are those of the AGV preset; the speed slider of the what-if stretches the time.
   */
  turnaround(vr, node) {
    const ratio = Math.max(0.1, num(vr.cfg.body.length, DOCK_REFERENCE_LENGTH) / DOCK_REFERENCE_LENGTH);
    const dead = this.lg.graph.deadEnd[node] === 1;
    const scale = dead ? 0.5 + 0.5 * ratio : Math.pow(ratio, 1.25);
    const slider = Math.min(1.5, Math.max(0.8, Math.pow(Math.max(0.05, num(this.lg.traffic.speedFactor, 1)), -0.5)));
    return (dead ? DOCK_TURNAROUND_DEAD_END : DOCK_TURNAROUND_THROUGH) * Math.max(0.5, scale) * slider;
  }

  // ---- the estimate -----------------------------------------------------------------------------------------------------

  /** Average speed (m/s) used to turn route costs into travel times. */
  cruise(vr) {
    return Math.max(0.05, num(vr.tv.vmax, 1.5) * num(this.lg.traffic.speedFactor, 1) * DOCK_CRUISE_SHARE);
  }

  /**
   * How long (s from now) the vehicle `u`, standing on or pulling out of `node`, will still hold the cell, for a vehicle that reaches the
   * cell `arrive` s from now (an idle vehicle only makes room once somebody waits behind it).
   */
  remaining(u, t, node, arrive = 0) {
    if (u.state === 'dead') return DOCK_DEAD_WAIT;
    if (node >= 0 && u.leaving === node && u.tv.node < 0) return Math.max(0, this.turnaround(u, node) - (t - u.leftAt));
    if (u.state === 'broken') {
      const repair = Math.max(0, num(u.repairLeft, 0));
      return repair + this.stopLeft(u, t, node, u.resumeState || 'idle', Math.max(0, arrive - repair));
    }
    return this.stopLeft(u, t, node, u.state, arrive);
  }

  /** What a vehicle in `state` still needs while it stands on `node` (`arrive`: see remaining). */
  stopLeft(u, t, node, state, arrive = 0) {
    switch (state) {
      case 'loading':
      case 'unloading':
        return Math.max(0, num(u.timer, 0)) + this.turnaround(u, node);
      case 'toPickup':
      case 'toDrop': {
        // arrived and about to start: the whole service; anywhere else it only stands for a moment
        const here = this.lg.graph.stationsAt.get(node);
        if (u.targetId === null || here === undefined || !here.includes(u.targetId)) return DOCK_SHORT_STOP;
        return this.serviceTime(u, state === 'toPickup' ? 'pickup' : 'drop', node);
      }
      case 'toPark':
      case 'toCharger':
        return 0; // it leaves the road on arrival
      case 'idle':
        // it does not move until somebody has waited behind it for YIELD_AFTER seconds; then it pulls out of the cell
        return Math.max(0, arrive) + YIELD_AFTER + this.turnaround(u, node);
      default:
        return DOCK_SHORT_STOP;
    }
  }

  /**
   * Does the vehicle `u`, standing on (or pulling out of) a cell of a two-way road, stand in the other lane than a route that passes the cell
   * over `inEdge` -> `outEdge`? The two lanes do not hold each other up. At a junction (one lock for the whole cell) there is no such thing.
   */
  laneApart(u, inEdge, outEdge) {
    const { graph } = this.lg;
    const tv = u.tv;
    if (tv.node >= 0) {
      if (graph.controlled[tv.node] === 1) return false;
      const arrived = tv.lastEdge >= 0 ? graph.edges[tv.lastEdge] : undefined;
      return arrived !== undefined && arrived.to === tv.node && outEdge === arrived.rev;
    }
    const going = tv.edge >= 0 ? graph.edges[tv.edge] : undefined; // it pulls out over this edge: the other lane brings traffic in over its reverse
    return going !== undefined && graph.controlled[going.from] !== 1 && inEdge === going.rev;
  }

  /** Does a vehicle with the reservation `r` arrive in the other lane than a route that passes the cell over `outEdge`? (see laneApart) */
  arrivesApart(r, node, outEdge) {
    const { graph } = this.lg;
    const route = r.vr.route;
    if (!route || route.edges.length === 0 || graph.controlled[node] === 1) return false;
    const arrived = graph.edges[route.edges[route.edges.length - 1]];
    return arrived !== undefined && arrived.to === node && outEdge === arrived.rev;
  }

  /**
   * When (s from now) the dock of `cell` is free for a vehicle that reaches it `arrive` seconds from now: the occupant's rest, then
   * the reservations that are expected before this vehicle, in the order they arrive. Reservations of broken or dead vehicles and
   * the vehicle's own are ignored. A vehicle that only passes the cell (over `inEdge` -> `outEdge`) is not held up by one in the other lane.
   */
  queueFree(cell, vr, arrive, t, inEdge = -1, outEdge = -1) {
    this.refreshOccupants();
    const passing = inEdge >= 0;
    const ahead = this.scratch;
    ahead.length = 0;
    let first = arrive; // when the first vehicle that waits behind the occupant gets there (s from now)
    for (const r of cell.queue) {
      const u = r.vr;
      if (u === vr || u.state === 'broken' || u.state === 'dead' || u.tv.disabled || u.tv.node === cell.node) continue; // (standing there: the occupant)
      if (passing && this.arrivesApart(r, cell.node, outEdge)) continue;
      if (r.eta - t <= arrive + DOCK_AHEAD_SLACK) {
        ahead.push(r);
        if (r.eta - t < first) first = r.eta - t;
      }
    }
    const occupant = cell.occupant;
    let free = occupant !== null && occupant !== vr && !(passing && this.laneApart(occupant, inEdge, outEdge)) ? this.remaining(occupant, t, cell.node, Math.max(0, first)) : 0;
    if (ahead.length > 1) ahead.sort((a, b) => (a.eta - b.eta) || (a.since - b.since));
    for (const r of ahead) free = Math.max(free, r.eta - t) + r.service;
    return free;
  }

  /**
   * Estimated time (s from now) until `vr` starts its service at `node` when it drives `route` from its edge number `from` on (the clock starts
   * at `offset`, the time for the part of the way not looked at). The sum of travel time, blocking delay and wait described in the header.
   */
  estimate(vr, route, node, t, offset = 0, from = 0) {
    this.sync();
    const { baseCost } = this.lg.graph; // seconds per metre of speed: length / limit
    const inv = 1 / this.cruise(vr);
    const { edges, nodes } = route;
    const last = edges.length - 1;
    if (last < 0 && vr.tv.node === node) return offset; // it stands on this dock already: whoever has reserved it comes after it
    const { mark, stuck, held, standing, cells } = this;
    const anyStuck = stuck.size > 0;
    let clock = offset;
    for (let i = from; i <= last; i++) {
      clock += baseCost[edges[i]] * inv;
      if (anyStuck) {
        const b = stuck.get(edges[i]);
        if (b !== undefined && b !== vr) clock = Math.max(clock, this.remaining(b, t, -1));
      }
      if (i < last && mark[nodes[i + 1]] !== 0) { // a cell in the middle of the way: whoever stands there, or will stop there before this vehicle passes, holds it up
        const here = nodes[i + 1];
        const bits = mark[here];
        const cell = cells.get(here);
        if (cell !== undefined && cell.queue.length > 0) clock = Math.max(clock, this.queueFree(cell, vr, clock, t, edges[i], edges[i + 1]));
        else if ((bits & 2) !== 0) {
          const u = standing.get(here);
          if (u !== undefined && u !== vr && !this.laneApart(u, edges[i], edges[i + 1])) clock = Math.max(clock, this.remaining(u, t, here, clock));
        }
        if ((bits & 4) !== 0) { // a long vehicle that stands on a spur still holds the junction cell it overhangs
          const u = held.get(here);
          if (u !== undefined && u !== vr) clock = Math.max(clock, this.remaining(u, t, u.tv.node, clock));
        }
      }
    }
    if ((mark[node] & 4) !== 0) {
      const u = held.get(node);
      if (u !== undefined && u !== vr) clock = Math.max(clock, this.remaining(u, t, u.tv.node, clock));
    }
    return Math.max(clock, this.queueFree(cells.get(node), vr, clock, t));
  }

  /** Travel time (s) along the edges `from..to-1` of a route, the first one from position `s`. */
  travelAlong(vr, route, from, to, s = 0) {
    const { graph } = this.lg;
    const speed = this.cruise(vr);
    let time = 0;
    for (let i = from; i < to; i++) {
      const e = graph.edges[route.edges[i]];
      time += (i === from ? Math.max(0, e.length - s) : e.length) / (e.limit * speed);
    }
    return time;
  }

  // ---- the choice -------------------------------------------------------------------------------------------------------

  /**
   * The dock of `stationId` a vehicle standing at `entry`'s start should drive to: among the docks it can get to and back from (and, for a
   * pickup, from which `toId` can still be reached) the one with the smallest estimated time to start service. Ties: cheaper route, lower node.
   * @returns {object|null} a dock of routes.docksOf (`{ node, dist, back, arrivalEdge }`), or null when none can be reached
   */
  choose(vr, entry, stationId, toId, t) {
    const { routes } = this.lg;
    const list = routes.dockChoices(entry, stationId, toId);
    if (list.length === 0) return null;
    let best = list[0];
    if (this.enabled && list.length > 1 && !(this.overhangRule && this.overhangs(vr, entry, list))) {
      const inv = 1 / this.cruise(vr);
      let near = Infinity; // the shortest route of the choices (s at cruise speed): what the way out of a farther dock adds is measured from it
      for (const dock of list) near = Math.min(near, routes.baseTimeOfDock(entry, dock));
      let bestCost = Infinity;
      let firstCost = Infinity;
      for (let i = 0; i < list.length; i++) {
        const dock = list[i];
        const route = routes.routeOfDock(entry, dock);
        if (route === null) continue;
        const cost = this.rank(vr, route, dock.node, t, this.exitWeight * Math.max(0, routes.baseTimeOfDock(entry, dock) - near) * inv);
        if (i === 0) firstCost = cost;
        if (cost < bestCost - TIE) { best = dock; bestCost = cost; }
      }
      // the cheapest route is left only for a clear gain
      if (best !== list[0] && firstCost - bestCost <= this.minGain) best = list[0];
    }
    routes.arrivalEdgeAt(entry, best);
    return best;
  }

  /**
   * Does this vehicle keep to the old rule (the nearest dock, no switching on the way) for this choice? A vehicle longer than a cell that
   * docks on a spur of one cell overhangs the junction in front of the dock and holds its lock (the validator warns about such fleets). Sent to
   * the farther docks of a comb of such spurs, these vehicles meet each other at the junctions of the main road and jam it, whatever the
   * estimate says: on 72 comb plants of tuggers and forklifts (30 min each) the dock choice without this rule made 5 of them more than 10 % worse
   * (four gridlocked: 1 or 2 loads against 48 to 55, 75 to 81 deadlocks) while it delivered 20 % more overall; with the rule none is more than
   * 10 % worse, there are 498 deadlocks against the old rule's 867 and the overall gain is 25 %. On spurs of two cells or more the vehicles stay
   * clear of the junction and use the dock choice.
   */
  overhangs(vr, entry, list) {
    const { graph, routes } = this.lg;
    if (!(vr.tv.length > graph.cellSize + 1e-9)) return false;
    for (const dock of list) {
      const route = routes.routeOfDock(entry, dock);
      if (route !== null && route.nodes.length >= 2 && graph.controlled[route.nodes[route.nodes.length - 2]] === 1) return true;
    }
    return false;
  }

  /**
   * What a second of waiting for the dock at the end of `route` costs, in seconds of driving: a vehicle that has to wait stands on the cell
   * before the dock, and when that is a junction (a dock one cell off the main road) it holds up everybody who wants to pass, so the wait
   * costs more than the vehicle's own time. On a spur of two or more cells it waits out of the way.
   */
  waitWeightOf(route) {
    const n = route.nodes.length;
    return n >= 2 && this.lg.graph.controlled[route.nodes[n - 2]] === 1 ? this.blockWeight : 1;
  }

  /**
   * The cost a dock is ranked by: the estimated time to start service (estimate), with the part of it that is spent waiting weighted by
   * waitWeightOf, plus `extra` seconds for the way out. `offset` and `from` as in estimate.
   */
  rank(vr, route, node, t, extra, offset = 0, from = 0) {
    const est = this.estimate(vr, route, node, t, offset, from);
    const w = this.waitWeightOf(route);
    if (w === 1) return est + extra;
    const { baseCost } = this.lg.graph;
    const inv = 1 / this.cruise(vr);
    let travel = offset;
    for (let i = from; i < route.edges.length; i++) travel += baseCost[route.edges[i]] * inv;
    return travel + w * Math.max(0, est - travel) + extra;
  }

  // ---- late rebinding ----------------------------------------------------------------------------------------------------

  /**
   * A vehicle that still drives to its dock looks for a better one (called by the vehicle every REBIND_INTERVAL seconds). It considers the
   * docks it chose between when it planned, along the routes of the same search tree, and only those that part from its route beyond the
   * first cell from which it can still turn (braking distance and two cells ahead).
   * @returns {boolean} true when the vehicle was given a new route
   */
  rebind(vr, t) {
    const res = vr.dock;
    if (res === null) return false;
    res.nextCheck = t + REBIND_INTERVAL;
    if (res.choices === null) return false; // one dock: nothing to choose from
    const { lg } = this;
    const { traffic, routes, graph } = lg;
    const tv = vr.tv;
    const route = vr.route;
    if (!this.enabled || !this.rebinding || typeof traffic.reroute !== 'function' || route === null || !tv.driving || tv.disabled) return false;
    const ri = tv.edge >= 0 ? edgeIndex(route, tv.edge, res) : -1;
    if (ri < 0) return false;
    const L = graph.cellSize;
    const n = route.edges.length;
    res.eta = t + ((n - ri) * L - tv.s) / this.cruise(vr);
    if (res.switches >= REBIND_MAX_SWITCHES) return false; // it switched already
    // the first cell of the route from which a different way can still be taken: beyond the braking distance and two cells
    const need = (tv.v * tv.v) / (2 * tv.decel) + 2 * L + tv.length;
    let j = ri + 1;
    let ahead = L - tv.s;
    while (j < n && ahead < need) { j++; ahead += L; }
    if (j >= n) return false; // too late
    const lead = this.travelAlong(vr, route, ri, j, tv.s);
    // the way out of a dock that lies farther than the nearest one costs extra, as in choose()
    const inv = 1 / this.cruise(vr);
    let near = Infinity;
    for (const dock of res.choices) near = Math.min(near, routes.baseTimeOfDock(res.entry, dock));
    const exitOf = (dock) => this.exitWeight * Math.max(0, routes.baseTimeOfDock(res.entry, dock) - near) * inv;
    const here = res.choices.find((dock) => dock.node === res.node);
    const exitNow = here === undefined ? 0 : exitOf(here);
    // the dock it drives to: unless something holds it up there by more than the hysteresis (the time it needs from here is about
    // lead + the rest of the route), or it is a far one whose way out a nearer one would save, no other dock can save enough
    const cur = this.rank(vr, route, res.node, t, exitNow, lead, j);
    if (cur - lead - ((n - j) * L) / this.cruise(vr) < REBIND_MIN_GAIN) return false;
    let best = null;
    let bestRoute = null;
    let bestCost = cur;
    for (const dock of res.choices) {
      if (dock.node === res.node) continue;
      const r = routes.routeOfDock(res.entry, dock);
      if (r === null || !sharesStart(route, r, j)) continue;
      if (r.edges.length > n && sharesStart(route, r, n)) continue; // it passes the dock the vehicle drives to now: no better than that one
      const cost = this.rank(vr, r, dock.node, t, exitOf(dock), lead, j);
      if (cost < bestCost - TIE) { best = dock; bestRoute = r; bestCost = cost; }
    }
    if (best === null || cur - bestCost <= Math.max(REBIND_MIN_GAIN, REBIND_GAIN_SHARE * cur)) return false;
    if (!traffic.reroute(tv, bestRoute)) return false;
    vr.route = bestRoute;
    for (let k = j; k < bestRoute.nodes.length; k++) lg.routeUse[bestRoute.nodes[k]]++;
    this.moveReservation(res, best.node, vr, t, this.travelAlong(vr, bestRoute, ri, bestRoute.edges.length, tv.s));
    res.switches++;
    this.switches++;
    return true;
  }

  /** The reservation now belongs to another dock of the same station. */
  moveReservation(res, node, vr, t, travel) {
    const from = this.cells.get(res.node).queue;
    const i = from.indexOf(res);
    if (i >= 0) from.splice(i, 1);
    res.node = node;
    res.kind = KIND_OF_STATE[vr.state] || res.kind;
    res.service = this.serviceTime(vr, res.kind, node);
    res.eta = t + travel;
    this.cells.get(node).queue.push(res);
  }

  // ---- views --------------------------------------------------------------------------------------------------------------

  /**
   * What a dock looks like right now, for the overlay and the dashboard: 'occupied' (a vehicle stands on it), 'reserved' (a vehicle
   * is on its way to it) or 'free'.
   */
  status(node) {
    this.refreshOccupants();
    const cell = this.cells.get(node);
    if (cell === undefined) return 'free';
    if (cell.occupant !== null) return 'occupied';
    return cell.queue.length > 0 ? 'reserved' : 'free';
  }

  /** Cumulative counters of every dock of a station, in node order: `{ node, visits, busy, held, wait }` (seconds; busy = in service, held = taken by an idle or broken vehicle). */
  counters(stationId) {
    return (this.byStation.get(stationId) || []).map((d) => ({ node: d.node, visits: d.visits, busy: d.busy, held: d.held, wait: d.wait }));
  }
}

/** Counter record for a (station, node) pair that is not a dock (never happens for a valid layout; keeps the hot path branch-free). */
const DUMMY = { station: '', node: -1, cell: null, visits: 0, busy: 0, held: 0, wait: 0 };

/** Is the vehicle on its way to a dock (or about to arrive at one)? A reservation of a vehicle that is not is a leak. */
export function isPlanning(vr) {
  const state = vr.state === 'broken' ? vr.resumeState : vr.state;
  if (!DRIVING_STATES.has(state) || vr.spot >= 0 || vr.targetId === null) return false;
  return vr.tv.driving || vr.replan || vr.arrived;
}

/**
 * Is the vehicle using the dock it stands on (or pulls out of)? It loads or unloads, has just arrived and is about to start, or is still
 * pulling out after the service. An idle vehicle that stays, a broken or a dead one only takes the cell (it holds others up, but the dock does no work).
 */
export function serves(graph, u) {
  if (u.tv.node < 0) return true;
  switch (u.state) {
    case 'loading':
    case 'unloading':
      return true;
    case 'toPickup':
    case 'toDrop':
    case 'toPark':
    case 'toCharger': {
      const here = graph.stationsAt.get(u.tv.node);
      return u.targetId !== null && here !== undefined && here.includes(u.targetId);
    }
    default:
      return false;
  }
}

/** Do the routes have their first `count` edges in common (so a vehicle that drives `a` can still take `b` from there)? */
function sharesStart(a, b, count) {
  if (a === b) return true;
  if (b.edges.length < count) return false;
  for (let i = 0; i < count; i++) if (a.edges[i] !== b.edges[i]) return false;
  return true;
}

/** Index of `edge` on a route; the last answer (kept on the reservation) is the place to start looking, a vehicle only moves forward. */
function edgeIndex(route, edge, res) {
  const edges = route.edges;
  let i = res.at >= 0 && res.route === route ? res.at : 0;
  while (i < edges.length && edges[i] !== edge) i++;
  if (i >= edges.length) i = edges.indexOf(edge);
  res.at = i;
  res.route = route;
  return i;
}

/** The vehicle left service on a dock cell and its body has not yet cleared the cell. */
function stillLeaving(graph, vr) {
  const tv = vr.tv;
  if (!tv.driving || tv.edge < 0) return false;
  const edge = graph.edges[tv.edge];
  return edge !== undefined && edge.from === vr.leaving && tv.s < graph.cellSize / 2 + tv.length / 2 + 0.3;
}

/**
 * Consistency of the dock book with the vehicles; the tests call it after every tick. Returns the problems found (empty when fine):
 * every reservation belongs to a vehicle that is on its way to a dock of that station, is queued exactly once at its own dock, and
 * every vehicle that is on its way to a dock has its reservation.
 * @param {object} lg a Logistics
 * @returns {string[]}
 */
export function checkDockInvariants(lg) {
  const problems = [];
  const book = lg.docks;
  const alive = new Set(lg.vehicles);
  let queued = 0;
  for (const cell of book.cellList) {
    const seen = new Set();
    for (const res of cell.queue) {
      queued++;
      const vr = res.vr;
      if (!alive.has(vr)) problems.push(`reservation at ${cell.node} of a vehicle that no longer exists (${vr.id})`);
      if (vr.dock !== res) problems.push(`${vr.id}: the reservation at ${cell.node} is not the vehicle's own`);
      if (res.node !== cell.node) problems.push(`${vr.id}: queued at ${cell.node} but reserved for ${res.node}`);
      if (seen.has(vr)) problems.push(`${vr.id}: queued twice at ${cell.node}`);
      seen.add(vr);
      if (!isPlanning(vr)) problems.push(`${vr.id}: holds a reservation at ${cell.node} but is in state ${vr.state} (${vr.tv.driving ? 'driving' : 'standing'})`);
      else if (!(lg.graph.stationsAt.get(res.node) || []).includes(vr.targetId)) problems.push(`${vr.id}: reservation at ${res.node} is not a dock of ${vr.targetId}`);
    }
  }
  let reserved = 0;
  for (const vr of lg.vehicles) {
    if (vr.dock !== null) reserved++;
    else if (isPlanning(vr) && vr.state !== 'broken' && vr.tv.driving) problems.push(`${vr.id}: drives to ${vr.targetId} (${vr.state}) without a dock reservation`);
  }
  if (reserved !== queued) problems.push(`${reserved} vehicles hold a reservation but ${queued} are queued`);
  return problems;
}

// ---- when one dock does all the work -----------------------------------------------------------------------------------

/** A station's visits in the window must reach this many before their distribution over its docks means anything. */
export const SKEW_MIN_VISITS = 20;
/** One dock takes at least this share of the visits... */
export const SKEW_SHARE = 0.75;
/** ...while another one gets at most this share. */
export const SKEW_QUIET_SHARE = 0.15;
/** ...and vehicles wait at least this long (s) per visit for a dock of the station: without waiting the imbalance costs nothing. */
export const SKEW_MIN_WAIT_PER_VISIT = 5;

/** Reasons a quiet dock stays unused. */
const SKEW_REASONS = Object.freeze(['trap', 'lane', 'detour']);
const reasonCache = new WeakMap();

/**
 * Is one dock of a station used far more than another although vehicles wait for docks of that station, and why? Called by the
 * statistics with the docks of the KPI report ({ node, cx, cy, visits, busyShare, waitBefore }).
 * @param {object} graph the road graph
 * @param {Array<object>} docks KPI dock records of one station
 * @param {number} waitTotal the station's dockWaitTotal (vehicle-seconds)
 * @returns {null|{ busy: object, quiet: object[], reason: 'trap'|'lane'|'detour', waitPerVisit: number }}
 */
export function dockSkew(graph, docks, waitTotal) {
  if (docks.length < 2) return null;
  let visits = 0;
  let top = docks[0];
  for (const d of docks) {
    visits += d.visits;
    if (d.visits > top.visits) top = d;
  }
  if (visits < SKEW_MIN_VISITS || top.visits < SKEW_SHARE * visits || waitTotal < SKEW_MIN_WAIT_PER_VISIT * visits) return null;
  const quiet = docks.filter((d) => d !== top && d.visits <= SKEW_QUIET_SHARE * visits);
  if (quiet.length === 0) return null;
  const share = (d) => ({ node: d.node, cx: d.cx, cy: d.cy, share: d.visits / visits });
  return { busy: share(top), quiet: quiet.map(share), reason: explainDockSkew(graph, top.node, quiet.map((d) => d.node)), waitPerVisit: waitTotal / visits };
}

/**
 * Why do vehicles avoid the dock cells `quiet` in favour of `busy`? 'trap': a vehicle that drives to one cannot get back (a one-way dead end,
 * or it cannot be reached at all), so it is only ever a last resort; 'lane': `busy` lies on the only way to it (docks lined up on one
 * lane: whoever stands on the first blocks the others); 'detour': it can be reached freely but lies farther away, so it pays only when the
 * wait for the nearer dock is longer than the extra drive.
 */
export function explainDockSkew(graph, busy, quiet) {
  let cache = reasonCache.get(graph);
  if (cache === undefined) reasonCache.set(graph, (cache = new Map()));
  const key = `${busy}>${quiet.join(',')}`;
  let reason = cache.get(key);
  if (reason === undefined) {
    reason = 'detour';
    for (const q of quiet) {
      if (!graph.sameScc(q, busy)) { reason = 'trap'; break; }
    }
    if (reason === 'detour') for (const q of quiet) if (isShadowed(graph, q, busy)) { reason = 'lane'; break; }
    cache.set(key, reason);
  }
  return SKEW_REASONS.includes(reason) ? reason : 'detour';
}

/** Does every way from the rest of the road network to `node` pass `through`? (Less than half of the network is reachable without it.) */
function isShadowed(graph, node, through) {
  const seen = new Uint8Array(graph.nodeCount);
  seen[node] = 1;
  seen[through] = 1;
  const queue = [node];
  let reached = 1;
  for (let h = 0; h < queue.length; h++) {
    const v = queue[h];
    for (const e of graph.out[v]) {
      const w = graph.edges[e].to;
      if (!seen[w]) { seen[w] = 1; reached++; queue.push(w); }
    }
    for (const e of graph.in[v]) {
      const w = graph.edges[e].from;
      if (!seen[w]) { seen[w] = 1; reached++; queue.push(w); }
    }
  }
  return reached * 2 < graph.nodes.length;
}
