import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStroke, cornerCount, lengthText, effectiveMode, turnThreshold, continueLine, isDrawMode,
  DRAW_MODES, DEFAULT_DRAW_MODE, TURN_THRESHOLD, SMART_AXIS_PICK, STRAIGHT_AXIS_LOCK, TOUCH_TURN_PX,
} from '../js/ui/editor/strokes.js';
import { extendStroke } from '../js/ui/editor/paths.js';
import { createRng } from '../js/util/rng.js';

// ---- helpers -------------------------------------------------------------------------------------------------------

const key = (c) => `${c[0]},${c[1]}`;
const neighbours = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) === 1;

/** Every step of the stroke is a step to a 4-neighbour: no gaps, no diagonals, no repeated cell in a row. */
function assertContiguous(cells, what = 'stroke') {
  for (let i = 1; i < cells.length; i++) assert.ok(neighbours(cells[i - 1], cells[i]), `${what}: step ${i} ${key(cells[i - 1])} -> ${key(cells[i])} is not a 4-neighbour step`);
}

/** No cell twice (strokes that do not cross themselves). */
function assertNoDuplicates(cells, what = 'stroke') {
  assert.equal(new Set(cells.map(key)).size, cells.length, `${what}: a cell appears twice`);
}

/** The corners of a stroke: the cells where its direction changes. */
function cornersOf(cells) {
  const out = [];
  for (let i = 1; i < cells.length - 1; i++) {
    const a = [cells[i][0] - cells[i - 1][0], cells[i][1] - cells[i - 1][1]];
    const b = [cells[i + 1][0] - cells[i][0], cells[i + 1][1] - cells[i][1]];
    if (a[0] !== b[0] || a[1] !== b[1]) out.push(cells[i]);
  }
  return out;
}

/** A stroke pressed at the centre of cell (cx, cy) in the given mode. */
const startAt = (cx, cy, opts = {}) => createStroke({ at: [cx + 0.5, cy + 0.5], ...opts });

/** Move the pointer in a straight line to (ux, uy) in steps of `step` cells (a slow, deliberate drag). */
function glide(stroke, ux, uy, step = 0.25) {
  const [x0, y0] = stroke.pointer;
  const n = Math.max(1, Math.ceil(Math.max(Math.abs(ux - x0), Math.abs(uy - y0)) / step));
  for (let i = 1; i <= n; i++) stroke.move(x0 + ((ux - x0) * i) / n, y0 + ((uy - y0) * i) / n);
  return stroke;
}

/** Glide to the centre of a cell. */
const glideToCell = (stroke, cx, cy, step) => glide(stroke, cx + 0.5, cy + 0.5, step);

const uniform = (rng, amp) => (rng.next() * 2 - 1) * amp;

// ---- small pure helpers --------------------------------------------------------------------------------------------

test('constants: three modes, smart by default, the thresholds of the brief', () => {
  assert.deepEqual([...DRAW_MODES], ['smart', 'straight', 'free']);
  assert.equal(DEFAULT_DRAW_MODE, 'smart');
  assert.equal(TURN_THRESHOLD, 2);
  assert.equal(SMART_AXIS_PICK, 1);
  assert.equal(STRAIGHT_AXIS_LOCK, 1.5);
  assert.ok(DRAW_MODES.every(isDrawMode));
  assert.equal(isDrawMode('diagonal'), false);
  assert.equal(isDrawMode(undefined), false);
});

test('effectiveMode: Shift is a straight line, otherwise the chosen mode, junk falls back to smart', () => {
  assert.equal(effectiveMode({ shift: true, drawMode: 'free' }), 'straight');
  assert.equal(effectiveMode({ shift: true }), 'straight');
  assert.equal(effectiveMode({ shift: false, drawMode: 'free' }), 'free');
  assert.equal(effectiveMode({ drawMode: 'straight' }), 'straight');
  assert.equal(effectiveMode({ drawMode: 'smart' }), 'smart');
  assert.equal(effectiveMode({ drawMode: 'nonsense' }), 'smart');
  assert.equal(effectiveMode({}), 'smart');
  assert.equal(effectiveMode(), 'smart');
});

test('turnThreshold: a mouse needs two cells, a finger at least TOUCH_TURN_PX on screen', () => {
  assert.equal(turnThreshold(30, 'mouse'), 2);
  assert.equal(turnThreshold(8, 'mouse'), 2);
  assert.equal(turnThreshold(30, 'touch'), 2, 'a big cell: two cells are already more than a fingertip');
  assert.equal(turnThreshold(8, 'touch'), Math.ceil(TOUCH_TURN_PX / 8));
  assert.equal(turnThreshold(8, 'touch'), 4);
  assert.equal(turnThreshold(0, 'touch'), 2, 'no usable size: the default');
  assert.equal(turnThreshold(Number.NaN, 'touch'), 2);
  assert.equal(turnThreshold(8, 'pen'), 2);
});

test('lengthText: metres first, then cells, singular for one cell', () => {
  assert.equal(lengthText(12, 2), '24 m · 12 cells');
  assert.equal(lengthText(1, 2), '2 m · 1 cell');
  assert.equal(lengthText(5, 2.5), '12.5 m · 5 cells');
  assert.equal(lengthText(3, 0.5), '1.5 m · 3 cells');
  assert.equal(lengthText(7, 0.1), '0.7 m · 7 cells');
});

test('cornerCount: counts changes of direction, repeated cells are not steps', () => {
  assert.equal(cornerCount([]), 0);
  assert.equal(cornerCount([[0, 0]]), 0);
  assert.equal(cornerCount([[0, 0], [1, 0], [2, 0]]), 0);
  assert.equal(cornerCount([[0, 0], [1, 0], [1, 1]]), 1);
  assert.equal(cornerCount([[0, 0], [1, 0], [1, 0], [1, 1], [2, 1]]), 2);
  assert.equal(cornerCount([[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2]]), 2);
});

test('continueLine: L-shaped from the end of the previous stroke, along the dominant axis first', () => {
  assert.deepEqual(continueLine([2, 2], [5, 3]), [[2, 2], [3, 2], [4, 2], [5, 2], [5, 3]]);
  assert.deepEqual(continueLine([2, 2], [3, 6]), [[2, 2], [2, 3], [2, 4], [2, 5], [2, 6], [3, 6]]);
  assert.deepEqual(continueLine([4, 4], [4, 1]), [[4, 4], [4, 3], [4, 2], [4, 1]]);
});

// ---- smart: the stroke is straight by intent -------------------------------------------------------------------------

test('smart: a press without movement is one cell; the axis is picked at the first cell of movement', () => {
  const s = startAt(10, 10);
  assert.deepEqual(s.cells, [[10, 10]]);
  assert.equal(s.axis, null);
  assert.equal(s.mode, 'smart');
  glide(s, 10.5 + 0.6, 10.5);
  assert.deepEqual(s.cells, [[10, 10]], 'less than one cell away: still just the press cell');
  assert.equal(s.axis, null);
  glide(s, 10.5 + 1.2, 10.5);
  assert.equal(s.axis, 'h');
  assert.deepEqual(s.cells, [[10, 10], [11, 10]]);
  const v = startAt(10, 10);
  glide(v, 10.5, 10.5 - 3);
  assert.equal(v.axis, 'v');
  assert.deepEqual(v.cells, [[10, 10], [10, 9], [10, 8], [10, 7]]);
});

test('smart: a straight drag to the right and one to the left, up and down, are straight lines to the pointer cell', () => {
  for (const [dx, dy] of [[9, 0], [-9, 0], [0, 9], [0, -9]]) {
    const s = startAt(20, 20);
    glideToCell(s, 20 + dx, 20 + dy);
    assert.equal(cornerCount(s.cells), 0);
    assert.equal(s.cells.length, 10);
    assert.deepEqual(s.end, [20 + dx, 20 + dy]);
    assertContiguous(s.cells);
    assertNoDuplicates(s.cells);
  }
});

test('smart: a wobble below the threshold never makes a jog (one cell off the line, the whole way)', () => {
  const s = startAt(10, 10);
  for (let x = 11; x <= 30; x++) {
    glide(s, x + 0.5, 10.5 + (x % 2 ? 1 : -1), 0.25);
    assert.equal(cornerCount(s.cells), 0, `no corner at x=${x}`);
  }
  assert.deepEqual(s.cells.at(-1), [30, 10]);
  assert.equal(s.cells.length, 21);
  assert.ok(s.cells.every((c) => c[1] === 10), 'all cells in the row of the press');
});

test('smart: an excursion of two cells or more makes ONE corner at the projected cell', () => {
  const s = startAt(10, 10);
  glideToCell(s, 20, 10);
  assert.equal(cornerCount(s.cells), 0);
  glideToCell(s, 20, 16);
  assert.equal(cornerCount(s.cells), 1);
  assert.deepEqual(cornersOf(s.cells), [[20, 10]], 'the corner is where the pointer left the line');
  assert.equal(s.cells.length, 11 + 6);
  assert.equal(s.axis, 'v');
  assertContiguous(s.cells);
  assertNoDuplicates(s.cells);
  assert.deepEqual(s.end, [20, 16]);
});

test('smart: a U and a spiral are possible with deliberate moves', () => {
  const u = startAt(10, 10);
  glideToCell(u, 22, 10);
  glideToCell(u, 22, 15);
  glideToCell(u, 12, 15);
  assert.equal(cornerCount(u.cells), 2);
  assert.deepEqual(cornersOf(u.cells), [[22, 10], [22, 15]]);
  assertNoDuplicates(u.cells);

  const spiral = startAt(10, 10);
  glideToCell(spiral, 30, 10);
  glideToCell(spiral, 30, 26);
  glideToCell(spiral, 14, 26);
  glideToCell(spiral, 14, 16);
  glideToCell(spiral, 24, 16);
  assert.equal(cornerCount(spiral.cells), 4);
  assert.deepEqual(cornersOf(spiral.cells), [[30, 10], [30, 26], [14, 26], [14, 16]]);
  assertContiguous(spiral.cells);
  assertNoDuplicates(spiral.cells);
  assert.deepEqual(spiral.end, [24, 16]);
});

test('smart: a pointer that sits exactly one cell off the line for a long time still does not turn', () => {
  const s = startAt(5, 5);
  glideToCell(s, 12, 5);
  glideToCell(s, 12, 6);
  glideToCell(s, 30, 6);
  assert.equal(cornerCount(s.cells), 0);
  assert.equal(s.cells.length, 26);
  assert.ok(s.cells.every((c) => c[1] === 5));
});

test('smart: the first guess of the axis is corrected without a stub (one cell sideways, then straight down)', () => {
  const s = startAt(10, 10);
  glide(s, 10.5 + 1.1, 10.5); // looks horizontal for a moment
  assert.equal(s.axis, 'h');
  glideToCell(s, 11, 10);
  glideToCell(s, 11, 18);
  assert.equal(cornerCount(s.cells), 0, 'no one-cell stub before the vertical line');
  assert.ok(s.cells.every((c) => c[0] === 10), 'the line runs down from the press cell');
  assert.deepEqual(s.end, [10, 18]);
  assert.equal(s.axis, 'v');
});

// ---- retraction ----------------------------------------------------------------------------------------------------

test('smart: moving back along the stroke retracts it', () => {
  const s = startAt(10, 10);
  glideToCell(s, 22, 10);
  glideToCell(s, 16, 10);
  assert.deepEqual(s.end, [16, 10]);
  assert.equal(s.cells.length, 7);
  glideToCell(s, 10, 10);
  assert.deepEqual(s.cells, [[10, 10]], 'back to the start: a single plate');
  glideToCell(s, 7, 10);
  assert.deepEqual(s.end, [7, 10], 'and on to the other side');
  assert.equal(cornerCount(s.cells), 0);
});

test('smart: retracting an L goes back through the corner, segment by segment', () => {
  const s = startAt(10, 10);
  glideToCell(s, 20, 10);
  glideToCell(s, 20, 16);
  assert.equal(cornerCount(s.cells), 1);
  glideToCell(s, 20, 13);
  assert.equal(cornerCount(s.cells), 1);
  assert.deepEqual(s.end, [20, 13]);
  glideToCell(s, 20, 10);
  assert.equal(cornerCount(s.cells), 0, 'the second leg is gone, nothing is left of the corner');
  assert.deepEqual(s.end, [20, 10]);
  glideToCell(s, 14, 10);
  assert.deepEqual(s.cells, [[10, 10], [11, 10], [12, 10], [13, 10], [14, 10]], 'the first leg is retracted too');
  assert.equal(s.axis, 'h');
});

test('smart: retracting a three-leg stroke undoes the corners one after the other', () => {
  const s = startAt(10, 10);
  glideToCell(s, 24, 10);
  glideToCell(s, 24, 18);
  glideToCell(s, 14, 18);
  assert.equal(cornerCount(s.cells), 2);
  glideToCell(s, 24, 18);
  assert.equal(cornerCount(s.cells), 1);
  glideToCell(s, 24, 10);
  assert.equal(cornerCount(s.cells), 0);
  assert.deepEqual(s.end, [24, 10]);
  glideToCell(s, 12, 10);
  assert.deepEqual(s.end, [12, 10]);
  assert.equal(s.cells.length, 3);
});

test('smart: coming back close to the line of the previous leg straightens the corner out', () => {
  const s = startAt(10, 10);
  glideToCell(s, 20, 10);
  glideToCell(s, 20, 15);
  assert.equal(cornerCount(s.cells), 1);
  glideToCell(s, 20, 10); // back at the corner
  glideToCell(s, 24, 11); // one cell below the first leg, further on: the first leg just gets longer
  assert.equal(cornerCount(s.cells), 0);
  assert.deepEqual(s.end, [24, 10]);
});

test('smart: a pointer that wanders back across the corner turns the other way', () => {
  const s = startAt(10, 10);
  glideToCell(s, 20, 10);
  glideToCell(s, 20, 15);
  glideToCell(s, 20, 7); // up past the corner: the second leg points up now
  assert.equal(cornerCount(s.cells), 1);
  assert.deepEqual(cornersOf(s.cells), [[20, 10]]);
  assert.deepEqual(s.end, [20, 7]);
  assertNoDuplicates(s.cells);
});

// ---- fast jumps ----------------------------------------------------------------------------------------------------

test('smart: one huge pointer jump leaves no gap', () => {
  const s = startAt(5, 5);
  s.move(45.5, 5.5);
  assert.equal(s.cells.length, 41);
  assertContiguous(s.cells);
  assert.deepEqual(s.end, [45, 5]);
  s.move(45.5, 30.5);
  assert.equal(cornerCount(s.cells), 1);
  assert.equal(s.cells.length, 41 + 25);
  assertContiguous(s.cells);
  assertNoDuplicates(s.cells);
});

test('smart: the result does not depend on how often the pointer was sampled', () => {
  const path = [[10.5, 10.5], [24.5, 10.5], [24.5, 19.5], [12.5, 19.5]];
  const sampled = (step) => {
    const s = createStroke({ at: path[0] });
    path.slice(1).forEach(([x, y]) => glide(s, x, y, step));
    return s.cells;
  };
  const fine = sampled(0.05);
  assert.deepEqual(sampled(0.5), fine);
  assert.deepEqual(sampled(1), fine);
  assert.deepEqual(sampled(3), fine, 'one sample every three cells: the corners were reached by the samples');
  assert.equal(cornerCount(fine), 2);
});

test('smart: a fast diagonal jump is interpolated along the way the pointer took (a staircase, never a gap)', () => {
  const s = startAt(0, 0);
  s.move(10.5, 6.5);
  assertContiguous(s.cells);
  assert.deepEqual(s.cells[0], [0, 0]);
  assert.deepEqual(s.end, [10, 6]);
  assert.ok(cornerCount(s.cells) >= 2, 'a diagonal pointer path makes a staircase');
  const again = startAt(0, 0);
  glide(again, 10.5, 6.5, 0.1);
  assertContiguous(again.cells);
  assert.deepEqual(again.end, [10, 6], 'a slow diagonal ends in the same cell');
});

// ---- jitter fuzz: the heart of the feature -------------------------------------------------------------------------

/** A jittery drag along one axis: the pointer wobbles up to `amp` cells around the centre line, in steps from tiny to huge. */
function jitteryDrag(rng, amp) {
  const horizontal = rng.next() < 0.5;
  const sign = rng.next() < 0.5 ? -1 : 1;
  const cx = 30 + rng.int(20);
  const cy = 30 + rng.int(20);
  const length = 3 + rng.int(40) + rng.next(); // cells of travel along the axis, at least 3
  const press = [cx + rng.range(0.02, 0.98), cy + rng.range(0.02, 0.98)];
  const centre = horizontal ? cy + 0.5 : cx + 0.5; // the centre line of the start cell
  const along0 = horizontal ? press[0] : press[1];
  const samples = [];
  let travelled = 0;
  while (travelled < length) {
    const step = rng.next() < 0.1 ? rng.range(2, 12) : rng.range(0.02, 1.2); // slow movement with the odd fast jump
    travelled = Math.min(length, travelled + step);
    const back = rng.next() < 0.15 ? rng.range(0, 0.8) : 0; // the hand also wobbles along the line
    const along = along0 + sign * Math.max(0, travelled - back);
    const across = centre + uniform(rng, amp);
    samples.push(horizontal ? [along, across] : [across, along]);
  }
  return { horizontal, sign, start: [cx, cy], press, samples, length };
}

test('smart fuzz: 1000 jittery straight drags (+-0.95 cell of noise, fast jumps, wobble along the line) make 0 corners', () => {
  const rng = createRng(20251);
  for (let i = 0; i < 1000; i++) {
    const d = jitteryDrag(rng, 0.95);
    const s = createStroke({ at: d.press });
    for (const p of d.samples) {
      s.move(p[0], p[1]);
      assert.equal(cornerCount(s.cells), 0, `drag ${i}: a corner appeared while drawing`);
    }
    const cells = s.cells;
    assertContiguous(cells, `drag ${i}`);
    assertNoDuplicates(cells, `drag ${i}`);
    assert.deepEqual(cells[0], d.start, `drag ${i}: starts in the press cell`);
    const last = d.samples.at(-1);
    const axisIndex = d.horizontal ? 0 : 1;
    assert.ok(cells.every((c) => c[1 - axisIndex] === d.start[1 - axisIndex]), `drag ${i}: the whole stroke is in the row/column of the press`);
    assert.equal(s.end[axisIndex], Math.floor(last[axisIndex]), `drag ${i}: ends at the pointer's projection`);
    assert.equal(s.axis, d.horizontal ? 'h' : 'v', `drag ${i}`);
  }
});

test('smart fuzz: with the touch threshold (turn 4) a finger wobbling +-2.95 cells also makes 0 corners', () => {
  const rng = createRng(77);
  for (let i = 0; i < 300; i++) {
    const d = jitteryDrag(rng, 2.95);
    const s = createStroke({ at: d.press, turn: 4 });
    for (const p of d.samples) s.move(p[0], p[1]);
    assert.equal(cornerCount(s.cells), 0, `drag ${i}`);
    assertContiguous(s.cells);
  }
});

/** A deliberate polyline: 2 to 5 legs of 6 to 20 cells, alternating axes, the pointer on a slightly jittery path through the corners. */
function polyline(rng, amp) {
  const legs = 2 + rng.int(4);
  let x = 30 + rng.int(10);
  let y = 30 + rng.int(10);
  const vertices = [[x, y]];
  let horizontal = rng.next() < 0.5;
  for (let i = 0; i < legs; i++) {
    const len = (6 + rng.int(15)) * (rng.next() < 0.5 ? -1 : 1);
    if (horizontal) x += len; else y += len;
    vertices.push([x, y]);
    horizontal = !horizontal;
  }
  const samples = [];
  for (let i = 1; i < vertices.length; i++) {
    const [ax, ay] = vertices[i - 1];
    const [bx, by] = vertices[i];
    const n = Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 2;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      samples.push([ax + (bx - ax) * t + 0.5 + uniform(rng, amp), ay + (by - ay) * t + 0.5 + uniform(rng, amp)]);
    }
  }
  return { legs, vertices, samples };
}

test('smart fuzz: 600 deliberate polylines (wobble +-0.45 cell) get exactly the intended corners at the intended places', () => {
  const rng = createRng(4242);
  for (let i = 0; i < 600; i++) {
    const p = polyline(rng, 0.45);
    const s = createStroke({ at: [p.vertices[0][0] + 0.5, p.vertices[0][1] + 0.5] });
    for (const q of p.samples) s.move(q[0], q[1]);
    const corners = cornersOf(s.cells);
    assert.equal(corners.length, p.legs - 1, `polyline ${i}: ${JSON.stringify(p.vertices)} gave corners ${JSON.stringify(corners)}`);
    corners.forEach((c, k) => {
      const want = p.vertices[k + 1];
      assert.ok(Math.abs(c[0] - want[0]) <= 1 && Math.abs(c[1] - want[1]) <= 1, `polyline ${i}: corner ${k} at ${key(c)}, intended ${key(want)}`);
    });
    assertContiguous(s.cells, `polyline ${i}`);
    const endWant = p.vertices.at(-1);
    assert.ok(Math.abs(s.end[0] - endWant[0]) <= 1 && Math.abs(s.end[1] - endWant[1]) <= 1, `polyline ${i}: ends at ${key(s.end)}, intended ${key(endWant)}`);
  }
});

test('smart fuzz: deliberate L shapes survive +-0.5 cell of wobble, and 1 cell on the first leg', () => {
  // The first leg runs in the row of the press cell, so it tolerates a pointer anywhere in the rows next to it. The next legs run in
  // the cell the pointer was in when it turned, so a wobble of a whole cell across them can reach the turn threshold: 0.5 is the limit.
  const rng = createRng(909);
  let shaky = 0;
  for (let i = 0; i < 600; i++) {
    const p = polyline(rng, 0.5);
    if (p.legs !== 2) continue;
    const s = createStroke({ at: [p.vertices[0][0] + 0.5, p.vertices[0][1] + 0.5] });
    for (const q of p.samples) s.move(q[0], q[1]);
    assert.equal(cornerCount(s.cells), 1, `L ${i}`);
    shaky++;
  }
  assert.ok(shaky > 100, 'enough L shapes were generated');
});

test('smart: a deliberate L (10 right, then 6 down) has exactly one corner, also with a shaky hand (+-0.45 cell)', () => {
  const rng = createRng(5);
  for (let i = 0; i < 200; i++) {
    const s = startAt(20, 20);
    for (let x = 0; x <= 10; x += 0.5) s.move(20.5 + x, 20.5 + uniform(rng, 0.45));
    for (let y = 0; y <= 6; y += 0.5) s.move(30.5 + uniform(rng, 0.45), 20.5 + y);
    assert.equal(cornerCount(s.cells), 1);
    assert.deepEqual(cornersOf(s.cells), [[30, 20]]);
    assert.deepEqual(s.end, [30, 26]);
    assert.equal(s.cells.length, 11 + 6);
  }
});

// ---- straight (Shift) ----------------------------------------------------------------------------------------------

test('straight: nothing is drawn before the axis locks at 1.5 cells, then a single straight line', () => {
  const s = startAt(10, 10, { mode: 'straight' });
  assert.equal(s.mode, 'straight');
  assert.equal(s.locked, false);
  glide(s, 10.5 + 1.2, 10.5);
  assert.deepEqual(s.cells, [[10, 10]]);
  assert.equal(s.axis, null);
  glide(s, 10.5 + 1.6, 10.5);
  assert.equal(s.axis, 'h');
  assert.equal(s.locked, true);
  assert.equal(s.cells.length, 3);
  glideToCell(s, 20, 10);
  assert.equal(s.cells.length, 11);
  assert.equal(cornerCount(s.cells), 0);
});

test('straight: the axis never flips, whatever the pointer does afterwards', () => {
  const s = startAt(10, 10, { mode: 'straight' });
  glideToCell(s, 18, 11); // locks horizontal
  assert.equal(s.axis, 'h');
  glideToCell(s, 18, 30); // the pointer swings to the vertical axis
  assert.equal(s.axis, 'h');
  assert.equal(cornerCount(s.cells), 0);
  assert.deepEqual(s.end, [18, 10], 'the line follows the pointer\'s x only');
  glideToCell(s, 10, 30);
  assert.deepEqual(s.cells, [[10, 10]]);
  glideToCell(s, 2, 25);
  assert.deepEqual(s.end, [2, 10], 'it can go to the other side of the start, still horizontal');
  assert.equal(s.axis, 'h');
  assertNoDuplicates(s.cells);
});

test('straight: the dominant axis at the moment of locking wins, vertical too', () => {
  const s = startAt(10, 10, { mode: 'straight' });
  glide(s, 10.5 + 0.7, 10.5 - 2, 0.1);
  assert.equal(s.axis, 'v');
  glideToCell(s, 30, 3);
  assert.equal(s.axis, 'v');
  assert.deepEqual(s.end, [10, 3]);
  assert.ok(s.cells.every((c) => c[0] === 10));
});

test('straight fuzz: whatever the pointer does, a straight stroke has no corners and no gaps', () => {
  const rng = createRng(31);
  for (let i = 0; i < 300; i++) {
    const s = startAt(40, 40, { mode: 'straight' });
    for (let k = 0; k < 60; k++) {
      s.move(40.5 + uniform(rng, 25), 40.5 + uniform(rng, 25));
      assert.equal(cornerCount(s.cells), 0);
    }
    assertContiguous(s.cells);
    assertNoDuplicates(s.cells);
    assert.ok(s.cells.every((c) => c[0] === 40) || s.cells.every((c) => c[1] === 40));
  }
});

// ---- Shift pressed and released in the middle of a stroke --------------------------------------------------------

test('Shift pressed mid-stroke starts a straight line from the current end', () => {
  const s = startAt(10, 10);
  glideToCell(s, 20, 10);
  glideToCell(s, 20, 15);
  assert.equal(cornerCount(s.cells), 1);
  assert.equal(s.setMode('straight'), true);
  assert.equal(s.mode, 'straight');
  assert.deepEqual(s.runStart, [20, 15], 'the new anchor is the end of the stroke so far');
  assert.equal(s.axis, null, 'a new lock is needed');
  glideToCell(s, 24, 16); // horizontal movement from the anchor: locks horizontal
  assert.equal(s.axis, 'h');
  glideToCell(s, 30, 26);
  assert.deepEqual(s.end, [30, 15]);
  assert.equal(cornerCount(s.cells), 2, 'the earlier L, then one more corner where the straight line starts');
  assertContiguous(s.cells);
  assertNoDuplicates(s.cells);
});

test('Shift released mid-stroke continues smart from the current end', () => {
  const s = startAt(10, 10, { mode: 'straight' });
  glideToCell(s, 20, 10);
  assert.equal(s.setMode('smart'), true);
  assert.deepEqual(s.runStart, [20, 10]);
  glideToCell(s, 20, 16); // a vertical excursion from the end: smart picks the vertical axis
  assert.deepEqual(s.end, [20, 16]);
  assert.equal(cornerCount(s.cells), 1);
  glideToCell(s, 20, 12);
  glideToCell(s, 14, 12);
  assertContiguous(s.cells);
  assert.equal(s.mode, 'smart');
});

test('Shift pressed and released several times keeps one contiguous stroke with the pointer position of each moment', () => {
  const s = startAt(5, 5);
  glideToCell(s, 12, 5);
  s.setMode('straight');
  glideToCell(s, 12, 12); // locks vertical from (12,5)
  assert.equal(s.axis, 'v');
  s.setMode('smart');
  glideToCell(s, 20, 12);
  s.setMode('free');
  glideToCell(s, 20, 14);
  s.setMode('smart');
  assert.equal(s.setMode('smart'), false, 'no change: nothing happens');
  assertContiguous(s.cells);
  assert.deepEqual(s.cells[0], [5, 5]);
  assert.deepEqual(s.end, [20, 14]);
  assertNoDuplicates(s.cells);
});

test('a mode change without any movement in the run just replaces the run', () => {
  const s = startAt(5, 5);
  glideToCell(s, 10, 5);
  s.setMode('straight');
  s.setMode('smart');
  s.setMode('straight');
  assert.deepEqual(s.cells, [[5, 5], [6, 5], [7, 5], [8, 5], [9, 5], [10, 5]]);
  assert.equal(s.setMode('bogus'), false);
  assert.equal(s.mode, 'straight');
});

// ---- free ----------------------------------------------------------------------------------------------------------

test('free: follows the pointer cell by cell, gaps are filled with the horizontal-first L-path', () => {
  const s = startAt(3, 2, { mode: 'free' });
  s.move(8.5, 6.5); // one jump across 5 x 4 cells
  assert.deepEqual(s.cells, [[3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [8, 3], [8, 4], [8, 5], [8, 6]]);
  assert.equal(s.axis, null);
});

test('free fuzz: identical to extendStroke for every pointer cell', () => {
  const rng = createRng(11);
  for (let i = 0; i < 200; i++) {
    const press = [20 + rng.range(0, 10), 20 + rng.range(0, 10)];
    const s = createStroke({ at: press, mode: 'free' });
    const reference = [];
    extendStroke(reference, [Math.floor(press[0]), Math.floor(press[1])]);
    for (let k = 0; k < 40; k++) {
      const u = [20 + rng.range(-8, 18), 20 + rng.range(-8, 18)];
      s.move(u[0], u[1]);
      extendStroke(reference, [Math.floor(u[0]), Math.floor(u[1])]);
    }
    assert.deepEqual(s.cells, reference);
    assertContiguous(s.cells);
  }
});

test('free: a wobbly horizontal drag keeps its wobble (that is what free means)', () => {
  const s = startAt(10, 10, { mode: 'free' });
  for (let x = 11; x <= 20; x++) glide(s, x + 0.5, 10.5 + (x % 2 ? 1 : 0), 0.25);
  assert.ok(cornerCount(s.cells) > 3);
});

// ---- invariants, determinism, bad input ---------------------------------------------------------------------------

test('invariants fuzz: any pointer path, any mode switches, always 4-neighbour steps, never a repeated cell in a row, starts at the press', () => {
  const rng = createRng(2024);
  for (let i = 0; i < 400; i++) {
    const press = [rng.range(0, 60), rng.range(0, 40)];
    const s = createStroke({ at: press, mode: DRAW_MODES[rng.int(3)], turn: 2 + rng.int(3) });
    for (let k = 0; k < 80; k++) {
      if (rng.next() < 0.1) s.setMode(DRAW_MODES[rng.int(3)]);
      const wild = rng.next() < 0.15;
      const [px, py] = s.pointer;
      s.move(px + uniform(rng, wild ? 30 : 2), py + uniform(rng, wild ? 30 : 2));
      const cells = s.cells;
      assert.deepEqual(cells[0], [Math.floor(press[0]), Math.floor(press[1])]);
      assertContiguous(cells, `stroke ${i} step ${k}`);
      assert.deepEqual(s.end, cells.at(-1), 'end is the last cell');
    }
  }
});

test('determinism: the same samples give the same stroke, call after call', () => {
  const make = () => {
    const rng = createRng(555);
    const s = createStroke({ at: [12.3, 8.7] });
    for (let k = 0; k < 200; k++) {
      if (k === 60) s.setMode('straight');
      if (k === 120) s.setMode('smart');
      const [px, py] = s.pointer;
      s.move(px + uniform(rng, 3), py + uniform(rng, 3));
    }
    return JSON.stringify(s.cells);
  };
  assert.equal(make(), make());
});

test('bad input: NaN and Infinity are ignored, an unknown mode falls back to smart', () => {
  const s = createStroke({ at: [4.5, 4.5], mode: 'wobbly' });
  assert.equal(s.mode, 'smart');
  s.move(Number.NaN, 5);
  s.move(5, Number.POSITIVE_INFINITY);
  s.move(undefined, 3);
  assert.deepEqual(s.cells, [[4, 4]]);
  glideToCell(s, 9, 4);
  assert.equal(s.cells.length, 6);
});

test('negative and out-of-range cells are fine (the editor decides what the plant area is)', () => {
  const s = createStroke({ at: [1.5, 1.5] });
  glide(s, -6.5, 1.5);
  assert.deepEqual(s.end, [-7, 1]);
  assert.equal(s.cells.length, 9);
  assertContiguous(s.cells);
});

test('a huge jump is capped, not looped forever', () => {
  const s = startAt(0, 0);
  const t0 = Date.now();
  s.move(1e9, 0.5);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(s.axis, 'h');
});
