import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectedItems, isMovable, checkMove, applyMove, selectionBounds, duplicateOffset, applyDuplicate, itemsText,
} from '../js/ui/editor/moves.js';
import { checkInvariants, getStation } from '../js/model/layout.js';
import { layoutFromAscii } from './helpers/ascii.js';

// 12 x 8 plant: A (1..3, 1..2) and B (6..7, 1..2) with a flow, a wall, a road on row 4, two labels
function plant() {
  const layout = layoutFromAscii([
    '............',
    '.AAA..BB....',
    '.AAA..BB....',
    '............',
    '......++++..',
    '..#.........',
    '............',
    '............',
  ], { stations: { A: 'source', B: 'process' }, flows: [['A', 'B', { weight: 3 }]] });
  layout.labels.push({ id: 'l1', x: 2.5, y: 6.5, text: 'Dock' }, { id: 'l2', x: 9, y: 6, text: 'Yard', size: 0.5 });
  return layout;
}
const stations = (...ids) => ({ kind: 'station', ids });

test('selectedItems finds the items of the selection kind and skips unknown ids', () => {
  const layout = plant();
  assert.deepEqual(selectedItems(layout, stations('A', 'zzz')).map((s) => s.id), ['A']);
  assert.deepEqual(selectedItems(layout, { kind: 'obstacle', ids: ['o1'] }).map((o) => o.id), ['o1']);
  assert.deepEqual(selectedItems(layout, { kind: 'label', ids: ['l1', 'l2'] }).map((l) => l.id), ['l1', 'l2']);
  assert.deepEqual(selectedItems(layout, { kind: 'flow', ids: ['f1'] }), [], 'flows cannot be moved');
  assert.deepEqual(selectedItems(layout, { kind: null, ids: [] }), []);
});

test('isMovable: stations, obstacles and labels only', () => {
  assert.ok(isMovable(stations('A')));
  assert.ok(isMovable({ kind: 'label', ids: ['l1'] }));
  assert.ok(!isMovable({ kind: 'flow', ids: ['f1'] }));
  assert.ok(!isMovable({ kind: 'cell', ids: ['1,1'] }));
  assert.ok(!isMovable({ kind: 'station', ids: [] }));
  assert.ok(!isMovable({ kind: null, ids: [] }));
});

test('checkMove: a free destination is valid and reports the new rectangles', () => {
  const layout = plant();
  const r = checkMove(layout, stations('A'), 0, 2);
  assert.equal(r.ok, true);
  assert.equal(r.reason, null);
  assert.deepEqual(r.moves[0].from, { x: 1, y: 1, w: 3, h: 2 });
  assert.deepEqual(r.moves[0].to, { x: 1, y: 3, w: 3, h: 2 });
  assert.equal(r.moves[0].type, 'source');
});

test('checkMove: a station may overlap its own old position', () => {
  assert.equal(checkMove(plant(), stations('A'), 1, 0).ok, true);
});

test('checkMove: blocked by stations, obstacles, roads and the edge of the baseplate, with a reason', () => {
  const layout = plant();
  assert.match(checkMove(layout, stations('A'), 4, 0).reason, /another station/);
  assert.match(checkMove(layout, stations('A'), 1, 4).reason, /wall or rack/);
  assert.match(checkMove(layout, stations('B'), 0, 3).reason, /road/);
  assert.match(checkMove(layout, stations('A'), -2, 0).reason, /plant area/);
  assert.match(checkMove(layout, stations('B'), 9, 0).reason, /plant area/);
  assert.equal(checkMove(layout, stations('A'), 4, 0).ok, false);
});

test('checkMove: obstacles are checked against stations and roads too', () => {
  const layout = plant();
  const wall = { kind: 'obstacle', ids: ['o1'] };
  assert.equal(checkMove(layout, wall, 1, 0).ok, true);
  assert.match(checkMove(layout, wall, 0, -4).reason, /another station/);
  assert.match(checkMove(layout, wall, 4, -1).reason, /road/);
});

test('checkMove: a group moves as one, so members may take each other\'s old places', () => {
  const layout = plant();
  const both = stations('A', 'B');
  assert.equal(checkMove(layout, both, 3, 0).ok, true, 'A lands where B was');
  assert.equal(checkMove(layout, both, 5, 0).ok, false, 'B would leave the baseplate');
  assert.equal(checkMove(layout, stations('A'), 3, 0).ok, false, 'on its own A would hit B');
});

test('checkMove: labels only have to stay on the baseplate', () => {
  const layout = plant();
  const l = { kind: 'label', ids: ['l1'] };
  assert.equal(checkMove(layout, l, 3, -2).ok, true);
  assert.deepEqual(checkMove(layout, l, 1, 1).moves[0].to, { x: 3.5, y: 7.5 });
  assert.match(checkMove(layout, l, -3, 0).reason, /plant area/);
  assert.match(checkMove(layout, l, 0, 2).reason, /plant area/);
});

test('checkMove: nothing selected is not a valid move', () => {
  const r = checkMove(plant(), { kind: 'station', ids: ['nope'] }, 1, 0);
  assert.equal(r.ok, false);
  assert.equal(r.moves.length, 0);
});

test('applyMove translates stations and keeps the layout valid; flows stay attached', () => {
  const layout = plant();
  assert.equal(applyMove(layout, stations('A', 'B'), 2, 1), true);
  assert.deepEqual([getStation(layout, 'A').x, getStation(layout, 'A').y], [3, 2]);
  assert.deepEqual([getStation(layout, 'B').x, getStation(layout, 'B').y], [8, 2]);
  assert.equal(layout.flows.length, 1);
  assert.deepEqual(checkInvariants(layout), []);
});

test('applyMove refuses an invalid move and leaves the layout untouched', () => {
  const layout = plant();
  const before = structuredClone(layout);
  assert.equal(applyMove(layout, stations('A'), 4, 0), false);
  assert.deepEqual(layout, before);
});

test('applyMove moves obstacles and labels', () => {
  const layout = plant();
  assert.equal(applyMove(layout, { kind: 'obstacle', ids: ['o1'] }, 0, 1), true);
  assert.equal(layout.obstacles[0].y, 6);
  assert.equal(applyMove(layout, { kind: 'label', ids: ['l1', 'l2'] }, 1, -1), true);
  assert.deepEqual(layout.labels.map((l) => [l.x, l.y]), [[3.5, 5.5], [10, 5]]);
});

test('selectionBounds: union of the items; a label counts as its anchor cell', () => {
  const layout = plant();
  assert.deepEqual(selectionBounds(layout, stations('A', 'B')), { x: 1, y: 1, w: 7, h: 2 });
  assert.deepEqual(selectionBounds(layout, { kind: 'label', ids: ['l1', 'l2'] }), { x: 2, y: 6, w: 8, h: 1 });
  assert.equal(selectionBounds(layout, stations('nope')), null);
});

test('duplicateOffset: the first free spot beside the selection with one empty cell between', () => {
  const layout = plant();
  assert.deepEqual(duplicateOffset(layout, stations('B')), [3, 0], 'B is 2 wide: the copy starts 3 cells to the right');
  assert.deepEqual(duplicateOffset(layout, { kind: 'label', ids: ['l1'] }), [0, 1]);
  assert.equal(duplicateOffset(layout, stations('A')), null, 'right is B, below is the wall, left and above leave the plate, the diagonal hits the road');
});

test('duplicateOffset: tries the left and the top when right and bottom are taken or off the plate', () => {
  const layout = layoutFromAscii(['........', '........', '........', '.......B', '.......B', '........', '........', '........'], { stations: { B: 'process' } });
  assert.deepEqual(duplicateOffset(layout, stations('B')), [0, 3], 'right is off the plate; below is free');
  const low = layoutFromAscii(['........', '........', '........', '........', '........', '........', '.......B', '.......B'], { stations: { B: 'process' } });
  assert.deepEqual(duplicateOffset(low, stations('B')), [-2, 0], 'right and below are off the plate: the copy goes to the left');
});

test('duplicateOffset: null when there is no room anywhere', () => {
  const layout = layoutFromAscii(['AAAAAAAA', 'AAAAAAAA', 'AAAAAAAA', 'AAAAAAAA', 'AAAAAAAA', 'AAAAAAAA', 'AAAAAAAA', 'AAAAAAAA'], { stations: { A: 'storage' } });
  assert.equal(duplicateOffset(layout, stations('A')), null);
});

test('applyDuplicate: copies a station next to the original with its settings and a fresh name', () => {
  const layout = plant();
  getStation(layout, 'B').params.cycle = { kind: 'const', mean: 33, spread: 0 };
  const created = applyDuplicate(layout, stations('B'), [3, 0]);
  assert.equal(created.kind, 'station');
  assert.equal(created.ids.length, 1);
  const copy = getStation(layout, created.ids[0]);
  assert.deepEqual([copy.x, copy.y, copy.w, copy.h], [9, 1, 2, 2]);
  assert.equal(copy.params.cycle.mean, 33);
  assert.notEqual(copy.name, 'B');
  assert.deepEqual(checkInvariants(layout), []);
  assert.equal(layout.flows.length, 1, 'a single copied station gets no flows');
});

test('applyDuplicate: a group keeps its internal flows (with their settings) between the copies', () => {
  const layout = plant();
  const created = applyDuplicate(layout, stations('A', 'B'), [0, 3]);
  assert.equal(created.ids.length, 2);
  assert.equal(layout.flows.length, 2);
  const copied = layout.flows[1];
  assert.deepEqual([copied.from, copied.to], created.ids);
  assert.equal(copied.weight, 3);
  assert.deepEqual(checkInvariants(layout), []);
});

test('applyDuplicate: without an offset the model looks for the nearest free spot', () => {
  const layout = plant();
  const created = applyDuplicate(layout, stations('A'), null);
  assert.equal(created.ids.length, 1);
  assert.deepEqual(checkInvariants(layout), []);
});

test('applyDuplicate: obstacles and labels are copied at the offset', () => {
  const layout = plant();
  const o = applyDuplicate(layout, { kind: 'obstacle', ids: ['o1'] }, [3, 0]);
  assert.deepEqual([layout.obstacles[1].x, layout.obstacles[1].y, layout.obstacles[1].kind], [5, 5, 'wall']);
  assert.equal(o.ids[0], layout.obstacles[1].id);
  const l = applyDuplicate(layout, { kind: 'label', ids: ['l2'] }, [0, 1]);
  const copy = layout.labels.find((x) => x.id === l.ids[0]);
  assert.deepEqual([copy.x, copy.y, copy.text, copy.size], [9, 7, 'Yard', 0.5]);
});

test('applyDuplicate returns null when nothing could be copied', () => {
  const layout = plant();
  assert.equal(applyDuplicate(layout, { kind: 'obstacle', ids: ['o1'] }, [0, 50]), null);
  assert.equal(layout.obstacles.length, 1);
});

test('itemsText names an undo step: the thing for one item, a count for several', () => {
  const layout = plant();
  assert.equal(itemsText(layout, stations('A')), 'station');
  assert.equal(itemsText(layout, stations('A', 'B')), '2 items');
  assert.equal(itemsText(layout, { kind: 'obstacle', ids: ['o1'] }), 'wall');
  assert.equal(itemsText(layout, { kind: 'label', ids: ['l1'] }), 'label');
  assert.equal(itemsText(layout, { kind: 'flow', ids: ['f1'] }), 'flow');
  assert.equal(itemsText(layout, { kind: 'cell', ids: ['6,4'] }), 'road');
});
