import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapRect, dragRect, blockReason, sizeText, clampCell, dragThreshold, DRAG_PX } from '../js/ui/editor/snapping.js';
import { resizeRect, HANDLES, isHandle } from '../js/ui/editor/resize.js';
import { HANDLE_NAMES } from '../js/ui/render/geometry.js';
import { layoutFromAscii } from './helpers/ascii.js';

const grid = { cols: 20, rows: 12 };

test('snapRect: odd sizes are centred on the pointer cell, even sizes snap to the nearest grid line', () => {
  assert.deepEqual(snapRect(5.5, 5.5, 3, 3, grid), { x: 4, y: 4, w: 3, h: 3 });
  assert.deepEqual(snapRect(5.1, 5.9, 3, 3, grid), { x: 4, y: 4, w: 3, h: 3 }, 'anywhere inside the cell gives the same brick');
  assert.deepEqual(snapRect(5.2, 5.2, 2, 2, grid), { x: 4, y: 4, w: 2, h: 2 });
  assert.deepEqual(snapRect(5.8, 5.8, 2, 2, grid), { x: 5, y: 5, w: 2, h: 2 });
  assert.deepEqual(snapRect(5.5, 5.5, 1, 1, grid), { x: 5, y: 5, w: 1, h: 1 });
});

test('snapRect: the brick is pushed back inside the baseplate and never larger than it', () => {
  assert.deepEqual(snapRect(0.5, 0.5, 3, 3, grid), { x: 0, y: 0, w: 3, h: 3 });
  assert.deepEqual(snapRect(19.5, 11.5, 3, 3, grid), { x: 17, y: 9, w: 3, h: 3 });
  assert.deepEqual(snapRect(-5, -5, 3, 2, grid), { x: 0, y: 0, w: 3, h: 2 });
  assert.deepEqual(snapRect(10, 6, 30, 30, grid), { x: 0, y: 0, w: 20, h: 12 });
});

test('dragRect: both press and pointer cell are inside, from any direction, at least 1 x 1, clipped to the grid', () => {
  assert.deepEqual(dragRect([3, 3], [3, 3], grid), { x: 3, y: 3, w: 1, h: 1 });
  assert.deepEqual(dragRect([3, 3], [6, 5], grid), { x: 3, y: 3, w: 4, h: 3 });
  assert.deepEqual(dragRect([6, 5], [3, 3], grid), { x: 3, y: 3, w: 4, h: 3 });
  assert.deepEqual(dragRect([3, 5], [6, 3], grid), { x: 3, y: 3, w: 4, h: 3 });
  assert.deepEqual(dragRect([3, 3], [99, -4], grid), { x: 3, y: 0, w: 17, h: 4 });
});

test('clampCell pulls any cell inside the grid', () => {
  assert.deepEqual(clampCell(-3, 4, grid), [0, 4]);
  assert.deepEqual(clampCell(25, 30, grid), [19, 11]);
  assert.deepEqual(clampCell(7, 7, grid), [7, 7]);
});

test('dragThreshold: touch needs more travel than mouse and pen; unknown types count as mouse', () => {
  assert.ok(dragThreshold('touch') > dragThreshold('mouse'));
  assert.equal(dragThreshold('pen'), DRAG_PX.pen);
  assert.equal(dragThreshold(undefined), DRAG_PX.mouse);
});

test('blockReason names what is in the way, and ignores the item being moved', () => {
  const layout = layoutFromAscii(['........', '.AA..#..', '.AA.....', '...++...', '........', '........', '........', '........']);
  assert.equal(blockReason(layout, { x: 4, y: 4, w: 2, h: 2 }), null);
  assert.equal(blockReason(layout, { x: 2, y: 1, w: 2, h: 1 }), 'another station is in the way');
  assert.equal(blockReason(layout, { x: 5, y: 1, w: 1, h: 2 }), 'a wall or rack is in the way');
  assert.equal(blockReason(layout, { x: 3, y: 3, w: 1, h: 1 }), 'a road is in the way');
  assert.equal(blockReason(layout, { x: 7, y: 6, w: 2, h: 1 }), 'it would leave the plant area');
  assert.equal(blockReason(layout, { x: -1, y: 0, w: 1, h: 1 }), 'it would leave the plant area');
  assert.equal(blockReason(layout, { x: 1, y: 1, w: 2, h: 2 }, { ignoreStation: 'A' }), null, 'a station does not block itself');
  assert.equal(blockReason(layout, { x: 1, y: 1, w: 2, h: 2 }), 'another station is in the way');
});

test('sizeText shows cells and metres', () => {
  assert.equal(sizeText({ w: 4, h: 3 }, 2), '4 × 3 cells (8 × 6 m)');
  assert.equal(sizeText({ w: 1, h: 1 }, 0.5), '1 × 1 cells (0.5 × 0.5 m)');
});

// ---- resize ----

const R = { x: 5, y: 4, w: 4, h: 3 }; // right edge 9, bottom edge 7

test('resizeRect: each handle moves only its own edges', () => {
  assert.deepEqual(resizeRect(R, 'e', 2, 9, grid), { x: 5, y: 4, w: 6, h: 3 });
  assert.deepEqual(resizeRect(R, 'w', -2, 9, grid), { x: 3, y: 4, w: 6, h: 3 });
  assert.deepEqual(resizeRect(R, 's', 9, 2, grid), { x: 5, y: 4, w: 4, h: 5 });
  assert.deepEqual(resizeRect(R, 'n', 9, -2, grid), { x: 5, y: 2, w: 4, h: 5 });
  assert.deepEqual(resizeRect(R, 'se', 1, 2, grid), { x: 5, y: 4, w: 5, h: 5 });
  assert.deepEqual(resizeRect(R, 'nw', -1, -2, grid), { x: 4, y: 2, w: 5, h: 5 });
  assert.deepEqual(resizeRect(R, 'ne', 3, -1, grid), { x: 5, y: 3, w: 7, h: 4 });
  assert.deepEqual(resizeRect(R, 'sw', -2, 3, grid), { x: 3, y: 4, w: 6, h: 6 });
});

test('resizeRect: shrinking works from every side', () => {
  assert.deepEqual(resizeRect(R, 'e', -2, 0, grid), { x: 5, y: 4, w: 2, h: 3 });
  assert.deepEqual(resizeRect(R, 'w', 2, 0, grid), { x: 7, y: 4, w: 2, h: 3 });
  assert.deepEqual(resizeRect(R, 's', 0, -1, grid), { x: 5, y: 4, w: 4, h: 2 });
  assert.deepEqual(resizeRect(R, 'n', 0, 1, grid), { x: 5, y: 5, w: 4, h: 2 });
});

test('resizeRect: never smaller than one cell; the dragged edge stops at the opposite edge', () => {
  assert.deepEqual(resizeRect(R, 'e', -50, 0, grid), { x: 5, y: 4, w: 1, h: 3 });
  assert.deepEqual(resizeRect(R, 'w', 50, 0, grid), { x: 8, y: 4, w: 1, h: 3 });
  assert.deepEqual(resizeRect(R, 's', 0, -50, grid), { x: 5, y: 4, w: 4, h: 1 });
  assert.deepEqual(resizeRect(R, 'n', 0, 50, grid), { x: 5, y: 6, w: 4, h: 1 });
  assert.deepEqual(resizeRect(R, 'nw', 50, 50, grid), { x: 8, y: 6, w: 1, h: 1 });
  assert.deepEqual(resizeRect(R, 'se', -50, -50, grid), { x: 5, y: 4, w: 1, h: 1 });
  assert.deepEqual(resizeRect({ x: 2, y: 2, w: 1, h: 1 }, 'e', -3, 0, grid), { x: 2, y: 2, w: 1, h: 1 }, 'a 1 x 1 brick cannot shrink further');
  assert.deepEqual(resizeRect(R, 'e', -3, 0, grid, 2), { x: 5, y: 4, w: 2, h: 3 }, 'a larger minimum is honoured');
});

test('resizeRect: clamped to the baseplate on every side', () => {
  assert.deepEqual(resizeRect(R, 'e', 99, 0, grid), { x: 5, y: 4, w: 15, h: 3 });
  assert.deepEqual(resizeRect(R, 'w', -99, 0, grid), { x: 0, y: 4, w: 9, h: 3 });
  assert.deepEqual(resizeRect(R, 's', 0, 99, grid), { x: 5, y: 4, w: 4, h: 8 });
  assert.deepEqual(resizeRect(R, 'n', 0, -99, grid), { x: 5, y: 0, w: 4, h: 7 });
  assert.deepEqual(resizeRect(R, 'se', 99, 99, grid), { x: 5, y: 4, w: 15, h: 8 });
  assert.deepEqual(resizeRect(R, 'nw', -99, -99, grid), { x: 0, y: 0, w: 9, h: 7 });
});

test('resizeRect: a zero drag returns the same rectangle for all eight handles', () => {
  for (const handle of HANDLES) assert.deepEqual(resizeRect(R, handle, 0, 0, grid), R, handle);
});

test('HANDLES are the renderer\'s handle names, and isHandle recognises exactly those', () => {
  assert.deepEqual([...HANDLES].sort(), [...HANDLE_NAMES].sort());
  assert.ok(isHandle('ne'));
  assert.ok(!isHandle('move'));
  assert.ok(!isHandle(undefined));
});
