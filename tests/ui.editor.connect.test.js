// Connecting stations on the canvas, in Node: the pure rules (js/ui/editor/connect.js), the editor behaviour built on them
// (flow handle, drag to connect, connect mode, hint toast after placing; js/ui/editor/connector.js through the real Editor with a
// fake DOM) and the pure parts of the jobs overlay (js/ui/render/jobs.js: where a vehicle is heading, loads waiting for pickup,
// fading, and the drawing code itself against a recording context). The browser run in tests/e2e/guidance-canvas.mjs covers real
// pixels and real pointer devices.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HANDLE_HINT, FLOW_CREATED, anchorOf, canReceive, canSend, classifyTarget, connectLabel, connectTargets, connectingText, dropTarget,
  handlePlacement, handleSide, hasHandle, insideHandle, nearestTarget, noPartnerText, overText, placementPrompt, sideFacing, startProblem, targetLabel,
} from '../js/ui/editor/connect.js';
import {
  CHIP_MIN_ZOOM, LINE_MIN_ZOOM, bufferSize, dockPoint, drawJobLines, drawWaitingBadges, fadeAlpha, jobTarget, shortName, waitingIsHigh,
  waitingLoads, waitingText,
} from '../js/ui/render/jobs.js';
import { Editor } from '../js/ui/editor.js';
import { createStore } from '../js/store/store.js';
import { Camera } from '../js/ui/camera.js';
import { Simulation } from '../js/sim/engine.js';
import { EXAMPLES } from '../js/model/examples.js';
import { getTheme } from '../js/ui/theme.js';
import { getScene } from '../js/ui/render/scene.js';
import { createLayout, paintRoadPath, addStation, addFlow, addFleet, addObstacle, checkInvariants } from '../js/model/layout.js';
import { pointInRect } from '../js/ui/render/geometry.js';

/** Source A (s1), workstation B (s2), sink C (s3), depot D (s4), a second source E (s5); flow A -> B; one road. */
function plant() {
  const layout = createLayout({ cols: 40, rows: 24, cellSize: 2 });
  addStation(layout, { type: 'source', x: 4, y: 4, w: 3, h: 2, name: 'A' });
  addStation(layout, { type: 'process', x: 14, y: 4, w: 3, h: 3, name: 'B' });
  addStation(layout, { type: 'sink', x: 26, y: 4, w: 3, h: 2, name: 'C' });
  addStation(layout, { type: 'depot', x: 4, y: 14, w: 3, h: 2, name: 'D' });
  addStation(layout, { type: 'source', x: 4, y: 20, w: 3, h: 2, name: 'E' });
  addFlow(layout, 's1', 's2');
  paintRoadPath(layout, [[4, 9], [30, 9]]);
  addObstacle(layout, { x: 20, y: 14, w: 6, h: 1, kind: 'wall' });
  return layout;
}

// ---------------------------------------------------------------------------------------------------------------------------
// connect.js
// ---------------------------------------------------------------------------------------------------------------------------

test('classifyTarget: valid pairs, existing flows, the station itself and types that do not fit, from both roles', () => {
  const l = plant();
  assert.deepEqual(classifyTarget(l, { fromId: 's1' }, 's3'), { status: 'valid', reason: null });
  assert.equal(classifyTarget(l, { fromId: 's1' }, 's2').status, 'exists');
  assert.equal(classifyTarget(l, { fromId: 's1' }, 's2').flowId, 'f1');
  assert.match(classifyTarget(l, { fromId: 's1' }, 's2').reason, /A already sends loads to B/);
  assert.equal(classifyTarget(l, { fromId: 's1' }, 's1').status, 'self');
  assert.deepEqual(classifyTarget(l, { fromId: 's1' }, 's5'), { status: 'invalid', reason: 'Goods in cannot receive loads.' });
  assert.match(classifyTarget(l, { fromId: 's1' }, 's4').reason, /cannot receive loads/);
  assert.equal(classifyTarget(l, { fromId: 's1' }, 'nope').status, 'invalid');
  assert.equal(classifyTarget(l, { fromId: 'nope' }, 's2').status, 'invalid');
  // a sink anchor asks what feeds it: the targets must be able to send
  assert.deepEqual(classifyTarget(l, { toId: 's3' }, 's2'), { status: 'valid', reason: null });
  assert.equal(classifyTarget(l, { toId: 's3' }, 's5').status, 'valid');
  assert.match(classifyTarget(l, { toId: 's3' }, 's4').reason, /cannot send loads/);
  assert.equal(classifyTarget(l, { toId: 's2' }, 's1').status, 'exists', 'A feeds B already');
  assert.equal(classifyTarget(l, { toId: 's2' }, 's3').status, 'invalid', 'a sink cannot send');
  assert.equal(classifyTarget(l, { toId: 's2' }, 's2').status, 'self');
  assert.equal(classifyTarget(l, {}, 's2').status, 'invalid', 'no anchor');
});

test('connectTargets: valid ids nearest first, existing pairs listed apart, both roles', () => {
  const l = plant();
  const from = connectTargets(l, { fromId: 's1' });
  assert.deepEqual([from.role, from.anchorId], ['from', 's1']);
  assert.deepEqual(from.valid, ['s3'], 'A can send to C; B is connected already; sources and the depot cannot receive');
  assert.deepEqual(from.exists, ['s2']);
  const fromB = connectTargets(l, { fromId: 's2' });
  assert.deepEqual(fromB.valid, ['s3']);
  const to = connectTargets(l, { toId: 's2' });
  assert.deepEqual(to.valid, ['s5'], 'E can feed B (A does already)');
  assert.deepEqual(to.exists, ['s1']);
  const toC = connectTargets(l, { toId: 's3' });
  assert.deepEqual(toC.valid, ['s2', 's1', 's5'], 'B is nearest to C, then A, then E');
  // add a storage between B and C: valid targets are ordered by distance, id breaks ties
  const l2 = plant();
  addStation(l2, { type: 'storage', x: 20, y: 4, w: 4, h: 3, name: 'S' });
  assert.deepEqual(connectTargets(l2, { fromId: 's2' }).valid, ['s6', 's3']);
  assert.equal(nearestTarget(l2, { fromId: 's2' }), 's6');
  assert.equal(nearestTarget(l2, { fromId: 's4' }), null, 'a depot sends nothing');
  assert.deepEqual(connectTargets(l, { fromId: 'missing' }).valid, []);
  assert.deepEqual(connectTargets(l, null).valid, []);
});

test('sideFacing / handleSide: the edge that faces the nearest valid destination, east when there is none', () => {
  const wide = { x: 0, y: 0, w: 6, h: 2 };
  assert.equal(sideFacing(wide, 20, 1), 'e');
  assert.equal(sideFacing(wide, -20, 1), 'w');
  assert.equal(sideFacing(wide, 3, 20), 's');
  assert.equal(sideFacing(wide, 3, -20), 'n');
  assert.equal(sideFacing(wide, 3, 1), 'e', 'the middle itself gives the default');
  // a wide brick: a point at 45 degrees leaves through the top or bottom, because it is the nearer edge
  assert.equal(sideFacing(wide, 13, 11), 's');
  assert.equal(sideFacing({ x: 0, y: 0, w: 2, h: 6 }, 13, 11), 'e');
  assert.equal(sideFacing({ x: 0, y: 0, w: 4, h: 4 }, 10, 10), 'e', 'an exact diagonal prefers the vertical edge');
  const l = plant();
  assert.equal(handleSide(l, 's1'), 'e', 'A: C is to the right');
  assert.equal(handleSide(l, 's5'), 'n', 'E: B and C are above it');
  assert.equal(handleSide(l, 's3'), 'e', 'a sink cannot send: fallback');
  assert.equal(handleSide(l, 's4'), 'e');
  assert.equal(handleSide(l, 'missing'), 'e');
  const lonely = createLayout({ cols: 20, rows: 20, cellSize: 2 });
  addStation(lonely, { type: 'source', x: 2, y: 2 });
  assert.equal(handleSide(lonely, 's1'), 'e', 'nothing to connect to: the right edge');
  const l3 = plant();
  addStation(l3, { type: 'storage', x: 4, y: 11, w: 4, h: 3, name: 'S' });
  assert.equal(handleSide(l3, 's5'), 'n', 'E (centre 5.5, 21) -> S (centre 6, 12.5) is straight up');
});

test('handlePlacement: the middle of the edge, moved out by the offset, with the direction of the arrow', () => {
  const r = { x: 100, y: 50, w: 60, h: 40 };
  const e = handlePlacement(r, 'e', 19);
  assert.deepEqual([e.x, e.y, e.edgeX, e.edgeY, e.angle], [179, 70, 160, 70, 0]);
  const s = handlePlacement(r, 's', 19);
  assert.deepEqual([s.x, s.y, s.edgeX, s.edgeY], [130, 109, 130, 90]);
  assert.equal(s.angle, Math.PI / 2);
  const w = handlePlacement(r, 'w', 0);
  assert.deepEqual([w.x, w.y, w.angle], [100, 70, Math.PI]);
  const n = handlePlacement(r, 'n', 10);
  assert.deepEqual([n.x, n.y, n.angle], [130, 40, -Math.PI / 2]);
  assert.deepEqual([handlePlacement(r, 'x', 5).x, handlePlacement(r, 'x', 5).y], [165, 70], 'an unknown side counts as east');
  assert.equal(insideHandle(e, 180, 71, 3), true);
  assert.equal(insideHandle(e, 190, 70, 3), false);
  assert.equal(hasHandle({ type: 'source' }), true);
  assert.equal(hasHandle({ type: 'process' }), true);
  assert.equal(hasHandle({ type: 'storage' }), true);
  assert.equal(hasHandle({ type: 'sink' }), false);
  assert.equal(hasHandle({ type: 'depot' }), false);
  assert.equal(hasHandle(null), false);
  assert.equal(canSend({ type: 'sink' }) || canReceive({ type: 'source' }) || canReceive({ type: 'depot' }), false);
});

test('dropTarget: what releasing on a cell does, with a sentence for every outcome', () => {
  const l = plant();
  const onC = dropTarget(l, { fromId: 's1' }, [27, 5]);
  assert.deepEqual(onC, { outcome: 'connect', fromId: 's1', toId: 's3', label: 'Connect A → C' });
  const reverse = dropTarget(l, { toId: 's3' }, [15, 5]);
  assert.deepEqual([reverse.outcome, reverse.fromId, reverse.toId, reverse.label], ['connect', 's2', 's3', 'Connect B → C']);
  const exists = dropTarget(l, { fromId: 's1' }, [15, 5]);
  assert.deepEqual([exists.outcome, exists.flowId], ['exists', 'f1']);
  assert.match(exists.message, /A already sends loads to B/);
  const invalid = dropTarget(l, { fromId: 's1' }, [5, 15]);
  assert.equal(invalid.outcome, 'invalid');
  assert.match(invalid.message, /^Parking & charging cannot receive loads\. Choose a Workstation, Storage or Goods out\.$/);
  assert.match(dropTarget(l, { toId: 's3' }, [5, 15]).message, /cannot send loads\. Choose a Goods in, Workstation or Storage\.$/);
  const none = dropTarget(l, { fromId: 's1' }, [35, 20]);
  assert.equal(none.outcome, 'none');
  assert.match(none.message, /^Nothing connected\. Drop on a Workstation, Storage or Goods out to send loads there\.$/);
  assert.match(dropTarget(l, { fromId: 's1' }, [35, 20], 'Click').message, /^Nothing connected\. Click on /);
  assert.match(dropTarget(l, { toId: 's3' }, [35, 20]).message, /Goods in, Workstation or Storage that should feed it/);
  assert.equal(dropTarget(l, { fromId: 's1' }, [5, 5]).outcome, 'self');
  assert.equal(dropTarget(l, { fromId: 'gone' }, [5, 5]).outcome, 'none');
  assert.equal(dropTarget(l, { fromId: 's1' }, null).outcome, 'none');
  assert.equal(connectLabel(l, 's1', 's3'), 'Connect A → C');
  assert.equal(connectLabel(l, 'x', 'y'), 'Connect x → y');
});

test('words: status lines, target labels, start problems and the hint after placing a station', () => {
  const l = plant();
  assert.equal(connectingText(l, { fromId: 's1' }), 'Where should A send its loads? Click the receiving station. Esc cancels.');
  assert.equal(connectingText(l, { toId: 's3' }), 'What feeds C? Click the station that sends loads to it. Esc cancels.');
  assert.equal(connectingText(l, { fromId: 'gone' }), '');
  assert.equal(overText(l, { fromId: 's1' }, 's3', 'Drop'), 'Drop to send loads from A to C');
  assert.equal(overText(l, { toId: 's3' }, 's2'), 'Click to send loads from B to C');
  assert.equal(overText(l, { fromId: 's1' }, 's4'), 'Parking & charging cannot receive loads.');
  assert.equal(overText(l, { fromId: 's1' }, 's1'), connectingText(l, { fromId: 's1' }));
  assert.equal(targetLabel('valid', 'Drop'), 'Drop to connect');
  assert.equal(targetLabel('valid', 'Click'), 'Click to connect');
  assert.equal(targetLabel('exists'), 'Already connected');
  assert.equal(targetLabel('invalid', 'Drop', 'from'), 'Cannot receive loads');
  assert.equal(targetLabel('invalid', 'Drop', 'to'), 'Cannot send loads');
  assert.equal(HANDLE_HINT, 'Drag to another station to send loads there');
  assert.equal(FLOW_CREATED, 'Flow created. Vehicles will serve it automatically.');
  assert.equal(startProblem(l, { fromId: 's1' }), null);
  assert.match(startProblem(l, { fromId: 's3' }), /Goods out cannot send loads/);
  assert.match(startProblem(l, { toId: 's1' }), /Goods in cannot receive loads/);
  assert.match(startProblem(l, { fromId: 'gone' }), /gone/);
  assert.equal(startProblem(l, null), 'That station is gone.');
  const lonely = createLayout({ cols: 20, rows: 20, cellSize: 2 });
  addStation(lonely, { type: 'source', x: 2, y: 2 });
  assert.equal(startProblem(lonely, { fromId: 's1' }), noPartnerText('from'));
  assert.match(noPartnerText('to'), /Nothing can feed it yet/);
  const connected = createLayout({ cols: 20, rows: 20, cellSize: 2 });
  addStation(connected, { type: 'source', x: 2, y: 2, name: 'In' });
  addStation(connected, { type: 'sink', x: 10, y: 2, name: 'Out' });
  addFlow(connected, 's1', 's2');
  assert.match(startProblem(connected, { fromId: 's1' }), /In is connected to every station it can reach/);
  assert.deepEqual(anchorOf({ fromId: 'a' }), { role: 'from', anchorId: 'a' });
  assert.deepEqual(anchorOf({ toId: 'b' }), { role: 'to', anchorId: 'b' });
  assert.equal(anchorOf({ fromId: 5 }), null);
});

test('placementPrompt: the toast after placing a station says what to do next and names the Connect action', () => {
  const l = plant();
  const source = placementPrompt(l, 's5');
  assert.deepEqual(source, { text: 'Goods in placed. Next: where do its loads go?', anchor: { fromId: 's5' } });
  const sink = placementPrompt(l, 's3');
  assert.deepEqual(sink, { text: 'Goods out placed. What feeds it?', anchor: { toId: 's3' } });
  assert.deepEqual(placementPrompt(l, 's2'), { text: 'Workstation placed. What feeds it?', anchor: { toId: 's2' } });
  assert.equal(placementPrompt(l, 's4'), null, 'a depot takes part in no flow');
  assert.equal(placementPrompt(l, 'gone'), null);
  const empty = createLayout({ cols: 20, rows: 20, cellSize: 2 });
  addStation(empty, { type: 'source', x: 2, y: 2 });
  const first = placementPrompt(empty, 's1');
  assert.equal(first.anchor, null, 'nothing to connect to yet: no action, but a next step');
  assert.match(first.text, /^Goods in placed\. Add a Workstation, Storage or Goods out/);
  addStation(empty, { type: 'sink', x: 10, y: 2 });
  assert.match(placementPrompt(empty, 's2').text, /^Goods out placed\. What feeds it\?/);
  const storageOnly = createLayout({ cols: 20, rows: 20, cellSize: 2 });
  addStation(storageOnly, { type: 'storage', x: 2, y: 2 });
  assert.match(placementPrompt(storageOnly, 's1').text, /^Storage placed\. Add a Goods in/);
  addStation(storageOnly, { type: 'sink', x: 10, y: 2 });
  assert.deepEqual(placementPrompt(storageOnly, 's1'), { text: 'Storage placed. Next: where do its loads go?', anchor: { fromId: 's1' } }, 'no sender yet: send onwards');
});

// ---------------------------------------------------------------------------------------------------------------------------
// the editor: flow handle, drag, connect mode, hint after placing (real Editor, real store, fake DOM)
// ---------------------------------------------------------------------------------------------------------------------------

function setup({ layout = plant() } = {}) {
  const frames = [];
  const win = Object.assign(new EventTarget(), { requestAnimationFrame: (fn) => frames.push(fn), innerWidth: 1200, innerHeight: 800 });
  const doc = { defaultView: win, querySelector: () => null };
  const canvas = Object.assign(new EventTarget(), {
    ownerDocument: doc, style: {}, title: '',
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 480 }),
    setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false,
  });
  const store = createStore({ storage: undefined });
  store.newProject(layout);
  const camera = new Camera({ x: 40, y: 24, zoom: 10, width: 800, height: 480 });
  const toasts = [];
  const closed = [];
  const statuses = [];
  const renderer = {
    layout: null,
    sim: null,
    view: { selection: { kind: null, ids: [] }, hover: null, tool: 'select', overlays: {}, ghost: null, paintPreview: null, flowPreview: null, marquee: null, resizeHandles: false },
    hitTest(px, py) {
      const l = this.layout;
      const cs = l.grid.cellSize;
      const [wx, wy] = camera.worldToScreen ? camera.screenToWorld(px, py) : [0, 0];
      const cell = [Math.floor(wx / cs), Math.floor(wy / cs)];
      const h = this.view.connectHandle;
      if (h) {
        const s = l.stations.find((e) => e.id === h.id);
        const [sx, sy] = camera.worldToScreen(s.x * cs, s.y * cs);
        const g = handlePlacement({ x: sx, y: sy, w: s.w * cs * camera.zoom, h: s.h * cs * camera.zoom }, handleSide(l, s.id), 19);
        if (insideHandle(g, px, py, 16)) return { kind: 'connect-handle', id: s.id, cell };
      }
      const station = l.stations.find((s) => pointInRect(wx / cs, wy / cs, s));
      if (station) return { kind: 'station', id: station.id, cell };
      return { kind: 'cell', cell };
    },
    render() {},
  };
  renderer.layout = store.getState().layout;
  const ctx = {
    toast: (m, o) => { const t = { message: m, ...o }; toasts.push(t); return { close: () => closed.push(m) }; },
    setStatus: (t) => statuses.push(t),
    actions: { fitView() {} },
  };
  const editor = new Editor({ canvas, store, camera, renderer, ctx });
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
  const at = (pt) => (Array.isArray(pt) ? px(...pt) : pt);
  const mouse = {
    down: (pt, props) => fire(canvas, 'pointerdown', { ...at(pt), ...props }),
    move: (pt, props) => fire(canvas, 'pointermove', { ...at(pt), ...props }),
    up: (pt, props) => fire(canvas, 'pointerup', { ...at(pt), ...props }),
    click(pt, props) { this.down(pt, props); this.up(pt, props); },
    drag(pts, props) {
      this.down(pts[0], props);
      for (const p of pts.slice(1)) this.move(p, props);
      this.up(pts[pts.length - 1], props);
    },
  };
  const key = (k, props = {}) => {
    const e = fire(win, 'keydown', { key: k, ...props });
    fire(win, 'keyup', { key: k, ...props });
    return e;
  };
  /** Client position of the flow handle of the selected station (it floats 19 px outside the edge that faces its target). */
  const handle = () => {
    const h = renderer.view.connectHandle;
    assert.ok(h, 'a flow handle is shown');
    const l = store.getState().layout;
    const s = l.stations.find((e) => e.id === h.id);
    const cs = l.grid.cellSize;
    const [sx, sy] = camera.worldToScreen(s.x * cs, s.y * cs);
    const g = handlePlacement({ x: sx, y: sy, w: s.w * cs * camera.zoom, h: s.h * cs * camera.zoom }, handleSide(l, s.id), 19);
    return { clientX: 100 + g.x, clientY: 50 + g.y };
  };
  const state = () => store.getState();
  const pairs = () => state().layout.flows.map((f) => `${f.from}>${f.to}`);
  return { editor, store, camera, renderer, canvas, win, toasts, closed, statuses, frames, px, fire, mouse, key, handle, state, pairs };
}

test('flow handle: shown for one selected sender with the Select tool, never while moving or with another tool, hit as a connect-handle', () => {
  const t = setup();
  assert.equal(t.renderer.view.connectHandle, null, 'nothing selected');
  t.store.select('station', ['s1']);
  assert.deepEqual(t.renderer.view.connectHandle, { id: 's1', hover: false, pressed: false });
  assert.equal(t.renderer.hitTest(t.handle().clientX - 100, t.handle().clientY - 50).kind, 'connect-handle');
  t.store.select('station', ['s3']);
  assert.equal(t.renderer.view.connectHandle, null, 'a sink cannot send');
  t.store.select('station', ['s4']);
  assert.equal(t.renderer.view.connectHandle, null, 'a depot has none');
  t.store.select('station', ['s1', 's2']);
  assert.equal(t.renderer.view.connectHandle, null, 'two stations selected');
  t.store.select('station', ['s2']);
  assert.equal(t.renderer.view.connectHandle.id, 's2');
  t.key('r');
  assert.equal(t.renderer.view.connectHandle, null, 'another tool');
  t.key('v');
  assert.ok(t.renderer.view.connectHandle, 'the Select tool brings it back');
  // hovering grows it and sets the tooltip and the status line
  t.mouse.move(t.handle());
  assert.equal(t.renderer.view.connectHandle.hover, true);
  assert.equal(t.canvas.title, HANDLE_HINT);
  assert.ok(t.statuses.at(-1).endsWith(HANDLE_HINT), t.statuses.at(-1));
  assert.deepEqual([...t.renderer.view.connect.valid], ['s3'], 'hovering the handle previews where it can connect to');
  assert.equal(t.renderer.view.connect.over, null);
  assert.equal(t.renderer.view.flowPreview, null, 'but there is no rubber band yet');
  t.mouse.move(t.px(30, 20));
  assert.equal(t.renderer.view.connectHandle.hover, false);
  assert.equal(t.canvas.title, '');
  assert.equal(t.renderer.view.connect, null, 'the preview is gone');
  // moving the station hides the handle until the move is over
  t.mouse.down(t.px(15, 5));
  t.mouse.move(t.px(15, 12));
  assert.equal(t.renderer.view.connectHandle, null, 'hidden while the station moves');
  t.mouse.up(t.px(15, 12));
  assert.ok(t.renderer.view.connectHandle, 'back after the move');
  t.editor.destroy();
  assert.equal(t.renderer.view.connectHandle, null);
});

test('drag from the flow handle: rubber band, glowing targets, one undo step on release, selection and toast', () => {
  const t = setup();
  t.store.select('station', ['s1']);
  const h = t.handle();
  t.mouse.down(h);
  assert.equal(t.renderer.view.connectHandle.pressed, true, 'the handle stays, held down');
  t.mouse.move({ clientX: h.clientX + 30, clientY: h.clientY + 4 });
  const c = t.renderer.view.connect;
  assert.deepEqual([c.role, c.anchorId, [...c.valid], [...c.exists], c.over, c.verb], ['from', 's1', ['s3'], ['s2'], null, 'Drop']);
  assert.equal(t.renderer.view.flowPreview.fromId, 's1');
  t.mouse.move(t.px(27, 5));
  const over = t.renderer.view.connect;
  assert.deepEqual([over.over, over.overStatus, over.snap], ['s3', 'valid', 's3']);
  assert.deepEqual(t.renderer.view.flowPreview, { fromId: 's1', toPoint: [55, 10] }, 'the band snaps to the middle of C');
  assert.match(t.statuses.at(-1), /^Drop to send loads from A to C$/);
  assert.equal(t.canvas.style.cursor, 'pointer');
  t.mouse.up(t.px(27, 5));
  assert.deepEqual(t.pairs(), ['s1>s2', 's1>s3']);
  assert.equal(t.state().undoLabel, 'Connect A → C');
  assert.deepEqual(t.state().ui.selection, { kind: 'flow', ids: ['f2'] });
  assert.equal(t.toasts.at(-1).message, FLOW_CREATED);
  assert.equal(t.toasts.at(-1).kind, 'success');
  assert.equal(t.renderer.view.connect, null);
  assert.equal(t.renderer.view.flowPreview, null);
  t.key('z', { ctrlKey: true });
  assert.deepEqual(t.pairs(), ['s1>s2'], 'undo');
  assert.deepEqual(checkInvariants(t.state().layout), []);
});

test('drag from the flow handle: a wrong release connects nothing and says what to do; a pair that exists is selected; Esc cancels', () => {
  const t = setup();
  t.store.select('station', ['s1']);
  const undo0 = t.state().undoLabel;
  t.mouse.down(t.handle());
  t.mouse.move(t.px(5, 15));
  assert.deepEqual([t.renderer.view.connect.over, t.renderer.view.connect.overStatus, t.renderer.view.connect.snap], ['s4', 'invalid', null]);
  assert.equal(t.canvas.style.cursor, 'not-allowed');
  assert.match(t.statuses.at(-1), /Parking & charging cannot receive loads/);
  t.mouse.up(t.px(5, 15));
  assert.equal(t.pairs().length, 1);
  assert.equal(t.toasts.at(-1).kind, 'warn');
  assert.match(t.toasts.at(-1).message, /^Parking & charging cannot receive loads\. Choose a Workstation, Storage or Goods out\.$/);
  assert.equal(t.state().undoLabel, undo0, 'no undo step');
  assert.ok(t.renderer.view.connectHandle, 'the station is still selected and keeps its handle');
  // empty ground
  t.mouse.drag([t.handle(), t.px(35, 20)]);
  assert.equal(t.pairs().length, 1);
  assert.match(t.toasts.at(-1).message, /^Nothing connected\. Drop on a Workstation, Storage or Goods out/);
  assert.equal(t.toasts.at(-1).kind, 'info');
  // released on the station itself
  t.mouse.drag([t.handle(), t.px(5, 5)]);
  assert.equal(t.pairs().length, 1);
  assert.match(t.toasts.at(-1).message, /^Nothing connected/);
  // an existing pair
  t.mouse.drag([t.handle(), t.px(15, 5)]);
  assert.equal(t.pairs().length, 1);
  assert.deepEqual(t.state().ui.selection, { kind: 'flow', ids: ['f1'] });
  assert.match(t.toasts.at(-1).message, /A already sends loads to B/);
  // Esc during the drag
  t.store.select('station', ['s1']);
  t.mouse.down(t.handle());
  t.mouse.move(t.px(27, 5));
  assert.ok(t.renderer.view.connect);
  t.key('Escape');
  assert.equal(t.renderer.view.connect, null);
  assert.equal(t.renderer.view.flowPreview, null);
  t.mouse.up(t.px(27, 5));
  assert.equal(t.pairs().length, 1, 'the cancelled drag did not connect');
  assert.equal(t.state().undoLabel, undo0);
});

test('connect mode by a click on the handle: targets glow, the next click on a valid station connects, Esc / a wrong click / a tool change end or keep it', () => {
  const t = setup();
  t.store.select('station', ['s1']);
  t.mouse.click(t.handle());
  assert.equal(t.editor.connector.mode, true);
  assert.deepEqual(t.editor.connector.anchor, { fromId: 's1' });
  assert.equal(t.renderer.view.connectHandle, null, 'the handle gives way');
  assert.equal(t.renderer.view.resizeHandles, false, 'and so do the resize handles');
  assert.deepEqual([...t.renderer.view.connect.valid], ['s3']);
  assert.equal(t.renderer.view.connect.verb, 'Click');
  assert.equal(t.statuses.at(-1), 'Where should A send its loads? Click the receiving station. Esc cancels.');
  assert.equal(t.pairs().length, 1, 'a plain click adds nothing');
  t.mouse.move(t.px(27, 5));
  assert.equal(t.renderer.view.connect.over, 's3');
  assert.equal(t.renderer.view.flowPreview.fromId, 's1');
  // a station that cannot receive: explained, the mode stays
  t.mouse.click(t.px(5, 15));
  assert.equal(t.editor.connector.mode, true);
  assert.match(t.toasts.at(-1).message, /Parking & charging cannot receive loads/);
  // a click on the station it started from is ignored quietly
  const toasts = t.toasts.length;
  t.mouse.click(t.px(5, 5));
  assert.equal(t.editor.connector.mode, true);
  assert.equal(t.toasts.length, toasts, 'no message for that');
  // the right one
  t.mouse.click(t.px(27, 5));
  assert.equal(t.editor.connector.mode, false);
  assert.deepEqual(t.pairs(), ['s1>s2', 's1>s3']);
  assert.equal(t.state().undoLabel, 'Connect A → C');
  assert.equal(t.toasts.at(-1).message, FLOW_CREATED);
  assert.equal(t.renderer.view.connect, null);
  assert.equal(t.state().ui.selection.kind, 'flow');
  // Esc cancels and leaves the station selected with its handle
  t.store.select('station', ['s2']);
  t.mouse.click(t.handle());
  assert.equal(t.editor.connector.mode, true);
  t.key('Escape');
  assert.equal(t.editor.connector.mode, false);
  assert.equal(t.renderer.view.connect, null);
  assert.deepEqual(t.state().ui.selection, { kind: 'station', ids: ['s2'] });
  assert.ok(t.renderer.view.connectHandle);
  assert.equal(t.editor.tool, 'select');
  // a click on empty ground ends it with a hint
  t.store.select('station', ['s5']);
  t.mouse.click(t.handle());
  assert.equal(t.editor.connector.mode, true);
  t.mouse.click(t.px(35, 20));
  assert.equal(t.editor.connector.mode, false);
  assert.match(t.toasts.at(-1).message, /^Nothing connected\. Click on a Workstation/);
  // another tool ends it
  t.store.select('station', ['s5']);
  t.mouse.click(t.handle());
  assert.equal(t.editor.connector.mode, true);
  t.key('e');
  assert.equal(t.editor.connector.mode, false);
  assert.equal(t.renderer.view.connect, null);
  // deleting the station while connecting ends the mode
  t.key('v');
  t.store.select('station', ['s5']);
  t.mouse.click(t.handle());
  assert.equal(t.editor.connector.mode, true);
  t.store.commit('Remove', (d) => { d.stations = d.stations.filter((s) => s.id !== 's5'); });
  assert.equal(t.editor.connector.mode, false, 'the anchor is gone');
  assert.equal(t.renderer.view.connect, null);
  // undo ends it too
  t.store.select('station', ['s2']);
  t.mouse.click(t.handle());
  assert.equal(t.editor.connector.mode, true);
  t.key('z', { ctrlKey: true });
  assert.equal(t.editor.connector.mode, false);
});

test('setUi accepts the jobs overlay flag and ignores junk for it', () => {
  const store = createStore({ storage: undefined });
  assert.equal(store.getState().ui.overlays.jobs, true, 'on by default');
  store.setUi({ overlays: { jobs: false } });
  assert.equal(store.getState().ui.overlays.jobs, false);
  store.setUi({ overlays: { jobs: 'yes' } });
  assert.equal(store.getState().ui.overlays.jobs, false, 'only booleans');
  store.setUi({ overlays: { grid: false } });
  assert.equal(store.getState().ui.overlays.jobs, false, 'other flags leave it alone');
});

test('editor.startConnect({ toId }): click the sender; the band runs from the pointer to the sink; start problems are explained', () => {
  const t = setup();
  assert.equal(t.editor.startConnect({ toId: 's3' }), true);
  assert.equal(t.editor.connector.mode, true);
  assert.deepEqual(t.state().ui.selection, { kind: 'station', ids: ['s3'] }, 'the anchor is selected');
  assert.deepEqual([...t.renderer.view.connect.valid].sort(), ['s1', 's2', 's5'], 'every sender glows');
  assert.equal(t.renderer.view.connect.role, 'to');
  assert.equal(t.statuses.at(-1), 'What feeds C? Click the station that sends loads to it. Esc cancels.');
  t.mouse.move(t.px(15, 5));
  assert.deepEqual(t.renderer.view.flowPreview, { toId: 's3', fromPoint: [31, 11] }, 'the band snaps to the middle of B');
  assert.match(t.statuses.at(-1), /^Click to send loads from B to C$/);
  t.mouse.click(t.px(15, 5));
  assert.deepEqual(t.pairs(), ['s1>s2', 's2>s3']);
  assert.equal(t.state().undoLabel, 'Connect B → C');
  assert.equal(t.editor.connector.mode, false);
  // problems: a station that cannot take part, a missing one, nothing given
  const before = t.toasts.length;
  assert.equal(t.editor.startConnect({ fromId: 's3' }), false);
  assert.match(t.toasts.at(-1).message, /Goods out cannot send loads/);
  assert.equal(t.editor.startConnect({ toId: 's1' }), false);
  assert.equal(t.editor.startConnect({ fromId: 'gone' }), false);
  assert.equal(t.editor.startConnect(), false);
  assert.equal(t.editor.startConnect({ fromId: 5 }), false);
  assert.equal(t.toasts.length, before + 5, 'each failure says why');
  assert.equal(t.editor.connector.mode, false);
  // starting while another tool is active switches to Select
  t.key('r');
  assert.equal(t.editor.startConnect({ fromId: 's1' }), true);
  assert.equal(t.editor.tool, 'select');
  assert.equal(t.state().ui.tool, 'select');
  // and starting again restarts cleanly
  assert.equal(t.editor.startConnect({ fromId: 's5' }), true);
  assert.deepEqual(t.editor.connector.anchor, { fromId: 's5' });
  t.editor.cancel();
  assert.equal(t.editor.connector.mode, false);
  assert.equal(t.renderer.view.connect, null);
});

test('after placing a station a hint toast names the next step; its Connect action starts connect mode; one hint at a time', () => {
  const t = setup();
  t.key('1');
  t.mouse.click(t.px(10, 18));
  assert.deepEqual(t.state().ui.selection, { kind: 'station', ids: ['s6'] });
  assert.equal(t.toasts.at(-1).message, 'Goods in placed. Next: where do its loads go?');
  assert.equal(t.toasts.at(-1).action.label, 'Connect');
  assert.equal(t.toasts.at(-1).kind, 'info');
  assert.ok(t.toasts.at(-1).ms >= 6000, 'long enough to read and act');
  // the action: connect mode from the new station, Select tool
  t.toasts.at(-1).action.onClick();
  assert.equal(t.editor.connector.mode, true);
  assert.deepEqual(t.editor.connector.anchor, { fromId: 's6' });
  assert.equal(t.editor.tool, 'select');
  t.mouse.click(t.px(15, 5));
  assert.equal(t.pairs().at(-1), 's6>s2');
  assert.equal(t.state().undoLabel, 'Connect Goods in 1 → B');
  // a sink: "What feeds it?" and the action asks for the sender
  t.key('4');
  t.mouse.click(t.px(30, 18));
  assert.equal(t.toasts.at(-1).message, 'Goods out placed. What feeds it?');
  t.toasts.at(-1).action.onClick();
  assert.deepEqual(t.editor.connector.anchor, { toId: 's7' });
  t.key('Escape');
  // a hint that nobody acted on is replaced by the next one instead of piling up
  t.key('1');
  t.mouse.click(t.px(36, 18));
  const first = t.toasts.at(-1).message;
  assert.equal(first, 'Goods in placed. Next: where do its loads go?');
  t.mouse.click(t.px(36, 22));
  assert.ok(t.closed.includes(first), 'the first hint was closed when the second station was placed');
  // a depot and an obstacle: no hint; a failed placement: no hint
  const n = t.toasts.length;
  t.key('5');
  t.mouse.click(t.px(34, 12));
  t.key('w');
  t.mouse.click(t.px(34, 20));
  t.key('4');
  t.mouse.click(t.px(15, 5)); // occupied by B
  assert.equal(t.toasts.slice(n).filter((x) => /placed/.test(x.message)).length, 0);
  assert.equal(t.toasts.slice(n).length, 1, 'only the warning about the blocked spot');
  // the first station of an empty plant has nothing to connect to yet: a hint without an action
  const e = setup({ layout: createLayout({ cols: 40, rows: 24, cellSize: 2 }) });
  e.key('1');
  e.mouse.click(e.px(10, 10));
  assert.match(e.toasts.at(-1).message, /^Goods in placed\. Add a Workstation, Storage or Goods out/);
  assert.equal(e.toasts.at(-1).action, undefined);
});

test('hovering a sender that is connected to everything it can reach previews nothing (no pointless dimming)', () => {
  const layout = plant();
  addFlow(layout, 's1', 's3');
  const t = setup({ layout });
  t.store.select('station', ['s1']);
  t.mouse.move(t.handle());
  assert.equal(t.renderer.view.connectHandle.hover, true);
  assert.equal(t.renderer.view.connect, null, 'A has no valid receiver left: nothing glows, nothing is dimmed');
  t.key('f');
  t.mouse.move(t.px(5, 4));
  assert.equal(t.renderer.view.connect, null);
});

test('the Flow tool highlights the receivers that are valid once a sender is chosen, and clears it again', () => {
  const t = setup();
  t.key('f');
  assert.equal(t.renderer.view.connect, null);
  t.mouse.move(t.px(5, 4)); // hovering a sender previews its receivers
  assert.deepEqual([t.renderer.view.connect.anchorId, [...t.renderer.view.connect.valid]], ['s1', ['s3']]);
  t.mouse.move(t.px(30, 20));
  assert.equal(t.renderer.view.connect, null, 'and the preview ends with the hover');
  t.mouse.move(t.px(27, 5)); // a sink cannot send: nothing to preview
  assert.equal(t.renderer.view.connect, null);
  t.mouse.click(t.px(5, 4)); // A: waits for the second click
  t.mouse.move(t.px(27, 5));
  const c = t.renderer.view.connect;
  assert.deepEqual([c.role, c.anchorId, [...c.valid], [...c.exists], c.over, c.overStatus], ['from', 's1', ['s3'], ['s2'], 's3', 'valid']);
  t.mouse.move(t.px(15, 5));
  assert.deepEqual([t.renderer.view.connect.over, t.renderer.view.connect.overStatus], ['s2', 'exists']);
  t.mouse.move(t.px(5, 15));
  assert.deepEqual([t.renderer.view.connect.over, t.renderer.view.connect.overStatus], ['s4', 'invalid']);
  t.key('Escape');
  assert.equal(t.renderer.view.connect, null);
  // drag and release creates one flow, labelled like every other way of connecting
  t.mouse.drag([t.px(5, 4), t.px(27, 5)]);
  assert.equal(t.pairs().length, 2);
  assert.match(t.state().undoLabel, /^Connect .+ → .+$/, 'the flow tool uses the same undo label as the handle');
  assert.equal(t.renderer.view.connect, null);
  assert.equal(t.renderer.view.flowPreview, null);
});

test('a pinch or a window blur in connect mode keeps the mode; leaving the canvas drops the rubber band but keeps the targets', () => {
  const t = setup();
  t.editor.startConnect({ fromId: 's1' });
  t.mouse.move(t.px(27, 5));
  assert.ok(t.renderer.view.flowPreview);
  t.fire(t.canvas, 'pointerleave', {});
  assert.equal(t.renderer.view.flowPreview, null, 'no band without a pointer');
  assert.ok(t.renderer.view.connect, 'but the targets still glow');
  assert.equal(t.renderer.view.connect.over, null);
  assert.equal(t.editor.connector.mode, true);
  t.fire(t.win, 'blur', {});
  assert.equal(t.editor.connector.mode, true, 'a blur ends a drag, not the mode');
  // two fingers: pan and zoom are not a connect
  t.fire(t.canvas, 'pointerdown', { ...t.px(5, 15), pointerType: 'touch', pointerId: 11 });
  t.fire(t.canvas, 'pointerdown', { ...t.px(8, 15), pointerType: 'touch', pointerId: 12 });
  t.fire(t.canvas, 'pointerup', { ...t.px(5, 15), pointerType: 'touch', pointerId: 11 });
  t.fire(t.canvas, 'pointerup', { ...t.px(8, 15), pointerType: 'touch', pointerId: 12 });
  assert.equal(t.editor.connector.mode, true);
  assert.equal(t.pairs().length, 1);
  t.editor.destroy();
  assert.equal(t.renderer.view.connect, null);
});

test('an editor without a toast function or status line still connects (the harness case)', () => {
  const layout = plant();
  const store = createStore({ storage: undefined });
  store.newProject(layout);
  const win = Object.assign(new EventTarget(), { requestAnimationFrame: (fn) => fn() });
  const canvas = Object.assign(new EventTarget(), { ownerDocument: { defaultView: win }, style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 480 }), setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false });
  const camera = new Camera({ x: 40, y: 24, zoom: 10, width: 800, height: 480 });
  const renderer = { layout: null, view: { selection: { kind: null, ids: [] }, overlays: {} }, hitTest: () => ({ kind: 'cell', cell: [0, 0] }), render() {} };
  const editor = new Editor({ canvas, store, camera, renderer });
  assert.equal(editor.startConnect({ fromId: 's1' }), true);
  assert.equal(editor.startConnect({ fromId: 's3' }), false);
  editor.cancel();
  editor.connector.afterPlace('s1');
  editor.destroy();
});

// ---------------------------------------------------------------------------------------------------------------------------
// jobs.js
// ---------------------------------------------------------------------------------------------------------------------------

test('jobTarget: the station a vehicle drives to for its order (pickup station, then delivery station), else null', () => {
  const order = { from: 's1', to: 's2' };
  assert.equal(jobTarget({ state: 'toPickup', order }), 's1');
  assert.equal(jobTarget({ state: 'toDrop', order }), 's2');
  assert.equal(jobTarget({ state: 'loading', order }), null);
  assert.equal(jobTarget({ state: 'unloading', order }), null);
  assert.equal(jobTarget({ state: 'idle', order: null }), null);
  assert.equal(jobTarget({ state: 'toPark', order: null, targetId: 's9' }), null, 'driving to a depot is not a job');
  assert.equal(jobTarget({ state: 'toPickup', order: null, targetId: 's4' }), 's4', 'no order object: the leg target');
  assert.equal(jobTarget({ state: 'toDrop', order: { from: 's1' }, targetId: 's2' }), null);
  assert.equal(jobTarget({ state: 'broken', order }), null);
});

test('fadeAlpha, shortName, waitingText: monotonic fading, truncation with an ellipsis, cached texts', () => {
  assert.equal(fadeAlpha(0), fadeAlpha(6));
  assert.ok(fadeAlpha(6) > fadeAlpha(20) && fadeAlpha(20) > fadeAlpha(40));
  assert.equal(fadeAlpha(40), fadeAlpha(400), 'the faintest line is still visible');
  assert.ok(fadeAlpha(400) >= 0.4 && fadeAlpha(0) <= 1);
  assert.equal(shortName('Goods in 2'), 'Goods in 2');
  assert.equal(shortName('Assembly hall west wing'), 'Assembly hall w…');
  assert.equal(shortName('Assembly hall west wing', 8), 'Assembl…');
  assert.equal(shortName('  padded  '), 'padded');
  assert.equal(shortName(undefined), '');
  assert.equal(waitingText(3), '3 waiting');
  assert.equal(waitingText(3), waitingText(3));
  assert.equal(waitingText(5000), '999+ waiting');
});

test('dockPoint: the last cell of the route when it is a dock of the station, else the nearest dock, else the station middle', () => {
  const graph = {
    x: (id) => (id % 10) * 2 + 1,
    y: (id) => Math.floor(id / 10) * 2 + 1,
    docks: new Map([['s1', [11, 25, 38]]]),
    stationsAt: new Map([[25, ['s1']], [11, ['s1', 's2']]]),
  };
  const entry = { x: 10, y: 10, w: 6, h: 4 };
  const out = [0, 0];
  assert.equal(dockPoint(graph, { route: { nodes: [3, 4, 25] } }, 's1', entry, 0, 0, out), true);
  assert.deepEqual(out, [11, 5], 'the route ends at node 25');
  assert.equal(dockPoint(graph, { route: { nodes: [3, 4, 26] } }, 's1', entry, 2, 3, out), true);
  assert.deepEqual(out, [3, 3], 'a route that ends elsewhere is ignored: the nearest dock by straight distance (node 11)');
  assert.equal(dockPoint(graph, { route: null }, 's1', entry, 17, 7, out), true);
  assert.deepEqual(out, [17, 7], 'node 38 is nearest to (17, 7)');
  assert.equal(dockPoint(graph, {}, 's9', entry, 0, 0, out), false);
  assert.deepEqual(out, [13, 12], 'no dock known: the middle of the station');
  assert.equal(dockPoint(null, {}, 's1', entry, 0, 0, out), false);
});

/** A running plant with a restricted flow: Goods in 2 -> Dispatch may only be served by a fleet without vehicles. */
function waitingPlant() {
  const layout = EXAMPLES.find((e) => e.id === 'starter').build();
  addStation(layout, { type: 'source', x: 14, y: 7, w: 3, h: 2, name: 'Goods in 2' });
  const fleet = addFleet(layout, 'forklift', { count: 0, name: 'Forklift' });
  addFlow(layout, 's5', 's3', { fleetId: fleet.id });
  return layout;
}

test('waitingLoads on a real simulation: loads nobody can collect pile up unclaimed; the claimed ones do not count', () => {
  const sim = new Simulation(waitingPlant(), { seed: 7 });
  const rt = (id) => sim.logistics.stationById.get(id);
  assert.equal(waitingLoads(rt('s5'), sim.time), 0);
  sim.advance(250);
  const n = waitingLoads(rt('s5'), sim.time);
  assert.ok(n >= 2, `Goods in 2 holds ${n} loads: nobody may collect them`);
  assert.equal(n, rt('s5').outCount, 'all of them are unclaimed');
  assert.equal(waitingIsHigh(rt('s5'), n), false, `${n} of ${bufferSize(rt('s5'))} is still fine`);
  sim.advance(900);
  const full = waitingLoads(rt('s5'), sim.time);
  assert.equal(full, bufferSize(rt('s5')), 'the buffer is full');
  assert.equal(bufferSize(rt('s5')), 6);
  assert.equal(waitingIsHigh(rt('s5'), full), true, 'full is a problem');
  assert.ok(rt('s5').yardQ.length > 0, 'and loads queue up in the yard: a source with a backlog is always a problem');
  assert.equal(waitingIsHigh(rt('s5'), 1), true, 'even one load waiting, while the yard is backed up');
  // the 80 % rule on its own: a buffer of 6 per flow (no backlog)
  const probe = { type: 'process', params: {}, outLinks: [{ cap: 6, queue: [], claimed: 0 }] };
  assert.equal(waitingIsHigh(probe, 5), true, '80 % of 6 is 4.8: five is a problem');
  assert.equal(waitingIsHigh(probe, 4), false);
  assert.equal(waitingIsHigh(probe, 0), false);
  assert.equal(waitingIsHigh({ type: 'process', params: {}, outLinks: [] }, 3), false, 'no buffer to be nearly full');
  // loads that an order has claimed are on their way: they do not wait
  let claimed = 0;
  for (let t = 0; t < 200 && claimed === 0; t++) {
    sim.advance(5);
    const link = rt('s1').outLinks[0];
    claimed = link.claimed;
    if (claimed > 0) assert.equal(waitingLoads(rt('s1'), sim.time), link.queue.length - claimed);
  }
  assert.ok(claimed > 0, 'a vehicle claimed a load at Goods receiving at some point');
  // stations without output queues, and junk
  assert.equal(waitingLoads(rt('s3'), sim.time), 0, 'a sink');
  assert.equal(waitingLoads(null, 0), 0);
  assert.equal(waitingLoads({}, 0), 0);
});

test('waitingLoads: a storage load whose dwell time is not over yet is not ready; a storage is as big as its capacity', () => {
  const link = (loads, claimed = 0) => ({ queue: loads, claimed, cap: Infinity });
  const rt = { type: 'storage', params: { capacity: 10 }, outLinks: [link([{ readyAt: 0 }, { readyAt: 5 }, { readyAt: 20 }, { readyAt: 30 }])] };
  assert.equal(waitingLoads(rt, 10), 2, 'two are ready at t = 10');
  assert.equal(waitingLoads(rt, 100), 4);
  assert.equal(waitingLoads(rt, -1), 0);
  rt.outLinks[0].claimed = 1;
  assert.equal(waitingLoads(rt, 100), 3, 'one is claimed by a vehicle');
  rt.outLinks.push(link([{ readyAt: 0 }]));
  assert.equal(waitingLoads(rt, 100), 4, 'all output queues count');
  assert.equal(bufferSize(rt), 10);
  assert.equal(waitingIsHigh(rt, 8), true);
  assert.equal(waitingIsHigh(rt, 7), false);
  assert.equal(bufferSize({ type: 'source', outLinks: [{ cap: 6 }, { cap: 6 }] }), 12, 'per outgoing flow, summed');
});

// ---- the drawing code against a recording context -------------------------------------------------------------------------

/** A canvas context that records the calls the jobs overlay makes and measures text as 6 px per character. */
function recorder() {
  const calls = [];
  const target = {
    calls,
    font: '',
    measureText: (s) => ({ width: String(s).length * 6 }),
  };
  return new Proxy(target, {
    get(obj, prop) {
      if (prop in obj) return obj[prop];
      return (...args) => { calls.push([prop, ...args]); };
    },
    set(obj, prop, value) { obj[prop] = value; return true; },
  });
}
const count = (ctx, name) => ctx.calls.filter((c) => c[0] === name).length;

/** A frame object like the renderer's, over `sim`. */
function frameFor(sim, { zoom = 20, overlays = {}, hoverVehicle = null, selFleet = null } = {}) {
  const layout = sim.layout;
  const scene = getScene(layout);
  return {
    theme: getTheme('light'), layout, scene, sim, view: {}, overlays, zoom, dpr: 1, cs: scene.cs, ox: 10, oy: 10, w: 1400, h: 900,
    vis: { x0: -1, y0: -1, x1: 1400 / zoom, y1: 900 / zoom }, alpha: 1, now: 0, hoverVehicle, selFleet, pose: new Float64Array(3),
    size: { length: 1.2, width: 0.66 }, rtOf: (id) => sim.logistics.stationById.get(id) || null,
  };
}

/** Run the Starter until a vehicle drives to a station more than 4 m away. */
function simWithJob() {
  const sim = new Simulation(waitingPlant(), { seed: 3 });
  for (let i = 0; i < 400; i++) {
    sim.advance(1);
    const v = sim.vehicles.find((x) => jobTarget(x) !== null && x.visible !== false);
    if (v) {
      const out = [0, 0];
      const e = sim.layout.stations.find((s) => s.id === jobTarget(v));
      dockPoint(sim.graph, v, e.id, { x: e.x * 2, y: e.y * 2, w: e.w * 2, h: e.h * 2 }, v.x, v.y, out);
      if (Math.hypot(out[0] - v.x, out[1] - v.y) > 4) return sim;
    }
  }
  throw new Error('no vehicle went to a station');
}

test('drawJobLines: one dashed line with an arrow head per vehicle that has an order, a chip when zoomed in, nothing when switched off or zoomed out', () => {
  const sim = simWithJob();
  const moving = sim.vehicles.filter((v) => jobTarget(v) !== null && v.visible !== false).length;
  assert.ok(moving >= 1);
  const ctx = recorder();
  drawJobLines(ctx, frameFor(sim, { zoom: 20 }));
  assert.ok(count(ctx, 'stroke') >= 2 * moving, 'casing and dashes for each line');
  assert.ok(count(ctx, 'fill') >= moving, 'an arrow head each');
  assert.ok(ctx.calls.some((c) => c[0] === 'setLineDash' && c[1].length === 2), 'dashed');
  const chips = ctx.calls.filter((c) => c[0] === 'fillText');
  assert.ok(chips.length >= 1 && chips.every((c) => c[1].startsWith('→ ')), `a chip with the target's name: ${chips.map((c) => c[1])}`);
  // zoomed out a little: lines, but no chips (not even the hovered vehicle's below its own threshold)
  const far = recorder();
  drawJobLines(far, frameFor(sim, { zoom: CHIP_MIN_ZOOM - 4 }));
  assert.ok(count(far, 'stroke') >= 2 && count(far, 'fillText') === 0);
  // a hovered vehicle shows its chip at a lower zoom
  const v = sim.vehicles.find((x) => jobTarget(x) !== null && x.visible !== false);
  const hovered = recorder();
  drawJobLines(hovered, frameFor(sim, { zoom: CHIP_MIN_ZOOM - 4, hoverVehicle: v.id }));
  assert.ok(count(hovered, 'fillText') >= 1, 'hovering a vehicle names its target');
  // a selected fleet likewise
  const fleet = recorder();
  drawJobLines(fleet, frameFor(sim, { zoom: CHIP_MIN_ZOOM - 4, selFleet: v.fleetId }));
  assert.ok(count(fleet, 'fillText') >= 1);
  // off, too small, no simulation
  const off = recorder();
  drawJobLines(off, frameFor(sim, { overlays: { jobs: false } }));
  assert.equal(off.calls.length, 0, 'switched off');
  const tiny = recorder();
  drawJobLines(tiny, frameFor(sim, { zoom: LINE_MIN_ZOOM - 1 }));
  assert.equal(tiny.calls.length, 0, 'too small to be useful');
  const none = recorder();
  drawJobLines(none, { ...frameFor(sim), sim: null });
  assert.equal(none.calls.length, 0);
  // vehicles with no order or parked inside draw nothing
  const idle = new Simulation(EXAMPLES.find((e) => e.id === 'starter').build(), { seed: 1 });
  const quiet = recorder();
  drawJobLines(quiet, frameFor(idle));
  // (the dock markers - small dots at the docks, hollow while free - are part of the overlay: no line, no arrow head, no chip)
  assert.ok(!quiet.calls.some((c) => c[0] === 'moveTo' || c[0] === 'lineTo' || c[0] === 'fillText'), 'before the first order no line and no chip is drawn');
  assert.ok(quiet.calls.filter((c) => c[0] === 'arc').length >= 1, 'but the docks are marked');
});

test('drawJobLines: chips never cover each other, and a hovered vehicle keeps its chip when two would collide', () => {
  const sim = simWithJob();
  const v = sim.vehicles.find((x) => jobTarget(x) !== null && x.visible !== false);
  const mk = (id, dx) => ({ ...v, id, x: v.x + dx, y: v.y, prevX: v.x + dx, prevY: v.y, route: v.route, tv: v.tv, order: v.order, state: v.state, fleetId: v.fleetId, visible: true });
  // two vehicles side by side heading for the same station: their chips would sit on top of each other
  const a = mk('a#1', 0);
  const b = mk('b#1', 0.4);
  const fr = frameFor(sim, { zoom: 20 });
  fr.sim = { ...sim, vehicles: [a, b], graph: sim.graph, time: sim.time };
  const both = recorder();
  drawJobLines(both, fr);
  assert.equal(count(both, 'fillText'), 1, 'one chip, not two stacked on each other');
  // far apart: both are drawn
  const c = mk('c#1', 12);
  fr.sim = { ...sim, vehicles: [a, c], graph: sim.graph, time: sim.time };
  const apart = recorder();
  drawJobLines(apart, fr);
  assert.equal(count(apart, 'fillText'), 2);
  // hovered second vehicle: its chip is the one that stays
  const focused = frameFor(sim, { zoom: 20, hoverVehicle: 'b#1' });
  focused.sim = { ...sim, vehicles: [a, b], graph: sim.graph, time: sim.time };
  const hovered = recorder();
  drawJobLines(hovered, focused);
  assert.equal(count(hovered, 'fillText'), 1);
});

test('drawJobLines: pickup lines are amber and delivery lines blue, in both themes; odd data does not throw', () => {
  const sim = simWithJob();
  const v = sim.vehicles.find((x) => jobTarget(x) !== null && x.visible !== false);
  for (const mode of ['light', 'dark']) {
    const ctx = recorder();
    const strokes = [];
    const fr = { ...frameFor(sim), theme: getTheme(mode) };
    Object.defineProperty(ctx, 'strokeStyle', { set: (c) => strokes.push(c), get: () => '' });
    drawJobLines(ctx, fr);
    const colour = v.state === 'toPickup' ? { light: '#e08600', dark: '#ffb224' } : { light: '#2b6fe0', dark: '#6aa6ff' };
    assert.ok(strokes.includes(colour[mode]), `${mode}: ${v.state} line colour ${colour[mode]} in ${strokes}`);
  }
  // NaN poses, a missing graph, an unknown target and a line off screen
  const bad = recorder();
  const saved = [v.x, v.y, v.visible];
  const fr = frameFor(sim);
  fr.sim = { vehicles: [{ ...v, state: 'toDrop', order: { from: 'zz', to: 'zz' }, x: NaN, y: NaN, tv: null }, { state: 'toPickup', order: { from: 's1' }, x: 5, y: 5, heading: 0 }], graph: null, time: 5 };
  assert.doesNotThrow(() => drawJobLines(bad, fr));
  assert.doesNotThrow(() => drawWaitingBadges(bad, fr));
  assert.equal(v.x, saved[0]);
  const away = recorder();
  const fr2 = frameFor(sim);
  fr2.ox = -50000;
  drawJobLines(away, fr2);
  assert.equal(away.calls.length > 0 ? count(away, 'stroke') : 0, 0, 'a line far off screen is skipped');
});

test('drawWaitingBadges: a badge "n waiting" above every station that has loads nobody collects, red from 80 % of the buffer', () => {
  const sim = new Simulation(waitingPlant(), { seed: 7 });
  sim.advance(250);
  const ctx = recorder();
  const fills = [];
  Object.defineProperty(ctx, 'fillStyle', { set: (c) => fills.push(c), get: () => '' });
  drawWaitingBadges(ctx, frameFor(sim, { zoom: 20 }));
  const texts = ctx.calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
  assert.ok(texts.some((x) => /^\d+ waiting$/.test(x)), `texts: ${texts}`);
  assert.ok(fills.includes('#f5a524') && !fills.includes('#c92a2a'), 'amber while there is room');
  sim.advance(900);
  const red = recorder();
  const fills2 = [];
  Object.defineProperty(red, 'fillStyle', { set: (c) => fills2.push(c), get: () => '' });
  drawWaitingBadges(red, frameFor(sim, { zoom: 20 }));
  assert.ok(fills2.includes('#c92a2a'), 'red when the buffer is full');
  // far out: a round badge with the bare number
  const small = recorder();
  drawWaitingBadges(small, frameFor(sim, { zoom: 6 }));
  assert.ok(small.calls.some((c) => c[0] === 'fillText' && /^\d+$/.test(c[1])), 'only the number');
  assert.ok(small.calls.some((c) => c[0] === 'arc'));
  // off, below the minimum zoom, no runtime
  for (const fr of [frameFor(sim, { overlays: { jobs: false } }), frameFor(sim, { zoom: LINE_MIN_ZOOM - 1 }), { ...frameFor(sim), sim: null }]) {
    const nothing = recorder();
    drawWaitingBadges(nothing, fr);
    assert.equal(nothing.calls.length, 0);
  }
});

test('the jobs overlay is cheap: 100 vehicles with orders and 40 stations draw in well under a millisecond per frame', () => {
  const layout = createLayout({ cols: 80, rows: 60, cellSize: 2 });
  for (let i = 0; i < 40; i++) addStation(layout, { type: i % 3 === 0 ? 'source' : i % 3 === 1 ? 'process' : 'storage', x: 2 + (i % 10) * 7, y: 2 + Math.floor(i / 10) * 12, w: 3, h: 2, name: `S${i}` });
  const scene = getScene(layout);
  const outLinks = [{ queue: Array.from({ length: 6 }, () => ({ readyAt: 0 })), claimed: 1, cap: 6 }];
  const stations = new Map(layout.stations.map((s) => [s.id, { id: s.id, type: s.type, params: { capacity: 40 }, outLinks, yardQ: [] }]));
  const graph = { x: (id) => (id % 80) * 2 + 1, y: (id) => Math.floor(id / 80) * 2 + 1, docks: new Map(layout.stations.map((s, i) => [s.id, [i * 3 + 80, i * 3 + 81]])), stationsAt: new Map() };
  const vehicles = Array.from({ length: 100 }, (_, i) => ({
    id: `v#${i}`, fleetId: 'v', state: i % 2 ? 'toPickup' : 'toDrop', visible: true, x: (i * 3) % 150, y: (i * 7) % 110, heading: 0, prevX: (i * 3) % 150, prevY: (i * 7) % 110, prevHeading: 0,
    order: { from: layout.stations[i % 40].id, to: layout.stations[(i + 7) % 40].id }, tv: null, route: null, fleet: { length: 1.2 },
  }));
  const sim = { layout, vehicles, graph, time: 100, stations: [...stations.values()], logistics: { stationById: stations } };
  const fr = { ...frameFor({ layout, vehicles, graph, time: 100, logistics: { stationById: stations } }, { zoom: 16 }), scene, rtOf: (id) => stations.get(id) };
  fr.sim = sim;
  // a context that does nothing, so that only the overlay's own work is measured; counts strokes
  let strokes = 0;
  const noop = () => {};
  const ctx = {
    font: '', fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1, lineCap: '', lineJoin: '', textAlign: '', textBaseline: '', lineDashOffset: 0,
    measureText: (s) => ({ width: s.length * 6 }),
    stroke() { strokes++; },
    beginPath: noop, moveTo: noop, lineTo: noop, closePath: noop, fill: noop, arc: noop, arcTo: noop, rect: noop, fillText: noop, setLineDash: noop, fillRect: noop,
  };
  for (let i = 0; i < 50; i++) { drawJobLines(ctx, fr); drawWaitingBadges(ctx, fr); }
  // the best of five batches: the test files of `npm test` run side by side, so one batch may be slowed down by a neighbour
  let ms = Infinity;
  let perFrame = 0;
  for (let batch = 0; batch < 5; batch++) {
    strokes = 0;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 100; i++) {
      drawJobLines(ctx, fr);
      drawWaitingBadges(ctx, fr);
    }
    ms = Math.min(ms, Number(process.hrtime.bigint() - t0) / 1e6 / 100);
    perFrame = strokes / 100;
  }
  assert.ok(perFrame > 100, `lines were drawn (${perFrame} strokes per frame)`);
  assert.ok(ms < 1, `${ms.toFixed(3)} ms per frame for 100 vehicles and 40 stations (limit 1 ms)`);
});

// ---------------------------------------------------------------------------------------------------------------------------
// the renderer side: hit testing of the flow handle and drawing of the connect state and the jobs overlay (fake canvas)
// ---------------------------------------------------------------------------------------------------------------------------

class FakeContext {
  constructor() {
    this.record = false;
    this.texts = [];
    this.strokes = 0;
    this.font = '';
    this.fillStyle = '#000';
    for (const name of ['save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arcTo', 'clip', 'strokeRect', 'clearRect', 'strokeText', 'setLineDash', 'bezierCurveTo', 'translate', 'scale', 'drawImage', 'setTransform', 'ellipse', 'fill', 'rect', 'arc', 'fillRect', 'quadraticCurveTo', 'rotate']) {
      this[name] = () => {};
    }
    this.stroke = () => { this.strokes++; };
    this.fillText = (t) => { if (this.record) this.texts.push(String(t)); };
    this.measureText = (t) => ({ width: String(t).length * 6 });
  }
}

class FakeCanvas {
  constructor(w = 0, h = 0) {
    this.width = w;
    this.height = h;
    this.clientWidth = 0;
    this.clientHeight = 0;
    this.ctx = new FakeContext();
  }

  getContext() { return this.ctx; }
  toDataURL() { return 'data:image/png;base64,FAKE'; }
}

async function rendererFor(layout, { zoom = 20, sim = null } = {}) {
  const { Renderer } = await import('../js/ui/renderer.js');
  const canvas = new FakeCanvas();
  canvas.clientWidth = 800;
  canvas.clientHeight = 600;
  const camera = new Camera({ x: 10, y: 8, zoom });
  const renderer = new Renderer(canvas, { camera, theme: 'light', dpr: 1, now: () => 0, createCanvas: (w, h) => new FakeCanvas(w, h) });
  renderer.layout = layout;
  renderer.sim = sim;
  return { renderer, camera, ctx: canvas.ctx };
}

/** Screen points inside a window around station `id` that the renderer reports as hits of `kind`. */
function hitsOf(renderer, camera, layout, id, kind, pad = 60) {
  const cs = layout.grid.cellSize;
  const s = layout.stations.find((e) => e.id === id);
  const [x0, y0] = camera.worldToScreen(s.x * cs, s.y * cs);
  const [x1, y1] = camera.worldToScreen((s.x + s.w) * cs, (s.y + s.h) * cs);
  const found = [];
  for (let y = y0 - pad; y < y1 + pad; y += 2) for (let x = x0 - pad; x < x1 + pad; x += 2) if (renderer.hitTest(x, y).kind === kind) found.push([x, y]);
  return found;
}

test('renderer.hitTest: the flow handle is a hit of kind connect-handle only while the view shows it, and the resize handle of the same edge keeps its zone', async () => {
  const layout = plant();
  const { renderer, camera } = await rendererFor(layout, { zoom: 10 });
  renderer.render(1);
  assert.equal(hitsOf(renderer, camera, layout, 's1', 'connect-handle').length, 0, 'no handle without view.connectHandle');
  renderer.view.selection = { kind: 'station', ids: ['s1'] };
  renderer.view.connectHandle = { id: 's1' };
  const handle = hitsOf(renderer, camera, layout, 's1', 'connect-handle');
  assert.ok(handle.length > 40, `${handle.length} sample points hit the handle`);
  const hit = renderer.hitTest(...handle[0]);
  assert.deepEqual([hit.kind, hit.id], ['connect-handle', 's1']);
  // the handle floats outside the east edge of A (C is to the right): every hit is right of the brick's right edge
  const [rightEdge] = camera.worldToScreen(7 * 2, 0);
  assert.ok(handle.every(([x]) => x > rightEdge), 'outside the east edge');
  // with resize handles on, the east handle in the middle of the edge wins over the connect handle in its zone
  renderer.view.resizeHandles = true;
  const [ex, ey] = [rightEdge, camera.worldToScreen(0, 5 * 2)[1]];
  const onEdge = renderer.hitTest(ex + 3, ey);
  assert.deepEqual([onEdge.kind, onEdge.handle], ['station', 'e'], 'the resize handle keeps its zone');
  const farther = renderer.hitTest(...handle[Math.floor(handle.length / 2)]);
  assert.equal(farther.kind, 'connect-handle');
  // another station, a missing one and a station too small to aim at
  renderer.view.connectHandle = { id: 'gone' };
  assert.equal(hitsOf(renderer, camera, layout, 's1', 'connect-handle').length, 0);
  renderer.view.connectHandle = { id: 's1' };
  camera.zoom = 2;
  assert.equal(hitsOf(renderer, camera, layout, 's1', 'connect-handle', 40).length, 0, 'zoomed far out there is no handle to aim at');
});

test('renderer: drawing the connect state, the rubber band in both directions and the handle never throws, and the labels are drawn', async () => {
  const layout = plant();
  const { renderer, ctx } = await rendererFor(layout, { zoom: 12 });
  const draw = () => { ctx.texts.length = 0; ctx.record = true; renderer.render(1); ctx.record = false; return ctx.texts.slice(); };
  renderer.view.selection = { kind: 'station', ids: ['s1'] };
  renderer.view.connectHandle = { id: 's1', hover: true, pressed: true };
  assert.doesNotThrow(draw);
  const targets = { role: 'from', anchorId: 's1', valid: new Set(['s3']), exists: new Set(['s2']), over: 's3', overStatus: 'valid', snap: 's3', verb: 'Drop' };
  renderer.view.connect = targets;
  renderer.view.flowPreview = { fromId: 's1', toPoint: [55, 10] };
  assert.ok(draw().includes('Drop to connect'), 'the station under the pointer says what happens');
  renderer.view.connect = { ...targets, over: 's2', overStatus: 'exists', snap: 's2' };
  assert.ok(draw().includes('Already connected'));
  renderer.view.connect = { ...targets, over: 's4', overStatus: 'invalid', snap: null };
  assert.ok(draw().includes('Cannot receive loads'));
  renderer.view.connect = { ...targets, role: 'to', anchorId: 's3', over: 's2', overStatus: 'valid', snap: 's2', verb: 'Click' };
  renderer.view.flowPreview = { toId: 's3', fromPoint: [31, 11] };
  assert.ok(draw().includes('Click to connect'));
  // odd input
  for (const connect of [{ role: 'from', anchorId: 'zz', valid: null, over: 'nope' }, { role: 'to', anchorId: 's1', valid: new Set(), exists: null, over: 's1', overStatus: 'valid' }, {}]) {
    renderer.view.connect = connect;
    assert.doesNotThrow(draw);
  }
  for (const flowPreview of [{ fromId: 's1', toPoint: [NaN, 3] }, { toId: 'zz', fromPoint: [1, 1] }, { toId: 's1', fromPoint: [1] }, { fromId: 's1', toPoint: [14, 11], space: 'screen' }, { fromId: 's1', toPoint: [14, 10] }]) {
    renderer.view.flowPreview = flowPreview;
    assert.doesNotThrow(draw);
  }
  // nothing of it is part of an exported picture
  renderer.view.flowPreview = { fromId: 's1', toPoint: [55, 10] };
  renderer.view.connect = targets;
  ctx.texts.length = 0;
  ctx.record = true;
  renderer.toDataURL({ scale: 0.2 });
  ctx.record = false;
  assert.ok(!ctx.texts.includes('Drop to connect'), 'editing aids are left out of exports');
});

test('renderer: the Jobs overlay draws waiting badges and vehicle chips from a running simulation and follows view.overlays.jobs', async () => {
  const layout = plant();
  const rt = (id, type, loads) => ({ id, type, params: { capacity: 20 }, outLinks: [{ queue: Array.from({ length: loads }, () => ({ readyAt: 0 })), claimed: 0, cap: 6 }], yardQ: [], state: 'normal', fill: 0.3, fillLabel: '2/6', outCount: loads, inCount: 0, consumed: 0, arrivals: 0 });
  const stations = new Map([['s1', rt('s1', 'source', 5)], ['s2', rt('s2', 'process', 1)], ['s3', { ...rt('s3', 'sink', 0), outLinks: [] }]]);
  const graph = { x: (id) => (id % 40) * 2 + 1, y: (id) => Math.floor(id / 40) * 2 + 1, docks: new Map([['s2', [9 * 40 + 15]]]), stationsAt: new Map(), edges: [], cols: 40 };
  const vehicle = { id: 'v1#1', fleetId: 'v1', state: 'toPickup', visible: true, x: 20, y: 12, heading: 0, prevX: 20, prevY: 12, prevHeading: 0, order: { from: 's2', to: 's3' }, route: null, tv: { length: 1.2, width: 0.66 }, fleet: { length: 1.2 }, color: '#2d7ff9', load: [], battery: 1 };
  const sim = { time: 100, vehicles: [vehicle], graph, layout, stations: [...stations.values()], logistics: { stationById: stations, stations: [...stations.values()], flows: [] }, traffic: {}, settings: { handedness: 'right' } };
  const { renderer, ctx } = await rendererFor(layout, { zoom: 20, sim });
  renderer.view.overlays = { ...renderer.view.overlays, jobs: true };
  ctx.record = true;
  renderer.render(1);
  ctx.record = false;
  assert.ok(ctx.texts.includes('5 waiting'), `the badge of the source: ${ctx.texts}`);
  assert.ok(ctx.texts.includes('1 waiting'), 'and of the workstation');
  assert.ok(ctx.texts.includes('→ B'), `the chip of the vehicle heading for B: ${ctx.texts}`);
  ctx.texts.length = 0;
  renderer.view.overlays = { ...renderer.view.overlays, jobs: false };
  ctx.record = true;
  renderer.render(1);
  ctx.record = false;
  assert.ok(!ctx.texts.some((t) => /waiting$/.test(t) || t.startsWith('→ ')), 'switched off: neither badges nor chips');
  // default view: the overlay is on
  const { createView } = await import('../js/ui/renderer.js');
  assert.equal(createView().overlays.jobs, true);
  assert.equal(createView().connectHandle, null);
  assert.equal(createView().connect, null);
  // a missing overlays object and a sim without a graph are tolerated
  renderer.view.overlays = undefined;
  assert.doesNotThrow(() => renderer.render(1));
  renderer.view.overlays = { jobs: true };
  renderer.sim = { ...sim, graph: undefined };
  assert.doesNotThrow(() => renderer.render(0.5));
});
