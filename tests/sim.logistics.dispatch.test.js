// Logistics: orders and dispatch - strategies, priority, fleet restriction, batching, capacity, reachability,
// claims and reservations, and route planning (cached shortest routes, congestion-aware routes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutFromAscii } from './helpers/ascii.js';
import { createWorld, injectLoads } from './helpers/logistics-invariants.js';
import { buildGraph } from '../js/sim/graph.js';
import { CONGESTION_REFRESH, PRIORITY_AGING, ROUTE_CACHE_BYTES } from '../js/sim/logistics/common.js';
import { RouteCache } from '../js/sim/logistics/routing.js';
import { dist } from '../js/model/defaults.js';

const OFF = dist('const', 0);
const node = (w, x, y) => y * w.graph.cols + x;

/** Move the (single, fresh, idle) vehicle to cell (x, y) before the simulation starts. */
function place(w, x, y, index = 0) {
  const tv = w.lg.vehicles[index].tv;
  if (tv.node === node(w, x, y)) return;
  assert.ok(w.traffic.relocate(tv, node(w, x, y)), 'placement cell is free');
}

/**
 * Three disabled sources O (x=0, far), N (x=10, near), B (x=16, medium) and a sink D on a line; one vehicle is placed at
 * x=12. Pickup costs are 24 m, 4 m and 8 m. Loads are injected with the given ages (seconds already waiting).
 */
function triangle({ ages, flowExtra = {}, settings = {}, fleets = [{ count: 1, preset: 'agv' }] }) {
  const layout = layoutFromAscii(['O.........N.....B.......D', '+'.repeat(25)], {
    stations: { O: { type: 'source', params: { interArrival: OFF } }, N: { type: 'source', params: { interArrival: OFF } }, B: { type: 'source', params: { interArrival: OFF } }, D: 'sink' },
    flows: [['O', 'D', flowExtra.O], ['N', 'D', flowExtra.N], ['B', 'D', flowExtra.B]], fleets, settings,
  });
  const w = createWorld(layout, { dt: 0.5, check: true });
  place(w, 12, 1);
  ['f1', 'f2', 'f3'].forEach((id, i) => injectLoads(w.lg, id, 1, { createdAt: -ages[i], readyAt: -ages[i] }));
  return w;
}

const firstOrder = (w) => {
  w.step();
  return [...w.lg.activeOrders.values()].map((o) => o.flowId);
};

// ---- strategies ---------------------------------------------------------------------------------------------------------------

test('dispatch: nearest, oldest and balanced pick different orders in the same situation', () => {
  const ages = [80, 5, 60]; // O is far (24 m) and oldest, N is near (4 m) and young, B is in between (8 m)
  assert.deepEqual(firstOrder(triangle({ ages, settings: { dispatch: 'nearest' } })), ['f2'], 'nearest: N, 4 m');
  assert.deepEqual(firstOrder(triangle({ ages, settings: { dispatch: 'oldest' } })), ['f1'], 'oldest: O, 80 s');
  assert.deepEqual(firstOrder(triangle({ ages, settings: { dispatch: 'balanced' } })), ['f3'], 'balanced: cost - 0.5 age is 1.5 (N), -16 (O), -22 (B)');
});

test('dispatch: the strategy can be switched at runtime', () => {
  const w = triangle({ ages: [80, 5, 60], settings: { dispatch: 'nearest' } });
  w.lg.setRuntime({ dispatch: 'oldest' });
  assert.deepEqual(firstOrder(w), ['f1']);
});

test('dispatch: nearest breaks distance ties by the older load, oldest breaks age ties by distance', () => {
  const layout = layoutFromAscii(['L.......R.......D', '+++++++++++++++++'], {
    stations: { L: { type: 'source', params: { interArrival: OFF } }, R: { type: 'source', params: { interArrival: OFF } }, D: 'sink' },
    flows: [['L', 'D'], ['R', 'D']], fleets: [{ count: 1 }],
  });
  const run = (dispatch, ageL, ageR, vx) => {
    const w = createWorld(layout, { dt: 0.5, check: true });
    w.lg.setRuntime({ dispatch });
    place(w, vx, 1);
    injectLoads(w.lg, 'f1', 1, { createdAt: -ageL, readyAt: -ageL });
    injectLoads(w.lg, 'f2', 1, { createdAt: -ageR, readyAt: -ageR });
    return firstOrder(w)[0];
  };
  assert.equal(run('nearest', 10, 30, 4), 'f2', 'equidistant (L and R both 4 cells away): the older R wins');
  assert.equal(run('nearest', 30, 10, 4), 'f1');
  assert.equal(run('oldest', 50, 50, 3), 'f1', 'equal age: the nearer L wins');
  assert.equal(run('oldest', 50, 50, 5), 'f2');
});

test('dispatch: priority beats the strategy, strategy orders within a priority', () => {
  const ages = [80, 5, 60];
  assert.deepEqual(firstOrder(triangle({ ages, flowExtra: { O: { priority: 3 } }, settings: { dispatch: 'nearest' } })), ['f1'], 'urgent far flow before the near normal one');
  assert.deepEqual(firstOrder(triangle({ ages, flowExtra: { O: { priority: 2 }, B: { priority: 2 } }, settings: { dispatch: 'nearest' } })), ['f3'], 'among the two high-priority flows the nearer one');
  assert.deepEqual(firstOrder(triangle({ ages, flowExtra: { N: { priority: 3 } }, settings: { dispatch: 'oldest' } })), ['f2'], 'priority also beats "oldest"');
});

test('dispatch: with several vehicles the global greedy matching serves flows in priority/strategy order', () => {
  const w = triangle({ ages: [80, 5, 60], settings: { dispatch: 'nearest' }, fleets: [{ count: 2, preset: 'agv' }] });
  place(w, 13, 1, 1);
  w.step();
  const orders = [...w.lg.activeOrders.values()];
  assert.equal(orders.length, 2);
  const byFlow = Object.fromEntries(orders.map((o) => [o.flowId, o.vehicleId]));
  assert.deepEqual(Object.keys(byFlow).sort(), ['f2', 'f3'], 'the two nearest pickups are served, the far one waits');
  assert.equal(byFlow.f2, 'v1#1', 'x=12 is nearer to N (x=10) than x=13');
});

// ---- fleets, batching, capacity ----------------------------------------------------------------------------------------------

test('dispatch: a flow restricted to a fleet is only served by that fleet', () => {
  const layout = layoutFromAscii(['A.......D', '+++++++++'], {
    stations: { A: { type: 'source', params: { interArrival: OFF } }, D: 'sink' },
    flows: [['A', 'D', { fleetId: 'v2' }]],
    fleets: [{ count: 1, preset: 'agv' }, { count: 1, preset: 'forklift' }],
  });
  const w = createWorld(layout, { dt: 0.5, check: true });
  place(w, 2, 1, 0); // the AGV (v1) is right next to the pickup, the forklift (v2) is far away
  place(w, 7, 1, 1);
  injectLoads(w.lg, 'f1', 2, { createdAt: 0 });
  w.step();
  const orders = [...w.lg.activeOrders.values()];
  assert.equal(orders.length, 1);
  assert.equal(orders[0].vehicleId, 'v2#1');
  w.run(300);
  assert.equal(w.lg.flowById.get('f1').delivered, 2);
  assert.equal(w.lg.vehicles.find((v) => v.fleetId === 'v1').trips, 0, 'the AGV never touched the restricted flow');
});

test('dispatch: a flow restricted to a fleet without vehicles (or an unknown fleet) is never assigned', () => {
  for (const fleetId of ['v2', 'nope']) {
    const layout = layoutFromAscii(['A.......D', '+++++++++'], {
      stations: { A: { type: 'source', params: { interArrival: dist('const', 5), startDelay: 0 } }, D: 'sink' },
      flows: [['A', 'D', { fleetId }]], fleets: [{ count: 2 }, { count: 0 }],
    });
    const w = createWorld(layout, { dt: 0.5, check: true });
    w.run(200);
    assert.equal(w.lg.ordersDelivered, 0);
    assert.equal(w.lg.activeOrders.size, 0);
    assert.ok(w.lg.stationById.get('A').outCount > 0, 'the loads wait');
  }
});

/** Source A -> sink D with a tugger (capacity 4) or AGV; loads are injected by the test. */
function shuttle({ flow = {}, fleet = { preset: 'tugger', count: 1 }, sinkLike = 'sink', dParams } = {}) {
  const layout = layoutFromAscii(['A.......D', '+++++++++'], {
    stations: { A: { type: 'source', params: { interArrival: OFF, outCap: 10 } }, D: dParams ? { type: sinkLike, params: dParams } : sinkLike },
    flows: [['A', 'D', flow]], fleets: [{ loadTime: 2, unloadTime: 2, speed: 2, ...fleet }],
  });
  const w = createWorld(layout, { dt: 0.5, check: true });
  place(w, 4, 1);
  return w;
}

test('dispatch: a tugger (capacity 4) carries four loads in one trip', () => {
  const w = shuttle();
  injectLoads(w.lg, 'f1', 4, { createdAt: 0 });
  w.step();
  const [order] = [...w.lg.activeOrders.values()];
  assert.equal(order.qty, 4);
  assert.equal(order.loads.length, 4);
  let carried = 0;
  while (w.lg.activeOrders.size > 0) {
    w.step();
    carried = Math.max(carried, w.lg.vehicles[0].load.length);
    assert.ok(w.t < 200);
  }
  assert.equal(carried, 4);
  assert.equal(w.lg.vehicles[0].trips, 1);
  assert.equal(w.lg.flowById.get('f1').delivered, 4);
  assert.equal(w.lg.flowById.get('f1').trips, 1);
  assert.equal(w.lg.completed, 4);
  assert.equal(w.named('orderDelivered')[0].order.qty, 4);
});

test('dispatch: an AGV (capacity 1) needs one trip per load; loads are taken oldest first', () => {
  const w = shuttle({ fleet: { preset: 'agv' } });
  const loads = injectLoads(w.lg, 'f1', 3, { createdAt: 0 });
  w.run(300);
  assert.equal(w.lg.flowById.get('f1').trips, 3);
  const order = w.named('orderAssigned').map((e) => e.order.loads[0].id);
  assert.deepEqual(order, loads.map((l) => l.id), 'FIFO');
});

test('dispatch: batchMax limits a transport below the vehicle capacity', () => {
  const w = shuttle({ flow: { batchMax: 2 } });
  injectLoads(w.lg, 'f1', 4, { createdAt: 0 });
  w.run(300);
  assert.deepEqual(w.named('orderAssigned').map((e) => e.order.qty), [2, 2]);
});

test('dispatch: batchMin waits for enough loads; maxWait releases a partial batch; maxWait 0 waits for ever', () => {
  const waiting = shuttle({ flow: { batchMin: 3 } });
  injectLoads(waiting.lg, 'f1', 2, { createdAt: 0 });
  waiting.run(2000);
  assert.equal(waiting.lg.activeOrders.size, 0, 'two loads are not a batch of three (maxWait 0 = no timeout)');
  injectLoads(waiting.lg, 'f1', 1, { createdAt: waiting.lg.now });
  waiting.step();
  assert.equal([...waiting.lg.activeOrders.values()][0].qty, 3, 'the third load completes the batch and triggers dispatch at once');

  const timed = shuttle({ flow: { batchMin: 3, maxWait: 30 } });
  injectLoads(timed.lg, 'f1', 1, { createdAt: 0 });
  timed.run(29);
  assert.equal(timed.lg.activeOrders.size, 0);
  timed.run(2);
  const [order] = [...timed.lg.activeOrders.values()];
  assert.ok(order, 'released once the oldest load has waited 30 s');
  assert.equal(order.qty, 1);
  assert.ok(order.createdAt >= 30 && order.createdAt <= 30.5 + 1e-9, `assigned at ${order.createdAt}`);
});

test('dispatch: batchMin larger than the vehicle or the buffers can ever hold does not starve the flow', () => {
  const big = shuttle({ flow: { batchMin: 10 } });
  injectLoads(big.lg, 'f1', 4, { createdAt: 0 });
  big.step();
  assert.equal([...big.lg.activeOrders.values()][0].qty, 4, 'clamped to the tugger capacity');

  const small = shuttle({ flow: { batchMin: 5 }, sinkLike: 'storage', dParams: { capacity: 3 } });
  injectLoads(small.lg, 'f1', 4, { createdAt: 0 });
  small.step();
  assert.equal([...small.lg.activeOrders.values()][0].qty, 3, 'clamped to what the storage can hold');
});

test('dispatch: the quantity is limited by the room at the destination', () => {
  const layout = layoutFromAscii(['A.......P', '+++++++++'], {
    stations: { A: { type: 'source', params: { interArrival: OFF, outCap: 10 } }, P: { type: 'process', params: { cycle: dist('const', 1000), inCap: 2 } } },
    flows: [['A', 'P']], fleets: [{ preset: 'tugger', count: 2 }],
  });
  const w = createWorld(layout, { dt: 0.5, check: true });
  injectLoads(w.lg, 'f1', 6, { createdAt: 0 });
  w.step();
  const orders = [...w.lg.activeOrders.values()];
  assert.equal(orders.length, 1, 'the second tugger is not sent: the two free places are already reserved');
  assert.equal(orders[0].qty, 2);
  assert.equal(w.lg.stationById.get('P').inbound.get('f1'), 2);
  w.run(300);
  assert.equal(w.lg.stationById.get('P').inQ.get('f1').length === 1 || w.lg.stationById.get('P').machines[0].state === 'busy', true);
});

// ---- reachability -----------------------------------------------------------------------------------------------------------------

test('dispatch: unreachable flows are never assigned and never crash the simulation', () => {
  // two separate road segments: the vehicle lives on the top one; B's dock is on the bottom one
  const layout = layoutFromAscii([
    'A.D.....',
    '++++....',
    '........',
    '..B.....',
    '..++++..',
  ], {
    stations: { A: { type: 'source', params: { interArrival: dist('const', 10), startDelay: 0 } }, D: 'sink', B: 'sink' },
    flows: [['A', 'B'], ['A', 'D']], fleets: [{ count: 1 }],
  });
  const w = createWorld(layout, { dt: 0.5, check: true });
  place(w, 1, 1);
  w.run(600);
  assert.ok(w.lg.flowById.get('f2').delivered > 10, 'the reachable flow works');
  assert.equal(w.lg.flowById.get('f1').delivered, 0);
  assert.equal(w.named('orderAssigned').filter((e) => e.order.flowId === 'f1').length, 0);
  assert.ok(w.lg.stationById.get('A').outQ.get('f1').length > 0, 'loads of the unreachable flow stay in the buffer');
});

test('dispatch: a drop that cannot be reached from the pickup (one-way dead end) is never assigned', () => {
  // one-way road to the east: B (upstream) cannot be reached from A (downstream)
  const layout = layoutFromAscii(['B..A....', '>>>>>>>>'], {
    stations: { A: { type: 'source', params: { interArrival: dist('const', 10), startDelay: 0 } }, B: 'sink' },
    flows: [['A', 'B']], fleets: [{ count: 1 }],
  });
  const w = createWorld(layout, { dt: 0.5, check: true });
  w.run(300);
  assert.equal(w.lg.ordersDelivered, 0);
  assert.equal(w.lg.activeOrders.size, 0);
  assert.equal(w.lg.vehicles[0].trips, 0);
});

test('dispatch: a vehicle that cannot reach the pickup is skipped while others serve the flow', () => {
  const layout = layoutFromAscii([
    'A.D.....',
    '++++....',
    '........',
    '........',
    '..++++..',
  ], { stations: { A: { type: 'source', params: { interArrival: dist('const', 10), startDelay: 0 } }, D: 'sink' }, flows: [['A', 'D']], fleets: [{ count: 2 }] });
  const w = createWorld(layout, { dt: 0.5, check: true });
  place(w, 1, 1, 0);
  place(w, 3, 4, 1); // stranded on the disconnected road segment
  w.run(300);
  const [near, stranded] = w.lg.vehicles;
  assert.ok(near.trips > 5);
  assert.equal(stranded.trips, 0);
  assert.equal(stranded.state, 'idle');
  assert.equal(w.graph.cy(stranded.tv.node), 4, 'it never moved');
});

// ---- claims and reservations ---------------------------------------------------------------------------------------------------------

test('reservations: no load is promised to two vehicles and no destination place twice', () => {
  const layout = layoutFromAscii(['A.......S.......D', '+++++++++++++++++'], {
    stations: { A: { type: 'source', params: { interArrival: OFF, outCap: 10 } }, S: { type: 'storage', params: { capacity: 3, dwell: 100000 } }, D: 'sink' },
    flows: [['A', 'S'], ['S', 'D']], fleets: [{ count: 5, preset: 'agv' }],
  });
  const w = createWorld(layout, { dt: 0.5, check: true });
  injectLoads(w.lg, 'f1', 8, { createdAt: 0 });
  injectLoads(w.lg, 'f2', 1, { createdAt: 0, readyAt: 1e9 }); // one load already sits in the storage
  w.step();
  assert.equal(w.lg.activeOrders.size, 2, 'capacity 3, one held: exactly two places are free -> two single-load orders');
  const loads = [...w.lg.activeOrders.values()].flatMap((o) => o.loads.map((l) => l.id));
  assert.equal(new Set(loads).size, 2);
  assert.equal(w.lg.stationById.get('S').inboundTotal, 2);
  w.run(400);
  assert.equal(w.lg.stationById.get('S').outCount, 3, 'storage filled to capacity, never beyond');
  assert.equal(w.lg.activeOrders.size, 0);
  assert.equal(w.lg.stationById.get('A').outQ.get('f1').length, 6);
});

test('reservations: 5 vehicles and 3 loads give exactly 3 orders on 3 distinct loads', () => {
  const layout = layoutFromAscii(['A.......D', '+++++++++'], {
    stations: { A: { type: 'source', params: { interArrival: OFF, outCap: 10 } }, D: 'sink' },
    flows: [['A', 'D']], fleets: [{ count: 5, preset: 'agv' }],
  });
  const w = createWorld(layout, { dt: 0.5, check: true });
  injectLoads(w.lg, 'f1', 3, { createdAt: 0 });
  w.step();
  const orders = [...w.lg.activeOrders.values()];
  assert.equal(orders.length, 3);
  assert.equal(new Set(orders.map((o) => o.vehicleId)).size, 3);
  assert.equal(new Set(orders.flatMap((o) => o.loads.map((l) => l.id))).size, 3);
  assert.equal(w.lg.vehicles.filter((v) => v.state === 'idle').length, 2);
  w.run(120);
  assert.equal(w.lg.completed, 3);
  assert.equal(w.lg.activeOrders.size, 0);
});

test('reservations: claimed loads stay in the output queue (holding their place) until loading ends', () => {
  const w = shuttle({ fleet: { preset: 'agv' } });
  injectLoads(w.lg, 'f1', 1, { createdAt: 0 });
  w.step();
  const a = w.lg.stationById.get('A');
  const [load] = a.outQ.get('f1');
  assert.equal(load.claimed, true);
  assert.equal(a.outLinks[0].claimed, 1);
  w.runUntil((x) => x.lg.vehicles[0].state === 'toDrop', 60);
  assert.equal(a.outQ.get('f1').length, 0, 'gone once the vehicle has loaded');
  assert.equal(a.outLinks[0].claimed, 0);
  assert.deepEqual(w.lg.vehicles[0].load, [load]);
});

test('dispatch: an order is assigned in the very tick its load becomes ready (event driven)', () => {
  const layout = layoutFromAscii(['A.......D', '+++++++++'], {
    stations: { A: { type: 'source', params: { interArrival: dist('const', 1000), startDelay: 13 } }, D: 'sink' },
    flows: [['A', 'D']], fleets: [{ count: 1 }],
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  w.run(30);
  assert.equal(w.named('orderAssigned')[0].order.createdAt, 13);
});

// ---- route planning -----------------------------------------------------------------------------------------------------------------------

/** Two parallel roads between A (west end) and B (east end): a short one on row 1 and a longer detour on row 3. */
function twoRoutes(settings) {
  return layoutFromAscii([
    'A.....B',
    '+++++++',
    '+.....+',
    '+++++++',
  ], {
    stations: { A: { type: 'source', params: { interArrival: dist('const', 1000), startDelay: 1 } }, B: 'sink' },
    flows: [['A', 'B']], fleets: [{ count: 1, speed: 2, loadTime: 1, unloadTime: 1 }], settings,
  });
}

/** A source upstream-reachable from the vehicle whose drop (B, further upstream) is unreachable: demand that never gets served. */
function stuckDemand(settings) {
  const layout = layoutFromAscii(['B..A....', '>>>>>>>>'], {
    stations: { A: { type: 'source', params: { interArrival: dist('const', 10), startDelay: 0 } }, B: 'sink' },
    flows: [['A', 'B']], fleets: [{ count: 1 }], settings,
  });
  const w = createWorld(layout, { dt: 0.25 });
  place(w, 1, 1);
  const calls = [];
  const search = w.graph.search;
  w.graph.search = (from, opts) => { calls.push({ key: `${from}/${opts.arrivalEdge}`, t: w.lg.time }); return search(from, opts); };
  return { w, calls };
}

test('routing: shortest routes are cached per (node, arrival edge) and searched once, however often dispatch looks', () => {
  const { w, calls } = stuckDemand({});
  w.run(60);
  assert.ok(w.lg.stationById.get('A').outCount > 0, 'demand exists the whole time');
  assert.equal(w.lg.ordersDelivered, 0);
  assert.ok(calls.length > 0 && calls.length <= 3, `${calls.length} searches`);
  assert.equal(new Set(calls.map((c) => c.key)).size, calls.length);
});

test('routing: congestion-aware costs are a snapshot that is renewed at most once per CONGESTION_REFRESH of sim time', () => {
  const { w, calls } = stuckDemand({ routing: 'congestion' });
  w.run(60);
  const byKey = new Map();
  for (const c of calls) byKey.set(c.key, [...(byKey.get(c.key) || []), c.t]);
  const expected = 60 / CONGESTION_REFRESH;
  const renewed = [...byKey.values()].filter((ts) => ts.length > 1);
  assert.ok(renewed.length >= 1, 'the search from the vehicle is renewed with the snapshot');
  for (const ts of renewed) {
    assert.ok(ts.length >= expected - 1 && ts.length <= expected + 1, `${ts.length} searches in 60 s (one per refresh = ${expected})`);
    for (let i = 1; i < ts.length; i++) assert.ok(ts[i] - ts[i - 1] >= CONGESTION_REFRESH - 1e-9, `two searches ${ts[i] - ts[i - 1]} s apart`);
  }
  assert.ok(byKey.size - renewed.length <= 2, 'questions of reachability are answered once, with plain costs, whatever the refresh');
  w.lg.setRuntime({ routing: 'shortest' });
  const before = calls.length;
  w.run(20);
  assert.ok(calls.length - before <= 3, 'after switching to shortest the new cache is filled once');
});

test('routing: congestion-aware routing detours around loaded edges; shortest ignores them', () => {
  const firstRoute = (routing) => {
    const w = createWorld(twoRoutes({ routing }), { dt: 0.5, check: true });
    place(w, 3, 1); // free choice: west along row 1 to A's dock, or the long way round
    const jammed = new Set(w.graph.edges.filter((e) => w.graph.cy(e.from) === 1 && w.graph.cy(e.to) === 1 && w.graph.cx(e.from) <= 3 && w.graph.cx(e.to) <= 3).map((e) => e.id));
    w.traffic.edgeCount = (id) => (jammed.has(id) ? 30 : 0); // pretend the short way is jammed
    const routes = [];
    const drive = w.traffic.drive.bind(w.traffic);
    w.traffic.drive = (tv, route) => { routes.push(route); return drive(tv, route); };
    w.run(120);
    assert.equal(w.lg.completed, 1, 'the load is delivered either way');
    return routes[0].nodes.map((n) => w.graph.cy(n));
  };
  assert.ok(!firstRoute('shortest').includes(3), 'shortest takes the 3-cell road west');
  const detour = firstRoute('congestion');
  assert.ok(detour.includes(3) && detour.length > 6, 'the jammed road is avoided: round the long way');
});

test('route cache: searches are keyed by start node and arrival edge, so the no-U-turn rule is respected', () => {
  const graph = buildGraph(layoutFromAscii(['.A......', '+'.repeat(8)], { stations: { A: 'source' }, fleets: [] }));
  const cache = new RouteCache(graph, { edgeCount: () => 0 });
  const at = (x) => 8 + x; // grid is 8 wide: node id = y * 8 + x
  const mid = at(3);
  const fromWest = graph.edgeBetween(at(2), mid);
  const free = cache.get(mid, -1, 0);
  const arrived = cache.get(mid, fromWest, 0);
  assert.notEqual(free, arrived);
  assert.equal(cache.get(mid, -1, 0), free, 'cached');
  assert.equal(cache.get(mid, fromWest, 0), arrived, 'cached per arrival edge');
  const direct = cache.bestDock(free, 'A');
  assert.equal(direct.node, at(1));
  assert.equal(direct.dist, 4, 'free choice: two cells west');
  const detour = cache.bestDock(arrived, 'A');
  assert.equal(detour.node, at(1));
  assert.equal(detour.dist, 20, 'having come from the west it must drive on to the east end and turn there');
  assert.equal(graph.edges[detour.arrivalEdge].to, at(1));
  assert.equal(cache.routeTo(arrived, at(1)).edges.length, 10);
  assert.equal(cache.bestDock(free, 'nowhere'), null);
  assert.equal(cache.bestDock(free, 'nowhere'), null, 'unreachable answers are cached too');
  const here = cache.bestDock(cache.get(at(1), -1, 0), 'A');
  assert.deepEqual([here.node, here.dist, here.arrivalEdge], [at(1), 0, -1], 'already on the dock: zero-length route keeps the arrival edge');
});

test('routing: a vehicle never reverses in mid-road - after loading mid-line it drives on to the end of the line and back', () => {
  const layout = layoutFromAscii(['.....A..D', '+++++++++'], {
    stations: { A: { type: 'source', params: { interArrival: dist('const', 1000), startDelay: 1 } }, D: 'sink' },
    flows: [['A', 'D']], fleets: [{ count: 1, ...{ speed: 2, accel: 1, decel: 1, loadTime: 2, unloadTime: 2 } }],
  });
  const w = createWorld(layout, { dt: 0.5, check: true });
  place(w, 8, 1); // east of A, free choice: the pickup is straight ahead (west)
  const routes = [];
  const drive = w.traffic.drive.bind(w.traffic);
  w.traffic.drive = (tv, route) => { routes.push(route.nodes.map((n) => w.graph.cx(n))); return drive(tv, route); };
  w.run(200);
  assert.equal(w.lg.completed, 1);
  assert.deepEqual(routes[0], [8, 7, 6, 5], 'to A (x=5)');
  // D (x=8) lies behind the vehicle now, but turning around is only possible at the west dead end (x=0)
  assert.deepEqual(routes[1], [5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

// ---- priority aging ------------------------------------------------------------------------------------------------------------

test('dispatch: priority is strict at first, but a flow that waits PRIORITY_AGING per level is not starved for ever', () => {
  // An urgent flow N near the sink D always has a fresh load ready; the normal flow F is far away (the vehicle turns round at the
  // dead end behind D, so N is 16 m and F 48 m from where it unloads). With strict priority F never
  // gets the only vehicle. Its priority rises by one level per PRIORITY_AGING seconds the oldest load has waited: at 2 levels it ties
  // with N (and the nearer N still wins), at 3 levels it is the highest and is served.
  const layout = layoutFromAscii(['F...............N.......D', '+'.repeat(25)], {
    stations: { N: { type: 'source', params: { interArrival: OFF } }, F: { type: 'source', params: { interArrival: OFF } }, D: 'sink' },
    flows: [['N', 'D', { priority: 3 }], ['F', 'D', { priority: 1 }]],
    fleets: [{ count: 1, idle: 'stay', speed: 4, accel: 2, decel: 2, loadTime: 1, unloadTime: 1 }],
  });
  const w = createWorld(layout, { dt: 1, check: true });
  injectLoads(w.lg, 'f2', 2, { createdAt: 0, readyAt: 0 });
  const served = (flowId) => w.named('orderAssigned').filter((p) => p.order.flowId === flowId).map((p) => p.t);
  const urgent = w.lg.flowById.get('f1').outLink;
  const runTo = (seconds) => {
    while (w.t < seconds) {
      if (urgent.queue.length === urgent.claimed) injectLoads(w.lg, 'f1', 1, { createdAt: w.t, readyAt: w.t });
      w.step();
    }
  };
  runTo(PRIORITY_AGING - 100);
  assert.ok(served('f1').length > 20, 'the urgent flow keeps the vehicle busy');
  assert.deepEqual(served('f2'), [], 'strict priority: the normal flow gets nothing yet');
  runTo(3 * PRIORITY_AGING - 100);
  assert.deepEqual(served('f2'), [], 'at two levels it only ties with the urgent flow, which is nearer');
  runTo(3 * PRIORITY_AGING + 100);
  const [first] = served('f2');
  assert.ok(first >= 3 * PRIORITY_AGING && first < 3 * PRIORITY_AGING + 60, `served at ${first} s, when its oldest load had waited 3 x ${PRIORITY_AGING} s`);
});

// ---- waking up exactly when something becomes possible ------------------------------------------------------------------------------

test('dispatch: a partial batch leaves in the tick in which its maxWait runs out, not at the next poll', () => {
  const lags = [];
  for (const readyAt of [5.0, 5.03, 5.12, 5.31, 5.49]) {
    const layout = layoutFromAscii(['S....D', '++++++'], {
      stations: { S: { type: 'source', params: { interArrival: OFF } }, D: 'sink' },
      flows: [['S', 'D', { batchMin: 4, maxWait: 7.3 }]], fleets: [{ count: 1, preset: 'tugger', idle: 'stay' }],
    });
    const w = createWorld(layout, { dt: 0.1, check: true });
    w.step(30);
    injectLoads(w.lg, 'f1', 2, { createdAt: readyAt, readyAt });
    w.run(20);
    const [order] = w.named('orderAssigned');
    assert.equal(order.order.qty, 2);
    lags.push(order.t - (readyAt + 7.3));
  }
  assert.ok(lags.every((l) => l >= -1e-9 && l <= 0.1 + 1e-9), `lag between "maxWait over" and "assigned" (s): ${lags.map((l) => l.toFixed(2)).join(', ')}`);
});

// ---- docks ---------------------------------------------------------------------------------------------------------------------------

test('route cache: docks come back returnable first, then by cost; a one-way dead-end dock is a last resort', () => {
  const layout = layoutFromAscii(['SS......DD..', 'SS.....^DD..', '++++++++++++'], {
    stations: { S: 'source', D: 'sink' }, flows: [['S', 'D']], fleets: [],
  });
  const graph = buildGraph(layout);
  const cache = new RouteCache(graph, { edgeCount: () => 0 });
  const at = (x, y) => y * graph.cols + x;
  const docks = cache.docksOf(cache.get(at(2, 2), -1, 0), 'D');
  assert.deepEqual(docks.map((d) => [d.node, d.back]), [[at(8, 2), true], [at(9, 2), true], [at(7, 1), false]], 'the trap (7,1) is as near as (8,2) but comes last');
  assert.equal(cache.bestDock(cache.get(at(2, 2), -1, 0), 'D').node, at(8, 2));
  const onlyTrap = cache.docksOf(cache.get(at(2, 2), -1, 0), 'S');
  assert.ok(onlyTrap.every((d) => d.back), 'the docks of S are all on the main road');
});

test('route cache: a pickup dock must lead on to the drop; with only a trap in reach there is no pickup dock', () => {
  const open = layoutFromAscii(['..SS........', '.^SS...D....', '++++++++++++'], { stations: { S: 'source', D: 'sink' }, flows: [['S', 'D']], fleets: [] });
  const g = buildGraph(open);
  const cache = new RouteCache(g, { edgeCount: () => 0 });
  const at = (x, y) => y * g.cols + x;
  const entry = cache.get(at(0, 2), -1, 0);
  assert.deepEqual(cache.docksOf(entry, 'S').map((d) => d.node), [at(2, 2), at(3, 2), at(1, 1)], 'the trap is not returnable: last');
  assert.equal(cache.pickupDock(entry, 'S', 'D').node, at(2, 2));
  assert.equal(cache.pickupDock(entry, 'S', 'D'), cache.pickupDock(entry, 'S', 'D'), 'cached');
  const closed = layoutFromAscii(['..SS........', '.^SS...D....', '++..++++++++'], { stations: { S: 'source', D: 'sink' }, flows: [['S', 'D']], fleets: [] });
  const g2 = buildGraph(closed);
  const c2 = new RouteCache(g2, { edgeCount: () => 0 });
  const e2 = c2.get(0 * g2.cols + 0 + g2.cols * 2, -1, 0);
  assert.deepEqual(c2.docksOf(e2, 'S').map((d) => d.node), [g2.cols + 1], 'only the trap dock of S is reachable');
  assert.equal(c2.pickupDock(e2, 'S', 'D'), null, 'D cannot be reached from the trap');
});

test('route cache: plain-cost searches survive a congestion refresh, the others expire; the least recently used are evicted first', () => {
  const graph = buildGraph(layoutFromAscii(['.A......', '+'.repeat(8)], { stations: { A: 'source' }, fleets: [] }));
  const at = (x) => 8 + x;
  const cache = new RouteCache(graph, { edgeCount: () => 0 }, 'congestion');
  const costed = cache.get(at(3), -1, 0);
  const plain = cache.settled(at(3), -1);
  assert.equal(cache.get(at(3), -1, CONGESTION_REFRESH - 0.5), costed, 'the snapshot lives for CONGESTION_REFRESH');
  assert.notEqual(cache.get(at(3), -1, CONGESTION_REFRESH), costed, 'then it is renewed');
  assert.equal(cache.settled(at(3), -1), plain, 'plain costs do not depend on traffic');
  cache.fixedCapacity = 4;
  const kept = [2, 3, 4, 5].map((x) => cache.settled(at(x), -1));
  cache.settled(at(2), -1); // touch
  cache.settled(at(6), -1); // full: the least recently used quarter (one entry) goes
  assert.equal(cache.settled(at(2), -1), kept[0], 'the entry that was just used stays');
  assert.notEqual(cache.settled(at(3), -1), kept[1], 'the one unused longest was dropped');
});

test('route cache: the memory budget caps the number of searches on a big plant', () => {
  const big = layoutFromAscii(['+'.repeat(160)], { fleets: [] });
  big.grid.rows = 160;
  const graph = buildGraph(big);
  const cache = new RouteCache(graph, { edgeCount: () => 0 });
  const perSearch = 12 * graph.nodes.length + 12 * graph.edges.length; // what a cached search keeps: per ROAD cell a distance and an edge, per link a predecessor and (until it has explored everything) a cost
  assert.ok((cache.fixedCapacity + cache.capacity) * perSearch <= ROUTE_CACHE_BYTES + 8 * perSearch, 'within the budget (plus the minimum of 8 per cache)');
  assert.ok(cache.fixedCapacity >= 8 && cache.fixedCapacity <= 512);
  const small = new RouteCache(buildGraph(layoutFromAscii(['A.B', '+++'], { stations: { A: 'source', B: 'sink' }, fleets: [] })), { edgeCount: () => 0 });
  assert.ok(small.fixedCapacity >= 128, 'a normal plant caches hundreds of searches');
});
