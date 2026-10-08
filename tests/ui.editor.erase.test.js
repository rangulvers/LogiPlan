import { test } from 'node:test';
import assert from 'node:assert/strict';
import { carveRect, eraseCells, eraseLabel } from '../js/ui/editor/erase.js';
import { checkInvariants, hasLink, roadAt } from '../js/model/layout.js';
import { layoutFromAscii } from './helpers/ascii.js';

const area = (r) => r.w * r.h;
const cellsOf = (rects) => new Set(rects.flatMap((r) => { const c = []; for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) c.push(`${x},${y}`); return c; }));

test('carveRect: cutting a cell out of a long thin wall leaves the two halves', () => {
  assert.deepEqual(carveRect({ x: 2, y: 3, w: 6, h: 1 }, 4, 3), [{ x: 2, y: 3, w: 2, h: 1 }, { x: 5, y: 3, w: 3, h: 1 }]);
  assert.deepEqual(carveRect({ x: 2, y: 3, w: 1, h: 5 }, 2, 5), [{ x: 2, y: 3, w: 1, h: 2 }, { x: 2, y: 6, w: 1, h: 2 }]);
});

test('carveRect: an end cell leaves one piece, a single cell leaves nothing', () => {
  assert.deepEqual(carveRect({ x: 2, y: 3, w: 6, h: 1 }, 2, 3), [{ x: 3, y: 3, w: 5, h: 1 }]);
  assert.deepEqual(carveRect({ x: 2, y: 3, w: 6, h: 1 }, 7, 3), [{ x: 2, y: 3, w: 5, h: 1 }]);
  assert.deepEqual(carveRect({ x: 2, y: 3, w: 1, h: 1 }, 2, 3), []);
});

test('carveRect: a cell in the middle of a block leaves four pieces that cover exactly the other cells', () => {
  const block = { x: 1, y: 1, w: 5, h: 4 };
  const pieces = carveRect(block, 3, 2);
  assert.equal(pieces.length, 4);
  assert.equal(pieces.reduce((n, r) => n + area(r), 0), area(block) - 1);
  const covered = cellsOf(pieces);
  assert.equal(covered.size, area(block) - 1, 'no overlaps');
  assert.ok(!covered.has('3,2'));
});

function plant() {
  const layout = layoutFromAscii([
    '..........',
    '.########.',
    '..........',
    '.++++++...',
    '..#.......',
    '..........',
    '..........',
    '..........',
  ]);
  layout.obstacles = [{ id: 'o1', x: 1, y: 1, w: 8, h: 1, kind: 'wall' }, { id: 'o2', x: 2, y: 4, w: 1, h: 1, kind: 'column' }];
  layout.labels.push({ id: 'l1', x: 5, y: 6, text: 'Dock' }, { id: 'l2', x: 7, y: 6, text: 'Yard' });
  return layout;
}

test('eraseCells: a road cell goes and the links of its neighbours into it go with it', () => {
  const layout = plant();
  const r = eraseCells(layout, [[3, 3]], []);
  assert.deepEqual(r, { roads: 1, obstacles: 0, labels: 0, kinds: [] });
  assert.equal(roadAt(layout, 3, 3), null);
  assert.equal(hasLink(layout, 2, 3, 1), false);
  assert.equal(hasLink(layout, 4, 3, 3), false);
  assert.equal(hasLink(layout, 4, 3, 1), true, 'the rest of the road is untouched');
  assert.deepEqual(checkInvariants(layout), []);
});

test('eraseCells: one cell of a wall opens a gap, the rest stays as two walls of the same kind', () => {
  const layout = plant();
  const r = eraseCells(layout, [[4, 1]], []);
  assert.deepEqual(r, { roads: 0, obstacles: 1, labels: 0, kinds: ['wall'] });
  const walls = layout.obstacles.filter((o) => o.kind === 'wall').map((o) => [o.x, o.w]).sort((a, b) => a[0] - b[0]);
  assert.deepEqual(walls, [[1, 3], [5, 4]]);
  assert.equal(layout.obstacles.find((o) => o.id === 'o1').x, 1, 'the first piece keeps the original id');
  assert.deepEqual(checkInvariants(layout), []);
});

test('eraseCells: a single-cell obstacle disappears; empty cells do nothing', () => {
  const layout = plant();
  assert.deepEqual(eraseCells(layout, [[2, 4]], []), { roads: 0, obstacles: 1, labels: 0, kinds: ['column'] });
  assert.equal(layout.obstacles.some((o) => o.id === 'o2'), false);
  const before = structuredClone(layout);
  assert.deepEqual(eraseCells(layout, [[9, 7], [0, 0]], []), { roads: 0, obstacles: 0, labels: 0, kinds: [] });
  assert.deepEqual(layout, before);
});

test('eraseCells: sweeping the whole wall removes it; repeated cells are harmless', () => {
  const layout = plant();
  const row = [1, 2, 3, 4, 5, 6, 7, 8, 4, 4].map((x) => [x, 1]);
  assert.equal(eraseCells(layout, row, []).obstacles, 8);
  assert.equal(layout.obstacles.some((o) => o.kind === 'wall'), false);
});

test('eraseCells: erases labels by id, roads and walls together, and says what it did', () => {
  const layout = plant();
  const r = eraseCells(layout, [[3, 3], [4, 1]], ['l2', 'nope']);
  assert.deepEqual(r, { roads: 1, obstacles: 1, labels: 1, kinds: ['wall'] });
  assert.deepEqual(layout.labels.map((l) => l.id), ['l1']);
});

test('eraseLabel names the undo step after what was removed', () => {
  assert.equal(eraseLabel({ roads: 3, obstacles: 0, labels: 0, kinds: [] }), 'Erase road');
  assert.equal(eraseLabel({ roads: 0, obstacles: 2, labels: 0, kinds: ['wall'] }), 'Erase wall');
  assert.equal(eraseLabel({ roads: 0, obstacles: 2, labels: 0, kinds: ['rack'] }), 'Erase rack');
  assert.equal(eraseLabel({ roads: 0, obstacles: 2, labels: 0, kinds: ['rack', 'column'] }), 'Erase obstacle');
  assert.equal(eraseLabel({ roads: 0, obstacles: 0, labels: 1, kinds: [] }), 'Erase label');
  assert.equal(eraseLabel({ roads: 1, obstacles: 1, labels: 0, kinds: ['wall'] }), 'Erase');
  assert.equal(eraseLabel({ roads: 0, obstacles: 0, labels: 0, kinds: [] }), 'Erase');
});
