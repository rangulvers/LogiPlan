import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLayout } from '../js/model/validate.js';
import * as L from '../js/model/layout.js';
import { emptyLayout } from '../js/model/defaults.js';
import { layoutFromAscii } from './helpers/ascii.js';
import { createRng } from '../js/util/rng.js';
import { DX, DY, opposite, cellKey } from '../js/util/grid.js';

// Every code that docs/ARCHITECTURE.md §4.7 lists (plus our extra one); the last test checks each was produced.
const ALL_CODES = [
  'no-stations', 'no-roads', 'no-flows', 'no-fleets', 'station-no-dock', 'station-dock-isolated', 'flow-unreachable',
  'flow-no-return', 'flow-bad-endpoints', 'flow-fleet-missing', 'source-no-outflow', 'process-no-inflow', 'process-no-outflow',
  'sink-no-inflow', 'perCycle-exceeds-inCap', 'batch-exceeds-capacity', 'storage-small', 'depot-missing', 'home-depot-missing',
  'vehicle-longer-than-cell', 'road-fragment', 'one-way-dead-end', 'fleet-count-zero', 'duplicate-names', 'warmup-exceeds-duration',
];
const produced = new Set();
const everyIssue = [];

function check(layout, opts) {
  const issues = validateLayout(layout, opts);
  for (const issue of issues) {
    produced.add(issue.code);
    everyIssue.push(issue);
  }
  return issues;
}
const codes = (issues) => issues.map((i) => i.code);
const find = (issues, code) => issues.find((i) => i.code === code);

const CHAIN = { stations: { A: 'source', B: 'process', C: 'sink' }, flows: [['A', 'B'], ['B', 'C']], fleets: [{ count: 1 }] };
/** source -> process -> sink along one two-way road: no issues expected. */
const healthy = (extra = {}) => layoutFromAscii(['AA..BB..CC', '++++++++++'], { ...CHAIN, ...extra });

test('a healthy source -> process -> sink plant has no issues', () => {
  assert.deepEqual(check(healthy()), []);
});

test('no-stations: an empty plant gets exactly one friendly error', () => {
  const issues = check(emptyLayout());
  assert.deepEqual(issues.map((i) => [i.code, i.severity, i.id]), [['no-stations', 'error', 'no-stations:layout']]);
  assert.match(issues[0].message, /no stations/i);
});

test('no-roads, no-flows and no-fleets', () => {
  const noRoad = check(layoutFromAscii(['AA..BB..CC'], CHAIN));
  assert.equal(find(noRoad, 'no-roads').severity, 'error');
  assert.deepEqual(codes(noRoad).filter((c) => c === 'station-no-dock').length, 3, 'every station is also reported as having no dock');
  assert.ok(!codes(noRoad).includes('flow-unreachable'), 'no duplicate noise for flows that cannot be checked');

  const noFlows = check(layoutFromAscii(['AA..BB..CC', '++++++++++'], { ...CHAIN, flows: [] }));
  assert.equal(find(noFlows, 'no-flows').severity, 'error');
  assert.ok(!codes(noFlows).includes('no-fleets'), 'no vehicles needed when nothing is transported');

  const noFleets = check(healthy({ fleets: [] }));
  assert.match(find(noFleets, 'no-fleets').message, /no vehicles/);
  const zeroFleets = check(healthy({ fleets: [{ count: 0 }] }));
  assert.match(find(zeroFleets, 'no-fleets').message, /count of zero/);
  assert.ok(find(zeroFleets, 'fleet-count-zero'));
});

test('station-no-dock is an error for stations in a flow and a warning for unused ones', () => {
  const l = layoutFromAscii(['AA..BB..CC', '++++++++++', '..........', '.DD.......'], { ...CHAIN, stations: { ...CHAIN.stations, D: 'storage' } });
  const unused = find(check(l), 'station-no-dock');
  assert.deepEqual([unused.severity, unused.id, unused.refs], ['warning', 'station-no-dock:D', { stationId: 'D' }]);
  assert.match(unused.hint, /Move the station next to a road or draw a road touching it/);
  L.addFlow(l, 'B', 'D');
  assert.equal(find(check(l), 'station-no-dock').severity, 'error');
  const depot = layoutFromAscii(['AA..BB..CC', '++++++++++', '..........', '.DD.......'], { ...CHAIN, stations: { ...CHAIN.stations, D: 'depot' } });
  assert.equal(find(check(depot), 'station-no-dock').severity, 'error', 'a depot always needs a dock');
});

test('station-dock-isolated: the only road next to a station is a lone plate', () => {
  const l = layoutFromAscii(['AA..BB..CC', '++++++++++', '..........', '.DD.......', '.+........'], { ...CHAIN, stations: { ...CHAIN.stations, D: 'storage' } });
  const issue = find(check(l), 'station-dock-isolated');
  assert.deepEqual([issue.severity, issue.refs.stationId, issue.refs.cells], ['warning', 'D', [[1, 4]]]);
  assert.ok(!codes(check(l)).includes('road-fragment'), 'a plate that is a dock is not a stray fragment');
  L.addFlow(l, 'B', 'D');
  assert.equal(find(check(l), 'station-dock-isolated').severity, 'error');
  assert.ok(find(check(l), 'flow-unreachable'));
});

test('flow-unreachable: a gap in the road, or a one-way road against the flow', () => {
  const gap = check(layoutFromAscii(['AA..BB..CC', '++..++++++'], CHAIN));
  const issue = find(gap, 'flow-unreachable');
  assert.deepEqual([issue.severity, issue.id, issue.refs.flowId], ['error', 'flow-unreachable:f1', 'f1']);
  assert.match(issue.message, /“A”.*“B”/);
  assert.ok(issue.hint.length > 20);
  const wrongWay = check(layoutFromAscii(['AA..BB..CC', '<<<<<<<<<<'], { ...CHAIN, flows: [['A', 'B']] }));
  assert.ok(codes(wrongWay).includes('flow-unreachable'), 'the road only leads west, from B towards A');
});

test('flow-no-return: vehicles can get there but not back', () => {
  const oneWay = check(layoutFromAscii(['AA..BB..CC', '>>>>>>>>>>'], { ...CHAIN, flows: [['A', 'B']] }));
  assert.equal(find(oneWay, 'flow-no-return').id, 'flow-no-return:f1');
  assert.ok(find(oneWay, 'one-way-dead-end'), 'the end of the one-way road traps vehicles');
  const loop = check(layoutFromAscii(['AA..BB..CC', '>>>>>>>>>v', '^<<<<<<<<<'], CHAIN));
  assert.deepEqual(loop, [], 'a one-way loop reaches every dock and returns');
});

test('routing honours the no-U-turn rule: reversing is only allowed where the road ends', () => {
  // B's docks are (4,1) and (5,1); east of them the road is one-way and traps. Turning round at B is not allowed.
  const trap = check(layoutFromAscii(['AA..BB', '+++++>>'], { stations: { A: 'source', B: 'sink' }, flows: [['A', 'B']] }));
  assert.ok(find(trap, 'flow-no-return'), 'a naive search that U-turns at the dock would call this fine');
  // The same road ending in a two-way dead end lets the vehicle reverse at the end.
  const deadEnd = check(layoutFromAscii(['AA..BB', '+++++++'], { stations: { A: 'source', B: 'sink' }, flows: [['A', 'B']] }));
  assert.ok(!codes(deadEnd).some((c) => c.startsWith('flow-')));
  // A dock on a straight road that goes on into a one-way return lane is fine: the vehicle drives round instead of turning.
  const around = check(layoutFromAscii(['AA..BB.', '+++++>v', '+<<<<<<'], { stations: { A: 'source', B: 'sink' }, flows: [['A', 'B']] }));
  assert.ok(!codes(around).some((c) => c.startsWith('flow-')));
  // Station sharing a dock cell: no movement needed either way.
  const shared = check(layoutFromAscii(['AABB', '++++'], { stations: { A: 'source', B: 'sink' }, flows: [['A', 'B']] }));
  assert.ok(!codes(shared).some((c) => c.startsWith('flow-')));
});

test('flow-bad-endpoints: dangling, wrong type, self and duplicate flows are reported, not assumed away', () => {
  const l = healthy();
  const raw = (id, from, to) => l.flows.push({ id, from, to, weight: 1, perCycle: 1, batchMin: 1, batchMax: 0, maxWait: 0, priority: 1, fleetId: null });
  raw('x1', 'A', 'zzz');
  raw('x2', 'C', 'B'); // from a sink
  raw('x3', 'A', 'A');
  raw('x4', 'B', 'A'); // into a source
  raw('x5', 'A', 'B'); // duplicate of f1
  const issues = check(l).filter((i) => i.code === 'flow-bad-endpoints');
  assert.deepEqual(issues.map((i) => i.id), ['flow-bad-endpoints:x1', 'flow-bad-endpoints:x2', 'flow-bad-endpoints:x3', 'flow-bad-endpoints:x4', 'flow-bad-endpoints:x5']);
  assert.match(issues[0].message, /no longer exists/);
  assert.match(issues[1].message, /sink/);
  assert.match(issues[2].message, /same station/);
  assert.match(issues[3].message, /source/);
  assert.match(issues[4].message, /more than one flow/);
  assert.ok(issues.every((i) => i.severity === 'error' && i.refs.flowId));
});

test('flow-fleet-missing: restriction to a missing fleet or to a fleet without vehicles', () => {
  const l = healthy();
  l.flows[0].fleetId = 'v77';
  const missing = find(check(l), 'flow-fleet-missing');
  assert.deepEqual([missing.severity, missing.refs.fleetId], ['error', 'v77']);
  assert.match(missing.message, /no longer exists/);
  const l2 = healthy({ fleets: [{ count: 1 }, { count: 0 }] });
  l2.flows[0].fleetId = 'v2';
  assert.match(find(check(l2), 'flow-fleet-missing').message, /no vehicles/);
  const l3 = healthy({ fleets: [{ count: 1 }, { count: 2 }] });
  l3.flows[0].fleetId = 'v2';
  assert.ok(!codes(check(l3)).includes('flow-fleet-missing'));
});

test('source-no-outflow, process-no-inflow, process-no-outflow, sink-no-inflow', () => {
  const l = healthy();
  l.flows = [];
  L.addFlow(l, 'B', 'C');
  const a = check(l);
  assert.deepEqual([find(a, 'source-no-outflow').severity, find(a, 'source-no-outflow').refs.stationId], ['warning', 'A']);
  assert.equal(find(a, 'process-no-inflow').severity, 'warning');
  l.flows = [];
  L.addFlow(l, 'A', 'B');
  const b = check(l);
  assert.equal(find(b, 'process-no-outflow').severity, 'info');
  assert.equal(find(b, 'sink-no-inflow').severity, 'warning');
  assert.match(find(b, 'sink-no-inflow').message, /“C”/);
});

test('perCycle-exceeds-inCap: the workstation could never start', () => {
  const l = healthy();
  L.updateFlow(l, 'f1', { perCycle: 5 });
  L.updateStation(l, 'B', { params: { inCap: 3 } });
  const issue = find(check(l), 'perCycle-exceeds-inCap');
  assert.deepEqual([issue.severity, issue.id, issue.refs], ['error', 'perCycle-exceeds-inCap:f1', { stationId: 'B', flowId: 'f1' }]);
  assert.match(issue.message, /5 loads.*holds only 3/);
  L.updateStation(l, 'B', { params: { inCap: 5 } });
  assert.ok(!codes(check(l)).includes('perCycle-exceeds-inCap'));
});

test('batch-exceeds-capacity: a minimum batch that can never be ready is a warning (the simulation sends smaller batches)', () => {
  const l = healthy();
  L.updateFlow(l, 'f1', { batchMin: 2 });
  const byVehicle = find(check(l), 'batch-exceeds-capacity');
  assert.deepEqual([byVehicle.severity, byVehicle.id], ['warning', 'batch-exceeds-capacity:f1']);
  assert.match(byVehicle.message, /vehicles carry at most 1.*leave with 1 or fewer/);
  assert.ok(!check(l).some((i) => i.severity === 'error'), 'the plan still runs, so the Checks tab shows no error');
  L.updateFlow(l, 'f1', { maxWait: 90 });
  assert.equal(find(check(l), 'batch-exceeds-capacity').severity, 'warning', 'with a maxWait too');
  L.updateFleet(l, 'v1', { capacity: 6 });
  assert.ok(!codes(check(l)).includes('batch-exceeds-capacity'));
  L.updateFlow(l, 'f1', { batchMin: 5, maxWait: 0 });
  L.updateStation(l, 'A', { params: { outCap: 3 } });
  assert.match(find(check(l), 'batch-exceeds-capacity').message, /“A” holds at most 3/);
  L.updateStation(l, 'A', { params: { outCap: 8 } });
  L.updateStation(l, 'B', { params: { inCap: 4 } });
  assert.match(find(check(l), 'batch-exceeds-capacity').message, /“B” accepts at most 4/);
  L.updateStation(l, 'B', { params: { inCap: 8 } });
  assert.deepEqual(check(l), []);
  L.updateFlow(l, 'f1', { batchMin: 3, batchMax: 3 });
  L.updateFlow(l, 'f1', { batchMin: 4 });
  assert.ok(!codes(check(l)).includes('batch-exceeds-capacity'), 'batchMin is kept <= batchMax by the model');
});

test('storage-small: the buffer cannot even take one full delivery', () => {
  const l = layoutFromAscii(['AA..SS..CC', '++++++++++'], {
    stations: { A: 'source', S: { type: 'storage', params: { capacity: 2 } }, C: 'sink' }, flows: [['A', 'S'], ['S', 'C']], fleets: [{ preset: 'tugger', count: 1 }],
  });
  const issue = find(check(l), 'storage-small');
  assert.deepEqual([issue.severity, issue.id], ['warning', 'storage-small:S']);
  assert.match(issue.message, /only 2 loads.*delivery of 4/);
  L.updateFlow(l, 'f1', { batchMax: 2 });
  assert.ok(!codes(check(l)).includes('storage-small'));
});

test('depot-missing: battery vehicles with nowhere to charge', () => {
  const l = healthy();
  L.updateFleet(l, 'v1', { battery: { enabled: true } });
  const issue = find(check(l), 'depot-missing');
  assert.deepEqual([issue.severity, issue.id], ['error', 'depot-missing:v1']);
  const withDepot = layoutFromAscii(['AA..BB..CC', '++++++++++', '..........', '.DD.......'], {
    ...CHAIN, stations: { ...CHAIN.stations, D: { type: 'depot', params: { slots: 2, chargers: 0 } } }, fleets: [{ count: 1, battery: { enabled: true } }],
  });
  assert.ok(find(check(withDepot), 'depot-missing'), 'a depot without chargers does not help');
  L.updateStation(withDepot, 'D', { params: { chargers: 1 } });
  assert.ok(!codes(check(withDepot)).includes('depot-missing'));
});

test('home-depot-missing: the fleet points at a station that is not a depot', () => {
  const l = healthy();
  l.fleets[0].home = 'ghost';
  const issue = find(check(l), 'home-depot-missing');
  assert.deepEqual([issue.severity, issue.id, issue.refs], ['error', 'home-depot-missing:v1', { fleetId: 'v1' }]);
  l.fleets[0].home = 'B';
  assert.ok(find(check(l), 'home-depot-missing'), 'a workstation is not a depot');
});

test('vehicle-longer-than-cell compares the vehicle length with the cell size', () => {
  const l = healthy({ fleets: [{ preset: 'forklift', count: 1 }] });
  const issue = find(check(l), 'vehicle-longer-than-cell');
  assert.deepEqual([issue.severity, issue.id], ['warning', 'vehicle-longer-than-cell:v1']);
  assert.match(issue.message, /2\.6 m long.*2 m/);
  L.setCellSize(l, 3);
  assert.ok(!codes(check(l)).includes('vehicle-longer-than-cell'));
});

test('road-fragment: a piece of road that touches no station', () => {
  const l = layoutFromAscii(['AA..BB..CC', '++++++++++', '..........', '.+++......'], CHAIN);
  const issue = find(check(l), 'road-fragment');
  assert.deepEqual([issue.severity, issue.id, issue.refs.cells], ['info', 'road-fragment:1,3', [[1, 3], [2, 3], [3, 3]]]);
  assert.match(issue.message, /3 cells/);
});

test('one-way-dead-end: cells vehicles can enter but never leave', () => {
  const l = layoutFromAscii(['AA..BB..CC', '++++++++++', '..........', '..........'], CHAIN);
  L.paintRoadPath(l, [[9, 1], [9, 3]], { oneWay: true });
  const issue = find(check(l), 'one-way-dead-end');
  assert.deepEqual([issue.severity, issue.id, issue.refs.cells], ['warning', 'one-way-dead-end:9,3', [[9, 3]]]);
  const twoWay = layoutFromAscii(['AA..BB..CC', '++++++++++', '.........+'], CHAIN);
  assert.ok(!codes(check(twoWay)).includes('one-way-dead-end'), 'vehicles reverse at a two-way dead end');
});

test('fleet-count-zero, duplicate-names and warmup-exceeds-duration', () => {
  const l = healthy({ fleets: [{ count: 2 }, { count: 0 }] });
  const zero = find(check(l), 'fleet-count-zero');
  assert.deepEqual([zero.severity, zero.id], ['warning', 'fleet-count-zero:v2']);

  L.updateStation(l, 'C', { name: 'press' });
  L.updateStation(l, 'B', { name: 'Press ' });
  const dup = find(check(l), 'duplicate-names');
  assert.deepEqual([dup.severity, dup.id, dup.refs.stationId], ['info', 'duplicate-names:station:press', 'B']);
  L.updateFleet(l, 'v2', { name: l.fleets[0].name });
  assert.equal(check(l).filter((i) => i.code === 'duplicate-names').length, 2, 'fleets are checked separately');

  l.settings.warmup = l.settings.duration;
  assert.equal(find(check(l), 'warmup-exceeds-duration').severity, 'warning');
});

test('issues are sorted by severity, ids are stable and unique, every issue explains itself', () => {
  const l = layoutFromAscii(['AA..BB..CC', '++..++++++', '..........', '.++.......'], { ...CHAIN, fleets: [{ count: 0 }] });
  l.flows.push({ id: 'x9', from: 'C', to: 'A', weight: 1, perCycle: 1, batchMin: 1, batchMax: 0, maxWait: 0, priority: 1, fleetId: null });
  const first = check(l);
  assert.deepEqual(first.map((i) => i.id), check(l).map((i) => i.id), 'stable between runs');
  assert.equal(new Set(first.map((i) => i.id)).size, first.length, 'unique');
  const rank = { error: 0, warning: 1, info: 2 };
  assert.deepEqual(first.map((i) => rank[i.severity]), first.map((i) => rank[i.severity]).sort(), 'errors first');
  assert.ok(first.length >= 5);
  for (const i of first) assert.ok(i.id.startsWith(`${i.code}:`) && i.id.length > i.code.length + 1, i.id);
});

// ---------------------------------------------------------------------------------------------------------
// Graph-aware reachability (code against the documented API; a tiny fake instead of the real graph)
// ---------------------------------------------------------------------------------------------------------

function fakeGraph(cols, distance, routeEdges = []) {
  const calls = [];
  return {
    cols,
    calls,
    search(from, opts) {
      calls.push([from, opts.arrivalEdge]);
      return { dist: (to) => distance(from, opts.arrivalEdge, to), routeTo: () => ({ nodes: [], edges: routeEdges, cost: 0 }) };
    },
  };
}

test('with a graph, graph.search decides reachability (arrival edge passed on the way back)', () => {
  const l = healthy();
  assert.deepEqual(check(l), []);
  const nobody = fakeGraph(10, () => Infinity);
  assert.deepEqual(codes(check(l, { graph: nobody })).filter((c) => c.startsWith('flow-')), ['flow-unreachable', 'flow-unreachable']);

  // A -> B works over route edges [3, 5]; coming back, only a search that starts with arrivalEdge -1 would succeed.
  const oneWayStreet = fakeGraph(10, (from, arrivalEdge) => (arrivalEdge === -1 ? 7 : Infinity), [3, 5]);
  const issues = check(l, { graph: oneWayStreet });
  assert.ok(find(issues, 'flow-no-return'));
  assert.ok(oneWayStreet.calls.some(([, edge]) => edge === 5), 'the way back starts with the last edge of the route');
  assert.equal(oneWayStreet.calls[0][1], -1, 'the way there starts with free choice');
  const docksOfA = L.docksOf(l, 'A').map(([cx, cy]) => cy * 10 + cx);
  assert.ok(docksOfA.includes(oneWayStreet.calls[0][0]), 'searches start at dock cells (dense node ids cy*cols+cx)');

  const fine = fakeGraph(10, () => 4, [3]);
  const gap = layoutFromAscii(['AA..BB..CC', '++..++..++'], CHAIN);
  assert.ok(find(check(gap), 'flow-unreachable'), 'the internal search sees the gaps');
  assert.deepEqual(codes(check(gap, { graph: fine })).filter((c) => c.startsWith('flow-')), [], 'the graph has the last word');
});

// ---------------------------------------------------------------------------------------------------------
// The internal search against an independent brute-force oracle
// ---------------------------------------------------------------------------------------------------------

/** Cell+heading state search written from the rule in §5.1, independent of validate.js. */
function oracle(layout, fromId, toId) {
  const exitsOf = (cx, cy) => [0, 1, 2, 3].filter((d) => L.hasLink(layout, cx, cy, d));
  const next = ([cx, cy, heading]) => {
    const all = exitsOf(cx, cy);
    const forward = heading < 0 ? all : all.filter((d) => d !== opposite(heading));
    return (forward.length ? forward : all).map((d) => [cx + DX[d], cy + DY[d], d]);
  };
  const flood = (starts) => {
    const seen = new Map(starts.map((s) => [s.join(), s]));
    const queue = [...seen.values()];
    for (let i = 0; i < queue.length; i++) {
      for (const n of next(queue[i])) if (!seen.has(n.join())) { seen.set(n.join(), n); queue.push(n); }
    }
    return [...seen.values()];
  };
  const a = L.docksOf(layout, fromId);
  const b = L.docksOf(layout, toId);
  const at = (docks) => (s) => docks.some(([cx, cy]) => cx === s[0] && cy === s[1]);
  const visited = flood(a.map(([cx, cy]) => [cx, cy, -1]));
  const arrived = visited.filter(at(b));
  if (!arrived.length) return 'unreachable';
  if (arrived.some((s) => at(a)(s) && s[2] < 0)) return 'ok';
  return arrived.some((s) => flood([s]).some(at(a))) ? 'ok' : 'no-return';
}

test('the internal reachability search agrees with a brute-force oracle on 300 random road networks', () => {
  const rng = createRng(99);
  const tally = { ok: 0, unreachable: 0, 'no-return': 0 };
  for (let t = 0; t < 300; t++) {
    const l = L.createLayout({ cols: 12, rows: 10 });
    L.addStation(l, { type: 'source', x: 0, y: 0, w: 2, h: 2 });
    L.addStation(l, { type: 'sink', x: 9, y: 7, w: 2, h: 2 });
    L.addFlow(l, 's1', 's2');
    L.addFleet(l);
    for (let s = 0; s < 7; s++) L.paintRoadPath(l, Array.from({ length: 2 + rng.int(3) }, () => [rng.int(12), rng.int(10)]), { oneWay: rng.next() < 0.5 });
    if (!L.docksOf(l, 's1').length || !L.docksOf(l, 's2').length) continue;
    const expected = oracle(l, 's1', 's2');
    const flowCodes = codes(check(l)).filter((c) => c.startsWith('flow-'));
    assert.deepEqual(flowCodes, expected === 'ok' ? [] : [`flow-${expected}`], `network ${t}`);
    tally[expected]++;
  }
  assert.ok(tally.ok > 20 && tally.unreachable > 20 && tally['no-return'] > 5, `the random networks cover all outcomes: ${JSON.stringify(tally)}`);
});

test('layouts that are not normalized are checked, not crashed on: missing names, parameters, settings or road records; null options', () => {
  const broken = {
    'a station without a name': (l) => { delete l.stations[1].name; },
    'a station with a blank name': (l) => { l.stations[1].name = '   '; },
    'stations without parameters': (l) => { for (const s of l.stations) delete s.params; },
    'a layout without settings': (l) => { delete l.settings; },
    'a fleet without a name': (l) => { delete l.fleets[0].name; },
    'a road record that is null': (l) => { l.roads['2,1'] = null; },
    'a road record without exits': (l) => { l.roads['3,1'] = {}; },
  };
  for (const [what, damage] of Object.entries(broken)) {
    const l = healthy();
    damage(l);
    assert.doesNotThrow(() => check(l), what);
    assert.doesNotThrow(() => check(l, null), `${what}, null options`);
    for (const i of check(l)) assert.ok(!/undefined|NaN|\[object|“”/.test(i.message + i.hint), `${what}: ${i.message}`);
  }
  const nameless = healthy();
  delete nameless.stations[0].name;
  L.updateFlow(nameless, 'f1', { batchMin: 5 });
  assert.match(find(check(nameless), 'batch-exceeds-capacity').message, /“A” → “B”/, 'a nameless item is called by its id');
  assert.deepEqual(check(healthy(), null), [], 'null options behave like none');
});

test('every issue code of the spec was produced, each with a message, a hint and valid references', () => {
  for (const code of ALL_CODES) assert.ok(produced.has(code), `no test produced ${code}`);
  assert.ok(everyIssue.length > 100);
  for (const i of everyIssue) {
    assert.match(i.severity, /^(error|warning|info)$/);
    assert.ok(typeof i.message === 'string' && i.message.length > 15 && !/undefined|NaN|\[object/.test(i.message), i.message);
    assert.ok(typeof i.hint === 'string' && i.hint.length > 15, `${i.code} needs a hint`);
    assert.ok(i.refs && typeof i.refs === 'object');
    assert.ok(!/SCC|strongly/i.test(i.message + i.hint), 'no jargon');
  }
});

test('the cellKey helper agrees with the ids used for cell references', () => {
  const l = layoutFromAscii(['AA..BB..CC', '++++++++++', '..........', '.++.......'], CHAIN);
  assert.equal(find(check(l), 'road-fragment').id, `road-fragment:${cellKey(1, 3)}`);
});
