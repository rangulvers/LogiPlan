// Vehicle motion engine: moves vehicles along routes with collision avoidance, lanes, controlled-cell locks and
// deadlock handling. Knows nothing about loads, stations or orders. Contract: docs/ARCHITECTURE.md §5.2.
//
// Model (the details live in js/sim/traffic/*.js)
//  * One reference point per vehicle = its centre; the vehicle is a rectangle length x width around it. The position
//    along the route is 1-D (edge + s); poses (x, y, heading) come from lane lines and smooth corner curves.
//  * Every tick is PLANNED for all vehicles from the start-of-tick state and only then APPLIED, so results do not
//    depend on vehicle order. Per-edge ordered lane lists give each vehicle its leader (the rear-most vehicle of the
//    edges ahead, parked vehicles on node centres, vehicles that left the lane but whose tail is still in it). The
//    advance is hard-clamped to (gap - headway); speed targets follow v^2 <= 2 * decel * (gap - headway + the leader's
//    braking distance), the leader credited with at most the follower's own deceleration.
//  * Controlled cells (zone blocking): a vehicle needs the lock of a cell while ANY part of its footprint overlaps it.
//    It stops at a stop line before the cell and requests the lock when that line is within braking distance; grants
//    are FIFO among requests that can proceed, atomically for the cell and every further lockable cell (junction or
//    bend) the vehicle could end up waiting in front of while its rear is still inside the last one (no hold-and-wait),
//    and only if there is room beyond the exit of the last cell for the vehicle's length + headway (no box-blocking).
//    The lock is released when the rear passes the cell exit. Parked vehicles hold the lock of their cell. A plain
//    bend (corner) is lockable: it is locked while somebody is parked in it, by a vehicle that has it in its chain,
//    and by a vehicle longer than a cell that turns in it.
//  * Long vehicles (longer than a cell) swing wide of their lane when they turn: the rear of a rigid body sweeps into
//    the opposite lane. They therefore lock the cell they turn in, wait until no vehicle is within reach of the swing,
//    and every stop line keeps the nose of the longest vehicle clear (standoff = headway + length / 2).
//  * In-place manoeuvres (v = 0): a U-turn at a dead end, and easing onto the lane line when a route starts from the
//    centre line or from the lane of another road. They take time; the vehicle keeps its locks and is an obstacle. A
//    manoeuvre only advances while the final pose keeps the headway to what is ahead and the swept bodies stay clear of
//    every other vehicle (also of those approaching); a long vehicle first locks all junctions and bends around it.
//  * Deadlocks: once a second the wait-for graph (tv.blockedBy) is searched for cycles. A cycle whose members all
//    waited >= deadlockTime is a deadlock (counted and reported once per membership); with resolveDeadlocks the
//    longest-waiting member that holds up the fewest others is relocated to a free node.
//  * Placing a vehicle (addVehicle, attach, relocate, findFreeNode) needs room for its body AND that every vehicle
//    driving towards the node can still stop in front of it with its own deceleration.
//
// Approximations and limits
//  * Verified (independent fuzz, all invariants on every tick, dt 0.1 .. 0.5 s, 2 m cells): vehicles up to 1.75 cells long
//    (the tugger preset), up to 2 cells on street layouts. Longer vehicles keep lane order and locks but may come closer
//    than the headway or overlap. Vehicles up to one cell long do not lock their turns: in dense traffic their bodies can
//    overlap by up to 0.3 m for an instant in a corner (about 0.1 m in the shipped examples), and two vehicles on
//    neighbouring nodes can be closer than the headway when their average length exceeds 0.75 cells (cell - length).
//    Vehicles longer than a cell lock stretches of road at once (see the chain above) and so meet the limits of exclusive
//    locks more often.
//  * Locks are per cell and exclusive: two vehicles that want each other's cell - docked on adjacent junctions or
//    bends and sent to swap places, or a ring with every cell taken - cannot be untied by the protocol. They are
//    reported as deadlocks after deadlockTime and resolved by relocation. Dense blocks of junction cells (every cell a
//    crossing) deadlock far more often than street layouts, because each vehicle locks its way through the block.
//  * Corners are shorter than the abstract 2 * (half cell) they stand for; followers add the difference between the
//    two centres to their gap, plus a small capped allowance for the rigid bodies.
//  * A vehicle with a route has node = -1 even while it still stands on its start node (node >= 0 means parked).
//  * The `rng` option is accepted for API compatibility; the engine is deterministic without randomness.

import { Geometry } from './traffic/geometry.js';
import { TV } from './traffic/vehicle.js';
import { MOVING_SPEED, stoppingDistance } from './traffic/kinematics.js';
import { evaluateRequest, evaluateSpin, scanAhead, grantLocks, releaseAll, cancelRequest } from './traffic/scan.js';
import { planMotion, applyMotion, laneRemove } from './traffic/motion.js';
import { findWaitCycles, cycleKey, isStandingDeadlock, pickVictim } from './traffic/deadlock.js';

const DEADLOCK_CHECK_INTERVAL = 1; // s between wait-for graph searches
const WAIT_SPEED_SHARE = 0.5; // a held-back vehicle is "waiting" below this share of its free speed
const BROKEN_CHAIN_LIMIT = 64; // longest blocking chain followed when looking for a breakdown behind a queue

/** Uncontrolled cells that have a perpendicular movement (two-way corners, one-way bends). */
function findBends(graph) {
  const bend = new Uint8Array(graph.nodeCount);
  for (const v of graph.nodes) {
    if (graph.controlled[v] === 1) continue;
    for (const i of graph.in[v]) {
      if (graph.out[v].some((o) => ((graph.edges[i].dir - graph.edges[o].dir) & 1) === 1)) { bend[v] = 1; break; }
    }
  }
  return bend;
}

export class TrafficSystem {
  /**
   * @param {object} graph road graph (js/sim/graph.js)
   * @param {object} [opts] { headway = 0.5 (min bumper gap, m), handedness = 'right', deadlockTime = 20 (s),
   *   resolveDeadlocks = true, rng }
   */
  constructor(graph, opts = {}) {
    this.graph = graph;
    this.headway = Number.isFinite(opts.headway) && opts.headway >= 0 ? opts.headway : 0.5;
    this.handedness = opts.handedness === 'left' ? 'left' : 'right';
    this.deadlockTime = Number.isFinite(opts.deadlockTime) && opts.deadlockTime >= 0 ? opts.deadlockTime : 20;
    this.resolveDeadlocks = opts.resolveDeadlocks !== false;
    this.vehicles = [];
    this.time = 0;
    this.speedFactor = 1;
    this.onArrive = () => {};
    this.onDeadlock = () => {};
    this.activeDeadlocks = [];
    this.stats = {
      edgePasses: new Int32Array(graph.edges.length),
      edgeWait: new Float64Array(graph.edges.length),
      nodeWait: new Float64Array(graph.nodeCount),
      waitVehicle: 0, waitJunction: 0, waitBroken: 0, deadlocks: 0, totalWait: 0, drivingTime: 0,
    };

    this.L = graph.cellSize;
    this.swingLength = graph.cellSize; // vehicles longer than a cell swing wide in corners and lock their turns
    this.r = graph.cellSize / 2;
    this._edges = graph.edges;
    this._out = graph.out;
    this.geo = new Geometry(graph, this.handedness);
    this._lanes = graph.edges.map(() => []); // per edge: vehicles on it, front-most (largest _ls) first
    this._fresh = new Array(graph.nodeCount).fill(undefined); // per node: parked vehicles on the node centre (no lane offset)
    this._lock = new Array(graph.nodeCount).fill(null); // per node: the vehicle holding its lock (mostly controlled nodes)
    this._bend = findBends(graph); // uncontrolled cells where the path turns (a parked vehicle there blocks the cell)
    this._lockable = graph.controlled.map((c, i) => c | this._bend[i]); // cells that can need a lock
    this._pending = []; // vehicles with an outstanding lock request, oldest first
    this._active = [];
    this._arrived = [];
    this._events = [];
    this._known = new Map(); // standing deadlocks already reported
    this._nextDeadlockCheck = DEADLOCK_CHECK_INTERVAL;
    this._pose = { x: 0, y: 0, h: 0 };
    this._maxLength = 1;
    this._maxSpeed = 0; // highest vmax of any vehicle (bound for neighbourhood searches)
    this.standoff = this._standoff(); // stop-line distance before a locked cell (grows with the longest vehicle)
    this._seq = 0;
  }

  // ---- vehicles -------------------------------------------------------------------------------------------

  /**
   * Distance between the front bumper of a vehicle waiting for a lock and the boundary of the cell: one headway to
   * whatever is inside, plus - when vehicles longer than a cell exist, which swing wide as they turn in the cell -
   * the reach of the nose of the longest one beyond the boundary of the cell (half its length).
   */
  _standoff() {
    return this.headway + (this._maxLength > this.swingLength ? this._maxLength / 2 : 0);
  }

  /**
   * Add a vehicle, stationary on the centre of `node`.
   * @param {object} spec { id, length, speed, accel, decel, node, owner?, width?, heading? }
   * @returns {TV|null} null if the node is not a road cell or there is no room for the vehicle
   */
  addVehicle(spec) {
    const node = spec.node;
    if (!Number.isInteger(node) || node < 0 || node >= this.graph.nodeCount || !this.graph.isNode[node]) return null;
    const tv = new TV(spec, this.L);
    if (!this._roomAt(node, tv.length, null)) return null;
    tv._seq = this._seq++;
    tv.heading = Number.isFinite(spec.heading) ? spec.heading : this._defaultHeading(node);
    this._maxLength = Math.max(this._maxLength, tv.length);
    this._maxSpeed = Math.max(this._maxSpeed, tv.vmax);
    this.standoff = this._standoff();
    this.vehicles.push(tv);
    this._placeFresh(tv, node);
    return tv;
  }

  /** Remove a vehicle for good. */
  removeVehicle(tv) {
    const i = this.vehicles.indexOf(tv);
    if (i < 0) return false;
    this._unregister(tv);
    this.vehicles.splice(i, 1);
    tv.onRoad = false;
    this._forget(tv);
    return true;
  }

  /** Lift a vehicle off the road (parked inside a depot): frees its lane position and locks, cancels any route. */
  detach(tv) {
    if (!tv.onRoad) return;
    this._unregister(tv);
    tv.onRoad = false;
    this._forget(tv);
    tv.node = -1;
    tv.edge = -1;
    tv.s = 0;
    tv.v = 0;
    tv.moving = false;
    tv.driving = false;
    this._clearWaiting(tv);
  }

  /** Is there room on `node` for a vehicle (of the longest length seen so far)? */
  canAttach(node) {
    return Number.isInteger(node) && node >= 0 && node < this.graph.nodeCount && this.graph.isNode[node] === 1
      && this._roomAt(node, this._maxLength, null);
  }

  /** Put a detached vehicle back on the centre of `node`; false if there is no room (or it is already on the road). */
  attach(tv, node) {
    const valid = Number.isInteger(node) && node >= 0 && node < this.graph.nodeCount && this.graph.isNode[node] === 1;
    if (tv.onRoad || !valid || !this.vehicles.includes(tv) || !this._roomAt(node, tv.length, tv)) return false;
    tv.onRoad = true;
    this._placeFresh(tv, node);
    return true;
  }

  /** Teleport a vehicle to a free node (deadlock resolution); its route is cleared. */
  relocate(tv, node) {
    if (!tv.onRoad || !Number.isInteger(node) || node < 0 || node >= this.graph.nodeCount || !this.graph.isNode[node]) return false;
    if (!this._roomAt(node, tv.length, tv)) return false;
    this._unregister(tv);
    this._forget(tv);
    this._placeFresh(tv, node);
    return true;
  }

  /**
   * Start driving `route` ({ nodes, edges }). The vehicle must be parked on route.nodes[0]. A route without edges
   * keeps the vehicle where it is; onArrive then fires during the next step().
   * @returns {boolean} false if the vehicle or the route is not valid for this call
   */
  drive(tv, route) {
    const edges = this.graph.edges;
    if (!tv.onRoad || tv.driving || tv.node < 0 || !route || !Array.isArray(route.nodes) || !Array.isArray(route.edges)) return false;
    if (route.nodes[0] !== tv.node || route.nodes.length !== route.edges.length + 1) return false;
    for (let i = 0; i < route.edges.length; i++) {
      const e = edges[route.edges[i]];
      if (e === undefined || e.from !== route.nodes[i] || e.to !== route.nodes[i + 1]) return false;
    }
    tv.driving = true;
    tv._route = route.edges.slice();
    tv._nodes = route.nodes.slice();
    tv._ri = 0;
    if (tv._route.length === 0) return true;
    const first = tv._route[0];
    const parkedLane = tv._lane;
    this._leaveParked(tv);
    tv._prev = parkedLane;
    tv._x0 = tv.x;
    tv._y0 = tv.y;
    tv._h0 = tv.heading;
    tv._ext = this._extension(tv);
    this._resolveHolds(tv);
    tv.node = -1;
    tv.edge = first;
    tv.s = 0;
    tv.lastEdge = first;
    tv._lane = first;
    tv._ls = 0;
    // an in-place manoeuvre first: a U-turn when the route leaves the way it came, otherwise easing onto the lane
    // line (from the centre line, or from the lane of another road)
    const uTurn = parkedLane >= 0 && this.geo.isReversal(parkedLane, first);
    tv._turn = uTurn || this.geo.easeLength(tv.x, tv.y, tv.heading, first) > 1e-3 ? 0 : -1;
    this._lanes[first].push(tv);
    this.stats.edgePasses[first]++;
    return true;
  }

  /**
   * Give a driving vehicle another way on, from a cell it has not reached yet, without stopping it (late dock choice, js/sim/logistics/docks.js).
   * `route` is the complete new route: it starts where the old one did and has the old edges as far as the cell where the two part, which
   * must lie beyond the vehicle's braking distance and two more cells, so whatever the new way holds (a stop line, a corner, the final stop) can
   * still be met with the vehicle's own deceleration. It must be a legal continuation (no U-turn except at a dead end). Locks the vehicle
   * holds on cells the new route does not use are let go (its body is not in them), the others and its place in a lock queue stay.
   * @returns {boolean} false, and nothing changed, if the vehicle cannot take this route now (not driving, turning in place, too close)
   */
  reroute(tv, route) {
    if (!tv.onRoad || !tv.driving || tv._route === null || tv._turn >= 0 || !route || !Array.isArray(route.nodes) || !Array.isArray(route.edges)) return false;
    const edges = this.graph.edges;
    const old = tv._route;
    if (route.edges.length === 0 || route.nodes.length !== route.edges.length + 1 || route.nodes[0] !== tv._nodes[0]) return false;
    for (let i = 0; i < route.edges.length; i++) {
      const e = edges[route.edges[i]];
      if (e === undefined || e.from !== route.nodes[i] || e.to !== route.nodes[i + 1]) return false;
    }
    let keep = 0; // edges the two routes have in common
    while (keep < old.length && keep < route.edges.length && old[keep] === route.edges[keep]) keep++;
    if (keep <= tv._ri) return false; // the edge the vehicle is on must stay
    if (keep === old.length && keep === route.edges.length) return true; // the same route
    if (keep * this.L - (tv._ri * this.L + tv.s) < stoppingDistance(tv.v, tv.decel) + 2 * this.L + tv.length) return false;
    if (keep < route.edges.length) { // no turning round in mid-road at the cell where the routes part
      const from = edges[route.edges[keep - 1]];
      if (from.rev === route.edges[keep] && this.graph.out[from.to].length > 1) return false;
    }
    tv._route = route.edges.slice();
    tv._nodes = route.nodes.slice();
    tv._ext = this._extension(tv);
    const used = new Set(tv._nodes);
    for (const e of tv._ext) used.add(edges[e].to);
    for (let k = tv._held.length - 1; k >= 0; k--) {
      const node = tv._held[k];
      if (used.has(node)) continue;
      if (this._lock[node] === tv) this._lock[node] = null;
      tv._held.splice(k, 1);
      tv._heldQ.splice(k, 1);
    }
    return true;
  }

  /**
   * Closest node (graph distance, ignoring direction) with room for a vehicle of `length`. A node a vehicle can still
   * route from and to (same strongly connected part of the network as `near`) is preferred over a closer one that is
   * not, and a cell that is not a junction over a junction; -1 if there is no room anywhere.
   */
  findFreeNode(near, length = this._maxLength) {
    const g = this.graph;
    if (!Number.isInteger(near) || near < 0 || near >= g.nodeCount || !g.isNode[near]) return -1;
    const seen = new Uint8Array(g.nodeCount);
    const queue = [near];
    seen[near] = 1;
    const best = [-1, -1, -1, -1]; // first free node per class: same part / plain, same part / junction, other / plain, other / junction
    for (let h = 0; h < queue.length; h++) {
      const node = queue[h];
      if (this._roomAt(node, length, null)) {
        const kind = (g.sameScc(near, node) ? 0 : 2) + (g.controlled[node] === 0 ? 0 : 1);
        if (kind === 0) return node;
        if (best[kind] < 0) best[kind] = node;
      }
      for (const e of g.out[node]) if (!seen[g.edges[e].to]) { seen[g.edges[e].to] = 1; queue.push(g.edges[e].to); }
      for (const e of g.in[node]) if (!seen[g.edges[e].from]) { seen[g.edges[e].from] = 1; queue.push(g.edges[e].from); }
    }
    return best.find((n) => n >= 0) ?? -1;
  }

  /** Number of vehicles currently driving on the edge (a vehicle parked at its head does not count). */
  edgeCount(edgeId) {
    const list = this._lanes[edgeId];
    if (list === undefined || list.length === 0) return 0;
    return list[0].edge === edgeId ? list.length : list.length - 1;
  }

  // ---- one tick ---------------------------------------------------------------------------------------------

  /** Advance all vehicles by dt seconds (any dt > 0; collision-free for dt up to and beyond 0.5 s). */
  step(dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    if (!(this.speedFactor >= 0 && this.speedFactor < Infinity)) this.speedFactor = 1; // NaN / negative / infinite: ignore
    this.time += dt;
    const vs = this.vehicles;
    this._arrived.length = 0;
    this._events.length = 0;
    const active = this._active; // vehicles that are on the road with a route (the only ones that plan and move)
    let count = 0;
    for (let i = 0; i < vs.length; i++) {
      const tv = vs[i];
      tv.prevX = tv.x;
      tv.prevY = tv.y;
      tv.prevHeading = tv.heading;
      if (!tv.onRoad || !tv.driving) continue;
      if (tv._route.length === 0) this._finishEmptyRoute(tv);
      else active[count++] = tv;
    }
    for (let i = 0; i < count; i++) {
      const tv = active[i];
      if (tv._turn >= 0) { // manoeuvring in place: the cells it sweeps and what stands ahead of its final pose
        evaluateSpin(this, tv);
        scanAhead(this, tv, this.headway + 1);
        continue;
      }
      const vTop = tv.vmax * this.speedFactor;
      const vNext = Math.min(vTop, tv.v + tv.accel * dt);
      const brake = (vTop * vTop) / (2 * tv.decel) + vTop * dt;
      evaluateRequest(this, tv, (vNext * vNext) / (2 * tv.decel) + 2 * vNext * dt + 0.5, brake + this.headway + 1);
    }
    grantLocks(this);
    for (let i = 0; i < count; i++) planMotion(this, active[i], dt);
    for (let i = 0; i < count; i++) applyMotion(this, active[i], dt);
    this._bookkeep(dt);
    this._checkDeadlocks();
    for (const tv of this._arrived) if (tv.onRoad && !tv.driving) this.onArrive(tv);
    for (const ev of this._events) this.onDeadlock(ev);
  }

  // ---- internals: registry ----------------------------------------------------------------------------------

  _defaultHeading(node) {
    const out = this.graph.out[node];
    return out.length > 0 ? this.geo.heading[out[0]] : 0;
  }

  /** Stand a vehicle on the centre of `node` (no lane offset), holding the cell lock if the cell is controlled. */
  _placeFresh(tv, node) {
    const g = this.graph;
    tv.node = node;
    tv.edge = -1;
    tv.s = 0;
    tv.lastEdge = -1;
    tv._lane = -1;
    tv._ls = 0;
    tv._prev = -1;
    tv._route = null;
    tv._nodes = null;
    tv._ext = [];
    tv._turn = -1;
    tv.v = 0;
    tv.moving = false;
    tv.driving = false;
    tv.x = g.x(node);
    tv.y = g.y(node);
    tv.prevX = tv.x;
    tv.prevY = tv.y;
    tv.prevHeading = tv.heading;
    tv.teleports++;
    this._clearWaiting(tv);
    (this._fresh[node] ??= []).push(tv);
    if (g.controlled[node] === 1 || this._bend[node] === 1) {
      this._lock[node] = tv;
      tv._held.push(node);
      tv._heldQ.push(this.r);
    }
    if (this._reachesNeighbours(tv.length)) { // parked heading unknown: hold neighbouring controlled cells until the first drive resolves them
      for (const m of this._neighbours(node)) {
        if (this._lockable[m] !== 1) continue;
        this._lock[m] = tv;
        tv._held.push(m);
        tv._heldQ.push(0);
      }
    }
  }

  /**
   * When a route starts, recompute where each cell the vehicle still holds is cleared. The route coordinate system
   * restarts at the start node, and a new route may leave in another direction (even back the way it came), so a
   * cell is identified by its position on the new route (or its straight continuation) - but only where the body
   * reaches it now. A cell the body overhangs behind or beside the start node is cleared as soon as the rear has
   * moved half a cell, even if the route comes back to it later (a dead-end turn-around): that is a new visit.
   */
  _resolveHolds(tv) {
    const n = tv._route.length;
    const reach = tv.length / 2 + 1e-9;
    for (let k = 0; k < tv._held.length; k++) {
      let i = tv._nodes.indexOf(tv._held[k]);
      if (i < 0) {
        const e = tv._ext.findIndex((x) => this.graph.edges[x].to === tv._held[k]);
        if (e >= 0) i = n + 1 + e;
      }
      if (i * this.L - this.r > reach) i = -1;
      tv._heldQ[k] = i >= 0 ? i * this.L + this.r : -this.r;
    }
  }

  /** Take a parked vehicle out of the lane list / fresh list it stands in. */
  _leaveParked(tv) {
    if (tv._lane >= 0) {
      laneRemove(this._lanes[tv._lane], tv);
    } else if (tv.node >= 0) {
      const list = this._fresh[tv.node];
      if (list !== undefined) {
        list.splice(list.indexOf(tv), 1);
        if (list.length === 0) this._fresh[tv.node] = undefined;
      }
    }
  }

  /** Remove every trace of a vehicle from lane lists, locks and the request queue. */
  _unregister(tv) {
    this._leaveParked(tv);
    cancelRequest(this, tv);
    releaseAll(this, tv);
    tv._lane = -1;
    tv._route = null;
    tv._nodes = null;
    tv._ext = [];
    tv._ri = 0;
    tv._prev = -1;
    tv._turn = -1;
    tv.driving = false;
    tv.edge = -1;
    tv.node = -1;
  }

  /** Drop references to a vehicle that left the road. */
  _forget(tv) {
    for (const o of this.vehicles) {
      if (o.blockedBy === tv) { // its blocker is gone: the wait ends (re-evaluated on the next tick)
        o.blockedBy = null;
        o.waiting = false;
        o.waitReason = null;
        o.waitTime = 0;
      }
      if (o._ldTv === tv) o._ldTv = null;
      if (o._blkTv === tv) o._blkTv = null;
      if (o._gate === tv) o._gate = null;
    }
  }

  _clearWaiting(tv) {
    tv.waiting = false;
    tv.waitReason = null;
    tv.blockedBy = null;
    tv.waitTime = 0;
  }

  /** Straight continuation of the route's last edge (the footprint of a long vehicle may overhang the final node). */
  _extension(tv) {
    const edges = this.graph.edges;
    const ext = [];
    let e = tv._route[tv._route.length - 1];
    for (let k = Math.ceil(tv.length / this.L) + 1; k > 0; k--) {
      const next = this.graph.out[edges[e].to].find((o) => edges[o].dir === edges[e].dir);
      if (next === undefined) break;
      ext.push(next);
      e = next;
    }
    return ext;
  }

  _finishEmptyRoute(tv) {
    tv.driving = false;
    tv._route = null;
    tv._nodes = null;
    this._arrived.push(tv);
  }

  /** Road cells edge-adjacent (along a link in either direction) to `node`. */
  _neighbours(node) {
    const g = this.graph;
    const list = [];
    for (const e of g.out[node]) if (!list.includes(g.edges[e].to)) list.push(g.edges[e].to);
    for (const e of g.in[node]) if (!list.includes(g.edges[e].from)) list.push(g.edges[e].from);
    return list;
  }

  /** Does a vehicle of this length, parked on a node centre, stick into the neighbouring cells? */
  _reachesNeighbours(length) {
    return length / 2 > this.r;
  }

  /**
   * Room for a vehicle of `length` centred on `node`: headway kept along the neighbouring lanes and in the plane, no
   * foreign lock, and every vehicle that is driving towards the node can still stop in front of it with its own
   * deceleration (a vehicle must not be dropped in front of traffic that has no way to avoid it).
   */
  _roomAt(node, length, ignore) {
    const g = this.graph;
    if (this._lock[node] !== null && this._lock[node] !== ignore) return false;
    if (this._reachesNeighbours(length)) {
      for (const m of this._neighbours(node)) {
        if (this._lock[m] !== null && this._lock[m] !== ignore) return false;
      }
    }
    for (const e of g.in[node]) { // along the lanes of the neighbouring edges the headway must hold too, whatever the pose
      for (const x of this._lanes[e]) if (x !== ignore && this.L - x._ls - (x.length + length) / 2 < this.headway - 1e-9) return false;
    }
    for (const e of g.out[node]) {
      for (const x of this._lanes[e]) if (x !== ignore && x._ls - (x.length + length) / 2 < this.headway - 1e-9) return false;
    }
    const gx = g.x(node);
    const gy = g.y(node);
    const clear = this._lockable[node] === 1 ? Math.max(length / 2 + this.headway, this.r + this.standoff) : length / 2 + this.headway;
    for (const o of this.vehicles) {
      if (!o.onRoad || o === ignore) continue;
      const min = (length + o.length) / 2 + this.headway - 1e-9;
      const dx = o.x - gx;
      const dy = o.y - gy;
      const d2 = dx * dx + dy * dy;
      if (d2 < min * min) return false;
      if (o.v > MOVING_SPEED && o.driving && !this._canStopBefore(o, node, clear, d2)) return false;
    }
    return true;
  }

  /**
   * Can the moving vehicle `o`, whose route leads through `node`, still stop with its own deceleration when something
   * stands on the node (its nose `clear` m before the node centre)? `d2` = squared distance of o's pose from the node.
   */
  _canStopBefore(o, node, clear, d2) {
    const need = o.length / 2 + clear + stoppingDistance(o.v, o.decel);
    if (d2 > (need + this.r) * (need + this.r)) return true; // the road to the node is longer than the straight line
    const i = o._nodes.indexOf(node, o._ri + 1);
    return i < 0 || i * this.L - (o._ri * this.L + o.s) >= need - 1e-9;
  }

  // ---- internals: bookkeeping -------------------------------------------------------------------------------

  /** Cell (node) that currently contains the centre of a driving vehicle. */
  _cellOf(tv) {
    const e = this.graph.edges[tv.edge];
    return tv.s >= this.r ? e.to : e.from;
  }

  /** Waiting flags, reasons and statistics after the move of this tick. */
  _bookkeep(dt) {
    const st = this.stats;
    for (const tv of this.vehicles) {
      if (!tv.onRoad) continue;
      // waiting = held back by a vehicle or a junction to less than half of the speed it could drive (a standstill, or a crawl)
      const waits = tv.driving && !tv.disabled && tv._blk !== 0 && tv._blkTv !== null
        && tv._vFree > MOVING_SPEED && tv.v < Math.max(MOVING_SPEED, WAIT_SPEED_SHARE * tv._vFree);
      tv.waiting = waits;
      tv.blockedBy = waits ? tv._blkTv : null;
    }
    for (const tv of this.vehicles) {
      if (!tv.onRoad) continue;
      if (tv.driving && !tv.disabled) st.drivingTime += dt;
      if (!tv.waiting) {
        tv.waitReason = null;
        tv.waitTime = 0;
        continue;
      }
      tv.waitTime += dt;
      tv.waitReason = this._reasonOf(tv);
      if (tv.waitReason === 'junction') st.waitJunction += dt;
      else if (tv.waitReason === 'broken') st.waitBroken += dt;
      else st.waitVehicle += dt;
      st.totalWait += dt;
      st.edgeWait[tv.edge] += dt;
      st.nodeWait[tv._blk === 2 ? tv._blkNode : this._cellOf(tv)] += dt;
    }
  }

  /** 'broken' if a disabled vehicle is anywhere along the blocking chain, else 'junction' / 'vehicle'. */
  _reasonOf(tv) {
    let b = tv.blockedBy;
    for (let k = 0; b !== null && k < BROKEN_CHAIN_LIMIT; k++) {
      if (b.disabled) return 'broken';
      b = b.waiting ? b.blockedBy : null;
    }
    return tv._blk === 2 ? 'junction' : 'vehicle';
  }

  // ---- internals: deadlocks ---------------------------------------------------------------------------------

  _checkDeadlocks() {
    if (this.time < this._nextDeadlockCheck) return;
    this._nextDeadlockCheck = this.time + DEADLOCK_CHECK_INTERVAL;
    const cycles = findWaitCycles(this.vehicles).filter((c) => isStandingDeadlock(c, this.deadlockTime));
    const seen = new Set();
    const active = [];
    for (const cycle of cycles) {
      const key = cycleKey(cycle);
      seen.add(key);
      let rec = this._known.get(key);
      const isNew = rec === undefined;
      if (isNew) {
        rec = { t: this.time, resolved: false, reportedResolved: false };
        this._known.set(key, rec);
        this.stats.deadlocks++;
      }
      const nodes = [...new Set(cycle.map((tv) => this._nodeOf(tv)))];
      let victim = null;
      if (this.resolveDeadlocks && !rec.resolved) {
        victim = pickVictim(cycle, this.vehicles);
        const target = this.findFreeNode(this._nodeOf(victim), victim.length);
        rec.resolved = target >= 0 && this.relocate(victim, target);
      }
      if (isNew || (rec.resolved && !rec.reportedResolved)) {
        rec.reportedResolved = rec.resolved;
        this._events.push({ vehicles: cycle.slice(), nodes, resolved: rec.resolved, victim: rec.resolved ? victim : null });
      }
      if (!rec.resolved) active.push({ nodes, vehicleIds: cycle.map((tv) => tv.id), t: rec.t });
    }
    for (const key of this._known.keys()) if (!seen.has(key)) this._known.delete(key);
    this.activeDeadlocks = active;
  }

  /** Node of the cell containing the vehicle's centre. */
  _nodeOf(tv) {
    return tv.node >= 0 ? tv.node : this._cellOf(tv);
  }
}
