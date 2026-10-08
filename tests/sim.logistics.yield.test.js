// Logistics: idle vehicles must not lock a plant. A vehicle that stands still holds up everything behind it, so when
// another vehicle has waited behind an idle one (or a parked vehicle with work cannot leave its depot because an idle
// one stands on its gate) the idle vehicle makes room: it parks, or drives to a road cell where it hinders nobody.
// Most tests run on the REAL traffic engine - only it can queue vehicles behind each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutFromAscii } from './helpers/ascii.js';
import { createWorld, eventDigest, injectLoads } from './helpers/logistics-invariants.js';
import { createRealWorld, hostilePlant, runChecked, waitBehindIdle } from './helpers/logistics-review-gen.js';
import { IDLE_GRACE, YIELD_AFTER } from '../js/sim/logistics/common.js';
import { applyIdlePolicy } from '../js/sim/logistics/idle.js';
import { leaveDepot, setState } from '../js/sim/logistics/vehicles.js';
import { dist } from '../js/model/defaults.js';

const OFF = dist('const', 0);
const node = (w, x, y) => y * w.graph.cols + x;
const AGV = { speed: 2, accel: 1, decel: 1, loadTime: 2, unloadTime: 2 };

/**
 * A source A and sinks X and D on the main road (row 1) and a storage P at the end of a one-cell spur at x=4: P's only dock (4,3) is
 * a dead end. X's docks (2..4,1) are the cells nearest to P on the main road. `depot` adds a depot G at the east end.
 */
function spurPlant({ fleet = {}, count = 2, depot = false } = {}) {
  const rows = [depot ? 'A.XXX...D.G' : 'A.XXX...D..', '+++++++++++', '....+......', '....+......', '...PPP.....'];
  const stations = {
    A: { type: 'source', params: { interArrival: OFF, outCap: 6 } }, D: 'sink', X: 'sink', P: { type: 'storage', params: { capacity: 10 } },
    ...(depot ? { G: { type: 'depot', params: { slots: 4, chargers: 0 } } } : {}),
  };
  return layoutFromAscii(rows, { stations, flows: [['A', 'P']], fleets: [{ count, idle: 'stay', ...AGV, ...fleet }] });
}

/** Take a vehicle that starts parked in a depot out onto the road (over any dock where it fits). */
function takeOut(w, vr) {
  if (vr.state !== 'parked') return;
  const dock = w.graph.docks.get(vr.depot.id).find((d) => w.traffic.canAttach(d));
  assert.ok(dock !== undefined && leaveDepot(w.lg, vr, dock));
  setState(vr, 'idle', 0);
}

/** Put a vehicle (that may start parked in a depot) onto the road cell [x, y]. */
function putOnRoad(w, vr, [x, y]) {
  takeOut(w, vr);
  return vr.tv.node === node(w, x, y) || w.traffic.relocate(vr.tv, node(w, x, y));
}

/** Put the vehicles onto their cells in order (a vehicle that is to stand on the only dock of the depot goes last). */
function placeAll(w, cells) {
  w.lg.vehicles.forEach((v, i) => assert.ok(putOnRoad(w, v, cells[i]), `cell ${cells[i]}`));
}

/** Two vehicles: `idler` stands on P's dock, `worker` is on the main road and gets the first load. */
function spurWorld(opts) {
  const w = createRealWorld(spurPlant(opts), { dt: 0.25, check: true });
  const [idler, worker] = w.lg.vehicles;
  assert.deepEqual([putOnRoad(w, idler, [4, 3]), putOnRoad(w, worker, [5, 1])], [true, true]);
  return { w, idler, worker };
}

test('yield: an idle vehicle on the only (dead-end) dock of a station makes room once a vehicle has waited behind it', () => {
  const { w, idler, worker } = spurWorld();
  injectLoads(w.lg, 'f1', 1, { createdAt: 0 });
  let workerRoute = null;
  let maxWait = 0;
  let spot = -1;
  for (let i = 0; i < 4 * 200 && w.lg.flowById.get('f1').delivered === 0; i++) {
    w.step();
    if (!workerRoute && worker.route && worker.state === 'toDrop') workerRoute = worker.route.nodes.slice();
    maxWait = Math.max(maxWait, worker.tv.waitTime);
    if (idler.state === 'toPark' && idler.spot >= 0) spot = idler.spot;
  }
  assert.equal(w.lg.flowById.get('f1').delivered, 1, 'the load reaches P');
  assert.ok(spot >= 0, 'the idle vehicle drove to a waiting cell');
  assert.ok(maxWait >= YIELD_AFTER && maxWait < YIELD_AFTER + 25, `the worker waited ${maxWait.toFixed(1)} s behind it`);
  assert.equal(w.graph.stationsAt.has(spot), false, 'not a dock - although the docks of X are as near as the plain cells');
  assert.equal(w.graph.controlled[spot], 0, 'not a junction or dead end');
  assert.ok(!workerRoute.includes(spot), 'not on the route the other vehicle was driving');
  w.run(30);
  assert.equal(idler.state, 'idle');
  assert.equal(idler.tv.node, spot, 'it waits there now');
  assert.ok(idler.parkDistance > 0);
});

test('yield: a vehicle that holds nobody up stays exactly where its last job ended', () => {
  const { w, idler } = spurWorld();
  w.run(300);
  assert.equal(idler.tv.node, node(w, 4, 3));
  assert.equal(idler.state, 'idle');
  assert.equal(idler.parkDistance, 0);
  assert.equal(idler.tv.odometer, 0);
});

test('yield: a vehicle of a "park" fleet goes to its depot at once instead of waiting out the grace period', () => {
  const { w, idler, worker } = spurWorld({ depot: true, fleet: { idle: 'park', home: 'G' } });
  assert.equal(w.lg.stationById.get('G').parked.length, 0, 'both vehicles were taken out of the depot by the test');
  injectLoads(w.lg, 'f1', 1, { createdAt: 0 });
  assert.ok(w.runUntil(() => worker.state === 'toDrop', 100));
  idler.stateSince = w.t; // the idler has only just fallen idle: its own grace period starts now
  const idleSince = w.t;
  assert.ok(w.runUntil(() => idler.state === 'toPark', 100));
  assert.ok(w.t - idleSince < IDLE_GRACE - 5, `it left ${w.t - idleSince} s after it fell idle - the grace period of ${IDLE_GRACE} s was not waited out`);
  assert.equal(idler.targetId, 'G');
  assert.equal(idler.spot, -1, 'to the depot, not to a waiting cell');
  w.run(150);
  assert.equal(idler.state, 'parked');
  assert.equal(w.lg.flowById.get('f1').delivered, 1);
});

test('yield: several vehicles queued behind one idle vehicle are all let through', () => {
  const w = createRealWorld(spurPlant({ count: 4 }), { dt: 0.25, check: true });
  const cells = [[4, 3], [6, 1], [7, 1], [9, 1]];
  placeAll(w, cells);
  injectLoads(w.lg, 'f1', 3, { createdAt: 0 });
  w.run(400);
  assert.equal(w.lg.flowById.get('f1').delivered, 3);
  assert.ok(waitBehindIdle(w) < YIELD_AFTER + 1e-9, 'nobody is waiting behind an idle vehicle any more');
});

test('yield: a parked vehicle that cannot leave because an idle vehicle stands on its depot gate gets out (stub traffic)', () => {
  const layout = layoutFromAscii(['Q....G....R.', '++++++++++++', '.....K......'], {
    stations: {
      G: { type: 'depot', params: { slots: 2, chargers: 0 } }, K: 'sink',
      Q: { type: 'source', params: { interArrival: OFF } }, R: { type: 'source', params: { interArrival: OFF } },
    },
    flows: [['Q', 'K', { fleetId: 'v1' }], ['R', 'K', { fleetId: 'v2' }]],
    fleets: [{ count: 1, idle: 'stay', home: 'G', ...AGV }, { count: 1, idle: 'park', home: 'G', ...AGV }],
  });
  const w = createWorld(layout, { dt: 0.5, check: true });
  const [stayer, parker] = w.lg.vehicles;
  injectLoads(w.lg, 'f1', 1);
  w.run(200);
  assert.equal(w.lg.flowById.get('f1').delivered, 1);
  assert.equal(stayer.tv.node, node(w, 5, 1), 'the "stay" vehicle idles on the gate cell of G, which is also a dock of K');
  assert.equal(parker.state, 'parked');
  injectLoads(w.lg, 'f2', 1);
  w.run(120);
  assert.equal(w.lg.flowById.get('f2').delivered, 1, 'the parked vehicle was let out');
  assert.notEqual(stayer.tv.node, node(w, 5, 1), 'the idle vehicle made room');
  assert.equal(w.graph.stationsAt.has(stayer.tv.node), false);
  assert.ok(stayer.parkDistance > 0);
});

test('yield: a plant with one-way lines, batteries and breakdowns never keeps a vehicle waiting behind an idle one for long', () => {
  for (const seed of [3, 5, 12, 17, 70, 92]) {
    const w = createRealWorld(hostilePlant(seed), { dt: 0.25 });
    let worst = 0;
    for (let i = 0; i < 90; i++) {
      runChecked(w, 10, 8);
      worst = Math.max(worst, waitBehindIdle(w));
    }
    assert.ok(worst < 60, `plant ${seed}: a vehicle waited ${worst.toFixed(0)} s behind an idle one`);
  }
});

// ---- where a vehicle waits -------------------------------------------------------------------------------------------------------

/** Stub world: a depot G (dock (5,1)) on a main road of 12 cells, `rows` below the road, `vehicles` 'stay' AGVs, all taken out of the depot. */
function gateWorld({ below = [], vehicles, cells }) {
  const layout = layoutFromAscii(['Q....G......', '+'.repeat(12), ...below], {
    stations: { Q: { type: 'source', params: { interArrival: OFF } }, G: { type: 'depot', params: { slots: 4 } } },
    flows: [], fleets: [{ count: vehicles, idle: 'stay', ...AGV }],
  });
  const w = createWorld(layout, { dt: 0.5, check: true });
  placeAll(w, cells);
  return w;
}

/** Vehicle `driver` is on its way along the whole main road (as the dispatcher would have sent it). */
function driveAlongRoad(w, driver) {
  const route = w.graph.path(driver.tv.node, node(w, 0, 1), { arrivalEdge: -1 });
  w.traffic.drive(driver.tv, route);
  driver.route = route;
}

const gate = (w) => new Set([w.lg.stationById.get('G')]);

/** The gate of G is reported blocked in two dispatch rounds YIELD_AFTER seconds apart: now the vehicles standing at it must make room. */
function makeRoom(w) {
  applyIdlePolicy(w.lg, 0, gate(w));
  assert.ok(w.lg.vehicles.every((v) => v.state === 'idle'), 'a gate that has been blocked for a moment only is no reason to move');
  applyIdlePolicy(w.lg, YIELD_AFTER, gate(w));
}

test('waiting cell: a cell on the route another vehicle is driving is passed over for a side road', () => {
  const w = gateWorld({ below: ['........+...', '........+...'], vehicles: 2, cells: [[11, 1], [5, 1]] });
  const [driver, idler] = w.lg.vehicles;
  driveAlongRoad(w, driver);
  makeRoom(w);
  assert.equal(idler.state, 'toPark');
  assert.equal(w.graph.cx(idler.spot), 8, 'the side road at x=8: 3 cells away, but not on the route in use');
  assert.equal(w.graph.cy(idler.spot), 2, 'its first cell - the dead end behind it is a controlled cell');
});

test('waiting cell: in a plant with a single aisle every cell is on a route - the vehicle still gets out of the way', () => {
  const w = gateWorld({ vehicles: 2, cells: [[11, 1], [5, 1]] });
  const [driver, idler] = w.lg.vehicles;
  driveAlongRoad(w, driver);
  makeRoom(w);
  assert.equal(idler.state, 'toPark', 'a busy cell is better than blocking the gate');
  assert.notEqual(idler.spot, node(w, 5, 1));
  assert.equal(w.graph.stationsAt.has(idler.spot), false);
});

test('waiting cell: two vehicles that make room in the same round get different cells', () => {
  const layout = layoutFromAscii(['Q...GGG.....', '++++++++++++'], {
    stations: { Q: { type: 'source', params: { interArrival: OFF } }, G: { type: 'depot', params: { slots: 4 } } },
    flows: [], fleets: [{ count: 2, idle: 'stay', ...AGV }],
  });
  const w = createWorld(layout, { dt: 0.5, check: true });
  const [a, b] = w.lg.vehicles;
  placeAll(w, [[4, 1], [5, 1]]);
  makeRoom(w);
  assert.equal(a.state, 'toPark');
  assert.equal(b.state, 'toPark');
  assert.notEqual(a.spot, b.spot);
  for (const v of [a, b]) assert.equal(w.graph.stationsAt.has(v.spot), false, 'neither goes to another dock of G');
});

test('waiting cell: a gate that is free again before YIELD_AFTER has passed does not move anybody', () => {
  const w = gateWorld({ vehicles: 1, cells: [[5, 1]] });
  const [idler] = w.lg.vehicles;
  applyIdlePolicy(w.lg, 0, gate(w));
  applyIdlePolicy(w.lg, 1, new Set());
  applyIdlePolicy(w.lg, YIELD_AFTER + 0.5, gate(w));
  assert.equal(idler.state, 'idle', 'the clock restarted when the gate was free');
  applyIdlePolicy(w.lg, 2 * YIELD_AFTER + 0.5, gate(w));
  assert.equal(idler.state, 'toPark');
});

test('waiting cell: of two equally near cells the one that is neither a junction nor used by routes is taken', () => {
  const w = gateWorld({ below: ['....+.......'], vehicles: 1, cells: [[5, 1]] });
  const [idler] = w.lg.vehicles;
  makeRoom(w);
  assert.equal(idler.state, 'toPark');
  assert.equal(w.graph.cx(idler.spot), 6, '(4,1) is a T-junction (controlled), (6,1) is a plain cell, both one cell away');

  const used = gateWorld({ vehicles: 1, cells: [[5, 1]] });
  used.lg.routeUse[node(used, 4, 1)] = 3; // routes have been driven over (4,1), never over (6,1)
  makeRoom(used);
  assert.equal(used.graph.cx(used.lg.vehicles[0].spot), 6);
});

test('waiting cell: a cell promised to another vehicle is not given out twice, even when it is by far the best', () => {
  // every cell of the main road is a dock of some station, except the two at the east end; G's docks are (4,1) and (5,1)
  const layout = layoutFromAscii(['XXXXGGYYYY..', '+'.repeat(12)], {
    stations: { X: 'sink', Y: 'sink', G: { type: 'depot', params: { slots: 4 } } }, flows: [], fleets: [{ count: 2, idle: 'stay', ...AGV }],
  });
  const w = createWorld(layout, { dt: 0.5, check: true });
  const [a, b] = w.lg.vehicles;
  assert.ok(putOnRoad(w, a, [4, 1]) && putOnRoad(w, b, [5, 1]));
  makeRoom(w);
  assert.deepEqual([a.state, b.state], ['toPark', 'toPark']);
  assert.deepEqual([a.spot, b.spot].map((n) => w.graph.cx(n)).sort((p, q) => p - q), [10, 11], 'the two plain cells, one each');
});

test('waiting cell: a vehicle that finds nowhere to go does not look again every half second', () => {
  const layout = layoutFromAscii(['G.', '++'], {
    stations: { G: { type: 'depot', params: { slots: 4 } } }, flows: [], fleets: [{ count: 2, idle: 'stay', ...AGV }],
  });
  const w = createWorld(layout, { dt: 0.5, check: true });
  const [a, b] = w.lg.vehicles;
  placeAll(w, [[1, 1], [0, 1]]);
  let attempts = 0;
  const canAttach = w.traffic.canAttach.bind(w.traffic);
  w.traffic.canAttach = (n) => { attempts++; return canAttach(n); };
  for (let t = 0; t < 8; t += 0.5) applyIdlePolicy(w.lg, t, gate(w));
  assert.ok([a, b].every((v) => v.state === 'idle'), 'two cells, both occupied: nowhere to go');
  assert.ok(attempts > 0 && attempts <= 6, `${attempts} attempts in 8 s - the vehicles back off for YIELD_RETRY after a failure`);
});

// ---- the whole thing, on random plants -------------------------------------------------------------------------------------------

test('fuzz on the real engine: 20 hostile plants, 8 simulated minutes each, live what-if changes - every invariant on every few ticks, no long idle jams', () => {
  const settings = [{ speedFactor: 2 }, { demandFactor: 3, processFactor: 0.5 }, { dispatch: 'oldest', routing: 'congestion' }, { dispatch: 'balanced', routing: 'shortest', speedFactor: 0.5 }];
  for (let seed = 100; seed < 120; seed++) {
    const w = createRealWorld(hostilePlant(seed), { dt: 0.25 });
    let worst = 0;
    for (let i = 0; i < 48; i++) {
      if (i % 12 === 6) w.lg.setRuntime(settings[(i / 12) | 0]);
      runChecked(w, 10, 8);
      worst = Math.max(worst, waitBehindIdle(w));
    }
    assert.ok(worst < 80, `plant ${seed}: a vehicle waited ${worst.toFixed(0)} s behind an idle one`);
  }
});

test('determinism on the real engine: making room, parking and re-planning replay identically', () => {
  const digest = () => {
    const w = createRealWorld(hostilePlant(70), { dt: 0.25 });
    w.run(900);
    return eventDigest(w.events) + ':' + w.lg.vehicles.map((v) => v.tv.odometer.toFixed(3) + v.parkDistance.toFixed(3)).join(',');
  };
  assert.equal(digest(), digest());
});
