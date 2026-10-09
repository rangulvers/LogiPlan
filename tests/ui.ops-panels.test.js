// The pure parts of the panels for trucks and dock doors: the helpers of the inspector section (js/ui/panels/ops-trucks.js), the models of the Doors card
// (js/ui/panels/doors-card.js), the preview of the paste dialog (js/ui/panels/timetable-dialog.js), the clock of the plant settings (js/ui/panels/plant-clock.js)
// and the rows of the HTML report (js/ui/report-ops.js). Every part tolerates a report without `report.ops` (the simulation may not have produced truck figures),
// and no number it prints may be NaN or undefined. The DOM behaviour of the same panels is driven by tests/e2e/doors.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/model/layout.js';
import { defaultTrucks, trucksOf } from '../js/model/ops.js';
import { convertToDoors } from '../js/model/doors.js';
import {
  doorCheckFor, doorFormula, measuredDoorSeconds, nextRow, rateSummary, scheduleWith, scheduleWithout, sectionAside, shippedLine, timetableSummary, toMinutes, toSeconds,
} from '../js/ui/panels/ops-trucks.js';
import { DOOR_BUSY_SHARE, doorModels, seriesValues, waitTone } from '../js/ui/panels/doors-card.js';
import { previewLines, useLabel } from '../js/ui/panels/timetable-dialog.js';
import { parseTimetable } from '../js/ui/panels/timetable-paste.js';
import { DAY_SECONDS, WEEK_SECONDS, runCostText, runPatch, runSpan, runText } from '../js/ui/panels/plant-clock.js';
import { createStore } from '../js/store/store.js';
import { clockRow, doorCheckRow, doorResultRows, truckRows, withTrucks } from '../js/ui/report-ops.js';
import { exportReportHtml, plantRows, stationParams } from '../js/ui/report.js';

function plant() {
  const layout = L.createLayout({ name: 'Doors', cols: 30, rows: 14, cellSize: 2 });
  L.paintRoadPath(layout, [[2, 8], [26, 8]]);
  const src = L.addStation(layout, { type: 'source', name: 'Goods receiving', x: 6, y: 6, w: 3, h: 2, params: { interArrival: { kind: 'const', mean: 180, spread: 0 } } });
  const sink = L.addStation(layout, { type: 'sink', name: 'Dispatch', x: 18, y: 6, w: 3, h: 2 });
  L.addFlow(layout, src.id, sink.id);
  L.addFleet(layout, 'forklift', { count: 2 });
  return { layout, src, sink };
}

/** A plant at the numbers of Appendix A: 6 trucks an hour of 26 pallets, 4 doors. */
function busy() {
  const p = plant();
  L.updateStation(p.layout, p.src.id, { ops: { trucks: { ...defaultTrucks(), doors: 4, interArrival: { kind: 'const', mean: 600, spread: 0 }, pallets: { kind: 'const', mean: 26, spread: 0 } } } });
  L.updateStation(p.layout, p.sink.id, { ops: { trucks: convertToDoors(L.getStation(p.layout, p.sink.id)) } });
  return p;
}

const entry = (over = {}) => ({
  name: 'Goods receiving', role: 'in', doors: 4, trucks: { arrived: 40, docked: 38, departed: 36, short: 0, noShow: 0, turnedAway: 0 }, gateWait: { mean: 1380, p90: 2400, max: 3000 },
  doorTime: { mean: 2940, p90: 3300 }, turnaround: { mean: 4320, p90: 5700 }, doorUtilization: 0.93, gateQueue: { mean: 2.4, max: 7, now: 5 }, doorsBusyNow: 4, fillRate: null,
  gateQueueSeries: [0, 1, 3, 5, 4, 6, 5], ...over,
});

test('inspector helpers: minutes and seconds, the aside, the next row, schedule edits', () => {
  assert.equal(toMinutes(300), 5);
  assert.equal(toMinutes(90), 1.5);
  assert.equal(toSeconds(1.5), 90);
  assert.equal(toSeconds(toMinutes(7200)), 7200);
  assert.equal(sectionAside(null), 'off');
  assert.equal(sectionAside({ ...defaultTrucks(), doors: 1 }), '1 door');
  assert.equal(sectionAside({ ...defaultTrucks(), doors: 3, mode: 'schedule' }), 'timetable · 3 doors');
  assert.deepEqual(nextRow([], defaultTrucks()), { at: 21600, pallets: 24 }, 'an empty table starts at 06:00 with an average truck');
  assert.deepEqual(nextRow([{ at: 21600, pallets: 24 }, { at: 30000, pallets: null }], { pallets: { mean: 18.4 } }), { at: 33600, pallets: 18 }, 'an hour after the last row');
  assert.equal(nextRow([{ at: 86000, pallets: 1 }], defaultTrucks()).at, 86340, 'never past the end of the day');
  const rows = [{ at: 100, pallets: 5 }, { at: 200, pallets: null }];
  assert.deepEqual(scheduleWith(rows, 1, { pallets: 7 }), [{ at: 100, pallets: 5 }, { at: 200, pallets: 7 }]);
  assert.deepEqual(scheduleWithout(rows, 0), [{ at: 200, pallets: null }]);
  assert.deepEqual(rows, [{ at: 100, pallets: 5 }, { at: 200, pallets: null }], 'the stored schedule is never mutated');
});

test('summaries: the rate line and the timetable line', () => {
  assert.equal(rateSummary(defaultTrucks()), 'About 1.3 trucks an hour of 24 pallets: 32 pallets an hour.');
  assert.equal(rateSummary(defaultTrucks(), 0), 'No truck arrives at this demand.');
  assert.equal(rateSummary({ ...defaultTrucks(), mode: 'schedule' }), '', 'a timetable has its own line');
  assert.equal(timetableSummary({ ...defaultTrucks(), mode: 'schedule', schedule: [] }), null);
  const rows = [{ at: 21600, pallets: 24 }, { at: 22200, pallets: 24 }, { at: 25200, pallets: null }, { at: 50000, pallets: 12 }];
  assert.equal(timetableSummary({ ...defaultTrucks(), mode: 'schedule', schedule: rows }), '4 trucks a day, 84 pallets, at most 2 in any hour');
  assert.equal(timetableSummary({ ...defaultTrucks(), mode: 'schedule', schedule: [{ at: 0, pallets: 1 }] }), '1 truck a day, 1 pallet, at most 1 in any hour');
});

test('the door check of the inspector: the numbers of Appendix A, the measured figure after a run, and its arithmetic in one line', () => {
  const { layout, src } = busy();
  const station = L.getStation(layout, src.id);
  const check = doorCheckFor(layout, station, null);
  assert.equal(check.tooFew, true);
  assert.deepEqual([check.parts.need, check.parts.trucks, check.parts.minutes, check.parts.better, check.parts.util], ['4.9', '6', '49', '6', '82']);
  assert.equal(check.action.label, 'Use 6 doors');
  assert.equal(doorFormula(check), '6 trucks an hour × 49 min at a door (5 min + 26 pallets × 90 s + 5 min) = 4.9 doors busy at once');
  assert.equal(doorCheckFor(layout, { ...station, ops: undefined }), null, 'no trucks, no check');

  const report = { ops: { trucks: { [src.id]: entry({ doorTime: { mean: 1800, p90: 2000 } }) } } };
  assert.equal(measuredDoorSeconds(report, src.id), 1800);
  const measured = doorCheckFor(layout, station, report);
  assert.equal(measured.basis, 'measured');
  assert.equal(measured.parts.minutes, '30');
  assert.match(doorFormula(measured), /^6 trucks an hour × 30 min at a door \(measured\) = 3 doors busy at once$/);
  assert.equal(measured.tooFew, false, 'the measured door time says 4 doors are enough');
  assert.equal(measuredDoorSeconds({ ops: { trucks: {} } }, src.id), null);
  assert.equal(measuredDoorSeconds({}, src.id), null);
  assert.equal(measuredDoorSeconds(null, src.id), null);
  assert.equal(measuredDoorSeconds({ ops: { trucks: { [src.id]: entry({ doorTime: { mean: null, p90: null } }) } } }, src.id), null, 'no truck has left yet');
  assert.equal(measuredDoorSeconds({ ops: { trucks: { [src.id]: entry({ trucks: { departed: 0 } }) } } }, src.id), null);
  const empty = doorCheckFor({ ...layout, settings: { ...layout.settings, demandFactor: 0 } }, station, null);
  assert.equal(doorFormula(empty), '', 'nothing to show when no truck arrives');
});

test('a Goods out says what the plant shipped in the last run, against what its trucks can take', () => {
  const { layout, sink } = busy();
  const trucks = trucksOf(L.getStation(layout, sink.id));
  assert.equal(shippedLine(null, { id: sink.id }, trucks), '');
  assert.equal(shippedLine({ throughput: { bySink: {} } }, { id: sink.id }, trucks), '');
  assert.equal(shippedLine({ throughput: { bySink: { [sink.id]: { perHour: 0 } } } }, { id: sink.id }, trucks), '');
  assert.equal(shippedLine({ throughput: { bySink: { [sink.id]: { perHour: 20.46 } } } }, { id: sink.id }, trucks), 'In the last run 20.5 pallets an hour reached this Goods out. The trucks here take up to 48 an hour.');
});

test('Doors card: one model per station with trucks, hidden for a plant without', () => {
  const { layout, src, sink } = busy();
  assert.deepEqual(doorModels(null, plant().layout), [], 'a plant without trucks has no card');
  const models = doorModels(null, layout);
  assert.deepEqual(models.map((m) => m.id), [src.id, sink.id]);
  assert.equal(models[0].has, false, 'no report: the configuration and a note, no numbers');
  assert.match(models[0].note, /no truck figures/);
  assert.ok(models.every((m) => m.metrics.every((x) => !/NaN|undefined/.test(x.value + x.sub))));
  assert.equal(models[0].metrics.find((x) => x.key === 'served').value, '–');
  assert.equal(models[0].role, 'Goods in');
  assert.equal(models[1].role, 'Goods out');
  assert.ok(models[1].metrics.some((x) => x.key === 'short'), 'a Goods out has the trucks that left short');
  assert.ok(!models[0].metrics.some((x) => x.key === 'short'));
  assert.equal(models[0].formula, '6 trucks an hour × 49 min at a door (5 min + 26 pallets × 90 s + 5 min) = 4.9 doors busy at once');
});

test('Doors card: the figures of a report, and a report that is partly empty', () => {
  const { layout, src, sink } = busy();
  const report = {
    ops: {
      trucks: {
        [src.id]: entry(),
        [sink.id]: entry({ name: 'Dispatch', role: 'out', doors: 2, trucks: { arrived: 20, docked: 20, departed: 18, short: 3, noShow: 0, turnedAway: 0 }, fillRate: 0.82, gateWait: { mean: 60, p90: 120, max: 200 }, doorTime: { mean: 2400, p90: 3000 }, doorUtilization: 0.41, gateQueue: { mean: 0, max: 1, now: 0 }, gateQueueSeries: [0, 0, 0] }),
      },
    },
  };
  const [a, b] = doorModels(report, layout);
  const get = (m, key) => m.metrics.find((x) => x.key === key);
  assert.equal(get(a, 'served').value, '36');
  assert.equal(get(a, 'served').sub, '40 arrived');
  assert.equal(get(a, 'gateWait').value, '23 min');
  assert.equal(get(a, 'gateWait').sub, '9 in 10 under 40 min');
  assert.equal(get(a, 'gateWait').tone, 'warn', 'amber from 15 minutes');
  assert.equal(get(a, 'doorTime').value, '49 min');
  assert.equal(get(a, 'queue').value, '5');
  assert.equal(get(a, 'queue').sub, 'most 7');
  assert.equal(a.utilText, '93 %');
  assert.equal(a.busy, true);
  assert.equal(a.busyNow, 4);
  assert.deepEqual(a.series, [0, 1, 3, 5, 4, 6, 5]);
  assert.equal(get(b, 'short').value, '3 of 18');
  assert.equal(get(b, 'short').sub, '82 % of the pallets');
  assert.equal(get(b, 'short').tone, 'warn', 'one truck in six left short');
  assert.equal(b.busy, false);
  assert.equal(a.formula.includes('(measured)'), true, 'the arithmetic uses the measured door time');

  // a report with `ops` but nothing for the station, and one with nulls everywhere
  const nulls = { ops: { trucks: { [src.id]: { name: 'x', role: 'in', doors: null, trucks: {}, gateWait: { mean: null, p90: null, max: null }, doorTime: { mean: null, p90: null }, doorUtilization: NaN, gateQueue: { mean: 0, max: 0, now: 0 }, gateQueueSeries: [NaN, null, 'x'] } } } };
  for (const r of [{ ops: { trucks: {} } }, { ops: {} }, nulls, { ops: { trucks: { [src.id]: 'junk' } } }]) {
    const models = doorModels(r, layout);
    assert.equal(models.length, 2);
    for (const m of models) assert.ok(m.metrics.every((x) => !/NaN|undefined|null/.test(`${x.value} ${x.sub}`)), JSON.stringify(m.metrics));
  }
  assert.equal(doorModels(nulls, layout)[0].utilText, '–');
  assert.equal(DOOR_BUSY_SHARE, 0.85);
});

test('Doors card: the gate queue series in the shapes a report may hold, and the tone of a wait', () => {
  assert.deepEqual(seriesValues([1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(seriesValues([[0, 4], [60, 5]]), [4, 5]);
  assert.deepEqual(seriesValues([{ t: 0, v: 4 }, { t: 60, value: 6 }, { t: 90 }]), [4, 6]);
  assert.deepEqual(seriesValues({ t: [0, 1], v: [7, 8] }), [7, 8]);
  assert.deepEqual(seriesValues({ values: [1, NaN, 2] }), [1, 2]);
  assert.deepEqual(seriesValues(null), []);
  assert.deepEqual(seriesValues('x'), []);
  assert.equal(seriesValues(Array.from({ length: 1000 }, (_, i) => i)).length, 240, 'the newest points');
  assert.deepEqual([0, 899, 900, 2699, 2700, null, NaN].map(waitTone), ['neutral', 'neutral', 'warn', 'warn', 'bad', 'neutral', 'neutral']);
});

test('the paste dialog previews every line in order: read rows, skipped rows marked in place, the header', () => {
  const result = parseTimetable('Ankunft;Paletten\n06.00;24,0\n6:30 Uhr;18\n25:70;4\n08:00;\n0900;300');
  const lines = previewLines(result);
  assert.deepEqual(lines.map((l) => [l.line, l.kind]), [[1, 'header'], [2, 'good'], [3, 'good'], [4, 'bad'], [5, 'good'], [6, 'bad']]);
  assert.deepEqual(lines[1], { line: 2, kind: 'good', time: '06:00', pallets: '24' });
  assert.equal(lines[4].pallets, 'drawn', 'an empty number: drawn from the distribution');
  assert.equal(lines[3].reason, '“25:70” is not a time');
  assert.equal(lines[5].reason, '“300” is not between 1 and 200 pallets');
  assert.equal(useLabel(result), 'Use 3 rows');
  assert.equal(useLabel(parseTimetable('06:00;24')), 'Use 1 row');
  assert.equal(useLabel(parseTimetable('')), 'Use rows');
  assert.deepEqual(previewLines(parseTimetable('')), []);
});

test('the clock of the plant settings: Run one day and Run one week set the whole span and no warm-up, reset, and run exactly that span', async () => {
  assert.deepEqual(runPatch(DAY_SECONDS), { duration: 86400, warmup: 0 });
  assert.deepEqual(runPatch(WEEK_SECONDS), { duration: 604800, warmup: 0 });
  assert.equal(runCostText(DAY_SECONDS), 'roughly 10 to 40 seconds');
  assert.equal(runCostText(WEEK_SECONDS), 'roughly 1 to 5 minutes');
  assert.match(runText(DAY_SECONDS), /^Runs one day of the plant from the start of the clock, as fast as this computer can \(roughly 10 to 40 seconds for a plant of this size\), and then stops\./);
  assert.match(runText(WEEK_SECONDS), /one week/);

  const { layout } = busy();
  const store = createStore({ storage: undefined });
  store.replaceLayout(layout, { label: 'Load' });
  const calls = [];
  const toasts = [];
  const runner = { reset: () => calls.push('reset'), step: async (s) => { calls.push(`step ${s}`); return s; } };
  const asked = [];
  const ctx = { store, runner, toast: (t) => toasts.push(t), dialogs: { confirm: async (o) => { asked.push(o.title); return false; } } };
  assert.equal(await runSpan(ctx, DAY_SECONDS), true);
  assert.deepEqual(calls, ['reset', 'step 86400']);
  assert.deepEqual([store.getState().layout.settings.duration, store.getState().layout.settings.warmup], [86400, 0]);
  assert.equal(store.getState().lastCommit.label, 'Run one day');
  assert.equal(toasts.length, 1);
  assert.equal(await runSpan(ctx, WEEK_SECONDS), false, 'the week asks first; declined: nothing changes');
  assert.deepEqual(asked, ['Run one week?']);
  assert.deepEqual(calls, ['reset', 'step 86400']);
  ctx.dialogs.confirm = async () => true;
  assert.equal(await runSpan(ctx, WEEK_SECONDS), true);
  assert.equal(store.getState().layout.settings.duration, 604800);
  assert.equal(calls.at(-1), 'step 604800');
});

test('report rows: a plant without trucks is reported as before; with trucks the doors, the arrivals and the check-in and check-out are there', () => {
  const plain = plant();
  const src = L.getStation(plain.layout, plain.src.id);
  assert.deepEqual(truckRows(src), []);
  const legacy = stationParams(src);
  assert.deepEqual(legacy.map(([k]) => k), ['Time between arrivals', 'Loads per arrival', 'Output buffer', 'First arrival']);
  assert.deepEqual(stationParams(L.getStation(plain.layout, plain.sink.id)), []);
  assert.equal(clockRow(plain.layout), null);
  assert.equal(plantRows(plain.layout).some(([k]) => k === 'Clock'), false);
  assert.equal(doorCheckRow(src, plain.layout), null);
  assert.deepEqual(doorResultRows(null, plain.layout), []);

  const { layout, src: s2, sink: k2 } = busy();
  const rows = stationParams(L.getStation(layout, s2.id));
  assert.deepEqual(rows.map(([k]) => k), ['Staging space', 'First arrival', 'Dock doors', 'Check-in / check-out', 'Time between trucks', 'Pallets per truck']);
  assert.equal(rows.find(([k]) => k === 'Dock doors')[1], '4');
  assert.equal(rows.find(([k]) => k === 'Check-in / check-out')[1], '5 min / 5 min');
  assert.equal(rows.find(([k]) => k === 'Time between trucks')[1], '10 min (constant)');
  assert.equal(rows.find(([k]) => k === 'Pallets per truck')[1], '26 pallets (constant)');
  const out = stationParams(L.getStation(layout, k2.id)).map(([k]) => k);
  assert.deepEqual(out, ['Dock doors', 'Check-in / check-out', 'Time between trucks', 'Pallets per truck', 'Staging per door', 'A truck waits for its pallets']);
  assert.match(doorCheckRow(L.getStation(layout, s2.id), layout)[1], /^At the busiest hour you need about 4\.9 doors busy at once/);
  assert.deepEqual(withTrucks({ type: 'process' }, [['a', 'b']]), [['a', 'b']]);

  // a timetable: the rows describe it, and the plant has a clock
  L.updateStation(layout, s2.id, { ops: { trucks: { mode: 'schedule', schedule: [{ at: 21600, pallets: 24 }, { at: 36000, pallets: null }], jitter: 600, noShow: 0.05 } } });
  L.updateCalendar(layout, { startTod: 21600, startDay: 1 });
  const sched = Object.fromEntries(stationParams(L.getStation(layout, s2.id)));
  assert.equal(sched.Trucks, 'follow a timetable: 2 trucks a day from 06:00 to 10:00, about 50 pallets');
  assert.equal(sched['Arrival variation'], 'up to 10 min early or late');
  assert.equal(sched['No-shows'], '5 %');
  assert.deepEqual(clockRow(layout), ['Clock', 'starts at 06:00 on Tuesday']);
  assert.equal(plantRows(layout).at(-1)[0], 'Clock');
});

test('the report: doors in the assumptions, and a Dock doors table in the results, with dashes while the run has no truck figures', () => {
  const { layout, src, sink } = busy();
  const run = (report) => {
    const store = { getState: () => ({ layout, project: { name: 'Doors', scenarios: [{ id: 'a', name: 'A', layout }], activeId: 'a' }, ui: {} }) };
    const runner = { sim: {}, kpis: () => report, insights: () => [] };
    return exportReportHtml({ store, runner, issues: () => [], renderer: null }, { now: new Date('2026-10-09T10:00:00Z'), includeComparison: false });
  };
  const base = { window: { start: 0, end: 3600, duration: 3600, warmingUp: false }, throughput: { total: 10, perHour: 10 }, leadTime: { count: 3 }, wip: {}, stations: {}, fleets: {}, flows: {}, traffic: {}, orders: {} };
  const without = run(base);
  assert.match(without, /Dock doors/);
  assert.match(without, /Check-in \/ check-out:/);
  assert.match(without, /Door check \(indicative\):/);
  assert.ok(!/NaN|undefined/.test(without));
  const withOps = run({ ...base, ops: { trucks: { [src.id]: entry(), [sink.id]: entry({ name: 'Dispatch', role: 'out', doors: 2, trucks: { arrived: 20, docked: 20, departed: 18, short: 3 }, fillRate: 0.8 }) } } });
  assert.match(withOps, /<h3>Dock doors<\/h3>/);
  assert.match(withOps, /3 of 18/);
  assert.match(withOps, /93 %/);
  assert.match(withOps, /includes the wait of their truck at the gate/);
  assert.ok(!/NaN|undefined/.test(withOps));
  const rows = doorResultRows(null, layout);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.slice(2).every((c) => c.v === '–')), 'no run: dashes');
});
