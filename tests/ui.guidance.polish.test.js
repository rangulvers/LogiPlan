// What the first-time-planner walkthrough (tests/e2e/walkthrough.mjs) found and fixed in the guidance layer, as pure rules:
// a flow nobody can carry, errors that stop "press play", the Open Results step waiting for the warm-up, the toast after a second
// input joins a workstation, the Properties tab not repeating what its form shows, and the Select tool coming back after a Connect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutFromAscii } from './helpers/ascii.js';
import { createStore } from '../js/store/store.js';
import { updateFlow, updateFleet, addFleet } from '../js/model/layout.js';
import {
  computeNextSteps, applyFix, fixForIssue, backToSelect, resultsAfter, RESULTS_AFTER_SECONDS, DEFAULT_FLEET,
} from '../js/ui/guidance.js';
import { flowCreatedText, FLOW_CREATED } from '../js/ui/editor/connect.js';
import { hiddenInProperties } from '../js/ui/panels/nextsteps.js';
import { validateLayout } from '../js/model/validate.js';

const ROW = [
  '.AA..BBB..CC.',
  '.AA..BBB..CC.',
  '+++++++++++++',
  '.............',
];
const row = ({ flows = [['A', 'B'], ['B', 'C']], fleets = [{ count: 2 }], stations = { A: 'source', B: 'process', C: 'sink' }, lines = ROW } = {}) =>
  layoutFromAscii(lines, { stations, flows, fleets });
const byId = (steps, id) => steps.find((s) => s.id === id);

function appCtx(layout) {
  const store = createStore({ storage: null });
  store.newProject(layout);
  const calls = [];
  const toasts = [];
  const ctx = {
    store,
    runner: { playing: false, time: 0 },
    toast: (msg, opts = {}) => { toasts.push({ msg, ...opts }); return { close() {} }; },
    issues: () => validateLayout(store.getState().layout),
    actions: { setTool: (t) => { calls.push(['tool', t]); }, focus() {}, setRightTab() {} },
  };
  return { ctx, store, calls, toasts };
}

/** A complete plant whose first flow is dedicated to a second fleet; `count` vehicles in that fleet. */
function dedicated(count = 0) {
  const layout = row();
  const second = addFleet(layout, 'agv', { count });
  updateFlow(layout, layout.flows[0].id, { fleetId: second.id });
  return { layout, second };
}

// ---- a flow nothing can carry --------------------------------------------------------------------------

test('a flow dedicated to a fleet without vehicles gets its own step, with a way to add vehicles and a way to open it to any fleet', () => {
  const { layout, second } = dedicated(0);
  const steps = computeNextSteps(layout);
  const step = byId(steps, `no-carrier:${layout.flows[0].id}`);
  assert.ok(step, 'a step names the flow');
  assert.equal(step.severity, 'warn');
  assert.equal(step.title, 'Nothing carries A → B');
  assert.match(step.text, /dedicated to .*, which has no vehicles\. Add vehicles, or let any fleet carry this flow\./);
  assert.deepEqual(step.fix, { type: 'add-fleet', preset: 'agv', fleetId: second.id, count: DEFAULT_FLEET.count, label: `Add ${DEFAULT_FLEET.count} vehicles` });
  assert.deepEqual(step.alt, { type: 'release-flow', flowId: layout.flows[0].id, label: 'Any fleet' });
  assert.deepEqual(step.scopes, ['flows', 'fleet'], 'shown on the Flows and Fleet tabs as well');
  assert.deepEqual(step.refs, { flowIds: [layout.flows[0].id], fleetIds: [second.id] });
  assert.equal(byId(steps, 'run:press-play'), undefined, 'a plant with a flow nobody carries is not ready to run');
  assert.equal(byId(steps, 'open-checks'), undefined, 'the empty fleet is not repeated as "1 thing to check"');
});

test('the carrier step goes away once the fleet has vehicles or the flow is open to any fleet', () => {
  const { layout, second } = dedicated(0);
  const stocked = structuredClone(layout);
  updateFleet(stocked, second.id, { count: 1 });
  assert.equal(byId(computeNextSteps(stocked), `no-carrier:${layout.flows[0].id}`), undefined);
  assert.ok(byId(computeNextSteps(stocked), 'run:press-play'), 'and the plant is ready to run');
  const open = structuredClone(layout);
  updateFlow(open, open.flows[0].id, { fleetId: null });
  assert.equal(byId(computeNextSteps(open), `no-carrier:${layout.flows[0].id}`), undefined);
});

test('an empty fleet that no flow depends on is still reported, once', () => {
  const layout = row();
  addFleet(layout, 'forklift', { count: 0 });
  const steps = computeNextSteps(layout);
  assert.equal(steps.filter((s) => s.id === 'open-checks').length, 1, 'one "to check" step for the empty fleet');
  assert.ok(byId(steps, 'run:press-play'), 'it is only a warning: the plant can run');
});

test('fixForIssue: the Checks tab offers Add vehicles for a flow dedicated to an empty fleet', () => {
  const { layout, second } = dedicated(0);
  const issue = validateLayout(layout).find((i) => i.code === 'flow-fleet-missing');
  assert.ok(issue);
  assert.deepEqual(fixForIssue(layout, issue), { type: 'add-fleet', preset: 'agv', fleetId: second.id, count: DEFAULT_FLEET.count, label: `Add ${DEFAULT_FLEET.count} vehicles` });
});

test('applyFix release-flow: one undoable commit that opens the flow to every fleet', () => {
  const { layout } = dedicated(0);
  const { ctx, store, toasts } = appCtx(layout);
  const flowId = layout.flows[0].id;
  assert.equal(applyFix(ctx, { type: 'release-flow', flowId, label: 'Any fleet' }), true);
  assert.equal(store.getState().layout.flows[0].fleetId, null);
  assert.equal(store.getState().undoLabel, 'Let any fleet carry A → B');
  assert.deepEqual(store.getState().ui.selection, { kind: 'flow', ids: [flowId] });
  assert.equal(toasts.at(-1).msg, 'Any fleet carries A → B now.');
  toasts.at(-1).action.onClick();
  assert.notEqual(store.getState().layout.flows[0].fleetId, null, 'Undo restores the dedication');
  assert.equal(applyFix(ctx, { type: 'release-flow', flowId: 'nope' }), false, 'a flow that is gone does nothing');
});

// ---- press play only when the plant can run ------------------------------------------------------------

test('"Press play" waits while an error that no step names is open, and not for a mere warning', () => {
  const layout = row();
  const withError = [{ id: 'depot-missing', severity: 'error', code: 'depot-missing', message: 'm', hint: 'h', refs: {} }];
  const withWarning = [{ id: 'storage-small:K', severity: 'warning', code: 'storage-small', message: 'm', hint: 'h', refs: {} }];
  const blocked = computeNextSteps(layout, { issues: withError });
  assert.equal(byId(blocked, 'run:press-play'), undefined);
  assert.equal(byId(blocked, 'open-checks').title, '1 thing to check');
  const fine = computeNextSteps(layout, { issues: withWarning });
  assert.ok(byId(fine, 'run:press-play'), 'a warning does not stop the first run');
  assert.ok(byId(fine, 'open-checks'));
});

// ---- Open Results ---------------------------------------------------------------------------------------

test('Open Results is suggested when the Results tab has figures: after the warm-up plus five measured minutes', () => {
  const layout = row();
  assert.equal(resultsAfter(layout), layout.settings.warmup + RESULTS_AFTER_SECONDS);
  const early = computeNextSteps(layout, { issues: [], hasRun: true, simulatedSeconds: layout.settings.warmup });
  assert.equal(byId(early, 'run:open-results'), undefined, 'during the warm-up the Results tab says "not counted yet"');
  const due = computeNextSteps(layout, { issues: [], hasRun: true, simulatedSeconds: resultsAfter(layout) });
  const step = byId(due, 'run:open-results');
  assert.equal(step.text, 'The first results are in. They show where loads wait and how busy the vehicles are.', 'no minute count that would be out of date next second');
  const longWarmup = structuredClone(layout);
  longWarmup.settings.warmup = 1800;
  assert.equal(resultsAfter(longWarmup), 2100);
});

// ---- the toast after a second input joins a workstation -------------------------------------------------

test('flowCreatedText: the usual sentence, plus what a second input means for a workstation', () => {
  const layout = row({ flows: [['A', 'B']], lines: ['.AA..KK..BBB..CC.', '.AA..KK..BBB..CC.', '+++++++++++++++++', '.................'], stations: { A: 'source', K: 'source', B: 'process', C: 'sink' } });
  assert.equal(flowCreatedText(layout, layout.flows[0]), FLOW_CREATED, 'one input: nothing to add');
  const second = { id: 'f9', from: 'K', to: 'B' };
  layout.flows.push(second);
  assert.equal(flowCreatedText(layout, second), `${FLOW_CREATED} Workstation now needs a load from both of its inputs before every cycle.`.replace('Workstation', layout.stations.find((s) => s.id === 'B').name));
  const third = { id: 'f10', from: 'C', to: 'B' };
  layout.flows.push(third);
  assert.match(flowCreatedText(layout, third), /needs a load from all 3 of its inputs before every cycle\.$/);
  const toSink = { id: 'f11', from: 'A', to: 'C' };
  layout.flows.push(toSink);
  assert.equal(flowCreatedText(layout, toSink), FLOW_CREATED, 'only a workstation waits for all its inputs');
  assert.equal(flowCreatedText(layout, null), FLOW_CREATED);
});

test('applyFix connect-flow into a workstation that already has an input says so in the toast', () => {
  const layout = row({ flows: [['A', 'B'], ['B', 'C']], lines: ['.AA..KK..BBB..CC.', '.AA..KK..BBB..CC.', '+++++++++++++++++', '.................'], stations: { A: 'source', K: 'source', B: 'process', C: 'sink' } });
  const { ctx, toasts } = appCtx(layout);
  assert.equal(applyFix(ctx, { type: 'connect-flow', fromId: 'K', toId: 'B', pick: 'to' }), true);
  assert.match(toasts.at(-1).msg, /^Flow created\. Vehicles will serve it automatically\. .* now needs a load from both of its inputs before every cycle\.$/);
});

// ---- the Select tool comes back --------------------------------------------------------------------------

test('a Connect or Add vehicles button leaves a placement tool behind: back to Select', () => {
  for (const [fix, label] of [
    [{ type: 'connect-flow', fromId: 'A', toId: 'B' }, 'connect'],
    [{ type: 'add-fleet', preset: 'agv', count: 2 }, 'add vehicles'],
  ]) {
    const { ctx, store, calls } = appCtx(row({ flows: [], fleets: [] }));
    store.setUi({ tool: 'sink' });
    assert.equal(applyFix(ctx, fix), true, label);
    assert.deepEqual(calls, [['tool', 'select']], `${label}: the Goods out tool is put down`);
  }
  const { ctx, store, calls } = appCtx(row({ flows: [], fleets: [] }));
  for (const tool of ['select', 'pan']) {
    store.setUi({ tool });
    backToSelect(ctx);
  }
  assert.deepEqual(calls, [], 'Select and Pan stay as they are');
});

// ---- the Properties tab does not say it twice -------------------------------------------------------------

test('hiddenInProperties: with a station selected the card leaves out its own connect steps, nothing else', () => {
  const stationA = { ui: { selection: { kind: 'station', ids: ['A'] } } };
  const step = (id, severity = 'todo') => ({ id, severity });
  assert.equal(hiddenInProperties(step('connect-out:A', 'warn'), stationA), true, 'the form shows this choice itself');
  assert.equal(hiddenInProperties(step('connect-in:A', 'warn'), stationA), true);
  assert.equal(hiddenInProperties(step('connect-out:B', 'warn'), stationA), false, 'another station is still news');
  assert.equal(hiddenInProperties(step('no-dock:A', 'warn'), stationA), false, 'a station off the road is not in the form callouts');
  assert.equal(hiddenInProperties(step('no-fleet'), stationA), false);
  assert.equal(hiddenInProperties(step('info:vehicles-serve-all', 'info'), stationA), false, 'the note about vehicles serving every Goods in stays');
  const nothing = { ui: { selection: { kind: null, ids: [] } } };
  assert.equal(hiddenInProperties(step('connect-out:A', 'warn'), nothing), false, 'nothing selected: the card is the guide');
  const several = { ui: { selection: { kind: 'station', ids: ['A', 'B'] } } };
  assert.equal(hiddenInProperties(step('connect-out:A', 'warn'), several), false, 'a multi-selection has no single form');
  const flow = { ui: { selection: { kind: 'flow', ids: ['f1'] } } };
  assert.equal(hiddenInProperties(step('connect-out:A', 'warn'), flow), false);
});
