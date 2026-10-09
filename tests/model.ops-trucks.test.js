// Milestone M1 of the warehouse module, the model: station.ops.trucks (Goods in, Goods out) and layout.calendar { startTod, startDay }.
// docs/WAREHOUSE-DESIGN.md 5.1 (rules for every new key), 5.2 (schema), 5.3 (M1 data), 10.2 (the round trip is table driven), acceptance A1.1, A1.2.
//
//   * the table OPS_KEYS / CALENDAR_KEYS drives one test per area: every documented key survives normalizeLayout, exportProject/importProject and
//     the share link, ranges are clamped, junk takes the default, unknown keys are dropped, `ops` on other station types is dropped, the schema is 2
//     for a layout with trucks (or a clock) and stays 1 for a legacy layout, a timetable creates the clock;
//   * mergeOps / updateStation patch semantics (a field of the panel, a sweep, a hostile patch);
//   * after EVERY mutator of layout.js, on plants that carry trucks, normalizeLayout(layout) is the layout (byte for byte), through the real store too,
//     with undo and redo (the classification of the mutators is tests/helpers/layout-mutators.js, checked by tests/model.reconcile.test.js);
//   * junk with own `__proto__` keys, and 50,000 random patches of a trucks block, stay inside the sanitizer's fixed point (the 4,000 junk documents
//     are in tests/model.ops-trucks.fuzz.test.js, a heavy-tier file).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/model/layout.js';
import { EXAMPLES } from '../js/model/examples.js';
import { legacyExamples } from './helpers/golden.js';
import { MAX_SCHEDULE_ROWS, OPS_KEYS, OPS_SANITIZERS, TRUCK_DEFAULTS, defaultTrucks, mergeOps, sanitizeOps, trucksOf } from '../js/model/ops.js';
import { CALENDAR_KEYS, makeClock, sanitizeCalendar, usesTimetable } from '../js/model/calendar.js';
import { reconcileLayout } from '../js/model/extensions.js';
import { SCHEMA_MAX, schemaNeeded } from '../js/model/schema.js';
import { decodeShare, encodeShare, exportProject, importProject } from '../js/model/serialize.js';
import { createStore } from '../js/store/store.js';
import { createRng } from '../js/util/rng.js';
import { MUTATORS, anyOf, pick } from './helpers/layout-mutators.js';
import { deepFreeze } from './helpers/m0-review-gen.js';

const bytes = (v) => JSON.stringify(v);
const clone = (v) => structuredClone(v);
const project = (layout) => ({ name: 'P', scenarios: [{ id: 'a', name: 'A', layout }], activeId: 'a' });
const build = (id) => EXAMPLES.find((e) => e.id === id).build();
const stationOf = (layout, type) => layout.stations.find((s) => s.type === type);
const TYPES = ['source', 'process', 'storage', 'sink', 'depot'];

/** `value` written at the dotted path below `ops` of a fresh raw ops block: 'trucks.interArrival.mean' -> { trucks: { interArrival: { mean } } }. */
function opsAt(path, value) {
  const keys = path.split('.');
  const root = {};
  let node = root;
  keys.forEach((key, i) => {
    node[key] = i === keys.length - 1 ? value : {};
    node = node[key];
  });
  return root;
}
/** The value at a dotted path. */
const at = (obj, path) => path.split('.').reduce((node, key) => (node === undefined || node === null ? undefined : node[key]), obj);

/** A plant whose Goods in and Goods out carry trucks (the first in timetable mode, so the clock exists). */
function truckPlant(id = 'two-lines') {
  const layout = build(id);
  const [source, sink] = [stationOf(layout, 'source'), stationOf(layout, 'sink')];
  L.updateStation(layout, source.id, { ops: { trucks: { doors: 3, mode: 'schedule', schedule: [{ at: 21600, pallets: 24 }, { at: 25200, pallets: null }] } } });
  L.updateStation(layout, sink.id, { ops: { trucks: { doors: 2, staging: 6 } } });
  return layout;
}

// ---------------------------------------------------------------------------------------------------------------------------
// A1.2: the documented keys, driven by the tables
// ---------------------------------------------------------------------------------------------------------------------------

test('A1.2 the table OPS_KEYS covers every key of 5.3 for Goods in and Goods out, and every entry is well formed', () => {
  const paths = OPS_KEYS.map((k) => k.key);
  for (const key of ['trucks', 'trucks.doors', 'trucks.checkIn', 'trucks.checkOut', 'trucks.mode', 'trucks.interArrival', 'trucks.pallets', 'trucks.schedule', 'trucks.jitter', 'trucks.noShow', 'trucks.maxDwell', 'trucks.staging']) {
    assert.ok(paths.includes(key), `OPS_KEYS lists ${key}`);
  }
  assert.equal(new Set(paths).size, paths.length, 'no key twice');
  for (const entry of OPS_KEYS) {
    assert.deepEqual([...entry.types], ['source', 'sink'], entry.key);
    assert.equal(entry.schema, 2, entry.key);
    assert.notEqual(entry.sample, undefined);
    assert.ok(Array.isArray(entry.cases) && entry.cases.length > 0, `${entry.key} has cases`);
  }
  assert.deepEqual(CALENDAR_KEYS.map((k) => k.key), ['startTod', 'startDay']);
});

for (const entry of OPS_KEYS) {
  for (const type of entry.types) {
    test(`A1.2 ops.${entry.key} on a ${type}: the sample survives normalizeLayout, export, import and the share link; the layout is schema 2`, async () => {
      const layout = build('two-lines');
      const station = stationOf(layout, type);
      const raw = clone(layout);
      raw.stations.find((s) => s.id === station.id).ops = opsAt(entry.key, clone(entry.sample));
      const out = L.normalizeLayout(raw);
      assert.equal(bytes(at(out.stations.find((s) => s.id === station.id).ops, entry.key)), bytes(entry.sample), `${entry.key} kept`);
      assert.equal(out.schema, 2);
      assert.equal(out.schema, schemaNeeded(out));
      assert.deepEqual(L.checkInvariants(out), []);
      assert.equal(bytes(L.normalizeLayout(out)), bytes(out), 'idempotent');
      const file = exportProject(project(out));
      assert.equal(JSON.parse(file).schema, 2);
      const back = importProject(file);
      assert.equal(back.warnings, undefined, 'a build that implements schema 2 does not warn about it');
      assert.equal(bytes(back.scenarios[0].layout), bytes(out), 'export and import');
      const shared = await decodeShare(await encodeShare(project(out)));
      assert.equal(bytes(shared.scenarios[0].layout), bytes(out), 'the share link');
      // the other station types do not carry it
      for (const other of TYPES.filter((t) => !entry.types.includes(t))) {
        const station2 = stationOf(layout, other);
        if (!station2) continue;
        const raw2 = clone(layout);
        raw2.stations.find((s) => s.id === station2.id).ops = opsAt(entry.key, clone(entry.sample));
        assert.ok(!('ops' in L.normalizeLayout(raw2).stations.find((s) => s.id === station2.id)), `${other} drops ops.${entry.key}`);
      }
    });

    test(`A1.2 ops.${entry.key} on a ${type}: ranges are clamped, junk takes the default, nothing else changes`, () => {
      const layout = build('starter');
      const station = stationOf(layout, type);
      for (const [input, expected] of entry.cases) {
        const raw = clone(layout);
        raw.stations.find((s) => s.id === station.id).ops = opsAt(entry.key, clone(input));
        const out = L.normalizeLayout(raw);
        const ops = out.stations.find((s) => s.id === station.id).ops;
        assert.equal(bytes(at(ops, entry.key)), bytes(expected), `${entry.key} <- ${bytes(input)}`);
        assert.deepEqual(L.checkInvariants(out), [], `${entry.key} <- ${bytes(input)}: valid`);
        // every other field of the block is the default
        const rest = clone(ops);
        const keys = entry.key.split('.');
        if (keys.length === 2) delete rest.trucks[keys[1]];
        if (keys.length === 3) delete rest.trucks[keys[1]][keys[2]];
        if (keys.length === 1) continue;
        const defaults = defaultTrucks();
        if (keys.length === 2) delete defaults[keys[1]];
        if (keys.length === 3) delete defaults[keys[1]][keys[2]];
        assert.equal(bytes(rest.trucks), bytes(defaults), `${entry.key} <- ${bytes(input)}: the other fields are defaults`);
      }
    });
  }
}

for (const entry of CALENDAR_KEYS) {
  test(`A1.2 calendar.${entry.key}: the sample survives normalizeLayout, export, import and the share link; ranges are clamped; schema 2`, async () => {
    const layout = build('starter');
    const raw = clone(layout);
    raw.calendar = { [entry.key]: clone(entry.sample) };
    const out = L.normalizeLayout(raw);
    assert.equal(out.calendar[entry.key], entry.sample);
    assert.equal(out.schema, 2);
    assert.deepEqual(L.checkInvariants(out), []);
    assert.equal(Object.keys(out).at(-1), 'calendar', 'appended after `settings`');
    assert.equal(bytes((await decodeShare(await encodeShare(project(out)))).scenarios[0].layout), bytes(out));
    assert.equal(bytes(importProject(exportProject(project(out))).scenarios[0].layout), bytes(out));
    for (const [input, expected] of entry.cases) {
      const r = clone(layout);
      r.calendar = { [entry.key]: input };
      assert.equal(L.normalizeLayout(r).calendar[entry.key], expected, `${entry.key} <- ${bytes(input)}`);
    }
  });
}

test('A1.2 unknown keys are dropped at every level of an ops block, and the block keeps the order of the document', () => {
  const layout = build('starter');
  const raw = clone(layout);
  const dirty = {
    hologram: 1,
    trucks: {
      zzz: 1, doors: 3, staging: 2, checkIn: 100, mode: 'schedule', interArrival: { kind: 'exp', mean: 1000, spread: 0.2, extra: 1 }, pallets: { mean: 20, junk: true },
      schedule: [{ at: 100, pallets: 5, days: [0], depart: 5, mix: [], extra: 1 }], later: { rack: true }, noShow: 0.2, jitter: 5, maxDwell: 5, checkOut: 1,
    },
    rack: { levels: 3 }, form: 'rack', calendar: { staffing: [] },
  };
  raw.stations.find((s) => s.type === 'source').ops = dirty;
  const out = L.normalizeLayout(raw);
  const ops = stationOf(out, 'source').ops;
  assert.deepEqual(Object.keys(ops), ['trucks']);
  assert.deepEqual(Object.keys(ops.trucks), ['doors', 'checkIn', 'checkOut', 'mode', 'interArrival', 'pallets', 'schedule', 'jitter', 'noShow', 'maxDwell', 'staging']);
  assert.deepEqual(Object.keys(ops.trucks.interArrival), ['kind', 'mean', 'spread']);
  assert.deepEqual(Object.keys(ops.trucks.pallets), ['kind', 'mean', 'spread']);
  assert.deepEqual(ops.trucks.schedule, [{ at: 100, pallets: 5 }]);
  assert.deepEqual(Object.keys(stationOf(out, 'source')).slice(-2), ['params', 'ops'], 'ops after params');
});

test('A1.2 an ops block that holds no trucks block, or a junk one, leaves no ops on the station; an empty block still gets the defaults', () => {
  const layout = build('starter');
  const put = (ops) => { const raw = clone(layout); stationOf(raw, 'source').ops = ops; return stationOf(L.normalizeLayout(raw), 'source'); };
  for (const junkOps of [undefined, null, 0, 'trucks', [], [{ trucks: {} }], {}, { trucks: null }, { trucks: 5 }, { trucks: 'many' }, { trucks: [] }, { rack: {} }, { other: 1 }]) {
    assert.ok(!('ops' in put(junkOps)), bytes(junkOps));
  }
  assert.equal(bytes(put({ trucks: {} }).ops), bytes({ trucks: defaultTrucks() }));
});

test('A1.2 the defaults are those of 5.3, and a block that exists stores every field', () => {
  assert.equal(bytes(TRUCK_DEFAULTS), bytes({
    doors: 2, checkIn: 300, checkOut: 300, mode: 'rate', interArrival: { kind: 'normal', mean: 2700, spread: 0.3 }, pallets: { kind: 'uniform', mean: 24, spread: 0.25 },
    schedule: [], jitter: 0, noShow: 0, maxDwell: 3600, staging: 4,
  }));
  assert.ok(Object.isFrozen(TRUCK_DEFAULTS) && Object.isFrozen(TRUCK_DEFAULTS.interArrival) && Object.isFrozen(TRUCK_DEFAULTS.schedule));
  const fresh = defaultTrucks();
  fresh.interArrival.mean = 1;
  fresh.schedule.push({ at: 1, pallets: 1 });
  assert.equal(TRUCK_DEFAULTS.interArrival.mean, 2700, 'defaultTrucks() is a copy');
  assert.deepEqual(TRUCK_DEFAULTS.schedule, []);
  for (const type of ['source', 'sink']) assert.equal(bytes(sanitizeOps(type, { trucks: {} }).trucks), bytes(TRUCK_DEFAULTS));
  assert.deepEqual(Object.keys(OPS_SANITIZERS).sort(), ['sink', 'source']);
  for (const type of ['process', 'storage', 'depot']) assert.equal(sanitizeOps(type, { trucks: {} }), undefined);
});

test('A1.2 the timetable: sorted by time (stable), at most 500 rows, times as text or seconds, pallets 1..200 or null, junk rows dropped', () => {
  const rows = (schedule) => sanitizeOps('source', { trucks: { mode: 'schedule', schedule } }).trucks.schedule;
  assert.deepEqual(rows([{ at: 30, pallets: 1 }, { at: 10, pallets: 2 }, { at: 10, pallets: 3 }, { at: 20, pallets: 4 }]).map((r) => r.pallets), [2, 3, 4, 1], 'equal times keep their order');
  assert.deepEqual(rows([{ at: '06:00', pallets: 24 }, { at: '6:05', pallets: '12' }, { at: 25200.4, pallets: 7.5 }]), [{ at: 21600, pallets: 24 }, { at: 21900, pallets: 12 }, { at: 25200, pallets: 8 }]);
  assert.deepEqual(rows([{ at: 0 }, { at: 86399, pallets: null }, { at: 86400 }, { at: -1 }, { at: '24:00' }, { at: NaN }]), [{ at: 0, pallets: null }, { at: 86399, pallets: null }]);
  assert.deepEqual(rows([{ at: 1, pallets: 0 }, { at: 2, pallets: -4 }, { at: 3, pallets: 1e9 }, { at: 4, pallets: 'x' }, { at: 5, pallets: [] }]).map((r) => r.pallets), [1, 1, 200, null, null]);
  const many = Array.from({ length: 1200 }, (_, i) => ({ at: (i * 61) % 86400, pallets: 1 + (i % 9) }));
  const kept = rows(many);
  assert.equal(kept.length, MAX_SCHEDULE_ROWS);
  assert.ok(kept.every((r, i) => i === 0 || kept[i - 1].at <= r.at), 'sorted');
  assert.deepEqual(kept, rows(kept), 'a normalized timetable is a fixed point');
  assert.deepEqual(rows(many.map((r) => ({ ...r, at: r.at }))).map((r) => r.at), kept.map((r) => r.at));
  const junkRows = Array.from({ length: 2000 }, () => 'x');
  assert.deepEqual(rows(junkRows), [], 'thousands of junk entries are scanned without effect');
});

test('A1.2 a timetable creates the clock; the clock stays when the timetable goes (it is not derived from nothing); a plant without one has none', () => {
  const layout = build('starter');
  assert.ok(!('calendar' in layout) && layout.schema === 1);
  const id = stationOf(layout, 'source').id;
  L.updateStation(layout, id, { ops: { trucks: { doors: 2 } } });
  assert.ok(!('calendar' in layout), 'rate mode does not need a clock');
  assert.equal(layout.schema, 2);
  assert.ok(!usesTimetable(layout));
  L.updateStation(layout, id, { ops: { trucks: { mode: 'schedule' } } });
  assert.deepEqual(layout.calendar, { startTod: 0, startDay: 0 }, 'created by the same edit');
  assert.ok(usesTimetable(layout));
  assert.equal(Object.keys(layout).at(-1), 'calendar');
  L.updateCalendar(layout, { startTod: '06:00', startDay: 2 });
  assert.deepEqual(layout.calendar, { startTod: 21600, startDay: 2 });
  assert.deepEqual(L.checkInvariants(layout), []);
  L.updateStation(layout, id, { ops: { trucks: { mode: 'rate' } } });
  assert.deepEqual(layout.calendar, { startTod: 21600, startDay: 2 }, 'the clock the planner set stays');
  assert.equal(L.updateCalendar(layout, null), true);
  assert.ok(!('calendar' in layout), 'and can be removed when no timetable needs it');
  assert.equal(layout.schema, 2, 'the trucks still need schema 2');
  L.updateStation(layout, id, { ops: { trucks: { mode: 'schedule' } } });
  L.updateCalendar(layout, null);
  assert.deepEqual(layout.calendar, { startTod: 0, startDay: 0 }, 'but a timetable always has one: removing it resets the clock');
  L.updateStation(layout, id, { ops: null });
  assert.equal(layout.schema, 2, 'the clock alone is schema 2');
  L.updateCalendar(layout, null);
  assert.equal(layout.schema, 1);
  assert.equal(bytes(layout), bytes(build('starter')), 'nothing left: the legacy plant, byte for byte');
  assert.equal(L.updateCalendar(layout, 5), false);
  assert.equal(L.updateCalendar(layout, 'x'), false);
  assert.equal(L.updateCalendar(layout, []), false);
});

test('A1.2 sanitizeCalendar and makeClock read the same fields: strings, clamping, junk', () => {
  assert.deepEqual(sanitizeCalendar({ startTod: '07:30', startDay: '5', shifts: [] }, { stations: [] }), { startTod: 27000, startDay: 5 });
  assert.equal(sanitizeCalendar(undefined, { stations: [{ ops: { trucks: { mode: 'schedule' } } }] }).startTod, 0);
  assert.equal(sanitizeCalendar(undefined, { stations: [{ ops: { trucks: { mode: 'rate' } } }, { ops: {} }, null, 7] }), undefined);
  assert.equal(sanitizeCalendar(undefined, null), undefined);
  assert.equal(makeClock({ startTod: 'x', startDay: 99 }).startDay, 6);
  assert.equal(makeClock(null).startTod, 0);
  assert.equal(makeClock({ startTod: 100000 }).startTod, 86399);
});

test('A1.2 a legacy layout is schema 1, has no ops and no calendar, and every legacy example survives normalizeLayout and the project round trip byte for byte (A1.1 keeps the golden tests for the rest)', () => {
  for (const example of legacyExamples(EXAMPLES)) {
    const layout = example.build();
    assert.equal(layout.schema, 1);
    assert.ok(!('calendar' in layout));
    assert.ok(layout.stations.every((s) => !('ops' in s)));
    const text = bytes(layout);
    assert.equal(bytes(L.normalizeLayout(JSON.parse(text))), text);
    const file = exportProject(project(layout));
    assert.equal(JSON.parse(file).schema, 1);
    assert.equal(importProject(file).warnings, undefined);
    assert.equal(bytes(importProject(file).scenarios[0].layout), text);
  }
  assert.equal(SCHEMA_MAX, 2);
});

// ---------------------------------------------------------------------------------------------------------------------------
// mergeOps and the mutators that touch ops
// ---------------------------------------------------------------------------------------------------------------------------

test('mergeOps: a partial patch keeps what it does not name (the mean of a gap keeps its kind and spread), arrays replace, null removes, junk changes nothing', () => {
  const current = sanitizeOps('source', { trucks: { doors: 4, interArrival: { kind: 'exp', mean: 3000, spread: 0.5 }, schedule: [{ at: 100, pallets: 5 }, { at: 200, pallets: 6 }] } });
  const frozen = bytes(current);
  const merged = (patch) => mergeOps('source', current, patch);
  assert.deepEqual(merged({ trucks: { interArrival: { mean: 2400 } } }).trucks.interArrival, { kind: 'exp', mean: 2400, spread: 0.5 });
  assert.equal(merged({ trucks: { doors: 7 } }).trucks.doors, 7);
  assert.deepEqual(merged({ trucks: { doors: 7 } }).trucks.schedule, current.trucks.schedule, 'a sibling patch keeps the rows');
  assert.deepEqual(merged({ trucks: { schedule: [{ at: 50 }] } }).trucks.schedule, [{ at: 50, pallets: null }], 'a list replaces');
  assert.deepEqual(merged({ trucks: { schedule: [] } }).trucks.schedule, []);
  assert.deepEqual(merged({ trucks: { schedule: null } }).trucks.schedule, [], 'null removes the key, the sanitizer fills the default');
  assert.deepEqual(merged({ trucks: { pallets: null } }).trucks.pallets, TRUCK_DEFAULTS.pallets);
  assert.equal(merged({ trucks: null }), undefined, 'switching the only key off leaves no block');
  assert.equal(merged(null), undefined);
  assert.equal(bytes(merged('junk')), frozen, 'a patch that is not an object changes nothing');
  assert.equal(bytes(merged([1, 2])), frozen);
  assert.equal(bytes(merged(undefined)), frozen);
  assert.equal(merged({ trucks: { doors: 'many' } }).trucks.doors, TRUCK_DEFAULTS.doors, 'junk in a patch takes the default (the loader rule), not the old value');
  assert.equal(merged(JSON.parse('{"trucks":{"doors":7,"__proto__":{"polluted":1}}}')).trucks.doors, 7);
  assert.equal({}.polluted, undefined);
  assert.equal(bytes(current), frozen, 'the current block is never modified');
  assert.equal(mergeOps('source', undefined, { trucks: { interArrival: { mean: 99 } } }).trucks.interArrival.mean, 99, 'creates the block');
  assert.equal(mergeOps('source', undefined, { trucks: { interArrival: { mean: 10 } } }).trucks.interArrival.mean, 60, 'and clamps it: at least one minute between trucks');
  assert.equal(mergeOps('storage', current, { trucks: { doors: 4 } }), undefined);
});

test('updateStation(ops): "Add dock doors", edits of a field, "Remove trucks" and undo keep the layout valid, in one commit each', () => {
  const store = createStore({ storage: null });
  store.replaceLayout(build('starter'));
  const id = stationOf(store.getState().layout, 'source').id;
  const original = bytes(store.getState().layout);
  assert.equal(store.commit('Add dock doors', (d) => L.updateStation(d, id, { ops: { trucks: { doors: 2 } } })), true);
  assert.equal(store.getState().layout.schema, 2);
  assert.equal(store.commit('Set doors', (d) => L.updateStation(d, id, { ops: { trucks: { doors: 5 } } }), { coalesce: 'doors' }), true);
  assert.equal(trucksOf(stationOf(store.getState().layout, 'source')).doors, 5);
  assert.equal(L.layoutChangeKind(L.normalizeLayout(JSON.parse(original)), store.getState().layout), 'structural', 'the simulation is rebuilt');
  assert.equal(store.commit('Remove trucks', (d) => L.updateStation(d, id, { ops: null })), true);
  assert.equal(bytes(store.getState().layout), original);
  assert.ok(store.undo());
  assert.equal(trucksOf(stationOf(store.getState().layout, 'source')).doors, 5);
  assert.ok(store.undo() && store.undo());
  assert.equal(bytes(store.getState().layout), original, 'undo goes back to the legacy plant');
  assert.ok(store.redo() && store.redo() && store.redo());
  assert.equal(store.getState().layout.stations.some((s) => s.ops), false);
});

test('addStation(ops) and duplicateStation: a new Goods in with trucks is valid at once, a copy has its own deep copy, a type without options drops them', () => {
  const layout = build('starter');
  const made = L.addStation(layout, { type: 'sink', x: 1, y: 1, ops: { trucks: { doors: 3, mode: 'schedule' } } });
  assert.ok(made);
  assert.equal(made.ops.trucks.doors, 3);
  assert.deepEqual(Object.keys(made).slice(-2), ['params', 'ops']);
  assert.equal(layout.schema, 2);
  assert.ok(layout.calendar, 'the timetable of the new station created the clock');
  assert.deepEqual(L.checkInvariants(layout), []);
  assert.equal(bytes(L.normalizeLayout(layout)), bytes(layout));
  const storage = L.addStation(layout, { type: 'storage', x: 1, y: 20, ops: { trucks: { doors: 3 } } });
  assert.ok(storage && !('ops' in storage), 'a Storage cannot have trucks');
  assert.ok(!('ops' in L.addStation(layout, { type: 'source', x: 30, y: 1, ops: 'junk' }) ?? {}));
  const copy = L.duplicateStation(layout, made.id);
  assert.equal(bytes(copy.ops), bytes(made.ops));
  copy.ops.trucks.schedule.push({ at: 1, pallets: 1 });
  assert.equal(made.ops.trucks.schedule.length, 0);
  assert.equal(bytes(L.normalizeLayout(layout)).length > 0, true);
});

test('checkInvariants guards the optional blocks: a timetable needs its clock, the clock must be a sanitized block, nothing else may leave one behind that no file could have', () => {
  const layout = truckPlant('starter');
  assert.deepEqual(L.checkInvariants(layout), []);
  const noClock = clone(layout);
  delete noClock.calendar;
  assert.ok(L.checkInvariants(noClock).some((m) => /calendar: missing/.test(m)), 'a mutator that forgot reconcileLayout is caught (and the store rolls the edit back)');
  for (const junkClock of [5, 'x', [], null, { startTod: 'x', startDay: 0 }, { startTod: 0, startDay: 9 }, { startTod: 0 }, { startTod: 0, startDay: 0, shifts: [] }]) {
    const broken = clone(layout);
    broken.calendar = junkClock;
    assert.ok(L.checkInvariants(broken).some((m) => /^calendar:/.test(m)), bytes(junkClock));
  }
  const legacy = build('starter');
  legacy.calendar = 5;
  legacy.schema = 2;
  assert.ok(L.checkInvariants(legacy).some((m) => /^calendar:/.test(m)));
  const store = createStore({ storage: null });
  store.replaceLayout(layout);
  assert.throws(() => store.commit('Forgot to reconcile', (d) => { delete d.calendar; }), /calendar/);
  assert.equal(bytes(store.getState().layout), bytes(layout), 'rolled back');
});

test('reconcileLayout on a layout whose stamp or clock is stale puts both right (a store draft that was edited by hand)', () => {
  const layout = truckPlant('starter');
  const good = bytes(layout);
  layout.schema = 1;
  delete layout.calendar;
  reconcileLayout(layout);
  assert.equal(bytes(layout), good);
  const frozen = deepFreeze(JSON.parse(good));
  assert.doesNotThrow(() => reconcileLayout(frozen), 'nothing to write, so nothing is written');
});

// ---------------------------------------------------------------------------------------------------------------------------
// After EVERY mutator, normalizeLayout(layout) is the layout
// ---------------------------------------------------------------------------------------------------------------------------

/** Assert that a layout is exactly what normalizeLayout makes of it (also the order of the keys), valid, and stamped. */
function assertFixedPoint(layout, what) {
  assert.deepEqual(L.checkInvariants(layout), [], `${what}: invariants`);
  assert.equal(layout.schema, schemaNeeded(layout), `${what}: stamp`);
  assert.equal(bytes(L.normalizeLayout(layout)), bytes(layout), `${what}: normalizeLayout(layout) is not the layout`);
}

test('every mutator of layout.js, 3,000 random calls on plants with trucks and a timetable: normalizeLayout(layout) is the layout after each call (byte for byte)', () => {
  const names = Object.keys(MUTATORS);
  const emphasis = ['updateStation', 'updateStation', 'updateStation', 'addStation', 'removeStation', 'duplicateStation', 'updateCalendar', 'resizeGrid', 'removeFleet', 'removeFlow'];
  const all = [...names, ...emphasis];
  const tried = new Set();
  let steps = 0;
  let withTrucks = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const rng = createRng(1000 + seed);
    const layout = truckPlant(['starter', 'two-lines', 'congestion-lab'][seed % 3]);
    for (let i = 0; i < 100; i++) {
      const name = pick(rng, all);
      tried.add(name);
      MUTATORS[name](layout, rng);
      steps++;
      if (layout.stations.some((s) => s.ops)) withTrucks++;
      assertFixedPoint(layout, `seed ${seed} step ${i} (${name})`);
    }
  }
  assert.equal(steps, 3000);
  assert.ok(withTrucks > 1500, `trucks were present in ${withTrucks} of ${steps} states`);
  assert.deepEqual(names.filter((n) => !tried.has(n)), [], 'every mutator was driven');
});

test('every mutator through the real store with undo and redo: each commit is accepted, undo restores the previous layout exactly, redo the next', () => {
  const names = Object.keys(MUTATORS);
  for (let seed = 1; seed <= 6; seed++) {
    const rng = createRng(2000 + seed);
    const store = createStore({ storage: null });
    store.replaceLayout(truckPlant(['starter', 'two-lines', 'congestion-lab'][seed % 3]));
    const history = [bytes(store.getState().layout)];
    let committed = 0;
    for (let i = 0; i < 60; i++) {
      const name = pick(rng, names);
      let ok;
      try {
        ok = store.commit(`${name} #${i}`, (draft) => MUTATORS[name](draft, rng));
      } catch (error) {
        assert.fail(`seed ${seed} step ${i}: "${name}" was rolled back: ${error.message}`);
      }
      if (ok) {
        committed++;
        history.push(bytes(store.getState().layout));
      }
      assertFixedPoint(store.getState().layout, `seed ${seed} step ${i} (${name})`);
    }
    assert.ok(committed > 15, `seed ${seed}: ${committed} commits`);
    // walk back through the history (the store keeps up to 100 steps) and forward again
    for (let k = history.length - 2; k >= 0; k--) {
      assert.ok(store.undo(), `undo ${k}`);
      assert.equal(bytes(store.getState().layout), history[k], `seed ${seed}: undo to ${k}`);
      assertFixedPoint(store.getState().layout, `seed ${seed}: after undo to ${k}`);
    }
    for (let k = 1; k < history.length; k++) {
      assert.ok(store.redo(), `redo ${k}`);
      assert.equal(bytes(store.getState().layout), history[k], `seed ${seed}: redo to ${k}`);
    }
  }
});

test('duplicate and remove a station with trucks through the real store: checkInvariants stays true, undo and redo bring the clock, the stamp and the block back together', () => {
  const store = createStore({ storage: null });
  store.replaceLayout(truckPlant('two-lines'));
  const state = () => store.getState().layout;
  const source = stationOf(state(), 'source');
  const sink = stationOf(state(), 'sink');
  let copyId = null;
  assert.equal(store.commit('Duplicate', (d) => { copyId = L.duplicateStation(d, source.id)?.id ?? null; }), true);
  assert.ok(copyId);
  assertFixedPoint(state(), 'after the copy');
  assert.equal(state().stations.find((s) => s.id === copyId).ops.trucks.mode, 'schedule');
  assert.equal(store.commit('Delete the original', (d) => L.removeStation(d, source.id)), true);
  assertFixedPoint(state(), 'after deleting the original');
  assert.ok(state().calendar, 'the copy still runs a timetable: the clock stays');
  assert.equal(store.commit('Delete the copy', (d) => L.removeStation(d, copyId)), true);
  assertFixedPoint(state(), 'after deleting the copy');
  assert.equal(state().schema, 2, 'the Goods out still has trucks');
  assert.equal(store.commit('Delete the Goods out', (d) => L.removeStation(d, sink.id)), true);
  assertFixedPoint(state(), 'after deleting the last station with trucks');
  assert.ok(state().calendar, 'the clock itself is not derived from nothing: it stays until the planner removes it');
  assert.equal(state().schema, 2, 'and the clock alone is schema 2');
  assert.equal(store.commit('No clock', (d) => L.updateCalendar(d, null)), true);
  assert.equal(state().schema, 1);
  assert.ok(!('calendar' in state()));
  for (let i = 0; i < 5; i++) {
    assert.ok(store.undo(), `undo ${i}`);
    assertFixedPoint(state(), `undo ${i}`);
  }
  assert.equal(state().stations.filter((s) => s.ops).length, 2, 'the original and the Goods out are back after five undos');
  for (let i = 0; i < 5; i++) {
    assert.ok(store.redo(), `redo ${i}`);
    assertFixedPoint(state(), `redo ${i}`);
  }
  assert.equal(state().stations.filter((s) => s.ops).length, 0);
  // shrinking the plan removes stations through removeStation
  const small = createStore({ storage: null });
  small.replaceLayout(truckPlant('two-lines'));
  assert.doesNotThrow(() => small.commit('Shrink', (d) => { L.resizeGrid(d, 8, 8); }));
  assertFixedPoint(small.getState().layout, 'after resizeGrid');
});

// ---------------------------------------------------------------------------------------------------------------------------
// Fuzz: ops and calendar junk
// ---------------------------------------------------------------------------------------------------------------------------

test('fuzz: prototype keys in a file (JSON with own "__proto__", "constructor" and "prototype" keys) reach no prototype and no station', () => {
  const text = '{"__proto__":{"polluted":"top"},"name":"P","calendar":{"__proto__":{"startTod":5},"constructor":{"prototype":{"polluted":"cal"}},"startTod":"06:00"},'
    + '"grid":{"cols":24,"rows":12,"cellSize":2},"stations":[{"type":"source","x":2,"y":2,"w":3,"h":2,"ops":{"__proto__":{"trucks":{"doors":9}},"trucks":{"__proto__":{"doors":31,"polluted":1},'
    + '"constructor":{"prototype":{"polluted":2}},"doors":"4","interArrival":{"__proto__":{"mean":61},"mean":3000},"schedule":[{"__proto__":{"at":7},"at":"07:00","pallets":"6"},{"prototype":1}]}}}]}';
  const raw = JSON.parse(text);
  assert.ok(Object.hasOwn(raw.stations[0].ops, '__proto__'), 'the document really has an own __proto__ key');
  const out = L.normalizeLayout(raw);
  assert.equal(out.stations[0].ops.trucks.doors, 4);
  assert.equal(out.stations[0].ops.trucks.interArrival.mean, 3000);
  assert.deepEqual(out.stations[0].ops.trucks.schedule, [{ at: 25200, pallets: 6 }]);
  assert.deepEqual(out.calendar, { startTod: 21600, startDay: 0 });
  assert.equal(JSON.stringify(out).includes('polluted'), false);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(Object.keys(Object.prototype), []);
  // Object.create(proto): inherited fields are not read
  const heir = Object.create({ trucks: { doors: 30 } });
  assert.equal(sanitizeOps('source', heir), undefined);
  assert.equal(sanitizeOps('source', { trucks: Object.create({ doors: 30 }) }).trucks.doors, TRUCK_DEFAULTS.doors);
});

test('fuzz: trucks blocks written by the panel, patch by patch, never leave the sanitizer\'s fixed point (50,000 random patches through mergeOps)', () => {
  const rng = createRng(77);
  let current;
  const pieces = [
    () => ({ doors: rng.pick([1, 5, 33, -2, '4', 2.5, 'x', null]) }), () => ({ mode: rng.pick(['rate', 'schedule', 'x', null, 3]) }),
    () => ({ interArrival: { mean: rng.pick([10, 600, 1e7, '900', null, 'x']) } }), () => ({ interArrival: { kind: rng.pick(['exp', 'const', 'x']) , spread: rng.pick([0, 2, -1, 'z']) } }),
    () => ({ pallets: { mean: rng.pick([0, 12, 500]) } }), () => ({ schedule: Array.from({ length: rng.int(4) }, () => ({ at: rng.int(90000), pallets: rng.pick([3, null, 'x']) })) }),
    () => ({ schedule: null }), () => ({ jitter: rng.pick([0, 600, 1e5]) }), () => ({ noShow: rng.pick([0, 0.2, 0.9, -1]) }), () => ({ staging: rng.pick([0, 4, 99]) }), () => ({ maxDwell: rng.pick([0, 99999, 1800]) }),
    () => ({ checkIn: rng.pick([0, 300, 1e5, -1]), checkOut: rng.pick([0, 60]) }),
  ];
  for (let i = 0; i < 50000; i++) {
    const patch = rng.next() < 0.03 ? rng.pick([null, 'x', {}, { trucks: null }]) : { trucks: Object.assign({}, ...Array.from({ length: 1 + rng.int(3) }, () => pieces[rng.int(pieces.length)]())) };
    current = mergeOps('sink', current, patch);
    if (current !== undefined) assert.equal(bytes(sanitizeOps('sink', current)), bytes(current), `patch ${i}: ${bytes(patch)}`);
  }
});
