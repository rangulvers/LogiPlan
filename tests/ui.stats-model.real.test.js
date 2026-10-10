// The view-model of the Statistics dock on REAL simulations (js/ui/panels/stats-model.js; docs/ENTITY-INSIGHTS-DESIGN.md 3.9, 5 and 10): the fleet question against the
// table of the design, properties of every item of the five examples and a frozen dock plant with the collector on (no NaN / Infinity / undefined, no share above 100 %,
// nothing printed negative, the rows plus "other places" equal the tile), the numbers against the collector and the Results fleet table, a model changes nothing the
// collector recorded, the focus ids against the overlay, every tile has its counting rule. The pure rules and the fixtures are tests/ui.stats-model.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/ui/panels/stats-model.js';
import { detailDigest } from './helpers/detail-digest.js';
import { readFixture, layoutOfFixture, runExample, liveInput, everySelection, modelProblems } from './helpers/stats-fixtures.js';

const { buildStatsModel } = M;
const DOCK44 = readFixture('dockplant-44-hostile.json');
const near = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg} ${a} is not ${b} (eps ${eps})`);
const tileOf = (m, id) => m.tiles.find((t) => t.id === id);
const blockOf = (m, id) => m.blocks.find((b) => b.id === id);
const REAL = ['starter', 'two-lines', 'congestion-lab', 'dock-lab', 'warehouse-first-day'];
/** A run of an example (35 minutes after the warm-up, the collector on) that tests only READ: it is made once for the whole file. */
const runs = new Map();
const shared = (id) => { if (!runs.has(id)) runs.set(id, runExample(id, { seconds: 35 * 60 })); return runs.get(id); };
const FQ_PLANTS = [
  // plant, fleet, verdict, forecast (design 3.9: within 1 point), vehicles needed at 75 % (null: none printed), cut off at 100 %
  // The verdict follows the load on the TIME IN SERVICE (forecast / (1 - charging - broken)); the forecast stays a share of all the time, which is what a simulation with one
  // vehicle less measures (tests/stats.truth.review.test.js TRUTH-7). A fleet that is busy all the time is 'limit': the arithmetic cannot tell (STAT-REV-17).
  ['starter', 'v1', 'needed', 1.35, 2, false],
  ['two-lines', 'v1', 'borderline', 0.83, 3, false],
  ['two-lines', 'v2', 'borderline', 0.77, 7, false],
  ['congestion-lab', 'v1', 'queueing', null, null, false],
  ['dock-lab', 'v1', 'spare', 0.71, 4, false],
  ['warehouse-first-day', 'v1', 'limit', 1.30, null, true],
];

test('the fleet question reproduces the table of the design on the real examples (seed 1, 2 h after the warm-up)', () => {
  const reports = new Map();
  for (const [plant, fleet, verdict, forecast, needed, censored] of FQ_PLANTS) {
    if (!reports.has(plant)) reports.set(plant, runExample(plant, { seconds: 2 * 3600, detail: false }).kpis());
    const report = reports.get(plant);
    const q = M.fleetQuestion(report, report.fleets[fleet], report.window.duration);
    assert.equal(q.verdict, verdict, `${plant}/${fleet}`);
    if (forecast !== null) assert.ok(Math.abs(q.forecast - forecast) < 0.01, `${plant}/${fleet}: forecast ${q.forecast} is not within a point of ${forecast}`);
    else assert.equal(q.forecast, null, 'withheld: no forecast');
    assert.equal(q.needed, needed, `${plant}/${fleet}: vehicles at 75 %`);
    assert.equal(q.censored, censored, `${plant}/${fleet}: cut off at 100 %`);
    if (forecast !== null) near(q.load, q.forecast / q.available, 1e-12, `${plant}/${fleet}: the load is the forecast on the time in service`);
    if (verdict === 'limit') assert.doesNotMatch(q.text, /does not fit|Needed|Spare/, 'a fleet at its limit is neither needed nor spare');
    if (censored) assert.doesNotMatch(q.text, /about \d+ vehicles?\./, 'a fleet that is cut off prints no count');
    if (verdict === 'queueing') assert.match(q.text, /^Vehicles queue \(28 % of their moving time\): the number of vehicles is not what limits this fleet, so no count is suggested\. Look at the docks and the roads first\.$/);
    assert.doesNotMatch(q.text, /\b(10[1-9]|1[1-9]\d|[2-9]\d\d|\d{4,}) ?%/, 'a workload above 100 % is said in words, never printed as a share');
    if (q.verdict !== 'queueing') assert.match(q.text, /Workload arithmetic, not a simulation/, 'labelled');
  }
});

test('S1.9: on real runs of the five examples every item of every kind builds a model without NaN, Infinity, undefined or a share above 100 %, in both windows', () => {
  for (const id of REAL) {
    const sim = shared(id);
    let n = 0;
    for (const win of ['start', 'last30']) {
      for (const sel of everySelection(sim.layout)) {
        const m = buildStatsModel(liveInput(sim, sel, { window: win }));
        assert.deepEqual(modelProblems(m), [], `${id} ${win} ${JSON.stringify(sel)}`);
        assert.equal(m.status, 'ready');
        n++;
      }
    }
    assert.ok(n > 20, `${id}: ${n} models`);
  }
});

test('S1.9: a frozen dock-dense plant (zero-length trips, relocated vehicles) builds clean models for every vehicle, in both windows', () => {
  const layout = layoutOfFixture(DOCK44);
  layout.settings.warmup = 0;
  const sim = runExample(null, { seconds: 1800, layout, seed: layout.settings.seed ?? 1 });
  for (const win of ['start', 'last30']) {
    for (const sel of everySelection(sim.layout)) {
      const m = buildStatsModel(liveInput(sim, sel, { window: win }));
      assert.deepEqual(modelProblems(m), [], `${win} ${JSON.stringify(sel)}`);
    }
  }
});

test('S1.9 on a real run: tiles equal the collector, the Results fleet table and the rows add up to the held-up number', () => {
  const sim = shared('two-lines');
  const report = sim.kpis();
  const det = sim.detail;
  for (const win of ['start', 'last30']) {
    const w = det.windowOf(win);
    for (let i = 0; i < det.V.length; i++) {
      const id = det.V[i].id;
      const m = buildStatsModel(liveInput(sim, { kind: 'vehicle', ids: [id] }, { window: win }));
      const t = det.timeSplit(i, w);
      near(tileOf(m, 'held').raw, (t.waiting + t.dockQueue) / t.seconds, 1e-12);
      near(tileOf(m, 'trips').raw, det.counts(i, w).trips / (t.seconds / 3600), 1e-12);
      const held = blockOf(m, 'time').held;
      if (held) near(held.rows.reduce((a, r) => a + r.seconds, 0), held.total, 1e-9, `${id} ${win}`);
      const split = blockOf(m, 'time').split.items;
      const share = (k) => (split.find((p) => p.key === k) || { share: 0 }).share;
      near(share('drivingLoaded') + share('drivingEmpty') + share('drivingDepot'), t.driving / t.seconds, 0.004, 'driving sub-slots');
    }
  }
  for (const f of Object.keys(report.fleets)) {
    const mates = det.V.filter((v) => v.fleetId === f).map((v) => buildStatsModel(liveInput(sim, { kind: 'vehicle', ids: [v.id] })));
    near(mates.reduce((a, m) => a + tileOf(m, 'trips').raw, 0) / mates.length, report.fleets[f].tripsPerVehicleHour, 1e-6, `${f}: trips per vehicle and hour`);
    near(mates.reduce((a, m) => a + tileOf(m, 'held').raw, 0) / mates.length, report.fleets[f].shares.waiting, 1e-6, `${f}: held up`);
  }
});

test('building models changes nothing the collector recorded and nothing the report says (a query is not an event)', () => {
  const sim = shared('two-lines');
  const before = { digest: detailDigest(sim.detail), version: sim.detail.version, kpis: JSON.stringify(sim.kpis()), time: sim.time };
  for (let round = 0; round < 3; round++) {
    for (const win of ['start', 'last30']) for (const sel of everySelection(sim.layout)) buildStatsModel(liveInput(sim, sel, { window: win }));
  }
  assert.equal(detailDigest(sim.detail), before.digest, 'the recorder holds the same bits');
  assert.equal(sim.detail.version, before.version);
  assert.ok(JSON.stringify(sim.kpis()) === before.kpis, 'the report is the same text');
  assert.equal(sim.time, before.time);
  // and a run with models built along the way equals one without: the fact memory and the caches are on this side of the seam
  const a = runExample('two-lines', { seconds: 20 * 60 });
  const b = runExample('two-lines', { seconds: 0 });
  for (let k = 0; k < 20; k++) { b.advance(60); buildStatsModel(liveInput(b, { kind: 'vehicle', ids: ['v2#1'] })); }
  assert.ok(JSON.stringify(b.kpis()) === JSON.stringify(a.kpis()), 'models built every simulated minute do not move a figure');
  assert.equal(detailDigest(b.detail), detailDigest(a.detail));
});

test('the view-model is plain data: it survives JSON and structuredClone, and building it twice gives the same model', () => {
  const sim = shared('two-lines');
  for (const sel of everySelection(sim.layout).slice(0, 25)) {
    const input = liveInput(sim, sel, { now: 42_000_000 });
    const a = buildStatsModel({ ...input, factMemory: M.createFactMemory() });
    const b = buildStatsModel({ ...input, factMemory: M.createFactMemory() });
    assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)), JSON.stringify(sel));
    assert.doesNotThrow(() => structuredClone(a));
  }
});

test('the routes of every trip row are understood by the overlay: the focus id is its canonical form', async () => {
  const { canonicalFocus } = await import('../js/ui/render/routes.js');
  const sim = shared('warehouse-first-day');
  let rows = 0;
  for (const v of sim.detail.V) {
    const m = buildStatsModel(liveInput(sim, { kind: 'vehicle', ids: [v.id] }));
    for (const r of blockOf(m, 'trips').rows) {
      rows++;
      assert.equal(canonicalFocus(r.focusId), r.focusId, r.focusId);
      assert.ok(M.parseFocusId(r.focusId), r.focusId);
    }
    const round = blockOf(m, 'trips').round;
    if (round) assert.equal(canonicalFocus(round.focusId), round.focusId);
  }
  assert.ok(rows > 0);
});

test('every tile of every kind has a counting rule in the table the Help page is made from', () => {
  const sim = shared('warehouse-first-day');
  const seen = new Set();
  for (const sel of everySelection(sim.layout)) {
    const m = buildStatsModel(liveInput(sim, sel));
    for (const t of m.tiles) {
      assert.ok(M.DEFINITIONS[t.spec], `${sel.kind}/${t.id}: no definition ${t.spec}`);
      assert.ok(t.def.startsWith(M.DEFINITIONS[t.spec].text), `${t.spec}: the (i) of the tile starts with the rule of the table`);
      seen.add(t.spec);
    }
  }
  assert.ok(seen.size > 30, `${seen.size} different rules in use`);
});
