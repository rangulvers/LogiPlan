// Test helper for the adversarial review of js/store/store.js and js/ui/runner.js (tests/store.review.test.js).
//
//   createClock()                 one virtual clock for `now` AND timers: clock.advance(ms) fires the timers that fall due
//   createStorage(opts)           a localStorage stand-in with a quota (UTF-16 units, like browsers) and failure switches
//   bigLayout(opts)               a ~300 KB plant (160 x 160 cells, ~15k road cells) for cost and memory measurements
//   randomEdit(rng, layout)       { label, run(draft) }: a random edit built from the layout.js mutators (some are no-ops)
//   createReference(opts)         a deliberately naive model of the store: plain arrays, deep copies, no sharing
//   makeRunnerRig(opts)           store + runner + fake renderer/document/animation frames/clock + a scriptable fake Simulation
//
// The reference model is the oracle of the model-based test: it implements the documented semantics of the store (history
// per scenario, coalescing bursts, selection pruning, dirty flag) in the most obvious way, with every snapshot a private
// deep copy. If the store and the model ever disagree, one of them is wrong - and the model is short enough to read.

import assert from 'node:assert/strict';
import * as L from '../../js/model/layout.js';
import { createStore } from '../../js/store/store.js';
import { createRunner } from '../../js/ui/runner.js';
import { cellKey } from '../../js/util/grid.js';

// ---------------------------------------------------------------------------------------------------------
// clock, storage
// ---------------------------------------------------------------------------------------------------------

/** Virtual time in ms plus setTimeout/clearTimeout that obey it. */
export function createClock() {
  let t = 0;
  let seq = 0;
  const pending = new Map();
  const clock = {
    now: () => t,
    setTimeout(fn, ms) {
      const id = ++seq;
      pending.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    /** Move time forward by `ms`, firing due timers in order (a timer may schedule further timers). */
    advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, timer] of pending) {
          if (timer.at <= end && (next === null || timer.at < next.timer.at || (timer.at === next.timer.at && id < next.id))) next = { id, timer };
        }
        if (next === null) break;
        pending.delete(next.id);
        t = Math.max(t, next.timer.at);
        next.timer.fn();
      }
      t = end;
    },
    get timers() {
      return pending.size;
    },
  };
  return clock;
}

/** localStorage stand-in. `quota` counts UTF-16 units of keys plus values, as browsers do. */
export function createStorage({ quota = Infinity, initial = {} } = {}) {
  const data = new Map(Object.entries(initial));
  const used = (exceptKey, key, value) => {
    let n = key.length + value.length;
    for (const [k, v] of data) if (k !== exceptKey) n += k.length + v.length;
    return n;
  };
  const storage = {
    data,
    attempts: 0,
    writes: 0,
    failRead: null,
    failWrite: null,
    getItem(key) {
      if (storage.failRead) throw storage.failRead;
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      storage.attempts++;
      if (storage.failWrite) throw storage.failWrite;
      const text = String(value);
      if (used(key, key, text) > quota) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
      storage.writes++;
      data.set(key, text);
    },
    removeItem(key) {
      data.delete(key);
    },
  };
  return storage;
}

/** A store wired to a virtual clock, a fake storage and an error log. */
export function makeRig({ storage = createStorage(), storageKey } = {}) {
  const clock = createClock();
  const errors = [];
  const store = createStore({
    storage,
    ...(storageKey ? { storageKey } : {}),
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onError: (err, context) => errors.push({ err, context }),
  });
  return { store, clock, storage, errors };
}

// ---------------------------------------------------------------------------------------------------------
// layouts and edits
// ---------------------------------------------------------------------------------------------------------

const NEIGHBOURS = [[0, -1, 1], [1, 0, 2], [0, 1, 4], [-1, 0, 8]];

/**
 * A big, valid, realistic-looking plant: a street grid (every 3rd row and column is a two-way road, a quarter of the
 * cells carry a slow-zone limit), 2 x 2 free blocks with stations in them, flows and two fleets. At 160 x 160 it has
 * ~14,000 road cells and is ~300 KB of JSON.
 */
export function bigLayout({ cols = 160, rows = 160 } = {}) {
  const layout = L.createLayout({ name: 'Big plant', cols, rows });
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) if (y % 3 === 0 || x % 3 === 0) layout.roads[cellKey(x, y)] = { out: 0 };
  }
  for (const key of Object.keys(layout.roads)) {
    const [cx, cy] = key.split(',').map(Number);
    let out = 0;
    for (const [dx, dy, bit] of NEIGHBOURS) if (layout.roads[cellKey(cx + dx, cy + dy)]) out |= bit;
    layout.roads[key].out = out;
    if ((cx * 7 + cy * 13) % 4 === 0) layout.roads[key].limit = 0.5;
  }
  const types = ['source', 'process', 'process', 'storage', 'sink'];
  let n = 0;
  for (let by = 1; by + 2 < rows && n < 120; by += 3) {
    for (let bx = 1; bx + 2 < cols && n < 120; bx += 3) {
      if (L.addStation(layout, { type: types[n % types.length], x: bx, y: by, w: 2, h: 2 })) n++;
    }
  }
  const ids = layout.stations.map((s) => s.id);
  for (let i = 0; i + 1 < ids.length && layout.flows.length < 60; i++) L.addFlow(layout, ids[i], ids[i + 1]);
  L.addFleet(layout, 'agv', { count: 8 });
  L.addFleet(layout, 'forklift', { count: 3 });
  assert.deepEqual(L.checkInvariants(layout), [], 'the big fixture must be a valid layout');
  return layout;
}

const STATION_KINDS = ['source', 'process', 'storage', 'sink', 'depot'];
const idOf = (rng, list, fallback = 'missing') => (list.length ? rng.pick(list).id : fallback);
/** An id to delete: only while `list` is longer than `keep`, so that long random scripts keep a plant to edit. */
const idToDelete = (rng, list, keep) => (list.length > keep ? rng.pick(list).id : 'missing');

/** [label, (rng, layout) => run(draft)]: parameters are drawn at build time so run() is deterministic on any copy. */
const addStationEdit = ['Add station', (rng, l) => {
  const spec = { type: rng.pick(STATION_KINDS), x: rng.int(l.grid.cols - 3), y: rng.int(l.grid.rows - 3) };
  return (d) => { L.addStation(d, spec); };
}];
const EDITS = [
  addStationEdit,
  addStationEdit,
  ['Move station', (rng, l) => {
    const id = idOf(rng, l.stations);
    const x = rng.int(l.grid.cols - 3);
    const y = rng.int(l.grid.rows - 3);
    return (d) => { L.moveStation(d, id, x, y); };
  }],
  ['Resize station', (rng, l) => {
    const s = l.stations.length ? rng.pick(l.stations) : null;
    const rect = s ? { x: s.x, y: s.y, w: 1 + rng.int(4), h: 1 + rng.int(4) } : null;
    return (d) => { if (s) L.resizeStation(d, s.id, rect); };
  }],
  ['Station parameters', (rng, l) => {
    const id = idOf(rng, l.stations.filter((s) => s.type === 'process'));
    const machines = 1 + rng.int(4);
    return (d) => { L.updateStation(d, id, { params: { machines } }); };
  }],
  ['Delete station', (rng, l) => {
    const id = idToDelete(rng, l.stations, 6);
    return (d) => { L.removeStation(d, id); };
  }],
  ['Add flow', (rng, l) => {
    const from = idOf(rng, l.stations);
    const to = idOf(rng, l.stations);
    return (d) => { L.addFlow(d, from, to); };
  }],
  ['Delete flow', (rng, l) => {
    const id = idToDelete(rng, l.flows, 3);
    return (d) => { L.removeFlow(d, id); };
  }],
  ['Add fleet', (rng) => {
    const preset = rng.pick(['agv', 'forklift', 'tugger']);
    return (d) => { L.addFleet(d, preset); };
  }],
  ['Fleet size', (rng, l) => {
    const id = idOf(rng, l.fleets);
    const count = rng.int(6);
    return (d) => { L.updateFleet(d, id, { count }); };
  }],
  ['Delete fleet', (rng, l) => {
    const id = idToDelete(rng, l.fleets, 2);
    return (d) => { L.removeFleet(d, id); };
  }],
  ['Draw road', (rng, l) => {
    const x = rng.int(l.grid.cols);
    const y = rng.int(l.grid.rows);
    const cells = [[x, y], [Math.min(l.grid.cols - 1, x + rng.int(7)), Math.min(l.grid.rows - 1, y + rng.int(5))]];
    const oneWay = rng.next() < 0.3;
    return (d) => { L.paintRoadPath(d, cells, { oneWay }); };
  }],
  ['Erase road', (rng, l) => {
    const keys = Object.keys(l.roads);
    const [cx, cy] = (keys.length ? rng.pick(keys) : '0,0').split(',').map(Number);
    return (d) => { L.eraseRoadCell(d, cx, cy); };
  }],
  ['Speed zone', (rng, l) => {
    const keys = Object.keys(l.roads);
    const [cx, cy] = (keys.length ? rng.pick(keys) : '0,0').split(',').map(Number);
    const limit = rng.pick([0.3, 0.5, 1]);
    return (d) => { L.setRoadLimit(d, cx, cy, limit); };
  }],
  ['Add label', (rng, l) => {
    const spec = { x: rng.int(l.grid.cols), y: rng.int(l.grid.rows), text: `Note ${rng.int(100)}` };
    return (d) => { L.addLabel(d, spec); };
  }],
  ['Delete label', (rng, l) => {
    const id = idOf(rng, l.labels);
    return (d) => { L.removeLabel(d, id); };
  }],
  ['Add obstacle', (rng, l) => {
    const spec = { x: rng.int(l.grid.cols - 1), y: rng.int(l.grid.rows - 1), w: 1, h: 1, kind: rng.pick(['wall', 'rack', 'column']) };
    return (d) => { L.addObstacle(d, spec); };
  }],
  ['Rename plant', (rng) => {
    const name = `Plant ${rng.int(5)}`;
    return (d) => { L.setName(d, name); };
  }],
  ['Demand factor', (rng) => {
    const demandFactor = 0.5 + rng.int(6) / 4;
    return (d) => { L.updateSettings(d, { demandFactor }); };
  }],
  ['Tick length', (rng) => {
    const dt = rng.pick([0.05, 0.1, 0.2]);
    return (d) => { L.updateSettings(d, { dt }); };
  }],
  ['Resize grid', (rng, l) => {
    const cols = Math.max(32, l.grid.cols + rng.int(7) - 2);
    const rows = Math.max(24, l.grid.rows + rng.int(7) - 2);
    return (d) => { L.resizeGrid(d, cols, rows); };
  }],
  ['Rejected edit', () => () => false],
  ['No-op edit', () => (d) => { d.name = d.name; d.settings.demandFactor = d.settings.demandFactor; }],
];

/** A random edit for `layout` (ids, positions and values drawn from `rng`). */
export function randomEdit(rng, layout) {
  const [label, make] = rng.pick(EDITS);
  return { label, run: make(rng, layout) };
}

// ---------------------------------------------------------------------------------------------------------
// the reference model
// ---------------------------------------------------------------------------------------------------------

/** Order-independent deep equality of plain JSON values. */
export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return Object.is(a, b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
}

const KINDS = ['station', 'flow', 'fleet', 'obstacle', 'label', 'cell'];
const NOTHING = () => ({ kind: null, ids: [] });

/**
 * The store as a plain state machine. Every method returns what the store should return; the test asserts both agree and
 * then compares the whole observable state with `expect(state)`.
 *   burst rule: a keyed commit joins the undo step on top iff that step was made by a keyed commit with the same key at most
 *   `coalesceMs` earlier and nothing but ui changes happened since; a burst that ends where it began leaves no step.
 */
export function createReference({ historyLimit, coalesceMs }) {
  const initial = L.createLayout();
  const scenario = (id, name, layout) => ({ id, name, layout, undo: [], redo: [], burst: null });
  const ref = {
    projectName: initial.name,
    scenarios: [scenario('sc1', 'A', initial)],
    activeId: 'sc1',
    dirty: false,
    selection: NOTHING(),
  };
  const active = () => ref.scenarios.find((s) => s.id === ref.activeId);
  const copy = (v) => structuredClone(v);
  const capped = (list) => { if (list.length > historyLimit) list.shift(); };

  const exists = (kind, id, layout) => {
    if (kind === 'cell') return Object.hasOwn(layout.roads, id);
    const list = { station: layout.stations, flow: layout.flows, fleet: layout.fleets, obstacle: layout.obstacles, label: layout.labels }[kind];
    return list.some((item) => item.id === id);
  };
  const cellId = (id) => {
    if (typeof id === 'string') return /^\d+,\d+$/.test(id) ? id : null;
    return Array.isArray(id) && id.length === 2 && id.every(Number.isInteger) ? `${id[0]},${id[1]}` : null;
  };
  const select = (kind, ids) => {
    const raw = Array.isArray(ids) ? ids : (ids == null ? [] : [ids]);
    const kept = [];
    if (KINDS.includes(kind)) {
      for (const candidate of raw) {
        const id = kind === 'cell' ? cellId(candidate) : candidate;
        if (id !== null && !kept.includes(id) && exists(kind, id, active().layout)) kept.push(id);
      }
    }
    ref.selection = kept.length ? { kind, ids: kept } : NOTHING();
  };
  const prune = () => select(ref.selection.kind, ref.selection.ids);
  const leave = () => { active().burst = null; };

  Object.assign(ref, {
    historyLimit,
    select,
    clearSelection: () => { ref.selection = NOTHING(); },

    commit(label, run, key, now) {
      const sc = active();
      const draft = copy(sc.layout);
      if (run(draft) === false || deepEqual(draft, sc.layout)) return false;
      const b = sc.burst;
      if (key && b && b.key === key && now - b.at <= coalesceMs && sc.undo[sc.undo.length - 1] === b.step) {
        b.at = now;
        if (deepEqual(b.step.layout, draft)) {
          sc.undo.pop();
          sc.burst = null;
          sc.layout = copy(b.step.layout);
        } else {
          sc.layout = draft;
        }
      } else {
        const step = { label, layout: sc.layout };
        sc.undo.push(step);
        capped(sc.undo);
        sc.burst = key ? { key, at: now, step } : null;
        sc.layout = draft;
      }
      sc.redo = [];
      ref.dirty = true;
      prune();
      return true;
    },

    undo() {
      const sc = active();
      const step = sc.undo.pop();
      if (!step) return false;
      sc.redo.push({ label: step.label, layout: sc.layout });
      sc.layout = step.layout;
      sc.burst = null;
      ref.dirty = true;
      prune();
      return true;
    },

    redo() {
      const sc = active();
      const step = sc.redo.pop();
      if (!step) return false;
      sc.undo.push({ label: step.label, layout: sc.layout });
      capped(sc.undo);
      sc.layout = step.layout;
      sc.burst = null;
      ref.dirty = true;
      prune();
      return true;
    },

    replace(raw, label) {
      const sc = active();
      const next = L.normalizeLayout(copy(raw));
      if (deepEqual(next, sc.layout)) return false;
      sc.undo.push({ label, layout: sc.layout });
      capped(sc.undo);
      sc.redo = [];
      sc.burst = null;
      sc.layout = next;
      ref.dirty = true;
      ref.clearSelection();
      return true;
    },

    switchTo(id) {
      if (id === ref.activeId || !ref.scenarios.some((s) => s.id === id)) return false;
      leave();
      ref.activeId = id;
      ref.clearSelection();
      return true;
    },

    /** The store chose `id` and `name`; the model checks the rest (copy of the layout, activation, dirty). */
    add(id, name, layout) {
      leave();
      ref.scenarios.push(scenario(id, name, copy(layout)));
      ref.activeId = id;
      ref.dirty = true;
      ref.clearSelection();
    },

    remove(id) {
      const index = ref.scenarios.findIndex((s) => s.id === id);
      if (index < 0 || ref.scenarios.length === 1) return false;
      const wasActive = id === ref.activeId;
      ref.scenarios.splice(index, 1);
      if (wasActive) {
        ref.activeId = (ref.scenarios[index - 1] || ref.scenarios[index]).id;
        ref.clearSelection();
      }
      ref.dirty = true;
      return true;
    },

    setScenarioName(id, name) {
      ref.scenarios.find((s) => s.id === id).name = name;
      ref.dirty = true;
    },

    renameProject(name) {
      if (name === ref.projectName) return false;
      ref.projectName = name;
      ref.dirty = true;
      return true;
    },

    markClean() {
      const was = ref.dirty;
      ref.dirty = false;
      return was;
    },

    /** A whole new document: empty histories, clean, nothing selected. */
    load(name, scenarios, activeId) {
      ref.projectName = name;
      ref.scenarios = scenarios.map((s) => scenario(s.id, s.name, copy(s.layout)));
      ref.activeId = activeId;
      ref.dirty = false;
      ref.clearSelection();
    },

    /** persist() + restore(): same content and dirty flag, but a new document without histories. */
    persistRestore() {
      for (const sc of ref.scenarios) {
        sc.undo = [];
        sc.redo = [];
        sc.burst = null;
      }
      ref.clearSelection();
    },

    activeScenario: active,

    /** Assert that the store state shows exactly what the model says. */
    expect(state) {
      const sc = active();
      assert.equal(state.project.name, ref.projectName, 'project name');
      assert.deepEqual(state.project.scenarios.map((s) => [s.id, s.name]), ref.scenarios.map((s) => [s.id, s.name]), 'scenario ids and names');
      assert.equal(state.project.activeId, ref.activeId, 'active scenario');
      state.project.scenarios.forEach((s, i) => assert.ok(deepEqual(s.layout, ref.scenarios[i].layout), `layout of scenario ${s.id}`));
      assert.equal(state.layout, state.project.scenarios.find((s) => s.id === ref.activeId).layout, 'state.layout is the active scenario layout');
      assert.equal(state.canUndo, sc.undo.length > 0, 'canUndo');
      assert.equal(state.canRedo, sc.redo.length > 0, 'canRedo');
      assert.equal(state.undoLabel, sc.undo.length ? sc.undo[sc.undo.length - 1].label : null, 'undoLabel');
      assert.equal(state.redoLabel, sc.redo.length ? sc.redo[sc.redo.length - 1].label : null, 'redoLabel');
      assert.equal(state.dirty, ref.dirty, 'dirty');
      assert.deepEqual({ kind: state.ui.selection.kind, ids: [...state.ui.selection.ids] }, ref.selection, 'selection');
      const names = state.project.scenarios.map((s) => s.name.toLowerCase());
      assert.equal(new Set(names).size, names.length, 'scenario names are unique');
      assert.deepEqual(L.checkInvariants(state.layout), [], 'layout invariants');
    },
  });
  return ref;
}

// ---------------------------------------------------------------------------------------------------------
// runner rig
// ---------------------------------------------------------------------------------------------------------

/**
 * A runner on a real store with everything else faked and scriptable: animation frames (exactly one may be scheduled),
 * clock, page visibility, renderer, and a Simulation that mimics the engine (whole ticks, request rounded UP).
 * `knobs` can be changed while a test runs: dt (read when a sim is built), capacity (sim seconds one advance() call can do),
 * failAdvance (message), failConstruct (message).
 */
export function makeRunnerRig({ knobs: initialKnobs = {}, SimulationClass, runner: runnerOptions = {}, observe = true, wrapStore } = {}) {
  const knobs = { dt: 0.1, capacity: Infinity, failAdvance: null, failConstruct: null, ...initialKnobs };
  class FakeSim {
    constructor(layout) {
      if (knobs.failConstruct) throw new Error(knobs.failConstruct);
      this.layout = layout;
      this.dt = knobs.dt;
      this.ticks = 0;
      this.advances = [];
      this.runtimePatches = [];
      FakeSim.instances.push(this);
    }

    get time() {
      return this.ticks * this.dt;
    }

    advance(seconds, opts = {}) {
      this.advances.push({ seconds, maxMillis: opts.maxMillis });
      if (knobs.failAdvance) throw new Error(knobs.failAdvance);
      if (!(seconds > 0)) return 0;
      const wanted = Math.ceil((seconds - this.dt * 1e-6) / this.dt);
      const n = Math.max(0, Math.min(wanted, Math.floor(knobs.capacity / this.dt)));
      this.ticks += n;
      return n * this.dt;
    }

    setRuntime(patch) {
      this.runtimePatches.push(patch);
    }

    kpis() {
      return { at: this.time };
    }

    insights() {
      return [];
    }
  }
  FakeSim.instances = [];
  const Sim = SimulationClass ?? FakeSim;

  const clock = { t: 10_000 };
  const scheduled = new Map();
  const cancelled = [];
  let handle = 0;
  const raf = (cb) => {
    scheduled.set(++handle, cb);
    return handle;
  };
  const caf = (h) => {
    cancelled.push(h);
    scheduled.delete(h);
  };
  const store = createStore({ storage: undefined, onError: () => {} });
  const renderer = {
    sim: null,
    layout: null,
    renders: [],
    render(alpha) {
      this.renders.push({ alpha, time: this.sim ? this.sim.time : null });
    },
  };
  const visibility = new Set();
  const document = {
    hidden: false,
    addEventListener: (type, fn) => { if (type === 'visibilitychange') visibility.add(fn); },
    removeEventListener: (type, fn) => { if (type === 'visibilitychange') visibility.delete(fn); },
    setHidden(hidden) {
      document.hidden = hidden;
      for (const fn of [...visibility]) fn();
    },
  };
  const reported = [];
  const runner = createRunner({
    store: wrapStore ? wrapStore(store) : store, renderer, raf, caf, now: () => clock.t, document, SimulationClass: Sim,
    onError: (err, context) => reported.push({ err, context }),
    ...runnerOptions,
  });
  const events = [];
  if (observe) for (const name of ['state', 'frame', 'kpis', 'rebuild', 'error']) runner.on(name, (payload) => events.push([name, payload]));

  let stationCount = 0;
  const rig = {
    knobs, FakeSim, store, renderer, document, runner, clock, events, reported, cancelled, scheduled, visibility,
    /** Run the one scheduled animation frame `ms` after the previous time. */
    frame(ms = 16) {
      assert.equal(scheduled.size, 1, 'exactly one animation frame must be scheduled');
      clock.t += ms;
      const [h, cb] = [...scheduled][0];
      scheduled.delete(h);
      cb(clock.t);
    },
    frames(n, ms = 16) {
      for (let i = 0; i < n; i++) rig.frame(ms);
    },
    of: (name) => events.filter(([n]) => n === name).map(([, payload]) => payload),
    sims: () => Sim.instances ?? FakeSim.instances,
    /** A structural edit that is always new: one more source station. */
    addStation: () => store.commit('Add station', (l) => { L.addStation(l, { type: 'source', x: 2 + 5 * (stationCount++ % 8), y: 2 + 4 * Math.floor(stationCount / 8) }); }),
  };
  return rig;
}
