// Test helper for the adversarial review of the traffic engine (tests/sim.traffic.review.test.js).
//
// Deliberately independent of tests/helpers/traffic-invariants.js: this file never reads the engine's underscore
// fields. Every check works from the PUBLIC vehicle record of docs/ARCHITECTURE.md 5.2 (pose, size, speed, flags) and
// from the road graph, so a defect in the engine's own bookkeeping cannot hide itself.
//
//  * reviewWorld(lines, opts)      traffic system on an ASCII picture (tests/helpers/ascii.js)
//  * createReviewChecker(traffic)  per-tick physical checks; violations are COLLECTED (kind, time, details), not thrown
//  * streetLines / blobLines / spurLines   random road pictures: streets on even lines, dense blocks with random links,
//                                  a main street with dead-end spurs
//  * runReviewScenario(opts)       seeded random fleet, trips, breakdowns, speed changes, detach / attach / remove / add

import { createRng } from '../../js/util/rng.js';
import { layoutFromAscii } from './ascii.js';
import { buildGraph } from '../../js/sim/graph.js';
import { TrafficSystem } from '../../js/sim/traffic.js';

// ---------------------------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------------------------

/** Corners of a vehicle's rectangle: `length` along the heading, `width` across. */
function rectOf(tv) {
  const hl = tv.length / 2;
  const hw = tv.width / 2;
  const c = Math.cos(tv.heading);
  const s = Math.sin(tv.heading);
  return [[hl, hw], [hl, -hw], [-hl, -hw], [-hl, hw]].map(([a, b]) => [tv.x + a * c - b * s, tv.y + a * s + b * c]);
}

/** Largest separating-axis distance of two convex polygons (> 0 apart, < 0 interpenetration depth). */
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

/** Gap between the bodies (full length x full width) of two vehicles: > 0 apart, < 0 overlapping. */
export const bodyGap = (a, b) => separation(rectOf(a), rectOf(b));

/** Signed shortest rotation from angle a to angle b. */
function angleDiff(a, b) {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

const isAxisAligned = (h) => {
  const q = Math.abs(h / (Math.PI / 2));
  return Math.abs(q - Math.round(q)) < 0.01;
};

// ---------------------------------------------------------------------------------------------------------------
// Independent checker
// ---------------------------------------------------------------------------------------------------------------

/**
 * Per-tick checker bound to a TrafficSystem. Call `check()` after every `traffic.step`; read `violations` (the first
 * 40: kind, time, message), `counts` and `worst` (kind -> largest magnitude).
 *
 * Kinds: nan, speed (negative, or above vmax * speedFactor while not slowing down), jump (pose moved further than the
 * speed allows), overlap (bodies interpenetrate by more than 2 cm), headway (straight pair closer than the headway),
 * pathgap (the same measured along the road for vehicles on one edge or two consecutive ones), cell (two vehicle
 * centres in one controlled cell), stats (totals that do not add up), api (set by the scenario runner).
 */
export function createReviewChecker(traffic) {
  const g = traffic.graph;
  const L = g.cellSize;
  const violations = [];
  const counts = {};
  const worst = {};
  const prev = new Map(); // tv -> { x, y, v, teleports } at the previous check
  let lastTime = traffic.time;
  let ticks = 0;

  const report = (kind, message, magnitude = 0) => {
    counts[kind] = (counts[kind] || 0) + 1;
    worst[kind] = Math.max(worst[kind] ?? 0, magnitude);
    if (violations.length < 40) violations.push({ kind, t: +traffic.time.toFixed(3), message });
  };

  function perVehicle(tv, dt) {
    for (const k of ['x', 'y', 'heading', 'v', 'odometer', 'waitTime', 's', 'prevX', 'prevY', 'prevHeading']) {
      if (!Number.isFinite(tv[k])) report('nan', `${tv.id}.${k} = ${tv[k]}`);
    }
    const cap = tv.vmax * Math.max(traffic.speedFactor, 0) + 1e-9;
    const before = prev.get(tv);
    const teleported = before !== undefined && before.teleports !== tv.teleports;
    if (tv.v < -1e-12) report('speed', `${tv.id} negative speed ${tv.v}`, -tv.v);
    if (tv.v > cap && !(before !== undefined && !teleported && tv.v <= before.v + 1e-9)) report('speed', `${tv.id} v=${tv.v} above cap ${cap}`, tv.v - cap);
    if (before !== undefined && !teleported && dt > 0) {
      const jump = Math.hypot(tv.x - before.x, tv.y - before.y);
      const maxStep = Math.max(tv.vmax * Math.max(1, traffic.speedFactor), before.v, tv.v) * dt + 0.05;
      if (jump > maxStep) report('jump', `${tv.id} moved ${jump.toFixed(3)} m in ${dt} s (limit ${maxStep.toFixed(3)})`, jump - maxStep);
    }
    prev.set(tv, { x: tv.x, y: tv.y, v: tv.v, teleports: tv.teleports });
  }

  /** Position of a vehicle along the edge network: [edge, s] (a parked vehicle stands at the head of its last edge), or null. */
  function onEdge(tv) {
    if (tv.driving && tv.edge >= 0) return [tv.edge, tv.s];
    if (!tv.driving && tv.node >= 0 && tv.lastEdge >= 0) return [tv.lastEdge, L];
    return null;
  }

  /**
   * Two vehicles in one lane keep the headway bumper to bumper. Straight pairs (both axis aligned, same heading) are
   * measured on the pose; pairs on the same edge or on consecutive edges are measured along the road (the spec's
   * "along the route"), which also holds around corners where the chord between the bumpers is shorter.
   */
  function headway(a, b, dx, dy) {
    const hw = traffic.headway;
    const ux = Math.cos(a.heading);
    const uy = Math.sin(a.heading);
    if (Math.abs(-dx * uy + dy * ux) > Math.min(a.width, b.width) * 0.6) return; // not in the same lane
    const turn = Math.abs(angleDiff(a.heading, b.heading));
    if (isAxisAligned(a.heading) && isAxisAligned(b.heading) && turn < 0.01) {
      const gap = Math.abs(dx * ux + dy * uy) - (a.length + b.length) / 2;
      if (gap < hw - 0.005) report('headway', `${a.id}/${b.id} bumper gap ${gap.toFixed(3)} < headway ${hw} on a straight`, hw - gap);
      return;
    }
    if (turn > 0.2) return; // one of them is turning in from another street, its rear still back there
    const pa = onEdge(a);
    const pb = onEdge(b);
    if (pa === null || pb === null) return;
    for (const [f, l] of [[pa, pb], [pb, pa]]) {
      let d = null;
      if (f[0] === l[0] && l[1] > f[1]) d = l[1] - f[1];
      else if (f[0] !== l[0] && g.edges[f[0]].to === g.edges[l[0]].from && g.edges[f[0]].dir === g.edges[l[0]].dir) d = L - f[1] + l[1];
      if (d === null) continue;
      const gap = d - (a.length + b.length) / 2;
      if (gap < hw - 0.005) report('pathgap', `${a.id}/${b.id} gap along the road ${gap.toFixed(3)} < headway ${hw}`, hw - gap);
    }
  }

  function pairs() {
    const vs = traffic.vehicles.filter((tv) => tv.onRoad);
    for (let i = 0; i < vs.length; i++) {
      for (let j = i + 1; j < vs.length; j++) {
        const a = vs[i];
        const b = vs[j];
        const reach = (a.length + b.length) / 2 + a.width + b.width;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (dx * dx + dy * dy > reach * reach) continue;
        const gap = separation(rectOf(a), rectOf(b));
        if (gap < -0.02) report('overlap', `${a.id} and ${b.id} overlap by ${(-gap).toFixed(3)} m at (${a.x.toFixed(2)},${a.y.toFixed(2)}) / (${b.x.toFixed(2)},${b.y.toFixed(2)})`, -gap);
        headway(a, b, dx, dy);
      }
    }
  }

  /** At most one vehicle centre may be inside a controlled cell. */
  function cells() {
    const centres = new Map();
    for (const tv of traffic.vehicles) {
      if (!tv.onRoad) continue;
      const node = Math.floor(tv.y / L) * g.cols + Math.floor(tv.x / L);
      if (!(node >= 0 && node < g.nodeCount && g.isNode[node] && g.controlled[node] === 1)) continue;
      const other = centres.get(node);
      if (other !== undefined) report('cell', `${other.id} and ${tv.id} are both centred in controlled cell ${g.cx(node)},${g.cy(node)}`, 1);
      else centres.set(node, tv);
    }
  }

  function stats() {
    const st = traffic.stats;
    const sum = st.waitVehicle + st.waitJunction + st.waitBroken;
    if (Math.abs(sum - st.totalWait) > 1e-6) report('stats', `totalWait ${st.totalWait} != ${sum}`);
    if (st.totalWait > st.drivingTime + 1e-6) report('stats', `totalWait ${st.totalWait} > drivingTime ${st.drivingTime}`);
    let e = 0;
    for (const x of st.edgeWait) e += x;
    let n = 0;
    for (const x of st.nodeWait) n += x;
    if (Math.abs(e - st.totalWait) > 1e-6 || Math.abs(n - st.totalWait) > 1e-6) report('stats', `edgeWait ${e} / nodeWait ${n} != totalWait ${st.totalWait}`);
  }

  return {
    violations, counts, worst, report,
    check() {
      const dt = traffic.time - lastTime;
      for (const tv of traffic.vehicles) if (tv.onRoad) perVehicle(tv, dt);
      pairs();
      cells();
      if (ticks++ % 25 === 0) stats();
      lastTime = traffic.time;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Worlds
// ---------------------------------------------------------------------------------------------------------------

const AGV = Object.freeze({ length: 1.2, speed: 1.5, accel: 0.6, decel: 1.0 });

/**
 * Traffic system on an ASCII picture. opts: cell (m, default 2), traffic (TrafficSystem options), check (default true).
 * w.add({ id, x, y, ...vehicle }) places a vehicle (AGV defaults); w.go(tv, x, y) routes it from where it stands;
 * w.run(seconds, dt) and w.runUntil(done, maxSeconds, dt) step the system (and the checker).
 */
export function reviewWorld(lines, opts = {}) {
  const layout = layoutFromAscii(lines, { cellSize: opts.cell ?? 2 });
  const graph = buildGraph(layout);
  const traffic = new TrafficSystem(graph, opts.traffic || {});
  const checker = opts.check === false ? null : createReviewChecker(traffic);
  const w = {
    graph, traffic, checker,
    node: (x, y) => y * graph.cols + x,
    add(spec) {
      const { x, y, ...rest } = spec;
      const tv = traffic.addVehicle({ ...AGV, ...rest, node: w.node(x, y) });
      if (tv === null) throw new Error(`no room for ${spec.id} at ${x},${y}`);
      return tv;
    },
    route(tv, x, y) {
      return graph.search(tv.node, { arrivalEdge: tv.lastEdge }).routeTo(w.node(x, y));
    },
    go(tv, x, y) {
      const route = w.route(tv, x, y);
      return route !== null && traffic.drive(tv, route);
    },
    run(seconds, dt = 0.1) {
      for (let i = 0, steps = Math.round(seconds / dt); i < steps; i++) {
        traffic.step(dt);
        if (checker) checker.check();
      }
    },
    runUntil(done, maxSeconds = 300, dt = 0.1) {
      const t0 = traffic.time;
      while (!done() && traffic.time - t0 < maxSeconds) {
        traffic.step(dt);
        if (checker) checker.check();
      }
      return traffic.time - t0;
    },
  };
  return w;
}

// ---------------------------------------------------------------------------------------------------------------
// Random road pictures
// ---------------------------------------------------------------------------------------------------------------

/** Streets (two-way or one-way) on even lines crossing each other, plus short stubs on odd lines. */
export function streetLines(rng, minCols = 14) {
  const cols = minCols + rng.int(14);
  const rows = 12 + rng.int(10);
  const grid = Array.from({ length: rows }, () => Array(cols).fill('.'));
  const put = (x, y, ch) => { grid[y][x] = grid[y][x] === '.' || grid[y][x] === ch ? ch : '+'; };
  const street = (horizontal, lane, start, len, ch) => {
    for (let i = start; i < start + len; i++) { if (horizontal) put(i, lane, ch); else put(lane, i, ch); }
  };
  for (let k = 0, n = 5 + rng.int(6); k < n; k++) {
    const horizontal = rng.next() < 0.5;
    const extent = horizontal ? cols : rows;
    const lanes = horizontal ? rows : cols;
    const len = Math.min(extent, 5 + rng.int(extent - 4));
    const twoWay = rng.next() < 0.55;
    const ch = twoWay ? '+' : (horizontal ? (rng.next() < 0.5 ? '>' : '<') : (rng.next() < 0.5 ? 'v' : '^'));
    street(horizontal, 2 * rng.int(Math.floor(lanes / 2)), rng.int(extent - len + 1), len, ch);
  }
  for (let k = 0; k < 3; k++) {
    const horizontal = rng.next() < 0.5;
    const extent = horizontal ? cols : rows;
    const lanes = horizontal ? rows : cols;
    street(horizontal, 1 + 2 * rng.int(Math.floor((lanes - 1) / 2)), rng.int(extent - 3), 2 + rng.int(2), '+');
  }
  return grid.map((row) => row.join(''));
}

/** Dense blocks: random cells of a small grid, each either two-way or one-way in a random direction (adjacent roads link). */
export function blobLines(rng) {
  const cols = 7 + rng.int(7);
  const rows = 7 + rng.int(6);
  const density = 0.45 + rng.next() * 0.3;
  const twoWayShare = rng.next();
  const lines = [];
  for (let y = 0; y < rows; y++) {
    let line = '';
    for (let x = 0; x < cols; x++) {
      if (rng.next() > density) line += '.';
      else if (rng.next() < twoWayShare) line += '+';
      else line += '>v<^'[rng.int(4)];
    }
    lines.push(line);
  }
  return lines;
}

/** A two-way main street with dead-end spurs of random depth on alternate cells (many U-turns) and a few one-way loops. */
function spurLines(rng) {
  const cols = 12 + rng.int(10);
  const rows = 9 + rng.int(4);
  const grid = Array.from({ length: rows }, () => Array(cols).fill('.'));
  for (let x = 0; x < cols; x++) grid[0][x] = '+';
  for (let x = 1 + rng.int(2); x < cols; x += 2) {
    const depth = 1 + rng.int(rows - 2);
    for (let y = 1; y <= depth; y++) grid[y][x] = '+';
  }
  return grid.map((row) => row.join(''));
}

/** Largest strongly connected set of road cells (vehicles live there so that every vehicle can always route). */
export function mainComponent(graph) {
  const sizes = new Map();
  for (const n of graph.nodes) sizes.set(graph.scc[n], (sizes.get(graph.scc[n]) || 0) + 1);
  const best = [...sizes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  return best ? graph.nodes.filter((n) => graph.scc[n] === best[0]) : [];
}

// ---------------------------------------------------------------------------------------------------------------
// Random scenarios
// ---------------------------------------------------------------------------------------------------------------

/** Vehicle types of the random fleets (index = value in the `fleets` option). */
const FLEETS = [
  { length: 1.2, speed: 1.5, accel: 0.6, decel: 1.0 }, // 0 AGV
  { length: 2.6, speed: 3.0, accel: 1.0, decel: 2.0 }, // 1 forklift
  { length: 0.8, speed: 1.0, accel: 0.4, decel: 0.8 }, // 2 small and slow
  { length: 1.0, speed: 4.0, accel: 1.5, decel: 0.5 }, // 3 fast with weak brakes
  { length: 1.6, speed: 0.6, accel: 0.3, decel: 0.3 }, // 4 sluggish
  { length: 3.0, speed: 2.0, accel: 0.5, decel: 1.0 }, // 5 long
];

/** Kinds of road picture a scenario can use. */
const PICTURES = { streets: streetLines, blob: blobLines, spurs: spurLines };

/**
 * One seeded scenario: a random road picture, a fleet that keeps driving to random cells, and (with `chaos`) random
 * breakdowns, speed-factor changes, detach / attach, relocate, add / remove and refused drive() calls. The independent
 * checker runs after every tick.
 *
 * opts: seed; dt (0.1); seconds (600); vehicles (20); kind ('streets' | 'blob' | 'spurs', default streets);
 *   chaos (share of random API abuse, 0.3); dwellProb (share of trips that end in a pause of up to 40 s, 0.3);
 *   plainOnly (start and end only on cells that are not junctions); resolve (resolveDeadlocks, true);
 *   slowZones (share of road cells with a speed limit factor of 0.25 .. 0.9, default none);
 *   headway (default: random); fleets (indexes into the vehicle types, default 0 and 2); cells (candidate cell sizes, default 2 and 3);
 *   bodies (own list of vehicle types { length, speed, accel, decel } that `fleets` indexes into instead of FLEETS).
 * @returns {object} { lines, traffic, checker, vehicles, arrivals, cellSize, handedness }
 */
export function runReviewScenario(opts) {
  const { seed, dt = 0.1, seconds = 600, vehicles = 20, kind = 'streets', chaos = 0.3, dwellProb = 0.3, plainOnly = false, resolve = true, slowZones = 0 } = opts;
  const rng = createRng(seed);
  const pick = rng.fork('pick');
  const ev = rng.fork('events');
  const cells = opts.cells || [2, 3];
  const fleets = opts.fleets || [0, 2];
  const types = opts.bodies || FLEETS;
  const cellSize = cells[rng.int(cells.length)];
  let lines;
  let graph;
  let domain = [];
  for (let attempt = 0; attempt < 30 && domain.length < 3 * vehicles; attempt++) {
    lines = PICTURES[kind](rng.fork('layout' + attempt));
    const layout = layoutFromAscii(lines, { cellSize });
    if (slowZones > 0) {
      const zones = rng.fork('zones' + attempt);
      for (const cell of Object.values(layout.roads)) if (zones.next() < slowZones) cell.limit = 0.25 + 0.65 * zones.next();
    }
    graph = buildGraph(layout);
    domain = mainComponent(graph);
  }
  const handedness = rng.next() < 0.5 ? 'right' : 'left';
  const headway = opts.headway ?? [0.5, 0.5, 0.3, 1][rng.int(4)];
  const traffic = new TrafficSystem(graph, { handedness, headway, deadlockTime: 10 + rng.int(20), resolveDeadlocks: resolve });
  const checker = createReviewChecker(traffic);
  const result = { lines, traffic, checker, vehicles: [], arrivals: 0, cellSize, handedness };

  const startCells = plainOnly ? domain.filter((x) => graph.controlled[x] === 0) : domain;
  const spawn = (id) => {
    for (let tries = 0; tries < 60; tries++) {
      const tv = traffic.addVehicle({ id, node: startCells[pick.int(startCells.length)], ...types[fleets[pick.int(fleets.length)]] });
      if (tv) return tv;
    }
    return null;
  };
  for (let i = 0, n = Math.min(vehicles, Math.max(2, Math.floor(domain.length / 3))); i < n; i++) {
    const tv = spawn(`v${i}`);
    if (tv) result.vehicles.push(tv);
  }

  /** A goal is fine if the vehicle can leave it again towards most of the network (no trap behind a forced turn). */
  const canLeave = (route) => {
    const back = graph.search(route.nodes[route.nodes.length - 1], { arrivalEdge: route.edges.length > 0 ? route.edges[route.edges.length - 1] : -1 });
    let reachable = 0;
    for (const x of domain) if (Number.isFinite(back.dist(x))) reachable++;
    return reachable * 2 >= domain.length;
  };
  const plan = (tv) => {
    const s = graph.search(tv.node, { arrivalEdge: tv.lastEdge });
    const reach = domain.filter((x) => x !== tv.node && Number.isFinite(s.dist(x)) && (!plainOnly || graph.controlled[x] === 0));
    for (let tries = 0; tries < 12 && reach.length > 0; tries++) {
      const route = s.routeTo(reach[pick.int(reach.length)]);
      if (route && canLeave(route) && traffic.drive(tv, route)) return;
    }
  };
  const dwellUntil = new Map(); // tv -> time at which it may start its next trip
  traffic.onArrive = (tv) => {
    result.arrivals++;
    dwellUntil.set(tv, traffic.time + (pick.next() < dwellProb ? pick.range(0, 40) : 0));
  };
  traffic.onDeadlock = (e) => { if (e.resolved && e.victim) dwellUntil.set(e.victim, traffic.time); };

  const repairAt = new Map();
  const attachAt = new Map();
  let nextId = vehicles + 100;
  /** One random disturbance; `tv` is the vehicle it picks on. */
  const disturb = (tv) => {
    const t = traffic.time;
    switch (ev.int(7)) {
      case 0:
        if (tv.onRoad && !tv.disabled) { tv.disabled = true; repairAt.set(tv, t + 3 + ev.range(0, 30)); }
        break;
      case 1:
        traffic.speedFactor = [1, 0.1, 0.5, 2, 1, 0.25][ev.int(6)];
        break;
      case 2:
        if (tv.onRoad && !tv.driving && tv.node >= 0) { traffic.detach(tv); attachAt.set(tv, t + 3 + ev.range(0, 10)); }
        break;
      case 3:
        if (tv.onRoad && !tv.driving && tv.node >= 0) traffic.relocate(tv, domain[ev.int(domain.length)]);
        break;
      case 4:
        if (result.vehicles.length < vehicles + 6) {
          const nv = spawn(`v${nextId++}`);
          if (nv) result.vehicles.push(nv);
        }
        break;
      case 5:
        if (result.vehicles.length > 4) {
          traffic.removeVehicle(tv);
          attachAt.delete(tv);
          repairAt.delete(tv);
          result.vehicles.splice(result.vehicles.indexOf(tv), 1);
        }
        break;
      default:
        if (tv.onRoad && tv.driving) { // a second drive() on a driving vehicle is refused and changes nothing
          const before = [tv.node, tv.edge, tv.s, tv.v, tv.x, tv.y].join();
          const route = graph.search(domain[0], {}).routeTo(domain[ev.int(domain.length)]);
          const accepted = route ? traffic.drive(tv, route) : false;
          if (accepted || [tv.node, tv.edge, tv.s, tv.v, tv.x, tv.y].join() !== before) checker.report('api', `drive() on the driving vehicle ${tv.id} changed it`);
        }
    }
  };

  const evEvery = Math.max(1, Math.round(15 / dt));
  for (let i = 0, steps = Math.round(seconds / dt); i < steps; i++) {
    for (const tv of result.vehicles) {
      if (tv.onRoad && !tv.driving && tv.node >= 0 && (dwellUntil.get(tv) ?? 0) <= traffic.time) plan(tv);
    }
    traffic.step(dt);
    checker.check();
    const t = traffic.time;
    if (i % evEvery === 0 && ev.next() < chaos && result.vehicles.length > 0) disturb(result.vehicles[ev.int(result.vehicles.length)]);
    for (const [tv, when] of repairAt) if (t >= when) { tv.disabled = false; repairAt.delete(tv); }
    for (const [tv, when] of attachAt) {
      if (t >= when && traffic.attach(tv, domain[pick.int(domain.length)])) { attachAt.delete(tv); dwellUntil.set(tv, t); }
    }
  }
  return result;
}
