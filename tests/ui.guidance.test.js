// Guidance (js/ui/guidance.js, docs/ARCHITECTURE.md 6.9): the rules behind the Next steps card, the checklist and the Fix buttons.
// Everything here is pure data in and out, so it runs in Node; the real app is driven by tests/e2e/guidance-logic.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutFromAscii } from './helpers/ascii.js';
import { createStore } from '../js/store/store.js';
import { validateLayout } from '../js/model/validate.js';
import { EXAMPLES } from '../js/model/examples.js';
import {
  createLayout, addStation, addFlow, addFleet, paintRoadPath, removeFlow, flowsFrom, flowsTo, getFlow, checkInvariants, updateFleet,
} from '../js/model/layout.js';
import {
  computeNextSteps, computeChecklist, validDestinations, validOrigins, suggestDestination, suggestOrigin, connectFixFor, applyFix, fixForIssue,
  createDismissals, createProgress, createGuidance, openSteps, DEFAULT_FLEET, RESULTS_AFTER_SECONDS, resultsAfter, DISMISS_KEY, typeName, stationLabel,
} from '../js/ui/guidance.js';
import { rankBySelection, forFlows, forFleet } from '../js/ui/panels/nextsteps.js';

// ---- builders ---------------------------------------------------------------------------------------------

/** Stations A (source) B (process) C (sink) in a row above a road; ids and names are the letters. */
const ROW = [
  '.AA..BBB..CC.',
  '.AA..BBB..CC.',
  '+++++++++++++',
  '.............',
];

function row({ flows = [], fleets = [], stations = { A: 'source', B: 'process', C: 'sink' }, lines = ROW } = {}) {
  return layoutFromAscii(lines, { stations, flows, fleets });
}

const ids = (steps) => steps.map((s) => s.id);
const byId = (steps, id) => steps.find((s) => s.id === id);
const steps = (layout, opts = {}) => computeNextSteps(layout, { issues: [], ...opts });

/** The fix of the connect step of a station, or undefined. */
const connectFix = (list, id) => byId(list, `connect-out:${id}`)?.fix;

// ---- valid ends -------------------------------------------------------------------------------------------

test('validDestinations: only legal receivers, closest first, ties by id, existing flows left out', () => {
  const layout = row({ flows: [['B', 'C']] });
  assert.deepEqual(validDestinations(layout, 'A').map((s) => s.id), ['B', 'C'], 'B is nearer to A than C');
  assert.deepEqual(validDestinations(layout, 'B').map((s) => s.id), [], 'B -> C exists; a process cannot send to a source or itself');
  assert.deepEqual(validDestinations(layout, 'C'), [], 'a Goods out sends nothing');
  assert.deepEqual(validDestinations(layout, 'nope'), []);
  const withDepot = row({ lines: ['.AA..BBB..DD.', '.AA..BBB..DD.', '+++++++++++++', '.............'], stations: { A: 'source', B: 'process', D: 'depot' } });
  assert.deepEqual(validDestinations(withDepot, 'A').map((s) => s.id), ['B'], 'a depot takes part in no flows');
});

test('validDestinations breaks distance ties by id', () => {
  const layout = layoutFromAscii([
    '.AA..BB..DD.',
    '.AA..BB..DD.',
    '++++++++++++',
    '............',
  ], { stations: { A: 'source', B: 'process', D: 'process' } });
  // move D so that B and D are exactly as far from A: mirror B around A is impossible at the edge, so test with two stations at one spot
  layout.stations.find((s) => s.id === 'D').x = layout.stations.find((s) => s.id === 'B').x;
  layout.stations.find((s) => s.id === 'D').y = layout.stations.find((s) => s.id === 'B').y;
  assert.deepEqual(validDestinations(layout, 'A').map((s) => s.id), ['B', 'D'], 'same distance: B before D');
  layout.stations.reverse();
  assert.deepEqual(validDestinations(layout, 'A').map((s) => s.id), ['B', 'D'], 'the order of the stations in the layout does not matter');
});

test('validOrigins: only legal senders, closest first, existing flows left out', () => {
  const layout = row({ flows: [['A', 'B']] });
  assert.deepEqual(validOrigins(layout, 'C').map((s) => s.id), ['B', 'A'], 'B is nearer to C than A');
  assert.deepEqual(validOrigins(layout, 'B').map((s) => s.id), [], 'A -> B exists and a Goods out cannot send');
  assert.deepEqual(validOrigins(layout, 'A'), [], 'a Goods in receives nothing');
});

test('every pair that validDestinations offers is accepted by addFlow, every other one is not', () => {
  const layout = row({ lines: ['.AA.BBB.KK.CC.', '.AA.BBB.KK.CC.', '++++++++++++++', '..............'], stations: { A: 'source', B: 'process', K: 'storage', C: 'sink' }, flows: [['A', 'B']] });
  for (const from of layout.stations) {
    const offered = new Set(validDestinations(layout, from.id).map((s) => s.id));
    for (const to of layout.stations) {
      const probe = structuredClone(layout);
      assert.equal(Boolean(addFlow(probe, from.id, to.id)), offered.has(to.id), `${from.id} -> ${to.id}`);
    }
  }
});

// ---- suggestions ------------------------------------------------------------------------------------------

test('suggestDestination: a Goods in prefers the nearest Storage, else the nearest Workstation', () => {
  const layout = row({ lines: ['.AA.BBB.....KKK.', '.AA.BBB.....KKK.', '++++++++++++++++', '................'], stations: { A: 'source', B: 'process', K: 'storage' } });
  assert.equal(suggestDestination(layout, 'A').id, 'K', 'storage first, although the workstation is nearer');
  const noStorage = row({ stations: { A: 'source', B: 'process', C: 'process' } });
  assert.equal(suggestDestination(noStorage, 'A').id, 'B', 'the nearest workstation');
  addFlow(noStorage, 'A', 'B');
  assert.equal(suggestDestination(noStorage, 'A').id, 'C', 'a workstation it does not feed yet');
  addFlow(noStorage, 'A', 'C');
  assert.equal(suggestDestination(noStorage, 'A'), null, 'nothing left to suggest');
});

test('suggestDestination: a Goods in with only a Goods out in the plant may send straight there', () => {
  const layout = row({ stations: { A: 'source', C: 'sink' }, lines: ['.AA.....CC.', '.AA.....CC.', '+++++++++++', '...........'] });
  assert.equal(suggestDestination(layout, 'A').id, 'C');
});

test('suggestDestination: a Workstation suggests the nearest station downstream and never one that leads into it', () => {
  const layout = layoutFromAscii([
    '.AA..WW..XX..KK.',
    '.AA..WW..XX..KK.',
    '++++++++++++++++',
    '................',
  ], { stations: { A: 'source', W: 'process', X: 'process', K: 'sink' }, flows: [['W', 'X']] });
  assert.equal(suggestDestination(layout, 'X').id, 'K', 'W is nearer to X but feeds it: no loop');
  assert.equal(suggestDestination(layout, 'W').id, 'K', 'W -> X exists already');
  // three in a row: A -> W -> X, the suggestion for X must not close the loop through W
  addFlow(layout, 'A', 'W');
  assert.equal(suggestDestination(layout, 'X').id, 'K');
});

test('suggestDestination: a Storage suggests a Workstation or Goods out, never another storage or an upstream station', () => {
  const layout = layoutFromAscii([
    '.AA..KK..LL..WW..CC.',
    '.AA..KK..LL..WW..CC.',
    '++++++++++++++++++++',
    '....................',
  ], { stations: { A: 'source', K: 'storage', L: 'storage', W: 'process', C: 'sink' } });
  assert.equal(suggestDestination(layout, 'K').id, 'W', 'L is nearer but a storage');
  addFlow(layout, 'W', 'C');
  addFlow(layout, 'K', 'W');
  assert.equal(suggestDestination(layout, 'K').id, 'C');
  assert.equal(suggestDestination(layout, 'L').id, 'W');
  addFlow(layout, 'W', 'C');
  assert.equal(suggestDestination(layout, 'A').id, 'K');
});

test('connectFixFor is the ready-made fix for the suggested destination, or null', () => {
  const layout = row();
  assert.deepEqual(connectFixFor(layout, 'A'), { type: 'connect-flow', fromId: 'A', toId: 'B', pick: 'to', label: 'Connect' });
  assert.equal(connectFixFor(layout, 'C'), null, 'a Goods out sends nothing');
  const { ctx, store } = appCtx(layout);
  assert.equal(applyFix(ctx, connectFixFor(store.getState().layout, 'A')), true);
  assert.deepEqual(flowsFrom(store.getState().layout, 'A').map((f) => f.to), ['B']);
});

test('suggestDestination: null for stations that cannot send and for unknown ids', () => {
  const layout = row();
  assert.equal(suggestDestination(layout, 'C'), null);
  assert.equal(suggestDestination(layout, 'zzz'), null);
});

test('suggestOrigin mirrors it: the nearest Goods in feeds a Workstation, a Workstation feeds a Goods out, never a station downstream', () => {
  const layout = layoutFromAscii([
    '.AA..PP..QQ..CC.',
    '.AA..PP..QQ..CC.',
    '++++++++++++++++',
    '................',
  ], { stations: { A: 'source', P: 'process', Q: 'process', C: 'sink' }, flows: [['P', 'Q']] });
  assert.equal(suggestOrigin(layout, 'C').id, 'Q', 'the nearest workstation');
  assert.equal(suggestOrigin(layout, 'P').id, 'A', 'a source, not Q (downstream of P)');
  assert.equal(suggestOrigin(layout, 'Q').id, 'A', 'P -> Q exists; the source is left');
  assert.equal(suggestOrigin(layout, 'A'), null, 'a Goods in is fed by nothing');
});

test('quality on laid-out plants: chaining suggestions builds a valid, loop-free, duplicate-free network', () => {
  for (const example of EXAMPLES) {
    const layout = example.build();
    layout.flows = [];
    connectAll(layout);
    assertSound(layout, example.id);
    for (const s of layout.stations) {
      if (s.type === 'source') assert.ok(flowsFrom(layout, s.id).length > 0, `${example.id}: ${s.name} sends loads somewhere`);
    }
  }
});

test('quality on random plants (seeded): the suggestion chain always ends and stays sound', () => {
  let seed = 12345;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const types = ['source', 'process', 'storage', 'sink', 'process', 'source'];
  for (let run = 0; run < 40; run++) {
    const layout = createLayout({ cols: 60, rows: 40 });
    const count = 3 + rand(8);
    for (let i = 0; i < count; i++) addStation(layout, { type: types[rand(types.length)], x: rand(52), y: rand(32) });
    if (layout.stations.length < 2) continue;
    connectAll(layout);
    assertSound(layout, `run ${run}`);
  }
});

/** Apply the suggested connect-flow fix of the first open connect step until none is left. */
function connectAll(layout) {
  for (let i = 0; i < 100; i++) {
    const fix = computeNextSteps(layout, { issues: [] }).map((s) => s.fix).find((f) => f?.type === 'connect-flow');
    if (!fix) return;
    assert.ok(addFlow(layout, fix.fromId, fix.toId), `the suggested flow ${fix.fromId} -> ${fix.toId} is legal and new`);
  }
  assert.fail('the suggestions never ran out');
}

function assertSound(layout, what) {
  assert.deepEqual(checkInvariants(layout), [], `${what}: layout invariants`);
  const pairs = layout.flows.map((f) => `${f.from}>${f.to}`);
  assert.equal(new Set(pairs).size, pairs.length, `${what}: no duplicate flow`);
  const color = new Map();
  const visit = (id) => {
    if (color.get(id) === 1) assert.fail(`${what}: a loop through ${id}`);
    if (color.get(id) === 2) return;
    color.set(id, 1);
    for (const f of flowsFrom(layout, id)) visit(f.to);
    color.set(id, 2);
  };
  for (const s of layout.stations) visit(s.id);
}

// ---- rules: roads, stations, docks ----------------------------------------------------------------------

test('no road: fires without roads and stops with the first road; the fix is the Road tool', () => {
  const empty = createLayout({});
  const step = byId(steps(empty), 'no-road');
  assert.equal(step.title, 'Draw your first road');
  assert.deepEqual(step.fix, { type: 'set-tool', tool: 'road', label: 'Road tool' });
  paintRoadPath(empty, [[2, 2], [3, 2]]);
  assert.equal(byId(steps(empty), 'no-road'), undefined);
});

test('no stations: asks for a Goods in and a Workstation next to the road; once a station exists a plant without a Goods in asks for one', () => {
  const empty = createLayout({});
  paintRoadPath(empty, [[2, 2], [3, 2]]);
  const first = steps(empty);
  assert.equal(byId(first, 'place-stations').title, 'Place a Goods in and a Workstation next to the road');
  assert.deepEqual(ids(first), ['place-stations']);
  addStation(empty, { type: 'process', x: 2, y: 3 });
  const second = steps(empty);
  assert.equal(byId(second, 'place-stations'), undefined);
  assert.equal(byId(second, 'no-source').fix.tool, 'source');
  assert.equal(byId(second, 'no-source').dismissible, true);
  addStation(empty, { type: 'source', x: 5, y: 3 });
  assert.equal(byId(steps(empty), 'no-source'), undefined);
});

test('an empty plant shows the road step before the stations step', () => {
  assert.deepEqual(ids(steps(createLayout({}))), ['no-road', 'place-stations']);
});

test('a station that touches no road: "X does not touch a road", with a focus fix and a hint to move it', () => {
  const layout = row();
  const far = layoutFromAscii(['.AA.........', '.AA.........', '............', '............', '++++++++....', '............'], { stations: { A: 'source' }, fleets: [] });
  assert.equal(byId(steps(layout), 'no-dock:A'), undefined, 'docked stations are fine');
  const step = byId(steps(far), 'no-dock:A');
  assert.equal(step.title, 'A does not touch a road');
  assert.match(step.text, /Vehicles cannot reach it/);
  assert.equal(step.severity, 'warn');
  assert.equal(step.fix.type, 'focus');
  assert.deepEqual(step.fix.refs, { stationIds: ['A'] });
  assert.match(step.fix.hint, /drag it next to a road/i);
  const noRoads = createLayout({});
  addStation(noRoads, { type: 'source', x: 2, y: 2 });
  assert.deepEqual(ids(steps(noRoads)).filter((i) => i.startsWith('no-dock')), [], 'with no road at all the road step speaks first');
});

// ---- rules: connections ---------------------------------------------------------------------------------

test('a Goods in with no outgoing flow: "X is not connected yet. Where should its loads go?" with the suggested destination', () => {
  const layout = row();
  const step = byId(steps(layout), 'connect-out:A');
  assert.equal(step.title, 'A is not connected yet');
  assert.match(step.text, /Where should its loads go\?/);
  assert.match(step.text, /Vehicles pick up from every connected Goods in automatically/);
  assert.equal(step.severity, 'warn');
  assert.deepEqual(step.fix, { type: 'connect-flow', fromId: 'A', toId: 'B', pick: 'to', label: 'Connect' });
  assert.deepEqual(step.refs, { stationIds: ['A'] });
  addFlow(layout, 'A', 'B');
  assert.equal(byId(steps(layout), 'connect-out:A'), undefined, 'connected: the step is gone');
});

test('workstations and storages with no outgoing flow ask where their loads go; Goods out and depots never do', () => {
  const layout = layoutFromAscii([
    '.AA..PP..KK..CC..DD.',
    '.AA..PP..KK..CC..DD.',
    '++++++++++++++++++++',
    '....................',
  ], { stations: { A: 'source', P: 'process', K: 'storage', C: 'sink', D: 'depot' }, flows: [['A', 'P']] });
  const list = steps(layout);
  assert.ok(byId(list, 'connect-out:P'), 'a workstation');
  assert.ok(byId(list, 'connect-out:K'), 'a storage');
  assert.equal(byId(list, 'connect-out:C'), undefined);
  assert.equal(byId(list, 'connect-out:D'), undefined);
  assert.equal(byId(list, 'connect-out:P').dismissible, true, 'a last workstation may legitimately end the line');
  assert.equal(byId(list, 'connect-out:K').dismissible, false);
  assert.equal(byId(list, 'connect-out:P').severity, 'todo', 'the checks tab calls this a note, so it is no warning');
});

test('with nowhere to send the loads the step says what to place instead', () => {
  const lonely = layoutFromAscii(['.AA.......', '.AA.......', '++++++++++', '..........'], { stations: { A: 'source' } });
  const step = byId(steps(lonely), 'connect-out:A');
  assert.equal(step.fix.type, 'set-tool');
  assert.equal(step.fix.tool, 'process');
  assert.match(step.text, /Place a Workstation, Storage or Goods out/);
  const noSink = layoutFromAscii(['.AA..PP...', '.AA..PP...', '++++++++++', '..........'], { stations: { A: 'source', P: 'process' }, flows: [['A', 'P']] });
  const last = byId(steps(noSink), 'connect-out:P');
  assert.equal(last.fix.tool, 'sink');
  assert.match(last.text, /Place a Goods out/);
});

test('"Nothing feeds X yet": a Workstation, Storage or Goods out nothing reaches, while an origin exists', () => {
  const layout = layoutFromAscii([
    '.AA..PP..QQ..CC.',
    '.AA..PP..QQ..CC.',
    '++++++++++++++++',
    '................',
  ], { stations: { A: 'source', P: 'process', Q: 'process', C: 'sink' }, flows: [['A', 'P'], ['P', 'C']] });
  const step = byId(steps(layout), 'connect-in:Q');
  assert.equal(step.title, 'Nothing feeds Q yet');
  assert.equal(step.fix.type, 'connect-flow');
  assert.equal(step.fix.pick, 'from');
  assert.equal(step.fix.toId, 'Q');
  assert.equal(step.fix.fromId, 'A', 'the nearest source');
  assert.equal(byId(steps(layout), 'connect-in:P'), undefined, 'fed');
  assert.equal(byId(steps(layout), 'connect-in:C'), undefined, 'fed');
  // no possible origin: only a sink and a workstation, nothing can send
  const noOrigin = layoutFromAscii(['.CC.......', '.CC.......', '++++++++++', '..........'], { stations: { C: 'sink' } });
  assert.deepEqual(ids(steps(noOrigin)).filter((i) => i.startsWith('connect-in')), []);
});

test('suggestions build on each other, so a fresh plant needs two connections, not four', () => {
  const list = steps(row());
  assert.deepEqual(ids(list), ['connect-out:A', 'connect-out:B']);
  assert.equal(list[0].fix.toId, 'B');
  assert.equal(list[1].fix.toId, 'C');
});

test('a plant that is connected has no connect steps, whichever way it got there', () => {
  const layout = row({ flows: [['A', 'B'], ['B', 'C']], fleets: [{ count: 2 }] });
  assert.deepEqual(ids(steps(layout, { hasRun: true })).filter((i) => i.startsWith('connect')), []);
});

// ---- rules: vehicles ------------------------------------------------------------------------------------

test('flows but no fleet: "Add vehicles to move the loads" with an add-fleet fix of two AGVs', () => {
  const layout = row({ flows: [['A', 'B'], ['B', 'C']] });
  const step = byId(steps(layout), 'no-fleet');
  assert.equal(step.title, 'Add vehicles to move the loads');
  assert.deepEqual(step.fix, { type: 'add-fleet', preset: 'agv', count: 2, label: 'Add vehicles' });
  assert.deepEqual(DEFAULT_FLEET, { preset: 'agv', count: 2 });
  assert.equal(byId(steps(row({ flows: [] })), 'no-fleet'), undefined, 'nothing to move without flows');
  assert.equal(byId(steps(row({ flows: [['A', 'B']], fleets: [{ count: 1 }] })), 'no-fleet'), undefined, 'with vehicles');
});

test('a fleet with zero vehicles: the step raises that fleet instead of adding another', () => {
  const layout = row({ flows: [['A', 'B'], ['B', 'C']], fleets: [{ count: 0, name: 'Tuggers', preset: 'tugger' }] });
  const step = byId(steps(layout), 'fleet-empty:v1');
  assert.equal(step.title, 'Tuggers has no vehicles');
  assert.equal(step.fix.type, 'add-fleet');
  assert.equal(step.fix.fleetId, 'v1');
  assert.equal(step.fix.count, 2);
  assert.equal(byId(steps(layout), 'no-fleet'), undefined);
  const two = row({ flows: [['A', 'B'], ['B', 'C']], fleets: [{ count: 0 }, { count: 3 }] });
  assert.deepEqual(ids(steps(two)).filter((i) => i.includes('fleet')), [], 'another fleet has vehicles');
});

test('a note about parking appears once there are vehicles and no depot, and can be dismissed', () => {
  const layout = row({ flows: [['A', 'B'], ['B', 'C']], fleets: [{ count: 2 }] });
  const step = byId(steps(layout, { hasRun: true }), 'info:no-depot');
  assert.equal(step.severity, 'info');
  assert.match(step.text, /Idle vehicles wait on the road\. Add a Parking & charging depot so they park out of the way/);
  assert.equal(step.fix.tool, 'depot');
  assert.equal(step.dismissible, true);
  const withDepot = row({
    lines: ['.AA..BBB..CC..DD', '.AA..BBB..CC..DD', '++++++++++++++++', '................'], stations: { A: 'source', B: 'process', C: 'sink', D: 'depot' },
    flows: [['A', 'B'], ['B', 'C']], fleets: [{ count: 2 }],
  });
  assert.equal(byId(steps(withDepot, { hasRun: true }), 'info:no-depot'), undefined);
  assert.equal(byId(steps(row({ flows: [['A', 'B']] }), { hasRun: true }), 'info:no-depot'), undefined, 'no vehicles: the fleet step comes first');
});

test('a flow with no route: a focus step for the flow (from the checks)', () => {
  const split = layoutFromAscii([
    '.AA.......BB.',
    '.AA.......BB.',
    '+++.......+++',
    '.............',
  ], { stations: { A: 'source', B: 'process' }, flows: [['A', 'B']], fleets: [{ count: 1 }] });
  const issues = validateLayout(split);
  assert.ok(issues.some((i) => i.code === 'flow-unreachable'));
  const step = byId(computeNextSteps(split, { issues }), 'no-route:f1');
  assert.equal(step.title, 'No route from A to B');
  assert.deepEqual(step.fix, { type: 'focus', refs: { flowIds: ['f1'] }, label: 'Show me' });
  assert.equal(byId(computeNextSteps(row({ flows: [['A', 'B']] }), { issues: validateLayout(row({ flows: [['A', 'B']] })) }), 'no-route:f1'), undefined);
});

// ---- rules: run and results -----------------------------------------------------------------------------

const complete = () => row({ flows: [['A', 'B'], ['B', 'C']], fleets: [{ count: 2 }] });

test('a complete plant that never ran: "Press play to watch it run"; running or having run silences it', () => {
  const layout = complete();
  const step = byId(steps(layout), 'run:press-play');
  assert.equal(step.title, 'Press play to watch it run');
  assert.deepEqual(step.fix, { type: 'run', label: 'Run' });
  assert.equal(byId(steps(layout, { simRunning: true }), 'run:press-play'), undefined);
  assert.equal(byId(steps(layout, { simulatedSeconds: 5 }), 'run:press-play'), undefined);
  assert.equal(byId(steps(layout, { hasRun: true }), 'run:press-play'), undefined, 'an edit that restarts the clock does not make it new');
  assert.equal(byId(steps(row({ flows: [['A', 'B']] })), 'run:press-play'), undefined, 'not while something is open');
  assert.equal(byId(steps(row()), 'run:press-play'), undefined);
});

test('once the warm-up is over and five minutes were measured: "Open Results to find the bottleneck" until the results were opened', () => {
  const layout = complete();
  const due = resultsAfter(layout);
  assert.equal(due, layout.settings.warmup + RESULTS_AFTER_SECONDS, 'the first minutes are warm-up and not counted: the Results tab has nothing before');
  assert.equal(byId(steps(layout, { simulatedSeconds: RESULTS_AFTER_SECONDS, hasRun: true }), 'run:open-results'), undefined, 'not while the warm-up runs');
  assert.equal(byId(steps(layout, { simulatedSeconds: due - 1, hasRun: true }), 'run:open-results'), undefined);
  const step = byId(steps(layout, { simulatedSeconds: due, hasRun: true }), 'run:open-results');
  assert.equal(step.title, 'Open Results to find the bottleneck');
  assert.deepEqual(step.fix, { type: 'set-tab', tab: 'results', label: 'Open Results' });
  assert.equal(byId(steps(layout, { simulatedSeconds: 900, hasRun: true, resultsSeen: true }), 'run:open-results'), undefined);
});

test('what is left in the checks that no step covers shows up as one "to check" step, and never hides "press play"', () => {
  const layout = complete();
  const issues = [{ id: 'storage-small:K', severity: 'warning', code: 'storage-small', message: 'm', hint: 'h', refs: {} }, { id: 'duplicate-names:x', severity: 'info', code: 'duplicate-names', message: 'm', hint: 'h', refs: {} }];
  const list = computeNextSteps(layout, { issues });
  assert.equal(byId(list, 'open-checks').title, '1 thing to check');
  assert.equal(byId(list, 'open-checks').fix.tab, 'checks');
  assert.ok(byId(list, 'run:press-play'));
  assert.equal(byId(computeNextSteps(layout, { issues: [{ ...issues[0], code: 'source-no-outflow' }] }), 'open-checks'), undefined, 'covered by a step of its own');
});

// ---- the model note ---------------------------------------------------------------------------------------

test('two Goods in, all connected: the note that vehicles serve every Goods in automatically', () => {
  const two = layoutFromAscii([
    '.AA..BBB..CC..SS.',
    '.AA..BBB..CC..SS.',
    '+++++++++++++++++',
    '.................',
  ], { stations: { A: 'source', S: 'source', B: 'process', C: 'sink' }, flows: [['A', 'B'], ['S', 'B'], ['B', 'C']], fleets: [{ count: 2 }] });
  const note = byId(steps(two, { hasRun: true }), 'info:vehicles-serve-all');
  assert.equal(note.severity, 'info');
  assert.equal(note.title, 'Your AGVs serve every Goods in automatically');
  assert.match(note.text, /Every free AGV takes the nearest job first, whichever Goods in it comes from\. Change this in Simulate › Dispatch strategy\./);
  assert.equal(note.fix.tab, 'simulate');
  assert.deepEqual(note.scopes, ['flows', 'fleet']);
  two.settings.dispatch = 'oldest';
  assert.match(byId(steps(two, { hasRun: true }), 'info:vehicles-serve-all').text, /oldest job first/);
  assert.equal(byId(steps(complete(), { hasRun: true }), 'info:vehicles-serve-all'), undefined, 'one Goods in: nothing to explain');
  const forklifts = structuredClone(two);
  forklifts.fleets[0].preset = 'forklift';
  assert.equal(byId(steps(forklifts, { hasRun: true }), 'info:vehicles-serve-all').title, 'Your vehicles serve every Goods in automatically');
  const unconnected = structuredClone(two);
  unconnected.flows = unconnected.flows.filter((f) => f.from !== 'S');
  assert.equal(byId(steps(unconnected, { hasRun: true }), 'info:vehicles-serve-all'), undefined, 'not while one is unconnected');
  assert.ok(byId(steps(unconnected, { hasRun: true }), 'connect-out:S'));
});

// ---- order, stable ids, dismissals ----------------------------------------------------------------------

test('steps come in the order of work, notes last', () => {
  const layout = layoutFromAscii([
    '.AA..BBB..CC..DD.',
    '.AA..BBB..CC..DD.',
    '+++++++++++++++++',
    '.................',
  ], { stations: { A: 'source', B: 'process', C: 'sink', D: 'source' }, flows: [['A', 'B'], ['B', 'C']], fleets: [{ count: 2 }] });
  layout.stations.push({ ...structuredClone(layout.stations[0]), id: 'Z', name: 'Z', x: 10, y: 8, w: 2, h: 2 }); // off the road
  const list = steps(layout, { hasRun: true });
  const order = ids(list);
  assert.ok(order.indexOf('no-dock:Z') < order.indexOf('connect-out:D'), 'docks before connections');
  assert.equal(order.at(-1), 'info:no-depot', 'notes at the end');
  assert.ok(list.filter((s) => s.severity === 'info').every((s) => list.indexOf(s) > list.findIndex((o) => o.severity === 'warn')));
});

test('step ids are stable and unique: the same plant gives the same ids, an unrelated edit keeps them', () => {
  const a = steps(row());
  const b = steps(row());
  assert.deepEqual(ids(a), ids(b));
  assert.equal(new Set(ids(a)).size, ids(a).length);
  const edited = row();
  edited.name = 'Renamed';
  edited.notes = 'x';
  assert.deepEqual(ids(steps(edited)), ids(a));
  addStation(edited, { type: 'source', x: 10, y: 4, w: 2, h: 2 });
  assert.ok(ids(steps(edited)).includes('connect-out:A'), 'steps of other stations keep their id');
});

test('dismissals hide dismissible steps only', () => {
  const dismissed = new Set(['connect-out:A', 'info:no-depot', 'no-road']);
  const layout = complete();
  const list = computeNextSteps(layout, { issues: [], hasRun: true, dismissed });
  assert.equal(byId(list, 'info:no-depot'), undefined);
  const open = row();
  const stations = computeNextSteps(open, { issues: [], dismissed });
  assert.ok(byId(stations, 'connect-out:A'), 'the connect step of a Goods in cannot be dismissed');
  const empty = computeNextSteps(createLayout({}), { issues: [], dismissed });
  assert.ok(byId(empty, 'no-road'), 'neither can the road step');
});

test('createDismissals: remembered in storage, tolerant of broken storage and junk', () => {
  const data = new Map();
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
  const first = createDismissals({ storage });
  assert.equal(first.has('info:no-depot'), false);
  let calls = 0;
  first.subscribe(() => { calls += 1; });
  assert.equal(first.add('info:no-depot'), true);
  assert.equal(first.add('info:no-depot'), false, 'twice is a no-op');
  assert.equal(first.has('info:no-depot'), true);
  assert.equal(calls, 1);
  assert.equal(first.version, 1);
  assert.deepEqual(JSON.parse(data.get(DISMISS_KEY)), ['info:no-depot']);
  assert.equal(DISMISS_KEY, 'logiplan:guidance-dismissed');
  const second = createDismissals({ storage });
  assert.equal(second.has('info:no-depot'), true, 'a new visit still knows');
  assert.equal(second.remove('info:no-depot'), true);
  assert.deepEqual(JSON.parse(data.get(DISMISS_KEY)), []);
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); } };
  const safe = createDismissals({ storage: throwing });
  assert.equal(safe.add('x'), true, 'works in memory when storage throws');
  assert.equal(safe.has('x'), true);
  data.set(DISMISS_KEY, '{not json');
  assert.equal(createDismissals({ storage }).list().length, 0);
  data.set(DISMISS_KEY, JSON.stringify(['ok', 5, null, { a: 1 }]));
  assert.deepEqual(createDismissals({ storage }).list(), ['ok']);
  assert.equal(createDismissals({ storage: null }).add('y'), true, 'no storage at all');
});

// ---- checklist --------------------------------------------------------------------------------------------

test('the checklist walks through the six steps as the plant is built', () => {
  const layout = createLayout({ cols: 40, rows: 24 });
  const done = (info) => computeChecklist(layout, info).items.filter((i) => i.done).map((i) => i.id);
  assert.deepEqual(computeChecklist(layout).items.map((i) => i.title), [
    'Draw roads', 'Place stations next to the road', 'Connect them with flows', 'Add vehicles', 'Run the simulation', 'Read the results']);
  assert.deepEqual(done(), []);
  assert.equal(computeChecklist(layout).items.find((i) => i.current).id, 'roads');
  paintRoadPath(layout, [[2, 6], [20, 6]]);
  assert.deepEqual(done(), ['roads']);
  assert.equal(computeChecklist(layout).items.find((i) => i.current).id, 'stations');
  addStation(layout, { type: 'source', x: 2, y: 4 });
  assert.deepEqual(done(), ['roads'], 'a Goods in alone is not enough');
  const w = addStation(layout, { type: 'process', x: 8, y: 3 });
  const k = addStation(layout, { type: 'sink', x: 14, y: 4 });
  assert.deepEqual(done(), ['roads', 'stations']);
  addStation(layout, { type: 'storage', x: 30, y: 15 });
  assert.deepEqual(done(), ['roads'], 'a station off the road takes "place stations" back');
  layout.stations.pop();
  assert.equal(computeChecklist(layout).items.find((i) => i.current).id, 'flows');
  addFlow(layout, 's1', w.id);
  assert.deepEqual(done(), ['roads', 'stations'], 'the sink is still not fed');
  addFlow(layout, w.id, k.id);
  assert.deepEqual(done(), ['roads', 'stations', 'flows']);
  addFleet(layout, 'agv');
  assert.deepEqual(done(), ['roads', 'stations', 'flows', 'fleet']);
  assert.deepEqual(done({ ran: true }), ['roads', 'stations', 'flows', 'fleet', 'run']);
  assert.deepEqual(done({ simulatedSeconds: 3 }), ['roads', 'stations', 'flows', 'fleet', 'run']);
  assert.deepEqual(done({ simRunning: true }), ['roads', 'stations', 'flows', 'fleet', 'run']);
  assert.deepEqual(done({ resultsSeen: true }), ['roads', 'stations', 'flows', 'fleet'], 'results only count after a run');
  const all = computeChecklist(layout, { ran: true, resultsSeen: true });
  assert.equal(all.complete, true);
  assert.equal(all.done, 6);
  assert.equal(all.total, 6);
  assert.equal(all.items.find((i) => i.current), undefined);
  const removed = structuredClone(layout);
  removeFlow(removed, getFlow(removed, 'f1').id);
  assert.equal(computeChecklist(removed, { ran: true, resultsSeen: true }).complete, false, 'live: removing a flow takes the item back');
});

test('every checklist row has a fix that performs or opens it', () => {
  const items = computeChecklist(createLayout({})).items;
  assert.deepEqual(items.map((i) => i.fix.type), ['set-tool', 'set-tool', 'set-tool', 'set-tab', 'run', 'set-tab']);
  assert.deepEqual(items.map((i) => i.fix.tool || i.fix.tab || ''), ['road', 'source', 'flow', 'fleet', '', 'results']);
  const placed = row();
  assert.equal(computeChecklist(placed).items[1].fix.tool, 'source', 'all stations are there: a hint to place another');
  const halfway = layoutFromAscii(['.AA.....', '.AA.....', '++++++++', '........'], { stations: { A: 'source' } });
  assert.equal(computeChecklist(halfway).items[1].fix.tool, 'process', 'the missing kind of station comes next');
});

// ---- progress ---------------------------------------------------------------------------------------------

test('createProgress remembers that the plant ran, for how long and whether the results were opened', () => {
  const progress = createProgress();
  assert.deepEqual(progress.get('sc1'), { ran: false, maxSeconds: 0, resultsSeen: false });
  progress.observe('sc1', { rightTab: 'results' });
  assert.equal(progress.get('sc1').resultsSeen, false, 'opening Results before a run is not reading results');
  progress.observe('sc1', { simRunning: true, simulatedSeconds: 10 });
  assert.equal(progress.get('sc1').ran, true);
  progress.observe('sc1', { simulatedSeconds: 0 });
  assert.equal(progress.get('sc1').ran, true, 'a restart at 0:00 keeps it');
  progress.observe('sc1', { simulatedSeconds: 400 });
  progress.observe('sc1', { simulatedSeconds: 50 });
  assert.equal(progress.get('sc1').maxSeconds, 400);
  progress.observe('sc1', { rightTab: 'results' });
  assert.equal(progress.get('sc1').resultsSeen, true);
  assert.equal(progress.get('sc2').ran, false, 'per plant');
  progress.reset();
  assert.equal(progress.get('sc1').ran, false);
});

// ---- applyFix ---------------------------------------------------------------------------------------------

function appCtx(layout, { playing = false } = {}) {
  const store = createStore({ storage: null });
  store.newProject(layout);
  const calls = [];
  const toasts = [];
  const runner = { playing, time: 0, play() { calls.push(['play']); this.playing = true; return Promise.resolve(true); }, toggle() { calls.push(['toggle']); return Promise.resolve(true); } };
  const ctx = {
    store, runner,
    toast: (msg, opts = {}) => { toasts.push({ msg, ...opts }); return { close() {} }; },
    issues: () => validateLayout(store.getState().layout),
    actions: { setTool: (t) => calls.push(['tool', t]), focus: (r) => calls.push(['focus', r]), setRightTab: (t) => calls.push(['tab', t]) },
  };
  return { ctx, store, calls, toasts };
}

test('applyFix connect-flow: one undoable commit with a clear label, the flow is selected, the toast offers Undo', () => {
  const { ctx, store, toasts } = appCtx(row());
  const fix = connectFix(steps(store.getState().layout), 'A');
  assert.equal(applyFix(ctx, fix), true);
  const state = store.getState();
  assert.equal(state.layout.flows.length, 1);
  assert.deepEqual([state.layout.flows[0].from, state.layout.flows[0].to], ['A', 'B']);
  assert.equal(state.undoLabel, 'Connect A → B');
  assert.deepEqual(state.ui.selection, { kind: 'flow', ids: [state.layout.flows[0].id] });
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].msg, 'Flow created. Vehicles will serve it automatically.');
  assert.equal(toasts[0].kind, 'success');
  assert.equal(toasts[0].action.label, 'Undo');
  toasts[0].action.onClick();
  assert.equal(store.getState().layout.flows.length, 0, 'Undo takes the flow away again');
});

test('applyFix connect-flow: the Undo of a toast does nothing once the plant changed again', () => {
  const { ctx, store, toasts } = appCtx(row());
  applyFix(ctx, { type: 'connect-flow', fromId: 'A', toId: 'B' });
  applyFix(ctx, { type: 'connect-flow', fromId: 'B', toId: 'C' });
  toasts[0].action.onClick();
  assert.equal(store.getState().layout.flows.length, 2, 'the first toast is outdated: the later edit stays');
  toasts[1].action.onClick();
  assert.equal(store.getState().layout.flows.length, 1);
});

test('applyFix connect-flow: a duplicate or illegal pair changes nothing and says why', () => {
  const { ctx, store, toasts } = appCtx(row({ flows: [['A', 'B']] }));
  const before = store.getState().layout;
  assert.equal(applyFix(ctx, { type: 'connect-flow', fromId: 'A', toId: 'B' }), false);
  assert.equal(store.getState().layout, before, 'no commit');
  assert.equal(toasts.at(-1).kind, 'warn');
  assert.match(toasts.at(-1).msg, /already sends loads/);
  assert.equal(applyFix(ctx, { type: 'connect-flow', fromId: 'C', toId: 'B' }), false);
  assert.match(toasts.at(-1).msg, /cannot send loads/);
  assert.equal(applyFix(ctx, { type: 'connect-flow', fromId: 'A', toId: 'gone' }), false);
  assert.equal(store.getState().layout.flows.length, 1);
  assert.equal(store.getState().canUndo, false);
});

test('applyFix connect-flow accepts the station the planner picked instead of the suggestion', () => {
  const { ctx, store } = appCtx(row());
  applyFix(ctx, { type: 'connect-flow', fromId: 'A', toId: 'C', pick: 'to' });
  assert.equal(store.getState().undoLabel, 'Connect A → C');
});

test('applyFix add-fleet adds two AGVs as one named commit and selects the fleet', () => {
  const { ctx, store, toasts } = appCtx(row({ flows: [['A', 'B'], ['B', 'C']] }));
  const fix = byId(steps(store.getState().layout), 'no-fleet').fix;
  assert.equal(applyFix(ctx, fix), true);
  const { layout, undoLabel, ui } = store.getState();
  assert.equal(layout.fleets.length, 1);
  assert.equal(layout.fleets[0].count, 2);
  assert.equal(layout.fleets[0].preset, 'agv');
  assert.equal(undoLabel, 'Add AGV fleet');
  assert.deepEqual(ui.selection, { kind: 'fleet', ids: [layout.fleets[0].id] });
  assert.match(toasts[0].msg, /Added 2 AGVs\. They serve every flow automatically\./);
  assert.equal(computeNextSteps(layout, { issues: [] }).some((s) => s.id === 'no-fleet'), false);
});

test('applyFix add-fleet with a fleetId raises that fleet', () => {
  const { ctx, store } = appCtx(row({ flows: [['A', 'B']], fleets: [{ count: 0 }] }));
  assert.equal(applyFix(ctx, byId(steps(store.getState().layout), 'fleet-empty:v1').fix), true);
  assert.equal(store.getState().layout.fleets[0].count, 2);
  assert.equal(store.getState().layout.fleets.length, 1);
  assert.match(store.getState().undoLabel, /vehicles/);
  assert.equal(applyFix(ctx, { type: 'add-fleet', fleetId: 'nope', count: 2 }), false);
});

test('applyFix drives the shell for the other fix types', () => {
  const { ctx, calls, toasts } = appCtx(complete());
  assert.equal(applyFix(ctx, { type: 'set-tool', tool: 'road' }), true);
  assert.equal(applyFix(ctx, { type: 'focus', refs: { stationIds: ['A'] }, hint: 'Drag it.' }), true);
  assert.equal(applyFix(ctx, { type: 'set-tab', tab: 'results' }), true);
  assert.equal(applyFix(ctx, { type: 'run' }), true);
  assert.deepEqual(calls, [['tool', 'road'], ['focus', { stationIds: ['A'] }], ['tab', 'results'], ['play']]);
  assert.equal(toasts.at(-1).msg, 'Drag it.');
  ctx.runner.playing = true;
  applyFix(ctx, { type: 'run' });
  assert.equal(calls.filter((c) => c[0] === 'play').length, 1, 'running already: nothing to start');
  assert.equal(applyFix(ctx, { type: 'unknown' }), false);
  assert.equal(applyFix(ctx, null), false);
});

// ---- fixes for issues of the Checks tab -------------------------------------------------------------------

test('fixForIssue maps the issues guidance can fix and ignores the rest', () => {
  const layout = row();
  const issues = validateLayout(layout);
  const fixOf = (code) => fixForIssue(layout, issues.find((i) => i.code === code) || { code, refs: {} });
  assert.deepEqual(fixOf('source-no-outflow'), { type: 'connect-flow', fromId: 'A', toId: 'B', pick: 'to', label: 'Connect' });
  const fed = row({ flows: [['A', 'B']] });
  const sinkIssue = validateLayout(fed).find((i) => i.code === 'sink-no-inflow');
  assert.deepEqual(fixForIssue(fed, sinkIssue), { type: 'connect-flow', fromId: 'B', toId: 'C', pick: 'from', label: 'Connect' });
  const processIssue = validateLayout(row({ flows: [['B', 'C']] })).find((i) => i.code === 'process-no-inflow');
  assert.deepEqual(fixForIssue(row({ flows: [['B', 'C']] }), processIssue), { type: 'connect-flow', fromId: 'A', toId: 'B', pick: 'from', label: 'Connect' });
  const withFlows = row({ flows: [['A', 'B'], ['B', 'C']] });
  assert.equal(fixForIssue(withFlows, { code: 'no-fleets', refs: {} }).type, 'add-fleet');
  assert.equal(fixForIssue(createLayout({}), { code: 'no-roads', refs: {} }).tool, 'road');
  assert.equal(fixForIssue(layout, { code: 'storage-small', refs: { stationId: 'A' } }), null);
  assert.equal(fixForIssue(layout, { code: 'source-no-outflow', refs: {} }), null, 'no station: no fix');
  const zero = row({ flows: [['A', 'B']], fleets: [{ count: 0 }] });
  assert.equal(fixForIssue(zero, { code: 'fleet-count-zero', refs: { fleetId: 'v1' } }).fleetId, 'v1');
});

test('every guidance fix that can be applied clears the issue it was made for', () => {
  for (const [layout, code] of [[row(), 'source-no-outflow'], [row({ flows: [['A', 'B']] }), 'sink-no-inflow'], [row({ flows: [['B', 'C']] }), 'process-no-inflow'], [row({ flows: [['A', 'B'], ['B', 'C']] }), 'no-fleets']]) {
    const { ctx, store } = appCtx(layout);
    const issue = validateLayout(store.getState().layout).find((i) => i.code === code);
    assert.ok(issue, code);
    assert.equal(applyFix(ctx, fixForIssue(store.getState().layout, issue)), true, code);
    assert.equal(validateLayout(store.getState().layout).some((i) => i.id === issue.id), false, `${code} is gone after its fix`);
  }
});

// ---- the shared state -------------------------------------------------------------------------------------

test('createGuidance: memoised reads, session progress, and a fresh start after a load', () => {
  const { ctx, store } = appCtx(complete());
  const storage = new Map();
  const g = createGuidance(ctx, { storage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) } });
  const first = g.read();
  assert.equal(g.read(), first, 'the same object while nothing changed');
  assert.ok(byId(first.steps, 'run:press-play'));
  assert.deepEqual(openSteps(first.steps).map((s) => s.id), ['run:press-play']);
  assert.equal(first.checklist.items.find((i) => i.id === 'run').done, false);
  ctx.runner.playing = true;
  ctx.runner.time = 20;
  const running = g.read();
  assert.notEqual(running, first);
  assert.equal(byId(running.steps, 'run:press-play'), undefined);
  assert.equal(running.checklist.items.find((i) => i.id === 'run').done, true);
  ctx.runner.playing = false;
  ctx.runner.time = 0; // the plant was edited: the clock is back at 0:00
  assert.equal(byId(g.read().steps, 'run:press-play'), undefined, 'it ran before');
  ctx.runner.playing = true;
  ctx.runner.time = resultsAfter(store.getState().layout) + 5;
  assert.ok(byId(g.read().steps, 'run:open-results'));
  store.setUi({ rightTab: 'results' });
  const seen = g.read();
  assert.equal(byId(seen.steps, 'run:open-results'), undefined, 'results opened');
  assert.equal(seen.checklist.items.find((i) => i.id === 'results').done, true);
  g.dismiss('info:no-depot');
  assert.equal(byId(g.read().steps, 'info:no-depot'), undefined);
  assert.deepEqual(JSON.parse(storage.get(DISMISS_KEY)), ['info:no-depot']);
  ctx.runner.playing = false;
  ctx.runner.time = 0;
  store.newProject(complete());
  assert.ok(byId(g.read().steps, 'run:press-play'), 'a new plant has not run yet');
});

test('createGuidance works without a runner or an issues function (panels in isolation)', () => {
  const store = createStore({ storage: null });
  store.newProject(row());
  const g = createGuidance({ store });
  assert.ok(byId(g.read().steps, 'connect-out:A'));
});

test('createGuidance survives an issue check that throws: the steps then look at the plant themselves', () => {
  const { ctx } = appCtx(row());
  ctx.issues = () => { throw new Error('boom'); };
  const g = createGuidance(ctx, { storage: null });
  assert.ok(byId(g.read().steps, 'connect-out:A'));
  assert.equal(g.read(), g.read(), 'and it is still memoised');
});

// ---- helpers of the cards (pure parts of js/ui/panels/nextsteps.js) -----------------------------------

test('the Flows and Fleet tabs keep only their own steps; the note about the strategy belongs to both', () => {
  const list = computeNextSteps(row({ flows: [['A', 'B']] }), { issues: [] });
  assert.deepEqual(ids(list.filter(forFlows)), ['connect-out:B']);
  assert.deepEqual(ids(list.filter(forFleet)), ['no-fleet']);
  const two = layoutFromAscii(['.AA..BBB..CC..SS.', '.AA..BBB..CC..SS.', '+++++++++++++++++', '.................'],
    { stations: { A: 'source', S: 'source', B: 'process', C: 'sink' }, flows: [['A', 'B'], ['S', 'B'], ['B', 'C']], fleets: [{ count: 2 }] });
  const notes = computeNextSteps(two, { issues: [], hasRun: true });
  assert.deepEqual(ids(notes.filter(forFlows)), ['info:vehicles-serve-all']);
  assert.ok(notes.filter(forFleet).some((s) => s.id === 'info:vehicles-serve-all'));
});

test('rankBySelection puts the steps about the selected thing first and keeps the order otherwise', () => {
  const list = computeNextSteps(layoutFromAscii(['.AA..PP..QQ..CC.', '.AA..PP..QQ..CC.', '++++++++++++++++', '................'],
    { stations: { A: 'source', P: 'process', Q: 'process', C: 'sink' }, fleets: [] }), { issues: [] });
  assert.deepEqual(ids(list), ['connect-out:A', 'connect-out:P', 'connect-out:Q']);
  assert.deepEqual(ids(rankBySelection(list, { kind: 'station', ids: ['Q'] })), ['connect-out:Q', 'connect-out:A', 'connect-out:P']);
  assert.equal(rankBySelection(list, { kind: null, ids: [] }), list, 'nothing selected: unchanged');
  assert.equal(rankBySelection(list, { kind: 'label', ids: ['l1'] }), list, 'a label has no steps');
});

// ---- wording helpers --------------------------------------------------------------------------------------

test('station wording matches the rest of the UI', () => {
  assert.equal(typeName('source'), 'Goods in');
  assert.equal(typeName('sink'), 'Goods out');
  assert.equal(stationLabel({ name: 'Assembly', type: 'process' }), 'Assembly (Workstation)');
});

test('flows exist as data: flowsTo and flowsFrom agree with what the steps assume', () => {
  const layout = row({ flows: [['A', 'B']] });
  assert.equal(flowsFrom(layout, 'A').length, 1);
  assert.equal(flowsTo(layout, 'B').length, 1);
  const fleet = addFleet(layout, 'agv');
  assert.ok(updateFleet(layout, fleet.id, { count: 0 }));
});
