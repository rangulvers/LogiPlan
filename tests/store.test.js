import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStore, HISTORY_LIMIT, COALESCE_MS, PERSIST_DEBOUNCE_MS, MAX_SCENARIOS, SELECTION_KINDS,
} from '../js/store/store.js';
import * as L from '../js/model/layout.js';
import { exportProject } from '../js/model/serialize.js';
import { createRng } from '../js/util/rng.js';
import { lPath } from '../js/util/grid.js';

// ---------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------

function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    writes: 0,
    failWrite: null,
    failRead: null,
    getItem(key) {
      if (this.failRead) throw this.failRead;
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      if (this.failWrite) throw this.failWrite;
      this.writes++;
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
  };
}

function fakeTimers() {
  const timers = { nextId: 1, pending: new Map(), cleared: [], delays: [] };
  timers.setTimeout = (fn, ms) => {
    const id = timers.nextId++;
    timers.pending.set(id, { fn, ms });
    timers.delays.push(ms);
    return id;
  };
  timers.clearTimeout = (id) => {
    timers.cleared.push(id);
    timers.pending.delete(id);
  };
  timers.fire = () => {
    const due = [...timers.pending.values()];
    timers.pending.clear();
    for (const { fn } of due) fn();
  };
  return timers;
}

/** A store with a fake clock, fake timers, fake storage and an error sink that records instead of printing. */
function makeStore(opts = {}) {
  const clock = { t: 0, advance(ms) { this.t += ms; } };
  const timers = fakeTimers();
  const errors = [];
  const storage = 'storage' in opts ? opts.storage : fakeStorage();
  const store = createStore({
    storage,
    now: () => clock.t,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onError: (err, context) => errors.push({ err, context }),
    ...(opts.storageKey ? { storageKey: opts.storageKey } : {}),
  });
  return { store, clock, timers, errors, storage };
}

const addSource = (x = 2, y = 2) => (l) => { L.addStation(l, { type: 'source', x, y }); };
const rename = (name) => (l) => { l.name = name; };
const names = (store) => store.getState().project.scenarios.map((s) => s.name);

/** Record every notification of a store. */
function record(store) {
  const log = [];
  store.subscribe((state, info) => log.push({ state, info }));
  return log;
}

// ---------------------------------------------------------------------------------------------------------
// initial state
// ---------------------------------------------------------------------------------------------------------

test('a new store holds one valid empty scenario "A" and nothing to undo', () => {
  const { store } = makeStore();
  const s = store.getState();
  assert.deepEqual(s.project.scenarios.map((x) => [x.id, x.name]), [['sc1', 'A']]);
  assert.equal(s.project.activeId, 'sc1');
  assert.equal(s.layout, s.project.scenarios[0].layout);
  assert.deepEqual(L.checkInvariants(s.layout), []);
  assert.equal(s.dirty, false);
  assert.equal(s.canUndo, false);
  assert.equal(s.canRedo, false);
  assert.deepEqual(s.lastCommit, { label: '', kind: 'none' });
  assert.deepEqual(s.ui.selection, { kind: null, ids: [] });
  assert.equal(s.ui.theme, 'auto');
  assert.deepEqual(s.ui.overlays, { grid: true, studs: true, flows: true, docks: false, heat: 'off', ids: false, labels: true });
});

test('state objects are frozen so identity-based change detection can be trusted', () => {
  const { store } = makeStore();
  const s = store.getState();
  assert.throws(() => { s.dirty = true; }, TypeError);
  assert.throws(() => { s.ui.theme = 'dark'; }, TypeError);
  assert.throws(() => { s.ui.overlays.grid = false; }, TypeError);
  assert.throws(() => { s.ui.selection.ids.push('x'); }, TypeError);
  assert.throws(() => { s.project.scenarios.push({}); }, TypeError);
});

// ---------------------------------------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------------------------------------

test('commit runs the mutator on a copy, replaces state.layout and leaves the old layout object untouched', () => {
  const { store } = makeStore();
  const before = store.getState().layout;
  const snapshot = structuredClone(before);
  let draft = null;
  assert.equal(store.commit('Add source', (l) => { draft = l; addSource()(l); }), true);
  const after = store.getState();
  assert.notEqual(draft, before);
  assert.equal(after.layout, draft);
  assert.equal(after.layout.stations.length, 1);
  assert.deepEqual(before, snapshot);
  assert.equal(after.project.scenarios[0].layout, after.layout);
  assert.equal(after.dirty, true);
  assert.deepEqual(after.lastCommit, { label: 'Add source', kind: 'structural' });
});

test('a mutator that returns false is "no change": no history, no notification', () => {
  const { store } = makeStore();
  const log = record(store);
  const v = store.getState().version;
  assert.equal(store.commit('Rejected', (l) => { l.name = 'changed but rejected'; return false; }), false);
  assert.equal(store.getState().canUndo, false);
  assert.equal(store.getState().layout.name, 'Untitled plant');
  assert.equal(store.getState().version, v);
  assert.equal(log.length, 0);
});

test('a deep-equal result is "no change" even if the mutator wrote to the draft', () => {
  const { store } = makeStore();
  const log = record(store);
  const layout = store.getState().layout;
  assert.equal(store.commit('Same name', (l) => { l.name = l.name; l.settings.demandFactor = 1; }), false);
  assert.equal(store.commit('Rejected add', (l) => { L.addStation(l, { type: 'source', x: -5, y: -5 }); }), false);
  assert.equal(store.getState().layout, layout);
  assert.equal(store.getState().canUndo, false);
  assert.equal(log.length, 0);
});

test('a throwing mutator leaves the store untouched and its error is re-thrown as it is', () => {
  const { store } = makeStore();
  const log = record(store);
  const before = store.getState();
  const boom = new RangeError('boom');
  assert.throws(() => store.commit('Explode', (l) => { l.name = 'half done'; throw boom; }), (err) => err === boom);
  assert.equal(store.getState(), before);
  assert.equal(log.length, 0);
});

test('a result that violates the model invariants is rolled back with an Error naming the label', () => {
  const { store } = makeStore();
  const log = record(store);
  const before = store.getState();
  assert.throws(
    () => store.commit('Break the grid', (l) => { l.grid.cols = 3.5; }),
    (err) => err instanceof Error && err.message.includes('Break the grid') && err.message.includes('rolled back'),
  );
  assert.throws(() => store.commit('Overlap', (l) => {
    l.stations.push({ ...L.addStation(structuredClone(l), { type: 'sink', x: 1, y: 1 }) });
    l.stations.push({ ...l.stations[0], id: 'dup' });
  }), /Overlap/);
  assert.equal(store.getState(), before);
  assert.equal(store.getState().canUndo, false);
  assert.equal(log.length, 0);
});

test('commit refuses a mutator that is not a function and cleans empty labels', () => {
  const { store } = makeStore();
  assert.throws(() => store.commit('x', 'nope'), TypeError);
  store.commit('', rename('Renamed'));
  assert.equal(store.getState().undoLabel, 'Edit');
});

test('listeners are told the change kind: cosmetic, runtime or structural', () => {
  const { store } = makeStore();
  const log = record(store);
  store.commit('Rename plant', rename('Plant X'));
  store.commit('Demand', (l) => { l.settings.demandFactor = 1.5; });
  store.commit('Add source', addSource());
  assert.deepEqual(log.map((e) => [e.info.type, e.info.kind, e.info.layoutChanged, e.info.label]), [
    ['commit', 'cosmetic', true, 'Rename plant'],
    ['commit', 'runtime', true, 'Demand'],
    ['commit', 'structural', true, 'Add source'],
  ]);
  assert.equal(log[2].state, store.getState());
});

// ---------------------------------------------------------------------------------------------------------
// undo / redo
// ---------------------------------------------------------------------------------------------------------

test('undo and redo walk through the history and restore the exact layouts', () => {
  const { store } = makeStore();
  const layouts = [store.getState().layout];
  for (const label of ['One', 'Two', 'Three']) {
    store.commit(`Name ${label}`, rename(label));
    layouts.push(store.getState().layout);
  }
  assert.equal(store.getState().undoLabel, 'Name Three');
  for (let i = 2; i >= 0; i--) {
    assert.equal(store.undo(), true);
    assert.equal(store.getState().layout, layouts[i]);
  }
  assert.equal(store.getState().canUndo, false);
  assert.equal(store.getState().canRedo, true);
  assert.equal(store.getState().redoLabel, 'Name One');
  for (let i = 1; i <= 3; i++) {
    assert.equal(store.redo(), true);
    assert.equal(store.getState().layout, layouts[i]);
  }
  assert.equal(store.getState().canRedo, false);
  assert.equal(store.getState().layout.name, 'Three');
});

test('undo and redo with nothing to do return false and notify nobody', () => {
  const { store } = makeStore();
  const log = record(store);
  assert.equal(store.undo(), false);
  assert.equal(store.redo(), false);
  assert.equal(log.length, 0);
});

test('undo and redo notify with their type, label and change kind', () => {
  const { store } = makeStore();
  store.commit('Add source', addSource());
  const log = record(store);
  store.undo();
  store.redo();
  assert.deepEqual(log.map((e) => [e.info.type, e.info.kind, e.info.layoutChanged, e.info.label]), [
    ['undo', 'structural', true, 'Add source'],
    ['redo', 'structural', true, 'Add source'],
  ]);
  assert.deepEqual(store.getState().lastCommit, { label: 'Add source', kind: 'structural' });
});

test('a new commit after undo discards the redo stack', () => {
  const { store } = makeStore();
  store.commit('A', rename('A'));
  store.commit('B', rename('B'));
  store.undo();
  assert.equal(store.getState().canRedo, true);
  store.commit('C', rename('C'));
  assert.equal(store.getState().canRedo, false);
  assert.equal(store.redo(), false);
  store.undo();
  assert.equal(store.getState().layout.name, 'A');
});

test('history keeps at most HISTORY_LIMIT steps per scenario', () => {
  const { store } = makeStore();
  const total = HISTORY_LIMIT + 20;
  for (let i = 1; i <= total; i++) store.commit(`Name ${i}`, rename(`Plant ${i}`));
  let undone = 0;
  while (store.undo()) undone++;
  assert.equal(undone, HISTORY_LIMIT);
  assert.equal(store.getState().layout.name, 'Plant 20');
  let redone = 0;
  while (store.redo()) redone++;
  assert.equal(redone, HISTORY_LIMIT);
  assert.equal(store.getState().layout.name, `Plant ${total}`);
});

test('undoing everything marks the project dirty (content changed since the last export)', () => {
  const { store } = makeStore();
  store.commit('x', rename('x'));
  store.markClean();
  store.undo();
  assert.equal(store.getState().dirty, true);
});

// ---------------------------------------------------------------------------------------------------------
// coalescing
// ---------------------------------------------------------------------------------------------------------

test('commits with the same coalesce key within 800 ms form one undo step (sliding window, first label wins)', () => {
  const { store, clock } = makeStore();
  const original = store.getState().layout;
  const type = (text) => store.commit(`Type ${text}`, rename(text), { coalesce: 'name' });
  type('P');
  clock.advance(COALESCE_MS - 1);
  type('Pl');
  clock.advance(COALESCE_MS);
  type('Pla');
  assert.equal(store.getState().layout.name, 'Pla');
  assert.equal(store.getState().undoLabel, 'Type P');
  store.undo();
  assert.equal(store.getState().layout, original);
  assert.equal(store.getState().canUndo, false);
  store.redo();
  assert.equal(store.getState().layout.name, 'Pla');
});

test('a pause longer than 800 ms ends the burst', () => {
  const { store, clock } = makeStore();
  store.commit('First', rename('1'), { coalesce: 'name' });
  clock.advance(COALESCE_MS + 1);
  store.commit('Second', rename('2'), { coalesce: 'name' });
  store.undo();
  assert.equal(store.getState().layout.name, '1');
  store.undo();
  assert.equal(store.getState().layout.name, 'Untitled plant');
});

test('different keys, or a commit without a key, never merge', () => {
  const { store } = makeStore();
  store.commit('A', rename('a'), { coalesce: 'name' });
  store.commit('B', (l) => { l.notes = 'b'; }, { coalesce: 'notes' });
  store.commit('C', rename('c'));
  store.commit('D', rename('d'), { coalesce: 'name' });
  let steps = 0;
  while (store.undo()) steps++;
  assert.equal(steps, 4);
});

test('a coalesced burst that ends where it started leaves no undo step and restores the original layout object', () => {
  const { store, clock } = makeStore();
  const original = store.getState().layout;
  store.commit('Slide', (l) => { l.settings.demandFactor = 2; }, { coalesce: 'demand' });
  clock.advance(100);
  store.commit('Slide', (l) => { l.settings.demandFactor = 1; }, { coalesce: 'demand' });
  const s = store.getState();
  assert.equal(s.layout, original);
  assert.equal(s.canUndo, false);
  assert.equal(store.undo(), false);
});

test('undo ends coalescing: an edit after an undo starts a fresh step', () => {
  const { store, clock } = makeStore();
  store.commit('Base', rename('base'));
  store.commit('Type', rename('t1'), { coalesce: 'name' });
  store.undo();
  clock.advance(10);
  store.commit('Type', rename('t2'), { coalesce: 'name' });
  store.undo();
  assert.equal(store.getState().layout.name, 'base');
  store.undo();
  assert.equal(store.getState().layout.name, 'Untitled plant');
});

test('coalescing uses the injected clock, never the wall clock', () => {
  const { store } = makeStore();
  store.commit('A', rename('a'), { coalesce: 'k' });
  store.commit('B', rename('b'), { coalesce: 'k' }); // fake clock has not moved
  assert.equal(store.undo(), true);
  assert.equal(store.undo(), false);
});

// ---------------------------------------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------------------------------------

function plantWithTwoStations() {
  const { store, ...rest } = makeStore();
  store.commit('Build', (l) => {
    L.addStation(l, { type: 'source', x: 2, y: 2 });
    L.addStation(l, { type: 'sink', x: 12, y: 2 });
    L.addFlow(l, 's1', 's2');
    L.addFleet(l, 'agv');
    L.paintRoadPath(l, [[3, 5], [4, 5], [5, 5]]);
  });
  return { store, ...rest };
}

test('select stores kind and unique existing ids; selecting the same thing again changes nothing', () => {
  const { store } = plantWithTwoStations();
  const log = record(store);
  assert.equal(store.select('station', ['s1', 's2', 's1']), true);
  assert.deepEqual(store.getState().ui.selection, { kind: 'station', ids: ['s1', 's2'] });
  const sel = store.getState().ui.selection;
  assert.equal(store.select('station', ['s1', 's2']), false);
  assert.equal(store.getState().ui.selection, sel);
  assert.equal(log.length, 1);
  assert.equal(log[0].info.type, 'ui');
});

test('select accepts a single id, drops unknown ids and unknown kinds, and clearSelection empties it', () => {
  const { store } = plantWithTwoStations();
  store.select('flow', 'f1');
  assert.deepEqual(store.getState().ui.selection, { kind: 'flow', ids: ['f1'] });
  store.select('fleet', ['v1', 'ghost']);
  assert.deepEqual(store.getState().ui.selection, { kind: 'fleet', ids: ['v1'] });
  store.select('station', ['ghost']);
  assert.deepEqual(store.getState().ui.selection, { kind: null, ids: [] });
  store.select('station', ['s1']);
  store.select('vehicle', ['v1#1']);
  assert.deepEqual(store.getState().ui.selection, { kind: null, ids: [] });
  store.select('station', ['s1']);
  assert.equal(store.clearSelection(), true);
  assert.equal(store.clearSelection(), false);
  assert.ok(SELECTION_KINDS.includes('cell'));
});

test('cell selections use road cell keys; [cx, cy] pairs are accepted and non-road cells are dropped', () => {
  const { store } = plantWithTwoStations();
  store.select('cell', ['3,5', [4, 5], '9,9', 'junk', [1.5, 2]]);
  assert.deepEqual(store.getState().ui.selection, { kind: 'cell', ids: ['3,5', '4,5'] });
  store.commit('Erase road', (l) => { L.eraseRoadCell(l, 4, 5); });
  assert.deepEqual(store.getState().ui.selection, { kind: 'cell', ids: ['3,5'] });
});

test('a commit that removes selected things prunes the selection to what still exists', () => {
  const { store } = plantWithTwoStations();
  store.select('station', ['s1', 's2']);
  store.commit('Remove source', (l) => { L.removeStation(l, 's1'); });
  assert.deepEqual(store.getState().ui.selection, { kind: 'station', ids: ['s2'] });
  store.commit('Remove sink', (l) => { L.removeStation(l, 's2'); });
  assert.deepEqual(store.getState().ui.selection, { kind: null, ids: [] });
});

test('undo and redo prune the selection too (nothing selected refers to a missing thing)', () => {
  const { store } = plantWithTwoStations();
  store.commit('Add third', (l) => { L.addStation(l, { type: 'storage', x: 20, y: 10 }); });
  store.select('station', ['s3']);
  store.undo();
  assert.deepEqual(store.getState().ui.selection, { kind: null, ids: [] });
  store.redo();
  assert.deepEqual(store.getState().ui.selection, { kind: null, ids: [] });
  store.select('station', ['s3']);
  assert.equal(store.getState().ui.selection.ids[0], 's3');
});

test('a commit that keeps the selection valid keeps its identity', () => {
  const { store } = plantWithTwoStations();
  store.select('station', ['s1']);
  const sel = store.getState().ui.selection;
  store.commit('Rename', rename('Another'));
  assert.equal(store.getState().ui.selection, sel);
});

// ---------------------------------------------------------------------------------------------------------
// ui
// ---------------------------------------------------------------------------------------------------------

test('ui-only changes keep the identity of project and layout and of untouched ui parts', () => {
  const { store } = makeStore();
  const before = store.getState();
  store.setUi({ tool: 'road' });
  const mid = store.getState();
  assert.notEqual(mid, before);
  assert.equal(mid.layout, before.layout);
  assert.equal(mid.project, before.project);
  assert.equal(mid.ui.overlays, before.ui.overlays);
  assert.equal(mid.ui.tool, 'road');
  store.setUi({ theme: 'dark' });
  assert.equal(store.getState().ui.overlays, before.ui.overlays);
  assert.equal(store.getState().ui.selection, before.ui.selection);
});

test('a layout commit leaves ui parts untouched and other scenarios identical', () => {
  const { store } = makeStore();
  store.addScenario('B');
  store.switchScenario('sc1');
  const before = store.getState();
  store.commit('Rename', rename('x'));
  const after = store.getState();
  assert.equal(after.ui, before.ui);
  assert.notEqual(after.project, before.project);
  assert.notEqual(after.layout, before.layout);
  assert.equal(after.project.scenarios[1], before.project.scenarios[1]);
});

test('setUi merges overlays per flag and validates heat, theme and flags', () => {
  const { store } = makeStore();
  store.setUi({ overlays: { grid: false, heat: 'traffic', docks: 'yes', nonsense: true } });
  assert.deepEqual(store.getState().ui.overlays, { grid: false, studs: true, flows: true, docks: false, heat: 'traffic', ids: false, labels: true });
  store.setUi({ overlays: { heat: 'lava' }, theme: 'neon', followSim: 'maybe', tool: '', rightTab: 42 });
  const ui = store.getState().ui;
  assert.equal(ui.overlays.heat, 'traffic');
  assert.equal(ui.theme, 'auto');
  assert.equal(ui.followSim, false);
  assert.equal(ui.tool, 'select');
  assert.equal(ui.rightTab, 'properties');
});

test('setUi that changes nothing returns false and notifies nobody', () => {
  const { store } = makeStore();
  const log = record(store);
  const v = store.getState().version;
  assert.equal(store.setUi({ tool: 'select', overlays: { grid: true } }), false);
  assert.equal(store.setUi({ theme: 'bogus' }), false);
  assert.equal(store.setUi(null), false);
  assert.equal(store.getState().version, v);
  assert.equal(log.length, 0);
});

test('toolOptions merge one level deep; other keys are stored as given; prototype keys are ignored', () => {
  const { store } = makeStore();
  store.setUi({ toolOptions: { factor: 0.8 } });
  assert.deepEqual(store.getState().ui.toolOptions, { factor: 0.8, kind: 'wall' });
  store.setUi({ drawerOpen: true, ['__proto__']: { polluted: true } });
  assert.equal(store.getState().ui.drawerOpen, true);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(store.getState().ui), Object.prototype);
  store.setUi({ drawerOpen: undefined });
  assert.equal('drawerOpen' in store.getState().ui, false);
});

// ---------------------------------------------------------------------------------------------------------
// replaceLayout / loadProject / newProject
// ---------------------------------------------------------------------------------------------------------

test('replaceLayout is one undoable step with its label, clears the selection and normalizes its input', () => {
  const { store } = plantWithTwoStations();
  store.select('station', ['s1']);
  const before = store.getState().layout;
  const incoming = L.createLayout({ name: 'Imported', cols: 20, rows: 12 });
  incoming.junk = 'dropped';
  assert.equal(store.replaceLayout(incoming, { label: 'Load example' }), true);
  const s = store.getState();
  assert.equal(s.layout.name, 'Imported');
  assert.equal('junk' in s.layout, false);
  assert.notEqual(s.layout, incoming);
  assert.deepEqual(s.ui.selection, { kind: null, ids: [] });
  assert.equal(s.undoLabel, 'Load example');
  store.undo();
  assert.equal(store.getState().layout, before);
});

test('replaceLayout with an equal layout is a no-op', () => {
  const { store } = makeStore();
  assert.equal(store.replaceLayout(structuredClone(store.getState().layout)), false);
  assert.equal(store.getState().canUndo, false);
});

test('loadProject installs the project with normalized layouts, unique ids and names, and empty histories', () => {
  const { store } = makeStore();
  store.commit('x', rename('x'));
  const dirty = L.createLayout({ name: 'Second' });
  dirty.stations = [{ id: 'oops' }];
  const project = {
    name: 'Imported plant',
    scenarios: [
      { id: 'a', name: 'Base', layout: L.createLayout({ name: 'First' }) },
      { id: 'a', name: 'base', layout: dirty },
      { id: '__proto__', name: '', layout: L.createLayout() },
      { id: 'skipped', name: 'No layout' },
    ],
    activeId: 'a',
  };
  assert.equal(store.loadProject(project), true);
  const s = store.getState();
  assert.equal(s.project.name, 'Imported plant');
  assert.deepEqual(s.project.scenarios.map((x) => x.name), ['Base', 'base 2', 'A']);
  assert.equal(new Set(s.project.scenarios.map((x) => x.id)).size, 3);
  assert.ok(s.project.scenarios.every((x) => L.checkInvariants(x.layout).length === 0));
  assert.equal(s.project.activeId, 'a');
  assert.equal(s.layout.name, 'First');
  assert.equal(s.canUndo, false);
  assert.equal(s.dirty, false);
  assert.equal(s.lastCommit.label, '');
});

test('loadProject falls back to the first scenario for an unknown activeId and refuses a project without layouts', () => {
  const { store } = makeStore();
  store.loadProject({ scenarios: [{ layout: L.createLayout({ name: 'One' }) }, { layout: L.createLayout({ name: 'Two' }) }], activeId: 'nope' });
  assert.equal(store.getState().layout.name, 'One');
  assert.equal(store.getState().project.name, 'One');
  const before = store.getState();
  assert.throws(() => store.loadProject({ scenarios: [] }), /scenario/);
  assert.throws(() => store.loadProject(null), /scenarios/);
  assert.throws(() => store.loadProject({ scenarios: [{ name: 'no layout' }] }), /scenario/);
  assert.equal(store.getState(), before);
});

test('loadProject keeps at most MAX_SCENARIOS and leaves the ui preferences alone', () => {
  const { store } = makeStore();
  store.setUi({ theme: 'dark', tool: 'road' });
  const many = Array.from({ length: MAX_SCENARIOS + 5 }, (_, i) => ({ id: `s${i}`, name: `S ${i}`, layout: L.createLayout() }));
  store.loadProject({ scenarios: many });
  assert.equal(store.getState().project.scenarios.length, MAX_SCENARIOS);
  assert.equal(store.getState().ui.theme, 'dark');
  assert.equal(store.getState().ui.tool, 'road');
});

test('newProject starts over: one scenario, empty histories, clean, nothing selected, ui preferences kept', () => {
  const { store } = plantWithTwoStations();
  store.select('station', ['s1']);
  store.setUi({ theme: 'light' });
  store.addScenario('B');
  const log = record(store);
  const layout = L.createLayout({ name: 'Fresh', cols: 20, rows: 12 });
  assert.equal(store.newProject(layout, 'My project'), true);
  const s = store.getState();
  assert.equal(s.project.name, 'My project');
  assert.deepEqual(s.project.scenarios.map((x) => x.name), ['A']);
  assert.equal(s.layout.name, 'Fresh');
  assert.equal(s.canUndo, false);
  assert.equal(s.dirty, false);
  assert.deepEqual(s.ui.selection, { kind: null, ids: [] });
  assert.equal(s.ui.theme, 'light');
  assert.deepEqual(log.map((e) => e.info.type), ['load']);
  store.newProject();
  assert.equal(store.getState().layout.name, 'Untitled plant');
  assert.equal(store.getState().project.name, 'Untitled plant');
});

// ---------------------------------------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------------------------------------

test('addScenario copies the current layout by default, activates the new scenario and numbers default names A, B, C', () => {
  const { store } = makeStore();
  store.commit('Name', rename('Base plant'));
  const id = store.addScenario();
  const s = store.getState();
  assert.equal(s.project.activeId, id);
  assert.deepEqual(names(store), ['A', 'B']);
  assert.deepEqual(s.layout, s.project.scenarios[0].layout);
  assert.notEqual(s.layout, s.project.scenarios[0].layout);
  assert.equal(store.addScenario('Variant', L.createLayout({ name: 'Own' })) !== null, true);
  assert.equal(store.getState().layout.name, 'Own');
  store.addScenario();
  assert.deepEqual(names(store), ['A', 'B', 'Variant', 'C']);
});

test('every scenario keeps its own undo history', () => {
  const { store } = makeStore();
  store.commit('A1', rename('a1'));
  store.commit('A2', rename('a2'));
  store.addScenario('B');
  assert.equal(store.getState().canUndo, false);
  store.commit('B1', rename('b1'));
  store.switchScenario('sc1');
  assert.equal(store.getState().undoLabel, 'A2');
  store.undo();
  store.undo();
  assert.equal(store.getState().layout.name, 'Untitled plant');
  assert.equal(store.getState().canUndo, false);
  store.switchScenario('sc2');
  assert.equal(store.getState().layout.name, 'b1');
  assert.equal(store.getState().undoLabel, 'B1');
  store.undo();
  assert.equal(store.getState().layout.name, 'a2', 'B started as a copy of A');
  assert.equal(store.getState().canUndo, false);
  store.switchScenario('sc1');
  assert.equal(store.getState().canRedo, true);
  assert.equal(store.getState().redoLabel, 'A1');
});

test('coalescing does not leak across a scenario switch', () => {
  const { store } = makeStore();
  store.addScenario('B');
  store.commit('Type', rename('b'), { coalesce: 'name' });
  store.switchScenario('sc1');
  store.commit('Type', rename('a'), { coalesce: 'name' });
  store.switchScenario('sc2');
  store.commit('Type', rename('b2'), { coalesce: 'name' });
  store.undo();
  assert.equal(store.getState().layout.name, 'b');
});

test('scenario names are unique, case-insensitively; a clash gets a number', () => {
  const { store } = makeStore();
  store.addScenario('Variant');
  store.addScenario('variant');
  store.addScenario('  Variant  ');
  store.addScenario('Variant 2');
  assert.deepEqual(names(store), ['A', 'Variant', 'variant 2', 'Variant 3', 'Variant 4']);
  assert.equal(store.renameScenario('sc1', 'VARIANT'), true);
  assert.equal(names(store)[0], 'VARIANT 5');
  assert.equal(store.renameScenario('sc2', 'Variant'), false, 'keeping a scenario\'s own name is not a change');
  assert.equal(store.renameScenario('sc2', '   '), false);
  assert.equal(store.renameScenario('nope', 'x'), false);
  const long = 'x'.repeat(200);
  store.addScenario(long);
  store.addScenario(long);
  assert.ok(names(store).every((n) => n.length <= 80));
  assert.equal(new Set(names(store).map((n) => n.toLowerCase())).size, names(store).length);
});

test('duplicateScenario clones the layout deeply, names the copy and activates it', () => {
  const { store } = plantWithTwoStations();
  const copyId = store.duplicateScenario('sc1');
  const s = store.getState();
  assert.equal(s.project.activeId, copyId);
  assert.deepEqual(names(store), ['A', 'A copy']);
  assert.deepEqual(s.project.scenarios[1].layout, s.project.scenarios[0].layout);
  assert.notEqual(s.project.scenarios[1].layout, s.project.scenarios[0].layout);
  store.duplicateScenario('sc1');
  assert.deepEqual(names(store), ['A', 'A copy', 'A copy 2']);
  assert.equal(store.duplicateScenario('nope'), null);
});

test('switchScenario changes the layout, clears the selection and ignores unknown or active ids', () => {
  const { store } = plantWithTwoStations();
  store.addScenario('B', L.createLayout({ name: 'Other' }));
  store.switchScenario('sc1');
  store.select('station', ['s1']);
  const log = record(store);
  assert.equal(store.switchScenario('sc1'), false);
  assert.equal(store.switchScenario('nope'), false);
  assert.equal(log.length, 0);
  assert.equal(store.switchScenario('sc2'), true);
  assert.equal(store.getState().layout.name, 'Other');
  assert.deepEqual(store.getState().ui.selection, { kind: null, ids: [] });
  assert.deepEqual([log[0].info.type, log[0].info.layoutChanged, log[0].info.kind], ['scenario', true, 'structural']);
  assert.equal(store.getState().layout, store.getState().project.scenarios[1].layout);
});

test('deleteScenario picks the left neighbour (or the right one for the first), drops the history, keeps others untouched', () => {
  const { store } = makeStore();
  store.addScenario('B');
  store.addScenario('C');
  store.switchScenario('sc2');
  store.commit('B edit', rename('b'));
  assert.equal(store.deleteScenario('sc2'), true);
  assert.deepEqual(names(store), ['A', 'C']);
  assert.equal(store.getState().project.activeId, 'sc1');
  assert.equal(store.deleteScenario('sc1'), true);
  assert.equal(store.getState().project.activeId, 'sc3');
  assert.equal(store.deleteScenario('sc3'), false, 'the last scenario cannot be deleted');
  assert.equal(store.deleteScenario('nope'), false);
  assert.deepEqual(names(store), ['C']);
  const id = store.addScenario('D');
  assert.equal(store.getState().canUndo, false, 'a reused id starts with a fresh history');
  assert.equal(id, 'sc1');
});

test('deleting a scenario that is not active leaves the active one and its selection alone', () => {
  const { store } = plantWithTwoStations();
  store.addScenario('B');
  store.switchScenario('sc1');
  store.select('station', ['s1']);
  assert.equal(store.deleteScenario('sc2'), true);
  assert.equal(store.getState().project.activeId, 'sc1');
  assert.deepEqual(store.getState().ui.selection, { kind: 'station', ids: ['s1'] });
});

test('refusing to delete the last scenario changes nothing and notifies nobody', () => {
  const { store } = makeStore();
  const log = record(store);
  const before = store.getState();
  assert.equal(store.deleteScenario('sc1'), false);
  assert.equal(store.getState(), before);
  assert.equal(log.length, 0);
});

test('a project holds at most MAX_SCENARIOS scenarios', () => {
  const { store } = makeStore();
  for (let i = 1; i < MAX_SCENARIOS; i++) assert.notEqual(store.addScenario(), null);
  assert.equal(store.getState().project.scenarios.length, MAX_SCENARIOS);
  assert.equal(store.addScenario(), null);
  assert.equal(store.duplicateScenario('sc1'), null);
  assert.equal(store.getState().project.scenarios.length, MAX_SCENARIOS);
});

test('renameProject sets a clean name; empty and unchanged names are refused', () => {
  const { store } = makeStore();
  assert.equal(store.renameProject('  Plant Nord \n'), true);
  assert.equal(store.getState().project.name, 'Plant Nord');
  assert.equal(store.renameProject('Plant Nord'), false);
  assert.equal(store.renameProject(''), false);
});

// ---------------------------------------------------------------------------------------------------------
// dirty flag
// ---------------------------------------------------------------------------------------------------------

test('dirty: set by project content changes, cleared by markClean / newProject / loadProject, untouched by ui and switching', () => {
  const { store } = makeStore();
  const log = record(store);
  assert.equal(store.getState().dirty, false);
  assert.equal(store.markClean(), false);
  store.setUi({ theme: 'dark' });
  store.select('station', ['x']);
  assert.equal(store.getState().dirty, false);
  store.commit('x', rename('x'));
  assert.equal(store.getState().dirty, true);
  assert.equal(store.markClean(), true);
  assert.equal(store.getState().dirty, false);
  assert.equal(log.at(-1).info.type, 'project');
  store.addScenario('B');
  assert.equal(store.getState().dirty, true);
  store.markClean();
  store.switchScenario('sc1');
  assert.equal(store.getState().dirty, false);
  store.renameScenario('sc1', 'Renamed');
  assert.equal(store.getState().dirty, true);
  store.loadProject({ scenarios: [{ layout: L.createLayout() }] });
  assert.equal(store.getState().dirty, false);
  store.commit('x', rename('y'));
  store.newProject();
  assert.equal(store.getState().dirty, false);
});

// ---------------------------------------------------------------------------------------------------------
// listeners
// ---------------------------------------------------------------------------------------------------------

test('listeners get (state, info) synchronously, in subscription order, until they unsubscribe', () => {
  const { store } = makeStore();
  const order = [];
  const off1 = store.subscribe((s, i) => order.push(['one', s === store.getState(), i.type]));
  store.subscribe(() => order.push(['two']));
  store.commit('x', rename('x'));
  assert.deepEqual(order, [['one', true, 'commit'], ['two']]);
  off1();
  store.commit('y', rename('y'));
  assert.deepEqual(order.slice(2), [['two']]);
  assert.throws(() => store.subscribe('nope'), TypeError);
});

test('an exception in one listener goes to onError and does not stop the others', () => {
  const { store, errors } = makeStore();
  const seen = [];
  const bad = new Error('listener bug');
  store.subscribe(() => { throw bad; });
  store.subscribe((s) => seen.push(s.version));
  assert.doesNotThrow(() => store.commit('x', rename('x')));
  assert.equal(seen.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].err, bad);
  assert.equal(errors[0].context.info.type, 'commit');
  assert.equal(store.getState().layout.name, 'x');
});

test('a failing onError sink cannot break the store either', () => {
  const store = createStore({ storage: undefined, onError: () => { throw new Error('sink down'); } });
  store.subscribe(() => { throw new Error('listener bug'); });
  assert.doesNotThrow(() => store.commit('x', rename('x')));
});

test('a change made inside a listener is delivered after the current round, so nobody sees states out of order', () => {
  const { store } = makeStore();
  const seen = [];
  let fired = false;
  store.subscribe((s, info) => {
    seen.push(['a', info.type, s.version]);
    if (!fired) {
      fired = true;
      store.setUi({ theme: 'dark' });
    }
  });
  store.subscribe((s, info) => seen.push(['b', info.type, s.version]));
  store.commit('x', rename('x'));
  assert.deepEqual(seen.map(([who, type]) => who + ':' + type), ['a:commit', 'b:commit', 'a:ui', 'b:ui']);
  for (const who of ['a', 'b']) {
    const versions = seen.filter((e) => e[0] === who).map((e) => e[2]);
    assert.deepEqual(versions, [...versions].sort((p, q) => p - q));
  }
  assert.equal(store.getState().ui.theme, 'dark');
});

test('a listener removed during a round is not called later in that round', () => {
  const { store } = makeStore();
  let calledSecond = 0;
  let off2 = null;
  store.subscribe(() => off2());
  off2 = store.subscribe(() => { calledSecond++; });
  store.commit('x', rename('x'));
  assert.equal(calledSecond, 0);
});

test('version grows with every change and not with refused ones', () => {
  const { store } = makeStore();
  const v0 = store.getState().version;
  store.commit('x', rename('x'));
  store.setUi({ tool: 'road' });
  store.undo();
  assert.equal(store.getState().version, v0 + 3);
  store.undo();
  assert.equal(store.getState().version, v0 + 3);
});

// ---------------------------------------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------------------------------------

test('autosave waits 400 ms after the LAST change (injected timers) and then writes the session', () => {
  const { store, timers, storage } = makeStore();
  store.commit('x', rename('x'));
  assert.equal(timers.pending.size, 1);
  assert.deepEqual(timers.delays, [PERSIST_DEBOUNCE_MS]);
  store.commit('y', rename('y'));
  assert.equal(timers.pending.size, 1, 'the earlier timer was cancelled');
  assert.equal(timers.cleared.length, 1);
  assert.equal(storage.writes, 0);
  timers.fire();
  assert.equal(storage.writes, 1);
  assert.equal(storage.data.has('logiplan:v1'), true);
  assert.equal(JSON.parse(storage.data.get('logiplan:v1')).scenarios[0].layout.name, 'y');
  assert.equal(store.lastPersistError, null);
});

test('persist() writes at once and cancels the pending autosave; storageKey is honoured', () => {
  const { store, timers, storage } = makeStore({ storageKey: 'custom:key' });
  store.commit('x', rename('x'));
  assert.equal(store.persist(), true);
  assert.equal(timers.pending.size, 0);
  assert.equal(storage.data.has('custom:key'), true);
  assert.equal(storage.data.has('logiplan:v1'), false);
});

test('persist and restore round-trip: scenarios, active scenario, names, ui preferences and dirty flag survive; history, tool and selection do not', () => {
  const first = makeStore();
  const { store } = first;
  store.commit('Build', (l) => {
    L.addStation(l, { type: 'source', x: 2, y: 2 });
    L.addStation(l, { type: 'sink', x: 12, y: 2 });
    L.addFlow(l, 's1', 's2');
    l.name = 'Plant X';
  });
  store.addScenario('Variant');
  store.commit('More', (l) => { L.addFleet(l, 'forklift', { count: 3 }); });
  store.renameProject('My project');
  store.setUi({ theme: 'dark', overlays: { heat: 'waiting', grid: false }, rightTab: 'results', tool: 'road' });
  store.select('station', ['s1']);
  store.persist();

  const second = makeStore({ storage: first.storage });
  assert.equal(second.store.restore(), true);
  const a = store.getState();
  const b = second.store.getState();
  assert.deepEqual(b.project, a.project);
  assert.equal(b.project.activeId, a.project.activeId);
  assert.equal(b.dirty, true);
  assert.equal(b.ui.theme, 'dark');
  assert.equal(b.ui.rightTab, 'results');
  assert.deepEqual(b.ui.overlays, a.ui.overlays);
  assert.equal(b.ui.tool, 'select');
  assert.deepEqual(b.ui.selection, { kind: null, ids: [] });
  assert.equal(b.canUndo, false);
  assert.equal(second.store.lastRestoreError, null);
  assert.deepEqual(L.checkInvariants(b.layout), []);
});

test('only theme, overlays and rightTab are saved as ui preferences, next to a normal project export', () => {
  const { store, storage } = makeStore();
  store.setUi({ tool: 'oneway', theme: 'light' });
  store.select('cell', ['1,1']);
  store.persist();
  const saved = JSON.parse(storage.data.get('logiplan:v1'));
  assert.deepEqual(Object.keys(saved.session.ui).sort(), ['overlays', 'rightTab', 'theme']);
  assert.equal(saved.session.dirty, false);
  assert.equal(saved.app, 'logiplan');
  assert.equal(JSON.parse(exportProject(store.getState().project)).scenarios.length, saved.scenarios.length);
});

test('ui changes that are not preferences (tool, selection) do not trigger an autosave; theme does', () => {
  const { store, timers } = makeStore();
  store.setUi({ tool: 'road' });
  store.select('cell', ['1,1']);
  assert.equal(timers.pending.size, 0);
  store.setUi({ theme: 'dark' });
  assert.equal(timers.pending.size, 1);
});

test('restore returns false and changes nothing when nothing is stored', () => {
  const { store } = makeStore();
  store.commit('x', rename('x'));
  const before = store.getState();
  assert.equal(store.restore(), false);
  assert.equal(store.getState(), before);
  assert.equal(store.lastRestoreError, null);
});

test('restore tolerates corrupt data: false, state untouched, the reason in lastRestoreError', () => {
  for (const junk of ['{not json', '[]', '{"app":"logiplan","scenarios":[]}', '"just a string"', '{"scenarios":[{"layout":"x"}]}', '\u0000\u0001']) {
    const { store, storage } = makeStore();
    storage.data.set('logiplan:v1', junk);
    store.commit('x', rename('mine'));
    const before = store.getState();
    assert.equal(store.restore(), false, junk);
    assert.equal(store.getState(), before);
    assert.ok(store.lastRestoreError instanceof Error, junk);
  }
});

test('restore survives a storage that throws on read', () => {
  const { store, storage } = makeStore();
  storage.failRead = new DOMException('blocked', 'SecurityError');
  assert.equal(store.restore(), false);
  assert.equal(store.lastRestoreError.name, 'SecurityError');
  assert.equal(store.getState().project.scenarios.length, 1);
});

test('restore repairs a damaged layout and ignores nonsense ui preferences', () => {
  const { store, storage } = makeStore();
  store.persist();
  const saved = JSON.parse(storage.data.get('logiplan:v1'));
  saved.scenarios[0].layout.grid.cols = 'many';
  saved.scenarios[0].layout.stations = [{ id: 's1' }, 7];
  saved.session.ui = { theme: 'neon', overlays: { grid: 'maybe', heat: 'lava' }, rightTab: 7, tool: 'road' };
  storage.data.set('logiplan:v1', JSON.stringify(saved));
  const other = makeStore({ storage });
  assert.equal(other.store.restore(), true);
  const s = other.store.getState();
  assert.deepEqual(L.checkInvariants(s.layout), []);
  assert.equal(s.ui.theme, 'auto');
  assert.equal(s.ui.rightTab, 'properties');
  assert.equal(s.ui.overlays.grid, true);
  assert.equal(s.ui.tool, 'select');
});

test('restore does not trigger a new autosave and cancels a pending one', () => {
  const first = makeStore();
  first.store.commit('x', rename('stored'));
  first.store.persist();
  const second = makeStore({ storage: first.storage });
  second.store.commit('y', rename('unsaved'));
  assert.equal(second.timers.pending.size, 1);
  second.store.restore();
  assert.equal(second.timers.pending.size, 0);
  assert.equal(second.store.getState().layout.name, 'stored');
});

test('a quota error is handled quietly: persist() is false, lastPersistError is set, editing goes on, listeners hear about the change once', () => {
  const { store, storage, timers } = makeStore();
  const log = record(store);
  storage.failWrite = new DOMException('full', 'QuotaExceededError');
  store.commit('x', rename('x'));
  assert.doesNotThrow(() => timers.fire());
  assert.equal(store.lastPersistError.name, 'QuotaExceededError');
  assert.deepEqual(log.map((e) => e.info.type), ['commit', 'persist']);
  assert.equal(log[1].state, store.getState());
  assert.equal(store.persist(), false);
  assert.equal(log.length, 2, 'a repeated failure is not news');
  store.commit('y', rename('y'));
  assert.equal(store.getState().layout.name, 'y');
  storage.failWrite = null;
  assert.equal(store.persist(), true);
  assert.equal(store.lastPersistError, null);
  assert.equal(log.at(-1).info.type, 'persist');
  assert.equal(JSON.parse(storage.data.get('logiplan:v1')).scenarios[0].layout.name, 'y');
});

test('a failing write keeps the previous good copy in storage', () => {
  const { store, storage } = makeStore();
  store.commit('x', rename('good'));
  store.persist();
  storage.failWrite = new Error('disk full');
  store.commit('y', rename('lost'));
  store.persist();
  assert.equal(JSON.parse(storage.data.get('logiplan:v1')).scenarios[0].layout.name, 'good');
});

test('without storage the store works, never schedules a timer and explains itself in lastPersistError', () => {
  const { store, timers } = makeStore({ storage: undefined });
  assert.ok(store.lastPersistError instanceof Error);
  store.commit('x', rename('x'));
  store.setUi({ theme: 'dark' });
  assert.equal(timers.pending.size, 0);
  assert.equal(store.persist(), false);
  assert.equal(store.restore(), false);
  const odd = createStore({ storage: { not: 'storage' } });
  assert.equal(odd.persist(), false);
});

test('the default storage is looked up defensively: a throwing localStorage getter does not break createStore', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError'); } });
  try {
    const store = createStore();
    assert.ok(store.lastPersistError instanceof Error);
    assert.equal(store.persist(), false);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('destroy flushes a pending autosave and detaches all listeners', () => {
  const { store, storage, timers } = makeStore();
  const log = record(store);
  store.commit('x', rename('last words'));
  store.destroy();
  assert.equal(timers.pending.size, 0);
  assert.equal(JSON.parse(storage.data.get('logiplan:v1')).scenarios[0].layout.name, 'last words');
  const count = log.length;
  store.commit('y', rename('after'));
  assert.equal(log.length, count);
});

// ---------------------------------------------------------------------------------------------------------
// property test: seeded random operations
// ---------------------------------------------------------------------------------------------------------

const TYPES = ['source', 'process', 'storage', 'sink', 'depot'];
const pickStation = (l, rng) => (l.stations.length ? l.stations[rng.int(l.stations.length)] : null);

/** Random edits through the real model API; each may be rejected or change nothing, which commit must cope with. */
const OPERATIONS = [
  ['Add station', (l, rng) => { L.addStation(l, { type: rng.pick(TYPES), x: rng.int(26), y: rng.int(14) }); }],
  ['Draw road', (l, rng) => {
    const x = rng.int(26);
    const y = rng.int(16);
    L.paintRoadPath(l, lPath(x, y, Math.min(29, x + rng.int(8)), Math.min(19, y + rng.int(5))), { oneWay: rng.next() < 0.3 });
  }],
  ['Erase road', (l, rng) => { L.eraseRoadCell(l, rng.int(30), rng.int(20)); }],
  ['Move station', (l, rng) => { const s = pickStation(l, rng); if (s) L.moveStation(l, s.id, rng.int(26), rng.int(14)); }],
  ['Remove station', (l, rng) => { const s = pickStation(l, rng); if (s) L.removeStation(l, s.id); }],
  ['Add flow', (l, rng) => { const a = pickStation(l, rng); const b = pickStation(l, rng); if (a && b) L.addFlow(l, a.id, b.id); }],
  ['Add fleet', (l, rng) => { L.addFleet(l, rng.pick(['agv', 'forklift', 'tugger'])); }],
  ['Fleet count', (l, rng) => { if (l.fleets.length) L.updateFleet(l, l.fleets[rng.int(l.fleets.length)].id, { count: rng.int(8) }); }],
  ['Add obstacle', (l, rng) => { L.addObstacle(l, { x: rng.int(28), y: rng.int(18), w: 1 + rng.int(2), h: 1, kind: 'rack' }); }],
  ['Add label', (l, rng) => { L.addLabel(l, { x: rng.range(0, 30), y: rng.range(0, 20), text: `Note ${rng.int(100)}` }); }],
  ['Rename plant', (l, rng) => { L.setName(l, `Plant ${rng.int(5)}`); }],
  ['Settings', (l, rng) => { L.updateSettings(l, { demandFactor: 0.5 + rng.int(4) / 2, dispatch: rng.pick(['nearest', 'oldest', 'balanced']) }); }],
  ['Resize grid', (l, rng) => { L.resizeGrid(l, 24 + rng.int(12), 16 + rng.int(8)); }],
];

function randomStore(seed) {
  const rng = createRng(seed);
  const { store, clock } = makeStore();
  const start = L.createLayout({ name: 'Random', cols: 30, rows: 20 });
  L.paintRoadPath(start, lPath(1, 8, 25, 8));
  store.newProject(start);
  return { store, clock, rng };
}

function randomEdit(store, clock, rng) {
  const [label, op] = OPERATIONS[rng.int(OPERATIONS.length)];
  clock.advance(COALESCE_MS + 1); // never coalesce in this test: every successful commit is one step
  return store.commit(label, (l) => op(l, rng));
}

for (const seed of [1, 7, 42, 2024, 99999]) {
  test(`property (seed ${seed}): undoing every step returns the initial layout, redoing every step returns the final one`, () => {
    const { store, clock, rng } = randomStore(seed);
    const initial = structuredClone(store.getState().layout);
    let committed = 0;
    for (let i = 0; i < 80; i++) {
      if (randomEdit(store, clock, rng)) committed++;
      assert.deepEqual(L.checkInvariants(store.getState().layout), []);
    }
    assert.ok(committed > 15, `the random walk should do real work (${committed} edits)`);
    const final = structuredClone(store.getState().layout);
    let undone = 0;
    while (store.undo()) undone++;
    assert.equal(undone, committed);
    assert.deepEqual(store.getState().layout, initial);
    let redone = 0;
    while (store.redo()) redone++;
    assert.equal(redone, committed);
    assert.deepEqual(store.getState().layout, final);
  });
}

for (const seed of [3, 11, 5150]) {
  test(`property (seed ${seed}): random edits, undos and redos always agree with a simple timeline model`, () => {
    const { store, clock, rng } = randomStore(seed);
    const timeline = [structuredClone(store.getState().layout)];
    let cursor = 0;
    for (let i = 0; i < 300; i++) {
      const roll = rng.next();
      if (roll < 0.6) {
        if (randomEdit(store, clock, rng)) {
          timeline.splice(cursor + 1);
          timeline.push(structuredClone(store.getState().layout));
          cursor++;
          while (cursor > HISTORY_LIMIT) {
            timeline.shift();
            cursor--;
          }
        }
      } else if (roll < 0.8) {
        assert.equal(store.undo(), cursor > 0);
        if (cursor > 0) cursor--;
      } else {
        assert.equal(store.redo(), cursor < timeline.length - 1);
        if (cursor < timeline.length - 1) cursor++;
      }
      const s = store.getState();
      assert.deepEqual(s.layout, timeline[cursor], `step ${i}`);
      assert.equal(s.canUndo, cursor > 0);
      assert.equal(s.canRedo, cursor < timeline.length - 1);
      assert.deepEqual(L.checkInvariants(s.layout), []);
    }
  });
}
