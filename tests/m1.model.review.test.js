// Adversarial review of the MODEL and DATA layer of milestone M1 of the warehouse module (trucks and dock doors):
// js/model/ops.js, calendar.js, schema.js, extensions.js, doors.js, validate-ops.js, serialize.js, the mutators of layout.js, the store's
// autosave, and the pure paste parser js/ui/panels/timetable-paste.js. The reviewer's brief: try to BREAK the data layer and prove it.
// Helpers, oracles (written from docs/WAREHOUSE-DESIGN.md, not from the code) and generators: tests/helpers/m1-model-review-gen.js.
//
//   1  hostile input         every place of a rich project gets every kind of junk; own "__proto__" keys; 10,000-row timetables; calendar junk;
//                            byte-identical round trips of every valid truck plant, every legacy fixture and every captured share link;
//                            the pre-M1 tree (commit a2af6d8) and this tree agree on every legacy document and every legacy edit
//   2  schema rule (5.2)     an independent oracle of the table, the stamp after every edit of random sessions through the REAL store (undo, redo,
//                            duplicate, remove, resize, replace, scenarios, autosave), a file from the future, a v1 file
//   3  pure helpers          convertToDoors on every legacy combination, the door check against a brute-force queue, schedules against a per-second scan
//   4  paste (7.2)           2,000 generated texts against a reference parser; hostile text; the parser applies nothing
//   5  validation (App. B)   each code against its oracle, the boundaries, odd shapes, the Fix buttons through the real store
//   6  layering              the import graph against docs/ARCHITECTURE.md section 3, cycles, scripts/check-imports.mjs
//   7  documents vs code     the numbers of 5.3 and Appendix B read from the document and compared with the code
//
// The defects (all `todo`, each with a test that fails today and passes with the fix; the cause and the evidence are in the failure message):
//   M1-MODEL-REV-1   mergeOps / mergeCalendar: a junk value in a patch resets the field to its DEFAULT (a junk "schedule" wipes the timetable), against the
//                    mutator convention of layout.js (keep the current value); latent, the panels guard their inputs today
//   M1-MODEL-REV-2   parseTimetable reads the Excel day fraction "0.25" as 00:25 (H.MM with one hour digit; 7.2 lists HH.MM only)
//   M1-MODEL-REV-3   docks-share-lane is silent when a second road lies behind the docks, but the simulation still sends every visit to the first dock
//   M1-MODEL-REV-4   parseTimeField takes quadratic time on a long run of spaces (the paste dialog parses on every keystroke)
//   M1-MODEL-REV-5   decodeShare takes quadratic time on a link that ends in a long run of punctuation (a crafted #p= link freezes the start-up)
//   M1-MODEL-REV-6   the Fix "Use 32 doors" of doors-too-few leaves the warning in place when even 32 doors are too few
//   M1-MODEL-REV-7   the message of doors-too-few reads "needs about 1 doors ... but it has 1" between 95 and 100 % busy
//   M1-MODEL-REV-8   doorCheck(trucks, null) throws
//   M1-MODEL-REV-9   an empty time cell before a tab is reported as "“24” is not a time"
//   M1-MODEL-REV-10  "06:00:00" (the usual export notation) is refused (a design gap: 7.2 lists no seconds)
//
// Tests named "M1-MODEL-REV-n" are REAL DEFECTS found by this review that are NOT fixed: they FAIL today and are `todo`, so that the suite stays green
// until they are fixed (M1_MODEL_REVIEW_STRICT=1 turns them into ordinary tests). Tests named "DISCREPANCY" pin a place where the code (which is
// authoritative) differs from a document: they pass, and say what the document should say. M1_MODEL_REVIEW_HEAVY=1 runs the larger sizes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import * as H from './helpers/m1-model-review-gen.js';
import * as L from '../js/model/layout.js';
import * as S from '../js/model/serialize.js';
import * as SC from '../js/model/schema.js';
import * as OPS from '../js/model/ops.js';
import * as CAL from '../js/model/calendar.js';
import * as DOORS from '../js/model/doors.js';
import * as VOPS from '../js/model/validate-ops.js';
import { reconcileLayout } from '../js/model/extensions.js';
import { validateLayout } from '../js/model/validate.js';
import { EXAMPLES, buildDockLab } from '../js/model/examples.js';
import { createStore } from '../js/store/store.js';
import { createRng } from '../js/util/rng.js';
import { Simulation } from '../js/sim/engine.js';
import { parseTimetable, parseTimeField, rowsOf, summarizeTimetable } from '../js/ui/panels/timetable-paste.js';
import { layoutFromAscii } from './helpers/ascii.js';
import { MUTATORS, READERS } from './helpers/layout-mutators.js';
import { legacyExamples, GOLDEN_DIR, DOCKPLANT_SEEDS, dockPlantLayoutFile, layoutFile, shareFile, SHARE_BASE } from './helpers/golden.js';
import * as H0 from './helpers/m0-review-gen.js';

const { bytes, clone, isObj, pick } = H;
/** A defect found by this review: fails today; a `todo` so that the suite stays green until it is fixed. */
const defect = (name, fn) => test(name, H.STRICT ? {} : { todo: 'a defect found by the M1 model review (see its message); fix it, then delete this marker' }, fn);
/** A check that is too expensive for every run: M1_MODEL_REVIEW_HEAVY=1. */
const heavy = (name, fn) => test(name, H.HEAVY ? {} : { skip: 'expensive: set M1_MODEL_REVIEW_HEAVY=1' }, fn);
const project = (layout, name = 'P') => ({ name, scenarios: [{ id: 'sc1', name: 'A', layout }], activeId: 'sc1' });
const build = (id) => EXAMPLES.find((e) => e.id === id).build();
const memoryStorage = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, removeItem: (k) => { m.delete(k); } };
};
const noTimers = { setTimeout: () => 0, clearTimeout: () => {} };
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };

// =============================================================================================================================
// 6. Layering
// =============================================================================================================================

test('M1-MODEL-REV layering: every import edge of js/ obeys docs/ARCHITECTURE.md section 3, and the pure model modules import exactly what it lists', () => {
  const graph = H.importGraph();
  assert.ok(graph.size > 100, `read ${graph.size} files`);
  const forbidden = [];
  for (const [from, tos] of graph) for (const to of tos) { const why = H.forbiddenEdge(from, to); if (why) forbidden.push(`${from} -> ${to}: ${why}`); }
  assert.deepEqual(forbidden, []);
  for (const file of H.PURE_MODEL) {
    assert.ok(graph.has(file), file);
    const modelOrUtil = (graph.get(file) ?? []).map((to) => (to.startsWith('js/util/') ? 'js/util/' : to));
    assert.deepEqual([...new Set(modelOrUtil)].sort(), [...H.LISTED_EDGES[file]].sort(), `${file}: ARCHITECTURE 3 lists these imports`);
  }
  // layout.js is imported by the model's loaders and by validate-ops.js, never by a pure module; nothing but validate.js (and tests) imports validate-ops.js
  const importersOf = (target) => [...graph].filter(([, tos]) => tos.includes(target)).map(([from]) => from).sort();
  assert.deepEqual(importersOf('js/model/validate-ops.js').filter((from) => !from.startsWith('js/ui/')), ['js/model/validate.js'], 'only validate.js (and the UI, for the Fix buttons) imports validate-ops.js');
  for (const file of H.PURE_MODEL) assert.ok(!(graph.get(file) ?? []).includes('js/model/layout.js'), `${file} must not import layout.js`);
});

test('M1-MODEL-REV layering: there is no import cycle in js/, and scripts/check-imports.mjs passes', () => {
  assert.deepEqual(H.importCycles(H.importGraph()), []);
  const run = spawnSync(process.execPath, [path.join(H.ROOT, 'scripts', 'check-imports.mjs')], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
});

// =============================================================================================================================
// 1. Hostile input
// =============================================================================================================================

/** Junk for places that belong to the module (ops, calendar, the extras): all of it. For the legacy places a short list is enough (they are not new). */
const OTHER_JUNK = H.HEAVY ? [null, NaN, '', 'x', '06:00', -1, 1e308, [], [1], {}, '__proto__'] : ['x'];
const OURS_JUNK = H.HEAVY ? H.JUNK : [null, NaN, 'x', 1e308, [1, 2, 3], { at: 3600 }];

test('M1-MODEL-REV hostile 1: junk of every kind at EVERY place of a rich project: normalizeLayout is total, idempotent, valid, keeps the key order, drops the foreign keys', () => {
  const rich = H.richProject();
  const base = rich.scenarios[0].layout;
  assert.deepEqual(H.wrongWithNormalize(base), [], 'the rich document itself');
  const all = H.pathsOf(base, 7).filter((trail) => trail[0] !== 'roads' && trail[0] !== 'grid');
  const ours = (trail) => trail.includes('ops') || trail[0] === 'calendar' || trail[0] === 'ops' || trail[0] === 'loadTypes' || trail.includes('types') || (trail[0] === 'fleets' && trail.length > 2 && ['calendar', 'ops', 'trucks'].includes(trail[2]));
  let checked = 0;
  const problems = [];
  for (const trail of all) {
    for (const value of ours(trail) ? OURS_JUNK : OTHER_JUNK) {
      const doc = H.withValue(base, trail, value);
      const wrong = H.wrongWithNormalize(doc, !ours(trail));
      checked++;
      if (wrong.length && problems.length < 5) problems.push(`${trail.join('.')} = ${String(JSON.stringify(value))}: ${wrong.join('; ')}`);
    }
    const dropped = H.wrongWithNormalize(H.withValue(base, trail, undefined), true);
    if (dropped.length && problems.length < 5) problems.push(`${trail.join('.')} deleted: ${dropped.join('; ')}`);
    if (ours(trail)) { // the same through the file: the text reads back as the normalized layout of the same text
      for (const value of [{ at: 3600, doors: 'x' }, 'x']) {
        const text = JSON.stringify({ app: 'logiplan', scenarios: [{ layout: H.withValue(base, trail, value) }] });
        const viaFile = S.importProject(text).scenarios[0].layout;
        const direct = L.normalizeLayout(JSON.parse(text).scenarios[0].layout);
        if (bytes(viaFile) !== bytes(direct) && problems.length < 5) problems.push(`${trail.join('.')}: the file and normalizeLayout disagree`);
      }
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(checked > 1200, `${checked} documents`);
});

test('M1-MODEL-REV hostile 2: own "__proto__", "constructor" and "prototype" keys at every object of a rich file reach no prototype and no station', async () => {
  const rich = H.richProject();
  const base = rich.scenarios[0].layout;
  const objectPaths = [[], ...H.pathsOf(base, 6).filter((trail) => { let at = base; for (const k of trail) at = at[k]; return isObj(at) && trail[0] !== 'roads'; })];
  const evil = () => JSON.parse('{"__proto__":{"evil":1},"constructor":{"prototype":{"evil":2}},"prototype":{"evil":3},"evil":4,"doors":99,"trucks":{"doors":98},"at":5}');
  for (const trail of objectPaths) {
    const doc = clone(base);
    let at = doc;
    for (const k of trail) at = at[k];
    for (const [key, value] of Object.entries(JSON.parse(JSON.stringify(evil())))) Object.defineProperty(at, key, { value, enumerable: true, configurable: true, writable: true });
    Object.defineProperty(at, '__proto__', { value: evil(), enumerable: true, configurable: true, writable: true });
    const wrong = H.wrongWithNormalize(doc);
    assert.deepEqual(wrong, [], `at ${trail.join('.') || 'the layout'}`);
    const out = bytes(L.normalizeLayout(doc));
    assert.ok(!out.includes('evil'), `a foreign key leaked into the layout (${trail.join('.')})`);
    // the same through the file path (JSON text with the keys, which importProject strips) and the share link
    const text = JSON.stringify({ app: 'logiplan', scenarios: [{ layout: doc }] }).replaceAll('"evil":4', '"evil":4,"__proto__":{"evil":5}');
    const imported = S.importProject(text);
    assert.deepEqual(L.checkInvariants(imported.scenarios[0].layout), []);
    assert.equal(({}).evil, undefined);
  }
  const link = await S.encodeShare(rich);
  assert.equal((await S.decodeShare(link)).scenarios.length, 2);
});

test('M1-MODEL-REV hostile 3: 200 documents with 2 to 6 pieces of junk each, in the truck blocks, the schedules and the calendar', () => {
  const rng = createRng(20261009);
  const base = H.richProject().scenarios[0].layout;
  const paths = H.pathsOf(base, 7).filter((trail) => (trail.includes('ops') || trail[0] === 'calendar') && !trail.includes('roads'));
  const problems = [];
  const n = H.size(200, 2500);
  for (let i = 0; i < n && problems.length < 5; i++) {
    let doc = base;
    for (let k = 0, m = 2 + rng.int(5); k < m; k++) {
      const trail = pick(rng, paths);
      try { doc = H.withValue(doc, trail, rng.next() < 0.1 ? undefined : pick(rng, H.JUNK)); } catch { /* the path is gone after an earlier replacement */ }
    }
    const wrong = H.wrongWithNormalize(doc);
    if (wrong.length) problems.push(`#${i}: ${wrong.join('; ')}`);
  }
  assert.deepEqual(problems, []);
});

test('M1-MODEL-REV hostile 4: ops on every kind of station, and on vehicles, flows, obstacles and labels: only Goods in and Goods out keep a trucks block', () => {
  const layout = L.createLayout({ cols: 40, rows: 16 });
  const kinds = ['source', 'process', 'storage', 'sink', 'depot'];
  kinds.forEach((type, i) => L.addStation(layout, { type, x: 2 + i * 6, y: 2 }));
  L.addFleet(layout, 'forklift');
  L.addObstacle(layout, { x: 1, y: 12 });
  L.addLabel(layout, { x: 3, y: 13, text: 'note' });
  const raw = clone(layout);
  for (const s of raw.stations) s.ops = { trucks: H.fullTrucks(), calendar: { staffing: [] }, rack: { levels: 5 }, pick: {} };
  raw.fleets[0].ops = { trucks: H.fullTrucks() };
  raw.fleets[0].trucks = H.fullTrucks();
  raw.obstacles[0].ops = { trucks: H.fullTrucks() };
  raw.labels[0].ops = { trucks: H.fullTrucks() };
  const out = L.normalizeLayout(raw);
  assert.deepEqual(out.stations.map((s) => [s.type, 'ops' in s]), [['source', true], ['process', false], ['storage', false], ['sink', true], ['depot', false]]);
  assert.deepEqual(out.stations.filter((s) => s.ops).map((s) => Object.keys(s.ops)), [['trucks'], ['trucks']], 'no key of a later milestone survives');
  assert.ok(!bytes([out.fleets, out.obstacles, out.labels]).includes('trucks'));
  assert.deepEqual(L.checkInvariants(out), []);
  assert.equal(out.schema, 2);
  assert.ok(OPS.TRUCK_TYPES.includes('source') && OPS.TRUCK_TYPES.includes('sink'));
  for (const type of ['process', 'storage', 'depot', '__proto__', 'constructor', undefined, null, 7]) assert.equal(OPS.sanitizeOps(type, { trucks: H.fullTrucks() }), undefined, String(type));
  // the mutators say the same
  const store = createStore({ storage: null });
  store.replaceLayout(layout);
  for (const s of store.getState().layout.stations) {
    store.commit('ops', (d) => { L.updateStation(d, s.id, { ops: { trucks: { doors: 3 } } }); });
    assert.equal('ops' in L.getStation(store.getState().layout, s.id), s.type === 'source' || s.type === 'sink', s.type);
  }
  assert.deepEqual(L.checkInvariants(store.getState().layout), []);
});

test('M1-MODEL-REV hostile 4b: nothing is shared with the caller: a normalized layout, a merged block and the rows of a paste are copies, and frozen input is read without a write', () => {
  const rich = H.richProject();
  const raw = rich.scenarios[0].layout;
  const out = L.normalizeLayout(raw);
  const snapshot = bytes(out);
  raw.stations[0].ops.trucks.schedule[0].at = 5;
  raw.stations[0].ops.trucks.interArrival.mean = 5;
  raw.calendar.startTod = 5;
  assert.equal(bytes(out), snapshot, 'changing the input afterwards does not change the layout');
  const deepFreeze = (v) => { if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze(v[k]); } return v; };
  const frozen = deepFreeze(clone(rich.scenarios[1].layout));
  assert.equal(bytes(L.normalizeLayout(frozen)), bytes(frozen), 'a frozen layout normalizes to itself');
  assert.equal(reconcileLayout(frozen), frozen, 'and reconcile writes nothing into it');
  const current = deepFreeze(OPS.sanitizeOps('source', { trucks: H.fullTrucks() }));
  const patch = deepFreeze({ trucks: { schedule: [{ at: 3600, pallets: 3 }], interArrival: { mean: 99 } } });
  const merged = OPS.mergeOps('source', current, patch);
  assert.equal(merged.trucks.interArrival.mean, 99);
  assert.notEqual(merged.trucks.schedule, patch.trucks.schedule, 'the rows of a patch are copied');
  const rows = [{ at: 3600, pallets: 3 }];
  const layout = L.createLayout({ cols: 12, rows: 8 });
  const s = L.addStation(layout, { type: 'source', x: 1, y: 1 });
  L.updateStation(layout, s.id, { ops: { trucks: { schedule: rows } } });
  rows[0].at = 7200;
  rows.push({ at: 1 });
  assert.deepEqual(layout.stations[0].ops.trucks.schedule, [{ at: 3600, pallets: 3 }], 'the panel and the paste dialog may reuse their arrays');
  const copy = L.duplicateStation(layout, s.id);
  copy.ops.trucks.schedule[0].at = 1;
  assert.equal(layout.stations[0].ops.trucks.schedule[0].at, 3600, 'a duplicate has its own rows');
  const toast = DOORS.convertToDoors(layout.stations[0]);
  toast.pallets.mean = 99;
  assert.equal(OPS.TRUCK_DEFAULTS.pallets.mean, 24, 'the frozen defaults are never handed out');
  assert.equal(DOORS.convertToDoors(layout.stations[0]).pallets.mean, 24);
  OPS.defaultTrucks().schedule.push({ at: 1 });
  assert.deepEqual(OPS.TRUCK_DEFAULTS.schedule, []);
});

test('M1-MODEL-REV hostile 5: calendar junk: a raw object keeps a clock, a timetable creates one, anything else has none; startTod and startDay are clamped', () => {
  const plain = L.createLayout({ cols: 12, rows: 8 });
  const withCalendar = (raw) => { const l = clone(plain); l.calendar = raw; return L.normalizeLayout(l); };
  const cases = [
    [{}, { startTod: 0, startDay: 0 }], [{ startTod: '06:00' }, { startTod: 21600, startDay: 0 }], [{ startTod: '6:05', startDay: '3' }, { startTod: 21900, startDay: 3 }],
    [{ startTod: '23:59:59' }, { startTod: 86399, startDay: 0 }], [{ startTod: '24:00' }, { startTod: 0, startDay: 0 }], [{ startTod: ' 7:30 ' }, { startTod: 27000, startDay: 0 }],
    [{ startTod: 86400 }, { startTod: 86399, startDay: 0 }], [{ startTod: '86400' }, { startTod: 86399, startDay: 0 }], [{ startTod: -1 }, { startTod: 0, startDay: 0 }],
    [{ startTod: 21600.4 }, { startTod: 21600, startDay: 0 }], [{ startTod: NaN, startDay: Infinity }, { startTod: 0, startDay: 0 }], [{ startDay: 7 }, { startTod: 0, startDay: 6 }],
    [{ startDay: -3 }, { startTod: 0, startDay: 0 }], [{ startDay: 'Wed' }, { startTod: 0, startDay: 0 }], [{ startDay: 2.5 }, { startTod: 0, startDay: 3 }],
    [{ startTod: 100, shifts: [{ id: 'a' }], profiles: [], extra: 1 }, { startTod: 100, startDay: 0 }],
  ];
  for (const [raw, want] of cases) assert.deepEqual(withCalendar(raw).calendar, want, bytes(raw));
  for (const raw of [[], 'x', 5, null, true, 0, '', undefined]) {
    const out = withCalendar(raw);
    assert.ok(!('calendar' in out), `a calendar of ${bytes(raw)} is no clock`);
    assert.equal(out.schema, 1);
  }
  const timetable = clone(plain);
  timetable.stations.push({ id: 's1', type: 'source', x: 1, y: 1, ops: { trucks: { mode: 'schedule' } } });
  assert.deepEqual(L.normalizeLayout(timetable).calendar, { startTod: 0, startDay: 0 }, 'a timetable creates the clock');
  const outbound = clone(plain);
  outbound.stations.push({ id: 's1', type: 'sink', x: 1, y: 1, ops: { trucks: { mode: 'schedule', schedule: [{ at: 3600 }] } } });
  assert.deepEqual(L.normalizeLayout(outbound).calendar, { startTod: 0, startDay: 0 }, 'a timetable of a Goods out creates the clock too');
  const quiet = clone(plain);
  quiet.stations.push({ id: 's1', type: 'sink', x: 1, y: 1, ops: { trucks: { mode: 'rate', schedule: [{ at: 3600 }] } } });
  assert.ok(!('calendar' in L.normalizeLayout(quiet)), 'rows in a rate-mode block do not make a day plant');
  timetable.calendar = 'junk';
  assert.deepEqual(L.normalizeLayout(timetable).calendar, { startTod: 0, startDay: 0 }, 'also over a junk calendar');
  assert.equal(L.normalizeLayout(withCalendar({})).schema, 2);
  assert.deepEqual(Object.keys(L.normalizeLayout(timetable)).slice(-2), ['settings', 'calendar'], 'the clock comes after settings');
});

test('M1-MODEL-REV hostile 6: a timetable of 10,000 rows (unsorted, duplicated, overlapping, half of them junk): the first 500 valid rows, sorted stably, in a blink', () => {
  const rng = createRng(4711);
  const rows = [];
  const valid = [];
  for (let i = 0; i < 10000; i++) {
    if (rng.next() < 0.5) { rows.push(pick(rng, [null, 'x', [], { at: 'x' }, { pallets: 3 }, { at: -1 }, { at: 86400 }, { at: NaN }, { at: '24:00' }])); continue; }
    const at = pick(rng, [rng.int(86400), 21600, 21600, 0, 86399]);
    const row = { at, pallets: 1 + (i % 200) };
    rows.push(row);
    valid.push(row);
  }
  const doc = L.createLayout({ cols: 12, rows: 8 });
  const raw = clone(doc);
  raw.stations.push({ id: 's1', type: 'source', x: 1, y: 1, ops: { trucks: { mode: 'schedule', schedule: rows } } });
  const t0 = cpu();
  const out = L.normalizeLayout(raw);
  const ms = cpu() - t0;
  const got = out.stations[0].ops.trucks.schedule;
  const want = valid.slice(0, 500).map((r, k) => ({ ...r, k })).sort((a, b) => a.at - b.at || a.k - b.k).map(({ at, pallets }) => ({ at, pallets }));
  assert.deepEqual(got, want, 'the first 500 valid rows in the order given, then a stable sort by time');
  assert.ok(ms < 400, `${ms.toFixed(0)} ms of CPU for 10,000 rows`);
  assert.equal(bytes(L.normalizeLayout(out)), bytes(out), 'idempotent');
  // overlapping rows (the same minute many times) are all kept; nothing is merged or dropped
  const same = Array.from({ length: 40 }, (_, i) => ({ at: 36000, pallets: i + 1 }));
  raw.stations[0].ops.trucks.schedule = same;
  assert.deepEqual(L.normalizeLayout(raw).stations[0].ops.trucks.schedule.map((r) => r.pallets), same.map((r) => r.pallets));
});

heavy('M1-MODEL-REV hostile 7 (heavy): a share-sized file with 2,000,000 junk rows is read in bounded time', () => {
  const text = `{"grid":{},"stations":[{"type":"source","x":1,"y":1,"ops":{"trucks":{"schedule":[${'null,'.repeat(2e6)}{"at":3600}]}}}]}`;
  const t0 = cpu();
  const out = S.importProject(text);
  assert.deepEqual(out.scenarios[0].layout.stations[0].ops.trucks.schedule, [{ at: 3600, pallets: null }]);
  assert.ok(cpu() - t0 < 8000);
});

/** Valid truck plants: the examples, the rich project's plant and `n` random ones made from valid patches only. */
function truckPlants(n, seed = 31) {
  const rng = createRng(seed);
  const plants = EXAMPLES.map((e) => [e.id, e.build()]);
  plants.push(['rich', clone(H.richProject().scenarios[1].layout)]);
  for (let i = 0; i < n; i++) {
    const layout = build(pick(rng, ['starter', 'two-lines', 'congestion-lab', 'dock-lab', 'warehouse-first-day']));
    for (const s of layout.stations.filter((x) => x.type === 'source' || x.type === 'sink')) {
      if (rng.next() < 0.2) continue;
      const schedule = Array.from({ length: rng.int(rng.next() < 0.1 ? 600 : 9) }, () => ({ at: rng.int(86400), pallets: rng.next() < 0.5 ? 1 + rng.int(200) : null }));
      L.updateStation(layout, s.id, { ops: { trucks: {
        doors: 1 + rng.int(32), checkIn: rng.int(7201), checkOut: rng.int(7201), mode: pick(rng, ['rate', 'schedule']), schedule,
        interArrival: { kind: pick(rng, ['const', 'normal', 'uniform', 'exp']), mean: 60 + rng.int(100000) + rng.next(), spread: rng.next() },
        pallets: { kind: pick(rng, ['const', 'normal', 'uniform', 'exp']), mean: 1 + rng.next() * 199, spread: rng.next() },
        jitter: rng.int(7201), noShow: Math.round(rng.next() * 5000) / 10000, maxDwell: rng.int(86401), staging: rng.int(51),
      } } });
    }
    if (rng.next() < 0.5) L.updateCalendar(layout, { startTod: rng.int(86400), startDay: rng.int(7) });
    plants.push([`random-${i}`, layout]);
  }
  return plants;
}

test('M1-MODEL-REV hostile 8: every valid truck plant is a fixed point of normalizeLayout and round-trips byte for byte through the file, the share link and the autosave', async () => {
  const plants = truckPlants(H.size(14, 100));
  const storage = memoryStorage();
  for (const [id, layout] of plants) {
    const text = bytes(layout);
    assert.deepEqual(L.checkInvariants(layout), [], id);
    assert.equal(bytes(L.normalizeLayout(layout)), text, `${id}: normalizeLayout`);
    const file = S.exportProject(project(layout));
    const back = S.importProject(file);
    assert.equal(bytes(back.scenarios[0].layout), text, `${id}: file`);
    assert.equal(S.exportProject(back), file.replace('"id":"sc1"', `"id":"${back.scenarios[0].id}"`), `${id}: export(import(export))`);
    assert.equal(back.warnings, undefined, id);
    const link = await S.encodeShare(project(layout));
    const shared = await S.decodeShare(link);
    assert.equal(bytes(shared.scenarios[0].layout), text, `${id}: share link`);
    assert.equal(await S.encodeShare(shared), link, `${id}: the link of the decoded project is the same link`);
    assert.equal(await S.shareUrl('https://x.example/app/#old', project(layout)), `https://x.example/app/#p=${link}`);
  }
  // the autosave: the store writes the project, a new store reads it back
  const writer = createStore({ storage, ...noTimers });
  const reader = () => createStore({ storage, ...noTimers });
  for (const [id, layout] of plants.slice(0, 12)) {
    writer.replaceLayout(layout);
    writer.persist();
    const other = reader();
    assert.ok(other.restore(), `${id}: ${other.lastRestoreError && other.lastRestoreError.message}`);
    assert.equal(bytes(other.getState().layout), bytes(layout), `${id}: autosave`);
    assert.deepEqual(other.lastRestoreWarnings, []);
  }
});

test('M1-MODEL-REV hostile 9: every legacy layout and every captured legacy share link is byte-identical through normalize, file and link, stays schema 1 and has no new key', async () => {
  const names = ['starter', 'two-lines', 'congestion-lab', ...DOCKPLANT_SEEDS.map((s) => `dockplant-${s}`)];
  for (const id of names) {
    const file = path.join(GOLDEN_DIR, id.startsWith('dockplant') ? dockPlantLayoutFile(Number(id.split('-')[1])) : layoutFile(id));
    const text = readFileSync(file, 'utf8');
    const layout = JSON.parse(text);
    assert.equal(layout.schema, 1, id);
    assert.equal(bytes(L.normalizeLayout(layout)), bytes(layout), `${id}: normalizeLayout`);
    const exported = S.exportProject(project(layout));
    assert.equal(JSON.parse(exported).schema, 1, `${id}: the file is stamped 1`);
    assert.equal(bytes(S.importProject(exported).scenarios[0].layout), bytes(layout), `${id}: file`);
    assert.ok(!/"ops"|"calendar"|"trucks"/.test(exported), `${id}: no key of the warehouse module`);
  }
  for (const id of ['starter', 'two-lines', 'congestion-lab']) {
    const link = readFileSync(path.join(GOLDEN_DIR, shareFile(id)), 'utf8').trim();
    const decoded = await S.decodeShare(link);
    assert.equal(decoded.warnings, undefined);
    assert.equal(bytes(decoded.scenarios[0].layout), bytes(JSON.parse(readFileSync(path.join(GOLDEN_DIR, layoutFile(id)), 'utf8'))), id);
    assert.equal(decoded.scenarios[0].layout.schema, 1);
    // the link made by this runtime from the decoded project: the same text where zlib is the same one (the golden helper compares by content for that reason)
    const again = await S.shareUrl(SHARE_BASE, decoded);
    assert.deepEqual((await S.decodeShare(again)).scenarios, decoded.scenarios);
  }
  for (const e of legacyExamples(EXAMPLES)) assert.equal(e.build().schema, 1);
});

/** One random legacy edit (nothing of the warehouse module), on any tree's layout module `M`. */
function legacyEdit(M, layout, rng) {
  const cell = () => [rng.int(layout.grid.cols), rng.int(layout.grid.rows)];
  const any = (list) => (list.length ? list[rng.int(list.length)] : undefined);
  switch (rng.int(16)) {
    case 0: return M.addStation(layout, { type: pick(rng, ['source', 'process', 'storage', 'sink', 'depot']), x: cell()[0], y: cell()[1], w: 1 + rng.int(4), h: 1 + rng.int(3) });
    case 1: return M.updateStation(layout, any(layout.stations)?.id, { params: { batch: 1 + rng.int(4), interArrival: { mean: 1 + rng.int(400) } }, name: `n${rng.int(50)}` });
    case 2: return M.removeStation(layout, any(layout.stations)?.id);
    case 3: return M.duplicateStation(layout, any(layout.stations)?.id);
    case 4: return M.moveStation(layout, any(layout.stations)?.id, ...cell());
    case 5: return M.resizeGrid(layout, 8 + rng.int(60), 8 + rng.int(40));
    case 6: return M.paintRoadPath(layout, [cell(), cell()], { oneWay: rng.next() < 0.2 });
    case 7: return M.eraseRoadCell(layout, ...cell());
    case 8: return M.addFlow(layout, any(layout.stations)?.id, any(layout.stations)?.id);
    case 9: return M.removeFlow(layout, any(layout.flows)?.id);
    case 10: return M.addFleet(layout, pick(rng, ['agv', 'forklift', 'tugger']));
    case 11: return M.updateFleet(layout, any(layout.fleets)?.id, { count: rng.int(6) });
    case 12: return M.removeFleet(layout, any(layout.fleets)?.id);
    case 13: return M.growGrid(layout, { left: rng.int(3), top: rng.int(3), right: rng.int(3), bottom: rng.int(3) });
    case 14: return M.updateSettings(layout, { demandFactor: pick(rng, [0.5, 1, 2]), dt: pick(rng, [0.1, 0.25]) });
    default: return M.setCellSize(layout, pick(rng, [1, 2, 3]));
  }
}

test('M1-MODEL-REV hostile 10: LEGACY OUTPUT: this tree and the end of M0 (a2af6d8) agree on every legacy document, every legacy edit and every legacy check', async (t) => {
  const root = H0.m0TreeRoot();
  if (!root) { t.skip('the tree of commit a2af6d8 is not available here (git archive failed); give a copy with M0_END_TREE=<dir with js/>'); return; }
  const OLD = await H0.loadTree(root);
  const rng = createRng(8675309);
  const bases = legacyExamples(EXAMPLES).map((e) => e.build());
  const junk = [null, 'x', 12, '12', -5, 1e9, NaN, [], {}, true, '__proto__', '1e3'];
  const damaged = (base) => {
    const d = clone(base);
    for (const s of d.stations) {
      if (rng.next() < 0.4) s.params = { ...s.params, [pick(rng, ['batch', 'outCap', 'machines', 'capacity', 'startDelay', 'interArrival', 'junk'])]: pick(rng, junk) };
      if (rng.next() < 0.2) s[pick(rng, ['x', 'y', 'w', 'h', 'name', 'id', 'type'])] = pick(rng, junk);
    }
    if (rng.next() < 0.3) d.settings = { ...d.settings, [pick(rng, ['dt', 'duration', 'demandFactor', 'seed', 'dispatch'])]: pick(rng, junk) };
    if (rng.next() < 0.3) d.schema = pick(rng, [0, 1, 2, '1', null, 99]);
    if (rng.next() < 0.3) for (const f of d.fleets) f[pick(rng, ['count', 'speed', 'preset', 'home', 'battery'])] = pick(rng, junk);
    return d;
  };
  const docs = H.size(150, 400);
  for (let i = 0; i < docs; i++) {
    const doc = damaged(pick(rng, bases));
    const was = OLD.layout.normalizeLayout(doc);
    const now = L.normalizeLayout(doc);
    // a damaged document may claim a newer schema: the stamp is the lowest that can express the content, so a claim of 2 or 99 gives 1 in both trees
    assert.equal(bytes(now), bytes(was), `document ${i}`);
    assert.equal(now.schema === 1 || now.schema === undefined ? 1 : 0, 1);
  }
  // legacy edits: the same random edits on both trees give the same layout, step for step, and never a key of the warehouse module
  for (let session = 0; session < H.size(8, 20); session++) {
    const base = pick(rng, bases);
    const a = clone(base);
    const b = clone(base);
    const seed = 100 + session;
    const ra = createRng(seed);
    const rb = createRng(seed);
    for (let step = 0; step < 50; step++) {
      const x = legacyEdit(OLD.layout, a, ra);
      const y = legacyEdit(L, b, rb);
      assert.equal(typeof x, typeof y, `session ${session} step ${step}`);
      assert.equal(bytes(b), bytes(a), `session ${session} step ${step}`);
      assert.equal(b.schema, 1);
      assert.ok(!('calendar' in b) && b.stations.every((s) => !('ops' in s)));
    }
    assert.equal(bytes(OLD.validate.validateLayout(a)), bytes(validateLayout(b)), `session ${session}: the checks agree`);
    assert.equal(S.exportProject(project(b)), OLD.serialize.exportProject(project(a)), `session ${session}: the file agrees`);
  }
});

// =============================================================================================================================
// 2. The schema rule (5.2)
// =============================================================================================================================

/** Raw layouts that use exactly one key of one row of the table in 5.2, and the row each must give. */
const ROW_CASES = [
  [1, 'nothing', () => ({})],
  [2, 'station.ops.trucks', (l) => { l.stations[0].ops = { trucks: {} }; }],
  [2, 'layout.calendar', (l) => { l.calendar = {}; }],
  [3, 'calendar.shifts', (l) => { l.calendar = { shifts: [] }; }],
  [3, 'calendar.profiles', (l) => { l.calendar = { profiles: [] }; }],
  [3, 'station.ops.calendar', (l) => { l.stations[0].ops = { calendar: {} }; }],
  [3, 'fleet.calendar', (l) => { l.fleets[0].calendar = {}; }],
  [3, 'ops.trucks.schedule[].days', (l) => { l.stations[0].ops = { trucks: { schedule: [{ at: 1 }, { at: 2, days: [0] }] } }; }],
  [4, 'station.ops.form', (l) => { l.stations[0].ops = { form: 'rack' }; }],
  [4, 'station.ops.rack', (l) => { l.stations[0].ops = { rack: {} }; }],
  [4, 'station.ops.block', (l) => { l.stations[0].ops = { block: {} }; }],
  [4, 'station.ops.putaway', (l) => { l.stations[0].ops = { putaway: 'random' }; }],
  [4, 'fleet.aisleMin', (l) => { l.fleets[0].aisleMin = 2.8; }],
  [4, 'fleet.liftHeight', (l) => { l.fleets[0].liftHeight = 10; }],
  [5, 'ops.putaway nearest-free', (l) => { l.stations[0].ops = { putaway: 'nearest-free' }; }],
  [5, 'ops.trucks.depart', (l) => { l.stations[0].ops = { trucks: { depart: 1 } }; }],
  [5, 'ops.trucks.releaseLead', (l) => { l.stations[0].ops = { trucks: { releaseLead: 1 } }; }],
  [5, 'ops.trucks.grace', (l) => { l.stations[0].ops = { trucks: { grace: 1 } }; }],
  [5, 'schedule[].depart', (l) => { l.stations[0].ops = { trucks: { schedule: [{ at: 1, depart: 5 }] } }; }],
  [6, 'layout.loadTypes', (l) => { l.loadTypes = []; }],
  [6, 'flow.types', (l) => { l.flows[0].types = []; }],
  [6, 'ops.mix', (l) => { l.stations[0].ops = { mix: [] }; }],
  [6, 'ops.accepts', (l) => { l.stations[0].ops = { accepts: [] }; }],
  [6, 'ops.outType', (l) => { l.stations[0].ops = { outType: 'x' }; }],
  [6, 'ops.trucks.mix', (l) => { l.stations[0].ops = { trucks: { mix: [] } }; }],
  [6, 'schedule[].mix', (l) => { l.stations[0].ops = { trucks: { schedule: [{ at: 1, mix: [] }] } }; }],
  [7, 'station.ops.pick', (l) => { l.stations[0].ops = { pick: {} }; }],
];

function schemaBase() {
  const l = L.createLayout({ cols: 20, rows: 12 });
  const a = L.addStation(l, { type: 'source', x: 1, y: 1 });
  const b = L.addStation(l, { type: 'sink', x: 10, y: 1 });
  L.addFlow(l, a.id, b.id);
  L.addFleet(l, 'forklift');
  return clone(l);
}

test('M1-MODEL-REV schema 1: schemaNeeded gives, for every key of every row of 5.2, the row of an independent oracle; the maximum wins', () => {
  assert.equal(SC.SCHEMA_ROWS.length, 7);
  for (const [row, what, apply] of ROW_CASES) {
    const l = schemaBase();
    apply(l);
    assert.equal(H.schemaOracle(l), row, `oracle: ${what}`);
    assert.equal(SC.schemaNeeded(l), row, what);
  }
  const rng = createRng(52);
  for (let i = 0; i < 400; i++) {
    const l = schemaBase();
    const used = ROW_CASES.slice(1).filter(() => rng.next() < 0.15);
    // applying several cases to station 0 would overwrite its ops: merge them instead
    const ops = {};
    for (const [, , apply] of used) {
      const probe = schemaBase();
      apply(probe);
      if (probe.stations[0].ops) Object.assign(ops, probe.stations[0].ops);
      else { apply(l); }
    }
    if (Object.keys(ops).length) l.stations[0].ops = ops;
    const want = Math.max(1, ...used.map(([row]) => row));
    // the merge of ops blocks can only keep or lose a nested key; the oracle is the judge of what the layout then holds
    assert.equal(SC.schemaNeeded(l), H.schemaOracle(l), bytes(l.stations[0].ops));
    assert.ok(H.schemaOracle(l) <= want);
  }
  // absent is not present: undefined values and a non-layout give the base
  const l = schemaBase();
  l.calendar = undefined;
  l.stations[0].ops = { trucks: undefined, pick: undefined };
  assert.equal(SC.schemaNeeded(l), 1);
  for (const v of [null, undefined, 5, 'x', [], [{}], { stations: 'x', fleets: 5, flows: null }]) assert.equal(SC.schemaNeeded(v), 1, bytes(v));
  assert.equal(SC.schemaNeeded({ calendar: 7 }), H.schemaOracle({ calendar: 7 }), 'a raw layout counts a present key whatever it holds; normalizeLayout decides what is kept');
  assert.equal(SC.SCHEMA_MAX, 2);
});

test('M1-MODEL-REV schema 2: normalizeLayout stamps the lowest schema that can express what it kept: 2 for trucks or a clock, 1 otherwise, never above SCHEMA_MAX', () => {
  for (const [row, what, apply] of ROW_CASES) {
    const l = schemaBase();
    apply(l);
    const out = L.normalizeLayout(l);
    assert.ok(out.schema <= SC.SCHEMA_MAX, what);
    assert.equal(out.schema, SC.schemaNeeded(out), what);
    assert.deepEqual(L.checkInvariants(out), [], what);
    // M1 implements row 2 only: the keys of the later rows are dropped, so a layout that uses only those is v1 again
    const keeps = row === 2 || (row > 2 && (out.calendar !== undefined || out.stations.some((s) => s.ops)));
    assert.equal(out.schema, keeps ? 2 : 1, what);
  }
  const l = schemaBase();
  l.schema = 99;
  assert.equal(L.normalizeLayout(l).schema, 1, 'a claim of 99 on a legacy plant is 1');
  l.schema = 1;
  l.stations[0].ops = { trucks: { doors: 3 } };
  assert.equal(L.normalizeLayout(l).schema, 2, 'a claim of 1 on a truck plant is 2');
});

test('M1-MODEL-REV schema 3: a file from the future warns and opens, keeps what M1 knows, and a v1 file stays v1 (file, link, autosave)', async () => {
  const layout = clone(H.richProject().scenarios[1].layout);
  const future = clone(layout);
  future.schema = 7;
  future.calendar = { startTod: 100, startDay: 2, shifts: [{ id: 'early', name: 'Early', from: 21600, to: 50400, days: [0, 1, 2], breaks: [{ from: 32400, to: 34200, paid: false, groups: 2 }] }], profiles: [{ id: 'm', hourly: new Array(24).fill(1) }] };
  future.stations[0].ops = { trucks: { ...H.fullTrucks(), depart: 5, releaseLead: 5400, grace: 900, mix: [], schedule: [{ at: 21600, pallets: 24, days: [0], depart: 5, mix: [] }] }, form: 'rack', rack: { levels: 5 }, putaway: 'nearest-free', pick: {}, calendar: { staffing: [] } };
  future.loadTypes = [{ id: 'fast', name: 'Fast', color: '#e8590c', velocity: 'A', cycleFactor: 1 }];
  future.flows[0].types = ['fast'];
  future.fleets[0].calendar = { staffing: [{ shift: 'early', count: 2 }] };
  future.fleets[0].aisleMin = 2.8;
  const text = JSON.stringify({ app: 'logiplan', schema: 7, name: 'Future', active: 0, scenarios: [{ id: 'sc1', name: 'A', layout: future }, { id: 'sc2', name: 'B', layout: schemaBase() }] });
  const imported = S.importProject(text);
  assert.equal(imported.warnings.length, 1);
  assert.match(imported.warnings[0], /newer version of LogiPlan \(format 7; this version reads format 2\)/);
  const kept = imported.scenarios[0].layout;
  assert.equal(kept.schema, 2);
  assert.deepEqual(kept.calendar, { startTod: 100, startDay: 2 }, 'M2 keys of the clock are dropped, M1 keys kept');
  assert.deepEqual(kept.stations[0].ops.trucks.schedule, [{ at: 21600, pallets: 24 }], 'days, depart and mix of a row are dropped');
  assert.equal(kept.stations[0].ops.trucks.doors, 5);
  assert.deepEqual(Object.keys(kept.stations[0].ops), ['trucks']);
  assert.ok(!bytes(kept).includes('"types"') && !bytes(kept).includes('aisleMin') && !bytes(kept).includes('loadTypes'));
  assert.deepEqual(L.checkInvariants(kept), []);
  assert.equal(imported.scenarios[1].layout.schema, 1, 'the other scenario is v1');
  // the same file through the share link and the autosave: warned, opened, nothing thrown
  const link = `z.${(await S.encodeShare({ name: 'x', scenarios: [{ id: 'a', name: 'A', layout: schemaBase() }], activeId: 'a' })).slice(2)}`;
  assert.ok(link.length > 10);
  const storage = memoryStorage();
  storage.setItem('logiplan:v1', text);
  const store = createStore({ storage, ...noTimers });
  assert.equal(store.restore(), true, store.lastRestoreError && store.lastRestoreError.message);
  assert.equal(store.lastRestoreWarnings.length, 1);
  assert.equal(store.getState().layout.schema, 2);
  assert.deepEqual(L.checkInvariants(store.getState().layout), []);
  store.persist();
  assert.equal(store.hasBackup(), true, 'a text that was only partly understood is kept as a backup before it is overwritten');
  // hostile schema numbers never crash
  for (const claim of [0, -1, 1.5, 2.5, 1e308, 'x', null, [], {}, true, '3']) {
    const raw = clone(layout);
    raw.schema = claim;
    const out = S.importProject(JSON.stringify({ schema: claim, scenarios: [{ layout: raw }] }));
    assert.equal(out.scenarios[0].layout.schema, 2, String(claim));
  }
  // a v1 file stays v1 even if it is stamped higher or lower
  for (const claim of [0, 1, '1', null]) {
    const legacy = schemaBase();
    legacy.schema = claim;
    const out = S.importProject(JSON.stringify({ schema: claim, scenarios: [{ layout: legacy }] }));
    assert.equal(out.scenarios[0].layout.schema, 1);
    assert.equal(out.warnings, undefined);
    assert.equal(JSON.parse(S.exportProject(out)).schema, 1);
  }
  // the project is stamped with the highest schema of its scenarios, even when a layout was edited after it was stamped
  const mixed = { name: 'M', scenarios: [{ id: 'a', name: 'A', layout: schemaBase() }, { id: 'b', name: 'B', layout }], activeId: 'a' };
  assert.equal(JSON.parse(S.exportProject(mixed)).schema, 2);
  const stale = clone(layout);
  stale.schema = 1;
  assert.equal(JSON.parse(S.exportProject({ name: 'S', scenarios: [{ id: 'a', name: 'A', layout: stale }], activeId: 'a' })).schema, 2, 'a stale stamp cannot make the file claim v1');
});

test('M1-MODEL-REV schema 4: random sessions through the REAL store (every kind of edit, undo, redo, duplicate, remove, resize, replace, scenarios, autosave): valid and equal to normalizeLayout after every step', () => {
  const sessions = H.size(3, 10);
  const steps = H.size(80, 140);
  const starts = ['two-lines', 'dock-lab', 'warehouse-first-day'];
  const seen = new Map();
  let totalSteps = 0;
  for (let session = 0; session < sessions; session++) {
    const rng = createRng(1000 + session);
    const storage = memoryStorage();
    const make = () => createStore({ storage, ...noTimers });
    const store = make();
    store.replaceLayout(build(starts[session % starts.length]));
    const memory = { storage, makeStore: make, mismatch: null };
    for (let i = 0; i < steps; i++) {
      let label = H.randomStep(store, rng, memory);
      if (i % 11 === 10) label = store.undo() && store.undo() && store.redo() ? 'redo' : 'undo/redo (nothing to undo)'; // the walk back and forth is part of every session
      totalSteps++;
      seen.set(label.replace(/ THREW.*/, ''), (seen.get(label.replace(/ THREW.*/, '')) ?? 0) + 1);
      const wrong = H.wrongWithStore(store);
      if (memory.mismatch) { wrong.push(memory.mismatch); memory.mismatch = null; }
      assert.ok(!/THREW/.test(label), `session ${session} step ${i}: ${label}`);
      assert.deepEqual(wrong, [], `session ${session} step ${i}: ${label}`);
    }
  }
  assert.ok(totalSteps >= sessions * steps);
  for (const kind of ['addStation', 'updateStation(ops)', 'removeStation', 'duplicateStation', 'resizeGrid', 'replaceLayout', 'updateCalendar', 'undo', 'redo', 'addScenario', 'switchScenario', 'persist and restore']) {
    assert.ok((seen.get(kind) ?? 0) > 0, `the sessions never did "${kind}"`);
  }
});

test('M1-MODEL-REV schema 4b: every exported mutator of layout.js (the classification table of the M0 fix pass), called through the real store on truck plants: accepted, valid, equal to normalizeLayout', () => {
  const exported = Object.keys(L).filter((name) => typeof L[name] === 'function');
  assert.deepEqual(exported.filter((name) => !READERS.has(name) && !(name in MUTATORS)), [], 'a function of layout.js that is neither a reader nor a mutator with a driver');
  assert.ok(Object.keys(MUTATORS).length >= 34, `${Object.keys(MUTATORS).length} mutators`);
  const starts = ['warehouse-first-day', 'dock-lab', 'two-lines'];
  const calls = H.size(10, 30);
  let committed = 0;
  Object.keys(MUTATORS).forEach((name, k) => {
    const rng = createRng(500 + k);
    const store = createStore({ storage: null });
    const layout = build(starts[k % starts.length]);
    for (const s of layout.stations.filter((x) => x.type === 'source' || x.type === 'sink')) L.updateStation(layout, s.id, { ops: { trucks: { mode: pick(rng, ['rate', 'schedule']), schedule: [{ at: 21600, pallets: 24 }, { at: 36000, pallets: null }] } } });
    store.newProject(layout);
    for (let i = 0; i < calls; i++) {
      try { if (store.commit(name, (d) => { MUTATORS[name](d, rng); })) committed++; } catch (err) { assert.fail(`${name} call ${i}: ${err.message}`); }
      assert.deepEqual(H.wrongWithStore(store), [], `${name} call ${i}`);
    }
    store.undo();
    store.redo();
    assert.deepEqual(H.wrongWithStore(store), [], `${name} after undo and redo`);
  });
  assert.ok(committed > Object.keys(MUTATORS).length * calls * 0.25, `${committed} commits changed the plant`);
});

test('M1-MODEL-REV schema 5: undo and redo walk the exact layouts, stamp and clock included, over a long chain of edits on a truck plant', () => {
  const rng = createRng(77);
  const store = createStore({ storage: null });
  store.newProject(build('warehouse-first-day'));
  const snapshots = [bytes(store.getState().layout)];
  for (let i = 0; i < 60; i++) {
    const s = pick(rng, store.getState().layout.stations.filter((x) => x.type === 'source' || x.type === 'sink'));
    const patch = pick(rng, [{ trucks: { mode: 'schedule', schedule: [{ at: 3600 * rng.int(24), pallets: 12 }] } }, { trucks: { mode: 'rate' } }, { trucks: null }, { trucks: { doors: 1 + rng.int(8) } }]);
    const changed = store.commit(`edit ${i}`, (d) => { L.updateStation(d, s.id, { ops: patch }); });
    if (changed) snapshots.push(bytes(store.getState().layout));
    if (rng.next() < 0.1) { store.commit('clock', (d) => { L.updateCalendar(d, pick(rng, [{ startTod: 3600 * rng.int(24) }, null])); }) && snapshots.push(bytes(store.getState().layout)); }
  }
  for (let i = snapshots.length - 2; i >= 0; i--) {
    assert.ok(store.undo(), `undo ${i}`);
    assert.equal(bytes(store.getState().layout), snapshots[i], `after undo to ${i}`);
    assert.deepEqual(L.checkInvariants(store.getState().layout), []);
  }
  assert.equal(store.undo(), false, 'the chain was within the history limit');
  for (let i = 1; i < snapshots.length; i++) {
    assert.ok(store.redo());
    assert.equal(bytes(store.getState().layout), snapshots[i], `after redo to ${i}`);
  }
});

test('M1-MODEL-REV schema 6: a mutator that forgets reconcileLayout is rolled back by the store with a message that names the stamp or the clock', () => {
  const store = createStore({ storage: null });
  store.replaceLayout(schemaBase());
  const id = store.getState().layout.stations[0].id;
  const before = bytes(store.getState().layout);
  assert.throws(() => store.commit('forgetful', (d) => { d.stations[0].ops = OPS.sanitizeOps('source', { trucks: { mode: 'schedule' } }); }), /rolled back.*(schema must be 2|calendar)/);
  assert.equal(bytes(store.getState().layout), before, 'nothing changed');
  assert.throws(() => store.commit('forgetful removal', (d) => { d.calendar = { startTod: 1, startDay: 1 }; }), /rolled back.*schema must be 2/);
  assert.throws(() => store.commit('forgetful clock', (d) => { L.updateStation(d, id, { ops: { trucks: { mode: 'schedule' } } }); delete d.calendar; }), /rolled back.*calendar/);
  assert.throws(() => store.commit('junk ops', (d) => { d.stations[0].ops = { trucks: { doors: 99 } }; d.schema = 2; }), /rolled back.*ops is not a sanitized options block/);
  assert.equal(bytes(store.getState().layout), before);
  // and the right way is accepted, in one step
  assert.equal(store.commit('right', (d) => { L.updateStation(d, id, { ops: { trucks: { mode: 'schedule' } } }); }), true);
  assert.equal(store.getState().layout.schema, 2);
  assert.deepEqual(store.getState().layout.calendar, { startTod: 0, startDay: 0 });
  assert.equal(reconcileLayout(Object.freeze(clone(store.getState().layout))).schema, 2, 'reconcile on a frozen, consistent layout writes nothing');
});

// =============================================================================================================================
// 5 (first part). A defect of the mutators: junk in a patch
// =============================================================================================================================

defect('M1-MODEL-REV-1 a junk value in a patch of ops.trucks or of the calendar RESETS the field to its default (and a junk "schedule" wipes the timetable) instead of keeping the current value', () => {
  // layout.js header: "anything non-numeric ... keeps the CURRENT value when a mutator patches a field (an editor that commits NaN or '' while the user
  // clears a field must not wipe the setting)". mergeParams does so for params; mergeOps / mergeCalendar fall back to the DEFAULT.
  const layout = L.createLayout({ cols: 20, rows: 12 });
  const s = L.addStation(layout, { type: 'source', x: 1, y: 1, ops: { trucks: { doors: 5, checkIn: 600, mode: 'schedule', schedule: [{ at: 3600, pallets: 10 }, { at: 7200, pallets: 11 }, { at: 9000, pallets: null }] } } });
  L.updateCalendar(layout, { startTod: 21600, startDay: 3 });
  const keep = (patch, field, want) => {
    const copy = clone(layout);
    L.updateStation(copy, s.id, { ops: { trucks: patch } });
    assert.deepEqual(OPS.trucksOf(copy.stations[0])[field], want, `${bytes(patch)} must leave ${field} alone`);
  };
  keep({ doors: 'many' }, 'doors', 5);
  keep({ doors: NaN }, 'doors', 5);
  keep({ checkIn: '' }, 'checkIn', 600);
  keep({ mode: 'zzz' }, 'mode', 'schedule');
  keep({ schedule: 'x' }, 'schedule', [{ at: 3600, pallets: 10 }, { at: 7200, pallets: 11 }, { at: 9000, pallets: null }]);
  keep({ interArrival: { mean: 'x' } }, 'interArrival', OPS.trucksOf(layout.stations[0]).interArrival);
  const copy = clone(layout);
  L.updateCalendar(copy, { startTod: NaN });
  assert.equal(copy.calendar.startTod, 21600, 'a cleared start time field must not move the start of the day to 00:00');
  L.updateCalendar(copy, { startDay: '' });
  assert.equal(copy.calendar.startDay, 3);
});

// =============================================================================================================================
// 3. Pure helpers
// =============================================================================================================================

test('M1-MODEL-REV helpers 1: convertToDoors on every legacy combination keeps the pallet rate exactly, the 600 s floor, the kind and the spread, and is a fixed point of the sanitizer', () => {
  const means = [0.5, 1, 2, 2.9, 3, 5, 7, 10, 14, 20, 24, 25, 30, 60, 100, 180, 300, 400, 599, 600, 601, 3600, 36000, 86400, 2e5, 3e5, 999999.9, 1e6];
  const batches = [1, 2, 3, 4, 5, 10, 24, 50, 99, 100];
  let n = 0;
  let exact = 0;
  for (const kind of ['const', 'normal', 'uniform', 'exp']) for (const spread of [0, 0.2, 1]) for (const g of means) for (const b of batches) {
    const layout = L.createLayout({ cols: 12, rows: 8 });
    const station = L.addStation(layout, { type: 'source', x: 1, y: 1, params: { interArrival: { kind, mean: g, spread }, batch: b } });
    const before = bytes(station);
    const block = DOORS.convertToDoors(station);
    n++;
    assert.equal(bytes(station), before, 'the station is not modified');
    assert.equal(bytes(DOORS.convertToDoors(station)), bytes(block), 'idempotent: the same station gives the same block');
    assert.equal(bytes(OPS.sanitizeOps('source', { trucks: block }).trucks), bytes(block), 'a fixed point of the sanitizer');
    assert.deepEqual([block.interArrival.kind, block.interArrival.spread], [kind, spread], 'kind and spread of the old distribution are kept');
    assert.deepEqual([block.doors, block.checkIn, block.checkOut, block.mode], [2, 300, 300, 'rate']);
    const P = block.pallets.mean;
    const gap = block.interArrival.mean;
    assert.ok(Number.isInteger(P) && P >= 1 && P <= 200, 'a whole number of pallets');
    const rate = P / gap;
    const legacy = station.params.batch / station.params.interArrival.mean;
    const off = Math.abs(rate - legacy) / legacy;
    if (off < 1e-9) exact++;
    else {
      // the only way the rate can change: the legacy plant makes more pallets a second than the biggest truck stream the block can hold (200 pallets every 60 s)
      assert.deepEqual([P, gap], [200, 60], `g=${g} b=${b} gives ${P} pallets every ${gap} s`);
      assert.ok(legacy > 200 / 60, `g=${g} b=${b}`);
      assert.ok(rate < legacy, 'the block carries less, never more');
    }
    if (legacy <= 200 / 60 * (1 - 1e-9)) assert.ok(off < 1e-9, `a realistic plant keeps its rate exactly (g=${g} b=${b})`);
    if (P < 200 && gap > 60) assert.ok(gap >= 600 - 1e-9, `the gap is never below 600 s unless the pallets are capped (g=${g} b=${b} P=${P} gap=${gap})`);
  }
  assert.equal(n, 4 * 3 * means.length * batches.length);
  assert.ok(exact > n * 0.5, `${exact} of ${n} keep the rate exactly`);
  // the numbers of Appendix A.5 and 6.3.1, from the document
  const lab = (g, b) => { const l = L.createLayout({ cols: 12, rows: 8 }); return DOORS.convertToDoors(L.addStation(l, { type: 'source', x: 1, y: 1, params: { interArrival: { kind: 'normal', mean: g, spread: 0.2 }, batch: b } })); };
  assert.deepEqual([lab(180, 1).pallets.mean, lab(180, 1).interArrival.mean], [24, 4320], 'Starter: 24 pallets every 72 minutes');
  assert.deepEqual([lab(400, 4).pallets.mean, lab(400, 4).interArrival.mean], [24, 2400], 'Congestion lab: every 40 minutes');
  assert.deepEqual([lab(20, 1).pallets.mean, lab(20, 1).interArrival.mean], [30, 600], 'a pallet every 20 s: 30 pallets every 600 s');
});

test('M1-MODEL-REV helpers 2: convertToDoors is total on every kind of argument and a Goods out has the documented defaults', () => {
  const junk = [undefined, null, 0, 'x', [], {}, { type: 'source' }, { type: 'source', params: null }, { type: 'source', params: { interArrival: 'x', batch: 'y' } }, { type: 'source', params: { interArrival: { mean: -5, kind: 'zzz', spread: 9 }, batch: -3 } }, { type: 'source', params: { interArrival: { mean: NaN }, batch: Infinity } }];
  for (const a of junk) for (const b of junk) {
    const block = DOORS.convertToDoors(a, b);
    assert.ok(block === null || bytes(OPS.sanitizeOps('source', { trucks: block }).trucks) === bytes(block), `${bytes(a)}, ${bytes(b)}`);
  }
  for (const type of ['process', 'storage', 'depot', 'x']) assert.equal(DOORS.convertToDoors(type, {}), null);
  const out = DOORS.convertToDoors({ type: 'sink', params: {} });
  assert.deepEqual([out.doors, out.checkIn, out.checkOut, out.pallets.mean, out.interArrival.mean, out.staging, out.maxDwell], [2, 300, 300, 24, 1800, 4, 3600]);
  const d = DOORS.describeTrucks(out);
  assert.deepEqual([d.trucksPerHour, d.palletsPerHour], [2, 48], '24 pallets every 30 minutes are 48 an hour');
  const shipped = DOORS.convertToDoors({ type: 'sink', params: {} }, { shippedPerHour: 20 });
  assert.ok(Math.abs(DOORS.describeTrucks(shipped).palletsPerHour - 20) < 1e-9);
});

test('M1-MODEL-REV helpers 3: the door check reproduces Appendix A.1 and agrees with a brute-force queue: the share of busy doors, the explosion near 100 %, the quiet at the suggestion', () => {
  const block = (o = {}) => OPS.sanitizeOps('source', { trucks: { interArrival: { kind: 'normal', mean: 600, spread: 0.3 }, pallets: { kind: 'const', mean: 26, spread: 0 }, ...o } }).trucks;
  const check = DOORS.doorCheck(block());
  // A.1 by hand: 26 x 90 s = 39 min, with 5 + 5 min = 49 min = 0.8167 h; 6 trucks an hour: 4.9 doors; 5 doors 98 %, 6 doors 82 %
  assert.equal(check.doorSeconds, 2940);
  assert.ok(Math.abs(check.needed - 6 * 2940 / 3600) < 1e-12);
  assert.equal(check.parts.need, '4.9');
  assert.equal(check.parts.minutes, '49');
  assert.deepEqual([4, 5, 6, 7].map((doors) => Math.round(DOORS.doorCheck(block({ doors })).utilisation * 100)), [123, 98, 82, 70]);
  assert.deepEqual([4, 5, 6].map((doors) => DOORS.doorCheck(block({ doors })).tooFew), [true, true, false]);
  assert.equal(check.suggestedDoors, 6);
  // the same plant, measured: 400 hours of trucks in a FIFO queue
  const gap = block().interArrival;
  const hours = H.size(3000, 10000);
  const measured = [5, 6, 7].map((doors) => H.queueRun(gap, doors, check.doorSeconds, hours, 5));
  for (const [i, doors] of [5, 6, 7].entries()) {
    assert.ok(Math.abs(measured[i].utilisation - DOORS.doorCheck(block({ doors })).utilisation) < 0.02, `${doors} doors: busy ${measured[i].utilisation.toFixed(3)}`);
  }
  assert.ok(measured[0].meanWait > 10 * Math.max(measured[1].meanWait, 1), `5 doors (98 %) queue ${measured[0].meanWait.toFixed(0)} s on average, 6 doors (82 %) ${measured[1].meanWait.toFixed(0)} s`);
  assert.ok(measured[1].meanWait < 0.1 * check.doorSeconds, 'at the suggested 82 % the gate is quiet');
  const infinite = H.queueRun(gap, 400, check.doorSeconds, hours, 6);
  assert.ok(Math.abs(infinite.utilisation * 400 - check.needed) / check.needed < 0.04, "Little's law: the average number of busy doors is arrivals x door time");
  // the suggestion is the FEWEST doors that stay at or below 85 %, for a range of plants
  const rng = createRng(3);
  for (let i = 0; i < 300; i++) {
    const t = block({ interArrival: { kind: 'const', mean: 60 + rng.int(8000), spread: 0 }, pallets: { kind: 'const', mean: 1 + rng.int(60), spread: 0 }, checkIn: rng.int(1200), checkOut: rng.int(1200), doors: 1 + rng.int(32) });
    const c = DOORS.doorCheck(t);
    let fewest = 32;
    for (let d = 1; d <= 32; d++) if (c.needed / d <= 0.85 + 1e-9) { fewest = d; break; }
    assert.equal(c.suggestedDoors, fewest, `needed ${c.needed}`);
    assert.equal(c.tooFew, !c.empty && c.needed / c.doors > 0.95);
    if (c.action) assert.ok(c.tooFew && c.suggestedDoors > c.doors, 'a button only where doors are too few and more doors help');
    if (c.tooFew && c.suggestedDoors > c.doors && c.suggestedUtilisation <= 0.95) assert.ok(c.action, 'and a button wherever more doors do help');
  }
  // the boundary: just below and just above 95 % busy
  const at = (util) => DOORS.doorCheck(block({ doors: 10, interArrival: { kind: 'const', mean: Math.round(2940 / (util * 10)), spread: 0 } }));
  const below = at(0.94);
  const above = at(0.96);
  assert.ok(Math.abs(below.utilisation - 0.94) < 0.005 && Math.abs(above.utilisation - 0.96) < 0.005, `${below.utilisation} ${above.utilisation}`);
  assert.equal(below.tooFew, false);
  assert.equal(above.tooFew, true);
});

test('M1-MODEL-REV helpers 4: the busiest hour of a timetable is the largest number of rows in any half-open hour of the repeating day (a brute-force scan of all 86,400 starts)', () => {
  const rng = createRng(6);
  for (let i = 0; i < H.size(40, 150); i++) {
    const n = 1 + rng.int(14);
    const times = Array.from({ length: n }, () => (rng.next() < 0.3 ? pick(rng, [0, 3600, 7200, 86399, 82800]) : rng.int(86400)));
    if (rng.next() < 0.5) times.forEach((t, k) => { if (k % 2) times[k] = (times[0] + k * 600) % 86400; });
    assert.equal(DOORS.peakRowsPerHour(times.map((at) => ({ at }))), H.bruteRowsPerHour(times), bytes(times));
  }
  assert.equal(DOORS.peakRowsPerHour([{ at: 0 }, { at: 3600 }]), 1, 'exactly an hour apart: different hours');
  assert.equal(DOORS.peakRowsPerHour([{ at: 86399 - 1199 }, { at: 1800 }]), 2, 'across midnight');
  assert.equal(DOORS.peakRowsPerHour([]), 0);
  assert.equal(DOORS.peakRowsPerHour('x'), 0);
});

test('M1-MODEL-REV helpers 5: the arrivals of a timetable are exactly the seconds at which the clock shows a row (startTod and startDay edges, midnight, week wrap)', () => {
  const rng = createRng(2024);
  const DAY = 86400;
  for (let iter = 0; iter < H.size(12, 80); iter++) {
    const startTod = rng.next() < 0.4 ? pick(rng, [0, 86399, 43200, 21600, 1]) : rng.int(DAY);
    const startDay = rng.int(7);
    const rows = Array.from({ length: 1 + rng.int(5) }, () => ({ at: rng.next() < 0.4 ? pick(rng, [0, 86399, startTod, (startTod + 1) % DAY, (startTod + DAY - 1) % DAY]) : rng.int(DAY), pallets: 5 }));
    const trucks = OPS.sanitizeOps('source', { trucks: { mode: 'schedule', schedule: rows } }).trucks;
    const clock = CAL.makeClock({ startTod, startDay });
    const days = 1 + rng.int(3);
    const horizon = days * DAY - startTod;
    const r = createRng(1);
    const due = [];
    for (let k = 0; k <= days; k++) for (const e of DOORS.expandScheduleDay(trucks, clock, k, r)) if (e.at < horizon) due.push(e.at);
    due.sort((a, b) => a - b);
    const scan = [];
    for (let t = 0; t < horizon; t++) { const tod = clock.tod(t); for (const row of trucks.schedule) if (row.at === tod) scan.push(t); }
    assert.deepEqual(due, scan, `startTod ${startTod} startDay ${startDay} rows ${bytes(trucks.schedule.map((x) => x.at))}`);
    for (const t of [0, 1, DAY - startTod - 1, DAY - startTod, DAY * 7 - startTod, DAY * 7 - startTod - 1, 3 * DAY + 12345, -1]) {
      const day = (((startDay + Math.floor((startTod + t) / DAY)) % 7) + 7) % 7;
      const tod = (((startTod + t) % DAY) + DAY) % DAY;
      assert.equal(clock.day(t), day);
      assert.equal(clock.tod(t), tod);
      assert.equal(clock.label(t), `${CAL.DAY_NAMES[day]} ${String(Math.floor(tod / 3600)).padStart(2, '0')}:${String(Math.floor((tod % 3600) / 60)).padStart(2, '0')}`);
      assert.equal(clock.dayStart(clock.dayIndex(t)) <= t, true);
    }
  }
  // jitter is bounded, never before time 0; a no-show stays in the list at its nominal time; the draws of one stream do not depend on another
  const trucks = OPS.sanitizeOps('source', { trucks: { mode: 'schedule', jitter: 900, noShow: 0.3, schedule: Array.from({ length: 48 }, (_, i) => ({ at: i * 1800, pallets: null })) } }).trucks;
  const clock = CAL.makeClock({ startTod: 0, startDay: 0 });
  const day = DOORS.expandScheduleDay(trucks, clock, 0, createRng(9));
  assert.equal(day.length, 48, 'no-shows stay in the list');
  assert.ok(day.every((e, i, a) => i === 0 || a[i - 1].at <= e.at), 'sorted');
  const noShows = day.filter((e) => e.noShow);
  assert.ok(noShows.length > 5 && noShows.length < 25, `${noShows.length} no-shows of 48 at 30 %`);
  for (const e of day) {
    const nominal = trucks.schedule[e.row].at;
    if (e.noShow) assert.equal(e.at, nominal);
    else { assert.ok(Math.abs(e.at - nominal) <= 900 && e.at >= 0); assert.ok(e.pallets >= 1 && e.pallets <= 200 && Number.isInteger(e.pallets)); }
  }
  assert.equal(bytes(DOORS.expandScheduleDay(trucks, clock, 0, createRng(9))), bytes(day), 'the same stream gives the same day');
  assert.equal(DOORS.expansionTime(trucks, clock, 0), 0);
  assert.equal(DOORS.expansionTime(trucks, clock, 3), 3 * 86400 - 900);
});

test('M1-MODEL-REV helpers 6: demandFactor: rate mode scales the truck frequency and not the pallets, schedule mode scales the pallets and never moves an appointment; 0 means no truck', () => {
  const rate = OPS.sanitizeOps('source', { trucks: { interArrival: { kind: 'const', mean: 1800, spread: 0 }, pallets: { kind: 'const', mean: 24, spread: 0 } } }).trucks;
  const sched = OPS.sanitizeOps('source', { trucks: { mode: 'schedule', schedule: [{ at: 21600, pallets: 24 }, { at: 25200, pallets: null }] } }).trucks;
  for (const f of [0.05, 0.5, 1, 2, 10]) {
    const d = DOORS.describeTrucks(rate, { demandFactor: f });
    assert.ok(Math.abs(d.trucksPerHour - 2 * f) < 1e-9, `frequency x${f}`);
    assert.equal(d.palletsPerTruck, 24);
    assert.equal(DOORS.truckGap(createRng(1), rate, f), 1800 / f);
    const s = DOORS.describeTrucks(sched, { demandFactor: f });
    assert.equal(s.rows, 2);
    assert.equal(s.trucksPerHour, 2 / 24, 'appointments do not move');
    assert.equal(s.palletsPerTruck, (DOORS.scalePallets(24, f) + DOORS.scalePallets(24, f)) / 2);
    assert.equal(DOORS.peakRowsPerHour(sched.schedule), 1);
    assert.equal(DOORS.doorCheck(sched, { demandFactor: f }).trucksPerHour, 1, 'the peak of a timetable is its rows');
    assert.ok(Math.abs(DOORS.doorCheck(rate, { demandFactor: f }).trucksPerHour - 2 * f) < 1e-9);
  }
  for (const f of [0, NaN, undefined, null, 'x', -0]) {
    if (f === undefined || f === null || typeof f === 'string' || Number.isNaN(f)) { assert.equal(DOORS.describeTrucks(rate, { demandFactor: f }).trucksPerHour, 2, `a junk factor reads as 1 (${f})`); continue; }
    assert.equal(DOORS.scalePallets(24, f), 0, `factor ${f}`);
    assert.equal(DOORS.truckGap(createRng(1), rate, f), Infinity);
    assert.equal(DOORS.doorCheck(rate, { demandFactor: f }).empty, f <= 0);
  }
  assert.deepEqual([DOORS.scalePallets(1, 0.05), DOORS.scalePallets(200, 10), DOORS.scalePallets(24, 1), DOORS.scalePallets(5, 0.5), DOORS.scalePallets(7, 0.5)], [1, 2000, 24, 3, 4]);
  assert.equal(DOORS.doorCheck(rate, { demandFactor: 0 }).text, 'No truck arrives, so no door is needed.');
});

test('M1-MODEL-REV helpers 7: the door check, the description, the toast and the schedule helpers are total: no NaN, undefined or Infinity in any number or text', () => {
  const rng = createRng(4);
  const bad = /NaN|undefined|Infinity|\[object/;
  const blocks = [undefined, null, 'x', [], {}, OPS.defaultTrucks(), OPS.sanitizeOps('sink', { trucks: { mode: 'schedule' } }).trucks, { doors: NaN, checkIn: 'x', interArrival: { mean: 0 }, pallets: null, schedule: 'x' }, { mode: 'schedule', schedule: [{ at: 5 }, null] }, OPS.sanitizeOps('source', { trucks: { interArrival: { mean: 60 }, pallets: { mean: 200 }, doors: 1, checkIn: 7200, checkOut: 7200 } }).trucks];
  const opts = [undefined, {}, { demandFactor: 0 }, { demandFactor: 10 }, { demandFactor: 'x' }, { tPallet: 0 }, { tPallet: Infinity }, { measuredDoorSeconds: 0 }, { measuredDoorSeconds: 1e9 }, { measuredDoorSeconds: -1 }, { measuredDoorSeconds: NaN }, { measuredDoorSeconds: 100, demandFactor: 3 }];
  for (const t of blocks) for (const o of opts) {
    let c;
    try { c = DOORS.doorCheck(t, o); } catch (err) { assert.fail(`doorCheck threw for ${bytes(t)} ${bytes(o)}: ${err.message}`); }
    for (const k of ['doors', 'trucksPerHour', 'pallets', 'doorSeconds', 'doorHours', 'needed', 'utilisation', 'suggestedDoors', 'suggestedUtilisation']) assert.ok(Number.isFinite(c[k]), `${k} for ${bytes(t)} ${bytes(o)}`);
    assert.ok(!bad.test(c.text), `${c.text} for ${bytes(t)} ${bytes(o)}`);
    assert.ok(c.suggestedDoors >= 1 && c.suggestedDoors <= 32);
    const d = DOORS.describeTrucks(t, o);
    assert.ok(Number.isFinite(d.trucksPerHour) && Number.isFinite(d.palletsPerHour) && Number.isFinite(d.palletsPerTruck));
    for (const type of ['source', 'sink']) assert.ok(!bad.test(DOORS.dockDoorsToast({ name: 'X', type, trucks: t, before: rng.next() < 0.5 ? 20 : undefined })), `toast ${bytes(t)}`);
  }
  for (const t of [undefined, {}, OPS.defaultTrucks()]) for (const f of [undefined, 0, 1, NaN, 'x']) {
    assert.ok(Number.isFinite(DOORS.scalePallets(5, f)));
    assert.ok(Number.isFinite(DOORS.drawPallets(createRng(1), { kind: 'exp', mean: 24, spread: 0 })));
  }
});

// =============================================================================================================================
// 4. Pasting a timetable (7.2): parseTimetable against a reference parser, hostile text, purity
// =============================================================================================================================

/** What the dialog would show for a text: rows as [line, at, pallets], the lines it could not read, and whether a header was skipped. */
const readBack = (text) => {
  const r = parseTimetable(text);
  return { rows: r.rows.map((x) => [x.line, x.at, x.pallets]), bad: r.skipped.filter((x) => x.code !== 'too-many').map((x) => x.line), header: r.header !== null };
};
const oracleBack = (text) => {
  const o = H.pasteOracle(text);
  return { rows: o.rows.map((x) => [x.line, x.at, x.pallets]), bad: o.bad.map((x) => x.line), header: o.header };
};

test('M1-MODEL-REV paste 1: 2,000 generated spreadsheet texts (separators, locales, line endings, BOM, quotes, trailing separators, bad rows): parseTimetable and the reference parser agree on every row, every bad line and the header', () => {
  const rng = createRng(20261010);
  const n = H.size(2000, 8000);
  const problems = [];
  let rows = 0;
  let bad = 0;
  for (let i = 0; i < n; i++) {
    const text = H.pasteText(rng);
    const got = readBack(text);
    const want = oracleBack(text);
    rows += want.rows.length;
    bad += want.bad.length;
    if (bytes(got) !== bytes(want) && problems.length < 5) problems.push(`${JSON.stringify(text)}\n  code   ${bytes(got)}\n  oracle ${bytes(want)}`);
  }
  assert.deepEqual(problems, []);
  assert.ok(rows > n && bad > n / 3, `the generator made ${rows} good rows and ${bad} bad ones`);
});

test('M1-MODEL-REV paste 2: nothing in 7.2 is guessed: bad fields are never read as another time or another number of pallets', () => {
  // a field that is not a time of 7.2 is a bad row, whatever it looks like (am/pm, seconds, 24:00, a day fraction with a comma, full-width digits)
  for (const time of H.BAD_TIMES) {
    const r = parseTimetable(`${time}\t24`);
    assert.equal(r.rows.length, 0, `“${time}” must not become a row`);
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0].message, /^row 1 /);
  }
  for (const p of H.BAD_PALLETS) {
    const r = parseTimetable(`6:00\t${p}`);
    assert.equal(r.rows.length, 0, `“${p}” pallets must not become a row`);
  }
  // what 7.2 does accept, with its exact meaning
  const good = { '6:00': 21600, '06:00': 21600, '06.00': 21600, '0600': 21600, '6:00 Uhr': 21600, '06:00h': 21600, '6:00 UHR': 21600, '0:00': 0, '23:59': 86399 - 59, '00:01': 60, '1230': 45000 };
  for (const [text, at] of Object.entries(good)) assert.deepEqual(readBack(`${text};24`).rows, [[1, at, 24]], text);
  for (const [text, pallets] of Object.entries({ '24': 24, '24,0': 24, '24.0': 24, '24,00': 24, '1': 1, '200': 200, '': null })) assert.deepEqual(readBack(`6:00;${text}`).rows, [[1, 21600, pallets]], `“${text}”`);
  for (const [sep, name] of [['\t', 'tab'], [';', 'semicolon'], [',', 'comma']]) {
    const r = parseTimetable(`Time${sep}Pallets\r\n6:00${sep}24\r\n7:30${sep}18`);
    assert.equal(r.separator, name);
    assert.deepEqual(r.rows.map((x) => [x.at, x.pallets]), [[21600, 24], [27000, 18]]);
    assert.deepEqual(r.header, { line: 1, text: `Time${sep}Pallets` });
  }
  // a comma separates columns only when every row has exactly one comma pair that is not a decimal number
  assert.equal(parseTimetable('0600,24\n0700,12').separator, null, 'could be decimal numbers: not split');
  assert.equal(parseTimetable('6:00,24\n7:00').separator, null, 'a row without a pair: not a comma file');
  assert.deepEqual(readBack('6:00,24\n7:00,12').rows, [[1, 21600, 24], [2, 25200, 12]]);
  // line numbers count the empty lines; the BOM and every line ending are understood
  assert.deepEqual(readBack('\ufeff6:00;1\r\n\r\n7:00;2\r8:00;3\n\n9:00;4').rows.map((r) => r[0]), [1, 3, 4, 6]);
  // the cap: the first 500 good rows and ONE entry that says how many were left out
  const many = parseTimetable(Array.from({ length: 2000 }, (_, i) => `${String(i % 24).padStart(2, '0')}:00;5`).join('\n'));
  assert.equal(many.rows.length, 500);
  assert.equal(many.omitted, 1500);
  assert.deepEqual(many.skipped.map((s) => [s.code, s.line]), [['too-many', 501]]);
  assert.equal(OPS.sanitizeOps('source', { trucks: { schedule: rowsOf(many) } }).trucks.schedule.length, 500, 'what the dialog applies is what the sanitizer keeps');
});

test('M1-MODEL-REV paste 3: parseTimetable never throws and never applies anything: 600 hostile inputs, a stable result, rows the sanitizer keeps as they are', () => {
  const rng = createRng(99);
  const alphabet = ['0', '1', '2', '5', '9', ':', '.', ',', ';', '\t', '\r', '\n', '\r\n', '"', "'", ' ', '\u00a0', '\ufeff', 'h', 'H', 'Uhr', 'AM', 'PM', 'x', '-', '+', 'e', '٣', '１', '\u0000', '\\', '/', '\u2028', '\u200b'];
  const inputs = [undefined, null, 0, 1, NaN, true, {}, [], ['6:00'], { text: '6:00' }, '', ' ', '\n', '\ufeff', ';', '\t', '"', '""""'];
  for (let i = 0; i < 580; i++) inputs.push(Array.from({ length: rng.int(80) }, () => alphabet[rng.int(alphabet.length)]).join(''));
  const globals = () => `${Object.getOwnPropertyNames(globalThis).sort().join()}|${Object.getOwnPropertyNames(Object.prototype).sort().join()}`;
  const globalsBefore = globals();
  for (const text of inputs) {
    let r;
    try { r = parseTimetable(text); } catch (err) { assert.fail(`threw for ${JSON.stringify(text)}: ${err.message}`); }
    assert.deepEqual(parseTimetable(text), r, 'the same text gives the same result');
    assert.ok(r.rows.length <= OPS.MAX_SCHEDULE_ROWS);
    let lastLine = 0;
    for (const row of r.rows) {
      assert.ok(Number.isInteger(row.at) && row.at >= 0 && row.at < 86400 && row.at % 60 === 0, bytes(row));
      assert.ok(row.pallets === null || (Number.isInteger(row.pallets) && row.pallets >= 1 && row.pallets <= 200), bytes(row));
      assert.ok(row.line > lastLine);
      lastLine = row.line;
    }
    for (const s of r.skipped) {
      assert.ok(['time', 'pallets', 'columns', 'no-time', 'too-many'].includes(s.code) && s.line >= 1 && s.message.length > 5 && !/undefined|NaN/.test(s.message), bytes(s));
    }
    assert.ok(!/undefined|NaN|\[object/.test(summarizeTimetable(r)), summarizeTimetable(r));
    // "Use N rows" applies exactly the N rows: the sanitizer keeps them all, with the same meaning
    const kept = OPS.sanitizeOps('source', { trucks: { schedule: rowsOf(r) } }).trucks.schedule;
    assert.deepEqual(kept, rowsOf(r).map((x, k) => ({ ...x, k })).sort((a, b) => a.at - b.at || a.k - b.k).map(({ at, pallets }) => ({ at, pallets })));
    // the result is fresh data: changing it changes nothing in the next call
    r.rows.push({ at: 1 });
    r.skipped.length = 0;
    assert.deepEqual(parseTimetable(text).rows.length, r.rows.length - 1);
  }
  assert.equal(globals(), globalsBefore, 'the parser creates no global and touches no prototype');
  const rows = [{ at: 21600, pallets: 24, line: 1 }];
  assert.deepEqual(rowsOf({ rows }), [{ at: 21600, pallets: 24 }], 'rowsOf drops the line numbers');
  assert.equal(rows[0].line, 1, 'and does not change its argument');
});

test('DISCREPANCY paste: the summary adds "(and N more)" to the sentence of copy 5 when more than one row was skipped; the document has the sentence without it', () => {
  const text = [...Array.from({ length: 12 }, (_, i) => `${6 + i}:00;24`), '25:70;3', 'noon;4'].join('\n');
  const r = parseTimetable(text);
  assert.equal(r.rows.length, 12);
  assert.equal(summarizeTimetable(r), '12 rows read, 2 skipped: row 13 “25:70” is not a time (and 1 more). Nothing is applied until you press Use 12 rows.');
  const design = readFileSync(path.join(H.ROOT, 'docs', 'WAREHOUSE-DESIGN.md'), 'utf8');
  assert.ok(design.includes('"{n} rows read, {k} skipped: row {r} “{text}” is not a time. Nothing is applied until you press Use {n} rows."'), 'copy 5 of 7.6 is still in the document');
  assert.equal(summarizeTimetable(parseTimetable(`${text.split('\n').slice(0, 12).join('\n')}\n25:70;3`)), '12 rows read, 1 skipped: row 13 “25:70” is not a time. Nothing is applied until you press Use 12 rows.', 'with one skipped row the copy is word for word');
});

defect('M1-MODEL-REV-2 parseTimetable reads an Excel day fraction such as "0.25" (a time cell shown as a number: 6:00) as 00:25, because "H.MM" with ONE hour digit is accepted; 7.2 lists HH.MM only', () => {
  // docs/WAREHOUSE-DESIGN.md 7.2: "Times: H:MM, HH:MM, HH.MM (two digits after the point, at most 59), HHMM". A single hour digit before a point is not on the list, and it is
  // exactly what a time cell shows in a General-formatted spreadsheet: 0.25 = 6:00, 0.5 = 12:00 (refused: one digit), 0.75 = 18:00. R12: never guess silently.
  for (const text of ['0.25;24', '0.75;24', '0.33;5', '6.00;24']) {
    const r = parseTimetable(text);
    assert.deepEqual(r.rows, [], `“${text}” is not a time of 7.2 and must be a bad row, not ${r.rows.length ? JSON.stringify(r.rows[0]) : '?'}`);
  }
  assert.equal(parseTimeField('0.25'), null);
  assert.equal(parseTimeField('06.00'), 21600, 'HH.MM stays');
});

defect('M1-MODEL-REV-10 (design gap) a time with seconds that are zero, "06:00:00", is a bad row: it is the notation of most warehouse-system and database exports, and reading it loses nothing', () => {
  // 7.2 lists no notation with seconds, so the parser refuses it; ops.js timeOfDay (the sanitizer) reads HH:MM:SS. Zero seconds can be read without a guess; 06:00:30 stays refused.
  assert.equal(parseTimeField('06:00:00'), 21600);
  assert.equal(parseTimeField('6:05:00'), 21900);
  assert.equal(parseTimeField('06:00:30'), null, 'seconds that are not zero would be a guess');
  assert.deepEqual(readBack('06:00:00;24\n07:30:00;18').rows, [[1, 21600, 24], [2, 27000, 18]]);
});

/** Milliseconds of CPU for one call of `fn`. */
const timed = (fn) => { const t0 = cpu(); fn(); return cpu() - t0; };

defect('M1-MODEL-REV-4 parseTimeField / parseTimetable take QUADRATIC time on a field with a long run of spaces (the regexp /\\s*(?:uhr|h)$/ is tried at every start): the paste dialog parses on every keystroke', () => {
  // 10,000 spaces: linear code needs a millisecond or two, the regexp 100 to 160 ms (measured: 8e4 spaces = 6.9 s, 4 times the input = 16 times the time)
  const ms = timed(() => parseTimetable(`6:00${' '.repeat(10000)}x;24`));
  assert.ok(ms < 40, `10,000 spaces in a time field: ${ms.toFixed(0)} ms of CPU`);
});

defect('M1-MODEL-REV-5 decodeShare takes QUADRATIC time on a link that ends in a long run of punctuation followed by a letter (sharePayload strips trailing punctuation with an unanchored /[.,;:!?)\\]}>"\']+$/): a crafted #p= link freezes the tab at start-up', async () => {
  const t0 = cpu();
  await S.decodeShare(`${')'.repeat(10000)}a`).catch(() => {});
  const ms = cpu() - t0;
  assert.ok(ms < 30, `10,000 punctuation characters: ${ms.toFixed(0)} ms of CPU (linear: a millisecond; measured: 8e4 characters = 6.5 s, 4 times the input = 16 times the time)`);
});

defect('M1-MODEL-REV-9 a row whose time cell is EMPTY and whose pallets are given ("<TAB>24") is reported as “24” is not a time, not as "has no arrival time": the line is trimmed before its columns are split', () => {
  const r = parseTimetable('\t24\n6:00\t12');
  assert.equal(r.separator, 'tab');
  assert.deepEqual(r.rows.map((x) => x.at), [21600]);
  assert.equal(r.skipped.length, 1);
  assert.equal(r.skipped[0].code, 'no-time', r.skipped[0].message);
});

// =============================================================================================================================
// 5. Validation (Appendix B): each code against its oracle, the boundaries, odd shapes, the Fix buttons
// =============================================================================================================================

const OWN_CODES = ['doors-too-few', 'doors-exceed-docks', 'docks-share-lane', 'timetable-empty'];
const issuesOf = (layout, codes = OWN_CODES) => validateLayout(layout).filter((i) => codes.includes(i.code));
const stationsWithTrucks = (layout) => layout.stations.filter((s) => OPS.trucksOf(s));

/** A random plant with roads, stations and truck blocks made only of valid values, so that every code has a chance to fire. */
function randomTruckPlant(rng) {
  const cols = 24 + rng.int(10);
  const rows = 16 + rng.int(8);
  const layout = L.createLayout({ cols, rows, cellSize: 2 });
  for (let i = 0, n = 2 + rng.int(6); i < n; i++) L.paintRoadPath(layout, [[rng.int(cols), rng.int(rows)], [rng.int(cols), rng.int(rows)]], { oneWay: rng.next() < 0.2 });
  for (let i = 0, n = 1 + rng.int(4); i < n; i++) {
    const type = pick(rng, ['source', 'sink', 'source', 'process', 'storage']);
    const s = L.addStation(layout, { type, x: rng.int(cols), y: rng.int(rows), w: 1 + rng.int(5), h: 1 + rng.int(3) });
    if (s && (type === 'source' || type === 'sink') && rng.next() < 0.8) {
      const mode = rng.next() < 0.3 ? 'schedule' : 'rate';
      const schedule = mode === 'schedule' ? Array.from({ length: rng.int(5) }, () => ({ at: rng.int(86400), pallets: rng.next() < 0.5 ? 1 + rng.int(40) : null })) : [];
      L.updateStation(layout, s.id, { ops: { trucks: { doors: 1 + rng.int(8), mode, schedule, interArrival: { mean: pick(rng, [60, 300, 900, 1800, 3600, 7200]) }, pallets: { mean: 1 + rng.int(40) }, checkIn: rng.int(900), checkOut: rng.int(900) } } });
    }
  }
  L.updateSettings(layout, { demandFactor: pick(rng, [0.5, 1, 1, 2]) });
  return layout;
}

/** Doors busy at once at the busiest hour, computed from 6.3.4 and Appendix A.1 with the numbers of the block and nothing from doors.js. */
function neededOracle(trucks, demand) {
  const door = trucks.checkIn + 0 + trucks.checkOut;
  if (trucks.mode === 'schedule') {
    if (trucks.schedule.length === 0) return 0;
    const pallets = trucks.schedule.reduce((sum, r) => sum + Math.max(1, Math.round((r.pallets ?? Math.round(trucks.pallets.mean)) * demand)), 0) / trucks.schedule.length;
    return H.bruteRowsPerHour(trucks.schedule.map((r) => r.at)) * (door + pallets * 90) / 3600;
  }
  return (3600 / trucks.interArrival.mean) * demand * (door + trucks.pallets.mean * 90) / 3600;
}

test('M1-MODEL-REV validate 1: on 200 random plants every code fires exactly when its oracle says (Appendix B with the three deviations of the code), with a stable id, one severity and the refs of the Fix', () => {
  const rng = createRng(31337);
  const seen = {};
  let plants = 0;
  for (let i = 0; i < H.size(200, 600); i++) {
    const layout = randomTruckPlant(rng);
    plants++;
    const found = issuesOf(layout);
    const byId = new Map(found.map((x) => [x.id, x]));
    assert.equal(byId.size, found.length, 'ids are unique');
    const demand = layout.settings.demandFactor;
    const expected = new Set();
    for (const s of layout.stations) {
      const trucks = OPS.trucksOf(s);
      if (!trucks) {
        for (const code of OWN_CODES) assert.ok(!byId.has(`${code}:${s.id}`), `a station without trucks is never warned about (${code}:${s.id})`);
        continue;
      }
      const docks = L.docksOf(layout, s.id);
      const need = neededOracle(trucks, demand);
      if (need > 0 && need / trucks.doors > 0.95) expected.add(`doors-too-few:${s.id}`);
      if (docks.length > 0 && trucks.doors > docks.length) expected.add(`doors-exceed-docks:${s.id}`);
      if (trucks.mode === 'schedule' && trucks.schedule.length === 0) expected.add(`timetable-empty:${s.id}`);
      const literal = H.literalLaneCells(layout, s);
      const cells = VOPS.dockLanes(layout, s).flat().map((c) => c.join(','));
      for (const c of cells) assert.ok(literal.has(c), `a lane cell ${c} that Appendix B does not select`);
      for (const c of cells) assert.ok(docks.some(([x, y]) => `${x},${y}` === c), 'a lane cell is a dock');
      if (cells.length) expected.add(`docks-share-lane:${s.id}`);
    }
    assert.deepEqual([...byId.keys()].sort(), [...expected].sort(), `plant ${i}`);
    for (const issue of found) {
      seen[issue.code] = (seen[issue.code] ?? 0) + 1;
      assert.equal(issue.severity, 'warning');
      assert.equal(issue.refs.stationId, issue.id.split(':')[1]);
      assert.ok(issue.message.length > 20 && issue.hint.length > 5 && !/undefined|NaN|\[object/.test(issue.message + issue.hint), issue.message);
      assert.equal(typeof issue.refs.stationId, 'string');
    }
  }
  for (const code of OWN_CODES) assert.ok((seen[code] ?? 0) >= (H.HEAVY ? 20 : 8), `${code} fired ${seen[code] ?? 0} times in ${plants} plants`);
  // no other code is new: a plant without trucks is judged by the legacy checks alone
  const legacy = validateLayout(build('two-lines'));
  assert.deepEqual(legacy.filter((i) => OWN_CODES.includes(i.code)), []);
});

/** A street at y=6 and a Goods in of 12 x 2 cells (x 1..12, y 1..2) with `docks` side roads of its own: each runs from the street up to the cell under the station (so each dock has a road behind it and no two share a lane). */
function boundaryPlant(docks, doors) {
  const layout = L.createLayout({ cols: 20, rows: 10 });
  L.addStation(layout, { type: 'source', name: 'In', x: 1, y: 1, w: 12, h: 2, ops: { trucks: { doors } } });
  L.paintRoadPath(layout, [[0, 6], [19, 6]]);
  for (let i = 0; i < docks; i++) L.paintRoadPath(layout, [[1 + i * 2, 6], [1 + i * 2, 3]]);
  return layout;
}

test('M1-MODEL-REV validate 2: the boundaries: doors == docks is fine, one door more warns; one row is a timetable, none is not; 95 % busy is fine, a hair above warns', () => {
  for (let docks = 1; docks <= 5; docks++) {
    for (const doors of [Math.max(1, docks - 1), docks, docks + 1, docks + 5]) {
      const layout = boundaryPlant(docks, doors);
      const station = layout.stations[0];
      assert.equal(L.docksOf(layout, station.id).length, docks, `${docks} docks`);
      const fires = issuesOf(layout, ['doors-exceed-docks']).length === 1;
      assert.equal(fires, doors > docks, `${doors} doors, ${docks} docks`);
      assert.deepEqual(issuesOf(layout, ['docks-share-lane']), [], 'spurs with a road behind them never share a lane');
    }
  }
  // a timetable
  const layout = boundaryPlant(2, 2);
  const id = layout.stations[0].id;
  const rows = (n) => ({ ops: { trucks: { mode: 'schedule', schedule: Array.from({ length: n }, (_, i) => ({ at: 3600 * i, pallets: 5 })) } } });
  L.updateStation(layout, id, rows(0));
  assert.deepEqual(issuesOf(layout, ['timetable-empty']).map((i) => i.id), [`timetable-empty:${id}`]);
  L.updateStation(layout, id, rows(1));
  assert.deepEqual(issuesOf(layout, ['timetable-empty']), []);
  L.updateStation(layout, id, { ops: { trucks: { mode: 'rate' } } });
  assert.deepEqual(issuesOf(layout, ['timetable-empty']), []);
  // 95 % busy: 4 doors, trucks of 40 pallets (3,600 s at 90 s a pallet, no check-in or check-out), one every 3600 / (4 x u) seconds
  for (const util of [0.9, 0.94, 0.949, 0.9499, 0.9501, 0.951, 0.96, 1.2]) {
    const plant = boundaryPlant(4, 4);
    L.updateStation(plant, plant.stations[0].id, { ops: { trucks: { doors: 4, checkIn: 0, checkOut: 0, interArrival: { kind: 'const', mean: 3600 / (4 * util), spread: 0 }, pallets: { kind: 'const', mean: 40, spread: 0 } } } });
    assert.equal(issuesOf(plant, ['doors-too-few']).length === 1, util > 0.95, `${util} busy`);
  }
  // Goods out is judged by the same four checks
  const out = boundaryPlant(1, 4);
  const sink = L.addStation(out, { type: 'sink', name: 'Out', x: 15, y: 7, w: 4, h: 2, ops: { trucks: { doors: 9 } } });
  assert.ok(issuesOf(out, ['doors-exceed-docks']).some((i) => i.id === `doors-exceed-docks:${sink.id}`));
});

/** ASCII plants of odd shapes: the lanes the rule must find, and what the sim shows is not asserted here. A is a Goods in with trucks. */
const SHAPES = [
  ['a row of three docks on one street', ['.AAA....', '.+++++..', '........'], ['1,1 2,1 3,1']],
  ['the same row with a second road behind it', ['.AAA....', '.+++++..', '.+++++..', '........'], []],
  ['the street turns a corner beside the station: the docks of one side', ['........', '.AA+....', '.AA+....', '..+++...', '........'], ['3,1 3,2']],
  ['two stations facing a one-cell street: the docks are shared and both are in a lane', ['AAAA....', '++++++..', 'BBBB....'], ['0,1 1,1 2,1 3,1']],
  ['three short spurs: every dock has a road behind it', ['.AAA....', '.+.+....', '.+.+....', '........'], []],
  ['a one-way street along the docks', ['.AAA....', '.>>>>...', '........'], ['1,1 2,1 3,1']],
  ['a street that is one-way each way from the middle: only the joined pair is a lane', ['.AAA....', '.><<....', '........'], ['2,1 3,1']],
  ['a station with a single dock cell has nothing to share', ['.A......', '.+......', '........'], []],
  ['a dead end: the street stops under the last dock', ['.AAA....', '.+++....', '........'], ['1,1 2,1 3,1']],
  ['road cells in the corners of a station are not docks', ['+AAA+...', '.....+..', '........'], []],
];

test('M1-MODEL-REV validate 3: docks-share-lane on odd shapes (corner, shared dock cells between two stations, dead ends, one-way streets, a second road behind): the lanes found are exactly the expected ones', () => {
  for (const [name, lines, want] of SHAPES) {
    const layout = L.normalizeLayout(layoutFromAscii(lines, { stations: { A: { type: 'source', ops: { trucks: { doors: 2 } } }, B: { type: 'sink', ops: { trucks: { doors: 2 } } } }, fleets: [{ count: 1 }] }));
    const lanes = VOPS.dockLanes(layout, layout.stations.find((s) => s.id === 'A')).map((lane) => lane.map((c) => c.join(',')).join(' '));
    assert.deepEqual(lanes, want, name);
    const fires = issuesOf(layout, ['docks-share-lane']).filter((i) => i.refs.stationId === 'A');
    assert.equal(fires.length, want.length ? 1 : 0, name);
    if (want.length) assert.deepEqual(fires[0].refs.cells.map((c) => c.join(',')), want.flatMap((w) => w.split(' ')), `${name}: the cells of the issue`);
    const literal = H.literalLaneCells(layout, layout.stations.find((s) => s.id === 'A'));
    for (const lane of want) for (const c of lane.split(' ')) assert.ok(literal.has(c), `${name}: Appendix B selects ${c}`);
  }
  // the facing station has the same lane from its side
  const facing = L.normalizeLayout(layoutFromAscii(SHAPES[3][1], { stations: { A: { type: 'source', ops: { trucks: { doors: 2 } } }, B: { type: 'sink', ops: { trucks: { doors: 2 } } } }, fleets: [{ count: 1 }] }));
  assert.deepEqual(VOPS.dockLanes(facing, facing.stations.find((s) => s.id === 'B')).map((l) => l.length), [4]);
  assert.deepEqual(issuesOf(facing, ['docks-share-lane']).map((i) => i.id).sort(), ['docks-share-lane:A', 'docks-share-lane:B']);
  // a road along the edge of the plan: outside the plan counts as no road
  const edge = L.createLayout({ cols: 10, rows: 8 });
  L.addStation(edge, { type: 'source', name: 'In', x: 2, y: 5, w: 4, h: 2, ops: { trucks: { doors: 2 } } });
  L.paintRoadPath(edge, [[1, 7], [8, 7]]);
  assert.equal(VOPS.dockLanes(edge, edge.stations[0]).length, 1, 'the docks along the last row of the plan share a lane');
  // the strips are exactly the docks of docksOf, in every shape
  for (const [name, lines] of SHAPES) {
    const layout = L.normalizeLayout(layoutFromAscii(lines, { stations: { A: { type: 'source', ops: { trucks: { doors: 2 } } }, B: 'sink' }, fleets: [{ count: 1 }] }));
    const a = layout.stations.find((s) => s.id === 'A');
    const docks = new Set(L.docksOf(layout, 'A').map((c) => c.join(',')));
    for (const lane of VOPS.dockLanes(layout, a)) for (const c of lane) assert.ok(docks.has(c.join(',')), `${name}: ${c} is a dock`);
  }
});

defect('M1-MODEL-REV-3 docks-share-lane is silent for docks in a row that have a second road BEHIND them, but the simulation sends every visit to the first dock there too (Appendix B: "the cells on their far side are not road cells")', () => {
  const plant = (wide) => {
    const l = L.createLayout({ name: 'Dock lab', cols: 40, rows: 24, cellSize: 2 });
    L.paintRoadPath(l, [[4, 10], [30, 10], [30, 18], [4, 18], [4, 10]]);
    if (wide) {
      for (let x = 4; x <= 30; x++) L.paintRoadPath(l, [[x, 10], [x, 11]]); // a second road row behind the docks, joined at every cell
      L.paintRoadPath(l, [[4, 11], [30, 11]]);
    }
    const src = L.addStation(l, { type: 'source', name: 'Goods in', x: 10, y: 8, w: 6, h: 2, params: { interArrival: { kind: 'normal', mean: 14, spread: 0.2 }, outCap: 12 }, ops: { trucks: { doors: 6 } } });
    const sink = L.addStation(l, { type: 'sink', name: 'Goods out', x: 31, y: 13, w: 3, h: 2 });
    const park = L.addStation(l, { type: 'depot', name: 'Park', x: 8, y: 19, w: 3, h: 2, params: { slots: 8 } });
    L.paintRoadPath(l, [[9, 18], [9, 19]]);
    L.addFlow(l, src.id, sink.id);
    L.addFleet(l, 'forklift', { name: 'FL', count: 8, home: park.id, capacity: 1 });
    // the legacy source makes the Appendix C load; the trucks block only switches the plan check on
    return l;
  };
  const visits = (l) => {
    const raw = clone(l);
    delete raw.stations[0].ops;
    const sim = new Simulation(L.normalizeLayout(raw), { seed: 3 });
    sim.advance(1800);
    return sim.logistics.docks.counters(raw.stations[0].id).map((d) => d.visits);
  };
  const narrow = plant(false);
  const wide = plant(true);
  const b = visits(wide);
  const share = (v) => v[0] / v.reduce((p, q) => p + q, 0);
  assert.ok(share(b) > 0.9, `with a second road behind the docks the first dock takes ${(share(b) * 100).toFixed(0)} % of the visits: ${b} (the Appendix C row without it: 465,0,0,0,0,0)`);
  assert.ok(VOPS.dockLanes(narrow, narrow.stations[0]).length > 0);
  assert.ok(VOPS.dockLanes(wide, wide.stations[0]).length > 0, 'the plan check must warn about the plant that shows the symptom');
});

test('M1-MODEL-REV validate 4: the Fix buttons through the REAL store: one undo step, the issue is gone, nothing is invalid, undo restores the plant exactly', () => {
  const rng = createRng(2718);
  const applied = { 'update-station': 0, 'extend-docks': 0, focus: 0 };
  let partial = 0;
  for (let i = 0; i < H.size(140, 450); i++) {
    const store = createStore({ storage: null });
    store.newProject(randomTruckPlant(rng));
    for (const issue of issuesOf(store.getState().layout)) {
      const layout = store.getState().layout;
      const fix = VOPS.opsFixFor(layout, issue);
      if (!fix) continue;
      applied[fix.type] = (applied[fix.type] ?? 0) + 1;
      assert.ok(typeof fix.label === 'string' && fix.label.length > 3);
      if (fix.type === 'focus') {
        assert.deepEqual(fix.refs.stationIds, [issue.refs.stationId]);
        assert.ok(fix.refs.cells.length >= 2);
        assert.equal(VOPS.applyOpsFix(clone(layout), fix), false, 'focus changes nothing');
        continue;
      }
      const before = bytes(layout);
      const depth = store.getState().undoLabel;
      let changed;
      try { changed = store.commit(fix.undoLabel, (d) => VOPS.applyOpsFix(d, fix)); } catch (err) { assert.fail(`${issue.id}: the Fix was rolled back: ${err.message}`); }
      const after = store.getState().layout;
      assert.deepEqual(L.checkInvariants(after), []);
      if (!changed) { assert.equal(bytes(after), before); partial++; continue; }
      assert.equal(store.getState().undoLabel, fix.undoLabel, 'one undo step with the label of the Fix');
      const stillThere = issuesOf(after).some((x) => x.id === issue.id);
      if (fix.type === 'update-station' && issue.code === 'doors-too-few') {
        const check = DOORS.doorCheck(OPS.trucksOf(L.getStation(after, issue.refs.stationId)), { demandFactor: after.settings.demandFactor });
        assert.equal(stillThere, check.tooFew);
        if (fix.patch.ops.trucks.doors < 32) assert.equal(stillThere, false, `${issue.id}: Use ${fix.patch.ops.trucks.doors} doors`);
      } else if (fix.type === 'extend-docks') {
        const need = fix.count;
        if (L.docksOf(after, issue.refs.stationId).length >= L.docksOf(layout, issue.refs.stationId).length + need) assert.equal(stillThere, false, `${issue.id}: extended fully`);
        else partial++;
      } else assert.equal(stillThere, false, `${issue.id}: ${fix.label}`);
      assert.ok(store.undo());
      assert.equal(bytes(store.getState().layout), before, `${issue.id}: one undo restores the plant`);
      assert.equal(store.getState().undoLabel, depth, 'and it was one step');
      assert.ok(store.redo());
      assert.equal(bytes(store.getState().layout), bytes(after));
    }
  }
  assert.ok(applied['update-station'] > 20 && applied['extend-docks'] > 5 && applied.focus > 3, JSON.stringify(applied));
});

defect('M1-MODEL-REV-6 the Fix of doors-too-few offers "Use 32 doors" when even 32 doors are too few, and the warning is still there afterwards', () => {
  const layout = L.createLayout({ cols: 40, rows: 14 });
  L.paintRoadPath(layout, [[0, 6], [39, 6]]);
  for (let i = 0; i < 20; i++) L.paintRoadPath(layout, [[1 + i * 2, 6], [1 + i * 2, 3]]);
  const s = L.addStation(layout, { type: 'source', name: 'In', x: 0, y: 1, w: 40, h: 2, ops: { trucks: { doors: 8, interArrival: { kind: 'const', mean: 60, spread: 0 }, pallets: { kind: 'const', mean: 40, spread: 0 } } } });
  const issue = issuesOf(layout, ['doors-too-few'])[0];
  assert.ok(issue, 'the plant needs about 70 doors');
  const fix = VOPS.opsFixFor(layout, issue);
  if (fix === null) return; // no button is also a fine answer
  VOPS.applyOpsFix(layout, fix);
  assert.equal(issuesOf(layout, ['doors-too-few']).filter((i) => i.refs.stationId === s.id).length, 0, `after "${fix.label}" the warning is still there`);
});

defect('M1-MODEL-REV-7 the message of doors-too-few says "needs about 1 doors busy at once ... but it has 1" at 96 % busy: the 95 % rule fires before the doors are fewer than needed, and the sentence does not say so', () => {
  const layout = L.createLayout({ cols: 30, rows: 14 });
  L.paintRoadPath(layout, [[2, 6], [28, 6]]);
  L.addStation(layout, { type: 'source', name: 'Goods in', x: 5, y: 4, w: 2, h: 2, ops: { trucks: { doors: 1, interArrival: { kind: 'const', mean: 3063, spread: 0 }, pallets: { kind: 'const', mean: 26, spread: 0 } } } });
  const check = DOORS.doorCheck(layout.stations[0].ops.trucks);
  assert.ok(check.tooFew && check.needed < 1, `needed ${check.needed}`);
  const issue = issuesOf(layout, ['doors-too-few'])[0];
  assert.ok(issue);
  assert.doesNotMatch(issue.message, /about 1 doors/, issue.message);
  assert.doesNotMatch(issue.message, /needs about 1 .*but it has 1,/, issue.message);
});

defect('M1-MODEL-REV-8 doorCheck(trucks, null) throws a TypeError (the options default only covers undefined), where describeTrucks and the layout.js convention read null as "no options"', () => {
  const t = OPS.defaultTrucks();
  assert.doesNotThrow(() => DOORS.describeTrucks(t, null));
  assert.doesNotThrow(() => DOORS.doorCheck(t, null));
  assert.equal(DOORS.doorCheck(t, null).doors, 2);
});

test('DISCREPANCY validate: the code is a SUPERSET of Appendix B for doors-too-few (95 % busy, not "exceeds the doors"), silent for a station without a dock, checks only stations that have trucks, and joins the lane cells by road', () => {
  // 1. Appendix B: "doors needed (A.1) exceeds the doors". Code: DOORS_TOO_FEW_UTILISATION = 0.95 (A.1 itself says 5 doors at 98 % explode).
  const layout = boundaryPlant(5, 5);
  L.updateStation(layout, layout.stations[0].id, { ops: { trucks: { doors: 5, checkIn: 300, checkOut: 300, interArrival: { kind: 'const', mean: 600, spread: 0 }, pallets: { kind: 'const', mean: 26, spread: 0 } } } });
  const check = DOORS.doorCheck(OPS.trucksOf(layout.stations[0]));
  assert.ok(check.needed > 4.8 && check.needed < 5, `${check.needed} doors needed, 5 doors: not exceeded`);
  assert.equal(issuesOf(layout, ['doors-too-few']).length, 1, 'but the code warns at 98 % busy');
  assert.equal(DOORS.DOORS_TOO_FEW_UTILISATION, 0.95);
  // 2. Appendix B: "more doors than road cells touching the station": with no road cell at all, 2 doors would be 'more'; the code leaves it to station-no-dock
  const lonely = L.createLayout({ cols: 12, rows: 8 });
  L.addStation(lonely, { type: 'source', name: 'In', x: 2, y: 2, ops: { trucks: { doors: 2 } } });
  assert.equal(L.docksOf(lonely, lonely.stations[0].id).length, 0);
  assert.deepEqual(issuesOf(lonely, ['doors-exceed-docks']), []);
  assert.ok(validateLayout(lonely).some((i) => i.code === 'station-no-dock'));
  // 3. Appendix B states docks-share-lane for any station; the code looks at stations with trucks only (a legacy plant must get no new issue)
  const raw = clone(buildDockLab('row'));
  for (const x of raw.stations) delete x.ops;
  const legacy = L.normalizeLayout(raw);
  const goodsIn = legacy.stations.find((x) => x.type === 'source');
  assert.equal(legacy.schema, 1);
  assert.ok(VOPS.dockLanes(legacy, goodsIn).length > 0, 'six docks in a row');
  assert.deepEqual(issuesOf(legacy, ['docks-share-lane']), [], 'a legacy Goods in with the same docks is not warned about');
  L.updateStation(legacy, goodsIn.id, { ops: { trucks: { doors: 2 } } });
  assert.equal(issuesOf(legacy, ['docks-share-lane']).length, 1, 'with trucks it is');
  // 4. Appendix B: two NEIGHBOURING road cells along the edge with no road behind them. The code also demands that the road is joined between them (a link either way):
  //    two one-way stubs side by side, one pointing up and one down, are neighbours that no vehicle can pass between.
  const stubs = L.normalizeLayout(layoutFromAscii(['.AAA....', '.^v.....', '........'], { stations: { A: { type: 'source', ops: { trucks: { doors: 2 } } } }, fleets: [{ count: 1 }] }));
  const a = stubs.stations.find((x) => x.id === 'A');
  assert.deepEqual([...H.literalLaneCells(stubs, a)].sort(), ['1,1', '2,1'], 'the sentence of Appendix B selects both');
  assert.deepEqual(VOPS.dockLanes(stubs, a), [], 'the code, which joins the cells by road, does not');
  assert.ok(build('congestion-lab').stations.some((x) => VOPS.dockLanes(build('congestion-lab'), x).length > 0), 'the Packing docks of the Congestion lab lie in a row too (a workstation: not warned about)');
  assert.deepEqual(issuesOf(build('congestion-lab'), ['docks-share-lane']), []);
});

// =============================================================================================================================
// 7. The documents against the code
// =============================================================================================================================

const DESIGN = readFileSync(path.join(H.ROOT, 'docs', 'WAREHOUSE-DESIGN.md'), 'utf8');
const ARCH = readFileSync(path.join(H.ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8');

test('M1-MODEL-REV docs 1: the M1 data block of 5.3 (defaults, ranges, key order) is what the sanitizer implements; the schema table of 5.2 is the table of schema.js', () => {
  const start = DESIGN.indexOf('#### M1: trucks and doors');
  const block = DESIGN.slice(start, DESIGN.indexOf('Meaning and interplay:', start));
  const num = (re) => { const m = re.exec(block); assert.ok(m, String(re)); return Number(m[1]); };
  const defaults = OPS.defaultTrucks();
  assert.equal(num(/"doors": (\d+)/), defaults.doors);
  assert.equal(num(/"checkIn": (\d+)/), defaults.checkIn);
  assert.equal(num(/"checkOut": (\d+)/), defaults.checkOut);
  assert.match(block, /"mode": "rate"/);
  assert.deepEqual(/"interArrival": \{ "kind": "(\w+)", "mean": (\d+), "spread": ([\d.]+) \}/.exec(block).slice(1), [defaults.interArrival.kind, String(defaults.interArrival.mean), String(defaults.interArrival.spread)]);
  assert.deepEqual(/"pallets": \{ "kind": "(\w+)", "mean": (\d+), "spread": ([\d.]+) \}/.exec(block).slice(1), [defaults.pallets.kind, String(defaults.pallets.mean), String(defaults.pallets.spread)]);
  assert.equal(num(/"jitter": (\d+)/), defaults.jitter);
  assert.equal(num(/"noShow": ([\d.]+)/), defaults.noShow);
  assert.equal(num(/"maxDwell": (\d+)/), defaults.maxDwell);
  assert.equal(num(/"staging": (\d+)/), defaults.staging);
  const range = (key, re) => { const m = re.exec(block.split('\n').find((line) => line.includes(`"${key}"`)) ?? ''); assert.ok(m, key); return [Number(m[1]), Number(m[2])]; };
  assert.deepEqual(range('doors', /(\d+)\.\.(\d+)/), [...OPS.TRUCK_RANGES.doors]);
  assert.deepEqual(range('checkIn', /(\d+)\.\.(\d+)/), [...OPS.TRUCK_RANGES.checkIn]);
  assert.deepEqual(range('checkOut', /(\d+)\.\.(\d+)/), [...OPS.TRUCK_RANGES.checkOut]);
  assert.deepEqual(range('jitter', /(\d+)\.\.(\d+)/), [...OPS.TRUCK_RANGES.jitter]);
  assert.deepEqual(range('noShow', /([\d.]+)\.\.([\d.]+)/), [...OPS.TRUCK_RANGES.noShow]);
  assert.deepEqual(range('maxDwell', /(\d+)\.\.(\d+)/), [...OPS.TRUCK_RANGES.maxDwell]);
  assert.deepEqual(range('staging', /(\d+)\.\.(\d+)/), [...OPS.TRUCK_RANGES.staging]);
  assert.match(block, /<= 500 rows/);
  assert.equal(OPS.MAX_SCHEDULE_ROWS, 500);
  assert.match(DESIGN, /`interArrival\.mean` is clamped to 60\.\.1,000,000 s/);
  assert.deepEqual([...OPS.TRUCK_RANGES.interArrivalMean], [60, 1000000]);
  assert.match(block, /"calendar": \{ "startTod": 0, "startDay": 0 \}\s+\/\/ int 0\.\.86399; int 0\.\.6/);
  assert.deepEqual(Object.keys(defaults), [...H.TRUCK_KEY_ORDER], 'the order of the document');
  // 5.2: the table of schemas and the keys each adds
  const table = DESIGN.slice(DESIGN.indexOf('| Schema | Introduced by |'), DESIGN.indexOf('Implementation (new file `js/model/schema.js`'));
  for (const row of SC.SCHEMA_ROWS.slice(1)) assert.ok(new RegExp(`\\| ${row.schema} \\| ${row.milestone} \\|`).test(table), `row ${row.schema} ${row.milestone}`);
  assert.match(table, /\| 2 \| M1 \| `station\.ops\.trucks` \(Goods in, Goods out\); `layout\.calendar` with `startTod` and `startDay` only \|/);
});

test('M1-MODEL-REV docs 2: Appendix B lists exactly the four codes of M1 with the severity and the Fix the code has; ARCHITECTURE 4.10 states the ranges the code has', () => {
  const rows = [...DESIGN.matchAll(/^\| `([a-z-]+)` \((\w+)[^)]*\) \| (\d) \| (.+?) \| (.+?) \|$/gm)].map((m) => ({ code: m[1], severity: m[2], milestone: m[3], fires: m[4], fix: m[5] }));
  const m1 = rows.filter((r) => r.milestone === '1');
  assert.deepEqual(m1.map((r) => r.code), OWN_CODES.slice().sort((a, b) => OWN_CODES.indexOf(a) - OWN_CODES.indexOf(b)));
  const plant = boundaryPlant(2, 5);
  L.updateStation(plant, plant.stations[0].id, { ops: { trucks: { mode: 'schedule', schedule: [] } } });
  const row = L.addStation(plant, { type: 'source', name: 'Row', x: 14, y: 0, w: 4, h: 1, ops: { trucks: { doors: 1 } } });
  L.paintRoadPath(plant, [[14, 1], [17, 1]]);
  const wide = L.addStation(plant, { type: 'sink', name: 'Heavy', x: 12, y: 8, w: 2, h: 1, ops: { trucks: { doors: 1, interArrival: { mean: 60 }, pallets: { mean: 40 } } } });
  L.paintRoadPath(plant, [[12, 7], [13, 7]]);
  const issues = issuesOf(plant);
  for (const code of OWN_CODES) assert.ok(issues.some((i) => i.code === code), `${code} fires on the probe plant (${issues.map((i) => i.code)})`);
  assert.ok(row && wide);
  for (const r of m1) {
    assert.ok(issues.filter((i) => i.code === r.code).every((i) => i.severity === r.severity), `${r.code}: the document says ${r.severity}`);
    const fix = VOPS.opsFixFor(plant, issues.find((i) => i.code === r.code));
    assert.ok(fix, r.code);
    const wanted = { 'doors-too-few': /Use N doors/, 'doors-exceed-docks': /Extend the road/, 'docks-share-lane': /Show docks/, 'timetable-empty': /Add a row/ }[r.code];
    assert.match(r.fix, wanted, r.code);
    assert.match(fix.label, { 'doors-too-few': /^Use \d+ doors$/, 'doors-exceed-docks': /^Extend the road$/, 'docks-share-lane': /^Show docks$/, 'timetable-empty': /^Add a row$/ }[r.code]);
  }
  assert.equal(VOPS.OPS_CHECKS.length, 4);
  // the table of ARCHITECTURE 4.10: ranges
  const t = ARCH.slice(ARCH.indexOf('### 4.10'), ARCH.indexOf('`layout.calendar = { startTod, startDay }`'));
  assert.match(t, /\| `doors` \| int 1\.\.32, 2 \|/);
  assert.match(t, /\| `checkIn`, `checkOut` \| whole s 0\.\.7200, 300 \|/);
  assert.match(t, /Dist, mean 60\.\.1,000,000 s, `\{ normal, 2700, 0\.3 \}`/);
  assert.match(t, /Dist, mean 1\.\.200, `\{ uniform, 24, 0\.25 \}`/);
  assert.match(t, /\| `jitter` \| whole s 0\.\.7200, 0 \|/);
  assert.match(t, /\| `noShow` \| 0\.\.0\.5 \(4 decimals\), 0 \|/);
  assert.match(t, /\| `maxDwell`, `staging` \| whole s 0\.\.86400, 3600; int 0\.\.50, 4 \|/);
});

test('M1-MODEL-REV docs 3: the copy of 7.6 (toast 1, docks in a row) is the text of the document word for word; the door-check sentence has the parts of the document', () => {
  const quoted = (re) => { const m = re.exec(DESIGN); assert.ok(m, String(re)); return m[1]; };
  // copy 1: Starter becomes 24 pallets every 72 minutes, the same 20 an hour
  const starter = build('starter').stations.find((s) => s.type === 'source');
  const trucks = DOORS.convertToDoors(starter);
  const toast = DOORS.dockDoorsToast({ name: 'Goods receiving', trucks, before: DOORS.legacyPalletsPerHour(starter.params) });
  assert.equal(toast, quoted(/Example: "(Goods receiving now receives trucks:[^"]+)"/));
  // copy 3: docks in a row (message and hint together)
  const row = buildDockLab('row');
  const issue = issuesOf(row, ['docks-share-lane'])[0];
  const name = row.stations.find((s) => s.id === issue.refs.stationId).name;
  const doc3 = quoted(/\| 3 \| Docks in a row[^|]+\| "([^"]+)" \|/).replace('{name}', `“${name}”`);
  assert.equal(`${issue.message} ${issue.hint}`, doc3);
  // copy 2: the parts the document names, for the Appendix A plant with 4 doors
  const check = DOORS.doorCheck(OPS.sanitizeOps('source', { trucks: { doors: 4, interArrival: { kind: 'const', mean: 600, spread: 0 }, pallets: { kind: 'const', mean: 26, spread: 0 } } }).trucks);
  const doc2 = quoted(/\| 2 \| Door check[^|]+\| "([^"]+)" Example:/);
  const fill = doc2.replace('{need}', check.parts.need).replace('{trucks}', check.parts.trucks).replace('{minutes}', check.parts.minutes).replace('{doors}', `${check.parts.doors} doors`).replace('{better}', check.parts.better).replace('{util}', check.parts.util).replace('{tPallet}', check.parts.tPallet);
  assert.equal(check.text, fill);
  assert.equal(check.parts.need, '4.9');
  assert.equal(check.action.label, 'Use 6 doors');
});

// =============================================================================================================================
// 1 (continued). The file, the link and the autosave: hostile wrappers; the tables that drive the round-trip tests are complete
// =============================================================================================================================

const FRIENDLY = /^(This file|This share link|A project needs|There is nothing|Expected the text)/;

test('M1-MODEL-REV hostile 11: junk in every wrapper of a project (schema, name, active, scenarios, ids, names): importProject, loadProject and the autosave answer with a project or a friendly Error, never a crash', () => {
  const rich = H.richProject();
  const wrapper = H.pathsOf(rich, 3).filter((trail) => !(trail[0] === 'scenarios' && trail.length > 2 && trail[2] === 'layout' && trail.length > 3));
  const junk = H.HEAVY ? [null, NaN, -1, 0, 1.5, 1e308, '', 'x', '3', true, [], [1], {}, { layout: 5 }, { layout: [] }, '__proto__'] : [null, 'x', [], { layout: 5 }, '__proto__'];
  let projects = 0;
  let errors = 0;
  for (const trail of wrapper) {
    for (const value of junk) {
      const doc = H.withValue(rich, trail, value);
      const text = JSON.stringify(doc);
      let imported = null;
      try { imported = S.importProject(text); } catch (err) {
        errors++;
        assert.ok(err instanceof Error && FRIENDLY.test(err.message), `${trail.join('.')} = ${JSON.stringify(value)}: ${err && err.message}`);
      }
      const storage = memoryStorage();
      storage.setItem('logiplan:v1', text);
      const store = createStore({ storage, ...noTimers });
      const restored = store.restore();
      assert.equal(restored, imported !== null, `restore agrees with importProject for ${trail.join('.')} = ${JSON.stringify(value)}`);
      if (imported === null) { assert.ok(store.lastRestoreError instanceof Error); continue; }
      projects++;
      assert.ok(imported.scenarios.length >= 1 && imported.scenarios.length <= 100);
      assert.ok(imported.scenarios.some((s) => s.id === imported.activeId), 'activeId is one of the scenarios');
      assert.equal(new Set(imported.scenarios.map((s) => s.id)).size, imported.scenarios.length, 'unique scenario ids');
      for (const sc of imported.scenarios) assert.deepEqual(L.checkInvariants(sc.layout), [], sc.id);
      assert.deepEqual(imported.warnings === undefined || (Array.isArray(imported.warnings) && imported.warnings.every((w) => typeof w === 'string')), true);
      assert.deepEqual(store.getState().project.scenarios.map((s) => s.layout), store.getState().project.scenarios.map((s) => L.normalizeLayout(s.layout)));
    }
  }
  assert.ok(projects > 40 && errors > 3, `${projects} projects, ${errors} refusals`);
  // not JSON, not a project, wrong types of the text itself
  for (const text of ['', '   ', 'null', '[]', '{}', '"x"', '123', '{"scenarios":5}', '{"scenarios":[]}', '{"scenarios":[null,5,"x"]}', '[[[[', '{"a":', '﻿{"grid":{}}x']) {
    try { S.importProject(text); } catch (err) { assert.ok(FRIENDLY.test(err.message), `${JSON.stringify(text)}: ${err.message}`); }
  }
  for (const text of [undefined, null, 5, {}, []]) assert.throws(() => S.importProject(text), /Expected the text/);
  assert.equal(S.importProject('﻿{"grid":{}}').scenarios.length, 1, 'a bare layout behind a BOM');
  assert.throws(() => S.exportProject({ name: 'x', scenarios: [] }), /nothing to export/);
});

test('M1-MODEL-REV hostile 12: a share link that is cut, garbled, compressed from something else, wrapped by a chat app or padded is refused with the one friendly message; a good link survives wrapping', async () => {
  const link = await S.encodeShare(H.richProject());
  const good = await S.decodeShare(link);
  assert.equal(good.scenarios.length, 2);
  for (const wrapped of [`#p=${link}`, `p=${link}`, `  ${link}\n`, `https://logiplan.example/app/#p=${link}.`, `(${link})`, `[${link}]`, `'${link}'`, `"${link}",`, `${link}).`, `${link.slice(0, 40)}\n${link.slice(40)}`, `<https://x.example/#p=${link}>`]) {
    assert.equal((await S.decodeShare(wrapped)).scenarios.length, 2, wrapped.slice(0, 30));
  }
  const friendly = (err) => /^This share link is damaged or from a newer version\.$/.test(err.message);
  for (const bad of ['', 'z.', 'p.', 'x.abc', 'z.!!!!', 'p.%%%%', 'z.A', 'z.AAAA', 'p.AAAA', `${link.slice(0, 30)}`, `${link.slice(0, -7)}`, `${link}${link}`, `z.${link.slice(2).replace(/[A-Za-z]/, '*')}`, 'z.' + 'A'.repeat(100), 'p.' + Buffer.from('{"scenarios":[1]}').toString('base64url'), 'p.' + Buffer.from('null').toString('base64url'), 'p.' + Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url')]) {
    await assert.rejects(S.decodeShare(bad), friendly, JSON.stringify(bad.slice(0, 30)));
  }
  for (const junk of [undefined, null, 5, {}, []]) await assert.rejects(S.decodeShare(junk), friendly);
  // the plain form is the same project
  const plain = `p.${Buffer.from(S.exportProject(H.richProject())).toString('base64url')}`;
  assert.equal(bytes((await S.decodeShare(plain)).scenarios.map((s) => s.layout)), bytes(good.scenarios.map((s) => s.layout)));
});

heavy('M1-MODEL-REV hostile 13 (heavy): a compressed link that inflates to 70 MB is refused quickly and without memory blow-up', async () => {
  const cs = new CompressionStream('deflate-raw');
  const writer = cs.writable.getWriter();
  writer.write(new Uint8Array(70 * 1024 * 1024)).then(() => writer.close());
  const chunks = [];
  const reader = cs.readable.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
  const bomb = `z.${Buffer.concat(chunks).toString('base64url')}`;
  const t0 = cpu();
  await assert.rejects(S.decodeShare(bomb), /damaged/);
  assert.ok(cpu() - t0 < 4000);
  assert.ok(process.memoryUsage().rss < 1.5e9);
});

test('M1-MODEL-REV docs 4: the tables OPS_KEYS and CALENDAR_KEYS list every key the sanitizers can emit (a key missing there would escape the round-trip tests) and the row of each', () => {
  const paths = (value, prefix) => {
    const out = [];
    for (const [key, v] of Object.entries(value)) {
      const here = prefix ? `${prefix}.${key}` : key;
      out.push(here);
      if (isObj(v)) out.push(...paths(v, here));
    }
    return out;
  };
  const emitted = new Set(paths({ trucks: OPS.defaultTrucks() }, ''));
  const sanitized = new Set(paths(OPS.sanitizeOps('source', { trucks: H.fullTrucks() }), ''));
  assert.deepEqual([...sanitized].sort(), [...emitted].sort(), 'defaults and a full block have the same keys');
  const listed = new Set(OPS.OPS_KEYS.map((e) => e.key));
  assert.deepEqual([...emitted].filter((k) => !listed.has(k)), [], 'a key the sanitizer emits is not in OPS_KEYS');
  assert.deepEqual([...listed].filter((k) => !emitted.has(k)), [], 'OPS_KEYS lists a key the sanitizer does not emit');
  assert.equal(listed.size, OPS.OPS_KEYS.length, 'no key twice');
  for (const entry of OPS.OPS_KEYS) {
    assert.equal(entry.schema, 2, entry.key);
    assert.deepEqual([...entry.types], ['source', 'sink'], entry.key);
    const raw = (v) => ({ trucks: entry.key === 'trucks' ? v : entry.key.split('.').slice(1).reduceRight((acc, k) => ({ [k]: acc }), v) });
    const layout = schemaBase();
    layout.stations[0].ops = raw(entry.sample);
    assert.equal(H.schemaOracle(layout), entry.schema, `${entry.key}: the row in the table is the row of 5.2`);
  }
  const clockKeys = Object.keys(CAL.sanitizeCalendar({}, { stations: [] }));
  assert.deepEqual(CAL.CALENDAR_KEYS.map((e) => e.key), clockKeys);
  for (const entry of CAL.CALENDAR_KEYS) assert.equal(entry.schema, 2);
});

test('DISCREPANCY docs: 5.3 says the clock is present once a station uses "schedule"; the code (and ARCHITECTURE 4.10) keep it after the last timetable goes, and ARCHITECTURE 4.10 and 6.10 disagree on what a day plant is', () => {
  // 5.3: "present once any truck station uses schedule" and "the sanitizer creates calendar ... if missing". The code creates it AND keeps it.
  const layout = L.createLayout({ cols: 12, rows: 8 });
  const s = L.addStation(layout, { type: 'source', x: 1, y: 1, ops: { trucks: { mode: 'schedule' } } });
  L.updateCalendar(layout, { startTod: 21600, startDay: 2 });
  L.updateStation(layout, s.id, { ops: { trucks: { mode: 'rate' } } });
  assert.deepEqual(layout.calendar, { startTod: 21600, startDay: 2 }, 'the clock stays when the last timetable goes');
  assert.equal(CAL.usesTimetable(layout), false);
  assert.equal(layout.schema, 2);
  L.updateCalendar(layout, null);
  assert.equal(layout.calendar, undefined, 'and goes when it is removed on purpose');
  assert.equal(layout.schema, 2, 'the trucks block keeps the schema at 2');
  L.updateStation(layout, s.id, { ops: { trucks: null } });
  assert.equal(layout.schema, 1, 'a plant without any trucks and without a clock is v1 again');
  // ARCHITECTURE 4.10 says so; WAREHOUSE-DESIGN 5.3 ("present once any truck station uses schedule") does not
  assert.match(ARCH, /nothing removes it by itself/);
  assert.match(DESIGN, /present once any truck station uses "schedule"/);
});
