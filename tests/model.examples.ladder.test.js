// The structure of the examples ladder (docs/EXAMPLES-DESIGN.md, acceptance E1 to E13, E31, E37): the catalogue of eleven examples, the five original ones
// untouched (the golden neutrality net: hashes of their layouts, project files and texts, taken before the ladder was added), and the six new ones as data - fresh
// deterministic builds, validated without a single issue, the structure table of the design, notes, labels, tips and card texts, share links.
// Fast tier. The simulation of the six (speed, two hours, first goods) is tests/sim.examples.ladder.test.js, their tips are tests/sim.examples.<id>.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { EXAMPLES } from '../js/model/examples.js';
import * as L from '../js/model/layout.js';
import { validateLayout } from '../js/model/validate.js';
import { GRID_LIMITS } from '../js/model/defaults.js';
import { exportProject, importProject, encodeShare, decodeShare } from '../js/model/serialize.js';
import { claims as helloClaims } from './helpers/ladder/hello-pallet.js';
import { claims as chargingClaims } from './helpers/ladder/charging-corner.js';
import { claims as yardClaims } from './helpers/ladder/yard-shuttle.js';
import { claims as morningClaims } from './helpers/ladder/morning-peak.js';
import { claims as componentsClaims } from './helpers/ladder/components-plant.js';
import { claims as twinClaims } from './helpers/ladder/twin-plants.js';

const sha1 = (text) => createHash('sha1').update(text).digest('hex');
const example = (id) => EXAMPLES.find((e) => e.id === id);
const asProject = (e, layout) => ({ name: e.name, scenarios: [{ id: 's1', name: 'Base', layout }], activeId: 's1' });

const ORIGINAL = ['starter', 'two-lines', 'congestion-lab', 'dock-lab', 'warehouse-first-day'];
const LADDER = ['hello-pallet', 'charging-corner', 'yard-shuttle', 'morning-peak', 'components-plant', 'twin-plants'];

// ---------------------------------------------------------------------------------------------------------------------------
// The catalogue (E1) and the neutrality net (E2, E3)
// ---------------------------------------------------------------------------------------------------------------------------

/** sha1 of JSON.stringify(build()), of the project file of that layout, and of [id, name, description, tips]; measured on the five original examples before the ladder. */
const ORIGINAL_HASHES = {
  starter: ['edb8d8e17863f7e3f49318e7701a03bf387e6e06', '908f9f42d4a2e009a30c339e841d78a91d662c6a', '3e54dd4044a0469b58267eabc81a3b66291037cd'],
  'two-lines': ['56f55340c433c07d6fbb1c3f5b936ac72e7690b3', '0058a22e1a52df225f331686fb5808b527051289', '780cb631d1cb8a1e115c0c96a996180cecdff496'],
  'congestion-lab': ['b8076eddd8feefc1c3aa0aba93bc86eca82dfe1e', '9d59bbb940ea6d36c2a44ead3816618084636cae', 'b7a3bf568d7b26cc69b8867c69d51a7da951a20e'],
  'dock-lab': ['3c035e019b3ba58ce01b387a404f0b84afcabae8', '9a529199f43bc1639f6f5336fec7feb992a68d32', '438930ac977c7702252806e8ed0e3bb73b5f8e7c'],
  'warehouse-first-day': ['9d15089b25ad003d7c18eb52d3f8b8286e6ccf9a', '0b0b14e78f0bc239a1dd00681a0f7010277cd074', 'c28d99f753af65230d222617ef4286346e078090'],
};

test('E1: eleven examples in this array order, with the names, levels and ranks of the ladder', () => {
  assert.deepEqual(EXAMPLES.map((e) => e.id), [...ORIGINAL, ...LADDER]);
  assert.deepEqual(EXAMPLES.map((e) => [e.id, e.level, e.rank]), [
    ['starter', 1, 2], ['two-lines', 3, 6], ['congestion-lab', 3, 7], ['dock-lab', 2, 5], ['warehouse-first-day', 3, 8],
    ['hello-pallet', 1, 1], ['charging-corner', 2, 3], ['yard-shuttle', 2, 4], ['morning-peak', 4, 9], ['components-plant', 4, 10], ['twin-plants', 5, 11],
  ]);
  assert.deepEqual([...EXAMPLES].sort((p, q) => p.level - q.level || p.rank - q.rank).map((e) => e.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 'the ranks are the path, 1 to 11, and agree with the levels');
  assert.deepEqual(LADDER.map((id) => example(id).name), [
    'Hello, pallet: one forklift, one road', 'Charging corner: six electric forklifts, two chargers', 'Yard shuttle: one truck, 280 metres',
    'Morning peak: a cross-dock on appointments', 'Components plant: one hall, three kinds of vehicle', 'Two plants, one yard',
  ]);
  assert.equal(new Set(EXAMPLES.map((e) => e.id)).size, EXAMPLES.length);
  for (const e of EXAMPLES) {
    assert.match(e.id, /^[a-z0-9-]+$/);
    assert.ok(e.learn && e.learn.length <= 110, `${e.id}: a learn line of at most 110 characters`);
    assert.ok(Array.isArray(e.chips) && e.chips.length >= 1 && e.chips.length <= 4 && e.chips.every((c) => typeof c === 'string' && c.length >= 1 && c.length <= 24), `${e.id}: at most 4 chips of at most 24 characters`);
    assert.ok(Number.isInteger(e.level) && e.level >= 1 && e.level <= 5);
  }
});

test('E2/E3 neutrality net: the five original examples build, export and read exactly as before the ladder (layout, project file, id, name, description, tips)', () => {
  for (const id of ORIGINAL) {
    const e = example(id);
    const layout = e.build();
    const [layoutHash, fileHash, textHash] = ORIGINAL_HASHES[id];
    assert.equal(sha1(JSON.stringify(layout)), layoutHash, `${id}: the layout`);
    assert.equal(sha1(exportProject(asProject(e, layout))), fileHash, `${id}: the project file`);
    assert.equal(sha1(JSON.stringify([e.id, e.name, e.description, e.tips])), textHash, `${id}: id, name, description and tips`);
  }
});

test('E2/E3: the first-five order is pinned and the legacy golden loop still names exactly the three golden examples', () => {
  assert.deepEqual(EXAMPLES.slice(0, 5).map((e) => e.id), ORIGINAL);
  const golden = readFileSync(new URL('./helpers/golden.js', import.meta.url), 'utf8');
  assert.match(golden, /LEGACY_EXAMPLE_IDS = Object.freeze\(\['starter', 'two-lines', 'congestion-lab'\]\)/, 'the golden net keeps its three ids; the ladder never enters it');
});

// ---------------------------------------------------------------------------------------------------------------------------
// The six as data (E5 to E13, E31, E37)
// ---------------------------------------------------------------------------------------------------------------------------

/** The structure table of the design (section 2, E8): grid, cell size, schema, clock, warm-up, counts. */
const TABLE = {
  'hello-pallet': { cols: 36, rows: 14, cell: 3, schema: 1, clock: false, warmup: 600, stations: 3, withTrucks: 0, flows: 1, fleets: 1, vehicles: 1, road: 29, labels: 3, bounds: { x: 1, y: 4 } },
  'charging-corner': { cols: 56, rows: 30, cell: 2, schema: 1, clock: false, warmup: 600, stations: 4, withTrucks: 0, flows: 2, fleets: 1, vehicles: 6, road: 130, labels: 3, bounds: { x: 5, y: 3 } },
  'yard-shuttle': { cols: 60, rows: 44, cell: 4, schema: 1, clock: false, warmup: 600, stations: 5, withTrucks: 0, flows: 2, fleets: 1, vehicles: 1, road: 84, labels: 4, bounds: { x: 4, y: 2 } },
  'morning-peak': { cols: 60, rows: 44, cell: 3, schema: 2, clock: true, warmup: 600, stations: 7, withTrucks: 5, flows: 5, fleets: 1, vehicles: 8, road: 238, labels: 4, bounds: { x: 4, y: 3 } },
  'components-plant': { cols: 79, rows: 42, cell: 2, schema: 2, clock: false, warmup: 7200, stations: 16, withTrucks: 4, flows: 13, fleets: 3, vehicles: 22, road: 345, labels: 4, bounds: { x: 4, y: 4 } },
  'twin-plants': { cols: 170, rows: 52, cell: 2, schema: 2, clock: false, warmup: 7200, stations: 33, withTrucks: 7, flows: 32, fleets: 7, vehicles: 30, road: 711, labels: 5, bounds: { x: 1, y: 2 } },
};
/** The claims of the tests of the tips, per example (the text of every claim must occur in its tip). */
const CLAIMS = {
  'hello-pallet': helloClaims, 'charging-corner': chargingClaims, 'yard-shuttle': yardClaims, 'morning-peak': morningClaims, 'components-plant': componentsClaims, 'twin-plants': twinClaims,
};

/** Number of connected pieces of the road network (cells joined by a connection in either direction). */
function roadPieces(layout) {
  const keys = new Set(Object.keys(layout.roads));
  const seen = new Set();
  let pieces = 0;
  for (const start of keys) {
    if (seen.has(start)) continue;
    pieces++;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const [x, y] = stack.pop().split(',').map(Number);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = `${x + dx},${y + dy}`;
        if (keys.has(k) && !seen.has(k)) { seen.add(k); stack.push(k); }
      }
    }
  }
  return pieces;
}

for (const id of LADDER) {
  const e = example(id);
  const t = TABLE[id];

  test(`${id}: fresh, deterministic, JSON-stable builds; a fixed point of normalizeLayout; invariants and validation clean (E6, E7)`, () => {
    const layout = e.build();
    assert.notEqual(e.build(), layout, 'a fresh object on every call');
    assert.deepEqual(e.build(), layout, 'the same layout on every call');
    assert.equal(JSON.stringify(e.build()), JSON.stringify(layout));
    assert.deepEqual(JSON.parse(JSON.stringify(layout)), layout, 'JSON round trip');
    assert.equal(JSON.stringify(L.normalizeLayout(layout)), JSON.stringify(layout), 'a fixed point of normalizeLayout, byte for byte');
    assert.deepEqual(L.checkInvariants(layout), []);
    assert.deepEqual(validateLayout(layout), [], 'zero issues of any severity');
  });

  test(`${id}: the structure table of the design (E8, E9)`, () => {
    const layout = e.build();
    assert.deepEqual({ cols: layout.grid.cols, rows: layout.grid.rows, cell: layout.grid.cellSize }, { cols: t.cols, rows: t.rows, cell: t.cell });
    assert.equal(layout.schema, t.schema);
    assert.equal(layout.calendar !== undefined, t.clock, 'a clock on the morning peak only');
    if (t.clock) assert.deepEqual(layout.calendar, { startTod: 21600, startDay: 0 }, 'the day starts at 06:00 on a Monday');
    assert.equal(layout.settings.warmup, t.warmup);
    assert.equal(layout.stations.length, t.stations);
    assert.equal(layout.stations.filter((s) => s.ops && s.ops.trucks).length, t.withTrucks);
    assert.equal(layout.flows.length, t.flows);
    assert.equal(layout.fleets.length, t.fleets);
    assert.equal(layout.fleets.reduce((s, f) => s + f.count, 0), t.vehicles);
    assert.equal(L.roadCellCount(layout), t.road);
    assert.equal(layout.labels.length, t.labels);
    assert.ok(layout.grid.cols >= GRID_LIMITS.minCols && layout.grid.cols <= GRID_LIMITS.maxCols && layout.grid.rows >= GRID_LIMITS.minRows && layout.grid.rows <= GRID_LIMITS.maxRows);
    assert.equal(roadPieces(layout), 1, 'one connected road network');
    for (const s of layout.stations) assert.ok(L.docksOf(layout, s.id).length >= 1, `${s.name} has a dock`);
    for (const fleet of layout.fleets) {
      const home = L.getStation(layout, fleet.home);
      assert.ok(home && home.type === 'depot', `${fleet.name} has a home depot`);
      const homed = layout.fleets.filter((f) => f.home === home.id).reduce((sum, f) => sum + f.count, 0);
      assert.ok(Number(home.params.slots) >= homed, `${home.name} holds the ${homed} vehicles that live there`);
    }
    const bounds = L.contentBounds(layout);
    assert.equal(bounds.x, t.bounds.x, 'no empty block at the west edge');
    assert.equal(bounds.y, t.bounds.y, 'no empty block at the north edge');
  });

  test(`${id}: notes, labels, tips and card texts (E1, E10 to E13, E37)`, () => {
    const layout = e.build();
    assert.equal(layout.notes, e.notes, 'the notes of the layout are the notes of the card');
    assert.ok(layout.notes.length >= 400, 'notes tell the story');
    assert.ok(layout.notes.includes('600×'), 'the notes name the speed as the UI writes it');
    if (['charging-corner', 'morning-peak', 'components-plant'].includes(id)) assert.match(layout.notes, /Every edit starts the run again|Every edit restarts the day/, 'the notes say that an edit starts the run again');
    if (id === 'twin-plants') {
      assert.match(layout.notes, /no site concept/i);
      assert.match(layout.notes, /no per-plant figures/);
      assert.doesNotMatch(layout.notes + e.tips.join(' ') + e.description, /\bsites?\b(?! concept)/i, 'two plants (zones), never "sites"');
      for (const text of ['PLANT A', 'THE YARD', 'PLANT B']) assert.ok(layout.labels.some((l) => l.text.startsWith(text)), `a label ${text}`);
    }
    assert.ok(layout.labels.length >= 3);
    assert.ok(e.tips.length >= 4 && e.tips.length <= 6, `${e.tips.length} tips`);
    for (const tip of e.tips) assert.ok(tip.length >= 30 && tip.length <= 700, `a tip of ${tip.length} characters`);
    assert.ok(e.tips[0].includes('600×'), 'tip 1 names the speed');
    assert.ok(e.tips.some((tip) => tip.startsWith('Try:')), 'something to try');
    assert.ok(e.description.length >= 105 && e.description.length <= 125, `a card description of ${e.description.length} characters`);
    assert.ok(e.learn.length <= 110);
    const all = [e.name, e.description, e.learn, ...e.chips, layout.notes, ...e.tips].join(' ');
    assert.doesNotMatch(all, /[$€£¥]/, 'no currency symbol: no money anywhere');
    assert.doesNotMatch(all, /\bpercentile\b|\bmedian\b/i, 'the Results tab says "95 % within", not percentile or median');
    for (const c of CLAIMS[id]) assert.ok(e.tips[c.tip - 1].includes(c.text), `tip ${c.tip} prints "${c.text}" (${c.label})`);
  });

  test(`${id}: the project file and the share link round trip to an equal layout, the link is at most 8 KB (E31)`, async () => {
    const layout = e.build();
    const project = asProject(e, layout);
    const file = exportProject(project);
    assert.deepEqual(importProject(file).scenarios[0].layout, layout);
    assert.equal(exportProject(importProject(file)), file, 'export(import(file)) is the file');
    const link = await encodeShare(project);
    assert.ok(link.length <= 8192, `${link.length} characters`);
    assert.deepEqual((await decodeShare(link)).scenarios[0].layout, layout);
  });
}

test('E5: the builders go through the exported mutators of layout.js only (no direct writes into the layout)', () => {
  const dir = new URL('../js/model/examples/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 8, 'helpers, index and the six examples');
  for (const f of files) {
    const source = readFileSync(new URL(f, dir), 'utf8');
    assert.doesNotMatch(source, /layout\.(stations|flows|fleets|roads|labels|obstacles|grid|settings)\b[^;\n]*(\.push\(|\]\s*=[^=]|=[^=])/, `${f}: no direct writes into the layout`);
    assert.doesNotMatch(source, /from '\.\.\/\.\.\/(sim|ui)\//, `${f}: the model layer does not import the engine or the UI`);
  }
  for (const id of LADDER) {
    const source = readFileSync(new URL(`${id}.js`, dir), 'utf8');
    assert.match(source, /must\(|from '\.\/helpers\.js'/, `${id}: creation goes through the helpers that check every result`);
  }
});

test('the ladder tips are quoted by the design: the strings of the six modules are what the examples export (E37)', () => {
  for (const id of LADDER) {
    const e = example(id);
    assert.ok(e.tips.every((tip) => typeof tip === 'string' && tip.trim() === tip && !tip.includes('  ')), `${id}: tidy tips`);
    assert.equal(typeof e.build, 'function');
  }
});
