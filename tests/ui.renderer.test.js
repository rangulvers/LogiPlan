// Renderer tests without a browser: a recording fake canvas stands in for the DOM. They check caching,
// robustness against odd input, hit-test priorities, text rules and export sizing. Pixel-level looks are
// verified by tests/e2e/render-visual.mjs in headless Chromium.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer, createView } from '../js/ui/renderer.js';
import { Camera } from '../js/ui/camera.js';
import { getTheme } from '../js/ui/theme.js';
import { getScene } from '../js/ui/render/scene.js';
import { quadPoint } from '../js/ui/render/geometry.js';
import { layoutFromAscii } from './helpers/ascii.js';
import { emptyLayout } from '../js/model/defaults.js';

// ---- fake canvas -----------------------------------------------------------------------------------------------

const NOOPS = [
  'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arcTo', 'rect', 'fill', 'stroke', 'clip', 'strokeRect',
  'clearRect', 'strokeText', 'setLineDash', 'quadraticCurveTo', 'bezierCurveTo', 'translate', 'scale', 'rotate', 'drawImage', 'setTransform', 'ellipse',
];

class FakeContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.calls = 0;
    this.record = false;
    this.texts = [];
    this.arcs = [];
    this.fillRects = [];
    this.font = '';
    this.fillStyle = '#000';
  }

  fillText(text) {
    this.calls++;
    if (this.record) this.texts.push(String(text));
  }

  arc(x, y, r) {
    this.calls++;
    if (this.record) this.arcs.push(Math.round(r * 1000) / 1000);
  }

  fillRect(x, y, w, h) {
    this.calls++;
    if (this.record) this.fillRects.push({ x, y, w, h, fillStyle: this.fillStyle });
  }

  measureText(text) {
    return { width: String(text).length * 6 };
  }
}
for (const name of NOOPS) FakeContext.prototype[name] = function noop() { this.calls++; };

class FakeCanvas {
  constructor(width = 0, height = 0) {
    this.width = width;
    this.height = height;
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.ctx = new FakeContext(this);
  }

  getContext() {
    return this.ctx;
  }

  toDataURL() {
    return `data:image/png;base64,FAKE${this.width}x${this.height}`;
  }
}

/** Renderer on a fake canvas of the given CSS size, with all offscreen canvases recorded in `made`. */
function setup(layout, { w = 800, h = 600, dpr = 1, zoom = 20, theme = 'light', sim = null, camera: cam } = {}) {
  const canvas = new FakeCanvas();
  canvas.clientWidth = w;
  canvas.clientHeight = h;
  const made = [];
  const clock = { t: 0 };
  const camera = cam || new Camera({ x: 10, y: 8, zoom });
  const renderer = new Renderer(canvas, {
    camera, theme, dpr, now: () => clock.t, createCanvas: (cw, ch) => { const c = new FakeCanvas(cw, ch); made.push(c); return c; },
  });
  renderer.layout = layout;
  renderer.sim = sim;
  return { renderer, canvas, camera, made, clock, ctx: canvas.ctx };
}

/** A 10 x 8 cell plant: source A, sink B, a road, a wall block, one free label. */
function smallPlant() {
  const layout = layoutFromAscii(['AAA...BBB.', '+++++++++.', '..........', '..##......'], {
    stations: { A: { type: 'source', name: 'Goods in' }, B: { type: 'sink', name: 'Shipping' } }, flows: [['A', 'B']],
  });
  layout.labels.push({ id: 'l1', x: 5, y: 3.5, text: 'Dock' });
  return layout;
}

const screenOfCell = (camera, cx, cy, cs = 2) => camera.worldToScreen((cx + 0.5) * cs, (cy + 0.5) * cs);

function fakeVehicle(id, x, y, extra = {}) {
  return {
    id, fleetId: 'v1', color: '#2d7ff9', state: 'toDrop', load: [], battery: 1, visible: true,
    x, y, heading: 0, prevX: x - 0.1, prevY: y, prevHeading: 0,
    tv: { length: 1.2, width: 0.66, waiting: false, disabled: false }, fleet: { id: 'v1', battery: { enabled: false } }, ...extra,
  };
}

// ---- robustness ---------------------------------------------------------------------------------------------------

test('renderer: renders nothing but the background for a null layout and survives every call', () => {
  const { renderer, ctx, canvas } = setup(null);
  renderer.render(0.5);
  assert.ok(ctx.calls > 0, 'cleared and filled the background');
  assert.deepEqual(renderer.hitTest(100, 100).kind, 'cell');
  assert.equal(typeof renderer.toDataURL(), 'string');
  assert.equal(canvas.width, 800);
});

test('renderer: empty layout, empty grid and layouts without optional collections', () => {
  const { renderer } = setup(emptyLayout({ grid: { cols: 8, rows: 8, cellSize: 1 } }));
  renderer.render(0);
  renderer.render(1);
  renderer.layout = { grid: { cols: 8, rows: 8, cellSize: 1 } };
  renderer.render(1);
  assert.equal(renderer.hitTest(5, 5).kind, 'cell');
  renderer.layout = {};
  renderer.render(1);
  renderer.toDataURL({ scale: 2 });
});

test('renderer: a 0 x 0 canvas draws nothing and does not throw', () => {
  const { renderer, canvas, ctx } = setup(smallPlant(), { w: 0, h: 0 });
  const before = ctx.calls;
  renderer.render(1);
  assert.equal(ctx.calls, before);
  assert.equal(canvas.width, 0);
  assert.equal(renderer.hitTest(1, 1).kind !== undefined, true);
  canvas.clientWidth = 400;
  canvas.clientHeight = 300;
  renderer.resize();
  renderer.render(1);
  assert.equal(canvas.width, 400);
  assert.ok(ctx.calls > before);
});

test('renderer: huge zoom, NaN and out-of-range camera values do not throw', () => {
  const { renderer, camera } = setup(smallPlant());
  camera.zoom = 1e9;
  renderer.render(1);
  renderer.hitTest(10, 10);
  camera.zoom = 1e-9;
  renderer.render(1);
  camera.zoom = 20;
  camera.x = NaN;
  camera.y = Infinity;
  renderer.render(1);
  renderer.hitTest(5, 5);
  camera.x = 1e12;
  camera.y = -1e12;
  renderer.render(1);
  renderer.render(NaN);
  renderer.render(-3);
  renderer.render(42);
  renderer.render(undefined);
});

test('renderer: a simulation without optional fields is drawn without errors', () => {
  const layout = smallPlant();
  const { renderer } = setup(layout);
  const sims = [
    {}, { vehicles: [] }, { vehicles: [null, undefined, {}, { x: NaN, y: 1 }, { x: 1, y: 1, tv: null }] },
    { stations: [{ id: 'A' }, { id: 'B', type: 'sink' }], logistics: {} },
    { logistics: { stationById: new Map([['A', { id: 'A', type: 'source', state: 7, fill: 'x', fillLabel: null, yard: -2 }]]), flows: 'nope' } },
    { traffic: { activeDeadlocks: 5 } }, { traffic: { activeDeadlocks: [null, 'x', {}, { nodes: 'a' }, { node: 1e9 }, -4, 1.5] } },
    { heat: () => null, graph: { edges: [] } }, { heat: () => { throw new Error('rebuilding'); }, graph: { edges: [] } },
    { heat: () => ({}), graph: { edges: [{ id: 0, from: 5, to: 6, dir: 1, rev: -1 }] } },
  ];
  for (const heat of ['off', 'traffic', 'waiting']) {
    renderer.view.overlays.heat = heat;
    renderer.view.overlays.ids = true;
    for (const sim of sims) {
      renderer.sim = sim;
      renderer.render(0.3);
      renderer.hitTest(50, 50);
      renderer.toDataURL({ scale: 0.5 });
    }
  }
});

test('renderer: partial or missing view objects fall back to defaults', () => {
  const { renderer } = setup(smallPlant());
  renderer.view = {};
  renderer.render(1);
  renderer.view = { selection: { kind: 'station', ids: ['A', 'ghost'] }, hover: { kind: 'station', id: 'nope' }, resizeHandles: true };
  renderer.render(1);
  renderer.view = { selection: { kind: 'cell', ids: ['2,3', [4, 4], 'junk', null] }, hover: { kind: 'cell', cell: [1, 1] }, ghost: { kind: 'obstacle', rect: { x: 1.4, y: 2, w: 0, h: 3 }, valid: false } };
  renderer.render(1);
  renderer.view = { paintPreview: { cells: [[1, 1]], oneWay: true }, flowPreview: { fromId: 'missing', toPoint: [3, 3] }, marquee: { x: 0, y: 0, w: -5, h: 0 } };
  renderer.render(1);
  renderer.view = { ghost: { kind: 'station', type: 'unknown-type', rect: { x: 0, y: 0, w: 2, h: 2 }, valid: true }, selection: { kind: 'flow', ids: ['f1'] } };
  renderer.render(1);
  renderer.view = null;
  renderer.render(1);
  renderer.view = createView();
  renderer.render(1);
});

// ---- static layer cache ------------------------------------------------------------------------------------------------

test('renderer: the static layer is rebuilt only when layout, theme, toggles, size, dpr or zoom bucket change', () => {
  const layout = smallPlant();
  const { renderer, canvas, camera, clock } = setup(layout);
  renderer.render(1);
  assert.equal(renderer.stats.staticBuilds, 1);
  for (let i = 0; i < 20; i++) { renderer.render(i / 20); clock.t += 16; }
  assert.equal(renderer.stats.staticBuilds, 1, 'plain frames and alpha changes reuse the bitmap');
  camera.pan(30, -20);
  renderer.render(1);
  assert.equal(renderer.stats.staticBuilds, 1, 'panning inside the cached window reuses it');
  renderer.view.ghost = { kind: 'station', type: 'sink', rect: { x: 1, y: 5, w: 3, h: 2 }, valid: true };
  renderer.view.selection = { kind: 'station', ids: ['A'] };
  renderer.render(1);
  assert.equal(renderer.stats.staticBuilds, 1, 'editing aids are not part of the static layer');
  renderer.theme = 'dark';
  renderer.render(1);
  assert.equal(renderer.stats.staticBuilds, 2, 'theme');
  renderer.layout = { ...layout };
  renderer.render(1);
  assert.equal(renderer.stats.staticBuilds, 3, 'new layout object');
  renderer.view.overlays.grid = false;
  renderer.render(1);
  assert.equal(renderer.stats.staticBuilds, 4, 'grid toggle');
  renderer.view.overlays.labels = false;
  renderer.render(1);
  assert.equal(renderer.stats.staticBuilds, 5, 'labels toggle');
  canvas.clientWidth = 640;
  renderer.resize();
  renderer.render(1);
  assert.equal(renderer.stats.staticBuilds, 6, 'canvas size');
  camera.zoomAt(1.6, 100, 100);
  renderer.render(1);
  assert.equal(renderer.stats.staticBuilds, 7, 'zoom beyond the 1.25x bucket re-renders at once');
});

test('renderer: a small zoom change scales the cached bitmap and re-renders sharp once the zoom has rested', () => {
  const { renderer, camera, clock } = setup(smallPlant());
  renderer.render(1);
  const builds = renderer.stats.staticBuilds;
  camera.zoomAt(1.1, 300, 200);
  clock.t += 5;
  renderer.render(1);
  assert.equal(renderer.stats.staticBuilds, builds, 'still the stand-in bitmap');
  clock.t += 50;
  camera.zoomAt(1.05, 300, 200);
  clock.t += 50;
  renderer.render(1);
  assert.equal(renderer.stats.staticBuilds, builds, 'a zoom that keeps changing keeps the stand-in');
  clock.t += 400;
  renderer.render(1);
  assert.equal(renderer.stats.staticBuilds, builds + 1, 'settled: one sharp re-render');
  renderer.render(1);
  assert.equal(renderer.stats.staticBuilds, builds + 1);
  renderer.destroy();
});

test('renderer: panning beyond the cached window of a big plant rebuilds the bitmap, small pans do not', () => {
  const layout = emptyLayout({ grid: { cols: 120, rows: 80, cellSize: 2 } }); // 240 x 160 m
  const { renderer, camera } = setup(layout, { zoom: 40, camera: new Camera({ x: 100, y: 80, zoom: 40 }) });
  renderer.render(1);
  assert.equal(renderer.stats.staticBuilds, 1);
  camera.pan(-60, 0); // 1.5 m: well inside the margin
  renderer.render(1);
  assert.equal(renderer.stats.staticBuilds, 1);
  camera.pan(-2400, 0); // 60 m
  renderer.render(1);
  assert.equal(renderer.stats.staticBuilds, 2);
  const cached = renderer._layer.canvas;
  assert.ok(cached.width * cached.height < 4e6, 'the bitmap covers the viewport plus a margin, not the whole plant');
});

test('renderer: nothing is built when the baseplate is out of view', () => {
  const { renderer, camera } = setup(smallPlant());
  camera.x = 5000;
  renderer.render(1);
  assert.equal(renderer.stats.staticBuilds, 0);
  camera.x = 10;
  renderer.render(1);
  assert.equal(renderer.stats.staticBuilds, 1);
});

test('renderer: devicePixelRatio scales the backing store and the static bitmap', () => {
  const { renderer, canvas, made } = setup(smallPlant(), { dpr: 2 });
  assert.equal(canvas.width, 1600);
  assert.equal(canvas.height, 1200);
  renderer.render(1);
  const bitmap = made[0];
  assert.ok(bitmap.width > 20 * 20 * 2 * 0.9, `bitmap is rendered at device resolution: ${bitmap.width}`);
  assert.equal(renderer.camera.width, 800, 'the camera works in CSS pixels');
});

// ---- hit testing ---------------------------------------------------------------------------------------------------------

test('hitTest: stations, obstacles, labels, flows and plain cells', () => {
  const layout = smallPlant();
  const { renderer, camera } = setup(layout);
  renderer.render(1);
  const at = (cx, cy) => renderer.hitTest(...screenOfCell(camera, cx, cy));
  assert.deepEqual(pick(at(1, 0), ['kind', 'id']), { kind: 'station', id: 'A' });
  assert.deepEqual(pick(at(7, 0), ['kind', 'id']), { kind: 'station', id: 'B' });
  assert.equal(at(2, 3).kind, 'obstacle');
  assert.equal(at(4, 1).kind, 'cell', 'a road cell is just a cell');
  assert.deepEqual(at(4, 1).cell, [4, 1]);
  const label = renderer.hitTest(...camera.worldToScreen(10, 7));
  assert.deepEqual(pick(label, ['kind', 'id']), { kind: 'label', id: 'l1' });
  const curve = getScene(layout).flows[0].curve;
  const p = quadPoint(curve, (curve.t0 + curve.t1) / 2);
  const flow = renderer.hitTest(...camera.worldToScreen(p[0], p[1]));
  assert.deepEqual(pick(flow, ['kind', 'id']), { kind: 'flow', id: 'f1' });
  const [fx, fy] = camera.worldToScreen(p[0], p[1]);
  assert.equal(renderer.hitTest(fx, fy + 4).kind, 'flow', 'within 6 px');
  assert.notEqual(renderer.hitTest(fx, fy + 12).kind, 'flow', 'beyond 6 px');
  renderer.view.overlays.flows = false;
  assert.notEqual(renderer.hitTest(fx, fy).kind, 'flow', 'a hidden flow layer cannot be hit');
});

test('hitTest: always returns the cell, also outside the grid and for junk input', () => {
  const { renderer, camera } = setup(smallPlant());
  const far = renderer.hitTest(-500, -500);
  assert.equal(far.kind, 'cell');
  assert.ok(far.cell[0] < 0 && far.cell[1] < 0);
  assert.deepEqual(renderer.hitTest(NaN, undefined).cell, camera.screenToCell(0, 0, 2));
  const none = setup(null).renderer.hitTest(10, 10);
  assert.equal(none.kind, 'cell');
  assert.ok(Array.isArray(none.cell) && none.cell.length === 2);
});

test('hitTest: vehicles win over stations, hidden vehicles are ignored, the top-most vehicle wins', () => {
  const layout = smallPlant();
  const a = fakeVehicle('v1#1', 2, 1); // on top of station A (x 0..6 m, y 0..2 m)
  const hidden = fakeVehicle('v1#2', 13, 1, { visible: false }); // on top of station B
  const under = fakeVehicle('v1#3', 2.2, 1.1);
  const { renderer, camera } = setup(layout, { sim: { vehicles: [under, a, hidden] } });
  renderer.render(1);
  assert.deepEqual(pick(renderer.hitTest(...camera.worldToScreen(2, 1)), ['kind', 'id']), { kind: 'vehicle', id: 'v1#1' }, 'later in the list = drawn on top');
  assert.deepEqual(pick(renderer.hitTest(...camera.worldToScreen(13, 1)), ['kind', 'id']), { kind: 'station', id: 'B' });
  const [px, py] = camera.worldToScreen(2, 1);
  assert.equal(renderer.hitTest(px + 40, py).kind, 'station', 'beyond the padded body');
});

test('hitTest: a rotated vehicle is hit along its body, not in its bounding circle', () => {
  const v = fakeVehicle('v1#1', 6, 5, { heading: Math.PI / 2, prevHeading: Math.PI / 2, prevX: 6, prevY: 5 });
  const { renderer, camera } = setup(smallPlant(), { sim: { vehicles: [v] } });
  renderer.render(1);
  const [px, py] = camera.worldToScreen(6, 5);
  assert.equal(renderer.hitTest(px, py + 10).kind, 'vehicle', 'along the (vertical) body');
  assert.notEqual(renderer.hitTest(px + 11, py).kind, 'vehicle', 'beside the body');
});

test('hitTest: resize handles beat labels and stations; the body of a selected item reports move', () => {
  const layout = smallPlant();
  const { renderer, camera } = setup(layout);
  renderer.view.selection = { kind: 'station', ids: ['A'] };
  renderer.view.resizeHandles = true;
  renderer.render(1);
  const [x0, y0] = camera.worldToScreen(0, 0); // station A: x 0..6 m, y 0..2 m
  const corner = renderer.hitTest(x0 + 2, y0 + 1);
  assert.deepEqual(pick(corner, ['kind', 'id', 'handle']), { kind: 'station', id: 'A', handle: 'nw' });
  const [x1, y1] = camera.worldToScreen(6, 2);
  assert.equal(renderer.hitTest(x1, y1).handle, 'se');
  assert.equal(renderer.hitTest(...camera.worldToScreen(3, 0)).handle, 'n');
  assert.equal(renderer.hitTest(...camera.worldToScreen(0, 1)).handle, 'w');
  const body = renderer.hitTest(...camera.worldToScreen(3, 1));
  assert.deepEqual(pick(body, ['kind', 'id', 'handle']), { kind: 'station', id: 'A', handle: 'move' });
  assert.equal(renderer.hitTest(...camera.worldToScreen(13, 1)).handle, undefined, 'unselected stations have no handle');
  renderer.view.resizeHandles = false;
  assert.equal(renderer.hitTest(x0 + 2, y0 + 1).handle, 'move', 'no handles when switched off, but the body still moves');
  renderer.view.selection = { kind: 'obstacle', ids: ['o1'] };
  renderer.view.resizeHandles = true;
  const ob = layout.obstacles[0];
  const [ox, oy] = camera.worldToScreen(ob.x * 2, ob.y * 2);
  assert.equal(renderer.hitTest(ox + 1, oy + 1).handle, 'nw', 'obstacles have handles too');
  renderer.view.selection = { kind: 'station', ids: ['A', 'B'] };
  assert.equal(renderer.hitTest(x0 + 2, y0 + 1).handle, 'move', 'a multi-selection has no handles');
});

const pick = (obj, keys) => Object.fromEntries(keys.map((k) => [k, obj[k]]));

// ---- text rules ---------------------------------------------------------------------------------------------------------------

function textsAt(layout, zoom, patch = {}) {
  const { renderer, ctx } = setup(layout, { zoom, ...patch });
  ctx.record = true;
  renderer.render(1);
  return ctx.texts;
}

function plantWith(name, w = 3, h = 3) {
  const rows = Array.from({ length: h + 1 }, (_, i) => (i < h ? 'A'.repeat(w) + '...' : '+'.repeat(w + 3)));
  return layoutFromAscii(rows, { stations: { A: { type: 'process', name } }, fleets: [] });
}

test('bricks: the name is shown when it fits, shortened with an ellipsis when it does not, hidden when the brick is tiny', () => {
  assert.ok(textsAt(plantWith('Press'), 20).includes('Press'));
  const long = textsAt(plantWith('Very long workstation name here'), 20).find((t) => t.endsWith('…'));
  assert.ok(long, 'ellipsised');
  assert.ok(long.length * 6 <= 82, `fits the tile: ${long}`);
  assert.ok(!textsAt(plantWith('Press'), 4).includes('Press'), 'at 4 px/m the brick is far too small for text');
  assert.ok(!textsAt(plantWith('Press'), 20, {}).includes('Pre'), 'never cuts a name that fits');
  const hidden = setup(plantWith('Press'));
  hidden.renderer.view.overlays.labels = false;
  hidden.ctx.record = true;
  hidden.renderer.render(1);
  assert.ok(!hidden.ctx.texts.includes('Press'), 'the labels toggle hides names');
});

test('bricks: live overlays appear only with a simulation (fill label, yard badge, machine count)', () => {
  const layout = plantWith('Press');
  const edit = textsAt(layout, 30);
  assert.ok(!edit.includes('2/4'));
  const sim = {
    stations: [{ id: 'A', type: 'process', state: 'busy', fill: 0.5, fillLabel: '2/4', machines: [{ state: 'busy', progress: 0.5 }] }],
  };
  assert.ok(textsAt(layout, 30, { sim }).includes('2/4'));
  const source = layoutFromAscii(['AAA...', '++++++'], { stations: { A: { type: 'source', name: 'In' } }, fleets: [] });
  const yard = textsAt(source, 30, { sim: { stations: [{ id: 'A', type: 'source', state: 'blocked', fill: 1, fillLabel: '6/6', yard: 7 }] } });
  assert.ok(yard.includes('7'), 'yard badge shows the backlog');
  const noYard = textsAt(source, 30, { sim: { stations: [{ id: 'A', type: 'source', state: 'normal', fill: 0.2, fillLabel: '1/6', yard: 0 }] } });
  assert.ok(!noYard.includes('0'), 'no badge without a backlog');
});

test('vehicles: ids are drawn for visible vehicles only and only when the toggle is on', () => {
  const layout = smallPlant();
  const sim = { vehicles: [fakeVehicle('v1#1', 6, 5), fakeVehicle('v1#2', 9, 5, { visible: false })] };
  const off = setup(layout, { sim });
  off.ctx.record = true;
  off.renderer.render(1);
  assert.ok(!off.ctx.texts.includes('v1#1'));
  const on = setup(layout, { sim });
  on.renderer.view.overlays.ids = true;
  on.ctx.record = true;
  on.renderer.render(1);
  assert.ok(on.ctx.texts.includes('v1#1'));
  assert.ok(!on.ctx.texts.includes('v1#2'));
});

test('deadlocks: rings pulse with time, stand still under reduced motion and are optional', () => {
  const layout = smallPlant();
  const sim = { vehicles: [], traffic: { activeDeadlocks: [{ nodes: [12, 13] }, 14] } };
  const ringsAt = (t, reducedMotion) => {
    const { renderer, clock, ctx } = setup(layout, { sim });
    renderer._motion = { matches: reducedMotion };
    clock.t = t;
    ctx.record = true;
    renderer.render(1);
    return ctx.arcs.join(',');
  };
  assert.notEqual(ringsAt(0, false), ringsAt(500, false), 'the rings expand over time');
  assert.equal(ringsAt(0, true), ringsAt(500, true), 'reduced motion: identical frames');
  assert.equal(ringsAt(0, false), ringsAt(1200, false), 'one pulse period');
  const plain = setup(layout, { sim: { vehicles: [], traffic: {} } });
  plain.ctx.record = true;
  plain.renderer.render(1);
  assert.ok(plain.ctx.arcs.length < ringsAt(0, false).split(',').length, 'no rings without deadlocks');
});

test('renderer: reducedMotion option and prefers-reduced-motion media query', () => {
  assert.equal(new Renderer(Object.assign(new FakeCanvas(), { clientWidth: 10, clientHeight: 10 }), { camera: new Camera(), reducedMotion: true })._motion.matches, true);
  const saved = globalThis.matchMedia;
  try {
    globalThis.matchMedia = (q) => ({ matches: q.includes('reduced-motion') });
    assert.equal(new Renderer(Object.assign(new FakeCanvas(), { clientWidth: 10, clientHeight: 10 }), { camera: new Camera() })._motion.matches, true);
    globalThis.matchMedia = () => { throw new Error('sandboxed'); };
    assert.equal(new Renderer(Object.assign(new FakeCanvas(), { clientWidth: 10, clientHeight: 10 }), { camera: new Camera() })._motion.matches, false);
  } finally {
    if (saved === undefined) delete globalThis.matchMedia; else globalThis.matchMedia = saved;
  }
});

// ---- heat ------------------------------------------------------------------------------------------------------------------

function heatSim() {
  const layout = layoutFromAscii(['++++', '....']);
  const edges = [{ id: 0, from: 0, to: 1, dir: 1, rev: 3 }, { id: 1, from: 1, to: 2, dir: 1, rev: 4 }];
  const sim = {
    layout, settings: layout.settings, vehicles: [], calls: 0,
    graph: { cols: layout.grid.cols, rows: layout.grid.rows, nodeCount: layout.grid.cols * layout.grid.rows, cellSize: 2, edges },
    heat() {
      sim.calls++;
      return { edgePasses: Int32Array.of(10, 40), edgeWait: Float64Array.of(0, 5), nodeWait: new Float64Array(layout.grid.cols * layout.grid.rows) };
    },
  };
  return { layout, sim };
}

test('heat: sim.heat() is sampled at about 4 Hz, not every frame, and re-read when the mode changes', () => {
  const { layout, sim } = heatSim();
  const { renderer, clock } = setup(layout, { sim });
  renderer.view.overlays.heat = 'traffic';
  for (let i = 0; i < 30; i++) { renderer.render(1); clock.t += 8; } // 240 ms
  assert.equal(sim.calls, 1);
  clock.t += 30;
  renderer.render(1);
  assert.equal(sim.calls, 2, 'refreshed after 250 ms');
  renderer.view.overlays.heat = 'waiting';
  renderer.render(1);
  assert.equal(sim.calls, 3, 'mode change reads immediately');
  renderer.view.overlays.heat = 'off';
  clock.t += 1000;
  renderer.render(1);
  assert.equal(sim.calls, 3, 'no sampling while the heatmap is off');
});

test('heat: lanes of two-way roads are offset to opposite sides and the hottest edge is the only fully red one', () => {
  const { layout, sim } = heatSim();
  const { renderer, ctx } = setup(layout, { sim });
  renderer.view.overlays.heat = 'traffic';
  renderer.render(1);
  const heat = renderer._heat;
  assert.equal(heat.count, 2);
  assert.equal(heat.title, 'Traffic');
  assert.match(heat.maxLabel, /40 passes/);
  assert.equal(heat.levels[1], 63, 'the maximum maps to the top of the ramp');
  assert.ok(heat.levels[0] > 0 && heat.levels[0] < 63);
  // strips: y of a right-hand lane is below the cell centre (cs = 2 m, centre y = 1 m)
  assert.ok(heat.rects[1] + heat.rects[3] / 2 > 1, 'right-hand lane lies south of the centre line');
  assert.ok(ctx.calls > 0);
});

// ---- toDataURL ---------------------------------------------------------------------------------------------------------------

test('toDataURL: size follows the layout and scale (20 px/m at scale 1), independent of the camera', () => {
  const layout = smallPlant(); // 10 x 8 cells of 2 m = 20 x 16 m, 1 m padding
  const { renderer, made, camera } = setup(layout);
  const url = renderer.toDataURL();
  assert.match(url, /^data:image\/png;base64,/);
  assert.deepEqual([made[0].width, made[0].height], [22 * 20, 18 * 20]);
  camera.zoomAt(3, 100, 100);
  camera.pan(500, 500);
  renderer.toDataURL({ scale: 1 });
  assert.deepEqual([made[1].width, made[1].height], [22 * 20, 18 * 20], 'the on-screen camera is ignored');
  renderer.toDataURL({ scale: 2 });
  assert.deepEqual([made[2].width, made[2].height], [22 * 40, 18 * 40]);
  renderer.toDataURL({ scale: 1, padding: 3 });
  assert.deepEqual([made[3].width, made[3].height], [26 * 20, 22 * 20]);
});

test('toDataURL: huge plants and scales are capped so the canvas stays creatable', () => {
  const layout = emptyLayout({ grid: { cols: 160, rows: 160, cellSize: 10 } }); // 1600 x 1600 m
  const { renderer, made } = setup(layout);
  renderer.toDataURL({ scale: 4 });
  const c = made[0];
  assert.ok(c.width <= 8192 && c.height <= 8192, `${c.width} x ${c.height}`);
  assert.ok(c.width * c.height <= 36e6);
  assert.ok(c.width >= 1000, 'still large enough to be useful');
  const small = setup(smallPlant());
  small.renderer.toDataURL({ scale: 1e6 });
  assert.ok(small.made[0].width <= 8192);
  small.renderer.toDataURL({ scale: -3 });
  small.renderer.toDataURL({ scale: NaN, padding: NaN });
  assert.ok(small.made[2].width > 100);
});

test('toDataURL: background colour, transparency and theme override', () => {
  const layout = smallPlant();
  const first = (opts) => {
    const { renderer, made } = setup(layout, { theme: 'light' });
    made.length = 0;
    const origCreate = renderer._createCanvas;
    renderer._createCanvas = (w, h) => { const c = origCreate(w, h); c.ctx.record = true; made.push(c); return c; };
    renderer.toDataURL(opts);
    return made[0];
  };
  const full = (c) => c.ctx.fillRects.find((r) => r.w === c.width && r.h === c.height);
  assert.equal(full(first({})).fillStyle, getTheme('light').bg);
  assert.equal(full(first({ theme: 'dark' })).fillStyle, getTheme('dark').bg);
  assert.equal(full(first({ background: '#123456' })).fillStyle, '#123456');
  assert.equal(full(first({ background: null })), undefined, 'transparent export has no background fill');
  assert.equal(full(first({ background: 'transparent' })), undefined);
});

test('toDataURL: a null layout still yields a PNG data URL and a canvas without a context yields an empty string', () => {
  const { renderer } = setup(null);
  assert.match(renderer.toDataURL(), /^data:image\/png/);
  const noPng = setup(smallPlant());
  noPng.renderer._createCanvas = () => ({ width: 1, height: 1, getContext: () => new FakeContext({}) });
  assert.equal(noPng.renderer.toDataURL(), '');
});

test('toDataURL: includes live vehicles and leaves editing aids out', () => {
  const layout = smallPlant();
  const sim = { vehicles: [fakeVehicle('v1#1', 6, 5)] };
  const { renderer, made } = setup(layout, { sim });
  renderer.view.overlays.ids = true;
  renderer.view.selection = { kind: 'station', ids: ['A'] };
  renderer.view.hover = { kind: 'station', id: 'B' };
  renderer.view.marquee = { x: 0, y: 0, w: 5, h: 5 };
  const origCreate = renderer._createCanvas;
  renderer._createCanvas = (w, h) => { const c = origCreate(w, h); c.ctx.record = true; return c; };
  made.length = 0;
  renderer.toDataURL();
  const ctx = made[made.length - 1].ctx;
  assert.ok(ctx.texts.includes('v1#1'), 'vehicle with id label is part of the export');
  assert.ok(ctx.texts.includes('Goods in'));
  assert.ok(!ctx.fillRects.some((r) => r.fillStyle === getTheme('light').marqueeFill), 'no marquee in the export');
});

// ---- performance ----------------------------------------------------------------------------------------------------------

const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'/g, "''");

/** Source text of the top-level function `name` in `src` (brace matching; the sources contain no braces in strings). */
function functionSource(src, name) {
  const start = src.search(new RegExp(`(?:export )?function ${name}\\(`));
  assert.ok(start >= 0, `function ${name} not found`);
  const open = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

test('vehicle path: the per-vehicle drawing code contains no allocating constructs', async () => {
  const { readFile } = await import('node:fs/promises');
  const forbidden = [
    [/`/, 'template string'], [/=>/, 'arrow function'], [/\bfunction\s*\(/, 'function expression'], [/\bnew\s/, 'new'], [/\.\.\./, 'spread'],
    [/(?:=|\(|,|return|:)\s*\[/, 'array literal'], [/(?:=|\(|,|return)\s*\{/, 'object literal'],
    [/\.(?:map|filter|forEach|slice|concat|reduce|find|includes|push|toFixed|join)\(/, 'allocating method'], [/Object\.assign|\bMath\.hypot\(.*,.*,/, 'allocating helper'],
  ];
  const files = {
    'js/ui/render/vehicles.js': ['vehiclePose', 'vehicleSize', 'isBroken', 'drawVehicles', 'drawBody', 'drawWheels', 'drawFront', 'drawLoad', 'drawHazard', 'drawBadges', 'drawBadgeDisc'],
    'js/ui/render/glyphs.js': ['drawBolt', 'drawClock'],
    'js/ui/render/draw.js': ['roundRectPath', 'haloText', 'fontOf'],
  };
  for (const [file, names] of Object.entries(files)) {
    const src = strip(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
    for (const name of names) {
      const body = functionSource(src, name);
      for (const [re, what] of forbidden) {
        // fontOf fills its cache on first use only; every other function must be free of the construct
        if (name === 'fontOf' && (what === 'template string' || what === 'object literal')) continue;
        assert.ok(!re.test(body), `${file}: ${name}() contains a ${what}`);
      }
    }
  }
});

test('vehicle path: thousands of frames with 100 vehicles leave no growth behind (no per-frame caches or leaks)', async () => {
  const v8 = await import('node:v8');
  const vm = await import('node:vm');
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const layout = layoutFromAscii(['++++++++++', '..........']);
  const vehicles = Array.from({ length: 100 }, (_, i) => fakeVehicle(`v1#${i}`, 1 + (i % 17), 1.2, {
    heading: i * 0.1, prevHeading: i * 0.1 - 0.05, prevX: 0.9 + (i % 17), prevY: 1.2, load: i % 3 === 0 ? [{}] : [],
    state: i % 7 === 0 ? 'charging' : 'toDrop', tv: { length: 1.2, width: 0.66, waiting: i % 5 === 0, disabled: i % 11 === 0 },
  }));
  const { renderer } = setup(layout, { sim: { vehicles } });
  renderer.view.overlays.ids = true;
  for (let i = 0; i < 300; i++) renderer.render((i % 10) / 10);
  gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 5000; i++) renderer.render((i % 10) / 10);
  gc();
  const grown = process.memoryUsage().heapUsed - before;
  assert.ok(grown < 1.5e6, `heap grew by ${(grown / 1e6).toFixed(2)} MB over 5000 frames`);
});

test('robustness: absurd sizes in the data cannot stall a frame (vehicle length, station / obstacle size, bay counts)', () => {
  const layout = layoutFromAscii(['AAA..BBB.', '+++++++++', '..#......'], {
    stations: { A: { type: 'depot', name: 'Depot' }, B: { type: 'process', name: 'Press' } }, flows: [],
  });
  layout.stations[1].w = 1e9;
  layout.stations[1].h = 1e9;
  layout.obstacles[0].w = 1e9;
  layout.obstacles[0].h = 1e9;
  layout.obstacles[0].kind = 'rack';
  layout.stations.push({ id: 'ghost', type: 'sink', name: 'NaN', x: NaN, y: 0, w: 3, h: 3, params: {} });
  const hazard = fakeVehicle('v1#1', 6, 3, { tv: { length: 1e9, width: 1e-9, waiting: false, disabled: true } });
  const sim = { vehicles: [hazard, fakeVehicle('v1#2', 8, 3, { tv: { length: -5, width: Infinity } })], stations: [{ id: 'A', type: 'depot', slots: 1e9, chargers: 1e9, parked: [], charging: [] }] };
  const { renderer } = setup(layout, { sim });
  renderer.view.ghost = { kind: 'station', type: 'storage', rect: { x: 0, y: 0, w: 1e9, h: 1e9 }, valid: true };
  renderer.view.overlays.docks = true;
  const t0 = performance.now();
  renderer.render(1);
  renderer.hitTest(100, 100);
  renderer.toDataURL({ scale: 0.5 });
  assert.ok(performance.now() - t0 < 1500, 'frames stay fast');
});

// ---- fuzz --------------------------------------------------------------------------------------------------------------------

test('fuzz: random layouts, simulations, views and cameras never make the renderer throw', async () => {
  const { createRng } = await import('../js/util/rng.js');
  const rng = createRng(20240607);
  const pickOf = (list) => list[rng.int(list.length)];
  const odd = () => pickOf([0, -1, 1, 0.5, 1e9, -1e9, NaN, Infinity, undefined, null, '3', 7]);
  const types = ['source', 'process', 'storage', 'sink', 'depot', 'bogus'];
  for (let round = 0; round < 60; round++) {
    const layout = layoutFromAscii(['AAA..BBB.C', '+++++++++>', '.#..v..DD.', '.....E....'], {
      stations: Object.fromEntries('ABCDE'.split('').map((id) => [id, { type: pickOf(types.slice(0, 5)), name: pickOf(['A', 'Very long station name that never fits', '', 'x'.repeat(200), '🏭 Plant']) }])),
      flows: [['A', 'B'], ['B', 'C'], ['C', 'D']],
    });
    for (const st of layout.stations) {
      if (rng.next() < 0.15) st.type = 'bogus';
      if (rng.next() < 0.3) st[pickOf(['x', 'y', 'w', 'h'])] = odd();
    }
    for (const f of layout.flows) if (rng.next() < 0.3) f.weight = odd();
    for (const o of layout.obstacles) if (rng.next() < 0.3) o.kind = pickOf(['wall', 'rack', 'column', 'ghost', undefined]);
    if (rng.next() < 0.3) layout.grid.cellSize = pickOf([0.5, 10, 3.3]);
    for (const cell of Object.values(layout.roads)) if (rng.next() < 0.2) { cell.limit = odd(); cell.out = odd(); }
    const vehicles = Array.from({ length: rng.int(8) }, (_, i) => fakeVehicle(`f#${i}`, 20 * rng.next(), 16 * rng.next(), {
      heading: odd(), prevHeading: odd(), prevX: odd(), battery: odd(), visible: pickOf([true, false, undefined]), load: pickOf([[], [{}], null, undefined]),
      tv: pickOf([null, undefined, { length: odd(), width: odd(), waiting: pickOf([true, false]), disabled: pickOf([true, false]) }]),
    }));
    const sim = pickOf([null, {}, { vehicles }, {
      vehicles, stations: layout.stations.map((st) => ({ id: st.id, state: pickOf(['busy', 'down', 7, undefined]), fill: odd(), fillLabel: pickOf(['1/2', null, 5]),
        yard: odd(), consumed: odd(), slots: odd(), chargers: odd(), machines: pickOf([undefined, [], [{ state: 'busy', progress: odd() }], Array.from({ length: 30 }, () => ({ state: 'down' }))] ),
        parked: pickOf([undefined, [fakeVehicle('p', 0, 0)], [null]]), charging: pickOf([undefined, [fakeVehicle('c', 0, 0)]]) })),
      traffic: { activeDeadlocks: pickOf([undefined, [odd()], [{ nodes: [odd(), 3] }]]) },
    }]);
    const { renderer, camera } = setup(layout, { sim, w: pickOf([0, 5, 320, 1200]), h: pickOf([0, 5, 240, 800]), dpr: pickOf([1, 1.5, 2, 3]) });
    camera.zoomAt(pickOf([0.1, 1, 3, 10]), odd(), odd());
    camera.pan(odd(), odd());
    renderer.view = {
      selection: pickOf([undefined, { kind: 'station', ids: ['A', 'zzz', null] }, { kind: 'obstacle', ids: ['o1'] }, { kind: 'label', ids: ['l1'] }, { kind: 'cell', ids: [odd(), '1,1'] }, { kind: 'fleet', ids: [] }]),
      hover: pickOf([null, { kind: 'station', id: 'B' }, { kind: 'cell', cell: [odd(), odd()] }, { kind: 'vehicle', id: 'f#0' }, { kind: 'flow', id: 'f1' }]),
      overlays: { grid: odd(), studs: odd(), flows: odd(), docks: odd(), heat: pickOf(['off', 'traffic', 'waiting', 7]), ids: odd(), labels: odd() },
      ghost: pickOf([null, { kind: 'station', type: pickOf(types), rect: { x: odd(), y: odd(), w: odd(), h: odd() }, valid: odd() }, { kind: 'obstacle', rect: { x: 1, y: 1, w: 2, h: 2 }, valid: true }]),
      paintPreview: pickOf([null, { cells: [[odd(), odd()], [1, 1]], oneWay: odd(), dir: odd() }]),
      flowPreview: pickOf([null, { fromId: 'A', toPoint: [odd(), odd()] }]), marquee: pickOf([null, { x: odd(), y: odd(), w: odd(), h: odd() }]), resizeHandles: odd(),
    };
    for (let f = 0; f < 3; f++) {
      renderer.render(pickOf([0, 0.5, 1, odd()]));
      renderer.hitTest(odd(), odd());
      renderer.hitTest(rng.next() * 400, rng.next() * 300);
    }
    renderer.toDataURL({ scale: pickOf([0.1, 1, 3, odd()]), background: pickOf([undefined, null, '#fff']), padding: odd() });
  }
});
