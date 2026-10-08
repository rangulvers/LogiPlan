import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Camera, MIN_ZOOM, MAX_ZOOM, plantBounds } from '../js/ui/camera.js';
import { emptyLayout } from '../js/model/defaults.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

test('camera: world <-> screen roundtrip at several zooms and centres', () => {
  for (const zoom of [MIN_ZOOM, 7.3, 20, 61.5, MAX_ZOOM]) {
    const cam = new Camera({ x: 13.4, y: -2.2, zoom, width: 800, height: 600 });
    for (const [wx, wy] of [[0, 0], [96, 64], [-5.5, 120.25], [13.4, -2.2]]) {
      const [px, py] = cam.worldToScreen(wx, wy);
      const [bx, by] = cam.screenToWorld(px, py);
      near(bx, wx, 1e-9);
      near(by, wy, 1e-9);
    }
  }
});

test('camera: the world point at (x, y) is drawn at the viewport centre', () => {
  const cam = new Camera({ x: 10, y: 20, zoom: 30, width: 640, height: 480 });
  assert.deepEqual(cam.worldToScreen(10, 20), [320, 240]);
  assert.deepEqual(cam.screenToWorld(320, 240), [10, 20]);
});

test('camera: out parameter is filled and returned (no allocation in hot loops)', () => {
  const cam = new Camera({ zoom: 10, width: 100, height: 100 });
  const out = [0, 0];
  assert.equal(cam.worldToScreen(1, 1, out), out);
  assert.equal(cam.screenToWorld(50, 50, out), out);
});

test('camera: zoomAt keeps the world point under the cursor fixed', () => {
  const cam = new Camera({ x: 40, y: 25, zoom: 20, width: 1000, height: 700 });
  for (const [px, py, factor] of [[0, 0, 1.25], [1000, 700, 0.8], [123, 456, 2], [500, 350, 0.5], [731, 18, 1.1]]) {
    const before = cam.screenToWorld(px, py);
    assert.ok(cam.zoomAt(factor, px, py));
    const after = cam.screenToWorld(px, py);
    near(after[0], before[0], 1e-9);
    near(after[1], before[1], 1e-9);
  }
});

test('camera: zoom is clamped to [4, 80] px/m and a clamped no-op reports false and moves nothing', () => {
  const cam = new Camera({ x: 5, y: 6, zoom: 20, width: 400, height: 300 });
  cam.zoomAt(1000, 10, 10);
  assert.equal(cam.zoom, MAX_ZOOM);
  const pos = [cam.x, cam.y];
  assert.equal(cam.zoomAt(2, 10, 10), false);
  assert.deepEqual([cam.x, cam.y], pos);
  cam.zoomAt(1e-6, 10, 10);
  assert.equal(cam.zoom, MIN_ZOOM);
  assert.equal(new Camera({ zoom: 1000 }).zoom, MAX_ZOOM);
  assert.equal(new Camera({ zoom: 0.1 }).zoom, MIN_ZOOM);
  assert.equal(MIN_ZOOM, 4);
  assert.equal(MAX_ZOOM, 80);
});

test('camera: clamped zoom still keeps the cursor point fixed', () => {
  const cam = new Camera({ x: 0, y: 0, zoom: 70, width: 800, height: 600 });
  const before = cam.screenToWorld(200, 100);
  cam.zoomAt(5, 200, 100); // wants 350, clamps to 80
  assert.equal(cam.zoom, 80);
  const after = cam.screenToWorld(200, 100);
  near(after[0], before[0]);
  near(after[1], before[1]);
});

test('camera: invalid zoom factors and positions are ignored, not propagated as NaN', () => {
  const cam = new Camera({ x: 1, y: 2, zoom: 20, width: 100, height: 100 });
  for (const bad of [0, -1, NaN, Infinity, undefined, null]) assert.equal(cam.zoomAt(bad, 10, 10), false);
  assert.deepEqual([cam.x, cam.y, cam.zoom], [1, 2, 20]);
  assert.ok(cam.zoomAt(2, NaN, undefined)); // falls back to zooming about the centre
  assert.ok(Number.isFinite(cam.x) && Number.isFinite(cam.y));
  assert.deepEqual(cam.worldToScreen(1, 2), [50, 50]);
});

test('camera: pan moves the content with the pointer', () => {
  const cam = new Camera({ x: 0, y: 0, zoom: 20, width: 400, height: 400 });
  const before = cam.worldToScreen(3, 4);
  cam.pan(40, -20);
  const after = cam.worldToScreen(3, 4);
  near(after[0], before[0] + 40);
  near(after[1], before[1] - 20);
  cam.pan(NaN, undefined);
  assert.ok(Number.isFinite(cam.x) && Number.isFinite(cam.y));
});

test('camera: screenToCell floors (negatives too) and never yields -0', () => {
  const cam = new Camera({ x: 0, y: 0, zoom: 10, width: 0, height: 0 });
  assert.deepEqual(cam.screenToCell(25, 25, 2), [1, 1]);
  assert.deepEqual(cam.screenToCell(-1, -19, 2), [-1, -1]);
  assert.deepEqual(cam.screenToCell(0, 0, 2), [0, 0]);
  assert.ok(Object.is(cam.screenToCell(-0, 0, 2)[0], 0));
  assert.deepEqual(cam.screenToCell(25, 25, 0), [2, 2], 'a broken cellSize does not produce NaN');
});

test('camera: fit centres the baseplate and leaves the requested padding', () => {
  const layout = emptyLayout({ grid: { cols: 48, rows: 32, cellSize: 2 } }); // 96 x 64 m
  const cam = new Camera();
  cam.fit(layout, 1000, 700, 50);
  assert.equal(cam.x, 48);
  assert.equal(cam.y, 32);
  // 900 / 96 = 9.375 (width limited), 600 / 64 = 9.375 -> exact tie: both fill
  near(cam.zoom, 9.375);
  const topLeft = cam.worldToScreen(0, 0);
  const bottomRight = cam.worldToScreen(96, 64);
  near(topLeft[0], 50);
  near(topLeft[1], 50);
  near(bottomRight[0], 950);
  near(bottomRight[1], 650);
});

test('camera: fit is limited by the tighter axis and centres on the other', () => {
  const layout = emptyLayout({ grid: { cols: 40, rows: 10, cellSize: 1 } }); // 40 x 10 m
  const cam = new Camera().fit(layout, 800, 800, 0);
  near(cam.zoom, 20); // 800 / 40
  const tl = cam.worldToScreen(0, 0);
  const br = cam.worldToScreen(40, 10);
  near(tl[0], 0);
  near(br[0], 800);
  near((tl[1] + br[1]) / 2, 400); // vertically centred
});

test('camera: fit clamps to the zoom range and survives tiny / zero viewports and null layouts', () => {
  const huge = emptyLayout({ grid: { cols: 160, rows: 160, cellSize: 10 } });
  assert.equal(new Camera().fit(huge, 800, 600, 10).zoom, MIN_ZOOM);
  const tiny = emptyLayout({ grid: { cols: 8, rows: 8, cellSize: 0.5 } });
  assert.equal(new Camera().fit(tiny, 2000, 2000, 10).zoom, MAX_ZOOM);
  const cam = new Camera().fit(tiny, 0, 0, 32);
  assert.ok(Number.isFinite(cam.zoom) && cam.zoom >= MIN_ZOOM && Number.isFinite(cam.x));
  const none = new Camera().fit(null, 960, 640, 32);
  assert.ok(Number.isFinite(none.zoom) && none.x > 0, 'null layout fits the default grid');
  const padded = new Camera().fit(tiny, 100, 100, 1e6);
  assert.ok(Number.isFinite(padded.zoom), 'absurd padding cannot produce a negative scale');
});

test('camera: fit records the viewport so world <-> screen works straight away', () => {
  const layout = emptyLayout();
  const cam = new Camera().fit(layout, 1200, 800, 24);
  assert.equal(cam.width, 1200);
  assert.equal(cam.height, 800);
  assert.deepEqual(cam.worldToScreen(cam.x, cam.y), [600, 400]);
});

test('camera: fitRect honours maxZoom and visibleRect matches the viewport', () => {
  const cam = new Camera().fitRect({ x: 10, y: 10, w: 2, h: 2 }, 800, 600, 20, 30);
  assert.equal(cam.zoom, 30);
  assert.equal(cam.x, 11);
  const v = cam.visibleRect();
  near(v.x1 - v.x0, 800 / 30);
  near(v.y1 - v.y0, 600 / 30);
  near((v.x0 + v.x1) / 2, 11);
});

test('camera: setViewport sanitises, clone is independent, centerOn ignores junk', () => {
  const cam = new Camera({ x: 1, y: 1, zoom: 12 }).setViewport(-5, NaN);
  assert.deepEqual([cam.width, cam.height], [0, 0]);
  const copy = cam.clone();
  copy.pan(100, 100);
  assert.notEqual(copy.x, cam.x);
  assert.equal(copy.zoom, 12);
  cam.centerOn(NaN, 7);
  assert.deepEqual([cam.x, cam.y], [1, 7]);
});

test('camera: plantBounds multiplies grid by cell size and falls back for junk', () => {
  assert.deepEqual(plantBounds(emptyLayout({ grid: { cols: 10, rows: 5, cellSize: 3 } })), { x: 0, y: 0, w: 30, h: 15 });
  assert.deepEqual(plantBounds(null), { x: 0, y: 0, w: 96, h: 64 });
  assert.deepEqual(plantBounds({ grid: { cols: 0, rows: -1, cellSize: NaN } }), { x: 0, y: 0, w: 96, h: 64 });
});
