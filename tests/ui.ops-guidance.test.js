// Trucks and dock doors in the coaching (js/ui/guidance-ops.js, wired into js/ui/guidance.js) and in the Checks tab: the note "add dock doors", the button
// "Add dock doors" (one undo step, the toast of copy 1), and the Fix buttons of the four checks of model/validate-ops.js through fixForIssue and applyFix
// (A1.12, the UI part): each fix is ONE undo step, undo restores the plant, and the issue is gone afterwards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../js/store/store.js';
import * as L from '../js/model/layout.js';
import { validateLayout } from '../js/model/validate.js';
import { defaultTrucks } from '../js/model/ops.js';
import { computeNextSteps, openSteps, fixForIssue, applyFix, createGuidance } from '../js/ui/guidance.js';
import { ADD_DOORS_ID, addDockDoors, addDoorsSteps, canAddDoors, doorsCandidate, opsFixDoneText } from '../js/ui/guidance-ops.js';

function plant({ docks = 3 } = {}) {
  const layout = L.createLayout({ name: 'Doors', cols: 30, rows: 16, cellSize: 2 });
  L.paintRoadPath(layout, [[2, 12], [26, 12]]);
  const src = L.addStation(layout, { type: 'source', name: 'Goods receiving', x: 8, y: 10, w: docks, h: 2, params: { interArrival: { kind: 'const', mean: 180, spread: 0 } } });
  const sink = L.addStation(layout, { type: 'sink', name: 'Dispatch', x: 21, y: 10, w: 3, h: 2 });
  L.addFlow(layout, src.id, sink.id);
  L.addFleet(layout, 'forklift', { count: 3 });
  return { layout, src, sink };
}

function harness(layout) {
  const store = createStore({ storage: undefined });
  store.replaceLayout(layout, { label: 'Load' });
  const toasts = [];
  const focused = [];
  const ctx = { store, toast: (text, opts) => { toasts.push({ text, ...opts }); }, actions: { focus: (refs) => focused.push(refs), setTool() {}, setRightTab() {} }, runner: { playing: false, play() {} } };
  return { store, ctx, toasts, focused };
}

const stationOf = (layout, id) => L.getStation(layout, id);

test('the note "add dock doors": info, dismissible, once the plant has flows, one per plant, never a step to finish', () => {
  const { layout, src, sink } = plant();
  const empty = L.createLayout({});
  assert.deepEqual(addDoorsSteps(empty), []);
  const noFlows = structuredClone(layout);
  noFlows.flows = [];
  assert.deepEqual(addDoorsSteps(noFlows), [], 'nothing to receive or ship yet');
  const [step] = addDoorsSteps(layout);
  assert.equal(step.id, ADD_DOORS_ID);
  assert.equal(step.severity, 'info');
  assert.equal(step.dismissible, true);
  assert.deepEqual(step.refs, { stationIds: [src.id] }, 'the Goods in comes first');
  assert.deepEqual(step.fix, { type: 'add-doors', stationId: src.id, label: 'Add dock doors' });
  assert.match(step.title, /Trucks bring the goods to Goods receiving/);
  const steps = computeNextSteps(layout, { hasRun: true });
  assert.ok(steps.some((s) => s.id === ADD_DOORS_ID));
  assert.ok(!openSteps(steps).some((s) => s.id === ADD_DOORS_ID), 'a note is not counted as a step to finish');
  assert.equal(steps.filter((s) => s.id === ADD_DOORS_ID).length, 1);

  const inOnly = structuredClone(layout);
  L.updateStation(inOnly, src.id, { ops: { trucks: defaultTrucks() } });
  const [second] = addDoorsSteps(inOnly);
  assert.equal(second.refs.stationIds[0], sink.id, 'the Goods in has doors: the Goods out is next');
  assert.match(second.title, /Trucks collect the goods at Dispatch/);
  L.updateStation(inOnly, sink.id, { ops: { trucks: defaultTrucks() } });
  assert.deepEqual(addDoorsSteps(inOnly), [], 'both have doors: nothing to suggest');
  const unconnected = structuredClone(layout);
  unconnected.flows = [];
  const other = L.addStation(unconnected, { type: 'sink', x: 12, y: 3, w: 2, h: 2 });
  assert.equal(doorsCandidate(unconnected), null, `a Goods out without a flow (${other.name}) is not offered doors`);
  assert.equal(canAddDoors(stationOf(layout, src.id)), true);
  assert.equal(canAddDoors({ type: 'process' }), false);
});

test('a dismissed note stays dismissed and the shared guidance state still counts no open step for it', () => {
  const { layout } = plant();
  const { store, ctx } = harness(layout);
  const storage = new Map();
  const g = createGuidance({ ...ctx, store }, { storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) } });
  assert.ok(g.read().steps.some((s) => s.id === ADD_DOORS_ID));
  g.dismiss(ADD_DOORS_ID);
  assert.ok(!g.read().steps.some((s) => s.id === ADD_DOORS_ID));
});

test('Add dock doors: one undo step, the station selected, the numbers in the toast, and the plant is as before after undo', () => {
  const { layout, src, sink } = plant();
  const { store, ctx, toasts, focused } = harness(layout);
  assert.equal(addDockDoors(ctx, 'nope'), false);
  assert.equal(addDockDoors(ctx, src.id), true);
  const after = store.getState();
  assert.equal(after.lastCommit.label, 'Add dock doors');
  const trucks = stationOf(after.layout, src.id).ops.trucks;
  assert.equal(trucks.doors, 2);
  assert.equal(trucks.pallets.mean, 24);
  assert.equal(trucks.interArrival.mean, 4320, 'one pallet every 180 s becomes 24 pallets every 72 minutes');
  assert.deepEqual(after.ui.selection, { kind: 'station', ids: [src.id] });
  assert.equal(after.layout.schema, 2);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].text, 'Goods receiving now receives trucks: 2 doors, 24 pallets per truck, about one truck every 72 min. That is the same 20 pallets an hour as before, but they now arrive in bunches.');
  assert.equal(toasts[0].ms, 8000);
  assert.equal(toasts[0].action.label, 'Show doors');
  toasts[0].action.onClick();
  assert.deepEqual(focused, [{ stationIds: [src.id] }]);
  assert.equal(addDockDoors(ctx, src.id), false, 'it has trucks already');
  assert.equal(addDockDoors(ctx, sink.id), true, 'a Goods out gets its own defaults');
  assert.equal(stationOf(store.getState().layout, sink.id).ops.trucks.interArrival.mean, 1800);
  store.undo();
  store.undo();
  assert.equal(JSON.stringify(store.getState().layout), JSON.stringify(layout), 'two undos give the plant back byte for byte (and schema 1)');
  assert.equal(store.getState().layout.schema, 1);
});

test('Add dock doors on a station with one dock (the Starter): two doors, and the plant says at once what the second door does and does not do (doors-exceed-docks)', () => {
  const one = plant({ docks: 1 });
  const h1 = harness(one.layout);
  assert.equal(L.docksOf(one.layout, one.src.id).length, 1);
  assert.equal(addDockDoors(h1.ctx, one.src.id), true);
  assert.equal(stationOf(h1.store.getState().layout, one.src.id).ops.trucks.doors, 2, 'one door would be the bottleneck of the Starter: its 10 minutes of check-in and check-out would be dead time for the only dock');
  const issue = validateLayout(h1.store.getState().layout).find((i) => i.code === 'doors-exceed-docks');
  assert.ok(issue, 'a warning, not an error');
  assert.equal(issue.severity, 'warning');
  assert.match(issue.message, /^“Goods receiving” has 2 doors but only 1 road cell touches it\./);
  assert.match(issue.message, /only lets one more truck check in or out while the others are unloaded/);
  assert.match(issue.hint, /give the station a second dock, ideally on its own side road/);
});

test('Add dock doors on a Goods out: after a run the trucks carry what the plant shipped; without a run (or with too few pallets) the default 48 an hour', () => {
  const { layout, sink } = plant();
  const first = harness(layout);
  assert.equal(addDockDoors(first.ctx, sink.id), true);
  assert.equal(stationOf(first.store.getState().layout, sink.id).ops.trucks.interArrival.mean, 1800);
  assert.match(first.toasts[0].text, /That is 48 pallets an hour: if the plant ships less, trucks leave without a full load\.$/);
  const ran = harness(layout);
  ran.ctx.runner.kpis = () => ({ throughput: { bySink: { [sink.id]: { name: 'Dispatch', count: 17, perHour: 20.4 } } } });
  assert.equal(addDockDoors(ran.ctx, sink.id), true);
  const trucks = stationOf(ran.store.getState().layout, sink.id).ops.trucks;
  assert.deepEqual([trucks.pallets.mean, Math.round(trucks.interArrival.mean)], [24, Math.round(24 * 3600 / 20.4)]);
  assert.match(ran.toasts[0].text, /^Dispatch now loads trucks: 2 doors, 24 pallets per truck, about one truck every 70\.6 min\. That is the same 20\.4 pallets an hour that reached it in the last run\.$/);
  const few = harness(layout);
  few.ctx.runner.kpis = () => ({ throughput: { bySink: { [sink.id]: { name: 'Dispatch', count: 3, perHour: 4 } } } });
  addDockDoors(few.ctx, sink.id);
  assert.equal(stationOf(few.store.getState().layout, sink.id).ops.trucks.interArrival.mean, 1800, 'three pallets in the window say nothing about a rate');
});

test('doors-too-few: the Fix "Use 6 doors" is one undo step and the warning is gone afterwards (A1.12)', () => {
  const { layout, src } = plant({ docks: 8 });
  L.updateStation(layout, src.id, { ops: { trucks: { ...defaultTrucks(), doors: 4, mode: 'rate', interArrival: { kind: 'const', mean: 600, spread: 0 }, pallets: { kind: 'const', mean: 26, spread: 0 } } } });
  const { store, ctx, toasts } = harness(layout);
  const issue = validateLayout(store.getState().layout).find((i) => i.code === 'doors-too-few');
  assert.ok(issue, 'fires at the numbers of Appendix A: 4.9 doors needed, 4 doors');
  const fix = fixForIssue(store.getState().layout, issue);
  assert.equal(fix.type, 'update-station');
  assert.equal(fix.label, 'Use 6 doors');
  assert.equal(applyFix(ctx, fix), true);
  assert.equal(store.getState().lastCommit.label, 'Set dock doors');
  assert.equal(stationOf(store.getState().layout, src.id).ops.trucks.doors, 6);
  assert.equal(validateLayout(store.getState().layout).some((i) => i.code === 'doors-too-few'), false);
  assert.equal(toasts.at(-1).text, 'Goods receiving now has 6 doors.');
  toasts.at(-1).action.onClick(); // Undo
  assert.equal(stationOf(store.getState().layout, src.id).ops.trucks.doors, 4);
  assert.equal(store.getState().canUndo, true);
});

test('doors-exceed-docks: the Fix extends the road along the edge in one undo step', () => {
  const layout = L.createLayout({ name: 'Doors', cols: 30, rows: 16, cellSize: 2 });
  L.paintRoadPath(layout, [[8, 10], [8, 12], [20, 12]]); // one road cell touches the station
  const src = L.addStation(layout, { type: 'source', name: 'Goods in', x: 8, y: 8, w: 5, h: 2 });
  const sink = L.addStation(layout, { type: 'sink', name: 'Goods out', x: 18, y: 9, w: 2, h: 2 });
  L.addFlow(layout, src.id, sink.id);
  L.updateStation(layout, src.id, { ops: { trucks: { ...defaultTrucks(), doors: 3 } } });
  const { store, ctx, toasts } = harness(layout);
  const issue = validateLayout(store.getState().layout).find((i) => i.code === 'doors-exceed-docks');
  assert.ok(issue);
  const fix = fixForIssue(store.getState().layout, issue);
  assert.deepEqual([fix.type, fix.count, fix.label], ['extend-docks', 2, 'Extend the road']);
  const docksBefore = L.docksOf(store.getState().layout, src.id).length;
  assert.equal(applyFix(ctx, fix), true);
  assert.equal(L.docksOf(store.getState().layout, src.id).length, docksBefore + 2);
  assert.equal(store.getState().lastCommit.label, 'Extend dock road');
  assert.equal(validateLayout(store.getState().layout).some((i) => i.code === 'doors-exceed-docks'), false);
  assert.match(toasts.at(-1).text, /^2 road cells more touch Goods in\./);
  store.undo();
  assert.equal(L.docksOf(store.getState().layout, src.id).length, docksBefore, 'one undo takes the whole extension back');
});

test('docks-share-lane: the Fix shows the docks on the plan, and the timetable-empty Fix adds a row', () => {
  const { layout, src } = plant({ docks: 4 });
  L.updateStation(layout, src.id, { ops: { trucks: { ...defaultTrucks(), doors: 2 } } });
  const { store, ctx, focused } = harness(layout);
  const issues = validateLayout(store.getState().layout);
  const lane = issues.find((i) => i.code === 'docks-share-lane');
  assert.ok(lane, 'four docks in a row on one lane');
  const fix = fixForIssue(store.getState().layout, lane);
  assert.equal(fix.type, 'focus');
  assert.equal(fix.label, 'Show docks');
  assert.equal(applyFix(ctx, fix), true);
  assert.equal(focused.length, 1);
  assert.deepEqual(focused[0].stationIds, [src.id]);
  assert.equal(focused[0].cells.length, 4);

  store.commit('Use a timetable', (d) => { L.updateStation(d, src.id, { ops: { trucks: { mode: 'schedule', schedule: [] } } }); });
  const empty = validateLayout(store.getState().layout).find((i) => i.code === 'timetable-empty');
  assert.ok(empty);
  const rowFix = fixForIssue(store.getState().layout, empty);
  assert.equal(rowFix.label, 'Add a row');
  assert.equal(applyFix(ctx, rowFix), true);
  assert.deepEqual(stationOf(store.getState().layout, src.id).ops.trucks.schedule, [{ at: 21600, pallets: 24 }]);
  assert.equal(validateLayout(store.getState().layout).some((i) => i.code === 'timetable-empty'), false);
  assert.equal(store.getState().lastCommit.label, 'Add timetable row at 06:00');
});

test('a fix of a station that is gone does nothing and says so', () => {
  const { layout, src } = plant({ docks: 8 });
  L.updateStation(layout, src.id, { ops: { trucks: { ...defaultTrucks(), doors: 4, interArrival: { kind: 'const', mean: 600, spread: 0 }, pallets: { kind: 'const', mean: 26, spread: 0 } } } });
  const { store, ctx, toasts } = harness(layout);
  const issue = validateLayout(layout).find((i) => i.code === 'doors-too-few');
  const fix = fixForIssue(layout, issue);
  store.commit('Delete', (d) => { L.removeStation(d, src.id); });
  const version = store.getState().version;
  assert.equal(applyFix(ctx, fix), false);
  assert.equal(store.getState().version, version, 'nothing was committed');
  assert.equal(toasts.at(-1).kind, 'warn');
  assert.match(opsFixDoneText(layout, layout, { type: 'update-station', stationId: src.id, patch: { ops: { trucks: { doors: 5 } } }, label: 'Use 5 doors' }), /now has 5 doors/);
});
