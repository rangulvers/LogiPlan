// The plan that grows with the work (js/ui/editor/grow.js and its use in js/ui/editor.js and the tools): the pure rules (how many
// blocks, the limit, auto-pan, the camera that keeps still, the '+' chips) and the Editor end to end in Node with a minimal fake browser:
// a road, a brick or a label beyond the edge grows the plan in the same undo step, nothing moves on screen, undo and redo take it back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../js/ui/editor.js';
import { createStore } from '../js/store/store.js';
import { Camera } from '../js/ui/camera.js';
import { createLayout, paintRoadPath, addStation, addObstacle, addLabel, checkInvariants, growGrid, trimGrid } from '../js/model/layout.js';
import { GRID_LIMITS } from '../js/model/defaults.js';
import { hitHandle, pointInRect } from '../js/ui/render/geometry.js';
import * as G from '../js/ui/editor/grow.js';
import { checkMove } from '../js/ui/editor/moves.js';
import { resizeRect } from '../js/ui/editor/resize.js';
import { clipStroke } from '../js/ui/editor/paths.js';

const MAX = GRID_LIMITS.maxCols;
const grid = (cols = 40, rows = 24) => ({ cols, rows, cellSize: 2 });
const ext = (x0, y0, x1, y1) => ({ x0, y0, x1, y1 });

// ---- pure: how many blocks ----------------------------------------------------------------------------------------------

test('blocksFor: whole blocks of 8 cells with one cell to spare; nothing needed, nothing added', () => {
  assert.equal(G.BLOCK, 8);
  assert.deepEqual([0, -3].map((n) => G.blocksFor(n)), [0, 0]);
  assert.deepEqual([1, 2, 7].map((n) => G.blocksFor(n)), [1, 1, 1], '7 cells + 1 spare = 8: one block');
  assert.deepEqual([8, 9, 15].map((n) => G.blocksFor(n)), [2, 2, 2], '8 cells + 1 spare = 9: two blocks');
  assert.equal(G.blocksFor(16), 3);
  assert.equal(G.blocksFor(5, { block: 4, margin: 0 }), 2);
});

test('planGrowth: nothing to do inside the plan, also for an edit that touches the last cell', () => {
  for (const e of [null, undefined, ext(0, 0, 1, 1), ext(0, 0, 40, 24), ext(10, 5, 20, 9)]) {
    const p = G.planGrowth(grid(), e);
    assert.deepEqual([p.grows, p.ok, p.left, p.top, p.right, p.bottom, p.cols, p.rows], [false, true, 0, 0, 0, 0, 40, 24], JSON.stringify(e));
  }
  assert.equal(G.planGrowth(grid(), ext(NaN, 0, 5, 5)).grows, false, 'junk extents are ignored');
});

test('planGrowth: each side grows by whole blocks that hold the edit and one cell more', () => {
  assert.deepEqual(pick(G.planGrowth(grid(), ext(30, 5, 41, 9))), { left: 0, top: 0, right: 8, bottom: 0, cols: 48, rows: 24 }, 'one cell beyond the right edge: one block');
  assert.deepEqual(pick(G.planGrowth(grid(), ext(30, 5, 47, 9))), { left: 0, top: 0, right: 8, bottom: 0, cols: 48, rows: 24 }, '7 beyond + 1 spare = 8');
  assert.deepEqual(pick(G.planGrowth(grid(), ext(30, 5, 48, 9))), { left: 0, top: 0, right: 16, bottom: 0, cols: 56, rows: 24 }, '8 beyond + 1 spare = 9: two blocks');
  assert.deepEqual(pick(G.planGrowth(grid(), ext(-1, 5, 10, 9))), { left: 8, top: 0, right: 0, bottom: 0, cols: 48, rows: 24 });
  assert.deepEqual(pick(G.planGrowth(grid(), ext(-9, 5, 10, 9))), { left: 16, top: 0, right: 0, bottom: 0, cols: 56, rows: 24 });
  assert.deepEqual(pick(G.planGrowth(grid(), ext(5, -2, 10, 9))), { left: 0, top: 8, right: 0, bottom: 0, cols: 40, rows: 32 });
  assert.deepEqual(pick(G.planGrowth(grid(), ext(5, 5, 10, 25))), { left: 0, top: 0, right: 0, bottom: 8, cols: 40, rows: 32 });
});

test('planGrowth: left and top at once, all four sides, and every axis on its own', () => {
  const both = G.planGrowth(grid(), ext(-3, -12, 10, 9));
  assert.deepEqual(pick(both), { left: 8, top: 16, right: 0, bottom: 0, cols: 48, rows: 40 });
  assert.equal(both.grows && both.ok && !both.limited, true);
  const all = G.planGrowth(grid(), ext(-20, -1, 70, 60));
  assert.deepEqual(pick(all), { left: 24, top: 8, right: 32, bottom: 40, cols: 96, rows: 72 });
  assert.deepEqual(G.sidesOf(all), { left: 24, top: 8, right: 32, bottom: 40 });
});

test('planGrowth: the limit. Whole blocks give way to what fits; an edit that cannot fit is refused (and shows the most there is)', () => {
  const big = { cols: MAX - 10, rows: 24 };
  const roomy = G.planGrowth(big, ext(0, 0, MAX - 10 + 5, 5));
  assert.deepEqual([roomy.ok, roomy.limited, roomy.cols], [true, false, MAX - 2], '5 cells + 1 spare = one block of 8, and 10 are left: fine');
  const squeezed = G.planGrowth(big, ext(0, 0, MAX - 10 + 9, 5));
  assert.deepEqual([squeezed.ok, squeezed.limited, squeezed.right, squeezed.cols], [true, true, 10, MAX], '9 cells need 2 blocks = 16, only 10 are left: the edit fits, the rest of the room goes to it');
  const tight = G.planGrowth({ cols: MAX - 5, rows: 24 }, ext(0, 0, MAX - 5 + 5, 5));
  assert.deepEqual([tight.ok, tight.limited, tight.right, tight.cols], [true, true, 5, MAX], 'the edit needs 5 of the 5 cells left: the spare cell and the rest of the block are dropped');
  const refused = G.planGrowth({ cols: MAX - 5, rows: 24 }, ext(0, 0, MAX + 1, 5));
  assert.deepEqual([refused.ok, refused.reason, refused.right], [false, 'limit', 5], 'needs 6, only 5 left');
  const full = G.planGrowth({ cols: MAX, rows: MAX }, ext(-1, 0, 5, 5));
  assert.deepEqual([full.ok, full.left], [false, 0]);
  const sum = G.planGrowth({ cols: MAX - 10, rows: 24 }, ext(-6, 0, MAX - 10 + 6, 5));
  assert.equal(sum.ok, false, 'left 6 + right 6 do not fit into 10 cells');
  const exact = G.planGrowth({ cols: MAX - 10, rows: 24 }, ext(-5, 0, MAX - 10 + 5, 5));
  assert.deepEqual([exact.ok, exact.left, exact.right, exact.cols], [true, 5, 5, MAX], 'left 5 + right 5 use exactly the 10 cells');
  assert.equal(G.limitText(), `The plan cannot grow beyond ${MAX} × ${MAX} cells.`);
});

test('describeGrowth and sizeLine: short plain sentences', () => {
  assert.equal(G.describeGrowth(G.planGrowth(grid(), ext(30, 5, 45, 9))), 'The plan grows by 8 columns on the right.');
  assert.equal(G.describeGrowth(G.planGrowth(grid(), ext(-3, 5, 10, 26))), 'The plan grows by 8 columns on the left and 8 rows below.');
  assert.equal(G.describeGrowth(G.planGrowth(grid(), ext(-3, -3, 45, 9))), 'The plan grows by 8 columns on the left, 8 rows above and 8 columns on the right.');
  assert.equal(G.describeGrowth(G.planGrowth(grid(), ext(0, 0, 5, 5))), '');
  assert.equal(G.describeGrowth(G.planGrowth({ cols: MAX, rows: 24 }, ext(0, 0, MAX + 1, 5))), G.limitText());
  assert.equal(G.sizeLine(48, 32, 2), '48 × 32 cells, 96 × 64 m');
  assert.equal(G.sizeLine(40, 24, 2.5), '40 × 24 cells, 100 × 60 m');
});

test('blockPlan: one block on one side, less near the limit, none at it', () => {
  assert.deepEqual(pick(G.blockPlan(grid(), 'left')), { left: 8, top: 0, right: 0, bottom: 0, cols: 48, rows: 24 });
  assert.deepEqual(pick(G.blockPlan(grid(), 'bottom')), { left: 0, top: 0, right: 0, bottom: 8, cols: 40, rows: 32 });
  const near = G.blockPlan({ cols: MAX - 3, rows: 24 }, 'right');
  assert.deepEqual([near.right, near.ok, near.limited], [3, true, true]);
  const none = G.blockPlan({ cols: MAX, rows: 24 }, 'right');
  assert.deepEqual([none.right, none.ok, none.grows], [0, false, false]);
});

function pick(p) {
  const { left, top, right, bottom, cols, rows } = p;
  return { left, top, right, bottom, cols, rows };
}

// ---- pure: extents, rectangles, reach -------------------------------------------------------------------------------------------------

test('extents of cells, rectangles and moves; union; clipping; shifting', () => {
  assert.equal(G.extentOfCells([]), null);
  assert.deepEqual(G.extentOfCells([[3, 4], [-2, 9], [5, 1]]), ext(-2, 1, 6, 10));
  assert.deepEqual(G.extentOfRect({ x: -4, y: 2, w: 3, h: 2 }), ext(-4, 2, -1, 4));
  assert.deepEqual(G.unionExtent(null, ext(0, 0, 2, 2), ext(-1, 5, 1, 6)), ext(-1, 0, 2, 6));
  assert.equal(G.unionExtent(null, null), null);
  assert.deepEqual(G.clipToGrid({ x: -2, y: 3, w: 5, h: 2 }, grid()), { x: 0, y: 3, w: 3, h: 2 });
  assert.equal(G.clipToGrid({ x: -5, y: 3, w: 3, h: 2 }, grid()), null);
  assert.deepEqual(G.shiftRect({ x: 1, y: 2, w: 3, h: 4 }, { dx: 8, dy: 16 }), { x: 9, y: 18, w: 3, h: 4 });
  const cells = [[1, 2]];
  assert.equal(G.shiftCells(cells, { dx: 0, dy: 0 }), cells, 'no shift, no copy');
  assert.deepEqual(G.shiftCells(cells, { dx: 8, dy: 0 }), [[9, 2]]);
  assert.deepEqual(G.extentOfMoves([{ to: { x: -3, y: 2, w: 2, h: 2 } }, { to: { x: 41.5, y: 3.5 } }]), ext(-3, 2, 42, 4), 'a label counts as the cell of its anchor');
  assert.deepEqual(G.labelExtent(grid(), 10, 10), ext(0, 0, 1, 1), 'on the baseplate: nothing');
  assert.deepEqual(G.labelExtent(grid(), 40, 24), ext(0, 0, 1, 1), 'on the far edge: still nothing (labels may sit on it)');
  assert.deepEqual(G.labelExtent(grid(), -0.5, 30), ext(-1, 0, 1, 30));
  assert.equal(G.planGrowth(grid(), G.labelExtent(grid(), 40.5, 5)).right, 8);
});

test('reach: a pointer far beyond the plan counts as the farthest cell the plan could ever grow to; chips and strokes stay bounded', () => {
  const g = grid();
  assert.deepEqual(G.reachPoint(5.5, 7.5, g), [5.5, 7.5]);
  assert.deepEqual(G.reachPoint(1e6, -1e6, g), [g.cols + G.REACH, -G.REACH]);
  assert.deepEqual(G.pointerBeyond(g, 20, 10), { x: false, y: false });
  assert.deepEqual(G.pointerBeyond(g, -0.1, 10), { x: true, y: false });
  assert.deepEqual(G.pointerBeyond(g, 40, 24), { x: true, y: true }, 'the line after the last column is outside');
  assert.equal(G.inReach(g, -(MAX - 40), 0), true);
  assert.equal(G.inReach(g, -(MAX - 40) - 1, 0), false);
  assert.equal(G.inReach(g, 39 + (MAX - 40), 0), true);
  assert.equal(G.inReach(g, 40 + (MAX - 40), 0), false);
  assert.deepEqual(G.snapRectBeyond(20.2, 10.2, 3, 2, g), { x: 19, y: 9, w: 3, h: 2 }, 'inside: as before');
  assert.deepEqual(G.snapRectBeyond(0.3, 10.2, 3, 2, g), { x: 0, y: 9, w: 3, h: 2 }, 'inside near the edge: pushed in, not out');
  assert.deepEqual(G.snapRectBeyond(-3.2, 10.2, 3, 2, g), { x: -5, y: 9, w: 3, h: 2 }, 'the pointer is beyond the left edge: the brick follows it out');
  assert.deepEqual(G.snapRectBeyond(41.5, 30.5, 3, 2, g), { x: 40, y: 30, w: 3, h: 2 }, 'beyond right and below');
  assert.deepEqual(G.dragRectBeyond([-3, 5], [4, 8]), { x: -3, y: 5, w: 8, h: 4 });
  assert.deepEqual(G.dragRectBeyond([50, 30], [45, 26]), { x: 45, y: 26, w: 6, h: 5 });
});

test('blockReasonGrowing: free ground beyond the edge, stations and walls still block, the pointer decides which axes may leave', () => {
  const layout = createLayout({ cols: 40, rows: 24 });
  addStation(layout, { type: 'source', x: 2, y: 2, w: 3, h: 2 });
  paintRoadPath(layout, [[10, 10], [12, 10]]);
  const both = { x: true, y: true };
  assert.equal(G.blockReasonGrowing(layout, { x: 30, y: 5, w: 3, h: 2 }, {}, both), null);
  assert.equal(G.blockReasonGrowing(layout, { x: 38, y: 5, w: 5, h: 2 }, {}, both), null, 'sticks out on the right: the plan grows');
  assert.equal(G.blockReasonGrowing(layout, { x: -2, y: 1, w: 5, h: 2 }, {}, both), 'another station is in the way', 'the part on the baseplate is checked');
  assert.equal(G.blockReasonGrowing(layout, { x: 9, y: 9, w: 3, h: 2 }, {}, both), 'a road is in the way');
  assert.equal(G.blockReasonGrowing(layout, { x: 38, y: 5, w: 5, h: 2 }, {}, { x: false, y: true }), 'it would leave the plant area');
  assert.equal(G.blockReasonGrowing(layout, { x: 5, y: 22, w: 3, h: 4 }, {}, { x: true, y: false }), 'it would leave the plant area');
  assert.equal(G.blockReasonGrowing(layout, { x: 5, y: 22, w: 3, h: 4 }, {}, both), null);
  assert.equal(G.blockReasonGrowing(layout, { x: MAX + 2, y: 5, w: 3, h: 2 }, {}, both), `the plan cannot grow beyond ${MAX} × ${MAX} cells`);
  assert.equal(G.blockReasonGrowing(layout, { x: 2, y: 2, w: 3, h: 2 }, { ignoreStation: 's1' }, both), null, 'the item that moves does not block itself');
});

test('checkMove with growth: items may leave on the axes the pointer is beyond; labels too; the limit refuses', () => {
  const layout = createLayout({ cols: 40, rows: 24 });
  addStation(layout, { type: 'source', x: 30, y: 5, w: 3, h: 2 });
  layout.labels.push({ id: 'l1', x: 10, y: 5, text: 'x' });
  const sel = { kind: 'station', ids: ['s1'] };
  assert.equal(checkMove(layout, sel, 8, 0).ok, false, 'without the pointer beyond the edge: refused as before');
  assert.equal(checkMove(layout, sel, 8, 0).reason, 'it would leave the plant area');
  assert.equal(checkMove(layout, sel, 8, 0, { x: true, y: false }).ok, true);
  assert.equal(checkMove(layout, sel, 8, 8, { x: true, y: false }).ok, true, 'the y part stays inside: 5 + 8 = 13');
  assert.equal(checkMove(layout, sel, 0, 30, { x: true, y: false }).ok, false, 'y would leave but the pointer is not beyond the bottom edge');
  assert.equal(checkMove(layout, sel, 400, 0, { x: true, y: false }).reason, `the plan cannot grow beyond ${MAX} × ${MAX} cells`);
  const label = { kind: 'label', ids: ['l1'] };
  assert.equal(checkMove(layout, label, 40, 0).ok, false);
  assert.equal(checkMove(layout, label, 40, 0, { x: true, y: false }).ok, true);
  assert.equal(checkMove(layout, label, 0, 40, { x: true, y: false }).ok, false);
  assert.equal(checkMove(layout, label, 1000, 0, { x: true, y: true }).ok, false);
});

test('resizeRect and clipStroke with growth', () => {
  const rect = { x: 30, y: 5, w: 4, h: 3 };
  assert.deepEqual(resizeRect(rect, 'e', 20, 0, grid()), { x: 30, y: 5, w: 10, h: 3 }, 'clamped to the baseplate, as before');
  assert.deepEqual(resizeRect(rect, 'e', 20, 0, grid(), 1, { x: true, y: false }), { x: 30, y: 5, w: 24, h: 3 });
  assert.deepEqual(resizeRect(rect, 'nw', -40, -10, grid(), 1, { x: true, y: true }), { x: -10, y: -5, w: 44, h: 13 });
  assert.deepEqual(resizeRect(rect, 'w', 50, 0, grid(), 1, { x: true, y: true }), { x: 33, y: 5, w: 1, h: 3 }, 'the dragged edge still stops at the opposite one');
  const layout = createLayout({ cols: 40, rows: 24 });
  addStation(layout, { type: 'sink', x: 20, y: 10, w: 3, h: 2 });
  const stroke = [[18, 10], [19, 10], [20, 10], [21, 10]];
  assert.equal(clipStroke(layout, stroke, { grow: true }).paint.length, 2, 'a station still stops a stroke');
  const out = [[38, 3], [39, 3], [40, 3], [41, 3]];
  assert.equal(clipStroke(layout, out).paint.length, 2, 'without growth the edge stops it');
  assert.equal(clipStroke(layout, out, { grow: true }).paint.length, 4, 'with growth the ground beyond is free');
  assert.equal(clipStroke(layout, [[39, 3], [MAX + 50, 3]], { grow: true }).paint.length, 1, 'but not beyond what the plan could ever reach');
});

// ---- pure: auto-pan, the camera that keeps still, the chips ----------------------------------------------------------------------------------------------

test('autoPanVelocity: still in the middle, faster the closer to the edge, towards the content the pointer is heading for', () => {
  const v = (x, y) => G.autoPanVelocity(x, y, 800, 480);
  assert.deepEqual(v(400, 240), [0, 0]);
  assert.deepEqual(v(G.AUTOPAN_ZONE + 1, 240), [0, 0], 'just outside the zone');
  const slow = v(G.AUTOPAN_ZONE - 2, 240)[0];
  const fast = v(4, 240)[0];
  assert.ok(slow > 0 && fast > slow, `speed rises towards the edge: ${slow} < ${fast}`);
  assert.ok(slow >= G.AUTOPAN_MIN && fast <= G.AUTOPAN_MAX);
  assert.equal(v(0, 240)[0], G.AUTOPAN_MAX);
  assert.equal(v(-50, 240)[0], G.AUTOPAN_MAX, 'beyond the edge: the maximum');
  assert.ok(v(799, 240)[0] < 0 && v(400, 1)[1] > 0 && v(400, 479)[1] < 0, 'near the right edge the content moves left: the view looks right');
  const corner = v(2, 2);
  assert.ok(corner[0] > 0 && corner[1] > 0);
  assert.deepEqual(G.autoPanVelocity(NaN, 10, 800, 480)[0], 0);
  assert.deepEqual(G.autoPanVelocity(5, 5, 60, 60), [0, 0], 'a viewport too small to pan in');
});

test('the camera follows the content: commit, undo and redo of a growth move it by the cells the content moved', () => {
  const a = { name: 'before' };
  const b = { name: 'after' };
  G.noteGrowth(b, { dx: 8, dy: 16 });
  G.noteGrowth(a, { dx: 0, dy: 0 });
  assert.equal(G.growthOf(a), null, 'no shift, nothing noted');
  assert.deepEqual(G.contentShift('commit', a, b), { dx: 8, dy: 16 });
  assert.deepEqual(G.contentShift('undo', b, a), { dx: -8, dy: -16 });
  assert.deepEqual(G.contentShift('redo', a, b), { dx: 8, dy: 16 });
  assert.equal(G.contentShift('undo', a, b), null, 'undoing a plain edit moves nothing');
  assert.equal(G.contentShift('load', a, b), null);
  assert.equal(G.growthOf(null), null);
  G.noteGrowth(null, { dx: 1, dy: 1 });
  G.noteGrowth(b, null);
  assert.deepEqual(G.growthOf(b), { dx: 8, dy: 16 });
});

test('edgeChips: four chips outside the plan, inside the window, hidden when the plan is tiny on screen; a strip never takes a click', () => {
  const view = { ox: 100, oy: 80, cellPx: 10, cols: 48, rows: 32, w: 1000, h: 700 };
  const chips = G.edgeChips(view);
  assert.deepEqual(chips.map((c) => c.side).sort(), ['bottom', 'left', 'right', 'top']);
  const by = Object.fromEntries(chips.map((c) => [c.side, c]));
  assert.equal(by.right.strip.x, 100 + 480, 'the strip starts at the edge, outside the plan');
  assert.ok(by.right.strip.w <= G.STRIP_MAX && by.right.strip.w >= G.STRIP_MIN);
  assert.ok(by.left.strip.x + by.left.strip.w === 100 && by.top.strip.y + by.top.strip.h === 80);
  assert.deepEqual([by.right.chip.x, by.right.chip.y], [100 + 480 + by.right.strip.w / 2, 80 + 160], 'in the middle of the edge');
  assert.equal(G.chipAt(chips, by.right.chip.x + 2, by.right.chip.y - 2), 'right');
  assert.equal(G.chipAt(chips, by.right.chip.x + 40, by.right.chip.y), null);
  assert.equal(G.stripAt(chips, by.right.chip.x, by.right.chip.y + 100), 'right');
  assert.equal(G.chipAt(chips, by.right.chip.x, by.right.chip.y + 100), null, 'the strip beside the chip is not the chip');
  assert.equal(G.edgeChips({ ...view, cellPx: 1.5 }).length, 0, 'hidden at a tiny zoom');
  const tight = G.edgeChips({ ox: 12, oy: 80, cellPx: 8, cols: 40, rows: 24, w: 340, h: 700 });
  assert.deepEqual(tight.map((c) => c.side).sort(), ['bottom', 'top'], 'a plan that fills the width of a phone has no room for chips on its sides');
  assert.equal(G.edgeChips({ ...view, cols: 8, rows: 8, cellPx: 4 }).length, 0, 'hidden when the plan is under 100 px');
  assert.ok(G.edgeChips(view, { coarse: true })[0].chip.r > G.edgeChips(view)[0].chip.r, 'larger for a finger');
  // a plan larger than the window: the chip sits at the middle of the part of the edge in view
  const zoomed = G.edgeChips({ ox: -2000, oy: -1000, cellPx: 40, cols: 48, rows: 32, w: 1000, h: 700 });
  assert.ok(zoomed.length < 4, 'edges out of view have no chip');
  const bottom = G.edgeChips({ ox: -500, oy: 100, cellPx: 40, cols: 48, rows: 12, w: 1000, h: 700 }).find((c) => c.side === 'bottom');
  assert.equal(bottom.chip.x, 500, 'the middle of the visible part of the bottom edge (x from 0 to 1000)');
  const none = G.edgeChips({ ox: 2000, oy: 100, cellPx: 10, cols: 48, rows: 32, w: 1000, h: 700 });
  assert.equal(none.length, 0, 'a plan out of the window');
  assert.ok(G.CHIP_TOOLS.includes('select') && G.CHIP_TOOLS.includes('road') && !G.CHIP_TOOLS.includes('erase') && !G.CHIP_TOOLS.includes('pan') && !G.CHIP_TOOLS.includes('flow'));
});

// ---- the Editor end to end -----------------------------------------------------------------------------------------------------------------------------------

function setup({ layout = createLayout({ cols: 40, rows: 24, cellSize: 2 }), tool = null } = {}) {
  const frames = [];
  const win = Object.assign(new EventTarget(), { requestAnimationFrame: (fn) => frames.push(fn) && frames.length, cancelAnimationFrame() {}, innerWidth: 1200, innerHeight: 800, matchMedia: () => ({ matches: false }) });
  const doc = { defaultView: win, querySelector: () => null };
  const canvas = Object.assign(new EventTarget(), {
    ownerDocument: doc, style: {}, getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 480 }),
    setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false,
  });
  const store = createStore({ storage: undefined });
  store.newProject(layout);
  const camera = new Camera({ x: 40, y: 24, zoom: 10, width: 800, height: 480 });
  const toasts = [];
  const statuses = [];
  const renderer = {
    layout: null,
    sim: null,
    view: { selection: { kind: null, ids: [] }, hover: null, tool: 'select', overlays: {}, ghost: null, paintPreview: null, flowPreview: null, marquee: null, resizeHandles: false, extension: null, extendChips: false, extendHover: null },
    render() {},
    hitTest(px, py) {
      const l = this.layout;
      const cs = l.grid.cellSize;
      const [wx, wy] = camera.screenToWorld(px, py);
      const cell = [Math.floor(wx / cs), Math.floor(wy / cs)];
      if (this.view.extendChips) {
        const [ox, oy] = camera.worldToScreen(0, 0);
        const chips = G.edgeChips({ ox, oy, cellPx: cs * camera.zoom, cols: l.grid.cols, rows: l.grid.rows, w: 800, h: 480 });
        const side = G.chipAt(chips, px, py);
        if (side) return { kind: 'extend', id: side, cell };
      }
      const sel = this.view.selection;
      if (this.view.resizeHandles && sel.ids.length === 1) {
        const item = (sel.kind === 'station' ? l.stations : l.obstacles).find((i) => i.id === sel.ids[0]);
        const [sx, sy] = camera.worldToScreen(item.x * cs, item.y * cs);
        const handle = hitHandle(sx, sy, item.w * cs * camera.zoom, item.h * cs * camera.zoom, px, py, 7);
        if (handle) return { kind: sel.kind, id: item.id, cell, handle };
      }
      const station = l.stations.find((s) => pointInRect(wx / cs, wy / cs, s));
      if (station) return { kind: 'station', id: station.id, cell };
      return { kind: 'cell', cell };
    },
  };
  renderer.layout = store.getState().layout;
  const ctx = { toast: (m, o) => toasts.push({ message: m, ...o }), setStatus: (t) => statuses.push(t), actions: { fitView() {} } };
  const editor = new Editor({ canvas, store, camera, renderer, ctx });
  if (tool) editor.setTool(tool);
  const px = (cx, cy, fx = 0.5, fy = 0.5) => {
    const cs = store.getState().layout.grid.cellSize;
    const [sx, sy] = camera.worldToScreen((cx + fx) * cs, (cy + fy) * cs);
    return { clientX: 100 + sx, clientY: 50 + sy };
  };
  const fire = (target, type, props = {}) => {
    const e = Object.assign(new Event(type, { cancelable: true, bubbles: true }), { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }, props);
    target.dispatchEvent(e);
    return e;
  };
  const mouse = {
    down: (cell, props) => fire(canvas, 'pointerdown', { ...px(...cell), ...props }),
    move: (cell, props) => fire(canvas, 'pointermove', { ...px(...cell), ...props }),
    up: (cell, props) => fire(canvas, 'pointerup', { ...px(...cell), ...props }),
    at: (type, clientX, clientY) => fire(canvas, type, { clientX, clientY }),
    click(cell, props) { this.down(cell, props); this.up(cell, props); },
    drag(cells, props) {
      this.down(cells[0], props);
      for (const c of cells.slice(1)) this.move(c, props);
      this.up(cells[cells.length - 1], props);
    },
  };
  const key = (k, props = {}) => {
    fire(win, 'keydown', { key: k, ...props });
    fire(win, 'keyup', { key: k, ...props });
  };
  const state = () => store.getState();
  /** Where a station's centre is on screen (CSS px). */
  const onScreen = (id) => {
    const l = state().layout;
    const s = l.stations.find((e) => e.id === id);
    const cs = l.grid.cellSize;
    return camera.worldToScreen((s.x + s.w / 2) * cs, (s.y + s.h / 2) * cs).map((v) => Math.round(v * 1000) / 1000);
  };
  return { editor, store, camera, renderer, canvas, win, toasts, statuses, frames, px, fire, mouse, key, state, onScreen };
}

/** A small plant: a station and a road in the middle of a 40 x 24 plan. */
function smallPlant() {
  const layout = createLayout({ cols: 40, rows: 24, cellSize: 2 });
  addStation(layout, { type: 'source', x: 8, y: 6, w: 3, h: 2, name: 'A' });
  addStation(layout, { type: 'sink', x: 24, y: 12, w: 3, h: 2, name: 'B' });
  paintRoadPath(layout, [[8, 9], [26, 9]]);
  return layout;
}

test('editor: a road drawn beyond the right edge grows the plan on the right in the same undo step; the view and the content stay where they are', () => {
  const t = setup({ layout: smallPlant(), tool: 'road' });
  const before = t.onScreen('s1');
  t.mouse.drag([[30, 3], [41, 3], [47, 3]]);
  const l = t.state().layout;
  assert.deepEqual([l.grid.cols, l.grid.rows], [56, 24], '47 is 7 beyond + 1 spare... the stroke ends in cell 47: 8 beyond, + 1 = 2 blocks');
  assert.ok(l.roads['47,3'] && l.roads['30,3']);
  assert.equal(t.state().undoLabel, 'Draw road', 'the label does not change');
  assert.deepEqual(t.onScreen('s1'), before, 'nothing moved on screen');
  assert.deepEqual(checkInvariants(l), []);
  assert.equal(t.renderer.view.extension, null, 'the preview is gone');
  t.key('z', { ctrlKey: true });
  assert.deepEqual([t.state().layout.grid.cols, Object.keys(t.state().layout.roads).length], [40, 19], 'one undo takes back the road and the growth');
  assert.deepEqual(t.onScreen('s1'), before);
});

test('editor: a road started and ended beyond the left and top edges shifts the content, the camera follows, undo and redo too', () => {
  const t = setup({ layout: smallPlant(), tool: 'road' });
  const before = t.onScreen('s1');
  const cam0 = [t.camera.x, t.camera.y];
  t.mouse.drag([[-6, -3], [-6, 4], [4, 4]]);
  const l = t.state().layout;
  assert.deepEqual([l.grid.cols, l.grid.rows], [48, 32], 'left 8, top 8');
  const a = l.stations.find((s) => s.name === 'A');
  assert.deepEqual([a.x, a.y], [8 + 8, 6 + 8], 'the content moved by the 8 cells added on the left and above');
  assert.ok(l.roads['2,5'] && l.roads['2,12'] && l.roads['12,12'], 'the stroke is where it was drawn, in the new coordinates');
  assert.deepEqual([t.camera.x - cam0[0], t.camera.y - cam0[1]], [16, 16], 'the view moved by 8 cells = 16 m');
  assert.deepEqual(t.onScreen('s1'), before, 'nothing moved on screen');
  assert.equal(t.state().undoLabel, 'Draw road');
  t.key('z', { ctrlKey: true });
  assert.deepEqual([t.state().layout.grid.cols, t.state().layout.stations[0].x], [40, 8]);
  assert.deepEqual([t.camera.x, t.camera.y], cam0, 'undo moves the view back');
  assert.deepEqual(t.onScreen('s1'), before, 'and nothing moves on screen');
  t.key('z', { ctrlKey: true, shiftKey: true });
  assert.deepEqual([t.state().layout.grid.cols, t.state().layout.stations[0].x], [48, 16]);
  assert.deepEqual(t.onScreen('s1'), before, 'redo too');
});

test('editor: the preview says what is added, as a block outline and a sentence, only while the stroke reaches out', () => {
  const t = setup({ tool: 'road' });
  t.mouse.down([30, 3]);
  t.mouse.move([36, 3]);
  assert.equal(t.renderer.view.extension, null);
  t.mouse.move([44, 3]);
  assert.deepEqual({ ...t.renderer.view.extension }, { left: 0, top: 0, right: 8, bottom: 0, ok: true, limited: false, hint: false });
  assert.match(t.statuses.at(-1), /Road: .*The plan grows by 8 columns on the right\./);
  t.mouse.move([35, 3]);
  assert.equal(t.renderer.view.extension, null, 'back inside: no growth');
  assert.doesNotMatch(t.statuses.at(-1), /grows/);
  t.mouse.move([-4, 3]);
  assert.equal(t.renderer.view.extension.left, 8);
  t.key('Escape');
  assert.equal(t.renderer.view.extension, null, 'Esc ends the gesture and the preview');
  assert.deepEqual([t.state().layout.grid.cols, t.state().canUndo], [40, false]);
});

test('editor: the limit. A road that runs into the edge of the largest plan stops there and says so; one that would need more room than there is is refused', () => {
  const layout = createLayout({ cols: MAX - 4, rows: 24, cellSize: 2 });
  const t = setup({ layout, tool: 'road' });
  t.mouse.down([10, 3]);
  t.mouse.move([MAX + 20, 3]);
  assert.equal(t.renderer.view.extension.ok, true, 'what fits is drawn');
  assert.equal(t.renderer.view.extension.right, 4, 'the last 4 cells');
  assert.match(t.statuses.at(-1), /The plan cannot grow beyond 320 × 320 cells\. The road stops at its edge\./);
  assert.ok(t.renderer.view.paintPreview.blocked.length > 0, 'the rest is shown in red');
  t.mouse.up([MAX + 20, 3]);
  assert.equal(t.state().layout.grid.cols, MAX);
  assert.ok(t.state().layout.roads[`${MAX - 1},3`] && !t.state().layout.roads[`${MAX},3`]);
  assert.match(t.toasts.at(-1).message, /The plan cannot grow beyond 320 × 320 cells\. The road stops at its edge\./);
  assert.equal(t.toasts.at(-1).kind, 'warn');
  assert.equal(t.state().undoLabel, 'Draw road');
  // room on both sides, but not for both at once
  const both = setup({ layout: createLayout({ cols: MAX - 10, rows: 24, cellSize: 2 }), tool: 'road' });
  both.mouse.down([-9, 3]);
  both.mouse.move([MAX - 10 + 8, 3]);
  assert.equal(both.renderer.view.extension.ok, false, 'shown in the warning colour');
  assert.match(both.statuses.at(-1), /The plan cannot grow beyond 320 × 320 cells\./);
  both.mouse.up([MAX - 10 + 8, 3]);
  assert.match(both.toasts.at(-1).message, /^The plan cannot grow beyond 320 × 320 cells\.$/);
  assert.equal(both.state().canUndo, false, 'nothing committed');
  assert.equal(both.state().layout.grid.cols, MAX - 10);
});

test('editor: a brick placed beyond the left edge: ghost and block while hovering, one undo step, selected, the view stays', () => {
  const t = setup({ layout: smallPlant(), tool: 'process' });
  const before = t.onScreen('s1');
  t.mouse.at('pointermove', t.px(-6, 10).clientX, t.px(-6, 10).clientY);
  assert.equal(t.renderer.view.ghost.valid, true);
  assert.ok(t.renderer.view.ghost.rect.x < 0, 'the ghost follows the pointer out');
  assert.equal(t.renderer.view.extension.left, 8, 'a block of baseplate shows what is added');
  t.mouse.click([-6, 10]);
  const l = t.state().layout;
  assert.equal(l.grid.cols, 48);
  const placed = l.stations.find((s) => s.name === 'Workstation 1');
  assert.deepEqual([placed.x, placed.y, placed.w, placed.h], [-8 + 8 - 0 + 0, 9, 3, 3].map((v, i) => (i === 0 ? placed.x : v)));
  assert.ok(placed.x >= 0 && placed.x + placed.w <= 8, 'inside the 8 new columns');
  assert.equal(t.state().undoLabel, 'Add workstation');
  assert.deepEqual(t.state().ui.selection, { kind: 'station', ids: [placed.id] });
  assert.deepEqual(t.onScreen('s1'), before);
  t.key('z', { ctrlKey: true });
  assert.deepEqual([t.state().layout.grid.cols, t.state().layout.stations.length], [40, 2]);
  assert.deepEqual(t.onScreen('s1'), before);
});

test('editor: a brick sized by dragging beyond the bottom right corner grows the plan on both sides of that corner', () => {
  const t = setup({ layout: smallPlant(), tool: 'storage' });
  t.mouse.drag([[30, 18], [44, 29]]);
  const l = t.state().layout;
  assert.deepEqual([l.grid.cols, l.grid.rows], [48, 32], 'x reaches 44: 5 beyond + 1 spare = 1 block; y reaches 29: 6 + 1 = 1 block');
  const s = l.stations.find((e) => e.name === 'Storage 1');
  assert.deepEqual([s.x, s.y, s.w, s.h], [30, 18, 15, 12]);
  assert.equal(t.state().undoLabel, 'Add storage / buffer');
});

test('editor: a brick that would sit on a station beyond the edge is refused like inside; beyond the limit it says why', () => {
  const t = setup({ layout: smallPlant(), tool: 'process' });
  t.mouse.click([9, 7]);
  assert.match(t.toasts.at(-1).message, /another station is in the way/);
  assert.equal(t.state().layout.stations.length, 2);
  const full = setup({ layout: createLayout({ cols: MAX, rows: 24, cellSize: 2 }), tool: 'process' });
  full.mouse.click([MAX + 3, 10]);
  assert.equal(full.toasts.at(-1).message, 'The plan cannot grow beyond 320 × 320 cells.', 'the whole toast is the plain sentence');
  assert.equal(full.state().canUndo, false);
});

test('editor: a station dragged beyond an edge grows the plan (pointer beyond); with the pointer still inside it stays red and says how to extend', () => {
  const t = setup({ layout: smallPlant() });
  const before = t.onScreen('s2');
  t.mouse.click([25, 13]);
  t.mouse.down([25, 13]);
  t.mouse.move([39, 13]);
  assert.equal(t.renderer.view.ghost.valid, false, 'the pointer is inside: the station may not stick out');
  assert.match(t.statuses.at(-1), /Cannot move here: it would leave the plant area\. Move the pointer past the edge to extend the plan\./);
  assert.equal(t.renderer.view.extension, null);
  t.mouse.move([42, 13]);
  assert.equal(t.renderer.view.ghost.valid, true);
  assert.equal(t.renderer.view.extension.right, 8);
  t.mouse.up([42, 13]);
  const l = t.state().layout;
  assert.equal(l.grid.cols, 48);
  const s = l.stations.find((e) => e.name === 'B');
  assert.deepEqual([s.x, s.y], [24 + 17, 12], 'moved by 17 cells');
  assert.equal(s.x + s.w <= l.grid.cols, true);
  assert.equal(t.state().undoLabel, 'Move station');
  t.key('z', { ctrlKey: true });
  assert.deepEqual([t.state().layout.grid.cols, t.state().layout.stations[1].x], [40, 24]);
  assert.deepEqual(t.onScreen('s2'), before);
});

test('editor: a station dragged beyond the top left corner shifts everything and the view follows', () => {
  const t = setup({ layout: smallPlant() });
  const before = t.onScreen('s2');
  t.mouse.click([9, 7]);
  t.mouse.drag([[9, 7], [-3, -2]]);
  const l = t.state().layout;
  assert.deepEqual([l.grid.cols, l.grid.rows], [48, 32]);
  const a = l.stations.find((e) => e.name === 'A');
  const b = l.stations.find((e) => e.name === 'B');
  assert.deepEqual([b.x, b.y], [24 + 8, 12 + 8], 'the other station moved with the content');
  assert.ok(a.x >= 0 && a.y >= 0, 'the moved one is on the new ground');
  assert.deepEqual(t.onScreen('s2'), before, 'the untouched station did not move on screen');
});

test('editor: resizing a station beyond the right edge grows the plan; the resize handle follows the pointer out', () => {
  const t = setup({ layout: smallPlant() });
  t.mouse.click([25, 13]);
  const s0 = t.state().layout.stations[1];
  const handle = t.px(s0.x + s0.w, s0.y + s0.h / 2, 0, 0); // the east handle, in the middle of the right edge
  t.mouse.at('pointerdown', handle.clientX, handle.clientY);
  t.mouse.move([45, 13]);
  assert.equal(t.renderer.view.extension.right, 8);
  t.mouse.up([45, 13]);
  const s = t.state().layout.stations[1];
  assert.ok(s.x + s.w > 40 && t.state().layout.grid.cols > 40, 'the station is wider than before and beyond the old edge');
  assert.match(t.state().undoLabel, /^Resize/);
  assert.deepEqual(checkInvariants(t.state().layout), []);
});

test('editor: a label placed beyond the edge grows the plan; the eraser and the speed zones never do', () => {
  const t = setup({ layout: smallPlant(), tool: 'label' });
  t.editor.editText = ({ onSubmit }) => onSubmit('Gate');
  t.mouse.click([-5, 3]);
  const l = t.state().layout;
  assert.equal(l.grid.cols, 48);
  assert.deepEqual([l.labels[0].text, l.labels[0].x >= 0 && l.labels[0].x <= 8], ['Gate', true]);
  assert.equal(t.state().undoLabel, 'Add label');
  const e = setup({ layout: smallPlant(), tool: 'erase' });
  e.mouse.drag([[30, 9], [60, 9]]);
  assert.equal(e.state().layout.grid.cols, 40, 'the eraser stays on the plan');
  assert.equal(e.renderer.view.extension, null);
  const z = setup({ layout: smallPlant(), tool: 'speedzone' });
  z.mouse.drag([[10, 9], [60, 9]]);
  assert.equal(z.state().layout.grid.cols, 40);
});

test('editor: click on an edge chip extends the plan by one block, one undo step "Extend plan", the view stays', () => {
  const t = setup({ layout: smallPlant() });
  t.mouse.at('pointermove', t.px(20, 10).clientX, t.px(20, 10).clientY);
  assert.equal(t.renderer.view.extendChips, true, 'the chips show while the mouse is over the canvas with Select');
  const before = t.onScreen('s1');
  const cs = 2;
  const [ox, oy] = t.camera.worldToScreen(0, 0);
  const chips = G.edgeChips({ ox, oy, cellPx: cs * t.camera.zoom, cols: 40, rows: 24, w: 800, h: 480 });
  // the camera shows the plan edge to edge: there is no room for strips inside the window, so zoom out a little
  t.camera.zoomAt(0.8, 400, 240);
  const [ox2, oy2] = t.camera.worldToScreen(0, 0);
  const chips2 = G.edgeChips({ ox: ox2, oy: oy2, cellPx: cs * t.camera.zoom, cols: 40, rows: 24, w: 800, h: 480 });
  assert.equal(chips.length <= chips2.length && chips2.length, 4, 'all four chips fit once the plan is a little smaller on screen');
  const left = chips2.find((c) => c.side === 'left').chip;
  const beforeZoomed = t.onScreen('s1');
  t.mouse.at('pointermove', 100 + left.x, 50 + left.y);
  assert.equal(t.renderer.view.extendHover, 'left');
  assert.deepEqual({ ...t.renderer.view.extension }, { left: 8, top: 0, right: 0, bottom: 0, ok: true, limited: false, hint: true }, 'hovering a chip shows the block it adds, lightly');
  assert.match(t.statuses.at(-1), /Click to extend the plan to the left by 8 columns \(then 48 × 24 cells\)\./);
  t.mouse.at('pointerdown', 100 + left.x, 50 + left.y);
  t.mouse.at('pointerup', 100 + left.x, 50 + left.y);
  assert.equal(t.state().layout.grid.cols, 48);
  assert.equal(t.state().undoLabel, 'Extend plan');
  assert.equal(t.state().layout.stations[0].x, 16, 'the content moved right by 8 cells');
  assert.deepEqual(t.onScreen('s1'), beforeZoomed, 'and not on screen');
  assert.equal(t.editor.active, null, 'a press on a chip starts no gesture');
  t.key('z', { ctrlKey: true });
  assert.equal(t.state().layout.grid.cols, 40);
  assert.deepEqual(t.onScreen('s1'), beforeZoomed);
  void before;
});

test('editor: extendSide at the limit says so', () => {
  const t = setup({ layout: createLayout({ cols: MAX, rows: 24, cellSize: 2 }) });
  assert.equal(t.editor.extendSide('right'), false);
  assert.match(t.toasts.at(-1).message, /cannot grow beyond 320/);
  assert.equal(t.editor.extendSide('bottom'), true);
  assert.equal(t.state().layout.grid.rows, 32);
});

test('editor: the chips are offered for Select and the drawing tools only, and not during a gesture', () => {
  const t = setup();
  const over = () => t.mouse.at('pointermove', t.px(10, 10).clientX, t.px(10, 10).clientY);
  over();
  assert.equal(t.renderer.view.extendChips, true);
  for (const tool of ['road', 'oneway', 'source', 'obstacle', 'label']) {
    t.editor.setTool(tool);
    over();
    assert.equal(t.renderer.view.extendChips, true, tool);
  }
  for (const tool of ['erase', 'speedzone', 'pan', 'flow']) {
    t.editor.setTool(tool);
    over();
    assert.equal(t.renderer.view.extendChips, false, tool);
  }
  t.editor.setTool('road');
  over();
  t.mouse.down([10, 10]);
  assert.equal(t.renderer.view.extendChips, false, 'not while drawing');
  t.mouse.up([10, 10]);
  t.mouse.at('pointerleave', 0, 0);
  assert.equal(t.renderer.view.extendChips, false, 'not when the mouse has left the canvas');
});

/** Run the animation frames that are queued (and those they queue, up to `n` rounds) with a timestamp that advances by `step` ms. */
function runFrames(t, n, step = 16) {
  for (let i = 0; i < n; i++) {
    const batch = t.frames.splice(0);
    if (batch.length === 0) return;
    t.clock = (t.clock || 0) + step;
    for (const f of batch) f(t.clock);
  }
}

test('editor: auto-pan. A drag held at the edge of the canvas pans the view, faster the closer it is, and stops at once when the pointer comes back', () => {
  const t = setup({ tool: 'road' });
  t.mouse.down([10, 3]);
  const x0 = t.camera.x;
  t.mouse.at('pointermove', 100 + 400, 50 + 240);
  runFrames(t, 5);
  assert.equal(t.camera.x, x0, 'in the middle of the canvas the view stands still');
  t.mouse.at('pointermove', 100 + 800 - 10, 50 + 240); // 10 px from the right edge
  runFrames(t, 10);
  const panned = t.camera.x - x0;
  assert.ok(panned > 0, `the view looks further right: ${panned} m`);
  const rows0 = t.camera.y;
  t.mouse.at('pointermove', 100 + 800 - 2, 50 + 240);
  const x1 = t.camera.x;
  runFrames(t, 10);
  const closer = t.camera.x - x1;
  assert.ok(closer > panned, `closer to the edge it is faster: ${closer} > ${panned}`);
  assert.equal(t.camera.y, rows0, 'only along the axis that is near the edge');
  assert.ok(t.state().layout.grid.cols === 40 && t.renderer.view.paintPreview.cells.length > 5, 'the stroke grows with the view, nothing is committed yet');
  assert.ok(t.renderer.view.extension && t.renderer.view.extension.right >= 8, 'and the plan block shows how much room is added');
  t.mouse.at('pointermove', 100 + 400, 50 + 240);
  const x2 = t.camera.x;
  runFrames(t, 5);
  assert.equal(t.camera.x, x2, 'the pointer left the zone: the view stands still');
  assert.equal(t.frames.length, 0, 'and the loop has ended');
  t.mouse.at('pointerup', 100 + 400, 50 + 240);
  t.mouse.at('pointermove', 100 + 800 - 2, 50 + 240);
  runFrames(t, 5);
  assert.equal(t.camera.x, x2, 'without a drag nothing pans');
});

test('editor: auto-pan in every direction, and the world under a resting pointer keeps moving the stroke', () => {
  const t = setup({ tool: 'road' });
  t.mouse.down([10, 10]);
  const [x0, y0] = [t.camera.x, t.camera.y];
  t.mouse.at('pointermove', 100 + 3, 50 + 3);
  runFrames(t, 8);
  assert.ok(t.camera.x < x0 && t.camera.y < y0, 'near the top left corner the view looks up and left');
  assert.ok(t.renderer.view.extension && t.renderer.view.extension.left > 0 && t.renderer.view.extension.top > 0, 'the pointer is over cells beyond the top left corner now');
  t.mouse.at('pointermove', 100 + 400, 50 + 480 - 3);
  const y1 = t.camera.y;
  runFrames(t, 8);
  assert.ok(t.camera.y > y1, 'near the bottom edge the view looks down');
  t.key('Escape');
  const x2 = t.camera.x;
  runFrames(t, 5);
  assert.equal(t.camera.x, x2, 'Esc stops it');
  assert.equal(t.frames.length, 0);
});

test('editor: auto-pan only for gestures that can grow: dragging a brick, a road, a resize; not the pan tool or a marquee', () => {
  const edge = (t) => { t.mouse.at('pointermove', 100 + 790, 50 + 240); const x = t.camera.x; runFrames(t, 6); return t.camera.x - x; };
  const t = setup({ layout: smallPlant() });
  t.mouse.down([5, 20]); // marquee on empty ground
  t.mouse.move([6, 21]);
  assert.equal(edge(t), 0, 'a marquee does not pan the view');
  t.mouse.up([6, 21]);
  const p = setup({ layout: smallPlant(), tool: 'pan' });
  p.mouse.down([5, 20]);
  p.mouse.move([6, 21]);
  assert.ok(Math.abs(edge(p)) < 30, 'the pan tool moves the view by the drag only (the pointer moved to the edge: that is a pan of 30 cells, not an autopan)');
  p.mouse.up([6, 21]);
  const d = setup({ layout: smallPlant() });
  d.mouse.click([9, 7]);
  d.mouse.down([9, 7]);
  d.mouse.move([10, 7]);
  assert.ok(edge(d) > 0, 'dragging a station does');
});

test('editor: the keyboard route. Nudge and duplicate never grow the plan', () => {
  const t = setup({ layout: smallPlant() });
  t.mouse.click([9, 7]);
  t.key('ArrowLeft', {});
  for (let i = 0; i < 12; i++) t.key('ArrowLeft', {});
  assert.equal(t.state().layout.grid.cols, 40);
  assert.equal(t.state().layout.stations[0].x >= 0, true);
});

test('trimGrid and growGrid go through the editor: the camera follows a Plant settings style commit', () => {
  const t = setup({ layout: smallPlant() });
  const before = t.onScreen('s1');
  t.store.commit('Extend plan', (d) => { const shift = growGrid(d, { left: 8, top: 8 }); G.noteGrowth(d, shift); });
  assert.deepEqual(t.onScreen('s1'), before, 'any commit that notes its shift keeps the view still');
  t.store.commit('Trim plan to content', (d) => { const r = trimGrid(d, { margin: 2 }); G.noteGrowth(d, r); });
  assert.deepEqual(t.onScreen('s1'), before);
  t.store.undo();
  assert.deepEqual(t.onScreen('s1'), before);
  t.store.undo();
  assert.deepEqual(t.onScreen('s1'), before);
  t.store.commit('Move without a note', (d) => { growGrid(d, { left: 8 }); });
  assert.notDeepEqual(t.onScreen('s1'), before, 'a commit that does not say it shifted the content moves it on screen (the tests above rely on the note)');
  void addLabel; void addObstacle;
});

// ---- the renderer side: the extension block and the chips --------------------------------------------------------------------------------------------------

/** A canvas whose 2D context records what the tests need and ignores everything else. */
function fakeCanvas(width = 0, height = 0) {
  const ctx = new Proxy({ calls: 0, arcs: [], rects: 0, texts: [], strokeStyles: new Set(), dashes: 0, record: false }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') return (t) => ({ width: String(t).length * 6 });
      return (...args) => {
        target.calls++;
        if (prop === 'arc' && target.record) target.arcs.push(Math.round(args[2] * 100) / 100);
        if (prop === 'rect') target.rects++;
        if (prop === 'fillText' && target.record) target.texts.push(String(args[0]));
        if (prop === 'setLineDash' && args[0] && args[0].length) target.dashes++;
      };
    },
    set(target, prop, value) {
      target[prop] = value;
      if (prop === 'strokeStyle' && target.record) target.strokeStyles.add(value);
      return true;
    },
  });
  return { width, height, clientWidth: 0, clientHeight: 0, ctx, getContext: () => ctx, toDataURL: () => 'data:image/png;base64,FAKE' };
}

async function rendererSetup(layout, { w = 1000, h = 700, zoom = 8 } = {}) {
  const { Renderer } = await import('../js/ui/renderer.js');
  const canvas = fakeCanvas();
  canvas.clientWidth = w;
  canvas.clientHeight = h;
  const made = [];
  const camera = new Camera({ x: layout.grid.cols, y: layout.grid.rows, zoom });
  const renderer = new Renderer(canvas, { camera, theme: 'light', dpr: 1, now: () => 0, createCanvas: (cw, ch) => { const c = fakeCanvas(cw, ch); made.push(c); return c; } });
  renderer.layout = layout;
  return { renderer, camera, canvas, ctx: canvas.ctx, made };
}

test('renderer: the extension block draws for every side, in the warning colour at the limit, lightly as a hint; the view starts without it', async () => {
  const { createView } = await import('../js/ui/renderer.js');
  assert.deepEqual([createView().extension, createView().extendChips, createView().extendHover], [null, false, null]);
  const layout = createLayout({ cols: 48, rows: 32, cellSize: 2 });
  const { renderer, ctx } = await rendererSetup(layout);
  renderer.render(1);
  const plain = ctx.calls;
  ctx.record = true;
  for (const extension of [
    { left: 8, top: 0, right: 0, bottom: 0, ok: true, limited: false, hint: false },
    { left: 0, top: 16, right: 24, bottom: 8, ok: true, limited: false, hint: false },
    { left: 8, top: 8, right: 8, bottom: 8, ok: true, limited: true, hint: false },
    { left: 0, top: 0, right: 8, bottom: 0, ok: false, limited: true, hint: false },
    { left: 0, top: 0, right: 0, bottom: 8, ok: true, limited: false, hint: true },
    { left: 0, top: 0, right: 0, bottom: 0, ok: false, limited: true, hint: false },
    { left: 5000, top: 5000, right: 5000, bottom: 5000, ok: false, limited: true, hint: false },
    { left: NaN, top: 8, right: undefined, bottom: -4, ok: true },
  ]) {
    renderer.view.extension = extension;
    const before = ctx.calls;
    renderer.render(1);
    assert.ok(ctx.calls >= before, JSON.stringify(extension));
  }
  renderer.view.extension = { left: 8, top: 0, right: 0, bottom: 0, ok: true, limited: false, hint: false };
  ctx.texts.length = 0;
  ctx.dashes = 0;
  const before = ctx.calls;
  renderer.render(1);
  assert.ok(ctx.calls - before > 30, `more is drawn with the block (${ctx.calls - before} calls) than without (${plain})`);
  assert.ok(ctx.texts.includes('+8 columns'), `the block says how much it adds: ${JSON.stringify(ctx.texts)}`);
  assert.ok(ctx.dashes >= 1, 'inside a dashed outline');
  ctx.texts.length = 0;
  renderer.view.extension = { left: 0, top: 8, right: 0, bottom: 0, ok: false, limited: true, hint: false };
  renderer.render(1);
  assert.ok(ctx.texts.includes('Limit: +8 rows'), JSON.stringify(ctx.texts));
  ctx.texts.length = 0;
  renderer.view.extension = { left: 0, top: 8, right: 0, bottom: 0, ok: true, limited: false, hint: true };
  renderer.render(1);
  assert.deepEqual(ctx.texts.filter((t) => /columns|rows/.test(t)), [], 'the block of a hovered chip carries no label (the scale bar still reads "10 m")');
});

test('renderer: edge chips are hit as "extend" only while they are on and no edit shows its own block', async () => {
  const layout = createLayout({ cols: 48, rows: 32, cellSize: 2 });
  const { renderer, camera } = await rendererSetup(layout, { zoom: 8 });
  const chips = () => {
    const [ox, oy] = camera.worldToScreen(0, 0);
    return G.edgeChips({ ox, oy, cellPx: 2 * camera.zoom, cols: 48, rows: 32, w: 1000, h: 700 });
  };
  const right = chips().find((c) => c.side === 'right').chip;
  assert.notEqual(renderer.hitTest(right.x, right.y).kind, 'extend', 'off by default');
  renderer.view.extendChips = true;
  const hit = renderer.hitTest(right.x, right.y);
  assert.deepEqual([hit.kind, hit.id], ['extend', 'right']);
  assert.deepEqual(renderer.hitTest(right.x, right.y + 60).kind, 'cell', 'beside the chip is just ground');
  const left = chips().find((c) => c.side === 'left').chip;
  assert.equal(renderer.hitTest(left.x + 3, left.y - 2).id, 'left');
  renderer.view.extension = { left: 0, top: 0, right: 8, bottom: 0, ok: true, limited: false, hint: false };
  assert.notEqual(renderer.hitTest(right.x, right.y).kind, 'extend', 'while an edit shows its block the chips step aside');
  renderer.view.extension = { left: 0, top: 0, right: 8, bottom: 0, ok: true, limited: false, hint: true };
  assert.equal(renderer.hitTest(right.x, right.y).kind, 'extend', 'but not for the hint of a chip');
  camera.zoom = 0.5;
  assert.notEqual(renderer.hitTest(right.x, right.y).kind, 'extend', 'and not at a tiny zoom');
  renderer.render(1);
});

test('renderer: chips, strips and blocks never reach the picture of the plan (PNG export)', async () => {
  const layout = createLayout({ cols: 48, rows: 32, cellSize: 2 });
  const { renderer, made } = await rendererSetup(layout);
  renderer.toDataURL();
  const plain = made.at(-1).ctx.calls;
  renderer.view.extendChips = true;
  renderer.view.extendHover = 'left';
  renderer.view.extension = { left: 8, top: 8, right: 8, bottom: 8, ok: true, limited: false, hint: false };
  made.at(-1).ctx.calls = 0;
  renderer.toDataURL();
  const created = made.filter((c) => c.width > 0).at(-1);
  assert.equal(created.ctx.calls, plain, 'the export draws exactly what it drew without the editing aids');
});

test('camera.translate: the view moves with the content by world metres; junk is ignored; the screen position of a world point follows', () => {
  const cam = new Camera({ x: 40, y: 24, zoom: 10, width: 800, height: 480 });
  const before = cam.worldToScreen(100, 50);
  assert.equal(cam.translate(16, 8), cam);
  assert.deepEqual([cam.x, cam.y, cam.zoom], [56, 32, 10]);
  assert.deepEqual(cam.worldToScreen(116, 58), before, 'a point that moved with the content is where it was on screen');
  cam.translate(NaN, undefined);
  assert.deepEqual([cam.x, cam.y], [56, 32]);
});

test('the 320 x 320 baseplate of 10 m cells (3200 m) still fits a 390 px phone and the desktop with the default padding', () => {
  const huge = { grid: { cols: MAX, rows: MAX, cellSize: 10 } };
  for (const [w, h] of [[390, 700], [1440, 900]]) {
    const cam = new Camera().fit(huge, w, h, 16);
    const [x0, y0] = cam.worldToScreen(0, 0);
    const [x1, y1] = cam.worldToScreen(3200, 3200);
    assert.ok(x0 >= 0 && y0 >= 0 && x1 <= w && y1 <= h, `${w} x ${h}: the whole plan is in view (${Math.round(x0)}..${Math.round(x1)}, ${Math.round(y0)}..${Math.round(y1)})`);
  }
});
