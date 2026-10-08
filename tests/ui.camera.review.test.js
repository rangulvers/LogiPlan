// Independent review of js/ui/camera.js (pure math, runs in Node). The first block guards behaviour that was
// found correct; the "CAM-n" tests pin defects the review found (fit() cut big plants off, non-finite input leaked
// into the camera state) and stay as regression tests.
//
//   node --test tests/ui.camera.review.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Camera, plantBounds, MIN_ZOOM, MAX_ZOOM } from '../js/ui/camera.js';
import { emptyLayout, GRID_LIMITS } from '../js/model/defaults.js';
import { createRng } from '../js/util/rng.js';

const layoutOf = (cols, rows, cellSize) => emptyLayout({ grid: { cols, rows, cellSize } });

/** Screen rectangle [x0, y0, x1, y1] of the whole baseplate under camera `cam`. */
function plantOnScreen(cam, layout) {
  const b = plantBounds(layout);
  const [x0, y0] = cam.worldToScreen(b.x, b.y);
  const [x1, y1] = cam.worldToScreen(b.x + b.w, b.y + b.h);
  return [x0, y0, x1, y1];
}

// ---- guards: behaviour that is correct ---------------------------------------------------------------------

test('camera: zoomAt keeps the world point under the cursor fixed and stays inside [MIN_ZOOM, MAX_ZOOM]', () => {
  const rng = createRng(20240607);
  for (let i = 0; i < 5000; i++) {
    const cam = new Camera({
      x: rng.range(-50, 250), y: rng.range(-50, 250), zoom: rng.range(MIN_ZOOM, MAX_ZOOM),
      width: rng.range(300, 1800), height: rng.range(300, 1200),
    });
    const px = rng.range(0, cam.width);
    const py = rng.range(0, cam.height);
    const [wx, wy] = cam.screenToWorld(px, py);
    cam.zoomAt(rng.range(0.2, 4), px, py);
    const [sx, sy] = cam.worldToScreen(wx, wy);
    assert.ok(Math.abs(sx - px) < 1e-6 && Math.abs(sy - py) < 1e-6, `anchor moved at iteration ${i}`);
    assert.ok(cam.zoom >= MIN_ZOOM && cam.zoom <= MAX_ZOOM);
  }
});

test('camera: zooming against a limit changes nothing, junk factors are ignored', () => {
  const cam = new Camera({ x: 3, y: 4, zoom: MAX_ZOOM, width: 800, height: 600 });
  assert.equal(cam.zoomAt(1.5, 10, 10), false);
  assert.deepEqual([cam.x, cam.y, cam.zoom], [3, 4, MAX_ZOOM]);
  for (const f of [0, -2, NaN, Infinity, undefined, 'x']) {
    const c = new Camera({ zoom: 10, width: 100, height: 100 });
    assert.equal(c.zoomAt(f, 1, 1), false, `factor ${f}`);
    assert.equal(c.zoom, 10);
  }
});

test('camera: screenToCell floors, never returns -0 and handles cells left of / above the grid', () => {
  const cam = new Camera({ x: 0, y: 0, zoom: 10, width: 100, height: 100 });
  const [cx, cy] = cam.screenToCell(50, 50, 2); // world (0, 0) is the corner of cell (0, 0)
  assert.ok(Object.is(cx, 0) && Object.is(cy, 0), 'no negative zero');
  assert.deepEqual(cam.screenToCell(49.9, 49.9, 2), [-1, -1]);
  assert.deepEqual(cam.screenToCell(-1e6, -1e6, 2).map((v) => Math.sign(v)), [-1, -1]);
});

test('camera: pan moves the content with the pointer, junk deltas are ignored, clone is independent', () => {
  const cam = new Camera({ x: 10, y: 10, zoom: 20, width: 400, height: 300 });
  const before = cam.worldToScreen(12, 9);
  cam.pan(30, -20);
  const after = cam.worldToScreen(12, 9);
  assert.ok(Math.abs(after[0] - before[0] - 30) < 1e-9 && Math.abs(after[1] - before[1] + 20) < 1e-9);
  cam.pan(NaN, Infinity);
  assert.ok(Number.isFinite(cam.x) && Number.isFinite(cam.y));
  const copy = cam.clone();
  copy.pan(100, 100);
  copy.setViewport(1, 1);
  assert.notEqual(copy.x, cam.x);
  assert.equal(cam.width, 400);
});

test('camera: fit centres the baseplate and a 0 x 0 viewport does not produce NaN', () => {
  const layout = layoutOf(48, 32, 2);
  const cam = new Camera().fit(layout, 1200, 800, 40);
  const [x0, y0, x1, y1] = plantOnScreen(cam, layout);
  assert.ok(Math.abs((x0 + x1) / 2 - 600) < 1e-6 && Math.abs((y0 + y1) / 2 - 400) < 1e-6, 'centred');
  assert.ok(x0 >= 40 - 1e-6 && y0 >= 40 - 1e-6 && x1 <= 1160 + 1e-6 && y1 <= 760 + 1e-6, 'padding kept');
  const hidden = new Camera().fit(layout, 0, 0);
  assert.ok(Number.isFinite(hidden.x) && Number.isFinite(hidden.y) && Number.isFinite(hidden.zoom));
});

test('camera: fitRect honours maxZoom (a single station is not blown up)', () => {
  const cam = new Camera().fitRect({ x: 10, y: 10, w: 2, h: 2 }, 800, 600, 32, 30);
  assert.equal(cam.zoom, 30);
  assert.deepEqual([cam.x, cam.y], [11, 11]);
});

// ---- regressions of review findings ------------------------------------------------------------------------

test('CAM-1: fit() shows the whole plant inside the padding for every grid the model allows, on laptops and phones', () => {
  // docs/ARCHITECTURE.md 6.2: fit() "centres and scales a layout"; GRID_LIMITS allow 160 x 160 cells of up to 10 m.
  const cases = [
    ['default plant (96 x 64 m) on a 390 x 700 phone, 32 px padding', layoutOf(48, 32, 2), 390, 700, 32],
    ['160 x 160 cells of 2 m (320 m) on a 1440 x 900 laptop', layoutOf(GRID_LIMITS.maxCols, GRID_LIMITS.maxRows, 2), 1440, 900, 32],
    ['100 x 60 cells of 5 m (500 x 300 m) on 1440 x 900', layoutOf(100, 60, 5), 1440, 900, 32],
    ['largest allowed grid (1600 x 1600 m) on 1440 x 900', layoutOf(GRID_LIMITS.maxCols, GRID_LIMITS.maxRows, GRID_LIMITS.maxCell), 1440, 900, 32],
    ['largest allowed grid on a 390 x 700 phone', layoutOf(GRID_LIMITS.maxCols, GRID_LIMITS.maxRows, GRID_LIMITS.maxCell), 390, 700, 32],
    ['smallest allowed grid (4 x 4 m) on 1440 x 900', layoutOf(GRID_LIMITS.minCols, GRID_LIMITS.minRows, GRID_LIMITS.minCell), 1440, 900, 32],
  ];
  const failures = [];
  for (const [label, layout, w, h, pad] of cases) {
    const cam = new Camera().fit(layout, w, h, pad);
    const [x0, y0, x1, y1] = plantOnScreen(cam, layout);
    const eps = 1e-6;
    if (x0 < pad - eps || y0 < pad - eps || x1 > w - pad + eps || y1 > h - pad + eps) {
      failures.push(`${label}: zoom ${cam.zoom.toFixed(2)} puts the plant at [${[x0, y0, x1, y1].map(Math.round)}] in a ${w} x ${h} viewport`);
    }
    assert.ok(cam.zoom >= MIN_ZOOM && cam.zoom <= MAX_ZOOM, label);
  }
  assert.deepEqual(failures, [], 'fit() leaves the plant outside the padded viewport');
});

test('CAM-2: a non-finite or absurd grid must not poison the camera state', () => {
  for (const grid of [{ cols: Infinity, rows: 10, cellSize: 2 }, { cols: 10, rows: NaN, cellSize: 2 }, { cols: 1e300, rows: 1e300, cellSize: 1e300 }]) {
    const cam = new Camera();
    cam.fit({ grid }, 800, 600);
    assert.ok(Number.isFinite(cam.x) && Number.isFinite(cam.y) && Number.isFinite(cam.zoom), `fit() left the camera at (${cam.x}, ${cam.y}, ${cam.zoom}) for ${JSON.stringify(grid)}`);
  }
  const rect = new Camera().fitRect({ x: Infinity, y: NaN, w: Infinity, h: -4 }, 800, 600);
  assert.ok(Number.isFinite(rect.x) && Number.isFinite(rect.y) && Number.isFinite(rect.zoom));
});

test('CAM-3: fitRect with a maxZoom below MIN_ZOOM (or junk) keeps the zoom invariant [MIN_ZOOM, MAX_ZOOM]', () => {
  for (const maxZoom of [0.001, 0, -3, NaN, 1e9, undefined]) {
    const cam = new Camera().fitRect({ x: 0, y: 0, w: 10, h: 10 }, 800, 600, 32, maxZoom);
    assert.ok(cam.zoom >= MIN_ZOOM && cam.zoom <= MAX_ZOOM, `maxZoom ${maxZoom} gave zoom ${cam.zoom}`);
  }
});

test('CAM-4: screenToCell ignores non-finite input (the viewport centre is used) instead of returning NaN cells', () => {
  const cam = new Camera({ x: 20, y: 10, zoom: 10, width: 800, height: 600 });
  const centre = cam.screenToCell(400, 300, 2);
  assert.deepEqual(centre, [10, 5]);
  for (const [px, py] of [[NaN, 300], [400, undefined], [Infinity, -Infinity], ['x', null]]) {
    const cell = cam.screenToCell(px, py, 2);
    assert.ok(cell.every(Number.isFinite), `got ${JSON.stringify(cell)} for (${px}, ${py})`);
  }
  assert.deepEqual(cam.screenToCell(NaN, 100, 2), [centre[0], cam.screenToCell(400, 100, 2)[1]], 'only the broken axis falls back');
});
