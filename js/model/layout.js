// Layout model: construction, tolerant loading (normalizeLayout), queries and the in-place mutators that
// keep the invariants of docs/ARCHITECTURE.md §4. Pure functions, no DOM. Layouts are plain JSON.
//
// Conventions and readings of the spec (also reported to the team):
//  * Mutators edit the layout they are given in place. "Returns true" means the request was valid and
//    applied (it may still be a no-op); false/null means it was rejected and the layout is untouched.
//    Road painting/erasing returns true only when something actually changed.
//  * Stations and obstacles never overlap each other (obstacles do not overlap obstacles either) and
//    never cover a road cell. Mutators REJECT such requests; they never delete roads silently.
//  * eraseLink removes the directed link (cx,cy)->dir only (the same pair of arguments hasLink takes);
//    call it for both cells to cut a two-way connection. flipRoadDirection cycles a link
//    both -> (cx,cy)->neighbour only -> neighbour->(cx,cy) only -> both.
//  * A one-way stroke painted over an existing two-way road changes nothing: strokes only ever ADD
//    links. Use flipRoadDirection (or erase and repaint) to change a direction.
//  * paintRoadPath returns the number of distinct stroke cells that were accepted (painted or already
//    road) before the stroke hit a blocked or out-of-bounds cell.
//  * Label `size` is a text height in grid cells (0.25..8); `x`/`y` are the anchor point in cells.
//  * normalizeLayout clips stations/obstacles to the grid (dropping them if nothing remains), drops
//    later stations/obstacles that overlap earlier ones, and drops roads under them. Schema 0/absent is
//    read as schema 1 (there is nothing older to migrate); newer schemas are read best-effort.
//  * Numeric strings ("12") are accepted wherever a number is expected; anything else non-numeric falls
//    back to the default when a layout is loaded and keeps the CURRENT value when a mutator patches a field
//    (an editor that commits NaN or '' while the user clears a field must not wipe the setting).
//  * Ids must match [A-Za-z0-9_-]{1,32} and must not be a property name of Object.prototype ("__proto__",
//    "constructor", "toString" …), so reports and stores that key plain objects by id cannot be corrupted;
//    missing/invalid/duplicate ids are reassigned.
//  * Options arguments (`{ oneWay }`, `{ ignoreStation }` …) may be null or omitted; both mean "defaults".

import {
  SCHEMA_VERSION, STATION_TYPES, DIST_KINDS, FLEET_PRESETS, DISPATCH_STRATEGIES, ROUTING_MODES,
  OBSTACLE_KINDS, GRID_LIMITS, RUNTIME_KEYS,
  defaultStationParams, defaultStation, defaultFlow, defaultFleet, defaultSettings, defaultGrid, emptyLayout,
} from './defaults.js';
import {
  DX, DY, DIR_BIT, opposite, cellKey, parseKey, dirFromTo, inBounds, rectsOverlap, inRect, perimeterCells, lPath,
} from '../util/grid.js';
import { nextId } from '../util/ids.js';
import { clamp } from '../util/format.js';

// ---------------------------------------------------------------------------------------------------------
// Field specifications (shared by the sanitizers and by checkInvariants)
// ---------------------------------------------------------------------------------------------------------

const num = (min, max) => ({ min, max, int: false });
const int = (min, max) => ({ min, max, int: true });

const NAME_MAX = 80;
const TEXT_MAX = 200;
const NOTES_MAX = 20000;
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const RESERVED_IDS = new Set(Object.getOwnPropertyNames(Object.prototype));
const KEY_RE = /^(0|[1-9]\d*),(0|[1-9]\d*)$/;
const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const GRID_SPEC = {
  cols: int(GRID_LIMITS.minCols, GRID_LIMITS.maxCols),
  rows: int(GRID_LIMITS.minRows, GRID_LIMITS.maxRows),
  cellSize: num(GRID_LIMITS.minCell, GRID_LIMITS.maxCell),
};
const SETTINGS_SPEC = {
  seed: int(0, 4294967295),
  duration: num(60, 30 * 86400),
  warmup: num(0, 7 * 86400),
  demandFactor: num(0.05, 10),
  speedFactor: num(0.05, 10),
  processFactor: num(0.05, 10),
  dt: num(0.01, 0.5),
};
const SETTINGS_ENUMS = {
  dispatch: Object.keys(DISPATCH_STRATEGIES),
  routing: Object.keys(ROUTING_MODES),
  handedness: ['right', 'left'],
  deadlock: ['resolve', 'ignore'],
};
const DIST_SPEC = { mean: num(0.5, 1e6), spread: num(0, 1) };
const PARAM_SPEC = {
  source: { batch: int(1, 100), outCap: int(1, 1000), startDelay: num(0, 86400) },
  process: { machines: int(1, 100), outPerCycle: int(1, 100), inCap: int(1, 1000), outCap: int(1, 1000), mtbf: num(0, 1e7), mttr: num(0, 1e7) },
  storage: { capacity: int(1, 100000), dwell: num(0, 1e6) },
  sink: {},
  depot: { slots: int(1, 1000), chargers: int(0, 1000) },
};
const FLOW_SPEC = {
  weight: num(0.01, 1000), perCycle: int(1, 1000), batchMin: int(1, 1000), batchMax: int(0, 1000),
  maxWait: num(0, 1e6), priority: int(1, 3),
};
const FLEET_SPEC = {
  count: int(0, 500), speed: num(0.1, 15), accel: num(0.05, 10), decel: num(0.05, 10), length: num(0.2, 20),
  capacity: int(1, 100), loadTime: num(0, 3600), unloadTime: num(0, 3600), mtbf: num(0, 1e7), mttr: num(0, 1e7),
};
const BATTERY_SPEC = { runtimeMin: num(1, 10000), chargeTimeMin: num(1, 10000), lowPct: num(0, 100), resumePct: num(0, 100) };
const LIMIT_SPEC = num(0.1, 1);
const LABEL_SIZE_SPEC = num(0.25, 8);
const FLOW_FROM_TYPES = ['source', 'process', 'storage'];
const FLOW_TO_TYPES = ['process', 'storage', 'sink'];

// ---------------------------------------------------------------------------------------------------------
// Small value helpers
// ---------------------------------------------------------------------------------------------------------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
/** Own-property lookup that cannot be fooled by keys such as "constructor" or "__proto__". */
const hasKey = (obj, key) => typeof key === 'string' && Object.hasOwn(obj, key);

/** Finite number, or a numeric string converted to one, else null. */
function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Rounded integer (never -0) or null. */
function toInt(v) {
  const n = toNumber(v);
  return n === null ? null : Math.round(n) + 0;
}

/** Coerce `v` into the spec's range (integer if the spec says so); junk falls back to `fallback`. */
function fit(spec, v, fallback) {
  const n = toNumber(v);
  const c = clamp(n === null ? fallback : n, spec.min, spec.max);
  return (spec.int ? Math.round(c) : c) + 0;
}

/** Is `v` already a valid value for the spec (strict, no coercion)? */
const fits = (spec, v) => typeof v === 'number' && Number.isFinite(v) && v >= spec.min && v <= spec.max
  && (!spec.int || Number.isInteger(v)) && !Object.is(v, -0);

/**
 * Clean text for names, notes and labels (shared with serialize.js): only strings and finite numbers count, control
 * characters become spaces, lone surrogates become U+FFFD, the result is cut to `max` and (single-line) trimmed.
 * Returns `fallback` when nothing is left.
 */
export function cleanText(v, max, fallback = '', multiline = false) {
  let s = typeof v === 'string' ? v : (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
  s = s.replace(multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, ' ');
  s = s.replace(/[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g, (m) => (m.length === 2 ? m : '\ufffd')); // lone surrogates
  s = s.slice(0, max);
  if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1);
  return (multiline ? s : s.trim()) || fallback;
}

/** Is `v` an acceptable entity id: [A-Za-z0-9_-]{1,32} and not a property name of Object.prototype? */
const isValidId = (v) => typeof v === 'string' && ID_RE.test(v) && !RESERVED_IDS.has(v);

/** A valid id string (see isValidId), or '' when `v` is not one. Non-negative integers become decimal strings. */
export function cleanId(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) v = String(v);
  return isValidId(v) ? v : '';
}

/** Keep first occurrences of valid ids, give every other item a fresh `prefix`+n id (linear time: one counter, one Set). */
function assignIds(items, prefix) {
  const used = new Set();
  for (const item of items) {
    if (item.id && !used.has(item.id)) used.add(item.id);
    else item.id = '';
  }
  let n = 1;
  for (const item of items) {
    if (item.id) continue;
    while (used.has(prefix + n)) n++;
    item.id = prefix + n;
    used.add(item.id);
  }
}

/** `base 1`, `base 2`, … : the first numbered name not in `taken`. */
function numberedName(taken, base) {
  let n = 1;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** `base` itself if free, otherwise `base 2`, `base 3`, … */
function plainOrNumberedName(taken, base) {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Name for a copy: "Press 2" -> "Press 3", "Press line" -> "Press line 2". */
function copyName(taken, name) {
  const m = /^(.*\S)\s+(\d+)$/.exec(name);
  const base = m ? m[1] : name;
  let n = m ? Number(m[2]) + 1 : 2;
  while (taken.has(`${base} ${n}`)) n++;
  return cleanText(`${base} ${n}`, NAME_MAX);
}

// ---------------------------------------------------------------------------------------------------------
// Sanitizers (used by normalizeLayout and by the mutators, so both agree on what "valid" means)
// ---------------------------------------------------------------------------------------------------------

function sanitizeDist(raw, base) {
  const src = isObj(raw) ? raw : {};
  return {
    kind: DIST_KINDS.includes(src.kind) ? src.kind : base.kind,
    mean: fit(DIST_SPEC.mean, src.mean, base.mean),
    spread: fit(DIST_SPEC.spread, src.spread, base.spread),
  };
}

/**
 * Complete, clamped `params` for a station type; unknown keys are dropped. A missing or junk field takes its value
 * from `fallback` (the type's defaults unless the caller passes the current, already valid, params).
 */
function sanitizeParams(type, raw, fallback = defaultStationParams(type)) {
  const src = isObj(raw) ? raw : {};
  const spec = PARAM_SPEC[type];
  const out = {};
  for (const key of Object.keys(fallback)) {
    out[key] = isObj(fallback[key]) ? sanitizeDist(src[key], fallback[key]) : fit(spec[key], src[key], fallback[key]);
  }
  if (type === 'depot') out.chargers = Math.min(out.chargers, out.slots);
  return out;
}

/**
 * `current` params with `patch` merged one level deep (distributions merge field by field), then sanitized.
 * A patched field that is not a usable value keeps its current value.
 */
function mergeParams(type, current, patch) {
  const base = sanitizeParams(type, current);
  const merged = { ...base };
  if (isObj(patch)) {
    for (const key of Object.keys(base)) {
      if (patch[key] === undefined) continue;
      merged[key] = isObj(base[key]) && isObj(patch[key]) ? { ...base[key], ...patch[key] } : patch[key];
    }
  }
  return sanitizeParams(type, merged, base);
}

/** If a maximum batch is set and below the minimum, let `keep` ('min' | 'max') win. */
function reconcileBatch(flow, keep) {
  if (flow.batchMax > 0 && flow.batchMin > flow.batchMax) {
    if (keep === 'min') flow.batchMax = flow.batchMin;
    else flow.batchMin = flow.batchMax;
  }
}

function sanitizeBattery(raw, base) {
  const src = isObj(raw) ? raw : {};
  const out = { enabled: typeof src.enabled === 'boolean' ? src.enabled : base.enabled };
  for (const key of Object.keys(BATTERY_SPEC)) out[key] = fit(BATTERY_SPEC[key], src[key], base[key]);
  out.resumePct = Math.max(out.resumePct, out.lowPct);
  return out;
}

/** Fully sanitized fleet from raw data. `name` may come back '' (the caller assigns a unique default). */
function sanitizeFleet(raw, depotIds) {
  const preset = hasKey(FLEET_PRESETS, raw.preset) ? raw.preset : 'custom';
  const f = defaultFleet(preset, { id: cleanId(raw.id) });
  f.name = cleanText(raw.name, NAME_MAX);
  for (const key of Object.keys(FLEET_SPEC)) f[key] = fit(FLEET_SPEC[key], raw[key], f[key]);
  if (typeof raw.color === 'string' && COLOR_RE.test(raw.color)) f.color = raw.color;
  f.battery = sanitizeBattery(raw.battery, f.battery);
  const home = cleanId(raw.home);
  f.home = depotIds.has(home) ? home : null;
  f.idle = raw.idle === 'stay' ? 'stay' : 'park';
  return f;
}

/** Fully sanitized flow whose endpoints were already validated. */
function sanitizeFlow(head, raw, fleetId) {
  const f = defaultFlow(head);
  for (const key of Object.keys(FLOW_SPEC)) f[key] = fit(FLOW_SPEC[key], raw[key], f[key]);
  f.fleetId = fleetId;
  reconcileBatch(f, 'max');
  return f;
}

const flowEndpointsValid = (a, b) => !!a && !!b && a !== b && FLOW_FROM_TYPES.includes(a.type) && FLOW_TO_TYPES.includes(b.type);

/** Clip an integer rectangle to the grid; null when nothing is left. */
function clipRect(r, cols, rows) {
  const x0 = Math.max(0, r.x);
  const y0 = Math.max(0, r.y);
  const x1 = Math.min(cols, r.x + r.w);
  const y1 = Math.min(rows, r.y + r.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** Rectangle from raw `x,y,w,h` fields (sizes below 1 become 1, missing ones use `size`), clipped to the grid. */
function rectFromRaw(raw, grid, size) {
  const x = toInt(raw.x);
  const y = toInt(raw.y);
  if (x === null || y === null) return null;
  const w = Math.max(1, toInt(raw.w) ?? size.w);
  const h = Math.max(1, toInt(raw.h) ?? size.h);
  return clipRect({ x, y, w, h }, grid.cols, grid.rows);
}

/** Mark the cells of `rect` in the occupancy grid; false (and no change) if any is taken. */
function claim(occ, grid, rect) {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) if (occ[y * grid.cols + x]) return false;
  }
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) occ[y * grid.cols + x] = 1;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Construction and loading
// ---------------------------------------------------------------------------------------------------------

/**
 * A new empty plant. Sizes are clamped to GRID_LIMITS.
 * @param {{name?: string, cols?: number, rows?: number, cellSize?: number}} [opts]
 */
export function createLayout(opts) {
  const { name, cols, rows, cellSize } = opts ?? {};
  const d = defaultGrid();
  const layout = emptyLayout({
    grid: {
      cols: fit(GRID_SPEC.cols, cols, d.cols),
      rows: fit(GRID_SPEC.rows, rows, d.rows),
      cellSize: fit(GRID_SPEC.cellSize, cellSize, d.cellSize),
    },
  });
  layout.name = cleanText(name, NAME_MAX, layout.name);
  return layout;
}

function normalizeGrid(raw) {
  const src = isObj(raw) ? raw : {};
  const d = defaultGrid();
  return {
    cols: fit(GRID_SPEC.cols, src.cols, d.cols),
    rows: fit(GRID_SPEC.rows, src.rows, d.rows),
    cellSize: fit(GRID_SPEC.cellSize, src.cellSize, d.cellSize),
  };
}

function normalizeSettings(raw) {
  const src = isObj(raw) ? raw : {};
  const base = defaultSettings();
  const out = {};
  for (const key of Object.keys(base)) {
    if (SETTINGS_SPEC[key]) out[key] = fit(SETTINGS_SPEC[key], src[key], base[key]);
    else if (SETTINGS_ENUMS[key]) out[key] = SETTINGS_ENUMS[key].includes(src[key]) ? src[key] : base[key];
    else out[key] = base[key];
  }
  return out;
}

function normalizeStations(raw, grid, occ) {
  const stations = [];
  for (const r of arr(raw)) {
    if (!isObj(r) || !hasKey(STATION_TYPES, r.type)) continue;
    const rect = rectFromRaw(r, grid, STATION_TYPES[r.type].size);
    if (!rect || !claim(occ, grid, rect)) continue;
    stations.push({
      id: cleanId(r.id), type: r.type, name: cleanText(r.name, NAME_MAX), ...rect, params: sanitizeParams(r.type, r.params),
    });
  }
  assignIds(stations, 's');
  const taken = new Set(stations.map((s) => s.name).filter(Boolean));
  for (const s of stations) {
    if (s.name) continue;
    s.name = numberedName(taken, STATION_TYPES[s.type].short);
    taken.add(s.name);
  }
  return stations;
}

function normalizeObstacles(raw, grid, occ) {
  const obstacles = [];
  for (const r of arr(raw)) {
    if (!isObj(r)) continue;
    const rect = rectFromRaw(r, grid, { w: 1, h: 1 });
    if (!rect || !claim(occ, grid, rect)) continue;
    obstacles.push({ id: cleanId(r.id), ...rect, kind: OBSTACLE_KINDS.includes(r.kind) ? r.kind : 'wall' });
  }
  assignIds(obstacles, 'o');
  return obstacles;
}

function normalizeLabels(raw, grid) {
  const labels = [];
  for (const r of arr(raw)) {
    if (!isObj(r)) continue;
    const x = toNumber(r.x);
    const y = toNumber(r.y);
    if (x === null || y === null || x < 0 || y < 0 || x > grid.cols || y > grid.rows) continue;
    const label = { id: cleanId(r.id), x: x + 0, y: y + 0, text: cleanText(r.text, TEXT_MAX, 'Label') };
    const size = toNumber(r.size);
    if (size !== null) label.size = fit(LABEL_SIZE_SPEC, size, 1);
    labels.push(label);
  }
  assignIds(labels, 'l');
  return labels;
}

/** Clear every exit bit that does not lead to another road cell (also covers out-of-bounds neighbours). */
function pruneLinks(roads) {
  for (const key of Object.keys(roads)) {
    const [cx, cy] = parseKey(key);
    const cell = roads[key];
    for (let d = 0; d < 4; d++) {
      if (cell.out & DIR_BIT[d] && !Object.hasOwn(roads, cellKey(cx + DX[d], cy + DY[d]))) cell.out &= ~DIR_BIT[d];
    }
  }
}

function normalizeRoads(raw, grid, occ) {
  const roads = {};
  if (!isObj(raw)) return roads;
  for (const key of Object.keys(raw)) {
    const m = KEY_RE.exec(key);
    if (!m) continue;
    const cx = Number(m[1]);
    const cy = Number(m[2]);
    if (!inBounds(cx, cy, grid.cols, grid.rows) || occ[cy * grid.cols + cx]) continue;
    const rec = isObj(raw[key]) ? raw[key] : {};
    const cell = { out: (toInt(rec.out) ?? 0) & 15 };
    const limit = toNumber(rec.limit);
    if (limit !== null && limit < 1) cell.limit = fit(LIMIT_SPEC, limit, 1);
    roads[key] = cell;
  }
  pruneLinks(roads);
  return roads;
}

function normalizeFleets(raw, depotIds) {
  const fleets = arr(raw).filter(isObj).map((r) => sanitizeFleet(r, depotIds));
  assignIds(fleets, 'v');
  const taken = new Set(fleets.map((f) => f.name).filter(Boolean));
  for (const f of fleets) {
    if (f.name) continue;
    f.name = plainOrNumberedName(taken, defaultFleet(f.preset).name);
    taken.add(f.name);
  }
  return fleets;
}

function normalizeFlows(raw, stations, fleetIds) {
  const byId = new Map(stations.map((s) => [s.id, s]));
  const pairs = new Set();
  const flows = [];
  for (const r of arr(raw)) {
    if (!isObj(r)) continue;
    const from = cleanId(r.from);
    const to = cleanId(r.to);
    if (!flowEndpointsValid(byId.get(from), byId.get(to)) || pairs.has(`${from}>${to}`)) continue;
    pairs.add(`${from}>${to}`);
    const fleetId = cleanId(r.fleetId);
    flows.push(sanitizeFlow({ id: cleanId(r.id), from, to }, r, fleetIds.has(fleetId) ? fleetId : null));
  }
  assignIds(flows, 'f');
  return flows;
}

/**
 * Tolerant loader: turns anything object-shaped into a valid layout (defaults filled, numbers clamped, dangling
 * references dropped, road links repaired, ids made unique). Idempotent. Throws only if `raw` is not an object.
 * @param {object} raw
 * @returns {object} a new Layout that shares no references with `raw`
 */
export function normalizeLayout(raw) {
  if (!isObj(raw)) throw new TypeError('normalizeLayout: expected a layout object');
  const grid = normalizeGrid(raw.grid);
  const occ = new Uint8Array(grid.cols * grid.rows);
  const stations = normalizeStations(raw.stations, grid, occ);
  const obstacles = normalizeObstacles(raw.obstacles, grid, occ);
  const labels = normalizeLabels(raw.labels, grid);
  const roads = normalizeRoads(raw.roads, grid, occ);
  const depotIds = new Set(stations.filter((s) => s.type === 'depot').map((s) => s.id));
  const fleets = normalizeFleets(raw.fleets, depotIds);
  const flows = normalizeFlows(raw.flows, stations, new Set(fleets.map((f) => f.id)));
  return {
    schema: SCHEMA_VERSION,
    name: cleanText(raw.name, NAME_MAX, 'Untitled plant'),
    notes: cleanText(raw.notes, NOTES_MAX, '', true),
    grid, roads, obstacles, labels, stations, flows, fleets,
    settings: normalizeSettings(raw.settings),
  };
}

/** Deep copy (structuredClone). */
export function cloneLayout(layout) {
  return structuredClone(layout);
}

// ---------------------------------------------------------------------------------------------------------
// Change classification
// ---------------------------------------------------------------------------------------------------------

function deepEqual(a, b) {
  if (a === b || (a !== a && b !== b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
}

const unionKeys = (a, b) => new Set([...Object.keys(a), ...Object.keys(b)]);
const COSMETIC_KEYS = new Set(['name', 'notes', 'labels', 'obstacles']);

/** Worst change among the settings keys that differ. */
function settingsChangeKind(a, b) {
  if (!isObj(a) || !isObj(b)) return 'structural';
  let kind = 'cosmetic';
  for (const key of unionKeys(a, b)) {
    if (deepEqual(a[key], b[key])) continue;
    if (RUNTIME_KEYS.includes(key)) kind = 'runtime';
    else if (key !== 'duration') return 'structural';
  }
  return kind;
}

/**
 * How much does the running simulation care about the difference between two layouts?
 * 'none' (deep-equal) | 'cosmetic' (only name, notes, labels, obstacles, settings.duration) |
 * 'runtime' (additionally only RUNTIME_KEYS settings) | 'structural' (anything else: rebuild the simulation).
 * @returns {'none'|'cosmetic'|'runtime'|'structural'}
 */
export function layoutChangeKind(prev, next) {
  if (deepEqual(prev, next)) return 'none';
  if (!isObj(prev) || !isObj(next)) return 'structural';
  let kind = 'cosmetic';
  for (const key of unionKeys(prev, next)) {
    if (deepEqual(prev[key], next[key]) || COSMETIC_KEYS.has(key)) continue;
    if (key !== 'settings') return 'structural';
    const k = settingsChangeKind(prev.settings, next.settings);
    if (k === 'structural') return 'structural';
    if (k === 'runtime') kind = 'runtime';
  }
  return kind;
}

// ---------------------------------------------------------------------------------------------------------
// Invariant checker (for tests and debugging)
// ---------------------------------------------------------------------------------------------------------

function checkGridAndSettings(layout, bad) {
  const g = layout.grid;
  const gridOk = isObj(g) && Object.keys(GRID_SPEC).every((k) => fits(GRID_SPEC[k], g[k]));
  if (!gridOk) bad.push('grid: cols/rows/cellSize missing or out of range');
  const s = layout.settings;
  if (!isObj(s)) {
    bad.push('settings: missing');
    return gridOk;
  }
  for (const [k, spec] of Object.entries(SETTINGS_SPEC)) if (!fits(spec, s[k])) bad.push(`settings.${k}: invalid (${s[k]})`);
  for (const [k, values] of Object.entries(SETTINGS_ENUMS)) if (!values.includes(s[k])) bad.push(`settings.${k}: invalid (${s[k]})`);
  return gridOk;
}

function checkRoads(layout, owner, bad) {
  const { cols, rows } = layout.grid;
  if (!isObj(layout.roads)) {
    bad.push('roads: not an object');
    return;
  }
  for (const [key, cell] of Object.entries(layout.roads)) {
    const m = KEY_RE.exec(key);
    if (!m || !inBounds(Number(m[1]), Number(m[2]), cols, rows)) {
      bad.push(`road ${key}: bad key or outside the grid`);
      continue;
    }
    const cx = Number(m[1]);
    const cy = Number(m[2]);
    if (owner[cy * cols + cx]) bad.push(`road ${key}: lies under ${owner[cy * cols + cx]}`);
    if (!isObj(cell) || !Number.isInteger(cell.out) || cell.out < 0 || cell.out > 15) {
      bad.push(`road ${key}: out must be an integer 0..15`);
      continue;
    }
    if ('limit' in cell && !(fits(LIMIT_SPEC, cell.limit) && cell.limit < 1)) bad.push(`road ${key}: limit must be in 0.1..<1`);
    for (let d = 0; d < 4; d++) {
      if (cell.out & DIR_BIT[d] && !Object.hasOwn(layout.roads, cellKey(cx + DX[d], cy + DY[d]))) {
        bad.push(`road ${key}: exit bit ${d} points at a non-road or off-grid cell`);
      }
    }
  }
}

/** Validate a list of id'd rectangles and record who owns which cell. Returns the Map id -> item. */
function checkRects(kind, items, layout, owner, bad, extra) {
  const { cols, rows } = layout.grid;
  const byId = new Map();
  if (!Array.isArray(items)) {
    bad.push(`${kind}s: not an array`);
    return byId;
  }
  for (const it of items) {
    const tag = `${kind} ${it && it.id}`;
    if (!isObj(it) || !isValidId(it.id)) { bad.push(`${tag}: invalid id`); continue; }
    if (byId.has(it.id)) bad.push(`${tag}: duplicate id`);
    byId.set(it.id, it);
    const geometryOk = ['x', 'y', 'w', 'h'].every((k) => Number.isInteger(it[k])) && it.w >= 1 && it.h >= 1
      && it.x >= 0 && it.y >= 0 && it.x + it.w <= cols && it.y + it.h <= rows;
    if (!geometryOk) { bad.push(`${tag}: rectangle invalid or outside the grid`); continue; }
    for (let y = it.y; y < it.y + it.h; y++) {
      for (let x = it.x; x < it.x + it.w; x++) {
        if (owner[y * cols + x]) bad.push(`${tag}: overlaps ${owner[y * cols + x]} at ${x},${y}`);
        else owner[y * cols + x] = tag;
      }
    }
    extra(it, tag);
  }
  return byId;
}

function checkStation(s, tag, bad) {
  if (typeof s.name !== 'string' || !s.name.trim()) bad.push(`${tag}: empty name`);
  if (!hasKey(STATION_TYPES, s.type)) {
    bad.push(`${tag}: unknown type`);
    return;
  }
  const base = defaultStationParams(s.type);
  if (!isObj(s.params) || Object.keys(s.params).sort().join() !== Object.keys(base).sort().join()) {
    bad.push(`${tag}: params keys differ from the type's defaults`);
    return;
  }
  for (const [k, v] of Object.entries(s.params)) {
    if (isObj(base[k])) {
      const ok = isObj(v) && DIST_KINDS.includes(v.kind) && fits(DIST_SPEC.mean, v.mean) && fits(DIST_SPEC.spread, v.spread);
      if (!ok) bad.push(`${tag}: params.${k} is not a valid distribution`);
    } else if (!fits(PARAM_SPEC[s.type][k], v)) bad.push(`${tag}: params.${k} invalid (${v})`);
  }
  if (s.type === 'depot' && s.params.chargers > s.params.slots) bad.push(`${tag}: more chargers than slots`);
}

function checkFlows(layout, stations, fleets, bad) {
  const ids = new Set();
  const pairs = new Set();
  if (!Array.isArray(layout.flows)) bad.push('flows: not an array');
  for (const f of arr(layout.flows)) {
    const tag = `flow ${f && f.id}`;
    if (!isObj(f) || !isValidId(f.id)) { bad.push(`${tag}: invalid id`); continue; }
    if (ids.has(f.id)) bad.push(`${tag}: duplicate id`);
    ids.add(f.id);
    if (!flowEndpointsValid(stations.get(f.from), stations.get(f.to))) bad.push(`${tag}: endpoints missing or not allowed`);
    if (pairs.has(`${f.from}>${f.to}`)) bad.push(`${tag}: duplicate ordered pair`);
    pairs.add(`${f.from}>${f.to}`);
    for (const [k, spec] of Object.entries(FLOW_SPEC)) if (!fits(spec, f[k])) bad.push(`${tag}: ${k} invalid (${f[k]})`);
    if (f.batchMax > 0 && f.batchMin > f.batchMax) bad.push(`${tag}: batchMin exceeds batchMax`);
    if (f.fleetId !== null && !fleets.has(f.fleetId)) bad.push(`${tag}: fleetId points at no fleet`);
  }
}

function checkFleets(layout, stations, bad) {
  const byId = new Map();
  if (!Array.isArray(layout.fleets)) bad.push('fleets: not an array');
  for (const f of arr(layout.fleets)) {
    const tag = `fleet ${f && f.id}`;
    if (!isObj(f) || !isValidId(f.id)) { bad.push(`${tag}: invalid id`); continue; }
    if (byId.has(f.id)) bad.push(`${tag}: duplicate id`);
    byId.set(f.id, f);
    if (typeof f.name !== 'string' || !f.name.trim()) bad.push(`${tag}: empty name`);
    if (!hasKey(FLEET_PRESETS, f.preset)) bad.push(`${tag}: unknown preset`);
    for (const [k, spec] of Object.entries(FLEET_SPEC)) if (!fits(spec, f[k])) bad.push(`${tag}: ${k} invalid (${f[k]})`);
    const b = f.battery;
    if (!isObj(b) || typeof b.enabled !== 'boolean' || !Object.entries(BATTERY_SPEC).every(([k, spec]) => fits(spec, b[k]))) bad.push(`${tag}: battery invalid`);
    else if (b.resumePct < b.lowPct) bad.push(`${tag}: battery resumePct below lowPct`);
    if (f.home !== null && !(stations.get(f.home) && stations.get(f.home).type === 'depot')) bad.push(`${tag}: home is not a depot`);
    if (f.idle !== 'park' && f.idle !== 'stay') bad.push(`${tag}: idle must be park or stay`);
    if (typeof f.color !== 'string' || !COLOR_RE.test(f.color)) bad.push(`${tag}: color invalid`);
  }
  return byId;
}

function checkLabels(layout, bad) {
  const ids = new Set();
  if (!Array.isArray(layout.labels)) bad.push('labels: not an array');
  for (const l of arr(layout.labels)) {
    const tag = `label ${l && l.id}`;
    if (!isObj(l) || !isValidId(l.id)) { bad.push(`${tag}: invalid id`); continue; }
    if (ids.has(l.id)) bad.push(`${tag}: duplicate id`);
    ids.add(l.id);
    const { cols, rows } = layout.grid;
    if (!(Number.isFinite(l.x) && Number.isFinite(l.y) && l.x >= 0 && l.y >= 0 && l.x <= cols && l.y <= rows)) bad.push(`${tag}: position outside the grid`);
    if (typeof l.text !== 'string' || !l.text.trim()) bad.push(`${tag}: empty text`);
    if ('size' in l && !fits(LABEL_SIZE_SPEC, l.size)) bad.push(`${tag}: size invalid`);
  }
}

/**
 * Everything wrong with a layout, as human-readable strings ([] = all invariants of §4.1–4.3 hold).
 * Independent of normalizeLayout on purpose: tests assert `checkInvariants(normalizeLayout(junk))` is empty.
 * @param {object} layout
 * @returns {string[]}
 */
export function checkInvariants(layout) {
  if (!isObj(layout)) return ['layout is not an object'];
  const bad = [];
  if (layout.schema !== SCHEMA_VERSION) bad.push(`schema must be ${SCHEMA_VERSION}`);
  if (typeof layout.name !== 'string' || !layout.name.trim()) bad.push('name must be a non-empty string');
  if (typeof layout.notes !== 'string') bad.push('notes must be a string');
  if (!checkGridAndSettings(layout, bad)) return bad;
  const owner = new Array(layout.grid.cols * layout.grid.rows);
  const stations = checkRects('station', layout.stations, layout, owner, bad, (s, tag) => checkStation(s, tag, bad));
  checkRects('obstacle', layout.obstacles, layout, owner, bad, (o, tag) => {
    if (!OBSTACLE_KINDS.includes(o.kind)) bad.push(`${tag}: unknown kind`);
  });
  checkRoads(layout, owner, bad);
  checkLabels(layout, bad);
  const fleets = checkFleets(layout, stations, bad);
  checkFlows(layout, stations, fleets, bad);
  return bad;
}

// ---------------------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------------------

/** Station by id, or null. */
export const getStation = (layout, id) => layout.stations.find((s) => s.id === id) || null;
/** Flow by id, or null. */
export const getFlow = (layout, id) => layout.flows.find((f) => f.id === id) || null;
/** Fleet by id, or null. */
export const getFleet = (layout, id) => layout.fleets.find((f) => f.id === id) || null;

/** Station covering cell (cx, cy), or null. */
export const stationAt = (layout, cx, cy) => layout.stations.find((s) => inRect(cx, cy, s)) || null;
/** Obstacle covering cell (cx, cy), or null. */
export const obstacleAt = (layout, cx, cy) => layout.obstacles.find((o) => inRect(cx, cy, o)) || null;
/** Topmost (last added) label whose anchor lies in cell (cx, cy), or null. */
export function labelAt(layout, cx, cy) {
  for (let i = layout.labels.length - 1; i >= 0; i--) {
    const l = layout.labels[i];
    if (Math.floor(l.x) === cx && Math.floor(l.y) === cy) return l;
  }
  return null;
}

const roadRec = (layout, cx, cy) => (Object.hasOwn(layout.roads, cellKey(cx, cy)) ? layout.roads[cellKey(cx, cy)] : null);

/** Road cell data `{ out, limit }` (limit defaults to 1), or null if (cx, cy) is not a road cell. */
export function roadAt(layout, cx, cy) {
  const rec = roadRec(layout, cx, cy);
  return rec ? { out: rec.out, limit: rec.limit ?? 1 } : null;
}

/** Does a directed link leave road cell (cx, cy) in direction `dir` into another road cell? */
export function hasLink(layout, cx, cy, dir) {
  const rec = roadRec(layout, cx, cy);
  return !!rec && (rec.out & DIR_BIT[dir]) !== 0 && roadRec(layout, cx + DX[dir], cy + DY[dir]) !== null;
}

/** In bounds and not covered by a station/obstacle (roads are ignored). */
export function isCellFree(layout, cx, cy, opts) {
  const { ignoreStation, ignoreObstacle } = opts ?? {};
  if (!Number.isInteger(cx) || !Number.isInteger(cy) || !inBounds(cx, cy, layout.grid.cols, layout.grid.rows)) return false;
  const s = stationAt(layout, cx, cy);
  if (s && s.id !== ignoreStation) return false;
  const o = obstacleAt(layout, cx, cy);
  return !o || o.id === ignoreObstacle;
}

/** Does any road cell lie inside the rectangle? Scans whichever is smaller: the rectangle or the road map. */
function hasRoadIn(layout, r) {
  if (r.w * r.h <= 1024) {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) if (roadRec(layout, x, y)) return true;
    }
    return false;
  }
  return Object.keys(layout.roads).some((key) => {
    const [cx, cy] = parseKey(key);
    return inRect(cx, cy, r);
  });
}

/** Is an integer rectangle inside the grid and clear of stations/obstacles (and of roads unless `allowRoads`)? */
export function isRectFree(layout, rect, opts) {
  const { ignoreStation, ignoreObstacle, allowRoads = false } = opts ?? {};
  if (!isObj(rect) || !['x', 'y', 'w', 'h'].every((k) => Number.isInteger(rect[k])) || rect.w < 1 || rect.h < 1) return false;
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > layout.grid.cols || rect.y + rect.h > layout.grid.rows) return false;
  if (layout.stations.some((s) => s.id !== ignoreStation && rectsOverlap(rect, s))) return false;
  if (layout.obstacles.some((o) => o.id !== ignoreObstacle && rectsOverlap(rect, o))) return false;
  return allowRoads || !hasRoadIn(layout, rect);
}

/** Road cells edge-adjacent to the station, in reading order (top to bottom, left to right). */
export function docksOf(layout, stationId) {
  const s = getStation(layout, stationId);
  if (!s) return [];
  return perimeterCells(s)
    .filter(([cx, cy]) => roadRec(layout, cx, cy) !== null)
    .map(([cx, cy]) => [cx, cy])
    .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

/** Flows leaving the station. */
export const flowsFrom = (layout, stationId) => layout.flows.filter((f) => f.from === stationId);
/** Flows arriving at the station. */
export const flowsTo = (layout, stationId) => layout.flows.filter((f) => f.to === stationId);

/** Number of road cells. */
export const roadCellCount = (layout) => Object.keys(layout.roads).length;
/** Road length in metres (road cells x cell size). */
export const roadLengthMeters = (layout) => roadCellCount(layout) * layout.grid.cellSize;

// ---------------------------------------------------------------------------------------------------------
// Road mutators
// ---------------------------------------------------------------------------------------------------------

/** Add the directed link a -> b (adjacent road cells) and, if `both`, b -> a. */
function linkCells(layout, a, b, both) {
  const d = dirFromTo(a[0], a[1], b[0], b[1]);
  roadRec(layout, a[0], a[1]).out |= DIR_BIT[d];
  if (both) roadRec(layout, b[0], b[1]).out |= DIR_BIT[opposite(d)];
}

/** Expand a stroke into consecutive 4-neighbour cells, filling gaps with lPath. Junk or absurdly long gaps end it. */
function expandStroke(cells, grid) {
  const path = [];
  const maxGap = 4 * (grid.cols + grid.rows);
  for (const c of arr(cells)) {
    if (!Array.isArray(c) || !Number.isInteger(c[0]) || !Number.isInteger(c[1])) break;
    if (!path.length) { path.push([c[0], c[1]]); continue; }
    const [px, py] = path[path.length - 1];
    if (px === c[0] && py === c[1]) continue;
    if (Math.abs(c[0] - px) + Math.abs(c[1] - py) > maxGap) break;
    path.push(...lPath(px, py, c[0], c[1]).slice(1));
  }
  return path;
}

/**
 * Paint a road stroke. Missing road cells are created, links P->Q (and Q->P unless `oneWay`) are ADDED along
 * the stroke (existing links are never removed, so a one-way stroke over a two-way road changes nothing).
 * The stroke stops before the first cell that is out of bounds or covered by a station/obstacle.
 * @param {number[][]} cells consecutive cells; non-adjacent neighbours are connected with an L-shaped path
 * @returns {number} distinct stroke cells accepted
 */
export function paintRoadPath(layout, cells, opts) {
  const oneWay = !!(opts ?? {}).oneWay;
  const accepted = new Set();
  let prev = null;
  for (const cell of expandStroke(cells, layout.grid)) {
    if (!isCellFree(layout, cell[0], cell[1])) break;
    paintRoadCell(layout, cell[0], cell[1]);
    if (prev) linkCells(layout, prev, cell, !oneWay);
    accepted.add(cellKey(cell[0], cell[1]));
    prev = cell;
  }
  return accepted.size;
}

/** Create a lone road cell (no links). False if it exists already or the cell is blocked. */
export function paintRoadCell(layout, cx, cy) {
  if (!isCellFree(layout, cx, cy) || roadRec(layout, cx, cy)) return false;
  layout.roads[cellKey(cx, cy)] = { out: 0 };
  return true;
}

/** Remove a road cell and every link into it. False if there was no road. */
export function eraseRoadCell(layout, cx, cy) {
  if (!roadRec(layout, cx, cy)) return false;
  delete layout.roads[cellKey(cx, cy)];
  for (let d = 0; d < 4; d++) {
    const n = roadRec(layout, cx + DX[d], cy + DY[d]);
    if (n) n.out &= ~DIR_BIT[opposite(d)];
  }
  return true;
}

/** Remove the directed link leaving (cx, cy) in direction `dir`. False if there was none. */
export function eraseLink(layout, cx, cy, dir) {
  const rec = roadRec(layout, cx, cy);
  if (!rec || !Number.isInteger(dir) || dir < 0 || dir > 3 || !(rec.out & DIR_BIT[dir])) return false;
  rec.out &= ~DIR_BIT[dir];
  return true;
}

/** Set the speed factor of a road cell (0.1..1; 1 removes the slow zone). True if the cell changed. */
export function setRoadLimit(layout, cx, cy, limit) {
  const rec = roadRec(layout, cx, cy);
  const n = toNumber(limit);
  if (!rec || n === null) return false;
  const next = fit(LIMIT_SPEC, n, 1);
  if (next >= 1) {
    if (!('limit' in rec)) return false;
    delete rec.limit;
    return true;
  }
  if (rec.limit === next) return false;
  rec.limit = next;
  return true;
}

/**
 * Cycle the link between road cell (cx, cy) and its neighbour in `dir`:
 * two-way -> (cx,cy)->neighbour only -> neighbour->(cx,cy) only -> two-way. False if the cells are not linked.
 */
export function flipRoadDirection(layout, cx, cy, dir) {
  if (!Number.isInteger(dir) || dir < 0 || dir > 3) return false;
  const a = roadRec(layout, cx, cy);
  const b = roadRec(layout, cx + DX[dir], cy + DY[dir]);
  if (!a || !b) return false;
  const ab = (a.out & DIR_BIT[dir]) !== 0;
  const ba = (b.out & DIR_BIT[opposite(dir)]) !== 0;
  if (!ab && !ba) return false;
  const nextAb = !ab || ba; // both -> a->b only; a->b only -> off; b->a only -> on
  const nextBa = !ab || !ba; // both -> off; a->b only -> on; b->a only -> on
  a.out = nextAb ? a.out | DIR_BIT[dir] : a.out & ~DIR_BIT[dir];
  b.out = nextBa ? b.out | DIR_BIT[opposite(dir)] : b.out & ~DIR_BIT[opposite(dir)];
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Station mutators
// ---------------------------------------------------------------------------------------------------------

/**
 * Add a station. Null if the type is unknown or the rectangle is out of bounds / overlaps a station, obstacle or road.
 * @param {{type: string, x: number, y: number, w?: number, h?: number, name?: string, params?: object}} spec
 */
export function addStation(layout, spec) {
  if (!isObj(spec) || !hasKey(STATION_TYPES, spec.type)) return null;
  const meta = STATION_TYPES[spec.type];
  const rect = { x: toInt(spec.x), y: toInt(spec.y), w: toInt(spec.w ?? meta.size.w), h: toInt(spec.h ?? meta.size.h) };
  if (Object.values(rect).includes(null) || !isRectFree(layout, rect)) return null;
  const taken = new Set(layout.stations.map((s) => s.name));
  const station = defaultStation(spec.type, {
    id: nextId('s', layout.stations.map((s) => s.id)),
    name: cleanText(spec.name, NAME_MAX) || numberedName(taken, meta.short),
    ...rect,
    params: mergeParams(spec.type, defaultStationParams(spec.type), spec.params),
  });
  layout.stations.push(station);
  return station;
}

/** Move a station to (x, y). False if unknown or blocked (including by roads). */
export function moveStation(layout, id, x, y) {
  return updateStation(layout, id, { x, y });
}

/** Give a station a new rectangle `{x, y, w, h}`. False if unknown or blocked (including by roads). */
export function resizeStation(layout, id, rect) {
  return isObj(rect) && ['x', 'y', 'w', 'h'].every((k) => rect[k] !== undefined) && updateStation(layout, id, rect);
}

/**
 * Patch a station: `name`, geometry (`x,y,w,h`) and `params` (merged one level deep; distributions merge field by
 * field; values are clamped). `id` and `type` cannot change. Atomic: a blocked geometry rejects the whole patch.
 */
export function updateStation(layout, id, patch) {
  const s = getStation(layout, id);
  if (!s || !isObj(patch)) return false;
  const rect = { x: s.x, y: s.y, w: s.w, h: s.h };
  let moved = false;
  for (const key of Object.keys(rect)) {
    if (patch[key] === undefined) continue;
    rect[key] = toInt(patch[key]);
    moved = true;
  }
  if (moved && (Object.values(rect).includes(null) || !isRectFree(layout, rect, { ignoreStation: id }))) return false;
  if (patch.name !== undefined) s.name = cleanText(patch.name, NAME_MAX, s.name);
  if (moved) Object.assign(s, rect);
  if (patch.params !== undefined) s.params = mergeParams(s.type, s.params, patch.params);
  return true;
}

/** Remove a station together with its flows; fleets homed there lose their home. False if unknown. */
export function removeStation(layout, id) {
  const i = layout.stations.findIndex((s) => s.id === id);
  if (i < 0) return false;
  layout.stations.splice(i, 1);
  layout.flows = layout.flows.filter((f) => f.from !== id && f.to !== id);
  for (const fleet of layout.fleets) if (fleet.home === id) fleet.home = null;
  return true;
}

/** Nearest free rectangle (Chebyshev rings around `base`, closest first), or null. */
function findFreeSpot(layout, base) {
  const maxRing = Math.max(layout.grid.cols, layout.grid.rows);
  for (let r = 0; r <= maxRing; r++) {
    const ring = r === 0 ? [[0, 0]] : [];
    for (let i = -r; r > 0 && i <= r; i++) ring.push([i, -r], [i, r]);
    for (let j = -r + 1; r > 0 && j < r; j++) ring.push([-r, j], [r, j]);
    ring.sort((a, b) => a[0] ** 2 + a[1] ** 2 - b[0] ** 2 - b[1] ** 2 || a[1] - b[1] || a[0] - b[0]);
    for (const [dx, dy] of ring) {
      const rect = { x: base.x + dx, y: base.y + dy, w: base.w, h: base.h };
      if (isRectFree(layout, rect)) return rect;
    }
  }
  return null;
}

/**
 * Copy a station (type, size, parameters; not its flows) to the free spot nearest to `(x+dx, y+dy)`.
 * Offsets default to one cell, which always overlaps the original, so the nearest free spot is used.
 */
export function duplicateStation(layout, id, offset) {
  const { dx = 1, dy = 1 } = offset ?? {};
  const s = getStation(layout, id);
  const ox = toInt(dx);
  const oy = toInt(dy);
  if (!s || ox === null || oy === null) return null;
  const spot = findFreeSpot(layout, { x: s.x + ox, y: s.y + oy, w: s.w, h: s.h });
  if (!spot) return null;
  return addStation(layout, {
    type: s.type, ...spot, name: copyName(new Set(layout.stations.map((o) => o.name)), s.name), params: structuredClone(s.params),
  });
}

// ---------------------------------------------------------------------------------------------------------
// Flow mutators
// ---------------------------------------------------------------------------------------------------------

function flowEndpointsOk(layout, from, to, ignoreFlowId) {
  return flowEndpointsValid(getStation(layout, from), getStation(layout, to))
    && !layout.flows.some((f) => f.id !== ignoreFlowId && f.from === from && f.to === to);
}

/** Apply numeric fields and `fleetId` of a patch to a flow draft. False if `fleetId` names no fleet. */
function applyFlowPatch(layout, flow, patch) {
  for (const key of Object.keys(FLOW_SPEC)) if (patch[key] !== undefined) flow[key] = fit(FLOW_SPEC[key], patch[key], flow[key]);
  if (patch.fleetId !== undefined) {
    if (patch.fleetId === null || patch.fleetId === '') flow.fleetId = null;
    else if (getFleet(layout, patch.fleetId)) flow.fleetId = patch.fleetId;
    else return false;
  }
  reconcileBatch(flow, patch.batchMin !== undefined && patch.batchMax === undefined ? 'min' : 'max');
  return true;
}

/**
 * Add a material flow `from` -> `to` (§4.3 rules: source/process/storage to process/storage/sink, no self flow,
 * one flow per ordered pair). Null if invalid or duplicate.
 */
export function addFlow(layout, from, to, patch = {}) {
  if (!flowEndpointsOk(layout, from, to)) return null;
  const flow = defaultFlow({ id: nextId('f', layout.flows.map((f) => f.id)), from, to });
  if (isObj(patch) && !applyFlowPatch(layout, flow, patch)) return null;
  layout.flows.push(flow);
  return flow;
}

/** Patch a flow (`weight, perCycle, batchMin, batchMax, maxWait, priority, fleetId, from, to`). Atomic. */
export function updateFlow(layout, id, patch) {
  const flow = getFlow(layout, id);
  if (!flow || !isObj(patch)) return false;
  const draft = { ...flow };
  for (const key of ['from', 'to']) if (patch[key] !== undefined) draft[key] = patch[key];
  if (!flowEndpointsOk(layout, draft.from, draft.to, id) || !applyFlowPatch(layout, draft, patch)) return false;
  Object.assign(flow, draft);
  return true;
}

/** Delete a flow. False if it does not exist. */
export function removeFlow(layout, id) {
  const i = layout.flows.findIndex((f) => f.id === id);
  if (i < 0) return false;
  layout.flows.splice(i, 1);
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Fleet mutators
// ---------------------------------------------------------------------------------------------------------

/** Apply a fleet patch to a draft (battery merged). False if `home` is not a depot of this layout. */
function applyFleetPatch(layout, fleet, patch) {
  for (const key of Object.keys(FLEET_SPEC)) if (patch[key] !== undefined) fleet[key] = fit(FLEET_SPEC[key], patch[key], fleet[key]);
  if (patch.name !== undefined) fleet.name = cleanText(patch.name, NAME_MAX, fleet.name);
  if (hasKey(FLEET_PRESETS, patch.preset)) fleet.preset = patch.preset;
  if (typeof patch.color === 'string' && COLOR_RE.test(patch.color)) fleet.color = patch.color;
  if (patch.idle === 'park' || patch.idle === 'stay') fleet.idle = patch.idle;
  if (patch.battery !== undefined) fleet.battery = sanitizeBattery({ ...fleet.battery, ...(isObj(patch.battery) ? patch.battery : {}) }, fleet.battery);
  if (patch.home !== undefined) {
    const depot = patch.home === null || patch.home === '' ? null : getStation(layout, patch.home);
    if (depot && depot.type !== 'depot') return false;
    if (patch.home && !depot) return false;
    fleet.home = depot ? depot.id : null;
  }
  return true;
}

/**
 * Add a fleet from a preset ('agv' | 'forklift' | 'tugger' | 'custom'; unknown -> custom) and optional overrides
 * (same fields as updateFleet; an invalid `home` is ignored). The name is the preset's, numbered if already taken.
 */
export function addFleet(layout, preset = 'agv', patch = {}) {
  const kind = hasKey(FLEET_PRESETS, preset) ? preset : 'custom';
  const taken = new Set(layout.fleets.map((f) => f.name));
  const fleet = defaultFleet(kind, { id: nextId('v', layout.fleets.map((f) => f.id)) });
  fleet.name = plainOrNumberedName(taken, fleet.name);
  if (isObj(patch)) applyFleetPatch(layout, fleet, patch);
  layout.fleets.push(fleet);
  return fleet;
}

/** Patch a fleet (any field of the fleet; `battery` is merged). False if unknown or `home` is not a depot. */
export function updateFleet(layout, id, patch) {
  const fleet = getFleet(layout, id);
  if (!fleet || !isObj(patch)) return false;
  const draft = { ...fleet, battery: { ...fleet.battery } };
  if (!applyFleetPatch(layout, draft, patch)) return false;
  Object.assign(fleet, draft);
  return true;
}

/** Remove a fleet; flows restricted to it become unrestricted. */
export function removeFleet(layout, id) {
  const i = layout.fleets.findIndex((f) => f.id === id);
  if (i < 0) return false;
  layout.fleets.splice(i, 1);
  for (const flow of layout.flows) if (flow.fleetId === id) flow.fleetId = null;
  return true;
}

/** Copy a fleet (same settings and home) under a new id and the next free numbered name; null if unknown. */
export function duplicateFleet(layout, id) {
  const src = getFleet(layout, id);
  if (!src) return null;
  const copy = structuredClone(src);
  copy.id = nextId('v', layout.fleets.map((f) => f.id));
  copy.name = copyName(new Set(layout.fleets.map((f) => f.name)), src.name);
  layout.fleets.push(copy);
  return copy;
}

// ---------------------------------------------------------------------------------------------------------
// Obstacles and labels
// ---------------------------------------------------------------------------------------------------------

/** Add an obstacle (`kind` defaults to 'wall', size to 1x1). Null if blocked by a station/obstacle/road or out of bounds. */
export function addObstacle(layout, spec) {
  if (!isObj(spec)) return null;
  const rect = { x: toInt(spec.x), y: toInt(spec.y), w: toInt(spec.w ?? 1), h: toInt(spec.h ?? 1) };
  if (Object.values(rect).includes(null) || !isRectFree(layout, rect)) return null;
  const obstacle = { id: nextId('o', layout.obstacles.map((o) => o.id)), ...rect, kind: OBSTACLE_KINDS.includes(spec.kind) ? spec.kind : 'wall' };
  layout.obstacles.push(obstacle);
  return obstacle;
}

/** Patch an obstacle's `x, y, w, h` and `kind`. Atomic; false if blocked or the kind is unknown. */
export function updateObstacle(layout, id, patch) {
  const o = layout.obstacles.find((e) => e.id === id);
  if (!o || !isObj(patch)) return false;
  const rect = { x: o.x, y: o.y, w: o.w, h: o.h };
  let moved = false;
  for (const key of Object.keys(rect)) {
    if (patch[key] === undefined) continue;
    rect[key] = toInt(patch[key]);
    moved = true;
  }
  if (moved && (Object.values(rect).includes(null) || !isRectFree(layout, rect, { ignoreObstacle: id }))) return false;
  if (patch.kind !== undefined && !OBSTACLE_KINDS.includes(patch.kind)) return false;
  Object.assign(o, rect);
  if (patch.kind !== undefined) o.kind = patch.kind;
  return true;
}

/** Delete an obstacle. False if it does not exist. */
export function removeObstacle(layout, id) {
  const i = layout.obstacles.findIndex((o) => o.id === id);
  if (i < 0) return false;
  layout.obstacles.splice(i, 1);
  return true;
}

const clampPoint = (layout, x, y) => [clamp(x, 0, layout.grid.cols) + 0, clamp(y, 0, layout.grid.rows) + 0];

/** Add a text label at (x, y) cells (clamped to the grid; empty text becomes "Label"). Null if x/y are not numbers. */
export function addLabel(layout, spec) {
  const x = isObj(spec) ? toNumber(spec.x) : null;
  const y = isObj(spec) ? toNumber(spec.y) : null;
  if (x === null || y === null) return null;
  const [px, py] = clampPoint(layout, x, y);
  const label = { id: nextId('l', layout.labels.map((l) => l.id)), x: px, y: py, text: cleanText(spec.text, TEXT_MAX, 'Label') };
  const size = toNumber(spec.size);
  if (size !== null) label.size = fit(LABEL_SIZE_SPEC, size, 1);
  layout.labels.push(label);
  return label;
}

/** Patch a label's `x, y` (clamped), `text` (empty keeps the old text) and `size` (null/'' removes it). */
export function updateLabel(layout, id, patch) {
  const label = layout.labels.find((l) => l.id === id);
  if (!label || !isObj(patch)) return false;
  const x = patch.x === undefined ? label.x : toNumber(patch.x);
  const y = patch.y === undefined ? label.y : toNumber(patch.y);
  if (x === null || y === null) return false;
  [label.x, label.y] = clampPoint(layout, x, y);
  if (patch.text !== undefined) label.text = cleanText(patch.text, TEXT_MAX, label.text);
  if (patch.size === null || patch.size === '') delete label.size;
  else if (toNumber(patch.size) !== null) label.size = fit(LABEL_SIZE_SPEC, patch.size, 1);
  return true;
}

/** Delete a label. False if it does not exist. */
export function removeLabel(layout, id) {
  const i = layout.labels.findIndex((l) => l.id === id);
  if (i < 0) return false;
  layout.labels.splice(i, 1);
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Plant name, notes and settings
// ---------------------------------------------------------------------------------------------------------

/** Rename the plant (control characters become spaces, 80 characters at most; an empty name keeps the old one). Always true. */
export function setName(layout, name) {
  layout.name = cleanText(name, NAME_MAX, layout.name);
  return true;
}

/** Replace the plant notes (multi-line text, 20000 characters at most; empty clears them). Always true. */
export function setNotes(layout, notes) {
  layout.notes = cleanText(notes, NOTES_MAX, '', true);
  return true;
}

/**
 * Patch `layout.settings`: numbers are clamped to their range, enumerations (`dispatch`, `routing`, `handedness`,
 * `deadlock`) must name a known option. A field whose new value is unusable (NaN, '', an unknown option) and keys
 * that are not settings keep their current value. False only if `patch` is not an object.
 */
export function updateSettings(layout, patch) {
  if (!isObj(patch)) return false;
  for (const [key, spec] of Object.entries(SETTINGS_SPEC)) {
    if (patch[key] !== undefined) layout.settings[key] = fit(spec, patch[key], layout.settings[key]);
  }
  for (const [key, values] of Object.entries(SETTINGS_ENUMS)) {
    if (values.includes(patch[key])) layout.settings[key] = patch[key];
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Grid mutators
// ---------------------------------------------------------------------------------------------------------

/**
 * Resize the grid (clamped to GRID_LIMITS). Roads and labels outside are dropped, stations and obstacles are
 * clipped (dropped, with their flows, if nothing remains). `removed` counts dropped road cells, stations,
 * obstacles and labels; clipped ones are not counted.
 * @returns {{removed: number}}
 */
export function resizeGrid(layout, cols, rows) {
  const c = fit(GRID_SPEC.cols, cols, layout.grid.cols);
  const r = fit(GRID_SPEC.rows, rows, layout.grid.rows);
  layout.grid.cols = c;
  layout.grid.rows = r;
  let removed = 0;
  for (const key of Object.keys(layout.roads)) {
    const [cx, cy] = parseKey(key);
    if (inBounds(cx, cy, c, r)) continue;
    delete layout.roads[key];
    removed++;
  }
  pruneLinks(layout.roads);
  for (const s of [...layout.stations]) {
    const clipped = clipRect(s, c, r);
    if (clipped) Object.assign(s, clipped);
    else {
      removeStation(layout, s.id);
      removed++;
    }
  }
  const kept = [];
  for (const o of layout.obstacles) {
    const clipped = clipRect(o, c, r);
    if (clipped) kept.push(Object.assign(o, clipped));
  }
  removed += layout.obstacles.length - kept.length;
  layout.obstacles = kept;
  const labels = layout.labels.filter((l) => l.x <= c && l.y <= r);
  removed += layout.labels.length - labels.length;
  layout.labels = labels;
  return { removed };
}

/** Set the cell size in metres (clamped to 0.5..10). False if `cellSize` is not a number. */
export function setCellSize(layout, cellSize) {
  const n = toNumber(cellSize);
  if (n === null) return false;
  layout.grid.cellSize = fit(GRID_SPEC.cellSize, n, layout.grid.cellSize);
  return true;
}

/** Shift everything by whole cells. False (nothing changed) if the shift would push anything off the grid. */
export function translateAll(layout, dx, dy) {
  const ox = toInt(dx);
  const oy = toInt(dy);
  if (ox === null || oy === null) return false;
  const { cols, rows } = layout.grid;
  const rects = [...layout.stations, ...layout.obstacles];
  const roadKeys = Object.keys(layout.roads);
  const inside = rects.every((e) => e.x + ox >= 0 && e.y + oy >= 0 && e.x + e.w + ox <= cols && e.y + e.h + oy <= rows)
    && roadKeys.every((key) => {
      const [cx, cy] = parseKey(key);
      return inBounds(cx + ox, cy + oy, cols, rows);
    })
    && layout.labels.every((l) => l.x + ox >= 0 && l.y + oy >= 0 && l.x + ox <= cols && l.y + oy <= rows);
  if (!inside) return false;
  const roads = {};
  for (const key of roadKeys) {
    const [cx, cy] = parseKey(key);
    roads[cellKey(cx + ox, cy + oy)] = layout.roads[key];
  }
  layout.roads = roads;
  for (const e of rects) {
    e.x += ox;
    e.y += oy;
  }
  for (const l of layout.labels) {
    l.x += ox;
    l.y += oy;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------
// Growing and trimming the plan (the canvas extends with the work: docs/ARCHITECTURE.md 4.6)
// ---------------------------------------------------------------------------------------------------------

/** A whole number of cells, never negative (fractions are rounded, junk counts as 0). */
const cellCount = (v) => Math.max(0, toInt(v) ?? 0);

/**
 * The smallest cell rectangle {x, y, w, h} that holds everything on the plan: road cells, stations, obstacles and
 * labels (a label counts as the cell its anchor lies in). Null for an empty plan.
 */
export function contentBounds(layout) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const take = (ax, ay, bx, by) => {
    if (ax < x0) x0 = ax;
    if (ay < y0) y0 = ay;
    if (bx > x1) x1 = bx;
    if (by > y1) y1 = by;
  };
  for (const key of Object.keys(layout.roads)) {
    const [cx, cy] = parseKey(key);
    take(cx, cy, cx + 1, cy + 1);
  }
  for (const e of layout.stations) take(e.x, e.y, e.x + e.w, e.y + e.h);
  for (const e of layout.obstacles) take(e.x, e.y, e.x + e.w, e.y + e.h);
  for (const l of layout.labels) take(Math.floor(l.x), Math.floor(l.y), Math.floor(l.x) + 1, Math.floor(l.y) + 1);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * Add cells to the sides of the baseplate. Everything on the plan keeps its place relative to everything else: what
 * lies right of or below the new cells moves with them (the whole plan is shifted by `left` columns and `top` rows
 * with translateAll), so nothing is ever lost and the node order of the road graph (row by row, left to right) is kept.
 * The result is clamped to GRID_LIMITS: when the request does not fit, `left` (and `top`) are served first and `right`
 * (and `bottom`) get what is left; the returned numbers are what was really added.
 * @param {object} layout edited in place
 * @param {{ left?: number, top?: number, right?: number, bottom?: number }} [sides] cells to add; negative or junk counts as 0
 * @returns {{ dx: number, dy: number, left: number, top: number, right: number, bottom: number, cols: number, rows: number }}
 *   `dx` / `dy`: how far the content moved in cells (= `left` / `top`); `cols` / `rows`: the new size
 */
export function growGrid(layout, sides) {
  const want = isObj(sides) ? sides : {};
  const { cols, rows } = layout.grid;
  const roomX = Math.max(0, GRID_LIMITS.maxCols - cols);
  const roomY = Math.max(0, GRID_LIMITS.maxRows - rows);
  const left = Math.min(cellCount(want.left), roomX);
  const right = Math.min(cellCount(want.right), roomX - left);
  const top = Math.min(cellCount(want.top), roomY);
  const bottom = Math.min(cellCount(want.bottom), roomY - top);
  if (left + right + top + bottom === 0) return { dx: 0, dy: 0, left: 0, top: 0, right: 0, bottom: 0, cols, rows };
  layout.grid.cols = cols + left + right;
  layout.grid.rows = rows + top + bottom;
  if (left || top) translateAll(layout, left, top); // cannot be refused: the grid has just become larger
  return { dx: left, dy: top, left, top, right, bottom, cols: layout.grid.cols, rows: layout.grid.rows };
}

/** One axis of trimGrid: the kept range [from, to) of `size` cells around content [c0, c1), at least `min` cells long. */
function trimAxis(c0, c1, size, margin, min) {
  let from = Math.max(0, c0 - margin);
  let to = Math.min(size, c1 + margin);
  let missing = min - (to - from); // below the minimum size: take cells back, from the far edge first
  if (missing > 0) {
    const more = Math.min(missing, size - to);
    to += more;
    missing -= more;
    from -= Math.min(missing, from);
  }
  return [from, to];
}

/**
 * Shrink the baseplate to the content plus `margin` empty cells on every side (never below the minimum size, never
 * dropping anything: only empty cells are removed, and the content moves up/left by the cells removed there). An empty
 * plan is left alone.
 * @param {object} layout edited in place
 * @param {{ margin?: number }} [opts] default 4
 * @returns {{ changed: boolean, dx: number, dy: number, left: number, top: number, right: number, bottom: number, cols: number, rows: number }}
 *   `left`, `top`, `right`, `bottom`: cells removed from that side as negative numbers (the mirror of growGrid); `dx` / `dy`: the
 *   move of the content in cells (= `left` / `top`)
 */
export function trimGrid(layout, opts) {
  const { cols, rows } = layout.grid;
  const none = { changed: false, dx: 0, dy: 0, left: 0, top: 0, right: 0, bottom: 0, cols, rows };
  const margin = cellCount((opts ?? {}).margin ?? 4);
  const b = contentBounds(layout);
  if (!b) return none;
  const [x0, x1] = trimAxis(b.x, b.x + b.w, cols, margin, GRID_LIMITS.minCols);
  const [y0, y1] = trimAxis(b.y, b.y + b.h, rows, margin, GRID_LIMITS.minRows);
  if (x0 === 0 && y0 === 0 && x1 === cols && y1 === rows) return none;
  if (x0 || y0) translateAll(layout, -x0, -y0); // content only moves inside the old grid: cannot be refused
  layout.grid.cols = x1 - x0;
  layout.grid.rows = y1 - y0;
  return { changed: true, dx: 0 - x0, dy: 0 - y0, left: 0 - x0, top: 0 - y0, right: x1 - cols, bottom: y1 - rows, cols: x1 - x0, rows: y1 - y0 };
}
