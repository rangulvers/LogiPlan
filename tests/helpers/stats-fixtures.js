// Test helpers of the statistics view-model and view (docs/ENTITY-INSIGHTS-DESIGN.md 9.1 and 10): inputs for js/ui/panels/stats-model.js built from
//   * the fixtures of tests/fixtures/stats (answers of the collector for fixed runs, made by SIM) through the fake collector of tests/helpers/fake-sim.js,
//   * a REAL simulation of an example with the collector on (the model reads the real Detail and the real report),
// and the property scan that every printed number of a view-model has to pass: no NaN, no Infinity, no "undefined", no share above 100 %, no negative amount.
//
//   FIXTURES                          the four fixture files
//   layoutOfFixture(fx)               the layout the fixture's run was made on (an example or a frozen golden plant)
//   fixtureInput(fx, selection, opts) a complete `input` for buildStatsModel (collector = createFakeDetail(fx)); opts: window, routes, detail (false: no collector), report, insights, sim
//   runExample(id, opts)              a real Simulation of an example with the collector on, run for `seconds` after the warm-up (default 25 min)
//   liveInput(sim, selection, opts)   a complete `input` from a real simulation
//   everySelection(layout, sim?)      one selection of every kind and every item of the plant, plus a selection of several of each kind
//   modelProblems(model)              every violation of the printing rules found in a view-model (empty = clean)
//   nextNow()                         a growing clock for `input.now` (the small caches of the model expire between calls)
//   makeModelPlain(model)             a JSON copy of a view-model (no functions)

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EXAMPLES } from '../../js/model/examples.js';
import { Simulation } from '../../js/sim/engine.js';
import { createFakeDetail } from './fake-sim.js';
import { FIXTURE_DIR, ROOT, readFixture } from './detail-snapshot.js';

export { ROOT, FIXTURE_DIR, readFixture };

export const FIXTURES = Object.freeze(['two-lines-agv1.json', 'warehouse-goods-in.json', 'dockplant-44-hostile.json', 'two-lines-early.json']);

let clock = 1_000_000;
/** A clock that moves on by 5 s per call, so the one-second caches of the model never serve an old answer to a test. */
export const nextNow = () => (clock += 5000);

export function layoutOfFixture(fx) {
  let layout;
  if (fx.source.example) layout = EXAMPLES.find((e) => e.id === fx.source.example).build();
  else layout = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'golden', fx.source.file), 'utf8'));
  if (fx.source.warmup !== null && fx.source.warmup !== undefined) layout.settings.warmup = fx.source.warmup;
  return layout;
}

/** A vehicle the way the shell hands it over (the real VehicleRT fields the model reads), from the fixture's list. */
function vehicleStub(v, live) {
  const toDrop = v.state === 'toDrop';
  return {
    id: v.id, name: v.name, fleetId: v.fleetId, state: live.state, targetId: live.targetId, load: toDrop ? [{}] : [], order: null, depot: null, battery: 0.8,
    cfg: { capacity: 1 }, tv: { waiting: false }, visible: true,
  };
}

/** A minimal simulation around a fixture: the fake collector, the report and the insights as the Results tab shows them. */
export function fixtureSim(fx, layout, detail) {
  const sim = {
    time: fx.time, dt: 0.1, settings: { warmup: fx.source && fx.source.warmup ? fx.source.warmup : 0 }, detail, detailError: null,
    vehicles: fx.vehicles.map((v, i) => vehicleStub(v, fx.live.vehicles[i])), layout,
    // the runtime stations: the model asks `st.capacity` of a storage (the layout-level read is kept out of js/ by the ledger of tests/sim.seams.test.js)
    logistics: { unplaced: [], stationById: new Map(layout.stations.map((s) => [s.id, { id: s.id, capacity: s.params && s.params.capacity }])) },
    kpis: () => structuredClone(fx.report), insights: () => structuredClone(fx.insights),
  };
  detail.sim = sim;
  return sim;
}

export function fixtureInput(fx, selection, { window = 'start', routes = true, detail = true, report, insights, layout, sim, now } = {}) {
  const lay = layout || layoutOfFixture(fx);
  const det = detail ? createFakeDetail(fx) : null;
  const s = sim === undefined ? fixtureSim(fx, lay, det || createFakeDetail(fx)) : sim;
  if (s) s.detail = det;
  if (s && det && s.vehicles) det.V = s.vehicles; // as in the real simulation: the collector's vehicles ARE the simulation's
  return {
    selection, layout: lay, sim: s, detail: det, report: report || structuredClone(fx.report), insights: insights || structuredClone(fx.insights), window, routes, state: 'open', narrow: false, now: now ?? nextNow(),
  };
}

/** A real simulation of an example (or of any layout) with the collector on; `seconds` is the time after the warm-up. */
export function runExample(id, { seconds = 25 * 60, seed = 1, detail = true, warmup, mutate, layout: given } = {}) {
  const layout = given || EXAMPLES.find((e) => e.id === id).build();
  if (warmup !== undefined) layout.settings.warmup = warmup;
  if (mutate) mutate(layout);
  const sim = new Simulation(layout, { seed });
  if (detail) sim.enableDetail();
  sim.advance(layout.settings.warmup + seconds);
  return sim;
}

export function liveInput(sim, selection, { window = 'start', routes = true, detail, now } = {}) {
  return {
    selection, layout: sim.layout, sim, detail: detail === undefined ? sim.detail : detail, report: sim.kpis(), insights: sim.insights(), window, routes, state: 'open', narrow: false, now: now ?? nextNow(),
  };
}

/** Every item of a plant as a selection, then a selection of several of each kind (road cells: every road cell near the first station). */
export function everySelection(layout, { cells = 6 } = {}) {
  const out = [];
  for (const f of layout.fleets) for (let n = 1; n <= f.count; n++) out.push({ kind: 'vehicle', ids: [`${f.id}#${n}`] });
  for (const s of layout.stations) out.push({ kind: 'station', ids: [s.id] });
  for (const f of layout.flows) out.push({ kind: 'flow', ids: [f.id] });
  for (const f of layout.fleets) out.push({ kind: 'fleet', ids: [f.id] });
  const roads = Object.keys(layout.roads || {});
  for (let k = 0; k < Math.min(cells, roads.length); k++) out.push({ kind: 'cell', ids: [roads[Math.floor((k * roads.length) / cells)]] });
  const two = (kind, ids) => { if (ids.length >= 2) out.push({ kind, ids: ids.slice(0, 3) }); };
  two('vehicle', layout.fleets.flatMap((f) => Array.from({ length: f.count }, (_, i) => `${f.id}#${i + 1}`)));
  two('station', layout.stations.map((s) => s.id));
  two('flow', layout.flows.map((f) => f.id));
  two('fleet', layout.fleets.map((f) => f.id));
  two('cell', roads);
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// The printing rules
// ---------------------------------------------------------------------------------------------------------

const BAD_WORDS = /\b(NaN|Infinity|undefined|null)\b|\[object/;
const PERCENT = /(-?\d[\d,]*(?:\.\d+)?)\s?%/g;
// "-1 loads" or "a -3 s": a minus sign in front of a number that is not part of a word or a range ("0:10-1:20" never occurs)
const NEGATIVE = /(^|[\s(·])-\d/;

/** Every string and number of a view-model, with the path it was found at (functions and DOM-less data only). */
export function* walkModel(value, at = '$') {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) { yield [at, value]; return; }
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) yield* walkModel(value[i], `${at}[${i}]`); return; }
  if (typeof value === 'object') for (const k of Object.keys(value)) yield* walkModel(value[k], `${at}.${k}`);
}

// keys whose strings are ids, not text a planner reads
const ID_KEYS = /\.(signature|key|focusId|kind|variant|status|id|tone|type|tone|ids\[\d+\]|node|state)$/;

/**
 * The violations of the printing rules in a view-model: a number that is not finite, "NaN" / "Infinity" / "undefined" in a text, a printed share above 100 %,
 * a printed negative amount, a tile that is not complete. Rows that carry a SHARE have it between 0 and 1.
 */
export function modelProblems(model) {
  const problems = [];
  if (!model) return ['no model'];
  for (const [at, v] of walkModel(model)) {
    if (typeof v === 'number' && !Number.isFinite(v)) problems.push(`${at}: ${v}`);
    if (typeof v !== 'string' || ID_KEYS.test(at)) continue;
    if (BAD_WORDS.test(v)) problems.push(`${at}: "${v}" has a bad word`);
    if (NEGATIVE.test(v)) problems.push(`${at}: "${v}" prints a negative amount`);
    for (const m of v.matchAll(PERCENT)) if (Number(m[1].replace(/,/g, '')) > 100) problems.push(`${at}: "${v}" prints ${m[0]}`);
  }
  if (!Array.isArray(model.tiles) || model.tiles.length !== 6) problems.push(`tiles: ${model.tiles && model.tiles.length}, expected six`);
  const ids = new Set();
  for (const t of model.tiles || []) {
    if (ids.has(t.id)) problems.push(`tile ${t.id} twice`);
    ids.add(t.id);
    if (!t.label || !t.def || typeof t.value !== 'string') problems.push(`tile ${t.id} is incomplete`);
    if (t.share && t.raw !== null && (t.raw < -1e-9 || t.raw > 1 + 1e-9)) problems.push(`tile ${t.id}: share ${t.raw} outside 0..1`);
    if (t.share && t.raw !== null && /%/.test(t.value) && Number(t.value.replace(/[^\d.]/g, '')) > 100) problems.push(`tile ${t.id}: ${t.value}`);
  }
  for (const b of model.blocks || []) {
    for (const r of (b.held && b.held.rows) || []) if (r.share < 0 || r.share > 1 + 1e-9 || r.seconds < 0) problems.push(`held row ${r.label}: share ${r.share}, seconds ${r.seconds}`);
    for (const p of (b.split && b.split.items) || []) if (p.share < 0 || p.share > 1 + 1e-9) problems.push(`split ${p.key}: ${p.share}`);
    for (const r of b.rows || []) if (r.share !== undefined && (r.share < 0 || r.share > 1 + 1e-9)) problems.push(`row ${r.key}: share ${r.share}`);
  }
  return problems;
}

export const makeModelPlain = (model) => JSON.parse(JSON.stringify(model));
