// Milestone M0 of the warehouse module (docs/WAREHOUSE-DESIGN.md 5.2, 9.1): the data seams.
//   A0.2  the three legacy layouts and the three captured share links round-trip byte for byte, with schema 1
//   A0.3  schemaNeeded: legacy 1, every row of the table in 5.2 gives its number, the highest row wins
//   A0.4  importProject warns for a schema above SCHEMA_MAX and for nothing at or below it; the project is stamped with the highest layout schema
//   plus the seams themselves: the empty sanitizers (sanitizeOps, mergeOps, sanitizeCalendar, normalizeExtensions) drop everything, so no
//   layout can carry an `ops` or `calendar` key yet; updateStation accepts an `ops` patch, duplicateStation copies `ops`, checkInvariants
//   accepts exactly schemaNeeded.
// M1 UPDATE: M1 fills the seams for Goods in and Goods out (ops.trucks) and the clock (calendar.startTod, startDay), so the tests that described
// the EMPTY seams now describe what is still empty (every other station type, every later row of the schema table); the rest is unchanged.
// The exhaustive tests of the M1 content are in tests/model.ops-trucks.test.js; these stand-in tests prove the wiring and still pass beside the real sanitizers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/model/layout.js';
import { createLayout } from '../js/model/layout.js';
import { SCHEMA_VERSION, STATION_TYPES } from '../js/model/defaults.js';
import { EXAMPLES } from '../js/model/examples.js';
import { SCHEMA_BASE, SCHEMA_MAX, SCHEMA_ROWS, migrate, schemaNeeded } from '../js/model/schema.js';
import { OPS_KEYS, OPS_SANITIZERS, clampInt, clampNumber, mergeOps, numberOf, sanitizeOps } from '../js/model/ops.js';
import { CALENDAR_KEYS, mergeCalendar, sanitizeCalendar, timeOfDay } from '../js/model/calendar.js';
import { EXTENSION_BLOCKS, normalizeExtensions } from '../js/model/extensions.js';
import { decodeShare, encodeShare, exportProject, importProject } from '../js/model/serialize.js';
import { kpisFile, layoutFile, readGolden, shareFile } from './helpers/golden.js';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const project = (layout, name = 'P', id = 'sc1') => ({ name, scenarios: [{ id, name: 'A', layout }], activeId: id });

/** A small legacy plant with one station of every type that can carry options, and a fleet. */
function plant() {
  const l = createLayout({ name: 'Seams', cols: 24, rows: 12, cellSize: 2 });
  L.paintRoadPath(l, [[1, 5], [22, 5]]);
  const src = L.addStation(l, { type: 'source', x: 2, y: 2, w: 3, h: 2 });
  const sto = L.addStation(l, { type: 'storage', x: 8, y: 2, w: 4, h: 2 });
  const snk = L.addStation(l, { type: 'sink', x: 16, y: 2, w: 3, h: 2 });
  L.addFlow(l, src.id, sto.id);
  L.addFlow(l, sto.id, snk.id);
  L.addFleet(l, 'forklift', { count: 2 });
  return l;
}

// ---------------------------------------------------------------------------------------------------------------------------
// A0.2: legacy layouts and share links are unchanged
// ---------------------------------------------------------------------------------------------------------------------------

for (const example of EXAMPLES) {
  test(`A0.2 ${example.id}: the recorded legacy layout is a fixed point of normalizeLayout, with schema 1`, () => {
    const text = readGolden(layoutFile(example.id));
    assert.equal(JSON.stringify(example.build()), text, 'the example still builds the recorded layout');
    const normalized = L.normalizeLayout(JSON.parse(text));
    assert.equal(JSON.stringify(normalized), text, 'normalizeLayout(x) is x, key for key and in the same order');
    assert.equal(normalized.schema, 1);
    assert.deepEqual(L.checkInvariants(normalized), []);
    for (const key of ['ops', 'calendar', 'loadTypes']) assert.ok(!(key in normalized), `no ${key} on a legacy layout`);
    for (const st of normalized.stations) assert.ok(!('ops' in st), `no ops on ${st.name}`);
  });

  test(`A0.2 ${example.id}: export, import and the captured share link keep the layout byte for byte`, async () => {
    const text = readGolden(layoutFile(example.id));
    const layout = JSON.parse(text);
    // exportProject / importProject
    const file = exportProject(project(layout, example.name));
    assert.equal(JSON.parse(file).schema, 1, 'the project of a legacy layout is stamped 1');
    const imported = importProject(file);
    assert.equal(imported.warnings, undefined, 'no warning');
    assert.equal(JSON.stringify(imported.scenarios[0].layout), text);
    // the share link captured on the tree before the warehouse module (made by shareUrl), and a fresh one
    const link = readGolden(shareFile(example.id)).trim();
    const old = await decodeShare(link);
    assert.equal(old.warnings, undefined, 'an old share link opens without a warning');
    assert.equal(old.scenarios.length, 1);
    assert.equal(JSON.stringify(old.scenarios[0].layout), text, 'the captured link decodes to the recorded layout');
    assert.equal(old.scenarios[0].layout.schema, 1);
    const fresh = await decodeShare(await encodeShare(project(layout, example.name)));
    assert.equal(JSON.stringify(fresh.scenarios[0].layout), text, 'a link made now decodes to the same layout');
  });
}

test('A0.2: the golden KPI fixtures exist for both seeds of every example (the safety net is complete)', () => {
  for (const example of EXAMPLES) for (const seed of [1, 2]) assert.ok(readGolden(kpisFile(example.id, seed)).length > 1000);
});

test('A0.2: createLayout and emptyLayout still stamp the base schema', () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(SCHEMA_BASE, SCHEMA_VERSION);
  assert.equal(createLayout().schema, SCHEMA_VERSION);
  assert.equal(L.normalizeLayout({}).schema, SCHEMA_VERSION);
});

// ---------------------------------------------------------------------------------------------------------------------------
// A0.3: schemaNeeded
// ---------------------------------------------------------------------------------------------------------------------------

/** A layout shaped like a normalized one, with the given extra keys (raw: schemaNeeded reads documented keys, not sanitizers). */
function with_(patch) {
  const l = plant();
  if (patch.station) l.stations[0].ops = patch.station;
  if (patch.storage) l.stations[1].ops = patch.storage;
  if (patch.fleet) Object.assign(l.fleets[0], patch.fleet);
  if (patch.flow) Object.assign(l.flows[0], patch.flow);
  for (const key of ['calendar', 'loadTypes']) if (patch[key] !== undefined) l[key] = patch[key];
  return l;
}

/** The rows of docs/WAREHOUSE-DESIGN.md 5.2, one layout per documented key. */
const ROW_CASES = [
  [2, 'ops.trucks', with_({ station: { trucks: { doors: 2 } } })],
  [2, 'layout.calendar (startTod, startDay)', with_({ calendar: { startTod: 21600, startDay: 0 } })],
  [3, 'calendar.shifts', with_({ calendar: { startTod: 0, startDay: 0, shifts: [] } })],
  [3, 'calendar.profiles', with_({ calendar: { profiles: [] } })],
  [3, 'ops.calendar', with_({ station: { calendar: { staffing: [] } } })],
  [3, 'fleet.calendar', with_({ fleet: { calendar: { staffing: [] } } })],
  [3, 'ops.trucks.schedule[].days', with_({ station: { trucks: { schedule: [{ at: 21600, pallets: 24 }, { at: 25200, pallets: 24, days: [0, 1] }] } } })],
  [4, 'ops.form', with_({ storage: { form: 'rack' } })],
  [4, 'ops.rack', with_({ storage: { rack: { levels: 5 } } })],
  [4, 'ops.block', with_({ storage: { block: { stack: 2 } } })],
  [4, 'ops.putaway', with_({ storage: { putaway: 'least-full' } })],
  [4, 'fleet.aisleMin', with_({ fleet: { aisleMin: 2.8 } })],
  [4, 'fleet.liftHeight', with_({ fleet: { liftHeight: 10 } })],
  [5, 'ops.putaway nearest-free', with_({ storage: { putaway: 'nearest-free' } })],
  [5, 'ops.trucks.depart', with_({ station: { trucks: { depart: 3600 } } })],
  [5, 'ops.trucks.releaseLead', with_({ station: { trucks: { releaseLead: 5400 } } })],
  [5, 'ops.trucks.grace', with_({ station: { trucks: { grace: 900 } } })],
  [5, 'ops.trucks.schedule[].depart', with_({ station: { trucks: { schedule: [{ at: 21600, pallets: 24, depart: 25200 }] } } })],
  [6, 'layout.loadTypes', with_({ loadTypes: [{ id: 'fast' }] })],
  [6, 'flow.types', with_({ flow: { types: ['fast'] } })],
  [6, 'ops.mix', with_({ station: { mix: [{ type: 'fast', share: 1 }] } })],
  [6, 'ops.trucks.mix', with_({ station: { trucks: { mix: [] } } })],
  [6, 'ops.trucks.schedule[].mix', with_({ station: { trucks: { schedule: [{ at: 0, mix: [] }] } } })],
  [6, 'ops.accepts', with_({ storage: { accepts: ['fast'] } })],
  [6, 'ops.outType', with_({ station: { outType: 'fast' } })],
  [7, 'ops.pick', with_({ station: { pick: { lines: 2 } } })],
];

test('A0.3 schemaNeeded: a legacy layout needs 1, whatever it holds besides the warehouse keys', () => {
  assert.equal(schemaNeeded(plant()), 1);
  assert.equal(schemaNeeded(createLayout()), 1);
  for (const ex of EXAMPLES) assert.equal(schemaNeeded(ex.build()), 1, ex.id);
  assert.equal(schemaNeeded({ ...plant(), schema: 99 }), 1, 'the stamp itself is not read: content decides');
});

for (const [row, what, layout] of ROW_CASES) {
  test(`A0.3 schemaNeeded: ${what} needs schema ${row}`, () => {
    assert.equal(schemaNeeded(layout), row);
  });
}

test('A0.3 schemaNeeded: every row of the table is covered by a case, rows are 1 to 7 in order', () => {
  assert.deepEqual(SCHEMA_ROWS.map((r) => r.schema), [1, 2, 3, 4, 5, 6, 7]);
  for (const row of SCHEMA_ROWS.filter((r) => r.schema > 1)) assert.ok(ROW_CASES.some(([n]) => n === row.schema), `row ${row.schema} has a case`);
  for (const row of SCHEMA_ROWS) assert.ok(row.milestone && row.keys, `row ${row.schema} documents its keys`);
});

test('A0.3 schemaNeeded: the highest row wins, in any order of the keys', () => {
  const both = with_({ station: { trucks: { doors: 2, schedule: [{ at: 0, days: [1] }] } }, fleet: { aisleMin: 3 } });
  assert.equal(schemaNeeded(both), 4, 'rows 2, 3 and 4 together');
  const high = with_({ station: { pick: {} }, calendar: { startTod: 0, startDay: 0 }, flow: { types: ['a'] } });
  assert.equal(schemaNeeded(high), 7, 'rows 2, 6 and 7 together');
  const l = with_({ calendar: { startTod: 0, startDay: 0, profiles: [] }, storage: { putaway: 'nearest-free' } });
  assert.equal(schemaNeeded(l), 5);
  assert.equal(schemaNeeded({ ...l, stations: [...l.stations].reverse() }), 5, 'station order does not matter');
});

test('A0.3 schemaNeeded: an unknown key or an empty block does not raise the schema; junk is never a problem', () => {
  assert.equal(schemaNeeded(with_({ station: {} })), 1, 'an empty ops block names no key');
  assert.equal(schemaNeeded(with_({ station: { hologram: true } })), 1);
  assert.equal(schemaNeeded(with_({ station: { trucks: undefined } })), 1);
  for (const junk of [null, undefined, 5, 'x', [], { stations: 'x' }, { stations: [null, 3, { ops: 5 }, { ops: [] }], fleets: {}, flows: 7 }]) {
    assert.equal(schemaNeeded(junk), 1, JSON.stringify(junk));
  }
});

test('A0.3 SCHEMA_MAX: this build implements rows 1 and 2 of the table (M1: trucks and the clock; M2 raises it to 3)', () => {
  assert.equal(SCHEMA_MAX, 2);
  assert.ok(SCHEMA_MAX >= SCHEMA_BASE);
});

test('migrate is the identity for now', () => {
  const raw = { a: 1 };
  assert.equal(migrate(raw), raw);
});

// ---------------------------------------------------------------------------------------------------------------------------
// The empty seams: nothing of the warehouse module is stored yet
// ---------------------------------------------------------------------------------------------------------------------------

const JUNK_OPS = [
  undefined, null, 0, 'trucks', [], {}, { trucks: { doors: 2 } }, { trucks: { doors: 99, mode: 'schedule', schedule: [{ at: 1 }] }, form: 'rack' },
  { __proto__: { x: 1 }, rack: { levels: 'many' } }, { calendar: { staffing: [] }, pick: {} },
];

test('types that have no options drop every ops block, and the truck types drop everything that holds no trucks block; none of it throws', () => {
  for (const type of Object.keys(STATION_TYPES)) {
    const carries = type === 'source' || type === 'sink';
    for (const raw of JUNK_OPS) {
      const hasTrucks = raw !== null && typeof raw === 'object' && Object.hasOwn(raw, 'trucks') && raw.trucks !== null && typeof raw.trucks === 'object' && !Array.isArray(raw.trucks);
      const out = sanitizeOps(type, raw);
      assert.equal(out !== undefined, carries && hasTrucks, `${type} ${JSON.stringify(raw)}`);
      if (!carries) assert.equal(mergeOps(type, { trucks: { doors: 2 } }, raw), undefined);
      assert.equal(mergeOps(type, undefined, null), undefined, 'null removes the block');
      assert.doesNotThrow(() => mergeOps(type, out, raw));
    }
  }
  for (const raw of [undefined, null, 3, 'x', []]) {
    assert.equal(sanitizeCalendar(raw, plant()), undefined, 'a plant without a timetable has a clock only if the file has one');
    assert.equal(mergeCalendar(undefined, raw), undefined, 'nothing to merge into');
  }
  assert.deepEqual(sanitizeCalendar({ startTod: 6 * 3600, startDay: 0, shifts: [{}] }, plant()), { startTod: 21600, startDay: 0 }, 'M1 keeps the two clock keys; shifts arrive with M2');
  assert.deepEqual(sanitizeCalendar({}, plant()), { startTod: 0, startDay: 0 });
  assert.deepEqual(mergeCalendar({ startTod: 0, startDay: 0 }, { startTod: '07:30' }), { startTod: 27000, startDay: 0 });
  assert.equal(mergeCalendar({ startTod: 0, startDay: 0 }, null), undefined);
  assert.deepEqual(normalizeExtensions({ calendar: { startTod: 0, startDay: 0 }, loadTypes: [{ id: 'a' }] }, plant()), { calendar: { startTod: 0, startDay: 0 } }, 'loadTypes (M5) is still dropped');
  assert.deepEqual(normalizeExtensions({}, plant()), {});
});

test('the registries that milestones add to hold what M1 registers: trucks for Goods in and Goods out, the calendar block', () => {
  assert.deepEqual(Object.keys(OPS_SANITIZERS).sort(), ['sink', 'source']);
  assert.deepEqual(EXTENSION_BLOCKS.map((b) => b.key), ['calendar']);
});

test('the tables of documented keys are frozen and every entry has a sample the sanitizer keeps', () => {
  assert.ok(Array.isArray(OPS_KEYS) && Object.isFrozen(OPS_KEYS) && OPS_KEYS.length > 0);
  assert.ok(Array.isArray(CALENDAR_KEYS) && Object.isFrozen(CALENDAR_KEYS) && CALENDAR_KEYS.length > 0);
  for (const entry of OPS_KEYS) { // structural check for the entries that milestones add (10.2 drives the round trip from this table)
    assert.equal(typeof entry.key, 'string');
    assert.ok(Array.isArray(entry.types) && entry.types.every((t) => Object.hasOwn(STATION_TYPES, t)), entry.key);
    assert.ok(Number.isInteger(entry.schema) && entry.schema >= 2 && entry.schema <= 7, entry.key);
    assert.notEqual(entry.sample, undefined, entry.key);
  }
});

test('later rows of the schema table are still dropped by normalizeLayout: shifts, load types, flow types, fleet keys, racks; the M1 content survives with schema 2', () => {
  const raw = plant();
  raw.stations[0].ops = { trucks: { doors: 3, checkIn: 300, mode: 'rate', schedule: [{ at: 21600, pallets: 24, days: [0, 1], depart: 25000, mix: [] }], depart: 3600 }, mix: [{ type: 'fast', share: 1 }] };
  raw.stations[1].ops = { form: 'rack', rack: { levels: 5 }, putaway: 'nearest-free' };
  raw.calendar = { startTod: 21600, startDay: 1, shifts: [{ id: 'early' }], profiles: [] };
  raw.loadTypes = [{ id: 'fast', name: 'Fast' }];
  raw.flows[0].types = ['fast'];
  raw.fleets[0].calendar = { staffing: [{ shift: 'early', count: 1 }] };
  raw.fleets[0].aisleMin = 2.8;
  raw.schema = 6;
  const n = L.normalizeLayout(raw);
  assert.equal(n.schema, 2, 'stamped with what the normalized content needs: the trucks and the clock, nothing of rows 3 to 7');
  assert.deepEqual(L.checkInvariants(n), []);
  assert.deepEqual(n.calendar, { startTod: 21600, startDay: 1 });
  assert.ok(!('loadTypes' in n));
  assert.deepEqual(Object.keys(n.stations[0].ops), ['trucks'], 'ops.mix (M5) is gone');
  assert.deepEqual(Object.keys(n.stations[0].ops.trucks), ['doors', 'checkIn', 'checkOut', 'mode', 'interArrival', 'pallets', 'schedule', 'jitter', 'noShow', 'maxDwell', 'staging']);
  assert.deepEqual(n.stations[0].ops.trucks.schedule, [{ at: 21600, pallets: 24 }], 'days, depart and mix of a row are later rows');
  assert.ok(!('ops' in n.stations[1]), 'a storage cannot carry ops yet (M3)');
  assert.ok(!('types' in n.flows[0]));
  assert.ok(!('calendar' in n.fleets[0]) && !('aisleMin' in n.fleets[0]));
  assert.equal(JSON.stringify(L.normalizeLayout(n)), JSON.stringify(n), 'idempotent');
  delete raw.stations[0].ops;
  delete raw.calendar;
  assert.equal(JSON.stringify(L.normalizeLayout(raw)), JSON.stringify(L.normalizeLayout(plant())), 'without the M1 keys it is the legacy plant again, schema 1');
});

test('updateStation accepts an ops patch: Goods in and Goods out store it, other types drop it, the stamp stays true', () => {
  const l = plant();
  const id = l.stations[0].id;
  const storage = l.stations.find((s) => s.type === 'storage');
  const before = JSON.stringify(l);
  assert.equal(L.updateStation(l, storage.id, { ops: { trucks: { doors: 2 } } }), true);
  assert.equal(JSON.stringify(l), before, 'a Storage has no options: a legacy layout is unchanged by the patch');
  assert.equal(L.updateStation(l, id, { ops: { trucks: { doors: 2 } } }), true);
  assert.equal(l.stations[0].ops.trucks.doors, 2);
  assert.equal(l.schema, 2);
  assert.equal(L.updateStation(l, id, { name: 'Renamed' }), true);
  assert.ok('ops' in l.stations[0], 'a patch without ops leaves the block alone');
  assert.equal(L.updateStation(l, id, { ops: null, name: 'Source 1' }), true);
  assert.ok(!('ops' in l.stations[0]));
  assert.equal(l.schema, 1);
  assert.equal(JSON.stringify(l), before, 'and the plant is the legacy plant again, byte for byte');
  assert.equal(L.updateStation(l, 'nope', { ops: {} }), false);
  assert.equal(L.updateStation(l, id, { ops: undefined, name: 'Again' }), true, 'an undefined ops is no patch');
});

test('updateStation: params, geometry and ops in one patch behave as before (atomic: a blocked move rejects the ops too)', () => {
  const l = plant();
  const [a, b] = l.stations;
  l.stations[0].ops = { trucks: {} };
  assert.equal(L.updateStation(l, a.id, { x: b.x, y: b.y, ops: null }), false, 'blocked geometry');
  assert.ok('ops' in l.stations[0], 'rejected: the block is still there');
});

test('duplicateStation copies ops (a deep copy), and a station without ops stays without', () => {
  const l = plant();
  const first = l.stations[0];
  const plain = L.duplicateStation(l, first.id);
  assert.ok(plain && !('ops' in plain));
  first.ops = { trucks: { doors: 2, schedule: [{ at: 1 }] } };
  const copy = L.duplicateStation(l, first.id);
  assert.deepEqual(copy.ops, first.ops);
  assert.notEqual(copy.ops, first.ops, 'not the same object');
  assert.notEqual(copy.ops.trucks, first.ops.trucks);
  copy.ops.trucks.doors = 9;
  assert.equal(first.ops.trucks.doors, 2, 'changing the copy leaves the original alone');
  assert.deepEqual(Object.keys(copy).slice(-2), ['params', 'ops'], 'ops comes after params');
});

test('checkInvariants accepts exactly schemaNeeded and rejects an ops block that sanitizeOps would not keep', () => {
  const l = plant();
  assert.deepEqual(L.checkInvariants(l), []);
  l.schema = 2;
  assert.ok(L.checkInvariants(l).some((m) => /schema must be 1/.test(m)), 'a legacy layout stamped 2');
  l.schema = 1;
  l.calendar = { startTod: 0, startDay: 0 };
  assert.ok(L.checkInvariants(l).some((m) => /schema must be 2/.test(m)), 'a layout that uses a schema-2 key but is stamped 1');
  l.schema = 2;
  assert.ok(!L.checkInvariants(l).some((m) => /schema/.test(m)), 'stamped with what it needs');
  delete l.calendar;
  l.schema = 1;
  l.stations[0].ops = { trucks: { doors: 2 } };
  assert.ok(L.checkInvariants(l).some((m) => /ops is not a sanitized/.test(m)), 'a truck block must hold every field');
  l.stations[0].ops = undefined;
  assert.deepEqual(L.checkInvariants(l), [], 'an ops key that is undefined is no block');
});

// ---------------------------------------------------------------------------------------------------------------------------
// A0.4: importProject warnings and the project stamp
// ---------------------------------------------------------------------------------------------------------------------------

test('A0.4 importProject warns when the file or a layout has a schema above SCHEMA_MAX, and for nothing at or below it', () => {
  const layout = plant();
  const file = (schema, layoutSchema) => JSON.stringify({ app: 'logiplan', schema, name: 'F', scenarios: [{ id: 'a', name: 'A', layout: { ...layout, schema: layoutSchema } }] });
  for (const ok of [[undefined, undefined], [0, 0], [SCHEMA_MAX, SCHEMA_MAX], [SCHEMA_MAX - 1, 0], [SCHEMA_MAX, 1]]) {
    assert.equal(importProject(file(...ok)).warnings, undefined, `schema ${ok} is fine`);
  }
  for (const [fileSchema, layoutSchema] of [[SCHEMA_MAX + 1, 1], [1, SCHEMA_MAX + 1], [SCHEMA_MAX + 3, SCHEMA_MAX + 4], [12, 12]]) {
    const p = importProject(file(fileSchema, layoutSchema));
    assert.equal(p.warnings.length, 1, `schema ${fileSchema}/${layoutSchema} warns once`);
    const newest = Math.max(fileSchema, layoutSchema);
    assert.match(p.warnings[0], new RegExp(`newer version of LogiPlan \\(format ${newest}; this version reads format ${SCHEMA_MAX}\\)`));
    assert.equal(p.scenarios[0].layout.schema, 1, 'the layout is opened anyway, stamped with what this build can express');
  }
});

test('A0.4 a bare layout with a newer schema warns too', () => {
  assert.equal(importProject(JSON.stringify({ ...plant(), schema: SCHEMA_MAX + 1 })).warnings.length, 1);
  assert.equal(importProject(JSON.stringify(plant())).warnings, undefined);
});

test('A0.4 exportProject stamps the project with the highest schema among its layouts (never below 1)', () => {
  const legacy = plant();
  assert.equal(JSON.parse(exportProject(project(legacy))).schema, 1);
  const stamped = { ...plant(), schema: 3 };
  const content = { ...plant(), calendar: { startTod: 0, startDay: 0, shifts: [] } }; // stamped 1 but needs 3: the content counts
  const rank = (...layouts) => JSON.parse(exportProject({ name: 'P', scenarios: layouts.map((layout, i) => ({ id: `s${i}`, name: `S${i}`, layout })), activeId: 's0' })).schema;
  assert.equal(rank(legacy, stamped), 3);
  assert.equal(rank(content), 3);
  assert.equal(rank(legacy, { ...plant(), schema: 2 }, legacy), 2);
  assert.equal(rank(legacy, { ...plant(), schema: 'x' }), 1, 'junk stamps are ignored');
  assert.equal(JSON.parse(exportProject({ name: 'P', scenarios: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B', layout: legacy }], activeId: 'b' })).schema, 1, 'a scenario without a layout does not matter');
});

test('A0.4 a share link of a plant with a newer schema (a later build) opens with the warning; old links open without one', async () => {
  const newer = { ...plant(), schema: SCHEMA_MAX + 1 };
  const link = await encodeShare({ name: 'Future', scenarios: [{ id: 'a', name: 'A', layout: newer }], activeId: 'a' });
  const opened = await decodeShare(link);
  assert.equal(JSON.parse(exportProject({ name: 'x', scenarios: [{ id: 'a', name: 'A', layout: newer }], activeId: 'a' })).schema, SCHEMA_MAX + 1);
  assert.equal(opened.warnings.length, 1);
  assert.match(opened.warnings[0], /newer version/);
  const oldLink = await encodeShare(project(plant()));
  assert.equal((await decodeShare(oldLink)).warnings, undefined);
});

// ---------------------------------------------------------------------------------------------------------------------------
// Clamping helpers the later sanitizers share
// ---------------------------------------------------------------------------------------------------------------------------

test('numberOf, clampNumber and clampInt accept numbers and numeric strings, clamp, and never return NaN or -0', () => {
  assert.equal(numberOf(3), 3);
  assert.equal(numberOf('4.5'), 4.5);
  assert.equal(numberOf(' 7 '), 7);
  for (const junk of ['', '  ', 'abc', NaN, Infinity, -Infinity, null, undefined, {}, [], true, '1e999']) assert.equal(numberOf(junk), null, String(junk));
  assert.equal(clampNumber(5, 1, 3, 2), 3);
  assert.equal(clampNumber('0.2', 1, 3, 2), 1);
  assert.equal(clampNumber('x', 1, 3, 2), 2, 'junk takes the fallback');
  assert.equal(clampNumber('x', 1, 3, 9), 3, 'and the fallback is clamped too');
  assert.ok(Object.is(clampNumber(-0, -1, 1, 0), 0), 'never -0');
  assert.equal(clampInt(2.5, 1, 10, 1), 3);
  assert.equal(clampInt('99', 1, 32, 2), 32);
  assert.equal(clampInt(null, 1, 32, 2), 2);
  assert.ok(Object.is(clampInt(-0.2, -5, 5, 0), 0));
});

test('timeOfDay reads seconds after midnight from numbers, numeric strings and HH:MM text', () => {
  assert.equal(timeOfDay(0), 0);
  assert.equal(timeOfDay(21600), 21600);
  assert.equal(timeOfDay('21600'), 21600);
  assert.equal(timeOfDay('06:00'), 21600);
  assert.equal(timeOfDay('6:05'), 21900);
  assert.equal(timeOfDay(' 23:59 '), 86340);
  assert.equal(timeOfDay('23:59:59'), 86399);
  assert.equal(timeOfDay(86399.4), 86399);
  assert.equal(timeOfDay('12'), 12, 'a plain numeric string is seconds');
  for (const bad of [86400, -1, '24:00', '12:60', 'noon', '', null, undefined, NaN, {}, [], true]) assert.equal(timeOfDay(bad), null, String(bad));
});

// ---------------------------------------------------------------------------------------------------------------------------
// The seams are WIRED: with a stand-in sanitizer registered, every caller goes through it (an empty sanitizer cannot show that)
// ---------------------------------------------------------------------------------------------------------------------------

/** A stand-in for the trucks sanitizer of M1: a `trucks` block with doors (1..32) and check-in seconds; anything else is dropped. */
function standInTrucks(raw) {
  if (raw === null || typeof raw !== 'object' || !raw.trucks || typeof raw.trucks !== 'object') return undefined;
  return { trucks: { doors: clampInt(raw.trucks.doors, 1, 32, 1), checkIn: clampNumber(raw.trucks.checkIn, 0, 7200, 300) } };
}

/** Run `fn` with the stand-in registered for Goods in (`source`), and always put the real sanitizer back. */
function withStandIn(fn) {
  return async () => {
    const real = OPS_SANITIZERS.source;
    OPS_SANITIZERS.source = standInTrucks;
    try {
      await fn();
    } finally {
      OPS_SANITIZERS.source = real;
    }
  };
}

test('wired: normalizeLayout keeps what sanitizeOps returns, after params, only for the types that have a sanitizer, and stamps schemaNeeded', withStandIn(async () => {
  const raw = plant();
  raw.stations[0].ops = { trucks: { doors: '3', checkIn: 120, junk: 1 }, extra: 2 };
  raw.stations[1].ops = { trucks: { doors: 3 } }; // a storage: no sanitizer registered, dropped
  const n = L.normalizeLayout(raw);
  assert.deepEqual(n.stations[0].ops, { trucks: { doors: 3, checkIn: 120 } });
  assert.deepEqual(Object.keys(n.stations[0]).slice(-2), ['params', 'ops']);
  assert.ok(!('ops' in n.stations[1]));
  assert.equal(n.schema, 2, 'the layout now needs schema 2');
  assert.deepEqual(L.checkInvariants(n), []);
  assert.equal(JSON.stringify(L.normalizeLayout(n)), JSON.stringify(n), 'idempotent');
  assert.equal(L.layoutChangeKind(L.normalizeLayout(plant()), n), 'structural', 'a change of ops rebuilds the simulation (F6)');
  // without ops in the raw layout nothing appears, and a block the sanitizer rejects is removed
  assert.ok(!('ops' in L.normalizeLayout(plant()).stations[0]));
  raw.stations[0].ops = { trucks: {} };
  assert.deepEqual(L.normalizeLayout(raw).stations[0].ops, { trucks: { doors: 1, checkIn: 300 } }, 'the sanitizer fills every field of a block that exists');
  raw.stations[0].ops = { trucks: 'many' };
  assert.ok(!('ops' in L.normalizeLayout(raw).stations[0]), 'a block the sanitizer rejects is removed');
  raw.stations[0].ops = { other: 1 };
  assert.ok(!('ops' in L.normalizeLayout(raw).stations[0]), 'an empty result removes the key');
  // file and share link: project stamped 2, an M0 build warns, a build that implements it keeps the data
  const doc = project(n);
  const file = exportProject(doc);
  assert.equal(JSON.parse(file).schema, 2);
  const back = importProject(file);
  assert.equal(JSON.stringify(back.scenarios[0].layout), JSON.stringify(n));
  assert.equal(back.warnings, undefined, 'format 2 is at SCHEMA_MAX (2) since M1: no warning');
  const shared = await decodeShare(await encodeShare(doc));
  assert.equal(JSON.stringify(shared.scenarios[0].layout), JSON.stringify(n));
}));

test('wired: updateStation merges an ops patch one level deep through mergeOps and keeps the schema stamp true', withStandIn(() => {
  const l = plant();
  const id = l.stations[0].id;
  assert.equal(L.updateStation(l, id, { ops: { trucks: { doors: 3 } } }), true);
  assert.deepEqual(l.stations[0].ops, { trucks: { doors: 3, checkIn: 300 } });
  assert.equal(l.schema, 2, 'the mutator re-stamped the layout');
  assert.deepEqual(L.checkInvariants(l), []);
  assert.equal(L.updateStation(l, id, { ops: { trucks: { checkIn: 60 } } }), true);
  assert.deepEqual(l.stations[0].ops, { trucks: { doors: 3, checkIn: 60 } }, 'the doors are kept');
  assert.equal(L.updateStation(l, id, { ops: 'junk' }), true);
  assert.deepEqual(l.stations[0].ops, { trucks: { doors: 3, checkIn: 60 } }, 'a patch that is not an object changes nothing');
  assert.equal(L.updateStation(l, id, { ops: { trucks: { doors: 99 } } }), true);
  assert.equal(l.stations[0].ops.trucks.doors, 32, 'clamped by the sanitizer');
  assert.deepEqual(Object.keys(l.stations[0]).slice(-2), ['params', 'ops']);
  const copy = L.duplicateStation(l, id);
  assert.deepEqual(copy.ops, l.stations[0].ops);
  assert.notEqual(copy.ops, l.stations[0].ops);
  assert.equal(L.removeStation(l, copy.id), true);
  assert.equal(L.updateStation(l, id, { ops: { trucks: null } }), true);
  assert.ok(!('ops' in l.stations[0]), 'switching the only key off leaves no block');
  assert.equal(l.schema, 1, 'and the layout needs schema 1 again');
  assert.deepEqual(L.checkInvariants(l), []);
  l.stations[0].ops = { trucks: { doors: 2, checkIn: 10 } };
  l.schema = 2;
  assert.equal(L.updateStation(l, id, { ops: null }), true);
  assert.ok(!('ops' in l.stations[0]));
  assert.equal(l.schema, 1);
  assert.equal(mergeOps('source', { trucks: { doors: 2, checkIn: 5 } }, { trucks: { doors: 4 }, __proto__: { x: 1 } }).trucks.doors, 4);
  assert.equal(mergeOps('storage', { trucks: {} }, { trucks: { doors: 4 } }), undefined, 'no sanitizer for a storage');
}));

test('wired: normalizeLayout appends the blocks of normalizeExtensions after `settings`, and they set the schema', async () => {
  const entry = EXTENSION_BLOCKS[0];
  const original = entry.sanitize;
  entry.sanitize = (raw) => (raw && typeof raw === 'object' ? { startTod: clampInt(raw.startTod, 0, 86399, 0), startDay: clampInt(raw.startDay, 0, 6, 0) } : undefined);
  try {
    const raw = plant();
    raw.calendar = { startTod: '21600', startDay: 9, junk: true };
    const n = L.normalizeLayout(raw);
    assert.deepEqual(n.calendar, { startTod: 21600, startDay: 6 });
    assert.equal(Object.keys(n).join(), 'schema,name,notes,grid,roads,obstacles,labels,stations,flows,fleets,settings,calendar', 'appended last');
    assert.equal(n.schema, 2);
    assert.deepEqual(L.checkInvariants(n), []);
    assert.equal(JSON.stringify(L.normalizeLayout(n)), JSON.stringify(n));
    assert.ok(!('calendar' in L.normalizeLayout(plant())), 'a layout without the block gets none');
    assert.equal(JSON.parse(exportProject(project(n))).schema, 2);
    assert.equal((await decodeShare(await encodeShare(project(n)))).scenarios[0].layout.calendar.startTod, 21600);
  } finally {
    entry.sanitize = original;
  }
  assert.deepEqual(L.normalizeLayout({ ...plant(), calendar: { startTod: 5 } }).calendar, { startTod: 5, startDay: 0 }, 'and the real sanitizer is back');
});
