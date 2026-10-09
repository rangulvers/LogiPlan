// Milestone M1 of the warehouse module, the plan checks of Appendix B (js/model/validate-ops.js, called by validateLayout):
//   doors-too-few, doors-exceed-docks, docks-share-lane, timetable-empty, their stable ids, severities, plain-language messages (7.6) and Fix data.
//   A1.12 (model part): docks-share-lane fires on the Dock lab "row" variant and not on the "bays" variant; doors-too-few fires at the Appendix A numbers;
//   doors-exceed-docks fires when the doors exceed the dock cells of the station.
//
// "Docks share a lane" is defined geometrically in dockLanes (validate-ops.js) and in docs/ARCHITECTURE.md 3.1: two neighbouring dock cells along one
// side of a station, joined by road, with no road cell behind either of them. The small plants below prove each part of that sentence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/model/layout.js';
import { EXAMPLES } from '../js/model/examples.js';
import { legacyExamples } from './helpers/golden.js';
import { validateLayout } from '../js/model/validate.js';
import { OPS_CHECKS, applyOpsFix, dockLanes, extendDockRoad, opsFixFor, validateOps } from '../js/model/validate-ops.js';
import { convertToDoors } from '../js/model/doors.js';
import { createStore } from '../js/store/store.js';
import { layoutFromAscii } from './helpers/ascii.js';

const OWN_CODES = ['doors-too-few', 'doors-exceed-docks', 'docks-share-lane', 'timetable-empty'];
const codesOf = (layout, only = OWN_CODES) => validateLayout(layout).filter((i) => only.includes(i.code)).map((i) => i.code);
const issue = (layout, code) => validateLayout(layout).find((i) => i.code === code);
const bytes = (v) => JSON.stringify(v);

/** The Dock lab of Appendix C: a two-way loop, a Goods in with `doors` doors and trucks, a sink, 8 forklifts. `row`: six docks in a row; `bays`: three side roads. */
function dockLab(variant, trucks = { doors: 3 }) {
  const layout = L.createLayout({ name: 'Dock lab', cols: 40, rows: 24, cellSize: 2 });
  L.paintRoadPath(layout, [[4, 10], [30, 10], [30, 18], [4, 18], [4, 10]]);
  const gap = { kind: 'normal', mean: 14, spread: 0.2 };
  if (variant === 'row') L.addStation(layout, { type: 'source', name: 'Goods in', x: 10, y: 8, w: 6, h: 2, params: { interArrival: gap, outCap: 12 } });
  else {
    L.addStation(layout, { type: 'source', name: 'Goods in', x: 10, y: 4, w: 7, h: 2, params: { interArrival: gap, outCap: 12 } });
    for (const x of [10, 13, 16]) L.paintRoadPath(layout, [[x, 10], [x, 6]]);
  }
  const sink = L.addStation(layout, { type: 'sink', name: 'Goods out', x: 31, y: 13, w: 3, h: 2 });
  const park = L.addStation(layout, { type: 'depot', name: 'Park', x: 8, y: 19, w: 3, h: 2, params: { slots: 8 } });
  L.paintRoadPath(layout, [[9, 18], [9, 19]]);
  const source = layout.stations.find((s) => s.type === 'source');
  L.addFlow(layout, source.id, sink.id);
  L.addFleet(layout, 'forklift', { name: 'FL', count: 8, home: park.id, capacity: 1 });
  if (trucks) L.updateStation(layout, source.id, { ops: { trucks } });
  return layout;
}
const sourceOf = (layout) => layout.stations.find((s) => s.type === 'source');

/** Layout from an ASCII picture; station A is a Goods in with trucks (when `trucks`), others are not. */
function plant(lines, { trucks = { doors: 2 }, type = 'source' } = {}) {
  const layout = layoutFromAscii(lines, { stations: { A: { type, ...(trucks ? { ops: { trucks } } : {}) }, B: 'sink' }, fleets: [{ count: 1 }] });
  return L.normalizeLayout(layout);
}
const lanesOf = (layout) => dockLanes(layout, layout.stations.find((s) => s.id === 'A')).map((lane) => lane.map((c) => c.join(',')));

// ---------------------------------------------------------------------------------------------------------------------------
// docks-share-lane
// ---------------------------------------------------------------------------------------------------------------------------

test('A1.12 docks-share-lane fires on the Dock lab "row" variant (six docks in a row on the loop) and not on the "bays" variant (three side roads)', () => {
  const row = dockLab('row');
  const bays = dockLab('bays');
  assert.deepEqual(L.docksOf(row, sourceOf(row).id), [[10, 10], [11, 10], [12, 10], [13, 10], [14, 10], [15, 10]]);
  assert.deepEqual(L.docksOf(bays, sourceOf(bays).id), [[10, 6], [13, 6], [16, 6]]);
  const found = issue(row, 'docks-share-lane');
  assert.ok(found, 'row: the warning');
  assert.equal(found.severity, 'warning');
  assert.equal(found.id, `docks-share-lane:${sourceOf(row).id}`);
  assert.deepEqual(found.refs.stationId, sourceOf(row).id);
  assert.deepEqual(found.refs.cells, [[10, 10], [11, 10], [12, 10], [13, 10], [14, 10], [15, 10]]);
  assert.equal(issue(bays, 'docks-share-lane'), undefined, 'bays: no warning');
  assert.deepEqual(codesOf(bays), []);
  assert.match(found.message, /^The docks of “Goods in” lie in a row on one lane\. A vehicle standing at the first dock blocks the others, so vehicles queue on the road while the docks behind stand free\.$/);
  assert.equal(found.hint, 'Give each dock its own short side road.');
  // the same plant without trucks (a legacy plant) gets no new issue
  const legacy = dockLab('row', null);
  assert.deepEqual(codesOf(legacy), []);
});

test('docks-share-lane: the precise rule on small plants (neighbours joined by road; a second road behind them does not help)', () => {
  // 1. four docks in a row, nothing behind: one lane of four cells
  assert.deepEqual(lanesOf(plant(['.AAAA...', '.++++...', '........', '........', '........', '........', '........', '........'])), [['1,1', '2,1', '3,1', '4,1']]);
  // 2. a road behind them (a parallel road): STILL one lane. Appendix B said "and the cells on their far side are not road cells", but the simulation sends every
  //    visit to the first dock there too (M1-MODEL-REV-3: 465 of 465 visits with nothing behind, 202 of 202 with a road joined at every cell, 372 of 372 at the ends)
  assert.deepEqual(lanesOf(plant(['.AAAA...', '.++++...', '.++++...', '........', '........', '........', '........', '........'])), [['1,1', '2,1', '3,1', '4,1']]);
  // 3. a road behind only one of four docks: the docks are neighbours joined by road all the same
  assert.deepEqual(lanesOf(plant(['.AAAA...', '.++++...', '...+....', '........', '........', '........', '........', '........'])), [['1,1', '2,1', '3,1', '4,1']]);
  // 4. docks that are not neighbours (side roads): no lane
  assert.deepEqual(lanesOf(plant(['.AAAA...', '.+.+....', '.+.+....', '........', '........', '........', '........', '........'])), []);
  // 5. neighbours without a link between them (two one-way plates side by side facing away): not one road, no lane
  assert.deepEqual(lanesOf(plant(['.AA.....', '.<>.....', '........', '........', '........', '........', '........', '........'])), []);
  // 6. a one-way row is one lane too
  assert.deepEqual(lanesOf(plant(['.AAAA...', '.>>>>...', '........', '........', '........', '........', '........', '........'])), [['1,1', '2,1', '3,1', '4,1']]);
  // 7. a column of docks on the right side of a tall station
  assert.deepEqual(lanesOf(plant(['.A+.....', '.A+.....', '.A+.....', '........', '........', '........', '........', '........'])), [['2,0', '2,1', '2,2']]);
  // 8. docks on two sides: a row on each side is a lane each; the corner is not a dock and joins nothing
  const corner = plant(['........', '..AA....', '..AA....', '.+++++..', '.+......', '.+......', '........', '........']);
  assert.deepEqual(lanesOf(corner), [['2,3', '3,3']], 'the cell (1,3) is a corner of the station: not a dock; (2,3) and (3,3) below it are, with nothing behind them');
  // 9. a corner road: one dock on the left and one below, not neighbours along a side
  assert.deepEqual(lanesOf(plant(['........', '..AA....', '..AA....', '.+......', '.++.....', '........', '........', '........'])), [], 'one dock on the left side, none below that is a neighbour');
  // 10. the last row of the plan: the far side lies outside the grid, which is not a road
  assert.deepEqual(lanesOf(plant(['........', '........', '........', '........', '........', '........', '.AAA....', '.+++....'])), [['1,7', '2,7', '3,7']]);
  // 11. one dock, no docks, a station that is not on the road
  assert.deepEqual(lanesOf(plant(['.AAA....', '.+......', '........', '........', '........', '........', '........', '........'])), []);
  assert.deepEqual(lanesOf(plant(['.AAA....', '........', '........', '........', '........', '........', '........', '........'])), []);
});

test('docks-share-lane: recognised on a legacy plant when asked (Congestion lab: the Packing docks on the main aisle), but only truck stations are warned about', () => {
  const lab = EXAMPLES.find((e) => e.id === 'congestion-lab').build();
  const packing = lab.stations.find((s) => s.name === 'Packing');
  const lanes = dockLanes(lab, packing);
  assert.equal(lanes.length, 1);
  assert.equal(lanes[0].length, L.docksOf(lab, packing.id).length);
  assert.deepEqual(codesOf(lab), [], 'a plant without trucks gets no new issue');
  L.updateStation(lab, packing.id, { ops: { trucks: { doors: 2 } } });
  assert.equal(L.docksOf(lab, packing.id).length >= 2, true);
  assert.deepEqual(L.checkInvariants(lab), [], 'a Workstation cannot carry trucks: nothing was stored');
  assert.deepEqual(codesOf(lab), []);
});

// ---------------------------------------------------------------------------------------------------------------------------
// doors-exceed-docks
// ---------------------------------------------------------------------------------------------------------------------------

test('A1.12 doors-exceed-docks fires when the doors exceed the road cells that touch the station, and not before', () => {
  const layout = dockLab('bays', { doors: 3 });
  assert.equal(L.docksOf(layout, sourceOf(layout).id).length, 3);
  assert.deepEqual(codesOf(layout), [], '3 doors, 3 docks');
  L.updateStation(layout, sourceOf(layout).id, { ops: { trucks: { doors: 4 } } });
  const found = issue(layout, 'doors-exceed-docks');
  assert.ok(found);
  assert.deepEqual([found.severity, found.id], ['warning', `doors-exceed-docks:${sourceOf(layout).id}`]);
  assert.match(found.message, /^“Goods in” has 4 doors but only 3 road cells touch it\. Vehicles serve the doors through those cells, so a door beyond them cannot be unloaded any faster: it only lets one more truck check in or out while the others are unloaded\.$/);
  assert.match(found.hint, /give the station a second dock, ideally on its own side road\. Extend the road adds road cells along the edge/);
  assert.deepEqual(found.refs.cells, [[10, 6], [13, 6], [16, 6]]);
  const single = plant(['.AAA....', '.+++....', '........', '........', '........', '........', '........', '........'], { trucks: { doors: 5 } });
  assert.deepEqual(codesOf(single), ['doors-exceed-docks', 'docks-share-lane']);
  const one = plant(['.AAA....', '.+......', '........', '........', '........', '........', '........', '........'], { trucks: { doors: 2 } });
  assert.match(issue(one, 'doors-exceed-docks').message, /has 2 doors but only 1 road cell touches it/);
  const none = plant(['.AAA....', '........', '........', '........', '........', '........', '........', '........'], { trucks: { doors: 2 } });
  assert.deepEqual(codesOf(none), [], 'no dock at all is the error station-no-dock, not this');
  assert.ok(validateLayout(none).some((i) => i.code === 'station-no-dock' || i.code === 'no-roads'));
});

// ---------------------------------------------------------------------------------------------------------------------------
// doors-too-few
// ---------------------------------------------------------------------------------------------------------------------------

/** Appendix A.1: 6 trucks an hour (every 600 s) of 26 pallets, check-in and check-out 300 s. */
const APPENDIX_A = { interArrival: { kind: 'const', mean: 600, spread: 0 }, pallets: { kind: 'const', mean: 26, spread: 0 }, checkIn: 300, checkOut: 300 };

test('A1.12 doors-too-few fires at the Appendix A numbers: 4.9 doors needed, 4 or 5 doors fire, 6 do not', () => {
  const layout = dockLab('bays', { ...APPENDIX_A, doors: 3 });
  const id = sourceOf(layout).id;
  const at = (doors) => { L.updateStation(layout, id, { ops: { trucks: { doors } } }); return issue(layout, 'doors-too-few'); };
  const four = at(3);
  assert.ok(four, '3 doors');
  const found = at(4);
  assert.ok(found, '4 doors');
  assert.deepEqual([found.severity, found.id], ['warning', `doors-too-few:${id}`]);
  assert.equal(found.message, 'At the busiest hour “Goods in” needs about 4.9 doors busy at once (6 trucks an hour, 49 minutes at a door each), but it has 4, so trucks will queue at the gate.');
  assert.equal(found.hint, '6 doors would be busy 82 % of the time. Door time includes waiting for forklifts, so more forklifts shorten it. This is an estimate from 90 s per pallet; Results shows the real figure after a run.');
  assert.deepEqual(found.refs, { stationId: id });
  assert.ok(at(5), '5 doors run at 98 %');
  assert.equal(at(6), undefined, '6 doors run at 82 %');
  assert.equal(at(8), undefined);
  // a timetable: six trucks of 26 pallets in one hour
  L.updateStation(layout, id, { ops: { trucks: { doors: 4, mode: 'schedule', schedule: Array.from({ length: 6 }, (_, i) => ({ at: 21600 + i * 600, pallets: 26 })) } } });
  assert.ok(issue(layout, 'doors-too-few'), 'schedule mode: the largest number of rows in any sliding hour');
  L.updateStation(layout, id, { ops: { trucks: { schedule: Array.from({ length: 6 }, (_, i) => ({ at: 21600 + i * 7200, pallets: 26 })) } } });
  assert.equal(issue(layout, 'doors-too-few'), undefined, 'the same six trucks spread over the day');
  // the demand slider is part of the plan as it will run
  L.updateStation(layout, id, { ops: { trucks: { mode: 'rate', doors: 4 } } });
  assert.ok(issue(layout, 'doors-too-few'));
  L.updateSettings(layout, { demandFactor: 0.5 });
  assert.equal(issue(layout, 'doors-too-few'), undefined, 'half the trucks need 2.45 doors');
  L.updateSettings(layout, { demandFactor: 2 });
  assert.match(issue(layout, 'doors-too-few').message, /needs about 9\.8 doors busy at once \(12 trucks an hour/);
});

// ---------------------------------------------------------------------------------------------------------------------------
// timetable-empty
// ---------------------------------------------------------------------------------------------------------------------------

test('timetable-empty: a station in schedule mode without a row, not in rate mode, not with a row', () => {
  const layout = dockLab('bays', { doors: 3 });
  const id = sourceOf(layout).id;
  assert.equal(issue(layout, 'timetable-empty'), undefined);
  L.updateStation(layout, id, { ops: { trucks: { mode: 'schedule' } } });
  const found = issue(layout, 'timetable-empty');
  assert.ok(found);
  assert.deepEqual([found.severity, found.id, found.refs], ['warning', `timetable-empty:${id}`, { stationId: id }]);
  assert.equal(found.message, 'The truck timetable of “Goods in” has no rows, so no truck ever arrives.');
  assert.match(found.hint, /Add a row/);
  assert.deepEqual(codesOf(layout), ['timetable-empty'], 'an empty timetable is not also "too few doors"');
  L.updateStation(layout, id, { ops: { trucks: { schedule: [{ at: 21600, pallets: 24 }] } } });
  assert.equal(issue(layout, 'timetable-empty'), undefined);
  L.updateStation(layout, id, { ops: { trucks: { schedule: [], mode: 'rate' } } });
  assert.equal(issue(layout, 'timetable-empty'), undefined);
});

// ---------------------------------------------------------------------------------------------------------------------------
// The module as a whole
// ---------------------------------------------------------------------------------------------------------------------------

test('the checks are listed in the order of Appendix B, run only on stations with trucks, and give stable ids', () => {
  assert.deepEqual(OPS_CHECKS.map((c) => c.name), ['checkDoorsTooFew', 'checkDoorsExceedDocks', 'checkDocksShareLane', 'checkTimetableEmpty']);
  for (const example of legacyExamples(EXAMPLES)) assert.deepEqual(codesOf(example.build()), [], `${example.id}: no trucks, no new issue`);
  const layout = dockLab('row', { ...APPENDIX_A, doors: 8, mode: 'schedule' });
  const own = validateLayout(layout).filter((i) => OWN_CODES.includes(i.code));
  assert.deepEqual(own.map((i) => i.code), ['doors-exceed-docks', 'docks-share-lane', 'timetable-empty'], '8 doors, 6 docks in a row, no rows: all warnings, in the order of the checks (too few doors is silent for an empty timetable)');
  assert.equal(bytes(validateLayout(layout).map((i) => i.id)), bytes(validateLayout(L.cloneLayout(layout)).map((i) => i.id)), 'ids are stable');
  const calls = [];
  validateOps({ layout, docks: new Map(), stations: new Map() }, (...args) => calls.push(args[1]));
  assert.ok(calls.includes('timetable-empty'));
  assert.doesNotThrow(() => validateOps({ layout: { stations: [], settings: {} }, docks: new Map() }, () => {}));
});

test('Goods out: the same four checks apply to a station of type sink; a Goods in and a Goods out can both be warned about', () => {
  const layout = dockLab('bays', { doors: 3 });
  const sink = layout.stations.find((s) => s.type === 'sink');
  L.updateStation(layout, sink.id, { ops: { trucks: { doors: 4, mode: 'schedule' } } });
  const mine = validateLayout(layout).filter((i) => OWN_CODES.includes(i.code));
  assert.deepEqual(mine.map((i) => [i.code, i.refs.stationId]), [['doors-exceed-docks', sink.id], ['docks-share-lane', sink.id], ['timetable-empty', sink.id]]);
  assert.match(mine[0].message, /^“Goods out” has 4 doors but only 2 road cells touch it\./);
  assert.deepEqual(mine[1].refs.cells, [[30, 13], [30, 14]], 'the two docks of the Goods out lie in a row on the loop (a column on its left side)');
});

test('converting every legacy example with "Add dock doors" gives no error, and only the warnings the plant deserves', () => {
  for (const example of legacyExamples(EXAMPLES)) {
    const layout = example.build();
    const errorsBefore = validateLayout(layout).filter((i) => i.severity === 'error').length;
    for (const station of layout.stations.filter((s) => s.type === 'source' || s.type === 'sink')) {
      assert.equal(L.updateStation(layout, station.id, { ops: { trucks: convertToDoors(station) } }), true);
    }
    assert.deepEqual(L.checkInvariants(layout), [], example.id);
    assert.equal(validateLayout(layout).filter((i) => i.severity === 'error').length, errorsBefore, `${example.id}: no new error`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// The Fix buttons are data
// ---------------------------------------------------------------------------------------------------------------------------

test('Fix data: doors-too-few -> update-station "Use 6 doors"; timetable-empty -> "Add a row"; docks-share-lane -> focus "Show docks"; doors-exceed-docks -> extend-docks', () => {
  const layout = dockLab('row', { ...APPENDIX_A, doors: 4 });
  const id = sourceOf(layout).id;
  const fixOf = (code) => opsFixFor(layout, issue(layout, code));
  assert.deepEqual(fixOf('doors-too-few'), { type: 'update-station', stationId: id, patch: { ops: { trucks: { doors: 6 } } }, label: 'Use 6 doors', undoLabel: 'Set dock doors' });
  const share = fixOf('docks-share-lane');
  assert.equal(share.type, 'focus');
  assert.equal(share.label, 'Show docks');
  assert.deepEqual(share.refs.stationIds, [id]);
  assert.deepEqual(share.refs.cells, issue(layout, 'docks-share-lane').refs.cells);
  L.updateStation(layout, id, { ops: { trucks: { doors: 9, mode: 'schedule' } } });
  assert.deepEqual(fixOf('doors-exceed-docks'), { type: 'extend-docks', stationId: id, count: 3, label: 'Extend the road', undoLabel: 'Extend dock road' });
  assert.deepEqual(fixOf('timetable-empty'), {
    type: 'update-station', stationId: id, patch: { ops: { trucks: { schedule: [{ at: 21600, pallets: 24 }] } } }, label: 'Add a row', undoLabel: 'Add timetable row at 06:00',
  });
  assert.equal(opsFixFor(layout, { code: 'no-roads', refs: {} }), null);
  assert.equal(opsFixFor(layout, { code: 'doors-too-few', refs: { stationId: 'nope' } }), null);
  assert.equal(opsFixFor(layout, { code: 'doors-too-few', refs: { stationId: layout.stations.find((s) => s.type === 'depot').id } }), null);
  assert.equal(opsFixFor(layout, null), null);
  const fine = dockLab('bays', { doors: 3 });
  assert.equal(opsFixFor(fine, { code: 'doors-too-few', refs: { stationId: sourceOf(fine).id } }), null, 'nothing to fix: no button');
});

test('Fix data applied through the real store: one undo step each, and the issue is gone', () => {
  const store = createStore({ storage: null });
  store.replaceLayout(dockLab('bays', { ...APPENDIX_A, doors: 4 }));
  const state = () => store.getState().layout;
  const id = sourceOf(state()).id;
  const fix = opsFixFor(state(), issue(state(), 'doors-too-few'));
  assert.equal(store.commit(fix.undoLabel, (draft) => applyOpsFix(draft, fix)), true);
  assert.equal(sourceOf(state()).ops.trucks.doors, 6);
  assert.equal(issue(state(), 'doors-too-few'), undefined);
  assert.equal(store.getState().lastCommit.label, 'Set dock doors');
  assert.equal(store.undo(), true);
  assert.equal(sourceOf(state()).ops.trucks.doors, 4, 'one undo step');
  // timetable-empty
  store.commit('Timetable', (d) => L.updateStation(d, id, { ops: { trucks: { mode: 'schedule' } } }));
  const add = opsFixFor(state(), issue(state(), 'timetable-empty'));
  assert.equal(store.commit(add.undoLabel, (d) => applyOpsFix(d, add)), true);
  assert.deepEqual(sourceOf(state()).ops.trucks.schedule, [{ at: 21600, pallets: 24 }]);
  assert.equal(issue(state(), 'timetable-empty'), undefined);
  assert.deepEqual(L.checkInvariants(state()), []);
  // 'focus' fixes change nothing
  const focus = { type: 'focus', refs: { stationIds: [id] }, label: 'Show docks' };
  const before = bytes(state());
  assert.equal(applyOpsFix(L.cloneLayout(state()), focus), false);
  assert.equal(applyOpsFix(L.cloneLayout(state()), null), false);
  assert.equal(applyOpsFix(L.cloneLayout(state()), { type: 'nothing' }), false);
  assert.equal(bytes(state()), before);
});

test('extendDockRoad: paints the free cells of the station edge next to existing docks, two-way, the fuller side first; stops at obstacles and the plan edge', () => {
  const layout = plant(['.AAAAA..', '.++.....', '........', '........', '........', '........', '........', '........'], { trucks: { doors: 4 } });
  assert.deepEqual(L.docksOf(layout, 'A'), [[1, 1], [2, 1]]);
  assert.equal(extendDockRoad(layout, 'A', 2), 2);
  assert.deepEqual(L.docksOf(layout, 'A'), [[1, 1], [2, 1], [3, 1], [4, 1]]);
  assert.deepEqual(L.checkInvariants(layout), []);
  assert.equal(L.hasLink(layout, 2, 1, 1) && L.hasLink(layout, 3, 1, 3), true, 'two-way, joined to the road that was there');
  assert.equal(issue(layout, 'doors-exceed-docks'), undefined, 'the warning is gone');
  assert.ok(issue(layout, 'docks-share-lane'), 'and the docks now lie in a row: side roads would be better');
  assert.equal(extendDockRoad(layout, 'A', 5), 1, 'only one free cell of the edge is left (5 cells wide)');
  assert.equal(extendDockRoad(layout, 'A', 1), 0, 'nothing left to extend');
  assert.equal(extendDockRoad(layout, 'A', 0), 0);
  assert.equal(extendDockRoad(layout, 'A', -3), 0);
  assert.equal(extendDockRoad(layout, 'A', 'x'), 0);
  assert.equal(extendDockRoad(layout, 'nope', 2), 0);
  const blocked = plant(['.AAAAA..', '.+#.....', '........', '........', '........', '........', '........', '........'], { trucks: { doors: 4 } });
  assert.equal(extendDockRoad(blocked, 'A', 3), 0, 'an obstacle on the edge stops the road');
  const none = plant(['.AAAAA..', '........', '........', '........', '........', '........', '........', '........'], { trucks: { doors: 4 } });
  assert.equal(extendDockRoad(none, 'A', 3), 0, 'no dock to start from');
  const full = plant(['.AA.....', '.++.....', '........', '........', '........', '........', '........', '........'], { trucks: { doors: 3 } });
  assert.equal(extendDockRoad(full, 'A', 1), 0, 'a 2 cell wide station whose edge is full has nothing to extend');
});

test('validateLayout does not need a normalized layout: junk ops blocks are read as far as they go and never throw', () => {
  const layout = dockLab('row', null);
  const id = sourceOf(layout).id;
  for (const ops of [{ trucks: 'x' }, { trucks: 5 }, { trucks: [] }, { trucks: null }, { trucks: {} }, { trucks: { doors: 'x', mode: 'schedule', schedule: 5 } }, { trucks: { doors: 99, mode: 'schedule', schedule: [null, 1] } },
    { trucks: { interArrival: 'x', pallets: [], checkIn: {} } }, 'junk', 5, null, []]) {
    sourceOf(layout).ops = ops;
    assert.doesNotThrow(() => validateLayout(layout), JSON.stringify(ops));
    for (const found of validateLayout(layout)) assert.ok(typeof found.message === 'string' && !/NaN|undefined/.test(`${found.message} ${found.hint}`), `${JSON.stringify(ops)}: ${found.message}`);
    assert.doesNotThrow(() => OWN_CODES.forEach((code) => opsFixFor(layout, { code, refs: { stationId: id } })));
  }
  sourceOf(layout).ops = { trucks: { mode: 'schedule' } };
  assert.ok(issue(layout, 'timetable-empty'), 'a schedule without a list of rows is an empty timetable');
});
