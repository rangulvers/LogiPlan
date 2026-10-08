// Independent review of js/ui/camera.js (pure math, runs in Node). Tests whose name starts with "DEFECT" fail
// today and pin a real defect; the others guard behaviour that is correct and must stay so.
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

// ---- defects -----------------------------------------------------------------------------------------------

test('DEFECT CAM-1 (medium): fit() must show the whole plant, but MIN_ZOOM 4 px/m cuts off big plants and ignores the padding on phones', () => {
  // docs/ARCHITECTURE.md 6.2: fit() "centres and scales a layout"; model GRID_LIMITS allow 160 x 160 cells of up to 10 m.
  const cases = [
    ['default plant (96 x 64 m) on a 390 x 700 phone, 32 px padding', layoutOf(48, 32, 2), 390, 700, 32],
    ['160 x 160 cells of 2 m (320 m) on a 1440 x 900 laptop', layoutOf(GRID_LIMITS.maxCols, GRID_LIMITS.maxRows, 2), 1440, 900, 32],
    ['100 x 60 cells of 5 m (500 x 300 m) on 1440 x 900', layoutOf(100, 60, 5), 1440, 900, 32],
  ];
  const failures = [];
  for (const [label, layout, w, h, pad] of cases) {
    const cam = new Camera().fit(layout, w, h, pad);
    const [x0, y0, x1, y1] = plantOnScreen(cam, layout);
    const eps = 1e-6;
    if (x0 < pad - eps || y0 < pad - eps || x1 > w - pad + eps || y1 > h - pad + eps) {
      failures.push(`${label}: zoom ${cam.zoom.toFixed(2)} puts the plant at [${[x0, y0, x1, y1].map(Math.round)}] in a ${w} x ${h} viewport`);
    }
  }
  assert.deepEqual(failures, [], 'fit() leaves the plant outside the padded viewport');
});

test('DEFECT CAM-2 (low): a non-finite or absurd grid must not poison the camera state', () => {
  const cam = new Camera();
  cam.fit({ grid: { cols: Infinity, rows: 10, cellSize: 2 } }, 800, 600);
  assert.ok(Number.isFinite(cam.x) && Number.isFinite(cam.y), `fit() left the camera at (${cam.x}, ${cam.y})`);
});

test('DEFECT CAM-3 (low): fitRect with a maxZoom below MIN_ZOOM must keep the zoom invariant [MIN_ZOOM, MAX_ZOOM]', () => {
  const cam = new Camera().fitRect({ x: 0, y: 0, w: 10, h: 10 }, 800, 600, 32, 2);
  assert.ok(cam.zoom >= MIN_ZOOM, `zoom ${cam.zoom} < MIN_ZOOM ${MIN_ZOOM}`);
});

test('DEFECT CAM-4 (low): screenToCell is documented to ignore non-finite input but returns NaN cells', () => {
  const cam = new Camera({ width: 800, height: 600 });
  const cell = cam.screenToCell(NaN, 5, 2);
  assert.ok(cell.every(Number.isFinite), `got ${JSON.stringify(cell)}`);
});
