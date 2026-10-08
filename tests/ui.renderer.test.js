// Renderer tests without a browser: a recording fake canvas stands in for the DOM. They check caching,
// robustness against odd input, hit-test priorities, text rules and export sizing. Pixel-level looks are
// verified by tests/e2e/render-visual.mjs in headless Chromium.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer, createView } from '../js/ui/renderer.js';
import { Camera } from '../js/ui/camera.js';
import { getTheme } from '../js/ui/theme.js';
import { getScene } from '../js/ui/render/scene.js';
import { bayOccupant, planContent } from '../js/ui/render/bricks.js';
import { drawHeat } from '../js/ui/render/overlays.js';
import { quadPoint } from '../js/ui/render/geometry.js';
import { layoutFromAscii } from './helpers/ascii.js';
import { emptyLayout } from '../js/model/defaults.js';

// ---- fake canvas -----------------------------------------------------------------------------------------------

const NOOPS = [
  'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arcTo', 'stroke', 'clip', 'strokeRect',
  'clearRect', 'strokeText', 'setLineDash', 'bezierCurveTo', 'translate', 'scale', 'drawImage', 'ellipse',
];

class FakeContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.calls = 0;
    this.record = false;
    this.texts = [];
    this.fonts = [];
    this.events = [];
    this.arcs = [];
    this.rotations = [];
    this.transforms = [];
    this.fillRects = [];
    this.fills = 0;
    this.rects = 0;
    this.font = '';
    this.fillStyle = '#000';
  }

  fillText(text) {
    this.calls++;
    if (this.record) {
      this.texts.push(String(text));
      this.fonts.push(this.font);
      this.events.push('text:' + text);
    }
  }

  quadraticCurveTo() {
    this.calls++;
    if (this.record) this.events.push('curve');
  }

  rotate(angle) {
    this.calls++;
    if (this.record) this.rotations.push(angle);
  }

  setTransform(a, b, c, d, e, f) {
    this.calls++;
    if (this.record) this.transforms.push([a, b, c, d, e, f]);
  }

  fill() {
    this.calls++;
    this.fills++;
  }

  rect() {
    this.calls++;
    this.rects++;
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
  assert.equal(renderer.stats.staticBuilds, 4, 'labels are drawn per frame (above the flows), so toggling them needs no rebuild');
  canvas.clientWidth = 640;
  renderer.resize();
  renderer.render(1);
  assert.equal(renderer.stats.staticBuilds, 5, 'canvas size');
  camera.zoomAt(1.6, 100, 100);
  renderer.render(1);
  assert.equal(renderer.stats.staticBuilds, 6, 'zoom beyond the 1.25x bucket re-renders at once');
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

test('simShift: while the old simulation waits for its replacement after the plan grew on the left, its vehicles are drawn and hit where the plan is now', () => {
  const layout = smallPlant(); // 2 m cells
  const v = fakeVehicle('v1#1', 2, 1);
  const bodyAt = (ctx, [x, y]) => ctx.transforms.some((t) => Math.abs(t[4] - x) < 1e-6 && Math.abs(t[5] - y) < 1e-6);
  const plain = setup(layout, { sim: { vehicles: [v] } });
  plain.ctx.record = true;
  plain.renderer.render(1);
  const at = (camera, x, y) => camera.worldToScreen(x, y);
  assert.ok(bodyAt(plain.ctx, at(plain.camera, 2, 1)), 'no shift: the body is drawn at its own place');
  // the content moved 3 cells (6 m) to the right: the same vehicle now belongs 6 m further along
  const moved = setup(layout, { sim: { vehicles: [v] } });
  moved.renderer.simShift = { dx: 3, dy: 0 };
  moved.ctx.record = true;
  moved.renderer.render(1);
  assert.ok(bodyAt(moved.ctx, at(moved.camera, 8, 1)), 'shifted: the body is drawn 3 cells along');
  assert.ok(!bodyAt(moved.ctx, at(moved.camera, 2, 1)), 'and not where it was');
  assert.equal(moved.renderer.hitTest(...at(moved.camera, 8, 1)).kind, 'vehicle', 'the hit test follows it');
  assert.notEqual(moved.renderer.hitTest(...at(moved.camera, 2, 1)).kind, 'vehicle', 'nothing is left behind');
  const down = setup(layout, { sim: { vehicles: [v] } });
  down.renderer.simShift = { dx: 0, dy: -1 };
  down.ctx.record = true;
  down.renderer.render(1);
  assert.ok(bodyAt(down.ctx, at(down.camera, 2, -1)), 'a shift in y moves it in y');
});

test('simShift: the layers that read the simulation\'s own geometry (deadlock rings, heat) wait for the replacement', () => {
  const layout = smallPlant();
  const sim = { vehicles: [], traffic: { activeDeadlocks: [{ nodes: [12, 13] }, 14] } };
  const rings = (shift) => {
    const { renderer, ctx } = setup(layout, { sim });
    renderer.simShift = shift;
    ctx.record = true;
    renderer.render(1);
    return ctx.arcs.length;
  };
  assert.ok(rings(null) > rings({ dx: 2, dy: 0 }), 'rings at nodes of the old grid would sit on the wrong cells');
  assert.equal(rings({ dx: 0, dy: 0 }), rings(null), 'a shift of nothing changes nothing');
  let heatReads = 0;
  const heatSim = { vehicles: [], graph: { edges: [], cols: 10, cellSize: 2, nodeCount: 80 }, heat: () => { heatReads++; return { edgePasses: [], edgeWait: [], nodeWait: [], maxEdgePasses: 0, maxEdgeWait: 0, maxNodeWait: 0 }; } };
  const { renderer } = setup(layout, { sim: heatSim });
  renderer.view.overlays.heat = 'traffic';
  renderer.simShift = { dx: 1, dy: 0 };
  renderer.render(1);
  assert.equal(heatReads, 0, 'no heat map from a simulation that is not on the plan any more');
  renderer.simShift = null;
  renderer.render(1);
  assert.ok(heatReads > 0, 'and it is back with the replacement');
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
  assert.ok(c.width * c.height <= 16.7e6, 'below the 16.7 M pixel canvas limit of iOS Safari');
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
    'js/ui/render/vehicles.js': ['vehiclePose', 'vehicleSize', 'isBroken', 'drawVehicles', 'drawBody', 'drawWheels', 'drawFront', 'drawLoad', 'drawHazard', 'drawBadges', 'drawBatteryBar'],
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

// ---- regressions of the review findings ----------------------------------------------------------------------------------------

const fontPx = (font) => Number(/(\d+(?:\.\d+)?)px/.exec(font)[1]);

test('FLOW-1: a flow between touching stations is drawn as a direction badge and can be clicked; nothing hides it', () => {
  const layout = layoutFromAscii(['AABB....', '++++++++'], { stations: { A: 'source', B: 'sink' }, flows: [['A', 'B']] }); // A | B share the edge x = 4 m
  const { renderer, camera, ctx } = setup(layout);
  ctx.record = true;
  renderer.render(1);
  assert.ok(ctx.arcs.some((r) => r > 12 && r < 13), 'the badge halo (marker radius + 1.5) is drawn');
  assert.ok(!ctx.events.includes('curve'), 'there is no arrow curve between them');
  const [bx, by] = camera.worldToScreen(4, 1);
  assert.deepEqual(pick(renderer.hitTest(bx, by), ['kind', 'id']), { kind: 'flow', id: 'f1' }, 'the badge sits on top of the bricks and wins the click');
  assert.equal(renderer.hitTest(bx - 40, by).kind, 'station', 'elsewhere on the brick the station is picked');
  assert.deepEqual(pick(renderer.hitTest(bx + 7, by + 7), ['kind', 'id']), { kind: 'flow', id: 'f1' }, 'within the badge radius plus slack');
  assert.equal(renderer.hitTest(bx + 30, by).kind, 'station');
  renderer.view.overlays.flows = false;
  ctx.arcs.length = 0;
  renderer.render(1);
  assert.ok(!ctx.arcs.some((r) => r > 12 && r < 13), 'the flows overlay hides the badge');
  assert.equal(renderer.hitTest(bx, by).kind, 'station', 'and a hidden badge cannot be clicked');
});

test('FLOW-1: every valid flow of a plant of 0.5 m cells with stations one cell apart or touching is drawable', () => {
  const layout = emptyLayout({ grid: { cols: 20, rows: 10, cellSize: 0.5 } });
  const st = (id, x) => layout.stations.push({ id, type: 'process', name: id, x, y: 1, w: 3, h: 3, params: {} });
  st('A', 1);
  st('B', 4); // touching A
  st('C', 8); // one 0.5 m cell after B
  st('D', 12); // one cell after C
  for (const [from, to] of [['A', 'B'], ['B', 'C'], ['C', 'D']]) layout.flows.push({ id: from + to, from, to, weight: 1 });
  const scene = getScene(layout);
  assert.equal(scene.flows.length, layout.flows.length, 'no valid flow is dropped');
  assert.deepEqual(scene.flows.map((e) => e.marker !== null), [true, false, false].map((_, i) => scene.flows[i].curve.marker), 'marker iff the curve is a marker');
  assert.ok(scene.flows[0].marker, 'touching: badge');
});

test('HIT-1: labels hidden by the labels overlay are neither drawn nor picked', () => {
  const layout = smallPlant();
  const { renderer, camera, ctx } = setup(layout);
  const [px, py] = camera.worldToScreen(10, 7);
  assert.equal(renderer.hitTest(px, py).kind, 'label');
  renderer.view.overlays.labels = false;
  assert.notEqual(renderer.hitTest(px, py).kind, 'label');
  ctx.record = true;
  renderer.render(1);
  assert.ok(!ctx.texts.includes('Dock'));
  renderer.view.overlays.labels = true;
  ctx.texts.length = 0;
  renderer.render(1);
  assert.ok(ctx.texts.includes('Dock'));
});

test('HIT-2: whenever a station is hit, the reported cell lies inside it (same pixel-snapped origin as the drawing)', () => {
  const layout = smallPlant();
  layout.labels = [];
  const a = layout.stations.find((st) => st.id === 'A'); // 3 x 1 cells at (0, 0)
  const { renderer, camera } = setup(layout);
  let hits = 0;
  for (const zoom of [4, 7.3, 12.4, 20, 33.3]) {
    for (const [cx, cy] of [[10, 8], [5.37, 3.61], [3.123, 0.77]]) {
      camera.zoom = zoom;
      camera.centerOn(cx, cy);
      renderer.render(1);
      for (const [x0, y0, x1, y1] of [[0, 0, 0, 2], [6, 0, 6, 2], [0, 0, 6, 0], [0, 2, 6, 2]]) {
        for (let t = 0.1; t < 1; t += 0.2) {
          const [sx, sy] = camera.worldToScreen(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
          for (let d = -1; d <= 1; d += 0.25) {
            for (const [ox, oy] of [[d, 0], [0, d]]) {
              const hit = renderer.hitTest(sx + ox, sy + oy);
              if (hit.kind !== 'station' || hit.id !== 'A') continue;
              hits++;
              assert.ok(hit.cell[0] >= a.x && hit.cell[0] < a.x + a.w && hit.cell[1] >= a.y && hit.cell[1] < a.y + a.h, `zoom ${zoom}: cell ${hit.cell} for a hit at (${sx + ox}, ${sy + oy})`);
            }
          }
        }
      }
    }
  }
  assert.ok(hits > 100, `only ${hits} border probes hit the station`);
});

test('LABEL-1: label size is a text height in grid cells, so the font scales with the cell size and with size', () => {
  const fontOfLabel = (cs, size) => {
    const layout = emptyLayout({ grid: { cols: 20, rows: 10, cellSize: cs } });
    layout.labels.push({ id: 'l1', x: 5, y: 5, text: 'LABELX', ...(size ? { size } : {}) });
    const { renderer, ctx } = setup(layout, { zoom: 20, camera: new Camera({ x: 5 * cs, y: 5 * cs, zoom: 20 }) });
    ctx.record = true;
    renderer.render(1);
    return fontPx(ctx.fonts[ctx.texts.indexOf('LABELX')]);
  };
  const base = fontOfLabel(2);
  assert.ok(Math.abs(fontOfLabel(4) / base - 2) < 0.02, 'twice the cell size, twice the font');
  assert.ok(Math.abs(fontOfLabel(2, 2) / base - 2) < 0.02, 'twice the size, twice the font');
  assert.ok(Math.abs(base - 0.8 * 2 * 20) < 0.5, `size 1 is one cell of text height (line box): ${base}px for 2 m cells at 20 px/m`);
  assert.ok(Math.abs(fontOfLabel(10, 8) - 400) < 0.5, 'absurd sizes are capped (400 px) so the rasteriser cannot crawl');
});

test('labels are drawn after the flows (an arrow never cuts through a label) and the zone badges follow the labels overlay', () => {
  const layout = smallPlant();
  layout.roads['3,1'].limit = 0.5;
  const { renderer, ctx, camera } = setup(layout, { zoom: 40 });
  camera.centerOn(8, 5);
  ctx.record = true;
  renderer.render(1);
  const lastCurve = ctx.events.lastIndexOf('curve');
  assert.ok(lastCurve >= 0 && ctx.events.indexOf('text:Dock') > lastCurve, 'label text after the flow curve');
  assert.ok(ctx.texts.includes('50 %'), 'speed zone badge');
  renderer.view.overlays.labels = false;
  ctx.texts.length = 0;
  renderer.render(1);
  assert.ok(!ctx.texts.includes('50 %') && !ctx.texts.includes('Dock'), 'both are labels');
});

test('DEPOT-1: bayOccupant shows every vehicle of a depot exactly once, whatever mix of charging and parked', () => {
  for (let slots = 1; slots <= 7; slots++) {
    for (let chargers = 0; chargers <= slots; chargers++) {
      for (let nC = 0; nC <= chargers; nC++) {
        for (let nP = 0; nP <= slots - nC; nP++) {
          const charging = Array.from({ length: nC }, (_, i) => `c${i}`);
          const parked = Array.from({ length: nP }, (_, i) => `p${i}`);
          const shown = Array.from({ length: slots }, (_, i) => bayOccupant(i, slots, chargers, charging, parked)).filter(Boolean);
          assert.deepEqual([...shown].sort(), [...charging, ...parked].sort(), `${slots} slots, ${chargers} chargers, ${nC} charging, ${nP} parked`);
          for (let i = 0; i < nC; i++) assert.equal(bayOccupant(i, slots, chargers, charging, parked), charging[i], 'charging vehicles sit in the charger bays');
        }
      }
    }
  }
  assert.equal(bayOccupant(0, 2, 0, [], []), null);
});

test('DEPOT-1: a depot with 4 slots, 2 chargers and 3 parked vehicles draws 3 vehicle silhouettes, and one more when one charges', () => {
  const layout = layoutFromAscii(['AAAA....', '++++++++'], { stations: { A: { type: 'depot', name: 'Parking', params: { slots: 4, chargers: 2 } } }, fleets: [] });
  const car = (id) => fakeVehicle(id, 0, 0, { visible: false });
  const depot = { id: 'A', type: 'depot', state: 'normal', fill: 0.75, fillLabel: '3/4', slots: 4, chargers: 2, parked: [car('a'), car('b'), car('c')], charging: [] };
  const sim = { vehicles: [], logistics: { stationById: new Map([['A', depot]]) } };
  const { renderer, ctx } = setup(layout, { sim, zoom: 40, camera: new Camera({ x: 4, y: 2, zoom: 40 }) });
  const silhouettes = () => { ctx.rotations.length = 0; renderer.render(1); return ctx.rotations.filter((a) => Math.abs(a + Math.PI / 2) < 1e-9).length; };
  ctx.record = true;
  assert.equal(silhouettes(), 3, 'all three parked vehicles are visible although there are chargers');
  depot.charging = [depot.parked.pop()];
  assert.equal(silhouettes(), 3, 'one of them now charges: still three');
  depot.parked = [car('d'), car('e')];
  assert.equal(silhouettes(), 3, '1 charging + 2 parked');
});

test('VIS-2 / VIS-3: the header row of a brick (yard badge, name tile, state dot) never overlaps itself or the live overlays', () => {
  const clampTo = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const names = ['A', 'Goods receiving dock', 'Final assembly line 3', 'Central warehouse'];
  const sizes = { source: [3, 2], process: [3, 3], storage: [4, 3], sink: [3, 2], depot: [3, 2], tiny: [2, 1] };
  const overlap = (p, q) => p.x < q.x + q.w - 0.01 && q.x < p.x + p.w - 0.01 && p.y < q.y + q.h - 0.01 && q.y < p.y + p.h - 0.01;
  let planned = 0;
  for (const [key, [cols, rows]] of Object.entries(sizes)) {
    const type = key === 'tiny' ? 'source' : key;
    for (const zoom of [6, 8, 10, 12, 16, 20, 30, 45, 60]) {
      for (const name of names) {
        const cell = 2 * zoom;
        const gap = clampTo(cell * 0.05, 0.5, 4);
        const bodyH = rows * cell - 2 * gap;
        const depth = Math.min(clampTo(cell * 0.1, 2, 8), bodyH * 0.25);
        const g = { x: 100, y: 100, w: cols * cell - 2 * gap, bodyH, depth, h: bodyH - depth, cell, cols, rows, originX: 100 - gap, originY: 100 - gap };
        const fr = { theme: getTheme('light'), overlays: {}, cs: 2, zoom };
        const rt = { state: 'blocked', yard: 12, fill: 0.5, fillLabel: '3/8', consumed: 4, machines: [{ state: 'busy', progress: 0.4 }], slots: 4, chargers: 1, parked: [], charging: [] };
        const ctx = new FakeContext(null);
        const plan = planContent(ctx, fr, g, type, { id: 's', name }, rt);
        if (!plan) continue;
        planned++;
        const items = [];
        if (plan.badge) items.push(['badge', { x: plan.badge.x, y: plan.badge.y, w: plan.badge.w, h: plan.badge.h }]);
        if (plan.tile.h > 0) items.push(['tile', { x: plan.tileX, y: plan.tileY, w: plan.tile.w, h: plan.tile.h }]);
        if (plan.dot) items.push(['dot', { x: plan.dot.x - plan.dot.d / 2, y: plan.dot.y - plan.dot.d / 2, w: plan.dot.d, h: plan.dot.d }]);
        if (plan.live) items.push(['live', { x: g.x + plan.pad, y: plan.liveY, w: plan.innerW, h: plan.live.h }]);
        const tag = `${key} @${zoom} px/m "${name}"`;
        for (const [label, r] of items) {
          assert.ok(r.x >= g.x - 0.01 && r.x + r.w <= g.x + g.w + 0.01 && r.y >= g.y - 0.01 && r.y + r.h <= g.y + g.h + 0.01, `${tag}: ${label} leaves the top face`);
        }
        for (let i = 0; i < items.length; i++) {
          for (let j = i + 1; j < items.length; j++) assert.ok(!overlap(items[i][1], items[j][1]), `${tag}: ${items[i][0]} overlaps ${items[j][0]}`);
        }
      }
    }
  }
  assert.ok(planned > 100, `only ${planned} face plans were checked`);
});

test('bricks: names win over icons - icon + full name, then the full name alone, then a stub with the icon, then icon only', () => {
  const g = { x: 0, y: 0, w: 116, bodyH: 80, depth: 4, h: 76, cell: 40, cols: 3, rows: 2, originX: 0, originY: 0 };
  const fr = { theme: getTheme('light'), overlays: {}, cs: 2, zoom: 20 };
  const tileOf = (name, width = g.w) => planContent(new FakeContext(null), fr, { ...g, w: width }, 'process', { id: 's', name }, null).tile;
  const short = tileOf('Press');
  assert.ok(short.icon > 0 && short.text === 'Press', 'icon + full name');
  const fifteen = tileOf('Goods receiving'); // 90 px: fits without the icon (98 px) but not with it (82 px)
  assert.equal(fifteen.icon, 0, 'the icon is dropped before the name is cut');
  assert.equal(fifteen.text, 'Goods receiving');
  const long = tileOf('Final assembly line number three');
  assert.ok(long.icon > 0 && long.text.endsWith('…') && long.text.length > 6, `icon + stub: "${long.text}"`);
  const narrow = tileOf('Goods receiving', 38);
  assert.ok(narrow.icon > 0 && narrow.text === '', `icon only when no readable stub fits: "${narrow.text}"`);
  assert.equal(tileOf('Press', 16).h, 0, 'a face too narrow for an icon has no tile');
  const noText = planContent(new FakeContext(null), { ...fr, overlays: { labels: false } }, g, 'process', { id: 's', name: 'Press' }, null).tile;
  assert.ok(noText.icon > 0 && noText.text === '', 'the labels overlay off keeps the icon');
});

test('bricks: studs are left out as whole rows where content sits, and small bricks keep an icon', () => {
  const layout = layoutFromAscii(['AAA.....', 'AAA.....', 'AAA.....', '++++++++'], { stations: { A: { type: 'process', name: 'Press' } }, fleets: [] });
  const arcsAt = (zoom) => {
    const { renderer, ctx } = setup(layout, { zoom, camera: new Camera({ x: 3, y: 3, zoom }) });
    ctx.record = true;
    renderer.render(1);
    return { arcs: ctx.arcs.length, texts: ctx.texts };
  };
  // 3 x 3 cells of 60 px: the name tile covers only the middle stud column, yet the whole middle stud row is left out:
  // two rows of three studs, three passes each, plus the one arc of the gear icon
  assert.equal(arcsAt(30).arcs, 2 * 3 * 3 + 1);
  const small = arcsAt(7); // cells of 14 px: no studs, no room for the name, but the icon stays
  assert.equal(small.arcs, 1, 'the gear icon of the process brick');
  assert.ok(!small.texts.includes('Press'));
});

test('very small bricks (zoomed far out) stay visible as a swatch instead of vanishing', () => {
  const layout = smallPlant();
  const { renderer, ctx, camera } = setup(layout);
  camera.zoom = 0.4; // a 3 x 1 cell brick of 2 m cells is 2.4 x 0.8 px
  camera.centerOn(10, 8);
  ctx.record = true;
  ctx.fills = 0;
  renderer.render(1);
  const fillsFar = ctx.fills;
  assert.ok(fillsFar >= 2, `the two stations are still painted: ${fillsFar} fills`);
});

test('PERF-1: panning a big hi-dpi canvas by a few pixels never rebuilds the static layer; its bitmap stays below 16 M pixels', () => {
  const layout = emptyLayout({ grid: { cols: 160, rows: 160, cellSize: 2 } });
  const { renderer, camera } = setup(layout, { w: 2560, h: 1440, dpr: 2, camera: new Camera({ x: 160, y: 160, zoom: 20 }) });
  renderer.render(1);
  assert.equal(renderer.stats.staticBuilds, 1);
  const bitmap = renderer._layer.canvas;
  assert.ok(bitmap.width * bitmap.height <= 16e6, `${bitmap.width} x ${bitmap.height}`);
  assert.ok(bitmap.width >= 5120 && bitmap.height >= 2880, 'at least the viewport at device resolution');
  for (let i = 0; i < 12; i++) { camera.pan(-3, 0); renderer.render(1); }
  assert.equal(renderer.stats.staticBuilds, 1, '12 pan frames of 3 px reuse the bitmap');
  camera.pan(-400, 0);
  renderer.render(1);
  assert.equal(renderer.stats.staticBuilds, 2, 'a long pan rebuilds');
});

test('ROB-1: structurally broken layouts, sims, selections and previews are tolerated', () => {
  const base = smallPlant();
  const cases = {
    'labels: [null]': (l) => { l.labels = [null, { id: 'x', x: 1, y: 1, text: 'ok' }]; },
    'flows: [null]': (l) => { l.flows = [null, ...l.flows]; },
    'obstacles: [null]': (l) => { l.obstacles = [null, ...l.obstacles]; },
    'stations: [null]': (l) => { l.stations = [null, ...l.stations]; },
    'label text number / object': (l) => { l.labels[0].text = 42; l.labels.push({ id: 'o', x: 2, y: 2, text: { a: 1 } }); },
    'no collections': (l) => { delete l.labels; delete l.obstacles; delete l.flows; },
  };
  for (const [name, patch] of Object.entries(cases)) {
    const layout = JSON.parse(JSON.stringify(base));
    patch(layout);
    const { renderer } = setup(layout);
    for (const sel of [{ kind: 'label', ids: ['l1', 'x'] }, { kind: 'obstacle', ids: ['o1'] }, { kind: 'station' }, { kind: 'station', ids: null }, { kind: 'station', ids: [null, undefined, 3] }]) {
      renderer.view = { ...createView(), selection: sel, resizeHandles: true, hover: { kind: 'label', id: 'x' } };
      renderer.render(1);
      renderer.hitTest(60, 60);
    }
    renderer.view = { ...createView(), paintPreview: { cells: [[1, 1], null, [NaN, 2], 'x'], oneWay: true, blocked: [null, [2, 2]] } };
    renderer.render(1);
    renderer.toDataURL({ scale: 0.1 });
    assert.ok(true, name);
  }
});

test('vehicles: the battery bar sits on the vehicle\'s own side of the road (right of travel, left with left-hand traffic), parallel to it', () => {
  const barOf = (layout, vehicle) => {
    const { renderer, camera, ctx } = setup(layout, { sim: { vehicles: [vehicle] }, zoom: 30, camera: new Camera({ x: 6, y: 5, zoom: 30 }) });
    const track = getTheme('light').vehicle.batteryTrack;
    ctx.record = true;
    renderer.render(1);
    const bar = ctx.fillRects.find((r) => r.fillStyle === track);
    const [sx, sy] = camera.worldToScreen(vehicle.x, vehicle.y);
    return { bar, sx, sy };
  };
  const car = (heading) => fakeVehicle('v1#1', 6, 5, { heading, prevHeading: heading, prevX: 6, prevY: 5, battery: 0.5, fleet: { id: 'v1', battery: { enabled: true } } });
  const right = smallPlant();
  const left = smallPlant();
  left.settings.handedness = 'left';
  const east = barOf(right, car(0));
  assert.ok(east.bar.y > east.sy && east.bar.w > east.bar.h, 'eastbound, right-hand traffic: south of the vehicle, horizontal');
  const west = barOf(right, car(Math.PI));
  assert.ok(west.bar.y + west.bar.h < west.sy, 'westbound: north (the other lane is on the south side)');
  const south = barOf(right, car(Math.PI / 2));
  assert.ok(south.bar.x + south.bar.w < south.sx && south.bar.h > south.bar.w, 'southbound: west of the vehicle, vertical');
  const north = barOf(right, car(-Math.PI / 2));
  assert.ok(north.bar.x > north.sx && north.bar.h > north.bar.w, 'northbound: east');
  const leftEast = barOf(left, car(0));
  assert.ok(leftEast.bar.y + leftEast.bar.h < leftEast.sy, 'left-hand traffic mirrors it');
});

test('heat: strips of one level are one path (no overlap stripes), straight lanes abut and turns keep their corners filled', () => {
  const layout = layoutFromAscii(['++++++++', '........']);
  const cols = layout.grid.cols;
  const edges = [];
  const out = Array.from({ length: cols * layout.grid.rows }, () => []);
  const into = Array.from({ length: cols * layout.grid.rows }, () => []);
  for (let i = 0; i < 7; i++) {
    edges.push({ id: i, from: i, to: i + 1, dir: 1, rev: -1 });
    out[i].push(i);
    into[i + 1].push(i);
  }
  const passes = Int32Array.of(5, 5, 5, 5, 30, 30, 5);
  const sim = {
    layout, settings: layout.settings, vehicles: [],
    graph: { cols, rows: layout.grid.rows, nodeCount: cols * layout.grid.rows, cellSize: 2, edges, out, in: into },
    heat: () => ({ edgePasses: passes, edgeWait: new Float64Array(7), nodeWait: new Float64Array(cols * layout.grid.rows) }),
  };
  const { renderer } = setup(layout, { sim });
  renderer.view.overlays.heat = 'traffic';
  renderer.render(1);
  const heat = renderer._heat;
  assert.equal(heat.count, 7);
  const r = (i) => [heat.rects[i * 4], heat.rects[i * 4 + 1], heat.rects[i * 4 + 2], heat.rects[i * 4 + 3]];
  const t = 2 * 0.44;
  for (let i = 0; i < 6; i++) assert.ok(Math.abs(r(i)[0] + r(i)[2] - r(i + 1)[0]) < 1e-4, `edge ${i} ends where edge ${i + 1} begins`);
  assert.ok(Math.abs(r(0)[0] - (1 - t / 2)) < 1e-4, 'the first strip reaches half a strip width behind its start');
  assert.ok(Math.abs(r(6)[0] + r(6)[2] - (15 + t / 2)) < 1e-4, 'the last one reaches past its end');
  // levels are drawn ascending, one path (one fill) per level
  const levelsInOrder = Array.from({ length: heat.count }, (_, k) => heat.levels[heat.order[k]]);
  assert.deepEqual(levelsInOrder, [...levelsInOrder].sort((a, b) => a - b));
  const fake = new FakeContext(null);
  drawHeat(fake, heat, 0);
  assert.equal(fake.fills, 2, 'two levels (5 passes, 30 passes) = two fills');
  assert.equal(fake.rects, 7);
});

test('heat: lanes that turn a corner overlap by half a strip so the corner has no hole', () => {
  const layout = layoutFromAscii(['++', '+.']);
  const cols = layout.grid.cols;
  const edges = [{ id: 0, from: 0, to: 1, dir: 1, rev: -1 }, { id: 1, from: 0, to: cols, dir: 2, rev: -1 }];
  const out = Array.from({ length: cols * layout.grid.rows }, () => []);
  const into = Array.from({ length: cols * layout.grid.rows }, () => []);
  const sim = {
    layout, settings: layout.settings, vehicles: [],
    graph: { cols, rows: layout.grid.rows, nodeCount: cols * layout.grid.rows, cellSize: 2, edges, out, in: into },
    heat: () => ({ edgePasses: Int32Array.of(9, 9), edgeWait: new Float64Array(2), nodeWait: new Float64Array(cols * layout.grid.rows) }),
  };
  const { renderer } = setup(layout, { sim });
  renderer.view.overlays.heat = 'traffic';
  renderer.render(1);
  const h = renderer._heat;
  const x1 = h.rects[0] + h.rects[2];
  assert.ok(x1 > 3 + 0.3, 'dead end of a lane: the strip extends past the node centre (x = 3 m)');
});

test('export: heat, labels and flow badges are part of it, the pixel cap is below the iOS canvas limit', () => {
  const layout = layoutFromAscii(['AABB....', '++++++++'], { stations: { A: 'source', B: 'sink' }, flows: [['A', 'B']] });
  layout.labels.push({ id: 'l1', x: 4, y: 4, text: 'Hall' });
  const { renderer, made } = setup(layout);
  const origCreate = renderer._createCanvas;
  renderer._createCanvas = (w, h) => { const c = origCreate(w, h); c.ctx.record = true; return c; };
  renderer.toDataURL();
  const ctx = made[made.length - 1].ctx;
  assert.ok(ctx.texts.includes('Hall'), 'labels in the export');
  assert.ok(ctx.arcs.some((r) => r > 7 && r < 12.6), 'flow badge in the export');
  const big = emptyLayout({ grid: { cols: 160, rows: 160, cellSize: 2 } });
  renderer.layout = big;
  renderer.toDataURL({ scale: 4 });
  const c = made[made.length - 1];
  assert.ok(c.width * c.height <= 16.7e6);
});
