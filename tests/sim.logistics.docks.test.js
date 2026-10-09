// The dock book (js/sim/logistics/docks.js): which dock of a station a vehicle drives to, and who is on or heading for which dock.
// Hand-made small plants, stepped tick by tick with the real traffic system:
//   * routing: dockChoices lists the docks a vehicle may choose between (returnable first, a pickup dock must lead on to the drop)
//   * choice: a free dock beats an occupied cheaper one; ties go to the cheaper route, then the lower node id; docks lined up on one lane
//     block each other and an off-lane free dock wins; a broken vehicle on a dock (or in the way) keeps it taken
//   * reservations: made when a leg is planned, replaced when it is planned again (deadlock relocation), released on arrival, when the order
//     is given up and when the vehicle is removed; a broken vehicle's reservation is ignored; the invariant helper finds no leak on any tick
//   * late rebinding: a vehicle still on its way switches when another dock is clearly better (TrafficSystem.reroute), once per approach
//   * TrafficSystem.reroute itself: keeps the edge the vehicle is on, refuses a switch too close to the vehicle or a U-turn, and survives a fuzz
//     with the traffic invariants (no overlap, no jump, locks consistent) checked on every tick
//   * dockSkew / explainDockSkew: why one dock is used far more than another (a trap, a lane, a detour)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutFromAscii } from './helpers/ascii.js';
import { createRealWorld } from './helpers/logistics-review-gen.js';
import { createInvariantChecker, createWorld as createTrafficWorld } from './helpers/traffic-invariants.js';
import { arrivalEdgeOf } from '../js/sim/logistics/vehicles.js';
import { checkDockInvariants, dockSkew, explainDockSkew, serves } from '../js/sim/logistics/docks.js';
import { buildGraph } from '../js/sim/graph.js';
import { createRng } from '../js/util/rng.js';

const source = (mean, extra = {}) => ({ type: 'source', params: { interArrival: { kind: 'const', mean, spread: 0 }, outCap: 50, startDelay: mean >= 1e6 ? 1e9 : 0, ...extra } });
const cellAt = (world, node) => `${world.graph.cx(node)},${world.graph.cy(node)}`;
const atCell = (world, x, y) => y * world.graph.cols + x;
const agvFleet = (count, extra = {}) => ({ count, preset: 'agv', idle: 'stay', ...extra });

/** Hand one load to the dispatcher, as a source would. */
function offerLoad(world, stationId = 'A') {
  const st = world.lg.stationById.get(stationId);
  st.outLinks[0].queue.push(world.lg.createLoad(st, world.t, world.t, 'source'));
  world.lg.markDirty();
}

/** Two spur docks (1,2) and (4,2) at the source A, one at the sink B. */
const TWO_SPURS = [
  'AAAAAA..BBB',
  'AAAAAA..BBB',
  '.+..+....+.',
  '.+++++++++.',
];
function twoSpurs({ vehicles = 2, loadTime = 60, interArrival = 5 } = {}) {
  return layoutFromAscii(TWO_SPURS, {
    stations: { A: source(interArrival), B: 'sink' },
    flows: [['A', 'B']],
    fleets: [agvFleet(vehicles, { loadTime, unloadTime: 5 })],
    settings: { warmup: 0, seed: 1 },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// routing.js: the docks a vehicle may choose between
// ---------------------------------------------------------------------------------------------------------------------

test('dockChoices: the reachable docks of the best class, cheapest first; the first is what bestDock and pickupDock return', () => {
  const w = createRealWorld(twoSpurs());
  const { lg } = w;
  const vr = lg.vehicles[0];
  const entry = lg.routes.get(vr.tv.node, arrivalEdgeOf(lg, vr), 0);
  const choices = lg.routes.dockChoices(entry, 'A');
  assert.equal(choices.length, 2);
  assert.ok(choices[0].dist <= choices[1].dist);
  assert.equal(lg.routes.bestDock(entry, 'A'), choices[0]);
  assert.equal(lg.routes.pickupDock(entry, 'A', 'B'), choices[0]);
  assert.equal(lg.routes.dockChoices(entry, 'A', 'B').length, 2, 'both lead on to the sink');
  assert.equal(lg.routes.dockChoices(entry, 'B').length, 1, 'a single dock is a single choice');
  assert.equal(lg.routes.dockChoices(entry, 'A'), choices, 'cached per entry');
});

test('dockChoices: a dock a vehicle cannot get back from is left out while a returnable one exists', () => {
  // the cell at x=4 is a one-way cell pointing at the station: it can be reached, but the vehicle is swallowed
  const layout = layoutFromAscii([
    'AAAAAA..',
    'AAAAAA..',
    '.+..^...',
    '.+++++++',
  ], { stations: { A: source(1e6) }, flows: [], fleets: [{ count: 1 }], settings: { warmup: 0 } });
  const w = createRealWorld(layout);
  const vr = w.lg.vehicles[0];
  const entry = w.lg.routes.get(vr.tv.node, arrivalEdgeOf(w.lg, vr), 0);
  const all = w.lg.routes.docksOf(entry, 'A');
  assert.equal(all.length, 2, 'both are reachable');
  assert.ok(all.some((d) => !d.back), 'one of them is a trap');
  const choices = w.lg.routes.dockChoices(entry, 'A');
  assert.equal(choices.length, 1);
  assert.ok(choices[0].back, 'only the returnable dock is offered');
});

// ---------------------------------------------------------------------------------------------------------------------
// The choice
// ---------------------------------------------------------------------------------------------------------------------

test('a second vehicle takes the free dock instead of queueing at the cheaper occupied one; with the old ranking it queues', () => {
  const together = (enabled) => {
    const w = createRealWorld(twoSpurs(), { check: true });
    w.lg.docks.enabled = enabled;
    const both = w.runUntil((x) => x.lg.vehicles.filter((v) => v.state === 'loading').length === 2, 200);
    return { w, both };
  };
  const on = together(true);
  assert.ok(on.both, 'both vehicles load at the same time, at two different docks');
  const [a, b] = on.w.lg.vehicles.map((v) => v.tv.node);
  assert.notEqual(a, b);
  assert.ok(on.w.t < 60, `and early (${on.w.t.toFixed(1)} s)`);
  assert.equal(together(false).both, false, 'the old ranking sends both to the cheapest dock: one waits for the other');
});

test('the dock book counts a visit when service starts, the vehicle on the cell is its occupant, the status follows', () => {
  const w = createRealWorld(twoSpurs({ vehicles: 1, loadTime: 30 }), { check: true });
  const vr = w.lg.vehicles[0];
  const book = w.lg.docks;
  assert.equal(book.byStation.get('A').length, 2);
  assert.ok(w.runUntil((x) => x.lg.vehicles[0].dock !== null, 20));
  assert.equal(book.status(vr.dock.node), 'reserved', 'a vehicle is on its way to the dock');
  assert.ok(w.runUntil((x) => x.lg.vehicles[0].state === 'loading', 100));
  const node = vr.tv.node;
  w.step();
  assert.equal(book.status(node), 'occupied');
  assert.equal(book.cells.get(node).occupant, vr);
  assert.equal(vr.dock, null, 'the reservation ended on arrival');
  assert.equal(book.counters('A').reduce((n, d) => n + d.visits, 0), 1);
  w.run(35);
  const dock = book.counters('A').find((d) => d.node === node);
  assert.ok(dock.busy >= 30, `busy time counts the loading time (${dock.busy.toFixed(1)} s)`);
  assert.equal(dock.wait, 0, 'nobody queued');
});

test('ties go to the cheaper route, then to the lower node id; a station with one usable dock is not evaluated', () => {
  const layout = layoutFromAscii([
    'AAAAAAAAA',
    '.+.....+.',
    '.+++++++.',
  ], { stations: { A: source(1e6) }, flows: [], fleets: [{ count: 1 }], settings: { warmup: 0 } });
  const w = createRealWorld(layout);
  const vr = w.lg.vehicles[0];
  const middle = atCell(w, 4, 2); // as far from the dock at x=1 as from the one at x=7
  assert.equal(w.traffic.relocate(vr.tv, middle), true);
  const entry = w.lg.routes.get(middle, -1, 0);
  const choices = w.lg.routes.dockChoices(entry, 'A');
  assert.equal(choices.length, 2);
  assert.equal(choices[0].dist, choices[1].dist);
  const book = w.lg.docks;
  assert.equal(book.choose(vr, entry, 'A', null, 0).node, Math.min(choices[0].node, choices[1].node), 'the lower node id');
  const calls = [];
  const estimate = book.estimate;
  book.estimate = function (...args) { calls.push(args[2]); return estimate.apply(this, args); };
  book.choose(vr, entry, 'A', null, 0);
  assert.equal(calls.length, 2, 'two docks, two estimates');
  calls.length = 0;
  const single = layoutFromAscii(['AAA', '.+.', '.++'], { stations: { A: source(1e6) }, flows: [], fleets: [{ count: 1 }], settings: { warmup: 0 } });
  const s = createRealWorld(single);
  s.lg.docks.estimate = (...args) => { calls.push(args); return 0; };
  const sv = s.lg.vehicles[0];
  const se = s.lg.routes.get(sv.tv.node, arrivalEdgeOf(s.lg, sv), 0);
  assert.equal(s.lg.routes.dockChoices(se, 'A').length, 1);
  assert.ok(s.lg.docks.choose(sv, se, 'A', null, 0));
  assert.equal(calls.length, 0, 'one dock: nothing to compare');
});

test('docks lined up on one lane block each other: the nearest stays the choice, a queue behind an occupant is no better than waiting for it', () => {
  const layout = layoutFromAscii([
    '..AAAA....',
    '..AAAA....',
    '..++++++++',
  ], { stations: { A: source(1e6) }, flows: [], fleets: [agvFleet(2)], settings: { warmup: 0 } });
  const w = createRealWorld(layout);
  const [v1, v2] = w.lg.vehicles;
  assert.deepEqual(w.graph.docks.get('A').map((n) => w.graph.cx(n)), [2, 3, 4, 5]);
  w.traffic.relocate(v1.tv, atCell(w, 5, 2)); // v1 loads on the first dock from the east
  v1.state = 'loading';
  v1.timer = 60;
  v1.targetId = 'A';
  w.traffic.relocate(v2.tv, atCell(w, 9, 2));
  const book = w.lg.docks;
  book.tick(0.1, 0);
  const entry = w.lg.routes.get(atCell(w, 9, 2), -1, 0);
  const est = (x) => book.estimate(v2, w.lg.routes.routeTo(entry, atCell(w, x, 2)), atCell(w, x, 2), 0);
  assert.ok(est(5) >= 60, 'waiting for the occupant');
  assert.ok(est(4) >= est(5), 'the dock behind it is blocked by it');
  assert.ok(est(2) >= est(4), 'and the one behind that');
  assert.equal(book.choose(v2, entry, 'A', null, 0).node, atCell(w, 5, 2));
});

test('an off-lane dock that is free beats the lane dock behind an occupant; the old ranking takes the lane dock and queues', () => {
  // lane docks (2..5, 0) above A, spur docks (6,1) and (6,2) beside A, reached from the lane cell (6,0)
  const layout = layoutFromAscii([
    '++++++++++',
    '..AAAA+...',
    '..AAAA+...',
  ], { stations: { A: source(1e6) }, flows: [], fleets: [agvFleet(2)], settings: { warmup: 0 } });
  const w = createRealWorld(layout);
  const docks = w.graph.docks.get('A').map((n) => cellAt(w, n)).sort();
  assert.deepEqual(docks, ['2,0', '3,0', '4,0', '5,0', '6,1', '6,2'].sort());
  const [v1, v2] = w.lg.vehicles;
  w.traffic.relocate(v1.tv, atCell(w, 5, 0)); // loads on the first lane dock from the east for a minute
  v1.state = 'loading';
  v1.timer = 60;
  v1.targetId = 'A';
  w.traffic.relocate(v2.tv, atCell(w, 9, 0));
  const book = w.lg.docks;
  book.tick(0.1, 0);
  const entry = w.lg.routes.get(atCell(w, 9, 0), -1, 0);
  assert.equal(cellAt(w, book.choose(v2, entry, 'A', null, 0).node), '6,1', 'the free spur dock, not a queue behind (5,0)');
  book.enabled = false;
  assert.equal(cellAt(w, book.choose(v2, entry, 'A', null, 0).node), '5,0', 'the old ranking takes the nearest cell and queues for it');
});

test('a broken vehicle on a dock keeps it taken until repaired, a dead one for ever; a broken vehicle on the road blocks every route over it', () => {
  const w = createRealWorld(twoSpurs({ vehicles: 2, interArrival: 1e6 }));
  const [v1] = w.lg.vehicles;
  const g = w.graph;
  const dock1 = g.docks.get('A')[0];
  w.traffic.relocate(v1.tv, dock1);
  v1.state = 'broken';
  v1.resumeState = 'loading';
  v1.timer = 10;
  v1.repairLeft = 500;
  v1.tv.disabled = true;
  v1.targetId = 'A';
  const book = w.lg.docks;
  book.tick(0.1, 0);
  book.refreshOccupants();
  assert.equal(book.cells.get(dock1).occupant, v1, 'physically there: the occupant, whatever else is ignored');
  assert.ok(book.remaining(v1, 0, dock1) >= 510, 'the repair and the rest of its service');
  v1.state = 'dead';
  assert.equal(book.remaining(v1, 0, dock1), 7200, 'dead: never');
  // in the middle of an edge of the main road
  v1.state = 'broken';
  const edge = g.edges.find((e) => g.cy(e.from) === 3 && g.cx(e.from) === 5 && g.cx(e.to) === 6);
  w.traffic.relocate(v1.tv, edge.from);
  v1.tv.node = -1;
  v1.tv.edge = edge.id;
  book.tick(0.1, 0);
  book.sync();
  assert.equal(book.stuck.get(edge.id), v1);
  const v2 = w.lg.vehicles[1];
  const sink = g.docks.get('B')[0];
  const route = g.search(edge.from).routeTo(sink);
  assert.equal(route.edges[0], edge.id);
  assert.ok(book.estimate(v2, route, sink, 0) >= 500, 'a route over that edge waits for the repair');
  const other = g.search(atCell(w, 9, 3)).routeTo(sink);
  assert.ok(book.estimate(v2, other, sink, 0) < 20, 'and one that does not is not held up');
});

// ---------------------------------------------------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------------------------------------------------

test('no reservation leaks: every tick of 20 simulated minutes the invariant helper finds the book consistent with the vehicles', () => {
  const w = createRealWorld(twoSpurs({ vehicles: 3, loadTime: 20, interArrival: 15 }), { check: true });
  let reserved = 0;
  let longest = 0;
  for (let i = 0; i < 12000; i++) {
    w.step();
    assert.deepEqual(checkDockInvariants(w.lg), [], `t=${w.t.toFixed(1)}`);
    if (w.lg.vehicles.some((v) => v.dock !== null)) reserved++;
    longest = Math.max(longest, ...w.lg.docks.cellList.map((c) => c.queue.length));
  }
  assert.ok(reserved > 200, 'vehicles did reserve docks');
  assert.ok(longest >= 1);
  assert.ok(w.lg.completed > 20);
});

test('a reservation names the dock, the kind of stop, the service time of its fleet and an arrival time; a later vehicle waits for it, an earlier one does not', () => {
  const w = createRealWorld(twoSpurs({ vehicles: 2, loadTime: 40, interArrival: 1e6 }));
  const book = w.lg.docks;
  offerLoad(w);
  w.step();
  const planning = w.lg.vehicles.filter((v) => v.dock !== null);
  assert.equal(planning.length, 1, 'one order, one reservation');
  const res = planning[0].dock;
  assert.equal(res.kind, 'pickup');
  assert.equal(res.station, 'A');
  assert.ok(res.service >= 40 && res.service <= 40 + 12, `the loading time plus the turnaround of the cell: ${res.service.toFixed(1)}`);
  assert.ok(res.eta > 0 && res.eta < 60);
  assert.deepEqual(checkDockInvariants(w.lg), []);
  const cell = book.cells.get(res.node);
  const other = w.lg.vehicles.find((v) => v !== planning[0]);
  assert.ok(book.queueFree(cell, other, 1000, 0) >= res.service, 'a vehicle that comes later waits for it');
  assert.equal(book.queueFree(cell, other, 0, 0), 0, 'a vehicle that would be there first does not');
});

test('the reservation of a broken vehicle is ignored in the estimate (it will not come soon) but stays a consistent reservation', () => {
  const w = createRealWorld(twoSpurs({ vehicles: 2, loadTime: 40, interArrival: 1e6 }));
  const book = w.lg.docks;
  offerLoad(w);
  w.step();
  const vr = w.lg.vehicles.find((v) => v.dock !== null);
  const other = w.lg.vehicles.find((v) => v !== vr);
  const cell = book.cells.get(vr.dock.node);
  assert.ok(book.queueFree(cell, other, 1000, 0) >= 40);
  vr.resumeState = vr.state;
  vr.state = 'broken';
  vr.repairLeft = 300;
  vr.tv.disabled = true;
  assert.equal(book.queueFree(cell, other, 1000, 0), 0, 'nobody waits for it');
  assert.deepEqual(checkDockInvariants(w.lg), [], 'but the reservation is still there and consistent');
  vr.state = vr.resumeState;
  vr.resumeState = null;
  vr.tv.disabled = false;
});

test('a real breakdown on the way: the order is kept, the reservation stays and nobody queues for it; after the repair the vehicle arrives and loads', () => {
  const layout = twoSpurs({ vehicles: 2, loadTime: 30, interArrival: 20 });
  layout.fleets[0].mtbf = 150;
  layout.fleets[0].mttr = 40;
  const w = createRealWorld(layout, { check: true });
  let broke = 0;
  let loadedAfter = 0;
  for (let i = 0; i < 24000; i++) {
    w.step();
    assert.deepEqual(checkDockInvariants(w.lg), [], `t=${w.t.toFixed(1)}`);
    for (const v of w.lg.vehicles) {
      if (v.state === 'broken' && v.resumeState === 'toPickup' && v.dock !== null) broke++;
    }
  }
  loadedAfter = w.lg.completed;
  assert.ok(broke > 0, 'a vehicle broke down on its way to a dock while holding a reservation');
  assert.ok(loadedAfter > 30, 'and the plant went on delivering');
});

test('relocation by deadlock resolution re-plans: the reservation is replaced and nothing leaks', () => {
  const w = createRealWorld(twoSpurs({ vehicles: 2, loadTime: 30, interArrival: 20 }), { check: true });
  const book = w.lg.docks;
  assert.ok(w.runUntil((x) => x.lg.vehicles.some((v) => v.dock !== null && v.tv.driving && v.tv.v > 0.5), 120), 'a vehicle drives to a dock');
  const vr = w.lg.vehicles.find((v) => v.dock !== null);
  const old = vr.dock;
  const near = vr.tv.node >= 0 ? vr.tv.node : w.graph.edges[vr.tv.edge].to;
  const target = w.traffic.findFreeNode(near, vr.tv.length);
  assert.ok(target >= 0);
  assert.equal(w.traffic.relocate(vr.tv, target), true);
  w.lg.handleDeadlock({ victim: vr.tv, resolved: true });
  assert.equal(vr.replan, true);
  assert.deepEqual(checkDockInvariants(w.lg), [], 'between the relocation and the next plan the reservation is still consistent');
  w.step();
  assert.deepEqual(checkDockInvariants(w.lg), []);
  assert.ok(vr.dock !== null && vr.dock !== old, 'a new reservation from the new place');
  assert.equal(book.cells.get(old.node).queue.includes(old), false, 'the old one is gone');
  assert.equal(book.cellList.reduce((n, c) => n + c.queue.length, 0), w.lg.vehicles.filter((v) => v.dock !== null).length);
  assert.ok(w.runUntil((x) => vr.state === 'loading', 200), 'and the vehicle gets there');
  assert.equal(vr.dock, null);
});

test('a vehicle removed on its way releases its reservation and its order; the plant carries on and the load ledger still balances', () => {
  const w = createRealWorld(twoSpurs({ vehicles: 3, loadTime: 20, interArrival: 15 }), { check: true });
  assert.ok(w.runUntil((x) => x.lg.vehicles.some((v) => v.dock !== null && v.state === 'toPickup'), 200));
  const vr = w.lg.vehicles.find((v) => v.dock !== null && v.state === 'toPickup');
  const res = vr.dock;
  const before = w.events.length;
  assert.equal(w.lg.removeVehicle(vr), true);
  assert.equal(w.lg.removeVehicle(vr), false, 'not twice');
  assert.equal(vr.dock, null);
  assert.equal(w.lg.docks.cells.get(res.node).queue.includes(res), false);
  assert.equal(w.lg.vehicles.includes(vr), false);
  assert.equal(w.traffic.vehicles.includes(vr.tv), false);
  assert.deepEqual(checkDockInvariants(w.lg), []);
  const cancelled = w.events.slice(before).filter((e) => e.name === 'orderCancelled');
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].payload.reason, 'vehicle-removed');
  w.run(600);
  assert.ok(w.lg.completed > 5, 'the other two vehicles carry on');
  assert.deepEqual(checkDockInvariants(w.lg), []);
});

test('removing a vehicle that carries a load or stands in a depot: nothing is left behind', () => {
  const layout = twoSpurs({ vehicles: 2, loadTime: 20, interArrival: 15 });
  const w = createRealWorld(layout, { check: true });
  assert.ok(w.runUntil((x) => x.lg.vehicles.some((v) => v.state === 'toDrop'), 300));
  const carrying = w.lg.vehicles.find((v) => v.state === 'toDrop');
  assert.ok(carrying.load.length > 0);
  const live = w.lg.liveLoads;
  w.lg.removeVehicle(carrying);
  assert.equal(w.lg.liveLoads, live - 1, 'the load it carried is scrapped, not lost track of');
  w.run(300);
  assert.deepEqual(checkDockInvariants(w.lg), []);
});

test('a vehicle whose battery runs flat on the way releases its reservation', () => {
  const layout = twoSpurs({ vehicles: 2, loadTime: 20, interArrival: 15 });
  layout.fleets[0].battery = { enabled: true, runtimeMin: 3, chargeTimeMin: 30, lowPct: 0, resumePct: 100 };
  const w = createRealWorld(layout, { check: true });
  let died = false;
  for (let i = 0; i < 6000 && !died; i++) {
    w.step();
    assert.deepEqual(checkDockInvariants(w.lg), [], `t=${w.t.toFixed(1)}`);
    died = w.lg.vehicles.some((v) => v.state === 'dead');
  }
  assert.ok(died, 'a battery ran flat');
  assert.ok(w.lg.vehicles.filter((v) => v.state === 'dead').every((v) => v.dock === null));
});

// ---------------------------------------------------------------------------------------------------------------------
// Late rebinding
// ---------------------------------------------------------------------------------------------------------------------

/** A long road to a source with two spur docks (21,2) and (26,2); the sink is at the far west end. */
const APPROACH = [
  'BBB.................AAAAAAAAAAAAAA..',
  'BBB.................AAAAAAAAAAAAAA..',
  '.+...................+....+.........',
  '+++++++++++++++++++++++++++++++++++',
];
function approachWorld() {
  const layout = layoutFromAscii(APPROACH, {
    stations: { A: source(1e6), B: 'sink' }, flows: [['A', 'B']], fleets: [agvFleet(1, { loadTime: 20, unloadTime: 20 })], settings: { warmup: 0, seed: 1 },
  });
  const w = createRealWorld(layout);
  const vr = w.lg.vehicles[0];
  assert.equal(w.traffic.relocate(vr.tv, atCell(w, 10, 3)), true);
  w.checker = createInvariantChecker(w.traffic);
  const step = w.step.bind(w);
  w.step = () => { step(); w.checker.check(); };
  return { w, vr };
}

/** The reservation of another vehicle that works at `node` for `service` seconds, as the dock book sees it. */
function fakeReservation(world, node, service) {
  const fake = { id: 'fake', state: 'toPickup', tv: { disabled: false, node: -1 } };
  world.lg.docks.cells.get(node).queue.push({ vr: fake, node, station: 'A', kind: 'pickup', service, eta: 0, since: 0, nextCheck: Infinity, switches: 0 });
}

test('late rebinding: a vehicle on its way switches to the other dock when that has become clearly better, once, and arrives there', () => {
  const { w, vr } = approachWorld();
  const [near, far] = w.graph.docks.get('A');
  offerLoad(w);
  w.step();
  assert.equal(vr.dock.node, near, 'it starts for the nearer dock');
  fakeReservation(w, near, 300); // another vehicle will work there for five minutes
  const book = w.lg.docks;
  let switchedAt = -1;
  for (let i = 0; i < 400 && vr.state !== 'loading'; i++) {
    w.step();
    if (switchedAt < 0 && book.switches > 0) switchedAt = w.t;
  }
  assert.equal(book.switches, 1);
  assert.ok(switchedAt > 0 && switchedAt <= 4, `within a few seconds of the next look (${switchedAt.toFixed(1)} s)`);
  assert.equal(vr.state, 'loading');
  assert.equal(vr.tv.node, far, 'and it loads at the other dock');
  assert.equal(book.counters('A').find((d) => d.node === far).visits, 1);
});

test('late rebinding: no flapping - after one switch the vehicle stays with its dock however the estimates move', () => {
  const { w, vr } = approachWorld();
  const [near, far] = w.graph.docks.get('A');
  offerLoad(w);
  w.step();
  fakeReservation(w, near, 300);
  assert.ok(w.runUntil(() => w.lg.docks.switches === 1, 10));
  assert.equal(vr.dock.node, far);
  fakeReservation(w, far, 900); // now the other one looks worse, much worse
  const res = vr.dock;
  w.run(6);
  assert.equal(w.lg.docks.switches, 1, 'one switch per approach');
  assert.equal(vr.dock, res, 'the same reservation, still at the same dock');
  assert.equal(vr.dock.node, far);
});

test('late rebinding does not happen without a reason: the hysteresis keeps a vehicle on a dock that is only a little worse, and a vehicle too close to the fork', () => {
  const { w, vr } = approachWorld();
  const [near] = w.graph.docks.get('A');
  offerLoad(w);
  w.step();
  fakeReservation(w, near, 4); // a few seconds of queue: less than the extra drive plus the hysteresis
  w.run(8);
  assert.equal(w.lg.docks.switches, 0);
  assert.equal(vr.dock.node, near);
  // with the book switched off, or no reroute available, nothing happens either
  const again = approachWorld();
  again.w.lg.docks.rebinding = false;
  offerLoad(again.w);
  again.w.step();
  fakeReservation(again.w, again.w.graph.docks.get('A')[0], 300);
  again.w.run(8);
  assert.equal(again.w.lg.docks.switches, 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// TrafficSystem.reroute
// ---------------------------------------------------------------------------------------------------------------------

const FORK = [
  '......+...+',
  '+++++++++++',
];
/** The complete route a vehicle would drive if it kept its route up to node index `j` and then went to (x, y). */
function rerouteTo(world, tv, j, x, y) {
  const nodes = tv._nodes;
  const edges = tv._route;
  const tail = world.graph.search(nodes[j], { arrivalEdge: edges[j - 1] }).routeTo(world.node(x, y));
  return { nodes: nodes.slice(0, j).concat(tail.nodes), edges: edges.slice(0, j).concat(tail.edges), cost: 0 };
}

test('reroute: a driving vehicle takes another way from a cell far enough ahead and arrives where the new route ends', () => {
  const w = createTrafficWorld(FORK);
  const a = w.add({ id: 'a', x: 0, y: 1 });
  assert.ok(w.drive(a, 6, 0));
  w.run(2);
  assert.equal(w.traffic.reroute(a, rerouteTo(w, a, a._ri + 4, 10, 0)), true);
  w.runUntil(() => !a.driving, 60);
  assert.equal(a.node, w.node(10, 0), 'it ends at the new target');
  assert.equal(w.traffic.stats.deadlocks, 0);
});

test('reroute: refused when the vehicle does not drive, starts elsewhere, would turn round in mid-road or is too close to the fork; the same route is accepted', () => {
  const w = createTrafficWorld(FORK);
  const a = w.add({ id: 'a', x: 0, y: 1 });
  assert.equal(w.traffic.reroute(a, { nodes: [a.node, w.node(1, 1)], edges: [w.graph.edgeBetween(a.node, w.node(1, 1))] }), false, 'not driving');
  assert.ok(w.drive(a, 6, 0));
  w.run(1);
  const same = { nodes: a._nodes.slice(), edges: a._route.slice(), cost: 0 };
  assert.equal(w.traffic.reroute(a, same), true, 'the same route changes nothing');
  const away = { nodes: [w.node(1, 1), w.node(2, 1)], edges: [w.graph.edgeBetween(w.node(1, 1), w.node(2, 1))], cost: 0 };
  assert.equal(w.traffic.reroute(a, away), false, 'a route that starts elsewhere');
  const j = a._ri + 4;
  const turn = { nodes: a._nodes.slice(0, j + 1).concat([a._nodes[j - 1]]), edges: a._route.slice(0, j).concat([w.graph.edges[a._route[j - 1]].rev]), cost: 0 };
  assert.equal(w.traffic.reroute(a, turn), false, 'a U-turn in mid-road');
  const before = a._nodes.slice();
  assert.deepEqual(before, same.nodes, 'and nothing changed');

  const b = createTrafficWorld(FORK);
  const v = b.add({ id: 'v', x: 0, y: 1 });
  assert.ok(b.drive(v, 6, 0));
  b.runUntil(() => v._ri >= 5, 30);
  assert.equal(b.traffic.reroute(v, rerouteTo(b, v, 6, 10, 0)), false, 'the routes would part less than a cell ahead: no room to brake');
  assert.deepEqual(v._nodes.slice(-2), [b.node(6, 1), b.node(6, 0)], 'and the vehicle keeps its route');
  b.runUntil(() => !v.driving, 60);
  assert.equal(v.node, b.node(6, 0));
});

test('reroute: random reroutes of eight vehicles in a street grid for ten simulated minutes, the traffic invariants checked on every tick', () => {
  const lines = [
    '+++++++++++++',
    '+.+.+.+.+.+.+',
    '+++++++++++++',
    '+.+.+.+.+.+.+',
    '+++++++++++++',
    '+.+.+.+.+.+.+',
    '+++++++++++++',
  ];
  const w = createTrafficWorld(lines);
  const rng = createRng(11);
  const vehicles = [];
  for (let i = 0; i < 8; i++) {
    const x = (i * 3) % 13;
    const y = (i % 3) * 2;
    vehicles.push(w.add({ id: `v${i}`, x, y }));
  }
  let accepted = 0;
  let refused = 0;
  const target = new Map();
  const pickTarget = (tv) => {
    for (let k = 0; k < 20; k++) {
      const n = w.node(rng.int(13), rng.int(7));
      if (w.graph.isNode[n] && n !== tv.node && w.drive(tv, n % w.graph.cols, Math.floor(n / w.graph.cols))) { target.set(tv, n); return; }
    }
  };
  for (const tv of vehicles) pickTarget(tv);
  for (let step = 0; step < 6000; step++) {
    w.traffic.step(0.1);
    w.checker.check();
    for (const tv of vehicles) {
      if (!tv.driving && tv.node >= 0) pickTarget(tv);
      else if (tv.driving && step % 20 === tv.id.charCodeAt(1) % 20 && tv._turn < 0 && tv._route && tv._ri + 3 < tv._route.length) {
        const j = Math.min(tv._route.length - 1, tv._ri + 2 + rng.int(3));
        const n = w.node(rng.int(13), rng.int(7));
        if (!w.graph.isNode[n] || n === tv._nodes[j]) continue;
        const tail = w.graph.search(tv._nodes[j], { arrivalEdge: tv._route[j - 1] }).routeTo(n);
        if (tail === null) continue;
        const full = { nodes: tv._nodes.slice(0, j).concat(tail.nodes), edges: tv._route.slice(0, j).concat(tail.edges), cost: 0 };
        if (w.traffic.reroute(tv, full)) { accepted++; target.set(tv, n); } else refused++;
      }
    }
  }
  assert.ok(accepted >= 50, `${accepted} reroutes accepted, ${refused} refused`);
  w.run(60);
});

// ---------------------------------------------------------------------------------------------------------------------
// Why one dock is used far more than another
// ---------------------------------------------------------------------------------------------------------------------

const kpiDocks = (graph, ...visits) => visits.map((v, i) => ({ node: i, cx: graph.cx(i), cy: graph.cy(i), visits: v, busyShare: 0.5, waitBefore: 0 }));

test('dockSkew: one dock with most of the visits, another hardly used and vehicles waiting - and not otherwise', () => {
  const g = buildGraph(layoutFromAscii(['AAAAAA', '+++++.'], { stations: { A: source(1e6) }, flows: [], fleets: [{ count: 1 }] }));
  const docks = kpiDocks(g, 90, 5, 5);
  const skew = dockSkew(g, docks, 900);
  assert.ok(skew);
  assert.equal(skew.busy.node, 0);
  assert.deepEqual(skew.quiet.map((d) => d.node), [1, 2]);
  assert.equal(skew.waitPerVisit, 9);
  assert.equal(dockSkew(g, docks, 100), null, 'a dock that is used little costs nothing while nobody waits');
  assert.equal(dockSkew(g, kpiDocks(g, 55, 40, 5), 900), null, 'balanced enough');
  assert.equal(dockSkew(g, kpiDocks(g, 12, 1, 1), 900), null, 'too few visits to say');
  assert.equal(dockSkew(g, kpiDocks(g, 100), 900), null, 'a single dock');
});

test('explainDockSkew: a trap (cannot get back), a lane (the busy dock is in the way), a detour (just farther)', () => {
  // trap: the cell (4,2) is a one-way cell into the station
  const trap = buildGraph(layoutFromAscii(['AAAAAA..', 'AAAAAA..', '.+..^...', '.+++++++'], { stations: { A: source(1e6) }, flows: [], fleets: [{ count: 1 }] }));
  const [d1, d2] = trap.docks.get('A');
  assert.equal(explainDockSkew(trap, d1, [d2]), 'trap');
  // lane: docks lined up on one lane, the busy one in front of the others
  const lane = buildGraph(layoutFromAscii(['AAAA....', '++++++++'], { stations: { A: source(1e6) }, flows: [], fleets: [{ count: 1 }] }));
  const docks = lane.docks.get('A');
  assert.deepEqual(docks.map((n) => lane.cx(n)), [0, 1, 2, 3]);
  const east = docks[3];
  assert.equal(explainDockSkew(lane, east, [docks[0]]), 'lane');
  // detour: two spurs on a loop, both reachable without passing the other
  const loop = buildGraph(layoutFromAscii(['AAAAAAAAA', '.+.....+.', '.+++++++.'], { stations: { A: source(1e6) }, flows: [], fleets: [{ count: 1 }] }));
  const [a, b] = loop.docks.get('A');
  assert.equal(explainDockSkew(loop, a, [b]), 'detour');
});

// ---------------------------------------------------------------------------------------------------------------------
// The fix pass after the review: the way out, long vehicles, idle occupants, what looking does
// ---------------------------------------------------------------------------------------------------------------------

/** A spur plant (docks (1,2), (4,2) above the main road y = 3, cells of 2 m), one fleet of `count` vehicles of `fleet`; v1 loads on the near dock (4,2). */
function occupiedNear({ fleet = { preset: 'agv' }, count = 2, rows = TWO_SPURS, loadTime = 60 } = {}) {
  const layout = layoutFromAscii(rows, {
    stations: { A: source(1e6), B: 'sink' },
    flows: [['A', 'B']],
    fleets: [{ count, idle: 'stay', loadTime, unloadTime: 5, ...fleet }],
    settings: { warmup: 0, seed: 1 },
  });
  const w = createRealWorld(layout);
  const [v1, v2] = w.lg.vehicles;
  const near = atCell(w, 4, 2);
  assert.equal(w.traffic.relocate(v1.tv, near), true);
  Object.assign(v1, { state: 'loading', timer: loadTime, targetId: 'A' });
  const road = atCell(w, 9, rows.length - 1); // the east end of the main road
  assert.equal(w.traffic.relocate(v2.tv, road), true);
  w.lg.docks.tick(0.1, 0);
  return { w, v1, v2, near, far: atCell(w, 1, 2), entry: w.lg.routes.get(road, -1, 0), book: w.lg.docks };
}

test('the way out counts: a farther dock wins only when it saves more than the extra drive in AND out, and the nearest is left for a gain of more than minGain', () => {
  const { v2, near, far, entry, book } = occupiedNear({ loadTime: 14 }); // the near dock is taken for 14 + 8 s more
  book.blockWeight = 1; // (the wait on the junction counting double is the next test)
  const toNear = book.estimate(v2, book.lg.routes.routeOfDock(entry, book.lg.routes.dockChoices(entry, 'A').find((d) => d.node === near)), near, 0);
  const toFar = book.estimate(v2, book.lg.routes.routeOfDock(entry, book.lg.routes.dockChoices(entry, 'A').find((d) => d.node === far)), far, 0);
  assert.ok(toFar < toNear, `the far dock reaches service sooner (${toFar.toFixed(1)} against ${toNear.toFixed(1)} s) ...`);
  assert.ok(toNear - toFar < 2 * 6 / (1.5 * 0.75), '... but by less than the detour in and out (6 m each way)');
  assert.equal(book.choose(v2, entry, 'A', null, 0).node, near, 'so it waits for the near one');
  book.exitWeight = 0;
  book.minGain = 0;
  assert.equal(book.choose(v2, entry, 'A', null, 0).node, far, 'without the way out and the minimum gain it would take the far one (the old behaviour)');
});

test('a wait on a junction costs double: a dock one cell off the main road is left sooner than the same wait on a spur of two cells', () => {
  const oneCell = occupiedNear({ loadTime: 14 });
  const twoCells = occupiedNear({ loadTime: 14, rows: ['AAAAAA..BBB', 'AAAAAA..BBB', '.+..+....+.', '.+..+....+.', '.+++++++++.'] });
  const weight = (x) => x.book.waitWeightOf(x.w.lg.routes.routeOfDock(x.entry, x.w.lg.routes.dockChoices(x.entry, 'A').find((d) => d.node === x.near)));
  const pick = (x) => x.book.choose(x.v2, x.entry, 'A', null, 0).node;
  assert.equal(weight(oneCell), 2, 'a one-cell spur: the vehicle that waits stands on the junction of the main road');
  assert.equal(weight(twoCells), 1, 'two cells: it waits out of the way');
  assert.equal(pick(oneCell), oneCell.far, 'the free dock is worth the detour');
  assert.equal(pick(twoCells), twoCells.near, 'the same wait is waited out on the deeper spur');
});

test('a vehicle longer than a cell keeps to the old rule on docks one cell off the road (no choice, no switching); an AGV, a deeper spur or the switch off give the choice', () => {
  const tugger = occupiedNear({ fleet: { preset: 'tugger' } });
  assert.ok(tugger.v2.tv.length > tugger.w.graph.cellSize, 'a tugger is longer than a 2 m cell');
  const choices = tugger.w.lg.routes.dockChoices(tugger.entry, 'A');
  assert.equal(choices.length, 2);
  assert.equal(tugger.book.overhangs(tugger.v2, tugger.entry, choices), true);
  assert.equal(tugger.book.choose(tugger.v2, tugger.entry, 'A', null, 0).node, tugger.near, 'it drives to the nearest dock although it is taken');
  tugger.book.overhangRule = false;
  assert.equal(tugger.book.choose(tugger.v2, tugger.entry, 'A', null, 0).node, tugger.far, 'with the rule off it takes the free one');
  const agv = occupiedNear();
  assert.equal(agv.book.overhangs(agv.v2, agv.entry, agv.w.lg.routes.dockChoices(agv.entry, 'A')), false);
  assert.equal(agv.book.choose(agv.v2, agv.entry, 'A', null, 0).node, agv.far);
  const deep = occupiedNear({ fleet: { preset: 'tugger' }, rows: ['AAAAAA..BBB', 'AAAAAA..BBB', '.+..+....+.', '.+..+....+.', '.+++++++++.'] });
  assert.equal(deep.book.overhangs(deep.v2, deep.entry, deep.w.lg.routes.dockChoices(deep.entry, 'A')), false, 'a spur of two cells: the vehicle stays clear of the junction');
  // a tugger that drives with a reservation has nothing to switch to
  const w = createRealWorld(layoutFromAscii(TWO_SPURS, {
    stations: { A: source(1e6), B: 'sink' }, flows: [['A', 'B']], fleets: [{ count: 1, preset: 'tugger', idle: 'stay' }], settings: { warmup: 0, seed: 1 },
  }));
  const vr = w.lg.vehicles[0];
  vr.state = 'toPickup';
  vr.targetId = 'A';
  vr.order = { flow: { to: { id: 'B' } } };
  const entry = w.lg.routes.get(vr.tv.node, -1, 0);
  const res = w.lg.docks.reserve(vr, w.graph.docks.get('A')[0], 'A', 0, 10, entry);
  assert.equal(res.choices, null, 'no rebinding for a vehicle that overhangs');
  w.lg.docks.release(vr);
});

test('a standing long vehicle holds the junction cell it overhangs: the estimate for a route over that cell waits for it', () => {
  const x = occupiedNear({ fleet: { preset: 'tugger' } });
  const { w, book, near, v1, v2 } = x;
  book.sync();
  const junction = atCell(w, 4, 3);
  assert.ok(w.traffic._lock[junction] === v1.tv || v1.tv._held.includes(junction), 'the tugger on the dock holds the junction in front of it');
  assert.equal(book.held.get(junction), v1);
  assert.ok((book.mark[junction] & 4) !== 0);
  const toFar = w.lg.routes.routeTo(x.entry, x.far); // passes (4,3)
  assert.ok(toFar.nodes.includes(junction));
  const wait = book.remaining(v1, 0, near);
  assert.ok(book.estimate(v2, toFar, x.far, 0) >= wait, `the way past (4,3) is blocked for ${wait.toFixed(1)} s`);
  assert.ok(wait > 60, 'the loading time and the turnaround');
});

test('an idle vehicle that stays on a dock frees it when the first follower has waited YIELD_AFTER s and the vehicle has pulled out; a follower that comes later waits longer', () => {
  const { w, v1, v2, near, book } = occupiedNear();
  Object.assign(v1, { state: 'idle', timer: 0, targetId: null });
  w.lg.docks.tick(0.1, 0);
  const turn = book.turnaround(v1, near);
  assert.equal(turn, 8, 'a dead end');
  assert.equal(book.remaining(v1, 0, near, 0), 2 + turn);
  assert.equal(book.remaining(v1, 0, near, 10), 10 + 2 + turn);
  const toNear = w.lg.routes.routeTo(w.lg.routes.get(v2.tv.node, -1, 0), near);
  const travel = toNear.edges.length * 2 / (1.5 * 0.75);
  assert.ok(Math.abs(book.estimate(v2, toNear, near, 0) - (travel + 2 + turn)) < 1e-6, 'the estimate: the drive, then the yield time and the pull-out');
  // a broken vehicle that will be idle after its repair: the repair first, then the same
  Object.assign(v1, { state: 'broken', resumeState: 'idle', repairLeft: 30 });
  assert.equal(book.remaining(v1, 0, near, 0), 30 + 2 + turn);
});

test('looking changes nothing: the dock status, the occupants and the markers drawn every tick leave the vehicles (leaving) and the statistics as they are', () => {
  const run = (look) => {
    const w = createRealWorld(twoSpurs({ vehicles: 3, loadTime: 8, interArrival: 5 }));
    const book = w.lg.docks;
    const nodes = [...book.cells.keys()];
    for (let i = 0; i < 3000; i++) {
      w.step();
      if (look) {
        book.refreshOccupants(true);
        for (const n of nodes) book.status(n);
      }
    }
    return JSON.stringify({ c: ['A', 'B'].map((s) => book.counters(s)), v: w.lg.vehicles.map((v) => [v.state, v.leaving, v.tv.x, v.tv.y]) });
  };
  assert.equal(run(true), run(false));
});

test('serves(): loading, unloading, arrived-and-starting and pulling out count as service; idle, broken, dead and passing vehicles only take the cell', () => {
  const { w, v1, near } = occupiedNear();
  const g = w.graph;
  assert.equal(serves(g, v1), true, 'loading');
  v1.state = 'unloading';
  assert.equal(serves(g, v1), true);
  v1.state = 'toDrop';
  v1.targetId = 'B';
  assert.equal(serves(g, v1), false, 'on its way somewhere with a target that is not this station');
  v1.state = 'toPickup';
  v1.targetId = 'A';
  assert.equal(serves(g, v1), true, 'arrived at a dock of its target');
  for (const state of ['idle', 'broken', 'dead']) { v1.state = state; assert.equal(serves(g, v1), false, state); }
  assert.ok(near >= 0);
});
