// The Statistics dock (js/ui/panels/stats-dock.js, docs/ENTITY-INSIGHTS-DESIGN.md 2.1 and 9.1: S1.6 to S1.8, S1.14 dock part, S1.15 UI part).
//   1. the pure rules: which selections have a dock, "has data", the open decision, names, cycling with [ and ], the remembered state (with a storage
//      that is missing, full or throws), heights and the phone's snap points;
//   2. the click rule on the real Editor: a clean click opens the dock AFTER the editor handled the same pointerup; a drag, a resize, a marquee,
//      a second finger, another tool or a press the editor did not take never does;
//   3. the dock element in a fake DOM: states, the grip, the window switch, the routes switch, closing, the keyboard, the region label and "no aria-live
//      inside the dock", the placeholder while the model builder's files are missing, the fall back from a vehicle to its fleet.
// The real browser (pointer events in Chromium, camera, layout, the phone sheet) is driven by tests/e2e/stats-dock.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/store/store.js';
import { createLayout, addStation, addFlow, addFleet, updateFleet, paintRoadPath } from '../js/model/layout.js';
import { Editor } from '../js/ui/editor.js';
import { Camera } from '../js/ui/camera.js';
import { pointInRect } from '../js/ui/render/geometry.js';
import {
  DOCK_KINDS, NO_DOCK_KINDS, NO_STATS_TEXT, OPEN_MAX_SHARE, OPEN_MIN_PX, OPEN_DEFAULT_PX, COMPACT_SLACK_PX, SNAP_PEEK_PX, MIN_MEASURED_SECONDS, DOCK_MEMORY_KEY,
  dockKind, selectionKey, hasStatisticsData, openDecision, identityOf, pressPlayText, roughly, waitText, fastClickText, FAST_CLICK_SPEED, refsOf, cycleSelection, cleanDockMemory, readDockMemory, writeDockMemory,
  nextDockMemory, openHeight, nextSnap, snapHeight, nearestSnap, watchClicks, createStatsDock,
} from '../js/ui/panels/stats-dock.js';
import { focusRect, minimalPan } from '../js/ui/app.js';
import { installFakeDom } from './helpers/version-review-gen.js';

// ---- a plant -----------------------------------------------------------------------------------------------------

function plant() {
  const layout = createLayout({ cols: 40, rows: 24, cellSize: 2 });
  addStation(layout, { type: 'source', x: 2, y: 2, name: 'Goods in' });
  addStation(layout, { type: 'process', x: 12, y: 2, name: 'Press line' });
  addStation(layout, { type: 'sink', x: 22, y: 2, name: 'Goods out' });
  addFlow(layout, 's1', 's2');
  addFlow(layout, 's2', 's3');
  const agv = addFleet(layout, 'agv');
  updateFleet(layout, agv.id, { name: 'AGVs', count: 3 });
  const lift = addFleet(layout, 'forklift');
  updateFleet(layout, lift.id, { name: 'Forklifts', count: 2 });
  paintRoadPath(layout, [[3, 6], [4, 6], [5, 6], [6, 6], [7, 6]]);
  return layout;
}

const measured = (seconds, over = {}) => ({ window: { start: 600, end: 600 + seconds, duration: seconds, warmingUp: false, ...over } });

// ---- 1. the pure rules -----------------------------------------------------------------------------------------------

test('only stations, flows, fleets, vehicles and road cells have a dock; walls and labels have none', () => {
  for (const kind of DOCK_KINDS) assert.equal(dockKind({ kind, ids: ['x'] }), kind);
  for (const kind of NO_DOCK_KINDS) assert.equal(dockKind({ kind, ids: ['x'] }), null, `${kind}: no dock`);
  assert.equal(dockKind({ kind: null, ids: [] }), null);
  assert.equal(dockKind({ kind: 'station', ids: [] }), null, 'a kind without ids is nothing');
  assert.equal(dockKind(null), null);
  assert.deepEqual([...DOCK_KINDS].sort(), ['cell', 'fleet', 'flow', 'station', 'vehicle']);
  assert.notEqual(selectionKey({ kind: 'station', ids: ['a', 'b'] }), selectionKey({ kind: 'station', ids: ['a'] }));
  assert.equal(selectionKey({ kind: null, ids: [] }), '');
});

test('"the simulation has data" means 30 measured seconds after the warm-up, never before', () => {
  assert.equal(MIN_MEASURED_SECONDS, 30);
  assert.equal(hasStatisticsData(measured(30)), true);
  assert.equal(hasStatisticsData(measured(29.99)), false);
  assert.equal(hasStatisticsData(measured(5000, { warmingUp: true })), false, 'a run that is still warming up has measured nothing');
  assert.equal(hasStatisticsData(measured(NaN)), false);
  assert.equal(hasStatisticsData(measured(Infinity)), false, 'an infinite window is a bug, not data');
  assert.equal(hasStatisticsData({}), false);
  assert.equal(hasStatisticsData(null), false);
  assert.equal(hasStatisticsData(undefined), false);
});

test('clicks and focus() obey the preference; I, [, ] and the Fleet tab always open the dock', () => {
  const data = measured(60);
  const none = measured(0);
  for (const trigger of ['click', 'focus']) {
    assert.deepEqual(openDecision({ trigger, pref: 'data', report: data }), { open: true });
    assert.deepEqual(openDecision({ trigger, pref: 'data', report: none }), { open: false, reason: 'nodata' });
    assert.deepEqual(openDecision({ trigger, pref: 'data', report: null }), { open: false, reason: 'nodata' });
    assert.deepEqual(openDecision({ trigger, pref: 'always', report: null }), { open: true });
    assert.deepEqual(openDecision({ trigger, pref: 'never', report: data }), { open: false, reason: 'never' });
  }
  for (const trigger of ['key', 'list', 'cycle']) {
    for (const pref of ['data', 'always', 'never']) assert.equal(openDecision({ trigger, pref, report: null }).open, true, `${trigger} with "${pref}"`);
  }
});

test('names for the header and the status line: items, flows, fleets, vehicles, road cells and several', () => {
  const layout = plant();
  assert.deepEqual(identityOf({ kind: 'station', ids: ['s2'] }, layout), { title: 'Press line', kindLabel: 'Workstation', icon: 'process', tone: 'process', crumb: null });
  assert.equal(identityOf({ kind: 'station', ids: ['s1'] }, layout).kindLabel, 'Goods in');
  assert.equal(identityOf({ kind: 'flow', ids: ['f1'] }, layout).title, 'Goods in → Press line');
  assert.equal(identityOf({ kind: 'fleet', ids: ['v2'] }, layout).icon, 'forklift');
  const vehicle = identityOf({ kind: 'vehicle', ids: ['v1#2'] }, layout);
  assert.equal(vehicle.title, 'AGVs 2');
  assert.deepEqual(vehicle.crumb, { prefix: 'in', text: 'AGVs', title: '3 vehicles: show the fleet', select: { kind: 'fleet', ids: ['v1'] } }, 'the fleet is one click away');
  assert.equal(identityOf({ kind: 'vehicle', ids: ['v1#1'] }, layout, { vehicles: [{ id: 'v1#1', name: 'AGV one' }] }).title, 'AGV one', 'the simulation’s own name wins');
  assert.equal(identityOf({ kind: 'cell', ids: ['3,6'] }, layout).title, 'Road cell 3, 6');
  assert.equal(identityOf({ kind: 'station', ids: ['s1', 's2', 's3'] }, layout).title, '3 stations');
  assert.equal(identityOf({ kind: 'vehicle', ids: ['v1#1', 'v1#2'] }, layout).title, '2 vehicles');
  assert.equal(identityOf({ kind: 'cell', ids: ['3,6', '4,6'] }, layout).title, '2 road cells');
  assert.equal(identityOf({ kind: null, ids: [] }, layout).title, '');
  assert.equal(identityOf({ kind: 'station', ids: ['gone'] }, layout).title, 'gone', 'an id that no longer exists still reads as something');
  assert.equal(pressPlayText({ kind: 'vehicle', ids: ['v1#1'] }, layout), 'Press play to see statistics for AGVs 1.');
  assert.equal(pressPlayText({ kind: 'cell', ids: ['3,6', '4,6'] }, layout), 'Press play to see statistics for these road cells.');
  assert.equal(NO_STATS_TEXT, 'Walls and labels have no statistics.');
});

test('refsOf names what to bring into view; app.js focusRect understands vehicles', () => {
  assert.deepEqual(refsOf({ kind: 'station', ids: ['s1'] }), { stationIds: ['s1'] });
  assert.deepEqual(refsOf({ kind: 'vehicle', ids: ['v1#1'] }), { vehicleIds: ['v1#1'] });
  assert.deepEqual(refsOf({ kind: 'cell', ids: ['3,6', '4,7'] }), { cells: [[3, 6], [4, 7]] });
  assert.deepEqual(refsOf({ kind: null, ids: [] }), {});
});

test('focusRect brings a single vehicle into view: the cell it is on, nothing while it is off the road', () => {
  const layout = plant();
  const vehicles = [{ id: 'v1#2', x: 21, y: 13, visible: true }, { id: 'v1#3', x: 5, y: 5, visible: false }, { id: 'v1#1', x: NaN, y: 3, visible: true }];
  assert.deepEqual(focusRect(layout, { vehicleIds: ['v1#2'] }, vehicles), { x: 20, y: 12, w: 2, h: 2 }, 'one cell (2 m) around its position');
  assert.equal(focusRect(layout, { vehicleIds: ['v1#3'] }, vehicles), null, 'hidden (parked): nothing to show');
  assert.equal(focusRect(layout, { vehicleIds: ['v1#1'] }, vehicles), null, 'no usable position');
  assert.equal(focusRect(layout, { vehicleIds: ['v9#1'] }, vehicles), null, 'unknown');
  assert.deepEqual(focusRect(layout, { vehicleIds: ['v1#2'], stationIds: ['s1'] }, vehicles), { x: 4, y: 4, w: 18, h: 10 }, 'with other things: the union');
});

test('minimalPan: nothing when the box is inside, the nearest edge when it sticks out; a box too big for the area stays while part of it shows, else it is centred', () => {
  const free = { left: 24, top: 88, right: 1000, bottom: 700 };
  const inside = { x0: 100, y0: 200, x1: 300, y1: 400 };
  assert.deepEqual(minimalPan(inside, free), { dx: 0, dy: 0 });
  assert.deepEqual(minimalPan({ ...inside, y0: 650, y1: 750 }, free), { dx: 0, dy: -50 }, 'under the dock: up by the least');
  assert.deepEqual(minimalPan({ ...inside, y0: 40, y1: 120 }, free), { dx: 0, dy: 48 }, 'under the top bars: down');
  assert.deepEqual(minimalPan({ x0: -30, y0: 200, x1: 60, y1: 300 }, free), { dx: 54, dy: 0 }, 'left');
  assert.deepEqual(minimalPan({ x0: 950, y0: 200, x1: 1050, y1: 300 }, free), { dx: -50, dy: 0 }, 'right');
  assert.deepEqual(minimalPan({ x0: 0, y0: 0, x1: 2000, y1: 1400 }, free), { dx: 0, dy: 0 }, 'bigger than the free area and partly in it: no jump (a click on a big station while zoomed in)');
  assert.deepEqual(minimalPan({ x0: -400, y0: 200, x1: 2000, y1: 1400 }, free), { dx: 0, dy: 0 }, 'part of it shows along both axes');
  assert.deepEqual(minimalPan({ x0: 1100, y0: 100, x1: 3200, y1: 300 }, free), { dx: (24 + 1000) / 2 - (1100 + 3200) / 2, dy: 0 }, 'bigger than the free width and wholly to its right: centred along that axis, not pushed to an edge');
  assert.deepEqual(minimalPan({ x0: 100, y0: 800, x1: 300, y1: 2400 }, free), { dx: 0, dy: (88 + 700) / 2 - (800 + 2400) / 2 }, 'the same below the free height');
  assert.deepEqual(minimalPan({ x0: 24, y0: 88, x1: 1000, y1: 700 }, free), { dx: 0, dy: 0 }, 'exactly the free area');
});

test('[ and ] cycle through the items of the kind, wrap around and start at the end when nothing matches', () => {
  const layout = plant();
  const next = (kind, id, dir) => cycleSelection(layout, { kind, ids: [id] }, dir);
  assert.deepEqual(next('station', 's1', 1), { kind: 'station', ids: ['s2'] });
  assert.deepEqual(next('station', 's3', 1), { kind: 'station', ids: ['s1'] }, 'wraps forwards');
  assert.deepEqual(next('station', 's1', -1), { kind: 'station', ids: ['s3'] }, 'wraps backwards');
  assert.deepEqual(next('flow', 'f1', 1), { kind: 'flow', ids: ['f2'] });
  assert.deepEqual(next('fleet', 'v1', 1), { kind: 'fleet', ids: ['v2'] });
  assert.deepEqual(next('vehicle', 'v1#3', 1), { kind: 'vehicle', ids: ['v2#1'] }, 'vehicles go fleet by fleet');
  assert.deepEqual(next('vehicle', 'v2#2', 1), { kind: 'vehicle', ids: ['v1#1'] });
  assert.deepEqual(next('vehicle', 'v1#1', -1), { kind: 'vehicle', ids: ['v2#2'] });
  assert.deepEqual(next('cell', '3,6', 1), { kind: 'cell', ids: ['4,6'] }, 'road cells by row, then column');
  assert.deepEqual(next('cell', '7,6', 1), { kind: 'cell', ids: ['3,6'] });
  assert.deepEqual(next('station', 'gone', 1), { kind: 'station', ids: ['s1'] }, 'an id that is gone: the first');
  assert.deepEqual(next('station', 'gone', -1), { kind: 'station', ids: ['s3'] }, 'and backwards the last');
  assert.equal(cycleSelection(layout, { kind: 'obstacle', ids: ['o1'] }, 1), null, 'walls have no dock to cycle');
  assert.equal(cycleSelection(layout, { kind: null, ids: [] }, 1), null);
  assert.equal(cycleSelection(createLayout(), { kind: 'station', ids: ['s1'] }, 1), null, 'nothing to cycle in an empty plant');
  assert.deepEqual(cycleSelection(layout, { kind: 'station', ids: ['s2', 's3'] }, 1), { kind: 'station', ids: ['s3'] }, 'from the first selected item');
});

test('the remembered state is validated; a missing, full, blocked or corrupt storage gives the defaults and never throws', () => {
  const defaults = { state: 'compact', height: null, snap: 'peek' };
  assert.deepEqual(cleanDockMemory(null), defaults, 'compact the first time');
  assert.deepEqual(cleanDockMemory('open'), defaults);
  assert.deepEqual(cleanDockMemory({ state: 'open', height: 333.4, snap: 'full' }), { state: 'open', height: 333, snap: 'full' });
  assert.deepEqual(cleanDockMemory({ state: 'sideways', height: 5, snap: 'half-way' }), defaults, 'junk and a height below the smallest open one');
  assert.equal(cleanDockMemory({ height: Infinity }).height, null);
  assert.equal(cleanDockMemory({ height: 1e9 }).height, null);
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); } };
  assert.equal(writeDockMemory(storage, { state: 'open', height: 300, snap: 'half' }), true);
  assert.equal(DOCK_MEMORY_KEY, 'logiplan:stats-dock');
  assert.deepEqual(readDockMemory(storage), { state: 'open', height: 300, snap: 'half' });
  store.set(DOCK_MEMORY_KEY, '{not json');
  assert.deepEqual(readDockMemory(storage), defaults, 'corrupt text');
  const blocked = { getItem() { throw new DOMException('denied', 'SecurityError'); }, setItem() { throw new DOMException('full', 'QuotaExceededError'); } };
  assert.deepEqual(readDockMemory(blocked), defaults, 'a storage that throws on read');
  assert.equal(writeDockMemory(blocked, { state: 'open' }), false, 'a storage that throws on write');
  assert.deepEqual(readDockMemory(undefined), defaults, 'no storage at all');
  assert.equal(writeDockMemory(null, {}), false);
});

test('expand, minimise and the grip: compact below the compact height plus a slack, else open within [200 px, 44 vh]', () => {
  const m = { state: 'compact', height: null, snap: 'peek' };
  assert.equal(nextDockMemory(m, { type: 'expand' }).state, 'open');
  assert.equal(nextDockMemory({ ...m, state: 'open' }, { type: 'minimise' }).state, 'compact');
  assert.equal(nextDockMemory(m, { type: 'toggle' }).state, 'open');
  assert.equal(nextDockMemory({ ...m, state: 'open' }, { type: 'toggle' }).state, 'compact');
  const drag = (height) => nextDockMemory({ ...m, state: 'open', height: 400 }, { type: 'resize', height, compact: 150, max: 396 });
  assert.equal(drag(150 + COMPACT_SLACK_PX - 1).state, 'compact', 'just below the slack: compact');
  assert.deepEqual([drag(150 + COMPACT_SLACK_PX).state, drag(150 + COMPACT_SLACK_PX).height], ['open', OPEN_MIN_PX], 'at the slack it is open, but never lower than the smallest open height');
  assert.equal(drag(300).height, 300);
  assert.equal(drag(9999).height, 396, 'never above the maximum (44 vh)');
  assert.equal(drag(NaN).height, 400, 'a junk height changes nothing');
  assert.equal(nextDockMemory(m, { type: 'snap', snap: 'half' }).snap, 'half');
  assert.equal(nextDockMemory(m, { type: 'snap', snap: 'tiny' }), m, 'an unknown snap point changes nothing');
  assert.equal(nextDockMemory(m, { type: 'nonsense' }), m);
  assert.equal(OPEN_MAX_SHARE, 0.44);
  assert.equal(OPEN_DEFAULT_PX, 360);
  assert.equal(openHeight({ height: null }, 900), 396, 'the first time an open dock is as high as it may be (44 vh): as much of the body as possible is on the screen');
  assert.equal(openHeight({ height: null }, 1200), 528);
  assert.equal(openHeight({ height: 500 }, 900), 396, '44 vh of a 900 px screen');
  assert.equal(openHeight({ height: 500 }, 1200), 500);
  assert.equal(openHeight({ height: null }, 300), OPEN_MIN_PX, 'on a short screen the smallest open height wins over 44 vh');
});

test('the phone sheet has three snap points that a tap, an arrow key and a swipe move between', () => {
  assert.deepEqual([nextSnap('peek'), nextSnap('half'), nextSnap('full')], ['half', 'full', 'peek'], 'a tap on the grip: the next one, then round');
  assert.equal(nextSnap('full', 1, false), 'full', 'an arrow key stops at the top');
  assert.equal(nextSnap('peek', -1, false), 'peek', 'and at the bottom');
  assert.equal(nextSnap('half', -1, false), 'peek');
  assert.equal(nextSnap('???'), 'half', 'unknown counts as the first');
  assert.deepEqual([snapHeight('peek', 800), snapHeight('half', 800), snapHeight('full', 800)], [SNAP_PEEK_PX, 432, 688]);
  assert.equal(nearestSnap(100, 800), 'peek');
  assert.equal(nearestSnap(440, 800), 'half');
  assert.equal(nearestSnap(700, 800), 'full');
  assert.equal(nearestSnap(300, 800), 'half', 'the middle goes to the nearer one');
});

// ---- 2. the click rule on the real editor ----------------------------------------------------------------------------

/** A real Editor on a fake canvas, plus a stand-in for the stage around it (events that bubble are replayed on it after the canvas listeners, like the browser does). */
function editorHarness({ tool = 'select' } = {}) {
  const frames = [];
  const win = Object.assign(new EventTarget(), { requestAnimationFrame: (fn) => frames.push(fn), innerWidth: 1200, innerHeight: 800 });
  const doc = { defaultView: win, querySelector: () => null };
  const canvas = Object.assign(new EventTarget(), {
    ownerDocument: doc, style: {}, getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 480 }),
    setPointerCapture() {}, releasePointerCapture() {}, hasPointerCapture: () => false,
  });
  const layout = plant();
  const store = createStore({ storage: undefined });
  store.newProject(layout);
  const camera = new Camera({ x: 40, y: 24, zoom: 10, width: 800, height: 480 });
  const renderer = {
    layout: null, sim: null, redraws: 0,
    view: { selection: { kind: null, ids: [] }, hover: null, tool: 'select', overlays: {}, ghost: null, paintPreview: null, flowPreview: null, marquee: null, resizeHandles: false },
    render() {},
    hitTest(px, py) {
      const l = this.layout;
      const cs = l.grid.cellSize;
      const [wx, wy] = camera.worldToScreen(px, py).length ? camera.screenToWorld(px, py) : [0, 0];
      const cell = [Math.floor(wx / cs), Math.floor(wy / cs)];
      if (this.vehicleAt && Math.abs(wx / cs - this.vehicleAt[0]) < 1 && Math.abs(wy / cs - this.vehicleAt[1]) < 1) return { kind: 'vehicle', id: 'v1#2', cell };
      const station = l.stations.find((s) => pointInRect(wx / cs, wy / cs, s));
      return station ? { kind: 'station', id: station.id, cell } : { kind: 'cell', cell };
    },
  };
  renderer.layout = store.getState().layout;
  const editor = new Editor({ canvas, store, camera, renderer, ctx: { toast() {}, setStatus() {}, actions: { fitView() {} } } });
  if (tool !== 'select') editor.setTool(tool);
  const px = (cx, cy) => {
    const cs = store.getState().layout.grid.cellSize;
    const [sx, sy] = camera.worldToScreen((cx + 0.5) * cs, (cy + 0.5) * cs);
    return { clientX: 100 + sx, clientY: 50 + sy };
  };
  const stageListeners = new Map();
  const stage = {
    addEventListener(type, fn) { stageListeners.set(type, [...(stageListeners.get(type) || []), fn]); },
    removeEventListener(type, fn) { stageListeners.set(type, (stageListeners.get(type) || []).filter((f) => f !== fn)); },
  };
  const send = (type, cell, props = {}) => {
    const e = Object.assign(new Event(type, { cancelable: true, bubbles: true }), { pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }, cell ? px(...cell) : {}, props);
    canvas.dispatchEvent(e);
    if (e.bubbles && type !== 'pointermove' && type !== 'pointercancel') {
      for (const fn of stageListeners.get(type) || []) fn(e); // the stage hears it after the canvas
      if (stageHook) stageHook.fire(type, e); // a stage built elsewhere (the fake DOM element the dock lives in); one listener per type: runs at once
    }
    return e;
  };
  let stageHook = null;
  const mouse = {
    down: (cell, props) => send('pointerdown', cell, props),
    move: (cell, props) => send('pointermove', cell, props),
    up: (cell, props) => send('pointerup', cell, props),
    click(cell, props) { this.down(cell, props); this.up(cell, props); },
  };
  return { editor, store, canvas, stage, camera, renderer, mouse, send, win, hookStage(target) { stageHook = target; } };
}

function clickWatcher(h) {
  const log = [];
  const watcher = watchClicks({
    canvas: h.canvas, upTarget: h.stage, editor: h.editor,
    onClick: (info) => log.push(['click', h.store.getState().ui.selection.kind, info.pointerType]), onDrag: () => log.push(['drag']), onEnd: () => log.push(['end']),
  });
  return { log, watcher };
}

test('a clean click on a station is reported after the editor has selected it and finished the gesture', () => {
  const h = editorHarness();
  const seen = [];
  const { log } = clickWatcher(h);
  h.canvas.addEventListener('pointerup', () => seen.push(['canvas listener ran', h.editor.active !== null]));
  h.mouse.click([3, 3]); // inside Goods in (s1: x 2..4, y 2..4)
  assert.deepEqual(log, [['end'], ['click', 'station', 'mouse']]);
  assert.equal(h.editor.active, null, 'the editor is done with the gesture when the dock hears the click');
  assert.deepEqual(h.store.getState().ui.selection, { kind: 'station', ids: ['s1'] });
  assert.equal(h.editor.currentTool.busy(), false, 'the tool is no longer busy');
});

test('pressing an unselected station selects it on pointerdown, but the dock hears nothing until the click ends (and never for a drag)', () => {
  const h = editorHarness();
  const { log } = clickWatcher(h);
  h.mouse.down([3, 3]);
  assert.deepEqual(h.store.getState().ui.selection, { kind: 'station', ids: ['s1'] }, 'the press selected it (select.js armMove)');
  assert.deepEqual(log, [], 'no click yet: the gesture is still going');
  assert.notEqual(h.editor.active, null);
  h.mouse.move([6, 3]); // five cells: a drag
  h.mouse.up([8, 3]);
  assert.deepEqual(log, [['drag'], ['end']], 'a drag: never a click');
});

test('a resize and a marquee are drags too; a press that hardly moved is still a click', () => {
  const h = editorHarness();
  const { log } = clickWatcher(h);
  h.mouse.down([30, 15]); // empty ground: a marquee begins
  h.mouse.move([34, 20]);
  h.mouse.up([34, 20]);
  assert.deepEqual(log, [['drag'], ['end']]);
  log.length = 0;
  h.mouse.down([3, 3], { clientX: 300, clientY: 200 });
  h.mouse.move(null, { clientX: 302, clientY: 201 }); // 2.2 px: below the drag threshold of a mouse (4 px)
  h.mouse.up(null, { clientX: 302, clientY: 201 });
  assert.equal(log.at(-1)[0], 'click', 'a wobble of the hand is a click');
  log.length = 0;
  h.mouse.down(null, { clientX: 300, clientY: 200, pointerType: 'touch' });
  h.mouse.move(null, { clientX: 307, clientY: 200, pointerType: 'touch' }); // 7 px: a finger may wobble up to 10 px
  h.mouse.up(null, { clientX: 307, clientY: 200, pointerType: 'touch' });
  assert.deepEqual(log.at(-1), ['click', log.at(-1)[1], 'touch'], 'a touch has the larger threshold');
});

test('a second finger, another tool, Space or the middle button, and a press the editor did not take are never clicks', () => {
  let h = editorHarness();
  let { log } = clickWatcher(h);
  h.mouse.down([3, 3], { pointerId: 1, pointerType: 'touch' });
  h.send('pointerdown', [4, 4], { pointerId: 2, pointerType: 'touch' }); // the second finger: a pinch
  h.mouse.up([3, 3], { pointerId: 1, pointerType: 'touch' });
  assert.equal(log.some((e) => e[0] === 'click'), false, 'pinch');

  h = editorHarness({ tool: 'road' });
  ({ log } = clickWatcher(h));
  h.mouse.click([3, 3]);
  assert.equal(log.some((e) => e[0] === 'click'), false, 'the road tool draws, it does not select');

  h = editorHarness();
  ({ log } = clickWatcher(h));
  h.editor.space = true; // Space held: a drag pans
  h.mouse.click([3, 3]);
  assert.equal(log.some((e) => e[0] === 'click'), false, 'a pan');
  h.editor.space = false;
  h.mouse.down([3, 3], { button: 1 });
  h.mouse.up([3, 3], { button: 1 });
  assert.equal(log.some((e) => e[0] === 'click'), false, 'the middle button');

  h = editorHarness();
  ({ log } = clickWatcher(h));
  h.editor.pressChip = () => true; // an edge chip of the plan: the editor takes no gesture
  h.mouse.click([3, 3]);
  assert.equal(h.editor.active, null);
  assert.equal(log.some((e) => e[0] === 'click'), false, 'a press the editor did not take');
});

test('the click that ends a connection in connect mode makes a flow, it is not a click on an item', () => {
  const h = editorHarness();
  const { log } = clickWatcher(h);
  h.mouse.click([3, 3]); // select Goods in
  assert.equal(log.filter((e) => e[0] === 'click').length, 1, 'a normal click');
  log.length = 0;
  h.editor.startConnect({ fromId: 's1' });
  assert.ok(h.editor.connector.mode, 'connect mode is on');
  const flows = h.store.getState().layout.flows.length;
  h.mouse.click([23, 3]); // Goods out receives (Goods in -> Press line and Press line -> Goods out exist already)
  assert.equal(h.store.getState().layout.flows.length, flows + 1, 'the click made a flow');
  assert.equal(log.some((e) => e[0] === 'click'), false, 'and was no request for statistics');
  log.length = 0;
  h.mouse.click([13, 3]); // the next click is an ordinary one again
  assert.equal(log.filter((e) => e[0] === 'click').length, 1);
});

test('a cancelled gesture is not a click, and a destroyed watcher hears nothing', () => {
  const h = editorHarness();
  const { log, watcher } = clickWatcher(h);
  h.mouse.down([3, 3]);
  h.send('pointercancel', [3, 3]);
  h.mouse.up([3, 3]);
  assert.equal(log.some((e) => e[0] === 'click'), false);
  assert.equal(watcher.gesture(), null);
  watcher.destroy();
  log.length = 0;
  h.mouse.click([3, 3]);
  assert.deepEqual(log, []);
});

// ---- 3. the dock in a fake DOM ---------------------------------------------------------------------------------------

const dom = installFakeDom();
after(() => dom.restore());

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (k) => (data.has(k) ? data.get(k) : null), setItem(k, v) { if (this.fail) throw new DOMException('full', 'QuotaExceededError'); data.set(k, String(v)); }, fail: false };
}

/** The dock on the real store and the real editor harness, with a fake runner and an injected model and view. */
function dockHarness({ report = measured(120), storage = memoryStorage(), loadContent, withEditor = true, narrow = false } = {}) {
  const eh = withEditor ? editorHarness() : null;
  const store = eh ? eh.store : (() => { const s = createStore({ storage: undefined }); s.newProject(plant()); return s; })();
  const stage = dom.document.createElement('div');
  const statuses = [];
  const toasts = [];
  const handlers = new Map();
  const runner = { sim: { vehicles: [], time: 0 }, kpis: () => report, insights: () => [], detail: () => null, on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); } };
  const renderer = { view: {} };
  const queue = [];
  const win = { listeners: new Map(), innerHeight: 900, addEventListener(t, f) { this.listeners.set(t, [...(this.listeners.get(t) || []), f]); }, removeEventListener(t, f) { this.listeners.set(t, (this.listeners.get(t) || []).filter((g) => g !== f)); } };
  const calls = { model: [], view: [], reveal: [], show: [] };
  const content = loadContent === undefined ? async () => ({
    buildStatsModel: (input) => { calls.model.push(input); return { signature: `${input.selection.kind}:${input.selection.ids.join()}`, header: { live: { tone: 'driving', strong: 'Carrying 1 load', rest: 'to Press line' } }, announce: 'AGVs 2 selected: busy 78 %.' }; },
    createStatsView: (host) => {
      const el = dom.document.createElement('div');
      const view = { el, updates: [], host, escapes: 0, update(model, info) { this.updates.push([model, info]); }, destroy() { this.destroyed = true; }, escape() { this.escapes += 1; return this.pinned === true; } };
      calls.view.push(view);
      return view;
    },
  }) : loadContent;
  const dock = createStatsDock({ store, runner, toast: (m) => toasts.push(m), setStatus: (t) => statuses.push(t), renderer }, {
    stage, editor: eh ? eh.editor : undefined, storage, loadContent: content, win, raf: (fn) => queue.push(fn),
    matchMedia: () => ({ matches: narrow, addEventListener() {}, removeEventListener() {} }),
    cameraControl: { revealMinimal: (rect) => { calls.reveal.push(rect); return true; }, showRect: (rect) => calls.show.push(rect) },
    rectOf: (selection) => ({ x: 1, y: 2, w: 3, h: 4, of: selection.kind }),
  });
  if (eh) eh.hookStage(stage);
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); while (queue.length) queue.shift()(); };
  const key = (k, props = {}) => { const e = { key: k, target: { tagName: 'DIV' }, defaultPrevented: false, repeat: false, preventDefault() { this.defaultPrevented = true; }, ...props }; for (const f of win.listeners.get('keydown') || []) f(e); return e; };
  return { dock, store, stage, statuses, toasts, handlers, runner, renderer, calls, flush, key, eh, storage, queue, win };
}

const el = (h) => h.dock.el;
const buttonByLabel = (h, label) => dom.elements(el(h)).find((e) => e.localName === 'button' && e.getAttribute('aria-label') === label);
const live = (root) => dom.elements(root).filter((e) => e.hasAttribute('aria-live') || e.getAttribute('role') === 'status' || e.getAttribute('role') === 'alert' || e.getAttribute('role') === 'log');

test('the dock is closed until it is asked for; the first open is compact; the region is labelled with the item', async () => {
  const h = dockHarness({ withEditor: false });
  assert.equal(el(h).hidden, true);
  assert.equal(h.dock.isOpen(), false);
  assert.equal(h.dock.covered(), 0);
  h.store.select('station', ['s2']);
  assert.equal(el(h).hidden, true, 'selecting is not asking: only a click, I, [ ], focus() or the Fleet tab open it');
  assert.equal(h.dock.open(), true);
  assert.equal(el(h).hidden, false);
  assert.equal(el(h).getAttribute('role'), 'region');
  assert.equal(el(h).getAttribute('aria-label'), 'Statistics for Press line');
  assert.equal(el(h).dataset.state, 'compact', 'compact the first time');
  assert.equal(el(h).dataset.kind, 'station');
  assert.equal(h.stage.dataset['dock'], 'compact');
  await h.flush();
  assert.equal(h.calls.view.length, 1, 'the view is built from the loaded model');
  assert.equal(h.calls.model[0].selection.kind, 'station');
  assert.equal(h.calls.model[0].window, 'start');
  assert.equal(h.calls.model[0].state, 'compact');
  assert.equal(h.calls.model[0].routes, true);
  assert.equal(h.renderer.view.stats.open, true, 'the overlay is told: drawn in every state but closed');
  h.dock.destroy();
});

test('S1.14: no aria-live anywhere inside the dock; the one polite announcement is a status NEXT TO it', async () => {
  const h = dockHarness({ withEditor: false });
  h.store.select('vehicle', ['v1#2']);
  h.dock.open();
  await h.flush();
  assert.deepEqual(live(el(h)).map((e) => e.localName), [], 'nothing live, no status or alert role inside the dock subtree');
  const announcer = h.stage.querySelector('[data-role="stats-announce"]');
  assert.ok(announcer, 'the announcer exists');
  assert.equal(announcer.getAttribute('aria-live'), 'polite');
  assert.equal(el(h).contains?.(announcer) ?? false, false);
  assert.equal(dom.all(el(h)).includes(announcer), false, 'it is a sibling, not a descendant');
  assert.equal(announcer.textContent, 'AGVs 2 selected: busy 78 %.', 'the model’s sentence');
  h.store.select('vehicle', ['v1#3']);
  await h.flush();
  assert.equal(announcer.textContent, 'AGVs 2 selected: busy 78 %.');
  h.dock.destroy();
});

test('state: details and minimise, the remembered state and height, and X closes it until the next click', async () => {
  const storage = memoryStorage();
  const h = dockHarness({ storage, withEditor: false });
  h.store.select('fleet', ['v1']);
  h.dock.open();
  assert.equal(buttonByLabel(h, 'Show details').hidden, false, 'compact offers the details');
  assert.equal(buttonByLabel(h, 'Minimise statistics').hidden, true);
  buttonByLabel(h, 'Show details').fire('click');
  assert.equal(el(h).dataset.state, 'open');
  assert.equal(buttonByLabel(h, 'Show details').getAttribute('aria-expanded'), 'true', 'hidden while open, and says it is expanded');
  assert.equal(buttonByLabel(h, 'Minimise statistics').hidden, false);
  assert.equal(JSON.parse(storage.data.get(DOCK_MEMORY_KEY)).state, 'open', 'remembered');
  buttonByLabel(h, 'Minimise statistics').fire('click');
  assert.equal(el(h).dataset.state, 'compact');
  buttonByLabel(h, 'Show details').fire('click');
  buttonByLabel(h, 'Close statistics').fire('click');
  assert.equal(el(h).hidden, true, 'X closes it');
  assert.deepEqual(h.store.getState().ui.selection, { kind: 'fleet', ids: ['v1'] }, 'the selection stays');
  h.store.select('fleet', ['v2']);
  await h.flush();
  assert.equal(el(h).hidden, true, 'selecting something else does not bring it back: only the next click does');
  h.dock.destroy();
  const again = dockHarness({ storage, withEditor: false });
  again.store.select('fleet', ['v1']);
  again.dock.open();
  assert.equal(el(again).dataset.state, 'open', 'a new session remembers it');
  again.dock.destroy();
});

test('the page works without storage: blocked reads, full writes, none at all', () => {
  for (const storage of [undefined, null, { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } }]) {
    const h = dockHarness({ storage, withEditor: false });
    h.store.select('flow', ['f1']);
    assert.equal(h.dock.open(), true);
    buttonByLabel(h, 'Show details').fire('click');
    assert.equal(el(h).dataset.state, 'open');
    buttonByLabel(h, 'Close statistics').fire('click');
    assert.equal(el(h).hidden, true);
    h.dock.destroy();
  }
  const full = memoryStorage();
  full.fail = true;
  const h = dockHarness({ storage: full, withEditor: false });
  h.store.select('flow', ['f1']);
  h.dock.open();
  buttonByLabel(h, 'Show details').fire('click');
  assert.equal(el(h).dataset.state, 'open', 'a full storage loses the memory, not the dock');
  h.dock.destroy();
});

test('an unusable stored state falls back to compact', () => {
  const h = dockHarness({ storage: memoryStorage({ [DOCK_MEMORY_KEY]: '{"state":"huge","height":"tall"}' }), withEditor: false });
  h.store.select('flow', ['f1']);
  h.dock.open();
  assert.equal(el(h).dataset.state, 'compact');
  h.dock.destroy();
});

test('nothing selected, or a wall or label: no dock, and the status line says why', () => {
  const layout = plant();
  const h = dockHarness({ withEditor: false });
  assert.equal(h.dock.open(), false);
  assert.match(h.statuses.at(-1), /Select an item first/);
  h.store.commit('Add wall', (l) => { l.obstacles.push({ id: 'o1', x: 30, y: 10, w: 1, h: 1, kind: 'wall' }); });
  h.store.select('obstacle', ['o1']);
  assert.equal(h.dock.open(), false);
  assert.equal(h.statuses.at(-1), NO_STATS_TEXT);
  assert.equal(el(h).hidden, true);
  assert.ok(layout);
  h.store.select('station', ['s1']);
  h.dock.open();
  assert.equal(el(h).hidden, false);
  h.store.select('obstacle', ['o1']);
  assert.equal(h.statuses.at(-1), NO_STATS_TEXT, 'selecting a wall closes an open dock and says so');
  h.dock.refreshNow();
  assert.equal(el(h).hidden, true);
  h.store.select('station', ['s1']);
  h.dock.refreshNow();
  assert.equal(el(h).hidden, true, 'and it stays closed for the next selection until asked');
  h.dock.destroy();
});

test('clearing the selection closes the dock', () => {
  const h = dockHarness({ withEditor: false });
  h.store.select('station', ['s1']);
  h.dock.open();
  h.store.clearSelection();
  h.dock.refreshNow();
  assert.equal(el(h).hidden, true);
  assert.equal(h.dock.state().opened, false);
  assert.equal(h.renderer.view.stats.open, false);
  h.dock.destroy();
});

test('the window switch: aria-pressed, the model is asked again, and a window the item has no figure for is disabled with the reason', async () => {
  const h = dockHarness({ withEditor: false });
  h.store.select('vehicle', ['v1#1']);
  h.dock.open();
  await h.flush();
  const [start, last30] = dom.elements(el(h)).filter((e) => e.dataset.window);
  assert.deepEqual([start.getAttribute('aria-pressed'), last30.getAttribute('aria-pressed')], ['true', 'false']);
  last30.fire('click');
  assert.deepEqual([start.getAttribute('aria-pressed'), last30.getAttribute('aria-pressed')], ['false', 'true']);
  assert.equal(h.calls.model.at(-1).window, 'last30');
  assert.equal(h.renderer.view.stats.window, 'last30', 'the overlay follows the window');
  h.dock.destroy();

  const g = dockHarness({ withEditor: false, loadContent: async () => ({
    buildStatsModel: () => ({ signature: 'x', windows: { last30: false, note: 'Road cells have no 30-minute figures.' } }),
    createStatsView: () => ({ el: dom.document.createElement('div'), update() {} }),
  }) });
  g.store.select('cell', ['3,6']);
  g.dock.open();
  await g.flush();
  const buttons = dom.elements(g.dock.el).filter((e) => e.dataset.window);
  assert.equal(buttons[1].getAttribute('aria-disabled'), 'true', 'dimmed, not disabled: it stays focusable and answers a tap');
  assert.ok(!buttons[1].disabled, 'not the disabled attribute');
  assert.equal(buttons[1].title, 'Road cells have no 30-minute figures.');
  g.dock.destroy();

  // the planner chose "Last 30 min" and then selects an item that has no such figure: the numbers are since start, the switch says so, the choice is remembered
  const asked = [];
  const f = dockHarness({ withEditor: false, loadContent: async () => ({
    buildStatsModel: (input) => { asked.push([input.selection.kind, input.window]); return { signature: `${input.selection.kind}:${input.window}`, windows: { last30: input.selection.kind !== 'cell' } }; },
    createStatsView: () => ({ el: dom.document.createElement('div'), updates: [], update(model, info) { this.updates.push(info.window); } }),
  }) });
  f.store.select('station', ['s1']);
  f.dock.open();
  await f.flush();
  f.dock.setWindow('last30');
  f.store.select('cell', ['3,6']);
  await f.flush();
  const pair = dom.elements(f.dock.el).filter((e) => e.dataset.window);
  assert.deepEqual(pair.map((b) => b.getAttribute('aria-pressed')), ['true', 'false'], 'since start is the one that is shown');
  assert.equal(pair[1].getAttribute('aria-disabled'), 'true');
  assert.deepEqual(asked.at(-2), ['cell', 'last30'], 'the model was asked for the planner\u2019s choice first ...');
  assert.deepEqual(asked.at(-1), ['cell', 'start'], '... and, saying it has none, again for the window that is shown');
  assert.equal(f.renderer.view.stats.window, 'start', 'the overlay is told the window that is shown');
  assert.equal(f.dock.host.window(), 'start');
  f.store.select('station', ['s2']);
  await f.flush();
  assert.deepEqual(asked.at(-1), ['station', 'last30'], 'the next item that has a 30-minute figure gets the planner\u2019s choice back');
  assert.equal(f.dock.host.window(), 'last30');
  f.dock.destroy();
});

test('a collector that failed says so in the dock (the simulation runs on) and can be started again; nothing while the planner has statistics off', async () => {
  const h = dockHarness({ withEditor: false });
  h.store.select('vehicle', ['v1#1']);
  h.dock.open();
  await h.flush();
  const notice = () => dom.elements(el(h)).find((e) => e.dataset.role === 'stopped');
  assert.equal(notice().hidden, true, 'no failure: no notice');
  h.runner.sim.detailError = new Error('Cannot read properties of undefined\n (reading \'stateSince\')');
  h.runner.sim.detail = null;
  h.dock.refreshNow();
  assert.equal(notice().hidden, false);
  assert.equal(notice().textContent.startsWith('Statistics stopped: Cannot read properties of undefined (reading \'stateSince\'). The simulation is not affected.'), true, 'the reason in one line');
  h.runner.sim.detail = {};
  h.dock.refreshNow();
  assert.equal(notice().hidden, true, 'a running collector: no notice');
  h.runner.sim.detail = null;
  h.store.setUi({ detail: false });
  h.dock.refreshNow();
  assert.equal(notice().hidden, false, 'the planner switched statistics off: no failure, but the dock says why there are no routes and what the numbers are');
  assert.equal(notice().dataset.mode, 'off');
  assert.match(notice().textContent, /switched off.*no routes on the plan.*report only/);
  const turnOn = dom.elements(el(h)).find((e) => e.dataset.role === 'turn-on');
  assert.equal(turnOn.hidden, false);
  assert.equal(dom.elements(el(h)).find((e) => e.dataset.role === 'count-again').hidden, true, '"Count again" is for a collector that failed');
  turnOn.fire('click');
  assert.equal(h.store.getState().ui.detail, true, '"Turn on" switches the preference on again');
  h.dock.refreshNow();
  assert.equal(notice().dataset.mode, 'failed', 'on again: the collector that failed earlier is still gone, so the failure notice is back');
  assert.equal(dom.elements(el(h)).find((e) => e.dataset.role === 'turn-on').hidden, true);
  assert.equal(dom.elements(el(h)).find((e) => e.dataset.role === 'count-again').hidden, false);
  h.runner.sim.detailError = null;
  h.dock.refreshNow();
  assert.equal(notice().hidden, true, 'nothing failed, statistics on: no notice');
  const prefs = [];
  h.store.subscribe((state) => prefs.push(state.ui.detail));
  dom.elements(el(h)).find((e) => e.dataset.role === 'count-again').fire('click');
  assert.deepEqual(prefs, [false, true], 'Count again switches the preference off and on, which makes the runner start a new collector');
  assert.equal(h.store.getState().ui.detail, true);
  h.dock.destroy();
});

test('the routes switch is the overlay flag of the store, both ways', async () => {
  const h = dockHarness({ withEditor: false });
  h.store.select('vehicle', ['v1#1']);
  h.dock.open();
  const input = h.stage.querySelector('[data-role="routes"]');
  assert.equal(input.checked, true);
  input.checked = false;
  input.fire('change');
  assert.equal(h.store.getState().ui.overlays.routes, false);
  assert.equal(h.calls.model.at(-1)?.routes ?? false, false);
  h.store.setUi({ overlays: { routes: true } });
  h.dock.refreshNow();
  assert.equal(input.checked, true);
  h.dock.destroy();
});

test('the crumb of a vehicle selects its fleet and the dock stays open', async () => {
  const h = dockHarness({ withEditor: false });
  h.store.select('vehicle', ['v2#1']);
  h.dock.open();
  const crumb = dom.elements(el(h)).find((e) => e.localName === 'button' && e.className === 'link');
  assert.ok(crumb, 'a link in the header');
  assert.equal(crumb.textContent, 'Forklifts');
  crumb.fire('click');
  assert.deepEqual(h.store.getState().ui.selection, { kind: 'fleet', ids: ['v2'] });
  await h.flush();
  assert.equal(el(h).hidden, false);
  assert.equal(el(h).getAttribute('aria-label'), 'Statistics for Forklifts');
  h.dock.destroy();
});

test('the key I toggles the dock, [ and ] cycle the selection, and none of them act while typing or behind a dialog', () => {
  const h = dockHarness({ withEditor: false });
  h.store.select('station', ['s1']);
  assert.equal(h.key('i').defaultPrevented, true);
  assert.equal(el(h).hidden, false, 'I opens it whatever the preference says');
  h.key('I');
  assert.equal(el(h).hidden, true, 'and closes it');
  h.key('i', { target: { tagName: 'INPUT' } });
  assert.equal(el(h).hidden, true, 'not while typing');
  h.key('i', { ctrlKey: true });
  h.key('i', { altKey: true });
  h.key('i', { repeat: true });
  assert.equal(el(h).hidden, true, 'not with a modifier, not held down');
  h.key('i', { defaultPrevented: true });
  assert.equal(el(h).hidden, true, 'not when somebody else used the key');
  const dialog = dom.document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dom.document.body.append(dialog);
  h.key('i');
  assert.equal(el(h).hidden, true, 'not behind a dialog');
  dialog.remove();
  h.key('i');
  const revealed = h.calls.reveal.length;
  h.key(']');
  assert.deepEqual(h.store.getState().ui.selection, { kind: 'station', ids: ['s2'] });
  assert.equal(h.calls.reveal.length, revealed + 1, 'the dock was already open, but the key chose an item that may be anywhere: it is brought out from under the dock');
  h.key('[');
  h.key('[');
  assert.equal(h.calls.reveal.length, revealed + 3, 'every step does');
  assert.deepEqual(h.store.getState().ui.selection, { kind: 'station', ids: ['s3'] });
  h.store.clearSelection();
  assert.equal(h.key(']').defaultPrevented, false, 'with nothing selected the keys are not ours');
  h.dock.destroy();
});

test('I with nothing with statistics selected says what to do', () => {
  const h = dockHarness({ withEditor: false });
  h.key('i');
  assert.match(h.statuses.at(-1), /Select an item first/);
  assert.equal(el(h).hidden, true);
  h.dock.destroy();
});

test('Esc in the dock first lets the view unpin a route; the editor then does not clear the selection', async () => {
  const h = dockHarness({ withEditor: false });
  h.store.select('vehicle', ['v1#1']);
  h.dock.open();
  await h.flush();
  const view = h.calls.view[0];
  view.pinned = true;
  const used = { key: 'Escape', defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
  await el(h).fire('keydown', used);
  assert.equal(view.escapes, 1);
  view.pinned = false;
  const free = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
  await el(h).fire('keydown', free);
  assert.equal(free.defaultPrevented, false, 'nothing pinned: the key goes on to the editor');
  h.dock.destroy();
});

test('S1.6: a vehicle that disappears in an edit falls back to its fleet, with a toast', () => {
  const h = dockHarness({ withEditor: false });
  h.store.select('vehicle', ['v1#3']);
  h.dock.open();
  h.store.commit('Fewer AGVs', (l) => { updateFleet(l, 'v1', { count: 2 }); });
  assert.deepEqual(h.store.getState().ui.selection, { kind: 'fleet', ids: ['v1'] });
  assert.deepEqual(h.toasts, ['That vehicle no longer exists, so its fleet is selected.']);
  assert.equal(el(h).hidden, false, 'the dock follows the fleet');
  h.store.select('station', ['s1']);
  h.store.commit('Rename', (l) => { updateFleet(l, 'v1', { name: 'Shuttles' }); });
  assert.equal(h.toasts.length, 1, 'no toast for anything else');
  h.dock.destroy();
});

test('while the model builder’s files are missing the dock shows a marked placeholder and remembers why', async () => {
  const h = dockHarness({ withEditor: false, loadContent: async () => { throw new Error('Failed to fetch dynamically imported module'); } });
  h.store.select('vehicle', ['v1#1']);
  h.dock.open();
  await h.flush();
  assert.equal(h.dock.contentState, 'failed');
  assert.match(h.dock.contentError.message, /dynamically imported/);
  const placeholder = h.stage.querySelector('[data-placeholder]');
  assert.ok(placeholder, 'a view that says it is a placeholder');
  assert.match(placeholder.textContent, /Placeholder/);
  assert.equal(dom.elements(placeholder).filter((e) => e.className === 'tile').length, 6, 'six numbers to be');
  h.dock.destroy();
});

test('a model or view that throws never reaches the app: the placeholder takes over and the error is reported once', async () => {
  const logged = [];
  const original = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    const h = dockHarness({ withEditor: false, loadContent: async () => ({
      buildStatsModel: () => { throw new Error('model broke'); },
      createStatsView: () => { throw new Error('view broke'); },
    }) });
    h.store.select('flow', ['f1']);
    h.dock.open();
    await h.flush();
    h.dock.refreshNow();
    h.dock.refreshNow();
    assert.ok(h.stage.querySelector('[data-placeholder]'));
    assert.equal(logged.filter((l) => /model broke/.test(l)).length, 1, 'once');
    const g = dockHarness({ withEditor: false, loadContent: async () => ({
      buildStatsModel: () => ({ signature: 'x' }),
      createStatsView: () => ({ el: dom.document.createElement('div'), update() { throw new Error('update broke'); } }),
    }) });
    g.store.select('flow', ['f1']);
    g.dock.open();
    await g.flush();
    g.dock.refreshNow();
    assert.equal(g.dock.isOpen(), true);
    assert.ok(logged.some((l) => /update broke/.test(l)));
    h.dock.destroy();
    g.dock.destroy();
  } finally {
    console.error = original;
  }
});

test('the view gets what the model builder is promised: selection, layout, runner, sim, detail, report, insights, window, routes, state', async () => {
  const h = dockHarness({ withEditor: false });
  h.store.select('vehicle', ['v1#1']);
  h.dock.open();
  await h.flush();
  h.dock.refreshNow();
  const input = h.calls.model.at(-1);
  assert.deepEqual(Object.keys(input).sort(), ['detail', 'insights', 'layout', 'narrow', 'report', 'routes', 'runner', 'selection', 'sim', 'state', 'window']);
  assert.equal(input.runner, h.runner);
  assert.equal(input.sim, h.runner.sim);
  assert.equal(input.report, h.runner.kpis());
  assert.equal(input.narrow, false);
  const host = h.calls.view[0].host;
  assert.deepEqual(Object.keys(host).sort(), ['announce', 'focusRoute', 'select', 'setWindow', 'showOnPlan', 'state', 'window']);
  host.showOnPlan({ x: 1, y: 1, w: 2, h: 2 });
  assert.deepEqual(h.calls.show, [{ x: 1, y: 1, w: 2, h: 2 }]);
  host.focusRoute('p1', { pinned: true });
  assert.deepEqual(h.renderer.view.stats.focus, { id: 'p1', pinned: true });
  host.focusRoute(null);
  assert.equal(h.renderer.view.stats.focus, null);
  host.select('station', ['s2']);
  assert.deepEqual(h.store.getState().ui.selection, { kind: 'station', ids: ['s2'] });
  h.dock.destroy();
});

test('without a simulation the model is asked with nulls (the view shows "Press play"), and runner events refresh the dock', async () => {
  const h = dockHarness({ withEditor: false });
  h.runner.sim = null;
  h.store.select('station', ['s1']);
  h.dock.open();
  await h.flush();
  const input = h.calls.model.at(-1);
  assert.deepEqual([input.sim, input.report, input.detail, input.insights], [null, null, null, []]);
  const before = h.calls.model.length;
  h.handlers.get('kpis')();
  await h.flush();
  assert.equal(h.calls.model.length, before + 1, 'a kpis event refreshes it');
  assert.deepEqual([...h.handlers.keys()].sort(), ['kpis', 'rebuild', 'state']);
  h.dock.destroy();
  assert.equal(h.handlers.size, 0, 'destroy unsubscribes');
});

test('covered(): the part of the stage the dock hides; the floating controls follow through --dock-covered', () => {
  const h = dockHarness({ withEditor: false });
  h.stage.getBoundingClientRect = () => ({ top: 48, bottom: 872, height: 824 });
  h.dock.el.getBoundingClientRect = () => ({ top: 716, bottom: 860, height: 144 });
  assert.equal(h.dock.covered(), 0, 'closed: nothing');
  h.store.select('station', ['s1']);
  h.dock.open();
  assert.equal(h.dock.covered(), 156, 'the dock plus its margin below it');
  assert.equal(h.stage.attrs.get('style:--dock-covered'), '156px');
  h.dock.close();
  assert.equal(h.dock.covered(), 0);
  assert.equal(h.stage.attrs.get('style:--dock-covered'), '0px');
  assert.equal(h.stage.getAttribute('data-dock'), null);
  h.dock.destroy();
});

test('S1.8: opening reveals the item by the smallest pan, when the dock was closed or the caller asks, and never while a gesture runs', () => {
  const h = dockHarness();
  h.store.select('station', ['s2']);
  h.dock.open();
  assert.equal(h.calls.reveal.length, 1);
  assert.deepEqual(h.calls.reveal[0], { x: 1, y: 2, w: 3, h: 4, of: 'station' }, 'the rectangle of the selection (app.js rectOf)');
  h.dock.open();
  assert.equal(h.calls.reveal.length, 1, 'already open: no second pan');
  h.dock.open({ reveal: 'always' });
  assert.equal(h.calls.reveal.length, 2, 'unless the caller chose the item away from the plan (the Fleet tab, the keys [ and ])');
  h.dock.open({ reveal: false });
  assert.equal(h.calls.reveal.length, 2, 'or asked for none (focus() fits the camera itself)');
  h.dock.close();
  h.eh.mouse.down([3, 3]); // a gesture is running: pressing a station
  h.dock.open();
  assert.equal(h.calls.reveal.length, 2, 'no camera move while the editor is busy');
  h.dock.open({ reveal: 'always' });
  assert.equal(h.calls.reveal.length, 2, 'not even when the caller insists');
  h.eh.mouse.up([3, 3]);
  h.dock.destroy();
});

test('S1.7: a clean click on the plan opens the dock after the editor handled it; a drag never does; the preference decides', async () => {
  for (const [pref, report, opens] of [['data', measured(120), true], ['data', measured(10), false], ['data', measured(500, { warmingUp: true }), false], ['always', null, true], ['never', measured(500), false]]) {
    const h = dockHarness({ report });
    h.store.setUi({ statsDock: pref });
    h.eh.mouse.click([13, 3]); // Press line
    assert.deepEqual(h.store.getState().ui.selection, { kind: 'station', ids: ['s2'] });
    assert.equal(!el(h).hidden, opens, `preference ${pref}, report ${JSON.stringify(report && report.window)}`);
    if (!opens && pref === 'data') assert.equal(h.statuses.at(-1), 'Press play to see statistics for Press line.');
    h.dock.destroy();
  }
  const h = dockHarness();
  h.eh.mouse.down([13, 3]);
  assert.equal(el(h).hidden, true, 'the press selected the station but the dock waits');
  h.eh.mouse.move([16, 3]);
  assert.equal(el(h).classList.contains('is-dragging'), true, 'dimmed while a drag runs');
  h.eh.mouse.up([18, 3]);
  assert.equal(el(h).classList.contains('is-dragging'), false);
  assert.equal(el(h).hidden, true, 'a drag never opens it');
  h.eh.mouse.click([13, 3]);
  assert.equal(el(h).hidden, true, 'the click after a move of the station: that station has been moved, the selection is the same: this click opens it');
  h.dock.destroy();
});

test('S1.7: a click on a vehicle selects it and opens the dock; Shift toggles it', () => {
  const h = dockHarness();
  h.eh.renderer.vehicleAt = [30, 15];
  h.eh.mouse.click([30, 15]);
  assert.deepEqual(h.store.getState().ui.selection, { kind: 'vehicle', ids: ['v1#2'] });
  assert.equal(el(h).hidden, false);
  assert.equal(el(h).getAttribute('aria-label'), 'Statistics for AGVs 2');
  h.eh.mouse.click([30, 15], { shiftKey: true });
  assert.deepEqual(h.store.getState().ui.selection, { kind: null, ids: [] }, 'Shift on the selected vehicle toggles it off');
  h.dock.refreshNow();
  assert.equal(el(h).hidden, true);
  h.dock.destroy();
});

test('clicking empty ground to deselect closes the dock and moves nothing', () => {
  const h = dockHarness();
  h.eh.mouse.click([13, 3]);
  assert.equal(el(h).hidden, false);
  const camera = { ...h.eh.camera };
  h.eh.mouse.click([35, 20]);
  assert.deepEqual(h.store.getState().ui.selection, { kind: null, ids: [] });
  h.dock.refreshNow();
  assert.equal(el(h).hidden, true);
  assert.deepEqual({ ...h.eh.camera }, camera, 'the camera did not move');
  assert.equal(h.calls.reveal.length, 1, 'only the first open revealed');
  h.dock.destroy();
});

test('S1.7: selecting a wall by a click says there are no statistics when it closed an open dock', () => {
  const h = dockHarness();
  h.store.commit('Add wall', (l) => { l.obstacles.push({ id: 'o1', x: 30, y: 10, w: 2, h: 2, kind: 'wall' }); });
  h.eh.renderer.layout = h.store.getState().layout;
  h.eh.renderer.hitTest = function hit(px, py) {
    const [wx, wy] = h.eh.camera.screenToWorld(px, py);
    const cs = this.layout.grid.cellSize;
    const o = this.layout.obstacles.find((e) => pointInRect(wx / cs, wy / cs, e));
    const s = this.layout.stations.find((e) => pointInRect(wx / cs, wy / cs, e));
    if (o) return { kind: 'obstacle', id: o.id, cell: [Math.floor(wx / cs), Math.floor(wy / cs)] };
    return s ? { kind: 'station', id: s.id, cell: [0, 0] } : { kind: 'cell', cell: [Math.floor(wx / cs), Math.floor(wy / cs)] };
  };
  h.eh.mouse.click([13, 3]);
  assert.equal(el(h).hidden, false);
  h.eh.mouse.click([30, 10]);
  assert.deepEqual(h.store.getState().ui.selection, { kind: 'obstacle', ids: ['o1'] });
  h.dock.refreshNow();
  assert.equal(el(h).hidden, true);
  assert.equal(h.statuses.at(-1), NO_STATS_TEXT);
  h.dock.destroy();
});

test('the grip: a drag resizes between compact and open up to 44 vh, a double click toggles, the arrow keys step, all remembered', () => {
  const storage = memoryStorage();
  const h = dockHarness({ storage, withEditor: false });
  h.store.select('station', ['s1']);
  h.dock.open();
  const grip = dom.elements(el(h)).find((e) => e.getAttribute('role') === 'separator');
  assert.equal(grip.getAttribute('aria-label'), 'Resize statistics');
  assert.equal(grip.getAttribute('tabindex'), '0', 'reachable with the keyboard');
  grip.fire('dblclick');
  assert.equal(el(h).dataset.state, 'open');
  grip.fire('dblclick');
  assert.equal(el(h).dataset.state, 'compact');
  grip.fire('keydown', { key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  assert.equal(el(h).dataset.state, 'compact', 'down from compact: nothing to shrink');
  grip.fire('keydown', { key: 'ArrowUp', preventDefault() {}, stopPropagation() {} });
  assert.equal(el(h).dataset.state, 'open', 'up from compact opens it');
  grip.fire('keydown', { key: 'Home', preventDefault() {}, stopPropagation() {} });
  grip.fire('keydown', { key: 'End', preventDefault() {}, stopPropagation() {} });
  assert.equal(el(h).dataset.state, 'open');
  grip.fire('keydown', { key: 'ArrowUp', shiftKey: true, preventDefault() {}, stopPropagation() {} });
  assert.equal(JSON.parse(storage.data.get(DOCK_MEMORY_KEY)).height, 396, 'bigger and bigger, but never above 44 vh of 900 px');
  grip.fire('keydown', { key: 'ArrowDown', shiftKey: true, preventDefault() {}, stopPropagation() {} });
  assert.equal(JSON.parse(storage.data.get(DOCK_MEMORY_KEY)).height, 300, 'and 96 px smaller with Shift');
  grip.fire('keydown', { key: 'Home', preventDefault() {}, stopPropagation() {} });
  assert.equal(el(h).dataset.state, 'compact');
  assert.deepEqual(['aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext'].map((a) => grip.getAttribute(a)), ['0', '100', '0', 'Compact'], 'a focusable separator says where it stands: compact is 0');
  grip.fire('keydown', { key: 'End', preventDefault() {}, stopPropagation() {} });
  grip.fire('keydown', { key: 'ArrowUp', shiftKey: true, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual([grip.getAttribute('aria-valuenow'), grip.getAttribute('aria-valuetext')], ['100', 'Open, 396 px high'], 'at 44 vh it is 100');
  grip.fire('keydown', { key: 'Home', preventDefault() {}, stopPropagation() {} });
  h.dock.destroy();
});

test('the phone sheet: three snap points; a tap on the grip goes to the next one, the arrow keys step without wrapping; no compact or details buttons', () => {
  const h = dockHarness({ withEditor: false, narrow: true });
  h.store.select('vehicle', ['v1#1']);
  h.dock.open();
  assert.equal(el(h).dataset.snap, 'peek', 'peek the first time');
  assert.equal(h.stage.dataset['dock'], 'peek');
  assert.equal(buttonByLabel(h, 'Show details').hidden, true);
  assert.equal(buttonByLabel(h, 'Minimise statistics').hidden, true);
  const grip = dom.elements(el(h)).find((e) => e.getAttribute('role') === 'separator');
  grip.fire('pointerdown', { button: 0, pointerId: 1, clientY: 500, preventDefault() {} });
  grip.fire('pointerup', { pointerId: 1 });
  assert.equal(el(h).dataset.snap, 'half', 'a tap');
  assert.deepEqual(['aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext'].map((a) => grip.getAttribute(a)), ['0', '2', '1', 'Half height'], 'on the phone the value is the snap point');
  grip.fire('keydown', { key: 'ArrowUp', preventDefault() {}, stopPropagation() {} });
  assert.equal(el(h).dataset.snap, 'full');
  grip.fire('keydown', { key: 'ArrowUp', preventDefault() {}, stopPropagation() {} });
  assert.equal(el(h).dataset.snap, 'full', 'the top');
  grip.fire('keydown', { key: 'Home', preventDefault() {}, stopPropagation() {} });
  assert.equal(el(h).dataset.snap, 'peek');
  assert.equal(h.stage.dataset['dock'], 'peek');
  h.dock.destroy();
});

test('destroy removes the dock, the announcer and every listener', () => {
  const h = dockHarness();
  h.store.select('station', ['s1']);
  h.dock.open();
  h.dock.destroy();
  assert.equal(el(h).parentNode, null);
  assert.equal(h.stage.querySelector('[data-role="stats-announce"]'), null);
  assert.deepEqual([...h.win.listeners.values()].flat(), [], 'the key listener is gone');
  h.dock.destroy(); // twice is fine (the click watcher\u2019s own removal is covered above: the fake DOM element cannot remove listeners)
});

// ---- 4. the review fixes of the planner's side (tests/e2e/entity-stats-review.mjs UX-1 to UX-23) -----------------------------

test('UX-1: before there is data a click says press play while paused and when the numbers start while the plant runs', () => {
  assert.equal(roughly(3), 'a few seconds');
  assert.equal(roughly(10), 'about 10 s');
  assert.equal(roughly(63), 'about 65 s');
  assert.equal(roughly(89), 'about 90 s');
  assert.equal(roughly(90), 'about 2 min');
  assert.equal(roughly(510), 'about 9 min');
  assert.equal(roughly(NaN), 'a few seconds', 'no number, no promise');
  const layout = plant();
  const one = { kind: 'station', ids: ['s2'] };
  const sim = { time: 120, settings: { warmup: 600 } };
  const warming = measured(0, { warmingUp: true });
  assert.equal(waitText(one, layout, sim, warming, { playing: false, speed: 10 }), 'Press play to see statistics for Press line.', 'paused: press play');
  assert.equal(waitText(one, layout, sim, null, { playing: true, speed: 10 }), 'Press play to see statistics for Press line.', 'no report yet: nothing to estimate');
  assert.equal(waitText(one, layout, sim, warming, null), 'Press play to see statistics for Press line.');
  assert.equal(waitText(one, layout, sim, warming, { playing: true, speed: 0 }), 'Press play to see statistics for Press line.', 'a junk speed promises nothing');
  assert.equal(waitText(one, layout, sim, warming, { playing: true, speed: 10 }), 'Statistics for Press line start in about 50 s: the plant is warming up first.', '(600 - 120 + 30) simulated seconds at 10x');
  assert.equal(waitText(one, layout, sim, warming, { playing: true, speed: 1 }), 'Statistics for Press line start in about 9 min: the plant is warming up first.', 'at 1x');
  assert.equal(waitText(one, layout, { time: 612, settings: { warmup: 600 } }, measured(12), { playing: true, speed: 10 }), 'Statistics for Press line start in a few seconds.', 'measuring, 18 of the 30 seconds to go; no warm-up to blame');
  assert.equal(waitText({ kind: 'cell', ids: ['3,6', '4,6'] }, layout, sim, warming, { playing: true, speed: 30 }), 'Statistics for these road cells start in about 15 s: the plant is warming up first.', '510 / 30 = 17 s');
  assert.equal(waitText(one, layout, null, warming, { playing: true, speed: 10 }), 'Statistics for Press line start in a few seconds: the plant is warming up first.', 'no simulation to read the warm-up from: the 30 s alone');
});

test('UX-1: the click while the plant is playing and warming up tells how long, not "press play"', () => {
  const h = dockHarness({ report: measured(0, { warmingUp: true }) });
  h.runner.playing = true;
  h.runner.speed = 10;
  h.runner.sim.settings = { warmup: 600 };
  h.runner.sim.time = 120;
  h.eh.mouse.click([13, 3]);
  assert.equal(el(h).hidden, true, 'nothing to show yet');
  assert.equal(h.statuses.at(-1), 'Statistics for Press line start in about 50 s: the plant is warming up first.');
  h.runner.playing = false;
  h.eh.mouse.click([13, 3]);
  assert.equal(h.statuses.at(-1), 'Press play to see statistics for Press line.', 'paused again: the old advice');
  h.dock.destroy();
});

test('UX-4: [ and ] are typed with AltGr (Ctrl+Alt) or Option; a bare Ctrl or Cmd with a bracket is the browser’s', () => {
  const h = dockHarness({ withEditor: false });
  h.store.select('station', ['s1']);
  h.dock.open();
  const sel = () => h.store.getState().ui.selection.ids[0];
  assert.equal(h.key(']', { ctrlKey: true, altKey: true }).defaultPrevented, true, 'AltGr+9 on a German keyboard');
  assert.equal(sel(), 's2');
  h.key(']', { altKey: true }); // Option+6 on a Mac
  assert.equal(sel(), 's3');
  h.key('[', { ctrlKey: true, altKey: true });
  assert.equal(sel(), 's2');
  assert.equal(h.key(']', { ctrlKey: true }).defaultPrevented, false, 'Ctrl+] alone is not ours');
  assert.equal(h.key(']', { metaKey: true }).defaultPrevented, false, 'Cmd+] alone is not ours');
  assert.equal(h.key(']', { ctrlKey: true, metaKey: true, altKey: true }).defaultPrevented, false);
  assert.equal(sel(), 's2');
  h.key('i', { ctrlKey: true, altKey: true });
  h.key('i', { altKey: true });
  assert.equal(el(h).hidden, false, 'I keeps its strict rule: no modifier');
  h.dock.destroy();
});

test('UX-19: Esc closes an open counting rule first, with the dock and the selection left alone; the next Esc goes on', async () => {
  const h = dockHarness({ withEditor: false });
  h.store.select('vehicle', ['v1#1']);
  h.dock.open();
  await h.flush();
  const rule = dom.document.createElement('button');
  rule.setAttribute('aria-expanded', 'true');
  let clicks = 0;
  rule.addEventListener('click', () => { clicks += 1; rule.setAttribute('aria-expanded', 'false'); });
  el(h).append(rule);
  const used = { prevented: 0, stopped: 0 };
  const esc = (target) => ({ key: 'Escape', target, preventDefault() { used.prevented += 1; }, stopPropagation() { used.stopped += 1; } });
  await el(h).fire('keydown', esc(rule));
  assert.equal(clicks, 1, 'the rule was closed with its own button');
  assert.deepEqual([used.prevented, used.stopped], [1, 1], 'the key was used: the editor does not clear the selection');
  await el(h).fire('keydown', esc(rule));
  assert.equal(clicks, 1, 'nothing open any more');
  assert.deepEqual([used.prevented, used.stopped], [1, 1], 'so Esc goes on to the editor');
  const details = buttonByLabel(h, 'Show details');
  details.setAttribute('aria-expanded', 'true');
  await el(h).fire('keydown', esc(details));
  assert.deepEqual([used.prevented, used.stopped], [1, 1], 'the details button is not a counting rule');
  h.dock.destroy();
});

test('UX-3: a keyboard planner whose focus is inside the dock keeps it there when the view is rebuilt for the next item', async () => {
  const P = dom.FElement.prototype;
  P.contains = function contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; };
  try {
    const h = dockHarness({ withEditor: false });
    h.store.select('vehicle', ['v1#1']);
    h.dock.open();
    await h.flush();
    const row = dom.document.createElement('button');
    h.calls.view[0].el.append(row);
    row.focus();
    assert.equal(dom.document.activeElement, row);
    h.key(']');
    assert.deepEqual(h.store.getState().ui.selection.ids, ['v1#2']);
    assert.equal(h.calls.view.length, 2, 'the view was rebuilt: the focused row is gone');
    assert.equal(dom.document.activeElement, el(h), 'the focus is on the dock, not lost to the page');
    // a focus that was outside the dock is not taken
    dom.document.body.focus();
    h.key(']');
    assert.equal(dom.document.activeElement, dom.document.body, 'focus outside the dock stays outside');
    h.dock.destroy();
  } finally {
    delete P.contains;
  }
});

test('UX-8 and UX-9: the window note says why Last 30 min equals Since start, and a dimmed Last 30 min answers a tap with its reason', async () => {
  const note = (h) => dom.elements(el(h)).find((e) => e.dataset.role === 'window-note');
  // before 30 minutes exist
  const h = dockHarness({ withEditor: false, report: measured(700) });
  h.store.select('vehicle', ['v1#1']);
  h.dock.open();
  await h.flush();
  assert.equal(note(h).hidden, true, 'Since start: nothing to explain');
  h.dock.setWindow('last30');
  assert.equal(note(h).hidden, false);
  assert.equal(note(h).textContent, 'Under 30 minutes have been measured (12 min), so Last 30 min is the same as Since start.');
  h.runner.kpis = () => measured(2400);
  h.dock.refreshNow();
  assert.equal(note(h).hidden, true, 'from 30 minutes on the two windows differ and the sentence goes');
  h.runner.kpis = () => measured(1799.5);
  h.dock.refreshNow();
  assert.equal(note(h).hidden, true, 'within half a second of 30 minutes it is no longer "only"');
  h.dock.destroy();

  // an item with no 30-minute figure: the dimmed button is focusable, and a tap shows the reason
  const g = dockHarness({ withEditor: false, loadContent: async () => ({
    buildStatsModel: () => ({ signature: 'x', windows: { last30: false, note: 'For this item the figures are since start.' } }),
    createStatsView: () => ({ el: dom.document.createElement('div'), update() {} }),
  }) });
  g.store.select('cell', ['3,6']);
  g.dock.open();
  await g.flush();
  const last30 = dom.elements(g.dock.el).find((e) => e.dataset.window === 'last30');
  assert.equal(last30.getAttribute('aria-describedby'), 'stats-window-note', 'a screen reader hears the reason with the button');
  assert.equal(note(g).hidden, true, 'not on the screen until asked: the dock does not nag on every station');
  assert.equal(note(g).textContent, 'For this item the figures are since start.', 'but it is in the page for the description');
  last30.fire('click');
  assert.equal(note(g).hidden, false, 'a tap or Enter shows it');
  assert.equal(g.dock.host.window(), 'start', 'and does not change the window');
  g.store.select('cell', ['4,6']);
  g.dock.refreshNow();
  assert.equal(note(g).hidden, true, 'the next item starts without it');
  g.dock.destroy();
});

test('UX-5: a phone sheet that grows brings the item out from under it, once per change, unless it leaves hardly any plan', () => {
  const h = dockHarness({ withEditor: false, narrow: true });
  h.stage.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600 });
  const top = { value: 440 };
  h.dock.el.getBoundingClientRect = () => ({ top: top.value, bottom: 600, height: 600 - top.value });
  h.store.select('vehicle', ['v1#1']);
  h.dock.open();
  assert.equal(h.calls.reveal.length, 1, 'opening at the peek');
  const grip = dom.elements(el(h)).find((e) => e.getAttribute('role') === 'separator');
  const tap = () => { grip.fire('pointerdown', { button: 0, pointerId: 1, clientY: 500, preventDefault() {} }); grip.fire('pointerup', { pointerId: 1 }); };
  top.value = 276; // half: 54 % of the stage
  tap();
  assert.equal(el(h).dataset.snap, 'half');
  assert.equal(h.calls.reveal.length, 2, 'half: the vehicle is brought out from under the sheet');
  h.dock.refreshNow();
  assert.equal(h.calls.reveal.length, 2, 'a refresh at the same snap point moves nothing');
  top.value = 84; // full: 86 %, 84 px of plan are left
  tap();
  assert.equal(el(h).dataset.snap, 'full');
  assert.equal(h.calls.reveal.length, 2, 'full leaves less than 120 px: the plan is not shoved about for it');
  top.value = 440;
  tap(); // back to peek: a sheet that shrinks needs no pan
  assert.equal(el(h).dataset.snap, 'peek');
  assert.equal(h.calls.reveal.length, 2);
  h.dock.destroy();
});

test('UX-23: a swipe on the title row of the phone sheet drags it like the grip; a tap on it does nothing; the buttons in it still tap', () => {
  const h = dockHarness({ withEditor: false, narrow: true });
  h.stage.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600 });
  h.dock.el.getBoundingClientRect = () => ({ top: 464, bottom: 600, height: 136 });
  h.store.select('vehicle', ['v1#1']);
  h.dock.open();
  const head = dom.elements(el(h)).find((e) => e.classList.contains('insight__head'));
  head.fire('pointerdown', { button: 0, pointerId: 7, clientY: 500 });
  head.fire('pointermove', { pointerId: 7, clientY: 480 });
  head.fire('pointerup', { pointerId: 7 });
  assert.equal(el(h).dataset.snap, 'peek', 'a tap with a little slip: stays');
  head.fire('pointerdown', { button: 0, pointerId: 8, clientY: 500 });
  head.fire('pointermove', { pointerId: 8, clientY: 300 });
  head.fire('pointerup', { pointerId: 8 });
  assert.equal(el(h).dataset.snap, 'half', 'swiped up 200 px: the nearest snap point');
  const close = buttonByLabel(h, 'Close statistics');
  head.fire('pointerdown', { button: 0, pointerId: 9, clientY: 500, target: close });
  head.fire('pointermove', { pointerId: 9, clientY: 200, target: close });
  head.fire('pointerup', { pointerId: 9 });
  assert.equal(el(h).dataset.snap, 'half', 'a press on a button in the row starts no drag');
  head.fire('pointerdown', { button: 0, pointerId: 10, clientY: 500 });
  head.fire('pointerup', { pointerId: 10 });
  assert.equal(el(h).dataset.snap, 'half', 'a plain tap on the row is no tap on the grip');
  h.dock.destroy();
});

test('UX-11: the toasts stand above the dock: --dock-lift is the distance from the bottom of the window to its top edge, 0 while it is closed', () => {
  const root = dom.document.documentElement;
  root.style.removeProperty = (name) => root.attrs.delete(`style:${name}`); // the fake DOM has none (the real one removes the property when the dock is destroyed)
  root.attrs.delete('style:--dock-lift'); // what the docks of the tests before this one left on the page
  const h = dockHarness({ withEditor: false });
  h.dock.el.getBoundingClientRect = () => ({ top: 500, bottom: 884, height: 384 });
  assert.equal(root.attrs.get('style:--dock-lift') ?? '0px', '0px', 'closed: no lift');
  h.store.select('station', ['s1']);
  h.dock.open();
  assert.equal(root.attrs.get('style:--dock-lift'), '408px', '900 - 500 + 8');
  h.dock.el.getBoundingClientRect = () => ({ top: 700, bottom: 884, height: 184 });
  h.dock.refreshNow();
  assert.equal(root.attrs.get('style:--dock-lift'), '208px', 'follows the dock');
  h.dock.close();
  assert.equal(root.attrs.get('style:--dock-lift'), '0px');
  h.dock.destroy();
});

test('UX-15: half and full are never lower than their minimum on a very short stage, so never lower than the peek', () => {
  assert.deepEqual([snapHeight('half', 182), snapHeight('full', 182)], [182, 182], 'a 300 % zoom stage of 182 px: the whole stage, not 98 px');
  assert.deepEqual([snapHeight('half', 400), snapHeight('full', 400)], [260, 344], '54 % of 400 is 216: the minimum 260 wins; 86 % is 344');
  assert.deepEqual([snapHeight('half', 800), snapHeight('full', 800)], [432, 688], 'a tall stage: the shares');
  assert.equal(nearestSnap(150, 182), 'peek');
  assert.ok(snapHeight('half', 182) >= SNAP_PEEK_PX, 'half is higher than the peek where the stage allows it');
});

test('UX-14: a click on a road cell while the plant plays at 60x or more says that a vehicle cannot be clicked at that speed', () => {
  assert.equal(FAST_CLICK_SPEED, 60);
  assert.equal(fastClickText({ playing: true, speed: 600 }), 'At 600x a vehicle moves too far between the press and the release to be clicked: pause (Space) first, or choose it in the Fleet tab.');
  assert.equal(fastClickText({ playing: true, speed: 60 }).startsWith('At 60x'), true);
  assert.equal(fastClickText({ playing: true, speed: 59 }), '', 'at 10x a click still hits a vehicle');
  assert.equal(fastClickText({ playing: false, speed: 600 }), '', 'paused: vehicles stand still');
  assert.equal(fastClickText(null), '');
  assert.equal(fastClickText({ playing: true, speed: NaN }), '');
  const h = dockHarness({ report: measured(120) });
  h.runner.playing = true;
  h.runner.speed = 600;
  h.eh.mouse.click([4, 6]); // a road cell of the plant
  assert.deepEqual(h.store.getState().ui.selection, { kind: 'cell', ids: ['4,6'] });
  assert.match(h.statuses.at(-1), /^At 600x a vehicle moves too far/);
  h.runner.speed = 10;
  const before = h.statuses.length;
  h.eh.mouse.click([4, 6]);
  h.eh.mouse.click([6, 6]);
  assert.equal(h.statuses.slice(before).some((t) => /moves too far/.test(t)), false, 'at 10x there is nothing to say');
  h.dock.destroy();
});

test('UX-7: while the body of the open dock has more below what is on the screen the dock says so (data-more fades its bottom edge); at the end or without a scroll it does not', async () => {
  const h = dockHarness({ withEditor: false });
  h.store.select('vehicle', ['v1#1']);
  h.dock.open();
  await h.flush();
  const body = dom.document.createElement('div');
  body.className = 'insight__body';
  Object.assign(body, { scrollHeight: 460, scrollTop: 0, clientHeight: 250 });
  h.calls.view[0].el.append(body);
  h.dock.refreshNow();
  assert.equal(el(h).getAttribute('data-more'), 'true', '210 px of the body are below the edge');
  body.scrollTop = 200;
  h.dock.refreshNow();
  assert.equal(el(h).getAttribute('data-more'), 'true', '10 px short of the end');
  body.scrollTop = 209; // the end, within the 2 px of rounding of a fractional scroll position
  h.dock.refreshNow();
  assert.equal(el(h).getAttribute('data-more'), null, 'at the end: nothing more below');
  Object.assign(body, { scrollHeight: 250, scrollTop: 0 });
  h.dock.refreshNow();
  assert.equal(el(h).getAttribute('data-more'), null, 'the content fits: no scroll, no fade');
  Object.assign(body, { scrollHeight: 460 });
  h.dock.refreshNow();
  assert.equal(el(h).getAttribute('data-more'), 'true');
  h.dock.close();
  assert.equal(el(h).getAttribute('data-more'), null, 'a closed dock says nothing');
  h.dock.destroy();
});
