// Milestone M0 of the warehouse module, fix pass after its review: the layout stays valid under EVERY edit once it carries extension content.
//
// layout.schema is derived from the content (the lowest version that can express it, schema.js) and checkInvariants demands it exactly, so
// an edit that removes the last key of a newer row used to leave a stale stamp and the store rolled the edit back ("schema must be 1").
// The rule now (docs/ARCHITECTURE.md 3.1): a mutator that adds or removes persisted extension content ends with reconcileLayout(layout)
// (extensions.js), which re-derives the optional blocks that other content implies and the stamp. These tests prove it with stand-in
// sanitizers that plug in the way M1 does, through the real store, and make a NEW exported mutator of layout.js a failing test until it is
// classified here (so the next milestone cannot add one without deciding whether it has to reconcile).
// M1 UPDATE: the stand-ins now REPLACE the real sanitizers for the length of a test and the real ones are put back afterwards (they used to be
// deleted); updateCalendar is classified as a mutator; the real sanitizers are driven the same way in tests/model.ops-trucks.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/model/layout.js';
import { EXAMPLES } from '../js/model/examples.js';
import { OPS_SANITIZERS, clampInt, clampNumber, mergeOps } from '../js/model/ops.js';
import { EXTENSION_BLOCKS, reconcileLayout } from '../js/model/extensions.js';
import { schemaNeeded } from '../js/model/schema.js';
import { createStore } from '../js/store/store.js';
import { createRng } from '../js/util/rng.js';
import { MUTATORS, READERS, anyOf, pick } from './helpers/layout-mutators.js';

const clone = (v) => structuredClone(v);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A plant with every kind of station, flows and fleets (the two-lines example). */
const plant = () => EXAMPLES.find((e) => e.id === 'two-lines').build();
const sourceOf = (layout) => layout.stations.find((s) => s.type === 'source');

// ---------------------------------------------------------------------------------------------------------------------------
// Stand-ins for what M1 registers
// ---------------------------------------------------------------------------------------------------------------------------

/** Trucks of Goods in / Goods out: doors, a mode and an inter-arrival distribution (so that partial patches can be tried). */
function standInTrucks(raw) {
  const t = isObj(raw) ? raw.trucks : undefined;
  if (!isObj(t)) return undefined;
  const d = isObj(t.interArrival) ? t.interArrival : {};
  return {
    trucks: {
      doors: clampInt(t.doors, 1, 32, 2),
      mode: t.mode === 'schedule' ? 'schedule' : 'rate',
      interArrival: {
        kind: ['const', 'normal', 'exp'].includes(d.kind) ? d.kind : 'normal',
        mean: clampNumber(d.mean, 1, 1e6, 2700),
        spread: clampNumber(d.spread, 0, 1, 0.3),
      },
    },
  };
}

/** The clock: it exists once a station runs a timetable (an implied block) or when the file has one. */
function standInCalendar(raw, layout) {
  const needed = layout.stations.some((s) => s.ops && s.ops.trucks && s.ops.trucks.mode === 'schedule');
  if (!needed && !isObj(raw)) return undefined;
  const src = isObj(raw) ? raw : {};
  return { startTod: clampInt(src.startTod, 0, 86399, 0), startDay: clampInt(src.startDay, 0, 6, 0) };
}

/** Run `fn` with the stand-ins registered (ops for source and sink, the calendar block), and always put the registries back. */
function withStandIn(fn, { calendar = true } = {}) {
  return async () => {
    const blocks = [...EXTENSION_BLOCKS];
    const real = { source: OPS_SANITIZERS.source, sink: OPS_SANITIZERS.sink };
    OPS_SANITIZERS.source = standInTrucks;
    OPS_SANITIZERS.sink = standInTrucks;
    if (calendar) {
      EXTENSION_BLOCKS.length = 0;
      EXTENSION_BLOCKS.push({ key: 'calendar', sanitize: standInCalendar });
    }
    try {
      await fn();
    } finally {
      OPS_SANITIZERS.source = real.source;
      OPS_SANITIZERS.sink = real.sink;
      EXTENSION_BLOCKS.length = 0;
      EXTENSION_BLOCKS.push(...blocks);
    }
  };
}

/** What reconcileLayout owns: the stamp, the optional blocks and the `ops` blocks. A mutated layout must agree with its own normalization here. */
const derived = (layout) => ({ schema: layout.schema, calendar: layout.calendar, ops: Object.fromEntries(layout.stations.map((s) => [s.id, s.ops])) });

function assertConsistent(layout, what) {
  assert.deepEqual(L.checkInvariants(layout), [], `${what}: the layout is invalid`);
  assert.equal(layout.schema, schemaNeeded(layout), `${what}: the stamp`);
  assert.deepEqual(derived(layout), derived(L.normalizeLayout(layout)), `${what}: the layout is not what normalizeLayout makes of it`);
}

// ---------------------------------------------------------------------------------------------------------------------------
// reconcileLayout itself
// ---------------------------------------------------------------------------------------------------------------------------

test('reconcileLayout leaves a legacy layout alone (byte for byte, also when it is frozen) and returns it', () => {
  for (const example of EXAMPLES) {
    const layout = example.build();
    const before = JSON.stringify(layout);
    assert.equal(reconcileLayout(layout), layout);
    assert.equal(JSON.stringify(layout), before, example.id);
    const frozen = Object.freeze(JSON.parse(before));
    assert.doesNotThrow(() => reconcileLayout(frozen), 'nothing to write, so nothing is written');
  }
});

test('reconcileLayout re-derives a stale stamp in both directions', withStandIn(() => {
  const layout = plant();
  layout.schema = 5;
  reconcileLayout(layout);
  assert.equal(layout.schema, 1);
  sourceOf(layout).ops = { trucks: { doors: 3, mode: 'rate', interArrival: { kind: 'normal', mean: 2700, spread: 0.3 } } };
  reconcileLayout(layout);
  assert.equal(layout.schema, 2);
  delete sourceOf(layout).ops;
  reconcileLayout(layout);
  assert.equal(layout.schema, 1);
}));

test('reconcileLayout creates the blocks that other content implies and removes the ones nothing needs, appended after `settings`', withStandIn(() => {
  const layout = plant();
  sourceOf(layout).ops = standInTrucks({ trucks: { mode: 'schedule' } });
  reconcileLayout(layout);
  assert.deepEqual(layout.calendar, { startTod: 0, startDay: 0 }, 'a timetable implies a clock');
  assert.equal(layout.schema, 2);
  assert.equal(Object.keys(layout).at(-1), 'calendar');
  const kept = layout.calendar;
  reconcileLayout(layout);
  assert.equal(layout.calendar, kept, 'an up-to-date block is not replaced by an equal copy');
  assertConsistent(layout, 'after the first reconcile');
  // with no calendar sanitizer registered (the M0 state) a stray block is dropped like normalizeLayout drops it
  EXTENSION_BLOCKS.length = 0;
  EXTENSION_BLOCKS.push({ key: 'calendar', sanitize: () => undefined });
  reconcileLayout(layout);
  assert.ok(!('calendar' in layout));
  assert.equal(layout.schema, 2, 'the trucks still need schema 2');
}));

// ---------------------------------------------------------------------------------------------------------------------------
// The defects of the review: the stamp after a removal, through the store that gates every edit
// ---------------------------------------------------------------------------------------------------------------------------

test('deleting the last station that carries ops commits (the stamp goes back to 1)', withStandIn(() => {
  const store = createStore({ storage: null });
  store.replaceLayout(plant());
  const id = sourceOf(store.getState().layout).id;
  store.commit('Add doors', (d) => L.updateStation(d, id, { ops: { trucks: { doors: 3 } } }));
  assert.equal(store.getState().layout.schema, 2);
  assert.doesNotThrow(() => store.commit('Delete', (d) => L.removeStation(d, id)));
  assert.equal(store.getState().layout.schema, 1, 'with nothing left that needs schema 2 the layout is a legacy layout again');
  assert.ok(store.undo());
  assert.equal(store.getState().layout.schema, 2, 'and undo brings the doors and the stamp back together');
}));

test('shrinking the plan so that the station with ops falls off the edge commits (resizeGrid removes it through removeStation)', withStandIn(() => {
  const store = createStore({ storage: null });
  store.replaceLayout(plant());
  const source = sourceOf(store.getState().layout);
  assert.ok(source.x >= 8, 'the Goods in lies beyond the smallest plan');
  store.commit('Add doors', (d) => L.updateStation(d, source.id, { ops: { trucks: { doors: 3 } } }));
  assert.doesNotThrow(() => store.commit('Shrink', (d) => { L.resizeGrid(d, 4, 4); }));
  assert.equal(store.getState().layout.schema, 1);
  assert.ok(!store.getState().layout.stations.some((s) => s.ops));
}));

test('removing the last timetable keeps the layout consistent, and a copy of a station with ops commits and can be deleted again', withStandIn(() => {
  const store = createStore({ storage: null });
  store.replaceLayout(plant());
  const id = sourceOf(store.getState().layout).id;
  store.commit('Timetable', (d) => L.updateStation(d, id, { ops: { trucks: { mode: 'schedule' } } }));
  assert.ok(store.getState().layout.calendar, 'the clock appeared with the timetable, in the same edit');
  assertConsistent(store.getState().layout, 'after the timetable');
  const copyId = (() => { let made = null; store.commit('Copy', (d) => { made = L.duplicateStation(d, id); }); return made.id; })();
  assert.equal(store.getState().layout.stations.find((s) => s.id === copyId).ops.trucks.mode, 'schedule');
  store.commit('Delete the copy', (d) => L.removeStation(d, copyId));
  store.commit('Rate again', (d) => L.updateStation(d, id, { ops: { trucks: { mode: 'rate' } } }));
  assertConsistent(store.getState().layout, 'after the timetable is gone');
}));

test('removeFleet and removeFlow re-derive the stamp (keys of later rows, set by hand because no sanitizer keeps them yet)', () => {
  const layout = plant();
  const fleet = layout.fleets[0];
  fleet.calendar = { shifts: [] }; // schema 3 (M2)
  layout.schema = schemaNeeded(layout);
  assert.equal(layout.schema, 3);
  assert.equal(L.removeFleet(layout, fleet.id), true);
  assert.equal(layout.schema, schemaNeeded(layout), 'the fleet that carried the calendar is gone');
  assert.equal(layout.schema, 1);
  layout.flows[0].types = ['a']; // schema 6 (M5)
  layout.schema = schemaNeeded(layout);
  assert.equal(layout.schema, 6);
  assert.equal(L.removeFlow(layout, layout.flows[0].id), true);
  assert.equal(layout.schema, 1);
});

// ---------------------------------------------------------------------------------------------------------------------------
// Every exported function of layout.js is classified, and every mutator keeps the layout consistent
// ---------------------------------------------------------------------------------------------------------------------------

test('every exported function of layout.js is classified: a reader, or a mutator that the consistency test below drives', () => {
  const exported = Object.keys(L).filter((name) => typeof L[name] === 'function');
  const unknown = exported.filter((name) => !READERS.has(name) && !(name in MUTATORS));
  assert.deepEqual(unknown, [], 'a new exported function of layout.js: add it to READERS, or add a driver to MUTATORS (and, if it can add or remove extension content, make it end with reconcileLayout)');
  assert.deepEqual([...READERS, ...Object.keys(MUTATORS)].filter((name) => typeof L[name] !== 'function'), [], 'a classified name that layout.js no longer exports');
  assert.deepEqual([...READERS].filter((name) => name in MUTATORS), []);
});

/** Run `steps` random edits through `apply(label, mutator)` and check consistency after each. */
function drive(seed, steps, current, apply) {
  const rng = createRng(seed);
  const emphasis = ['updateStation', 'updateStation', 'updateStation', 'removeStation', 'removeStation', 'resizeGrid', 'duplicateStation', 'addStation', 'addStation', 'removeFleet', 'removeFlow'];
  const names = [...Object.keys(MUTATORS), ...emphasis]; // the mutators that add and remove extension content come up more often
  const tried = new Set();
  for (let i = 0; i < steps; i++) {
    const name = pick(rng, names);
    tried.add(name);
    apply(`${name} #${i}`, (draft) => MUTATORS[name](draft, rng));
    assertConsistent(current(), `step ${i} (${name})`);
  }
  return tried;
}

test('120 random edits of every mutator through the real store: every commit is accepted and the layout stays consistent', withStandIn(() => {
  const store = createStore({ storage: null });
  store.replaceLayout(plant());
  // make sure the interesting content exists at the start, so that removals have something to remove
  store.commit('Doors', (d) => L.updateStation(d, sourceOf(d).id, { ops: { trucks: { doors: 3 } } }));
  let committed = 0;
  const tried = drive(20261009, 120, () => store.getState().layout, (label, mutator) => {
    try {
      if (store.commit(label, mutator)) committed++;
    } catch (error) {
      assert.fail(`"${label}" was rolled back: ${error.message}`);
    }
  });
  assert.ok(committed > 40, `only ${committed} of 120 edits changed anything`);
  assert.ok(tried.size >= 25, `${tried.size} different mutators were tried`);
  const layout = store.getState().layout;
  assert.ok(layout.stations.some((s) => s.ops) || committed > 0);
}));

test('the same edits on a plain layout (no store): consistent after every mutator, also without the calendar block', withStandIn(() => {
  const layout = plant();
  L.updateStation(layout, sourceOf(layout).id, { ops: { trucks: { mode: 'schedule' } } });
  drive(77, 150, () => layout, (label, mutator) => { mutator(layout); });
  // the whole sequence again with the stand-in calendar left out, as in M0 (nothing implies a block)
  const second = plant();
  drive(78, 100, () => second, (label, mutator) => { mutator(second); });
}));

// ---------------------------------------------------------------------------------------------------------------------------
// mergeOps: a partial patch of a nested object keeps what it does not name (like mergeParams does for distributions)
// ---------------------------------------------------------------------------------------------------------------------------

test('mergeOps merges plain objects at every depth: a patch of only the mean keeps the kind and the spread', withStandIn(() => {
  const current = { trucks: { doors: 2, mode: 'rate', interArrival: { kind: 'exp', mean: 3000, spread: 0.5 } } };
  const frozen = JSON.stringify(current);
  assert.deepEqual(mergeOps('source', current, { trucks: { interArrival: { mean: 2400 } } }).trucks.interArrival, { kind: 'exp', mean: 2400, spread: 0.5 });
  assert.deepEqual(mergeOps('source', current, { trucks: { doors: 5 } }).trucks.interArrival, { kind: 'exp', mean: 3000, spread: 0.5 }, 'a sibling patch leaves it alone');
  assert.equal(JSON.stringify(current), frozen, 'the current block is not modified');
  const layout = plant();
  const id = sourceOf(layout).id;
  L.updateStation(layout, id, { ops: current });
  L.updateStation(layout, id, { ops: { trucks: { interArrival: { mean: 2400 } } } });
  assert.deepEqual(sourceOf(layout).ops.trucks.interArrival, { kind: 'exp', mean: 2400, spread: 0.5 }, 'what an experiment sweep (a single field) writes');
}));

test('mergeOps: null removes a key at any depth, arrays and scalars replace, __proto__ and unknown station types are harmless', withStandIn(() => {
  const current = { trucks: { doors: 2, mode: 'schedule', interArrival: { kind: 'exp', mean: 3000, spread: 0.5 } } };
  assert.equal(mergeOps('source', current, { trucks: { interArrival: null } }).trucks.interArrival.kind, 'normal', 'removed, so the sanitizer fills the default');
  assert.equal(mergeOps('source', current, null), undefined, 'null removes the whole block');
  assert.equal(mergeOps('source', current, { trucks: null }), undefined, 'and so does switching the only key off');
  assert.equal(mergeOps('source', current, 'junk').trucks.doors, 2, 'a patch that is not an object changes nothing');
  assert.equal(mergeOps('source', current, JSON.parse('{"trucks":{"doors":7,"__proto__":{"polluted":1}}}')).trucks.doors, 7);
  assert.equal({}.polluted, undefined, 'no prototype was touched');
  assert.equal(mergeOps('storage', current, { trucks: { doors: 4 } }), undefined, 'no sanitizer for a storage');
  assert.equal(mergeOps('source', undefined, { trucks: { interArrival: { mean: 99 } } }).trucks.interArrival.mean, 99, 'a block that does not exist yet is created');
}));

test('mergeOps for a station type without a sanitizer (Workstation, Storage, Parking) returns undefined for every input', () => {
  for (const type of ['process', 'storage', 'depot']) {
    for (const patch of [null, {}, { trucks: { doors: 3 } }, 'x', 5, [], undefined]) assert.equal(mergeOps(type, { trucks: { doors: 2 } }, patch), undefined);
  }
  assert.deepEqual(Object.keys(OPS_SANITIZERS).sort(), ['sink', 'source']);
});
