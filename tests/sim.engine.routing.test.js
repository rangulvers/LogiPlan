// Tests of what the fix pass added to the logistics layer for big plants and odd networks: reachability without searching
// (RouteCache.canReach), the per-tick search budget and stale congestion snapshots, the start region of a fleet, the cap on the
// yard of a source and the fleet distance in the KPIs. Small plants whose behaviour is known; the large-scale behaviour (event loop
// stalls on 160 x 160 cells) is tested in tests/sim.engine.review.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../js/sim/engine.js';
import { EXAMPLES } from '../js/model/examples.js';
import { updateSettings, updateStation } from '../js/model/layout.js';
import { buildGraph } from '../js/sim/graph.js';
import { RouteCache, searchBudget } from '../js/sim/logistics/routing.js';
import { CONGESTION_REFRESH, SEARCH_WORK_PER_TICK, YARD_LIMIT } from '../js/sim/logistics/common.js';
import { layoutFromAscii } from './helpers/ascii.js';
import { blockPlant, bridgePlant, hostilePlant } from './helpers/engine-review-gen.js';

const example = (id) => EXAMPLES.find((e) => e.id === id).build();
const noTraffic = { edgeCount: () => 0, canAttach: () => true };

// ---------------------------------------------------------------------------------------------------------------------
// canReach: the answer of a search, without a search
// ---------------------------------------------------------------------------------------------------------------------

test('canReach: gives exactly the answer a search gives - every station, node and arrival edge of the examples and of 25 hostile plants', () => {
  const plants = [...EXAMPLES.map((e) => e.build()), bridgePlant({}), ...Array.from({ length: 25 }, (_, i) => hostilePlant(i + 1))];
  let checked = 0;
  let reachable = 0;
  for (const layout of plants) {
    const graph = buildGraph(new Simulation(layout).layout);
    const cache = new RouteCache(graph, noTraffic);
    for (const node of graph.nodes) {
      for (const arrival of [-1, ...graph.in[node]]) {
        const search = graph.search(node, { arrivalEdge: arrival });
        for (const station of layout.stations) {
          const docks = graph.docks.get(station.id) || [];
          const truth = docks.some((d) => d === node || search.dist(d) < Infinity);
          assert.equal(cache.canReach(node, arrival, station.id), truth, `${layout.name}: station ${station.id} from node ${node} arrived over edge ${arrival}`);
          checked++;
          if (truth) reachable++;
        }
      }
    }
  }
  assert.ok(checked > 50000 && reachable > 5000 && reachable < checked, `${checked} questions, ${reachable} with a way`);
});

test('canReach: the no-U-turn rule counts - arrived over the only road at a dock-free spur, the way back is the dead-end reversal', () => {
  // A dead-end spur: from the junction at (3,1) the vehicle drives north to the dead end (3,0) and may turn round there
  const graph = buildGraph(layoutFromAscii(['...+....', 'A..+..B.', '+++++++.'.replace('.', '+')], { stations: { A: 'source', B: 'sink' }, fleets: [] }));
  const cache = new RouteCache(graph, noTraffic);
  const at = (x, y) => y * graph.cols + x;
  const intoSpur = graph.edgeBetween(at(3, 1), at(3, 0));
  assert.ok(intoSpur >= 0);
  assert.equal(cache.canReach(at(3, 0), intoSpur, 'A'), true, 'at the dead end the vehicle reverses');
  assert.equal(cache.canReach(at(3, 0), intoSpur, 'nowhere'), false);
  assert.equal(cache.canReachAny(at(3, 0), intoSpur, ['nowhere', 'B']), true);
  assert.equal(cache.canReachAny(at(3, 0), intoSpur, []), false);
  for (const [node, edge] of [[-1, -1], [graph.nodeCount + 5, -1], [at(0, 0), -1], [at(3, 1), 99999]]) {
    assert.doesNotThrow(() => cache.canReach(node, edge, 'A'), `node ${node}, edge ${edge}`);
  }
  assert.equal(cache.canReach(-1, -1, 'A'), false);
  assert.equal(cache.canReach(at(0, 0), -1, 'A'), false, 'a cell that is not a road');
});

// ---------------------------------------------------------------------------------------------------------------------
// The search budget
// ---------------------------------------------------------------------------------------------------------------------

/** A straight road with a source at the west end. */
function corridor() {
  const graph = buildGraph(layoutFromAscii(['A.......', '++++++++'], { stations: { A: 'source' }, fleets: [] }));
  const cache = new RouteCache(graph, noTraffic);
  const calls = [];
  const search = graph.search;
  graph.search = (from, opts) => { calls.push(from); return search(from, opts); };
  return { graph, cache, calls, at: (x) => graph.cols + x };
}

test('budget: deferrable lookups start at most `budget` new searches per tick; cached ones are free; get() without deferrable always answers', () => {
  const { cache, calls, at } = corridor();
  cache.budget = 2;
  const first = cache.get(at(1), -1, 0, true);
  const second = cache.get(at(2), -1, 0, true);
  assert.ok(first && second);
  assert.equal(cache.get(at(3), -1, 0, true), null, 'the third new search does not fit into the tick');
  assert.equal(cache.get(at(1), -1, 0, true), first, 'a cached search costs nothing');
  assert.equal(calls.length, 2);
  assert.ok(cache.get(at(3), -1, 0), 'a caller that cannot wait gets its search');
  assert.equal(calls.length, 3);
  cache.beginTick();
  assert.equal(cache.get(at(4), -1, 0, true).node, at(4), 'the next tick has its budget again');
  assert.equal(calls.length, 4);
});

test('budget: the default is no limit, searchBudget scales with the size of the graph and is at least one', () => {
  const { cache } = corridor();
  assert.equal(cache.budget, Infinity);
  const small = buildGraph(layoutFromAscii(['A.......', '++++++++'], { stations: { A: 'source' }, fleets: [] }));
  const big = buildGraph(blockPlant(160, 160, 12, 1, 1));
  // the work of a search follows the ROAD graph (cells with a road + links), not the baseplate: empty room around a plant costs nothing
  assert.equal(searchBudget(small), Math.floor(SEARCH_WORK_PER_TICK / (small.edges.length + small.nodes.length)));
  assert.ok(searchBudget(small) > 100, 'a small plant is not limited in practice');
  // 10 ms of searching per tick at about 100 ns per road cell and link: 8 searches on the 160 x 160 block plant (3900 road cells), 1-2 on the largest 320 x 320 one
  assert.ok(searchBudget(big) >= 1 && searchBudget(big) <= 8, `${searchBudget(big)} searches per tick on a big plant`);
  assert.ok(searchBudget(buildGraph(blockPlant(320, 320, 12, 1, 1))) <= 2, 'and at most two on the largest baseplate');
  assert.ok(searchBudget(big) * (big.edges.length + big.nodes.length) <= SEARCH_WORK_PER_TICK || searchBudget(big) === 1);
});

test('budget: congestion costs of an older snapshot are searched again when asked for, or used as they are when the tick has no search left', () => {
  const { cache, calls, at } = corridor();
  cache.setMode('congestion');
  cache.budget = 1;
  const old = cache.get(at(3), -1, 0, true);
  assert.ok(old);
  assert.equal(cache.get(at(3), -1, CONGESTION_REFRESH - 0.5, true), old, 'the snapshot lives for CONGESTION_REFRESH');
  cache.beginTick();
  const renewed = cache.get(at(3), -1, CONGESTION_REFRESH, true);
  assert.notEqual(renewed, old, 'a new snapshot: a new search');
  assert.equal(calls.length, 2);
  cache.beginTick();
  cache.get(at(5), -1, 2 * CONGESTION_REFRESH, true); // uses this tick's search for another start
  assert.equal(cache.get(at(3), -1, 2 * CONGESTION_REFRESH, true), renewed, 'no search left: the entry of the last snapshot has to do');
  assert.equal(calls.length, 3);
  assert.notEqual(cache.get(at(3), -1, 2 * CONGESTION_REFRESH), renewed, 'a caller that cannot wait gets the fresh search');
  assert.equal(calls.length, 4);
});

/** Per-tick count of the graph searches of a running simulation, and the orders assigned so far. */
function countSearches(sim) {
  const perTick = [];
  let current = 0;
  const search = sim.graph.search;
  sim.graph.search = (from, opts) => { current++; return search(from, opts); };
  const step = sim.step.bind(sim);
  sim.step = (dt) => { current = 0; step(dt); perTick.push(current); };
  return perTick;
}

test('budget: with one search per tick the vehicles of a big plant are put to work one after the other, and nothing is lost', () => {
  const run = (budget) => {
    const sim = new Simulation(blockPlant(60, 40, 10, 5, 2), { seed: 1 });
    sim.logistics.routes.budget = budget;
    const perTick = countSearches(sim);
    const assigned = [];
    sim.on('orderAssigned', (p) => assigned.push(p.t));
    sim.advance(1800);
    return { sim, perTick, assigned };
  };
  const unlimited = run(Infinity);
  const slow = run(1);
  assert.ok(slow.perTick.every((n) => n <= 1), `no tick searched more than once: ${Math.max(...slow.perTick)}`);
  assert.ok(Math.max(...unlimited.perTick) > 5, 'the unlimited cold start searches a lot in one tick');
  assert.ok(slow.assigned[0] <= 0.2 && slow.assigned.length >= 10, `${slow.assigned.length} orders`);
  const startUp = (r) => r.assigned.filter((t) => t < 0.35).length; // the first three ticks
  assert.ok(startUp(slow) < startUp(unlimited) && startUp(unlimited) >= 5, `vehicles are put to work one by one: ${startUp(slow)} orders in the first three ticks, ${startUp(unlimited)} without a budget`);
  assert.ok(slow.assigned.filter((t) => t < 3).length >= 6, 'and all of them are at work after a few seconds');
  const done = (r) => r.sim.logistics.ordersDelivered;
  assert.ok(done(slow) >= 0.8 * done(unlimited), `${done(slow)} deliveries against ${done(unlimited)}`);
});

test('budget: the examples never come near their budget, so they run exactly as they would without one', () => {
  for (const e of EXAMPLES) {
    const sim = new Simulation(e.build(), { seed: 1 });
    const { routes } = sim.logistics;
    let most = 0;
    const begin = routes.beginTick.bind(routes);
    routes.beginTick = () => { most = Math.max(most, routes.spent); begin(); };
    sim.advance(3600);
    assert.ok(routes.budget > 30, `${e.id}: budget ${routes.budget}`);
    assert.ok(most < routes.budget, `${e.id}: ${most} searches in the busiest tick against a budget of ${routes.budget}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Where vehicles start
// ---------------------------------------------------------------------------------------------------------------------

/** The bridge plant (left ring: source A and storage B; right ring, reachable over a one-way bridge only: source C and sink D) with a fleet for each ring. */
function twoRings() {
  return layoutFromAscii([
    '...AAA............',
    '.++++++++>++++++++',
    '.+......+.+......+',
    '.+.....B+.+CC..DD+',
    '.+.....B+.+......+',
    '.+......+.+......+',
    '.++++++++.++++++++',
  ], {
    settings: { warmup: 0 },
    stations: { A: 'source', B: 'storage', C: 'source', D: 'sink' },
    flows: [['A', 'B', { fleetId: 'v1' }], ['C', 'D', { fleetId: 'v2' }]],
    fleets: [{ count: 3, idle: 'stay' }, { count: 2, idle: 'stay' }],
  });
}

test('start region: every fleet starts in the part of the network that holds a dock of its own stations - a one-way bridge does not mix them up', () => {
  const sim = new Simulation(twoRings(), { seed: 1 });
  assert.equal(sim.vehicles.length, 5);
  for (const v of sim.vehicles) {
    const cx = sim.graph.cx(v.tv.node);
    if (v.fleetId === 'v1') assert.ok(cx <= 8, `${v.id} starts at x=${cx}, in the right ring that it can never leave`);
    else assert.ok(cx >= 10, `${v.id} starts at x=${cx}, in the left ring that has nothing for it`);
  }
  sim.advance(1800);
  assert.ok(sim.flows[0].delivered > 0 && sim.flows[1].delivered > 0, 'both rings work');
});

test('start region: a fleet without any station to work for, or with docks nowhere, is spread over the whole network as before', () => {
  const layout = twoRings();
  layout.flows.length = 0;
  const sim = new Simulation(layout, { seed: 1 });
  assert.equal(sim.vehicles.length, 5);
  const xs = sim.vehicles.map((v) => sim.graph.cx(v.tv.node));
  assert.ok(xs.some((x) => x <= 8) && xs.some((x) => x >= 10), `spread over both rings: ${xs}`);
});

test('start region: a ring that is full leaves the surplus vehicles unplaced instead of putting them where they are lost', () => {
  const layout = bridgePlant({ vehicles: 60 });
  const sim = new Simulation(layout, { seed: 1 });
  assert.ok(sim.logistics.unplaced.length > 0, 'the left ring has no room for 60 vehicles');
  for (const v of sim.vehicles) assert.ok(sim.graph.cx(v.tv.node) <= 8, `${v.id} in the right ring`);
  assert.equal(sim.vehicles.length + sim.logistics.unplaced.length, 60);
});

// ---------------------------------------------------------------------------------------------------------------------
// Memory guard and distance
// ---------------------------------------------------------------------------------------------------------------------

test('yard: a source that is fed far more than the plant can take stops at YARD_LIMIT loads, drops the rest and keeps the books straight', () => {
  const layout = example('starter');
  const source = layout.stations.find((s) => s.type === 'source');
  updateStation(layout, source.id, { params: { interArrival: { kind: 'const', mean: 1, spread: 0 }, batch: 100 } });
  updateSettings(layout, { demandFactor: 10, warmup: 0 });
  const sim = new Simulation(layout, { seed: 1 });
  let created = 0;
  let fromSource = 0;
  sim.on('loadCreated', (p) => { created++; if (p.station.type === 'source') fromSource++; });
  sim.advance(1200);
  const st = sim.stations.find((s) => s.type === 'source');
  assert.ok(st.yard <= YARD_LIMIT && st.yard >= YARD_LIMIT - 200, `${st.yard} loads in the yard`);
  assert.ok(st.dropped > 1e6, `${st.dropped} loads dropped`);
  assert.equal(st.produced, fromSource, 'produced counts the loads that exist');
  assert.equal(sim.logistics.liveLoads + sim.logistics.completed + sim.logistics.loadsConsumed, created);
  assert.ok(sim.insights().some((i) => i.severity === 'critical'), 'the Results tab calls it critical');
});

test('distance: the fleet distance in the KPIs is everything the vehicles drove, parking trips included', () => {
  for (const e of EXAMPLES) {
    const layout = e.build();
    layout.settings.warmup = 0;
    const sim = new Simulation(layout, { seed: 3 });
    sim.advance(3600);
    const report = sim.kpis();
    const reported = Object.values(report.fleets).reduce((sum, f) => sum + f.distance, 0);
    const odometer = sim.vehicles.reduce((sum, v) => sum + v.tv.odometer, 0);
    const park = sim.vehicles.reduce((sum, v) => sum + v.parkDistance, 0);
    assert.ok(Math.abs(reported - odometer) <= 0.01 * odometer + 5, `${e.id}: reported ${reported.toFixed(0)} m, odometers ${odometer.toFixed(0)} m`);
    assert.ok(park > 0 || e.id === 'congestion-lab', `${e.id}: the vehicles park`);
    for (const f of Object.values(report.fleets)) assert.ok(f.emptyShare === null || (f.emptyShare >= 0 && f.emptyShare <= 1));
  }
});
