// Test helpers for the traffic engine (js/sim/traffic.js).
//
//  * createInvariantChecker(traffic): physical and structural invariants, checked after every tick
//        const checker = createInvariantChecker(traffic);
//        for (...) { traffic.step(dt); checker.check(); }      // throws an Error naming the first violated invariant
//    Checked: finite poses; 0 <= v <= vmax * speedFactor (above a lowered cap only while slowing down); no pose jump
//    (<= vmax * dt + 5 cm per tick, teleports excepted); bumper-to-bumper gap >= headway to every vehicle ahead on the
//    route (re-computed from scratch over ALL vehicles in the lane lists, across edge boundaries); no overlapping
//    footprints (oriented rectangles, vehicles that are not turning); at most one vehicle centre per controlled cell,
//    and that vehicle holds the lock; lane lists, fresh lists, locks, request queue and edgeCount consistent with the
//    vehicle fields; waiting bookkeeping and statistics consistent. Cheap checks run on every tick, the ones that scan
//    the whole network (all lane lists, all locks, the statistics) every 20th tick and on the first.
//  * createWorld(lines): a traffic system on an ASCII road picture with add / drive / run helpers (hand-written scenarios)
//  * runRandomScenario / runFuzzShard: seeded random layouts with random fleets, routes, breakdowns and detach / attach
//  * bodyGap(a, b): distance between the rectangles of two vehicles
//
// Internals read here (underscore fields of TV / TrafficSystem) are part of the engine's test contract.

import { createRng } from '../../js/util/rng.js';
import { layoutFromAscii } from './ascii.js';
import { buildGraph } from '../../js/sim/graph.js';
import { TrafficSystem } from '../../js/sim/traffic.js';

const EPS = 1e-6;
const JUMP_TOLERANCE = 0.05; // m on top of vmax * dt (spec: 5 cm)
const MOVING_SPEED = 0.05;
const FULL_CHECK_EVERY = 20; // ticks between the checks that scan every edge / node / statistic
const OVERLAP_TOLERANCE = 0.05; // m of interpenetration tolerated between footprints (rigid bodies on curved paths)

function fail(traffic, message) {
  throw new Error(`traffic invariant violated at t=${traffic.time.toFixed(2)}: ${message}`);
}

/** Corners of the oriented rectangle of a vehicle (length along the heading, width scaled by `widthFactor`). */
function corners(tv, widthFactor) {
  const hl = tv.length / 2;
  const hw = (tv.width * widthFactor) / 2;
  const c = Math.cos(tv.heading);
  const s = Math.sin(tv.heading);
  return [[hl, hw], [hl, -hw], [-hl, -hw], [-hl, hw]].map(([a, b]) => [tv.x + a * c - b * s, tv.y + a * s + b * c]);
}

/** Signed distance between two convex polygons: > 0 apart (largest gap on a separating axis), < 0 interpenetration depth. */
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

/** Gap between the bodies (rectangles of the full length and width) of two vehicles: > 0 apart, < 0 overlapping. */
export const bodyGap = (a, b) => separation(corners(a, 1), corners(b, 1));

/**
 * Create a checker bound to a TrafficSystem. `check()` must be called after each `traffic.step`.
 * @param {TrafficSystem} traffic
 * @param {object} [opts] { geometry = true: also test footprint overlap (oriented rectangles, half width) of vehicles up to
 *   footprintLimit metres long (default one cell) }
 */
export function createInvariantChecker(traffic, opts = {}) {
  const geometry = opts.geometry !== false;
  // A vehicle is modelled as a rigid rectangle tangent to its path, which swings wide of the lane while it turns, so
  // the footprint test skips vehicles that are in a corner or U-turn and vehicles longer than `footprintLimit`
  // (default: one cell). Lane gaps and cell locks are checked for every vehicle regardless.
  const footprintLimit = opts.footprintLimit ?? traffic.graph.cellSize;
  const prev = new Map(); // tv -> { x, y, v, teleports } at the previous check
  const touched = new Set(); // edges whose lane lists held vehicles at the previous check
  let ticks = 0;
  let lastTime = traffic.time;
  const g = traffic.graph;
  const L = g.cellSize;

  // a vehicle that has just been told to drive and not moved yet may be parked turned away from its route
  const justStarted = (tv) => tv.driving && tv._ri === 0 && tv.s === 0;

  function checkVehicle(tv) {
    for (const k of ['x', 'y', 'heading', 'v', 's', 'odometer', 'waitTime']) {
      if (!Number.isFinite(tv[k])) fail(traffic, `${tv.id}.${k} is not finite (${tv[k]})`);
    }
    if (tv.v < -EPS) fail(traffic, `${tv.id} has negative speed ${tv.v}`);
    const cap = tv.vmax * Math.max(traffic.speedFactor, 0) + EPS;
    const before = prev.get(tv);
    // after the factor is lowered a vehicle may still be above the new cap, but only while it is slowing down
    if (tv.v > cap && !(before && before.teleports === tv.teleports && tv.v <= before.v + EPS)) {
      fail(traffic, `${tv.id} speed ${tv.v} exceeds vmax*factor ${cap}`);
    }
    if (tv.moving !== tv.v > MOVING_SPEED) fail(traffic, `${tv.id} moving=${tv.moving} but v=${tv.v}`);
    const dt = traffic.time - lastTime;
    if (before && before.teleports === tv.teleports && dt > 0) {
      const jump = Math.hypot(tv.x - before.x, tv.y - before.y);
      const limit = Math.max(tv.vmax * Math.max(1, traffic.speedFactor), before.v, tv.v) * dt + JUMP_TOLERANCE;
      if (jump > limit) fail(traffic, `${tv.id} jumped ${jump.toFixed(3)} m in one tick (limit ${limit.toFixed(3)})`);
    }
    prev.set(tv, { x: tv.x, y: tv.y, v: tv.v, teleports: tv.teleports });
    if (tv.waiting) {
      if (!tv.driving || tv.blockedBy === null || tv.waitReason === null) fail(traffic, `${tv.id} waiting without driving/blocker/reason`);
    } else if (tv.waitReason !== null || tv.blockedBy !== null || tv.waitTime !== 0) {
      fail(traffic, `${tv.id} not waiting but has waiting fields`);
    }
    if (tv.driving !== (tv._route !== null)) fail(traffic, `${tv.id} driving=${tv.driving} but route=${tv._route}`);
  }

  /** Lane lists of the edges vehicles are on now or were on at the previous check; every edge when `full`. */
  function laneScope(full) {
    if (full) return g.edges.map((e) => e.id);
    const scope = new Set(touched);
    touched.clear();
    for (const tv of traffic.vehicles) if (tv._lane >= 0) { scope.add(tv._lane); touched.add(tv._lane); }
    return scope;
  }

  function checkLanes(full) {
    const seen = new Map();
    for (const e of laneScope(full)) {
      const list = traffic._lanes[e];
      for (let i = 0; i < list.length; i++) {
        const tv = list[i];
        if (!tv.onRoad || tv._lane !== e) fail(traffic, `${tv.id} in lane list ${e} but onRoad=${tv.onRoad} lane=${tv._lane}`);
        if (seen.has(tv)) fail(traffic, `${tv.id} is in two lane lists`);
        seen.set(tv, e);
        if (i > 0) {
          const ahead = list[i - 1];
          if (!(ahead._ls > tv._ls)) fail(traffic, `lane ${e} not ordered: ${ahead.id}@${ahead._ls} before ${tv.id}@${tv._ls}`);
          const gap = ahead._ls - ahead.length / 2 - (tv._ls + tv.length / 2);
          if (gap < traffic.headway - EPS && !justStarted(tv)) fail(traffic, `gap ${gap.toFixed(4)} < headway between ${ahead.id} and ${tv.id} on edge ${e}`);
        }
      }
      const driving = list.filter((tv) => tv.edge === e).length;
      if (traffic.edgeCount(e) !== driving) fail(traffic, `edgeCount(${e}) = ${traffic.edgeCount(e)}, expected ${driving}`);
    }
    for (const tv of traffic.vehicles) {
      if (!tv.onRoad) {
        if (seen.has(tv) || traffic._pending.includes(tv) || tv._held.length > 0) fail(traffic, `${tv.id} is off road but still registered`);
        continue;
      }
      if (tv.driving && tv._route.length > 0) {
        if (tv.edge !== tv._route[tv._ri] || tv._lane !== tv.edge || tv.node !== -1 || tv._ls !== tv.s) fail(traffic, `${tv.id} driving fields inconsistent`);
        if (tv.s < -EPS || tv.s > L + EPS) fail(traffic, `${tv.id} s=${tv.s} outside the edge`);
      } else {
        if (tv.node < 0 || tv.edge !== -1) fail(traffic, `${tv.id} parked but node=${tv.node} edge=${tv.edge}`);
        if (tv.lastEdge >= 0) {
          if (tv._lane !== tv.lastEdge || tv._ls !== L || g.edges[tv.lastEdge].to !== tv.node) fail(traffic, `${tv.id} parked lane fields inconsistent`);
        } else if (!(traffic._fresh[tv.node] || []).includes(tv)) fail(traffic, `${tv.id} fresh but not in the fresh list of node ${tv.node}`);
        if (tv.v !== 0) fail(traffic, `${tv.id} parked with v=${tv.v}`);
      }
    }
    if (!full) return;
    traffic._fresh.forEach((list, node) => {
      if (list === undefined) return;
      if (list.length === 0) fail(traffic, `empty fresh list kept at node ${node}`);
      for (const tv of list) if (!tv.onRoad || tv.node !== node || tv.lastEdge !== -1 || tv.driving) fail(traffic, `${tv.id} stale in fresh list ${node}`);
    });
  }

  /** Gap along the route to every vehicle ahead, computed from scratch over all vehicles in the lane lists. */
  function checkHeadwayAlongRoutes() {
    const hw = traffic.headway;
    for (const tv of traffic.vehicles) {
      if (!tv.onRoad || !tv.driving || tv._route.length === 0) continue;
      if (justStarted(tv)) continue;
      const q = tv._ri * L + tv.s;
      const front = q + tv.length / 2;
      for (let j = tv._ri; j < tv._route.length; j++) {
        for (const x of traffic._lanes[tv._route[j]]) {
          if (x === tv) continue;
          if (j === tv._ri && x._ls <= tv.s) continue; // behind
          // a vehicle that just entered this edge from another street still has its rear back there (cell lock covers it)
          if (x._ls - x.length / 2 < 0 && x._prev >= 0 && x._prev !== (j > 0 ? tv._route[j - 1] : tv._prev)) continue;
          const gap = j * L + x._ls - x.length / 2 - front;
          if (gap < hw - EPS) fail(traffic, `${tv.id} is ${gap.toFixed(4)} m behind ${x.id} (headway ${hw}) on route edge ${j}`);
        }
        if (j * L > front + 12 * L) break;
      }
    }
  }

  function checkLocks(full) {
    const centres = new Map();
    for (const tv of traffic.vehicles) {
      if (!tv.onRoad) continue;
      const node = tv.node >= 0 ? tv.node : (tv.s >= L / 2 ? g.edges[tv.edge].to : g.edges[tv.edge].from);
      if (g.controlled[node] !== 1) continue;
      if (centres.has(node)) fail(traffic, `${centres.get(node).id} and ${tv.id} are both in controlled cell ${node}`);
      centres.set(node, tv);
      if (traffic._lock[node] !== tv) fail(traffic, `${tv.id} is in controlled cell ${node} without holding its lock`);
    }
    if (full) {
      for (let node = 0; node < g.nodeCount; node++) {
        const holder = traffic._lock[node];
        if (holder === null) continue;
        if (!holder.onRoad || !holder._held.includes(node)) fail(traffic, `lock of node ${node} held by ${holder.id} which does not list it`);
      }
    }
    for (const tv of traffic.vehicles) {
      if (tv._held.length !== tv._heldQ.length) fail(traffic, `${tv.id} held/heldQ length mismatch`);
      for (const node of tv._held) if (traffic._lock[node] !== tv) fail(traffic, `${tv.id} lists node ${node} but does not hold its lock`);
      if (new Set(tv._held).size !== tv._held.length) fail(traffic, `${tv.id} lists a lock twice`);
    }
    const pending = new Set(traffic._pending);
    if (pending.size !== traffic._pending.length) fail(traffic, 'duplicate vehicle in the request queue');
    for (const tv of traffic.vehicles) {
      if ((tv._req >= 0) !== pending.has(tv)) fail(traffic, `${tv.id} request flag (${tv._req}) and queue disagree`);
    }
  }

  /** Is the vehicle's body rotating through a corner or a U-turn? A rigid rectangle swings wide of the lane there. */
  function isTurning(tv) {
    if (!tv.driving || tv._route.length === 0) return false;
    if (tv._turn >= 0) return true;
    const n = tv._route.length;
    const prev = tv._ri > 0 ? tv._route[tv._ri - 1] : tv._prev;
    const next = tv._ri + 1 < n ? tv._route[tv._ri + 1] : -1;
    return (tv.s < L / 2 && traffic.geo.isCorner(prev, tv.edge)) || (tv.s > L / 2 && traffic.geo.isCorner(tv.edge, next));
  }

  function checkOverlap() {
    const vs = traffic.vehicles.filter((tv) => tv.onRoad && tv.length <= footprintLimit && !isTurning(tv));
    for (let i = 0; i < vs.length; i++) {
      for (let j = i + 1; j < vs.length; j++) {
        const a = vs[i];
        const b = vs[j];
        const reach = (a.length + b.length) / 2 + a.width;
        if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 > reach * reach) continue;
        if (separation(corners(a, 0.5), corners(b, 0.5)) < -OVERLAP_TOLERANCE) {
          fail(traffic, `footprints of ${a.id} (${a.x.toFixed(2)},${a.y.toFixed(2)}) and ${b.id} (${b.x.toFixed(2)},${b.y.toFixed(2)}) overlap`);
        }
      }
    }
  }

  function checkStats() {
    const st = traffic.stats;
    const sum = st.waitVehicle + st.waitJunction + st.waitBroken;
    if (Math.abs(sum - st.totalWait) > 1e-6) fail(traffic, `totalWait ${st.totalWait} != sum of reasons ${sum}`);
    const edgeSum = st.edgeWait.reduce((a, b) => a + b, 0);
    const nodeSum = st.nodeWait.reduce((a, b) => a + b, 0);
    if (Math.abs(edgeSum - st.totalWait) > 1e-6 || Math.abs(nodeSum - st.totalWait) > 1e-6) fail(traffic, 'edgeWait/nodeWait do not add up to totalWait');
    if (st.totalWait > st.drivingTime + 1e-6) fail(traffic, 'totalWait exceeds drivingTime');
    for (const x of [...st.edgePasses, ...st.edgeWait, ...st.nodeWait]) if (!(x >= 0)) fail(traffic, 'negative statistic');
  }

  return {
    /** Check every invariant for the current state. */
    check() {
      if (!(traffic.time >= lastTime)) fail(traffic, `time went backwards (${lastTime} -> ${traffic.time})`);
      const full = ticks++ % FULL_CHECK_EVERY === 0;
      for (const tv of traffic.vehicles) if (tv.onRoad) checkVehicle(tv);
      checkLanes(full);
      checkHeadwayAlongRoutes();
      checkLocks(full);
      if (full) checkStats();
      if (geometry) checkOverlap();
      lastTime = traffic.time;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Seeded random scenarios (used by the fuzz tests)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Random road picture for layoutFromAscii: a few two-way and one-way streets on even grid lines (so parallel streets
 * never touch), crossing each other, plus short stubs on odd lines. This yields crossings, T-junctions, merges, forks,
 * corners and dead ends without the pathological solid road blocks that adjacent parallel streets would create.
 */
export function randomRoadLines(rng) {
  const cols = 22 + rng.int(16);
  const rows = 16 + rng.int(10);
  const grid = Array.from({ length: rows }, () => Array(cols).fill('.'));
  const put = (x, y, ch) => { grid[y][x] = grid[y][x] === '.' || grid[y][x] === ch ? ch : '+'; };
  const street = (horizontal, lane, start, len, ch) => {
    for (let i = start; i < start + len; i++) { if (horizontal) put(i, lane, ch); else put(lane, i, ch); }
  };
  const streets = 7 + rng.int(6);
  for (let k = 0; k < streets; k++) {
    const horizontal = rng.next() < 0.5;
    const extent = horizontal ? cols : rows;
    const lanes = horizontal ? rows : cols;
    const twoWay = rng.next() < 0.6;
    const len = Math.min(extent, 6 + rng.int(extent - 5));
    const ch = twoWay ? '+' : (horizontal ? (rng.next() < 0.5 ? '>' : '<') : (rng.next() < 0.5 ? 'v' : '^'));
    street(horizontal, 2 * rng.int(Math.floor(lanes / 2)), rng.int(extent - len + 1), len, ch);
  }
  for (let k = 0; k < 3; k++) { // short two-way stubs on odd lines: dead ends and T-junctions
    const horizontal = rng.next() < 0.5;
    const extent = horizontal ? cols : rows;
    const lanes = horizontal ? rows : cols;
    street(horizontal, 1 + 2 * rng.int(Math.floor((lanes - 1) / 2)), rng.int(extent - 3), 2 + rng.int(2), '+');
  }
  return grid.map((row) => row.join(''));
}

/**
 * Run one random scenario: `vehicles` vehicles with random fleet parameters drive random routes for `seconds`, with
 * occasional breakdowns, speed-factor changes and detach/attach cycles; every tick is checked by the invariants.
 * @returns {object} { lines, layout, traffic, arrivals, deadlocks, vehicles }
 */
export function runRandomScenario({ seed, vehicles = 30, seconds = 1500, dt = 0.1, geometry = true }) {
  const rng = createRng(seed);
  let lines;
  let layout;
  let graph;
  let domain = [];
  for (let attempt = 0; attempt < 20 && domain.length < 4 * vehicles; attempt++) { // roomy enough for the fleet
    lines = randomRoadLines(rng.fork(`layout${attempt}`));
    layout = layoutFromAscii(lines, { cellSize: [1.5, 2, 3][rng.int(3)] });
    graph = buildGraph(layout);
    // vehicles live on the largest strongly connected part of the network so that every vehicle can always route
    const sizes = new Map();
    for (const n of graph.nodes) sizes.set(graph.scc[n], (sizes.get(graph.scc[n]) || 0) + 1);
    const biggest = [...sizes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    domain = biggest ? graph.nodes.filter((n) => graph.scc[n] === biggest[0]) : [];
  }
  vehicles = Math.min(vehicles, Math.floor(domain.length / 4));
  const traffic = new TrafficSystem(graph, { handedness: rng.next() < 0.5 ? 'right' : 'left', deadlockTime: 15, rng });
  const checker = createInvariantChecker(traffic, { geometry });
  const pick = rng.fork('plan');
  const result = { lines, layout, traffic, arrivals: 0, deadlocks: 0, vehicles: [] };

  const fleets = [
    { length: 1.2, speed: 1.5, accel: 0.6, decel: 1.0 },
    { length: 2.6, speed: 3.0, accel: 1.0, decel: 2.0 },
    { length: 0.8, speed: 1.0, accel: 0.4, decel: 0.8 },
  ];
  for (let tries = 0; result.vehicles.length < vehicles && tries < 400; tries++) {
    const node = domain[pick.int(domain.length)];
    const tv = traffic.addVehicle({ id: `v${result.vehicles.length}`, node, ...fleets[pick.int(fleets.length)] });
    if (tv) result.vehicles.push(tv);
  }
  /** A goal is fine if the vehicle can leave it again towards (most of) the network - no trap behind a forced turn. */
  const canLeave = (route) => {
    const back = graph.search(route.nodes[route.nodes.length - 1], { arrivalEdge: route.edges.length > 0 ? route.edges[route.edges.length - 1] : -1 });
    let reachable = 0;
    for (const n of domain) if (Number.isFinite(back.dist(n))) reachable++;
    return reachable * 2 >= domain.length;
  };
  const plan = (tv) => {
    const search = graph.search(tv.node, { arrivalEdge: tv.lastEdge });
    const reachable = domain.filter((n) => n !== tv.node && Number.isFinite(search.dist(n)));
    // docks are mostly on plain road cells; every seventh trip ends anywhere, junctions and dead ends included
    const plain = reachable.filter((n) => graph.controlled[n] === 0);
    const goals = pick.int(7) > 0 && plain.length > 0 ? plain : reachable;
    for (let tries = 0; tries < 12 && goals.length > 0; tries++) {
      const route = search.routeTo(goals[pick.int(goals.length)]);
      if (canLeave(route)) { traffic.drive(tv, route); return; }
    }
  };
  traffic.onArrive = (tv) => { result.arrivals++; plan(tv); };
  traffic.onDeadlock = (ev) => { if (ev.resolved && ev.victim) plan(ev.victim); };
  for (const tv of result.vehicles) plan(tv);

  const repairAt = new Map();
  const attachAt = new Map();
  const ticks = Math.round(seconds / dt);
  for (let i = 0; i < ticks; i++) {
    traffic.step(dt);
    try {
      checker.check();
    } catch (err) {
      err.message = `seed ${seed}, dt ${dt}: ${err.message}`;
      err.scenario = { lines, result };
      throw err;
    }
    const t = traffic.time;
    if (i % Math.round(25 / dt) === 0 && result.vehicles.length > 0) { // breakdown / detach events
      const tv = result.vehicles[pick.int(result.vehicles.length)];
      if (tv.onRoad && !tv.disabled && pick.next() < 0.5) {
        tv.disabled = true;
        repairAt.set(tv, t + 5 + pick.range(0, 20));
      } else if (tv.onRoad && !tv.driving && tv.node >= 0 && pick.next() < 0.5) {
        traffic.detach(tv);
        attachAt.set(tv, t + 5);
      }
    }
    if (i % Math.round(200 / dt) === 0) traffic.speedFactor = [1, 0.5, 1.5, 1][pick.int(4)];
    for (const [tv, when] of repairAt) if (t >= when) { tv.disabled = false; repairAt.delete(tv); }
    for (const [tv, when] of attachAt) {
      if (t < when) continue;
      const node = domain[pick.int(domain.length)];
      if (traffic.attach(tv, node)) { attachAt.delete(tv); plan(tv); }
    }
  }
  result.deadlocks = traffic.stats.deadlocks;
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Small world builder for hand-written scenarios
// ---------------------------------------------------------------------------------------------------------------

export const AGV = Object.freeze({ length: 1.2, speed: 1.5, accel: 0.6, decel: 1.0 });

/**
 * Build a traffic world from an ASCII road picture (tests/helpers/ascii.js).
 *   const w = createWorld(['>>>>>>>>']);
 *   const a = w.add({ id: 'a', x: 0, y: 0 });      // AGV defaults, override any field
 *   w.drive(a, 7, 0);                              // shortest legal route from where `a` stands
 *   w.run(20);                                     // 20 s in 0.1 s steps, invariants checked after every step
 * @param {string[]} lines
 * @param {object} [opts] { cell = 2 (m), traffic = {} (TrafficSystem options), layout = {} (layoutFromAscii options),
 *   mutate = (layout) => {} (edit the layout before the graph is built, e.g. set road limits),
 *   check = true (run the invariant checker), geometry = true }
 */
export function createWorld(lines, opts = {}) {
  const layout = layoutFromAscii(lines, { cellSize: opts.cell ?? 2, ...(opts.layout || {}) });
  if (opts.mutate) opts.mutate(layout);
  const graph = buildGraph(layout);
  const traffic = new TrafficSystem(graph, opts.traffic || {});
  const checker = opts.check === false ? null : createInvariantChecker(traffic, { geometry: opts.geometry !== false });
  const world = {
    layout, graph, traffic, checker,
    node: (x, y) => y * graph.cols + x,
    add(spec) {
      const { x, y, ...rest } = spec;
      const tv = traffic.addVehicle({ ...AGV, ...rest, node: world.node(x, y) });
      if (tv === null) throw new Error(`no room for ${spec.id} at ${x},${y}`);
      return tv;
    },
    /** Route from where the vehicle is parked to cell (x, y); false if there is none. */
    drive(tv, x, y) {
      const route = graph.search(tv.node, { arrivalEdge: tv.lastEdge }).routeTo(world.node(x, y));
      return route !== null && traffic.drive(tv, route);
    },
    /** Advance `seconds`, calling `onTick(traffic)` after every step; returns the number of steps. */
    run(seconds, dt = 0.1, onTick = null) {
      const steps = Math.round(seconds / dt);
      for (let i = 0; i < steps; i++) {
        traffic.step(dt);
        if (checker) checker.check();
        if (onTick) onTick(traffic);
      }
      return steps;
    },
    /** Step until `done()` is true (or `maxSeconds` pass); returns the elapsed simulated time. */
    runUntil(done, maxSeconds = 600, dt = 0.1) {
      const start = traffic.time;
      while (!done() && traffic.time - start < maxSeconds) {
        traffic.step(dt);
        if (checker) checker.check();
      }
      return traffic.time - start;
    },
  };
  return world;
}

/** Number of random scenarios of the full fuzz run, and the number of test files it is split into (node runs them in parallel). */
export const FUZZ_SCENARIOS = 100;
export const FUZZ_SHARDS = 8;

/** Time step of fuzz scenario `seed`: the four step sizes alternate within every shard. */
export const fuzzStep = (seed) => [0.1, 0.25, 0.5, 0.25][Math.floor((seed - 1) / FUZZ_SHARDS) % 4];

/**
 * Run scenarios `seed` = shard + 1, shard + 1 + FUZZ_SHARDS, ... up to FUZZ_SCENARIOS (30 vehicles, 1500 s each).
 * @returns {object[]} per scenario { seed, dt, vehicles, arrivals, deadlocks, time }
 */
export function runFuzzShard(shard) {
  const out = [];
  for (let seed = shard + 1; seed <= FUZZ_SCENARIOS; seed += FUZZ_SHARDS) {
    const dt = fuzzStep(seed);
    const r = runRandomScenario({ seed, vehicles: 30, seconds: 1500, dt });
    out.push({ seed, dt, vehicles: r.vehicles.length, arrivals: r.arrivals, deadlocks: r.deadlocks, time: r.traffic.time });
  }
  return out;
}
