// Test helper: a plain-JSON snapshot of everything the detail collector (js/sim/detail.js) can answer for a finished run, in the exact shape of its query
// API (docs/ENTITY-INSIGHTS-DESIGN.md 6.4, docs/ARCHITECTURE.md 5.8). It has two uses:
//   * the fixtures tests/fixtures/stats/*.json (the CONTRACT between the simulation and the model / overlay builders: they work against these files without a
//     collector), written by `node tests/helpers/detail-snapshot.js --write` and proved to match the live collector by tests/sim.detail.fixtures.test.js;
//   * tests/helpers/fake-sim.js `createFakeDetail(fixture)`, a collector stand-in that answers its queries from a fixture.
//
// Shape of a fixture (format 1). Everything is JSON: no Map, no typed array, no NaN or Infinity (the builder throws on one). Indices `i` are the position in
// `vehicles` / `stations` / `flows` (= det.V[i], det.stations[i], sim.flows[i]); a station index `0xffff` (65535) means "no station" (a waiting place).
//
//   format, about, source { example | file, seed, warmup, seconds }      how to rebuild the run
//   time                      sim.time at the snapshot
//   graph { cols, rows, cellSize }                                     a path node `n` is cell (n % cols, floor(n / cols)); metres = steps x cellSize
//   detail { windowStart, version, nV, nS, bucketCount, notices[], legs { count, rows, cap }, ... }
//   windows { start, last30 }                                         windowOf(kind) -> { kind, t0, seconds, row, zero }
//   stations[i] { index, id, name, type }     flows[i] { index, id, from, to, name }     vehicles[i] { index, id, name, fleetId, state, targetId }
//   report                    sim.kpis()           insights  sim.insights()           (exactly what the Results tab shows)
//   live { vehicles[i] { metresToGo, state, targetId }, stations[i] { queueNow { loads, oldest } } }
//   series { working[i] }     workingSeries(i, 60)   busy share per 30 s bucket, oldest first
//   queries.<start|last30>.vehicles[i] {
//       timeSplit, counts, batteryOf,                                 as the methods answer
//       routes   routesOf(i, w, [0, 1, 2, 3])                          every kind; filter on `kind` (0 empty, 1 loaded, 2 to charger, 3 to park)
//       round    roundOf(i, w, 2) | null            queues  queuesOf(i, w)
//       hotspots hotspots(i, 8)  (start only, else null)            idleSpots  idleSpots(i, 3)  (start only, else null) }
//   queries.<start|last30>.stations[i] { stationWindow, visitsTo }    busiestRoutes busiestRoutes(w, 4)     loadedRoutes loadedRoutes({}, w)
//   hist { pickWait, yardWait { <station index>: { n, sum, max, p50, p90, p95 } }, sinkLead { <station index>: { n, sum, min, max, p50, p90, p95 } } }
//   paths { <path id>: [node, ...] }                                  det.pool.nodes(id) for every path id any query above mentions
//
// The fixtures are of the REFERENCE collector (revision 2 of the design stage) with the hardening of the build on top: numbers agree to 1e-9 relative
// (tests/sim.detail.fixtures.test.js compares them with that tolerance, and structure and integers exactly).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'stats');
export const FORMAT = 1;

/** The fixtures: file name -> how its run is made. `example` is an id of js/model/examples.js, `file` a layout in tests/fixtures/golden. */
export const FIXTURE_SPECS = Object.freeze({
  'two-lines-agv1.json': { example: 'two-lines', seed: 1, warmup: 600, seconds: 600 + 7560, about: 'Two production lines + warehouse, 2 h 06 min measured after the 10 min warm-up: the AGVs 1 of the vehicle view (design 3.1, 4.1).' },
  'warehouse-goods-in.json': { example: 'warehouse-first-day', seed: 1, warmup: null, seconds: 3 * 3600, about: 'Warehouse first day (trucks, three doors, four docks), 3 h: the Goods in view (design 3.3) and vehicles that choose between docks (4.1).' },
  'dockplant-44-hostile.json': { file: 'layout.dockplant-44.json', seed: null, warmup: null, seconds: 1800, about: 'Frozen dock-dense plant 44 (golden fixture layout), 30 min: zero-length legs, relocated legs, a window shorter than 20 minutes.' },
  'two-lines-early.json': { example: 'two-lines', seed: 1, warmup: 600, seconds: 600 + 90, about: 'Two lines, 90 s after the warm-up: nearly empty windows (placeholder, "indicative", Last 30 min = Since start).' },
});

const KINDS_ALL = [0, 1, 2, 3];
const NO_STATION = 0xffff;

/** Throw when `value` holds a NaN or an Infinity (JSON.stringify would turn it into null without a word). */
export function assertFinite(value, where = '$') {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${where}`);
  } else if (Array.isArray(value)) value.forEach((v, i) => assertFinite(v, `${where}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) assertFinite(v, `${where}.${k}`);
}

const histSummary = (h) => ({ n: h.n, sum: h.sum, max: h.max, p50: h.percentile(0.5), p90: h.percentile(0.9), p95: h.percentile(0.95) });
const setSummary = (s) => (s.count === 0 ? { n: 0, sum: 0, min: null, max: null, p50: null, p90: null, p95: null } : { n: s.count, sum: s.sum, min: s.min, max: s.max, p50: s.percentile(0.5), p90: s.percentile(0.9), p95: s.percentile(0.95) });
const mapObject = (map, fn) => Object.fromEntries([...map].sort((a, b) => a[0] - b[0]).map(([k, v]) => [k, fn(v)]));

/**
 * Every query of the collector for a finished run, as plain JSON.
 * @param {object} sim a Simulation with sim.detail on
 * @param {{ source?: object }} [opts] `source` is copied into the fixture (how the run was made)
 */
export function snapshotDetail(sim, { source = null, about = '' } = {}) {
  const det = sim.detail;
  if (!det) throw new Error('snapshotDetail: the simulation has no collector (sim.enableDetail())');
  const windows = { start: det.windowOf('start'), last30: det.windowOf('last30') };
  const paths = new Map();
  const usePath = (id) => { if (Number.isInteger(id) && id >= 0 && !paths.has(id)) paths.set(id, Array.from(det.pool.nodes(id))); };
  const stations = det.stations.map((st, index) => ({ index, id: st.id, name: st.def?.name ?? st.name ?? st.id, type: st.type }));
  const flows = sim.flows.map((f, index) => ({ index, id: f.id, from: f.from?.id ?? f.def?.from ?? f.from, to: f.to?.id ?? f.def?.to ?? f.to, name: f.name ?? f.def?.name ?? f.id }));
  const vehicles = det.V.map((vr, index) => ({ index, id: vr.id, name: vr.name, fleetId: vr.fleetId, state: vr.state, targetId: vr.targetId }));
  const queries = {};
  for (const kind of ['start', 'last30']) {
    const w = windows[kind];
    const perVehicle = det.V.map((vr, i) => {
      const routes = det.routesOf(i, w, KINDS_ALL);
      for (const r of routes) { usePath(r.pathId); for (const p of r.pathIds) usePath(p.id); }
      return {
        index: i, timeSplit: det.timeSplit(i, w), counts: det.counts(i, w), batteryOf: det.batteryOf(i, w), routes, round: det.roundOf(i, w, 2), queues: det.queuesOf(i, w),
        hotspots: kind === 'start' ? det.hotspots(i, 8) : null, idleSpots: kind === 'start' ? det.idleSpots(i, 3) : null,
      };
    });
    const perStation = det.stations.map((_, i) => ({ index: i, stationWindow: det.stationWindow(i, w), visitsTo: det.visitsTo(i, w) }));
    const busiest = det.busiestRoutes(w, 4);
    for (const r of busiest.routes) usePath(r.pathId);
    const loaded = det.loadedRoutes({}, w);
    for (const r of loaded) usePath(r.pathId);
    queries[kind] = { vehicles: perVehicle, stations: perStation, busiestRoutes: busiest, loadedRoutes: loaded };
  }
  const snap = {
    format: FORMAT,
    about,
    source,
    time: sim.time,
    graph: { cols: sim.graph.cols, rows: sim.graph.rows, cellSize: sim.graph.cellSize },
    detail: {
      windowStart: det.windowStart, version: det.version, nV: det.nV, nS: det.nS, bucketCount: det.bCount, notices: det.notices.map((n) => ({ ...n })),
      legs: { count: det.legs.count, rows: det.legs.size, cap: det.legs.cap }, paths: det.pool.size, whatIf: det.whatIf.map((x) => ({ ...x })),
    },
    windows,
    stations,
    flows,
    vehicles,
    report: JSON.parse(JSON.stringify(sim.kpis())),
    insights: JSON.parse(JSON.stringify(sim.insights())),
    live: { vehicles: det.V.map((vr, i) => ({ metresToGo: det.metresToGo(i), state: vr.state, targetId: vr.targetId })), stations: det.stations.map((_, i) => ({ queueNow: det.queueNow(i) })) },
    series: { working: det.V.map((_, i) => det.workingSeries(i, 60)) },
    queries,
    hist: {
      pickWait: mapObject(det.pickWait, histSummary), yardWait: mapObject(det.yardWait, histSummary), sinkLead: mapObject(det.sinkLead, setSummary),
    },
    paths: Object.fromEntries([...paths].sort((a, b) => a[0] - b[0])),
  };
  assertFinite(snap);
  return snap;
}

/** The fixture text: one top-level key per line (a diff of two fixtures reads), numbers as JSON.stringify prints them. */
export function fixtureText(snap) {
  return `{\n${Object.keys(snap).map((k) => `${JSON.stringify(k)}: ${JSON.stringify(snap[k])}`).join(',\n')}\n}\n`;
}

export function readFixture(name) {
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

/**
 * Run the plant of a fixture spec on the tree under test and snapshot it.
 * @param {string} name a key of FIXTURE_SPECS
 * @param {{ root?: string }} [opts] `root`: another checkout (the reference tree of the design stage), default this one
 */
export async function buildFixture(name, { root = ROOT } = {}) {
  const spec = FIXTURE_SPECS[name];
  if (!spec) throw new Error(`no fixture spec ${name}`);
  const url = (rel) => pathToFileURL(path.join(root, rel)).href;
  const { Simulation } = await import(url('js/sim/engine.js'));
  let layout;
  if (spec.example) {
    const { EXAMPLES } = await import(url('js/model/examples.js'));
    layout = EXAMPLES.find((e) => e.id === spec.example).build();
  } else layout = JSON.parse(readFileSync(path.join(ROOT, 'tests', 'fixtures', 'golden', spec.file), 'utf8'));
  if (spec.warmup !== null) layout.settings.warmup = spec.warmup;
  const sim = new Simulation(layout, spec.seed === null ? {} : { seed: spec.seed });
  sim.enableDetail();
  sim.advance(spec.seconds);
  const source = { ...(spec.example ? { example: spec.example } : { file: spec.file }), seed: sim.seed, warmup: sim.settings.warmup, seconds: spec.seconds };
  return snapshotDetail(sim, { source, about: spec.about });
}

export { NO_STATION };

// node tests/helpers/detail-snapshot.js --write [--root <checkout>] [name ...]   rewrites tests/fixtures/stats/*.json from the tree (default: this one)
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const rootAt = args.indexOf('--root');
  const root = rootAt >= 0 ? path.resolve(args[rootAt + 1]) : ROOT;
  const names = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--root');
  if (!args.includes('--write')) {
    console.log('usage: node tests/helpers/detail-snapshot.js --write [--root <checkout>] [fixture name ...]');
    console.log(`fixtures: ${Object.keys(FIXTURE_SPECS).join(', ')}`);
  } else {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    for (const name of names.length ? names : Object.keys(FIXTURE_SPECS)) {
      const text = fixtureText(await buildFixture(name, { root }));
      writeFileSync(path.join(FIXTURE_DIR, name), text);
      console.log(`${name}: ${(text.length / 1024).toFixed(0)} KiB`);
    }
  }
}
