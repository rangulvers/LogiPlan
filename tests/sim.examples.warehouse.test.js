// The two examples of the warehouse module, milestone M1 (docs/WAREHOUSE-DESIGN.md 8.1 rows 1 and 2, acceptance A1.14 and the example part of A1.16):
//   'dock-lab'             Dock lab: one street, three docks (variant 'bays' is the example, variant 'row' is the plant after the edit its notes describe)
//   'warehouse-first-day'  Warehouse: first day (doors against forklifts)
//
// What is checked:
//  * both are built through the layout.js mutators, validate without a single issue (the row variant: exactly docks-share-lane), are fixed points
//    of normalizeLayout, schema 2, stationary (no clock), and have the doors and docks the tips talk about;
//  * A1.14: the plants run; in the row variant the first dock takes more than 90 % of the visits of Goods in, Checks shows docks-share-lane and the
//    Results finding says the docks lie on one lane; in the bays variant each of the first two docks has more than 20 % (the thresholds were
//    calibrated on the built example, 5 seeds x 8 h: row 93 to 98 %, bays 51 to 62 % and 30 to 39 %, and then fixed here);
//  * the tips: no tip ships with a number this file does not reproduce. Every figure of every tip is the mean of seeds 1 to 5 over the default run
//    length of 8 simulated hours (the live app shows one seed: a single run can differ, the tips say "about" and "over several runs");
//  * A1.16 for the two new examples: at least 500 times real time (the target of 2000 is logged).
//
// Heavy tier: the runs are about 50 CPU seconds, spread over worker threads (tests/helpers/warehouse-runs.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES, buildDockLab, buildWarehouseFirstDay } from '../js/model/examples.js';
import * as L from '../js/model/layout.js';
import { validateLayout } from '../js/model/validate.js';
import { dockLanes } from '../js/model/validate-ops.js';
import { doorCheck } from '../js/model/doors.js';
import { schemaNeeded } from '../js/model/schema.js';
import { Simulation } from '../js/sim/engine.js';
import { generateInsights } from '../js/sim/insights.js';
import { meanOf, runVariants } from './helpers/warehouse-runs.js';

const example = (id) => EXAMPLES.find((e) => e.id === id);
const trucksOf = (layout, type) => layout.stations.find((s) => s.type === type).ops.trucks;
const goodsIn = (layout) => layout.stations.find((s) => s.type === 'source');
const issueIds = (layout) => validateLayout(layout).map((i) => i.id);

// ---------------------------------------------------------------------------------------------------------------------------
// The examples as data
// ---------------------------------------------------------------------------------------------------------------------------

test('the gallery: the three old examples come first and unchanged in name, then Dock lab and Warehouse: first day, each with notes and tips', () => {
  assert.deepEqual(EXAMPLES.map((e) => e.id), ['starter', 'two-lines', 'congestion-lab', 'dock-lab', 'warehouse-first-day']);
  assert.equal(example('dock-lab').name, 'Dock lab: one street, three docks');
  assert.equal(example('warehouse-first-day').name, 'Warehouse: first day');
  for (const id of ['dock-lab', 'warehouse-first-day']) {
    const e = example(id);
    assert.ok(e.description.length > 60 && e.description.length < 260, `${id}: a card description that fits three lines`);
    assert.ok(e.tips.length >= 3 && e.tips.every((t) => t.length > 30), `${id}: tips`);
    assert.ok(e.tips.some((t) => t.startsWith('Try:')), `${id}: something to try`);
    assert.ok(e.build().notes.length > 200, `${id}: notes tell the story`);
    assert.ok(e.build().labels.length >= 3, `${id}: the baseplate explains itself`);
  }
});

test('both are valid, normalized, JSON-stable layouts of schema 2 without a clock, built fresh on every call', () => {
  for (const id of ['dock-lab', 'warehouse-first-day']) {
    const layout = example(id).build();
    assert.deepEqual(L.checkInvariants(layout), [], id);
    assert.deepEqual(JSON.parse(JSON.stringify(layout)), layout, `${id}: JSON round trip`);
    assert.equal(JSON.stringify(L.normalizeLayout(layout)), JSON.stringify(layout), `${id}: a fixed point of normalizeLayout, byte for byte`);
    assert.equal(schemaNeeded(layout), 2);
    assert.equal(layout.schema, 2);
    assert.equal(layout.calendar, undefined, `${id}: rate mode, no timetable, so no clock: a stationary plant (warm restart, impact card)`);
    assert.deepEqual(example(id).build(), layout);
    assert.notEqual(example(id).build(), layout);
    assert.equal(layout.stations.filter((s) => s.ops).length, 2, `${id}: Goods in and Goods out have trucks, nothing else has options`);
  }
});

test('A1.14 validation: zero issues for Dock lab and for Warehouse: first day; the row variant has exactly one: docks-share-lane of Goods in', () => {
  const bays = buildDockLab('bays');
  const row = buildDockLab('row');
  assert.deepEqual(validateLayout(bays), []);
  assert.deepEqual(validateLayout(buildWarehouseFirstDay()), []);
  assert.deepEqual(issueIds(row), [`docks-share-lane:${goodsIn(row).id}`]);
  const issue = validateLayout(row)[0];
  assert.equal(issue.severity, 'warning', 'zero errors');
  assert.equal(issue.refs.cells.length, 7, 'it lists the seven docks of the row');
  assert.throws(() => buildDockLab('diagonal'), /unknown Dock lab variant/);
});

test('Dock lab: three doors on three docks that sit on three side roads, two doors on two docks at Goods out, five forklifts; the row variant has seven docks in one lane', () => {
  const bays = buildDockLab('bays');
  const row = buildDockLab('row');
  const docks = (layout, station) => L.docksOf(layout, station.id);
  assert.deepEqual(docks(bays, goodsIn(bays)), [[22, 6], [25, 6], [28, 6]]);
  assert.deepEqual(dockLanes(bays, goodsIn(bays)), [], 'three docks on their own side roads share no lane');
  assert.equal(trucksOf(bays, 'source').doors, 3);
  assert.equal(trucksOf(bays, 'sink').doors, 2);
  assert.equal(docks(bays, bays.stations.find((s) => s.type === 'sink')).length, 2);
  assert.equal(bays.fleets[0].count, 5);
  assert.equal(bays.fleets[0].preset, 'forklift');
  assert.deepEqual(docks(row, goodsIn(row)), [[22, 10], [23, 10], [24, 10], [25, 10], [26, 10], [27, 10], [28, 10]]);
  assert.deepEqual(dockLanes(row, goodsIn(row)), [[[22, 10], [23, 10], [24, 10], [25, 10], [26, 10], [27, 10], [28, 10]]], 'one lane of seven');
  // what the notes say: erase the three side roads, then drag Goods in down until it touches the street (that works only after the erasing)
  const edited = buildDockLab('bays');
  assert.equal(L.moveStation(edited, goodsIn(edited).id, 22, 8), false, 'Goods in cannot be dragged onto the side roads');
  for (const x of [22, 25, 28]) for (let y = 6; y < 10; y++) assert.equal(L.eraseRoadCell(edited, x, y), true);
  assert.equal(L.moveStation(edited, goodsIn(edited).id, 22, 8), true);
  assert.deepEqual(edited.stations.map((s) => [s.x, s.y, s.w, s.h]), row.stations.map((s) => [s.x, s.y, s.w, s.h]));
  assert.deepEqual(edited.roads, row.roads, 'the notes lead to exactly the row variant');
  assert.match(bays.notes, /erase the three side roads and drag Goods in down/);
});

test('Warehouse: first day: three doors on a Goods in with four docks (the fourth is there for the tip), two doors on two docks at Goods out, four forklifts', () => {
  const layout = buildWarehouseFirstDay();
  assert.equal(L.docksOf(layout, goodsIn(layout).id).length, 4);
  assert.deepEqual(dockLanes(layout, goodsIn(layout)), [], 'four docks on four side roads');
  assert.equal(trucksOf(layout, 'source').doors, 3);
  assert.equal(trucksOf(layout, 'sink').doors, 2);
  assert.equal(L.docksOf(layout, layout.stations.find((s) => s.type === 'sink').id).length, 2);
  assert.equal(layout.fleets[0].count, 4);
  // the fourth door of the tip is legal: no warning, no error
  const four = buildWarehouseFirstDay();
  L.updateStation(four, goodsIn(four).id, { ops: { trucks: { doors: 4 } } });
  assert.deepEqual(validateLayout(four), []);
  const five = buildWarehouseFirstDay();
  L.updateFleet(five, five.fleets[0].id, { count: 5 });
  assert.deepEqual(validateLayout(five), []);
});

test('the door check at the plan stage: the first day needs 2.7 of its 3 doors on paper (90 % busy, no warning); the Dock lab is not short of doors either', () => {
  const first = buildWarehouseFirstDay();
  const check = doorCheck(trucksOf(first, 'source'), {});
  assert.equal(check.needed.toFixed(1), '2.7');
  assert.equal(Math.round(check.utilisation * 100), 90);
  assert.equal(check.tooFew, false);
  assert.equal(check.tPallet, 90, 'before a run the assumption of 90 s per pallet is used');
  for (const type of ['source', 'sink']) assert.equal(doorCheck(trucksOf(buildDockLab('bays'), type), {}).tooFew, false, `Dock lab ${type}`);
  assert.equal(doorCheck(trucksOf(first, 'source'), { measuredDoorSeconds: 42.5 * 60 }).basis, 'measured', 'after a run the measured door time replaces the assumption');
});

// ---------------------------------------------------------------------------------------------------------------------------
// A1.14 and the tips, at the default run length (8 simulated hours), seeds 1 to 5
// ---------------------------------------------------------------------------------------------------------------------------

let measured = null;
/** Every variant the tips talk about, run once for all tests of this file. */
function measurements() {
  measured ??= runVariants({
    labBays: { example: 'dock-lab', variant: 'bays' },
    labRow: { example: 'dock-lab', variant: 'row' },
    labBaysSixth: { example: 'dock-lab', variant: 'bays', forklifts: 6 },
    labRowSixth: { example: 'dock-lab', variant: 'row', forklifts: 6 },
    firstBase: { example: 'warehouse-first-day' },
    firstDoors4: { example: 'warehouse-first-day', doorsIn: 4 },
    firstFifth: { example: 'warehouse-first-day', forklifts: 5 },
    firstSixth: { example: 'warehouse-first-day', forklifts: 6 },
  });
  return measured;
}
const pct = (x) => x * 100;
/** `x` lies in [lo, hi]: a claim "about N" is checked against a band around N, because the figures are means of five runs. */
const within = (x, lo, hi, what) => assert.ok(x >= lo && x <= hi, `${what}: ${x.toFixed(3)} is outside ${lo}..${hi}`);

test('A1.14 bays variant: it runs, and each of the first two docks of Goods in has more than 20 % of the visits (every seed); the third is the spare', async () => {
  const m = await measurements();
  for (const r of m.labBays) {
    assert.ok(r.throughput > 30, `seed ${r.seed}: the plant delivers ${r.throughput.toFixed(1)} pallets/h`);
    assert.ok(r.shares[0] > 0.2 && r.shares[1] > 0.2, `seed ${r.seed}: shares ${r.shares.map((s) => s.toFixed(2))}`);
    assert.equal(r.shares.length, 3);
    assert.equal(r.short, 0, 'no Goods out truck leaves short');
    assert.ok(!r.insights.includes(`docks-unbalanced:s1`), 'the docks are not called unbalanced');
    assert.equal(r.unbalanced, '');
  }
});

test('A1.14 row variant: it runs, the first dock of Goods in takes more than 90 % of the visits (every seed), and the Results finding says the docks lie on one lane', async () => {
  const m = await measurements();
  for (const r of m.labRow) {
    assert.ok(r.throughput > 30, `seed ${r.seed}: ${r.throughput.toFixed(1)} pallets/h`);
    assert.equal(r.shares.length, 7);
    assert.ok(r.shares[0] > 0.9, `seed ${r.seed}: the first dock has ${(100 * r.shares[0]).toFixed(1)} %`);
    assert.ok(r.insights.includes('docks-unbalanced:s1'), `seed ${r.seed}: ${r.insights}`);
    assert.match(r.unbalanced, /the docks lie one behind the other on one lane/, 'the finding names the lane (the statistics call it a detour on a loop, and the golden fixtures pin that word)');
    assert.ok(['detour', 'lane'].includes(r.skewReason));
  }
  const row = buildDockLab('row');
  assert.ok(issueIds(row).includes(`docks-share-lane:${goodsIn(row).id}`), 'Checks shows the warning');
  assert.ok(!issueIds(buildDockLab('bays')).some((id) => id.startsWith('docks-share-lane')), 'and not for the bays variant');
});

test('the "lane" wording of the finding comes from the layout and only for a plant with trucks; the Congestion lab keeps the old word', () => {
  const lab = example('congestion-lab').build();
  const sim = new Simulation(lab, { seed: 1 });
  sim.advance(3 * 3600);
  const insight = generateInsights(sim.kpis(), sim.layout).find((i) => i.id.startsWith('docks-unbalanced'));
  assert.ok(insight, 'the Congestion lab has the finding');
  assert.match(insight.detail, /a long way round/, 'unchanged for a legacy plant: the pre-M0 digests of the insights are pinned (tests/m0.review.test.js 1.1)');
});

test('tip 1 of the Dock lab: with a side road for each dock the visits split about 57 %, 34 % and 9 %', async () => {
  const m = await measurements();
  const share = (i) => pct(meanOf(m.labBays, (r) => r.shares[i]));
  within(share(0), 53, 61, 'first dock about 57 %');
  within(share(1), 30, 38, 'second dock about 34 %');
  within(share(2), 6, 12, 'third dock about 9 %');
});

test('tip 2 of the Dock lab: in the row the first dock takes about 97 %, the forklifts are busier (58 % instead of 53 %, about 10 % harder) and a truck holds its door about 2 minutes longer (33 instead of 31)', async () => {
  const m = await measurements();
  within(pct(meanOf(m.labRow, (r) => r.shares[0])), 94.5, 98.5, 'first dock about 97 %');
  const bays = meanOf(m.labBays, 'fleetUtilization');
  const row = meanOf(m.labRow, 'fleetUtilization');
  within(pct(bays), 50.5, 54.5, 'forklifts busy 53 % in the bays variant');
  within(pct(row), 56, 60, 'forklifts busy 58 % in the row');
  within(row / bays, 1.07, 1.13, 'about 10 % harder');
  within(meanOf(m.labBays, 'door'), 30.5, 32.4, 'door time 31 minutes');
  within(meanOf(m.labRow, 'door'), 32.2, 34.2, 'door time 33 minutes in the row');
  within(meanOf(m.labRow, 'door') - meanOf(m.labBays, 'door'), 1, 3, 'about 2 minutes longer');
  assert.equal(meanOf(m.labBays, 'throughput').toFixed(0), meanOf(m.labRow, 'throughput').toFixed(0), 'the same pallets go through: the supply is the trucks');
});

test('tip 3 of the Dock lab: a sixth forklift shortens the door time (30 instead of 31 minutes) but raises waiting in traffic from 9 % to 14 %, in the row to 20 %, and the row stays at 97 %', async () => {
  const m = await measurements();
  within(meanOf(m.labBaysSixth, 'door'), 28.7, 30.5, 'door time 30 minutes');
  within(meanOf(m.labBays, 'door') - meanOf(m.labBaysSixth, 'door'), 0.8, 3, 'shorter than with five');
  within(pct(meanOf(m.labBays, 'waitShare')), 8, 10.5, 'waiting in traffic 9 %');
  within(pct(meanOf(m.labBaysSixth, 'waitShare')), 13, 15.5, 'waiting in traffic 14 % with six');
  within(pct(meanOf(m.labRowSixth, 'waitShare')), 19, 21, 'waiting in traffic 20 % in the row with six');
  within(pct(meanOf(m.labRowSixth, (r) => r.shares[0])), 94.5, 98.5, 'the extra forklift cannot reach the empty docks: the first dock still takes about 97 %');
});

test('tip 1 of the first day: a truck waits about 8 minutes at the gate and holds its door about 42 minutes, doors busy about 83 %, forklifts busy 99 %, and the findings blame the forklifts', async () => {
  const m = await measurements();
  within(meanOf(m.firstBase, 'gate'), 6.5, 10, 'gate wait about 8 minutes');
  within(meanOf(m.firstBase, 'door'), 40.5, 44, 'door time about 42 minutes');
  within(pct(meanOf(m.firstBase, 'doorUtilization')), 79, 87, 'doors busy about 83 %');
  within(pct(meanOf(m.firstBase, 'fleetUtilization')), 97.5, 100, 'forklifts busy 99 %');
  const blamed = m.firstBase.filter((r) => r.insights.some((id) => id.startsWith('unload-limited-by-vehicles'))).length;
  assert.ok(blamed >= 4, `${blamed} of 5 runs say "the doors are not the problem, the forklifts are" (the finding is a matter of the run, not of the mean)`);
  for (const r of m.firstBase) assert.equal(r.short, 0);
  within(meanOf(m.firstBase, 'throughput'), 54, 58, 'about 56 pallets an hour leave (the Goods out trucks set the pace)');
});

test('tip 2 of the first day: a fourth door halves the wait at the gate (about 4 minutes) but the door time grows to about 47 minutes, the forklifts stay at 99 % and the same pallets go through', async () => {
  const m = await measurements();
  within(meanOf(m.firstDoors4, 'gate'), 2.5, 5, 'gate wait about 4 minutes');
  assert.ok(meanOf(m.firstDoors4, 'gate') < 0.5 * meanOf(m.firstBase, 'gate'), 'less than half as long');
  within(meanOf(m.firstDoors4, 'door'), 45, 48.5, 'door time about 47 minutes');
  assert.ok(meanOf(m.firstDoors4, 'door') > meanOf(m.firstBase, 'door'), 'each truck stays longer');
  within(pct(meanOf(m.firstDoors4, 'fleetUtilization')), 97.5, 100, 'forklifts still 99 %');
  assert.ok(Math.abs(meanOf(m.firstDoors4, 'throughput') - meanOf(m.firstBase, 'throughput')) < 0.5, 'the same pallets go through');
});

test('tip 3 of the first day: a fifth forklift gives a door time of about 26 minutes, an empty gate and forklifts busy about 89 %; a sixth about 22 minutes and twice the waiting in traffic (5 % to 10 %)', async () => {
  const m = await measurements();
  within(meanOf(m.firstFifth, 'door'), 24.5, 28, 'door time about 26 minutes');
  within(meanOf(m.firstFifth, 'gate'), 0, 0.5, 'the gate stays empty');
  within(pct(meanOf(m.firstFifth, 'fleetUtilization')), 87, 91, 'forklifts busy about 89 %');
  within(meanOf(m.firstSixth, 'door'), 20.5, 23.5, 'door time about 22 minutes');
  within(pct(meanOf(m.firstBase, 'waitShare')), 4, 6, 'waiting in traffic 5 % with four');
  within(pct(meanOf(m.firstSixth, 'waitShare')), 9, 11, 'waiting in traffic 10 % with six');
});

// ---------------------------------------------------------------------------------------------------------------------------
// A1.16 (the two new examples): speed
// ---------------------------------------------------------------------------------------------------------------------------

test('A1.16: Dock lab and Warehouse: first day simulate at least 500 times real time (target 2000, logged)', (t) => {
  const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1e6; };
  for (const id of ['dock-lab', 'warehouse-first-day']) {
    new Simulation(example(id).build(), { seed: 1 }).advance(600); // the first run of fresh code is slower
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const sim = new Simulation(example(id).build(), { seed: 1 });
      const t0 = cpu();
      sim.advance(3600);
      best = Math.min(best, cpu() - t0);
    }
    t.diagnostic(`${id}: ${best.toFixed(3)} CPU s per simulated hour = ${Math.round(3600 / best)}x real time (target 2000x)`);
    assert.ok(3600 / best >= 500, `${id}: ${Math.round(3600 / best)}x real time, required 500x`);
  }
});
