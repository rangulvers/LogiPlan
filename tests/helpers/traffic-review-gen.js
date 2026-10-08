// Test helper for the adversarial review of the traffic engine (tests/sim.traffic.review.test.js).
//
// Deliberately independent of tests/helpers/traffic-invariants.js: this file never reads the engine's underscore
// fields. Every check works from the PUBLIC vehicle record of docs/ARCHITECTURE.md 5.2 (pose, size, speed, flags) and
// from the road graph, so a defect in the engine's own bookkeeping cannot hide itself.
//
//  * reviewWorld(lines, opts)      traffic system on an ASCII picture (tests/helpers/ascii.js)
//  * createReviewChecker(traffic)  per-tick physical checks; violations are COLLECTED (kind, time, details), not thrown
//  * streetLines / blobLines       random road pictures: streets on even lines, or dense blocks with random links
//  * runReviewScenario(opts)       seeded random fleet, trips, breakdowns, speed changes, detach / attach / remove / add

import { createRng } from '../../js/util/rng.js';
import { layoutFromAscii } from './ascii.js';
import { buildGraph } from '../../js/sim/graph.js';
import { TrafficSystem } from '../../js/sim/traffic.js';

// ---------------------------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------------------------

/** Corners of a vehicle's rectangle: `length` along the heading, `width` across. */
export function rectOf(tv, widthFactor = 1) {
  const hl = tv.length / 2;
  const hw = (tv.width * widthFactor) / 2;
  const c = Math.cos(tv.heading);
  const s = Math.sin(tv.heading);
  return [[hl, hw], [hl, -hw], [-hl, -hw], [-hl, hw]].map(([a, b]) => [tv.x + a * c - b * s, tv.y + a * s + b * c]);
}

/** Largest separating-axis distance of two convex polygons (> 0 apart, < 0 interpenetration depth). */
export function separation(pa, pb) {
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

/** Area of a convex polygon clipped to the axis-aligned box [x0,x1] x [y0,y1] (Sutherland-Hodgman). */
export function clippedArea(poly, x0, y0, x1, y1) {
  let pts = poly;
  const edges = [
    (p) => p[0] - x0, (p) => x1 - p[0], (p) => p[1] - y0, (p) => y1 - p[1],
  ];
  for (const side of edges) {
    const next = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const da = side(a);
      const db = side(b);
      if (da >= 0) next.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        next.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    pts = next;
    if (pts.length === 0) return 0;
  }
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    area += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area) / 2;
}

const angleDiff = (a, b) => {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
};

// ---------------------------------------------------------------------------------------------------------------
// Independent checker
// ---------------------------------------------------------------------------------------------------------------

/**
 * Per-tick checker bound to a TrafficSystem. Call `check()` after every `traffic.step`; read `violations` / `counts`.
 * Kinds: nan, speed, jump, decel, accel, overlap, headway, pathgap, cell (two vehicle centres in one controlled cell), cellFoot (two footprints reach into one), stats.
 * `opts`: overlapTol (m of interpenetration, default 0.02), cellAreaTol (m^2 of intrusion into a controlled cell
 * that still counts as "outside", default 0.03), headwayTol (m, default 1e-6), keep (max stored violations).
 */
export function createReviewChecker(traffic, opts = {}) {
  const g = traffic.graph;
  const L = g.cellSize;
  const overlapTol = opts.overlapTol ?? 0.02;
  const cellAreaTol = opts.cellAreaTol ?? 0.15;
  const headwayTol = opts.headwayTol ?? 1e-6;
  const keep = opts.keep ?? 40;
  const violations = [];
  const counts = {};
  const worst = {}; // kind -> worst magnitude
  const prev = new Map();
  let lastTime = traffic.time;
  let ticks = 0;

  const report = (kind, message, magnitude = 0) => {
    counts[kind] = (counts[kind] || 0) + 1;
    worst[kind] = Math.max(worst[kind] ?? 0, magnitude);
    if (violations.length < keep) violations.push({ kind, t: +traffic.time.toFixed(3), message });
  };

  function perVehicle(tv, dt) {
    for (const k of ['x', 'y', 'heading', 'v', 'odometer', 'waitTime', 's', 'prevX', 'prevY', 'prevHeading']) {
      if (!Number.isFinite(tv[k])) report('nan', `${tv.id}.${k} = ${tv[k]}`);
    }
    const cap = tv.vmax * Math.max(traffic.speedFactor, 0) + 1e-9;
    const before = prev.get(tv);
    const teleported = before && before.teleports !== tv.teleports;
    if (tv.v < -1e-12) report('speed', `${tv.id} negative speed ${tv.v}`, -tv.v);
    if (tv.v > cap && !(before && !teleported && tv.v <= before.v + 1e-9)) report('speed', `${tv.id} v=${tv.v} above cap ${cap}`, tv.v - cap);
    if (before && !teleported && dt > 0) {
      const jump = Math.hypot(tv.x - before.x, tv.y - before.y);
      const maxStep = Math.max(tv.vmax * Math.max(1, traffic.speedFactor), before.v, tv.v) * dt + 0.05;
      if (jump > maxStep) report('jump', `${tv.id} moved ${jump.toFixed(3)} m in ${dt} s (limit ${maxStep.toFixed(3)})`, jump - maxStep);
      // braking harder than the vehicle's own decel (allowed only by an exact stop snap, so it is measured, not forbidden)
      const drop = (before.v - tv.v) / dt;
      if (drop > tv.decel * 1.0001 + 1e-9) report('decel', `${tv.id} braked at ${drop.toFixed(2)} m/s^2 (decel ${tv.decel}) v ${before.v.toFixed(2)} -> ${tv.v.toFixed(2)}`, drop / tv.decel);
      const rise = (tv.v - before.v) / dt;
      if (rise > tv.accel * 1.0001 + 1e-9) report('accel', `${tv.id} accelerated at ${rise.toFixed(2)} m/s^2 (accel ${tv.accel})`, rise / tv.accel);
    }
    prev.set(tv, { x: tv.x, y: tv.y, v: tv.v, teleports: tv.teleports });
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
        if (gap < -overlapTol) report('overlap', `${a.id} and ${b.id} overlap by ${(-gap).toFixed(3)} m at (${a.x.toFixed(2)},${a.y.toFixed(2)}) / (${b.x.toFixed(2)},${b.y.toFixed(2)})`, -gap);
        headway(a, b, dx, dy);
      }
    }
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
    const axis = (h) => { const q = Math.abs(h / (Math.PI / 2)); return Math.abs(q - Math.round(q)) < 0.01; };
    const ux = Math.cos(a.heading);
    const uy = Math.sin(a.heading);
    const lateral = Math.abs(-dx * uy + dy * ux);
    if (lateral > Math.min(a.width, b.width) * 0.6) return;
    if (axis(a.heading) && axis(b.heading) && Math.abs(angleDiff(a.heading, b.heading)) < 0.01) {
      const gap = Math.abs(dx * ux + dy * uy) - (a.length + b.length) / 2;
      if (gap < hw - headwayTol - 0.005) report('headway', `${a.id}/${b.id} bumper gap ${gap.toFixed(3)} < headway ${hw} on a straight`, hw - gap);
      return;
    }
    if (Math.abs(angleDiff(a.heading, b.heading)) > 0.5) return; // one of them has just turned in from another street
    const pa = onEdge(a);
    const pb = onEdge(b);
    if (pa === null || pb === null) return;
    for (const [f, l] of [[pa, pb], [pb, pa]]) {
      let d = null;
      if (f[0] === l[0] && l[1] > f[1]) d = l[1] - f[1];
      else if (f[0] !== l[0] && g.edges[f[0]].to === g.edges[l[0]].from && g.edges[f[0]].dir === g.edges[l[0]].dir) d = L - f[1] + l[1];
      if (d === null) continue;
      const gap = d - (a.length + b.length) / 2;
      if (gap < hw - headwayTol - 0.005) report('pathgap', `${a.id}/${b.id} gap along the road ${gap.toFixed(3)} < headway ${hw}`, hw - gap);
    }
  }

  /**
   * At most one vehicle may be inside a controlled cell: by its centre (kind 'cell'), and, with a tolerance for the swing
   * of a rigid body around a corner, by its footprint (kind 'cellFoot', more than `cellAreaTol` m^2 of the body in the cell).
   */
  function cells() {
    const centres = new Map();
    const feet = new Map();
    for (const tv of traffic.vehicles) {
      if (!tv.onRoad) continue;
      const node = Math.floor(tv.y / L) * g.cols + Math.floor(tv.x / L);
      if (node >= 0 && node < g.nodeCount && g.isNode[node] && g.controlled[node] === 1) {
        const other = centres.get(node);
        if (other) report('cell', `${other.id} and ${tv.id} are both centred in controlled cell ${g.cx(node)},${g.cy(node)}`, 1);
        else centres.set(node, tv);
      }
      const poly = rectOf(tv);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const [x, y] of poly) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
      for (let cy = Math.max(0, Math.floor(minY / L)); cy <= Math.min(g.rows - 1, Math.floor(maxY / L)); cy++) {
        for (let cx = Math.max(0, Math.floor(minX / L)); cx <= Math.min(g.cols - 1, Math.floor(maxX / L)); cx++) {
          const n = cy * g.cols + cx;
          if (!g.isNode[n] || g.controlled[n] !== 1) continue;
          const area = clippedArea(poly, cx * L, cy * L, (cx + 1) * L, (cy + 1) * L);
          if (area <= cellAreaTol) continue;
          const other = feet.get(n);
          if (other) report('cellFoot', `${other.tv.id} and ${tv.id} both reach into controlled cell ${cx},${cy} (${other.area.toFixed(3)} / ${area.toFixed(3)} m^2)`, Math.min(area, other.area));
          else feet.set(n, { tv, area });
        }
      }
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
    violations, counts, worst,
    check() {
      const dt = traffic.time - lastTime;
      for (const tv of traffic.vehicles) if (tv.onRoad) perVehicle(tv, dt);
      pairs();
      cells();
      if (ticks++ % 25 === 0) stats();
      lastTime = traffic.time;
    },
    /** Violation kinds that make a scenario fail (decel / accel are measured separately). */
    hard() {
      return Object.keys(counts).filter((k) => k !== 'decel' && k !== 'accel');
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Worlds
// ---------------------------------------------------------------------------------------------------------------

export const AGV = Object.freeze({ length: 1.2, speed: 1.5, accel: 0.6, decel: 1.0 });

/**
 * Traffic system on an ASCII picture. opts: cell (m, default 2), traffic (TrafficSystem options), check (default true).
 * w.add({ id, x, y, ...vehicle }) places a vehicle (AGV defaults); w.go(tv, x, y) routes it; w.run(seconds, dt) steps.
 */
export function reviewWorld(lines, opts = {}) {
  const layout = layoutFromAscii(lines, { cellSize: opts.cell ?? 2 });
  if (opts.mutate) opts.mutate(layout);
  const graph = buildGraph(layout);
  const traffic = new TrafficSystem(graph, opts.traffic || {});
  const checker = opts.check === false ? null : createReviewChecker(traffic, opts.checker || {});
  const w = {
    layout, graph, traffic, checker,
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
    run(seconds, dt = 0.1, onTick = null) {
      const steps = Math.round(seconds / dt);
      for (let i = 0; i < steps; i++) {
        traffic.step(dt);
        if (checker) checker.check();
        if (onTick) onTick(traffic, i);
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

const FLEETS = [
  { length: 1.2, speed: 1.5, accel: 0.6, decel: 1.0 },
  { length: 2.6, speed: 3.0, accel: 1.0, decel: 2.0 },
  { length: 0.8, speed: 1.0, accel: 0.4, decel: 0.8 },
  { length: 1.0, speed: 4.0, accel: 1.5, decel: 0.5 }, // fast with weak brakes
  { length: 1.6, speed: 0.6, accel: 0.3, decel: 0.3 }, // slow and sluggish
  { length: 3.0, speed: 2.0, accel: 0.5, decel: 1.0 }, // long
];

/**
 * One seeded scenario. Returns { lines, traffic, checker, vehicles, arrivals, stuck, moves }.
 * opts: seed, dt, seconds, vehicles, kind ('streets' | 'blob' | 'mixed'), chaos (0..1, share of random API abuse), dwellProb (share of trips ending in a pause), plainOnly (trips end only on cells that are not junctions),
 * resolve (resolveDeadlocks, default true), fleets (indexes into FLEETS), cells (candidate cell sizes).
 */
export function runReviewScenario(opts) {
  const { seed, dt = 0.1, seconds = 600, vehicles = 20, kind = 'mixed', chaos = 0.3, resolve = true, dwellProb = 0.3, plainOnly = false } = opts;
  const rng = createRng(seed);
  const pick = rng.fork('pick');
  const ev = rng.fork('events');
  let lines;
  let graph;
  let domain = [];
  const cellSize = (opts.cells || [1.5, 2, 3, 5])[rng.int((opts.cells || [1.5, 2, 3, 5]).length)];
  for (let attempt = 0; attempt < 30 && domain.length < 3 * vehicles; attempt++) {
    const r = rng.fork('layout' + attempt);
    lines = kind === 'blob' || (kind === 'mixed' && seed % 3 === 0) ? blobLines(r) : streetLines(r);
    graph = buildGraph(layoutFromAscii(lines, { cellSize }));
    domain = mainComponent(graph);
  }
  const n = Math.min(vehicles, Math.max(2, Math.floor(domain.length / 3)));
  const handedness = rng.next() < 0.5 ? 'right' : 'left';
  const headwayPick = [0.5, 0.5, 0.3, 1][rng.int(4)];
  const headway = opts.headway ?? headwayPick;
  const traffic = new TrafficSystem(graph, { handedness, headway, deadlockTime: 10 + rng.int(20), resolveDeadlocks: resolve });
  const checker = createReviewChecker(traffic, opts.checker || {});
  const fleetPool = opts.fleets || FLEETS.map((_, i) => i);
  const result = { lines, traffic, checker, vehicles: [], arrivals: 0, deadlocks: 0, stuck: [], handedness, headway, cellSize };

  const startCells = plainOnly ? domain.filter((x) => graph.controlled[x] === 0) : domain;
  const spawn = (i) => {
    for (let tries = 0; tries < 60; tries++) {
      const fl = FLEETS[fleetPool[pick.int(fleetPool.length)]];
      if (fl.length > 1.5 * cellSize) continue;
      const tv = traffic.addVehicle({ id: `v${i}`, node: startCells[pick.int(startCells.length)], ...fl });
      if (tv) return tv;
    }
    return null;
  };
  for (let i = 0; i < n; i++) { const tv = spawn(i); if (tv) result.vehicles.push(tv); }

  const dwellUntil = new Map();
  /** A goal is fine if the vehicle can leave it again towards most of the network (no trap behind a forced turn). */
  const canLeave = (route) => {
    const back = graph.search(route.nodes[route.nodes.length - 1], { arrivalEdge: route.edges.length > 0 ? route.edges[route.edges.length - 1] : -1 });
    let reachable = 0;
    for (const x of domain) if (Number.isFinite(back.dist(x))) reachable++;
    return reachable * 2 >= domain.length;
  };
  const plan = (tv) => {
    if (!tv.onRoad || tv.driving || tv.node < 0) return;
    const s = graph.search(tv.node, { arrivalEdge: tv.lastEdge });
    const reach = domain.filter((x) => x !== tv.node && Number.isFinite(s.dist(x)) && (!plainOnly || graph.controlled[x] === 0));
    for (let tries = 0; tries < 12 && reach.length > 0; tries++) {
      const route = s.routeTo(reach[pick.int(reach.length)]);
      if (route && canLeave(route) && traffic.drive(tv, route)) return;
    }
  };
  traffic.onArrive = (tv) => { result.arrivals++; dwellUntil.set(tv, traffic.time + (pick.next() < dwellProb ? pick.range(0, 40) : 0)); };
  traffic.onDeadlock = (e) => { if (e.resolved && e.victim) dwellUntil.set(e.victim, traffic.time); };
  for (const tv of result.vehicles) dwellUntil.set(tv, 0);

  const repairAt = new Map();
  const attachAt = new Map();
  const progress = new Map(); // tv -> { odo, t }
  const steps = Math.round(seconds / dt);
  const evEvery = Math.max(1, Math.round(15 / dt));
  for (let i = 0; i < steps; i++) {
    for (const tv of result.vehicles) {
      if (tv.onRoad && !tv.driving && tv.node >= 0 && (dwellUntil.get(tv) ?? 0) <= traffic.time) plan(tv);
    }
    traffic.step(dt);
    checker.check();
    const t = traffic.time;
    for (const tv of result.vehicles) {
      if (!tv.onRoad || !tv.driving || tv.disabled) { progress.delete(tv); continue; }
      const p = progress.get(tv);
      if (!p || tv.odometer - p.odo > 0.2) progress.set(tv, { odo: tv.odometer, t });
      else if (t - p.t > 400 && !result.stuck.includes(tv.id)) result.stuck.push(tv.id);
    }
    if (i % evEvery === 0 && ev.next() < chaos && result.vehicles.length > 0) chaosEvent(tv0());
    for (const [tv, when] of repairAt) if (t >= when) { tv.disabled = false; repairAt.delete(tv); }
    for (const [tv, when] of attachAt) {
      if (t < when || !tv.vehicleAlive) continue;
      if (traffic.attach(tv, domain[pick.int(domain.length)])) { attachAt.delete(tv); dwellUntil.set(tv, t); }
    }
  }
  function tv0() { return result.vehicles[ev.int(result.vehicles.length)]; }
  function chaosEvent(tv) {
    const op = ev.int(10);
    const t = traffic.time;
    if (op === 0 && tv.onRoad && !tv.disabled) { tv.disabled = true; repairAt.set(tv, t + 3 + ev.range(0, 30)); }
    else if (op === 1) traffic.speedFactor = [1, 0.1, 0.5, 2, 1, 0.25][ev.int(6)];
    else if (op === 2 && tv.onRoad && !tv.driving && tv.node >= 0) { traffic.detach(tv); tv.vehicleAlive = true; attachAt.set(tv, t + 3 + ev.range(0, 10)); }
    else if (op === 3 && tv.onRoad && !tv.driving && tv.node >= 0) {
      const to = domain[ev.int(domain.length)];
      traffic.relocate(tv, to);
    } else if (op === 4 && result.vehicles.length < n + 6) {
      const nv = spawn(result.vehicles.length + 100);
      if (nv) { result.vehicles.push(nv); dwellUntil.set(nv, t); }
    } else if (op === 5 && result.vehicles.length > 4) {
      const k = result.vehicles.indexOf(tv);
      traffic.removeVehicle(tv);
      attachAt.delete(tv);
      repairAt.delete(tv);
      result.vehicles.splice(k, 1);
    } else if (op === 6 && tv.onRoad && tv.driving) { // drive() on a driving vehicle must be a harmless refusal
      const before = [tv.node, tv.edge, tv.s, tv.v, tv.x, tv.y].join();
      const s = graph.search(domain[0], {});
      const route = s.routeTo(domain[ev.int(domain.length)]);
      const ok = route ? traffic.drive(tv, route) : false;
      if (ok || [tv.node, tv.edge, tv.s, tv.v, tv.x, tv.y].join() !== before) checker.violations.push({ kind: 'api', t, message: `drive() on driving ${tv.id} returned ${ok}` });
    }
  }
  result.deadlocks = traffic.stats.deadlocks;
  return result;
}
