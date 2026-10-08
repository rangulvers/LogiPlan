// Adversarial review of js/store/store.js and js/ui/runner.js.
//
// Tests named "DEFECT <id>" assert the behaviour a planner needs; they FAILED on the code as reviewed (they are the findings)
// and pass since the fix pass, so they now guard against the findings coming back. Everything else is a regression net the
// reviewed code already passed (model-based, property and fuzz tests). Severity in the test names: high = lost work /
// corrupted history / crash / runaway loop, medium = wrong semantics in plausible use, low = polish or misuse hardening.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createStore, HISTORY_LIMIT, COALESCE_MS, PERSIST_DEBOUNCE_MS } from '../js/store/store.js';
import { MAX_FRAME_SECONDS, REBUILD_DEBOUNCE_MS, SPEEDS } from '../js/ui/runner.js';
import { Simulation } from '../js/sim/engine.js';
import { EXAMPLES } from '../js/model/examples.js';
import * as L from '../js/model/layout.js';
import { importProject } from '../js/model/serialize.js';
import { createRng } from '../js/util/rng.js';
import {
  bigLayout, createClock, createReference, createStorage, deepEqual, makeRig, makeRunnerRig, randomEdit,
} from './helpers/store-review-gen.js';

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

// =========================================================================================================
// STORE: model-based test - random interleavings against a naive reference
// =========================================================================================================

const PROFILES = {
  // many kinds of operations, so that scenario switches, deletes, loads and undo all meet
  mixed: { commit: 26, keyed: 18, burst: 8, undo: 9, redo: 7, switchTo: 5, add: 2, duplicate: 2, remove: 3, rename: 2, select: 5, setUi: 3, clear: 1, replace: 1, clean: 1, project: 1, persist: 1, probe: 1, load: 1 },
  // commit heavy and one scenario most of the time, so that the history cap (100) is reached and exceeded
  deep: { commit: 62, keyed: 28, undo: 2, redo: 1, select: 3, setUi: 1, probe: 1 },
};

/** Pick a key of `weights` with probability proportional to its weight. */
function pickWeighted(rng, weights) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let x = rng.next() * total;
  for (const [name, w] of Object.entries(weights)) {
    x -= w;
    if (x < 0) return name;
  }
  return Object.keys(weights)[0];
}

function selectionTarget(rng, layout) {
  const kind = rng.pick(['station', 'flow', 'fleet', 'obstacle', 'label', 'cell', 'cell', 'nonsense']);
  const lists = { station: layout.stations, flow: layout.flows, fleet: layout.fleets, obstacle: layout.obstacles, label: layout.labels };
  let ids;
  if (kind === 'cell') {
    const keys = Object.keys(layout.roads);
    ids = [];
    for (let i = 0; i < 1 + rng.int(3); i++) {
      const key = keys.length ? rng.pick(keys) : '0,0';
      ids.push(rng.next() < 0.5 ? key : key.split(',').map(Number));
    }
  } else {
    const list = lists[kind] ?? [];
    ids = list.length ? [rng.pick(list).id, rng.pick(list).id] : [];
    if (rng.next() < 0.3) ids.push('ghost');
  }
  return { kind, ids };
}

/**
 * Run `steps` random operations against the store AND the reference and compare after each. Throws (with the seed, step and
 * operation) at the first disagreement. Also checks per notification: strictly growing version, `layoutChanged` agrees with
 * identity, `kind` agrees with layoutChangeKind, and a ui-only change keeps `project` and `layout` identical.
 */
function runModelScript(seed, steps, profileName) {
  const rng = createRng(seed);
  const rig = makeRig();
  const { store, clock } = rig;
  const ref = createReference({ historyLimit: HISTORY_LIMIT, coalesceMs: COALESCE_MS });
  const weights = PROFILES[profileName];
  const trace = [];
  let counter = 0;

  let previous = store.getState();
  store.subscribe((state, info) => {
    if (info.type === 'persist') {
      assert.equal(state, previous, 'a persist notification repeats the state');
      return;
    }
    assert.ok(state.version > previous.version, 'version grows with every notification');
    assert.equal(info.layoutChanged, state.layout !== previous.layout, `layoutChanged agrees with identity (${info.type})`);
    assert.equal(info.kind, info.layoutChanged ? L.layoutChangeKind(previous.layout, state.layout) : 'none', `kind agrees with layoutChangeKind (${info.type})`);
    if (info.type === 'ui') {
      assert.equal(state.project, previous.project, 'a ui change keeps project identity');
      assert.equal(state.layout, previous.layout, 'a ui change keeps layout identity');
    }
    if (info.type === 'commit') {
      for (const s of previous.project.scenarios) {
        if (s.id !== state.project.activeId) assert.equal(state.project.scenarios.find((x) => x.id === s.id), s, 'a commit leaves other scenarios untouched');
      }
      assert.equal(state.ui.overlays, previous.ui.overlays, 'a commit leaves overlays untouched');
    }
    assert.ok(Object.isFrozen(state) && Object.isFrozen(state.ui) && Object.isFrozen(state.project), 'state is frozen');
    previous = state;
  });

  const walk = (direction) => {
    const method = direction === 'undo' ? 'undo' : 'redo';
    for (let n = 0; ; n++) {
      const a = store[method]();
      const b = ref[method]();
      assert.equal(a, b, `${method} result`);
      if (!a) return n;
      ref.expect(store.getState());
    }
  };

  const op = {
    commit() {
      const e = randomEdit(rng, ref.activeScenario().layout);
      trace.push(`commit ${e.label}`);
      clock.advance(rng.int(300));
      const a = store.commit(e.label, e.run);
      const b = ref.commit(e.label, e.run, null, clock.now());
      assert.equal(a, b, 'commit result');
    },
    keyed() {
      const e = randomEdit(rng, ref.activeScenario().layout);
      const key = rng.pick(['a', 'a', 'b']);
      const delta = rng.pick([0, 10, 400, COALESCE_MS - 1, COALESCE_MS, COALESCE_MS + 1, 2000]);
      trace.push(`keyed ${key} +${delta} ${e.label}`);
      clock.advance(delta);
      const a = store.commit(e.label, e.run, { coalesce: key });
      const b = ref.commit(e.label, e.run, key, clock.now());
      assert.equal(a, b, 'keyed commit result');
    },
    undo() {
      trace.push('undo');
      assert.equal(store.undo(), ref.undo(), 'undo result');
    },
    redo() {
      trace.push('redo');
      assert.equal(store.redo(), ref.redo(), 'redo result');
    },
    switchTo() {
      const target = rng.pick([...ref.scenarios.map((s) => s.id), 'nope']);
      trace.push(`switch ${target}`);
      assert.equal(store.switchScenario(target), ref.switchTo(target), 'switch result');
    },
    add() {
      const own = rng.next() < 0.5 ? L.normalizeLayout(randomEditApplied(rng, ref.activeScenario().layout)) : null;
      const name = rng.next() < 0.5 ? `Variant ${counter++}` : undefined;
      trace.push(`add ${name} ${own ? 'own layout' : 'copy'}`);
      const source = ref.activeScenario().layout;
      const id = store.addScenario(name, own);
      assert.ok(id !== null);
      const entry = store.getState().project.scenarios.find((s) => s.id === id);
      assert.ok(!ref.scenarios.some((s) => s.id === id), 'a new scenario gets a fresh id');
      if (name) assert.ok(entry.name.startsWith('Variant'), 'the wanted name is kept (renumbered if taken)');
      ref.add(id, entry.name, own ?? source);
    },
    duplicate() {
      const src = rng.pick(ref.scenarios);
      trace.push(`duplicate ${src.id}`);
      const id = store.duplicateScenario(src.id);
      assert.ok(id !== null);
      const entry = store.getState().project.scenarios.find((s) => s.id === id);
      assert.ok(entry.name.startsWith(src.name), 'a copy is named after its source');
      ref.add(id, entry.name, src.layout);
    },
    remove() {
      const target = rng.pick(ref.scenarios).id;
      trace.push(`remove ${target}`);
      assert.equal(store.deleteScenario(target), ref.remove(target), 'delete result');
    },
    rename() {
      const target = rng.pick(ref.scenarios);
      const wanted = rng.pick(['B', 'a', 'Variant 1', 'Base case', '  ', 'A copy']);
      trace.push(`rename ${target.id} ${wanted}`);
      const changed = store.renameScenario(target.id, wanted);
      const now = store.getState().project.scenarios.find((s) => s.id === target.id).name;
      assert.equal(changed, now !== target.name, 'rename reports whether the name changed');
      if (changed) ref.setScenarioName(target.id, now);
    },
    select() {
      const t = selectionTarget(rng, ref.activeScenario().layout);
      trace.push(`select ${t.kind}`);
      store.select(t.kind, t.ids);
      ref.select(t.kind, t.ids);
    },
    setUi() {
      trace.push('setUi');
      store.setUi(rng.pick([{ theme: 'dark' }, { tool: 'road' }, { overlays: { grid: false } }, { overlays: { heat: 'traffic' } }, { rightTab: 'results' }, { followSim: true }, { bogus: 1 }, { theme: 'nonsense' }]));
    },
    clear() {
      trace.push('clearSelection');
      store.clearSelection();
      ref.clearSelection();
    },
    replace() {
      const next = randomEditApplied(rng, ref.activeScenario().layout);
      trace.push('replaceLayout');
      assert.equal(store.replaceLayout(next, { label: 'Load example' }), ref.replace(next, 'Load example'), 'replace result');
    },
    clean() {
      trace.push('markClean');
      assert.equal(store.markClean(), ref.markClean(), 'markClean result');
    },
    project() {
      const name = `Project ${rng.int(3)}`;
      trace.push(`renameProject ${name}`);
      assert.equal(store.renameProject(name), ref.renameProject(name), 'renameProject result');
    },
    persist() {
      trace.push('persist+restore');
      assert.equal(store.persist(), true);
      assert.equal(store.restore(), true);
      ref.persistRestore();
    },
    load() {
      const count = 1 + rng.int(3);
      const scenarios = [];
      for (let i = 0; i < count; i++) scenarios.push({ id: `p${i + 1}`, name: `P${i + 1}`, layout: randomEditApplied(rng, L.createLayout({ name: `Loaded ${i}` })) });
      const activeId = rng.pick(scenarios).id;
      trace.push(`loadProject x${count}`);
      store.loadProject({ name: 'Loaded project', scenarios, activeId });
      ref.load('Loaded project', scenarios.map((s) => ({ ...s, layout: L.normalizeLayout(s.layout) })), activeId);
    },
    /**
     * A slider drag (keyed commits) with something else happening in the middle: whatever it is, the model says whether the
     * drag stays one undo step. Toggling between a few values also makes bursts that end where they began.
     */
    burst() {
      const key = rng.pick(['a', 'b']);
      const drag = (wait) => {
        const demandFactor = rng.pick([1, 1.25, 1.5]);
        const run = (d) => { L.updateSettings(d, { demandFactor }); };
        clock.advance(wait);
        assert.equal(store.commit('Demand', run, { coalesce: key }), ref.commit('Demand', run, key, clock.now()), 'drag commit result');
      };
      const others = ref.scenarios.filter((x) => x.id !== ref.activeId);
      const disruptor = rng.pick(['switchAndBack', 'undoRedo', 'select', 'ui', 'clean', 'project', 'persist', 'replace', 'removeOther', 'none']);
      trace.push(`burst ${key} with ${disruptor}`);
      drag(0);
      clock.advance(20);
      if (disruptor === 'switchAndBack' && others.length) {
        const home = ref.activeId;
        const away = rng.pick(others).id;
        assert.equal(store.switchScenario(away), ref.switchTo(away));
        assert.equal(store.switchScenario(home), ref.switchTo(home));
      } else if (disruptor === 'undoRedo') {
        assert.equal(store.undo(), ref.undo());
        assert.equal(store.redo(), ref.redo());
      } else if (disruptor === 'select') op.select();
      else if (disruptor === 'ui') op.setUi();
      else if (disruptor === 'clean') assert.equal(store.markClean(), ref.markClean());
      else if (disruptor === 'project') op.project();
      else if (disruptor === 'persist') op.persist();
      else if (disruptor === 'replace') op.replace();
      else if (disruptor === 'removeOther' && others.length) {
        const gone = rng.pick(others).id;
        assert.equal(store.deleteScenario(gone), ref.remove(gone));
      }
      drag(30);
      drag(30);
    },

    probe() {
      trace.push('probe (undo all, redo all)');
      const pending = ref.activeScenario().redo.length;
      const undone = walk('undo');
      assert.equal(store.getState().canUndo, false);
      const redone = walk('redo');
      assert.equal(redone, undone + pending, 'redo walks back every step undone plus those that were already waiting');
      assert.equal(store.getState().canRedo, false);
    },
  };

  try {
    ref.expect(store.getState());
    for (let i = 0; i < steps; i++) {
      op[pickWeighted(rng, weights)]();
      clock.advance(rng.int(200));
      ref.expect(store.getState());
    }
    // every scenario: undo all, then redo all, must visit exactly the model's snapshots
    for (const s of [...ref.scenarios]) {
      store.switchScenario(s.id);
      ref.switchTo(s.id);
      op.probe();
    }
    assert.equal(rig.errors.length, 0, `no listener or timer errors: ${rig.errors.map((e) => e.err && e.err.message)}`);
  } catch (err) {
    err.message = `[seed ${seed}, profile ${profileName}, step ${trace.length}: ${trace.slice(-8).join(' | ')}]\n${err.message}`;
    throw err;
  }
  return ref;
}

/** A copy of `layout` with a few random edits applied (always a valid layout). */
function randomEditApplied(rng, layout) {
  const copy = structuredClone(layout);
  for (let i = 0; i < 1 + rng.int(4); i++) randomEdit(rng, copy).run(copy);
  return copy;
}

test('model-based: random interleavings of commit, coalesced commit, undo/redo, scenario ops, load, selection and ui match a naive reference (mixed profile)', () => {
  for (let seed = 1; seed <= 18; seed++) runModelScript(seed, 260, 'mixed');
});

test('model-based: deep histories reach and exceed the 100-step cap and keep the newest 100 steps exactly', () => {
  let capped = 0;
  for (let seed = 101; seed <= 102; seed++) {
    const ref = runModelScript(seed, 520, 'deep');
    capped += ref.scenarios.filter((s) => s.undo.length === HISTORY_LIMIT).length;
  }
  assert.equal(capped, 2, 'every deep script must actually reach the cap');
});

test('undo all returns the exact initial layout object, redo all the exact final one (identity, not just equality)', () => {
  const rng = createRng(7);
  const { store, clock } = makeRig();
  const first = store.getState().layout;
  for (let i = 0; i < 60; i++) {
    const e = randomEdit(rng, store.getState().layout);
    clock.advance(rng.pick([0, 100, 1000]));
    store.commit(e.label, e.run, rng.next() < 0.5 ? { coalesce: 'k' } : undefined);
  }
  const last = store.getState().layout;
  while (store.undo());
  assert.equal(store.getState().layout, first, 'identity of the initial layout is restored');
  while (store.redo());
  assert.equal(store.getState().layout, last, 'identity of the final layout is restored');
  assert.ok(deepEqual(last, store.getState().layout));
});

test('every scenario keeps its own newest HISTORY_LIMIT steps while the others are edited in between', () => {
  const { store } = makeRig();
  const b = store.addScenario('B');
  const counters = { sc1: 0, [b]: 0 };
  for (let i = 0; i < 2 * (HISTORY_LIMIT + 30); i++) {
    const id = i % 2 ? b : 'sc1';
    store.switchScenario(id);
    const k = counters[id]++;
    store.commit('Edit', (l) => { l.name = `${id}-${k}`; });
  }
  for (const id of ['sc1', b]) {
    store.switchScenario(id);
    let steps = 0;
    while (store.undo()) steps++;
    assert.equal(steps, HISTORY_LIMIT, `${id}: exactly the newest ${HISTORY_LIMIT} steps are kept`);
    assert.equal(store.getState().layout.name, `${id}-29`, `${id}: the oldest kept state is the one before commit #${30 + 1}`);
  }
});

// =========================================================================================================
// STORE: coalescing
// =========================================================================================================

const setDemand = (value) => (l) => { L.updateSettings(l, { demandFactor: value }); };
const demand = (store) => store.getState().layout.settings.demandFactor;

test('coalescing: the window is inclusive at 800 ms, slides with every merged commit and ends at 801 ms', () => {
  const { store, clock } = makeRig();
  store.commit('Demand', setDemand(2), { coalesce: 'demand' });
  for (const [value, wait] of [[3, COALESCE_MS], [4, COALESCE_MS], [5, COALESCE_MS], [6, COALESCE_MS + 1]]) {
    clock.advance(wait);
    store.commit('Demand', setDemand(value), { coalesce: 'demand' });
  }
  assert.equal(demand(store), 6);
  store.undo();
  assert.equal(demand(store), 5, 'the commit 801 ms after the last one is its own step');
  store.undo();
  assert.equal(demand(store), 1, 'the three before it (each within 800 ms of the previous) are one step');
  assert.equal(store.getState().canUndo, false);
});

test('coalescing: a rejected or no-op commit neither extends nor breaks a burst', () => {
  {
    const { store, clock } = makeRig();
    store.commit('Demand', setDemand(2), { coalesce: 'demand' });
    clock.advance(300);
    assert.equal(store.commit('Demand', setDemand(2), { coalesce: 'demand' }), false, 'deep-equal result');
    assert.equal(store.commit('Demand', () => false, { coalesce: 'demand' }), false, 'mutator refused');
    clock.advance(200);
    store.commit('Demand', setDemand(3), { coalesce: 'demand' });
    store.undo();
    assert.equal(demand(store), 1, 'still one burst: 500 ms after the first commit');
  }
  {
    const { store, clock } = makeRig();
    store.commit('Demand', setDemand(2), { coalesce: 'demand' });
    clock.advance(500);
    store.commit('Demand', setDemand(2), { coalesce: 'demand' }); // no-op: must not slide the window
    clock.advance(400);
    store.commit('Demand', setDemand(3), { coalesce: 'demand' });
    store.undo();
    assert.equal(demand(store), 2, '900 ms after the last real commit the burst is over');
  }
});

test('coalescing: a burst that returns to its start leaves no step, and the next commit with the same key starts a fresh step', () => {
  const { store, clock } = makeRig();
  const first = store.getState().layout;
  store.commit('Demand', setDemand(2), { coalesce: 'demand' });
  clock.advance(10);
  store.commit('Demand', setDemand(1), { coalesce: 'demand' });
  assert.equal(store.getState().layout, first, 'the original layout object is current again');
  assert.equal(store.getState().canUndo, false);
  clock.advance(10);
  store.commit('Demand', setDemand(4), { coalesce: 'demand' });
  clock.advance(10);
  store.commit('Name', (l) => L.setName(l, 'Other'), { coalesce: 'name' });
  store.undo();
  assert.equal(demand(store), 4);
  store.undo();
  assert.equal(demand(store), 1);
  assert.equal(store.getState().canUndo, false, 'exactly two steps existed');
});

test('coalescing: two keys in alternation never merge with each other', () => {
  const { store, clock } = makeRig();
  for (let i = 0; i < 6; i++) {
    clock.advance(10);
    if (i % 2) store.commit('Demand', setDemand(2 + i), { coalesce: 'demand' });
    else store.commit('Name', (l) => L.setName(l, `N${i}`), { coalesce: 'name' });
  }
  let steps = 0;
  while (store.undo()) steps++;
  assert.equal(steps, 6);
});

test('coalescing: a burst survives selection and ui changes made in between (dragging a slider while the inspector re-renders)', () => {
  const { store, clock } = makeRig();
  store.commit('Demand', setDemand(2), { coalesce: 'demand' });
  store.setUi({ theme: 'dark' });
  store.select('station', ['nothing']);
  store.markClean();
  clock.advance(100);
  store.commit('Demand', setDemand(3), { coalesce: 'demand' });
  store.undo();
  assert.equal(demand(store), 1);
});

test('DEFECT SCN-1 (low): adding or duplicating a scenario must end the coalescing burst of the scenario that is left', () => {
  // A user drags a slider (burst on A), duplicates A as a variant, returns to A within 800 ms and drags again:
  // with the burst still open, the second drag is merged into the first, and one Undo reverts both.
  const variants = {
    addScenario: (store) => store.addScenario('B'),
    duplicateScenario: (store) => store.duplicateScenario('sc1'),
  };
  for (const [name, leave] of Object.entries(variants)) {
    const { store, clock } = makeRig();
    store.commit('Demand 2', setDemand(2), { coalesce: 'demand' });
    clock.advance(50);
    leave(store);
    store.switchScenario('sc1');
    clock.advance(50);
    store.commit('Demand 3', setDemand(3), { coalesce: 'demand' });
    store.undo();
    assert.equal(demand(store), 2, `${name}: the second commit is its own undo step`);
  }
});

test('DEFECT SCN-1b (low): deleting the scenario that was active must not revive an old burst of the one that becomes active', () => {
  const { store, clock } = makeRig();
  store.commit('Demand 2', setDemand(2), { coalesce: 'demand' });
  clock.advance(50);
  const copy = store.duplicateScenario('sc1');
  store.deleteScenario(copy);
  assert.equal(store.getState().project.activeId, 'sc1');
  clock.advance(50);
  store.commit('Demand 3', setDemand(3), { coalesce: 'demand' });
  store.undo();
  assert.equal(demand(store), 2, 'the second commit is its own undo step');
});

// =========================================================================================================
// STORE: listeners, reentrancy, subscription semantics
// =========================================================================================================

test('listeners: every listener sees every notification exactly once, in the same order, with growing versions, even when one of them commits', () => {
  const { store } = makeRig();
  const logs = [[], [], []];
  let echoed1 = false;
  let echoed2 = false;
  store.subscribe((s, info) => {
    logs[0].push(s.version);
    if (info.type === 'commit' && s.layout.name === 'start' && !echoed1) {
      echoed1 = true;
      store.commit('echo 1', (l) => { l.notes = 'echo'; });
    }
  });
  store.subscribe((s) => {
    logs[1].push(s.version);
    if (s.layout.notes === 'echo' && !echoed2) {
      echoed2 = true;
      store.commit('echo 2', setDemand(2));
    }
  });
  store.subscribe((s) => logs[2].push(s.version));
  store.commit('go', (l) => { l.name = 'start'; });
  assert.deepEqual(logs[0], logs[1]);
  assert.deepEqual(logs[0], logs[2]);
  assert.equal(logs[0].length, 3, 'the original commit and the two echoes');
  assert.deepEqual(logs[0], [...logs[0]].sort((a, b) => a - b));
  assert.equal(new Set(logs[0]).size, 3);
  assert.equal(store.getState().version, logs[0][2]);
});

test('listeners: getState() inside a listener is always the newest state, the argument is the state of that notification', () => {
  const { store } = makeRig();
  const seen = [];
  store.subscribe((s, info) => {
    if (info.type === 'commit' && s.layout.name === 'a') store.commit('b', (l) => { l.name = 'b'; });
    seen.push([s.version, store.getState().version]);
  });
  store.commit('a', (l) => { l.name = 'a'; });
  assert.deepEqual(seen, [[2, 3], [3, 3]]);
});

test('listeners: a listener subscribed during a round misses that round but hears everything after it; one unsubscribed during a round is skipped', () => {
  const { store } = makeRig();
  const heard = { late: [], victim: [], self: [] };
  let offVictim;
  let subscribed = false;
  store.subscribe((s) => {
    if (s.layout.name === 'one' && !subscribed) {
      subscribed = true;
      store.subscribe((s2) => heard.late.push(s2.layout.name));
      offVictim();
    }
  });
  offVictim = store.subscribe((s) => heard.victim.push(s.layout.name));
  const offSelf = store.subscribe((s) => {
    heard.self.push(s.layout.name);
    if (s.layout.name === 'one') offSelf();
  });
  store.commit('1', (l) => { l.name = 'one'; });
  store.commit('2', (l) => { l.name = 'two'; });
  assert.deepEqual(heard.late, ['two'], 'the new listener does not get the round in progress');
  assert.deepEqual(heard.victim, [], 'removed before its turn: never called');
  assert.deepEqual(heard.self, ['one'], 'a listener that unsubscribes itself is not called again');
});

test('listeners: a listener that undoes inside a notification leaves a consistent store and everybody hears both changes in order', () => {
  const { store } = makeRig();
  const order = [];
  store.subscribe((s, info) => {
    order.push(`${info.type}:${s.layout.name}`);
    if (info.type === 'commit' && s.layout.name === 'bad') store.undo();
  });
  store.subscribe((s, info) => order.push(`B ${info.type}:${s.layout.name}`));
  store.commit('bad edit', (l) => { l.name = 'bad'; });
  assert.deepEqual(order, ['commit:bad', 'B commit:bad', 'undo:Untitled plant', 'B undo:Untitled plant']);
  assert.equal(store.getState().layout.name, 'Untitled plant');
  assert.equal(store.getState().canRedo, true);
});

test('listeners: throwing anything (even undefined or a string) is reported to onError and never stops the other listeners or the store', () => {
  const { store, errors } = makeRig();
  const ok = [];
  store.subscribe(() => { throw 'a string'; }); // eslint-disable-line no-throw-literal
  store.subscribe(() => { throw undefined; }); // eslint-disable-line no-throw-literal
  store.subscribe(() => { throw new RangeError('boom'); });
  store.subscribe((s) => ok.push(s.version));
  assert.equal(store.commit('x', (l) => { l.name = 'x'; }), true);
  assert.equal(store.commit('y', (l) => { l.name = 'y'; }), true);
  assert.deepEqual(ok, [2, 3]);
  assert.equal(errors.length, 6);
  assert.deepEqual(errors.slice(0, 3).map((e) => e.err), ['a string', undefined, errors[2].err]);
});

test('listeners: destroy() from inside a listener stops the round and the queue', () => {
  const { store } = makeRig();
  const calls = [];
  store.subscribe((s) => { calls.push('first'); store.commit('echo', (l) => { l.notes = 'echo'; }); store.destroy(); });
  store.subscribe(() => calls.push('second'));
  store.commit('x', (l) => { l.name = 'x'; });
  assert.deepEqual(calls, ['first'], 'nobody is called after destroy()');
});

test('DEFECT SUB-1 (low): subscribing the same function twice gives two independent subscriptions, and a stale unsubscribe cannot remove a newer one', () => {
  {
    const { store } = makeRig();
    let calls = 0;
    const fn = () => { calls++; };
    const offFirst = store.subscribe(fn);
    store.subscribe(fn);
    offFirst();
    store.commit('x', (l) => { l.name = 'x'; });
    assert.equal(calls, 1, 'the second subscription is still alive');
  }
  {
    const { store } = makeRig();
    let calls = 0;
    const fn = () => { calls++; };
    const off = store.subscribe(fn);
    off();
    store.subscribe(fn);
    off(); // calling an old unsubscribe function again must be a no-op
    store.commit('x', (l) => { l.name = 'x'; });
    assert.equal(calls, 1, 'an unsubscribe function only ever removes its own subscription');
  }
});

test('DEFECT NTF-1 (medium): a listener that keeps committing is cut off and reported instead of freezing the tab and flooding the undo history', () => {
  const { store, errors } = makeRig();
  store.commit('The user work', (l) => { l.notes = 'precious'; });
  let rounds = 0;
  // a buggy panel: "keep the name in sync" with a value that never settles
  store.subscribe((s, info) => {
    if (info.type === 'commit' && rounds < 4000) {
      rounds++;
      store.commit('sync', (l) => { l.name = `sync ${rounds}`; });
    }
  });
  store.commit('trigger', (l) => { l.name = 'trigger'; });
  assert.ok(rounds <= 1000, `the notification chain must be limited (it ran ${rounds} rounds)`);
  assert.ok(errors.length >= 1, 'the cut-off is reported through onError');
});

test('DEFECT RE-1 (low): store.commit called from inside a mutator must not silently lose the inner edit and corrupt the history', () => {
  const { store } = makeRig();
  let thrown = null;
  try {
    store.commit('outer', (l) => {
      store.commit('inner', (l2) => { l2.name = 'inner edit'; });
      l.notes = 'outer edit';
    });
  } catch (err) {
    thrown = err;
  }
  const layout = store.getState().layout;
  if (thrown) {
    // refusing is fine, as long as nothing half-happened
    assert.equal(layout.notes, '');
  } else {
    assert.equal(layout.name, 'inner edit', 'the inner edit survived');
    assert.equal(layout.notes, 'outer edit', 'the outer edit survived');
  }
  let previous = layout;
  while (store.undo()) {
    assert.ok(!deepEqual(previous, store.getState().layout), 'every undo step changes something (no phantom steps)');
    previous = store.getState().layout;
  }
});

// =========================================================================================================
// STORE: state reference stability
// =========================================================================================================

test('stability: getState() is the very same object until something changes; unchanged requests change nothing', () => {
  const { store } = makeRig();
  store.commit('x', (l) => { l.name = 'x'; });
  store.select('station', []);
  const s = store.getState();
  assert.equal(store.getState(), s);
  assert.equal(store.setUi({ theme: 'auto', overlays: { grid: true }, toolOptions: { factor: 0.5 } }), false);
  assert.equal(store.select('station', ['ghost']), false);
  assert.equal(store.clearSelection(), false);
  assert.equal(store.markClean(), true);
  assert.equal(store.markClean(), false);
  assert.equal(store.renameProject(store.getState().project.name), false);
  assert.equal(store.switchScenario('sc1'), false);
  assert.equal(store.undo() && store.redo(), true);
  const after = store.getState();
  assert.equal(after.layout, s.layout, 'undo + redo restores the very same layout object');
});

test('stability: a failed restore, a refused delete and a rolled-back commit leave getState() identical', () => {
  const { store, storage } = makeRig();
  store.commit('x', (l) => { l.name = 'x'; });
  const s = store.getState();
  storage.data.set('logiplan:v1', '{not json');
  assert.equal(store.restore(), false);
  assert.equal(store.deleteScenario('sc1'), false);
  assert.throws(() => store.commit('bad', (l) => { l.grid.cols = -5; }), /rolled back/);
  assert.throws(() => store.commit('throws', () => { throw new Error('mutator failed'); }), /mutator failed/);
  assert.throws(() => store.loadProject({ scenarios: [] }), /scenario/);
  assert.equal(store.getState(), s);
});

// =========================================================================================================
// STORE: persistence
// =========================================================================================================

const KEY = 'logiplan:v1';

/** A rich saved session: edits, a second scenario, ui preferences. Returns the stored text. */
function savedSession(seed) {
  const rng = createRng(seed);
  const rig = makeRig();
  for (let i = 0; i < 25; i++) {
    const e = randomEdit(rng, rig.store.getState().layout);
    rig.store.commit(e.label, e.run);
  }
  rig.store.addScenario('Variant');
  for (let i = 0; i < 8; i++) {
    const e = randomEdit(rng, rig.store.getState().layout);
    rig.store.commit(e.label, e.run);
  }
  rig.store.setUi({ theme: 'dark', overlays: { heat: 'traffic' }, rightTab: 'results' });
  assert.equal(rig.store.persist(), true);
  return rig.storage.getItem(KEY);
}

/** Everything that must hold for a store after a restore() that returned true. */
function assertHealthy(store) {
  const s = store.getState();
  for (const sc of s.project.scenarios) assert.deepEqual(L.checkInvariants(sc.layout), [], `layout of ${sc.id}`);
  const ids = s.project.scenarios.map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'unique ids');
  assert.ok(ids.includes(s.project.activeId), 'active scenario exists');
  assert.equal(new Set(s.project.scenarios.map((x) => x.name.toLowerCase())).size, ids.length, 'unique names');
  assert.equal(s.layout, s.project.scenarios.find((x) => x.id === s.project.activeId).layout);
  assert.equal(typeof s.dirty, 'boolean');
  assert.ok(['auto', 'light', 'dark'].includes(s.ui.theme));
  assert.ok(['off', 'traffic', 'waiting'].includes(s.ui.overlays.heat));
  assert.equal(typeof s.ui.rightTab, 'string');
  assert.ok(s.project.name.length > 0);
  assert.equal(s.canUndo || s.canRedo, false, 'a restored document starts without history');
}

test('persistence: restore() never throws and never half-applies - 600 randomly damaged saves either load completely or change nothing', () => {
  const good = savedSession(11);
  const rng = createRng(99);
  const junk = [null, 0, -1, 1e999, '', 'x', '__proto__', [], {}, [1, 2], { a: 1 }, true, false, 'constructor', 1.5, 2 ** 40, '0,0', { out: 'x' }];
  const mutate = (value) => {
    if (value === null || typeof value !== 'object') return rng.pick(junk);
    const copy = Array.isArray(value) ? [...value] : { ...value };
    const keys = Object.keys(copy);
    if (!keys.length) return copy;
    const key = rng.pick(keys);
    const mode = rng.int(4);
    if (mode === 0) { if (Array.isArray(copy)) copy.splice(Number(key), 1); else delete copy[key]; } else if (mode === 1) copy[key] = rng.pick(junk);
    else copy[key] = mutate(copy[key]);
    return copy;
  };
  let loaded = 0;
  let refused = 0;
  for (let i = 0; i < 600; i++) {
    let damaged = JSON.parse(good);
    for (let k = 0; k < 1 + rng.int(3); k++) damaged = mutate(damaged);
    const text = JSON.stringify(damaged);
    if (text === undefined) continue;
    const rig = makeRig({ storage: createStorage({ initial: { [KEY]: text } }) });
    const before = rig.store.getState();
    if (rig.store.restore()) {
      loaded++;
      assertHealthy(rig.store);
    } else {
      refused++;
      assert.equal(rig.store.getState(), before, 'a refused restore leaves the state object itself untouched');
      assert.ok(rig.store.lastRestoreError instanceof Error || rig.store.lastRestoreError === null);
    }
  }
  assert.ok(loaded > 100 && refused > 20, `the fuzz must exercise both outcomes (loaded ${loaded}, refused ${refused})`);
});

test('persistence: a save cut off at any point (partial write) is refused with a reason and changes nothing', () => {
  const good = savedSession(12);
  const step = Math.max(1, Math.floor(good.length / 250));
  for (let n = 0; n < good.length; n += step) {
    const rig = makeRig({ storage: createStorage({ initial: { [KEY]: good.slice(0, n) } }) });
    const before = rig.store.getState();
    assert.equal(rig.store.restore(), false, `prefix of ${n} characters`);
    assert.equal(rig.store.getState(), before);
    if (n > 0) assert.ok(rig.store.lastRestoreError instanceof Error, 'the reason is available');
  }
});

test('persistence: storage that throws on getItem, throws non-errors, or returns non-text is survived', () => {
  for (const failure of [new Error('SecurityError'), 'denied', undefined, null, 0]) {
    const storage = createStorage();
    storage.failRead = failure;
    // the fake only throws truthy values: use a getter for the falsy ones
    if (!failure) storage.getItem = () => { throw failure; };
    const rig = makeRig({ storage });
    const before = rig.store.getState();
    assert.equal(rig.store.restore(), false);
    assert.equal(rig.store.getState(), before);
    assert.equal(rig.store.commit('still editable', (l) => { l.name = 'ok'; }), true);
  }
  for (const value of [42, {}, [], true, '']) {
    const rig = makeRig({ storage: { getItem: () => value, setItem() {} } });
    assert.equal(rig.store.restore(), false, `getItem returned ${JSON.stringify(value)}`);
  }
});

test('persistence: a save from a newer format version still loads into a valid store', () => {
  const good = JSON.parse(savedSession(13));
  good.schema = 99;
  good.scenarios[0].layout.schema = 99;
  good.scenarios[0].layout.futureThing = { a: 1 };
  const rig = makeRig({ storage: createStorage({ initial: { [KEY]: JSON.stringify(good) } }) });
  assert.equal(rig.store.restore(), true);
  assertHealthy(rig.store);
});

test('persistence: with a 1 KB quota nothing throws, the user keeps editing, the failure is reported once and the old copy survives', () => {
  const storage = createStorage({ quota: 1024 });
  const { store, clock, errors } = makeRig({ storage });
  const notes = [];
  store.subscribe((s, info) => { if (info.type === 'persist') notes.push(s.version); });
  assert.equal(store.persist(), true, 'an empty project fits into 1 KB');
  const saved = storage.getItem(KEY);
  store.replaceLayout(EXAMPLES[1].build(), { label: 'Load example' });
  for (let i = 0; i < 30; i++) {
    clock.advance(rng7(i));
    assert.equal(store.commit('Edit', (l) => { l.notes = `note ${i}`; }), true, 'committing never throws because of storage');
  }
  clock.advance(2000);
  assert.equal(storage.getItem(KEY), saved, 'the previous good copy is untouched');
  assert.ok(store.lastPersistError, 'the problem is visible to the shell');
  assert.equal(store.lastPersistError.name, 'QuotaExceededError');
  assert.equal(notes.length, 1, 'listeners hear about the failure once, not on every attempt');
  assert.ok(storage.attempts <= 1 + 31, `no retry storm (${storage.attempts} attempts)`);
  assert.equal(errors.length, 0, 'a full disk is not an application error');
  // when the project shrinks again the save works and the shell is told
  while (store.undo());
  store.newProject();
  assert.equal(store.persist(), true);
  assert.equal(store.lastPersistError, null);
  assert.equal(notes.length, 2, 'recovery is announced too');
});

test('DEFECT PER-3 (high): two tabs share one localStorage - a save from one tab must not silently destroy what the other tab saved', () => {
  // Tab B was opened before tab A saved (it restored an empty storage). Later the user works in B - or opens a share link in B,
  // which loads that project - and B's autosave replaces A's project, which is then nowhere in storage any more.
  const storage = createStorage();
  const tabA = makeRig({ storage });
  const tabB = makeRig({ storage });
  assert.equal(tabB.store.restore(), false, 'nothing saved yet');
  tabA.store.commit('Name', (l) => { l.name = 'Plant of tab A'; });
  tabA.clock.advance(1000);
  assert.ok(storage.getItem(KEY).includes('Plant of tab A'), 'tab A saved');
  tabB.store.replaceLayout(EXAMPLES[0].build(), { label: 'Load example' });
  tabB.clock.advance(1000);
  const everything = [...storage.data.values()].join('\n');
  assert.ok(everything.includes('Plant of tab A'), 'tab A\'s project must still be in storage (under another key, or because tab B refused to overwrite it and said so)');
});

/** Deterministic pseudo-random gaps (50..350 ms) for the quota test. */
function rng7(i) {
  return 50 + ((i * 97) % 300);
}

test('DEFECT PER-1 (medium): when the whole project no longer fits the quota, the scenario on screen is still saved', () => {
  // 7.5 KB plant; quota 12 KB: one scenario fits, two do not. The user duplicates the plant as a variant and keeps working
  // on the copy. After a reload (restore) the work on the copy is gone and so is the variant: nothing newer than the
  // moment of the duplicate was ever stored.
  const storage = createStorage({ quota: 12_000 });
  const { store, clock } = makeRig({ storage });
  store.replaceLayout(EXAMPLES[1].build(), { label: 'Load example' });
  clock.advance(1000);
  assert.ok(storage.data.has(KEY), 'the first save fits');
  store.duplicateScenario('sc1');
  clock.advance(1000);
  store.commit('Work on the variant', (l) => { l.name = 'Variant with a faster fleet'; L.updateFleet(l, l.fleets[0].id, { count: 7 }); });
  clock.advance(1000);
  const onScreen = store.getState().layout;

  const after = createStore({ storage, onError: () => {} });
  assert.equal(after.restore(), true);
  assert.ok(deepEqual(after.getState().layout, onScreen), 'the layout the user was working on survives a reload');
});

test('DEFECT PER-2 (low): autosave also happens during uninterrupted editing (a trailing debounce alone never fires while commits keep coming)', () => {
  const storage = createStorage();
  const { store, clock } = makeRig({ storage });
  // 60 s of editing with a pause of at most 300 ms between edits (dragging things around)
  for (let i = 0; i < 200; i++) {
    clock.advance(300);
    store.commit('Drag', (l) => { l.name = `Plant ${i}`; });
  }
  assert.ok(storage.writes >= 1, 'something was saved after 60 s of work (the debounce is only PERSIST_DEBOUNCE_MS = ' + PERSIST_DEBOUNCE_MS + ')');
});

test('persistence: autosave coalesces bursts into one write, writes the latest state and never writes for ui-only changes', () => {
  const storage = createStorage();
  const { store, clock } = makeRig({ storage });
  for (let i = 0; i < 20; i++) {
    store.commit('Edit', (l) => { l.name = `n${i}`; });
    clock.advance(100);
  }
  assert.equal(storage.writes, 0, '20 edits within two seconds: still waiting');
  clock.advance(PERSIST_DEBOUNCE_MS);
  assert.equal(storage.writes, 1);
  assert.equal(importProject(storage.getItem(KEY)).scenarios[0].layout.name, 'n19');
  store.select('station', []);
  store.setUi({ tool: 'road' });
  store.setUi({ overlays: { grid: false } });
  clock.advance(5000);
  assert.equal(storage.writes, 2, 'only the overlay preference changed what is saved');
});

// =========================================================================================================
// STORE: cost and memory on a big plant
// =========================================================================================================

const BIG = bigLayout();

/** Median wall time in ms of `n` calls of `fn(i)` after `warmup` untimed calls. */
function medianMs(fn, { n = 5, warmup = 1 } = {}) {
  for (let i = 0; i < warmup; i++) fn(-1 - i);
  const times = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    fn(i);
    times.push(performance.now() - t0);
  }
  return median(times);
}

test('the big fixture is the size the review claims: a valid ~300 KB plant with ~15,000 road cells', () => {
  const kb = JSON.stringify(BIG).length / 1024;
  assert.ok(kb >= 290 && kb <= 420, `fixture is ${kb.toFixed(0)} KB`);
  assert.ok(Object.keys(BIG.roads).length >= 14000);
  assert.deepEqual(L.checkInvariants(BIG), []);
});

test('DEFECT PERF-1 (medium): one commit on a 300 KB plant takes at most 5 ms (a slider drag commits on every input event)', () => {
  const COMMIT_BUDGET_MS = 5;
  const clock = createClock();
  const store = createStore({ storage: undefined, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  store.replaceLayout(BIG, { label: 'Load big plant' });
  const fleetId = BIG.fleets[0].id;
  const measured = {
    'rename plant': medianMs((i) => store.commit('Rename', (l) => { l.name = `Plant ${i}`; })),
    'slider (coalesced demand factor)': medianMs((i) => {
      clock.advance(16);
      store.commit('Demand', (l) => { l.settings.demandFactor = 1 + (i + 10) / 100; }, { coalesce: 'demand' });
    }),
    'fleet size stepper': medianMs((i) => store.commit('Fleet size', (l) => { L.updateFleet(l, fleetId, { count: 1 + ((i + 10) % 20) }); })),
  };
  const over = Object.entries(measured).filter(([, ms]) => ms > COMMIT_BUDGET_MS).map(([name, ms]) => `${name}: ${ms.toFixed(1)} ms`);
  assert.ok(over.length === 0, `median commit time on a ${(JSON.stringify(BIG).length / 1024).toFixed(0)} KB plant must stay within ${COMMIT_BUDGET_MS} ms, but: ${over.join('; ')}`);
});

test('DEFECT PERF-2 (low): the runner spends at most 2 ms per layout notification checking whether the simulation must restart, even on a 300 KB plant', async () => {
  const spent = [];
  const rig = makeRunnerRig({
    wrapStore: (store) => ({
      getState: store.getState,
      subscribe: (fn) => store.subscribe((state, info) => {
        const t0 = performance.now();
        fn(state, info);
        spent.push(performance.now() - t0);
      }),
    }),
  });
  rig.store.newProject(BIG);
  rig.frame(16);
  await rig.runner.play();
  spent.length = 0;
  for (let i = 0; i < 9; i++) rig.store.commit('Demand', (l) => { l.settings.demandFactor = 1 + (i + 1) / 20; }, { coalesce: 'demand' });
  assert.equal(spent.length, 9);
  assert.ok(median(spent) <= 2, `the runner's store listener took ${median(spent).toFixed(1)} ms per notification (median of 9)`);
});

/** Retained heap in MB after a full GC (the gc function is obtained without a command line flag). */
function retainedMB() {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  gc();
  gc();
  return process.memoryUsage().heapUsed / 1e6;
}

test('DEFECT MEM-1 (medium): undo steps of a 300 KB plant must not cost one full copy each (unchanged parts are shared between history entries)', () => {
  const STEPS = 30;
  const clock = createClock();
  const before = retainedMB();
  const store = createStore({ storage: undefined, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  store.replaceLayout(BIG, { label: 'Load big plant' });
  const one = retainedMB() - before; // heap of one plant (plus the store)
  // edits that never touch the roads - the bulk of the plant
  for (let i = 0; i < STEPS; i++) {
    store.commit('Edit', (l) => { l.name = `Plant ${i}`; L.updateStation(l, l.stations[i % l.stations.length].id, { name: `Station ${i}` }); });
  }
  const grown = retainedMB() - before - one;
  assert.equal(store.getState().canUndo, true);
  assert.ok(one > 1, `sanity: the plant itself takes ${one.toFixed(1)} MB`);
  assert.ok(grown < 0.4 * one * STEPS, `${STEPS} steps retain ${grown.toFixed(0)} MB = ${(grown / one).toFixed(1)} plants of ${one.toFixed(1)} MB (${(grown / STEPS / one * 100).toFixed(0)}% of a plant per step); edits that leave the roads alone should share them (limit 40% per step; at the history cap of ${HISTORY_LIMIT} steps a full copy per step is ${(one * HISTORY_LIMIT).toFixed(0)} MB per scenario)`);
});

// =========================================================================================================
// RUNNER: timing with a fake clock
// =========================================================================================================

const alphaOf = (rig) => rig.renderer.renders[rig.renderer.renders.length - 1].alpha;
const assertAlpha = (alpha, context = '') => assert.ok(Number.isFinite(alpha) && alpha >= 0 && alpha <= 1, `alpha ${alpha} must be in [0, 1] ${context}`);

test('runner timing: random frame lengths (stalls included) and speed changes - the clock follows speed x min(frame, 0.1 s) within one tick, alpha stays in [0, 1], limited stays off', async () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const rng = createRng(seed);
    const dt = rng.pick([0.02, 0.05, 0.1, 0.25, 0.5]);
    const rig = makeRunnerRig({ knobs: { dt } });
    rig.frame(16);
    assert.equal(await rig.runner.play(), true);
    const sim = rig.runner.sim;
    let expected = 0;
    for (let i = 0; i < 400; i++) {
      if (rng.next() < 0.05) rig.runner.setSpeed(rng.pick(SPEEDS));
      const ms = rng.pick([1, 8, 16, 16, 16, 17, 33, 50, 99, 100, 101, 250, 1000, 60_000]);
      const before = sim.time;
      rig.frame(ms);
      expected += Math.min(ms / 1000, MAX_FRAME_SECONDS) * rig.runner.speed;
      const context = `(seed ${seed}, frame ${i}, ${ms} ms, speed ${rig.runner.speed}, dt ${dt})`;
      assert.ok(sim.time >= before, `time never goes back ${context}`);
      assert.ok(sim.time >= expected - dt * 1e-5 && sim.time < expected + dt + dt * 1e-5, `sim.time ${sim.time} vs expected ${expected} ${context}`);
      assertAlpha(alphaOf(rig), context);
      assert.equal(rig.runner.limited, false, `an unconstrained simulation is never "limited" ${context}`);
    }
    assert.equal(rig.reported.length, 0);
  }
});

test('runner timing: the interpolation alpha is the position of the display clock inside the last tick', async () => {
  const rig = makeRunnerRig({ knobs: { dt: 0.5 } });
  rig.runner.setSpeed(1);
  rig.frame(16);
  await rig.runner.play();
  // speed 1, tick 0.5 s, 100 ms frames: the display clock walks 0.1, 0.2, ... and the sim holds the tick that ends at 0.5, 1.0, ...
  const alphas = [];
  for (let i = 0; i < 10; i++) {
    rig.frame(100);
    alphas.push(Number(alphaOf(rig).toFixed(6)));
  }
  assert.deepEqual(alphas, [0.2, 0.4, 0.6, 0.8, 1, 0.2, 0.4, 0.6, 0.8, 1]);
});

test('runner timing: a hidden tab pauses; coming back neither resumes nor fast-forwards; playing after a half-hour stall advances one capped frame at most', async () => {
  for (const framesBeforePlay of [0, 1]) {
    const rig = makeRunnerRig();
    rig.runner.setSpeed(120);
    rig.frame(16);
    await rig.runner.play();
    rig.frames(10);
    const t = rig.runner.time;
    rig.document.setHidden(true);
    assert.equal(rig.runner.playing, false, 'hidden: paused at once');
    rig.frames(5, 1000); // some engines keep calling back for a while
    assert.equal(rig.runner.time, t, 'hidden: the clock does not move');
    rig.clock.t += 30 * 60 * 1000; // rAF is suspended for half an hour
    rig.document.setHidden(false);
    assert.equal(rig.runner.playing, false, 'visible again: still paused');
    assert.equal(rig.runner.time, t);
    if (framesBeforePlay) rig.frame(16);
    await rig.runner.play();
    const before = rig.runner.time;
    rig.frame(framesBeforePlay ? 16 : 30 * 60 * 1000);
    const advanced = rig.runner.time - before;
    assert.ok(advanced <= MAX_FRAME_SECONDS * 120 + 0.1 + 1e-9, `first frame after the stall advanced ${advanced.toFixed(2)} s (cap ${MAX_FRAME_SECONDS * 120} s)`);
    assert.ok(advanced > 0);
  }
});

test('runner timing: changing the speed mid-run takes effect on the next frame with no jump, up and down', async () => {
  const rig = makeRunnerRig();
  rig.runner.setSpeed(10);
  rig.frame(16);
  await rig.runner.play();
  const stepOf = (ms = 16) => {
    const before = rig.runner.time;
    rig.frame(ms);
    return rig.runner.time - before;
  };
  rig.frames(20);
  rig.runner.setSpeed(1200);
  let total = 0;
  for (let i = 0; i < 10; i++) total += stepOf();
  assert.ok(Math.abs(total - 10 * 0.016 * 1200) <= 0.1 + 1e-6, `10 frames at 1200x advanced ${total}`);
  rig.runner.setSpeed(1);
  total = 0;
  for (let i = 0; i < 100; i++) total += stepOf();
  assert.ok(Math.abs(total - 100 * 0.016) <= 0.1 + 1e-6, `100 frames at 1x advanced ${total}, expected ${1.6}: dropping the speed must not run on at the old one`);
});

test('DEFECT RUN-2 (low): lowering the speed after a slow phase must not race through the old backlog in one frame', async () => {
  const rig = makeRunnerRig({ knobs: { capacity: 0.3 } });
  rig.runner.setSpeed(1200);
  rig.frame(16);
  await rig.runner.play();
  rig.frames(100); // far behind: 19 sim s wanted per frame, 0.3 s possible
  assert.equal(rig.runner.limited, true);
  rig.knobs.capacity = Infinity; // the machine is fast again ...
  rig.runner.setSpeed(1); // ... and the user slows down to look closely
  const advances = [];
  for (let i = 0; i < 6; i++) {
    const before = rig.runner.time;
    rig.frame(16);
    advances.push(rig.runner.time - before);
  }
  assert.ok(Math.max(...advances) <= 0.5 + 0.1 + 1e-9, `frames after the switch advanced ${advances.map((a) => a.toFixed(2))} s`);
  assert.equal(rig.runner.limited, false);
});

test('runner timing: catching up after a slow phase is bounded by the backlog cap (half a second of wall time at the chosen speed)', async () => {
  const rig = makeRunnerRig({ knobs: { capacity: 1 } });
  rig.runner.setSpeed(120);
  rig.frame(16);
  await rig.runner.play();
  rig.frames(200); // 1.9 s wanted per frame, 1 s possible
  assert.equal(rig.runner.limited, true);
  rig.knobs.capacity = Infinity;
  const before = rig.runner.time;
  rig.frame(16);
  const burst = rig.runner.time - before;
  assert.ok(burst <= 0.5 * 120 + 0.1 * 120 + 0.1 + 1e-9, `one frame advanced ${burst.toFixed(1)} s`);
  rig.frames(3);
  assert.equal(rig.runner.limited, false);
});

test('runner timing: a simulation that cannot advance at all (stuck) is flagged, never spun on, and requests stay bounded', async () => {
  const rig = makeRunnerRig({ knobs: { capacity: 0 } });
  rig.runner.setSpeed(600);
  rig.frame(16);
  await rig.runner.play();
  const sim = rig.runner.sim;
  rig.frames(300);
  assert.equal(rig.runner.limited, true);
  assert.equal(sim.time, 0);
  const requested = Math.max(...sim.advances.map((a) => a.seconds));
  assert.ok(requested <= 0.5 * 600 + 0.1 * 600 + 0.4 + 1e-9, `largest request ${requested} s`);
  assert.equal(sim.advances.length, 300, 'one advance call per frame, no retry loop');
  for (const { alpha } of rig.renderer.renders) assertAlpha(alpha);
  rig.knobs.capacity = Infinity;
  rig.frames(30);
  assert.ok(sim.time > 0);
  assert.equal(rig.runner.limited, false);
});

test('runner timing: random dt, capacity and speed never produce an alpha outside [0, 1], a going-back clock, errors or a lost frame loop', async () => {
  for (const seed of [21, 22, 23, 24]) {
    const rng = createRng(seed);
    const rig = makeRunnerRig({ knobs: { dt: rng.pick([0.01, 0.1, 0.5]) } });
    rig.frame(16);
    await rig.runner.play();
    let last = 0;
    for (let i = 0; i < 300; i++) {
      if (rng.next() < 0.1) rig.knobs.capacity = rng.pick([0, 0.05, 0.3, 5, Infinity]);
      if (rng.next() < 0.1) rig.runner.setSpeed(rng.pick(SPEEDS));
      if (rng.next() < 0.02) rig.runner.pause();
      if (rng.next() < 0.05) await rig.runner.play();
      rig.frame(rng.pick([4, 16, 16, 33, 120, 800]));
      assert.ok(rig.runner.time >= last);
      last = rig.runner.time;
      assertAlpha(alphaOf(rig), `(seed ${seed}, frame ${i})`);
    }
    assert.equal(rig.reported.length, 0);
    assert.equal(rig.scheduled.size, 1);
  }
});

// =========================================================================================================
// RUNNER: rebuild, errors, step
// =========================================================================================================

test('runner: a rebuild during play keeps playing, restarts at 0 with no catch-up burst, and the old simulation stops being advanced', async () => {
  const rig = makeRunnerRig();
  rig.runner.setSpeed(60);
  rig.frame(16);
  await rig.runner.play();
  rig.frames(30);
  const old = rig.runner.sim;
  const oldTicks = old.ticks;
  for (let i = 0; i < 3; i++) { rig.addStation(); rig.frame(16); } // three structural edits in quick succession
  assert.equal(rig.runner.sim, old, 'debounced: nothing yet');
  rig.frames(Math.ceil(REBUILD_DEBOUNCE_MS / 16) + 1);
  assert.equal(rig.sims().length, 2, 'exactly one rebuild for three edits');
  const fresh = rig.runner.sim;
  assert.notEqual(fresh, old);
  assert.equal(rig.renderer.sim, fresh);
  assert.equal(rig.runner.playing, true);
  assert.equal(old.ticks, oldTicks + old.ticks - oldTicks, 'sanity');
  const frozen = old.ticks;
  rig.frames(10);
  assert.equal(old.ticks, frozen, 'the replaced simulation is never advanced again');
  const perFrame = 0.016 * 60;
  assert.ok(fresh.time <= (Math.ceil(REBUILD_DEBOUNCE_MS / 16) + 12) * perFrame, 'the new clock started from 0 (no catch-up for the time the old one had run)');
  assert.deepEqual(rig.of('rebuild').map((e) => e.reason), ['create', 'structural']);
  for (const { alpha } of rig.renderer.renders) assertAlpha(alpha);
});

test('runner: the rebuild debounce is trailing - edits 200 ms apart keep postponing it until 250 ms after the last one', async () => {
  const rig = makeRunnerRig();
  rig.frame(16);
  await rig.runner.play();
  rig.frames(3);
  for (let i = 0; i < 5; i++) {
    rig.addStation();
    for (let ms = 0; ms < 200; ms += 20) rig.frame(20);
  }
  assert.equal(rig.sims().length, 1, '1 s of edits, each 200 ms after the previous: still the first simulation');
  rig.frames(Math.ceil(REBUILD_DEBOUNCE_MS / 20) + 1, 20);
  assert.equal(rig.sims().length, 2);
});

test('runner: play() and step() apply a pending rebuild at once, so the first run never uses a stale layout', async () => {
  for (const start of [(rig) => rig.runner.play(), (rig) => rig.runner.step(1)]) {
    const rig = makeRunnerRig();
    await rig.runner.play();
    rig.runner.pause();
    rig.addStation();
    assert.equal(rig.sims().length, 1);
    start(rig);
    assert.equal(rig.sims().length, 2, 'the new layout is simulated from the first moment');
    assert.equal(rig.runner.sim.layout, rig.store.getState().layout);
  }
});

test('runner timing: pausing in a slow phase and playing later starts from where the simulation is, without a backlog', async () => {
  const rig = makeRunnerRig({ knobs: { capacity: 0.3 } });
  rig.runner.setSpeed(120);
  rig.frame(16);
  await rig.runner.play();
  rig.frames(100);
  assert.equal(rig.runner.limited, true);
  rig.runner.pause();
  rig.knobs.capacity = Infinity;
  rig.frames(5);
  await rig.runner.play();
  const before = rig.runner.time;
  rig.frame(16);
  assert.ok(rig.runner.time - before <= 0.016 * 120 + 0.1 + 1e-9, `the first frame after play() advanced ${(rig.runner.time - before).toFixed(2)} s`);
});

test('runner: an exception in sim.advance pauses the run, reports once per second, keeps the frame loop and recovers on the next play()', async () => {
  const rig = makeRunnerRig();
  rig.frame(16);
  await rig.runner.play();
  rig.frames(3);
  rig.knobs.failAdvance = 'engine exploded';
  rig.frame(16);
  assert.equal(rig.runner.playing, false);
  assert.deepEqual(rig.of('error').map((e) => [e.phase, e.error.message]), [['advance', 'engine exploded']]);
  assert.equal(rig.scheduled.size, 1, 'the loop lives on');
  for (let i = 0; i < 8; i++) {
    await rig.runner.play();
    rig.frame(16);
    assert.equal(rig.runner.playing, false);
  }
  assert.equal(rig.of('error').length, 1, 'the same failure inside one second is reported once');
  rig.clock.t += 1500;
  await rig.runner.play();
  rig.frame(16);
  assert.equal(rig.of('error').length, 2, 'and again after a second');
  rig.knobs.failAdvance = null;
  await rig.runner.play();
  const before = rig.runner.time;
  rig.frames(5);
  assert.ok(rig.runner.time > before, 'the run goes on once the engine works again');
  assert.equal(rig.reported.length, 0, 'errors went to the error listener, not to onError');
});

test('runner: step() while playing pauses at once, advances exactly that long (to whole ticks), does not let the live loop drift afterwards, and play() resumes without a burst', async () => {
  const rig = makeRunnerRig();
  rig.runner.setSpeed(600);
  rig.frame(16);
  await rig.runner.play();
  rig.frames(5);
  const start = rig.runner.time;
  const stepping = rig.runner.step(2);
  assert.equal(rig.runner.playing, false, 'step() pauses synchronously');
  assert.equal(rig.of('state').at(-1).playing, false);
  rig.frame(16);
  assert.equal(await stepping, rig.runner.time - start);
  assert.ok(Math.abs(rig.runner.time - start - 2) <= 0.1 + 1e-9, `stepped ${rig.runner.time - start} s`);
  const stopped = rig.runner.time;
  rig.frames(20);
  assert.equal(rig.runner.time, stopped, 'nothing moves after the step');
  rig.clock.t += 10_000;
  await rig.runner.play();
  rig.frame(16);
  assert.ok(rig.runner.time - stopped <= MAX_FRAME_SECONDS * 600 + 0.1 + 1e-9, 'resuming starts from where the step stopped: the 10 s of wall time that passed count for at most one capped frame');
});

test('runner: step() with nothing sensible to do resolves 0 without touching the state; overlapping steps share one total', async () => {
  const rig = makeRunnerRig();
  rig.frame(16);
  for (const bad of [0, -1, NaN, Infinity, 'x', null]) assert.equal(await rig.runner.step(bad), 0);
  assert.equal(rig.sims().length, 0, 'no simulation was built for nothing');
  const a = rig.runner.step(1);
  const b = rig.runner.step(1);
  rig.frames(3);
  const [x, y] = await Promise.all([a, b]);
  assert.equal(x, y);
  assert.ok(Math.abs(x - 2) <= 0.1 + 1e-9, `both steps together advanced ${x}`);
});

test('runner: a step that is interrupted by a rebuild, a reset, a pause or a destroy still resolves', async () => {
  for (const interrupt of [
    (rig) => { rig.addStation(); rig.frames(Math.ceil(REBUILD_DEBOUNCE_MS / 16) + 2); },
    (rig) => rig.runner.reset(),
    (rig) => rig.runner.pause(),
    (rig) => rig.runner.destroy(),
    (rig) => rig.runner.play(),
  ]) {
    const rig = makeRunnerRig({ knobs: { capacity: 0.2 } });
    rig.frame(16);
    const stepping = rig.runner.step(1000);
    rig.frames(2);
    interrupt(rig);
    const advanced = await Promise.race([stepping, new Promise((resolve) => setTimeout(() => resolve('HUNG'), 200))]);
    assert.notEqual(advanced, 'HUNG', `${interrupt}`);
    assert.ok(Number.isFinite(advanced) && advanced >= 0);
  }
});

test('runner: repeated play/pause/toggle/step/reset/speed/edit/visibility storms never leak or double-schedule animation frames', async () => {
  const rng = createRng(5);
  const rig = makeRunnerRig();
  // (the promises of play/toggle/step are not awaited: a step only resolves when frames run)
  const actions = [
    () => { rig.runner.play(); }, () => rig.runner.pause(), () => { rig.runner.toggle(); }, () => { rig.runner.step(0.3); }, () => rig.runner.reset(),
    () => rig.runner.setSpeed(rng.pick(SPEEDS)), () => rig.addStation(), () => rig.store.undo(), () => rig.store.redo(),
    () => rig.document.setHidden(rng.next() < 0.5), () => rig.runner.kpis(), () => rig.runner.insights(),
    () => rig.frame(rng.pick([4, 16, 40, 260])), () => rig.frame(16), () => rig.frame(16),
  ];
  for (let i = 0; i < 3000; i++) {
    rng.pick(actions)();
    assert.equal(rig.scheduled.size, 1, `after action ${i}`);
  }
  assert.equal(rig.cancelled.length, 0, 'no frame was cancelled and re-requested while the runner lives');
  assert.equal(rig.visibility.size, 1, 'one visibility listener');
  rig.runner.destroy();
  assert.equal(rig.scheduled.size, 0);
  assert.equal(rig.cancelled.length, 1);
  assert.equal(rig.visibility.size, 0);
  rig.runner.destroy();
  assert.equal(await rig.runner.play(), false);
  assert.equal(await rig.runner.step(1), 0);
  rig.store.commit('after destroy', (l) => { l.name = 'x'; });
  assert.equal(rig.scheduled.size, 0);
});

test('runner: 5,000 play() calls without a frame in between create one simulation and schedule nothing', async () => {
  const rig = makeRunnerRig();
  for (let i = 0; i < 5000; i++) await rig.runner.play();
  assert.equal(rig.sims().length, 1);
  assert.equal(rig.scheduled.size, 1);
  assert.equal(rig.of('state').length, 1);
});

// =========================================================================================================
// RUNNER: what restarts the simulation (layoutChangeKind interplay)
// =========================================================================================================

const freeCell = (layout) => {
  for (let y = 0; y < layout.grid.rows; y++) {
    for (let x = 0; x < layout.grid.cols; x++) if (L.isCellFree(layout, x, y) && !L.roadAt(layout, x, y)) return [x, y];
  }
  throw new Error('no free cell');
};

const RESTART_CASES = [
  ['plant name', 'nothing', (l) => L.setName(l, 'Renamed plant')],
  ['plant notes', 'nothing', (l) => L.setNotes(l, 'Some notes\nfor the team')],
  ['a text label', 'nothing', (l) => L.addLabel(l, { x: 2, y: 2, text: 'Hello' })],
  ['an obstacle', 'nothing', (l) => { const [x, y] = freeCell(l); L.addObstacle(l, { x, y, w: 1, h: 1, kind: 'wall' }); }],
  ['run duration', 'nothing', (l) => L.updateSettings(l, { duration: 7200 })],
  ['demand factor', 'runtime', (l) => L.updateSettings(l, { demandFactor: 1.5 }), { demandFactor: 1.5 }],
  ['vehicle speed factor', 'runtime', (l) => L.updateSettings(l, { speedFactor: 0.5 }), { speedFactor: 0.5 }],
  ['process time factor', 'runtime', (l) => L.updateSettings(l, { processFactor: 2 }), { processFactor: 2 }],
  ['dispatch strategy', 'runtime', (l) => L.updateSettings(l, { dispatch: 'oldest' }), { dispatch: 'oldest' }],
  ['routing mode', 'runtime', (l) => L.updateSettings(l, { routing: 'congestion' }), { routing: 'congestion' }],
  ['fleet count', 'rebuild', (l) => L.updateFleet(l, l.fleets[0].id, { count: l.fleets[0].count + 3 })],
  ['an added fleet', 'rebuild', (l) => L.addFleet(l, 'forklift')],
  ['random seed', 'rebuild', (l) => L.updateSettings(l, { seed: 99 })],
  ['tick length', 'rebuild', (l) => L.updateSettings(l, { dt: 0.2 })],
  ['handedness', 'rebuild', (l) => L.updateSettings(l, { handedness: 'left' })],
  ['deadlock policy', 'rebuild', (l) => L.updateSettings(l, { deadlock: 'ignore' })],
  ['warm-up', 'rebuild', (l) => L.updateSettings(l, { warmup: 0 })],
  ['a road cell', 'rebuild', (l) => { const [x, y] = freeCell(l); L.paintRoadCell(l, x, y); }],
  ['a moved station', 'rebuild', (l) => {
    const { x, y } = l.stations[0];
    for (const [dx, dy] of [[0, -1], [0, -2], [-1, 0], [1, 0], [-2, 0], [2, 0], [0, -3]]) if (L.moveStation(l, l.stations[0].id, x + dx, y + dy)) return;
  }],
  ['a flow weight', 'rebuild', (l) => L.updateFlow(l, l.flows[0].id, { weight: 3 })],
  ['a cycle time', 'rebuild', (l) => L.updateStation(l, 's2', { params: { cycle: { kind: 'const', mean: 30, spread: 0 } } })],
];

test('runner x layoutChangeKind: cosmetic edits touch nothing, runtime edits are applied live, everything else rebuilds - for a running simulation', async () => {
  for (const [what, outcome, edit, patch] of RESTART_CASES) {
    const rig = makeRunnerRig();
    rig.store.newProject(EXAMPLES[0].build());
    rig.frame(16);
    await rig.runner.play();
    rig.frames(10);
    const before = rig.runner.sim;
    const t = before.time;
    assert.equal(rig.store.commit(`Change ${what}`, edit), true, `${what}: the edit must change the layout`);
    if (outcome === 'runtime') assert.equal(before.runtimePatches.length, 1, `${what}: a what-if change reaches the running simulation at once, not after a debounce`);
    rig.frames(Math.ceil(REBUILD_DEBOUNCE_MS / 16) + 4);
    const rebuilt = rig.runner.sim !== before;
    assert.equal(rebuilt, outcome === 'rebuild', `${what}: ${outcome === 'rebuild' ? 'must restart the simulation' : 'must keep the simulation running'}`);
    assert.equal(rig.runner.playing, true, `${what}: stays playing`);
    if (!rebuilt) {
      assert.ok(before.time > t, `${what}: the clock keeps running`);
      if (outcome === 'runtime') {
        assert.equal(before.runtimePatches.length, 1, `${what}: setRuntime once`);
        for (const [key, value] of Object.entries(patch)) assert.equal(before.runtimePatches[0][key], value, `${what}: ${key}`);
      } else {
        assert.equal(before.runtimePatches.length, 0, `${what}: setRuntime not called`);
      }
    } else {
      assert.ok(rig.runner.sim.time < before.time, `${what}: the new run starts again at 0`);
    }
  }
});

test('runner x layoutChangeKind: an edit and its undo inside the debounce window cancel each other; outside it they rebuild twice', async () => {
  const rig = makeRunnerRig();
  rig.store.newProject(EXAMPLES[0].build());
  rig.frame(16);
  await rig.runner.play();
  rig.frames(5);
  rig.store.commit('Fleet', (l) => L.updateFleet(l, 'v1', { count: 5 }));
  rig.frames(5);
  rig.store.undo();
  rig.frames(40);
  assert.equal(rig.sims().length, 1, 'undone in time: the simulation was never replaced');
  rig.store.commit('Fleet', (l) => L.updateFleet(l, 'v1', { count: 5 }));
  rig.frames(25);
  rig.store.undo();
  rig.frames(25);
  assert.equal(rig.sims().length, 3, 'edit and undo each took effect');
  assert.equal(rig.runner.sim.layout, rig.store.getState().layout);
});

test('runner x store: loading another project or switching scenario restarts only when the simulation would differ', async () => {
  const rig = makeRunnerRig();
  rig.store.newProject(EXAMPLES[0].build());
  rig.frame(16);
  await rig.runner.play();
  rig.frames(5);
  const first = rig.runner.sim;
  const same = rig.store.addScenario('Same plant, other name'); // a copy: identical simulation
  rig.store.commit('Rename', (l) => L.setName(l, 'Copy of the starter'));
  rig.frames(30);
  assert.equal(rig.runner.sim, first, 'a renamed copy is the same simulation');
  rig.store.commit('More vehicles', (l) => L.updateFleet(l, 'v1', { count: 9 }));
  rig.frames(30);
  const second = rig.runner.sim;
  assert.notEqual(second, first);
  rig.store.switchScenario('sc1');
  rig.frames(30);
  assert.notEqual(rig.runner.sim, second, 'back to the original scenario: its fleet differs');
  assert.equal(rig.runner.sim.layout, rig.store.getState().layout);
  assert.ok(same);
});

test('runner x engine: with the real Simulation the display clock follows the selected speed to within one tick and alpha stays in [0, 1]', async () => {
  const rig = makeRunnerRig({ SimulationClass: Simulation });
  rig.store.newProject(EXAMPLES[1].build());
  rig.runner.setSpeed(60);
  rig.frame(16);
  assert.equal(await rig.runner.play(), true);
  const sim = rig.runner.sim;
  assert.ok(sim instanceof Simulation);
  let expected = 0;
  for (let i = 0; i < 150; i++) {
    const ms = i % 25 === 24 ? 400 : 16;
    rig.frame(ms);
    expected += Math.min(ms / 1000, MAX_FRAME_SECONDS) * 60;
    assert.ok(sim.time >= expected - 1e-6 && sim.time < expected + sim.dt + 1e-6, `frame ${i}: ${sim.time} vs ${expected}`);
    assertAlpha(alphaOf(rig));
  }
  assert.equal(rig.runner.limited, false);
  assert.equal(rig.reported.length, 0);
  assert.equal(rig.of('error').length, 0);
  assert.ok(rig.runner.kpis() && rig.runner.insights(), 'results are available');
});

// =========================================================================================================
// RUNNER: destroy during a frame
// =========================================================================================================

/**
 * Run frames until `arm(rig, destroy)` makes something call runner.destroy() from inside the runner. Returns what went wrong
 * afterwards (nothing may be reported, no frame may be scheduled, the renderer must not be called again).
 */
async function destroyDuringFrame(arm, setup = {}) {
  const rig = makeRunnerRig(setup);
  rig.store.newProject(EXAMPLES[0].build());
  rig.runner.setSpeed(setup.speed ?? 10);
  rig.frame(16);
  await rig.runner.play();
  rig.frames(3);
  let rendersAtDestroy = null;
  const destroy = () => {
    rendersAtDestroy = rig.renderer.renders.length;
    rig.runner.destroy();
  };
  arm(rig, destroy);
  // 40 ms frames: a paused runner skips frames that come within 30 ms of the last drawn one, which would hide a stray render
  for (let i = 0; i < 80 && rendersAtDestroy === null && rig.scheduled.size; i++) rig.frame(40);
  assert.notEqual(rendersAtDestroy, null, 'the arrangement must make the runner call destroy()');
  if (rig.scheduled.size) rig.frame(40); // a frame that was already scheduled when destroy() was called
  const problems = [];
  if (rig.reported.length) problems.push(`reported ${rig.reported.map((r) => r.err.message).join('; ')}`);
  if (rig.scheduled.size) problems.push('a frame is still scheduled');
  if (rig.renderer.renders.length !== rendersAtDestroy) problems.push(`rendered ${rig.renderer.renders.length - rendersAtDestroy}x after destroy()`);
  return problems;
}

const DESTROY_FROM = {
  "a 'frame' listener": (rig, destroy) => rig.runner.on('frame', destroy),
  "a 'kpis' listener": (rig, destroy) => rig.runner.on('kpis', destroy),
  'the renderer': (rig, destroy) => {
    rig.renderer.render = function render(alpha) {
      this.renders.push({ alpha });
      destroy();
    };
  },
};

test('runner: destroy() called from a frame listener, a kpis listener or the renderer ends everything at once', async () => {
  for (const [where, arm] of Object.entries(DESTROY_FROM)) assert.deepEqual(await destroyDuringFrame(arm), [], where);
});

test('DEFECT RUN-1 (low): destroy() called from a listener while a frame is running must end the frame - no TypeError, no stray render()', async () => {
  const cases = {
    "a 'state' listener, speed limit raised inside sim.advance (TypeError)": [(rig, destroy) => {
      rig.knobs.capacity = 0.3;
      rig.runner.setSpeed(1200);
      rig.runner.on('state', (s) => { if (s.limited) destroy(); });
    }, { speed: 1200 }],
    "a 'state' listener, hidden-tab pause at the start of a frame": [(rig, destroy) => {
      rig.runner.on('state', (s) => { if (!s.playing) destroy(); });
      rig.document.hidden = true; // no visibilitychange event: the frame notices
    }],
    "a 'rebuild' listener, structural edit applied at the start of a frame": [(rig, destroy) => {
      rig.runner.on('rebuild', (e) => { if (e.reason === 'structural') destroy(); });
      rig.addStation();
    }],
    "an 'error' listener, engine failure": [(rig, destroy) => {
      rig.runner.on('error', destroy);
      rig.knobs.failAdvance = 'boom';
    }],
  };
  const failures = [];
  for (const [where, [arm, setup]] of Object.entries(cases)) {
    const problems = await destroyDuringFrame(arm, setup);
    if (problems.length) failures.push(`${where}: ${problems.join(', ')}`);
  }
  assert.deepEqual(failures, []);
});
