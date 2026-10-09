// Golden fixtures: the safety net of the warehouse module (docs/WAREHOUSE-DESIGN.md 10.1, milestone M0).
//
// What is recorded (tests/fixtures/golden/), for each of the three example plants:
//   kpis.<id>.seed<N>.json   JSON.stringify(sim.kpis()) after sim.advance(3600) with warm-up 600 s, seeds 1 and 2: the text itself, so
//                            a comparison of two strings is a comparison bit for bit (JSON.stringify prints the shortest text that
//                            reads back as the same double)
//   layout.<id>.json         JSON.stringify(EXAMPLES[i].build()): the legacy layout (schema 1, no `ops`, no `calendar`)
//   share.<id>.txt           the share link of that layout as shareUrl(SHARE_BASE, project) made it
//   kpis.docks-<row|bays>.seed3.json   (added beyond the design's list) the same for two small multi-dock plants, built below: the three
//                            examples never let the dock choice decide anything in their first hour (switching the dock book off
//                            changes no byte of their fixtures), so without these two the safety net is blind to docks/dispatching
//                            of Goods in with several dock cells, the code the warehouse milestones touch most
//   layout.dockplant-<seed>.json + kpis.dockplant-<seed>.json   (added after the M0 review) five FROZEN dock-dense plants (comb, ring, lined-up docks, trap
//                            spurs, depot, breakdowns; seeds 13, 22, 30, 44 and 52 of tests/helpers/docks-review-gen.js dockPlant) and their KPI texts after
//                            600 simulated seconds. The layout files are INPUTS: JSON.stringify(dockPlant(seed)) as the tree before M0 (commit eccdca8)
//                            made it, never regenerated, so the net does not move when a generator or the layout API does. They exist because the two
//                            plants above feel only a few of the dock-choice constants (the review changed twelve of them by 25 to 100 % and the three
//                            examples plus the two dock-lab plants noticed four); these five notice all twelve, also when each is changed by only 4 to 30 %
//                            (24 deliberate changes in a scratch copy, none slipped; a scan of 60 seeds picked the plants by greedy cover, seed 30 alone
//                            notices 10 of the 12)
//   perf-baseline.json       CPU seconds per simulated hour (scripts/perf-baseline.mjs); numbers for people, no test reads them
//
// Rule: any change in a recorded KPI text is a bug unless the pull request says why and re-records the fixtures with
// scripts/rebaseline-golden.mjs. The planned re-baseline was the one after the dock work; this set was captured after it.
//
// The share links are compared by what they decode to, never by their text: the compressed bytes may differ between zlib versions.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const GOLDEN_DIR = path.join(ROOT, 'tests', 'fixtures', 'golden');
export const GOLDEN_SEEDS = Object.freeze([1, 2]);
/**
 * The three LEGACY examples: the plants of the safety net (fixtures, share links, schema 1). EXAMPLES also holds the examples of the warehouse
 * module ('dock-lab', 'warehouse-first-day': trucks, schema 2) since milestone M1; they have no fixtures here, and every test or script that means
 * "the plants that must never change" takes its list through legacyExamples().
 */
export const LEGACY_EXAMPLE_IDS = Object.freeze(['starter', 'two-lines', 'congestion-lab']);
export const legacyExamples = (examples) => examples.filter((e) => LEGACY_EXAMPLE_IDS.includes(e.id));
/** Simulated seconds that are run, and the warm-up that is excluded from the KPIs (both fixed by the design, not read from the example). */
export const GOLDEN_SECONDS = 3600;
export const GOLDEN_WARMUP = 600;
export const SHARE_BASE = 'https://logiplan.example/app/';

export const DOCK_SEED = 3;
export const DOCK_SECONDS = 3 * 3600;
export const DOCK_VARIANTS = Object.freeze(['row', 'bays']);

/** The frozen dock-dense plants (see the header) and the simulated seconds they run; their own settings (seed, dt, warm-up 0) apply. */
export const DOCKPLANT_SEEDS = Object.freeze([13, 22, 30, 44, 52]);
export const DOCKPLANT_SECONDS = 600;

export const kpisFile = (id, seed) => `kpis.${id}.seed${seed}.json`;
export const dockKpisFile = (variant) => kpisFile(`docks-${variant}`, DOCK_SEED);
export const layoutFile = (id) => `layout.${id}.json`;
export const dockPlantLayoutFile = (seed) => layoutFile(`dockplant-${seed}`);
export const dockPlantKpisFile = (seed) => `kpis.dockplant-${seed}.json`;
export const shareFile = (id) => `share.${id}.txt`;
export const PERF_FILE = 'perf-baseline.json';

/**
 * Load the modules of the tree under test. By default the tree this file lives in; `root` points at another checkout
 * (scripts/perf-baseline.mjs --root compares a pristine copy with the working tree).
 */
export async function loadTree(root = ROOT) {
  const url = (rel) => pathToFileURL(path.join(root, rel)).href;
  const [{ Simulation }, { EXAMPLES }, serialize, layout] = await Promise.all([
    import(url('js/sim/engine.js')),
    import(url('js/model/examples.js')),
    import(url('js/model/serialize.js')),
    import(url('js/model/layout.js')),
  ]);
  return { Simulation, EXAMPLES, serialize, layout };
}

/** The golden run: example plant, seed, one simulated hour with a warm-up of 600 s. Returns the KPI report as text. */
export function goldenKpisText(Simulation, example, seed) {
  const layout = example.build();
  layout.settings.warmup = GOLDEN_WARMUP;
  const sim = new Simulation(layout, { seed });
  sim.advance(GOLDEN_SECONDS);
  return JSON.stringify(sim.kpis());
}

/**
 * The scratch plant of docs/WAREHOUSE-DESIGN.md Appendix C: a two-way loop, a Goods in with docks on the loop, a Goods out, a depot and
 * 8 forklifts, one pallet every 14 s. `variant` 'row': six dock cells in a row on one lane; 'bays': three short side roads. `L` is the
 * namespace of js/model/layout.js (of the tree under test). Built through the layout API, so a change of the API shows up here too.
 */
export function dockLabLayout(L, variant) {
  const layout = L.createLayout({ name: 'Dock lab', cols: 40, rows: 24, cellSize: 2 });
  L.paintRoadPath(layout, [[4, 10], [30, 10], [30, 18], [4, 18], [4, 10]]);
  const params = { interArrival: { kind: 'normal', mean: 14, spread: 0.2 }, outCap: 12 };
  if (variant === 'row') {
    L.addStation(layout, { type: 'source', name: 'Goods in', x: 10, y: 8, w: 6, h: 2, params });
  } else {
    L.addStation(layout, { type: 'source', name: 'Goods in', x: 10, y: 4, w: 7, h: 2, params });
    for (const x of [10, 13, 16]) L.paintRoadPath(layout, [[x, 10], [x, 6]]);
  }
  const sink = L.addStation(layout, { type: 'sink', name: 'Goods out', x: 31, y: 13, w: 3, h: 2 });
  const park = L.addStation(layout, { type: 'depot', name: 'Park', x: 8, y: 19, w: 3, h: 2, params: { slots: 8 } });
  L.paintRoadPath(layout, [[9, 18], [9, 19]]);
  const src = layout.stations.find((st) => st.type === 'source');
  L.addFlow(layout, src.id, sink.id);
  L.addFleet(layout, 'forklift', { name: 'FL', count: 8, home: park.id, capacity: 1 });
  return layout;
}

/** KPI report text of the dock-lab plant: 3 simulated hours, seed 3, default warm-up. */
export function dockKpisText(Simulation, L, variant) {
  const sim = new Simulation(dockLabLayout(L, variant), { seed: DOCK_SEED });
  sim.advance(DOCK_SECONDS);
  return JSON.stringify(sim.kpis());
}

/** KPI report text of a frozen dock-dense plant: `layoutText` is the content of its layout fixture. */
export function dockPlantKpisText(Simulation, layoutText) {
  const sim = new Simulation(JSON.parse(layoutText));
  sim.advance(DOCKPLANT_SECONDS);
  return JSON.stringify(sim.kpis());
}

/** The project a share link of an example holds (the shape of the store's project, one scenario). */
export function goldenProject(example) {
  return { name: example.name, scenarios: [{ id: 'sc1', name: 'A', layout: example.build() }], activeId: 'sc1' };
}

/** Everything the fixtures hold for the three examples, as { file name: text }, produced by the tree under test. */
export async function captureGolden(tree) {
  const files = {};
  for (const example of legacyExamples(tree.EXAMPLES)) {
    for (const seed of GOLDEN_SEEDS) files[kpisFile(example.id, seed)] = goldenKpisText(tree.Simulation, example, seed);
    files[layoutFile(example.id)] = JSON.stringify(example.build());
    files[shareFile(example.id)] = `${await tree.serialize.shareUrl(SHARE_BASE, goldenProject(example))}\n`;
  }
  for (const variant of DOCK_VARIANTS) files[dockKpisFile(variant)] = dockKpisText(tree.Simulation, tree.layout, variant);
  for (const seed of DOCKPLANT_SEEDS) files[dockPlantKpisFile(seed)] = dockPlantKpisText(tree.Simulation, readGolden(dockPlantLayoutFile(seed))); // the layouts are inputs
  return files;
}

/** Text of a fixture file; throws a message that says how to create it when it is missing. */
export function readGolden(file) {
  const p = path.join(GOLDEN_DIR, file);
  if (!existsSync(p)) throw new Error(`Missing golden fixture ${file}. Create the fixtures on a known good tree with: node scripts/rebaseline-golden.mjs`);
  return readFileSync(p, 'utf8');
}

export function writeGolden(file, text) {
  mkdirSync(GOLDEN_DIR, { recursive: true });
  writeFileSync(path.join(GOLDEN_DIR, file), text);
}

/** Where two texts first differ, with some context, for a failure message a person can act on. */
export function describeDifference(expected, actual, what) {
  let i = 0;
  while (i < expected.length && i < actual.length && expected[i] === actual[i]) i++;
  const cut = (text) => JSON.stringify(text.slice(Math.max(0, i - 50), i + 70));
  return [
    `${what} differs from the golden fixture (lengths ${expected.length} and ${actual.length}, first difference at character ${i}).`,
    `  fixture: ...${cut(expected)}`,
    `  now:     ...${cut(actual)}`,
    'A change in the results of a legacy example is a bug unless it was intended and agreed. If it was, re-record with',
    'node scripts/rebaseline-golden.mjs and say in the pull request why the results changed (docs/WAREHOUSE-DESIGN.md 10.1).',
  ].join('\n');
}
