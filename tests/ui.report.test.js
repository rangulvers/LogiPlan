// Pure parts of the Experiments tab and the report (js/ui/compare.js, js/ui/report.js). The DOM behaviour of the tab is covered by
// tests/e2e/compare.mjs (Playwright); everything here runs in Node without a DOM, including the whole report document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/store/store.js';
import { EXAMPLES } from '../js/model/examples.js';
import {
  createLayout, addStation, addFlow, addFleet, addLabel, paintRoadPath, updateSettings, updateFleet, setNotes, setName,
} from '../js/model/layout.js';
import { validateLayout } from '../js/model/validate.js';
import { Simulation } from '../js/sim/engine.js';
import { METRICS, runReplications, listSweepParameters } from '../js/sim/experiments.js';
import {
  LIMITS, variantParts, scaleFor, formatFixed, formatScaled, formatParamValue, describeValues, deltaVs, markBestWorst, buildComparison,
  headline, comparisonTsv, rangeValues, recommendSweep, buildSweep, sweepTsv, sweepSeries, resultStaleness, getLastResults, formatEta,
} from '../js/ui/compare.js';
import {
  html, raw, stationTypeName, describeDist, describeBreakdowns, stationParams, flowCells, fleetParams, settingsRows, plantRows, slug,
  reportFileName, pngBytes, measurementNote, kpiTiles, svgBars, svgLine, exportReportHtml,
} from '../js/ui/report.js';

const metric = (id) => METRICS.find((m) => m.id === id);
const stat = (mean, min = mean, max = mean, n = 3) => ({ mean, sd: 0, min, max, n });
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const HOSTILE = '<script>alert(1)</script>"\'&<img src=x onerror=alert(2)>';

/** A comparison result with the given throughput / lead-time means per variant (names are scenario names, letters by position). */
function comparison(variants, settings = { duration: 7200, warmup: 300, replications: 3 }) {
  return {
    kind: 'compare', at: 1700000000000, settings,
    variants: variants.map((v, i) => ({
      id: `sc${i + 1}`, ...variantParts(v.name, i), layout: v.layout || {},
      summary: { throughput: stat(v.tp, v.tp - 1, v.tp + 1), leadMean: stat(v.lead ?? 600, 500, 700), waitShare: stat(v.wait ?? 10), deadlocks: stat(v.dead ?? 0), ...v.summary },
    })),
  };
}

/** A sweep result of vehicles with the given throughput means. */
function sweepResult(means, { values = means.map((_, i) => i + 1), current = 3, unit = 'vehicles', replications = 3, layout = {} } = {}) {
  return {
    kind: 'sweep', at: 1700000000000, scenarioId: 'sc1', scenarioName: 'Baseline', layout, current, values,
    param: { key: 'fleet.v1.count', label: 'AGV: number of vehicles', unit }, settings: { duration: 7200, warmup: 300, replications }, partial: false,
    points: means.map((m, i) => ({ value: values[i], summary: { throughput: stat(m, m - 2, m + 2, replications), leadMean: stat(1000 - m * 5) } })),
  };
}

// ---- compare.js: names, numbers -----------------------------------------------------------------------------------------

test('variants are named by their position, and a name that already says its letter is kept', () => {
  assert.deepEqual(variantParts('Baseline', 0), { letter: 'A', name: 'Baseline', label: 'A - Baseline' });
  assert.equal(variantParts('One-way aisles', 2).label, 'C - One-way aisles');
  assert.equal(variantParts('C - One-way aisles', 2).label, 'C - One-way aisles');
  assert.equal(variantParts('B: Two lanes', 1).name, 'Two lanes');
  assert.deepEqual(variantParts('B', 1), { letter: 'B', name: '', label: 'B' });
  assert.deepEqual(variantParts('B', 0), { letter: 'B', name: '', label: 'B' }, 'a scenario called just "B" stays B wherever it is');
  assert.equal(variantParts('', 3).label, 'D');
  assert.equal(variantParts('Late', 27).label, 'S28 - Late');
  assert.equal(variantParts(undefined, 0).label, 'A');
});

test('seconds are shown as minutes or hours, other units are left alone', () => {
  assert.deepEqual(scaleFor(metric('leadMean'), 45), { factor: 1, unit: 's', digits: 0 });
  assert.deepEqual(scaleFor(metric('leadMean'), 1840), { factor: 1 / 60, unit: 'min', digits: 1 });
  assert.deepEqual(scaleFor(metric('leadMean'), 20000), { factor: 1 / 3600, unit: 'h', digits: 1 });
  assert.deepEqual(scaleFor(metric('throughput'), 1e6), { factor: 1, unit: 'loads/h', digits: 1 });
  assert.deepEqual(scaleFor(metric('leadMean'), NaN), { factor: 1, unit: 's', digits: 0 });
  assert.equal(formatScaled(1840, scaleFor(metric('leadMean'), 1840)), '30.7');
  assert.equal(formatScaled(null, { factor: 1, digits: 1 }), '–');
  assert.equal(formatFixed(44, 1), '44.0', 'a column of values keeps its decimals');
  assert.equal(formatFixed(12345.678, 1), '12,345.7');
});

test('a sweep value reads with its unit, once, and in the planner\'s words', () => {
  assert.equal(formatParamValue(6, 'vehicles'), '6 vehicles');
  assert.equal(formatParamValue(1, 'vehicles'), '1 vehicle');
  assert.equal(formatParamValue(6, 'vehicles', { short: true }), '6');
  assert.equal(formatParamValue(1.5, '×'), '1.5×');
  assert.equal(formatParamValue(2.25, 'm/s'), '2.25 m/s');
  assert.equal(formatParamValue(135, 's'), '2.3 min');
  assert.equal(formatParamValue(30, ''), '30');
  assert.equal(formatParamValue(NaN, 'm/s'), '–');
  assert.equal(describeValues([2, 3, 4], 'vehicles'), '2, 3, 4 vehicles');
  assert.equal(describeValues([0.5, 1, 1.5], '×'), '0.5×, 1×, 1.5×');
  assert.equal(describeValues([60, 180], 's'), '60 s, 3 min');
  assert.equal(describeValues([1, 2], ''), '1, 2');
});

test('deltas: points for shares, plain difference against zero, percent otherwise, tone says whether the change is wanted', () => {
  assert.deepEqual(deltaVs(metric('throughput'), 100, 114), { text: '+14 %', tone: 'good' });
  assert.deepEqual(deltaVs(metric('throughput'), 100, 90), { text: '−10 %', tone: 'bad' });
  assert.deepEqual(deltaVs(metric('leadMean'), 600, 540), { text: '−10 %', tone: 'good' });
  assert.deepEqual(deltaVs(metric('waitShare'), 10, 18.4), { text: '+8.4 pt', tone: 'bad' });
  assert.deepEqual(deltaVs(metric('deadlocks'), 0, 2), { text: '+2', tone: 'bad' });
  assert.deepEqual(deltaVs(metric('deadlocks'), 0, 0), { text: '±0', tone: 'neutral' });
  assert.deepEqual(deltaVs(metric('throughput'), 100, 100.2), { text: '±0 %', tone: 'neutral' }, 'below half a percent is no change');
  assert.deepEqual(deltaVs(metric('fleetUtilization'), 80, 90), { text: '+10 pt', tone: 'neutral' }, 'a measure without direction is never good or bad');
  assert.equal(deltaVs(metric('throughput'), null, 5), null);
  assert.equal(deltaVs(metric('throughput'), 5, NaN), null);
  assert.equal(deltaVs(metric('throughput'), 8.4, 9.5).text, '+13 %');
  assert.equal(deltaVs(metric('throughput'), 100, 103.4).text, '+3.4 %', 'small changes keep a decimal');
});

test('best and worst per row: direction, ties, noise level, measures without direction', () => {
  assert.deepEqual(markBestWorst([37, 44, 43], 'higher'), { best: [1], worst: [0] });
  assert.deepEqual(markBestWorst([37, 44, 43], 'lower'), { best: [0], worst: [1] });
  assert.deepEqual(markBestWorst([50, 50.2, 50.1], 'higher'), { best: [], worst: [] }, 'differences below 1 % are noise');
  assert.deepEqual(markBestWorst([10, 20], null), { best: [], worst: [] });
  assert.deepEqual(markBestWorst([5, null, 9], 'higher'), { best: [2], worst: [0] });
  assert.deepEqual(markBestWorst([null, 9], 'higher'), { best: [], worst: [] }, 'one value cannot be compared');
  assert.deepEqual(markBestWorst([0, 0, 0], 'lower'), { best: [], worst: [] });
  assert.deepEqual(markBestWorst([0, 1], 'lower'), { best: [0], worst: [1] });
});

// ---- compare.js: the comparison -----------------------------------------------------------------------------------------

test('the comparison table rows follow METRICS, hide what nobody can report and mark best, worst and change', () => {
  const result = comparison([{ name: 'Baseline', tp: 37.6, lead: 2150 }, { name: '7 AGVs', tp: 44, lead: 1800 }, { name: '9 AGVs', tp: 43.7, lead: 1840 }]);
  const model = buildComparison(result);
  assert.deepEqual(model.variants.map((v) => v.label), ['A - Baseline', 'B - 7 AGVs', 'C - 9 AGVs']);
  assert.equal(model.repetitions, 3);
  const ids = model.rows.map((r) => r.metric.id);
  assert.deepEqual(ids, METRICS.map((m) => m.id).filter((id) => ['throughput', 'leadMean', 'waitShare', 'deadlocks'].includes(id)), 'METRICS order, only measures with data');
  assert.ok(model.missing.some((m) => m.id === 'minBattery'), 'what nobody could report is listed');
  const tp = model.rows.find((r) => r.metric.id === 'throughput');
  assert.deepEqual(tp.cells.map((c) => c.text), ['37.6', '44.0', '43.7']);
  assert.deepEqual(tp.cells.map((c) => [c.best, c.worst]), [[false, true], [true, false], [false, false]]);
  assert.equal(tp.cells[0].delta, null, 'the first variant is the reference');
  assert.deepEqual(tp.cells[1].delta, { text: '+17 %', tone: 'good' });
  assert.equal(tp.cells[0].range, '36.6–38.6', 'lowest to highest over the repetitions');
  const lead = model.rows.find((r) => r.metric.id === 'leadMean');
  assert.equal(lead.scale.unit, 'min', 'lead times are shown in minutes');
  assert.deepEqual(lead.cells.map((c) => c.text), ['35.8', '30.0', '30.7']);
  assert.deepEqual(lead.cells.map((c) => c.best), [false, true, false]);
  const dead = model.rows.find((r) => r.metric.id === 'deadlocks');
  assert.deepEqual(dead.cells.map((c) => c.best || c.worst), [false, false, false], 'equal values mark nothing');
});

test('a single run shows no range, and a measure that is null for one variant stays an en dash', () => {
  const result = comparison([{ name: 'A', tp: 10, summary: { leadMean: stat(null, null, null, 0) } }, { name: 'B', tp: 12 }], { duration: 3600, warmup: 0, replications: 1 });
  result.variants[0].summary.throughput = stat(10, 10, 10, 1);
  const model = buildComparison(result);
  assert.equal(model.rows[0].cells[0].range, '');
  const lead = model.rows.find((r) => r.metric.id === 'leadMean');
  assert.equal(lead.cells[0].text, '–');
  assert.equal(lead.cells[0].delta, null);
  assert.equal(lead.cells[1].delta, null, 'no change against an unknown reference');
});

test('the headline says what the best variant does against the first', () => {
  const v = (...tps) => tps.map((tp, i) => ({ label: variantParts(['Baseline', 'Aisles', 'Third'][i], i).label, summary: { throughput: stat(tp), leadMean: stat(600) } }));
  assert.equal(headline(v(100, 114)), 'B - Aisles delivers 14 % more per hour than A - Baseline.');
  assert.equal(headline(v(100, 114.04, 90)), 'B - Aisles delivers 14 % more per hour than A - Baseline.');
  assert.equal(headline(v(100, 101.5)), 'B - Aisles delivers 1.5 % more per hour than A - Baseline.');
  assert.match(headline(v(100, 100.4)), /^All variants deliver about the same per hour/);
  assert.equal(headline(v(100, 90)), 'No variant beats A - Baseline, which delivers 100 loads per hour. B - Aisles is 10 % behind.');
  assert.equal(headline(v(100, 100.5, 70)), 'No variant beats A - Baseline, which delivers 100 loads per hour. C - Third is 30 % behind.', 'a variant within noise of the reference is not a winner');
  assert.equal(headline(v(0, 20)), 'B - Aisles delivers 20 loads per hour; A - Baseline delivers none.');
  assert.match(headline(v(0, 0)), /^Nothing was delivered/);
  assert.equal(headline(v(100)), '');
  assert.equal(headline([]), '');
});

test('the headline adds the lead time when it differs by 5 % or more', () => {
  const pair = (leadA, leadB) => [
    { label: 'A - Base', summary: { throughput: stat(100), leadMean: stat(leadA) } },
    { label: 'B - New', summary: { throughput: stat(120), leadMean: stat(leadB) } },
  ];
  assert.equal(headline(pair(600, 540)), 'B - New delivers 20 % more per hour than A - Base, with a 10 % shorter mean lead time.');
  assert.equal(headline(pair(600, 720)), 'B - New delivers 20 % more per hour than A - Base, but with a 20 % longer mean lead time.');
  assert.equal(headline(pair(600, 610)), 'B - New delivers 20 % more per hour than A - Base.');
  assert.equal(headline(pair(600, null)), 'B - New delivers 20 % more per hour than A - Base.');
});

test('copy as table: tab-separated, unit column, decimal points, empty for unknown values', () => {
  const model = buildComparison(comparison([{ name: 'Baseline', tp: 37.6, lead: 2150 }, { name: '7 AGVs', tp: 44, summary: { leadMean: stat(null, null, null, 0) } }]));
  const lines = comparisonTsv(model).split('\n');
  assert.equal(lines[0], 'Measure\tUnit\tA - Baseline\tB - 7 AGVs');
  assert.equal(lines[1], 'Throughput\tloads/h\t37.6\t44');
  assert.equal(lines.find((l) => l.startsWith('Mean lead time')), 'Mean lead time\tmin\t35.8\t');
  assert.ok(lines.every((l) => l.split('\t').length === 4), 'every row has the same number of columns');
});

// ---- compare.js: sweeps -------------------------------------------------------------------------------------------------

test('range values: the grid, the current value merged in, and every way to get it wrong explained', () => {
  assert.deepEqual(rangeValues(2, 6, 1), { values: [2, 3, 4, 5, 6], error: null });
  assert.deepEqual(rangeValues(0.5, 2, 0.25).values, [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
  assert.deepEqual(rangeValues(0.1, 0.5, 0.1).values, [0.1, 0.2, 0.3, 0.4, 0.5], 'no float noise');
  assert.deepEqual(rangeValues(2, 10, 4, 5).values, [2, 5, 6, 10], 'the value in use is always tested when it lies in the range');
  assert.deepEqual(rangeValues(2, 10, 4, 6).values, [2, 6, 10]);
  assert.deepEqual(rangeValues(2, 10, 4, 12).values, [2, 6, 10], 'but not when it lies outside');
  assert.deepEqual(rangeValues(5, 5, 1).values, [5]);
  assert.match(rangeValues(1, 10, 0).error, /greater than zero/);
  assert.match(rangeValues(1, 10, -1).error, /greater than zero/);
  assert.match(rangeValues(10, 1, 1).error, /must not be below/);
  assert.match(rangeValues(NaN, 1, 1).error, /Enter a number/);
  assert.match(rangeValues(1, 100, 1).error, /100 values.*at most 25/);
  assert.equal(rangeValues(1, 25, 1).values.length, LIMITS.sweepPoints);
  assert.deepEqual(rangeValues(1, 100, 1).values, []);
});

test('the recommendation names the smallest value that is within 5 % of the best', () => {
  const pts = (means, from = 1) => means.map((mean, i) => ({ value: from + i, mean }));
  const higher = metric('throughput');
  assert.deepEqual(recommendSweep(pts([20, 30, 38, 43, 44, 43.9, 44]), higher, 'vehicles'), {
    text: 'Throughput stops improving beyond 4 vehicles: from there it is within 5 % of the best result.', best: 5, reach: 4,
  });
  assert.equal(recommendSweep(pts([20, 30, 38, 43]), higher, 'vehicles').text, 'Throughput is still improving at 4 vehicles, the highest value tested. Try a wider range.');
  assert.equal(recommendSweep(pts([44, 30, 20]), higher, 'vehicles').text, 'Throughput is best at 1 vehicle, the lowest value tested. Try a wider range.');
  assert.equal(recommendSweep(pts([20, 44, 20]), higher, 'vehicles').text, 'Throughput is best at 2 vehicles; higher values make it worse.');
  assert.equal(recommendSweep(pts([20, 44, 43.5, 44]), higher, 'vehicles').text, 'Throughput stops improving beyond 2 vehicles: from there it is within 5 % of the best result.', 'a plateau after the first good value');
  assert.equal(recommendSweep(pts([20, 42, 44, 30]), higher, 'vehicles').text, 'Throughput is best at 3 vehicles; higher values make it worse.', 'a later drop is not a plateau');
  assert.equal(recommendSweep(pts([30, 30.1, 30.2]), higher, 'vehicles').text, 'Throughput hardly changes across these values.');
  assert.match(recommendSweep(pts([30, null, null]), higher, 'vehicles').text, /Not enough results/);
  // lower is better: lead time falls with the number of vehicles until it flattens
  const lead = recommendSweep(pts([3300, 2000, 1900, 1860, 1890]), metric('leadMean'), 'vehicles');
  assert.equal(lead.text, 'Mean lead time stops improving beyond 3 vehicles: from there it is within 5 % of the best result.');
  assert.deepEqual([lead.best, lead.reach], [4, 3]);
  assert.equal(recommendSweep(pts([3300, 2216, 1860, 1890, 1924]), metric('leadMean'), 'vehicles').text, 'Mean lead time stops improving beyond 3 vehicles: from there it is within 5 % of the best result.');
  // a measure without a good direction gets no verdict
  const util = recommendSweep(pts([90, 70, 50]), metric('fleetUtilization'), 'vehicles');
  assert.match(util.text, /no better or worse direction/);
  assert.deepEqual([util.best, util.reach], [null, null]);
  // the smallest value counts even if the order of the points is shuffled, and a zero best does not divide by zero
  assert.equal(recommendSweep([{ value: 4, mean: 44 }, { value: 2, mean: 38 }, { value: 3, mean: 43.5 }, { value: 1, mean: 20 }], higher, 'vehicles').reach, 3);
  assert.deepEqual(recommendSweep(pts([5, 2, 0, 0]), metric('deadlocks'), 'vehicles').reach, 3);
});

test('the sweep model marks the best point, the value in use and the change against it', () => {
  const result = sweepResult([21.2, 30.1, 37.6, 43.8, 44.0, 43.8], { values: [3, 4, 5, 6, 7, 8], current: 5 });
  const model = buildSweep(result, 'throughput');
  assert.deepEqual(model.rows.map((r) => r.valueText), ['3 vehicles', '4 vehicles', '5 vehicles', '6 vehicles', '7 vehicles', '8 vehicles']);
  assert.deepEqual(model.rows.map((r) => r.current), [false, false, true, false, false, false]);
  assert.deepEqual(model.rows.map((r) => r.best), [false, false, false, false, true, false]);
  assert.equal(model.rows[2].delta, null, 'the value in use is the reference');
  assert.deepEqual(model.rows[0].delta, { text: '−44 %', tone: 'bad' });
  assert.deepEqual(model.rows[3].delta, { text: '+16 %', tone: 'good' });
  assert.equal(model.rows[0].range, '19.2–23.2');
  assert.equal(model.recommendation.reach, 6);
  assert.match(model.recommendation.text, /^Throughput stops improving beyond 6 vehicles/);
  const lead = buildSweep(result, 'leadMean');
  assert.equal(lead.metric.id, 'leadMean');
  assert.equal(lead.scale.unit, 'min');
  assert.equal(buildSweep(result, 'nonsense').metric.id, 'throughput', 'an unknown measure falls back to the first');
  const tsv = sweepTsv(result, model).split('\n');
  assert.equal(tsv[0], 'AGV: number of vehicles (vehicles)\tThroughput (loads/h)\tLowest\tHighest');
  assert.equal(tsv[1], '3\t21.2\t19.2\t23.2');
});

test('the sweep series are what the chart and the report picture draw', () => {
  const model = buildSweep(sweepResult([10, 30, 20], { values: [1, 2, 3] }), 'throughput');
  const series = sweepSeries(sweepResult([10, 30, 20], { values: [1, 2, 3] }), model);
  assert.deepEqual(series.x, [1, 2, 3]);
  assert.deepEqual(series.y, [10, 30, 20]);
  assert.deepEqual(series.lo, [8, 28, 18]);
  assert.deepEqual(series.hi, [12, 32, 22]);
  assert.equal(series.bestIndex, 1);
  const single = sweepSeries(sweepResult([10, 30], { replications: 1 }), buildSweep(sweepResult([10, 30], { replications: 1 }), 'throughput'));
  assert.equal(single.lo, null, 'no band for a single run');
});

// ---- compare.js: results in memory --------------------------------------------------------------------------------------

/** A store holding a project of two scenarios built from the starter example. */
function twoVariantStore() {
  const store = createStore({ storage: undefined });
  store.newProject(EXAMPLES[0].build());
  store.addScenario('Third AGV', null);
  store.commit('More vehicles', (d) => updateFleet(d, d.fleets[0].id, { count: 3 }));
  store.switchScenario(store.getState().project.scenarios[0].id);
  return store;
}

test('a result is stale when a variant changed in a way the simulation notices, not when it was only renamed', () => {
  const store = twoVariantStore();
  const { scenarios } = store.getState().project;
  const run = comparison(scenarios.map((s) => ({ name: s.name, tp: 10, layout: s.layout })));
  run.variants.forEach((v, i) => { v.id = scenarios[i].id; });
  assert.equal(resultStaleness(run, store.getState()), null);
  store.commit('Rename the plant', (d) => setName(d, 'Another name'));
  assert.equal(resultStaleness(run, store.getState()), null, 'cosmetic changes do not matter');
  store.commit('Add a label', (d) => addLabel(d, { x: 2, y: 2, text: 'Hello' }));
  assert.equal(resultStaleness(run, store.getState()), null);
  store.commit('Demand up', (d) => updateSettings(d, { demandFactor: 1.5 }));
  assert.equal(resultStaleness(run, store.getState()).reason, 'changed', 'a runtime setting changes the results');
  store.undo();
  store.undo();
  store.undo();
  assert.equal(resultStaleness(run, store.getState()), null, 'undoing brings the result back to date');
  store.commit('More vehicles', (d) => updateFleet(d, d.fleets[0].id, { count: 4 }));
  const stale = resultStaleness(run, store.getState());
  assert.equal(stale.reason, 'changed');
  assert.match(stale.text, /^A was changed after this comparison ran/);
  store.deleteScenario(scenarios[1].id);
  assert.equal(resultStaleness(run, store.getState()).reason, 'removed');
  assert.equal(resultStaleness(null, store.getState()), null);
});

test('a sweep belongs to the variant it ran on', () => {
  const store = twoVariantStore();
  const state = store.getState();
  const result = sweepResult([1, 2, 3], { layout: state.layout });
  result.scenarioId = state.project.activeId;
  result.scenarioName = 'A';
  assert.equal(resultStaleness(result, state), null);
  store.switchScenario(state.project.scenarios[1].id);
  assert.equal(resultStaleness(result, store.getState()).reason, 'other');
});

test('applying a sweep value, undoing it or editing the setting by hand does not date the sweep; changing anything else does', () => {
  const store = createStore({ storage: undefined });
  store.newProject(EXAMPLES[0].build());
  const start = store.getState();
  const param = listSweepParameters(start.layout).find((p) => p.key === 'fleet.v1.count');
  const result = { ...sweepResult([10, 20, 30, 30], { values: [1, 2, 3, 4], current: 2, layout: start.layout }), param, scenarioId: start.project.activeId };
  assert.equal(resultStaleness(result, start), null);
  store.commit('Apply', (d) => { const next = param.apply(d, 4); for (const key of Object.keys(next)) d[key] = next[key]; });
  assert.equal(store.getState().layout.fleets[0].count, 4);
  assert.equal(resultStaleness(result, store.getState()), null, 'the sweep covers every value of that setting');
  store.commit('By hand', (d) => updateFleet(d, d.fleets[0].id, { count: 9 }));
  assert.equal(resultStaleness(result, store.getState()), null);
  store.commit('Another setting', (d) => updateFleet(d, d.fleets[0].id, { speed: 3 }));
  assert.equal(resultStaleness(result, store.getState()).reason, 'changed');
  store.undo();
  assert.equal(resultStaleness(result, store.getState()), null, 'undoing the other change brings it back');
  store.commit('The fleet is gone', (d) => { d.fleets.length = 0; });
  assert.equal(resultStaleness(result, store.getState()).reason, 'changed');
});

test('the value in use marks its row and is the reference of the changes', () => {
  const result = sweepResult([21, 30, 38, 44], { values: [3, 4, 5, 6], current: 3 });
  assert.deepEqual(buildSweep(result, 'throughput').rows.map((r) => r.current), [true, false, false, false], 'the value the sweep ran with by default');
  const model = buildSweep(result, 'throughput', 5);
  assert.deepEqual(model.rows.map((r) => r.current), [false, false, true, false]);
  assert.equal(model.current, 5);
  assert.deepEqual(model.rows[0].delta, { text: '−45 %', tone: 'bad' });
  assert.equal(model.rows[2].delta, null);
  const nowhere = buildSweep(result, 'throughput', 99);
  assert.ok(nowhere.rows.every((r) => !r.current), 'a value outside the tested ones marks no row');
  assert.equal(nowhere.rows[0].delta, null, 'the first value is the reference then');
  assert.equal(buildSweep(result, 'throughput', null).current, null);
});

test('nothing has run yet: no results, and the accessor hands out a plain object', () => {
  assert.deepEqual(getLastResults(), { compare: null, sweep: null });
});

test('estimated time left reads like a person would say it', () => {
  assert.equal(formatEta(2), 'a few seconds left');
  assert.equal(formatEta(12), 'about 10 s left');
  assert.equal(formatEta(47), 'about 45 s left');
  assert.equal(formatEta(300), 'about 5 min left');
  assert.equal(formatEta(NaN), '');
});

test('real runs feed the model: a short comparison of two real variants gives a table and a headline', async () => {
  const base = EXAMPLES[0].build();
  const more = structuredClone(base);
  updateFleet(more, more.fleets[0].id, { count: 4 });
  const results = [];
  for (const layout of [base, more]) results.push(await runReplications(layout, { duration: 1200, warmup: 120, replications: 2 }));
  const result = comparison([{ name: 'Baseline', tp: 0 }, { name: 'More AGVs', tp: 0 }]);
  result.variants.forEach((v, i) => { v.summary = results[i].summary; });
  const model = buildComparison(result);
  assert.ok(model.rows.length >= 8);
  assert.ok(model.rows.every((r) => r.cells.every((c) => typeof c.text === 'string' && !c.text.includes('NaN'))));
  assert.ok(headline(result.variants).length > 10);
  assert.ok(comparisonTsv(model).includes('Throughput'));
});

// ---- report.js: safe markup ---------------------------------------------------------------------------------------------

test('the html tag escapes every interpolated value, in text and in attributes', () => {
  const out = String(html`<p title="${HOSTILE}">${HOSTILE}</p>`);
  assert.ok(!out.includes('<script'), out);
  assert.ok(!out.includes('<img'), out);
  assert.ok(!/title="[^"]*"[^>]*"/.test(out.replace(/&quot;/g, '')), 'the quote cannot close the attribute');
  assert.ok(out.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(out.startsWith('<p title="') && out.endsWith('</p>'));
});

test('html passes its own results through, joins arrays and drops null, false and undefined, but prints 0', () => {
  const inner = html`<b>${'a&b'}</b>`;
  assert.equal(String(html`<i>${inner}</i>`), '<i><b>a&amp;b</b></i>');
  assert.equal(String(html`<ul>${['x', 'y'].map((v) => html`<li>${v}</li>`)}</ul>`), '<ul><li>x</li><li>y</li></ul>');
  assert.equal(String(html`[${null}${undefined}${false}${0}]`), '[0]');
  assert.equal(String(html`${raw('<hr>')}`), '<hr>');
  assert.equal(String(html`${'<hr>'}`), '&lt;hr&gt;', 'plain strings are never trusted');
});

// ---- report.js: readable parameters -------------------------------------------------------------------------------------

test('time distributions and breakdowns are described in words', () => {
  assert.equal(describeDist({ kind: 'normal', mean: 60, spread: 0.1 }), '60 s on average, ±10 % (bell curve)');
  assert.equal(describeDist({ kind: 'const', mean: 120, spread: 0 }), '2 min (constant)');
  assert.equal(describeDist({ kind: 'exp', mean: 180, spread: 0 }), '3 min on average (random, exponential)');
  assert.equal(describeDist({ kind: 'uniform', mean: 100, spread: 0.2 }), '80 s to 2 min (evenly spread)');
  assert.equal(describeDist(null), '–');
  assert.equal(describeBreakdowns(0, 0), 'none');
  assert.equal(describeBreakdowns(14400, 1200), 'every 4 h on average, repaired in 20 min');
  assert.equal(stationTypeName('source'), 'Goods in');
  assert.equal(stationTypeName('process'), 'Workstation');
  assert.equal(stationTypeName('ufo'), 'ufo');
});

test('every station type lists its parameters with units', () => {
  const layout = EXAMPLES[1].build();
  const byType = (type) => layout.stations.find((s) => s.type === type);
  const labels = (s) => stationParams(s).map(([k]) => k);
  assert.deepEqual(labels(byType('source')), ['Time between arrivals', 'Loads per arrival', 'Output buffer', 'First arrival']);
  assert.deepEqual(labels(byType('process')), ['Cycle time', 'Parallel machines', 'Loads produced per cycle', 'Input slots', 'Output slots', 'Breakdowns']);
  assert.deepEqual(labels(byType('storage')), ['Capacity', 'Minimum stay']);
  assert.deepEqual(labels(byType('depot')), ['Parking places', 'of them with a charger']);
  assert.deepEqual(stationParams(byType('sink')), []);
  for (const s of layout.stations) for (const [, v] of stationParams(s)) assert.ok(typeof v === 'string' && v.length > 0 && !v.includes('undefined') && !v.includes('NaN'), `${s.name}: ${v}`);
  assert.equal(stationParams({ type: 'storage', params: { capacity: 1, dwell: 90 } })[0][1], '1 load');
});

test('flows read as from, to, share, loads per cycle, batch, wait, priority and vehicles', () => {
  const layout = createLayout();
  const a = addStation(layout, { type: 'source', name: 'Goods in', x: 2, y: 2 });
  const b = addStation(layout, { type: 'process', name: 'Press', x: 8, y: 2 });
  const c = addStation(layout, { type: 'sink', name: 'Shipping', x: 14, y: 2 });
  const fleet = addFleet(layout, 'forklift', { name: 'Forklifts' });
  addFlow(layout, a.id, b.id, { weight: 3, perCycle: 2, batchMin: 2, batchMax: 4, maxWait: 120, priority: 3, fleetId: fleet.id });
  addFlow(layout, a.id, c.id, { weight: 1 });
  addFlow(layout, b.id, c.id);
  assert.deepEqual(flowCells(layout.flows[0], layout), ['Goods in', 'Press', '75 %', '2', '2 to 4 loads', '2 min', 'Urgent', 'Forklifts']);
  assert.deepEqual(flowCells(layout.flows[1], layout), ['Goods in', 'Shipping', '25 %', '1', '1 to vehicle capacity', '–', 'Normal', 'Any fleet']);
  assert.equal(flowCells(layout.flows[2], layout)[2], 'all', 'a single outgoing flow takes everything');
  assert.equal(flowCells({ ...layout.flows[2], from: 'gone' }, layout)[0], 'Unknown station');
  assert.equal(flowCells({ ...layout.flows[2], fleetId: 'gone' }, layout)[7], 'Unknown fleet');
});

test('fleets and settings are described in readable units', () => {
  const layout = createLayout();
  const depot = addStation(layout, { type: 'depot', name: 'Parking', x: 2, y: 2 });
  const fleet = addFleet(layout, 'agv', { name: 'AGVs', home: depot.id, battery: { enabled: true, runtimeMin: 480, chargeTimeMin: 90 }, mtbf: 7200, mttr: 600 });
  const params = Object.fromEntries(fleetParams(fleet, layout));
  assert.equal(params['Top speed'], '1.5 m/s (5.4 km/h)');
  assert.equal(params['Acceleration / braking'], '0.6 / 1 m/s²');
  assert.equal(params.Capacity, '1 load');
  assert.equal(params['Loading / unloading'], '12 s / 12 s');
  assert.match(params.Battery, /^8 h runtime, 1\.5 h to charge; goes charging below 25 %, back to work at 90 %$/);
  assert.equal(params.Breakdowns, 'every 2 h on average, repaired in 10 min');
  assert.equal(params['Home depot'], 'Parking');
  assert.equal(params['When idle'], 'parks in a depot');
  assert.equal(Object.fromEntries(fleetParams({ ...fleet, battery: { enabled: false }, home: null, idle: 'stay' }, layout)).Battery, 'not modelled');
  updateSettings(layout, { demandFactor: 1.25, duration: 4 * 3600, handedness: 'left' });
  const s = Object.fromEntries(settingsRows(layout.settings));
  assert.equal(s['Run length of an experiment'], '4 h');
  assert.equal(s.Demand, '1.25×');
  assert.equal(s.Traffic, 'Left-hand');
  assert.equal(s.Dispatching, 'Nearest job first');
  assert.equal(s.Routing, 'Shortest path');
  assert.equal(s.Deadlocks.startsWith('Resolved automatically'), true);
});

test('the plant at a glance counts what is there', () => {
  const layout = EXAMPLES[1].build();
  const rows = Object.fromEntries(plantRows(layout));
  assert.match(rows['Floor area'], /^\d+ × \d+ m \([\d,]+ m²\), grid of \d+ × \d+ cells of [\d.]+ m$/);
  assert.match(rows['Road network'], /^[\d.]+ (m|km) \([\d,]+ cells\)$/);
  assert.match(rows.Stations, new RegExp(`^${layout.stations.length}: .*goods in`));
  assert.equal(rows['Material flows'], String(layout.flows.length));
  assert.match(rows.Vehicles, /^\d+ in 2 fleets$/);
  assert.equal(Object.fromEntries(plantRows(createLayout())).Stations, 'none');
});

test('file names are safe and tell what is inside', () => {
  assert.equal(slug('Plant 1 / East <wing>'), 'plant-1-east-wing');
  assert.equal(slug('  '), 'plant');
  assert.equal(slug('Ärger über Öl'), 'arger-uber-ol');
  assert.equal(slug('Große Halle'), 'grosse-halle');
  assert.equal(slug('x'.repeat(100)).length, 40);
  assert.equal(slug('', 'logiplan-project'), 'logiplan-project');
  assert.equal(reportFileName('Starter plant', new Date(2026, 9, 8)), 'logiplan-report-starter-plant-2026-10-08.html');
  assert.equal(reportFileName('../../etc/passwd', new Date(2026, 0, 2)), 'logiplan-report-etc-passwd-2026-01-02.html');
});

test('only PNG data URLs are accepted as the layout picture', () => {
  assert.equal(pngBytes(PNG).length, 70);
  assert.deepEqual([...pngBytes(PNG).slice(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  for (const bad of ['', null, undefined, 'data:image/svg+xml;base64,PHN2Zz4=', 'javascript:alert(1)', 'data:image/png;base64,AAA"onerror="x', 'data:text/html;base64,PHNjcmlwdD4=', 'https://example.com/x.png', 'data:image/png;base64,']) {
    assert.equal(pngBytes(bad), null, String(bad));
  }
});

test('the measurement note tells a warming-up or short run from a usable one', () => {
  assert.equal(measurementNote({ window: { warmingUp: true, duration: 0 } }).level, 'warming');
  assert.match(measurementNote({ window: { warmingUp: true } }).text, /not representative/);
  assert.equal(measurementNote({ window: { warmingUp: false, duration: 120 } }).level, 'short');
  assert.match(measurementNote({ window: { duration: 120 } }).text, /Only 2 min of operation/);
  assert.equal(measurementNote({ window: { duration: 1800 } }).level, 'indicative');
  assert.equal(measurementNote({ window: { duration: 7200 } }).level, 'ok');
  assert.equal(measurementNote(null).level, 'short');
});

test('the SVG pictures escape their labels and survive missing data', () => {
  const bars = String(svgBars([{ label: HOSTILE, value: 10, mark: 'best' }, { label: 'B', value: null }, { label: 'C', value: 5, mark: 'worst' }], { unit: 'loads/h', digits: 1, title: HOSTILE }));
  assert.ok(!bars.includes('<script') && !bars.includes('<img'), bars);
  assert.ok(bars.includes('✓ best') && bars.includes('! worst'));
  assert.ok(bars.startsWith('<svg') && bars.includes('role="img"'));
  assert.ok(!bars.includes('NaN') && !bars.includes('undefined'));
  const series = { x: [1, 2, 3], y: [10, null, 30], lo: [8, null, 28], hi: [12, null, 32], bestIndex: 2 };
  const line = String(svgLine(series, { xLabel: HOSTILE, yLabel: 'y', xText: (v) => `${v}<`, yText: (v) => String(v), current: 2, title: 'chart' }));
  assert.ok(!line.includes('<script') && !line.includes('<img'), line);
  assert.ok(!line.includes('NaN'), 'a gap in the data does not break the picture');
  assert.ok(line.includes('now'));
  assert.ok(String(svgBars([], { title: 't' })).startsWith('<svg'));
});

// ---- report.js: the document --------------------------------------------------------------------------------------------

/** A project whose every user-visible text is hostile. */
function hostileStore() {
  const layout = createLayout({ name: HOSTILE, cols: 24, rows: 12, cellSize: 2 });
  setNotes(layout, `${HOSTILE}\nsecond line`);
  const a = addStation(layout, { type: 'source', name: HOSTILE, x: 2, y: 2 });
  const b = addStation(layout, { type: 'process', name: `${HOSTILE} 2`, x: 10, y: 2 });
  const c = addStation(layout, { type: 'sink', name: '</td><script>x()</script>', x: 17, y: 2 });
  paintRoadPath(layout, [[3, 5], [20, 5]]);
  addFlow(layout, a.id, b.id);
  addFlow(layout, b.id, c.id);
  addFleet(layout, 'agv', { name: HOSTILE, count: 2 });
  const store = createStore({ storage: undefined });
  store.loadProject({ name: HOSTILE, scenarios: [{ id: 'sc1', name: HOSTILE, layout }, { id: 'sc2', name: 'Other', layout }], activeId: 'sc1' });
  return store;
}

function fakeCtx(store, { sim = null, picture = PNG, issues } = {}) {
  return {
    store,
    runner: { sim, kpis: () => (sim ? sim.kpis() : null), insights: () => (sim ? sim.insights() : []) },
    renderer: { sim, toDataURL: () => picture },
    issues: issues || (() => validateLayout(store.getState().layout)),
    toast() {},
  };
}

/** Every tag name that appears in a document. */
const tagNames = (doc) => new Set([...doc.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase()));
const ALLOWED_TAGS = new Set(['html', 'head', 'meta', 'title', 'style', 'body', 'div', 'span', 'p', 'h1', 'h2', 'h3', 'b', 'i', 'strong', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'dl', 'dt', 'dd',
  'ul', 'li', 'figure', 'figcaption', 'img', 'footer', 'svg', 'title', 'rect', 'text', 'line', 'polyline', 'polygon', 'circle']);

test('hostile names anywhere in the plant never reach the markup of the report', async () => {
  const store = hostileStore();
  const sim = new Simulation(store.getState().layout);
  sim.advance(900);
  const doc = exportReportHtml(fakeCtx(store, { sim }), { now: new Date(2026, 9, 8, 14, 5) });
  assert.ok(doc.startsWith('<!doctype html>'));
  assert.ok(!/<script/i.test(doc), 'no script element');
  assert.ok(!/<iframe|<object|<embed|<link|<base|<form|<a /i.test(doc), 'nothing that loads or navigates');
  const tags = doc.match(/<[a-zA-Z][^>]*>/g);
  assert.ok(tags.every((tag) => !/\son[a-z]+\s*=/i.test(tag.replace(/="[^"]*"/g, '=""'))), 'no event-handler attributes');
  assert.ok(doc.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the text is still there, escaped');
  const bad = [...tagNames(doc)].filter((t) => !ALLOWED_TAGS.has(t));
  assert.deepEqual(bad, [], 'only the tags the report itself writes');
  assert.equal([...doc.matchAll(/<img /g)].length, 1, 'exactly the layout picture');
  assert.ok(!/(?:src|href)\s*=\s*["']?https?:/i.test(doc) && !/url\(\s*["']?https?:/i.test(doc), 'no external request');
  assert.ok(!/https?:\/\//i.test(doc), 'not even a link');
});

test('the report is a complete self-contained document with the parts a planner expects', () => {
  const store = createStore({ storage: undefined });
  store.newProject(EXAMPLES[1].build());
  const sim = new Simulation(store.getState().layout);
  sim.advance(3 * 3600);
  const doc = exportReportHtml(fakeCtx(store, { sim }), { now: new Date(2026, 9, 8, 14, 5) });
  for (const part of ['<html lang="en">', '<meta charset="utf-8">', '@page { size: A4', 'print-color-adjust', '8 October 2026', 'Generated with LogiPlan', '<h1>', 'Plant report',
    '<h2>Plant</h2>', '<h2>Results of the simulation</h2>', '<h2>Insights</h2>', '<h2>Assumptions</h2>', '<h3>Stations</h3>', '<h3>Material flows</h3>', '<h3>Vehicle fleets</h3>',
    '<h3>Simulation settings</h3>', '<h2>Checks</h2>', 'Throughput', 'Mean lead time', 'data:image/png;base64,']) {
    assert.ok(doc.includes(part), `missing ${part}`);
  }
  for (const s of sim.layout.stations) assert.ok(doc.includes(s.name.replace(/&/g, '&amp;')), `station ${s.name}`);
  assert.ok(!doc.includes('NaN') && !doc.includes('undefined') && !doc.includes('[object'), 'no unformatted values');
  assert.ok(doc.length < 400000);
});

test('without a simulation the report says so and still lists the assumptions', () => {
  const store = createStore({ storage: undefined });
  store.newProject(EXAMPLES[0].build());
  const doc = exportReportHtml(fakeCtx(store), {});
  assert.ok(doc.includes('No simulation has run in this session yet'));
  assert.ok(!doc.includes('<h2>Insights</h2>'));
  assert.ok(doc.includes('<h3>Stations</h3>') && doc.includes('Goods receiving'));
});

test('a warm-up that is still running and a very short run are called out', () => {
  const store = createStore({ storage: undefined });
  store.newProject(EXAMPLES[0].build());
  const early = new Simulation(store.getState().layout);
  early.advance(60);
  assert.ok(exportReportHtml(fakeCtx(store, { sim: early }), {}).includes('still in its warm-up phase'));
  store.commit('No warm-up', (d) => updateSettings(d, { warmup: 0 }));
  const shortRun = new Simulation(store.getState().layout);
  shortRun.advance(120);
  assert.match(exportReportHtml(fakeCtx(store, { sim: shortRun }), {}), /Only 2 min of operation have been measured/);
});

test('a picture that is not a PNG is left out, and a missing renderer does not break the report', () => {
  const store = createStore({ storage: undefined });
  store.newProject(EXAMPLES[0].build());
  for (const picture of ['', 'javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=']) {
    const doc = exportReportHtml(fakeCtx(store, { picture }), {});
    assert.ok(!doc.includes('<img'), picture);
  }
  const ctx = fakeCtx(store);
  delete ctx.renderer;
  assert.ok(exportReportHtml(ctx, {}).includes('<h1>'));
});

test('the layout picture shows the plant without vehicles unless the heatmap is on, and restores the simulation afterwards', () => {
  const store = createStore({ storage: undefined });
  store.newProject(EXAMPLES[0].build());
  const sim = new Simulation(store.getState().layout);
  const seen = [];
  const ctx = fakeCtx(store, { sim });
  ctx.renderer.toDataURL = function toDataURL(opts) { seen.push({ sim: this.sim, opts }); return PNG; };
  exportReportHtml(ctx, {});
  assert.equal(seen[0].sim, null, 'vehicles are not in the picture');
  assert.equal(seen[0].opts.theme, 'light', 'the report is always light');
  assert.equal(ctx.renderer.sim, sim, 'the renderer has its simulation back');
  store.setUi({ overlays: { heat: 'traffic' } });
  exportReportHtml(ctx, {});
  assert.equal(seen[1].sim, sim, 'with the heatmap on, the simulation stays attached');
  assert.match(exportReportHtml(ctx, {}), /with the traffic heatmap/);
});

test('the issues of the plant are listed with their advice', () => {
  const store = createStore({ storage: undefined });
  store.newProject(createLayout({ name: 'Empty' }));
  const doc = exportReportHtml(fakeCtx(store), {});
  const issues = validateLayout(store.getState().layout);
  assert.ok(issues.length > 0);
  assert.ok(doc.includes('<h2>Checks</h2>'));
  assert.ok(doc.includes(issues[0].message.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;')));
  const clean = exportReportHtml(fakeCtx(store, { issues: () => [] }), {});
  assert.ok(clean.includes('No problems were found in the plant.'));
});

test('comparison and sweep results go into the report, with a warning when the plant changed since', () => {
  const store = twoVariantStore();
  const { scenarios } = store.getState().project;
  const compare = comparison(scenarios.map((s, i) => ({ name: s.name, tp: [37.6, 44][i], layout: s.layout })));
  compare.variants.forEach((v, i) => { v.id = scenarios[i].id; });
  const sweep = sweepResult([21, 30, 38, 44, 44.2, 43.9], { values: [3, 4, 5, 6, 7, 8], current: 5, layout: store.getState().layout });
  sweep.scenarioId = store.getState().project.activeId;
  const ctx = fakeCtx(store);
  const doc = exportReportHtml(ctx, { results: { compare, sweep } });
  assert.ok(doc.includes('<h2>Experiments</h2>'));
  assert.ok(doc.includes('Comparison of variants'));
  assert.ok(doc.includes(headline(compare.variants)));
  assert.ok(doc.includes('Parameter sweep: AGV: number of vehicles'));
  assert.ok(doc.includes('Throughput stops improving beyond 6 vehicles'));
  assert.ok(doc.includes('class="chart"') && doc.includes('<polyline'), 'a picture of the sweep');
  assert.ok(doc.includes('✓'), 'best is marked in text, not only in colour');
  assert.ok(!doc.includes('out of date') && !doc.includes('was changed after'));
  store.commit('More vehicles', (d) => updateFleet(d, d.fleets[0].id, { count: 6 }));
  const later = exportReportHtml(ctx, { results: { compare, sweep } });
  assert.ok(later.includes('was changed after this comparison ran'));
  assert.ok(later.includes('The plant was changed after this sweep ran'));
  assert.ok(!exportReportHtml(ctx, { results: { compare, sweep }, includeComparison: false }).includes('<h2>Experiments</h2>'));
  assert.ok(!exportReportHtml(ctx, { results: { compare: null, sweep: null } }).includes('<h2>Experiments</h2>'));
});

test('hostile variant and parameter names stay inert in the experiments section', () => {
  const store = hostileStore();
  const { scenarios } = store.getState().project;
  const compare = comparison(scenarios.map((s, i) => ({ name: s.name, tp: [30, 40][i], layout: s.layout })));
  compare.variants.forEach((v, i) => { v.id = scenarios[i].id; });
  const sweep = sweepResult([1, 2, 3], { layout: store.getState().layout });
  sweep.param.label = `${HOSTILE}: number`;
  const doc = exportReportHtml(fakeCtx(store), { results: { compare, sweep } });
  assert.ok(!/<script/i.test(doc));
  assert.deepEqual([...tagNames(doc)].filter((t) => !ALLOWED_TAGS.has(t)), []);
});

test('kpi tiles quote the numbers of a real report', () => {
  const layout = EXAMPLES[0].build();
  const sim = new Simulation(layout);
  sim.advance(2 * 3600);
  const tiles = kpiTiles(sim.kpis());
  assert.deepEqual(tiles.map((t) => t[0]), ['Throughput', 'Mean lead time', 'Lead time, 95th percentile', 'Work in process', 'Fleet utilization', 'Vehicle waiting']);
  assert.ok(tiles[0][1].endsWith('loads/h') && !tiles[0][1].startsWith('–'));
  for (const [, value, small] of tiles) assert.ok(!`${value}${small}`.includes('NaN') && !`${value}${small}`.includes('undefined'));
});

test('every sweep parameter of the examples can be described by the sweep model', () => {
  for (const example of EXAMPLES) {
    const layout = example.build();
    for (const param of listSweepParameters(layout)) {
      const text = describeValues(param.values, param.unit);
      assert.ok(text.length > 0 && !text.includes('NaN'), `${example.id} ${param.key}: ${text}`);
      assert.ok(formatParamValue(param.get(layout), param.unit).length > 0);
    }
  }
});
