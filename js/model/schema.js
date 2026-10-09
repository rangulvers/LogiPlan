// Schema versions of a layout file (docs/WAREHOUSE-DESIGN.md 5.2). Pure, no DOM, imports only defaults.js.
//
// The rule: a layout's `schema` is the LOWEST version that can express its content. A legacy layout (nothing of the warehouse module in
// it) is 1 and stays 1, so its file, its share link and its autosave stay byte-identical; a layout that uses a key of a later row is
// stamped with that row. One number per milestone that persists new keys means that a cached older tab warns about a newer file
// (serialize.js) instead of silently dropping the keys it does not know.
//
//   SCHEMA_VERSION (defaults.js)  the BASE schema: what createLayout and emptyLayout stamp. It never moves.
//   SCHEMA_MAX                    the highest row this build implements, i.e. can read without telling the planner that the file is
//                                 from a newer version. Raise it in the milestone that adds the row (M1: 2, M2: 3, M3: 4, ...).
//   schemaNeeded(layout)          the highest row whose keys the layout uses (at least 1). normalizeLayout stamps it, checkInvariants
//                                 demands exactly it, exportProject stamps the project with the highest of its scenarios. The mutators
//                                 of layout.js that add or remove extension content keep the stamp true with reconcileLayout (extensions.js).
//   migrate(raw)                  reserved: runs before sanitizing. Everything in M1 to M6 is additive, so it is the identity. A future
//                                 rename gets one numbered step here and one fixture.
//
// schemaNeeded looks at the documented KEYS of each row, not at whether a sanitizer accepts them, so it is meaningful for a raw layout
// as well as for a normalized one; until a milestone implements a row, normalizeLayout drops those keys and so always stamps 1.

import { SCHEMA_VERSION } from './defaults.js';

/** The base schema (alias of defaults.js SCHEMA_VERSION). */
export const SCHEMA_BASE = SCHEMA_VERSION;
/** The highest schema row implemented by this build (M0: only the base schema). */
export const SCHEMA_MAX = 1;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
/** Does `obj` carry `key` (own property, not undefined)? Safe for any value of `obj`. */
const has = (obj, key) => isObj(obj) && Object.hasOwn(obj, key) && obj[key] !== undefined;
const hasAny = (obj, keys) => keys.some((key) => has(obj, key));

/** The `station.ops` blocks of a layout. */
const opsBlocks = (layout) => arr(layout.stations).filter(isObj).map((s) => s.ops).filter(isObj);
/** The rows of every `ops.trucks.schedule`. */
const scheduleRows = (ops) => ops.flatMap((block) => (isObj(block.trucks) ? arr(block.trucks.schedule) : [])).filter(isObj);

/**
 * One row per schema. `uses(layout, ops, rows)` says whether the layout carries a key introduced by that row (`ops`: its station
 * options blocks, `rows`: its truck timetable rows, both computed once); `keys` is the documentation of the row
 * (docs/WAREHOUSE-DESIGN.md 5.2). The base row 1 needs no test: everything is at least 1.
 */
export const SCHEMA_ROWS = Object.freeze([
  Object.freeze({
    schema: 1, milestone: 'legacy', keys: 'everything that exists now',
    uses: () => true,
  }),
  Object.freeze({
    schema: 2, milestone: 'M1', keys: 'station.ops.trucks (Goods in, Goods out); layout.calendar with startTod and startDay only',
    uses: (layout, ops) => has(layout, 'calendar') || ops.some((block) => has(block, 'trucks')),
  }),
  Object.freeze({
    schema: 3, milestone: 'M2', keys: 'calendar.shifts, calendar.profiles; station.ops.calendar; fleet.calendar; ops.trucks.schedule[].days',
    uses: (layout, ops, rows) => hasAny(layout.calendar, ['shifts', 'profiles'])
      || ops.some((block) => has(block, 'calendar'))
      || arr(layout.fleets).some((f) => has(f, 'calendar'))
      || rows.some((row) => has(row, 'days')),
  }),
  Object.freeze({
    schema: 4, milestone: 'M3', keys: 'station.ops.form, rack, block, putaway; fleet.aisleMin, fleet.liftHeight',
    uses: (layout, ops) => ops.some((block) => hasAny(block, ['form', 'rack', 'block', 'putaway']))
      || arr(layout.fleets).some((f) => hasAny(f, ['aisleMin', 'liftHeight'])),
  }),
  Object.freeze({
    schema: 5, milestone: 'M4', keys: 'ops.putaway value nearest-free; ops.trucks.depart, releaseLead, grace, schedule[].depart',
    uses: (layout, ops, rows) => ops.some((block) => block.putaway === 'nearest-free' || hasAny(block.trucks, ['depart', 'releaseLead', 'grace']))
      || rows.some((row) => has(row, 'depart')),
  }),
  Object.freeze({
    schema: 6, milestone: 'M5', keys: 'layout.loadTypes; flow.types; ops.mix, ops.trucks.mix, ops.accepts, ops.outType; schedule[].mix',
    uses: (layout, ops, rows) => has(layout, 'loadTypes')
      || arr(layout.flows).some((f) => has(f, 'types'))
      || ops.some((block) => hasAny(block, ['mix', 'accepts', 'outType']) || has(block.trucks, 'mix'))
      || rows.some((row) => has(row, 'mix')),
  }),
  Object.freeze({
    schema: 7, milestone: 'M6', keys: 'station.ops.pick',
    uses: (layout, ops) => ops.some((block) => has(block, 'pick')),
  }),
]);

/**
 * The lowest schema version that can express `layout`: the highest row whose keys it uses, at least 1 (the base). Never throws; a
 * value that is not a layout gives the base schema.
 * @param {object} layout normalized or raw
 * @returns {number} an integer from SCHEMA_BASE up to the number of rows
 */
export function schemaNeeded(layout) {
  let need = SCHEMA_BASE;
  if (!isObj(layout)) return need;
  const ops = opsBlocks(layout);
  const rows = scheduleRows(ops);
  for (const row of SCHEMA_ROWS) if (row.schema > need && row.uses(layout, ops, rows)) need = row.schema;
  return need;
}

/**
 * Reserved hook, run before sanitizing a raw layout: brings a file of an older shape to the current one. Everything up to M6 only adds
 * keys, so for now it returns `raw` unchanged.
 * @param {object} raw a layout object
 * @returns {object}
 */
export function migrate(raw) {
  return raw;
}
