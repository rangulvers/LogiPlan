// Adversarial review of milestone M0 of the warehouse module (docs/WAREHOUSE-DESIGN.md 9.1: foundations, no behaviour change).
// Helpers and the long story of what each check is for: tests/helpers/m0-review-gen.js.
//
// M0 promises two things, and this file tries to break both:
//   1. NOTHING changes for a plant that uses none of the new features (results, results of what-ifs, files, share links, autosave).
//      Checked against the digests recorded from the PRE-M0 tree (commit eccdca8) and, where git can give that tree, against the tree itself.
//   2. The seams are ready for the next milestones: the registries, the schema stamp, the capacity accessor, the hooks in Stats.
//      Checked with stand-in sanitizers that plug in the way M1 will, through the real store.
//
// Switches (environment): M0_REVIEW_HEAVY=1 runs the expensive checks (hundreds of plants, 8 h runs, the mutation runs of the golden
// tests, CPU and allocation comparisons); M0_OLD_TREE=<dir with js/> or M0_OLD_REV=<commit> chooses the pre-M0 tree; M0_REVIEW_STRICT=1
// turns the known-defect tests (todo by default, so that the suite stays green) into ordinary failing tests.
//
// M1 UPDATE (the model builder of milestone M1 filled the seams for trucks and the clock): the checks that described the EMPTY seams were rewritten to
// describe what is still true: 3.3, 3.4, 3.6, 3.7, 3.11, 6.1 (now measured between the pre-M0 tree and the END of M0, a2af6d8, so that the files M1 adds
// or edits cannot fail an M0 test), 6.2 and 6.3. Every other check is unchanged.
//
// Tests named "DEFECT M0-REV-n" are real defects found by this review that are NOT fixed; they FAIL today (they are `todo`). The defects that
// the fix pass repaired (1, 1b, 2, 3, 3b, 4) are ordinary tests now, named "M0-REV fixed n"; M0-REV-5 (the numbers in a document) is fixed since the M1 verification (Appendix C states the tree's numbers next to the dated first measurement).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import * as H from './helpers/m0-review-gen.js';
import * as L from '../js/model/layout.js';
import * as S from '../js/model/serialize.js';
import * as SC from '../js/model/schema.js';
import * as OPS from '../js/model/ops.js';
import * as EXT from '../js/model/extensions.js';
import * as CAL from '../js/model/calendar.js';
import * as VOPS from '../js/model/validate-ops.js';
import * as INS from '../js/sim/insights.js';
import { validateLayout } from '../js/model/validate.js';
import { createStore } from '../js/store/store.js';
import { Simulation } from '../js/sim/engine.js';
import { EXAMPLES as ALL_EXAMPLES } from '../js/model/examples.js';
import { createRng } from '../js/util/rng.js';
import { bufferSize } from '../js/ui/render/jobs.js';
import { dockLabLayout, dockKpisFile, legacyExamples, readGolden, DOCK_SEED, DOCK_SECONDS } from './helpers/golden.js';

/** The three legacy examples: since milestone M1 the catalogue also holds the warehouse examples (trucks, schema 2), which this review of M0 does not mean. */
const EXAMPLES = legacyExamples(ALL_EXAMPLES);

const OLD_ROOT = H.oldTreeRoot();
const M0_ROOT = H.m0TreeRoot();
const OLD = OLD_ROOT ? await H.loadTree(OLD_ROOT) : null;
const NEW = await H.loadTree();
const REPO = H.ROOT;
const read = (...parts) => readFileSync(path.join(REPO, ...parts), 'utf8');
const SKIP_OLD = `the pre-M0 tree (commit ${H.OLD_REV}) is not available here: git archive failed. Give a copy with M0_OLD_TREE=<dir with js/>`;
/** A check that needs the pre-M0 tree. */
const live = (name, fn) => test(name, OLD ? {} : { skip: SKIP_OLD }, fn);
/** A check that is too expensive for every run: M0_REVIEW_HEAVY=1. */
const heavy = (name, fn) => test(name, H.HEAVY ? {} : { skip: 'expensive: set M0_REVIEW_HEAVY=1' }, fn);
const heavyLive = (name, fn) => test(name, H.HEAVY && OLD ? {} : { skip: H.HEAVY ? SKIP_OLD : 'expensive: set M0_REVIEW_HEAVY=1' }, fn);
/** A defect found by this review: fails today; a `todo` so that the suite stays green until it is fixed (M0_REVIEW_STRICT=1: a real failure). */
const defect = (name, fn) => test(name, H.STRICT ? {} : { todo: 'a defect found by the M0 review (see its message); fix it, then delete this marker' }, fn);
const defectHeavy = (name, fn) => test(name, H.HEAVY ? (H.STRICT ? {} : { todo: 'a defect found by the M0 review' }) : { skip: 'expensive: set M0_REVIEW_HEAVY=1' }, fn);

const standIn = (fn, opts) => H.withStandIn({ ops: OPS, extensions: EXT }, fn, opts);
const clone = (v) => structuredClone(v);
const bytes = (v) => JSON.stringify(v);
const project = (layout) => ({ name: 'P', scenarios: [{ id: 'a', name: 'A', layout }], activeId: 'a' });

// ---------------------------------------------------------------------------------------------------------
// 1. Behaviour: nothing changes for a legacy plant
// ---------------------------------------------------------------------------------------------------------

// Recorded from the pre-M0 tree (commit eccdca8) by H.captureMatrix: "KPI text . event stream . insights . congestion heat" (8 hex digits
// of a SHA-256 each), for the three examples x seeds 1 to 4 x dt 0.1 and 0.25, 1200 simulated seconds with a warm-up of 300 s and a
// what-if (setRuntime) at 600 s. A different recorded value is a change of behaviour, whatever the golden fixtures say.
const MATRIX = {
  'starter:1:0.1': 'c5f32bc2.8bef5b27.c275b8fc.ae5d4dad',
  'starter:1:0.25': '39dacc92.bfad99b9.2d75565f.a7ad2b0a',
  'starter:2:0.1': 'f4303815.5ab52027.a39523ed.0294b7dd',
  'starter:2:0.25': '73a35101.c5d9c453.d4e03d9e.a4cec396',
  'starter:3:0.1': '493d246f.0b28721b.c4639cd1.ecbee4be',
  'starter:3:0.25': 'b6627332.3961c629.b79a991a.c3fe322a',
  'starter:4:0.1': '2c4e9426.3276c1ef.bcb0a429.7a642ff8',
  'starter:4:0.25': 'c831fbce.d6bb0cf2.bcb0a429.dda1ac02',
  'two-lines:1:0.1': '34de00f2.3e913381.a779ce90.08710812',
  'two-lines:1:0.25': '0ead6bab.400cb5ae.98878347.5f820736',
  'two-lines:2:0.1': '03e88ad4.9f41658f.12c3fc7d.6f828a83',
  'two-lines:2:0.25': 'e3e9dc9f.072d5a9f.44f7c13a.2f84fd8e',
  'two-lines:3:0.1': '7432a8a2.204209e1.7822b598.0f9c1bad',
  'two-lines:3:0.25': 'dcfe61ee.c9f60582.e14466b8.a0104531',
  'two-lines:4:0.1': '5a8b30fe.336c8e33.5eda6414.1e235576',
  'two-lines:4:0.25': '11938bce.787f5b6a.097787c4.50efa291',
  'congestion-lab:1:0.1': '68b22924.3c3254be.ad4ddf1f.1c8a84a9',
  'congestion-lab:1:0.25': '513c52fa.79cc9b6a.a292407b.fbadfc58',
  'congestion-lab:2:0.1': '5dcb5cc1.64c77e76.eb415776.4136328b',
  'congestion-lab:2:0.25': 'c03b16a8.f4baaa5b.e0763101.edf1a87f',
  'congestion-lab:3:0.1': 'db5966b2.d8011860.fad02217.407f5b8c',
  'congestion-lab:3:0.25': '9f3b497f.fe7dca2a.deccd6d5.118f4090',
  'congestion-lab:4:0.1': '55716205.55f309f1.2aeae810.1972d367',
  'congestion-lab:4:0.25': '489ff89c.b8fe33bc.bc04eb6c.4fba72fd',
};

test('M0-REV 1.1 behaviour: the three examples (4 seeds, dt 0.1 and 0.25, a what-if mid-run) reproduce the digests recorded from the pre-M0 tree', () => {
  const wrong = [];
  for (const example of legacyExamples(NEW.EXAMPLES)) {
    for (const seed of H.MATRIX_SEEDS) {
      for (const dt of H.MATRIX_DTS) {
        const key = H.matrixKey(example.id, seed, dt);
        const got = H.digestOf(H.runMatrixCell(NEW, example.id, seed, dt));
        if (got !== MATRIX[key]) wrong.push(`${key}: ${got} (recorded ${MATRIX[key]}; order: KPI . events . insights . heat)`);
      }
    }
  }
  assert.equal(Object.keys(MATRIX).length, legacyExamples(NEW.EXAMPLES).length * H.MATRIX_SEEDS.length * H.MATRIX_DTS.length, 'the table covers the whole matrix');
  assert.deepEqual(wrong, [], 'a legacy example gave other results than the pre-M0 tree');
});

live('M0-REV 1.2 behaviour: the recorded table is what the pre-M0 tree really gives (a cell recomputed from the tree itself, three with M0_REVIEW_HEAVY=1)', () => {
  for (const [id, seed, dt] of H.HEAVY ? [['starter', 4, 0.25], ['two-lines', 2, 0.25], ['congestion-lab', 3, 0.1]] : [['two-lines', 2, 0.25]]) {
    assert.equal(H.digestOf(H.runMatrixCell(OLD, id, seed, dt)), MATRIX[H.matrixKey(id, seed, dt)], `${id} seed ${seed} dt ${dt}`);
  }
});

// Recorded the same way for dock-dense plants (docks-review-gen dockPlant), which react to EVERY setting of the dock book (see 2.2):
// "KPI text . event stream". `layout` is a hash of the generated layout: if the generator changes, the check skips instead of lying.
const DOCK_NET = {
  2: { layout: '7b53a19faa', digest: '0862090d.6a1455fc' },
  4: { layout: 'eae7b3ef27', digest: '65740e6f.48ef4740' },
  13: { layout: 'd6eed08dd5', digest: '28adfa48.151938ff' },
  22: { layout: '5dfdbe2f63', digest: '68267d23.fc49268c' },
  25: { layout: '27074822b9', digest: 'd692a7ad.261ff5ab' },
};

test('M0-REV 1.3 behaviour: dock-dense plants (the code M1 and M3 touch most) reproduce the digests recorded from the pre-M0 tree', async (t) => {
  const { dockPlant } = await import('./helpers/docks-review-gen.js');
  const wrong = [];
  let compared = 0;
  for (const { seed, seconds } of H.HEAVY ? H.DOCK_NET : H.DOCK_NET.slice(0, 3)) {
    const layout = dockPlant(seed);
    if (H.sha(bytes(layout), 10) !== DOCK_NET[seed].layout) continue; // the generator changed: this plant is not the recorded one
    compared++;
    const got = H.runDockPlant(NEW, layout, seconds);
    if (got !== DOCK_NET[seed].digest) wrong.push(`dock plant ${seed}: ${got} (recorded ${DOCK_NET[seed].digest})`);
  }
  if (compared === 0) t.skip('docks-review-gen.js generates other plants than the recorded ones: re-record DOCK_NET with the pre-M0 tree');
  assert.deepEqual(wrong, []);
});

live('M0-REV 1.4 behaviour: plants of the other reviews (hostile, random, dock-dense, two engineered jams, tugger trains) with what-ifs mid-run equal the pre-M0 tree', async () => {
  const plants = await H.generatorPlants(H.HEAVY ? { hostile: 40, random: 40, docks: 30 } : { hostile: 2, random: 1, docks: 1 });
  const wrong = [];
  let events = 0;
  const attempt = (tree, layout, plan) => {
    try {
      return H.runPlan(tree, layout, plan);
    } catch (error) {
      return { texts: { kpi: `THROWS ${error.message}`, events: '', insights: '', heat: '', state: '' }, eventCount: 0 };
    }
  };
  plants.forEach((plant, i) => {
    for (const withSteps of H.HEAVY ? [false, true] : [true]) {
      const seconds = H.HEAVY ? plant.seconds : 400;
      const plan = { seconds, steps: withSteps ? H.slicedSteps(seconds, i) : [] };
      const before = attempt(OLD, plant.layout, plan);
      const after = attempt(NEW, plant.layout, plan);
      events += after.eventCount;
      const difference = H.firstDifference(before, after);
      if (difference) wrong.push(`${plant.name}${withSteps ? ' with what-ifs' : ''}: ${difference}`);
    }
  });
  assert.ok(events > 1000, `the runs were not trivial (${events} events)`);
  assert.deepEqual(wrong, []);
});

heavyLive('M0-REV 1.5 behaviour (heavy): 8 simulated hours of each example, two seeds, and a 160 x 160 plant with 100 vehicles, equal the pre-M0 tree', async () => {
  const wrong = [];
  for (const example of legacyExamples(NEW.EXAMPLES)) {
    for (const seed of [1, 2]) {
      const plan = { seed, seconds: 8 * 3600, steps: H.slicedSteps(8 * 3600, seed) };
      const difference = H.firstDifference(H.runPlan(OLD, example.build(), plan), H.runPlan(NEW, example.build(), plan));
      if (difference) wrong.push(`${example.id} seed ${seed}, 8 h: ${difference}`);
    }
  }
  const { blockPlant } = await import('./helpers/engine-review-gen.js');
  const big = blockPlant(160, 160, 12, 50, 2);
  const difference = H.firstDifference(H.runPlan(OLD, big, { seconds: 600, events: false }), H.runPlan(NEW, big, { seconds: 600, events: false }));
  if (difference) wrong.push(`160 x 160 plant with 100 vehicles, 10 min: ${difference}`);
  assert.deepEqual(wrong, []);
});

test('M0-REV 1.6 behaviour: a legacy plant has no extension object anywhere, and its report has exactly the keys of the old report', () => {
  const REPORT_KEYS = ['window', 'throughput', 'leadTime', 'wip', 'stations', 'fleets', 'flows', 'traffic', 'orders', 'series'];
  for (const example of EXAMPLES) {
    const sim = new Simulation(example.build(), { seed: 1 });
    sim.advance(120);
    assert.equal(sim.logistics.ext, null, `${example.id}: Logistics.ext`);
    assert.equal(sim.logistics.clock, null, `${example.id}: Logistics.clock`);
    assert.equal(sim.stats.ext, null, `${example.id}: Stats.ext`);
    for (const st of sim.stations) assert.deepEqual([st.trucks, st.rack, st.cal], [null, null, null], `${example.id}/${st.id}: station seams`);
    assert.deepEqual(Object.keys(sim.kpis()), REPORT_KEYS, `${example.id}: the keys of the report (an extra key such as "ops" changes the report of every legacy plant)`);
    assert.equal(sim.layout.calendar, undefined);
    assert.ok(sim.insights().every((i) => !String(i.id ?? '').startsWith('ops')), 'no insight of the extension rules');
  }
});

// ---------------------------------------------------------------------------------------------------------
// 2. The golden suite itself
// ---------------------------------------------------------------------------------------------------------

heavyLive('M0-REV 2.1 golden (heavy): the recorded fixtures are the pre-M0 tree\'s own results (not a byproduct of the M0 edits)', async () => {
  const G = await import('./helpers/golden.js');
  const fixtures = await G.captureGolden(OLD);
  const stale = [];
  for (const [file, text] of Object.entries(fixtures)) {
    if (file.startsWith('share.')) continue; // compressed text may vary between zlib versions: compared by what it decodes to below
    if (G.readGolden(file) !== text) stale.push(file);
  }
  for (const example of EXAMPLES) {
    const decoded = await S.decodeShare(G.readGolden(G.shareFile(example.id)).trim().replace(/^.*#p=/, ''));
    if (bytes(decoded.scenarios[0].layout) !== G.readGolden(G.layoutFile(example.id))) stale.push(G.shareFile(example.id));
  }
  assert.deepEqual(stale, [], 'fixtures that the pre-M0 tree does not reproduce');
});

test('M0-REV 2.2 golden: the dock-dense plants of the review react to each of 8 dock-book settings (so a digest above would notice them)', async () => {
  const { dockPlant } = await import('./helpers/docks-review-gen.js');
  const insensitive = [];
  for (const { seed, seconds } of H.DOCK_NET.filter((p) => p.seed === 22)) {
    const layout = dockPlant(seed);
    const base = H.runDockPlant(NEW, layout, seconds);
    for (const [name, knob] of Object.entries(H.DOCK_KNOBS)) if (H.runDockPlant(NEW, layout, seconds, knob) === base) insensitive.push(`plant ${seed} does not feel "${name}"`);
  }
  assert.deepEqual(insensitive, [], 'a plant of the net that does not change when the dock book changes is no net');
});

heavy('M0-REV 2.3 golden (heavy): six deliberate regressions in a scratch copy; the golden tests catch every one', () => {
  const clean = H.runGoldenAgainst(null);
  assert.deepEqual([clean.fail, clean.tests > 10], [0, true], 'the unchanged scratch copy passes the golden tests');
  const slipped = [];
  const report = [];
  for (const mutant of H.MUTANTS) {
    const run = H.runGoldenAgainst(mutant);
    report.push(`${mutant.name}: ${run.fail} of ${run.tests} golden tests fail`);
    if (run.fail === 0) slipped.push(mutant.name);
  }
  assert.deepEqual(slipped, [], `regressions that slipped through the golden tests:\n${report.join('\n')}`);
  if (slipped.length) console.log(`# golden mutation: slipped through: ${slipped.join('; ')}\n# ${report.join('\n# ')}`);
});

heavy('M0-REV 2.4 golden (heavy): the five dock-dense plants of the review notice at least 11 of the 12 dock constants (the golden fixtures notice 4)', async () => {
  const { dockPlant } = await import('./helpers/docks-review-gen.js');
  const plants = H.DOCK_NET.map((p) => ({ ...p, layout: dockPlant(p.seed) }));
  const reference = plants.map((p) => H.runDockPlant(NEW, p.layout, p.seconds));
  const unnoticed = [];
  for (const mutant of H.DOCK_MUTANTS) {
    const noticed = await H.withMutantTree(mutant, (tree) => plants.some((p, k) => H.runDockPlant(tree, p.layout, p.seconds) !== reference[k]));
    if (!noticed) unnoticed.push(mutant.name);
  }
  assert.ok(unnoticed.length <= 1, `dock constants that no plant of the net notices: ${unnoticed.join('; ')}`);
});

test('M0-REV fixed 3 (was a medium defect): the golden dock fixtures can feel the blocking weight of the dock choice (a changed DOCK_BLOCK_WEIGHT no longer passes the safety net unseen)', async () => {
  // The knob is an instance field of the dock book, so a golden run can be repeated in process with one setting changed.
  const G = await import('./helpers/golden.js');
  const felt = [];
  for (const seed of G.DOCKPLANT_SEEDS) {
    const sim = new Simulation(JSON.parse(G.readGolden(G.dockPlantLayoutFile(seed))));
    sim.logistics.docks.blockWeight = 5; // DOCK_BLOCK_WEIGHT is 2
    sim.advance(G.DOCKPLANT_SECONDS);
    if (bytes(sim.kpis()) !== G.readGolden(G.dockPlantKpisFile(seed))) felt.push(`dock plant ${seed}`);
  }
  assert.ok(felt.length >= 2, `only ${felt.join(', ') || 'no golden fixture'} changes when the blocking weight of the dock choice goes from 2 to 5; a regression there would pass the safety net`);
});

heavy('M0-REV fixed 3b (was a medium defect, heavy): of 12 dock constants changed by 25 to 100 %, the golden tests notice every one', () => {
  const slipped = [];
  for (const mutant of H.DOCK_MUTANTS) if (H.runGoldenAgainst(mutant).fail === 0) slipped.push(mutant.name);
  assert.deepEqual(slipped, [], 'dock constants whose change no golden test notices');
});

// ---------------------------------------------------------------------------------------------------------
// 3. Round trips, schema, hostile input
// ---------------------------------------------------------------------------------------------------------

/** A layout with at least one source, sink, storage, process, flow and fleet (the first example). */
const withEverything = () => {
  const layout = EXAMPLES.find((e) => e.id === 'two-lines').build();
  assert.ok(['source', 'sink', 'storage', 'process'].every((type) => layout.stations.some((s) => s.type === type)) && layout.flows.length && layout.fleets.length);
  return layout;
};

test('M0-REV 3.1 schemaNeeded: every row of the table of 5.2, written down again from the document, gives its number alone; a legacy plant gives 1', () => {
  assert.equal(SC.schemaNeeded(withEverything()), 1);
  for (const example of EXAMPLES) assert.equal(SC.schemaNeeded(example.build()), 1, example.id);
  const wrong = [];
  for (const { row, what, put } of H.SCHEMA_TABLE) {
    const layout = withEverything();
    put(layout);
    const got = SC.schemaNeeded(layout);
    if (got !== row) wrong.push(`${what}: ${got}, the table says ${row}`);
  }
  assert.deepEqual(wrong, []);
  assert.deepEqual([...new Set(H.SCHEMA_TABLE.map((c) => c.row))], [2, 3, 4, 5, 6, 7], 'the oracle covers every row of the table');
  assert.equal(SC.SCHEMA_ROWS.length, 7, 'and schema.js has exactly seven rows');
});

test('M0-REV 3.2 schemaNeeded: the maximum wins (any subset of keys), and it never throws on junk', () => {
  const rng = createRng(5);
  for (let i = 0; i < 100; i++) {
    const layout = withEverything();
    const chosen = H.SCHEMA_TABLE.filter(() => rng.next() < 0.15);
    for (const c of chosen) c.put(layout);
    const expected = Math.max(1, ...chosen.map((c) => c.row));
    assert.equal(SC.schemaNeeded(layout), expected, chosen.map((c) => c.what).join(' + '));
  }
  for (let i = 0; i < 100; i++) {
    const doc = H.parsed(H.junkDocument(rng, EXAMPLES[i % 3].build()));
    const need = SC.schemaNeeded(doc);
    assert.ok(Number.isInteger(need) && need >= 1 && need <= 7, `junk document ${i}: ${need}`);
  }
  for (const odd of [undefined, null, 0, 'x', [], [[]], () => 1, { stations: 5, fleets: 'x', flows: null }, { stations: [null, 3, 'x', { ops: 5 }, { ops: [] }] }]) assert.equal(SC.schemaNeeded(odd), 1);
});

test('M0-REV 3.3 hostile input: junk in every place of the warehouse module is dropped except the keys M1 implements (ops.trucks on Goods in and Goods out, calendar); the rest is byte-equal to the pre-M0 result; total, idempotent, valid', () => {
  const rng = createRng(31337);
  const bases = EXAMPLES.map((e) => e.build());
  const TOP = ['schema', 'name', 'notes', 'grid', 'roads', 'obstacles', 'labels', 'stations', 'flows', 'fleets', 'settings'];
  const STATION = ['id', 'type', 'name', 'x', 'y', 'w', 'h', 'params'];
  const count = H.HEAVY ? 3000 : 80;
  /** What the pre-M0 tree would have made of the document: the M1 keys taken off, the stamp back at 1. */
  const legacyView = (layout) => {
    const view = clone(layout);
    delete view.calendar;
    for (const s of view.stations) delete s.ops;
    view.schema = 1;
    return view;
  };
  let withJunkOps = 0;
  let kept = 0;
  for (let i = 0; i < count; i++) {
    const raw = H.junkDocument(rng, bases[i % 3]);
    const text = bytes(raw);
    withJunkOps += raw.stations.some((s) => s && s.ops !== undefined) ? 1 : 0;
    const frozen = H.deepFreeze(JSON.parse(text)); // a write into the input throws
    const out = L.normalizeLayout(frozen);
    assert.deepEqual(Object.keys(out), 'calendar' in out ? [...TOP, 'calendar'] : TOP, `document ${i}: a key of a later milestone survived in the layout`);
    for (const s of out.stations) {
      assert.deepEqual(Object.keys(s), s.ops ? [...STATION, 'ops'] : STATION, `document ${i}: station keys`);
      if (s.ops) {
        kept++;
        assert.ok(s.type === 'source' || s.type === 'sink', `document ${i}: ops on a ${s.type}`);
        assert.deepEqual(Object.keys(s.ops), ['trucks'], `document ${i}: only M1 keys`);
      }
    }
    for (const f of out.fleets) assert.ok(!('calendar' in f) && !('aisleMin' in f) && !('liftHeight' in f), `document ${i}: fleet keys`);
    for (const f of out.flows) assert.ok(!('types' in f), `document ${i}: flow keys`);
    assert.ok(!('loadTypes' in out), `document ${i}: loadTypes`);
    assert.equal(out.schema, 'calendar' in out || out.stations.some((s) => s.ops) ? 2 : 1, `document ${i}: schema`);
    assert.deepEqual(L.checkInvariants(out), [], `document ${i}: invariants`);
    assert.equal(bytes(L.normalizeLayout(out)), bytes(out), `document ${i}: idempotent`);
    assert.equal(bytes(frozen), text, `document ${i}: the input was modified`);
    const legacy = legacyView(out);
    if (OLD) assert.equal(bytes(legacy), bytes(OLD.layout.normalizeLayout(JSON.parse(text))), `document ${i}: differs from the pre-M0 normalizeLayout`);
    const exported = S.exportProject(project(out));
    assert.equal(JSON.parse(exported).schema, out.schema, `document ${i}: project schema`);
    assert.equal(bytes(S.importProject(exported).scenarios[0].layout), bytes(out), `document ${i}: export/import`);
    if (OLD) assert.equal(S.exportProject(project(legacy)), OLD.serialize.exportProject(project(OLD.layout.normalizeLayout(JSON.parse(text)))), `document ${i}: the project file of the legacy part differs from the pre-M0 file`);
  }
  assert.ok(withJunkOps > count / 3, 'the fuzz really put ops junk on stations');
  assert.ok(kept > count / 8, `the fuzz put real trucks blocks on stations (${kept})`);
  assert.deepEqual(Object.keys(Object.prototype), [], 'Object.prototype was polluted');
  for (const name of ['doors', 'trucks', 'calendar', 'ops', 'polluted', 'startTod']) assert.equal({}[name], undefined, `Object.prototype.${name}`);
});

test('M0-REV 3.4 hostile input with a sanitizer registered (the way M1 plugs in): the wiring keeps what the sanitizer returns, only where it belongs, and everything stays total, idempotent and round-trippable', async () => {
  await standIn(async () => {
    const rng = createRng(4242);
    const bases = EXAMPLES.map((e) => e.build());
    let kept = 0;
    let shared = 0;
    for (let i = 0; i < (H.HEAVY ? 1500 : 100); i++) {
      const raw = H.junkDocument(rng, bases[i % 3]);
      const text = bytes(raw);
      const out = L.normalizeLayout(H.deepFreeze(JSON.parse(text)));
      for (const s of out.stations) {
        const want = OPS.sanitizeOps(s.type, s.ops);
        assert.equal(bytes(s.ops), bytes(want), `document ${i}: ${s.id} (${s.type}) keeps an ops block that its sanitizer would not keep`);
        if (s.ops !== undefined) {
          kept++;
          assert.ok(['source', 'sink'].includes(s.type), `document ${i}: ops on a ${s.type}`);
          assert.deepEqual(Object.keys(s), ['id', 'type', 'name', 'x', 'y', 'w', 'h', 'params', 'ops'], 'ops comes right after params');
        }
      }
      assert.equal(out.schema, SC.schemaNeeded(out), `document ${i}: the stamp is what the content needs`);
      if (out.stations.some((s) => s.ops)) assert.ok(out.schema >= 2, `document ${i}: trucks make it at least 2`);
      assert.deepEqual(L.checkInvariants(out), [], `document ${i}: invariants`);
      assert.equal(bytes(L.normalizeLayout(out)), bytes(out), `document ${i}: idempotent`);
      const exported = S.exportProject(project(out));
      assert.equal(JSON.parse(exported).schema, out.schema, `document ${i}: the project is stamped with the layout's schema`);
      const back = S.importProject(exported);
      assert.equal(bytes(back.scenarios[0].layout), bytes(out), `document ${i}: export/import keeps the ops blocks`);
      assert.equal(Boolean(back.warnings), out.schema > SC.SCHEMA_MAX, `document ${i}: it warns exactly when the schema is above SCHEMA_MAX (${SC.SCHEMA_MAX})`);
      if (i % 20 === 0) {
        const link = await S.encodeShare(project(out));
        assert.equal(bytes((await S.decodeShare(link)).scenarios[0].layout), bytes(out), `document ${i}: share link`);
        shared++;
      }
    }
    // the wiring against the RAW value: on an otherwise clean plant every station keeps exactly what its sanitizer makes of what the file said
    for (let i = 0; i < 40; i++) {
      const raw = clone(bases[i % 3]);
      for (const s of raw.stations) if (rng.next() < 0.8) s.ops = { trucks: H.junkTrucks(rng) };
      const out = L.normalizeLayout(H.parsed(raw));
      assert.equal(out.stations.length, raw.stations.length);
      out.stations.forEach((s, j) => assert.equal(bytes(s.ops), bytes(OPS.sanitizeOps(raw.stations[j].type, H.parsed(raw.stations[j]).ops)), `clean plant ${i}: station ${s.id}`));
    }
    assert.ok(kept > 20 && shared >= 5, `the fuzz exercised the ops path (${kept} blocks kept, ${shared} share links)`);
    assert.deepEqual(Object.keys(Object.prototype), []);
  }, { calendar: true });
  assert.deepEqual(Object.keys(OPS.OPS_SANITIZERS).sort(), ['sink', 'source'], 'the stand-in was removed again and the real sanitizers are back');
  assert.equal(OPS.sanitizeOps('source', { trucks: { doors: 99 } }).trucks.doors, 32);
  assert.equal(EXT.EXTENSION_BLOCKS.length, 1);
  assert.equal(EXT.EXTENSION_BLOCKS[0].sanitize, CAL.sanitizeCalendar);
});

test('M0-REV 3.5 a v1 file survives import and export byte for byte, with no warning, in the new code and in the old (examples and random plants)', async () => {
  const plants = [...EXAMPLES.map((e) => e.build())];
  const { randomPlant } = await import('./helpers/sim-invariants.js');
  for (let seed = 1; seed <= 12; seed++) plants.push(randomPlant(seed));
  for (const layout of plants) {
    const p = project(L.normalizeLayout(layout));
    const file = S.exportProject(p);
    const imported = S.importProject(file);
    assert.equal(imported.warnings, undefined, `${layout.name}: no warning for a file at or below SCHEMA_MAX`);
    assert.equal(S.exportProject(imported), file, `${layout.name}: export(import(file)) is the file`);
    assert.equal(JSON.parse(file).schema, 1);
    assert.equal(JSON.parse(file).scenarios[0].layout.schema, 1);
    const link = await S.shareUrl('https://example.test/app/', p);
    assert.equal(S.exportProject(await S.decodeShare(link.slice(link.indexOf('#p=') + 3))), file, `${layout.name}: the share link decodes to the same file`);
    if (OLD) {
      assert.equal(file, OLD.serialize.exportProject(project(OLD.layout.normalizeLayout(clone(layout)))), `${layout.name}: the file of the pre-M0 tree`);
      assert.equal(link, await OLD.serialize.shareUrl('https://example.test/app/', project(OLD.layout.normalizeLayout(clone(layout)))), `${layout.name}: the share link of the pre-M0 tree, character for character`);
      const oldImported = OLD.serialize.importProject(file);
      assert.equal(bytes(oldImported.scenarios[0].layout), bytes(imported.scenarios[0].layout), `${layout.name}: both trees open the file the same way`);
    }
  }
});

test('M0-REV 3.6 a file from the future: a warning, never a crash, and the autosave of a newer tab is kept as a backup before anything overwrites it', () => {
  const layout = EXAMPLES[0].build();
  const file = JSON.parse(S.exportProject(project(layout)));
  const future = SC.SCHEMA_MAX + 1; // M1 reads format 2; the shifts of M2 are format 3
  file.schema = future;
  file.scenarios[0].layout.schema = future;
  file.scenarios[0].layout.stations[0].ops = { trucks: { doors: 3 } };
  file.scenarios[0].layout.calendar = { startTod: 21600, startDay: 0, shifts: [{ id: 'early' }] };
  const text = bytes(file);
  const opened = S.importProject(text);
  assert.equal(opened.warnings.length, 1);
  assert.match(opened.warnings[0], new RegExp(`newer version of LogiPlan \\(format ${future}; this version reads format ${SC.SCHEMA_MAX}\\)`));
  assert.equal(opened.scenarios[0].layout.schema, SC.SCHEMA_MAX, 'what this build cannot express (the shifts) is dropped, the trucks and the clock stay, and the layout says what it needs');
  assert.deepEqual(opened.scenarios[0].layout.calendar, { startTod: 21600, startDay: 0 });
  assert.deepEqual(L.checkInvariants(opened.scenarios[0].layout), []);
  for (const schema of [1e308, 2.5, 99, 8]) {
    const odd = { ...file, schema };
    assert.equal(S.importProject(bytes(odd)).warnings.length, 1, `project schema ${schema}`);
  }
  for (const schema of [-5, 0, 1, '2', null, true, [], {}]) {
    const odd = { ...file, schema, scenarios: [{ ...file.scenarios[0], layout: { ...file.scenarios[0].layout, schema: 1 } }] };
    assert.equal(S.importProject(bytes(odd)).warnings, undefined, `project schema ${bytes(schema)} is not newer`);
  }
  // the whole chain in the store: restore warns, and the next save keeps the original text
  const mem = new Map([['key', text]]);
  const storage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
  const store = createStore({ storage, storageKey: 'key', setTimeout: () => 0, clearTimeout: () => 0 });
  assert.equal(store.restore(), true);
  assert.equal(store.lastRestoreWarnings.length, 1);
  store.commit('Rename', (d) => { d.name = 'changed'; });
  store.persist();
  assert.equal(mem.get('key:backup'), text, 'the file of the newer version was copied to the backup before it was overwritten');
});

test('M0-REV 3.7 ops of the wrong type, on the wrong stations, or with prototype keys, in a patch: nothing is stored on a type without options, a sanitized block or nothing on Goods in and Goods out, nothing is polluted, no throw', () => {
  const layout = withEverything();
  const before = bytes(layout);
  const junkPatches = [null, 0, 1, -1, 1e300, '', 'x', true, false, [], [1, 2], {}, { trucks: 5 }, { trucks: null }, { __proto__: { polluted: 1 } }, JSON.parse('{"__proto__":{"polluted":1}}'),
    JSON.parse('{"trucks":{"__proto__":{"polluted":1},"doors":3}}'), { constructor: { prototype: { polluted: 1 } } }, { toString: 1, hasOwnProperty: 2 }, { trucks: { doors: 1e300, schedule: 'x' } }];
  for (const station of layout.stations) {
    const carries = station.type === 'source' || station.type === 'sink';
    for (const patch of junkPatches) {
      assert.equal(L.updateStation(layout, station.id, { ops: patch }), true);
      if (!carries) assert.equal(station.ops, undefined, `${station.type}: nothing is stored without a sanitizer (${bytes(patch)})`);
      else assert.equal(bytes(station.ops), bytes(OPS.sanitizeOps(station.type, station.ops)), `${station.type}: what is stored is a fixed point of its sanitizer (${bytes(patch)})`);
      assert.deepEqual(L.checkInvariants(layout), [], `${station.type}: the layout stays valid after ${bytes(patch)}`);
    }
    assert.equal(L.updateStation(layout, station.id, { ops: undefined, name: station.name }), true, 'undefined means "no change"');
    assert.equal(L.updateStation(layout, station.id, { ops: null }), true);
  }
  assert.equal(bytes(layout), before, 'removing the blocks again leaves the legacy layout, byte for byte');
  assert.equal(L.updateStation(layout, 'nope', { ops: {} }), false);
  assert.equal(L.updateStation(layout, layout.stations[0].id, null), false);
  assert.deepEqual(Object.keys(Object.prototype), []);
  assert.equal({}.polluted, undefined);
  const dup = L.duplicateStation(layout, layout.stations[0].id, { dx: 0, dy: 8 });
  if (dup) assert.equal(dup.ops, undefined, 'a copy of a station without ops has none');
});

test('M0-REV 3.8 a patch can reach an ops sanitizer only through sanitizeOps / mergeOps: stand-in sanitizer, hostile patches, prototype keys, atomic geometry', () => {
  standIn(() => {
    const layout = withEverything();
    const source = layout.stations.find((s) => s.type === 'source');
    assert.equal(L.updateStation(layout, source.id, { ops: { trucks: { doors: 3 } } }), true);
    assert.equal(bytes(source.ops.trucks.doors), '3');
    assert.equal(layout.schema, 2, 'the stamp follows the content');
    // a key outside the sanitizer, prototype keys, wrong types, huge numbers
    L.updateStation(layout, source.id, { ops: JSON.parse('{"trucks":{"__proto__":{"polluted":1},"doors":1e300,"checkIn":"abc","extra":1},"junk":1}') });
    assert.deepEqual(Object.keys(source.ops), ['trucks']);
    assert.equal(source.ops.trucks.doors, 32, 'clamped');
    assert.equal(source.ops.trucks.checkIn, 300, 'junk takes the default of the block');
    assert.equal({}.polluted, undefined);
    assert.deepEqual(L.checkInvariants(layout), []);
    // atomic: a blocked move rejects the ops of the same patch
    const snapshot = bytes(layout);
    assert.equal(L.updateStation(layout, source.id, { x: -50, ops: { trucks: { doors: 7 } } }), false);
    assert.equal(bytes(layout), snapshot);
    // null removes
    assert.equal(L.updateStation(layout, source.id, { ops: null }), true);
    assert.equal(source.ops, undefined);
    assert.equal(layout.schema, 1, 'and the stamp goes back to 1');
    // a station type without a sanitizer cannot carry ops, whatever the patch
    const storage = layout.stations.find((s) => s.type === 'storage');
    L.updateStation(layout, storage.id, { ops: { trucks: { doors: 3 } } });
    assert.equal(storage.ops, undefined);
  });
});

// A mutator sequence through the REAL store (its commit rolls an edit back when checkInvariants finds a problem), with a sanitizer registered.
test('M0-REV 3.9 mutators keep the ops blocks and the schema stamp true through the store: move, resize, duplicate, translate, grow, trim, patch, undo, redo', () => {
  standIn(() => {
    const store = createStore({ storage: null });
    store.replaceLayout(withEverything());
    const layout0 = store.getState().layout;
    const sources = layout0.stations.filter((s) => s.type === 'source').map((s) => s.id);
    const rng = createRng(77);
    const opsOf = () => Object.fromEntries(store.getState().layout.stations.filter((s) => s.ops).map((s) => [s.id, bytes(s.ops)]));
    store.commit('Add doors', (d) => L.updateStation(d, sources[0], { ops: { trucks: { doors: 4 } } }));
    store.commit('Add doors', (d) => L.updateStation(d, sources[1] ?? sources[0], { ops: { trucks: { doors: 2, mode: 'schedule', schedule: [{ at: 100, pallets: 5, days: [0, 3] }] } } }));
    assert.equal(store.getState().layout.schema, 3, 'a timetable row with days is schema 3 (trucks 2, schedule[].days 3)');
    const survivors = opsOf();
    const edits = [
      (d) => L.moveStation(d, rng.pick(Object.keys(survivors)), rng.int(30), rng.int(20)),
      (d) => L.resizeStation(d, sources[0], { x: d.stations.find((s) => s.id === sources[0]).x, y: d.stations.find((s) => s.id === sources[0]).y, w: 2 + rng.int(3), h: 2 }),
      (d) => !!L.duplicateStation(d, rng.pick(Object.keys(survivors)), { dx: rng.int(6) - 3, dy: rng.int(6) - 3 }),
      (d) => L.translateAll(d, rng.int(3) - 1, rng.int(3) - 1),
      (d) => { L.growGrid(d, { left: rng.int(3), top: rng.int(3), right: rng.int(3), bottom: rng.int(3) }); },
      (d) => { L.trimGrid(d, { margin: 2 + rng.int(4) }); },
      (d) => L.updateStation(d, rng.pick(Object.keys(survivors)), { ops: { trucks: { doors: 1 + rng.int(40) } } }),
      (d) => L.updateStation(d, rng.pick(Object.keys(survivors)), { name: `n${rng.int(99)}`, params: { batch: 1 + rng.int(3) } }),
      (d) => L.setName(d, `plant ${rng.int(9)}`),
      (d) => L.updateSettings(d, { dt: rng.pick([0.1, 0.25]) }),
    ];
    for (let i = 0; i < 120; i++) {
      const edit = rng.pick(edits);
      try {
        store.commit(`edit ${i}`, edit);
      } catch (error) {
        assert.fail(`edit ${i} was rolled back: ${error.message}`);
      }
      const layout = store.getState().layout;
      assert.deepEqual(L.checkInvariants(layout), [], `edit ${i}`);
      assert.equal(layout.schema, SC.schemaNeeded(layout), `edit ${i}: stamp`);
      for (const s of layout.stations) if (s.ops) assert.deepEqual(Object.keys(s).slice(-2), ['params', 'ops'], `edit ${i}: ops follows params`);
      if (i % 17 === 0) { store.undo(); store.undo(); store.redo(); assert.deepEqual(L.checkInvariants(store.getState().layout), [], `edit ${i} after undo/redo`); }
    }
    assert.ok(Object.keys(opsOf()).length >= 2, 'ops blocks are still there');
  });
});

test('M0-REV fixed 1 (was a medium defect): deleting the last station that carries ops is accepted by the store (removeStation re-derives layout.schema)', () => {
  standIn(() => {
    const store = createStore({ storage: null });
    store.replaceLayout(withEverything());
    const id = store.getState().layout.stations.find((s) => s.type === 'source').id;
    store.commit('Add doors', (d) => L.updateStation(d, id, { ops: { trucks: { doors: 3 } } }));
    assert.equal(store.getState().layout.schema, 2);
    assert.doesNotThrow(() => store.commit('Delete', (d) => L.removeStation(d, id)),
      'deleting a Goods in that has dock doors must work; today: "Edit was rolled back because it left the layout invalid: schema must be 1"');
    assert.equal(store.getState().layout.schema, 1, 'with nothing left that needs schema 2, the layout is a legacy layout again');
  });
});

test('M0-REV fixed 1b (was a medium defect): shrinking the plan so that a station with ops falls off the edge is accepted by the store too (resizeGrid calls removeStation)', () => {
  standIn(() => {
    const store = createStore({ storage: null });
    store.replaceLayout(withEverything());
    const source = store.getState().layout.stations.find((s) => s.type === 'source');
    assert.ok(source.x >= 8, 'the Goods in lies beyond the smallest plan');
    store.commit('Add doors', (d) => L.updateStation(d, source.id, { ops: { trucks: { doors: 3 } } }));
    assert.doesNotThrow(() => store.commit('Shrink', (d) => { L.resizeGrid(d, 4, 4); }), 'a smaller plan that drops the Goods in must be possible');
    assert.equal(store.getState().layout.schema, 1);
  });
});

test('M0-REV fixed 4 (was a low defect): a partial Dist patch (only the mean) keeps the kind and spread of ops.trucks.interArrival, like mergeParams does', () => {
  standIn(() => {
    const layout = withEverything();
    const source = layout.stations.find((s) => s.type === 'source');
    L.updateStation(layout, source.id, { ops: { trucks: { interArrival: { kind: 'exp', mean: 3000, spread: 0.5 } } } });
    assert.equal(source.ops.trucks.interArrival.kind, 'exp');
    L.updateStation(layout, source.id, { ops: { trucks: { interArrival: { mean: 2400 } } } }); // what an experiment sweep (truckGap:<station>) writes
    assert.deepEqual(source.ops.trucks.interArrival, { kind: 'exp', mean: 2400, spread: 0.5 },
      'params merge a distribution field by field (mergeParams); ops do not, so a sweep or a field that sends only the mean silently resets kind and spread');
  });
});

test('M0-REV 3.10 layoutChangeKind: any change in ops, the clock or the schema stamp rebuilds the simulation (structural), a rename stays cosmetic', () => {
  standIn(() => {
    const a = withEverything();
    const b = clone(a);
    L.updateStation(b, b.stations.find((s) => s.type === 'source').id, { ops: { trucks: { doors: 3 } } });
    assert.equal(L.layoutChangeKind(a, b), 'structural');
    const c = clone(a);
    c.calendar = { startTod: 0, startDay: 0 };
    assert.equal(L.layoutChangeKind(a, c), 'structural');
    const d = clone(a);
    L.setName(d, 'other');
    assert.equal(L.layoutChangeKind(a, d), 'cosmetic');
    const e = clone(b);
    L.updateStation(e, e.stations.find((s) => s.type === 'source').id, { ops: { trucks: { doors: 4 } } });
    assert.equal(L.layoutChangeKind(b, e), 'structural');
  });
});

test('M0-REV 3.11 the registries hold what M1 registers and stay inert for a legacy plant: no new issue, no new insight, no new key', () => {
  assert.deepEqual(Object.keys(OPS.OPS_SANITIZERS).sort(), ['sink', 'source']);
  assert.ok(OPS.OPS_KEYS.length > 0 && OPS.OPS_KEYS.every((k) => k.schema === 2));
  assert.ok(CAL.CALENDAR_KEYS.length > 0 && CAL.CALENDAR_KEYS.every((k) => k.schema === 2));
  assert.deepEqual(VOPS.OPS_CHECKS.map((c) => c.name), ['checkDoorsTooFew', 'checkDoorsExceedDocks', 'checkDocksShareLane', 'checkTimetableEmpty']);
  assert.deepEqual(INS.EXTENSION_RULES.map((r) => r.name), ['gateQueueLong', 'doorsBottleneck', 'unloadLimitedByVehicles', 'doorsIdle', 'outboundShort']);
  assert.equal(EXT.EXTENSION_BLOCKS.length, 1);
  for (const example of EXAMPLES) {
    const layout = example.build();
    const issues = validateLayout(layout);
    if (OLD) assert.equal(bytes(issues), bytes(OLD.validate.validateLayout(clone(layout))), `${example.id}: the issues are those of the pre-M0 tree`);
    assert.ok(issues.every((i) => !/^(doors|docks-share|timetable|shift|staffing|profile|calendar|aisle|rack|fleet-cannot|plan-after|type-)/.test(i.code)), `${example.id}: ${issues.map((i) => i.code)}`);
  }
  assert.equal(CAL.mergeCalendar(undefined, { startTod: 5 }).startTod, 5, 'a patch creates the clock');
  assert.equal(CAL.sanitizeCalendar({ startTod: 1 }, {}).startTod, 1, 'a file that has a clock keeps it');
  assert.equal(CAL.sanitizeCalendar(undefined, { stations: [] }), undefined, 'and a plant without one gets none');
  assert.deepEqual(EXT.normalizeExtensions({ calendar: { startTod: 1 }, loadTypes: [{}] }, { stations: [] }), { calendar: { startTod: 1, startDay: 0 } }, 'loadTypes belongs to M5');
});

// ---------------------------------------------------------------------------------------------------------
// 4. Performance neutrality of the hooks
// ---------------------------------------------------------------------------------------------------------

test('M0-REV 4.1 the extension hooks cost nothing for a legacy plant: they run only behind a null test (call counts with a stand-in extension, none without)', () => {
  const sim = new Simulation(EXAMPLES[0].build(), { seed: 1 });
  sim.advance(60);
  const calls = { reset: 0, sample: 0, onEvent: 0, report: 0 };
  sim.stats.ext = {
    reset() { calls.reset++; },
    sample() { calls.sample++; },
    onEvent() { calls.onEvent++; },
    report(r) { calls.report++; r.ops = { seen: true }; },
  };
  const events = [];
  sim.on('*', (payload, name) => events.push(name));
  sim.advance(30);
  const ticks = Math.round(30 / sim.dt);
  assert.equal(calls.sample, ticks, 'one sample call per tick, no more');
  assert.equal(calls.onEvent, events.length, 'one onEvent call per event');
  assert.equal(sim.kpis().ops.seen, true);
  assert.equal(calls.report, 1);
  sim.stats.reset();
  assert.equal(calls.reset, 1);
  sim.stats.ext = null;
  assert.equal('ops' in sim.kpis(), false);
});

heavyLive('M0-REV 4.2 allocation per tick (heavy): the three examples and a 160 x 160 plant with 100 vehicles allocate the same per tick as the pre-M0 tree (within 10 %)', async () => {
  const { blockPlant } = await import('./helpers/engine-review-gen.js');
  const plants = [...EXAMPLES.map((e) => [e.id, () => e.build(), 900, 400]), ['160 x 160, 100 vehicles', () => blockPlant(160, 160, 12, 50, 2), 120, 60]];
  const rows = [];
  for (const [name, build, warm, ticks] of plants) {
    const per = (tree) => {
      const sim = new tree.Simulation(build(), { seed: 1 });
      sim.advance(warm);
      return H.bytesPerTick(sim, { ticks, windows: 40 });
    };
    let [before, after] = [per(OLD), per(NEW)];
    if (after > before * 1.1 + 100) [before, after] = [Math.min(before, per(OLD)), Math.min(after, per(NEW))]; // one more go: the heap is noisy
    rows.push({ name, before: Math.round(before), after: Math.round(after), ok: after <= before * 1.1 + 100 });
  }
  console.log(`# bytes per tick, pre-M0 -> now: ${rows.map((r) => `${r.name} ${r.before} -> ${r.after}`).join('; ')}`);
  assert.deepEqual(rows.filter((r) => !r.ok), []);
});

heavyLive('M0-REV 4.3 CPU per simulated hour (heavy): the three examples and the 160 x 160 plant cost the same as the pre-M0 tree (best of 7 rounds, order alternates, within 12 %)', async () => {
  const { blockPlant } = await import('./helpers/engine-review-gen.js');
  const plants = [...EXAMPLES.map((e) => [e.id, () => e.build(), 2 * 3600]), ['160 x 160, 100 vehicles', () => blockPlant(160, 160, 12, 50, 2), 120]];
  const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1e6; };
  const rows = [];
  for (const [name, build, seconds] of plants) {
    const best = { old: Infinity, now: Infinity };
    for (let round = 0; round < 7; round++) {
      for (const which of round % 2 ? ['now', 'old'] : ['old', 'now']) {
        const sim = new (which === 'old' ? OLD : NEW).Simulation(build(), { seed: 1 });
        const t0 = cpu();
        sim.advance(seconds);
        best[which] = Math.min(best[which], (cpu() - t0) / (seconds / 3600));
      }
    }
    rows.push({ name, ratio: best.now / best.old });
  }
  console.log(`# CPU ratio now / pre-M0 (best of 7): ${rows.map((r) => `${r.name} ${r.ratio.toFixed(3)}`).join('; ')}`);
  assert.deepEqual(rows.filter((r) => r.ratio > 1.12), [], 'more than 12 % slower than the pre-M0 tree (the machine noise of a 2 hour run of the Starter is about 5 %)');
});

// ---------------------------------------------------------------------------------------------------------
// 5. st.capacity
// ---------------------------------------------------------------------------------------------------------

const STATIONS_JS = read('js', 'sim', 'logistics', 'stations.js');

test('M0-REV 5.1 st.capacity: no read of params.capacity is left in the simulation, except the accessor itself and the sanitizer of the runtime parameters', () => {
  const offenders = [];
  const dir = path.join(REPO, 'js', 'sim');
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(dir);
  for (const file of files) {
    read(path.relative(REPO, file)).split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (!/params\??\.capacity|\.capacity\b/.test(line)) return;
      if (/(fleet|cfg|vr|vehicle|this\.capacity = Math\.max|maxCapacity|\bf\.capacity|capacity: \d|demand\.|\bcapacity,|const capacity = vehicle|, capacity\)|\(capacity,)/.test(line) && !/params/.test(line)) return;
      offenders.push(`${path.relative(REPO, file)}:${i + 1}: ${line.trim()}`);
    });
  }
  const allowed = offenders.filter((o) => /stations\.js:\d+: return this\.params\.capacity;/.test(o) || /insights\.js:\d+: .*stationDefs/.test(o) || /experiments\.js/.test(o));
  const rest = offenders.filter((o) => !allowed.includes(o) && !/this\.capacity\b/.test(o) && !/\.capacity\b.*(outCount|inboundTotal|ratio|flow)/.test(o));
  assert.deepEqual(rest.filter((o) => /params/.test(o)), [], 'a reader of params.capacity that does not go through st.capacity');
});

test('M0-REV 5.2 st.capacity answers params.capacity for a storage and undefined for every other type, and equals the pre-M0 params.capacity on every station of every example and hostile plant', async () => {
  const layouts = [...EXAMPLES.map((e) => e.build())];
  const { hostilePlant } = await import('./helpers/engine-review-gen.js');
  for (let s = 1; s <= 25; s++) layouts.push(hostilePlant(s));
  let storages = 0;
  for (const layout of layouts) {
    const sim = new Simulation(layout);
    const old = OLD ? new OLD.Simulation(clone(layout)) : null;
    sim.stations.forEach((st, i) => {
      if (st.type === 'storage') {
        storages++;
        assert.equal(st.capacity, st.params.capacity);
        assert.ok(Number.isInteger(st.capacity) && st.capacity >= 0);
      } else assert.equal(st.capacity, undefined, `${st.type} has no capacity`);
      if (old) assert.equal(st.capacity, old.stations[i].params.capacity, `${st.id}: the same value as before`);
      assert.equal(Object.getOwnPropertyDescriptor(st, 'capacity'), undefined, 'a getter on the prototype, not a field per station');
      assert.equal(typeof Object.getOwnPropertyDescriptor(Object.getPrototypeOf(st), 'capacity').get, 'function');
    });
  }
  assert.ok(storages >= 5);
});

live('M0-REV 5.3 st.capacity: each of the six old reads is gone from the new code and each now reads st.capacity (checked against the pre-M0 source text)', () => {
  const oldStations = readFileSync(path.join(OLD_ROOT, 'js', 'sim', 'logistics', 'stations.js'), 'utf8');
  const oldDispatcher = readFileSync(path.join(OLD_ROOT, 'js', 'sim', 'logistics', 'dispatcher.js'), 'utf8');
  const oldReads = [...oldStations.matchAll(/^.*params\.capacity.*$/gm)].map((m) => m[0].trim()).filter((l) => !l.startsWith('return { capacity'));
  const oldDispatch = [...oldDispatcher.matchAll(/^.*params\.capacity.*$/gm)].map((m) => m[0].trim());
  assert.equal(oldReads.length + oldDispatch.length, 6, 'the design (F10) counts six reads');
  const newStations = STATIONS_JS;
  const newDispatcher = read('js', 'sim', 'logistics', 'dispatcher.js');
  const left = [...newStations.matchAll(/^.*params\.capacity.*$/gm), ...newDispatcher.matchAll(/^.*params\.capacity.*$/gm)].map((m) => m[0].trim())
    .filter((l) => !l.startsWith('return { capacity') && !l.includes('return this.params.capacity') && !/^(\/\/|\*|\/\*)/.test(l));
  assert.deepEqual(left, [], 'reads of params.capacity left in the new code');
  for (const read of ['this.outCount >= this.capacity', 'ratio(this.outCount, this.capacity)', '${this.outCount}/${this.capacity}', 'to.capacity - to.outCount - to.inboundTotal', 'return flow.to.capacity']) assert.ok(newStations.includes(read), `stations.js reads ${read}`);
  assert.ok(newDispatcher.includes('flow.from.capacity ?? Infinity'), 'dispatcher.js line 79');
});

test('M0-REV fixed 2 (was a medium defect): the Jobs overlay asks the station for its capacity (js/ui/render/jobs.js bufferSize), the seventh runtime reader: M3 racks show the right "waiting" threshold', () => {
  const rt = { type: 'storage', params: { capacity: 10 }, outLinks: [] };
  Object.defineProperty(rt, 'capacity', { get: () => 77 }); // what a rack storage will answer in M3
  assert.equal(bufferSize(rt), 77, 'bufferSize must ask the station (st.capacity), as the six readers of the design do');
});

// ---------------------------------------------------------------------------------------------------------
// 6. Hot files, layering, documents
// ---------------------------------------------------------------------------------------------------------

/** Lines that differ between two texts (added + removed), by a plain diff. */
function changedLines(oldFile, newFile) {
  const run = spawnSync('diff', ['-U0', oldFile, newFile], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return (run.stdout || '').split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).length;
}

/** A check that needs the pre-M0 tree and the tree at the end of M0 (the M1 edits are not part of M0). */
const liveM0 = (name, fn) => test(name, OLD && M0_ROOT ? {} : { skip: OLD ? `the tree at the end of M0 (commit ${H.M0_REV}) is not available here: git archive failed. Give a copy with M0_END_TREE=<dir with js/>` : SKIP_OLD }, fn);

liveM0('M0-REV 6.1 hot files: M0 (the tree at its end, not the working tree) edited only the production files of the list (9.9), each by a few lines; the files of the roads-and-canvas wave and the vehicle code are byte-identical', () => {
  const list = (dir) => {
    const out = [];
    const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(path.relative(dir, p)); } };
    walk(dir);
    return out.sort();
  };
  const oldFiles = list(path.join(OLD_ROOT, 'js'));
  const newFiles = list(path.join(M0_ROOT, 'js'));
  const added = newFiles.filter((f) => !oldFiles.includes(f));
  const removed = oldFiles.filter((f) => !newFiles.includes(f));
  assert.deepEqual(removed, []);
  assert.deepEqual(added, ['model/calendar.js', 'model/extensions.js', 'model/ops.js', 'model/schema.js', 'model/validate-ops.js'], 'new files of M0');
  const BUDGET = { // changed lines (added + removed) allowed per edited production file
    'model/layout.js': 45, 'model/serialize.js': 40, 'model/defaults.js': 10, 'model/validate.js': 6, 'sim/logistics.js': 14, 'sim/logistics/stations.js': 40,
    'sim/logistics/dispatcher.js': 4, 'sim/stats.js': 22, 'sim/insights.js': 14,
    'ui/render/jobs.js': 6, // added by the fix pass: bufferSize asks the station (finding 2); the one line of ui/ that M0 may touch
  };
  const edited = [];
  for (const file of oldFiles) {
    if (readFileSync(path.join(OLD_ROOT, 'js', file), 'utf8') === readFileSync(path.join(M0_ROOT, 'js', file), 'utf8')) continue;
    const n = changedLines(path.join(OLD_ROOT, 'js', file), path.join(M0_ROOT, 'js', file));
    if (n > 0) edited.push([file, n]);
  }
  assert.deepEqual(edited.map(([f]) => f).filter((f) => !(f in BUDGET)), [], 'a production file outside the list was edited');
  assert.deepEqual(edited.filter(([f, n]) => n > BUDGET[f]).map(([f, n]) => `${f}: ${n} changed lines (budget ${BUDGET[f]})`), [], 'a hot file got more than a call site');
  for (const never of ['ui/', 'store/', 'sim/graph.js', 'sim/traffic', 'sim/logistics/vehicles.js', 'sim/logistics/idle.js', 'sim/logistics/docks.js', 'sim/logistics/routing.js', 'sim/engine.js', 'sim/experiments.js', 'main.js']) {
    assert.deepEqual(edited.map(([f]) => f).filter((f) => f.startsWith(never) && f !== 'ui/render/jobs.js'), [], `${never} must not change in M0`);
  }
});

test('M0-REV 6.2 layering (ARCHITECTURE 3): the pure model modules of the warehouse module import only util, defaults.js and each other, never layout.js (validate-ops.js is the one that may); the store does not import them', () => {
  const importsOf = (file) => [...read('js', 'model', file).matchAll(/^import [^;]*? from '([^']+)';/gm)].map((m) => m[1]); // also an import over several lines
  assert.deepEqual(importsOf('schema.js'), ['./defaults.js']);
  assert.deepEqual(importsOf('ops.js'), ['../util/format.js', './defaults.js']);
  assert.deepEqual(importsOf('calendar.js'), ['./ops.js']);
  assert.deepEqual(importsOf('extensions.js'), ['./calendar.js', './schema.js']);
  assert.deepEqual(importsOf('doors.js'), ['../util/format.js', '../util/rng.js', './ops.js']);
  assert.ok(importsOf('validate-ops.js').includes('./layout.js'), 'the one pure model module that may import layout.js');
  const arch = read('docs', 'ARCHITECTURE.md');
  assert.match(arch, /`schema\.js` → `defaults\.js`; `ops\.js` → `util`, `defaults\.js`; `calendar\.js` → `ops\.js`; `extensions\.js` → `calendar\.js`, `schema\.js`; `doors\.js` → `util`, `ops\.js`/);
  for (const [name, patterns] of Object.entries({ store: [/model\/(schema|ops|calendar|extensions|doors)\.js/] })) {
    const dir = path.join(REPO, 'js', name);
    const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const file of walk(dir)) for (const p of patterns) assert.ok(!p.test(readFileSync(file, 'utf8')), `${path.relative(REPO, file)} imports a seam module`);
  }
});

test('M0-REV 6.3 documents: ARCHITECTURE 3.1 names exactly the exports, files and commands that exist', () => {
  const arch = read('docs', 'ARCHITECTURE.md');
  const section = arch.slice(arch.indexOf('### 3.1 Extension seams'), arch.indexOf('## 4. Domain model'));
  const exportsOf = { 'ops.js': OPS, 'extensions.js': EXT, 'schema.js': SC, 'calendar.js': CAL, 'validate-ops.js': VOPS, 'insights.js': INS };
  for (const [name, file] of [['OPS_SANITIZERS', 'ops.js'], ['EXTENSION_BLOCKS', 'extensions.js'], ['OPS_KEYS', 'ops.js'], ['CALENDAR_KEYS', 'calendar.js'], ['OPS_CHECKS', 'validate-ops.js'], ['EXTENSION_RULES', 'insights.js'],
    ['SCHEMA_MAX', 'schema.js'], ['schemaNeeded', 'schema.js'], ['migrate', 'schema.js'], ['normalizeExtensions', 'extensions.js'], ['reconcileLayout', 'extensions.js'], ['validateOps', 'validate-ops.js']]) {
    assert.ok(section.includes(name), `ARCHITECTURE 3.1 names ${name}`);
    assert.ok(name in exportsOf[file], `${name} is exported by ${file}`);
  }
  for (const file of ['scripts/rebaseline-golden.mjs', 'scripts/perf-baseline.mjs', 'tests/helpers/golden.js', 'tests/fixtures/golden/perf-baseline.json', 'tests/sim.golden.starter.test.js']) assert.ok(existsSync(path.join(REPO, file)), `${file} exists`);
  const readme = read('README.md');
  for (const script of ['scripts/perf-baseline.mjs', 'scripts/rebaseline-golden.mjs']) assert.ok(readme.includes(script) && existsSync(path.join(REPO, script)), script);
  assert.equal(SC.SCHEMA_MAX, 2);
});

heavy('M0-REV 6.3b documents (heavy): rebaseline-golden.mjs --check runs and finds every fixture up to date', () => {
  const cli = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'rebaseline-golden.mjs'), '--check'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stdout.slice(-400));
  assert.match(cli.stdout, /All fixtures are up to date/);
});

test('M0-REV 6.4 documents: the fixed shapes of 5.4 are the shapes the code creates (key order and initial values), in the design, in ARCHITECTURE and in the code', () => {
  const design = read('docs', 'WAREHOUSE-DESIGN.md');
  const parse = (list) => list.split(',').map((s) => s.trim()).filter(Boolean).map((s) => { const [k, v] = s.split(':').map((x) => x.trim()); return [k, v === undefined ? undefined : Number(v)]; });
  const loadSpec = parse(/- Load: `\{ ([^}]*) \}`/.exec(design)[1]);
  const orderExtra = parse(/the existing fields plus `([^`]*)`/.exec(design)[1]);
  const sim = new Simulation(EXAMPLES[0].build(), { seed: 1 });
  const events = [];
  sim.on('loadCreated', (p) => events.push(['load', p.load]));
  sim.on('orderAssigned', (p) => events.push(['order', p.order]));
  sim.advance(900);
  const load = events.find(([k]) => k === 'load')[1];
  const order = events.find(([k]) => k === 'order')[1];
  assert.deepEqual(Object.keys(load), loadSpec.map(([k]) => k));
  for (const [k, v] of loadSpec) if (v !== undefined) assert.equal(load[k], v, `load.${k}`);
  assert.deepEqual(Object.keys(order).slice(-orderExtra.length), orderExtra.map(([k]) => k));
  for (const [k, v] of orderExtra) assert.equal(order[k], v, `order.${k}`);
  const arch = read('docs', 'ARCHITECTURE.md');
  assert.ok(arch.includes('Load = { id, createdAt, origin, readyAt, claimed, ty, tk, at, slot }'));
  assert.ok(arch.includes('pickedAt, deliveredAt, pickAt, dropAt, pickExtra, dropExtra }'));
});

test('M0-REV fixed 5 (was a low defect): Appendix C of the design states what the tree gives for the dock bays (310, 156, 1) and the row (465, 0, ...), next to the dated first measurement (311, 155, 2)', async () => {
  const design = read('docs', 'WAREHOUSE-DESIGN.md');
  assert.ok(/Result on 2026-10-08: `\[465,0,0,0,0,0\]` for the row with the dock book on or off; `\[311,155,2\]` for the bays with it on/.test(design), 'the dated first measurement is kept as history');
  assert.ok(/gives `\[465,0,0,0,0,0\]` for the row and `\[310,156,1\]` for the bays \(seed 3, 3 simulated hours\)/.test(design), 'and the tree of M1 is stated next to it');
  for (const [variant, wanted] of [['bays', [310, 156, 1]], ['row', [465, 0, 0, 0, 0, 0]]]) {
    const sim = new Simulation(dockLabLayout(L, variant), { seed: 3 });
    sim.advance(3 * 3600);
    const src = sim.stations.find((st) => st.type === 'source');
    assert.deepEqual(sim.logistics.docks.counters(src.id).map((d) => d.visits), wanted, `Appendix C result of the ${variant} with the dock book on`);
  }
});

test('M0-REV 6.5 hygiene: the copy of the pre-M0 tree lives in the temp directory, outside the repository (nothing in the working tree is written)', () => {
  assert.ok(!OLD_ROOT || !OLD_ROOT.startsWith(REPO + path.sep), 'the pre-M0 tree lives outside the repository');
  assert.ok(os.tmpdir().length > 0);
});
