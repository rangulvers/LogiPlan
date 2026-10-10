// Pure helpers of the Fleet and Flows panels and the dialogs (js/ui/panels/{fleet,flows}.js, js/ui/dialogs.js).
// The DOM behaviour is covered by tests/e2e/panels2.mjs (Playwright); everything here runs in Node without a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLayout, addStation, addFlow, addFleet, updateFleet, cloneLayout, checkInvariants,
} from '../js/model/layout.js';
import { STATION_TYPE_ORDER, FLEET_PRESETS, FLEET_PRESET_ORDER, GRID_LIMITS } from '../js/model/defaults.js';
import { exportProject, shareUrl } from '../js/model/serialize.js';
import { EXAMPLES } from '../js/model/examples.js';
import {
  COLOR_CHOICES, PRESET_KEYS, presetName, presetPatch, presetChanges, describeChanges, fleetSummary, vehicleGroup, fleetCounts,
  restrictedFlows, chargingDepots, vehicleBreakdownSummary, batterySummary, homeOptions, idleHint, vehicleRows, VEHICLE_LIST_LIMIT,
} from '../js/ui/panels/fleet.js';
import {
  pairProblem, senders, receivers, missingStations, percentages, outputSplits, outputShare, flowSummary, weightHint, chainChoices, chainPlan, typeName,
} from '../js/ui/panels/flows.js';
import {
  isWelcomeHidden, setWelcomeHidden, WELCOME_KEY, EMPTY_PLANT_SIZES, plantArea, layoutFacts, hasWork, projectFileName, classifyProjectText, parseProjectText,
} from '../js/ui/dialogs.js';

// ---- fleet: vehicle types ---------------------------------------------------------------------------------------

test('every vehicle type has a planner name and a complete patch of its values', () => {
  assert.deepEqual(FLEET_PRESET_ORDER.map(presetName), ['AGV', 'Forklift', 'Tugger train', 'Custom vehicle']);
  assert.equal(presetName('nonsense'), 'Custom vehicle', 'an unknown type reads as custom');
  for (const key of FLEET_PRESET_ORDER) {
    const patch = presetPatch(key);
    assert.deepEqual(Object.keys(patch), [...PRESET_KEYS]);
    for (const k of PRESET_KEYS) assert.equal(patch[k], FLEET_PRESETS[key][k]);
  }
});

test('presetChanges lists exactly the values the planner changed, and applying the patch clears them', () => {
  const layout = createLayout();
  const fleet = addFleet(layout, 'forklift');
  assert.deepEqual(presetChanges(fleet), []);
  updateFleet(layout, fleet.id, { speed: 4, loadTime: 5, name: 'Renamed', count: 9 });
  assert.deepEqual(presetChanges(layout.fleets[0]), ['speed', 'loadTime'], 'name, count, colour and home are not part of a type');
  assert.equal(describeChanges(['speed', 'loadTime']), 'top speed and loading time');
  assert.equal(describeChanges(['speed', 'decel', 'capacity']), 'top speed, braking and capacity');
  assert.equal(describeChanges(['length']), 'length');
  updateFleet(layout, fleet.id, presetPatch('tugger'));
  assert.deepEqual(presetChanges(layout.fleets[0]), [...PRESET_KEYS], 'every tugger value differs from the forklift the fleet still says it is');
  updateFleet(layout, fleet.id, { preset: 'tugger' });
  assert.deepEqual(presetChanges(layout.fleets[0]), [], 'after switching the type the values match it');
  assert.deepEqual(checkInvariants(layout), []);
});

test('the colour choices are eight distinct valid colours that the model accepts', () => {
  assert.equal(COLOR_CHOICES.length, 8);
  assert.equal(new Set(COLOR_CHOICES.map((c) => c.value)).size, 8);
  assert.equal(new Set(COLOR_CHOICES.map((c) => c.name)).size, 8);
  const layout = createLayout();
  const fleet = addFleet(layout, 'agv');
  for (const { value } of COLOR_CHOICES) {
    assert.equal(updateFleet(layout, fleet.id, { color: value }), true);
    assert.equal(layout.fleets[0].color, value);
  }
});

test('fleetSummary says what a collapsed card needs to say', () => {
  const layout = createLayout();
  const fleet = addFleet(layout, 'tugger', { count: 3 });
  assert.equal(fleetSummary(fleet), 'Tugger train · 2 m/s · carries 4 loads');
  assert.equal(fleetSummary({ ...fleet, count: 0 }), 'No vehicles yet');
  assert.equal(fleetSummary({ ...fleet, capacity: 1 }), 'Tugger train · 2 m/s · carries 1 load');
});

// ---- fleet: live status -----------------------------------------------------------------------------------------

test('vehicleGroup sorts every vehicle state into exactly one planner group', () => {
  const v = (state, waiting = false) => ({ state, tv: { waiting } });
  assert.equal(vehicleGroup(v('toPickup')), 'working');
  assert.equal(vehicleGroup(v('loading')), 'working');
  assert.equal(vehicleGroup(v('toDrop')), 'working');
  assert.equal(vehicleGroup(v('unloading')), 'working');
  assert.equal(vehicleGroup(v('idle')), 'idle');
  assert.equal(vehicleGroup(v('parked')), 'idle');
  assert.equal(vehicleGroup(v('toPark')), 'idle');
  assert.equal(vehicleGroup(v('charging')), 'charging');
  assert.equal(vehicleGroup(v('toCharger')), 'charging');
  assert.equal(vehicleGroup(v('broken')), 'down');
  assert.equal(vehicleGroup(v('dead')), 'down');
  assert.equal(vehicleGroup(v('toPickup', true)), 'waiting', 'stuck in traffic beats the job it is on');
  assert.equal(vehicleGroup(v('broken', true)), 'down', 'a breakdown beats waiting');
  assert.equal(vehicleGroup({ state: 'toDrop' }), 'working', 'a vehicle without a traffic body is not waiting');
  assert.equal(vehicleGroup({ state: 'something new' }), 'idle', 'unknown states are not counted as work');
});

test('fleetCounts adds up per fleet and ignores nothing', () => {
  const vehicles = [
    { fleetId: 'v1', state: 'toPickup', tv: { waiting: false } },
    { fleetId: 'v1', state: 'toDrop', tv: { waiting: true } },
    { fleetId: 'v1', state: 'parked', tv: { waiting: false } },
    { fleetId: 'v2', state: 'charging', tv: { waiting: false } },
    { fleetId: 'v2', state: 'broken', tv: { waiting: false } },
  ];
  const counts = fleetCounts(vehicles);
  assert.deepEqual(counts.get('v1'), { total: 3, working: 1, waiting: 1, idle: 1, charging: 0, down: 0 });
  assert.deepEqual(counts.get('v2'), { total: 2, working: 0, waiting: 0, idle: 0, charging: 1, down: 1 });
  for (const c of counts.values()) assert.equal(c.total, c.working + c.waiting + c.idle + c.charging + c.down);
  assert.equal(fleetCounts([]).size, 0);
  assert.equal(fleetCounts(undefined).size, 0, 'no simulation vehicles is fine');
});

// ---- fleet: wording and layout queries ----------------------------------------------------------------------------

test('vehicleRows lists the vehicles of a fleet with their ids, live state and trips per hour; the Fleet tab shows twelve before "Show all"', () => {
  const layout = createLayout();
  const fleet = addFleet(layout, 'agv');
  updateFleet(layout, fleet.id, { name: 'AGVs', count: 30 });
  const f = layout.fleets[0];
  const plain = vehicleRows(f, null, null);
  assert.equal(plain.length, VEHICLE_LIST_LIMIT, 'twelve at first');
  assert.deepEqual(plain[0], { id: 'v1#1', name: 'AGVs 1', group: null, tripsPerHour: null }, 'without a simulation: ids and names only');
  assert.equal(vehicleRows(f, null, null, 999).length, 30, '"Show all"');
  assert.equal(vehicleRows({ ...f, count: 0 }, null, null).length, 0);
  const sim = { vehicles: [{ id: 'v1#1', fleetId: 'v1', state: 'toDrop', tv: { waiting: false } }, { id: 'v1#2', fleetId: 'v1', state: 'toPickup', tv: { waiting: true } }, { id: 'v9#1', fleetId: 'v9', state: 'idle' }] };
  const report = { window: { duration: 1800, warmingUp: false }, fleets: { v1: { vehicleTrips: { 'v1#1': 9, 'v1#2': 0 } } } };
  const live = vehicleRows(f, sim, report, 3);
  assert.deepEqual(live.map((r) => [r.id, r.group, r.tripsPerHour]), [['v1#1', 'working', 18], ['v1#2', 'waiting', 0], ['v1#3', null, null]], 'trips per hour of the report\u2019s window; a vehicle the simulation does not know has no state');
  assert.equal(vehicleRows(f, sim, { window: { duration: 0 }, fleets: report.fleets }, 1)[0].tripsPerHour, null, 'no window yet: no rate (never a division by zero)');
  assert.equal(vehicleRows(f, sim, { window: report.window, fleets: { v1: { vehicleTrips: { 'v1#1': NaN } } } }, 1)[0].tripsPerHour, null, 'a junk count is no number');
});

test('vehicleBreakdownSummary explains availability and nags about a missing repair time', () => {
  assert.deepEqual(vehicleBreakdownSummary(0, 0), { aside: 'never', hint: 'Vehicles never break down.', warn: false });
  const noRepair = vehicleBreakdownSummary(7200, 0);
  assert.equal(noRepair.aside, 'every 2 h');
  assert.equal(noRepair.warn, true);
  const full = vehicleBreakdownSummary(7200, 600);
  assert.equal(full.warn, false);
  assert.match(full.hint, /available about 92 % of the time/);
  assert.match(full.hint, /blocks its lane/);
});

test('batterySummary reads the battery in hours, minutes and percent', () => {
  const b = { enabled: true, runtimeMin: 480, chargeTimeMin: 90, lowPct: 25, resumePct: 90 };
  assert.deepEqual(batterySummary({ ...b, enabled: false }), { aside: 'off', hint: 'Vehicles never run out of charge.' });
  const on = batterySummary(b);
  assert.equal(on.aside, '8 h per charge');
  assert.match(on.hint, /At 25 %/);
  assert.match(on.hint, /1\.5 h/);
  assert.match(on.hint, /90 %/);
});

test('depots: charging depots, home options and the idle hint follow the plant', () => {
  const layout = createLayout({ cols: 30, rows: 20 });
  assert.deepEqual(homeOptions(layout), [{ value: '', label: 'Any depot with a free place' }]);
  assert.deepEqual(chargingDepots(layout), []);
  const park = addStation(layout, { type: 'depot', x: 2, y: 2, name: 'Parking', params: { slots: 4, chargers: 0 } });
  const charge = addStation(layout, { type: 'depot', x: 8, y: 2, name: 'Charging', params: { slots: 1, chargers: 1 } });
  addStation(layout, { type: 'process', x: 14, y: 2 });
  assert.deepEqual(homeOptions(layout).map((o) => [o.value, o.label]), [['', 'Any depot with a free place'], [park.id, 'Parking (4 places)'], [charge.id, 'Charging (1 place)']]);
  assert.deepEqual(chargingDepots(layout).map((s) => s.id), [charge.id], 'only depots with a charger count');
  assert.match(idleHint({ idle: 'park' }, 0), /no depot in the plant/);
  assert.match(idleHint({ idle: 'park' }, 2), /drives to a depot/);
  assert.match(idleHint({ idle: 'stay' }, 0), /block the lane/);
});

test('restrictedFlows finds the flows only one fleet may serve', () => {
  const layout = EXAMPLES.find((e) => e.id === 'two-lines').build();
  const [forklifts, agvs] = layout.fleets;
  assert.deepEqual(restrictedFlows(layout, forklifts.id).map((f) => f.id), ['f1', 'f6']);
  assert.equal(restrictedFlows(layout, agvs.id).length, 4);
  assert.deepEqual(restrictedFlows(layout, 'nobody'), []);
});

// ---- flows: endpoint rules ---------------------------------------------------------------------------------------

test('pairProblem agrees with the model for every pair of station types', () => {
  const layout = createLayout({ cols: 60, rows: 20 });
  const stations = STATION_TYPE_ORDER.map((type, i) => addStation(layout, { type, x: 2 + i * 8, y: 2 }));
  for (const a of stations) {
    for (const b of stations) {
      const probe = cloneLayout(layout);
      const accepted = addFlow(probe, a.id, b.id) !== null;
      assert.equal(pairProblem(layout, a.id, b.id) === null, accepted, `${a.type} -> ${b.type}: ${pairProblem(layout, a.id, b.id)}`);
    }
  }
});

test('pairProblem names the reason in planner language', () => {
  const layout = createLayout({ cols: 60, rows: 20 });
  const source = addStation(layout, { type: 'source', x: 2, y: 2, name: 'Dock' });
  const process = addStation(layout, { type: 'process', x: 10, y: 2, name: 'Press' });
  const sink = addStation(layout, { type: 'sink', x: 20, y: 2, name: 'Shipping' });
  const depot = addStation(layout, { type: 'depot', x: 30, y: 2 });
  assert.equal(pairProblem(layout, '', process.id), 'Pick the station where the loads start.');
  assert.equal(pairProblem(layout, source.id, ''), 'Pick the station the loads go to.');
  assert.equal(pairProblem(layout, process.id, process.id), 'A station cannot send loads to itself.');
  assert.equal(pairProblem(layout, sink.id, process.id), 'Goods out cannot send loads.');
  assert.equal(pairProblem(layout, depot.id, process.id), 'Depot cannot send loads.');
  assert.equal(pairProblem(layout, process.id, source.id), 'Goods in cannot receive loads.');
  assert.equal(pairProblem(layout, process.id, depot.id), 'Depot cannot receive loads.');
  assert.equal(pairProblem(layout, source.id, process.id), null);
  addFlow(layout, source.id, process.id);
  assert.equal(pairProblem(layout, source.id, process.id), 'There is already a flow from Dock to Press.');
  assert.equal(pairProblem(layout, source.id, process.id, { allowExisting: true }), null);
  assert.equal(typeName('process'), 'Workstation');
});

test('senders, receivers and missingStations tell what the plant lacks', () => {
  const layout = createLayout({ cols: 40, rows: 20 });
  assert.match(missingStations(layout), /Place a Goods in, Workstation or Storage/);
  addStation(layout, { type: 'depot', x: 2, y: 2 });
  assert.match(missingStations(layout), /Goods in, Workstation or Storage/, 'a depot is neither');
  addStation(layout, { type: 'source', x: 8, y: 2 });
  assert.match(missingStations(layout), /Place a Workstation, Storage or Goods out/);
  addStation(layout, { type: 'sink', x: 14, y: 2 });
  assert.equal(missingStations(layout), null);
  assert.deepEqual(senders(layout).map((s) => s.type), ['source']);
  assert.deepEqual(receivers(layout).map((s) => s.type), ['sink']);
});

// ---- flows: output shares -----------------------------------------------------------------------------------------

test('percentages are whole numbers that add up to exactly 100', () => {
  assert.deepEqual(percentages([2, 1]), [67, 33]);
  assert.deepEqual(percentages([1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(percentages([1]), [100]);
  assert.deepEqual(percentages([]), []);
  assert.deepEqual(percentages([0, 0]), [0, 0], 'no weight, no share');
  assert.deepEqual(percentages([1000, 0.01]), [100, 0]);
  let seed = 7;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let i = 0; i < 300; i++) {
    const weights = Array.from({ length: 1 + Math.floor(rnd() * 7) }, () => 0.01 + rnd() * 50);
    const result = percentages(weights);
    assert.equal(result.reduce((a, b) => a + b, 0), 100, JSON.stringify(weights));
    weights.forEach((w, j) => assert.ok(Math.abs(result[j] - (w / weights.reduce((a, b) => a + b, 0)) * 100) < 1, 'within one point of the exact share'));
  }
});

test('outputSplits only lists stations with several outgoing flows and shares follow the weights', () => {
  const layout = EXAMPLES.find((e) => e.id === 'two-lines').build();
  const splits = outputSplits(layout);
  assert.equal(splits.length, 1);
  assert.equal(splits[0].station.name, 'Central warehouse');
  assert.deepEqual(splits[0].shares.map((s) => [s.to.name, s.percent]), [['Press line', 67], ['Machining', 33]]);
  const f2 = layout.flows.find((f) => f.id === 'f2');
  const f1 = layout.flows.find((f) => f.id === 'f1');
  assert.equal(outputShare(layout, f2), 67);
  assert.equal(outputShare(layout, f1), 100, 'a lone flow carries everything');
});

test('flowSummary and weightHint describe the flow as the planner set it', () => {
  const layout = EXAMPLES.find((e) => e.id === 'two-lines').build();
  const flow = (id) => layout.flows.find((f) => f.id === id);
  assert.equal(flowSummary(layout, flow('f1')), 'All output · Forklifts');
  assert.equal(flowSummary(layout, flow('f2')), '67 % of output · AGVs');
  assert.equal(flowSummary(layout, flow('f4')), 'All output · 2 per cycle · AGVs');
  assert.equal(flowSummary(layout, flow('f6')), 'All output · High priority · Forklifts');
  flow('f3').fleetId = null;
  flow('f3').priority = 3;
  assert.equal(flowSummary(layout, flow('f3')), '33 % of output · Urgent · any fleet');
  assert.match(weightHint(layout, flow('f2')), /^67 % of the loads from Central warehouse go this way/);
  assert.match(weightHint(layout, flow('f1')), /has only this one flow/);
});

// ---- flows: chaining stations ---------------------------------------------------------------------------------------

function lineLayout() {
  const layout = createLayout({ cols: 80, rows: 20 });
  const ids = {};
  [['source', 'in'], ['storage', 'store'], ['process', 'work'], ['sink', 'out'], ['depot', 'park']].forEach(([type, key], i) => {
    ids[key] = addStation(layout, { type, x: 2 + i * 10, y: 2 }).id;
  });
  return { layout, ids };
}

test('chainChoices offers valid next stations only and ends at Goods out', () => {
  const { layout, ids } = lineLayout();
  assert.deepEqual(chainChoices(layout, []).map((s) => s.id), [ids.in, ids.store, ids.work], 'start with a station that can send');
  assert.deepEqual(chainChoices(layout, [ids.in]).map((s) => s.id), [ids.store, ids.work, ids.out]);
  assert.deepEqual(chainChoices(layout, [ids.in, ids.store]).map((s) => s.id), [ids.work, ids.out], 'a station is used once');
  assert.deepEqual(chainChoices(layout, [ids.in, ids.out]), [], 'nothing leaves Goods out');
  assert.deepEqual(chainChoices(layout, ['gone']), [], 'a vanished station ends the chain');
});

test('chainPlan creates the missing flows, skips existing ones and reports problems', () => {
  const { layout, ids } = lineLayout();
  assert.deepEqual(chainPlan(layout, [ids.in]), { pairs: [], existing: 0, problem: null }, 'one station makes no flow');
  assert.deepEqual(chainPlan(layout, [ids.in, ids.store, ids.work, ids.out]), {
    pairs: [[ids.in, ids.store], [ids.store, ids.work], [ids.work, ids.out]], existing: 0, problem: null,
  });
  addFlow(layout, ids.store, ids.work);
  const plan = chainPlan(layout, [ids.in, ids.store, ids.work, ids.out]);
  assert.deepEqual(plan.pairs, [[ids.in, ids.store], [ids.work, ids.out]]);
  assert.equal(plan.existing, 1);
  assert.equal(chainPlan(layout, [ids.out, ids.work]).problem, 'Goods out cannot send loads.');
  // creating the planned pairs through the model never fails
  for (const [a, b] of plan.pairs) assert.ok(addFlow(layout, a, b));
  assert.deepEqual(chainPlan(layout, [ids.in, ids.store, ids.work, ids.out]).pairs, []);
});

// ---- dialogs ----------------------------------------------------------------------------------------------------------

test('layoutFacts, plantArea and hasWork describe what the welcome screen shows', () => {
  const layout = EXAMPLES.find((e) => e.id === 'starter').build();
  assert.equal(layoutFacts(layout), '4 stations · 2 flows · 2 vehicles');
  assert.equal(layoutFacts(createLayout()), '0 stations · 0 flows');
  assert.equal(plantArea(48, 32, 2), '96 × 64 m');
  assert.equal(plantArea(80, 52, 2.5), '200 × 130 m');
  const fresh = { layout: createLayout(), dirty: false, project: { scenarios: [{}] } };
  assert.equal(hasWork(fresh), false, 'an untouched empty plant has nothing to continue');
  assert.equal(hasWork({ ...fresh, dirty: true }), true);
  assert.equal(hasWork({ ...fresh, project: { scenarios: [{}, {}] } }), true, 'a second scenario is work');
  assert.equal(hasWork({ ...fresh, layout: layout }), true);
  const roads = createLayout();
  roads.roads['1,1'] = { out: 0 };
  assert.equal(hasWork({ ...fresh, layout: roads }), true, 'a single road cell is work');
});

test('the empty-plant sizes are valid, ordered and accepted by the model', () => {
  assert.deepEqual(EMPTY_PLANT_SIZES.map((s) => s.id), ['small', 'medium', 'large']);
  for (const s of EMPTY_PLANT_SIZES) {
    assert.ok(s.cols >= GRID_LIMITS.minCols && s.cols <= GRID_LIMITS.maxCols && s.rows >= GRID_LIMITS.minRows && s.rows <= GRID_LIMITS.maxRows, s.id);
    const layout = createLayout({ cols: s.cols, rows: s.rows, cellSize: 2 });
    assert.deepEqual([layout.grid.cols, layout.grid.rows], [s.cols, s.rows]);
  }
  const cells = EMPTY_PLANT_SIZES.map((s) => s.cols * s.rows);
  assert.deepEqual([...cells].sort((a, b) => a - b), cells, 'small < medium < large');
});

test('projectFileName makes a safe .logiplan.json name', () => {
  assert.equal(projectFileName('Two lines + warehouse'), 'two-lines-warehouse.logiplan.json');
  assert.equal(projectFileName('  Größe / Halle 7!  '), 'grosse-halle-7.logiplan.json', 'umlauts lose their dots, slashes become dashes');
  assert.equal(projectFileName('日本語'), 'logiplan-project.logiplan.json', 'nothing usable left: a generic name');
  assert.equal(projectFileName(''), 'logiplan-project.logiplan.json');
  assert.equal(projectFileName(undefined), 'logiplan-project.logiplan.json');
  assert.doesNotMatch(projectFileName('../../etc/passwd'), /[/\\]/);
});

test('classifyProjectText tells JSON, share links and junk apart', () => {
  assert.equal(classifyProjectText(''), 'empty');
  assert.equal(classifyProjectText('  \n '), 'empty');
  assert.equal(classifyProjectText(undefined), 'empty');
  assert.equal(classifyProjectText('{"app":"logiplan"}'), 'json');
  assert.equal(classifyProjectText('﻿  { }'), 'json');
  assert.equal(classifyProjectText('[1, 2]'), 'json');
  assert.equal(classifyProjectText('https://example.test/app/#p=z.abc-_'), 'share');
  assert.equal(classifyProjectText('#p=p.abc'), 'share');
  assert.equal(classifyProjectText('p=z.abc'), 'share');
  assert.equal(classifyProjectText('z.abcdef'), 'share');
  assert.equal(classifyProjectText('hello world'), 'unknown');
  assert.equal(classifyProjectText('https://example.test/page'), 'unknown');
});

test('parseProjectText reads files, bare layouts and share links, and explains everything else', async () => {
  const layout = EXAMPLES[0].build();
  const project = { name: 'Plant A', activeId: 'a', scenarios: [{ id: 'a', name: 'A', layout }] };
  const fromFile = await parseProjectText(exportProject(project));
  assert.equal(fromFile.name, 'Plant A');
  assert.deepEqual(fromFile.scenarios[0].layout, layout, 'a project file survives the trip unchanged');
  const bare = await parseProjectText(JSON.stringify(layout));
  assert.equal(bare.scenarios.length, 1, 'a bare layout becomes a one-scenario project');
  const link = await shareUrl('https://example.test/app/?x=1#old', project);
  assert.ok(link.startsWith('https://example.test/app/?x=1#p='));
  assert.deepEqual((await parseProjectText(link)).scenarios[0].layout, layout, 'a whole share link');
  assert.deepEqual((await parseProjectText(link.slice(link.indexOf('#p=') + 3))).scenarios[0].layout, layout, 'just its payload');
  assert.deepEqual((await parseProjectText(`Here is the plant: ${link} (valid for ever)`)).scenarios[0].layout, layout, 'a link inside a sentence');
  const wrapped = link.replace(/(.{60})/g, '$1\n');
  assert.deepEqual((await parseProjectText(wrapped)).scenarios[0].layout, layout, 'a link that a mail client wrapped over several lines');
  await assert.rejects(parseProjectText(''), /nothing to open yet/);
  await assert.rejects(parseProjectText('   '), /nothing to open yet/);
  await assert.rejects(parseProjectText('hello'), /does not look like a LogiPlan project file or share link/);
  await assert.rejects(parseProjectText('{ not json'), /not valid JSON/);
  await assert.rejects(parseProjectText('{"hello":"world"}'), /does not look like a LogiPlan project or layout/);
  await assert.rejects(parseProjectText('https://example.test/#p=z.@@@@'), /damaged/);
});

test('the welcome choice is kept in localStorage and a broken storage is harmless', () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const store = new Map();
  try {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    });
    assert.equal(isWelcomeHidden(), false);
    setWelcomeHidden(true);
    assert.equal(store.get(WELCOME_KEY), '1');
    assert.equal(isWelcomeHidden(), true);
    setWelcomeHidden(false);
    assert.equal(store.has(WELCOME_KEY), false);
    assert.equal(isWelcomeHidden(), false);
    const broken = () => { throw new Error('blocked'); };
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: broken, setItem: broken, removeItem: broken } });
    assert.equal(isWelcomeHidden(), false, 'blocked storage reads as "show it"');
    assert.doesNotThrow(() => setWelcomeHidden(true));
    assert.doesNotThrow(() => setWelcomeHidden(false));
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: broken });
    assert.equal(isWelcomeHidden(), false, 'a throwing getter too');
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had);
    else delete globalThis.localStorage;
  }
});
