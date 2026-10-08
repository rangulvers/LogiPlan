// Edit feedback, pure parts: the change-impact card (js/ui/panels/impact.js: delta classification, noise bands, honesty line,
// model, hint) and the live status of a fleet (js/ui/panels/fleet-status.js: counts, badge, figures). The DOM parts are exercised in
// the real browser by tests/e2e/edit-feedback.mjs; the baseline itself (kept across edits, Keep, Dismiss, the old plant simulated next to
// the new one) is tested with the runner in tests/ui.runner.warm.test.js; the noise bands against real paired runs in
// tests/ui.impact.paired.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IMPACT_FIGURES, COMPARE_FULL_SECONDS, NOISE_RELATIVE, NO_CHANGE_NOTE, STALLED_NOTE, classifyDelta, windowStatus, describeLabels, impactModel, impactHintText, compareProperly,
} from '../js/ui/panels/impact.js';
import { createStore } from '../js/store/store.js';
import { EXAMPLES } from '../js/model/examples.js';
import * as L from '../js/model/layout.js';
import { statusGroup, countVehicles, usageBadge, fleetStatusModel, STATUS_GROUPS } from '../js/ui/panels/fleet-status.js';
import { METRICS } from '../js/sim/experiments.js';

const figure = (id) => IMPACT_FIGURES.find((f) => f.id === id);

/** A KpiReport with just the numbers the card reads. */
function report({ perHour = 20, lead = 600, wip = 10, util = 0.6, wait = 0.05, deadlocks = 0, duration = 1200, warmingUp = false, count = 4, leadCount = 10, drove = true } = {}) {
  return {
    window: { start: 600, end: 600 + duration, duration, warmingUp },
    throughput: { total: Math.round((perHour * duration) / 3600), perHour, bySink: {} },
    leadTime: { count: leadCount, mean: lead, min: 100, p50: lead, p90: lead * 1.4, p95: lead * 1.5, max: lead * 2 },
    wip: { mean: wip, max: wip * 2, now: wip },
    stations: {},
    fleets: { f1: { name: 'AGV', count, utilization: util, emptyShare: 0.4, distance: 1000, shares: { driving: drove ? 0.4 : 0, waiting: drove ? 0.05 : 0, loading: 0.1, unloading: 0.1, idle: 0.35, parked: 0, charging: 0, broken: 0 } } },
    flows: {},
    traffic: { waitShare: wait, vehicleWait: 10, junctionWait: 5, brokenWait: 0, deadlocks, hotspots: [], deadlockEvents: [] },
    orders: { completed: 10, avgPickupWait: 30, avgTransit: 40 },
    series: { interval: 60, t: [], throughput: [], wip: [], vehiclesWorking: [], vehiclesWaiting: [] },
  };
}
/** A baseline without the fair figures (a kept baseline, or one whose pair could not be made). */
const baselineOf = (r, labels = ['Add fleet']) => ({ report: r, simTime: 1500, labels, edits: labels.length, layout: {}, control: null, after: null });
/** A baseline with the old plant (`before`) and the updated plant (`after`) over the same window. */
const pairedOf = (before, after, labels = ['Add fleet']) => ({
  report: report({ duration: 3600 }), simTime: 4200, labels, edits: labels.length, layout: {},
  control: { window: before.window.duration, report: before }, after: { window: after.window.duration, report: after },
});

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

test('classifyDelta: every figure has a noise band of its own, just above the noise of paired runs', () => {
  assert.equal(NOISE_RELATIVE, 0.08);
  assert.deepEqual(IMPACT_FIGURES.map((f) => [f.id, f.relative]), [['throughput', 0.15], ['leadTime', 0.08], ['wip', 0.08], ['fleet', 0.08], ['traffic', 0.08], ['deadlocks', 0]]);
  // the throughput moves in steps of whole loads: 15 %
  assert.equal(classifyDelta(figure('throughput'), 100, 114.9).noise, true);
  assert.equal(classifyDelta(figure('throughput'), 100, 115.1).tone, 'good');
  // lead time and work in progress: 8 %
  assert.equal(classifyDelta(figure('leadTime'), 1000, 1079).tone, 'neutral');
  assert.equal(classifyDelta(figure('leadTime'), 1000, 1081).tone, 'bad');
  assert.equal(classifyDelta(figure('wip'), 10, 10.7).label, 'no clear change');
  assert.equal(classifyDelta(figure('wip'), 10, 9.1).tone, 'good');
  const c = classifyDelta(figure('throughput'), 100, 102.9);
  assert.equal(c.noise, true);
  assert.equal(c.tone, 'neutral');
  assert.equal(c.label, 'no clear change');
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
  assert.equal(classifyDelta(figure('traffic'), 1, 4.9).noise, true, 'less than four points of waiting');
  assert.equal(classifyDelta(figure('traffic'), 1, 5.1).tone, 'bad');
});

test('classifyDelta: with the loads behind the figures, a handful of loads does not make a verdict', () => {
  const ten = { seconds: 600, countBefore: 10, countAfter: 10 };
  // one load more in 10 minutes is 6 per hour: +33 % of 18, but a single load
  const one = classifyDelta(figure('throughput'), 18, 24, ten);
  assert.equal(one.noise, true);
  assert.equal(one.tone, 'neutral');
  assert.equal(classifyDelta(figure('throughput'), 18, 30, ten).tone, 'good', 'two loads');
  assert.equal(classifyDelta(figure('throughput'), 30, 18, ten).tone, 'bad');
  assert.equal(classifyDelta(figure('throughput'), 18, 24, { seconds: 1200 }).tone, 'good', 'the same rate difference is two loads in 20 minutes');
  assert.equal(classifyDelta(figure('throughput'), 18, 24).tone, 'good', 'without the loads only the band applies');
  // lead time needs three loads on each side
  assert.equal(classifyDelta(figure('leadTime'), 600, 900, { countBefore: 2, countAfter: 8 }).noise, true);
  assert.equal(classifyDelta(figure('leadTime'), 600, 900, { countBefore: 8, countAfter: 2 }).noise, true);
  assert.equal(classifyDelta(figure('leadTime'), 600, 900, { countBefore: 3, countAfter: 3 }).tone, 'bad');
  // a window of 599.99 s is a window of 600 s
  assert.equal(classifyDelta(figure('throughput'), 18, 30, { seconds: 599.99 }).tone, 'good');
});

test('classifyDelta: a deadlock appearing where there was none is bad, and any change of the count is a change', () => {
  const first = classifyDelta(figure('deadlocks'), 0, 1);
  assert.equal(first.tone, 'bad');
  assert.equal(first.noise, false);
  assert.equal(first.text, '+1', 'no percentage of zero');
  assert.equal(classifyDelta(figure('deadlocks'), 100, 102).tone, 'bad', 'two more deadlocks are two more deadlocks');
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
  // a change that rounds to nothing is "±0", never "−0 pts" or "+0 %"
  assert.equal(classifyDelta(figure('fleet'), 68.02, 67.98).text, '±0');
  assert.equal(classifyDelta(figure('traffic'), 11.04, 11.0).text, '±0');
  assert.equal(classifyDelta(figure('wip'), 10000, 10000.4).text, '±0');
  assert.equal(classifyDelta(figure('traffic'), 11, 10.9).text, '−0.1 pts', 'but a tenth of a point is shown');
});

// ---- the honesty line ----------------------------------------------------------------------------------

test('windowStatus: what the compared window is, and that it is one run per plant', () => {
  assert.equal(COMPARE_FULL_SECONDS, 1200);
  const ten = windowStatus(report({ duration: 600 }));
  assert.equal(ten.key, 'indicative');
  assert.equal(ten.text, 'Indicative: one run per plant, so small differences are not coloured.');
  assert.equal(ten.seconds, 600);
  const almost = windowStatus(report({ duration: 1199 }));
  assert.equal(almost.key, 'indicative');
  const solid = windowStatus(report({ duration: 1200 }));
  assert.equal(solid.key, 'solid');
  assert.equal(solid.text, 'One run per plant, so small differences are not coloured.');
  assert.equal(windowStatus(report({ duration: 5400 })).seconds, 5400);
});

test('windowStatus: under a minute names seconds, a warming plant says so, no report says nothing', () => {
  assert.equal(windowStatus(report({ duration: 45 })).seconds, 45);
  assert.equal(windowStatus(report({ duration: 0 })).seconds, 0);
  assert.match(windowStatus(report({ duration: 0 })).text, /^Indicative: one run per plant/);
  const warming = windowStatus(report({ warmingUp: true, duration: 100 }));
  assert.equal(warming.key, 'warming');
  assert.match(warming.text, /still warming up/);
  for (const nothing of [null, undefined, {}, { window: null }]) assert.deepEqual(windowStatus(nothing), { key: 'none', text: '', seconds: null });
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

test('impactModel: six rows of the old plant against the updated one, with the change, the labels, the window and the honesty line', () => {
  const before = report({ perHour: 18, lead: 252, wip: 12, util: 0.68, wait: 0.11, deadlocks: 0, duration: 600 });
  const after = report({ perHour: 30, lead: 186, wip: 9, util: 0.58, wait: 0.05, deadlocks: 0, duration: 600 });
  const m = impactModel(pairedOf(before, after, ['Add fleet', 'Connect Goods in 2 → Assembly']), after);
  assert.equal(m.title, 'Effect of your change');
  assert.equal(m.subtitle, 'Add fleet, Connect Goods in 2 → Assembly');
  assert.deepEqual(m.rows.map((r) => r.id), ['throughput', 'leadTime', 'wip', 'fleet', 'traffic', 'deadlocks']);
  const row = Object.fromEntries(m.rows.map((r) => [r.id, r]));
  assert.equal(row.throughput.pair, '18 → 30 /h');
  assert.equal(row.throughput.change.tone, 'good');
  assert.equal(row.throughput.change.text, '+67 %');
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
  assert.equal(m.status.key, 'indicative');
  assert.equal(m.status.text, 'Indicative: one run per plant, so small differences are not coloured.');
  assert.equal(m.windows, 'Both plants were simulated for the same 10 min after warm-up, with the same random seed.');
  assert.equal(m.paired, true);
  assert.equal(m.updating, false);
  assert.equal(m.hasNumbers, true);
  assert.equal(m.canCompare, true);
  assert.equal(m.note, '');
});

test('impactModel: the figures are the paired ones; the long-run report of the baseline and the live report change nothing', () => {
  const before = report({ perHour: 18, duration: 600 });
  const after = report({ perHour: 30, duration: 600 });
  const baseline = pairedOf(before, after);
  const a = impactModel(baseline, report({ perHour: 99, duration: 5000 }));
  const b = impactModel(baseline, null);
  assert.deepEqual(a.rows.map((r) => r.pair), b.rows.map((r) => r.pair));
  assert.equal(a.rows[0].pair, '18 → 30 /h');
});

test('impactModel: a pair that does not exist (no fair comparison) shows dashes and says why', () => {
  const live = report({ duration: 900 });
  const unpaired = impactModel(baselineOf(report()), live);
  assert.ok(unpaired);
  assert.equal(unpaired.paired, false);
  assert.equal(unpaired.hasNumbers, false);
  assert.equal(unpaired.status.key, 'unpaired');
  assert.match(unpaired.status.text, /could not be run again next to the updated one in time/);
  assert.equal(unpaired.windows, '');
  assert.equal(unpaired.note, '', 'nothing to compare, so nothing to conclude');
  for (const row of unpaired.rows) {
    assert.equal(row.beforeText, '–');
    assert.equal(row.afterText, '–');
    assert.equal(row.change.text, '–');
  }
  assert.equal(impactHintText(unpaired), '');
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

test('impactModel: the card of an earlier edit stays while the next one is being pre-rolled, marked "updating"', () => {
  const before = report({ perHour: 18, duration: 600 });
  const after = report({ perHour: 30, duration: 600 });
  const m = impactModel(pairedOf(before, after), after, { priming: true });
  assert.equal(m.updating, true);
  assert.equal(m.hasNumbers, true);
});

test('impactModel: a report without a figure shows an en dash for it, never NaN or undefined', () => {
  const bare = { window: { start: 0, end: 600, duration: 600, warmingUp: false } };
  const m = impactModel(pairedOf(report({ duration: 600 }), bare), bare);
  for (const row of m.rows) {
    assert.ok(!/NaN|undefined|null/.test(`${row.pair} ${row.change.text}`), row.id);
  }
  assert.equal(m.rows.find((r) => r.id === 'throughput').afterText, '–');
  const noReport = impactModel(baselineOf(report()), null);
  assert.ok(noReport);
  assert.equal(noReport.status.key, 'none');
  assert.equal(noReport.windows, '');
});

test('impactModel: when no figure changed beyond noise it says so and where to look; any real change silences the note', () => {
  const r = report({ duration: 600 });
  const same = impactModel(pairedOf(r, report({ perHour: 20.2, lead: 603, wip: 10.1, wait: 0.052, duration: 600 })), null);
  assert.equal(same.note, NO_CHANGE_NOTE);
  assert.match(NO_CHANGE_NOTE, /Checks tab/);
  assert.match(NO_CHANGE_NOTE, /Compare properly/);
  const changed = (extra) => impactModel(pairedOf(r, report({ duration: 600, ...extra })), null).note;
  assert.equal(changed({ perHour: 40 }), '', 'throughput changed by three loads in 10 minutes');
  assert.equal(changed({ perHour: 30 }), NO_CHANGE_NOTE, 'but 20 -> 30 per hour is a single load in 10 minutes: not a change');
  assert.equal(changed({ util: 0.8 }), '', 'a change of the fleet utilization is a change, though it is not coloured');
  assert.equal(changed({ deadlocks: 1 }), '', 'a first deadlock is a change');
  assert.equal(impactModel(baselineOf(r), report({ warmingUp: true, duration: 0 })).note, '', 'nothing to say before there are numbers');
  assert.equal(impactModel(baselineOf(r), null).note, '');
});

test('impactModel: a plant that finished nothing after the change says so and is not called better in anything', () => {
  const before = report({ perHour: 20, wip: 10, wait: 0.05, duration: 600 });
  const after = { ...report({ perHour: 0, wip: 4, wait: 0.2, duration: 600 }), leadTime: { count: 0, mean: null, min: null, p50: null, p90: null, p95: null, max: null } };
  const m = impactModel(pairedOf(before, after), after);
  assert.equal(m.note, STALLED_NOTE);
  assert.match(STALLED_NOTE, /^No load was finished/);
  assert.match(STALLED_NOTE, /Checks tab/);
  const row = Object.fromEntries(m.rows.map((r) => [r.id, r]));
  assert.equal(row.throughput.change.tone, 'bad');
  assert.equal(row.leadTime.change.known, false, 'no lead time without a finished load');
  assert.equal(row.wip.change.tone, 'neutral', 'less work in progress in a plant that stands still is not an improvement');
  assert.equal(row.wip.change.label, 'not comparable');
  assert.deepEqual(m.rows.filter((r) => r.change.tone === 'good'), []);
});

test('impactModel: waiting in traffic is not rated when nothing drove after the change', () => {
  const before = report({ perHour: 20, wait: 0.05, duration: 600 });
  const after = report({ perHour: 0, wait: 0, duration: 600, drove: false });
  const m = impactModel(pairedOf(before, after), after);
  const traffic = m.rows.find((r) => r.id === 'traffic');
  assert.equal(traffic.pair, '5 → 0 %');
  assert.equal(traffic.change.tone, 'neutral');
  assert.equal(traffic.change.label, 'nothing drove');
  // a plant that really drives with less waiting keeps its green verdict
  const better = impactModel(pairedOf(before, report({ perHour: 30, wait: 0.005, duration: 600 })), null);
  assert.equal(better.rows.find((r) => r.id === 'traffic').change.tone, 'good');
});

test('impactModel: "Compare properly" needs the old plant; a baseline without a layout cannot offer it', () => {
  const m = impactModel({ ...baselineOf(report()), layout: undefined }, report());
  assert.equal(m.canCompare, false);
});

test('impactModel does not change its inputs and gives the same answer twice', () => {
  const b = pairedOf(report({ perHour: 10, duration: 600 }), report({ perHour: 14, duration: 600 }));
  const a = report({ perHour: 14 });
  const frozen = JSON.stringify([b, a]);
  const one = impactModel(b, a);
  const two = impactModel(b, a);
  assert.equal(JSON.stringify([b, a]), frozen);
  assert.deepEqual(one, two);
});

// ---- the hint ------------------------------------------------------------------------------------------

test('impactHintText names the two most telling changes and says when the numbers are only indicative', () => {
  const before = report({ perHour: 18, lead: 252, wip: 12, wait: 0.11, duration: 600 });
  const after = report({ perHour: 30, lead: 252, wip: 12, wait: 0.05, duration: 600 });
  const text = impactHintText(impactModel(pairedOf(before, after), after));
  assert.equal(text, 'Throughput 18 → 30 /h · Time waiting in traffic 11 → 5 % (indicative)', 'the larger relative change first');
  const solid = impactHintText(impactModel(pairedOf({ ...before, window: { ...before.window, duration: 1200 } }, { ...after, window: { ...after.window, duration: 1200 } }), after));
  assert.ok(!solid.includes('indicative'));
});

test('impactHintText: when nothing changed clearly it says so instead of quoting noise', () => {
  const r = report({ duration: 600 });
  const almost = report({ perHour: 20.2, duration: 600 });
  assert.equal(impactHintText(impactModel(pairedOf(r, almost), almost)), 'No clear change in the key figures (indicative)');
  assert.equal(impactHintText(null), '');
});

// ---- Compare properly ------------------------------------------------------------------------------------

/** A store with a plant that has been edited once, and the baseline that remembers the plant before the edit. */
function editedPlant() {
  const store = createStore({ storage: undefined });
  store.newProject(EXAMPLES[0].build());
  const before = store.getState().layout;
  store.commit('Add fleet', (l) => { L.addFleet(l, 'forklift'); });
  const baseline = { report: report(), labels: ['Add fleet', 'Add Goods out'], edits: 2, layout: before, control: null, after: null };
  const tabs = [];
  const toasts = [];
  const ctx = { store, runner: { baseline }, actions: { setRightTab: (tab) => tabs.push(tab) }, toast: (message, options) => toasts.push({ message, kind: options && options.kind }) };
  return { store, before, baseline, tabs, toasts, ctx };
}

test('compareProperly adds the old plant as a variant, stays on the current plant and opens the Experiments tab', () => {
  const { store, before, tabs, toasts, ctx } = editedPlant();
  const active = store.getState().project.activeId;
  const current = store.getState().layout;
  assert.equal(compareProperly(ctx), true);
  const state = store.getState();
  assert.equal(state.project.scenarios.length, 2);
  assert.equal(state.project.activeId, active, 'the planner stays on the current plant');
  assert.equal(state.layout, current, 'whose layout is untouched');
  const variant = state.project.scenarios[1];
  assert.equal(variant.name, 'Before: Add fleet and 1 more');
  assert.equal(variant.layout.fleets.length, before.fleets.length, 'it is the plant without the edits');
  assert.equal(state.layout.fleets.length, before.fleets.length + 1);
  assert.deepEqual(tabs, ['experiments']);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /^Added "Before: Add fleet and 1 more" as a variant\./);
  assert.equal(toasts[0].kind, 'success');
});

test('compareProperly does not add a second copy of the same old plant', () => {
  const { store, tabs, toasts, ctx } = editedPlant();
  compareProperly(ctx);
  assert.equal(compareProperly(ctx), true);
  assert.equal(store.getState().project.scenarios.length, 2);
  assert.deepEqual(tabs, ['experiments', 'experiments']);
  assert.equal(toasts.length, 1, 'and does not say it again');
});

test('compareProperly without the old plant only opens the Experiments tab; with no room for a variant it says so', () => {
  const { store, baseline, tabs, toasts, ctx } = editedPlant();
  assert.equal(compareProperly({ ...ctx, runner: { baseline: { ...baseline, layout: undefined } } }), false);
  assert.equal(compareProperly({ ...ctx, runner: { baseline: null } }), false);
  assert.deepEqual(tabs, ['experiments', 'experiments']);
  assert.equal(store.getState().project.scenarios.length, 1);
  while (store.addScenario('Filler')) { /* up to the limit of variants */ }
  const full = store.getState().project.scenarios.length;
  assert.equal(compareProperly(ctx), false);
  assert.equal(store.getState().project.scenarios.length, full);
  assert.equal(toasts.at(-1).kind, 'warn');
  assert.match(toasts.at(-1).message, /no room for another variant/);
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

test('usageBadge: "no jobs", "barely used", "some idle" or "mostly idle" with the reason of the insight, nothing otherwise', () => {
  const insights = [
    { id: 'fleet-unused:f1', title: 'The 2 vehicles of the Forklifts fleet hardly work (1 trip in 2 h).', suggestion: 'The other vehicles already cover every job.' },
    { id: 'vehicle-idle-some:f2', title: '1 of 4 vehicles in the AGVs fleet hardly work.', suggestion: 'Try 3 vehicles instead of 4.' },
    { id: 'fleet-oversized:f3', title: 'The AGV fleet is mostly idle.', suggestion: 'Try 2 vehicles instead of 5.' },
    { id: 'fleet-no-jobs:f4', title: 'The 1 vehicle of the Truck fleet has no job.', suggestion: 'Allow Truck on a flow.' },
    { id: 'traffic', title: 'Traffic is costing time.' },
  ];
  assert.deepEqual(usageBadge(insights, 'f1'), { text: 'barely used', tip: 'The 2 vehicles of the Forklifts fleet hardly work (1 trip in 2 h). The other vehicles already cover every job.' });
  assert.equal(usageBadge(insights, 'f2').text, 'some idle');
  assert.deepEqual(usageBadge(insights, 'f3'), { text: 'mostly idle', tip: 'The AGV fleet is mostly idle. Try 2 vehicles instead of 5.' }, 'what Results call mostly idle, the strip says too');
  assert.deepEqual(usageBadge(insights, 'f4'), { text: 'no jobs', tip: 'The 1 vehicle of the Truck fleet has no job. Allow Truck on a flow.' });
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
