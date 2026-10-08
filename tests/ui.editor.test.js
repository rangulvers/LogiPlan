// The Editor class end to end in Node: the real store, camera and model with a minimal fake DOM (event targets, a
// canvas with a bounding box) and a fake renderer whose hit test reads the layout. The browser run in
// tests/e2e/editor.mjs covers rendering, real pointer devices and the inline text box; this file keeps the gesture and
// keyboard logic honest in `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../js/ui/editor.js';
import { createStore } from '../js/store/store.js';
import { Camera } from '../js/ui/camera.js';
import { createLayout, paintRoadPath, addStation, addFlow, addObstacle, checkInvariants } from '../js/model/layout.js';
import { hitHandle, pointInRect } from '../js/ui/render/geometry.js';
import { createRng } from '../js/util/rng.js';

// ---- fake browser ---------------------------------------------------------------------------------------------

function setup({ layout = createLayout({ cols: 40, rows: 24, cellSize: 2 }), ctx = {} } = {}) {
  const frames = [];
  const win = Object.assign(new EventTarget(), { requestAnimationFrame: (fn) => frames.push(fn), innerWidth: 1200, innerHeight: 800 });
  const doc = { defaultView: win, querySelector: () => (doc.dialog ? {} : null), dialog: false };
  const canvas = Object.assign(new EventTarget(), {
    ownerDocument: doc,
    style: {},
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 480 }),
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture: () => false,
  });
  const store = createStore({ storage: undefined });
  store.newProject(layout);
  const camera = new Camera({ x: 40, y: 24, zoom: 10, width: 800, height: 480 });
  const toasts = [];
  const statuses = [];
  const fitted = [];
  const renderer = {
    layout: null,
    sim: null,
    view: { selection: { kind: null, ids: [] }, hover: null, tool: 'select', overlays: {}, ghost: null, paintPreview: null, flowPreview: null, marquee: null, resizeHandles: false },
    renders: 0,
    render() { this.renders++; },
    hitTest(px, py) {
      const l = this.layout;
      const cs = l.grid.cellSize;
      const [wx, wy] = camera.screenToWorld(px, py);
      const cell = [Math.floor(wx / cs), Math.floor(wy / cs)];
      const sel = this.view.selection;
      if (this.view.resizeHandles && sel.ids.length === 1) {
        const item = (sel.kind === 'station' ? l.stations : l.obstacles).find((i) => i.id === sel.ids[0]);
        const [sx, sy] = camera.worldToScreen(item.x * cs, item.y * cs);
        const handle = hitHandle(sx, sy, item.w * cs * camera.zoom, item.h * cs * camera.zoom, px, py, 7);
        if (handle) return { kind: sel.kind, id: item.id, cell, handle };
      }
      const label = l.labels.find((e) => Math.abs(e.x - wx / cs) < 1 && Math.abs(e.y - wy / cs) < 0.6);
      if (label) return { kind: 'label', id: label.id, cell };
      const station = l.stations.find((s) => pointInRect(wx / cs, wy / cs, s));
      if (station) return { kind: 'station', id: station.id, cell };
      const obstacle = l.obstacles.find((o) => pointInRect(wx / cs, wy / cs, o));
      if (obstacle) return { kind: 'obstacle', id: obstacle.id, cell };
      return { kind: 'cell', cell };
    },
  };
  renderer.layout = store.getState().layout;
  const fullCtx = { toast: (m, o) => toasts.push({ message: m, ...o }), setStatus: (t) => statuses.push(t), actions: { fitView: () => fitted.push(true) }, ...ctx };
  const editor = new Editor({ canvas, store, camera, renderer, ctx: fullCtx });

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
    click(cell, props) { this.down(cell, props); this.up(cell, props); },
    drag(cells, props) {
      this.down(cells[0], props);
      for (const c of cells.slice(1)) this.move(c, props);
      this.up(cells[cells.length - 1], props);
    },
  };
  const key = (k, props = {}) => {
    const e = fire(win, 'keydown', { key: k, ...props });
    fire(win, 'keyup', { key: k, ...props });
    return e;
  };
  const state = () => store.getState();
  return { editor, store, camera, renderer, canvas, win, doc, toasts, statuses, fitted, frames, px, fire, mouse, key, state };
}

/** A plant with Goods in (source A), a workstation (B), Goods out (sink C) and a depot (D), flow A -> B, a road and a wall. */
function plant() {
  const layout = createLayout({ cols: 40, rows: 24, cellSize: 2 });
  addStation(layout, { type: 'source', x: 4, y: 4, w: 3, h: 2, name: 'A' });
  addStation(layout, { type: 'process', x: 14, y: 4, w: 3, h: 3, name: 'B' });
  addStation(layout, { type: 'sink', x: 26, y: 4, w: 3, h: 2, name: 'C' });
  addStation(layout, { type: 'depot', x: 4, y: 14, w: 3, h: 2, name: 'D' });
  addFlow(layout, 's1', 's2');
  paintRoadPath(layout, [[4, 9], [30, 9]]);
  addObstacle(layout, { x: 20, y: 14, w: 6, h: 1, kind: 'wall' });
  return layout;
}

// ---- tools and sync -----------------------------------------------------------------------------------------------

test('editor: starts in the store\'s tool, mirrors tool, selection and layout into renderer.view, and sets the canvas up for touch', () => {
  const t = setup();
  assert.equal(t.editor.tool, 'select');
  assert.equal(t.canvas.style.touchAction, 'none');
  assert.equal(t.renderer.view.tool, 'select');
  assert.equal(t.renderer.layout, t.state().layout);
  t.store.commit('x', (d) => { addStation(d, { type: 'source', x: 1, y: 1 }); });
  assert.equal(t.renderer.layout, t.state().layout, 'a commit reaches renderer.layout at once, before any frame');
  t.store.select('station', ['s1']);
  assert.deepEqual(t.renderer.view.selection, { kind: 'station', ids: ['s1'] });
  assert.equal(t.renderer.view.resizeHandles, true);
  const early = setup();
  early.store.setUi({ tool: 'road' });
  const second = new Editor({ canvas: early.canvas, store: early.store, camera: early.camera, renderer: early.renderer, ctx: {} });
  assert.equal(second.tool, 'road', 'a new editor picks the tool from the store');
  second.destroy();
  early.editor.destroy();
});

test('editor: tool keys, the store and setTool stay in sync both ways', () => {
  const t = setup();
  t.key('r');
  assert.equal(t.state().ui.tool, 'road');
  t.store.setUi({ tool: 'flow' });
  assert.equal(t.editor.tool, 'flow', 'a palette button reaches the editor');
  assert.equal(t.canvas.style.cursor, 'crosshair');
  assert.equal(t.renderer.view.tool, 'flow');
  assert.equal(t.editor.setTool('depot'), true);
  assert.equal(t.state().ui.tool, 'depot');
  assert.equal(t.editor.setTool('teleport'), false);
  t.store.setUi({ tool: 'teleport' });
  assert.equal(t.editor.tool, 'depot', 'an unknown tool name from the store is ignored');
  t.key('v');
  assert.equal(t.canvas.style.cursor, 'default');
  t.key('h');
  assert.equal(t.canvas.style.cursor, 'grab');
  t.key('t');
  assert.equal(t.canvas.style.cursor, 'text');
});

test('editor: W and Z cycle the options of their tool in store.ui.toolOptions', () => {
  const t = setup();
  t.key('w');
  assert.equal(t.state().ui.toolOptions.kind, 'wall');
  t.key('w');
  assert.equal(t.state().ui.toolOptions.kind, 'rack');
  t.key('w');
  assert.equal(t.state().ui.toolOptions.kind, 'column');
  t.key('z');
  assert.equal(t.state().ui.toolOptions.factor, 0.5);
  t.key('z');
  assert.equal(t.state().ui.toolOptions.factor, 0.25);
  t.editor.setToolOptions({ factor: 0.75 });
  assert.equal(t.state().ui.toolOptions.factor, 0.75);
  assert.equal(t.state().ui.toolOptions.kind, 'column', 'options merge, they do not replace each other');
});

test('editor: keys are ignored in text fields and behind dialogs, and browser shortcuts stay untouched', () => {
  const t = setup();
  const inField = (props) => t.fire(t.win, 'keydown', props);
  const typed = Object.defineProperty(new Event('keydown', { cancelable: true }), 'target', { value: { tagName: 'INPUT' } });
  Object.assign(typed, { key: 'r' });
  t.win.dispatchEvent(typed);
  assert.equal(t.editor.tool, 'select', 'typing in an input');
  t.doc.dialog = true;
  t.key('r');
  assert.equal(t.editor.tool, 'select', 'a dialog is open');
  t.doc.dialog = false;
  const ctrlR = inField({ key: 'r', ctrlKey: true });
  assert.equal(ctrlR.defaultPrevented, false);
  assert.equal(t.editor.tool, 'select');
  const plain = t.key('r');
  assert.equal(plain.defaultPrevented, true);
  assert.equal(t.editor.tool, 'road');
});

// ---- road tools ---------------------------------------------------------------------------------------------------

test('editor: a road stroke is one commit with a live preview, filled gaps and links; undo/redo keys work', () => {
  const t = setup();
  t.key('r');
  t.mouse.down([5, 5]);
  t.mouse.move([9, 7]);
  assert.deepEqual(t.renderer.view.paintPreview.cells.at(-1), [9, 7]);
  assert.equal(t.renderer.view.paintPreview.cells.length, 5 + 2, 'the jump was filled with an L-shaped path');
  assert.equal(Object.keys(t.state().layout.roads).length, 0, 'nothing is committed before the release');
  t.mouse.up([9, 7]);
  assert.equal(Object.keys(t.state().layout.roads).length, 7);
  assert.equal(t.state().undoLabel, 'Draw road');
  assert.equal(t.renderer.view.paintPreview, null);
  assert.deepEqual(checkInvariants(t.state().layout), []);
  t.key('z', { ctrlKey: true });
  assert.equal(Object.keys(t.state().layout.roads).length, 0);
  t.key('z', { ctrlKey: true, shiftKey: true });
  assert.equal(Object.keys(t.state().layout.roads).length, 7);
  t.key('z', { metaKey: true });
  t.key('y', { ctrlKey: true });
  assert.equal(Object.keys(t.state().layout.roads).length, 7);
});

test('editor: a stroke dragged beyond the edge of the plant (the pointer is captured) stops at the last column and row', () => {
  const t = setup();
  t.key('r');
  t.mouse.drag([[30, 10], [90, 10], [90, 60]]);
  const cells = Object.keys(t.state().layout.roads);
  assert.equal(cells.length, 10 + 13, 'row 10 from x = 30 to 39, then column 39 down to the last row (y = 23)');
  assert.ok(t.state().layout.roads['39,23']);
  assert.deepEqual(checkInvariants(t.state().layout), []);
});

test('editor: Shift draws an L-shaped line, one-way follows the drag direction, a click paints a plate', () => {
  const t = setup();
  t.key('r');
  t.mouse.drag([[2, 2], [8, 5]], { shiftKey: true });
  assert.equal(Object.keys(t.state().layout.roads).length, 7 + 3);
  assert.ok(t.state().layout.roads['8,2'] && !t.state().layout.roads['5,3']);
  t.key('o');
  t.mouse.drag([[12, 12], [16, 12]]);
  assert.equal(t.state().undoLabel, 'Draw one-way road');
  assert.deepEqual([12, 13, 16].map((x) => t.state().layout.roads[`${x},12`].out), [2, 2, 0]);
  t.key('r');
  t.mouse.click([30, 20]);
  assert.deepEqual(t.state().layout.roads['30,20'], { out: 0 });
});

test('editor: a stroke into a station stops before it, shows the blocked part, and nothing is committed on a blocked start', () => {
  const t = setup({ layout: plant() });
  t.key('r');
  t.mouse.down([10, 5]);
  t.mouse.move([20, 5]);
  const pv = t.renderer.view.paintPreview;
  assert.deepEqual(pv.cells.at(-1), [13, 5]);
  assert.deepEqual(pv.blocked[0], [14, 5]);
  t.mouse.up([20, 5]);
  assert.ok(t.state().layout.roads['13,5']);
  assert.equal(t.state().layout.roads['14,5'], undefined);
  const undo = t.state().undoLabel;
  t.mouse.drag([[15, 5], [20, 5]]);
  assert.equal(t.state().undoLabel, undo, 'starting inside a station paints nothing');
  assert.match(t.toasts.at(-1).message, /cannot be placed on stations or walls/);
});

test('editor: Esc cancels a stroke without a commit; the next Esc leaves the tool', () => {
  const t = setup();
  t.key('r');
  t.mouse.down([3, 3]);
  t.mouse.move([9, 3]);
  t.key('Escape');
  assert.equal(t.renderer.view.paintPreview, null);
  assert.equal(t.editor.tool, 'road');
  t.mouse.move([12, 3]);
  t.mouse.up([12, 3]);
  assert.equal(Object.keys(t.state().layout.roads).length, 0);
  t.key('Escape');
  assert.equal(t.editor.tool, 'select');
  assert.equal(t.state().canUndo, false);
});

test('editor: speed zone paints the limit on road cells, Alt removes it; eraser removes roads, carves walls and says what it did', () => {
  const t = setup({ layout: plant() });
  t.key('z');
  t.mouse.drag([[10, 9], [14, 9]]);
  assert.equal(t.state().layout.roads['12,9'].limit, 0.5);
  assert.equal(t.state().undoLabel, 'Set speed zone');
  t.mouse.drag([[10, 9], [14, 9]], { altKey: true });
  assert.equal(t.state().layout.roads['12,9'].limit, undefined);
  assert.equal(t.state().undoLabel, 'Clear speed zone');
  t.key('e');
  t.mouse.drag([[22, 14], [22, 14]]);
  assert.deepEqual(t.state().layout.obstacles.map((o) => [o.x, o.w]), [[20, 2], [23, 3]], 'one cell of the wall is gone');
  assert.equal(t.state().undoLabel, 'Erase wall');
  t.mouse.drag([[8, 9], [10, 9]]);
  assert.equal(t.state().undoLabel, 'Erase road');
  assert.equal(t.state().layout.roads['9,9'], undefined);
  t.key('r');
  t.mouse.drag([[24, 9], [26, 9]], { altKey: true });
  assert.equal(t.state().undoLabel, 'Erase road', 'Alt+drag with a road tool erases');
});

// ---- placing ------------------------------------------------------------------------------------------------------

test('editor: placement ghost, click places a default brick centred on the pointer, the tool stays and the station is selected', () => {
  const t = setup();
  t.key('2');
  t.mouse.move([10, 8]);
  assert.deepEqual(t.renderer.view.ghost, { kind: 'station', type: 'process', rect: { x: 9, y: 7, w: 3, h: 3 }, valid: true });
  assert.match(t.statuses.at(-1), /^Workstation · 3 × 3 cells \(6 × 6 m\)$/);
  t.mouse.click([10, 8]);
  assert.deepEqual(t.state().layout.stations.map((s) => [s.name, s.x, s.y, s.w, s.h]), [['Workstation 1', 9, 7, 3, 3]]);
  assert.equal(t.state().undoLabel, 'Add workstation');
  assert.deepEqual(t.state().ui.selection, { kind: 'station', ids: ['s1'] });
  assert.equal(t.editor.tool, 'process');
  t.mouse.click([10, 8]);
  assert.equal(t.state().layout.stations.length, 1, 'occupied');
  assert.match(t.toasts.at(-1).message, /another station is in the way/);
  assert.equal(t.renderer.view.ghost.valid, false);
});

test('editor: dragging sizes the brick (any direction, clamped to the plate); a tiny jiggle is a click; Shift+click returns to Select', () => {
  const t = setup();
  t.key('1');
  t.mouse.drag([[20, 5], [25, 8]]);
  const first = t.state().layout.stations[0];
  assert.deepEqual([first.x, first.y, first.w, first.h, first.type, first.name], [20, 5, 6, 4, 'source', 'Goods in 1']);
  t.key('4');
  t.mouse.drag([[12, 20], [8, 17]]);
  assert.deepEqual([t.state().layout.stations[1].x, t.state().layout.stations[1].y, t.state().layout.stations[1].w, t.state().layout.stations[1].h], [8, 17, 5, 4]);
  t.key('3');
  t.mouse.drag([[30, 20], [90, 90]]);
  assert.deepEqual([t.state().layout.stations[2].w, t.state().layout.stations[2].h], [10, 4], 'clamped to the baseplate');
  t.key('5');
  t.mouse.down([2, 2]);
  t.mouse.move([2, 2], { clientX: t.px(2, 2).clientX + 2 });
  t.mouse.up([2, 2], { clientX: t.px(2, 2).clientX + 2 });
  assert.deepEqual([t.state().layout.stations[3].w, t.state().layout.stations[3].h], [3, 2]);
  t.key('2');
  t.mouse.click([34, 12], { shiftKey: true });
  assert.equal(t.state().layout.stations.length, 5);
  assert.equal(t.editor.tool, 'select', 'Shift+click placed one brick and returned to Select');
});

test('editor: obstacle tool places the chosen type and selects it', () => {
  const t = setup();
  t.key('w');
  t.key('w');
  t.mouse.drag([[10, 10], [14, 10]]);
  assert.deepEqual(t.state().layout.obstacles, [{ id: 'o1', x: 10, y: 10, w: 5, h: 1, kind: 'rack' }]);
  assert.equal(t.state().undoLabel, 'Add rack');
  assert.deepEqual(t.state().ui.selection, { kind: 'obstacle', ids: ['o1'] });
});

// ---- select -------------------------------------------------------------------------------------------------------

test('editor: click selects, Shift+click toggles, empty ground clears, Ctrl+A selects all stations; selecting commits nothing', () => {
  const t = setup({ layout: plant() });
  t.mouse.click([15, 5]);
  assert.deepEqual(t.state().ui.selection, { kind: 'station', ids: ['s2'] });
  t.mouse.click([5, 4], { shiftKey: true });
  assert.deepEqual(t.state().ui.selection, { kind: 'station', ids: ['s2', 's1'] });
  t.mouse.click([5, 4], { shiftKey: true });
  assert.deepEqual(t.state().ui.selection, { kind: 'station', ids: ['s2'] });
  t.mouse.click([21, 14]);
  assert.deepEqual(t.state().ui.selection, { kind: 'obstacle', ids: ['o1'] });
  t.mouse.click([35, 20]);
  assert.deepEqual(t.state().ui.selection, { kind: null, ids: [] });
  t.mouse.click([10, 9]);
  assert.deepEqual(t.state().ui.selection, { kind: 'cell', ids: ['10,9'] }, 'a road cell');
  t.key('a', { ctrlKey: true });
  assert.equal(t.state().ui.selection.ids.length, 4);
  t.key('Escape');
  assert.equal(t.state().ui.selection.kind, null);
  assert.equal(t.state().canUndo, false);
});

test('editor: marquee selects what it touches, and clears when it touches nothing', () => {
  const t = setup({ layout: plant() });
  t.mouse.drag([[2, 2], [16, 5]]);
  assert.deepEqual(t.state().ui.selection, { kind: 'station', ids: ['s1', 's2'] });
  assert.equal(t.renderer.view.marquee, null);
  t.mouse.drag([[33, 18], [38, 22]]);
  assert.equal(t.state().ui.selection.kind, null);
  t.mouse.drag([[20, 12], [25, 16]]);
  assert.deepEqual(t.state().ui.selection, { kind: 'obstacle', ids: ['o1'] });
  t.mouse.drag([[2, 2], [7, 7]], { shiftKey: true });
  assert.deepEqual(t.state().ui.selection, { kind: 'station', ids: ['s1'] }, 'a different kind replaces the selection');
});

test('editor: dragging moves the selection as one undo step; a blocked drop is refused; Esc cancels; clicking commits nothing', () => {
  const t = setup({ layout: plant() });
  t.mouse.click([15, 5]);
  t.mouse.down([15, 5]);
  t.mouse.move([15, 13]);
  assert.deepEqual(t.renderer.view.ghost, { kind: 'station', type: 'process', rect: { x: 14, y: 12, w: 3, h: 3 }, valid: true });
  t.mouse.up([15, 13]);
  assert.deepEqual([t.state().layout.stations[1].x, t.state().layout.stations[1].y], [14, 12]);
  assert.equal(t.state().undoLabel, 'Move station');
  t.key('z', { ctrlKey: true });
  assert.deepEqual([t.state().layout.stations[1].x, t.state().layout.stations[1].y], [14, 4]);
  t.mouse.down([15, 5]);
  t.mouse.move([15, 9]);
  assert.equal(t.renderer.view.ghost.valid, false, 'the road at y = 9 is in the way');
  t.mouse.up([15, 9]);
  assert.deepEqual([t.state().layout.stations[1].x, t.state().layout.stations[1].y], [14, 4]);
  assert.match(t.toasts.at(-1).message, /Cannot move here: a road is in the way/);
  t.mouse.down([15, 5]);
  t.mouse.move([22, 5]);
  t.key('Escape');
  t.mouse.up([22, 5]);
  assert.deepEqual([t.state().layout.stations[1].x, t.state().layout.stations[1].y], [14, 4], 'Esc cancelled');
  assert.equal(t.state().canUndo, false);
  t.mouse.click([15, 5]);
  assert.equal(t.state().canUndo, false);
});

test('editor: obstacles and labels move by dragging too (obstacle ghost, label target box), as one undo step each', () => {
  const layout = plant();
  layout.labels.push({ id: 'l1', x: 10, y: 20, text: 'Dock' });
  const t = setup({ layout });
  t.mouse.click([21, 14]);
  t.mouse.down([21, 14]);
  t.mouse.move([23, 11]);
  assert.deepEqual(t.renderer.view.ghost, { kind: 'obstacle', obstacleKind: 'wall', rect: { x: 22, y: 11, w: 6, h: 1 }, valid: true });
  t.mouse.up([23, 11]);
  assert.deepEqual([t.state().layout.obstacles[0].x, t.state().layout.obstacles[0].y], [22, 11]);
  assert.equal(t.state().undoLabel, 'Move wall');
  t.mouse.click([10, 20]);
  assert.deepEqual(t.state().ui.selection, { kind: 'label', ids: ['l1'] });
  t.mouse.down([10, 20]);
  t.mouse.move([13, 21]);
  assert.deepEqual(t.renderer.view.marquee, { x: 25, y: 41, w: 2, h: 2 }, 'a one-cell box marks the drop position of the label');
  assert.equal(t.renderer.view.ghost, null);
  t.mouse.up([13, 21]);
  assert.deepEqual([t.state().layout.labels[0].x, t.state().layout.labels[0].y], [13, 21]);
  assert.equal(t.state().undoLabel, 'Move label');
  t.mouse.down([13, 21]);
  t.mouse.move([13, 60]);
  t.mouse.up([13, 60]);
  assert.deepEqual([t.state().layout.labels[0].x, t.state().layout.labels[0].y], [13, 21], 'a label cannot be dropped outside the plant area');
  assert.match(t.toasts.at(-1).message, /plant area/);
});

test('editor: a group moves together; an invalid member refuses the whole move', () => {
  const t = setup({ layout: plant() });
  t.key('a', { ctrlKey: true });
  t.mouse.drag([[5, 4], [5, 12]]);
  assert.equal(t.state().undoLabel, 'Move 4 items');
  assert.deepEqual(t.state().layout.stations.map((s) => s.y), [12, 12, 12, 22]);
  const before = t.state().layout;
  t.mouse.drag([[5, 12], [5, 20]]);
  assert.equal(t.state().layout, before, 'the depot would leave the plate: nothing moved');
});

test('editor: all eight resize handles, minimum 1 x 1, one undo step, blocked sizes refused', () => {
  const t = setup();
  t.store.commit('x', (d) => { addStation(d, { type: 'process', x: 18, y: 10, w: 4, h: 4 }); });
  t.store.select('station', ['s1']);
  const fractions = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
  const out = { nw: [-2, -1], n: [0, -2], ne: [1, -1], e: [2, 0], se: [1, 2], s: [0, 1], sw: [-1, 1], w: [-1, 0] };
  const expected = { nw: [16, 9, 6, 5], n: [18, 8, 4, 6], ne: [18, 9, 5, 5], e: [18, 10, 6, 4], se: [18, 10, 5, 6], s: [18, 10, 4, 5], sw: [17, 10, 5, 5], w: [17, 10, 5, 4] };
  for (const [name, [fx, fy]] of Object.entries(fractions)) {
    const from = t.px(18 + 4 * fx, 10 + 4 * fy, 0, 0);
    t.fire(t.canvas, 'pointerdown', from);
    const to = t.px(18 + 4 * fx + out[name][0], 10 + 4 * fy + out[name][1], 0, 0);
    t.fire(t.canvas, 'pointermove', to);
    assert.equal(t.renderer.view.ghost.valid, true, name);
    t.fire(t.canvas, 'pointerup', to);
    const s = t.state().layout.stations[0];
    assert.deepEqual([s.x, s.y, s.w, s.h], expected[name], `handle ${name}`);
    assert.equal(t.state().undoLabel, 'Resize station');
    t.store.undo();
  }
  const east = t.px(22, 12, 0, 0);
  t.fire(t.canvas, 'pointerdown', east);
  t.fire(t.canvas, 'pointermove', t.px(2, 12));
  assert.equal(t.renderer.view.ghost.rect.w, 1);
  t.fire(t.canvas, 'pointerup', t.px(2, 12));
  assert.equal(t.state().layout.stations[0].w, 1);
  t.store.undo();
  t.store.commit('road', (d) => { paintRoadPath(d, [[26, 8], [26, 16]]); });
  t.fire(t.canvas, 'pointerdown', t.px(22, 14, 0, 0));
  t.fire(t.canvas, 'pointermove', t.px(28, 15, 0, 0));
  assert.equal(t.renderer.view.ghost.valid, false);
  t.fire(t.canvas, 'pointerup', t.px(28, 15, 0, 0));
  assert.equal(t.state().layout.stations[0].w, 4, 'refused');
  assert.match(t.toasts.at(-1).message, /Cannot resize here/);
});

test('editor: Delete takes the flows of a station along and offers Undo; arrows nudge (coalesced, blocked ones refused); Ctrl+D duplicates', () => {
  const t = setup({ layout: plant() });
  t.mouse.click([15, 5]);
  t.key('Delete');
  assert.equal(t.state().undoLabel, 'Delete station');
  assert.deepEqual(t.state().layout.stations.map((s) => s.id), ['s1', 's3', 's4']);
  assert.equal(t.state().layout.flows.length, 0);
  assert.equal(t.toasts.at(-1).message, 'Deleted station and 1 flow.');
  t.toasts.at(-1).action.onClick();
  assert.equal(t.state().layout.stations.length, 4);
  assert.equal(t.state().layout.flows.length, 1);
  t.mouse.click([5, 4]);
  t.key('ArrowRight');
  t.key('ArrowRight');
  assert.deepEqual([t.state().layout.stations[0].x, t.state().layout.stations[0].y], [6, 4]);
  assert.equal(t.state().undoLabel, 'Nudge station');
  t.key('ArrowDown', { shiftKey: true });
  assert.equal(t.state().layout.stations[0].y, 4, 'five cells down would cover the road row');
  assert.match(t.statuses.at(-1), /^Cannot move: a road is in the way\.$/);
  t.key('z', { ctrlKey: true });
  assert.equal(t.state().layout.stations[0].x, 4, 'both nudges were one undo step');
  t.mouse.click([15, 5]);
  t.key('d', { ctrlKey: true });
  assert.equal(t.state().undoLabel, 'Duplicate station');
  const copy = t.state().layout.stations.at(-1);
  assert.deepEqual([copy.id, copy.name, copy.x, copy.y, copy.w, copy.h], ['s5', 'B 2', 18, 4, 3, 3]);
  assert.deepEqual(t.state().ui.selection, { kind: 'station', ids: ['s5'] });
  assert.equal(t.state().layout.flows.length, 1);
  t.key('Backspace');
  assert.equal(t.state().layout.stations.length, 4);
});

test('editor: Ctrl+D with nothing to copy is still swallowed (no bookmark dialog) and says what to do', () => {
  const t = setup({ layout: plant() });
  const e = t.key('d', { ctrlKey: true });
  assert.equal(e.defaultPrevented, true);
  assert.equal(t.state().canUndo, false);
  assert.match(t.statuses.at(-1), /Select a station, wall or label first/);
  t.store.select('flow', ['f1']);
  assert.equal(t.key('d', { ctrlKey: true }).defaultPrevented, true, 'a flow cannot be copied either');
  assert.equal(t.state().canUndo, false);
});

test('editor: a fleet selection is not deleted from the canvas; nothing selected means Delete does nothing', () => {
  const layout = plant();
  layout.fleets.push({ id: 'v1', name: 'AGV', preset: 'agv', count: 2 });
  const t = setup({ layout });
  t.key('Delete');
  assert.equal(t.state().canUndo, false);
  t.store.select('fleet', ['v1']);
  const e = t.key('Delete');
  assert.equal(t.state().layout.fleets.length, 1);
  assert.equal(e.defaultPrevented, false, 'the key was not ours');
});

// ---- flows --------------------------------------------------------------------------------------------------------

test('editor: flow tool connects by drag and by two clicks; invalid pairs say why; a duplicate selects the existing flow; Esc cancels', () => {
  const t = setup({ layout: plant() });
  t.key('f');
  t.mouse.click([27, 5]);
  assert.equal(t.toasts.at(-1).message, 'Goods out cannot send loads.');
  assert.equal(t.renderer.view.flowPreview, null);
  t.mouse.down([15, 5]);
  t.mouse.move([27, 5]);
  assert.deepEqual(t.renderer.view.flowPreview, { fromId: 's2', toPoint: [55, 10] }, 'the band snaps to the middle of the valid receiver C');
  assert.deepEqual(t.renderer.view.hover, { kind: 'station', id: 's3' });
  t.mouse.up([27, 5]);
  assert.deepEqual(t.state().layout.flows.map((f) => [f.from, f.to]), [['s1', 's2'], ['s2', 's3']]);
  assert.match(t.state().undoLabel, /^Connect .+ → .+$/);
  assert.deepEqual(t.state().ui.selection, { kind: 'flow', ids: ['f2'] });
  assert.equal(t.renderer.view.flowPreview, null);
  t.mouse.click([5, 4]);
  assert.equal(t.renderer.view.flowPreview.fromId, 's1', 'a click on the sender waits for the second click');
  t.mouse.move([20, 8]);
  assert.deepEqual(t.renderer.view.flowPreview.toPoint, [41, 17], 'the rubber band follows the pointer');
  t.mouse.click([27, 5]);
  assert.equal(t.state().layout.flows.length, 3);
  t.mouse.drag([[5, 4], [15, 5]]);
  assert.deepEqual(t.state().ui.selection, { kind: 'flow', ids: ['f1'] }, 'A -> B exists already: it is selected instead');
  assert.equal(t.toasts.at(-1).message, 'A already sends loads to B.');
  assert.equal(t.state().layout.flows.length, 3);
  t.mouse.click([15, 5]);
  t.mouse.click([5, 4]);
  assert.equal(t.toasts.at(-1).message, 'Goods in cannot receive loads.');
  assert.ok(t.renderer.view.flowPreview, 'still waiting for a valid receiver');
  t.key('Escape');
  assert.equal(t.renderer.view.flowPreview, null);
  assert.equal(t.editor.tool, 'flow');
  t.key('Escape');
  assert.equal(t.editor.tool, 'select');
  t.key('f');
  t.mouse.drag([[15, 5], [35, 20]]);
  assert.equal(t.state().layout.flows.length, 3, 'released on empty ground: nothing connected');
});

// ---- camera and touch ----------------------------------------------------------------------------------------------

test('editor: the wheel zooms at the cursor (ctrl+wheel as a pinch), Space+drag and the middle button pan, a double click on empty ground fits the view', () => {
  const t = setup({ layout: plant() });
  const at = t.px(10, 10);
  const world = () => t.camera.screenToWorld(at.clientX - 100, at.clientY - 50);
  const w0 = world();
  const z0 = t.camera.zoom;
  const wheel = t.fire(t.canvas, 'wheel', { ...at, deltaY: -100, deltaMode: 0 });
  assert.equal(wheel.defaultPrevented, true, 'the page does not scroll');
  assert.ok(t.camera.zoom > z0 * 1.15);
  assert.ok(Math.hypot(world()[0] - w0[0], world()[1] - w0[1]) < 1e-9, 'the point under the cursor stays put');
  const z1 = t.camera.zoom;
  t.fire(t.canvas, 'wheel', { ...at, deltaY: -10, ctrlKey: true });
  assert.ok(Math.abs(t.camera.zoom / z1 - Math.exp(0.1)) < 1e-9);
  t.fire(t.canvas, 'wheel', { ...at, deltaY: 1, deltaMode: 1 });
  assert.ok(t.camera.zoom < z1 * 1.1, 'line-based wheels are scaled');
  const c0 = { x: t.camera.x, y: t.camera.y };
  t.fire(t.win, 'keydown', { key: ' ' });
  assert.equal(t.canvas.style.cursor, 'grab');
  t.fire(t.canvas, 'pointerdown', { clientX: 500, clientY: 300 });
  assert.equal(t.canvas.style.cursor, 'grabbing');
  t.fire(t.canvas, 'pointermove', { clientX: 540, clientY: 330 });
  t.fire(t.canvas, 'pointerup', { clientX: 540, clientY: 330 });
  t.fire(t.win, 'keyup', { key: ' ' });
  assert.equal(t.editor.spacePanned, true, 'a shell can tell that this Space hold panned');
  t.fire(t.win, 'keydown', { key: ' ' });
  t.fire(t.win, 'keyup', { key: ' ' });
  assert.equal(t.editor.spacePanned, false, 'and that a clean Space tap did not');
  assert.ok(Math.abs((c0.x - t.camera.x) * t.camera.zoom - 40) < 1e-9 && Math.abs((c0.y - t.camera.y) * t.camera.zoom - 30) < 1e-9);
  assert.equal(t.state().canUndo, false);
  assert.equal(t.editor.tool, 'select');
  const c1 = t.camera.x;
  t.fire(t.canvas, 'pointerdown', { clientX: 500, clientY: 300, button: 1 });
  t.fire(t.canvas, 'pointermove', { clientX: 450, clientY: 300 });
  t.fire(t.canvas, 'pointerup', { clientX: 450, clientY: 300, button: 1 });
  assert.ok(Math.abs((t.camera.x - c1) * t.camera.zoom - 50) < 1e-9);
  t.mouse.click([35, 20]);
  assert.equal(t.fitted.length, 0);
  t.mouse.click([35, 20]);
  assert.equal(t.fitted.length, 1, 'two quick clicks on empty ground = ctx.actions.fitView()');
  t.mouse.click([15, 5]);
  t.mouse.click([15, 5]);
  assert.equal(t.fitted.length, 1, 'a double click on a station is not a fit');
  t.key('r');
  t.mouse.click([35, 20]);
  t.mouse.click([35, 20]);
  assert.equal(t.fitted.length, 1, 'and neither is one with a drawing tool (two plates are painted)');
});

test('editor: two fingers pan and pinch-zoom, abandon the stroke the first finger began, and the finger left over stays quiet', () => {
  const t = setup();
  t.key('r');
  const f1 = t.px(5, 5);
  t.fire(t.canvas, 'pointerdown', { ...f1, pointerId: 11, pointerType: 'touch' });
  assert.ok(t.renderer.view.paintPreview, 'one finger draws');
  const z0 = t.camera.zoom;
  const f2 = { clientX: f1.clientX + 100, clientY: f1.clientY };
  t.fire(t.canvas, 'pointerdown', { ...f2, pointerId: 12, pointerType: 'touch' });
  assert.equal(t.renderer.view.paintPreview, null, 'the second finger cancels the stroke');
  t.fire(t.canvas, 'pointermove', { ...f2, clientX: f2.clientX + 100, pointerId: 12, pointerType: 'touch' });
  assert.ok(Math.abs(t.camera.zoom / z0 - 2) < 1e-9, 'fingers 100 px apart moved to 200 px apart: zoom x2');
  const c = { x: t.camera.x, y: t.camera.y };
  t.fire(t.canvas, 'pointermove', { clientX: f1.clientX + 30, clientY: f1.clientY + 20, pointerId: 11, pointerType: 'touch' });
  t.fire(t.canvas, 'pointermove', { clientX: f2.clientX + 130, clientY: f2.clientY + 20, pointerId: 12, pointerType: 'touch' });
  assert.ok(t.camera.x < c.x && t.camera.y < c.y, 'moving both fingers pans');
  t.fire(t.canvas, 'pointerup', { ...f2, pointerId: 12, pointerType: 'touch' });
  t.fire(t.canvas, 'pointermove', { ...t.px(10, 10), pointerId: 11, pointerType: 'touch' });
  assert.equal(t.renderer.view.paintPreview, null, 'the remaining finger does not start a stroke');
  t.fire(t.canvas, 'pointerup', { ...t.px(10, 10), pointerId: 11, pointerType: 'touch' });
  assert.equal(Object.keys(t.state().layout.roads).length, 0);
  t.camera.zoomTo(10);
  t.fire(t.canvas, 'pointerdown', { ...t.px(5, 5), pointerId: 13, pointerType: 'touch' });
  t.fire(t.canvas, 'pointermove', { ...t.px(8, 5), pointerId: 13, pointerType: 'touch' });
  t.fire(t.canvas, 'pointerup', { ...t.px(8, 5), pointerId: 13, pointerType: 'touch' });
  assert.equal(Object.keys(t.state().layout.roads).length, 4, 'all fingers up: the next single finger draws again');
  assert.equal(t.renderer.view.hover, null, 'no hover feedback is left after a touch');
});

test('editor: pen input draws like a mouse; other mouse buttons start nothing; a lost pointer cancels', () => {
  const t = setup();
  t.key('r');
  t.fire(t.canvas, 'pointerdown', { ...t.px(5, 5), pointerType: 'pen', pointerId: 7 });
  t.fire(t.canvas, 'pointermove', { ...t.px(9, 5), pointerType: 'pen', pointerId: 7 });
  t.fire(t.canvas, 'pointerup', { ...t.px(9, 5), pointerType: 'pen', pointerId: 7 });
  assert.equal(Object.keys(t.state().layout.roads).length, 5);
  t.mouse.down([5, 8], { button: 2 });
  assert.equal(t.renderer.view.paintPreview, null, 'a right-button press starts no gesture');
  t.mouse.up([5, 8], { button: 2 });
  t.mouse.down([5, 10]);
  t.mouse.move([9, 10]);
  t.fire(t.canvas, 'pointercancel', { ...t.px(9, 10) });
  assert.equal(t.renderer.view.paintPreview, null);
  t.mouse.up([9, 10]);
  assert.equal(Object.keys(t.state().layout.roads).length, 5, 'pointercancel abandoned the stroke');
  t.mouse.down([5, 12]);
  t.mouse.move([9, 12]);
  t.fire(t.win, 'blur');
  assert.equal(t.renderer.view.paintPreview, null, 'losing the window focus abandons the gesture too');
});

// ---- lifecycle ----------------------------------------------------------------------------------------------------

test('editor: cancel() abandons the gesture and clears previews; undo and scenario changes abandon it too', () => {
  const t = setup();
  t.key('r');
  t.mouse.down([3, 3]);
  t.mouse.move([9, 3]);
  t.editor.cancel();
  assert.equal(t.renderer.view.paintPreview, null);
  t.mouse.up([9, 3]);
  assert.equal(Object.keys(t.state().layout.roads).length, 0);
  t.mouse.drag([[3, 3], [6, 3]]);
  t.mouse.down([3, 6]);
  t.mouse.move([9, 6]);
  t.store.undo();
  assert.equal(t.renderer.view.paintPreview, null, 'an undo from elsewhere ends the stroke');
  t.mouse.up([9, 6]);
  assert.equal(Object.keys(t.state().layout.roads).length, 0, 'nothing was painted by the abandoned stroke');
  t.mouse.down([3, 6]);
  t.store.newProject();
  assert.equal(t.renderer.view.paintPreview, null, 'loading another plant ends it as well');
});

test('editor: destroy() removes every listener and every trace in renderer.view', () => {
  const t = setup();
  t.key('2');
  t.mouse.move([10, 10]);
  assert.ok(t.renderer.view.ghost);
  t.editor.destroy();
  assert.equal(t.renderer.view.ghost, null);
  assert.equal(t.renderer.view.hover, null);
  assert.equal(t.renderer.view.resizeHandles, false);
  assert.notEqual(t.canvas.style.touchAction, 'none');
  t.key('v');
  assert.equal(t.state().ui.tool, 'process', 'keys do nothing any more');
  t.mouse.click([10, 10]);
  assert.equal(t.state().layout.stations.length, 0, 'neither does the pointer');
  t.store.setUi({ tool: 'road' });
  assert.equal(t.editor.tool, 'process', 'nor the store');
  t.editor.destroy();
});

test('editor: works without a ctx (no toast, no status line, no fit action) and draws a frame itself when there is no runner', () => {
  const t = setup({ ctx: {} });
  const bare = new Editor({ canvas: t.canvas, store: t.store, camera: t.camera, renderer: t.renderer });
  bare.setTool('road');
  t.mouse.drag([[3, 3], [6, 3]]);
  t.mouse.click([30, 20], { shiftKey: true });
  assert.ok(Object.keys(t.state().layout.roads).length >= 4);
  assert.ok(t.frames.length > 0, 'a frame was requested');
  const before = t.renderer.renders;
  for (const f of t.frames.splice(0)) f();
  assert.ok(t.renderer.renders > before);
  const withRunner = setup({ ctx: { runner: {} } });
  withRunner.key('r');
  withRunner.mouse.drag([[3, 3], [6, 3]]);
  assert.equal(withRunner.frames.length, 0, 'with the app\'s runner the editor never asks for frames');
  bare.destroy();
});

// ---- robustness ---------------------------------------------------------------------------------------------------

test('editor: fuzz - random pointer, key and wheel input never throws, never breaks the layout and leaves no stale preview', () => {
  const tools = [...'vhrozewf12345'];
  const edits = ['Escape', 'Delete', 'Backspace', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
  for (const seed of [1, 2, 3, 4]) {
    const rng = createRng(seed);
    const t = setup({ layout: seed % 2 ? plant() : createLayout({ cols: 40, rows: 24, cellSize: 2 }) });
    let down = null;
    for (let i = 0; i < 1500; i++) {
      const r = rng.next();
      const at = t.px(rng.int(46) - 3, rng.int(30) - 3);
      const props = { clientX: at.clientX + rng.range(-8, 8), clientY: at.clientY + rng.range(-8, 8), shiftKey: rng.next() < 0.2, altKey: rng.next() < 0.1 };
      if (r < 0.2 && !down) {
        down = { pointerId: 1, pointerType: rng.next() < 0.2 ? 'touch' : 'mouse', button: rng.next() < 0.1 ? 1 : 0 };
        t.fire(t.canvas, 'pointerdown', { ...props, ...down });
      } else if (r < 0.5) t.fire(t.canvas, 'pointermove', { ...props, ...(down || {}) });
      else if (r < 0.62 && down) {
        t.fire(t.canvas, rng.next() < 0.9 ? 'pointerup' : 'pointercancel', { ...props, ...down });
        down = null;
      } else if (r < 0.74) t.key(rng.pick(tools));
      else if (r < 0.84) t.key(rng.pick(edits), props);
      else if (r < 0.9) t.key(rng.pick(['z', 'y', 'd', 'a']), { ctrlKey: true, shiftKey: rng.next() < 0.3 });
      else if (r < 0.95) t.fire(t.canvas, 'wheel', { ...props, deltaY: rng.range(-300, 300), ctrlKey: rng.next() < 0.3 });
      else t.fire(t.win, rng.next() < 0.5 ? 'keydown' : 'keyup', { key: ' ' });
      if (i % 25 === 0) assert.deepEqual(checkInvariants(t.state().layout), [], `seed ${seed}, step ${i}`);
    }
    if (down) t.fire(t.canvas, 'pointerup', { ...t.px(5, 5), ...down });
    for (let i = 0; i < 3; i++) t.key('Escape');
    assert.deepEqual(checkInvariants(t.state().layout), [], `seed ${seed}`);
    assert.equal(t.toasts.some((x) => x.kind === 'error'), false, 'no edit was ever rolled back by the store');
    const v = t.renderer.view;
    assert.deepEqual([v.ghost, v.paintPreview, v.flowPreview, v.marquee], [null, null, null, null], `seed ${seed}: no stale preview`);
    assert.equal(t.editor.tool, 'select');
    while (t.state().canUndo) t.store.undo();
    assert.deepEqual(checkInvariants(t.state().layout), []);
  }
});
