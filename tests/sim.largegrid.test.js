// The plan grows (320 x 320 cells at most): what the simulation must guarantee for a baseplate with a lot of empty room.
//   1. Translation invariance: the same plant on a bigger baseplate (cells added on any side, so that everything is shifted) gives
//      IDENTICAL results: KPIs, heat and vehicle poses (shifted by the same cells) on all three example plants, with all dispatch and
//      routing settings. Node ids are row-major, so a shift keeps their order and every tie is broken the same way.
//   2. The compact route search (js/sim/graph.js) answers exactly what the dense reference search of the old implementation answers.
//   3. Cost follows the ROAD graph, not the grid: a search, the search budget and the route cache do not care about empty cells.
//   4. The Two lines example runs at least 400 x real time on a 320 x 320 baseplate (measured factors are logged).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES as ALL_EXAMPLES } from '../js/model/examples.js';
import { legacyExamples } from './helpers/golden.js';

/** The three legacy examples: the catalogue also holds the warehouse examples since M1 (trucks, schema 2), which have their own tests (sim.examples.warehouse.test.js). */
const EXAMPLES = legacyExamples(ALL_EXAMPLES);
import { GRID_LIMITS } from '../js/model/defaults.js';
import * as L from '../js/model/layout.js';
import { Simulation } from '../js/sim/engine.js';
import { buildGraph } from '../js/sim/graph.js';
import { RouteCache, searchBudget } from '../js/sim/logistics/routing.js';
import { createRng } from '../js/util/rng.js';
import { blockPlant } from './helpers/engine-review-gen.js';

const MAX = GRID_LIMITS.maxCols;

/** Keys of a KPI report that name a PLACE (a cell or a node id): they move with the plant, so they are compared separately, mapped. */
const PLACE_KEYS = new Set(['node', 'nodes', 'cx', 'cy']);

/** The KPI report without the places it mentions, wherever it mentions them (hotspots, deadlock events, the docks of a station). */
function placeFree(report) {
  const strip = (value) => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !PLACE_KEYS.has(key)).map(([key, v]) => [key, strip(v)]));
    return value;
  };
  return strip(JSON.parse(JSON.stringify(report)));
}

/** Largest relative difference met by sameUpToRounding so far (logged at the end). */
let worstRelative = 0;

/**
 * Deep comparison: structure, strings, booleans and every count equal; floats equal up to rounding. Positions enter the
 * arithmetic (a vehicle's pose is a sum of the cell centre and a lane offset), so sums such as the driven distance differ in
 * the last bits (about 1e-16 relative) when the same plant stands at other coordinates; nothing else may differ.
 */
function sameUpToRounding(actual, expected, message, path = '') {
  if (typeof expected === 'number' && typeof actual === 'number') {
    const diff = Math.abs(actual - expected);
    const rel = diff / Math.max(1, Math.abs(actual), Math.abs(expected));
    worstRelative = Math.max(worstRelative, rel);
    assert.ok(rel <= 1e-9 || (Number.isNaN(actual) && Number.isNaN(expected)), `${message}: ${path} is ${actual}, expected ${expected}`);
  } else if (expected !== null && typeof expected === 'object') {
    assert.ok(actual !== null && typeof actual === 'object', `${message}: ${path} should be an object`);
    assert.deepEqual(Object.keys(actual), Object.keys(expected), `${message}: keys of ${path || 'the report'}`);
    for (const key of Object.keys(expected)) sameUpToRounding(actual[key], expected[key], message, `${path}.${key}`);
  } else assert.equal(actual, expected, `${message}: ${path}`);
}

function run(layout, seconds) {
  const sim = new Simulation(layout);
  sim.advance(seconds);
  return sim;
}

// ---- 1. translation invariance ------------------------------------------------------------------------------------------

test('growing the plant on any side gives identical KPIs, heat and vehicle poses on all three examples (seeded)', () => {
  const rng = createRng(2024);
  const dispatches = ['nearest', 'oldest', 'balanced'];
  let cases = 0;
  for (const example of EXAMPLES) {
    for (let k = 0; k < 6; k++) {
      const base = example.build();
      base.settings.seed = 1 + rng.int(1000);
      base.settings.dispatch = dispatches[k % 3];
      if (k % 2 === 1) base.settings.routing = 'congestion';
      const sides = { left: rng.int(3) ? rng.int(30) : 0, top: rng.int(3) ? rng.int(30) : 0, right: rng.int(3) ? rng.int(60) : 0, bottom: rng.int(3) ? rng.int(60) : 0 };
      if (k === 0) Object.assign(sides, { left: 8, top: 8 }); // always one case that shifts both ways
      const grown = L.cloneLayout(base);
      const g = L.growGrid(grown, sides);
      assert.deepEqual(L.checkInvariants(grown), []);
      const seconds = 1500;
      const a = run(base, seconds);
      const b = run(grown, seconds);
      const tag = `${example.id} #${k} seed ${base.settings.seed} ${base.settings.dispatch}/${base.settings.routing} grow ${JSON.stringify(sides)}`;
      sameUpToRounding(placeFree(b.kpis()), placeFree(a.kpis()), `${tag}: KPIs`);
      assert.ok(a.kpis().throughput.total > 0 || example.id === 'congestion-lab', `${tag}: the plant does produce`);
      // the places in the report are the same places, shifted
      const ha = a.kpis().traffic.hotspots;
      const hb = b.kpis().traffic.hotspots;
      assert.equal(hb.length, ha.length);
      hb.forEach((h, i) => {
        assert.deepEqual([h.cx - g.dx, h.cy - g.dy], [ha[i].cx, ha[i].cy], `${tag}: hotspot ${i}`);
        sameUpToRounding(h.wait, ha[i].wait, `${tag}: hotspot ${i} wait`);
        assert.equal(h.node, h.cy * grown.grid.cols + h.cx);
      });
      // heat: per edge identical (edge ids keep their order), per node the shifted cell
      const heatA = a.heat();
      const heatB = b.heat();
      assert.deepEqual([...heatB.edgePasses], [...heatA.edgePasses], `${tag}: edge passes`);
      sameUpToRounding([...heatB.edgeWait], [...heatA.edgeWait], `${tag}: edge waits`);
      for (const node of a.graph.nodes) {
        const cx = a.graph.cx(node);
        const cy = a.graph.cy(node);
        sameUpToRounding(heatB.nodeWait[(cy + g.dy) * grown.grid.cols + cx + g.dx], heatA.nodeWait[node], `${tag}: node wait at ${cx},${cy}`);
      }
      // vehicles: same states, same loads, poses shifted by whole cells
      const cs = base.grid.cellSize;
      assert.equal(b.vehicles.length, a.vehicles.length);
      a.vehicles.forEach((va, i) => {
        const vb = b.vehicles[i];
        assert.equal(vb.state, va.state, `${tag}: vehicle ${va.id} state`);
        assert.equal(vb.trips, va.trips);
        assert.ok(Math.abs(vb.x - (va.x + g.dx * cs)) < 1e-9 && Math.abs(vb.y - (va.y + g.dy * cs)) < 1e-9, `${tag}: vehicle ${va.id} pose`);
      });
      cases++;
    }
  }
  assert.equal(cases, 18);
  console.log(`# translation invariance: 18 grown plants, the largest relative difference of any figure is ${worstRelative.toExponential(1)} (rounding of positions)`);
});

test('trimming a plant that sits in a big baseplate changes nothing in the simulation either', () => {
  for (const example of EXAMPLES) {
    const base = example.build();
    const roomy = L.cloneLayout(base);
    L.growGrid(roomy, { left: 40, top: 24, right: 100, bottom: 100 });
    const trimmed = L.cloneLayout(roomy);
    L.trimGrid(trimmed, { margin: 3 });
    assert.ok(trimmed.grid.cols < roomy.grid.cols);
    sameUpToRounding(placeFree(run(trimmed, 1200).kpis()), placeFree(run(base, 1200).kpis()), example.id);
  }
});

test('non-binary cell sizes: tiny rounding differences do not change what happens (cell 1.3 m)', () => {
  const base = EXAMPLES.find((e) => e.id === 'two-lines').build();
  L.setCellSize(base, 1.3);
  const grown = L.cloneLayout(base);
  L.growGrid(grown, { left: 8, top: 16, right: 24, bottom: 8 });
  sameUpToRounding(placeFree(run(grown, 1200).kpis()), placeFree(run(base, 1200).kpis()), 'cell 1.3 m');
});

// ---- 2. the compact search equals the dense reference ---------------------------------------------------------------------

/** The search of the old implementation (arrays sized by the grid), kept here as the reference. */
function referenceSearch(graph, from, opts = {}) {
  const { edges, out, nodeCount } = graph;
  const arrivalEdge = opts.arrivalEdge ?? -1;
  const cost = opts.cost || ((e) => e.length / e.limit);
  const target = opts.target ?? -1;
  const exitsAfter = (v, arrival) => {
    const exits = out[v];
    if (arrival < 0) return exits;
    const rev = edges[arrival].rev;
    if (rev < 0 || exits.length === 1) return exits;
    return exits.filter((id) => id !== rev);
  };
  const edgeCost = new Float64Array(edges.length).fill(Infinity);
  const pred = new Int32Array(edges.length).fill(-1);
  const nodeDist = new Float64Array(nodeCount).fill(Infinity);
  const nodeEdge = new Int32Array(nodeCount).fill(-1);
  const heap = [];
  const less = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const push = (item) => { heap.push(item); heap.sort((a, b) => (less(a, b) ? -1 : less(b, a) ? 1 : 0)); };
  nodeDist[from] = 0;
  const relax = (e, base, p) => {
    const c = base + Math.max(1e-9, cost(edges[e]));
    if (c < edgeCost[e]) { edgeCost[e] = c; pred[e] = p; push([c, e]); }
  };
  for (const e of exitsAfter(from, arrivalEdge)) relax(e, 0, -1);
  while (heap.length) {
    const [c, e] = heap.shift();
    if (c > edgeCost[e]) continue;
    const v = edges[e].to;
    if (c < nodeDist[v] || (c === nodeDist[v] && e < nodeEdge[v])) { nodeDist[v] = c; nodeEdge[v] = e; }
    if (v === target) break;
    for (const nx of exitsAfter(v, e)) relax(nx, c, e);
  }
  return {
    dist: (node) => (node === from ? 0 : nodeDist[node]),
    routeTo(node) {
      if (node === from) return { nodes: [from], edges: [], cost: 0 };
      if (nodeEdge[node] < 0) return null;
      const routeEdges = [];
      for (let e = nodeEdge[node]; e >= 0; e = pred[e]) routeEdges.push(e);
      routeEdges.reverse();
      return { nodes: [from, ...routeEdges.map((e) => edges[e].to)], edges: routeEdges, cost: nodeDist[node] };
    },
  };
}

test('lazy compact route search: distances and routes equal the dense reference on random road networks, asked in any order, several searches at once (seeded)', () => {
  const rng = createRng(77);
  let compared = 0;
  for (let n = 0; n < 40; n++) {
    const layout = L.createLayout({ cols: 12 + rng.int(24), rows: 10 + rng.int(16) });
    for (let i = 0, strokes = 3 + rng.int(8); i < strokes; i++) {
      const cells = [[rng.int(layout.grid.cols), rng.int(layout.grid.rows)]];
      for (let k = 0, steps = 4 + rng.int(30); k < steps; k++) {
        const [x, y] = cells[cells.length - 1];
        const d = rng.int(4);
        cells.push([Math.max(0, Math.min(layout.grid.cols - 1, x + [0, 1, 0, -1][d])), Math.max(0, Math.min(layout.grid.rows - 1, y + [-1, 0, 1, 0][d]))]);
      }
      L.paintRoadPath(layout, cells, { oneWay: rng.next() < 0.35 });
    }
    for (const key of Object.keys(layout.roads)) if (rng.next() < 0.1) L.setRoadLimit(layout, ...key.split(',').map(Number), 0.5);
    if (rng.next() < 0.5) L.growGrid(layout, { left: rng.int(20), top: rng.int(20), right: rng.int(40), bottom: rng.int(40) });
    const graph = buildGraph(layout);
    if (graph.nodes.length < 2) continue;
    const weights = Float64Array.from({ length: graph.edges.length }, () => 1 + rng.int(5));
    // several searches alive at once, asked in turns and in any order of nodes (the Dijkstra of each one goes on where it stopped)
    const pairs = [];
    for (let q = 0; q < 5; q++) {
      const from = rng.pick(graph.nodes);
      const arrivalEdge = rng.next() < 0.5 || graph.in[from].length === 0 ? -1 : rng.pick(graph.in[from]);
      const opts = { arrivalEdge };
      if (rng.next() < 0.3) opts.cost = (e) => weights[e.id] * e.length;
      if (rng.next() < 0.2) opts.target = rng.pick(graph.nodes);
      // with the default costs `target` no longer stops anything (the search goes as far as it is asked); with a cost callback it still does
      const slowOpts = opts.cost ? opts : { arrivalEdge };
      pairs.push({ opts, fast: graph.search(from, opts), slow: referenceSearch(graph, from, slowOpts), from });
    }
    for (let ask = 0; ask < 160; ask++) {
      const { opts, fast, slow } = rng.pick(pairs);
      const node = opts.target !== undefined && rng.next() < 0.7 ? opts.target : rng.pick(graph.nodes);
      // a search that stops at its target (cost callback + target) only answers for what it settled; the reference stops at the same place
      assert.equal(fast.dist(node), slow.dist(node), `net ${n} ask ${ask}: dist to ${node}`);
      if (rng.next() < 0.5) assert.deepEqual(fast.routeTo(node), slow.routeTo(node), `net ${n} ask ${ask}: route to ${node}`);
      compared++;
    }
    for (const { fast, slow, opts } of pairs) {
      if (opts.cost && opts.target !== undefined) continue;
      for (const node of graph.nodes) assert.equal(fast.dist(node), slow.dist(node), `net ${n}: final dist to ${node}`);
      assert.equal(fast.dist(-1), Infinity);
      assert.equal(fast.dist(graph.nodeCount + 3), Infinity);
      assert.equal(fast.dist(0.5), Infinity, 'a fractional id is no node');
      assert.equal(fast.routeTo(-4), null);
      const nonRoad = graph.isNode.indexOf(0);
      assert.equal(fast.dist(nonRoad), Infinity, 'an empty cell is not reachable');
      assert.equal(fast.routeTo(nonRoad), null);
    }
  }
  assert.ok(compared > 5000, `${compared} distances compared`);
});

test('compact route search: starting off the road or on a dead cell answers like before; searches do not disturb each other', () => {
  const layout = L.createLayout({ cols: 16, rows: 16 });
  L.paintRoadPath(layout, [[1, 1], [6, 1], [6, 5]]);
  L.paintRoadCell(layout, 10, 10);
  const graph = buildGraph(layout);
  const id = (cx, cy) => cy * layout.grid.cols + cx;
  const off = graph.search(id(14, 14));
  assert.equal(off.routeTo(id(6, 5)), null);
  assert.equal(off.dist(id(14, 14)), 0, 'the start is at distance 0 even when it is no road (as before)');
  assert.equal(off.dist(id(6, 5)), Infinity);
  const lone = graph.search(id(10, 10));
  assert.deepEqual(lone.routeTo(id(10, 10)), { nodes: [id(10, 10)], edges: [], cost: 0 });
  assert.equal(lone.routeTo(id(1, 1)), null);
  const first = graph.search(id(1, 1));
  const keep = JSON.stringify(first.routeTo(id(6, 5)));
  graph.search(id(6, 5)); // a later search reuses the scratch buffers; the earlier result must not change
  graph.search(id(6, 1), { cost: () => 7 });
  assert.equal(JSON.stringify(first.routeTo(id(6, 5))), keep);
  assert.equal(first.dist(id(6, 5)), 18, '9 cells of 2 m');
});

// ---- 3. cost follows the road graph ------------------------------------------------------------------------------------------

test('empty room costs nothing: budgets, cache sizes and search time are those of the roads alone', () => {
  const base = blockPlant(60, 40, 10, 5, 2);
  const roomy = L.cloneLayout(base);
  L.growGrid(roomy, { left: 100, top: 100, right: 100, bottom: 100 });
  const a = buildGraph(base);
  const b = buildGraph(roomy);
  assert.equal(b.nodeCount > 10 * a.nodeCount, true);
  assert.equal(searchBudget(b), searchBudget(a));
  const ca = new RouteCache(a, { edgeCount: () => 0 });
  const cb = new RouteCache(b, { edgeCount: () => 0 });
  assert.deepEqual([cb.capacity, cb.fixedCapacity], [ca.capacity, ca.fixedCapacity]);
  const time = (graph) => {
    const nodes = graph.nodes;
    for (let i = 0; i < 30; i++) graph.search(nodes[(i * 131) % nodes.length], {});
    let best = Infinity;
    for (let round = 0; round < 5; round++) {
      const t0 = performance.now();
      for (let i = 0; i < 60; i++) graph.search(nodes[(i * 977) % nodes.length], {});
      best = Math.min(best, performance.now() - t0);
    }
    return best / 60;
  };
  const small = time(a);
  const big = time(b);
  console.log(`# search on the roads of a 60 x 40 plant: ${small.toFixed(3)} ms on the 60 x 40 baseplate, ${big.toFixed(3)} ms on ${roomy.grid.cols} x ${roomy.grid.rows} (${(big / small).toFixed(2)}x)`);
  assert.ok(big < small * 2.5 + 0.05, `a search must not depend on the empty cells: ${small.toFixed(3)} ms vs ${big.toFixed(3)} ms`);
});

// ---- 4. speed on the largest baseplate -------------------------------------------------------------------------------------------

test('the Two lines example runs at least 400 x real time on a 320 x 320 baseplate (and the other examples too)', () => {
  const rows = [];
  for (const example of EXAMPLES) {
    const plant = example.build();
    L.growGrid(plant, { right: MAX, bottom: MAX }); // 320 x 320, the plant in the top-left corner
    assert.deepEqual([plant.grid.cols, plant.grid.rows], [MAX, MAX]);
    let t0 = performance.now();
    const sim = new Simulation(plant);
    const build = performance.now() - t0;
    t0 = performance.now();
    sim.advance(3600);
    const ms = performance.now() - t0;
    const factor = 3600 / (ms / 1000);
    rows.push(`${example.id}: build ${build.toFixed(0)} ms, 3600 s in ${ms.toFixed(0)} ms = ${factor.toFixed(0)} x real time`);
    assert.ok(factor >= 400, `${example.id} on 320 x 320 must run at 400 x or more, got ${factor.toFixed(0)} x`);
    assert.ok(sim.kpis().throughput.total > 0 || example.id === 'congestion-lab');
  }
  console.log(`# ${rows.join('; ')}`);
});

test('a road-heavy plant fills the 320 x 320 baseplate and still builds and runs (the stress plant)', () => {
  const plant = blockPlant(MAX, MAX, 12, 25, 2);
  assert.equal(plant.grid.cols, MAX);
  assert.deepEqual(L.checkInvariants(plant), []);
  const roads = Object.keys(plant.roads).length;
  let t0 = performance.now();
  const sim = new Simulation(plant);
  const build = performance.now() - t0;
  t0 = performance.now();
  sim.advance(120);
  const ms = performance.now() - t0;
  console.log(`# stress plant 320 x 320: ${roads} road cells, ${plant.stations.length} stations, ${sim.vehicles.length} vehicles: build ${build.toFixed(0)} ms, 120 s in ${ms.toFixed(0)} ms = ${(120 / (ms / 1000)).toFixed(0)} x real time`);
  assert.ok(roads > 10000);
  assert.ok(build < 3000, `build ${build.toFixed(0)} ms`);
  assert.ok(sim.time >= 119.9 && Number.isFinite(sim.kpis().throughput.total));
});
