// Logistics: idle vehicles must not lock a plant. A vehicle that stands still holds up everything behind it, so when
// another vehicle has waited behind an idle one (or a parked vehicle with work cannot leave its depot because an idle
// one stands on its gate) the idle vehicle makes room: it parks, or drives to a road cell where it hinders nobody.
// Most tests run on the REAL traffic engine - only it can queue vehicles behind each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutFromAscii } from './helpers/ascii.js';
import { createWorld, injectLoads } from './helpers/logistics-invariants.js';
import { createRealWorld, hostilePlant, runChecked, waitBehindIdle } from './helpers/logistics-review-gen.js';
import { IDLE_GRACE, YIELD_AFTER } from '../js/sim/logistics/common.js';
import { leaveDepot, setState } from '../js/sim/logistics/vehicles.js';
import { dist } from '../js/model/defaults.js';

const OFF = dist('const', 0);
const node = (w, x, y) => y * w.graph.cols + x;
const AGV = { speed: 2, accel: 1, decel: 1, loadTime: 2, unloadTime: 2 };

/**
 * A source A and a sink D on the main road (row 1) and a storage P at the end of a one-cell spur at x=4: P's only dock (4,3) is a
 * dead end. `extra` adds station letters (a depot G on the main road).
 */
function spurPlant({ fleet = {}, count = 2, depot = false } = {}) {
  const rows = [depot ? 'A.......D.G' : 'A.......D..', '+++++++++++', '....+......', '....+......', '...PPP.....'];
  const stations = {
    A: { type: 'source', params: { interArrival: OFF, outCap: 6 } }, D: 'sink', P: { type: 'storage', params: { capacity: 10 } },
    ...(depot ? { G: { type: 'depot', params: { slots: 4, chargers: 0 } } } : {}),
  };
  return layoutFromAscii(rows, { stations, flows: [['A', 'P']], fleets: [{ count, idle: 'stay', ...AGV, ...fleet }] });
}

/** Take a vehicle that starts parked in a depot out onto the road, onto `cell`. */
function putOnRoad(w, vr, [x, y]) {
  if (vr.state === 'parked') {
    const dock = w.graph.docks.get(vr.depot.id)[0];
    assert.ok(leaveDepot(w.lg, vr, dock));
    setState(vr, 'idle', 0);
  }
  return w.traffic.relocate(vr.tv, node(w, x, y));
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
  assert.equal(w.graph.stationsAt.has(spot), false, 'not a dock');
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
  w.lg.vehicles.forEach((v, i) => assert.ok(putOnRoad(w, v, cells[i])));
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
