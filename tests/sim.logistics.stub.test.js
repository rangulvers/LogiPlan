// The StubTraffic test double (tests/helpers/stub-traffic.js) honours the parts of the TrafficSystem contract that the
// logistics tests rely on: exact travel times, arrival callbacks, disabled vehicles, attach/detach/relocate with node
// occupancy, edge counts, statistics and strict preconditions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutFromAscii } from './helpers/ascii.js';
import { StubTraffic, tripTicks } from './helpers/stub-traffic.js';
import { buildGraph } from '../js/sim/graph.js';

const setup = (lines, opts) => {
  const layout = layoutFromAscii(lines, { fleets: [], ...opts });
  const graph = buildGraph(layout);
  const traffic = new StubTraffic(graph);
  const id = (x, y) => y * graph.cols + x;
  const add = (x, y, extra = {}) => traffic.addVehicle({ id: `t${x},${y}`, length: 1, speed: 2, accel: 1, decel: 1, node: id(x, y), owner: { name: 'owner' }, ...extra });
  return { layout, graph, traffic, id, add };
};

const route = (graph, from, to, arrivalEdge = -1) => graph.search(from, { arrivalEdge }).routeTo(to);

test('stub: a trip of D metres at v m/s takes ceil(D / (v dt)) ticks, then the vehicle stands exactly on the last node and onArrive fires once', () => {
  const { graph, traffic, id, add } = setup(['+++++++']);
  const tv = add(0, 0);
  const arrivals = [];
  traffic.onArrive = (v) => arrivals.push([v, v.node, v.driving]);
  traffic.drive(tv, route(graph, id(0, 0), id(5, 0)));
  assert.equal(tv.driving, true);
  assert.equal(tv.node, id(0, 0), 'still at its node until it moves');
  const dt = 0.25;
  const ticks = tripTicks(10, 2, dt);
  assert.equal(ticks, 20);
  for (let i = 0; i < ticks - 1; i++) traffic.step(dt);
  assert.equal(arrivals.length, 0);
  assert.equal(tv.node, -1);
  assert.ok(tv.edge >= 0 && tv.moving && tv.v === 2);
  traffic.step(dt);
  assert.equal(arrivals.length, 1);
  assert.deepEqual([arrivals[0][0] === tv, arrivals[0][1], arrivals[0][2]], [true, id(5, 0), false]);
  assert.equal(tv.x, graph.x(id(5, 0)));
  assert.equal(tv.y, graph.y(id(5, 0)));
  assert.equal(tv.odometer, 10);
  assert.equal(tv.lastEdge, graph.edgeBetween(id(4, 0), id(5, 0)));
  traffic.step(dt);
  assert.equal(arrivals.length, 1, 'no second callback');
  assert.equal(tv.moving, false);
  assert.equal(tripTicks(0, 2, dt), 0);
  assert.equal(tripTicks(10.5, 2, dt), 21);
});

test('stub: speed is vmax * speedFactor * edge.limit; edge counts and pass statistics are kept', () => {
  const { layout, id } = setup(['++++']);
  layout.roads['2,0'].limit = 0.5; // slow zone: the edges 1->2 and 2->3 run at half speed
  const graph = buildGraph(layout);
  const traffic = new StubTraffic(graph);
  const tv = traffic.addVehicle({ id: 'a', length: 1, speed: 2, accel: 1, decel: 1, node: id(0, 0) });
  traffic.speedFactor = 2;
  traffic.drive(tv, route(graph, id(0, 0), id(3, 0)));
  const onEdges = [];
  let ticks = 0;
  while (tv.driving) {
    traffic.step(0.25);
    ticks++;
    onEdges.push(graph.edges.reduce((n, e) => n + traffic.edgeCount(e.id), 0));
    assert.ok(ticks < 100);
  }
  // 2 m at 4 m/s = 0.5 s (2 ticks); the two slow edges 2 m at 2 m/s = 1 s (4 ticks) each
  assert.equal(ticks, 2 + 4 + 4);
  assert.ok(onEdges.slice(0, -1).every((c) => c === 1), 'one vehicle on exactly one edge while driving');
  assert.equal(onEdges.at(-1), 0);
  assert.equal(traffic.stats.edgePasses.reduce((a, b) => a + b, 0), 3);
  assert.equal(traffic.stats.drivingTime, ticks * 0.25);
  assert.equal(tv.odometer, 6);
});

test('stub: vehicles do not collide - they pass through each other - but two cannot stand on one node', () => {
  const { graph, traffic, id, add } = setup(['+++++']);
  const a = add(0, 0);
  const b = add(4, 0);
  assert.equal(add(0, 0), null, 'node occupied');
  assert.equal(traffic.canAttach(id(0, 0)), false);
  assert.equal(traffic.canAttach(id(2, 0)), true);
  assert.equal(traffic.canAttach(id(0, 3)), false, 'not a road cell');
  assert.equal(traffic.canAttach(-1), false);
  traffic.drive(a, route(graph, id(0, 0), id(4, 0)));
  traffic.drive(b, route(graph, id(4, 0), id(0, 0)));
  for (let i = 0; i < 40; i++) traffic.step(0.25);
  assert.equal(a.driving || b.driving, false);
  assert.equal(a.node, id(4, 0));
  assert.equal(b.node, id(0, 0));
});

test('stub: a disabled vehicle stays put with its route, counts as waiting (broken) and carries on when re-enabled', () => {
  const { graph, traffic, id, add } = setup(['+++++']);
  const tv = add(0, 0);
  traffic.drive(tv, route(graph, id(0, 0), id(4, 0)));
  for (let i = 0; i < 4; i++) traffic.step(0.25);
  tv.disabled = true;
  const where = [tv.x, tv.odometer, tv.edge];
  for (let i = 0; i < 8; i++) traffic.step(0.25);
  assert.deepEqual([tv.x, tv.odometer, tv.edge], where);
  assert.equal(tv.driving, true);
  assert.equal(tv.waiting, true);
  assert.equal(tv.waitReason, 'broken');
  assert.equal(tv.waitTime, 2);
  assert.equal(traffic.stats.waitBroken, 2);
  assert.equal(traffic.stats.totalWait, 2);
  tv.disabled = false;
  for (let i = 0; i < 40 && tv.driving; i++) traffic.step(0.25);
  assert.equal(tv.node, id(4, 0));
  assert.equal(tv.waiting, false);
});

test('stub: detach frees the node and the lane, attach puts the vehicle back at a free node, relocate teleports and drops the route', () => {
  const { graph, traffic, id, add } = setup(['+++++']);
  const tv = add(1, 0);
  const other = add(3, 0);
  traffic.detach(tv);
  assert.equal(tv.onRoad, false);
  assert.equal(traffic.canAttach(id(1, 0)), true);
  traffic.step(0.25); // detached vehicles are ignored
  assert.equal(traffic.attach(tv, id(3, 0)), false, 'occupied');
  assert.equal(traffic.attach(tv, id(2, 0)), true);
  assert.deepEqual([tv.onRoad, tv.node, tv.lastEdge, tv.x], [true, id(2, 0), -1, graph.x(id(2, 0))]);
  assert.throws(() => traffic.attach(tv, id(0, 0)), /already on the road/);

  traffic.drive(tv, route(graph, id(2, 0), id(0, 0)));
  traffic.step(0.25);
  assert.equal(traffic.edgeCount(graph.edgeBetween(id(2, 0), id(1, 0))), 1);
  assert.equal(traffic.relocate(tv, id(3, 0)), false, 'occupied');
  assert.equal(traffic.relocate(tv, id(4, 0)), true);
  assert.equal(tv.driving, false);
  assert.equal(tv.node, id(4, 0));
  assert.equal(traffic.edgeCount(graph.edgeBetween(id(2, 0), id(1, 0))), 0);
  assert.equal(traffic.canAttach(id(2, 0)), true);
  traffic.removeVehicle(other);
  assert.equal(traffic.vehicles.includes(other), false);
  assert.equal(traffic.canAttach(id(3, 0)), true);
});

test('stub: findFreeNode returns the closest free node by graph distance, ignoring direction', () => {
  const { traffic, id, add } = setup(['>>>>>', '.....']);
  add(2, 0);
  add(1, 0);
  assert.equal(traffic.findFreeNode(id(2, 0)), id(3, 0), 'distance 1: x=1 is taken, x=3 is free (direction is ignored)');
  assert.equal(traffic.findFreeNode(id(0, 0)), id(0, 0), 'a free node is its own answer');
  assert.equal(traffic.findFreeNode(id(0, 1)), -1, 'not a road cell');
  const full = setup(['+']);
  full.add(0, 0);
  assert.equal(full.traffic.findFreeNode(full.id(0, 0)), -1, 'no free node anywhere');
});

test('stub: drive refuses calls that break the contract', () => {
  const { graph, traffic, id, add } = setup(['+++++']);
  const tv = add(1, 0);
  const r = route(graph, id(1, 0), id(3, 0));
  assert.throws(() => traffic.drive(tv, route(graph, id(2, 0), id(3, 0))), /route starts at/);
  assert.throws(() => traffic.drive(tv, route(graph, id(1, 0), id(1, 0))), /empty route/);
  assert.throws(() => traffic.drive(tv, { nodes: [id(1, 0), id(3, 0)], edges: [graph.edgeBetween(id(1, 0), id(2, 0))], cost: 4 }), /inconsistent/);
  traffic.drive(tv, r);
  assert.throws(() => traffic.drive(tv, r), /already driving/);
  traffic.detach(tv);
  assert.throws(() => traffic.drive(tv, r), /not on the road/);
});

test('stub: drive refuses routes that turn around in mid-road (the graph rule), also right after arriving', () => {
  const { graph, traffic, id, add } = setup(['+++++']);
  const tv = add(0, 0);
  traffic.drive(tv, route(graph, id(0, 0), id(2, 0)));
  for (let i = 0; i < 20 && tv.driving; i++) traffic.step(0.25);
  assert.equal(tv.node, id(2, 0));
  const back = { nodes: [id(2, 0), id(1, 0)], edges: [graph.edgeBetween(id(2, 0), id(1, 0))], cost: 2 };
  assert.throws(() => traffic.drive(tv, back), /U-turn on the spot/);

  const atEnd = add(4, 0); // a dead end: reversing there is legal
  assert.doesNotThrow(() => traffic.drive(atEnd, route(graph, id(4, 0), id(3, 0))));

  const mid = add(3, 0);
  const zigzag = { nodes: [id(3, 0), id(2, 0), id(3, 0)], edges: [graph.edgeBetween(id(3, 0), id(2, 0)), graph.edgeBetween(id(2, 0), id(3, 0))], cost: 4 };
  assert.throws(() => traffic.drive(mid, zigzag), /U-turn in mid-road/);
});
