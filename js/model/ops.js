// Station options of the warehouse module: `station.ops`, a sparse block next to `params` (docs/WAREHOUSE-DESIGN.md 5.1, 5.3).
// Pure, no DOM, imports only util and defaults.js. This file owns every key under `ops`: its sanitizer, its merge and its table of documented keys.
//
// STATE OF THIS FILE (milestone M1): `ops.trucks` is implemented for Goods in ('source') and Goods out ('sink'): doors, check-in and
// check-out, rate mode or timetable, jitter, no-shows, the longest wait of an outbound truck and its staging (5.3). The other station types
// have no sanitizer, so for them
//   sanitizeOps(type, raw) -> undefined   "this station has no options": normalizeLayout leaves `ops` off the station, which is
//                                         exactly what keeps a legacy layout, its file and its share link byte-identical
//   mergeOps(type, current, patch)        the `ops` block that updateStation(layout, id, { ops: patch }) stores (see below)
// M3 registers `form`/`rack`/`block`/`putaway`, M5 `mix`/`accepts`/`outType`, M6 `pick`; each adds its entries to OPS_KEYS.
//
// The rules every sanitizer here follows (5.1): sparse (a key exists only when it differs from "feature off", and an `ops` block that
// becomes empty is removed: sanitizeOps returns undefined for it); unknown keys are dropped; numbers are clamped into their range and
// numeric strings are accepted like in the other sanitizers; times are seconds; it never throws; inside a block that exists every
// field is stored, so a later change of a default affects new blocks only.

import { clamp } from '../util/format.js';
import { DIST_KINDS } from './defaults.js';

/** Station types that carry `ops.trucks`: Goods in ('source') receives trucks, Goods out ('sink') loads them. */
export const TRUCK_TYPES = Object.freeze(['source', 'sink']);
/** How trucks come: `rate` (a time between trucks and a number of pallets drawn per truck) or `schedule` (a timetable of arrivals). */
export const TRUCK_MODES = Object.freeze(['rate', 'schedule']);
/** The longest timetable (rows of `ops.trucks.schedule`); further rows are dropped. */
export const MAX_SCHEDULE_ROWS = 500;
/** Seconds in a day: a time of day is 0 .. SECONDS_PER_DAY - 1. */
export const SECONDS_PER_DAY = 86400;

/** The ranges of `ops.trucks` (docs/WAREHOUSE-DESIGN.md 5.3): [min, max], whole numbers where the key says so. */
export const TRUCK_RANGES = Object.freeze({
  doors: Object.freeze([1, 32]), // int
  checkIn: Object.freeze([0, 7200]), // s
  checkOut: Object.freeze([0, 7200]), // s
  interArrivalMean: Object.freeze([60, 1000000]), // s, rate mode: the mean time between trucks
  palletsMean: Object.freeze([1, 200]), // pallets per truck (the distribution's mean); the draw is rounded and kept in 1..200
  rowPallets: Object.freeze([1, 200]), // int, pallets of one timetable row
  jitter: Object.freeze([0, 7200]), // s
  noShow: Object.freeze([0, 0.5]), // chance
  maxDwell: Object.freeze([0, 86400]), // s, Goods out
  staging: Object.freeze([0, 50]), // int, pallets per door, Goods out
});

/**
 * The defaults of a new `ops.trucks` block (5.3). Inside a block that exists every field is stored, so a later change of a default
 * affects new blocks only. Frozen; use `defaultTrucks()` for a copy you may edit.
 */
export const TRUCK_DEFAULTS = Object.freeze({
  doors: 2,
  checkIn: 300,
  checkOut: 300,
  mode: 'rate',
  interArrival: Object.freeze({ kind: 'normal', mean: 2700, spread: 0.3 }),
  pallets: Object.freeze({ kind: 'uniform', mean: 24, spread: 0.25 }),
  schedule: Object.freeze([]),
  jitter: 0,
  noShow: 0,
  maxDwell: 3600,
  staging: 4,
});

/** A fresh copy of TRUCK_DEFAULTS that the caller may edit. */
export function defaultTrucks() {
  return {
    ...TRUCK_DEFAULTS,
    interArrival: { ...TRUCK_DEFAULTS.interArrival },
    pallets: { ...TRUCK_DEFAULTS.pallets },
    schedule: [],
  };
}

/**
 * The table of documented `ops` keys, one entry per key, with a valid sample value. One test (docs/WAREHOUSE-DESIGN.md 10.2) drives
 * from it: every key survives normalizeLayout, exportProject/importProject and the share link, ranges are clamped, and the layout's
 * schema equals schemaNeeded. Each milestone adds its entries.
 * @type {ReadonlyArray<{ key: string, types: ReadonlyArray<string>, schema: number, sample: unknown, cases?: ReadonlyArray<[unknown, unknown]> }>}
 *   `key`: dotted path below `ops` ('trucks.doors'); `types`: station types that may carry it; `schema`: the row of
 *   docs/WAREHOUSE-DESIGN.md 5.2 that introduces it; `sample`: a value the sanitizer must keep as it is, other than the default;
 *   `cases`: [input, output] pairs for the same path (clamping, rounding, junk taking the default).
 */
export const OPS_KEYS = Object.freeze([
  { key: 'trucks', types: TRUCK_TYPES, schema: 2, sample: { ...defaultTrucks(), doors: 4 }, cases: [[{}, defaultTrucks()], [{ doors: 4 }, { ...defaultTrucks(), doors: 4 }]] },
  { key: 'trucks.doors', types: TRUCK_TYPES, schema: 2, sample: 5, cases: [[0, 1], [-3, 1], [99, 32], ['7', 7], [2.6, 3], ['x', 2], [null, 2], [NaN, 2]] },
  { key: 'trucks.checkIn', types: TRUCK_TYPES, schema: 2, sample: 600, cases: [[-1, 0], [99999, 7200], ['90', 90], [12.4, 12], ['soon', 300]] },
  { key: 'trucks.checkOut', types: TRUCK_TYPES, schema: 2, sample: 120, cases: [[-1, 0], [99999, 7200], ['90', 90], [12.6, 13], [{}, 300]] },
  { key: 'trucks.mode', types: TRUCK_TYPES, schema: 2, sample: 'schedule', cases: [['rate', 'rate'], ['SCHEDULE', 'rate'], ['timetable', 'rate'], [3, 'rate'], [null, 'rate']] },
  { key: 'trucks.interArrival', types: TRUCK_TYPES, schema: 2, sample: { kind: 'exp', mean: 1800, spread: 0.5 }, cases: [[{ mean: 100 }, { kind: 'normal', mean: 100, spread: 0.3 }], ['x', { kind: 'normal', mean: 2700, spread: 0.3 }]] },
  { key: 'trucks.interArrival.kind', types: TRUCK_TYPES, schema: 2, sample: 'uniform', cases: [['const', 'const'], ['poisson', 'normal'], [7, 'normal']] },
  { key: 'trucks.interArrival.mean', types: TRUCK_TYPES, schema: 2, sample: 3600, cases: [[59, 60], [0, 60], [2e6, 1e6], ['1200', 1200], ['x', 2700]] },
  { key: 'trucks.interArrival.spread', types: TRUCK_TYPES, schema: 2, sample: 0.1, cases: [[-1, 0], [3, 1], ['0.5', 0.5], ['x', 0.3]] },
  { key: 'trucks.pallets', types: TRUCK_TYPES, schema: 2, sample: { kind: 'const', mean: 33, spread: 0 }, cases: [[{ mean: 10 }, { kind: 'uniform', mean: 10, spread: 0.25 }]] },
  { key: 'trucks.pallets.kind', types: TRUCK_TYPES, schema: 2, sample: 'normal', cases: [['exp', 'exp'], ['gauss', 'uniform']] },
  { key: 'trucks.pallets.mean', types: TRUCK_TYPES, schema: 2, sample: 18, cases: [[0, 1], [500, 200], ['12', 12], ['x', 24]] },
  { key: 'trucks.pallets.spread', types: TRUCK_TYPES, schema: 2, sample: 0.4, cases: [[-0.5, 0], [2, 1], ['x', 0.25]] },
  {
    key: 'trucks.schedule', types: TRUCK_TYPES, schema: 2, sample: [{ at: 21600, pallets: 24 }, { at: 25200, pallets: null }, { at: 36000, pallets: 12 }],
    cases: [
      [[{ at: 30000, pallets: 5 }, { at: 100, pallets: 6 }, { at: 100, pallets: 7 }], [{ at: 100, pallets: 6 }, { at: 100, pallets: 7 }, { at: 30000, pallets: 5 }]],
      [[{ at: '06:00', pallets: '24' }, { at: 86400 }, { at: -1 }, { at: 'noon' }, 'x', null, [], { pallets: 3 }], [{ at: 21600, pallets: 24 }]],
      [[{ at: 3600, pallets: 0 }, { at: 3700, pallets: 999 }, { at: 3800, pallets: 'many' }, { at: 3900, pallets: 4.6 }], [{ at: 3600, pallets: 1 }, { at: 3700, pallets: 200 }, { at: 3800, pallets: null }, { at: 3900, pallets: 5 }]],
      ['timetable', []],
    ],
  },
  { key: 'trucks.jitter', types: TRUCK_TYPES, schema: 2, sample: 600, cases: [[-5, 0], [1e6, 7200], ['300', 300], ['x', 0]] },
  { key: 'trucks.noShow', types: TRUCK_TYPES, schema: 2, sample: 0.1, cases: [[-1, 0], [0.9, 0.5], ['0.25', 0.25], ['x', 0]] },
  { key: 'trucks.maxDwell', types: TRUCK_TYPES, schema: 2, sample: 5400, cases: [[-1, 0], [1e6, 86400], ['1800', 1800], ['x', 3600]] },
  { key: 'trucks.staging', types: TRUCK_TYPES, schema: 2, sample: 8, cases: [[-1, 0], [99, 50], ['6', 6], [2.5, 3], ['x', 4]] },
]);

/** Finite number, or a numeric string converted to one, else null (the rule of layout.js: junk is never coerced). */
export function numberOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** `v` clamped into [min, max]; junk (anything numberOf rejects) takes `fallback`, which is clamped too. Never -0. */
export function clampNumber(v, min, max, fallback) {
  const n = numberOf(v);
  return clamp(n === null ? fallback : n, min, max) + 0;
}

/** Like clampNumber, rounded to an integer. */
export function clampInt(v, min, max, fallback) {
  return Math.round(clampNumber(v, min, max, fallback)) + 0;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Own property of a plain object (never an inherited one, so a polluted prototype or a key such as "constructor" cannot leak in). */
const own = (obj, key) => (isObj(obj) && Object.hasOwn(obj, key) ? obj[key] : undefined);

/**
 * A time of day in seconds after midnight (an integer 0..86399) from a number or numeric string, or from "H:MM", "HH:MM" or
 * "HH:MM:SS"; null for anything else (5.1: the UI shows HH:MM, the sanitizer accepts the string). Lives here because the timetable of
 * `ops.trucks` is read with it; calendar.js re-exports it.
 * @param {unknown} v
 * @returns {number|null}
 */
export function timeOfDay(v) {
  if (typeof v === 'string') {
    const m = /^\s*(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\s*$/.exec(v);
    if (m) return Number(m[1]) < 24 ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0) : null;
  }
  const n = numberOf(v);
  if (n === null || n < 0 || n >= SECONDS_PER_DAY) return null;
  return Math.min(Math.round(n), SECONDS_PER_DAY - 1) + 0; // 86399.6 is still the last second of the day
}

// ---------------------------------------------------------------------------------------------------------
// ops.trucks (M1): Goods in and Goods out
// ---------------------------------------------------------------------------------------------------------

/** A time distribution for a truck field: kind from DIST_KINDS, mean clamped into [meanMin, meanMax], spread into 0..1; junk takes `base`. */
function sanitizeTruckDist(raw, base, [meanMin, meanMax]) {
  const kind = own(raw, 'kind');
  return {
    kind: DIST_KINDS.includes(kind) ? kind : base.kind,
    mean: clampNumber(own(raw, 'mean'), meanMin, meanMax, base.mean),
    spread: clampNumber(own(raw, 'spread'), 0, 1, base.spread),
  };
}

/**
 * The timetable of a station: at most MAX_SCHEDULE_ROWS rows `{ at, pallets }`, sorted by `at` (a time of day, seconds after midnight;
 * equal times keep their order). `pallets` is a whole number 1..200, or null: draw the pallets from `ops.trucks.pallets`. A row without a
 * readable time is dropped; an unreadable `pallets` becomes null (the time of an arrival is its essential content); other keys are dropped
 * (`days` arrives with M2). Which rows survive the cap is the first 500 valid ones in the order given, so a sorted list stays as it is.
 * @param {unknown} raw
 * @returns {Array<{ at: number, pallets: number|null }>}
 */
function sanitizeSchedule(raw) {
  const rows = [];
  if (!Array.isArray(raw)) return rows;
  for (let i = 0; i < raw.length && rows.length < MAX_SCHEDULE_ROWS; i++) {
    const row = raw[i];
    const at = timeOfDay(own(row, 'at'));
    if (at === null) continue;
    const pallets = numberOf(own(row, 'pallets'));
    rows.push({ at, pallets: pallets === null ? null : clampInt(pallets, ...TRUCK_RANGES.rowPallets, 1) });
  }
  return rows.sort((a, b) => a.at - b.at); // Array#sort is stable
}

/**
 * A complete, clamped `ops.trucks` block (5.3); every junk field takes its default. Keys come in the order of the document.
 * @param {unknown} raw
 * @returns {object}
 */
function sanitizeTrucks(raw) {
  const d = TRUCK_DEFAULTS;
  const r = TRUCK_RANGES;
  const mode = own(raw, 'mode');
  return {
    doors: clampInt(own(raw, 'doors'), ...r.doors, d.doors),
    checkIn: clampInt(own(raw, 'checkIn'), ...r.checkIn, d.checkIn),
    checkOut: clampInt(own(raw, 'checkOut'), ...r.checkOut, d.checkOut),
    mode: TRUCK_MODES.includes(mode) ? mode : d.mode,
    interArrival: sanitizeTruckDist(own(raw, 'interArrival'), d.interArrival, r.interArrivalMean),
    pallets: sanitizeTruckDist(own(raw, 'pallets'), d.pallets, r.palletsMean),
    schedule: sanitizeSchedule(own(raw, 'schedule')),
    jitter: clampInt(own(raw, 'jitter'), ...r.jitter, d.jitter),
    noShow: Math.round(clampNumber(own(raw, 'noShow'), ...r.noShow, d.noShow) * 1e4) / 1e4,
    maxDwell: clampInt(own(raw, 'maxDwell'), ...r.maxDwell, d.maxDwell),
    staging: clampInt(own(raw, 'staging'), ...r.staging, d.staging),
  };
}

/** The sanitizer of the `ops` block of Goods in and Goods out: `{ trucks }` when the raw block holds a truck block, else nothing. */
function sanitizeTruckOps(raw) {
  const trucks = own(raw, 'trucks');
  return isObj(trucks) ? { trucks: sanitizeTrucks(trucks) } : undefined;
}

/**
 * The truck block of a station (layout or runtime), or null: `station.ops.trucks` when it is an object. Reads only; never creates anything.
 * @param {{ ops?: { trucks?: object } }|null|undefined} station
 * @returns {object|null}
 */
export function trucksOf(station) {
  const trucks = station && station.ops ? station.ops.trucks : null;
  return isObj(trucks) ? trucks : null;
}

/**
 * The sanitizer of a whole `ops` block, per station type: (raw) => block | undefined. M1 registers 'source' and 'sink' (trucks), M3
 * 'storage' (form, rack, block, putaway), M5 and M6 the rest. A type without an entry cannot carry options. An object that milestones
 * add to, not a switch, so that a test can register a stand-in and prove that every caller goes through sanitizeOps / mergeOps.
 * @type {Record<string, (raw: unknown) => (object|undefined)>}
 */
export const OPS_SANITIZERS = Object.create(null);
for (const type of TRUCK_TYPES) OPS_SANITIZERS[type] = sanitizeTruckOps;

/**
 * Sanitized `ops` block for a station of `type`, or undefined when the station has no options: a type without an entry in
 * OPS_SANITIZERS (Workstation, Storage, Parking: M1 knows no options for them) drops whatever it is given.
 * @param {string} type station type ('source' | 'process' | 'storage' | 'sink' | 'depot')
 * @param {unknown} raw whatever a file or a patch holds
 * @returns {object|undefined}
 */
export function sanitizeOps(type, raw) {
  const sanitize = OPS_SANITIZERS[type];
  return typeof sanitize === 'function' ? sanitize(raw) : undefined;
}

/** `patch` merged into `base`, as a new object: plain objects merge key by key at every depth, arrays and scalars replace, `null` removes a key. */
function mergeDeep(base, patch) {
  const merged = { ...base };
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value === undefined || key === '__proto__') continue;
    if (value === null) delete merged[key];
    else merged[key] = isObj(value) && Object.hasOwn(merged, key) && isObj(merged[key]) ? mergeDeep(merged[key], value) : value;
  }
  return merged;
}

/**
 * The `ops` block that results from merging `patch` into `current` (a sanitized block or undefined), sanitized again; undefined when
 * the station then has no options. Merged like `params`, but at every depth: the keys of the patch replace those of the block, a plain
 * object that exists on both sides merges key by key (a patch of `{ trucks: { doors: 3 } }` changes the doors and keeps the other truck
 * fields, a patch of `{ trucks: { interArrival: { mean: 2400 } } }` changes the mean and keeps the kind and the spread, which is what a
 * field of the panel or a sweep sends), arrays and scalars replace, a `null` value switches that key off, and `patch === null` removes the
 * whole block. A patch that is not an object changes nothing.
 * @param {string} type
 * @param {object|undefined} current
 * @param {unknown} patch
 * @returns {object|undefined}
 */
export function mergeOps(type, current, patch) {
  if (patch === null) return undefined;
  const base = isObj(current) ? current : {};
  return sanitizeOps(type, isObj(patch) ? mergeDeep(base, patch) : { ...base });
}
