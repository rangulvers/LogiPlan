// Helpers of tests/m0.review.test.js: the adversarial review of milestone M0 of the warehouse module (docs/WAREHOUSE-DESIGN.md 9.1).
//
// M0's promise has two halves: (1) NOTHING changes for a plant that uses none of the new features, (2) the seams the next milestones
// plug into are ready. This file holds what the review test needs to attack both halves:
//
//   * the PRE-M0 TREE: the production code of commit eccdca8 (before the first M0 edit of a production file), materialised with
//     `git archive` (read-only) into the temp directory, or given with M0_OLD_TREE=<dir with js/>. Every "old against new" check runs
//     the same plant through both trees. Without git or without that commit (a shallow CI checkout) those checks are skipped; the
//     embedded digests of the review test still pin the results.
//   * run plans and digests: a run is reduced to four short hashes (KPI text, event stream, insights, congestion heat) so that a
//     table of expected values can live in the test file.
//   * hostile input: documents with junk in every place the warehouse module will own (ops, calendar, loadTypes, fleet and flow keys).
//   * an independent oracle of the schema table (docs/WAREHOUSE-DESIGN.md 5.2), written from the document, not from schema.js.
//   * stand-in sanitizers that plug into the registries of M0 (OPS_SANITIZERS, EXTENSION_BLOCKS) the way M1 will.
//   * the mutation harness: a scratch copy of the tree with one deliberate change, run against the golden tests.
//
// Nothing here is imported by production code.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** The commit whose production code is the PRE-M0 tree (the base of the M0 branch; steps 1 of M0 changed tests only). */
export const OLD_REV = process.env.M0_OLD_REV || 'eccdca8';
/** Run the expensive checks (hundreds of plants, 8 hour runs, mutation runs): M0_REVIEW_HEAVY=1. */
export const HEAVY = process.env.M0_REVIEW_HEAVY === '1';
/** Known defects are `todo` tests (they fail, the suite stays green); M0_REVIEW_STRICT=1 makes them ordinary tests. */
export const STRICT = process.env.M0_REVIEW_STRICT === '1';

// ---------------------------------------------------------------------------------------------------------
// The pre-M0 tree
// ---------------------------------------------------------------------------------------------------------

/**
 * Directory of the pre-M0 tree (it holds js/ and package.json), or null when it cannot be had. Cached in the temp directory.
 * `git archive` only reads the repository; nothing in the working tree is touched.
 * @returns {string|null}
 */
export function oldTreeRoot() {
  if (process.env.M0_OLD_TREE) {
    const given = path.resolve(process.env.M0_OLD_TREE);
    return existsSync(path.join(given, 'js', 'sim', 'engine.js')) ? given : null;
  }
  const dir = path.join(os.tmpdir(), `logiplan-m0-old-${OLD_REV}`);
  if (existsSync(path.join(dir, 'js', 'sim', 'engine.js'))) return dir;
  try {
    const archive = spawnSync('git', ['archive', OLD_REV, 'js', 'package.json'], { cwd: ROOT, maxBuffer: 1 << 28 });
    if (archive.status !== 0 || !archive.stdout || archive.stdout.length === 0) return null;
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'logiplan-m0-old-part-'));
    const untar = spawnSync('tar', ['-x', '-C', scratch], { input: archive.stdout, maxBuffer: 1 << 28 });
    if (untar.status !== 0) { rmSync(scratch, { recursive: true, force: true }); return null; }
    try { renameSync(scratch, dir); } catch { rmSync(scratch, { recursive: true, force: true }); }
    return existsSync(path.join(dir, 'js', 'sim', 'engine.js')) ? dir : null;
  } catch {
    return null;
  }
}

/** The modules of a tree (this one by default) that a comparison needs. */
export async function loadTree(root = ROOT) {
  const url = (rel) => pathToFileURL(path.join(root, rel)).href;
  const [{ Simulation }, { EXAMPLES }, layout, serialize, validate] = await Promise.all([
    import(url('js/sim/engine.js')), import(url('js/model/examples.js')), import(url('js/model/layout.js')), import(url('js/model/serialize.js')), import(url('js/model/validate.js')),
  ]);
  return { root, Simulation, EXAMPLES, layout, serialize, validate };
}

// ---------------------------------------------------------------------------------------------------------
// Digests of a run
// ---------------------------------------------------------------------------------------------------------

export const sha = (text, n = 10) => createHash('sha256').update(text).digest('hex').slice(0, n);

/** Keys that the warehouse module added to the payloads of events (loads and orders, docs/WAREHOUSE-DESIGN.md 5.4): not part of "old behaviour". */
export const SEAM_KEYS = new Set(['ty', 'tk', 'at', 'slot', 'pickAt', 'dropAt', 'pickExtra', 'dropExtra']);

/**
 * A payload as plain data, safe to stringify: objects of a class (stations, vehicles) become their id, cycles are cut, the seam keys of
 * loads and orders are left out, -0 is spelled out (JSON.stringify prints it as 0).
 */
export function safe(v, depth = 0, seen = new Set()) {
  if (v === null || typeof v !== 'object') return typeof v === 'number' && Object.is(v, -0) ? '-0' : v;
  if (seen.has(v)) return '@cycle';
  if (Array.isArray(v)) {
    seen.add(v);
    const out = v.map((x) => safe(x, depth + 1, seen));
    seen.delete(v);
    return out;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return { '@': v.id ?? v.constructor.name };
  if (depth > 4) return '@deep';
  seen.add(v);
  const out = {};
  for (const k of Object.keys(v)) if (!SEAM_KEYS.has(k)) out[k] = safe(v[k], depth + 1, seen);
  seen.delete(v);
  return out;
}

const heatText = (h) => JSON.stringify({ ...h, edgePasses: Array.from(h.edgePasses), edgeWait: Array.from(h.edgeWait), nodeWait: Array.from(h.nodeWait) });

/**
 * Run a layout through a tree and reduce what it did to four hashes plus counters.
 * @param {object} tree from loadTree
 * @param {object} layout a layout object (copied)
 * @param {{ seed?: number, dt?: number, warmup?: number, seconds?: number, steps?: Array<{ at: number, runtime: object }>, events?: boolean }} plan
 *   `steps`: setRuntime(runtime) when the simulated time reaches `at`, in order
 * @returns {{ kpi: string, events: string, insights: string, heat: string, state: string, eventCount: number, texts: object }}
 */
export function runPlan(tree, layout, { seed, dt, warmup, seconds = 1800, steps = [], events = true } = {}) {
  const copy = structuredClone(layout);
  if (dt !== undefined) copy.settings.dt = dt;
  if (warmup !== undefined) copy.settings.warmup = warmup;
  const sim = new tree.Simulation(copy, seed === undefined ? {} : { seed });
  const log = [];
  if (events) sim.on('*', (payload, name) => { log.push(`${name}@${sim.time.toFixed(4)}:${JSON.stringify(safe(payload))}`); });
  let done = 0;
  for (const step of [...steps, { at: seconds, runtime: null }]) {
    sim.advance(step.at - done);
    done = step.at;
    if (step.runtime) sim.setRuntime(step.runtime);
  }
  const lg = sim.logistics;
  const state = [lg.liveLoads, lg.completed, lg.createdBySources, lg.createdByProcesses, lg.loadsConsumed, lg.ordersDelivered, lg.deadlocks, lg.activeOrders.size, lg.loadSeq].join(',');
  const texts = { kpi: JSON.stringify(sim.kpis()), events: log.join('\n'), insights: JSON.stringify(sim.insights()), heat: heatText(sim.heat()), state };
  return {
    kpi: sha(texts.kpi, 8), events: sha(texts.events, 8), insights: sha(texts.insights, 8), heat: sha(texts.heat, 8), state, eventCount: log.length, texts,
  };
}

/** `a.b.c.d` of the four hashes (the value embedded in the review test). */
export const digestOf = (r) => `${r.kpi}.${r.events}.${r.insights}.${r.heat}`;

/** Where two runs differ: the first part that is not equal. */
export function firstDifference(a, b) {
  for (const key of ['kpi', 'events', 'insights', 'heat', 'state']) {
    if (a.texts[key] === b.texts[key]) continue;
    let i = 0;
    while (i < a.texts[key].length && a.texts[key][i] === b.texts[key][i]) i++;
    const cut = (t) => JSON.stringify(t.slice(Math.max(0, i - 40), i + 60));
    return `${key} differs at character ${i}: ${cut(a.texts[key])} against ${cut(b.texts[key])}`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// The matrix of the three examples
// ---------------------------------------------------------------------------------------------------------

export const MATRIX_SEEDS = Object.freeze([1, 2, 3, 4]);
export const MATRIX_DTS = Object.freeze([0.1, 0.25]);
export const MATRIX_SECONDS = 1200;
export const MATRIX_WARMUP = 300;
/** A what-if change in the middle of every run (the runtime settings are the live-adjustable ones): a different one for odd and even seeds. */
export const matrixSteps = (seed) => [{
  at: 600,
  runtime: seed % 2 === 1 ? { demandFactor: 1.5, dispatch: 'oldest' } : { speedFactor: 0.8, routing: 'congestion', processFactor: 1.2 },
}];
export const matrixKey = (id, seed, dt) => `${id}:${seed}:${dt}`;

/** Run one cell of the matrix. */
export function runMatrixCell(tree, id, seed, dt) {
  const example = tree.EXAMPLES.find((e) => e.id === id);
  return runPlan(tree, example.build(), { seed, dt, warmup: MATRIX_WARMUP, seconds: MATRIX_SECONDS, steps: matrixSteps(seed) });
}

/** Every cell of the matrix for a tree, as { key: digest }. Used once to record the table that the review test embeds. */
export function captureMatrix(tree) {
  const table = {};
  for (const example of tree.EXAMPLES) for (const seed of MATRIX_SEEDS) for (const dt of MATRIX_DTS) table[matrixKey(example.id, seed, dt)] = digestOf(runMatrixCell(tree, example.id, seed, dt));
  return table;
}

// ---------------------------------------------------------------------------------------------------------
// Plants from the existing generators (test helpers of this repository)
// ---------------------------------------------------------------------------------------------------------

/**
 * A list of { name, layout, seconds } from the generators that the other reviews use: hostile plants (breakdowns, batteries, one-way dead
 * ends, coarse steps), random plants, plants with several docks, and the two engineered jams.
 * @param {{ hostile: number, random: number, docks: number }} counts how many seeds of each generator
 */
export async function generatorPlants({ hostile, random, docks }) {
  const engine = await import('./engine-review-gen.js');
  const invariants = await import('./sim-invariants.js');
  const dockGen = await import('./docks-review-gen.js');
  const out = [];
  for (let s = 1; s <= hostile; s++) out.push({ name: `hostile ${s}`, layout: engine.hostilePlant(s), seconds: 1200 });
  for (let s = 1; s <= random; s++) out.push({ name: `random ${s}`, layout: invariants.randomPlant(s), seconds: 1200 });
  for (let s = 1; s <= docks; s++) {
    out.push({ name: `dock ${s}`, layout: dockGen.dockPlant(s), seconds: 1200 });
    if (s <= Math.ceil(docks / 2)) out.push({ name: `hostile dock ${s}`, layout: dockGen.hostileDocks(s), seconds: 1200 });
  }
  for (const mode of ['resolve', 'ignore']) {
    out.push({ name: `jam (${mode})`, layout: engine.jamPlant(mode), seconds: 2400 });
    out.push({ name: `tugger trains (${mode})`, layout: engine.tuggerTwoLines(mode), seconds: 2400 });
  }
  return out;
}

/** The runtime changes the comparisons apply in the middle of a run (rotating through all five keys). */
export const RUNTIME_CHANGES = Object.freeze([
  { demandFactor: 2 }, { speedFactor: 0.5 }, { processFactor: 1.5 }, { dispatch: 'oldest' }, { routing: 'congestion' }, { demandFactor: 0.3, dispatch: 'balanced' }, { demandFactor: 0, speedFactor: 3 },
]);

/** Four slices of a run with a runtime change after each, starting with change number `k`. */
export function slicedSteps(seconds, k) {
  return [1, 2, 3].map((i) => ({ at: (seconds * i) / 4, runtime: RUNTIME_CHANGES[(k + i - 1) % RUNTIME_CHANGES.length] }));
}

// ---------------------------------------------------------------------------------------------------------
// Dock-sensitive plants (the golden fixtures are blind to most dock settings, see the review test)
// ---------------------------------------------------------------------------------------------------------

/** Seeds of `dockPlant` that react to every dock-choice setting (found by sweeping 30 seeds against 8 settings), and how long they run. */
export const DOCK_NET = Object.freeze([{ seed: 13, seconds: 600 }, { seed: 22, seconds: 600 }, { seed: 2, seconds: 900 }, { seed: 4, seconds: 900 }, { seed: 25, seconds: 900 }]);

/** The settings of the dock book that the sweep changes, as fields of `sim.logistics.docks`. */
export const DOCK_KNOBS = Object.freeze({
  'minimum gain 3 -> 6': { minGain: 6 },
  'minimum gain 3 -> 0': { minGain: 0 },
  'blocking weight 2 -> 5': { blockWeight: 5 },
  'blocking weight 2 -> 1': { blockWeight: 1 },
  'exit weight 1 -> 2': { exitWeight: 2 },
  'exit weight 1 -> 0': { exitWeight: 0 },
  'late rebinding off': { rebinding: false },
  'dock book off': { enabled: false },
});

/** Digest (KPI text + event stream) of a dock plant with some settings of the dock book changed. */
export function runDockPlant(tree, layout, seconds, knob = null) {
  const sim = new tree.Simulation(structuredClone(layout));
  if (knob) Object.assign(sim.logistics.docks, knob);
  const log = [];
  sim.on('*', (payload, name) => { log.push(`${name}@${sim.time.toFixed(4)}:${JSON.stringify(safe(payload))}`); });
  sim.advance(seconds);
  return `${sha(JSON.stringify(sim.kpis()), 8)}.${sha(log.join('\n'), 8)}`;
}

// ---------------------------------------------------------------------------------------------------------
// Hostile documents
// ---------------------------------------------------------------------------------------------------------

const JUNK_SCALARS = [
  null, true, false, 0, -0, 1, -1, 7, 2.5, 1e9, -1e9, 1e300, -1e300, 'abc', '', '12', ' 3 ', '1e3', '0x10', 'Infinity', 'NaN', '__proto__', 'constructor', 'prototype', 'toString',
  'source', 'sink', 'storage', 'process', 'depot', 'a'.repeat(300), '\u0000\u0001x', '\ud800', '😀', 's1', 'f1', 'nearest-free', 'rack', 'block', 'rate', 'schedule',
  '06:00', '24:00', '6:5', 86399, 86400, 604800,
];
/** Keys of the warehouse module (docs/WAREHOUSE-DESIGN.md 5.3) plus the ones that are dangerous as keys. */
export const JUNK_KEYS = Object.freeze([
  'trucks', 'doors', 'checkIn', 'checkOut', 'mode', 'interArrival', 'pallets', 'schedule', 'jitter', 'noShow', 'maxDwell', 'staging', 'calendar', 'staffing', 'shift', 'count', 'profile',
  'onEnd', 'form', 'rack', 'block', 'putaway', 'aisleWidth', 'depth', 'levels', 'bayWidth', 'reserve', 'axis', 'mix', 'accepts', 'outType', 'pick', 'startTod', 'startDay', 'shifts',
  'profiles', 'hourly', 'days', 'breaks', 'from', 'to', 'paid', 'groups', 'depart', 'releaseLead', 'grace', 'id', 'name', 'at', 'type', 'share', 'velocity', 'kind', 'mean', 'spread',
  '__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty',
]);

/** A random JSON-like value of limited depth, biased towards what the warehouse module will read. */
export function junk(rng, depth = 0) {
  const roll = rng.next();
  if (depth > 4 || roll < 0.4) return rng.pick(JUNK_SCALARS);
  if (roll < 0.65) return Array.from({ length: rng.int(5) }, () => junk(rng, depth + 1));
  const obj = {};
  // defineProperty, not assignment: assigning to "__proto__" would replace the prototype, a file brings it in as an own key
  for (let i = rng.int(6); i >= 0; i--) Object.defineProperty(obj, rng.pick(JUNK_KEYS), { value: junk(rng, depth + 1), enumerable: true, writable: true, configurable: true });
  return obj;
}

/** An `ops.trucks` block (docs/WAREHOUSE-DESIGN.md 5.3, M1) with plausible keys and junk values, sometimes with a few wrong keys. */
export function junkTrucks(rng) {
  const t = {};
  const put = (key, value) => Object.defineProperty(t, key, { value, enumerable: true, writable: true, configurable: true });
  const number = () => rng.pick([0, 1, 2, 24, 300, 3600, 1e9, -5, 2.5, '3', ' 7 ', 'abc', null, 1e300, -0]);
  const dist = () => (rng.next() < 0.7 ? { kind: rng.pick(['const', 'normal', 'uniform', 'exp', 'x', 3, null]), mean: number(), spread: rng.pick([0, 0.3, 1, 2, -1, 'y']) } : junk(rng, 3));
  if (rng.next() < 0.8) put('doors', number());
  if (rng.next() < 0.5) put('checkIn', number());
  if (rng.next() < 0.5) put('checkOut', number());
  if (rng.next() < 0.6) put('mode', rng.pick(['rate', 'schedule', 'x', 3, null]));
  if (rng.next() < 0.5) put('interArrival', dist());
  if (rng.next() < 0.5) put('pallets', dist());
  if (rng.next() < 0.5) put('schedule', rng.next() < 0.8 ? Array.from({ length: rng.int(5) }, () => (rng.next() < 0.8 ? { at: number(), pallets: number(), ...(rng.next() < 0.4 ? { days: Array.from({ length: rng.int(4) }, number) } : {}) } : junk(rng, 3))) : junk(rng, 3));
  for (let i = rng.int(3); i > 0; i--) put(rng.pick(JUNK_KEYS), junk(rng, 3));
  return t;
}

/**
 * A raw layout document: a real plant with junk in every place the warehouse module will own. `JSON.parse(JSON.stringify(...))` of it
 * has own "__proto__" keys where the junk had them (that is how a file brings them in).
 * @param {object} rng createRng
 * @param {object} base a layout (copied)
 */
export function junkDocument(rng, base) {
  const raw = structuredClone(base);
  for (const s of raw.stations) {
    const roll = rng.next();
    if (roll < 0.4) s.ops = { trucks: junkTrucks(rng), ...(rng.next() < 0.3 ? { extra: junk(rng, 2) } : {}) };
    else if (roll < 0.7) s.ops = junk(rng);
  }
  if (rng.next() < 0.6) raw.calendar = junk(rng);
  if (rng.next() < 0.3) raw.loadTypes = junk(rng);
  for (const f of raw.fleets) {
    if (rng.next() < 0.4) f.calendar = junk(rng);
    if (rng.next() < 0.3) f.aisleMin = junk(rng);
    if (rng.next() < 0.3) f.liftHeight = junk(rng);
  }
  for (const f of raw.flows) if (rng.next() < 0.4) f.types = junk(rng);
  for (const list of [raw.obstacles, raw.labels]) for (const item of list ?? []) if (rng.next() < 0.2) item.ops = junk(rng);
  if (rng.next() < 0.2) raw.settings.ops = junk(rng);
  if (rng.next() < 0.2) raw.grid.ops = junk(rng);
  if (rng.next() < 0.3) raw.schema = junk(rng);
  if (rng.next() < 0.3) raw.stations.push(junk(rng), { type: rng.pick(['source', 'sink', 'storage', 'process', 'depot']), x: 1, y: 1, ops: junk(rng) });
  return raw;
}

/** The text of a document as a file would bring it in: own "__proto__" keys survive (JSON.parse defines them as data). */
export const parsed = (value) => JSON.parse(JSON.stringify(value));

export function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------
// The schema table of docs/WAREHOUSE-DESIGN.md 5.2, as an independent oracle
// ---------------------------------------------------------------------------------------------------------

const station = (layout, type) => layout.stations.find((s) => s.type === type);
const opsOf = (layout, type, patch) => {
  const s = station(layout, type);
  s.ops = { ...(s.ops ?? {}), ...patch };
};
const trucksOf = (layout, patch, type = 'source') => {
  const s = station(layout, type);
  s.ops = { ...(s.ops ?? {}), trucks: { ...(s.ops?.trucks ?? {}), ...patch } };
};

/**
 * Every persisted key that the table of 5.2 names, with the schema row the table gives it and a function that puts it into a layout
 * that has at least one source, sink, storage and fleet. Written from the document, not from schema.js.
 * @type {ReadonlyArray<{ row: number, what: string, put: (layout: object) => void }>}
 */
export const SCHEMA_TABLE = Object.freeze([
  { row: 2, what: 'station.ops.trucks on a Goods in', put: (l) => trucksOf(l, { doors: 2 }) },
  { row: 2, what: 'station.ops.trucks on a Goods out', put: (l) => trucksOf(l, { doors: 2 }, 'sink') },
  { row: 2, what: 'layout.calendar with startTod and startDay only', put: (l) => { l.calendar = { startTod: 21600, startDay: 0 }; } },
  { row: 3, what: 'calendar.shifts', put: (l) => { l.calendar = { startTod: 0, startDay: 0, shifts: [{ id: 'early', from: 21600, to: 50400 }] }; } },
  { row: 3, what: 'calendar.profiles', put: (l) => { l.calendar = { startTod: 0, startDay: 0, profiles: [{ id: 'm', hourly: new Array(24).fill(1) }] }; } },
  { row: 3, what: 'station.ops.calendar', put: (l) => opsOf(l, 'source', { calendar: { staffing: [] } }) },
  { row: 3, what: 'fleet.calendar', put: (l) => { l.fleets[0].calendar = { staffing: [] }; } },
  { row: 3, what: 'ops.trucks.schedule[].days', put: (l) => trucksOf(l, { mode: 'schedule', schedule: [{ at: 21600, pallets: 24, days: [0, 1] }] }) },
  { row: 4, what: 'station.ops.form', put: (l) => opsOf(l, 'storage', { form: 'rack' }) },
  { row: 4, what: 'station.ops.rack', put: (l) => opsOf(l, 'storage', { rack: { levels: 5 } }) },
  { row: 4, what: 'station.ops.block', put: (l) => opsOf(l, 'storage', { block: { stack: 2 } }) },
  { row: 4, what: 'station.ops.putaway (least-full)', put: (l) => opsOf(l, 'storage', { putaway: 'least-full' }) },
  { row: 4, what: 'fleet.aisleMin', put: (l) => { l.fleets[0].aisleMin = 2.8; } },
  { row: 4, what: 'fleet.liftHeight', put: (l) => { l.fleets[0].liftHeight = 10; } },
  { row: 5, what: 'ops.putaway value nearest-free', put: (l) => opsOf(l, 'storage', { putaway: 'nearest-free' }) },
  { row: 5, what: 'ops.trucks.depart', put: (l) => trucksOf(l, { depart: 3600 }, 'sink') },
  { row: 5, what: 'ops.trucks.releaseLead', put: (l) => trucksOf(l, { releaseLead: 5400 }, 'sink') },
  { row: 5, what: 'ops.trucks.grace', put: (l) => trucksOf(l, { grace: 900 }, 'sink') },
  { row: 5, what: 'ops.trucks.schedule[].depart', put: (l) => trucksOf(l, { mode: 'schedule', schedule: [{ at: 21600, pallets: 24, depart: 25000 }] }, 'sink') },
  { row: 6, what: 'layout.loadTypes', put: (l) => { l.loadTypes = [{ id: 'fast', name: 'Fast' }]; } },
  { row: 6, what: 'flow.types', put: (l) => { l.flows[0].types = ['fast']; } },
  { row: 6, what: 'station.ops.mix', put: (l) => opsOf(l, 'source', { mix: [{ type: 'fast', share: 1 }] }) },
  { row: 6, what: 'ops.trucks.mix', put: (l) => trucksOf(l, { mix: [{ type: 'fast', share: 1 }] }) },
  { row: 6, what: 'station.ops.accepts', put: (l) => opsOf(l, 'storage', { accepts: ['fast'] }) },
  { row: 6, what: 'station.ops.outType', put: (l) => opsOf(l, 'process', { outType: 'fast' }) },
  { row: 7, what: 'station.ops.pick', put: (l) => opsOf(l, 'process', { pick: { tSetup: 10 } }) },
]);

// ---------------------------------------------------------------------------------------------------------
// Stand-ins for the registries of M0 (how M1 will plug in)
// ---------------------------------------------------------------------------------------------------------

/**
 * A stand-in for the M1 sanitizer of `ops.trucks` (Goods in and Goods out): fills every field inside a block that exists, drops unknown
 * keys, clamps, and returns undefined for anything that is not a block with `trucks`. Written with the helpers of ops.js, as M1 will.
 */
export function makeTrucksSanitizer({ clampInt, clampNumber }) {
  const dist = (raw, base) => {
    const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
      kind: ['const', 'normal', 'uniform', 'exp'].includes(src.kind) ? src.kind : base.kind,
      mean: clampNumber(src.mean, 1, 1e6, base.mean),
      spread: clampNumber(src.spread, 0, 1, base.spread),
    };
  };
  return (raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const t = raw.trucks;
    if (t === null || typeof t !== 'object' || Array.isArray(t)) return undefined;
    const rows = Array.isArray(t.schedule) ? t.schedule.filter((r) => r !== null && typeof r === 'object').slice(0, 500) : [];
    return {
      trucks: {
        doors: clampInt(t.doors, 1, 32, 2),
        checkIn: clampNumber(t.checkIn, 0, 7200, 300),
        checkOut: clampNumber(t.checkOut, 0, 7200, 300),
        mode: t.mode === 'schedule' ? 'schedule' : 'rate',
        interArrival: dist(t.interArrival, { kind: 'normal', mean: 2700, spread: 0.3 }),
        pallets: dist(t.pallets, { kind: 'uniform', mean: 24, spread: 0.25 }),
        schedule: rows.map((r) => ({
          at: clampInt(r.at, 0, 604799, 0),
          pallets: clampInt(r.pallets, 1, 200, 24),
          ...(Array.isArray(r.days) ? { days: [...new Set(r.days.map((d) => clampInt(d, 0, 6, 0)))].sort((a, b) => a - b) } : {}),
        })),
      },
    };
  };
}

/**
 * Register stand-in sanitizers, run `fn`, and put the registries back (also when `fn` throws or returns a promise).
 * @param {{ ops: object, extensions: object }} modules `import * as` of js/model/ops.js and js/model/extensions.js
 * @param {{ calendar?: boolean }} [opts] `calendar`: also register a `calendar` block (startTod/startDay) that appears when any station has trucks in schedule mode
 */
export function withStandIn(modules, fn, { calendar = false } = {}) {
  const { ops, extensions } = modules;
  const savedSanitizers = { ...ops.OPS_SANITIZERS };
  const savedBlocks = [...extensions.EXTENSION_BLOCKS];
  const trucks = makeTrucksSanitizer(ops);
  ops.OPS_SANITIZERS.source = trucks;
  ops.OPS_SANITIZERS.sink = trucks;
  if (calendar) {
    extensions.EXTENSION_BLOCKS.length = 0;
    extensions.EXTENSION_BLOCKS.push({
      key: 'calendar',
      sanitize: (raw, layout) => {
        const needs = layout.stations.some((s) => s.ops?.trucks?.mode === 'schedule');
        if (!needs && (raw === null || typeof raw !== 'object')) return undefined;
        const src = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
        return { startTod: ops.clampInt(src.startTod, 0, 86399, 0), startDay: ops.clampInt(src.startDay, 0, 6, 0) };
      },
    });
  }
  const restore = () => {
    for (const key of Object.keys(ops.OPS_SANITIZERS)) delete ops.OPS_SANITIZERS[key];
    Object.assign(ops.OPS_SANITIZERS, savedSanitizers);
    extensions.EXTENSION_BLOCKS.length = 0;
    extensions.EXTENSION_BLOCKS.push(...savedBlocks);
  };
  let result;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore();
  return result;
}

// ---------------------------------------------------------------------------------------------------------
// The mutation harness
// ---------------------------------------------------------------------------------------------------------

const rep = (name, file, from, to) => Object.freeze({ name, file, from, to });
const dockConst = (name, from, to) => rep(`${name} ${from} -> ${to}`, 'js/sim/logistics/common.js', `export const ${name} = ${from};`, `export const ${name} = ${to};`);

/** The six deliberate changes of the review brief (a regression that must not slip through the golden tests), each a text replacement. */
export const MUTANTS = Object.freeze([
  rep('dispatch tie-break (nearest: on equal cost the YOUNGER load wins)', 'js/sim/logistics/dispatcher.js',
    'default: return (cmp(a.cost, b.cost) || cmp(b.age, a.age)) < 0;', 'default: return (cmp(a.cost, b.cost) || cmp(a.age, b.age)) < 0;'),
  dockConst('DOCK_MIN_GAIN', 3, 4),
  rep('battery drain +5 %', 'js/sim/logistics/vehicles.js', 'drain: runtimeMin > 0 ? 1 / (runtimeMin * 60) : 0,', 'drain: runtimeMin > 0 ? 1.05 / (runtimeMin * 60) : 0,'),
  rep('SWRR weights (square root)', 'js/sim/logistics/swrr.js', '(Number.isFinite(w) && w > 0 ? w : 0)', '(Number.isFinite(w) && w > 0 ? Math.sqrt(w) : 0)'),
  rep('traffic headway 0.5 -> 0.6 m', 'js/sim/traffic.js', 'opts.headway >= 0 ? opts.headway : 0.5;', 'opts.headway >= 0 ? opts.headway : 0.6;'),
  rep('statistics window (the warm-up ends one tick late)', 'js/sim/engine.js', 'this.time + WARMUP_EPS >= this.settings.warmup', 'this.time > this.settings.warmup + 1e-9'),
]);

/** More dock-choice constants, to show which of them the golden dock fixtures can feel. */
export const DOCK_MUTANTS = Object.freeze([
  dockConst('DOCK_TURNAROUND_DEAD_END', 8, 10), dockConst('DOCK_TURNAROUND_THROUGH', 3, 4), dockConst('DOCK_SHORT_STOP', 2, 3), dockConst('DOCK_CRUISE_SHARE', 0.75, 0.7),
  dockConst('DOCK_AHEAD_SLACK', 1, 2), dockConst('DOCK_EXIT_WEIGHT', 1, 1.5), dockConst('DOCK_BLOCK_WEIGHT', 2, 3), dockConst('DOCK_MIN_GAIN', 3, 5),
  dockConst('REBIND_INTERVAL', 2, 3), dockConst('REBIND_MIN_GAIN', 8, 6), dockConst('REBIND_GAIN_SHARE', 0.25, 0.3), dockConst('REBIND_MAX_SWITCHES', 1, 2),
]);

/** A scratch copy of js/ with one replacement applied (it must occur exactly once), loaded as a tree; removed again after `fn`. */
export async function withMutantTree(mutant, fn) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'logiplan-m0-tree-'));
  try {
    cpSync(path.join(ROOT, 'js'), path.join(tmp, 'js'), { recursive: true });
    cpSync(path.join(ROOT, 'package.json'), path.join(tmp, 'package.json'));
    const target = path.join(tmp, mutant.file);
    const source = readFileSync(target, 'utf8');
    const count = source.split(mutant.from).length - 1;
    if (count !== 1) throw new Error(`${mutant.name}: the text to replace occurs ${count} times in ${mutant.file}, not once`);
    writeFileSync(target, source.replace(mutant.from, () => mutant.to));
    return await fn(await loadTree(tmp));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Copy the tree into a scratch directory, apply one replacement (it must occur exactly once), run the golden tests there and count the
 * failures. Nothing in the real tree is touched.
 * @param {{ name: string, file: string, from: string, to: string }|null} mutant null: the unchanged copy (must pass)
 * @returns {{ tests: number, fail: number, failing: string[] }}
 */
export function runGoldenAgainst(mutant) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'logiplan-m0-mutant-'));
  try {
    cpSync(path.join(ROOT, 'js'), path.join(tmp, 'js'), { recursive: true });
    cpSync(path.join(ROOT, 'package.json'), path.join(tmp, 'package.json'));
    mkdirSync(path.join(tmp, 'tests'), { recursive: true });
    cpSync(path.join(ROOT, 'tests', 'helpers'), path.join(tmp, 'tests', 'helpers'), { recursive: true });
    cpSync(path.join(ROOT, 'tests', 'fixtures'), path.join(tmp, 'tests', 'fixtures'), { recursive: true });
    const tests = readdirSync(path.join(ROOT, 'tests')).filter((n) => /^sim\.golden\..*\.test\.js$/.test(n));
    for (const file of tests) cpSync(path.join(ROOT, 'tests', file), path.join(tmp, 'tests', file));
    if (mutant) {
      const target = path.join(tmp, mutant.file);
      const source = readFileSync(target, 'utf8');
      const count = source.split(mutant.from).length - 1;
      if (count !== 1) throw new Error(`${mutant.name}: the text to replace occurs ${count} times in ${mutant.file}, not once (did the code change?)`);
      writeFileSync(target, source.replace(mutant.from, () => mutant.to));
    }
    // a test run inside `node --test` has NODE_TEST_CONTEXT set; a nested runner would then print machine events instead of TAP
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests.map((n) => `tests/${n}`)], { cwd: tmp, encoding: 'utf8', maxBuffer: 1 << 26, env });
    const out = `${run.stdout}\n${run.stderr}`;
    const count = (key) => Number((out.match(new RegExp(`^# ${key} (\\d+)`, 'm')) || [])[1]);
    const result = { tests: count('tests'), fail: count('fail'), failing: [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]) };
    if (!Number.isInteger(result.tests) || !Number.isInteger(result.fail)) throw new Error(`the nested test run printed no summary:\n${out.slice(0, 600)}`);
    return result;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Allocation per tick
// ---------------------------------------------------------------------------------------------------------

let collect = null;
/** Run the garbage collector (the flag is switched on at run time, so the test needs no command line option). */
export function gc() {
  if (collect === null) {
    v8.setFlagsFromString('--expose-gc');
    collect = vm.runInNewContext('gc');
  }
  collect();
}

/**
 * Bytes allocated per tick: the heap growth over windows of `ticks` ticks that start right after a collection, the 25th percentile of
 * the windows that grew (a window in which the collector ran shows less than it allocated, a noisy one more).
 * @param {object} sim a Simulation that has been warmed up
 */
export function bytesPerTick(sim, { ticks = 200, windows = 30 } = {}) {
  const grew = [];
  for (let w = 0; w < windows; w++) {
    gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < ticks; i++) sim.step();
    const delta = (process.memoryUsage().heapUsed - before) / ticks;
    if (delta > 0) grew.push(delta);
  }
  grew.sort((a, b) => a - b);
  return grew.length ? grew[Math.floor(grew.length / 4)] : 0;
}
