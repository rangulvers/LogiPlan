// TrafficSystem: controlled cells (junction locks, FIFO, no box-blocking, fairness), parked vehicles in junctions and
// on bends, deadlock detection and resolution, long vehicles and busy mixed scenarios.
// Every scenario runs with the invariant checker of tests/helpers/traffic-invariants.js after each tick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld } from './helpers/traffic-invariants.js';

/** Two one-way feeders merging into a one-way stem: the merge cell is (mx, 0). */
const mergeLines = (arm, stem) => [
  '>'.repeat(arm) + 'v' + '<'.repeat(arm),
  ...Array.from({ length: stem }, () => '.'.repeat(arm) + 'v' + '.'.repeat(arm)),
];

/**
 * Let each vehicle drive its own endless list of destinations: `plans` maps a vehicle to [[x, y], ...]; the first
 * entry is where it starts. Returns a function giving the number of completed trips of a vehicle.
 */
function shuttle(w, plans) {
  const next = new Map([...plans.keys()].map((tv) => [tv, 0]));
  const trips = new Map([...plans.keys()].map((tv) => [tv, 0]));
  const go = (tv) => {
    const list = plans.get(tv);
    const i = (next.get(tv) + 1) % list.length;
    next.set(tv, i);
    assert.ok(w.drive(tv, ...list[i]), `${tv.id} has a route to ${list[i]}`);
  };
  w.traffic.onArrive = (tv) => { trips.set(tv, trips.get(tv) + 1); go(tv); };
  for (const tv of plans.keys()) go(tv);
  return (tv) => trips.get(tv);
}

/** Is the vehicle's centre inside the cell (cx, cy)? */
const inCell = (w, tv, cx, cy) => Math.abs(tv.x - w.graph.x(w.node(cx, cy))) < w.graph.cellSize / 2 && Math.abs(tv.y - w.graph.y(w.node(cx, cy))) < w.graph.cellSize / 2;

// ---- controlled cells: lock, FIFO, no box-blocking (requirement 4) -------------------------------------------------

test('a merge is controlled: the vehicle that reaches the stop line first goes first, the other waits at the line', () => {
  const w = createWorld(mergeLines(4, 6));
  const g = w.graph;
  assert.equal(g.controlled[w.node(4, 0)], 1);
  const a = w.add({ id: 'A', x: 0, y: 0 }); // 4 cells from the merge
  const b = w.add({ id: 'B', x: 6, y: 0 }); //  2 cells from the merge
  w.drive(a, 4, 5);
  w.drive(b, 4, 6);
  const entered = {};
  const left = {};
  const reasons = new Set();
  let waitEdge = -1;
  w.run(60, 0.1, (t) => {
    if (a.waiting) waitEdge = a.edge;
    for (const v of [a, b]) {
      const inside = inCell(w, v, 4, 0);
      if (inside && entered[v.id] === undefined) entered[v.id] = t.time;
      if (!inside && entered[v.id] !== undefined && left[v.id] === undefined) left[v.id] = t.time;
      if (v.waiting) reasons.add(`${v.id}:${v.waitReason}`);
    }
  });
  assert.ok(entered.B < entered.A, 'B was nearer to the merge and goes first');
  assert.ok(entered.A > left.B, 'A enters only after B has left the cell');
  assert.deepEqual([...reasons], ['A:junction'], 'only A ever waited, and for the junction');
  assert.equal(a.node, w.node(4, 5));
  assert.equal(b.node, w.node(4, 6));
  const st = w.traffic.stats;
  assert.ok(st.waitJunction > 0 && st.waitVehicle === 0 && st.waitBroken === 0);
  assert.equal(st.nodeWait[w.node(4, 0)], st.waitJunction, 'junction waits are attributed to the cell in front of which the vehicle waits');
  assert.equal(waitEdge, g.edgeBetween(w.node(2, 0), w.node(3, 0)), 'A waits on the edge before the last one, a headway short of the cell');
  assert.equal(st.edgeWait[waitEdge], st.waitJunction, 'and the wait is attributed to the edge it stands on');
});

test('a waiting vehicle names the lock holder as its blocker', () => {
  const w = createWorld(mergeLines(4, 6));
  const holder = w.add({ id: 'H', x: 4, y: 0 }); // parked in the controlled cell
  const a = w.add({ id: 'A', x: 1, y: 0 });
  w.drive(a, 4, 5);
  w.run(25);
  assert.equal(a.waiting, true);
  assert.equal(a.waitReason, 'junction');
  assert.equal(a.blockedBy, holder);
  assert.ok(!inCell(w, a, 4, 0), 'it waits in front of the cell');
  w.drive(holder, 4, 6);
  w.runUntil(() => !a.driving && !holder.driving);
  assert.equal(a.node, w.node(4, 5));
});

test('grants are first come, first served: six vehicles from both sides enter the cell in the order they reach the line', () => {
  const w = createWorld(mergeLines(9, 10));
  // west vehicles at distances 8, 6, 3 cells from the merge, east vehicles at 7, 5, 2 cells: arrival order by distance
  const spec = [['W0', 1], ['E0', 16], ['W1', 3], ['E1', 14], ['W2', 6], ['E2', 11]];
  const vs = spec.map(([id, x]) => w.add({ id, x, y: 0, speed: 1.5 }));
  const dist = Object.fromEntries(spec.map(([id, x]) => [id, Math.abs(9 - x)]));
  vs.forEach((v, i) => w.drive(v, 9, 3 + i));
  const order = [];
  w.run(120, 0.1, () => { for (const v of vs) if (inCell(w, v, 9, 0) && !order.includes(v.id)) order.push(v.id); });
  assert.deepEqual(order, spec.map(([id]) => id).sort((p, q) => dist[p] - dist[q]));
  vs.forEach((v) => assert.ok(!v.driving, `${v.id} arrived`));
});

test('a four-way crossing lets one vehicle through at a time, in request order (ties: vehicle order)', () => {
  const w = createWorld(['..+..', '..+..', '+++++', '..+..', '..+..']);
  const specs = [['N', 2, 0, 2, 4], ['E', 4, 2, 0, 2], ['S', 2, 4, 2, 0], ['W', 0, 2, 4, 2]];
  const vs = specs.map(([id, x, y]) => w.add({ id, x, y }));
  specs.forEach(([, , , gx, gy], i) => w.drive(vs[i], gx, gy));
  const order = [];
  const intervals = {};
  w.run(80, 0.1, (t) => {
    for (const v of vs) {
      const inside = inCell(w, v, 2, 2);
      if (inside && !order.includes(v.id)) order.push(v.id);
      if (inside) { intervals[v.id] = intervals[v.id] ?? [t.time, t.time]; intervals[v.id][1] = t.time; }
    }
  });
  assert.deepEqual(order, ['N', 'E', 'S', 'W'], 'equal distances: the order in which the vehicles were created');
  const spans = order.map((id) => intervals[id]);
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i][0] > spans[i - 1][1], 'the cell is never shared');
  vs.forEach((v, i) => assert.equal(v.node, w.node(specs[i][3], specs[i][4])));
});

test('a T junction serves all six movements (straight, left, right) over five minutes without conflicts or deadlock', () => {
  const w = createWorld(['+++++++++', '....+....', '....+....', '....+....']);
  const W = [0, 0];
  const E = [8, 0];
  const S = [4, 3];
  const route = (id, start, ...rest) => [w.add({ id, x: start[0], y: start[1] }), [start, ...rest]];
  const plans = new Map([
    route('a', W, E, W), // W -> E straight, E -> W straight
    route('b', E, W, E),
    route('c', S, W, S, E), // S -> W, W -> S, S -> E, E -> S
    route('d', [2, 0], S, E, S, W),
    route('e', [6, 0], S, W, E),
  ]);
  const trips = shuttle(w, plans);
  w.run(300, 0.1);
  for (const tv of plans.keys()) assert.ok(trips(tv) >= 4, `${tv.id} completed ${trips(tv)} trips`);
  assert.equal(w.traffic.stats.deadlocks, 0);
  assert.ok(w.traffic.stats.waitJunction > 0, 'the junction did serialise the traffic');
});

test('at a two-way T junction vehicles from the two arms are served in the order they reach the line', () => {
  const w = createWorld(['+++++++++', '....+....', '....+....', '....+....', '....+....']);
  // west arm vehicle 4 cells from the junction, east arm vehicle 3 cells, a stem vehicle 2 cells (equal speed)
  const west = w.add({ id: 'W', x: 0, y: 0 });
  const east = w.add({ id: 'E', x: 7, y: 0 });
  const stem = w.add({ id: 'S', x: 4, y: 2 });
  w.drive(west, 4, 3);
  w.drive(east, 4, 4);
  w.drive(stem, 8, 0);
  const order = [];
  w.run(60, 0.1, () => { for (const v of [west, east, stem]) if (inCell(w, v, 4, 0) && !order.includes(v.id)) order.push(v.id); });
  assert.deepEqual(order, ['S', 'E', 'W']);
  assert.equal(west.node, w.node(4, 3));
  assert.equal(east.node, w.node(4, 4));
  assert.equal(stem.node, w.node(8, 0));
});

test('no box-blocking: a vehicle does not enter the junction while there is no room for it beyond the exit', () => {
  const w = createWorld(mergeLines(4, 6));
  const blocker = w.add({ id: 'X', x: 4, y: 1 }); // parked right behind the merge cell
  const a = w.add({ id: 'A', x: 0, y: 0 });
  w.drive(a, 4, 4);
  let entered = false;
  w.run(40, 0.1, () => { if (inCell(w, a, 4, 0) || a.x > w.graph.x(w.node(4, 0)) - 1) entered = true; });
  assert.equal(entered, false, 'A never crossed the boundary of the merge cell');
  assert.equal(a.waiting, true);
  assert.equal(a.waitReason, 'junction');
  assert.equal(a.blockedBy, blocker, 'the vehicle without exit room is blamed on the one in its way');
  const wait = w.traffic.stats.nodeWait[w.node(4, 0)];
  assert.ok(wait > 20, `waited in front of the cell for ${wait} s`);
  w.drive(blocker, 4, 5);
  w.runUntil(() => !a.driving && !blocker.driving);
  assert.equal(blocker.node, w.node(4, 5));
  assert.equal(a.node, w.node(4, 4), 'once the way is free A follows');
});

test('the lock is released when the rear has cleared the cell, and then granted to the vehicle that waits', () => {
  const w = createWorld(mergeLines(4, 8));
  const g = w.graph;
  const merge = w.node(4, 0);
  const a = w.add({ id: 'A', x: 4, y: 0 }); // parked in the merge cell: holds the lock
  const b = w.add({ id: 'B', x: 0, y: 0 });
  w.drive(b, 4, 6);
  w.run(25);
  assert.equal(b.waiting, true);
  assert.equal(b.blockedBy, a);
  assert.equal(w.traffic._lock[merge], a);
  w.drive(a, 4, 7);
  const exitY = g.y(merge) + g.cellSize / 2;
  let release = null;
  let grant = null;
  let roomReached = null;
  w.run(40, 0.1, (t) => {
    const rear = a.y - a.length / 2; // A drives south
    if (roomReached === null && rear >= exitY + 1.2 + 0.5) roomReached = t.time;
    if (release === null && t._lock[merge] !== a) release = { time: t.time, rear };
    if (release === null) assert.ok(rear < exitY + 1e-9, 'held while the rear is inside the cell');
    if (grant === null && t._lock[merge] === b) grant = t.time;
  });
  assert.ok(release.rear >= exitY - 1e-9 && release.rear <= exitY + 0.2, `released with the rear at ${release.rear}, exit at ${exitY}`);
  // B may enter only when it can come to rest beyond the cell: A's rear must be a vehicle length + headway past the exit
  assert.ok(grant >= release.time && grant >= roomReached, 'granted only after the release and once the room is free');
  assert.ok(grant - roomReached <= 1.5, `B was granted ${grant - roomReached} s after the room became free`); // corner clearance adds a little
  assert.equal(b.node, w.node(4, 6));
  assert.equal(a.node, w.node(4, 7));
});

test('a vehicle parked on a controlled dock cell holds it (that is the point)', () => {
  const w = createWorld(['+++++', '..+..', '..+..']);
  const dock = w.add({ id: 'dock', x: 2, y: 0 }); // the T junction itself
  const a = w.add({ id: 'A', x: 0, y: 0 });
  w.drive(a, 2, 2);
  w.run(40);
  assert.equal(a.waiting, true);
  assert.equal(a.blockedBy, dock);
  assert.ok(a.x < w.graph.x(w.node(2, 0)) - 1, 'A waits in front of the cell');
  assert.equal(w.traffic._lock[w.node(2, 0)], dock);
  w.drive(dock, 4, 0);
  w.runUntil(() => !a.driving && !dock.driving);
  assert.equal(a.node, w.node(2, 2));
});

test('merge fairness: neither side starves over five minutes of continuous traffic', () => {
  const w = createWorld(mergeLines(8, 6));
  const fleet = [];
  for (let i = 0; i < 3; i++) {
    fleet.push({ tv: w.add({ id: `W${i}`, x: 1 + i * 3, y: 0 }), side: 'W', start: w.node(1 + i * 3, 0) });
    fleet.push({ tv: w.add({ id: `E${i}`, x: 15 - i * 3, y: 0 }), side: 'E', start: w.node(15 - i * 3, 0) });
  }
  const passes = { W: 0, E: 0 };
  let longestWait = 0;
  const restart = (rec) => {
    if (!w.traffic.relocate(rec.tv, rec.start)) { rec.pending = true; return; }
    rec.pending = false;
    w.drive(rec.tv, 8, 6);
  };
  w.traffic.onArrive = (tv) => { const rec = fleet.find((r) => r.tv === tv); passes[rec.side]++; restart(rec); };
  fleet.forEach((rec) => w.drive(rec.tv, 8, 6));
  w.run(300, 0.1, () => {
    for (const rec of fleet) {
      if (rec.pending) restart(rec);
      longestWait = Math.max(longestWait, rec.tv.waitTime);
    }
  });
  assert.ok(passes.W >= 10 && passes.E >= 10, `passes ${JSON.stringify(passes)}`);
  assert.ok(Math.max(passes.W, passes.E) <= 1.5 * Math.min(passes.W, passes.E), `unfair: ${JSON.stringify(passes)}`);
  assert.ok(longestWait < 40, `longest uninterrupted wait ${longestWait} s`);
});

test('adjacent controlled cells: opposing traffic over two nearby junctions never ends in a lock deadlock', () => {
  const w = createWorld(['+++++++', '..+.+..', '..+.+..']);
  const fleet = [
    [w.add({ id: 'p', x: 0, y: 0 }), [[6, 0], [0, 0]]],
    [w.add({ id: 'q', x: 6, y: 0 }), [[0, 0], [6, 0]]],
    [w.add({ id: 'r', x: 2, y: 2 }), [[4, 2], [2, 2]]],
    [w.add({ id: 's', x: 4, y: 2 }), [[2, 2], [4, 2]]],
  ];
  const legs = new Map(fleet.map(([tv]) => [tv, 0]));
  let arrivals = 0;
  w.traffic.onArrive = (tv) => {
    arrivals++;
    const [, goals] = fleet.find(([v]) => v === tv);
    const next = legs.get(tv) + 1;
    legs.set(tv, next);
    assert.ok(w.drive(tv, ...goals[next % 2]));
  };
  fleet.forEach(([tv, goals]) => w.drive(tv, ...goals[0]));
  w.run(300, 0.1);
  assert.equal(w.traffic.stats.deadlocks, 0);
  assert.ok(arrivals >= 12, `${arrivals} trips completed`);
});

test('a vehicle that breaks down inside a junction keeps the cell locked: the others wait for the breakdown', () => {
  const w = createWorld(mergeLines(4, 8));
  const a = w.add({ id: 'A', x: 4, y: 0 });
  const b = w.add({ id: 'B', x: 0, y: 0 });
  w.drive(a, 4, 7);
  w.run(1);
  assert.ok(inCell(w, a, 4, 0) && a.v > 0);
  a.disabled = true; // stops with the lock in its hands
  w.drive(b, 4, 4);
  w.run(60);
  assert.ok(a.v === 0 && inCell(w, a, 4, 0), 'A came to rest inside the cell');
  assert.equal(w.traffic._lock[w.node(4, 0)], a);
  assert.equal(b.waiting, true);
  assert.equal(b.waitReason, 'broken');
  assert.equal(b.blockedBy, a);
  assert.ok(w.traffic.stats.waitBroken > 30);
  a.disabled = false;
  w.runUntil(() => !a.driving && !b.driving);
  assert.equal(b.node, w.node(4, 4));
});

// ---- bends: a parked vehicle in a corner cell blocks the cell ------------------------------------------------------

test('a vehicle parked in a corner cell makes vehicles that turn there wait in front of it', () => {
  const w = createWorld(['+++', '+..', '+..']);
  const g = w.graph;
  const corner = w.node(0, 0);
  assert.equal(g.controlled[corner], 0, 'a plain two-way corner is not a controlled cell');
  const x = w.add({ id: 'X', x: 0, y: 2 });
  const y = w.add({ id: 'Y', x: 2, y: 0 });
  w.drive(x, 0, 0); // docks in the corner
  w.runUntil(() => !x.driving);
  assert.equal(x.node, corner);
  w.drive(y, 0, 2); // turns through the corner cell, needs the cell X is parked in
  w.run(40);
  assert.equal(y.waiting, true);
  assert.equal(y.blockedBy, x);
  assert.ok(y.x > g.x(w.node(1, 0)) - 0.5, 'it waits before the corner');
  w.drive(x, 2, 0);
  w.runUntil(() => !x.driving && !y.driving);
  assert.equal(x.node, w.node(2, 0));
  assert.equal(y.node, w.node(0, 2));
});

test('a vehicle docked on a straight two-way road does not block the opposite lane', () => {
  const w = createWorld(['+++++++++']);
  const docked = w.add({ id: 'D', x: 4, y: 0 });
  const west = w.add({ id: 'W', x: 8, y: 0 });
  const east = w.add({ id: 'E', x: 0, y: 0 });
  w.drive(docked, 5, 0);
  w.runUntil(() => !docked.driving);
  w.drive(west, 0, 0); // opposite lane: passes the docked vehicle
  w.drive(east, 8, 0); // same lane: queues behind it
  w.run(40);
  assert.equal(west.node, w.node(0, 0));
  assert.equal(west.waiting, false);
  assert.equal(east.waiting, true);
  assert.equal(east.blockedBy, docked);
});

// ---- deadlocks (requirement 6) -----------------------------------------------------------------------------------

/** A one-way ring of 24 cells with a two-way spur below it (free cells for relocated vehicles). */
const RING = ['>>>>>>>v', '^......v', '^......v', '^......v', '^......v', '^<<+<<<<', '...+....', '...+....'];

/** Fill the ring with 24 vehicles that touch their neighbours (gap = headway) and send each to the next cell. */
function packedRing(opts) {
  const w = createWorld(RING, opts);
  const g = w.graph;
  const ring = [];
  for (let n = w.node(0, 0); ring.length === 0 || n !== ring[0]; n = g.edges[g.out[n].find((e) => g.cy(g.edges[e].to) <= 5)].to) ring.push(n);
  const vs = ring.map((n, i) => w.add({ id: `r${i}`, x: g.cx(n), y: g.cy(n), length: 1.5 }));
  vs.forEach((v, i) => w.traffic.drive(v, g.search(v.node, { arrivalEdge: v.lastEdge }).routeTo(ring[(i + 1) % ring.length])));
  return { w, vs, ring };
}

test('a packed ring is a deadlock: detected after deadlockTime, the victim is relocated and the jam dissolves', () => {
  const { w, vs } = packedRing({ traffic: { deadlockTime: 10 } });
  const events = [];
  w.traffic.onDeadlock = (ev) => events.push({ t: w.traffic.time, ...ev });
  w.run(9);
  assert.equal(events.length, 0, 'not before deadlockTime');
  assert.equal(w.traffic.stats.deadlocks, 0);
  w.run(4);
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.resolved, true);
  assert.equal(ev.vehicles.length, 24);
  assert.ok(ev.nodes.length >= 20 && ev.nodes.every((n) => w.graph.isNode[n]));
  assert.ok(vs.includes(ev.victim));
  assert.ok(ev.victim.node >= 0 && w.graph.cy(ev.victim.node) > 5, 'the victim was moved to the spur');
  assert.equal(ev.victim.driving, false);
  assert.equal(w.traffic.stats.deadlocks, 1);
  assert.deepEqual(w.traffic.activeDeadlocks, []);
  w.run(60);
  assert.equal(events.length, 1, 'no second deadlock: the jam is gone');
  for (const v of vs) if (v !== ev.victim) assert.equal(v.driving, false, `${v.id} reached its cell`);
  assert.equal(vs.filter((v) => v.odometer > 1.9).length, 23);
});

test('with resolveDeadlocks=false the jam is reported once, listed as active and stands', () => {
  const { w, vs } = packedRing({ traffic: { deadlockTime: 10, resolveDeadlocks: false } });
  const events = [];
  w.traffic.onDeadlock = (ev) => events.push(ev);
  w.run(15);
  assert.equal(events.length, 1);
  assert.equal(events[0].resolved, false);
  assert.equal(events[0].victim, null);
  assert.equal(w.traffic.stats.deadlocks, 1);
  const [active] = w.traffic.activeDeadlocks;
  assert.equal(w.traffic.activeDeadlocks.length, 1);
  assert.equal(active.vehicleIds.length, 24);
  assert.deepEqual([...active.vehicleIds].sort(), vs.map((v) => v.id).sort());
  assert.ok(active.t >= 10 && active.t <= 12);
  const before = vs.map((v) => v.x + ',' + v.y);
  w.run(60);
  assert.deepEqual(vs.map((v) => v.x + ',' + v.y), before, 'nothing moved');
  assert.equal(w.traffic.stats.deadlocks, 1, 'still counted once');
  assert.equal(events.length, 1);
  assert.equal(w.traffic.activeDeadlocks.length, 1);
});

test('if no node has room the victim cannot be relocated: reported as unresolved, then resolved once room appears', () => {
  const w = createWorld(['>>>>>>>v', '^......v', '^......v', '^......v', '^......v', '^<<<<<<<'], { traffic: { deadlockTime: 10 } });
  const g = w.graph;
  const ring = [];
  for (let n = w.node(0, 0); ring.length === 0 || n !== ring[0]; n = g.edges[g.out[n][0]].to) ring.push(n);
  const vs = ring.map((n, i) => w.add({ id: `r${i}`, x: g.cx(n), y: g.cy(n), length: 1.5 }));
  vs.forEach((v, i) => w.traffic.drive(v, g.search(v.node, { arrivalEdge: v.lastEdge }).routeTo(ring[(i + 1) % ring.length])));
  const events = [];
  w.traffic.onDeadlock = (ev) => events.push({ resolved: ev.resolved, victim: ev.victim });
  w.run(20);
  assert.equal(events.length, 1);
  assert.equal(events[0].resolved, false, 'the ring is full: there is no free node');
  assert.equal(events[0].victim, null);
  assert.equal(w.traffic.activeDeadlocks.length, 1);
  assert.equal(w.traffic.stats.deadlocks, 1);
  w.traffic.removeVehicle(vs[5]); // somebody makes room
  w.run(30);
  assert.equal(w.traffic.stats.deadlocks, 1, 'the jam dissolved by itself, nothing new is reported');
  assert.deepEqual(w.traffic.activeDeadlocks, []);
});

test('an unresolved deadlock disappears from activeDeadlocks when the jam is dissolved from outside', () => {
  const { w, vs } = packedRing({ traffic: { deadlockTime: 5, resolveDeadlocks: false } });
  w.run(8);
  assert.equal(w.traffic.activeDeadlocks.length, 1);
  w.traffic.relocate(vs[0], w.node(3, 7));
  w.run(5);
  assert.deepEqual(w.traffic.activeDeadlocks, []);
});

test('queues are not deadlocks: a long wait behind a broken vehicle is never reported', () => {
  const w = createWorld(['>'.repeat(20)], { traffic: { deadlockTime: 5 } });
  const lead = w.add({ id: 'lead', x: 5, y: 0 });
  const f = w.add({ id: 'f', x: 0, y: 0 });
  lead.disabled = true;
  w.drive(lead, 19, 0);
  w.drive(f, 19, 0);
  w.run(120);
  assert.equal(f.waiting, true);
  assert.ok(f.waitTime > 60);
  assert.equal(w.traffic.stats.deadlocks, 0);
});

// ---- long vehicles, busy networks, robustness ------------------------------------------------------------------------

/** Street grid: two-way streets on every third row / column. */
function streetGrid(size, spacing) {
  return Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) => (x % spacing === 0 || y % spacing === 0 ? '+' : '.')).join(''));
}

/** Put `count` vehicles on random non-junction cells of `w` and keep them driving to random cells. */
function busyTraffic(w, count, params, seed = 3) {
  let state = seed;
  const rand = (n) => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state % n; };
  const g = w.graph;
  const cells = g.nodes.filter((n) => !g.controlled[n]);
  const vs = [];
  for (let i = 0; vs.length < count && i < 500; i++) {
    const tv = w.traffic.addVehicle({ id: `b${vs.length}`, node: cells[rand(cells.length)], ...params(vs.length) });
    if (tv) vs.push(tv);
  }
  let trips = 0;
  const plan = (tv) => {
    const search = g.search(tv.node, { arrivalEdge: tv.lastEdge });
    const goals = cells.filter((n) => n !== tv.node && Number.isFinite(search.dist(n)));
    w.traffic.drive(tv, search.routeTo(goals[rand(goals.length)]));
  };
  w.traffic.onArrive = (tv) => { trips++; plan(tv); };
  w.traffic.onDeadlock = (ev) => { if (ev.victim) plan(ev.victim); };
  vs.forEach(plan);
  return { vs, trips: () => trips };
}

test('a busy street grid is collision-free for every time step from 0.05 s to 0.5 s', () => {
  for (const dt of [0.05, 0.1, 0.25, 0.5]) {
    const w = createWorld(streetGrid(19, 6));
    const { vs, trips } = busyTraffic(w, 14, (i) => ({ length: [1.2, 0.8, 1.6][i % 3], speed: [1.5, 1.0, 2.5][i % 3], accel: 0.6, decel: 1 }));
    assert.equal(vs.length, 14);
    w.run(150, dt);
    assert.ok(trips() >= 14, `${trips()} trips at dt ${dt}`);
  }
});

test('even coarse time steps (1 s, 2 s, 5 s) cannot make vehicles overlap or skip a lock', () => {
  for (const dt of [1, 2, 5]) {
    const w = createWorld(streetGrid(19, 6));
    const { trips } = busyTraffic(w, 14, () => ({ length: 1.2, speed: 1.5, accel: 0.6, decel: 1 }), 9);
    w.run(600, dt);
    assert.ok(trips() >= 10, `${trips()} trips at dt ${dt}`);
  }
});

test('a lone road plate with no links is a legal place to stand; a route of zero edges there arrives at once', () => {
  const w = createWorld(['+...']);
  const a = w.add({ id: 'a', x: 0, y: 0 });
  assert.equal(w.graph.edges.length, 0);
  assert.equal(w.drive(a, 0, 0), true);
  w.run(0.5);
  assert.equal(a.driving, false);
  assert.equal(w.traffic.findFreeNode(a.node), -1, 'the only cell is taken');
  w.traffic.detach(a);
  assert.equal(w.traffic.findFreeNode(w.node(0, 0)), w.node(0, 0));
});

test('long vehicles (up to 1.75 cells) stay collision-free; they just need more room', () => {
  const w = createWorld(streetGrid(19, 6));
  const { vs, trips } = busyTraffic(w, 10, (i) => ({ length: [2.6, 3.5, 1.2][i % 3], speed: 2, accel: 0.8, decel: 1.2 }), 5);
  assert.equal(vs.length, 10);
  w.run(300);
  assert.ok(trips() >= 6, `${trips()} trips`);
  assert.ok(vs.some((v) => v.length > 3));
});

test('the speed factor can change at any time without collisions or jumps', () => {
  const w = createWorld(streetGrid(19, 6));
  const { vs, trips } = busyTraffic(w, 12, (i) => ({ length: 1.2, speed: [1.5, 3][i % 2], accel: 0.6, decel: 1 }), 11);
  for (const factor of [1, 0.3, 1.6, 0, 1, 0.7]) {
    w.traffic.speedFactor = factor;
    w.run(25);
  }
  assert.ok(trips() > 0);
  assert.equal(vs.length, 12);
});

test('breakdowns on a busy grid: broken vehicles are driven around by nobody, queues form and clear', () => {
  const w = createWorld(streetGrid(19, 6));
  const { vs, trips } = busyTraffic(w, 12, () => ({ length: 1.2, speed: 1.5, accel: 0.6, decel: 1 }), 7);
  w.run(30);
  vs[0].disabled = true;
  vs[5].disabled = true;
  w.run(60);
  assert.ok(w.traffic.stats.waitBroken > 0 || vs[0].driving === false);
  vs[0].disabled = false;
  vs[5].disabled = false;
  const before = trips();
  w.run(120);
  assert.ok(trips() > before, 'traffic flows again');
});

test('a plant with one-way aisles, a crossing and dead ends keeps moving (integration)', () => {
  const w = createWorld([
    '>>>>>>>>>v.',
    '^........v.',
    '^..+++...v.',
    '^..+.+...v.',
    '^..+++...v.',
    '^<<<<<<<<<+',
    '.........+.',
  ]);
  const { vs, trips } = busyTraffic(w, 8, () => ({ length: 1.2, speed: 1.5, accel: 0.6, decel: 1 }), 2);
  assert.equal(vs.length, 8);
  w.run(300);
  assert.ok(trips() >= 8, `${trips()} trips`);
});

test('a platoon crossing a busy junction keeps its headway and everybody arrives', () => {
  const w = createWorld(['.........+.........', '+++++++++++++++++++', '.........+.........', '.........+.........']);
  assert.equal(w.graph.controlled[w.node(9, 1)], 1);
  const east = [0, 1, 2, 3].map((i) => w.add({ id: `e${i}`, x: 6 - 2 * i, y: 1 }));
  const north = w.add({ id: 'n', x: 9, y: 0 });
  const south = w.add({ id: 's', x: 9, y: 3 });
  east.forEach((v, i) => w.drive(v, 18 - 2 * i, 1));
  w.drive(north, 9, 3);
  w.drive(south, 9, 0);
  let minGap = Infinity;
  w.run(90, 0.1, () => {
    for (let i = 1; i < east.length; i++) minGap = Math.min(minGap, east[i - 1].x - east[i].x - 1.2);
  });
  assert.ok(minGap >= 0.5 - 1e-9, `closest approach ${minGap}`);
  east.forEach((v, i) => assert.equal(v.node, w.node(18 - 2 * i, 1), `${v.id} arrived`));
  assert.equal(north.node, w.node(9, 3));
  assert.equal(south.node, w.node(9, 0));
  assert.equal(w.traffic.stats.deadlocks, 0);
});
