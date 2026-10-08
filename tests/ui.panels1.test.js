// Pure helpers of the Properties, What-if and Checks panels (js/ui/panels/{inspector,simulate,checks}.js).
// The DOM behaviour is covered by tests/e2e/panels1.mjs (Playwright); everything here runs in Node without a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLayout, addStation, addFlow, addFleet, addObstacle, addLabel, paintRoadPath, cloneLayout, resizeGrid, checkInvariants, roadAt,
} from '../js/model/layout.js';
import { DIR_BIT, E, W } from '../js/util/grid.js';
import {
  linkState, setLinkState, roadNeighbourMask, plantSummary, describeResize, breakdownSummary, stationStatus, removeSelection,
} from '../js/ui/panels/inspector.js';
import { formatFactor, factorSummary, nextSeed, measuredWindow } from '../js/ui/panels/simulate.js';
import { groupIssues, focusTarget } from '../js/ui/panels/checks.js';

// ---- road links -------------------------------------------------------------------------------------------

function threeCellRoad() {
  const layout = createLayout({ cols: 12, rows: 8 });
  paintRoadPath(layout, [[2, 3], [3, 3], [4, 3]]);
  return layout;
}

test('linkState reads a link from the point of view of the selected cell', () => {
  const layout = threeCellRoad();
  assert.equal(linkState(layout, 3, 3, E), 'both');
  assert.equal(linkState(layout, 3, 3, W), 'both');
  assert.equal(linkState(layout, 3, 3, 0), 'none', 'no neighbour to the north');
  paintRoadPath(layout, [[6, 3], [7, 3]], { oneWay: true });
  assert.equal(linkState(layout, 6, 3, E), 'out');
  assert.equal(linkState(layout, 7, 3, W), 'in');
});

test('setLinkState reaches every state from every state and keeps the layout valid', () => {
  const layout = threeCellRoad();
  const states = ['both', 'out', 'in', 'none'];
  for (const from of states) {
    for (const to of states) {
      assert.equal(setLinkState(layout, 3, 3, E, from), true);
      assert.equal(setLinkState(layout, 3, 3, E, to), true);
      assert.equal(linkState(layout, 3, 3, E), to, `${from} -> ${to}`);
      assert.deepEqual(checkInvariants(layout), []);
    }
  }
});

test('setLinkState sets exactly the two link bits and leaves other links alone', () => {
  const layout = threeCellRoad();
  setLinkState(layout, 3, 3, E, 'in'); // neighbour -> this cell only
  assert.equal(layout.roads['3,3'].out & DIR_BIT[E], 0);
  assert.notEqual(layout.roads['4,3'].out & DIR_BIT[W], 0);
  assert.equal(linkState(layout, 3, 3, W), 'both', 'the link to the other neighbour is untouched');
  setLinkState(layout, 3, 3, E, 'out');
  assert.notEqual(layout.roads['3,3'].out & DIR_BIT[E], 0);
  assert.equal(layout.roads['4,3'].out & DIR_BIT[W], 0);
});

test('setLinkState refuses to invent road cells', () => {
  const layout = threeCellRoad();
  const before = cloneLayout(layout);
  assert.equal(setLinkState(layout, 3, 3, 0, 'both'), false, 'no road cell to the north');
  assert.equal(setLinkState(layout, 9, 9, E, 'both'), false, 'not a road cell');
  assert.deepEqual(layout, before);
});

test('roadNeighbourMask marks the road neighbours (N=1 E=2 S=4 W=8)', () => {
  const layout = threeCellRoad();
  assert.equal(roadNeighbourMask(layout, 3, 3), 2 | 8);
  assert.equal(roadNeighbourMask(layout, 2, 3), 2);
  assert.equal(roadNeighbourMask(layout, 9, 9), 0);
});

// ---- plant summary and resize ----------------------------------------------------------------------------

function plant() {
  const layout = createLayout({ cols: 20, rows: 12, cellSize: 2.5 });
  const a = addStation(layout, { type: 'source', name: 'In', x: 0, y: 0, w: 3, h: 2 });
  addStation(layout, { type: 'process', name: 'Press', x: 15, y: 5, w: 4, h: 3 }); // reaches x = 19
  const c = addStation(layout, { type: 'sink', name: 'Out', x: 18, y: 9, w: 2, h: 2 });
  addFlow(layout, a.id, c.id);
  paintRoadPath(layout, [[0, 3], [19, 3]]);
  addObstacle(layout, { x: 10, y: 8, w: 2, h: 2, kind: 'rack' });
  addLabel(layout, { x: 19, y: 1, text: 'Dock' });
  addFleet(layout, 'agv', { count: 3 });
  return layout;
}

test('plantSummary counts what the planner sees', () => {
  const layout = plant();
  const s = plantSummary(layout);
  assert.deepEqual(s.byType, { source: 1, process: 1, storage: 0, sink: 1, depot: 0 });
  assert.equal(s.stations, 3);
  assert.equal(s.roadCells, 20);
  assert.equal(s.roadMeters, 50);
  assert.equal(s.widthM, 50);
  assert.equal(s.heightM, 30);
  assert.equal(s.areaM2, 1500);
  assert.equal(s.vehicles, 3);
  assert.equal(s.flows, 1);
});

test('describeResize reports removed and shortened things, and nothing when the plant only grows', () => {
  const layout = plant();
  const grow = cloneLayout(layout);
  resizeGrid(grow, 30, 20);
  assert.equal(describeResize(layout, grow).total, 0);
  assert.equal(describeResize(layout, grow).text, '');

  const shrink = cloneLayout(layout);
  assert.equal(resizeGrid(shrink, 17, 12).removed > 0, true);
  const loss = describeResize(layout, shrink);
  assert.equal(loss.roads, 3, 'road cells at columns 17 to 19');
  assert.equal(loss.stations, 1, 'Out lies completely outside');
  assert.equal(loss.flows, 1, 'and takes its flow with it');
  assert.equal(loss.labels, 1);
  assert.equal(loss.obstacles, 0);
  assert.equal(loss.clipped, 1, 'Press is cut shorter');
  assert.match(loss.text, /3 road cells, 1 station \(with 1 flow\) and 1 label/);
  assert.match(loss.text, /1 station or obstacle at the edge will be cut shorter/);
  assert.equal(loss.total, 3 + 1 + 1 + 1);
});

// ---- breakdowns and live status --------------------------------------------------------------------------

test('breakdownSummary explains never, incomplete and complete settings', () => {
  assert.equal(breakdownSummary(0, 0).aside, 'never');
  assert.equal(breakdownSummary(0, 600).warn, false);
  const half = breakdownSummary(3600, 0);
  assert.equal(half.warn, true);
  assert.match(half.hint, /repair time/);
  const full = breakdownSummary(7200, 480);
  assert.equal(full.warn, false);
  assert.equal(full.aside, 'every 2 h');
  assert.match(full.hint, /available about 94 % of the time/);
});

test('stationStatus words the runtime state for a planner', () => {
  const busy = stationStatus({ type: 'process', state: 'busy', fill: 0.5, fillLabel: '2/4', machines: [{ state: 'busy' }, { state: 'idle' }, { state: 'busy' }] });
  assert.deepEqual(busy, { tone: 'busy', label: 'Working', detail: '2 of 3 machines working', fill: 0.5, fillText: 'Input buffer 2/4' });
  assert.equal(stationStatus({ type: 'process', state: 'starved', fill: 0, fillLabel: '0/4', machines: [{ state: 'idle' }] }).label, 'Waiting for material');
  assert.equal(stationStatus({ type: 'process', state: 'blocked', fill: 1, fillLabel: '4/4', machines: [] }).tone, 'blocked');
  assert.equal(stationStatus({ type: 'process', state: 'down', fill: 0, fillLabel: '0/4', machines: [] }).tone, 'down');
  assert.equal(stationStatus({ type: 'source', state: 'blocked', fill: 1, fillLabel: '6/6 +3' }).label, 'Yard is backing up');
  assert.equal(stationStatus({ type: 'storage', state: 'full', fill: 1, fillLabel: '40/40' }).label, 'Full');
  const sink = stationStatus({ type: 'sink', state: 'normal', fill: 0, fillLabel: '' });
  assert.equal(sink.label, 'Receiving');
  assert.equal(sink.fillText, '', 'a sink has no buffer to show');
  assert.equal(stationStatus({ type: 'storage', state: 'full', fill: 7, fillLabel: 'x' }).fill, 1, 'fill is clamped');
  assert.equal(stationStatus({ type: 'storage', state: 'weird', fill: NaN, fillLabel: 'x' }).tone, 'idle', 'unknown states read as idle');
});

// ---- deleting a selection --------------------------------------------------------------------------------

test('removeSelection deletes stations (with their flows), obstacles, labels and road cells', () => {
  const layout = plant();
  const ids = layout.stations.map((s) => s.id);
  assert.equal(removeSelection(layout, 'station', [ids[0], 'nope']), 1, 'unknown ids are not counted');
  assert.equal(layout.flows.length, 0, 'the flow of the deleted station went with it');
  assert.equal(removeSelection(layout, 'obstacle', [layout.obstacles[0].id]), 1);
  assert.equal(removeSelection(layout, 'label', [layout.labels[0].id]), 1);
  assert.equal(removeSelection(layout, 'cell', ['5,3', '6,3']), 2);
  assert.equal(roadAt(layout, 5, 3), null);
  assert.equal(removeSelection(layout, 'flow', ['f1']), 0, 'flows are not deleted from here');
  assert.deepEqual(checkInvariants(layout), []);
});

// ---- what-if ---------------------------------------------------------------------------------------------

test('formatFactor drops trailing zeros', () => {
  assert.equal(formatFactor(1), '1×');
  assert.equal(formatFactor(1.25), '1.25×');
  assert.equal(formatFactor(0.2), '0.2×');
  assert.equal(formatFactor(1.1500000000000001), '1.15×');
});

test('factorSummary names only the factors that were changed', () => {
  assert.deepEqual(factorSummary({ demandFactor: 1, speedFactor: 1, processFactor: 1 }), { changed: [], text: 'All factors at 1×' });
  const some = factorSummary({ demandFactor: 1.5, speedFactor: 1, processFactor: 1.2 });
  assert.deepEqual(some.changed, ['demandFactor', 'processFactor']);
  assert.equal(some.text, 'Demand 1.5×, process time 1.2×');
  assert.equal(factorSummary({ demandFactor: 1, speedFactor: 0.5, processFactor: 1 }).text, 'Vehicle speed 0.5×');
});

test('nextSeed gives a friendly seed that differs from the current one', () => {
  assert.equal(nextSeed(1, () => 0.5), 500000);
  assert.equal(nextSeed(1, () => 0), 2, 'never the current seed');
  assert.equal(nextSeed(999999, () => 0.9999999), 1, 'wraps instead of repeating');
  for (const r of [0, 0.123, 0.5, 0.9999999]) {
    const seed = nextSeed(42, () => r);
    assert.ok(Number.isInteger(seed) && seed >= 1 && seed <= 999999 && seed !== 42);
  }
});

test('measuredWindow warns when the warm-up swallows the run', () => {
  assert.equal(measuredWindow(600, 28800).warn, false);
  assert.match(measuredWindow(600, 28800).text, /last 7\.8 h/);
  assert.equal(measuredWindow(28800, 28800).warn, true);
  assert.equal(measuredWindow(40000, 28800).warn, true);
});

// ---- checks ----------------------------------------------------------------------------------------------

const issue = (id, severity, refs = {}) => ({ id, severity, code: id, message: id, hint: '', refs });

test('groupIssues splits by severity and hides only dismissed notes', () => {
  const issues = [issue('e1', 'error'), issue('w1', 'warning'), issue('i1', 'info'), issue('i2', 'info'), issue('w2', 'warning')];
  const all = groupIssues(issues);
  assert.deepEqual([all.error.length, all.warning.length, all.info.length, all.hidden], [1, 2, 2, 0]);
  const some = groupIssues(issues, new Set(['i1', 'e1', 'w1']));
  assert.deepEqual([some.error.length, some.warning.length, some.info.length, some.hidden], [1, 2, 1, 1], 'errors and warnings cannot be dismissed');
  assert.deepEqual(groupIssues([]), { error: [], warning: [], info: [], hidden: 0 });
});

test('focusTarget maps issue refs to the arguments of ctx.actions.focus', () => {
  assert.deepEqual(focusTarget({ stationId: 's1', flowId: 'f2' }), { stationIds: ['s1'], flowIds: ['f2'] });
  assert.deepEqual(focusTarget({ fleetId: 'v1' }), { fleetIds: ['v1'] });
  assert.deepEqual(focusTarget({ cells: [[1, 2], [3, 4]] }), { cells: [[1, 2], [3, 4]] });
  assert.equal(focusTarget({}), null, 'plant-wide issues point at nothing');
  assert.equal(focusTarget({ cells: [] }), null);
  assert.equal(focusTarget(undefined), null);
});
