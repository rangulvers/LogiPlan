// Helpers of tests/m1.model.review.test.js: the adversarial review of the MODEL and DATA layer of milestone M1 of the warehouse module
// (trucks and dock doors: docs/WAREHOUSE-DESIGN.md 5.1 to 5.3, 6.2, 6.3, 7.2, Appendices A and B).
//
// Everything here is an ORACLE or a GENERATOR written from the documents, not from the code under test:
//   * layering         the import graph of js/ read from the source text, the rules of docs/ARCHITECTURE.md section 3, cycles by Tarjan
//   * hostile input    a rich valid project and the enumeration of every path of it, so that a junk value can be put at EACH place
//   * schema oracle    the table of 5.2 as data, applied to a raw layout by its own traversal (not schema.js)
//   * paste            a reference parser written from 7.2 only, and a generator of spreadsheet text with a known meaning
//   * lanes            the literal rule of Appendix B for docks-share-lane
//   * queues           a brute-force FIFO multi-door queue (what the door check of 6.3.4 predicts)
//   * schedules        a per-second scan of the clock (what expandScheduleDay must produce)
//   * store drive      random sessions through the REAL store that check, after every step, that the layout is valid and equals
//                      normalizeLayout(layout) byte for byte
//
// Nothing here is imported by production code.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as L from '../../js/model/layout.js';
import { createRng, sampleDist } from '../../js/util/rng.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Run the expensive sizes (more documents, longer sessions): M1_MODEL_REVIEW_HEAVY=1. */
export const HEAVY = process.env.M1_MODEL_REVIEW_HEAVY === '1';
/** Known defects are `todo` tests (they fail, the suite stays green); M1_MODEL_REVIEW_STRICT=1 makes them ordinary tests. */
export const STRICT = process.env.M1_MODEL_REVIEW_STRICT === '1';
/** Scale a count by the mode: the fast tier must stay below 10 s of CPU. */
export const size = (fast, heavy) => (HEAVY ? heavy : fast);

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const bytes = (v) => JSON.stringify(v);
export const clone = (v) => structuredClone(v);

// ---------------------------------------------------------------------------------------------------------
// Layering (docs/ARCHITECTURE.md section 3)
// ---------------------------------------------------------------------------------------------------------

/** Every js/**.js file with the files it imports (static imports, re-exports and import()), as paths relative to the repository root. */
export function importGraph() {
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.js')) files.push(p);
    }
  })(path.join(ROOT, 'js'));
  const graph = new Map();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const specs = [
      ...[...source.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1]),
      ...[...source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
    ].filter((spec) => spec.startsWith('.'));
    graph.set(path.relative(ROOT, file), specs.map((spec) => path.relative(ROOT, path.resolve(path.dirname(file), spec))));
  }
  return graph;
}

/** The pure model modules of the optional features and what each may import (ARCHITECTURE 3: util, defaults.js and each other, never layout.js). */
export const PURE_MODEL = Object.freeze(['js/model/schema.js', 'js/model/ops.js', 'js/model/calendar.js', 'js/model/extensions.js', 'js/model/doors.js']);
/** The edges ARCHITECTURE 3 lists by name for them. */
export const LISTED_EDGES = Object.freeze({
  'js/model/schema.js': ['js/model/defaults.js'],
  'js/model/ops.js': ['js/util/', 'js/model/defaults.js'],
  'js/model/calendar.js': ['js/model/ops.js'],
  'js/model/extensions.js': ['js/model/calendar.js', 'js/model/schema.js'],
  'js/model/doors.js': ['js/util/', 'js/model/ops.js'],
});
const layerOf = (file) => {
  const m = /^js\/(util|model|sim|store|ui)\//.exec(file);
  return m ? m[1] : file === 'js/main.js' ? 'main' : 'other';
};

/**
 * The rule of ARCHITECTURE 3 for one import edge: a reason when the edge is NOT allowed, else null.
 *   util imports nothing; model imports only util; the pure model modules import util, defaults.js and each other (never layout.js);
 *   the one model module that may import layout.js besides the loaders is validate-ops.js; sim imports util and the model modules that are pure
 *   (defaults, schema, ops, calendar, extensions, doors) or layout.js, never validate, serialize, examples, validate-ops; sim never imports ui or store;
 *   store imports model and util only; ui may import everything below it but never main.js.
 */
export function forbiddenEdge(from, to) {
  const a = layerOf(from);
  const b = layerOf(to);
  if (a === 'util') return b === 'util' ? null : 'util imports nothing but util';
  if (a === 'model') {
    if (b !== 'util' && b !== 'model') return 'model imports only util';
    if (PURE_MODEL.includes(from)) {
      if (b === 'model' && to !== 'js/model/defaults.js' && !PURE_MODEL.includes(to)) return 'a pure model module imports only util, defaults.js and the other pure modules (never layout.js)';
    }
    return null;
  }
  if (a === 'sim') {
    if (b === 'ui' || b === 'store' || b === 'main') return 'sim never imports ui, store or main';
    if (b === 'model') {
      const pureOrLayout = to === 'js/model/defaults.js' || to === 'js/model/layout.js' || PURE_MODEL.includes(to);
      if (!pureOrLayout) return 'sim imports util, defaults.js, layout.js and the pure model modules only';
    }
    return null;
  }
  if (a === 'store') return b === 'util' || b === 'model' ? null : 'store imports model and util only';
  if (a === 'ui') return b === 'main' ? 'ui never imports main.js' : null;
  return null;
}

/** Strongly connected components of more than one file (import cycles), by Tarjan. */
export function importCycles(graph) {
  let counter = 0;
  const stack = [];
  const onStack = new Set();
  const index = new Map();
  const low = new Map();
  const found = [];
  const visit = (v) => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!graph.has(w)) continue;
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const component = [];
      let w;
      do {
        w = stack.pop();
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1 || (graph.get(v) ?? []).includes(v)) found.push(component.sort());
    }
  };
  for (const v of graph.keys()) if (!index.has(v)) visit(v);
  return found;
}

// ---------------------------------------------------------------------------------------------------------
// Hostile input
// ---------------------------------------------------------------------------------------------------------

/** One of everything a hand-edited or damaged file can hold where a number, a string, a list or an object is expected. */
export const JUNK = Object.freeze([
  null, true, false, 0, -0, 1, -1, 0.5, 1e308, -1e308, 5e-324, NaN, Infinity, -Infinity, 2 ** 53, -(2 ** 53), 4294967296, 86400, 86399.9999, -0.4,
  '', ' ', 'x', '12', ' 12 ', '1e3', '0x10', '0b11', '06:00', '24:00', '25:70', '6:5', 'Infinity', '-Infinity', 'NaN', '\u0000', '\ud800', '１２', '٣',
  '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty',
  [], [1, 2, 3], [null], [[]], [{}], ['x'], {}, { a: 1 }, { at: 3600 }, { at: 'x', pallets: [] }, { kind: 'zzz', mean: 'x', spread: {} }, { __proto__: { evil: 1 } },
]);

/** Every path (array of keys) to a value inside `root`, objects and arrays included, down to `depth`. */
export function pathsOf(root, depth = 7) {
  const out = [];
  const walk = (value, trail) => {
    if (trail.length > 0) out.push(trail);
    if (trail.length >= depth || value === null || typeof value !== 'object') return;
    for (const key of Object.keys(value)) walk(value[key], [...trail, Array.isArray(value) ? Number(key) : key]);
  };
  walk(root, []);
  return out;
}

/** A copy of `root` with the value at `trail` replaced by `value` (undefined: the key is deleted). */
export function withValue(root, trail, value) {
  const copy = clone(root);
  let at = copy;
  for (let i = 0; i < trail.length - 1; i++) at = at[trail[i]];
  const key = trail[trail.length - 1];
  if (value === undefined) {
    if (Array.isArray(at)) at.splice(key, 1);
    else delete at[key];
  } else at[key] = value;
  return copy;
}

/** The ops/truck keys of docs/WAREHOUSE-DESIGN.md 5.3, in the order of the document. */
export const TRUCK_KEY_ORDER = Object.freeze(['doors', 'checkIn', 'checkOut', 'mode', 'interArrival', 'pallets', 'schedule', 'jitter', 'noShow', 'maxDwell', 'staging']);

/** A valid truck block that differs from the defaults in every field, built by hand from 5.3. */
export function fullTrucks(over = {}) {
  return {
    doors: 5, checkIn: 600, checkOut: 120, mode: 'schedule',
    interArrival: { kind: 'exp', mean: 1800, spread: 0.5 }, pallets: { kind: 'normal', mean: 18, spread: 0.4 },
    schedule: [{ at: 21600, pallets: 24 }, { at: 25200, pallets: null }, { at: 36000, pallets: 12 }, { at: 36000, pallets: 7 }],
    jitter: 600, noShow: 0.1, maxDwell: 5400, staging: 8, ...over,
  };
}

/**
 * A rich document of the file format: a project with two scenarios, in which every kind of station, fleet and flow exists and the warehouse module
 * is used (trucks on Goods in and Goods out, a clock), plus the junk a future or damaged file may hold in places the module does not own.
 */
export function richProject() {
  const layout = L.createLayout({ name: 'Rich', cols: 40, rows: 24, cellSize: 2 });
  L.paintRoadPath(layout, [[2, 10], [36, 10]]);
  const a = L.addStation(layout, { type: 'source', name: 'Goods in', x: 4, y: 7, w: 3, h: 3, ops: { trucks: fullTrucks() } });
  const b = L.addStation(layout, { type: 'source', name: 'Rate in', x: 10, y: 7, w: 3, h: 3, ops: { trucks: fullTrucks({ mode: 'rate', schedule: [] }) } });
  const p = L.addStation(layout, { type: 'process', name: 'Work', x: 16, y: 7, w: 3, h: 3 });
  const s = L.addStation(layout, { type: 'storage', name: 'Store', x: 22, y: 7, w: 3, h: 3 });
  const k = L.addStation(layout, { type: 'sink', name: 'Goods out', x: 28, y: 7, w: 3, h: 3, ops: { trucks: fullTrucks({ mode: 'rate', schedule: [] }) } });
  const d = L.addStation(layout, { type: 'depot', name: 'Park', x: 2, y: 12, w: 3, h: 2 });
  L.addFlow(layout, a.id, p.id);
  L.addFlow(layout, b.id, s.id);
  L.addFlow(layout, p.id, s.id);
  L.addFlow(layout, s.id, k.id);
  L.addFleet(layout, 'forklift', { count: 3, home: d.id });
  L.updateCalendar(layout, { startTod: 21600, startDay: 3 });
  const raw = clone(layout);
  // what a damaged or newer file may hold where the module has no key (all of it must be dropped)
  raw.stations[2].ops = { trucks: fullTrucks(), rack: { levels: 5 } };
  raw.stations[3].ops = { putaway: 'random' };
  raw.stations[5].ops = { calendar: { staffing: [] } };
  raw.fleets[0].calendar = { staffing: [{ shift: 'a', count: 1 }] };
  raw.fleets[0].ops = { trucks: fullTrucks() };
  raw.flows[0].types = ['fast'];
  raw.loadTypes = [{ id: 'fast' }];
  raw.ops = { trucks: fullTrucks() };
  return { app: 'logiplan', schema: 2, name: 'Rich', active: 0, scenarios: [{ id: 'sc1', name: 'A', layout: raw }, { id: 'sc2', name: 'B', layout: clone(layout) }] };
}

/** Totality, idempotence and validity of one hostile layout: returns a list of what is wrong (empty = fine). `quick` skips the round trip through JSON text. */
export function wrongWithNormalize(raw, quick = false) {
  const wrong = [];
  let once;
  try {
    once = L.normalizeLayout(raw);
  } catch (err) {
    return [`normalizeLayout threw: ${err && err.message}`];
  }
  const text = bytes(once);
  try {
    if (bytes(L.normalizeLayout(once)) !== text) wrong.push('not idempotent');
    if (!quick && bytes(L.normalizeLayout(JSON.parse(text))) !== text) wrong.push('a round trip through JSON changes it');
  } catch (err) {
    wrong.push(`normalizing a normalized layout threw: ${err && err.message}`);
  }
  const bad = L.checkInvariants(once);
  if (bad.length) wrong.push(`checkInvariants: ${bad[0]}`);
  for (const s of once.stations) {
    if (s.ops !== undefined) {
      if (s.type !== 'source' && s.type !== 'sink') wrong.push(`ops kept on a ${s.type}`);
      else if (Object.keys(s.ops.trucks).join() !== TRUCK_KEY_ORDER.join()) wrong.push(`ops.trucks keys: ${Object.keys(s.ops.trucks).join()}`);
      else if (Object.keys(s.ops).join() !== 'trucks') wrong.push(`ops keys: ${Object.keys(s.ops).join()}`);
    }
  }
  for (const f of once.fleets) if (Object.keys(f).some((key) => ['ops', 'calendar', 'trucks', 'aisleMin', 'liftHeight'].includes(key))) wrong.push('a fleet kept a key of the warehouse module');
  for (const f of once.flows) if ('types' in f) wrong.push('a flow kept "types"');
  for (const key of Object.keys(once)) if (!['schema', 'name', 'notes', 'grid', 'roads', 'obstacles', 'labels', 'stations', 'flows', 'fleets', 'settings', 'calendar'].includes(key)) wrong.push(`layout key ${key}`);
  if (({}).doors !== undefined || ({}).trucks !== undefined || ({}).evil !== undefined || ({}).at !== undefined) wrong.push('Object.prototype was polluted');
  return wrong;
}

// ---------------------------------------------------------------------------------------------------------
// Schema oracle (docs/WAREHOUSE-DESIGN.md 5.2), written from the table, not from schema.js
// ---------------------------------------------------------------------------------------------------------

/**
 * The highest schema row that a RAW layout uses, by the table of 5.2:
 *   2  station.ops.trucks; layout.calendar
 *   3  calendar.shifts, calendar.profiles; station.ops.calendar; fleet.calendar; ops.trucks.schedule[].days
 *   4  station.ops.form, rack, block, putaway; fleet.aisleMin, fleet.liftHeight
 *   5  ops.putaway = nearest-free; ops.trucks.depart, releaseLead, grace; schedule[].depart
 *   6  layout.loadTypes; flow.types; ops.mix, accepts, outType; ops.trucks.mix; schedule[].mix
 *   7  station.ops.pick
 * A key counts when it is present (an own property whose value is not undefined).
 */
export function schemaOracle(layout) {
  const has = (o, k) => o !== null && typeof o === 'object' && !Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
  const list = (v) => (Array.isArray(v) ? v : []);
  let need = 1;
  const row = (n, yes) => { if (yes && n > need) need = n; };
  if (layout === null || typeof layout !== 'object' || Array.isArray(layout)) return 1;
  row(2, has(layout, 'calendar'));
  row(3, has(layout.calendar, 'shifts') || has(layout.calendar, 'profiles'));
  row(6, has(layout, 'loadTypes'));
  for (const f of list(layout.fleets)) {
    row(3, has(f, 'calendar'));
    row(4, has(f, 'aisleMin') || has(f, 'liftHeight'));
  }
  for (const f of list(layout.flows)) row(6, has(f, 'types'));
  for (const s of list(layout.stations)) {
    if (!has(s, 'ops')) continue;
    const o = s.ops;
    if (o === null || typeof o !== 'object' || Array.isArray(o)) continue;
    row(2, has(o, 'trucks'));
    row(3, has(o, 'calendar'));
    row(4, ['form', 'rack', 'block', 'putaway'].some((k) => has(o, k)));
    row(5, o.putaway === 'nearest-free');
    row(6, ['mix', 'accepts', 'outType'].some((k) => has(o, k)));
    row(7, has(o, 'pick'));
    const t = o.trucks;
    row(5, ['depart', 'releaseLead', 'grace'].some((k) => has(t, k)));
    row(6, has(t, 'mix'));
    for (const r of list(t && t.schedule)) {
      row(3, has(r, 'days'));
      row(5, has(r, 'depart'));
      row(6, has(r, 'mix'));
    }
  }
  return need;
}

// ---------------------------------------------------------------------------------------------------------
// Pasting a timetable (docs/WAREHOUSE-DESIGN.md 7.2): a reference parser and a generator with a known meaning
// ---------------------------------------------------------------------------------------------------------

/**
 * A reference reading of pasted text, from 7.2 and nothing else. Lines end with \n, \r\n or \r; a BOM at the start is ignored; empty lines are
 * ignored (line numbers count them); the first non-empty line without a digit is a header; the separator is a tab if any data line has one, else a
 * semicolon if any has, else a comma when every data line has exactly two comma-separated fields and is not itself a decimal number, else there is one
 * column; fields are trimmed and double quotes removed. Time (7.2 as amended after the review): H:MM, HH:MM, H:MM:00 and HH:MM:00 (seconds only when zero),
 * HH.MM (two digits before and after the point), HHMM, hours 0..23, minutes 0..59, a trailing "h" or "Uhr" (any case) ignored; H.MM (one digit before the
 * point) only with that suffix; 12-hour times with a colon and AM/PM (also a.m., any case, a space allowed), hours 1..12, 12 AM is midnight.
 * Pallets: an integer 1..200, "24,0" and "24.0" (also two zeros) accepted, empty = null.
 * More than two columns, or a bad field, make the row a bad row. Returns { rows: [{ line, at, pallets }], bad: [{ line, why }], header }.
 */
/** A time field by 7.2 (see pasteOracle): seconds after midnight, or null. Written from the sentence, not from parseTimeField. */
function oracleTime(field) {
  const f = field.trim();
  const twelve = /^(.*?)\s*([ap])\.?\s*m\.?$/i.exec(f);
  if (twelve) {
    const m = /^(\d{1,2}):(\d\d)(?::00)?$/.exec(twelve[1].trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 1 || h > 12 || min > 59) return null;
    return ((h % 12) + (twelve[2].toLowerCase() === 'p' ? 12 : 0)) * 3600 + min * 60;
  }
  const suffix = /\s*(uhr|h)$/i.test(f);
  const tf = f.replace(/\s*(uhr|h)$/i, '').trim();
  const m = /^(\d{1,2}):(\d\d)(?::00)?$/.exec(tf) || /^(\d\d)\.(\d\d)$/.exec(tf) || (suffix ? /^(\d)\.(\d\d)$/.exec(tf) : null) || /^(\d\d)(\d\d)$/.exec(tf);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60;
}

export function pasteOracle(text) {
  const out = { rows: [], bad: [], header: false };
  if (typeof text !== 'string') return out;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = [];
  source.split(/\r\n|\r|\n/).forEach((t, i) => { const trimmed = t.trim(); if (trimmed !== '') lines.push({ n: i + 1, t: trimmed }); });
  if (!lines.length) return out;
  let data = lines;
  if (!/[0-9]/.test(lines[0].t)) { out.header = true; data = lines.slice(1); }
  const split = (t, sep) => {
    const fields = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (c === '"') { if (quoted && t[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted; } else if (c === sep && !quoted) { fields.push(cur.trim()); cur = ''; } else cur += c;
    }
    fields.push(cur.trim());
    return fields;
  };
  const trimmedColumns = (f) => { const g = f.slice(); while (g.length > 2 && g[g.length - 1] === '') g.pop(); return g; };
  let sep = null;
  if (data.some((l) => trimmedColumns(split(l.t, '\t')).length > 1)) sep = '\t';
  else if (data.some((l) => trimmedColumns(split(l.t, ';')).length > 1)) sep = ';';
  else if (data.length && data.every((l) => split(l.t, ',').length === 2 && !/^\d+,\d+$/.test(l.t.replace(/"/g, '').trim()))) sep = ',';
  for (const l of data) {
    const fields = sep ? trimmedColumns(split(l.t, sep)) : [l.t.replace(/"/g, '').trim()];
    if (fields.length > 2) { out.bad.push({ line: l.n, why: 'columns' }); continue; }
    const at = oracleTime(fields[0]);
    if (at === null) { out.bad.push({ line: l.n, why: 'time' }); continue; }
    let pallets = null;
    if (fields.length === 2 && fields[1] !== '') {
      const p = /^\+?(\d+)(?:[.,]0{1,2})?$/.exec(fields[1]);
      const v = p ? Number(p[1]) : NaN;
      if (!(v >= 1 && v <= 200)) { out.bad.push({ line: l.n, why: 'pallets' }); continue; }
      pallets = v;
    }
    out.rows.push({ line: l.n, at, pallets });
  }
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');

/** Spreadsheet text for a time of day in one of the notations of 7.2 as amended (seconds that are zero, 12-hour times, "6.30 Uhr"). */
export function timeText(seconds, style) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  switch (style) {
    case 0: return `${h}:${pad2(m)}`;
    case 1: return `${pad2(h)}:${pad2(m)}`;
    case 2: return `${pad2(h)}.${pad2(m)}`;
    case 3: return `${pad2(h)}${pad2(m)}`;
    case 4: return `${h}:${pad2(m)} Uhr`;
    case 5: return `${pad2(h)}:${pad2(m)}h`;
    case 6: return `${pad2(h)}:${pad2(m)} UHR`;
    case 7: return `${h}:${pad2(m)}:00`;
    case 8: return `${pad2(h)}:${pad2(m)}:00`;
    case 9: {
      const meridiem = [['AM', 'PM'], ['am', 'pm'], ['a.m.', 'p.m.']][m % 3][h < 12 ? 0 : 1];
      return `${((h + 11) % 12) + 1}:${pad2(m)} ${meridiem}`;
    }
    default: return h < 10 ? `${h}.${pad2(m)} Uhr` : `${pad2(h)}.${pad2(m)}`;
  }
}
export const TIME_STYLES = 11;
/** Fields that are not a time of day by 7.2 (each must end up as a bad row, never as a row with another meaning). */
export const BAD_TIMES = Object.freeze(['25:70', '24:00', '-1:00', '6:5', 'noon', '6', '6:00:30', '6:00:5', '1e3', '６：００', '٠٦:٠٠', '6;00', '99:99', '12:60', '6,00', '24.00', '00.60', '2400', '13:00 PM', '0:30 AM', '12:60 PM', '6 AM', '6:00 xm', '12:00 noon', '5.5', '0.25', '0.75', '6.30']);
/** Pallet fields that are not a whole number of pallets 1..200. */
export const BAD_PALLETS = Object.freeze(['abc', '0', '201', '-5', '24,5', '1e1', '24 pallets', '999999', '24,', '1.000', '1 000', '1,000', "1'000", '24.50', '٢٤']);

/**
 * Pasted text with a known meaning: `lines` rows, a separator, optional header, quotes, trailing separators, blank lines, BOM, line endings, bad rows.
 * Returns the text only; the oracle reads it back.
 */
export function pasteText(rng) {
  const pick = (list) => list[rng.int(list.length)];
  const sep = pick(['\t', ';', ',']);
  const eol = pick(['\n', '\r\n', '\r']);
  const lines = [];
  if (rng.next() < 0.4) lines.push(pick(['Arrival;Pallets', 'Time\tPallets', 'Zeit,Anzahl', 'Ankunft', 'Arrival time (h:mm);Number of pallets']).replace(/[;\t,]/, sep));
  for (let k = 0, n = rng.int(7); k < n; k++) {
    const time = rng.next() < 0.2 ? pick(BAD_TIMES) : timeText(rng.int(86400), rng.int(TIME_STYLES));
    let pallets;
    if (rng.next() < 0.2) pallets = '';
    else if (rng.next() < 0.2) pallets = pick(BAD_PALLETS);
    else {
      const p = 1 + rng.int(60);
      pallets = pick([String(p), String(p), `${p}${pick([',0', '.0', ',00', '.00'])}`]);
    }
    let line = `${time}${sep}${pallets}`;
    if (rng.next() < 0.15) line += sep;
    if (rng.next() < 0.15) line = `"${time}"${sep}"${pallets}"`;
    if (rng.next() < 0.1) line = ` ${line} `;
    if (rng.next() < 0.1) lines.push('');
    lines.push(line);
  }
  let text = lines.join(eol);
  if (rng.next() < 0.1) text = `\ufeff${text}`;
  if (rng.next() < 0.1) text += eol;
  return text;
}

// ---------------------------------------------------------------------------------------------------------
// docks-share-lane (Appendix B), literally
// ---------------------------------------------------------------------------------------------------------

/**
 * The cells that Appendix B's sentence selects (as amended after M1-MODEL-REV-3), applied literally: on each of the four sides of the station, two
 * NEIGHBOURING cells of the strip that touches it, both road cells. (The first version of the sentence added "and the cells one step away from the
 * station behind both are not road cells"; a measurement showed that a second road behind the docks does not help. validate-ops.js adds one clause:
 * the road must be joined between the two cells.) Returns a Set of "x,y".
 */
export function literalLaneCells(layout, s) {
  const road = (x, y) => Object.hasOwn(layout.roads, `${x},${y}`);
  const cells = new Set();
  const strips = [
    Array.from({ length: s.w }, (_, i) => [s.x + i, s.y - 1]),
    Array.from({ length: s.w }, (_, i) => [s.x + i, s.y + s.h]),
    Array.from({ length: s.h }, (_, j) => [s.x - 1, s.y + j]),
    Array.from({ length: s.h }, (_, j) => [s.x + s.w, s.y + j]),
  ];
  for (const strip of strips) {
    const ok = strip.map(([x, y]) => road(x, y));
    for (let i = 0; i + 1 < strip.length; i++) {
      if (ok[i] && ok[i + 1]) { cells.add(strip[i].join()); cells.add(strip[i + 1].join()); }
    }
  }
  return cells;
}

// ---------------------------------------------------------------------------------------------------------
// A brute-force queue and a brute-force clock
// ---------------------------------------------------------------------------------------------------------

/**
 * FIFO queue of trucks for `doors` doors that each hold a truck `doorSeconds`; arrivals from the gap distribution of a trucks block. What the door
 * check of 6.3.4 predicts, measured: the share of door time that is busy and the mean wait at the gate.
 */
export function queueRun(gap, doors, doorSeconds, hours, seed) {
  const rng = createRng(seed);
  const free = new Array(doors).fill(0);
  const end = hours * 3600;
  let t = 0;
  let n = 0;
  let wait = 0;
  let busy = 0;
  for (;;) {
    t += sampleDist(rng, gap);
    if (t > end) break;
    let k = 0;
    for (let i = 1; i < doors; i++) if (free[i] < free[k]) k = i;
    const start = Math.max(t, free[k]);
    wait += start - t;
    free[k] = start + doorSeconds;
    busy += doorSeconds;
    n++;
  }
  return { trucks: n, meanWait: n ? wait / n : 0, utilisation: busy / (doors * end) };
}

/** The most rows of a daily timetable in any half-open hour [a, a + 3600), the day repeating, by trying every second a of the day. */
export function bruteRowsPerHour(times) {
  let best = 0;
  for (let a = 0; a < 86400; a++) {
    let c = 0;
    for (const t of times) if ((((t - a) % 86400) + 86400) % 86400 < 3600) c++;
    if (c > best) best = c;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------
// Random sessions through the real store
// ---------------------------------------------------------------------------------------------------------

export const pick = (rng, list) => list[rng.int(list.length)];

/** Patches of `station.ops` as the panel, a sweep, a paste and a hostile file would send them. */
export const OPS_PATCHES = Object.freeze([
  { trucks: { doors: 4 } }, { trucks: { doors: 1 } }, { trucks: { mode: 'schedule' } }, { trucks: { mode: 'rate' } }, { trucks: { interArrival: { mean: 1800 } } },
  { trucks: null }, null, 'junk', {}, [], { trucks: { schedule: [] } }, { trucks: { schedule: [{ at: '06:00', pallets: 12 }, { at: 'x' }] } },
  { trucks: { mode: 'schedule', schedule: [{ at: 21600, pallets: 24 }, { at: 25200, pallets: null }] } }, { trucks: { jitter: 600, noShow: 0.1, maxDwell: 1800, staging: 8, pallets: { mean: 30 } } },
  { trucks: { doors: 99, checkIn: -5 } }, { trucks: { doors: NaN, mode: 'zzz' } }, { trucks: fullTrucks() }, { rack: { levels: 5 }, trucks: { doors: 2 } },
]);

/**
 * One random step on a store, chosen from every kind of edit the app has: the mutators of layout.js (inside store.commit), undo, redo, replace,
 * scenario switch and copy, project load, save and restore. Returns a label (for the failure message).
 */
export function randomStep(store, rng, memory) {
  const layout = store.getState().layout;
  const stations = layout.stations;
  const any = (list) => (list.length ? list[rng.int(list.length)] : undefined);
  const cell = () => [rng.int(layout.grid.cols), rng.int(layout.grid.rows)];
  const edit = (label, fn) => { try { store.commit(label, fn); } catch (err) { return `${label} THREW ${err.message}`; } return label; };
  const r = rng.int(30);
  switch (r) {
    case 0: case 1: case 2: return edit('addStation', (d) => { const [x, y] = cell(); L.addStation(d, { type: pick(rng, ['source', 'sink', 'process', 'storage', 'depot']), x, y, w: 1 + rng.int(4), h: 1 + rng.int(3), ...(rng.next() < 0.6 ? { ops: pick(rng, OPS_PATCHES) } : {}) }); });
    case 3: case 4: case 5: case 6: return edit('updateStation(ops)', (d) => { const s = any(d.stations); if (s) L.updateStation(d, s.id, { ops: pick(rng, OPS_PATCHES) }); });
    case 7: return edit('removeStation', (d) => { const s = any(d.stations); if (s) L.removeStation(d, s.id); });
    case 8: case 9: return edit('duplicateStation', (d) => { const s = any(d.stations); if (s) L.duplicateStation(d, s.id, { dx: rng.int(5) - 2, dy: rng.int(5) - 2 }); });
    case 10: return edit('resizeGrid', (d) => { L.resizeGrid(d, 8 + rng.int(50), 8 + rng.int(30)); });
    case 11: return edit('growGrid/trimGrid', (d) => { if (rng.next() < 0.5) L.growGrid(d, { left: rng.int(3), top: rng.int(3), right: rng.int(3), bottom: rng.int(3) }); else L.trimGrid(d); });
    case 12: return edit('updateCalendar', (d) => { L.updateCalendar(d, pick(rng, [{ startTod: 21600 }, { startDay: 3 }, { startTod: '07:30', startDay: 1 }, null, {}, 'junk', { startTod: NaN }])); });
    case 13: return edit('road', (d) => { L.paintRoadPath(d, [cell(), cell()], { oneWay: rng.next() < 0.2 }); });
    case 14: return edit('flow', (d) => { const a = any(d.stations); const b = any(d.stations); if (a && b) L.addFlow(d, a.id, b.id); });
    case 15: return edit('fleet', (d) => { if (rng.next() < 0.5) L.addFleet(d, pick(rng, ['agv', 'forklift'])); else { const f = any(d.fleets); if (f) L.removeFleet(d, f.id); } });
    case 16: return edit('moveStation', (d) => { const s = any(d.stations); if (s) L.moveStation(d, s.id, ...cell()); });
    case 17: return edit('translateAll', (d) => { L.translateAll(d, rng.int(3) - 1, rng.int(3) - 1); });
    case 18: case 19: return store.undo() ? 'undo' : 'undo (empty)';
    case 20: case 21: return store.redo() ? 'redo' : 'redo (empty)';
    case 22: { const s = any(stations); const base = s ? clone(layout) : clone(layout); if (s && rng.next() < 0.7) base.stations.find((x) => x.id === s.id).ops = pick(rng, [{ trucks: fullTrucks() }, { trucks: { mode: 'schedule' } }, 'junk', { trucks: [] }]); try { store.replaceLayout(base); } catch (err) { return `replaceLayout THREW ${err.message}`; } return 'replaceLayout'; }
    case 23: { const id = store.addScenario(`S${rng.int(99)}`); return id ? 'addScenario' : 'addScenario (full)'; }
    case 24: { const list = store.getState().project.scenarios; const t = any(list); if (t) store.switchScenario(t.id); return 'switchScenario'; }
    case 25: { const list = store.getState().project.scenarios; if (list.length > 1 && rng.next() < 0.5) store.deleteScenario(any(list).id); else store.duplicateScenario(store.getState().project.activeId); return 'delete/duplicateScenario'; }
    case 26: case 27: {
      // autosave and restore: what comes back from the saved text is the project that was saved, byte for byte
      if (!memory.storage) return 'persist (no storage)';
      store.persist();
      const other = memory.makeStore();
      if (!other.restore()) { memory.mismatch = `restore failed: ${other.lastRestoreError && other.lastRestoreError.message}`; return 'restore'; }
      const a = store.getState().project;
      const b = other.getState().project;
      if (bytes(a.scenarios.map((x) => [x.id, x.layout])) !== bytes(b.scenarios.map((x) => [x.id, x.layout])) || a.activeId !== b.activeId) memory.mismatch = 'the restored project differs from the saved one';
      if (other.lastRestoreWarnings.length) memory.mismatch = `restore warned: ${other.lastRestoreWarnings[0]}`;
      return 'persist and restore';
    }
    default: return edit('settings', (d) => { L.updateSettings(d, { demandFactor: pick(rng, [0.5, 1, 2]) }); });
  }
}

/** Everything that must hold of a store after any step: returns a list of what is wrong. */
export function wrongWithStore(store) {
  const wrong = [];
  const { scenarios } = store.getState().project;
  for (const sc of scenarios) {
    const bad = L.checkInvariants(sc.layout);
    if (bad.length) wrong.push(`scenario ${sc.id}: ${bad[0]}`);
    const text = bytes(sc.layout);
    let again;
    try { again = bytes(L.normalizeLayout(sc.layout)); } catch (err) { wrong.push(`scenario ${sc.id}: normalizeLayout threw ${err.message}`); continue; }
    if (again !== text) wrong.push(`scenario ${sc.id}: normalizeLayout(layout) differs from the layout`);
  }
  return wrong;
}
