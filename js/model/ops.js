// Station options of the warehouse module: `station.ops`, a sparse block next to `params` (docs/WAREHOUSE-DESIGN.md 5.1, 5.3).
// Pure, no DOM, imports only util. This file owns every key under `ops`: its sanitizer, its merge and its table of documented keys.
//
// STATE OF THIS FILE (milestone M0): a seam only. No `ops` key is implemented yet (OPS_SANITIZERS is empty), so
//   sanitizeOps(type, raw) -> undefined   "this station has no options": normalizeLayout leaves `ops` off the station, which is
//                                         exactly what keeps a legacy layout, its file and its share link byte-identical
//   mergeOps(type, current, patch) -> undefined   the same for updateStation(layout, id, { ops: patch }): nothing is stored, and any
//                                         `ops` the station had is removed (a patch of `null` always means "remove the options")
// M1 registers `ops.trucks` for Goods in and Goods out, M3 `form`/`rack`/`block`/`putaway`, M5 `mix`/`accepts`/`outType`, M6 `pick`.
//
// The rules every sanitizer here follows (5.1): sparse (a key exists only when it differs from "feature off", and an `ops` block that
// becomes empty is removed: sanitizeOps returns undefined for it); unknown keys are dropped; numbers are clamped into their range and
// numeric strings are accepted like in the other sanitizers; times are seconds; it never throws; inside a block that exists every
// field is stored, so a later change of a default affects new blocks only.

import { clamp } from '../util/format.js';

/**
 * The table of documented `ops` keys, one entry per key, with a valid sample value. One test (docs/WAREHOUSE-DESIGN.md 10.2) drives
 * from it: every key survives normalizeLayout, exportProject/importProject and the share link, and the layout's schema equals
 * schemaNeeded. Empty until a milestone adds keys.
 * @type {ReadonlyArray<{ key: string, types: string[], schema: number, sample: unknown }>}
 *   `key`: dotted path below `ops` ('trucks.doors'); `types`: station types that may carry it; `schema`: the row of
 *   docs/WAREHOUSE-DESIGN.md 5.2 that introduces it; `sample`: a value the sanitizer must keep as it is.
 */
export const OPS_KEYS = Object.freeze([]);

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

/**
 * The sanitizer of a whole `ops` block, per station type: (raw) => block | undefined. M1 registers 'source' and 'sink' (trucks), M3
 * 'storage' (form, rack, block, putaway), M5 and M6 the rest. A type without an entry cannot carry options. An object that milestones
 * add to, not a switch, so that a test can register a stand-in and prove that every caller goes through sanitizeOps / mergeOps.
 * Empty in M0.
 * @type {Record<string, (raw: unknown) => (object|undefined)>}
 */
export const OPS_SANITIZERS = Object.create(null);

/**
 * Sanitized `ops` block for a station of `type`, or undefined when the station has no options (M0: always undefined, nothing is
 * registered in OPS_SANITIZERS).
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
