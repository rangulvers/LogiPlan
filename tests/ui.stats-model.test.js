// The view-model of the Statistics dock (js/ui/panels/stats-model.js; docs/ENTITY-INSIGHTS-DESIGN.md 3, 4.1, 5 and 10; acceptance S1.9, S1.10, S1.12, S1.13).
//   1. the formatters and the pure rules (arrow rule, usual route wording, drawn ways, colour ramp, hysteresis, fleet question, focus ids)
//   2. a vehicle from the fixtures of tests/fixtures/stats (answers of the collector for fixed runs): every number equals the collector's query and the Results
//      fleet table, the rows of "where it is held up" add up to the Held up number, the facts at their thresholds, the trips, the usual round, the windows
//   3. the other kinds (workstation, Goods in with doors, storage, Goods out, depot, flow, fleet, road cell, several): six numbers equal to the report, with and
//      without the collector, "Press play" before the first measured second
//   4. properties on REAL simulations of the five examples and a frozen dock plant with the collector on: no NaN / Infinity / undefined, no share above 100 %,
//      nothing printed negative, the rows plus "other places" equal the tile, building a model changes nothing the collector recorded
//   5. empty windows, a plant without vehicles, a vehicle that never moved, a dead vehicle, the caches
// The DOM (stats-view.js) is tests/ui.stats-view.test.js; the Help page tests/ui.stats-help.test.js; the real browser tests/e2e/stats-view.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../js/ui/panels/stats-model.js';
import { EMPTY_DRIVING_SHARE, generateInsights, congested as insightsCongested, fleetWaitShare as insightsFleetWaitShare } from '../js/sim/insights.js';
import { NO_STATION as DETAIL_NO_STATION } from '../js/sim/detail.js';
import {
  FIXTURES, readFixture, fixtureInput, layoutOfFixture, everySelection, modelProblems,
} from './helpers/stats-fixtures.js';
import { createFakeDetail } from './helpers/fake-sim.js';

const { buildStatsModel } = M;
const fixtures = Object.fromEntries(FIXTURES.map((name) => [name, readFixture(name)]));
const TWO = fixtures['two-lines-agv1.json'];
const WARE = fixtures['warehouse-goods-in.json'];
const DOCK44 = fixtures['dockplant-44-hostile.json'];
const EARLY = fixtures['two-lines-early.json'];
const near = (a, b, eps = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${msg} ${a} is not ${b} (eps ${eps})`);
const tweak = (fx, fn) => { const c = structuredClone(fx); fn(c); return c; };
const tileOf = (m, id) => m.tiles.find((t) => t.id === id);
const blockOf = (m, id) => m.blocks.find((b) => b.id === id);
const vehicleModelOf = (fx, id, opts = {}) => buildStatsModel(fixtureInput(fx, { kind: 'vehicle', ids: [id] }, opts));
const indexOfVehicle = (fx, id) => fx.vehicles.findIndex((v) => v.id === id);

// ---------------------------------------------------------------------------------------------------------
// 1. the formatters and the pure rules
// ---------------------------------------------------------------------------------------------------------

test('the formatters print a dash for anything that is not a finite number and never a share above 100 %', () => {
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, '3', {}]) {
    for (const f of [M.num, M.pct, M.duration, M.secs, M.mmss, M.metres]) assert.equal(f(bad), '–', `${f.name}(${String(bad)})`);
  }
  assert.equal(M.pct(0.5), '50 %');
  assert.equal(M.pct(1), '100 %');
  assert.equal(M.pct(1.0000001), '100 %', 'a share that drifted a hair above 1 prints as 100 %');
  assert.equal(M.pct(7.3), '100 %', 'and one that is far above it is cut at 100 %, never printed as 730 %');
  assert.equal(M.pct(-0.2), '0 %', 'a share is never negative');
  assert.equal(M.num(-0.0), '0', 'no "-0"');
  assert.equal(M.num(-0.04, 1), '0.0', 'a tiny negative rounds to a plain 0.0, never "-0.0"');
  assert.equal(M.num(1234.567, 1), '1,234.6');
  assert.equal(M.num(2, 1), '2.0');
  assert.equal(M.duration(45), '45 s');
  assert.equal(M.duration(89.6), '90 s');
  assert.equal(M.duration(150), '2.5 min');
  assert.equal(M.duration(700), '12 min');
  assert.equal(M.duration(7560), '2 h 6 min');
  assert.equal(M.duration(7200), '2 h');
  assert.equal(M.duration(-5), '0 s', 'a negative span is nothing');
  assert.equal(M.secs(62), '62 s');
  assert.equal(M.secs(95), '1.6 min');
  assert.equal(M.mmss(1431), '23:51 min');
  assert.equal(M.mmss(59.6), '1:00 min');
  assert.equal(M.metres(54), '54 m');
  assert.equal(M.metres(1530), '1.5 km');
  assert.equal(M.clockText(600), '0:10');
  assert.equal(M.clockText(3 * 3600 + 59), '3:00');
  assert.equal(M.clockText(-5), '0:00');
  assert.equal(M.clockText(NaN), '0:00');
});

test('the thresholds are the ones of the design, the insights ones are imported', () => {
  assert.deepEqual(
    [M.MIN_LEGS_FOR_USUAL, M.USUAL_SHARE_CLAIMED, M.VARIANT_DRAWN_SHARE, M.WAIT_SHARE_NOTABLE, M.WAIT_NOTABLE_SECONDS, M.QUEUE_SHARE, M.EMPTY_SHARE_NOTABLE, M.EMPTY_NOTABLE_METRES, M.DEPOT_DRIVE_SHARE, M.DEPOT_DRIVE_MIN, M.NEED_NEEDED_FROM],
    [5, 0.5, 0.1, 0.05, 60, 0.4, 0.6, 200, 0.08, 3, 0.9], 'section 3.0 (the empty share is the insights\' EMPTY_DRIVING_SHARE since the truth review: a shuttle drives about half of its metres empty)');
  assert.equal(M.EMPTY_SHARE_NOTABLE, EMPTY_DRIVING_SHARE, 'one source for what counts as driving empty too much');
  assert.equal(M.HYSTERESIS, 0.85);
  assert.equal(M.NEED_BORDERLINE_FROM, 0.75, 'FLEET_TARGET_UTILIZATION of insights.js');
  assert.equal(M.INDICATIVE_BELOW, 20 * 60, 'UNUSED_MIN_WINDOW of insights.js: below 20 minutes every verdict is indicative');
  assert.equal(M.NO_STATION, DETAIL_NO_STATION, 'the "no station" of the collector');
  assert.equal(M.congested, insightsCongested, 'one source of the "more vehicles do not help" test');
  assert.equal(M.fleetWaitShare, insightsFleetWaitShare);
});

test('the arrow rule: an arrow only when the difference is real (S1.12: 3 points, two sigma, 20 events, 12 %)', () => {
  // shares: 3 points of floor and 12 % of the peer value
  assert.equal(M.deltaMark(0.10, 0.06, { kind: 'share' }), 'up');
  assert.equal(M.deltaMark(0.04, 0.10, { kind: 'share' }), 'down');
  assert.equal(M.deltaMark(0.085, 0.06, { kind: 'share' }), null, '2.5 points are below the floor');
  assert.equal(M.deltaMark(0.0905, 0.06, { kind: 'share' }), 'up', 'just over 3 points and over 12 %');
  assert.equal(M.deltaMark(0.27, 0.25, { kind: 'share' }), null, '2 points: no arrow');
  assert.equal(M.deltaMark(0.30, 0.25, { kind: 'share' }), 'up', '5 points and 20 %');
  assert.equal(M.deltaMark(0.60, 0.575, { kind: 'share' }), null, '2.5 points on a big value is noise');
  assert.equal(M.deltaMark(0.8, 0.0, { kind: 'share' }), null, 'no peer, no arrow');
  assert.equal(M.deltaMark(NaN, 0.5, { kind: 'share' }), null);
  // rates from a count: 20 events and two standard deviations (sqrt(count) / hours)
  assert.equal(M.deltaMark(30, 10, { kind: 'rate', count: 19, hours: 1 }), null, 'under 20 events nothing is said');
  assert.equal(M.deltaMark(30, 10, { kind: 'rate', count: 20, hours: 1 }), 'up', '20 events: sigma 4.5, difference 20');
  const sigma = Math.sqrt(20) / 2;
  assert.equal(M.deltaMark(10 + 2 * sigma - 0.05, 10, { kind: 'rate', count: 20, hours: 2 }), null, 'a hair under two sigma');
  assert.equal(M.deltaMark(10 + 2 * sigma + 0.05, 10, { kind: 'rate', count: 20, hours: 2 }), 'up', 'a hair over two sigma');
  assert.equal(M.deltaMark(105, 100, { kind: 'rate', count: 400, hours: 1 }), null, '5 % is below the 12 % even when it is over two sigma');
  assert.equal(M.deltaMark(60, 100, { kind: 'rate', count: 400, hours: 1 }), 'down');
  assert.equal(M.deltaMark(5, 4, { kind: 'rate', count: null, hours: null }), null, 'a rate without a count has no arrow');
});

test('the usual route is claimed only from 5 complete trips and when one way carries at least half of the trips', () => {
  assert.deepEqual(M.usualWording({ complete: 4, variants: 1, share: 1 }), { usual: false, text: 'too few trips for a usual route' });
  assert.deepEqual(M.usualWording({ complete: 0, variants: 0, share: 0 }), { usual: false, text: 'too few trips for a usual route' });
  assert.deepEqual(M.usualWording({ complete: 5, variants: 1, share: 1 }), { usual: true, text: 'always the same way' });
  assert.deepEqual(M.usualWording({ complete: 9, variants: 3, share: 0.5 }), { usual: true, text: '50 % the same way' }, 'exactly half is enough');
  assert.deepEqual(M.usualWording({ complete: 9, variants: 3, share: 0.4949 }), { usual: false, text: '3 ways, the most used 49 %' });
  assert.deepEqual(M.usualWording({ complete: 20, variants: 4, share: 0.41 }), { usual: false, text: '4 ways, the most used 41 %' });
});

test('every way with at least 10 % of the trips of a pair is drawn, the usual one always', () => {
  const ways = (...ns) => ns.map((n, i) => ({ id: i, n }));
  assert.deepEqual(M.drawnVariants(ways(90, 9, 1)).map((p) => p.id), [0], '9 % and 1 % are not drawn');
  assert.deepEqual(M.drawnVariants(ways(80, 10, 10)).map((p) => p.id), [0, 1, 2], 'exactly 10 % is drawn');
  assert.deepEqual(M.drawnVariants(ways(1)).map((p) => p.id), [0]);
  assert.deepEqual(M.drawnVariants(ways(0, 0)).map((p) => p.id), [0], 'the usual one even when nothing is counted');
  assert.deepEqual(M.drawnVariants([]), []);
});

test('the red end of the colour ramp is the 90th percentile in steps of 5 %, between 8 % and 30 %', () => {
  assert.equal(M.rampMaxOf([]), 0.25, 'nothing on screen');
  assert.equal(M.rampMaxOf([0, 0, 0.01]), 0.08, 'a calm plant still has an amber and a red end');
  assert.equal(M.rampMaxOf([0.5, 0.6]), 0.3, 'a hopeless one is cut at 30 %');
  assert.equal(M.rampMaxOf([0.02, 0.04, 0.06, 0.07, 0.11]), 0.15, '90th of five is the largest: 11 % rounds up to 15 %');
  assert.equal(M.rampMaxOf([NaN, 0.1, Infinity]), 0.1, 'junk is ignored');
  assert.equal(M.rampMaxOf(Array.from({ length: 10 }, (_, i) => i * 0.02)), 0.2, '90th of ten: the tenth value, 18 %, rounds to 20 %');
  // the colour is a ramp over the tokens: calm for nothing, red for the red end
  assert.equal(M.rampColor(0, 0.25), 'var(--route-calm)');
  assert.equal(M.rampColor(0.25, 0.25), 'var(--route-much)');
  assert.equal(M.rampColor(5, 0.25), 'var(--route-much)', 'beyond the end it stays red');
  assert.equal(M.rampColor(NaN, 0.25), 'var(--route-calm)');
  assert.match(M.rampColor(0.0625, 0.25), /^color-mix\(in oklab, var\(--route-calm\), var\(--route-some\) \d+%\)$/, 'a quarter of the way: turning towards amber');
  assert.equal(M.rampColor(0.1, 0.25), 'var(--route-some)', 'amber holds in the middle');
});

test('a fact appears at its threshold, goes only below 0.85 times it, and a memory without history is a plain threshold (hysteresis on the value)', () => {
  const memory = M.createFactMemory();
  assert.equal(M.holds(memory, 'k', 0.0499, 0.05), false, 'just below: not yet');
  assert.equal(M.holds(memory, 'k', 0.05, 0.05), true, 'at the threshold');
  assert.equal(M.holds(memory, 'k', 0.0426, 0.05), true, 'stays down to 0.85 x 0.05 = 0.0425');
  assert.equal(M.holds(memory, 'k', 0.0424, 0.05), false, 'below 0.85 x: gone');
  assert.equal(M.holds(memory, 'k', 0.0426, 0.05), false, 'and it does not come back before the threshold');
  assert.equal(M.holds(memory, 'k', 0.06, 0.05), true);
  assert.equal(M.holds(memory, 'k', NaN, 0.05), false, 'a number that is not one never holds');
  assert.equal(M.holds(memory, 'k', 0.0426, 0.05), false, 'and it forgets');
  assert.equal(M.holds(M.createFactMemory(), 'other', 0.0426, 0.05), false, 'no history, no hysteresis');
  assert.equal(M.holds(memory, 'a', 0.06, 0.05) && M.holds(memory, 'b', 0.01, 0.05), false, 'facts do not share a memory');
});

test('the focus id of a route round-trips; the usual round has its own', () => {
  assert.equal(M.routeFocusId('loaded', 's4', 's5'), 'loaded:s4>s5');
  assert.deepEqual(M.parseFocusId('loaded:s4>s5'), { kind: 'loaded', from: 's4', to: 's5' });
  assert.deepEqual(M.parseFocusId(M.routeFocusId('empty', 'a b', 'c')), { kind: 'empty', from: 'a b', to: 'c' });
  assert.deepEqual(M.parseFocusId(M.routeFocusId('depot', 's4', 's8')), { kind: 'depot', from: 's4', to: 's8' });
  assert.deepEqual(M.parseFocusId(M.ROUND_FOCUS_ID), { kind: 'round', from: null, to: null });
  assert.equal(M.ROUND_FOCUS_ID, 'round');
  for (const junk of ['', 'loaded', 'loaded:s4', 'fly:s4>s5', null, undefined, 7]) assert.equal(M.parseFocusId(junk), null, String(junk));
});

test('a vehicle id is "<fleet>#<n>"; anything else is a fleet name with no number', () => {
  assert.deepEqual(M.parseVehicleId('v2#3'), { fleetId: 'v2', n: 3 });
  assert.deepEqual(M.parseVehicleId('fleet with #1#12'), { fleetId: 'fleet with #1', n: 12 });
  assert.deepEqual(M.parseVehicleId('v2'), { fleetId: 'v2', n: 0 });
  assert.deepEqual(M.parseVehicleId('v2#x'), { fleetId: 'v2#x', n: 0 });
});

test('a path becomes the corner points of its shape; a straight run is two points', () => {
  const cols = 10;
  const node = (x, y) => y * cols + x;
  assert.deepEqual(M.shapeOf([node(1, 1), node(2, 1), node(3, 1), node(4, 1)], cols), [[1, 1], [4, 1]]);
  assert.deepEqual(M.shapeOf([node(1, 1), node(2, 1), node(3, 1), node(3, 2), node(3, 3)], cols), [[1, 1], [3, 1], [3, 3]]);
  assert.deepEqual(M.shapeOf([node(2, 2)], cols), [[2, 2]]);
  assert.deepEqual(M.shapeOf([], cols), []);
});

test('a road cell is named by what it is: the dock of a station, a junction or a road near one, else its coordinates', () => {
  const layout = layoutOfFixture(TWO);
  const press = layout.stations.find((s) => s.name === 'Press line');
  const dockNode = TWO.report.stations[press.id].docks[0].node;
  assert.equal(M.cellLabel({ cols: 56 }, layout, TWO.report, dockNode), 'dock of Press line');
  const near = (press.y + press.h + 2) * 56 + press.x;
  assert.equal(M.cellLabel({ cols: 56, out: { [near]: [1, 2] } }, layout, TWO.report, near), 'road near Press line');
  assert.equal(M.cellLabel({ cols: 56, out: { [near]: [1, 2, 3] } }, layout, TWO.report, near), 'junction at Press line');
  assert.equal(M.cellLabel({ cols: 56 }, layout, TWO.report, 0), 'road cell (0, 0)', 'far from every station');
  assert.equal(M.cellLabel(null, layout, null, 0), 'road cell (0, 0)', 'a model without a graph still answers');
});

// ---------------------------------------------------------------------------------------------------------
// 1b. the fleet question (S1.12)
// ---------------------------------------------------------------------------------------------------------


test('the fleet question at its boundaries: 90 % needed, above 75 % borderline, 75 % and below spare, 95 % busy hides the count, congestion withholds it', () => {
  const fleet = (n, util, waiting = 0) => ({ count: n, utilization: util, shares: { waiting, driving: util - waiting } });
  const quiet = { traffic: { waitShare: 0 } };
  const seconds = 2 * 3600;
  // forecast = n * util / (n - 1) with no waiting: n = 4
  const at = (util) => M.fleetQuestion(quiet, fleet(4, util), seconds);
  assert.equal(at(0.675).verdict, 'needed', 'forecast 0.9: needed');
  assert.equal(at(0.674).verdict, 'borderline', 'just under 0.9');
  assert.equal(at(0.5626).verdict, 'borderline', 'just above 0.75');
  assert.equal(at(0.5625).verdict, 'spare', 'exactly 0.75: spare capacity');
  assert.equal(at(0.5).verdict, 'spare');
  assert.equal(at(0.76).verdict, 'needed', 'forecast above 1: needed, said in words');
  assert.match(at(0.76).text, /does not fit into 3; the others would have to work more than all the time/);
  assert.equal(at(0.95).censored, true, 'busy at 95 %: cut off');
  assert.equal(at(0.949).censored, false);
  assert.equal(at(0.949).needed, Math.ceil((4 * 0.949) / 0.75), 'ceil(Wp / 0.75)');
  assert.equal(at(0.5).needed, 3, 'W = 2: 2 / 0.75 rounds up to 3');
  // the waiting is not work: it comes off W
  const waited = M.fleetQuestion(quiet, fleet(4, 0.6, 0.05), seconds);
  near(waited.Wp, 4 * 0.6 - 4 * 0.05, 1e-12);
  near(waited.forecast, (4 * 0.55) / 3, 1e-12, 'forecast = (W - n x waiting) / (n - 1)');
  // withheld while the fleet or the plant queues: 12 % of the moving time
  assert.equal(M.fleetQuestion(quiet, fleet(4, 0.5, 0.06), seconds).verdict, 'queueing', 'waiting 6 % of a 50 % utilisation is 12 % of the moving time');
  assert.equal(M.fleetQuestion(quiet, fleet(4, 0.5, 0.0599), seconds).verdict, 'spare');
  assert.equal(M.fleetQuestion({ traffic: { waitShare: 0.12 } }, fleet(4, 0.5, 0), seconds).verdict, 'queueing', 'or the whole plant does');
  // vehicles that charge or are broken down cannot take work over: the verdict follows the load on the time IN SERVICE (STAT-REV-6), the forecast stays a share of all the time
  const away = (n, util, charging, broken = 0) => ({ count: n, utilization: util, shares: { waiting: 0, driving: util, charging, broken } });
  const free = M.fleetQuestion(quiet, away(4, 0.5, 0), seconds);
  assert.equal(free.verdict, 'spare'); near(free.forecast, 2 / 3, 1e-12); near(free.load, 2 / 3, 1e-12);
  const charging = M.fleetQuestion(quiet, away(4, 0.5, 0.25), seconds);
  near(charging.forecast, 2 / 3, 1e-12, 'the forecast is what a simulation with one vehicle less measures: a share of all the time');
  near(charging.available, 0.75, 1e-12); near(charging.load, 2 / 3 / 0.75, 1e-12, 'the load is that of the time in service');
  assert.equal(charging.verdict, 'borderline', '25 % of the time on the chargers: 89 % of the time in service');
  assert.match(charging.text, /busy about 67 % of the time, 89 % of the time they are in service/);
  assert.equal(M.fleetQuestion(quiet, away(4, 0.5, 0.2, 0.1), seconds).verdict, 'needed', 'charging and broken down add up: 70 % in service, load 95 %');
  assert.equal(charging.needed, Math.ceil((4 * 0.5) / (0.75 * 0.75)), 'ceil(Wp / (0.75 x time in service))');
  const dead = M.fleetQuestion(quiet, away(2, 0.02, 0, 0.98), seconds);
  assert.equal(dead.verdict, 'unavailable'); assert.doesNotMatch(dead.text, /could take over/); assert.match(dead.text, /Out of service 98 % of the time/);
  assert.equal(M.fleetQuestion(quiet, away(4, 0.3, 0.5), seconds).verdict, 'unavailable', 'in service half of the time or less: no verdict');
  assert.notEqual(M.fleetQuestion(quiet, away(4, 0.3, 0.49), seconds).verdict, 'unavailable', 'just above half');
  // a fleet that is busy all the time says "at the limit": neither needed nor spare, no count (STAT-REV-17)
  const limit = at(0.97);
  assert.equal(limit.verdict, 'limit'); assert.equal(limit.censored, true); assert.equal(limit.needed, null);
  assert.match(limit.text, /^At the limit: the fleet is busy all the time/); assert.doesNotMatch(limit.text, /does not fit|about \d+ vehicles/);
  // the queue is named: the fleet's own share, or the plant's with the fleet's beside it (STAT-REV-7)
  assert.match(M.fleetQuestion(quiet, fleet(4, 0.5, 0.06), seconds).text, /^Vehicles queue \(12 % of their moving time\):/);
  assert.match(M.fleetQuestion({ traffic: { waitShare: 0.2 } }, fleet(4, 0.5, 0), seconds).text, /^Vehicles queue across the plant \(20 % of their moving time; this fleet's vehicles 0 %\):/);
  assert.deepEqual(M.fleetQuestion({ traffic: { waitShare: 0.2 } }, fleet(4, 0.5, 0.01), seconds).queue.own < 0.12, true);
  // too early, too small
  assert.equal(M.fleetQuestion(quiet, fleet(4, 0.5), 20 * 60 - 1).verdict, 'indicative');
  assert.equal(M.fleetQuestion(quiet, fleet(4, 0.5), 20 * 60).verdict, 'spare', 'from 20 minutes');
  assert.equal(M.fleetQuestion(quiet, fleet(1, 0.5), seconds).verdict, 'indicative', 'a fleet of one');
  assert.equal(M.fleetQuestion(quiet, fleet(0, 0), seconds).verdict, 'indicative', 'no vehicles');
  assert.equal(M.fleetQuestion(quiet, null, seconds).verdict, 'indicative', 'no fleet at all');
  assert.equal(M.fleetQuestion(null, fleet(4, 0.5), seconds).verdict, 'spare', 'no report: the plant does not queue');
});

test('congested() agrees with the "relieve the congestion" suggestion of the fleet-saturated insight', () => {
  const layout = layoutOfFixture(TWO);
  for (const [waiting, plantWait] of [[0.02, 0.02], [0.2, 0.02], [0.02, 0.2], [0.0, 0.0], [0.06, 0.0]]) {
    const report = structuredClone(TWO.report);
    for (const f of Object.values(report.fleets)) { f.utilization = 0.9; f.shares.waiting = waiting; f.shares.driving = 0.9 - waiting; }
    report.traffic.waitShare = plantWait;
    const insight = generateInsights(report, layout).find((i) => i.id === 'fleet-saturated:v2');
    assert.ok(insight, `a fleet at 90 % is saturated (waiting ${waiting}, plant ${plantWait})`);
    const withheld = M.fleetQuestion(report, report.fleets.v2, report.window.duration).verdict === 'queueing';
    assert.equal(/relieve the congestion/.test(insight.suggestion), withheld, `the insight and the dock agree: ${insight.suggestion}`);
    assert.equal(M.congested(report, report.fleets.v2), withheld);
  }
});

// ---------------------------------------------------------------------------------------------------------
// 2. a vehicle from the fixtures
// ---------------------------------------------------------------------------------------------------------

test('S1.9: every number of a vehicle equals the collector\'s query for the shown window, for every vehicle of Two lines, in both windows', () => {
  for (const win of ['start', 'last30']) {
    for (let i = 0; i < TWO.vehicles.length; i++) {
      const v = TWO.vehicles[i];
      const q = TWO.queries[win].vehicles[i];
      const t = q.timeSplit;
      const hours = t.seconds / 3600;
      const m = vehicleModelOf(TWO, v.id, { window: win });
      assert.equal(m.status, 'ready');
      near(tileOf(m, 'trips').raw, q.counts.trips / hours, 1e-12, `${v.id} ${win} trips per hour`);
      near(tileOf(m, 'busy').raw, (t.driving + t.waiting + t.dockQueue + t.loading + t.unloading) / t.seconds, 1e-12, 'busy');
      near(tileOf(m, 'held').raw, (t.waiting + t.dockQueue) / t.seconds, 1e-12, 'held up');
      near(tileOf(m, 'driven').raw, (q.counts.loaded + q.counts.empty + q.counts.park) / hours / 1000, 1e-12, 'driven');
      const legs = q.routes.filter((r) => r.kind === 1 && r.meanTime !== null && r.complete > 0);
      const loaded = legs.reduce((a, r) => a + r.meanTime * r.complete, 0) / Math.max(1, legs.reduce((a, r) => a + r.complete, 0));
      if (legs.length) near(tileOf(m, 'loaded').raw, loaded, 1e-12, 'average loaded trip'); else assert.equal(tileOf(m, 'loaded').raw, null);
      if (v.fleetId === 'v2') near(tileOf(m, 'battery').raw, q.batteryOf.min, 1e-12, 'lowest battery');
      else near(tileOf(m, 'parked').raw, t.parked / t.seconds, 1e-12, 'parked');
      assert.deepEqual(modelProblems(m), [], `${v.id} ${win}`);
    }
  }
});

test('S1.9: the numbers of the design\'s mock-up for AGVs 1 on Two lines (the fixture of 2 h 6 min)', () => {
  const m = vehicleModelOf(TWO, 'v2#1');
  assert.deepEqual(m.tiles.map((t) => `${t.label}: ${t.value}${t.unit}`), [
    'Trips per hour: 18.6/h', 'Busy, incl. waiting: 78 %', 'Held up: 7 %', 'Driven: 1.9 km/h', 'Avg loaded trip: 54 s', 'Lowest battery: 49 %']);
  assert.deepEqual(m.tiles.map((t) => t.ref.text), [
    'fleet 17.8', 'fleet 73 %', 'fleet 6 %', 'loaded 43 % · empty 31 % · to depot 26 %', 'fleet 51 s', '2 charge stops in the window']);
  assert.equal(m.header.live.rest.endsWith('2 h 6 min measured'), true, 'the header says how long it measured');
  assert.equal(m.window.text, '2 h 6 min measured, warm-up excluded');
  assert.equal(m.ariaLabel, 'Statistics for AGVs 1');
  assert.deepEqual(m.blocks.map((b) => b.type), ['time', 'facts', 'trips']);
  assert.equal(m.windows.last30, true);
  assert.equal(m.routes, true);
});

test('S1.9: trips per hour, held up and busy equal the Results fleet table for the same window (rounding)', () => {
  const fleet = TWO.report.fleets.v2;
  const mates = TWO.vehicles.filter((v) => v.fleetId === 'v2').map((v) => vehicleModelOf(TWO, v.id));
  const mean = (f) => mates.reduce((a, m) => a + f(m), 0) / mates.length;
  near(mean((m) => tileOf(m, 'trips').raw), fleet.tripsPerVehicleHour, 1e-6, 'trips per vehicle and hour');
  near(mean((m) => tileOf(m, 'held').raw), fleet.shares.waiting, 1e-9, 'held up = the waiting share of the fleet');
  near(mean((m) => tileOf(m, 'busy').raw), fleet.utilization, 1e-9, 'busy = the utilization of the fleet');
  for (const v of TWO.vehicles.filter((x) => x.fleetId === 'v2')) {
    const m = vehicleModelOf(TWO, v.id);
    near(tileOf(m, 'trips').raw, fleet.vehicleTrips[v.id] / (TWO.report.window.duration / 3600), 1e-6, `${v.id}: the vehicle's own deliveries of the Results tab`);
  }
  // the fleet reference value of a tile is the same mean
  assert.equal(vehicleModelOf(TWO, 'v2#1').tiles[1].ref.text, `fleet ${M.pct(fleet.utilization)}`);
});

test('S1.9: the three driving pieces of the time split add up to driving and all 11 pieces to the whole window', () => {
  for (const win of ['start', 'last30']) {
    for (let i = 0; i < TWO.vehicles.length; i++) {
      const m = vehicleModelOf(TWO, TWO.vehicles[i].id, { window: win });
      const t = TWO.queries[win].vehicles[i].timeSplit;
      const split = blockOf(m, 'time').split;
      const share = (key) => (split.items.find((p) => p.key === key) || { share: 0 }).share;
      near(share('drivingLoaded') + share('drivingEmpty') + share('drivingDepot'), t.driving / t.seconds, 1e-3, 'the three parts of driving (pieces under 0.4 % are not drawn)');
      const all = split.items.reduce((a, p) => a + p.share, 0);
      assert.ok(all <= 1 + 1e-6 && all >= 0.98, `${TWO.vehicles[i].id} ${win}: the pieces add up to ${all}`);
      assert.ok(split.items.every((p) => p.share > 0.004 && p.text.endsWith(' %')));
      assert.match(split.label, /^Time split: Driving loaded \d+ %/, 'a sentence for the picture');
    }
  }
});

test('S1.9: the rows of "where it is held up" plus "other places" equal the Held up number (3 %), both windows, every vehicle of every fixture', () => {
  for (const fx of [TWO, WARE, DOCK44]) {
    for (const win of ['start', 'last30']) {
      for (let i = 0; i < fx.vehicles.length; i++) {
        const t = fx.queries[win].vehicles[i].timeSplit;
        const tile = t.waiting + t.dockQueue;
        const m = vehicleModelOf(fx, fx.vehicles[i].id, { window: win });
        const held = blockOf(m, 'time').held;
        if (tile < 1) { assert.equal(held, null, 'nothing was held up: no rows'); continue; }
        const sum = held.rows.reduce((a, r) => a + r.seconds, 0);
        assert.ok(Math.abs(sum - tile) <= 0.03 * tile, `${fx.vehicles[i].id} ${win}: rows ${sum} against tile ${tile}`);
        near(sum, tile, 1e-9, 'by construction they are equal');
        assert.ok(held.rows.length <= 5, 'at most four rows and "other places"');
        assert.equal(held.rows[held.rows.length - 1].key, 'other');
        assert.ok(held.rows.every((r) => r.seconds >= 0 && r.share >= 0 && r.share <= 1 + 1e-9));
        assert.equal(held.total, tile);
      }
    }
  }
});

test('S1.10: Last 30 min shows no cell rows and says why; Since start has them', () => {
  const start = blockOf(vehicleModelOf(TWO, 'v2#1', { window: 'start' }), 'time').held;
  const last = blockOf(vehicleModelOf(TWO, 'v2#1', { window: 'last30' }), 'time').held;
  assert.ok(start.rows.some((r) => r.kind === 'cell'), 'since start: a road cell is named');
  assert.ok(start.rows.every((r) => !/^Queue for/.test(r.label) || r.kind === 'queue'));
  assert.ok(last.rows.every((r) => r.kind !== 'cell'), 'the last 30 minutes: queues only');
  assert.equal(last.rows[last.rows.length - 1].label, 'Other places (road cells: since start only)');
  assert.match(last.note, /Road cells are listed for Since start only/);
  assert.equal(start.rows[start.rows.length - 1].label, 'Other places');
  assert.match(start.note, /Booked on the cell that blocks \(a junction or a dock\), not where the vehicle stands\./);
});

test('S1.10: the window text counts from the collector\'s start, says "indicative" below 20 minutes and shows the real length', () => {
  const full = vehicleModelOf(TWO, 'v2#1');
  assert.equal(full.window.text, '2 h 6 min measured, warm-up excluded');
  assert.equal(full.window.indicative, false);
  assert.equal(full.window.since, '0:10');
  assert.equal(blockOf(full, 'facts').how[0], 'Counted since 0:10 (warm-up excluded).');
  const last = vehicleModelOf(TWO, 'v2#1', { window: 'last30' });
  assert.equal(last.window.text, '30 min measured');
  assert.equal(last.window.equalsStart, false);
  assert.equal(last.window.since, '1:46');
  assert.equal(blockOf(last, 'facts').how[0], 'The last 30 minutes, counted since 1:46.');
  // 90 seconds measured: a window shorter than 30 minutes is Since start, and says so; 20 minutes are not there yet
  const early = vehicleModelOf(EARLY, 'v2#1', { window: 'last30' });
  assert.equal(early.window.equalsStart, true);
  assert.equal(early.window.indicative, true);
  assert.equal(early.window.text, '1.5 min measured, the same as Since start until 30 minutes have passed, indicative');
  assert.match(blockOf(early, 'facts').how[0], /Under 30 minutes have been measured, so the last 30 minutes are the same as Since start\./);
  assert.equal(vehicleModelOf(EARLY, 'v2#1').window.text, '1.5 min measured, warm-up excluded, indicative');
  assert.equal(vehicleModelOf(EARLY, 'v2#1').header.live.rest.endsWith('1.5 min measured, indicative'), true);
  // late enabling: the collector began at 0:50, the report's window at 0:10
  const late = tweak(TWO, (c) => { c.detail.windowStart = 3000; c.windows.start.t0 = 3000; });
  const m = vehicleModelOf(late, 'v2#1');
  assert.equal(m.window.late, true);
  assert.equal(m.window.text, 'counting since 0:50');
  assert.match(blockOf(m, 'facts').how[0], /^Counting since 0:50: the statistics were switched on then, so earlier time is not in these figures\.$/);
  assert.equal(vehicleModelOf(TWO, 'v2#1', { window: 'last30' }).window.late, false);
});

test('S1.10: a setting changed during the run is noted, and so is a restart after the fleet changed', () => {
  const changed = tweak(TWO, (c) => { c.detail.whatIf = [{ t: 4000, key: 'demandFactor', from: 1, to: 1.5 }, { t: 100, key: 'speedFactor', from: 1, to: 2 }]; });
  const how = blockOf(vehicleModelOf(changed, 'v2#1'), 'facts').how;
  assert.ok(how.some((x) => /^Demand changed about 69 min ago: figures from before then mix both\.$/.test(x)), how.join(' | ')); // stamped when the next 30 s bucket closes: "about"
  assert.ok(!how.some((x) => /Vehicle speed/.test(x)), 'a change from before the window began is not in it');
  const restarted = tweak(TWO, (c) => { c.detail.notices = [{ t: 4500, text: 'The vehicles or stations changed; the statistics start counting again here' }]; });
  assert.ok(blockOf(vehicleModelOf(restarted, 'v2#1'), 'facts').how.some((x) => x === 'The vehicles or stations changed; the statistics start counting again here (at 1:15).'));
  // the collector's own text ends in a full stop: no second one after "(at 1:15)" (STAT-REV-16)
  const real = tweak(TWO, (c) => { c.detail.notices = [{ t: 4500, text: 'The vehicles or stations changed; the statistics start counting again here.' }]; });
  assert.ok(blockOf(vehicleModelOf(real, 'v2#1'), 'facts').how.includes('The vehicles or stations changed; the statistics start counting again here (at 1:15).'));
  assert.ok(blockOf(vehicleModelOf(TWO, 'v2#1'), 'facts').how.length === 2, 'nothing changed: only the two standing lines');
});

test('S1.9: the trips are the loaded pairs by trips, with the usual way, the share and the dock pair', () => {
  const m = vehicleModelOf(TWO, 'v2#1');
  const trips = blockOf(m, 'trips');
  assert.equal(trips.aside, 'top 3 of 4');
  assert.deepEqual(trips.rows.map((r) => r.name), ['Press line → Final assembly', 'Central warehouse → Press line', 'Central warehouse → Machining']);
  assert.deepEqual(trips.rows.map((r) => r.rank), [1, 2, 3]);
  assert.equal(trips.rows[0].meta, '16 trips · 7.6/h · 54 m · 62 s');
  assert.equal(trips.rows[0].waits, 'waits 7 s');
  assert.equal(trips.rows[0].waitTone, 'some', '7 s of 62 s is 11 %: amber');
  assert.equal(trips.rows[1].waitTone, 'much', '11 s of 52 s is 21 %: red');
  assert.equal(trips.rows[2].waitTone, '', 'no waiting: no colour');
  assert.equal(trips.rows[0].usual, '', 'always the same way: nothing to add');
  assert.equal(trips.rows[2].usual, '', 'five complete trips on one way: usual, nothing to add');
  assert.ok(trips.rows.every((r) => r.shape.length >= 2 && r.label.startsWith(`${r.rank}: `) && r.focusId === M.routeFocusId('loaded', ...r.focusId.slice(7).split('>'))));
  assert.match(trips.rows[0].label, /^1: Press line to Final assembly, 16 trips, 7\.6 an hour, 54 m, 62 s each, held up 7 s, always the same way$/, 'the whole sentence for a screen reader');
  assert.deepEqual(trips.legend, { max: 0.25, text: 'time lost waiting: none → 25 %+' });
  assert.equal(trips.other.text, '39 empty · 27 to depot or charger');
  assert.equal(trips.other.items.length, 2);
  // sorted by trips, the same way ties are broken as in the design (most trips, then longer path)
  for (let k = 1; k < trips.rows.length; k++) assert.ok(trips.rows[k - 1].trips >= trips.rows[k].trips);
});

test('S1.9: with several docks the way depends on the dock: the dock pairs are shown, grouped, and "usual" is not claimed below half', () => {
  let found = 0;
  for (let i = 0; i < WARE.vehicles.length; i++) {
    const m = vehicleModelOf(WARE, WARE.vehicles[i].id);
    for (const r of blockOf(m, 'trips').rows) {
      if (!r.ways) continue;
      found++;
      assert.match(r.ways, /^(Dock \d → Dock \d \d+ %)( · Dock \d → Dock \d \d+ %){0,2}$/, r.ways);
      const shares = [...r.ways.matchAll(/(\d+) %/g)].map((x) => Number(x[1]));
      assert.ok(shares.reduce((a, b) => a + b, 0) <= 101, `the groups add up to at most 100 % (rounding): ${r.ways}`);
      assert.ok(shares.every((x, k) => k === 0 || shares[k - 1] >= x), 'the most used first');
      assert.match(r.label, /Dock \d to Dock \d \d+ %/, 'and in the sentence for a screen reader, with words instead of arrows');
    }
  }
  assert.ok(found > 0, 'Warehouse first day has vehicles that choose between docks');
  const m = vehicleModelOf(WARE, 'v1#1');
  const fact = blockOf(m, 'facts').facts.find((f) => f.id === 'main');
  if (fact && /ways, the most used/.test(fact.text)) assert.match(fact.text, /: the dock chosen changes the way\.$/);
});

test('S1.9: a pair is "usual" only from 5 complete trips and half of the trips; below that the row says "N ways" or "too few trips"', () => {
  const pick = (complete, variants, share) => tweak(TWO, (c) => {
    const i = indexOfVehicle(c, 'v2#1');
    const r = c.queries.start.vehicles[i].routes.find((x) => x.kind === 1 && x.complete >= 5);
    r.complete = complete;
    r.variants = variants;
    r.pathShare = share;
    r.pathIds = Array.from({ length: Math.max(1, variants) }, (_, k) => ({ id: r.pathIds[0].id, n: Math.max(1, Math.round(r.trips * (k === 0 ? share : (1 - share) / Math.max(1, variants - 1)))), complete: 1, meanTime: r.meanTime, meanWait: r.meanWait }));
    r.drawn = r.pathIds.reduce((a, p) => a + p.n, 0);
  });
  const row = (fx) => blockOf(vehicleModelOf(fx, 'v2#1'), 'trips').rows.find((x) => x.rank === 1);
  assert.equal(row(pick(4, 1, 1)).usual, 'too few trips for a usual route');
  assert.equal(row(pick(5, 1, 1)).usual, '');
  assert.equal(row(pick(9, 3, 0.5)).usual, '50 % the same way');
  assert.match(row(pick(9, 3, 0.45)).usual, /^3 ways, the most used \d+ %$/);
});

test('S1.9: the usual round is the most frequent pair of consecutive trips, with its count; none when it is rarer than 3', () => {
  const m = vehicleModelOf(TWO, 'v2#1');
  const round = blockOf(m, 'trips').round;
  assert.deepEqual(round.jobs, ['Central warehouse → Press line', 'Central warehouse → Press line']);
  assert.equal(round.text, '3 of 11 pairs of trips (27 %), empty drive between');
  assert.equal(round.focusId, 'round');
  assert.ok(round.bounds && round.bounds.w > 0, 'the paths of the round: something to bring into view');
  assert.match(round.label, /^Usual round: Central warehouse to Press line, then Central warehouse to Press line, 3 of 11 pairs of trips, 27 %$/);
  assert.equal(blockOf(vehicleModelOf(TWO, 'v2#1', { window: 'last30' }), 'trips').round, null, 'under 3 occurrences there is none');
  assert.equal(blockOf(tweak(TWO, (c) => { c.queries.start.vehicles[3].round = { jobs: [{ from: 1, to: 65535 }, { from: 2, to: 3 }], count: 3, of: 10, share: 0.3 }; }) && vehicleModelOf(tweak(TWO, (c) => { c.queries.start.vehicles[3].round = { jobs: [{ from: 1, to: 65535 }, { from: 2, to: 3 }], count: 3, of: 10, share: 0.3 }; }), 'v2#1'), 'trips').round, null, 'a round that names no station is not drawn');
});

test('counts say what they are based on: a row whose times come from fewer trips than it counts, a trip that is not drawn, a number from a few trips', () => {
  const partial = (complete, trips, undrawn) => tweak(TWO, (c) => {
    const r = c.queries.start.vehicles[indexOfVehicle(c, 'v2#1')].routes.filter((x) => x.kind === 1).sort((a, b) => b.trips - a.trips)[0];
    Object.assign(r, { complete, trips, undrawn, meanTime: complete > 0 ? r.meanTime : null, meanWait: complete > 0 ? r.meanWait : null });
  });
  const first = (fx) => blockOf(vehicleModelOf(fx, 'v2#1'), 'trips').rows.find((r) => r.rank === 1);
  assert.equal(first(TWO).note, '', 'all trips complete, all drawn: nothing to add');
  const a = first(partial(3, 20, 1));
  assert.equal(a.note, 'times from 3 of 20 trips · 1 trip not drawn');
  assert.match(a.label, /, times from 3 of 20 trips, 1 trip not drawn$/);
  assert.equal(first(partial(0, 20, 20)).note, 'no complete trip yet · 20 trips not drawn');
  const m = vehicleModelOf(TWO, 'v2#1');
  assert.match(tileOf(m, 'trips').def, /Counted from \d+ deliveries\.$/, 'the (i) of the trips number says how many deliveries it is');
  assert.match(tileOf(m, 'loaded').def, /Based on \d+ complete trips\.$/);
  const few = tweak(TWO, (c) => { const q = c.queries.start.vehicles[indexOfVehicle(c, 'v2#1')]; q.counts.trips = 1; q.routes = q.routes.filter((r) => r.kind !== 1 || r.complete === 1).slice(0, 1); });
  assert.match(tileOf(vehicleModelOf(few, 'v2#1'), 'trips').def, /Counted from 1 delivery\./);
});

test('S1.12: each fact of a vehicle appears at its threshold and not just below, and goes below 0.85 times it', () => {
  // a vehicle of 1 h in the window whose held-up share we set exactly
  const base = (held, extra = {}) => tweak(TWO, (c) => {
    const i = indexOfVehicle(c, 'v2#1');
    const t = c.queries.start.vehicles[i].timeSplit;
    const total = 3600;
    const waiting = held * total;
    Object.assign(t, { seconds: total, waiting: waiting * 0.5, dockQueue: waiting * 0.5, driving: 1500, loading: 500, unloading: 500, idle: 0, parked: total - 2500 - waiting, charging: 0, broken: 0, drivingLoaded: 700, drivingEmpty: 700, drivingDepot: 100, ...extra });
    c.queries.start.vehicles[i].queues = [{ station: 4, seconds: waiting * 0.5, legs: 10, dockNode: 1245 }];
    c.queries.start.vehicles[i].hotspots = { cells: [{ node: 1030, seconds: waiting * 0.5 }], total: waiting, folded: 0 };
    c.queries.start.vehicles[i].counts.trips = 30;
    c.queries.start.vehicles[i].counts.empty = 400; c.queries.start.vehicles[i].counts.loaded = 800; c.queries.start.vehicles[i].counts.park = 100;
  });
  const has = (fx, id, memory) => blockOf(buildStatsModel({ ...fixtureInput(fx, { kind: 'vehicle', ids: ['v2#1'] }), factMemory: memory }), 'facts').facts.some((f) => f.id === id);
  const memory = M.createFactMemory();
  assert.equal(has(base(0.0499), 'held', memory), false, 'just below 5 %');
  assert.equal(has(base(0.05), 'held', memory), true, 'at 5 % (and 180 s)');
  assert.equal(has(base(0.0426), 'held', memory), true, 'stays down to 0.85 x 5 %');
  assert.equal(has(base(0.0424), 'held', memory), false, 'below that it goes');
  assert.equal(has(base(0.0426), 'held', memory), false, 'and does not come back until 5 %');
  assert.equal(has(base(0.05), 'held', M.createFactMemory()), true);
  // 60 seconds of held-up time at least: 0.05 of 1 h is 180 s, so shrink the window to 10 min and the seconds fall below 60
  const short = tweak(base(0.05), (c) => { const t = c.queries.start.vehicles[indexOfVehicle(c, 'v2#1')].timeSplit; for (const k of ['waiting', 'dockQueue']) t[k] /= 4; t.parked += 90; });
  assert.equal(has(short, 'held', M.createFactMemory()), false, 'under 60 s of waiting nothing is said');
  // driving to park or charge: 8 % of the time and 3 drives
  const depot = (share, drives) => tweak(base(0.0), (c) => {
    const i = indexOfVehicle(c, 'v2#1');
    Object.assign(c.queries.start.vehicles[i].timeSplit, { drivingDepot: share * 3600, drivingLoaded: 700 - (share * 3600 - 100) / 2, drivingEmpty: 700 - (share * 3600 - 100) / 2 });
    c.queries.start.vehicles[i].routes = c.queries.start.vehicles[i].routes.filter((r) => r.kind === 1);
    if (drives > 0) c.queries.start.vehicles[i].routes.push({ kind: 3, from: 3, to: 7, flow: 65535, trips: drives, complete: drives, meanTime: 30, meanWait: 0, meanDockWait: 0, meanQty: 0, pathId: -1, pathShare: 0, drawn: 0, undrawn: drives, variants: 0, metres: 0, usualTime: 30, usualWait: 0, disturbed: 0, pathIds: [] });
  });
  assert.equal(has(depot(0.0799, 5), 'depot', M.createFactMemory()), false, '7.99 %');
  assert.equal(has(depot(0.08, 5), 'depot', M.createFactMemory()), true, '8 %');
  assert.equal(has(depot(0.2, 2), 'depot', M.createFactMemory()), false, 'only 2 drives');
  assert.equal(has(depot(0.2, 3), 'depot', M.createFactMemory()), true, '3 drives');
  // the empty share of the metres: 60 % (the insights' EMPTY_DRIVING_SHARE: a shuttle drives about half of its metres empty) and more than 200 m (instead of the depot sentence)
  const empty = (e, l, p) => tweak(depot(0.0, 0), (c) => { Object.assign(c.queries.start.vehicles[indexOfVehicle(c, 'v2#1')].counts, { empty: e, loaded: l, park: p }); });
  assert.equal(has(empty(500, 500, 0), 'empty', M.createFactMemory()), false, '50 %: a shuttle, no finding');
  assert.equal(has(empty(599, 401, 0), 'empty', M.createFactMemory()), false, '59.9 %');
  assert.equal(has(empty(600, 400, 0), 'empty', M.createFactMemory()), true, '60 %');
  assert.equal(has(empty(100, 100, 0), 'empty', M.createFactMemory()), false, '50 % of 200 m is not more than 200 m');
  // a vehicle that did nothing in 10 minutes or more says so
  const idle = tweak(TWO, (c) => { const i = indexOfVehicle(c, 'v2#1'); c.queries.start.vehicles[i].counts.trips = 0; c.queries.start.vehicles[i].routes = []; c.queries.start.vehicles[i].queues = []; Object.assign(c.queries.start.vehicles[i].timeSplit, { driving: 0, waiting: 0, dockQueue: 0, loading: 0, unloading: 0, idle: 600, parked: 6960, charging: 0, broken: 0, drivingLoaded: 0, drivingEmpty: 0, drivingDepot: 0 }); });
  const text = blockOf(vehicleModelOf(idle, 'v2#1'), 'facts').facts.find((f) => f.id === 'none').text;
  assert.match(text, /^AGVs 1 made no trip in 2 h 6 min: it was parked 92 % and without a job 8 % of the time\.$/);
  // the sentence names where the time went: a vehicle that was dead is not "parked 0 % and without a job 0 %" (STAT-REV-15)
  const dead = tweak(idle, (c) => { Object.assign(c.queries.start.vehicles[indexOfVehicle(c, 'v2#1')].timeSplit, { idle: 0, parked: 100, broken: 7400 }); });
  assert.match(blockOf(vehicleModelOf(dead, 'v2#1'), 'facts').facts.find((f) => f.id === 'none').text, /^AGVs 1 made no trip in 2 h 6 min: it was out of service \(broken down or battery empty\) 98 % of the time\.$/);
});

test('S1.12: the held-up sentence names the queues when together they hold 40 % of it, else the one cell that holds 40 %, else nothing', () => {
  const held = (queues, cell, other = 0) => tweak(TWO, (c) => {
    const i = indexOfVehicle(c, 'v2#1');
    const q = queues.reduce((a, x) => a + x, 0);
    Object.assign(c.queries.start.vehicles[i].timeSplit, { seconds: 3600, waiting: cell + other, dockQueue: q, driving: 1500, loading: 500, unloading: 500, idle: 0, parked: 3600 - 2500 - cell - other - q, charging: 0, broken: 0, drivingLoaded: 700, drivingEmpty: 700, drivingDepot: 100 });
    c.queries.start.vehicles[i].queues = queues.map((seconds, k) => ({ station: 3 + k, seconds, legs: 5, dockNode: 1245 + k }));
    c.queries.start.vehicles[i].hotspots = { cells: cell > 0 ? [{ node: 1030, seconds: cell }] : [], total: cell + other + q, folded: 0 };
  });
  const text = (fx) => blockOf(vehicleModelOf(fx, 'v2#1'), 'facts').facts.find((f) => f.id === 'held').text;
  assert.match(text(held([40, 40, 40, 40], 180)), /; 47 % of that in the queue for a dock, about 2\.7 min in every hour\.$/, 'four small queues and one big cell: the queues are the finding');
  assert.match(text(held([20, 20], 300)), /; 88 % of it at the (junction|road)[A-Za-z ]*\.$/, 'one cell holds nearly all of it');
  assert.match(text(held([20], 120, 180)), /\.$/);
  assert.doesNotMatch(text(held([20], 120, 180)), /of that in the queue|of it at the/, 'nothing holds 40 %: no place is named');
  const rect = blockOf(vehicleModelOf(held([40, 40, 40, 40], 180), 'v2#1'), 'facts').facts.find((f) => f.id === 'held').rect;
  assert.ok(rect && rect.w === TWO.graph.cellSize, 'the biggest queue is the place to show');
});

test('S1.12: the facts are at most four, the fleet question is one of them, and under Last 30 min it says it is since start', () => {
  const start = blockOf(vehicleModelOf(TWO, 'v2#1'), 'facts').facts;
  assert.ok(start.length <= 4);
  assert.deepEqual(start.map((f) => f.id), ['held', 'main', 'depot', 'fleet']);
  assert.match(start[0].text, /^AGVs 1 is held up 7 % of its time \(fleet 6 %\); \d+ % of that in the queue for a dock, about 3\.1 min in every hour\.$/);
  assert.match(start[1].text, /^Its main trip Press line → Final assembly: 16 trips \(7\.6 an hour\), 62 s each; always the same way\.$/);
  assert.match(start[2].text, /^15 % of AGVs 1’s time goes to driving to park or charge \(27 times in 2 h 6 min\); 26 % of its metres\.$/);
  assert.match(start[3].text, /^Fleet: Borderline: without it the other 6 would be busy about 77 % of the time, 82 % of the time they are in service \(the insights aim for 75 % of the time in service\)\. At 75 % load the work would need about 7 vehicles\./);
  const forklifts = blockOf(vehicleModelOf(TWO, 'v1#1'), 'facts').facts.find((f) => f.id === 'fleet');
  assert.match(forklifts.text, /^Fleet: Borderline: without it the other 2 would be busy about \d+ % of the time \(the insights aim for 75 %\)\./, 'a fleet that is hardly ever away from work gets the short form');
  const last = blockOf(vehicleModelOf(TWO, 'v2#1', { window: 'last30' }), 'facts').facts;
  assert.match(last.find((f) => f.id === 'fleet').text, /^Fleet, since start: /);
  assert.ok(!last.some((f) => f.id === 'held' && /at the (junction|road|dock)/.test(f.text)), 'under Last 30 min only the queue form exists');
  // below 20 minutes every fact is indicative; below 10 minutes there is no sentence about a share
  const early = blockOf(vehicleModelOf(EARLY, 'v2#1'), 'facts').facts;
  assert.ok(!early.some((f) => f.id === 'held' || f.id === 'depot' || f.id === 'empty' || f.id === 'none'), 'no sentence about a share from 90 s');
  assert.ok(!early.some((f) => f.id === 'fleet'), 'no fleet verdict from 90 s');
  const shrunk = tweak(TWO, (c) => {
    c.windows.start.seconds = 900;
    c.report.window.duration = 900;
    for (const v of c.queries.start.vehicles) { const t = v.timeSplit; const k = 900 / t.seconds; for (const key of Object.keys(t)) t[key] *= k; }
  });
  const between = blockOf(vehicleModelOf(shrunk, 'v2#1'), 'facts').facts;
  assert.ok(between.length > 0 && between.every((f) => f.indicative === (f.id !== 'fleet')), 'between 10 and 20 minutes the sentences are marked indicative'); assert.ok(!between.some((f) => f.id === 'fleet'), 'and the fleet verdict waits for 20 minutes');
});

test('the live line says what the vehicle does now, in the words of the design', () => {
  const stub = (patch) => {
    const input = fixtureInput(TWO, { kind: 'vehicle', ids: ['v2#1'] });
    Object.assign(input.detail.V[3], patch);
    return buildStatsModel(input).header.live;
  };
  const press = layoutOfFixture(TWO).stations.find((s) => s.name === 'Press line');
  const hall = layoutOfFixture(TWO).stations.find((s) => s.name === 'Central warehouse');
  const live = (o) => { const { tone, strong, rest } = stub(o); return `${tone}|${strong}|${rest.split(' · ').slice(0, -1).join(' · ')}`; };
  assert.equal(live({ state: 'toDrop', load: [{}], order: { from: hall.id, to: press.id } }), 'driving|Carrying 1 load to Press line|18 m to go');
  assert.equal(live({ state: 'toDrop', load: [{}, {}], order: { from: hall.id, to: press.id } }), 'driving|Carrying 2 loads to Press line|18 m to go');
  assert.equal(live({ state: 'toDrop', load: [{}], order: { from: hall.id, to: press.id }, tv: { waiting: true } }), 'waiting|Carrying 1 load to Press line|held up now · 18 m to go', 'held up in traffic right now');
  assert.equal(live({ state: 'toPickup', order: { from: hall.id, to: press.id } }), 'driving|Driving to Central warehouse|to pick up a load · 18 m to go');
  assert.equal(live({ state: 'toPickup', order: null, targetId: press.id }), 'driving|Driving to Press line|to pick up a load · 18 m to go', 'without an order the target is the place');
  assert.equal(live({ state: 'toCharger', targetId: 's8' }), 'driving|Driving to AGV charging|to charge · 18 m to go');
  assert.equal(live({ state: 'toPark', targetId: 's2' }), 'driving|Driving to Forklift park|to park · 18 m to go');
  assert.equal(live({ state: 'loading', order: { from: hall.id, to: press.id } }), 'loading|Loading at Central warehouse|');
  assert.equal(live({ state: 'unloading', order: { from: hall.id, to: press.id } }), 'unloading|Unloading at Press line|');
  assert.equal(live({ state: 'idle' }), 'idle|No job|standing on the road');
  assert.equal(live({ state: 'parked', depot: { id: 's8' } }), 'parked|Parked|in AGV charging');
  assert.equal(live({ state: 'charging', battery: 0.5 }), 'charging|Charging|50 % charged');
  assert.equal(live({ state: 'broken' }), 'broken|Out of service|broken down, being repaired');
  assert.equal(live({ state: 'dead' }), 'broken|Stopped|battery empty, standing on the road');
  assert.equal(stub({ state: 'toDrop', load: [], order: null, targetId: null }).strong, 'Carrying 0 loads', 'no order and no target does not throw, and names no destination');
  assert.equal(stub({ state: 'toPickup', order: null, targetId: null }).strong, 'Driving to a pickup');
  assert.equal(stub({ state: 'unloading', order: null, targetId: null }).strong, 'Unloading');
  assert.equal(stub({ state: 'loading', battery: NaN }).rest.includes('NaN'), false);
});

test('the announcement of a selected vehicle is one sentence with its state and its two headline numbers', () => {
  const m = vehicleModelOf(TWO, 'v2#1');
  assert.match(m.announce, /^AGVs 1 selected: .+, busy 78 %, held up 7 %\.$/);
  assert.equal(m.ariaLabel, 'Statistics for AGVs 1');
});

test('what to bring into view is the box of the drawn routes (metres), and nothing when the routes are off', () => {
  const on = vehicleModelOf(TWO, 'v2#1', { routes: true }).bounds;
  const cs = TWO.graph.cellSize;
  assert.ok(on && on.w > 0 && on.h > 0);
  assert.equal(on.x % cs, 0, 'whole cells');
  const nodes = TWO.queries.start.vehicles[3].routes.filter((r) => r.kind === 1).slice(0, 3).flatMap((r) => r.pathIds.map((p) => TWO.paths[p.id])).flat();
  const xs = nodes.map((n) => (n % TWO.graph.cols) * cs);
  assert.ok(on.x <= Math.min(...xs) && on.x + on.w >= Math.max(...xs) + cs - 1e-9, 'the box covers the drawn paths');
  assert.equal(vehicleModelOf(TWO, 'v2#1', { routes: false }).bounds, undefined, 'routes off: the shell brings the vehicle itself into view');
});

test('the fleet peers are cached for a second and a big fleet is sampled', () => {
  let calls = 0;
  const det = createFakeDetail(TWO);
  const timeSplit = det.timeSplit;
  det.timeSplit = (...a) => { calls++; return timeSplit(...a); };
  const input = fixtureInput(TWO, { kind: 'vehicle', ids: ['v2#1'] });
  input.detail = det;
  const run = (now) => buildStatsModel({ ...input, now });
  run(5_000_000);
  const first = calls;
  run(5_000_100);
  assert.equal(calls - first, 1, 'the second call within a second asks only for the selected vehicle again');
  run(5_001_200);
  assert.equal(calls - first, 1 + 1 + 7 + 1 - 1 + 0, 'after a second the seven mates are asked again, plus the vehicle itself');
  // a fleet of 400: at most 120 mates are asked
  const big = tweak(TWO, (c) => {
    const proto = c.vehicles[3];
    c.vehicles = Array.from({ length: 400 }, (_, k) => ({ ...proto, index: k, id: `v2#${k + 1}`, name: `AGVs ${k + 1}` }));
    for (const win of ['start', 'last30']) c.queries[win].vehicles = c.vehicles.map((v, k) => ({ ...structuredClone(TWO.queries[win].vehicles[3]), index: k }));
    c.series.working = c.vehicles.map(() => TWO.series.working[3]);
    c.live.vehicles = c.vehicles.map(() => TWO.live.vehicles[3]);
    c.detail.nV = 400;
  });
  let bigCalls = 0;
  const bdet = createFakeDetail(big);
  const bts = bdet.timeSplit;
  bdet.timeSplit = (...a) => { bigCalls++; return bts(...a); };
  const bi = fixtureInput(big, { kind: 'vehicle', ids: ['v2#7'] });
  bi.detail = bdet;
  const m = buildStatsModel({ ...bi, now: 9_000_000 });
  assert.ok(bigCalls <= 1 + 120, `a fleet of 400 asks ${bigCalls} times, not 400`);
  assert.match(tileOf(m, 'busy').ref.text, /^fleet about \d+ %$/, 'and says "about"');
});

// ---------------------------------------------------------------------------------------------------------
// 3. the other kinds: six numbers from the report
// ---------------------------------------------------------------------------------------------------------

const withoutCollector = { detail: false };

function stripOf(fx, kind, ids, opts = {}) {
  return buildStatsModel(fixtureInput(fx, { kind, ids }, opts));
}

test('S1.13: every station of the fixtures shows six numbers that equal the Results tab, with the collector and without it', () => {
  for (const fx of [TWO, WARE, DOCK44]) {
    const hours = fx.report.window.duration / 3600;
    for (const st of fx.stations) {
      for (const opts of [{}, withoutCollector]) {
        const m = stripOf(fx, 'station', [st.id], opts);
        const rep = fx.report.stations[st.id];
        assert.equal(m.status, 'ready');
        assert.equal(m.tiles.length, 6, `${st.name}: six tiles`);
        assert.deepEqual(modelProblems(m), [], `${fx.about.slice(0, 20)} ${st.name}`);
        assert.equal(m.windows.last30, false, 'the figures are since start');
        assert.match(m.windows.note, /since start/);
        if (st.type === 'process') {
          near(tileOf(m, 'output').raw, rep.produced / hours, 1e-12, 'output');
          near(tileOf(m, 'busy').raw, rep.utilization, 1e-12);
          near(tileOf(m, 'starved').raw, rep.starved, 1e-12);
          near(tileOf(m, 'blocked').raw, rep.blocked, 1e-12);
          near(tileOf(m, 'queue').raw, rep.avgIn, 1e-12);
        } else if (st.type === 'source') {
          near(tileOf(m, 'arrivals').raw, rep.produced / hours, 1e-12);
          near(tileOf(m, 'buffer').raw, rep.avgOut, 1e-12);
          near(tileOf(m, 'full').raw, rep.blocked, 1e-12);
        } else if (st.type === 'storage') {
          near(tileOf(m, 'in').raw, rep.arrivals / hours, 1e-12);
          near(tileOf(m, 'out').raw, rep.produced / hours, 1e-12);
          near(tileOf(m, 'full').raw, rep.blocked, 1e-12);
        } else if (st.type === 'sink') {
          const by = fx.report.throughput.bySink[st.id];
          near(tileOf(m, 'shipped').raw, by.perHour, 1e-12);
          if (fx.report.throughput.total > 0) near(tileOf(m, 'share').raw, by.count / fx.report.throughput.total, 1e-12);
        } else {
          near(tileOf(m, 'slots').raw, rep.avgFill, 1e-12);
        }
      }
    }
  }
});

test('S1.13: the stock of a storage is its average fill times the capacity of the RUNTIME station; without that capacity the stock shows a dash', () => {
  const rep = TWO.report.stations.s4;
  const input = fixtureInput(TWO, { kind: 'station', ids: ['s4'] });
  const m = buildStatsModel(input);
  const cap = input.sim.logistics.stationById.get('s4').capacity;
  assert.equal(cap, 80);
  near(tileOf(m, 'stock').raw, rep.avgFill * cap, 1e-12);
  assert.equal(tileOf(m, 'stock').ref.text, `most ${Math.round(rep.maxFill * cap)} of ${cap}`);
  near(tileOf(m, 'stay').raw, (rep.avgFill * cap) / (rep.produced / TWO.report.window.duration), 1e-9, "Little's law");
  const blind = buildStatsModel({ ...input, sim: { ...input.sim, logistics: { unplaced: [] } } });
  assert.equal(tileOf(blind, 'stock').value, '–');
  assert.equal(tileOf(blind, 'stock').ref.text, `most ${M.pct(rep.maxFill)} full`);
  assert.equal(tileOf(blind, 'stay').value, '–');
  assert.deepEqual(modelProblems(blind), []);
});

test('S1.13: the wait for a vehicle of a station is the trip-weighted mean of its outgoing flows (the Results number), with the loads waiting now', () => {
  const layout = layoutOfFixture(TWO);
  for (const st of TWO.stations.filter((s) => ['process', 'storage', 'source'].includes(s.type))) {
    const flows = layout.flows.filter((f) => f.from === st.id).map((f) => TWO.report.flows[f.id]);
    const trips = flows.reduce((a, f) => a + (f.avgPickupWait !== null ? f.trips : 0), 0);
    const mean = trips > 0 ? flows.reduce((a, f) => a + (f.avgPickupWait !== null ? f.avgPickupWait * f.trips : 0), 0) / trips : null;
    const m = stripOf(TWO, 'station', [st.id]);
    const wait = tileOf(m, 'wait');
    if (mean === null) assert.equal(wait.raw, null); else near(wait.raw, mean, 1e-12, st.name);
    assert.equal(wait.ref.text, mean === null ? 'no load picked up yet' : `waiting now: ${flows.reduce((a, f) => a + f.backlog, 0)}`);
  }
});

test('S1.13: Goods in with dock doors shows the doors and the gate; without doors the yard and the loads waiting', () => {
  const goodsIn = stripOf(WARE, 'station', ['s1']);
  assert.deepEqual(goodsIn.tiles.map((t) => t.id), ['arrivals', 'buffer', 'wait', 'full', 'doors', 'gate']);
  const tr = WARE.report.ops.trucks.s1;
  near(tileOf(goodsIn, 'doors').raw, tr.doorUtilization, 1e-12);
  assert.equal(tileOf(goodsIn, 'doors').unit, ' of 3 doors');
  assert.equal(tileOf(goodsIn, 'gate').value, 'none', 'no truck waited a second at the gate (the longest was 0.06 s): a door was always free');
  assert.equal(tileOf(goodsIn, 'gate').ref.text, 'a door was always free');
  // the gate is a dash while no truck has taken a door, and "none" is not said from the MEAN when one truck waited (STAT-REV-3)
  const gateOf = (gw) => tileOf(stripOf(tweak(WARE, (c) => { c.report.ops.trucks.s1.gateWait = gw; }), 'station', ['s1']), 'gate');
  assert.deepEqual([gateOf({ mean: null, p90: null, max: null }).value, gateOf({ mean: null, p90: null, max: null }).ref.text], ['–', 'no truck has taken a door yet']);
  const longest = gateOf({ mean: 29, p90: 13, max: 306 });
  assert.equal(longest.value, '0:29 min'); assert.equal(longest.ref.text, 'longest 5:06 min · 90 % under 0:13 min', 'a truck waited 5 minutes: not "none"');
  assert.equal(gateOf({ mean: 0.4, p90: 0.9, max: 0.99 }).value, 'none'); assert.notEqual(gateOf({ mean: 0.4, p90: 0.9, max: 1.0 }).value, 'none');
  assert.equal(gateOf({ mean: 1000, p90: 1200, max: 1500 }).tone, 'warn', 'a quarter of an hour at the gate is coloured');
  assert.equal(tileOf(goodsIn, 'arrivals').ref.text, '9 trucks in 2 h 50 min');
  const plain = stripOf(TWO, 'station', ['s1']);
  assert.deepEqual(plain.tiles.map((t) => t.id), ['arrivals', 'buffer', 'wait', 'full', 'yard', 'waiting']);
  assert.equal(tileOf(plain, 'yard').raw, TWO.report.stations.s1.yardNow);
  const goodsOut = stripOf(WARE, 'station', ['s3']);
  assert.deepEqual(goodsOut.tiles.map((t) => t.id), ['shipped', 'share', 'lead', 'lead90', 'doors', 'fill']);
  near(tileOf(goodsOut, 'fill').raw, WARE.report.ops.trucks.s3.fillRate, 1e-12);
});

test('S1.13: the lead time of a Goods out is its own when the collector has it, the plant\'s otherwise, and says which', () => {
  const own = stripOf(WARE, 'station', ['s3']);
  const hist = WARE.hist.sinkLead['2'];
  near(tileOf(own, 'lead').raw, hist.sum / hist.n, 1e-9);
  near(tileOf(own, 'lead90').raw, hist.p90, 1e-9);
  assert.equal(tileOf(own, 'lead').ref.text, 'this Goods out');
  const plant = stripOf(WARE, 'station', ['s3'], withoutCollector);
  near(tileOf(plant, 'lead').raw, WARE.report.leadTime.mean, 1e-9);
  assert.equal(tileOf(plant, 'lead').ref.text, 'whole plant', 'the honest label');
});

test('S1.13: the docks of a station are a table of its own: visits per hour, in service, queue per visit', () => {
  const m = stripOf(WARE, 'station', ['s1']);
  const docks = blockOf(m, 'docks');
  const rep = WARE.report.stations.s1;
  assert.equal(docks.rows.length, 4);
  docks.rows.forEach((r, k) => {
    assert.equal(r.name, `Dock ${k + 1}`);
    assert.equal(r.cell, `(${rep.docks[k].cx}, ${rep.docks[k].cy})`);
    near(r.visitsPerHour, rep.docks[k].visits / (WARE.report.window.duration / 3600), 1e-12);
    assert.ok(r.inService >= 0 && r.inService <= 1 && r.barShare >= 0 && r.barShare <= 1);
  });
  assert.equal(stripOf(WARE, 'station', ['s3']).blocks.filter((b) => b.type === 'docks').length, 1);
  assert.equal(blockOf(stripOf(TWO, 'station', ['s5']), 'docks').skew, '', 'no skew: nothing said');
});

test('S1.13: the findings of the Results tab that name the item come first, worded the same way (the dock and the Results tab cannot disagree)', () => {
  const m = stripOf(TWO, 'station', ['s5']);
  const facts = blockOf(m, 'facts').facts;
  const mine = TWO.insights.filter((i) => i.refs.stationIds && i.refs.stationIds.includes('s5'));
  assert.ok(mine.length >= 1);
  assert.deepEqual(facts.map((f) => f.text), mine.map((i) => i.title));
  assert.deepEqual(facts.map((f) => f.hint), mine.map((i) => i.suggestion));
  assert.deepEqual(facts.map((f) => f.tone), mine.map((i) => ({ warning: 'warn', info: 'info', critical: 'bad', good: 'good' }[i.severity])));
  assert.ok(facts[0].rect && facts[0].rect.w > 0, 'a place to show');
  assert.equal(stripOf(TWO, 'station', ['s3']).blocks[0].facts.length, 0, 'a station the Results tab says nothing about');
  assert.ok(blockOf(stripOf(TWO, 'station', ['s3']), 'facts').empty.length > 0);
  // a fleet's finding is shown on the fleet
  const manyFindings = tweak(TWO, (c) => { c.insights = Array.from({ length: 7 }, (_, k) => ({ id: `x${k}`, severity: 'info', title: `finding ${k}`, detail: '', suggestion: '', refs: { stationIds: ['s5'] } })); });
  assert.equal(blockOf(stripOf(manyFindings, 'station', ['s5']), 'facts').facts.length, 4, 'at most four');
});

test('S1.13: a flow shows delivered per hour, the wait for a vehicle with the loads waiting now, the backlog, the transit, the load per trip and the trips', () => {
  for (const fx of [TWO, WARE]) {
    const hours = fx.report.window.duration / 3600;
    for (const f of fx.flows) {
      const m = stripOf(fx, 'flow', [f.id]);
      const rep = fx.report.flows[f.id];
      assert.deepEqual(m.tiles.map((t) => t.id), ['delivered', 'wait', 'backlog', 'transit', 'load', 'trips']);
      near(tileOf(m, 'delivered').raw, rep.delivered / hours, 1e-12);
      if (rep.avgPickupWait === null) assert.equal(tileOf(m, 'wait').raw, null); else near(tileOf(m, 'wait').raw, rep.avgPickupWait, 1e-12);
      assert.equal(tileOf(m, 'wait').ref.text, rep.avgPickupWait === null ? 'no load picked up yet' : `waiting now: ${rep.backlog}`);
      assert.equal(tileOf(m, 'backlog').raw, rep.backlog);
      if (rep.avgTransit !== null) near(tileOf(m, 'transit').raw, rep.avgTransit, 1e-12);
      if (rep.trips > 0) near(tileOf(m, 'load').raw, rep.delivered / rep.trips, 1e-12);
      near(tileOf(m, 'trips').raw, rep.trips / hours, 1e-12);
      assert.equal(m.ariaLabel, `Statistics for ${fx.stations.find((s) => s.id === f.from).name} → ${fx.stations.find((s) => s.id === f.to).name}`);
      assert.deepEqual(modelProblems(m), []);
    }
  }
});

test('S1.13: a fleet shows busy, trips per vehicle, held up, empty share, load wait and the fleet question', () => {
  for (const fx of [TWO, WARE]) {
    const hours = fx.report.window.duration / 3600;
    for (const id of Object.keys(fx.report.fleets)) {
      const m = stripOf(fx, 'fleet', [id]);
      const rep = fx.report.fleets[id];
      assert.deepEqual(m.tiles.map((t) => t.id), ['busy', 'trips', 'held', 'empty', 'wait', 'question']);
      near(tileOf(m, 'busy').raw, rep.utilization, 1e-12);
      near(tileOf(m, 'trips').raw, rep.tripsPerVehicleHour, 1e-12);
      near(tileOf(m, 'held').raw, rep.shares.waiting, 1e-12);
      near(tileOf(m, 'empty').raw, rep.emptyShare, 1e-12);
      near(tileOf(m, 'wait').raw, rep.avgPickupWait, 1e-12);
      const per = Object.values(rep.vehicleTrips).map((x) => x / hours);
      assert.equal(tileOf(m, 'trips').ref.text, `range ${M.num(Math.min(...per), 1)} to ${M.num(Math.max(...per), 1)}`);
      const q = M.fleetQuestion(fx.report, rep, fx.report.window.duration);
      assert.equal(tileOf(m, 'question').value, { needed: 'Needed', borderline: 'Borderline', spare: 'Spare', queueing: 'Queueing', unavailable: 'Out of service', limit: 'At the limit', indicative: 'Too early' }[q.verdict]);
      assert.deepEqual(modelProblems(m), []);
    }
  }
  const early = stripOf(EARLY, 'fleet', ['v2']);
  assert.equal(tileOf(early, 'question').value, 'Too early', 'under 20 minutes: "indicative", no verdict');
  assert.equal(tileOf(early, 'question').ref.text, 'needs 20 min measured');
  assert.equal(M.fleetQuestion(EARLY.report, EARLY.report.fleets.v2, EARLY.report.window.duration).verdict, 'indicative');
});

test('S1.13: the strips work without the collector and without the simulation; before the first measured second they show a dash and "Press play"', () => {
  for (const sel of [{ kind: 'station', ids: ['s5'] }, { kind: 'flow', ids: ['f2'] }, { kind: 'fleet', ids: ['v2'] }, { kind: 'vehicle', ids: ['v2#1'] }, { kind: 'cell', ids: ['13,22'] }, { kind: 'station', ids: ['s5', 's6'] }]) {
    const noCollector = buildStatsModel(fixtureInput(TWO, sel, withoutCollector));
    assert.ok(noCollector, JSON.stringify(sel));
    assert.deepEqual(modelProblems(noCollector), [], `${JSON.stringify(sel)} without the collector`);
    for (const state of [{ sim: null, report: null, insights: [], detail: false }, { report: tweak(TWO, (c) => { c.report.window = { start: 600, end: 600, duration: 0, warmingUp: false }; }).report }, { report: tweak(TWO, (c) => { c.report.window.warmingUp = true; }).report }]) {
      const m = buildStatsModel({ ...fixtureInput(TWO, sel, withoutCollector), ...state, sim: state.sim === undefined ? null : state.sim });
      assert.equal(m.status, 'waiting', `${JSON.stringify(sel)}: before data`);
      assert.match(m.statusText, /^Press play to see statistics for /);
      assert.equal(m.tiles.length, 6);
      assert.ok(m.tiles.every((t) => t.value === '–' && t.raw === null && t.def.length > 20), 'six dashes, each with its counting rule');
      assert.deepEqual(modelProblems(m), []);
      assert.deepEqual(m.blocks.map((b) => b.type), ['status']);
    }
  }
  const vehicle = buildStatsModel(fixtureInput(TWO, { kind: 'vehicle', ids: ['v2#1'] }, withoutCollector));
  assert.equal(vehicle.variant, 'vehicle-report', 'a vehicle without the collector: the report-only variant');
  assert.equal(vehicle.windows.last30, false, 'without the collector there is no 30-minute figure');
  near(tileOf(vehicle, 'trips').raw, TWO.report.fleets.v2.vehicleTrips['v2#1'] / (TWO.report.window.duration / 3600), 1e-12, 'its own trips, the Results number');
  assert.match(blockOf(vehicle, 'facts').facts[0].text, /Collect statistics for clicked items/);
});

test('S1.10: only vehicles have a 30-minute version; every other kind says so and keeps its since-start values', () => {
  for (const sel of [{ kind: 'station', ids: ['s5'] }, { kind: 'flow', ids: ['f2'] }, { kind: 'fleet', ids: ['v2'] }, { kind: 'cell', ids: ['13,22'] }]) {
    const start = buildStatsModel(fixtureInput(TWO, sel, { window: 'start' }));
    const last = buildStatsModel(fixtureInput(TWO, sel, { window: 'last30' }));
    assert.equal(start.windows.last30, false, JSON.stringify(sel));
    assert.ok(start.windows.note.length > 20, 'with the reason');
    assert.deepEqual(last.tiles.map((t) => [t.id, t.value]), start.tiles.map((t) => [t.id, t.value]), 'asked for Last 30 min the numbers stay the since-start ones');
    assert.equal(last.window.kind, 'start', 'and the window says so');
  }
  assert.equal(vehicleModelOf(TWO, 'v2#1').windows.last30, true);
});

test('S1.13: a road cell shows passes, waiting, share, delay, rank and what it is, from the heat of the simulation (cached for a second)', () => {
  const layout = layoutOfFixture(TWO);
  const cols = layout.grid.cols;
  const press = TWO.report.stations.s5.docks[0];
  const node = press.cy * cols + press.cx;
  const edges = [{ to: node }, { to: node }];
  const nodeWait = new Float64Array(cols * layout.grid.rows);
  nodeWait[node] = 600;
  nodeWait[node + 1] = 300;
  nodeWait[node + 2] = 100;
  const edgePasses = new Int32Array(10);
  edgePasses[3] = 40; edgePasses[4] = 60;
  let heatCalls = 0;
  // the end of a bay (a dead end: one exit, and a link back), a T junction (three exits), a merge of two one-way roads and a plain one-way road: as the engine classifies them
  const N = cols * layout.grid.rows;
  const controlled = new Uint8Array(N); const deadEnd = new Uint8Array(N);
  controlled[node] = 1; deadEnd[node] = 1; controlled[node + 1] = 1; controlled[node + 2] = 1;
  const graph = {
    cols, rows: layout.grid.rows, cellSize: layout.grid.cellSize, in: { [node]: [3, 4] }, controlled, deadEnd,
    out: { [node]: [0], [node + 1]: [0, 1, 4], [node + 2]: [2], [node + 3]: [2] },
    edges: [{ rev: 1 }, { rev: 0 }, { rev: -1 }, { rev: 5 }, { rev: 3 }, { rev: 4 }],
  };
  const sim = { time: 8000, heat: () => { heatCalls++; return { edgePasses, nodeWait }; }, graph, vehicles: [] };
  const key = `${press.cx},${press.cy}`;
  const input = { ...fixtureInput(TWO, { kind: 'cell', ids: [key] }, { sim }), now: 7_000_000 };
  input.layout.roads[key] = input.layout.roads[key] || { out: 15 };
  const m = buildStatsModel(input);
  const hours = TWO.report.window.duration / 3600;
  near(tileOf(m, 'passes').raw, 100 / hours, 1e-12);
  near(tileOf(m, 'wait').raw, 600 / hours / 60, 1e-12);
  near(tileOf(m, 'share').raw, 600 / 1000, 1e-12);
  near(tileOf(m, 'delay').raw, 6, 1e-12);
  assert.equal(tileOf(m, 'rank').value, '1');
  assert.equal(tileOf(m, 'rank').ref.text, 'of 3 cells with waiting');
  assert.equal(tileOf(m, 'what').value, 'Dock');
  assert.equal(tileOf(m, 'what').ref.text, 'of Press line, dead end, one vehicle at a time, two-way', 'a dock is the end of a two-way bay, not a one-way road (STAT-REV-5)');
  const whatOf = (x, y = press.cy) => { const k = `${x},${y}`; input.layout.roads[k] = { out: 15 }; const t = tileOf(buildStatsModel({ ...input, selection: { kind: 'cell', ids: [k] } }), 'what'); return `${t.value}: ${t.ref.text}`; };
  assert.equal(whatOf(press.cx + 1), 'Junction: one vehicle at a time, two-way');
  assert.equal(whatOf(press.cx + 2), 'Junction: one vehicle at a time, one-way', 'a merge of one-way roads holds one vehicle at a time too');
  assert.equal(whatOf(press.cx + 3), 'Road: one-way');
  assert.equal(whatOf(0, 0), 'Road: two-way', 'no exit known: the plain default');
  assert.equal(m.windows.last30, false);
  assert.equal(m.windows.note, 'Road figures are since start only.');
  buildStatsModel({ ...input, now: 7_000_300 });
  assert.equal(heatCalls, 1, 'heat() allocates the size of the road graph: once a second is enough');
  buildStatsModel({ ...input, now: 7_001_500 });
  assert.equal(heatCalls, 2);
  assert.equal(buildStatsModel({ ...input, layout: { ...input.layout, roads: {} } }).status, 'gone', 'a cell that is not a road any more');
  assert.equal(buildStatsModel({ ...input, sim: null }).status, 'waiting');
});

test('S1.13: several items selected show a strip of totals, averages and the worst item, never a meaningless sum', () => {
  const several = (kind, ids, opts) => buildStatsModel(fixtureInput(TWO, { kind, ids }, opts));
  const hours = TWO.report.window.duration / 3600;
  const st = several('station', ['s5', 's6', 's7']);
  assert.equal(tileOf(st, 'count').value, '3');
  assert.equal(tileOf(st, 'count').ref.text, '3 workstations');
  const busiest = ['s5', 's6', 's7'].map((id) => [id, TWO.report.stations[id].utilization]).sort((a, b) => b[1] - a[1])[0];
  near(tileOf(st, 'busiest').raw, busiest[1], 1e-12);
  assert.equal(tileOf(st, 'busiest').ref.text, TWO.report.stations[busiest[0]].name);
  near(tileOf(st, 'output').raw, ['s5', 's6', 's7'].reduce((a, id) => a + TWO.report.stations[id].produced, 0) / hours, 1e-12, 'output adds up over workstations');
  const mixed = several('station', ['s1', 's4', 's3']);
  assert.equal(tileOf(mixed, 'count').ref.text, '1 Goods in, 1 storage, 1 Goods out');
  assert.equal(tileOf(mixed, 'busiest').value, '–', 'no workstation in the selection: no "busiest"');
  const fl = several('flow', ['f2', 'f3']);
  near(tileOf(fl, 'delivered').raw, (TWO.report.flows.f2.delivered + TWO.report.flows.f3.delivered) / hours, 1e-12);
  near(tileOf(fl, 'backlog').raw, TWO.report.flows.f2.backlog + TWO.report.flows.f3.backlog, 1e-12);
  const fleets = several('fleet', ['v1', 'v2']);
  assert.equal(tileOf(fleets, 'vehicles').raw, 10);
  near(tileOf(fleets, 'busy').raw, (3 * TWO.report.fleets.v1.utilization + 7 * TWO.report.fleets.v2.utilization) / 10, 1e-12, 'weighted by vehicles');
  const veh = several('vehicle', ['v2#1', 'v2#2', 'v2#3']);
  const own = ['v2#1', 'v2#2', 'v2#3'].map((id) => tileOf(vehicleModelOf(TWO, id), 'busy').raw);
  near(tileOf(veh, 'busy').raw, own.reduce((a, b) => a + b, 0) / 3, 1e-9, 'the mean of the vehicles');
  assert.equal(veh.windows.last30, true, 'with the collector several vehicles have a 30-minute figure');
  const vehNone = several('vehicle', ['v2#1', 'v2#2'], withoutCollector);
  assert.equal(vehNone.windows.last30, false);
  assert.equal(tileOf(vehNone, 'busy').value, '–');
  for (const m of [st, mixed, fl, fleets, veh, vehNone]) assert.deepEqual(modelProblems(m), []);
  assert.equal(st.routes, false, 'no routes switch for several');
});

test('the model answers null for walls, labels and nothing, and a "gone" model for an item that is no longer in the plant', () => {
  const layout = layoutOfFixture(TWO);
  for (const sel of [{ kind: 'obstacle', ids: ['o1'] }, { kind: 'label', ids: ['l1'] }, { kind: null, ids: [] }, { kind: 'station', ids: [] }, null, undefined, { kind: 'banana', ids: ['x'] }]) {
    assert.equal(buildStatsModel({ ...fixtureInput(TWO, { kind: 'station', ids: ['s5'] }), selection: sel }), null, JSON.stringify(sel));
  }
  assert.equal(buildStatsModel({ selection: { kind: 'station', ids: ['s5'] } }), null, 'without a layout there is nothing to name');
  for (const sel of [{ kind: 'station', ids: ['zz'] }, { kind: 'flow', ids: ['zz'] }, { kind: 'fleet', ids: ['zz'] }, { kind: 'vehicle', ids: ['zz#1'] }, { kind: 'vehicle', ids: ['v2#99'] }, { kind: 'cell', ids: ['0,0'] }]) {
    const m = buildStatsModel(fixtureInput(TWO, sel));
    assert.equal(m.status, 'gone', JSON.stringify(sel));
    assert.equal(m.tiles.length, 6);
    assert.deepEqual(modelProblems(m), [], JSON.stringify(sel));
  }
  assert.ok(layout.stations.length > 0);
});

// ---------------------------------------------------------------------------------------------------------
// 5. empty windows, no vehicles, a vehicle that never moved, a dead one
// ---------------------------------------------------------------------------------------------------------

test('S1.9: no NaN, no Infinity for a vehicle that never moved, a dead vehicle, an empty window and a vehicle without trips', () => {
  const never = tweak(TWO, (c) => {
    const i = indexOfVehicle(c, 'v2#1');
    for (const win of ['start', 'last30']) {
      const q = c.queries[win].vehicles[i];
      Object.assign(q.timeSplit, { driving: 0, waiting: 0, dockQueue: 0, loading: 0, unloading: 0, idle: 0, parked: q.timeSplit.seconds, charging: 0, broken: 0, drivingLoaded: 0, drivingEmpty: 0, drivingDepot: 0 });
      Object.assign(q.counts, { trips: 0, loaded: 0, empty: 0, park: 0, qty: 0 });
      Object.assign(q, { routes: [], round: null, queues: [], batteryOf: { now: 1, min: 1, stops: [] } });
    }
    c.queries.start.vehicles[i].hotspots = { cells: [], total: 0, folded: 0 };
    c.series.working[i] = [];
  });
  for (const win of ['start', 'last30']) {
    const m = vehicleModelOf(never, 'v2#1', { window: win });
    assert.equal(m.status, 'ready');
    assert.deepEqual(modelProblems(m), [], win);
    assert.equal(tileOf(m, 'trips').value, '0.0');
    assert.equal(tileOf(m, 'busy').value, '0 %');
    assert.equal(tileOf(m, 'held').value, '0 %');
    assert.equal(tileOf(m, 'driven').value, '0.0');
    assert.equal(tileOf(m, 'driven').ref.text, 'no distance driven yet');
    assert.equal(tileOf(m, 'loaded').value, '–');
    assert.equal(tileOf(m, 'loaded').ref.text, 'no complete loaded trip yet');
    assert.equal(blockOf(m, 'time').held, null, 'nothing held up: no rows');
    assert.equal(blockOf(m, 'time').spark, null, 'no series: no sparkline');
    assert.equal(blockOf(m, 'trips').rows.length, 0);
    assert.equal(blockOf(m, 'trips').empty.startsWith('No loaded trip in '), true);
    assert.equal(blockOf(m, 'trips').round, null);
    assert.equal(blockOf(m, 'trips').aside, '');
    assert.equal(blockOf(m, 'trips').other.text, '0 empty · 0 to depot or charger');
  }
  assert.ok(blockOf(vehicleModelOf(never, 'v2#1'), 'facts').facts.some((f) => f.id === 'none'), 'and says so in a sentence');
  const dead = fixtureInput(TWO, { kind: 'vehicle', ids: ['v2#1'] });
  Object.assign(dead.sim.vehicles[3], { state: 'dead', battery: 0 });
  assert.deepEqual(modelProblems(buildStatsModel(dead)), []);
  // a window of zero length is "nothing measured", not a division by zero
  const zero = tweak(TWO, (c) => { c.windows.start.seconds = 0; c.windows.last30.seconds = 0; });
  const m = vehicleModelOf(zero, 'v2#1');
  assert.equal(m.status, 'waiting');
  assert.deepEqual(modelProblems(m), []);
});

test('S1.9: an empty plant, a plant without vehicles and a fleet of none show something sensible and no NaN', () => {
  const noFleets = tweak(TWO, (c) => { c.report.fleets = {}; c.vehicles = []; c.live.vehicles = []; c.detail.nV = 0; });
  const layout = layoutOfFixture(TWO);
  layout.fleets = [];
  for (const sel of [{ kind: 'station', ids: ['s5'] }, { kind: 'flow', ids: ['f2'] }, { kind: 'vehicle', ids: ['v2#1'] }, { kind: 'fleet', ids: ['v2'] }]) {
    const m = buildStatsModel({ ...fixtureInput(noFleets, sel, { layout }), detail: null });
    assert.ok(m, JSON.stringify(sel));
    assert.deepEqual(modelProblems(m), [], JSON.stringify(sel));
  }
  const none = layoutOfFixture(TWO);
  none.fleets.find((f) => f.id === 'v2').count = 0;
  const rep = structuredClone(TWO.report);
  Object.assign(rep.fleets.v2, { count: 0, utilization: 0, vehicleTrips: {}, tripsPerVehicleHour: 0, distance: 0, distancePerVehicle: 0, emptyShare: null, avgPickupWait: null, avgTransit: null, trips: 0, shares: { driving: 0, waiting: 0, loading: 0, unloading: 0, idle: 1, parked: 0, charging: 0, broken: 0 } });
  const fleet = buildStatsModel({ ...fixtureInput(TWO, { kind: 'fleet', ids: ['v2'] }, { layout: none }), report: rep });
  assert.deepEqual(modelProblems(fleet), []);
  assert.equal(tileOf(fleet, 'question').value, 'None');
  assert.equal(tileOf(fleet, 'question').ref.text, 'no vehicle in this fleet');
  assert.equal(tileOf(fleet, 'empty').value, '–');
  assert.equal(tileOf(fleet, 'wait').value, '–');
  // an empty report: no stations, no flows, nothing delivered
  const emptyReport = { window: { start: 0, end: 100, duration: 100, warmingUp: false }, throughput: { total: 0, perHour: 0, bySink: {} }, leadTime: { count: 0, mean: null, min: null, p50: null, p90: null, p95: null, max: null }, wip: { mean: 0, max: 0, now: 0 }, stations: {}, fleets: {}, flows: {}, traffic: { waitShare: 0, hotspots: [] }, orders: {}, series: {} };
  for (const sel of [{ kind: 'station', ids: ['s5'] }, { kind: 'flow', ids: ['f2'] }, { kind: 'fleet', ids: ['v2'] }, { kind: 'station', ids: ['s5', 's6'] }, { kind: 'flow', ids: ['f2', 'f3'] }, { kind: 'fleet', ids: ['v1', 'v2'] }]) {
    const m = buildStatsModel({ ...fixtureInput(TWO, sel, withoutCollector), report: emptyReport });
    assert.ok(m && m.tiles.length === 6, JSON.stringify(sel));
    assert.deepEqual(modelProblems(m), [], JSON.stringify(sel));
  }
});

test('S1.9: zero deliveries, zero distance and a report of zeros never divide by zero', () => {
  const zeros = tweak(TWO, (c) => {
    c.report.window.duration = 1e-9;
    for (const s of Object.values(c.report.stations)) Object.assign(s, { produced: 0, consumed: 0, arrivals: 0, avgIn: 0, avgOut: 0, avgFill: 0, utilization: 0, starved: 0, blocked: 0, docks: s.docks.map((d) => ({ ...d, visits: 0, busyShare: 0, waitBefore: 0 })), dockWaitTotal: 0 });
    for (const f of Object.values(c.report.flows)) Object.assign(f, { delivered: 0, trips: 0, avgPickupWait: null, avgTransit: null, backlog: 0, avgBacklog: 0 });
    for (const f of Object.values(c.report.fleets)) Object.assign(f, { trips: 0, tripsPerVehicleHour: 0, distance: 0, distancePerVehicle: 0, emptyShare: null, avgPickupWait: null, avgTransit: null, vehicleTrips: Object.fromEntries(Object.keys(f.vehicleTrips).map((k) => [k, 0])) });
  });
  for (const sel of everySelection(layoutOfFixture(TWO), { cells: 0 })) {
    const m = buildStatsModel(fixtureInput(zeros, sel, withoutCollector));
    assert.ok(m, JSON.stringify(sel));
    assert.deepEqual(modelProblems(m), [], JSON.stringify(sel));
  }
});

test('signatures: the same item gives the same signature as time passes, another item or another layout of tiles gives another one', () => {
  const sig = (fx, sel, opts) => buildStatsModel(fixtureInput(fx, sel, opts)).signature;
  assert.equal(sig(TWO, { kind: 'vehicle', ids: ['v2#1'] }), sig(TWO, { kind: 'vehicle', ids: ['v2#1'] }, { window: 'last30' }), 'the window does not rebuild the view');
  assert.notEqual(sig(TWO, { kind: 'vehicle', ids: ['v2#1'] }), sig(TWO, { kind: 'vehicle', ids: ['v2#2'] }));
  assert.notEqual(sig(TWO, { kind: 'vehicle', ids: ['v2#1'] }), sig(TWO, { kind: 'vehicle', ids: ['v1#1'] }), 'a battery fleet has another sixth tile');
  assert.notEqual(sig(TWO, { kind: 'vehicle', ids: ['v2#1'] }), sig(TWO, { kind: 'vehicle', ids: ['v2#1'] }, withoutCollector), 'the report-only variant is another layout');
  assert.notEqual(sig(TWO, { kind: 'station', ids: ['s5'] }), sig(TWO, { kind: 'station', ids: ['s4'] }), 'process and storage');
  assert.equal(sig(TWO, { kind: 'station', ids: ['s5'] }), buildStatsModel(fixtureInput(TWO, { kind: 'station', ids: ['s5'] })).signature);
  const waiting = buildStatsModel({ ...fixtureInput(TWO, { kind: 'station', ids: ['s5'] }), sim: null, report: null });
  assert.notEqual(waiting.signature, sig(TWO, { kind: 'station', ids: ['s5'] }), 'data arriving rebuilds the view once');
});

test('the words are fixed: no "Working" tile, no "Waiting for a job", "Held up" for being held up', () => {
  for (const fx of [TWO, WARE]) {
    for (const sel of everySelection(layoutOfFixture(fx))) {
      for (const win of ['start', 'last30']) {
        const m = buildStatsModel(fixtureInput(fx, sel, { window: win }));
        for (const t of m.tiles) assert.ok(!/^Working$/i.test(t.label), `${sel.kind} ${t.id}`);
        const text = JSON.stringify(m);
        assert.ok(!/Waiting for a job/i.test(text), 'No job, not "waiting for a job"');
      }
    }
  }
  const m = vehicleModelOf(TWO, 'v2#1');
  assert.ok(m.tiles.some((t) => t.label === 'Busy, incl. waiting') && m.tiles.some((t) => t.label === 'Held up'));
  assert.ok(blockOf(m, 'time').split.items.some((p) => p.label === 'No job'));
});



// ---------------------------------------------------------------------------------------------------------
// 6. the truth review of the model (tests/stats.truth.review.test.js, tests/stats.engine.review.test.js): the rules behind the fixes, on fixtures
// ---------------------------------------------------------------------------------------------------------

test('wholePercents: the parts of one whole add up to exactly 100 (largest remainder), each within a point of its exact value, and a part above zero never prints as 0', () => {
  assert.deepEqual(M.wholePercents([1 / 3, 1 / 3, 1 / 3], { total: 1 }), [34, 33, 33], 'the first of equal remainders gets the extra point');
  assert.deepEqual(M.wholePercents([0.5, 0.5], { total: 1 }), [50, 50]);
  assert.deepEqual(M.wholePercents([0.236, 0.184, 0.58], { total: 1 }), [24, 18, 58], 'rounded one by one these are 24 + 18 + 58 = 100; the point goes where the remainder is largest');
  assert.deepEqual(M.wholePercents([0.004, 0.996], { total: 1, min: 1 }), [1, 99], 'a part that is printed at all is at least 1');
  assert.deepEqual(M.wholePercents([], { total: 1 }), []); assert.deepEqual(M.wholePercents([0, 0], { total: 1 }), [0, 0]);
  assert.deepEqual(M.wholePercents([NaN, -1, 0.25]), [0, 0, 25], 'junk counts as 0'); assert.ok(M.wholePercents([Infinity, 0.5]).every(Number.isFinite));
  let seed = 7; const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  for (let round = 0; round < 500; round++) {
    const n = 1 + Math.floor(rnd() * 11);
    const raw = Array.from({ length: n }, () => (rnd() < 0.3 ? 0 : rnd() ** 2));
    const sum = raw.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) continue;
    const shares = raw.map((x) => x / sum);
    const out = M.wholePercents(shares, { total: 1 });
    assert.equal(out.reduce((a, b) => a + b, 0), 100, JSON.stringify(shares));
    out.forEach((p, k) => assert.ok(Math.abs(p - shares[k] * 100) < 1 + 1e-9 && p >= 0, `${p} for ${shares[k] * 100}`));
    const withMin = M.wholePercents(shares.filter((x) => x > 0), { total: 1, min: 1 });
    assert.ok(withMin.every((p) => p >= 1) && withMin.reduce((a, b) => a + b, 0) === 100, JSON.stringify(shares));
  }
});

test('the legend of the time split and the three shares of the metres print whole percents that add up to 100 (STAT-REV-13)', () => {
  for (const win of ['start', 'last30']) {
    for (const v of TWO.vehicles) {
      const m = vehicleModelOf(TWO, v.id, { window: win });
      const legend = blockOf(m, 'time').split.items.map((p) => Number(p.text.replace(/[^\d]/g, '')));
      assert.equal(legend.reduce((a, b) => a + b, 0), 100, `${v.id} ${win}: ${legend.join(' + ')}`);
      const d = /loaded (\d+) % · empty (\d+) % · to depot (\d+) %/.exec(tileOf(m, 'driven').ref.text);
      if (d) assert.equal(Number(d[1]) + Number(d[2]) + Number(d[3]), 100, `${v.id} ${win}`);
    }
  }
});

test('a minute is read from the clock plus a margin: 2999.999999998 s is 0:50 (STAT-REV-12), also on a day plant', () => {
  assert.equal(M.clockText(2999.999999998), '0:50'); assert.equal(M.clockText(299.99999999), '0:05'); assert.equal(M.clockText(2999), '0:49'); assert.equal(M.clockText(3599.9995), '0:59', 'a margin of a microsecond, not of a tick');
  assert.equal(M.sinceText({ settings: {} }, 2999.999999998), '0:50');
});

test('the queue rows of "where it is held up" share the dock-queue seconds of the time split, so they cannot fall short of the Held up number (STAT-REV-11)', () => {
  for (const win of ['start', 'last30']) {
    for (let i = 0; i < TWO.vehicles.length; i++) {
      const q = TWO.queries[win].vehicles[i];
      const m = vehicleModelOf(TWO, TWO.vehicles[i].id, { window: win });
      const held = blockOf(m, 'time').held;
      if (!held) continue;
      const queued = held.rows.filter((r) => r.kind === 'queue').reduce((a, r) => a + r.seconds, 0);
      const want = Math.min(q.timeSplit.waiting + q.timeSplit.dockQueue, q.timeSplit.dockQueue);
      // at most four rows are listed (the rest is "other places"): all of the dock queue when the queues fit, never more than it
      if (q.queues.length && held.rows.length - 1 < M.HELD_ROWS) near(queued, want, 1e-9, `${TWO.vehicles[i].id} ${win}: the queue rows are the dock queue of the time split`);
      assert.ok(queued <= want + 1e-9, `${TWO.vehicles[i].id} ${win}: ${queued} s of queue rows against ${want} s of dock queue`);
      near(held.rows.reduce((a, r) => a + r.seconds, 0), held.total, 1e-9, 'and with the other places they are the tile');
    }
  }
  // a queue the legs have not placed yet (the first drives are still open) is one row, not "other places"
  const open = tweak(TWO, (c) => { const v = c.queries.start.vehicles[indexOfVehicle(c, 'v2#1')]; v.queues = []; });
  const rows = blockOf(vehicleModelOf(open, 'v2#1'), 'time').held.rows;
  assert.ok(rows.some((r) => r.key === 'queue:Queue for a dock' && r.seconds > 0), rows.map((r) => r.label).join(' | '));
});

test('once the leg log has wrapped the trips are counted since the log is complete: per-hour figures use that span, the dock says so (STAT-ENG-REV-1)', () => {
  const wrapped = tweak(TWO, (c) => { c.detail.legs = { count: 50000, rows: 32768, cap: 32768, since: 5000 }; });
  const plain = vehicleModelOf(TWO, 'v2#1');
  const m = vehicleModelOf(wrapped, 'v2#1');
  const trips = blockOf(m, 'trips');
  const hours = (TWO.time - 5000) / 3600;
  const rowsOf = (mm) => blockOf(mm, 'trips').rows;
  rowsOf(m).forEach((r, k) => { near(r.perHour, r.trips / hours, 1e-9, `row ${k}`); assert.notEqual(r.meta, rowsOf(plain)[k].meta, 'the rate is not the one of the whole window'); });
  assert.match(trips.aside, /^top 3 of 4 · the last 32,768 drives, since 1:23$/);
  assert.ok(blockOf(m, 'facts').how.some((x) => /^Only the newest 32,768 drives are kept: the trips, the usual round, the other drives and the queue by dock count the drives since 1:23 \(\d+ min\)/.test(x)), blockOf(m, 'facts').how.join(' | '));
  assert.doesNotMatch(trips.other.items[0].text, /\d+ m\b|km/, 'metres are of the whole window: not beside the drives of a part of it');
  assert.equal(tileOf(m, 'trips').value, tileOf(plain, 'trips').value, 'the strip does not depend on the log');
  // not wrapped: nothing changes
  const same = vehicleModelOf(tweak(TWO, (c) => { c.detail.legs.since = 5000; }), 'v2#1');
  assert.deepEqual(rowsOf(same).map((r) => r.meta), rowsOf(plain).map((r) => r.meta), 'a log that has not wrapped ignores `since`');
});

test('a window that began because the plant changed says so, not "warm-up excluded" (STAT-REV-16)', () => {
  const restarted = tweak(TWO, (c) => {
    c.detail.windowStart = 4500; c.windows.start.t0 = 4500; c.windows.start.seconds = c.time - 4500; c.report.window.start = 4500; c.report.window.duration = c.time - 4500;
    c.detail.notices = [{ t: 4500, text: 'The vehicles or stations changed; the statistics start counting again here.' }];
  });
  const m = vehicleModelOf(restarted, 'v2#1');
  assert.equal(m.window.restarted, true); assert.equal(m.window.late, false);
  assert.match(m.window.text, /^counting since 1:15 \(the plant changed\)$/);
  assert.match(m.window.counted, /^Counting since 1:15: the vehicles or stations changed then/);
  assert.doesNotMatch(`${m.window.text} ${m.window.counted}`, /warm-up excluded/);
  assert.equal(vehicleModelOf(TWO, 'v2#1').window.restarted, false);
});

test('a rate from less than 20 minutes says it is indicative and what it stands on (STAT-REV-18)', () => {
  const young = vehicleModelOf(EARLY, 'v2#1');
  const t = tileOf(young, 'trips');
  assert.match(t.ref.text, / · indicative$/); assert.match(t.def, /indicative, the rate will move/);
  assert.doesNotMatch(tileOf(vehicleModelOf(TWO, 'v2#1'), 'trips').ref.text, /indicative/);
  const shrunk = tweak(TWO, (c) => { c.windows.start.seconds = 900; for (const v of c.queries.start.vehicles) { const k = 900 / v.timeSplit.seconds; for (const key of Object.keys(v.timeSplit)) v.timeSplit[key] *= k; } });
  assert.match(blockOf(vehicleModelOf(shrunk, 'v2#1'), 'time').held.aside, /indicative$/, 'the minutes per hour of the held-up rows too');
});

test('the fleet\'s own loads an hour stand behind the fleet\'s trips, not the vehicle\'s (STAT-REV-14)', () => {
  const input = fixtureInput(TWO, { kind: 'vehicle', ids: ['v1#1'] });
  for (const v of input.detail.V) v.cfg = { capacity: 2 }; // the forklifts carry two loads (the fixture\'s vehicles are plain objects without the vehicle configuration)
  const m = buildStatsModel(input);
  const ref = tileOf(m, 'trips').ref.text;
  const mm = /^fleet [\d.]+ · ([\d.]+) loads\/h$/.exec(ref);
  assert.ok(mm, ref);
  const mates = TWO.vehicles.map((v, k) => [v, k]).filter(([v]) => v.fleetId === 'v1');
  const hours = TWO.queries.start.vehicles[0].timeSplit.seconds / 3600;
  near(Number(mm[1]), mates.reduce((a, [, k]) => a + TWO.queries.start.vehicles[k].counts.qty, 0) / mates.length / hours, 0.06, 'the mean of the fleet');
  assert.match(tileOf(m, 'trips').def, /so it moved [\d.]+ loads an hour/, 'and the vehicle\'s own figure is in the (i)');
});
