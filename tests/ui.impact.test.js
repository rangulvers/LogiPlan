// Edit feedback, pure parts: the change-impact card (js/ui/panels/impact.js: delta classification, noise threshold, honesty line,
// model, hint) and the live status of a fleet (js/ui/panels/fleet-status.js: counts, badge, figures). The DOM parts are exercised in
// the real browser by tests/e2e/edit-feedback.mjs; the baseline itself (kept across edits, Keep, Dismiss) is tested with the runner in
// tests/ui.runner.warm.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IMPACT_FIGURES, COMPARE_FULL_SECONDS, NOISE_RELATIVE, NO_CHANGE_NOTE, classifyDelta, windowStatus, describeLabels, impactModel, impactHintText,
} from '../js/ui/panels/impact.js';
import { statusGroup, countVehicles, usageBadge, fleetStatusModel, STATUS_GROUPS } from '../js/ui/panels/fleet-status.js';
import { METRICS } from '../js/sim/experiments.js';

const figure = (id) => IMPACT_FIGURES.find((f) => f.id === id);

/** A KpiReport with just the numbers the card reads. */
function report({ perHour = 20, lead = 600, wip = 10, util = 0.6, wait = 0.05, deadlocks = 0, duration = 1200, warmingUp = false, count = 4 } = {}) {
  return {
    window: { start: 600, end: 600 + duration, duration, warmingUp },
    throughput: { total: Math.round((perHour * duration) / 3600), perHour, bySink: {} },
    leadTime: { count: 10, mean: lead, min: 100, p50: lead, p90: lead * 1.4, p95: lead * 1.5, max: lead * 2 },
    wip: { mean: wip, max: wip * 2, now: wip },
    stations: {},
    fleets: { f1: { name: 'AGV', count, utilization: util, emptyShare: 0.4, distance: 1000 } },
    flows: {},
    traffic: { waitShare: wait, vehicleWait: 10, junctionWait: 5, brokenWait: 0, deadlocks, hotspots: [], deadlockEvents: [] },
    orders: { completed: 10, avgPickupWait: 30, avgTransit: 40 },
    series: { interval: 60, t: [], throughput: [], wip: [], vehiclesWorking: [], vehiclesWaiting: [] },
  };
}
const baselineOf = (r, labels = ['Add fleet']) => ({ report: r, simTime: 1500, labels, edits: labels.length });

// ---- the figures ---------------------------------------------------------------------------------------

test('six figures, in the order of the card, each tied to a METRICS entry that says which direction is better', () => {
  assert.deepEqual(IMPACT_FIGURES.map((f) => f.id), ['throughput', 'leadTime', 'wip', 'fleet', 'traffic', 'deadlocks']);
  for (const f of IMPACT_FIGURES) assert.ok(METRICS.some((m) => m.id === f.metric), f.metric);
  const better = Object.fromEntries(METRICS.map((m) => [m.id, m.better]));
  assert.equal(better.throughput, 'higher');
  assert.equal(better.leadMean, 'lower');
  assert.equal(better.fleetUtilization, null);
});

// ---- classifyDelta -------------------------------------------------------------------------------------

test('classifyDelta: a real increase of the throughput is good, a real decrease is bad', () => {
  const up = classifyDelta(figure('throughput'), 18, 24);
  assert.equal(up.tone, 'good');
  assert.equal(up.noise, false);
  assert.equal(up.label, 'better');
  assert.equal(up.text, '+33 %');
  const down = classifyDelta(figure('throughput'), 24, 18);
  assert.equal(down.tone, 'bad');
  assert.equal(down.label, 'worse');
  assert.equal(down.text, '−25 %');
});

test('classifyDelta: for lead time, work in progress, waiting and deadlocks "lower" is the good direction', () => {
  assert.equal(classifyDelta(figure('leadTime'), 800, 600).tone, 'good');
  assert.equal(classifyDelta(figure('leadTime'), 600, 800).tone, 'bad');
  assert.equal(classifyDelta(figure('wip'), 12, 8).tone, 'good');
  assert.equal(classifyDelta(figure('traffic'), 5, 12).tone, 'bad');
  assert.equal(classifyDelta(figure('traffic'), 12, 5).tone, 'good');
  assert.equal(classifyDelta(figure('deadlocks'), 0, 2).tone, 'bad');
  assert.equal(classifyDelta(figure('deadlocks'), 4, 0).tone, 'good');
});

test('classifyDelta: fleet utilization is never coloured (neither more nor less is better), however large the change', () => {
  const c = classifyDelta(figure('fleet'), 40, 90);
  assert.equal(c.tone, 'neutral');
  assert.equal(c.noise, false);
  assert.equal(c.label, 'for information');
  assert.equal(c.text, '+50 pts');
});

test('classifyDelta: below 3 % the change is noise, whatever the figure', () => {
  assert.equal(NOISE_RELATIVE, 0.03);
  const c = classifyDelta(figure('throughput'), 100, 102.9);
  assert.equal(c.noise, true);
  assert.equal(c.tone, 'neutral');
  assert.equal(c.label, 'no clear change');
  assert.equal(classifyDelta(figure('throughput'), 100, 103.1).tone, 'good', 'just above 3 %');
  assert.equal(classifyDelta(figure('leadTime'), 1000, 1029).tone, 'neutral');
  assert.equal(classifyDelta(figure('leadTime'), 1000, 1040).tone, 'bad');
});

test('classifyDelta: less than one load per hour is noise for the throughput, even when it is a large share', () => {
  const small = classifyDelta(figure('throughput'), 4, 4.9);
  assert.equal(small.noise, true);
  assert.equal(small.tone, 'neutral');
  assert.equal(classifyDelta(figure('throughput'), 4, 5.1).tone, 'good');
  assert.equal(classifyDelta(figure('throughput'), 4, 2.9).tone, 'bad');
});

test('classifyDelta: the other figures have their own floors', () => {
  assert.equal(classifyDelta(figure('leadTime'), 8, 12).noise, true, 'less than 5 s');
  assert.equal(classifyDelta(figure('leadTime'), 8, 14).noise, false);
  assert.equal(classifyDelta(figure('wip'), 1, 1.4).noise, true, 'less than half a load');
  assert.equal(classifyDelta(figure('traffic'), 1, 1.4).noise, true, 'less than half a point');
  assert.equal(classifyDelta(figure('traffic'), 1, 1.6).tone, 'bad');
});

test('classifyDelta: a deadlock appearing where there was none is bad, and a count changing by a hair is noise', () => {
  const first = classifyDelta(figure('deadlocks'), 0, 1);
  assert.equal(first.tone, 'bad');
  assert.equal(first.noise, false);
  assert.equal(first.text, '+1', 'no percentage of zero');
  assert.equal(classifyDelta(figure('deadlocks'), 100, 102).tone, 'neutral', '2 % of 100');
  assert.equal(classifyDelta(figure('deadlocks'), 0, 0).text, '±0');
  assert.equal(classifyDelta(figure('deadlocks'), 0, 0).tone, 'neutral');
});

test('classifyDelta: null-safe, and no change at all reads ±0', () => {
  for (const [a, b] of [[null, 5], [5, null], [null, null], [undefined, 3], [NaN, 3], [3, Infinity], ['5', 6]]) {
    const c = classifyDelta(figure('throughput'), a, b);
    assert.equal(c.tone, 'neutral');
    assert.equal(c.known, false);
    assert.equal(c.text, '–');
    assert.equal(c.delta, null);
  }
  const same = classifyDelta(figure('throughput'), 12, 12);
  assert.equal(same.text, '±0');
  assert.equal(same.noise, true);
});

test('classifyDelta: the size of the change is worded with a sign that does not depend on colour', () => {
  assert.equal(classifyDelta(figure('traffic'), 11, 15.5).text, '+4.5 pts');
  assert.equal(classifyDelta(figure('traffic'), 15.5, 11).text, '−4.5 pts');
  assert.equal(classifyDelta(figure('fleet'), 68, 58).text, '−10 pts');
  assert.equal(classifyDelta(figure('wip'), 10, 11).text, '+10 %');
  assert.equal(classifyDelta(figure('wip'), 10, 10.45).text, '+4.5 %');
  assert.equal(classifyDelta(figure('throughput'), 1, 60).text, '+999+ %');
});

// ---- the honesty line ----------------------------------------------------------------------------------

test('windowStatus: indicative while the new window is short, with the share measured, "Measured over" from 20 minutes on', () => {
  assert.equal(COMPARE_FULL_SECONDS, 1200);
  const six = windowStatus(report({ duration: 360 }));
  assert.equal(six.key, 'indicative');
  assert.equal(six.text, 'Indicative: only 6 of 20 minutes measured so far');
  assert.ok(Math.abs(six.progress - 0.3) < 1e-9);
  const ten = windowStatus(report({ duration: 600 }));
  assert.equal(ten.text, 'Indicative: only 10 of 20 minutes measured so far');
  const almost = windowStatus(report({ duration: 1199 }));
  assert.equal(almost.key, 'indicative');
  assert.equal(almost.text, 'Indicative: only 19 of 20 minutes measured so far');
  const solid = windowStatus(report({ duration: 1200 }));
  assert.equal(solid.key, 'solid');
  assert.equal(solid.text, 'Measured over 20 min');
  assert.equal(solid.progress, 1);
  assert.equal(windowStatus(report({ duration: 5400 })).text, 'Measured over 1.5 h');
});

test('windowStatus: under a minute names seconds, a warming plant says so, no report says nothing', () => {
  assert.equal(windowStatus(report({ duration: 45 })).text, 'Indicative: only 45 s of 20 minutes measured so far');
  assert.equal(windowStatus(report({ duration: 0 })).text, 'Indicative: only 0 s of 20 minutes measured so far');
  const warming = windowStatus(report({ warmingUp: true, duration: 100 }));
  assert.equal(warming.key, 'warming');
  assert.match(warming.text, /still warming up/);
  assert.equal(warming.progress, null);
  for (const nothing of [null, undefined, {}, { window: null }]) assert.deepEqual(windowStatus(nothing), { key: 'none', text: '', progress: null, seconds: null });
});

// ---- labels --------------------------------------------------------------------------------------------

test('describeLabels names three edits, then "and n more"', () => {
  assert.equal(describeLabels(['Add fleet']), 'Add fleet');
  assert.equal(describeLabels(['Add fleet', 'Connect Goods in 2 → Assembly']), 'Add fleet, Connect Goods in 2 → Assembly');
  assert.equal(describeLabels(['a', 'b', 'c']), 'a, b, c');
  assert.equal(describeLabels(['a', 'b', 'c', 'd', 'e']), 'a, b, c and 2 more');
  assert.equal(describeLabels([]), '');
  assert.equal(describeLabels(null), '');
  assert.equal(describeLabels(['a', '', 5, 'b']), 'a, b');
});

// ---- the model -----------------------------------------------------------------------------------------

test('impactModel: nothing to show without a baseline, without an edit since, or without numbers to compare', () => {
  const r = report();
  assert.equal(impactModel(null, r), null);
  assert.equal(impactModel(undefined, r), null);
  assert.equal(impactModel({ report: r, labels: [] }, r), null, 'kept as baseline: no edit since');
  assert.equal(impactModel({ labels: ['x'] }, r), null, 'no report in the baseline');
  assert.equal(impactModel({ report: r, labels: 'x' }, r), null);
});

test('impactModel: six rows of before -> after with the change, the labels, the window lengths and the honesty line', () => {
  const before = report({ perHour: 18, lead: 252, wip: 12, util: 0.68, wait: 0.11, deadlocks: 0, duration: 1200 });
  const after = report({ perHour: 24.5, lead: 186, wip: 9, util: 0.58, wait: 0.05, deadlocks: 0, duration: 360 });
  const m = impactModel(baselineOf(before, ['Add fleet', 'Connect Goods in 2 → Assembly']), after);
  assert.equal(m.title, 'Effect of your change');
  assert.equal(m.subtitle, 'Add fleet, Connect Goods in 2 → Assembly');
  assert.deepEqual(m.rows.map((r) => r.id), ['throughput', 'leadTime', 'wip', 'fleet', 'traffic', 'deadlocks']);
  const row = Object.fromEntries(m.rows.map((r) => [r.id, r]));
  assert.equal(row.throughput.pair, '18 → 24.5 /h');
  assert.equal(row.throughput.change.tone, 'good');
  assert.equal(row.throughput.change.text, '+36 %');
  assert.equal(row.leadTime.pair, '4.2 min → 3.1 min');
  assert.equal(row.leadTime.change.tone, 'good');
  assert.equal(row.leadTime.change.text, '−26 %');
  assert.equal(row.wip.pair, '12 → 9 loads');
  assert.equal(row.fleet.pair, '68 → 58 %');
  assert.equal(row.fleet.change.tone, 'neutral');
  assert.equal(row.traffic.pair, '11 → 5 %');
  assert.equal(row.traffic.change.tone, 'good');
  assert.equal(row.deadlocks.pair, '0 → 0');
  assert.equal(row.deadlocks.change.text, '±0');
  assert.equal(m.status.text, 'Indicative: only 6 of 20 minutes measured so far');
  assert.equal(m.windows, 'Before: 20 min measured · After: 6 min measured');
  assert.equal(m.updating, false);
  assert.equal(m.hasNumbers, true);
});

test('impactModel: a plant that is still warming up has no "after" numbers yet', () => {
  const m = impactModel(baselineOf(report()), report({ warmingUp: true, duration: 0 }), { priming: true });
  assert.ok(m);
  assert.equal(m.updating, true);
  assert.equal(m.status.key, 'warming');
  for (const row of m.rows) {
    assert.equal(row.afterText, '–');
    assert.equal(row.change.text, '–');
    assert.equal(row.change.tone, 'neutral');
  }
  assert.equal(m.hasNumbers, false);
  assert.equal(impactHintText(m), '');
});

test('impactModel: a report without a figure shows an en dash for it, never NaN or undefined', () => {
  const bare = { window: { start: 0, end: 600, duration: 600, warmingUp: false } };
  const m = impactModel(baselineOf(report()), bare);
  for (const row of m.rows) {
    assert.ok(!/NaN|undefined|null/.test(`${row.pair} ${row.change.text}`), row.id);
  }
  assert.equal(m.rows.find((r) => r.id === 'throughput').afterText, '–');
  const noReport = impactModel(baselineOf(report()), null);
  assert.ok(noReport);
  assert.equal(noReport.status.key, 'none');
  assert.equal(noReport.windows, 'Before: 20 min measured · After: –');
});

test('impactModel: when no figure changed beyond noise it says so and where to look; any real change silences the note', () => {
  const r = report();
  const same = impactModel(baselineOf(r), report({ perHour: 20.2, lead: 603, wip: 10.1, wait: 0.052, duration: 1300 }));
  assert.equal(same.note, NO_CHANGE_NOTE);
  assert.match(NO_CHANGE_NOTE, /Checks tab/);
  assert.equal(impactModel(baselineOf(r), report({ perHour: 26 })).note, '', 'throughput changed');
  assert.equal(impactModel(baselineOf(r), report({ util: 0.8 })).note, '', 'a change of the fleet utilization is a change, though it is not coloured');
  assert.equal(impactModel(baselineOf(r), report({ deadlocks: 1 })).note, '', 'a first deadlock is a change');
  assert.equal(impactModel(baselineOf(r), report({ warmingUp: true, duration: 0 })).note, '', 'nothing to say before there are numbers');
  assert.equal(impactModel(baselineOf(r), null).note, '');
});

test('impactModel does not change its inputs and gives the same answer twice', () => {
  const b = baselineOf(report({ perHour: 10 }));
  const a = report({ perHour: 14 });
  const frozen = JSON.stringify([b, a]);
  const one = impactModel(b, a);
  const two = impactModel(b, a);
  assert.equal(JSON.stringify([b, a]), frozen);
  assert.deepEqual(one, two);
});

// ---- the hint ------------------------------------------------------------------------------------------

test('impactHintText names the two most telling changes and says when the numbers are only indicative', () => {
  const before = report({ perHour: 18, lead: 252, wip: 12, wait: 0.11 });
  const after = report({ perHour: 24.5, lead: 252, wip: 12, wait: 0.05, duration: 360 });
  const text = impactHintText(impactModel(baselineOf(before), after));
  assert.equal(text, 'Time waiting in traffic 11 → 5 % · Throughput 18 → 24.5 /h (indicative)', 'the larger relative change first');
  const solid = impactHintText(impactModel(baselineOf(before), { ...after, window: { ...after.window, duration: 1300 } }));
  assert.ok(!solid.includes('indicative'));
});

test('impactHintText: when nothing changed clearly it says so instead of quoting noise', () => {
  const r = report();
  assert.equal(impactHintText(impactModel(baselineOf(r), report({ perHour: 20.2, duration: 1300 }))), 'No clear change in the key figures yet');
  assert.equal(impactHintText(impactModel(baselineOf(r), report({ perHour: 20.2, duration: 400 }))), 'No clear change in the key figures yet (indicative)');
  assert.equal(impactHintText(null), '');
});

// ---- the live status of a fleet ------------------------------------------------------------------------

const vehicle = (state, fleetId = 'f1', waiting = false) => ({ id: `${fleetId}#x`, fleetId, state, tv: { waiting } });

test('statusGroup puts every vehicle state into exactly one live group', () => {
  assert.equal(statusGroup(vehicle('toPickup')), 'working');
  assert.equal(statusGroup(vehicle('loading')), 'working');
  assert.equal(statusGroup(vehicle('toDrop')), 'working');
  assert.equal(statusGroup(vehicle('unloading')), 'working');
  assert.equal(statusGroup(vehicle('toPickup', 'f1', true)), 'waiting');
  assert.equal(statusGroup(vehicle('idle')), 'idle');
  assert.equal(statusGroup(vehicle('toPark')), 'idle');
  assert.equal(statusGroup(vehicle('parked')), 'parked');
  assert.equal(statusGroup(vehicle('charging')), 'charging');
  assert.equal(statusGroup(vehicle('toCharger')), 'charging');
  assert.equal(statusGroup(vehicle('broken')), 'down');
  assert.equal(statusGroup(vehicle('dead')), 'down');
  assert.equal(statusGroup({ state: 'weird' }), 'idle');
  assert.equal(statusGroup(null), 'idle');
  const groups = STATUS_GROUPS.map((g) => g.key);
  for (const state of ['toPickup', 'loading', 'toDrop', 'unloading', 'idle', 'parked', 'toPark', 'charging', 'toCharger', 'broken', 'dead']) {
    assert.ok(groups.includes(statusGroup(vehicle(state))), state);
  }
});

test('countVehicles counts one fleet: working, waiting, idle, parked, and the total', () => {
  const vehicles = [
    vehicle('toPickup'), vehicle('loading'), vehicle('toDrop', 'f1', true), vehicle('idle'), vehicle('parked'), vehicle('parked'), vehicle('broken'),
    vehicle('toPickup', 'f2'), vehicle('parked', 'f2'),
  ];
  assert.deepEqual(countVehicles(vehicles, 'f1'), { total: 7, working: 2, waiting: 1, idle: 1, parked: 2, charging: 0, down: 1 });
  assert.deepEqual(countVehicles(vehicles, 'f2'), { total: 2, working: 1, waiting: 0, idle: 0, parked: 1, charging: 0, down: 0 });
  assert.deepEqual(countVehicles(vehicles, 'nobody'), { total: 0, working: 0, waiting: 0, idle: 0, parked: 0, charging: 0, down: 0 });
  assert.deepEqual(countVehicles(null, 'f1'), { total: 0, working: 0, waiting: 0, idle: 0, parked: 0, charging: 0, down: 0 });
});

test('usageBadge: "barely used" with the reason of the insight, "some idle" for single vehicles, nothing otherwise', () => {
  const insights = [
    { id: 'fleet-unused:f1', title: 'The 2 vehicles of the Forklifts fleet hardly work (1 trip in 2 h).', suggestion: 'The other vehicles already cover every job.' },
    { id: 'vehicle-idle-some:f2', title: '1 of 4 vehicles in the AGVs fleet hardly work.', suggestion: 'Try 3 vehicles instead of 4.' },
    { id: 'fleet-oversized:f3', title: 'x' },
  ];
  assert.deepEqual(usageBadge(insights, 'f1'), { text: 'barely used', tip: 'The 2 vehicles of the Forklifts fleet hardly work (1 trip in 2 h). The other vehicles already cover every job.' });
  assert.equal(usageBadge(insights, 'f2').text, 'some idle');
  assert.equal(usageBadge(insights, 'f3'), null);
  assert.equal(usageBadge(insights, 'f9'), null);
  assert.equal(usageBadge(null, 'f1'), null);
  assert.equal(usageBadge([null, {}], 'f1'), null);
});

test('fleetStatusModel: trips so far, trips per vehicle and hour, lowest battery and the badge, all null-safe', () => {
  const r = report();
  r.fleets.f1 = { ...r.fleets.f1, trips: 42, tripsPerVehicleHour: 8.4, minBattery: 0.54 };
  const vehicles = [vehicle('toPickup'), vehicle('parked'), vehicle('idle')];
  const insights = [{ id: 'fleet-unused:f1', title: 'T.', suggestion: 'S.' }];
  const m = fleetStatusModel({ vehicles, fleetId: 'f1', report: r, insights });
  assert.deepEqual(m.counts, { total: 3, working: 1, waiting: 0, idle: 1, parked: 1, charging: 0, down: 0 });
  assert.equal(m.tripsText, '42 trips so far');
  assert.equal(m.perHourText, '8.4 trips per vehicle and hour');
  assert.equal(m.batteryText, 'lowest battery 54 %');
  assert.deepEqual(m.badge, { text: 'barely used', tip: 'T. S.' });

  r.fleets.f1.trips = 1;
  r.fleets.f1.tripsPerVehicleHour = 1;
  r.fleets.f1.minBattery = null;
  const one = fleetStatusModel({ vehicles, fleetId: 'f1', report: r, insights: [] });
  assert.equal(one.tripsText, '1 trip so far');
  assert.equal(one.perHourText, '1 trip per vehicle and hour');
  assert.equal(one.batteryText, '');
  assert.equal(one.badge, null);

  const nothing = fleetStatusModel({ vehicles: [], fleetId: 'f1', report: null, insights: null });
  assert.deepEqual(nothing.counts.total, 0);
  assert.equal(nothing.tripsText, '');
  assert.equal(nothing.perHourText, '');
  assert.equal(nothing.batteryText, '');
  assert.equal(nothing.badge, null);
  const unknownFleet = fleetStatusModel({ vehicles, fleetId: 'f9', report: r, insights: [] });
  assert.equal(unknownFleet.tripsText, '');
});
