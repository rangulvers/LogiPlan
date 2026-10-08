// Test helper: a deterministic stand-in for the real TrafficSystem (js/sim/traffic.js, docs/ARCHITECTURE.md 5.2),
// so the logistics layer can be tested without the traffic module and with exactly computable travel times.
//
// It has the same public surface as the real thing (addVehicle, removeVehicle, detach, attach, canAttach, drive,
// relocate, findFreeNode, step, speedFactor, onArrive, onDeadlock, edgeCount, stats, vehicles) and the same TV
// fields, but a much simpler physics:
//   * a driving vehicle moves along its route at constant speed  vmax * speedFactor * edge.limit  (no
//     acceleration; edge.limit is 1 unless the layout has slow zones, so on normal roads the speed is exactly
//     vmax * speedFactor and a route of cost C metres takes C / (vmax * speedFactor) seconds);
//   * NO collisions, headway, lanes, junction locks or deadlocks - vehicles pass through each other;
//   * the only exclusion is a stationary one: at most one on-road vehicle may stand at a node centre
//     (addVehicle / attach / relocate are refused on an occupied node, which is what makes depot departure
//     and "no room" handling testable). A vehicle that has been given a route still occupies its node until
//     it actually moves;
//   * a vehicle with `disabled = true` stays put, keeps its route (driving stays true) and counts as
//     waiting with reason 'broken';
//   * on reaching the end of its route the vehicle stops exactly at the last node, `driving` becomes false
//     and `onArrive(tv)` is called from inside step() - exactly the real contract. Arrival is detected at the
//     end of the tick in which the route's distance has been covered, so a trip of D metres takes
//     ceil(D / (speed * dt)) ticks (see tripTicks).
// The stub is strict: drive() throws when its preconditions (vehicle on the road, stopped, at the route's first
// node, route with at least one edge, consistent edges, no mid-road U-turn - the graph's routing rule, also right
// after arriving over `lastEdge`) are violated, so a logistics bug cannot hide.
// Pose: on an edge the vehicle sits on the line between the centres of its end cells (no lane offset); `prev*`
// is the pose at the start of the last tick.

import { DX, DY } from '../../js/util/grid.js';

const TIME_EPS = 1e-9;

/** Ticks a trip of `distance` metres takes at `speed` m/s with step `dt` (arrival is seen at the end of that tick). */
export function tripTicks(distance, speed, dt) {
  return distance <= 0 ? 0 : Math.ceil(distance / (speed * dt) - 1e-9);
}

export class StubTraffic {
  /** @param {object} graph road graph (js/sim/graph.js) */
  constructor(graph) {
    this.graph = graph;
    this.vehicles = [];
    this.speedFactor = 1;
    this.onArrive = () => {};
    this.onDeadlock = () => {};
    this.occupant = new Map(); // node -> TV standing there
    this.onEdge = new Int32Array(graph.edges.length);
    this.stats = {
      edgePasses: new Int32Array(graph.edges.length),
      edgeWait: new Float64Array(graph.edges.length),
      nodeWait: new Float64Array(graph.nodeCount),
      waitVehicle: 0, waitJunction: 0, waitBroken: 0, deadlocks: 0, totalWait: 0, drivingTime: 0,
    };
  }

  /** Place a stationary vehicle at a node centre; null when the node is not a road cell or is occupied. */
  addVehicle({ id, length, speed, accel, decel, node, owner }) {
    if (!this.canAttach(node)) return null;
    const g = this.graph;
    const tv = {
      id, owner, length, width: 0.8, vmax: speed, accel, decel,
      onRoad: true, node, edge: -1, s: 0, lastEdge: -1, v: 0,
      x: g.x(node), y: g.y(node), heading: 0, prevX: g.x(node), prevY: g.y(node), prevHeading: 0,
      driving: false, moving: false, waiting: false, waitReason: null, blockedBy: null, disabled: false,
      odometer: 0, waitTime: 0,
      route: null, routeIdx: 0, // stub internals
    };
    this.occupant.set(node, tv);
    this.vehicles.push(tv);
    return tv;
  }

  removeVehicle(tv) {
    this.detach(tv);
    const i = this.vehicles.indexOf(tv);
    if (i >= 0) this.vehicles.splice(i, 1);
  }

  /** Lift the vehicle off the road (it keeps its pose, owns no node and no lane). */
  detach(tv) {
    if (!tv.onRoad) return;
    this.release(tv);
    tv.onRoad = false;
    tv.driving = false;
    tv.moving = false;
    tv.waiting = false;
    tv.waitReason = null;
    tv.route = null;
    tv.v = 0;
  }

  canAttach(node) {
    return node >= 0 && node < this.graph.nodeCount && this.graph.isNode[node] === 1 && !this.occupant.has(node);
  }

  attach(tv, node) {
    if (tv.onRoad) throw new Error(`StubTraffic.attach: ${tv.id} is already on the road`);
    if (!this.canAttach(node)) return false;
    this.place(tv, node);
    tv.onRoad = true;
    return true;
  }

  /** Start driving. The vehicle must stand still at route.nodes[0]. */
  drive(tv, route) {
    const g = this.graph;
    if (!tv.onRoad) throw new Error(`StubTraffic.drive: ${tv.id} is not on the road`);
    if (tv.driving) throw new Error(`StubTraffic.drive: ${tv.id} is already driving`);
    if (!route || route.edges.length === 0) throw new Error(`StubTraffic.drive: ${tv.id} got an empty route`);
    if (tv.node !== route.nodes[0]) throw new Error(`StubTraffic.drive: ${tv.id} is at node ${tv.node}, route starts at ${route.nodes[0]}`);
    route.edges.forEach((e, i) => {
      if (g.edges[e].from !== route.nodes[i] || g.edges[e].to !== route.nodes[i + 1]) throw new Error('StubTraffic.drive: inconsistent route');
    });
    this.checkNoUTurn(tv, route);
    tv.route = route;
    tv.routeIdx = 0;
    tv.driving = true;
  }

  /** The graph's routing rule: no reversal in mid-road, neither on the way nor right after arriving over `lastEdge`. */
  checkNoUTurn(tv, route) {
    const g = this.graph;
    const reverses = (inEdge, outEdge) => g.edges[inEdge].rev === outEdge && g.out[g.edges[inEdge].to].length > 1;
    if (tv.lastEdge >= 0 && g.edges[tv.lastEdge].to === tv.node && reverses(tv.lastEdge, route.edges[0])) {
      throw new Error(`StubTraffic.drive: ${tv.id} would U-turn on the spot at node ${tv.node}`);
    }
    for (let i = 1; i < route.edges.length; i++) {
      if (reverses(route.edges[i - 1], route.edges[i])) throw new Error(`StubTraffic.drive: ${tv.id} would U-turn in mid-road at node ${route.nodes[i]}`);
    }
  }

  /** Teleport to a free node, dropping the route (what deadlock resolution does). */
  relocate(tv, node) {
    if (!this.canAttach(node)) return false;
    this.release(tv);
    this.place(tv, node);
    return true;
  }

  /** Closest node (graph distance, ignoring direction, ties by node id) where a vehicle fits; -1 if none. */
  findFreeNode(near) {
    const g = this.graph;
    if (near < 0 || near >= g.nodeCount || !g.isNode[near]) return -1;
    const seen = new Set([near]);
    let frontier = [near];
    while (frontier.length > 0) {
      const free = frontier.filter((n) => this.canAttach(n)).sort((a, b) => a - b);
      if (free.length > 0) return free[0];
      const next = new Set();
      for (const n of frontier) {
        for (const e of [...g.out[n], ...g.in[n]]) {
          const m = g.edges[e].from === n ? g.edges[e].to : g.edges[e].from;
          if (!seen.has(m)) { seen.add(m); next.add(m); }
        }
      }
      frontier = [...next].sort((a, b) => a - b);
    }
    return -1;
  }

  edgeCount(edgeId) {
    return this.onEdge[edgeId];
  }

  step(dt) {
    for (const tv of this.vehicles) {
      if (!tv.onRoad) continue;
      tv.prevX = tv.x;
      tv.prevY = tv.y;
      tv.prevHeading = tv.heading;
      if (!tv.driving) { tv.v = 0; tv.moving = false; continue; }
      this.stats.drivingTime += dt;
      if (tv.disabled) {
        tv.v = 0;
        tv.moving = false;
        this.markWaiting(tv, dt);
        continue;
      }
      tv.waiting = false;
      tv.waitReason = null;
      this.advance(tv, dt);
    }
  }

  // ---- internals -------------------------------------------------------------------------------------------

  markWaiting(tv, dt) {
    tv.waiting = true;
    tv.waitReason = 'broken';
    tv.waitTime += dt;
    this.stats.waitBroken += dt;
    this.stats.totalWait += dt;
    if (tv.edge >= 0) this.stats.edgeWait[tv.edge] += dt;
    else this.stats.nodeWait[tv.node] += dt;
  }

  /** Move along the route for `dt` seconds; stop and report at its end. */
  advance(tv, dt) {
    const g = this.graph;
    let left = dt;
    tv.moving = true;
    while (left > TIME_EPS) {
      if (tv.node >= 0) this.leaveNode(tv);
      const edge = g.edges[tv.route.edges[tv.routeIdx]];
      const speed = tv.vmax * this.speedFactor * edge.limit;
      tv.v = speed;
      const toGo = edge.length - tv.s;
      const needed = toGo / speed;
      if (needed > left + TIME_EPS) {
        tv.s += speed * left;
        tv.odometer += speed * left;
        left = 0;
      } else {
        tv.odometer += toGo;
        left -= Math.min(left, needed);
        tv.s = edge.length;
        this.onEdge[edge.id]--;
        tv.lastEdge = edge.id;
        tv.routeIdx++;
        if (tv.routeIdx === tv.route.edges.length) { this.finishRoute(tv, edge); this.pose(tv); this.onArrive(tv); return; }
        tv.edge = tv.route.edges[tv.routeIdx];
        tv.s = 0;
        this.onEdge[tv.edge]++;
        this.stats.edgePasses[tv.edge]++;
      }
      this.pose(tv);
    }
  }

  /** The vehicle starts moving away from the node it stood on. */
  leaveNode(tv) {
    this.occupant.delete(tv.node);
    tv.node = -1;
    tv.edge = tv.route.edges[tv.routeIdx];
    tv.s = 0;
    this.onEdge[tv.edge]++;
    this.stats.edgePasses[tv.edge]++;
  }

  finishRoute(tv, lastEdge) {
    tv.node = lastEdge.to;
    tv.edge = -1;
    tv.s = 0;
    tv.v = 0;
    tv.moving = false;
    tv.driving = false;
    tv.route = null;
    this.occupant.set(tv.node, tv);
  }

  /** World pose of a vehicle from its node / edge position. */
  pose(tv) {
    const g = this.graph;
    if (tv.node >= 0) {
      tv.x = g.x(tv.node);
      tv.y = g.y(tv.node);
      return;
    }
    const e = g.edges[tv.edge];
    const f = tv.s / e.length;
    tv.x = g.x(e.from) + (g.x(e.to) - g.x(e.from)) * f;
    tv.y = g.y(e.from) + (g.y(e.to) - g.y(e.from)) * f;
    tv.heading = Math.atan2(DY[e.dir], DX[e.dir]);
  }

  /** Forget where the vehicle stands (node or edge) and its route. */
  release(tv) {
    if (tv.node >= 0 && this.occupant.get(tv.node) === tv) this.occupant.delete(tv.node);
    if (tv.edge >= 0) this.onEdge[tv.edge]--;
    tv.node = -1;
    tv.edge = -1;
    tv.s = 0;
    tv.route = null;
    tv.driving = false;
    tv.moving = false;
    tv.waiting = false;
    tv.waitReason = null;
    tv.v = 0;
  }

  /** Stand still at a node centre, forgetting the last edge. */
  place(tv, node) {
    tv.node = node;
    tv.edge = -1;
    tv.s = 0;
    tv.lastEdge = -1;
    tv.x = this.graph.x(node);
    tv.y = this.graph.y(node);
    tv.prevX = tv.x;
    tv.prevY = tv.y;
    this.occupant.set(node, tv);
  }
}
