// The pure parts of the panels for trucks and dock doors: the helpers of the inspector section (js/ui/panels/ops-trucks.js), the models of the Doors card
// (js/ui/panels/doors-card.js), the preview of the paste dialog (js/ui/panels/timetable-dialog.js), the clock of the plant settings (js/ui/panels/plant-clock.js)
// and the rows of the HTML report (js/ui/report-ops.js). Every part tolerates a report without `report.ops` (the simulation may not have produced truck figures),
// and no number it prints may be NaN or undefined. The DOM behaviour of the same panels is driven by tests/e2e/doors.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/model/layout.js';
import { defaultTrucks, trucksOf } from '../js/model/ops.js';
import { convertToDoors, doorCheck } from '../js/model/doors.js';
import {
  demandNote, doorCheckFor, doorCheckNote, doorFormula, dockNote, measuredDoorSeconds, nextRow, rateSummary, rowsFromRate, scheduleWith, scheduleWithout, sectionAside, seedText, shippedLine, timetableSummary, toMinutes, toSeconds,
} from '../js/ui/panels/ops-trucks.js';
import { whenSettled } from '../js/ui/panels/time-input.js';
import { dayHintVisible } from '../js/ui/panels/day-hint.js';
import { FIRST_TRUCK_GAP, firstTruckAfterStart } from '../js/ui/panels/plant-clock.js';
import { opsFixDoneText } from '../js/ui/guidance-ops.js';
import { DOOR_BUSY_SHARE, doorModel, doorModels, seriesValues, waitTone } from '../js/ui/panels/doors-card.js';
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
  // a truck that was at a door when the warm-up ended is served without having arrived in the window: no "7 served, 6 arrived"
  const early = doorModel(src, trucksOf(src), entry({ trucks: { arrived: 6, docked: 6, departed: 7, short: 0, noShow: 2, turnedAway: 1 } }), layout, null);
  assert.equal(early.metrics.find((m) => m.key === 'served').sub, '1 turned away, 2 did not come');
  assert.equal(early.metrics.find((m) => m.key === 'gateWait').sub, '9 in 10 under 40 min');
  const calm = doorModel(src, trucksOf(src), entry({ gateWait: { mean: 0, p90: 0.1, max: 0.2 } }), layout, null);
  assert.equal(calm.metrics.find((m) => m.key === 'gateWait').sub, '', 'a p90 below a second is a tick, not a wait');
  assert.equal(calm.metrics.find((m) => m.key === 'gateWait').value, '0 s');
  assert.equal(doorModel(src, trucksOf(src), entry({ gateWait: { mean: 0.1, p90: 0.1, max: 0.1 } }), layout, null).metrics.find((m) => m.key === 'gateWait').value, '0 s', 'one tick at the gate is no wait');
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
  assert.equal(runCostText(DAY_SECONDS), 'roughly 2 to 10 seconds', 'measured: 2.4 s of wall time in the browser, 4.4 s of CPU on a busy machine');
  assert.equal(runCostText(WEEK_SECONDS), 'roughly 15 to 60 seconds');
  assert.match(runText(DAY_SECONDS), /^Runs one day of the plant from the start of the clock, as fast as this computer can \(roughly 2 to 10 seconds for a plant of this size\), and then stops\./);
  assert.match(runText(DAY_SECONDS), /It also sets the run length of the plant to 24 h with no warm-up, which later runs, comparisons and sweeps use too/, 'UX-25: the toast says what it changed');
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

test('the line under the door check says that the vehicles set the door time: an assumption before a run, a measurement after it', () => {
  const trucks = { ...defaultTrucks(), doors: 3, interArrival: { kind: 'const', mean: 900, spread: 0 }, pallets: { kind: 'const', mean: 24, spread: 0 } };
  const before = doorCheck(trucks, {});
  assert.match(doorCheckNote(before), /^The 90 s per pallet is an assumption\. In a run your vehicles decide how long a truck stays at its door/);
  assert.match(doorCheckNote(doorCheck(trucks, { measuredDoorSeconds: 2520 })), /^Your vehicles set this door time: if it is long, look at the forklifts and AGVs before adding doors\.$/);
  assert.equal(doorCheckNote(doorCheck({ ...trucks, mode: 'schedule', schedule: [] }, {})), '', 'an empty timetable has no check');
  assert.equal(doorCheckNote(null), '');
});

// ---- the fixes of the UX review (UX-1, UX-5, UX-8, UX-9, UX-23) ----------------------------------------------------------------------------------------

/** An input stand-in on Node's EventTarget that behaves like a native time input: `type()` fires `change` per finished segment, as Chromium does. */
function timeInput() {
  const el = new EventTarget();
  el.focus = () => el.dispatchEvent(new Event('focus'));
  el.blur = (related = null) => { const e = new Event('blur'); e.relatedTarget = related; el.dispatchEvent(e); };
  el.change = () => el.dispatchEvent(new Event('change'));
  el.press = (key) => { const e = new Event('keydown'); e.key = key; el.dispatchEvent(e); };
  return el;
}

test('UX-1: a time field is settled when the planner is done with it, never per segment', () => {
  const input = timeInput();
  const settled = [];
  const watch = whenSettled(input, (how, event) => settled.push([how, event.relatedTarget ?? null]));
  input.focus();
  input.change(); // the hour (09:00 on the way to 09:30)
  input.change(); // the minutes
  input.change(); // AM/PM
  assert.deepEqual(settled, [], 'nothing while the planner is in the field');
  assert.equal(watch.pending, true);
  const next = {};
  input.blur(next);
  assert.deepEqual(settled, [['blur', next]], 'one edit when the focus leaves, with the control the focus goes to');
  assert.equal(watch.pending, false);
  input.blur();
  assert.equal(settled.length, 1, 'a blur without an edit settles nothing');
  // Enter ends an edit and the focus stays
  input.focus();
  input.change();
  input.press('Enter');
  assert.deepEqual(settled.map((x) => x[0]), ['blur', 'enter']);
  input.press('Enter');
  assert.equal(settled.length, 2, 'Enter without an edit settles nothing');
  // a change without the focus (a script, autofill) is settled at once
  input.blur();
  input.change();
  assert.deepEqual(settled.map((x) => x[0]), ['blur', 'enter', 'away']);
  // cancel forgets an edit
  input.focus();
  input.change();
  watch.cancel();
  input.blur();
  assert.equal(settled.length, 3);
  // the focus can be told by the caller (tests, a custom control)
  const other = timeInput();
  const got = [];
  whenSettled(other, (how) => got.push(how), { focused: () => true });
  other.change();
  assert.deepEqual(got, [], 'focused by the caller: waits');
  other.blur();
  assert.deepEqual(got, ['blur']);
});

test('UX-8: switching to a timetable keeps the trucks: the rate becomes the rows of one day', () => {
  const rate = { ...defaultTrucks(), interArrival: { kind: 'normal', mean: 1020, spread: 0.2 }, pallets: { kind: 'const', mean: 24, spread: 0 } };
  const rows = rowsFromRate(rate);
  assert.equal(rows.length, 84, 'a truck every 17 minutes for 24 hours');
  assert.deepEqual(rows[0], { at: 0, pallets: 24 });
  assert.deepEqual(rows[1], { at: 1020, pallets: 24 });
  assert.ok(rows.every((r, i) => i === 0 || r.at > rows[i - 1].at) && rows.at(-1).at < 86400, 'increasing, inside the day');
  assert.equal(rows.length * 24, 2016, 'the pallets of a day: the same load as the rate (84 trucks x 24)');
  assert.equal(timetableSummary({ ...rate, schedule: rows }), '84 trucks a day, 2,016 pallets, at most 4 in any hour');
  assert.match(seedText(rate, rows), /^Your rate \(a truck about every 17 min with 24 pallets\) became 84 rows of the timetable, so the plant gets the same trucks\./);
  // pallets that vary stay "drawn"; a rate closer than the table can hold gets more pallets per truck, the same pallets a day
  assert.ok(rowsFromRate({ ...rate, pallets: { kind: 'exp', mean: 18, spread: 0 } }).every((r) => r.pallets === null));
  assert.ok(rowsFromRate({ ...rate, pallets: { kind: 'normal', mean: 18, spread: 0.2 } }).every((r) => r.pallets === null));
  assert.ok(rowsFromRate({ ...rate, pallets: { kind: 'normal', mean: 18, spread: 0 } }).every((r) => r.pallets === 18));
  const dense = rowsFromRate({ ...rate, interArrival: { kind: 'const', mean: 60, spread: 0 } });
  assert.ok(dense.length <= 500 && dense.length >= 499, `${dense.length} rows at the most`);
  assert.equal(dense[0].pallets, 69, '24 pallets a minute x 172.8 s = 69 pallets per truck');
  assert.ok(Math.abs(dense.length * dense[0].pallets - 1440 * 24) / (1440 * 24) < 0.01, 'within 1 % of the same pallets a day (1,440 trucks of 24 = 34,560)');
  // odd rates
  assert.deepEqual(rowsFromRate({ ...rate, interArrival: { kind: 'const', mean: 1e6, spread: 0 } }), [{ at: 0, pallets: 24 }], 'one truck for a rate slower than a day');
  assert.deepEqual(rowsFromRate(null), []);
  assert.deepEqual(rowsFromRate({ interArrival: { mean: 0 } }), []);
  assert.deepEqual(rowsFromRate({ interArrival: { mean: NaN } }), []);
  assert.ok(rowsFromRate({ interArrival: { mean: 600 }, pallets: null }).every((r) => r.pallets === 24), 'no pallets block: an average truck');
});

test('UX-23: where the demand slider enters the numbers of the section', () => {
  assert.equal(demandNote(1), '');
  assert.equal(demandNote(undefined), '');
  assert.equal(demandNote(2), 'includes the demand setting of the plant, 2×');
  assert.equal(demandNote(0.5, ' (', ')'), ' (includes the demand setting of the plant, 0.5×)');
  const rate = { ...defaultTrucks(), interArrival: { kind: 'const', mean: 1020, spread: 0 }, pallets: { kind: 'const', mean: 24, spread: 0 } };
  assert.doesNotMatch(rateSummary(rate, 1), /demand/);
  assert.match(rateSummary(rate, 2), /^About 7\.1 trucks an hour of 24 pallets: 169\.4 pallets an hour, includes the demand setting of the plant, 2×\.$/);
  const schedule = { ...defaultTrucks(), mode: 'schedule', schedule: [{ at: 21600, pallets: 24 }, { at: 25200, pallets: 24 }] };
  assert.doesNotMatch(timetableSummary(schedule, 1), /demand/);
  assert.match(timetableSummary(schedule, 2), /^2 trucks a day, 96 pallets, at most 1 in any hour \(includes the demand setting of the plant, 2×\)$/);
  const check = doorCheck(rate);
  assert.doesNotMatch(doorCheckNote(check, 1), /demand/);
  assert.match(doorCheckNote(check, 2), /The check includes the demand setting of the plant, 2×\.$/);
});

test('UX-5: the door check and the toast of "Use N doors" say that a single dock cell limits the doors', () => {
  assert.equal(dockNote(2, 2), '');
  assert.equal(dockNote(1, 4), '');
  assert.equal(dockNote(6, 0), '', 'a station with no dock at all is the business of another check');
  assert.match(dockNote(6, 1), /^Only 1 road cell touches this station, so its vehicles reach one dock: doors beyond that only let more trucks check in or out while others are unloaded\. A second dock/);
  assert.match(dockNote(6, 3), /^Only 3 road cells touch this station, so its vehicles reach 3 docks/);
  const p = plant();
  const before = p.layout;
  const fix = { type: 'update-station', stationId: p.src.id, patch: { ops: { trucks: { doors: 6 } } }, label: 'Use 6 doors' };
  const after = structuredClone(before);
  L.updateStation(after, p.src.id, { ops: { trucks: { ...defaultTrucks(), doors: 6 } } });
  const docks = L.docksOf(after, p.src.id).length;
  assert.ok(docks >= 1 && docks < 6, `the plant has ${docks} dock cells`);
  assert.match(opsFixDoneText(before, after, fix), new RegExp(`^Goods receiving now has 6 doors\\. Only ${docks === 1 ? '1 road cell touches' : `${docks} road cells touch`} it, so a door beyond (that dock|those docks) cannot be unloaded any faster`));
  const enough = structuredClone(before);
  L.updateStation(enough, p.src.id, { ops: { trucks: { ...defaultTrucks(), doors: 1 } } });
  assert.equal(opsFixDoneText(before, enough, { ...fix, patch: { ops: { trucks: { doors: 1 } } } }), 'Goods receiving now has 1 door.', 'no note when the docks are enough');
});

test('UX-6: the hint of a day plant is shown after an edit, until it is dealt with', () => {
  const dayPlant = busy().layout;
  L.updateStation(dayPlant, dayPlant.stations[0].id, { ops: { trucks: { mode: 'schedule', schedule: [{ at: 21600, pallets: 24 }] } } });
  const stationary = plant().layout;
  assert.equal(dayHintVisible({ armed: true, layout: dayPlant, rightTab: 'results' }), true);
  assert.equal(dayHintVisible({ armed: false, layout: dayPlant, rightTab: 'results' }), false, 'nobody edited');
  assert.equal(dayHintVisible({ armed: true, layout: dayPlant, rightTab: 'experiments' }), false, 'the planner is where the hint leads');
  assert.equal(dayHintVisible({ armed: true, layout: stationary, rightTab: 'results' }), false, 'a stationary plant has no day');
  assert.equal(dayHintVisible({ armed: true, layout: null, rightTab: null }), false);
});

test('UX-9: a clock that starts long before the first truck says so', () => {
  const p = plant();
  L.updateStation(p.layout, p.src.id, { ops: { trucks: { ...defaultTrucks(), mode: 'schedule', schedule: [{ at: 21600, pallets: 24 }, { at: 25200, pallets: 12 }] } } });
  assert.deepEqual(firstTruckAfterStart(p.layout), { at: 21600, wait: 21600 }, 'no clock yet: it starts at 00:00');
  L.updateCalendar(p.layout, { startTod: 21000 });
  assert.equal(firstTruckAfterStart(p.layout), null, 'ten minutes to the first truck: soon enough');
  L.updateCalendar(p.layout, { startTod: 25000 });
  assert.equal(firstTruckAfterStart(p.layout), null, 'the 07:00 truck comes in 200 s');
  L.updateCalendar(p.layout, { startTod: 26000 });
  assert.deepEqual(firstTruckAfterStart(p.layout), { at: 21600, wait: 21600 + 86400 - 26000 }, 'both rows are past: the first one of the next day');
  L.updateCalendar(p.layout, { startTod: 21600 });
  assert.equal(firstTruckAfterStart(p.layout), null);
  assert.equal(FIRST_TRUCK_GAP, 1800);
  const rate = plant();
  L.updateStation(rate.layout, rate.src.id, { ops: { trucks: defaultTrucks() } });
  assert.equal(firstTruckAfterStart(rate.layout), null, 'a rate has no first truck');
  assert.equal(firstTruckAfterStart(null), null);
  const empty = plant();
  L.updateStation(empty.layout, empty.src.id, { ops: { trucks: { ...defaultTrucks(), mode: 'schedule', schedule: [] } } });
  assert.equal(firstTruckAfterStart(empty.layout), null, 'an empty timetable');
});
