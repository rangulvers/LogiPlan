// "Who serves which flow" (js/ui/panels/jobs-info.js): the pure helpers behind the Properties, Fleet and Flows panels and the Help.
// Everything is data in, data out, so it runs in Node; the drawing (js/ui/panels/jobs-view.js) is driven in a real browser by
// tests/e2e/guidance-panels.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutFromAscii } from './helpers/ascii.js';
import { removeFleet, updateFlow, updateFleet, addFlow, checkInvariants } from '../js/model/layout.js';
import {
  WEIGHT_MIN, WEIGHT_MAX, percentages, stepWeight, vehicleNoun, flowTitle, fleetCount, dispatchPhrase, servedFlows, fleetsServing, describeServedBy,
  describeSplit, describeInflows, fleetJobsSummary, restrictedFleetProblems,
} from '../js/ui/panels/jobs-info.js';
import { percentages as flowsPercentages } from '../js/ui/panels/flows.js';
import { WELCOME_TIPS, nextTipIndex } from '../js/ui/dialogs.js';
import { validDestinations, validOrigins } from '../js/ui/guidance.js';

// ---- builders ---------------------------------------------------------------------------------------------

/** Two Goods in (A, B), an Assembly (C) and Dispatch (D) along a road; flows A -> C and B -> C -> D. Fleets: v1 AGV, v2 Forklift. */
const PLANT = [
  '.AA..BB..CCC..DD.',
  '.AA..BB..CCC..DD.',
  '+++++++++++++++++',
  '.................',
];

function plant({ flows = [['A', 'C'], ['B', 'C'], ['C', 'D']], fleets = [{ count: 2, name: 'AGV' }, { count: 1, preset: 'forklift', name: 'Forklift' }] } = {}) {
  return layoutFromAscii(PLANT, { stations: { A: 'source', B: 'source', C: 'process', D: 'sink' }, flows, fleets });
}

const ids = (flows) => flows.map((f) => f.id);

// ---- percentages and weight steps -------------------------------------------------------------------------

test('percentages: whole numbers that always add up to 100, none for no weight', () => {
  assert.deepEqual(percentages([1, 1]), [50, 50]);
  assert.deepEqual(percentages([1, 1, 1]), [34, 33, 33], 'the largest remainder goes to the first of equals');
  assert.deepEqual(percentages([2, 1]), [67, 33]);
  assert.deepEqual(percentages([5]), [100]);
  assert.deepEqual(percentages([]), []);
  assert.deepEqual(percentages([0, 0]), [0, 0]);
  for (const weights of [[3, 7, 11], [0.01, 1000], [1, 2, 3, 4, 5, 6, 7], [0.3, 0.3, 0.3]]) {
    assert.equal(percentages(weights).reduce((a, b) => a + b, 0), 100, `${weights} add up to 100`);
  }
  assert.equal(flowsPercentages, percentages, 'the Flows panel re-exports the same function');
});

test('stepWeight: whole steps from 1 up, halving and doubling below 1, always within the model range', () => {
  assert.equal(stepWeight(1, 1), 2);
  assert.equal(stepWeight(2, 1), 3);
  assert.equal(stepWeight(2, -1), 1);
  assert.equal(stepWeight(1.5, 1), 2, 'a typed 1.5 goes up to the next whole number');
  assert.equal(stepWeight(1.5, -1), 1, 'and down to the whole number below');
  assert.equal(stepWeight(1, -1), 0.5, 'below 1 the weight halves, never jumping up');
  assert.equal(stepWeight(0.5, -1), 0.25);
  assert.equal(stepWeight(0.5, 1), 1);
  assert.equal(stepWeight(0.3, 1), 0.6);
  assert.equal(stepWeight(0.01, -1), WEIGHT_MIN, 'stops at the smallest weight');
  assert.equal(stepWeight(WEIGHT_MAX, 1), WEIGHT_MAX, 'and at the largest');
  assert.equal(stepWeight(Number.NaN, 1), 2, 'junk counts as 1');
  assert.equal(stepWeight(-3, -1), 0.5);
  // the buttons are inverse-ish: stepping up then down returns to the start for whole weights
  for (const w of [1, 2, 5, 10]) assert.equal(stepWeight(stepWeight(w, 1), -1), w);
});

// ---- names ------------------------------------------------------------------------------------------------

test('names: vehicle noun by type, flow title, fleet with its count, dispatch phrase by setting', () => {
  const layout = plant();
  assert.deepEqual(layout.fleets.map(vehicleNoun), ['AGV', 'forklift']);
  assert.equal(vehicleNoun({ preset: 'tugger' }), 'tugger train');
  assert.equal(vehicleNoun({ preset: 'custom' }), 'vehicle');
  assert.equal(vehicleNoun(null), 'vehicle');
  assert.equal(flowTitle(layout, layout.flows[0]), 'A → C');
  assert.equal(flowTitle(layout, { from: 'A', to: 'gone' }), 'A → a station', 'a missing station reads as a station');
  assert.equal(fleetCount(layout.fleets[0]), 'AGV ×2');
  assert.equal(dispatchPhrase(layout), 'the nearest job first');
  layout.settings.dispatch = 'oldest';
  assert.equal(dispatchPhrase(layout), 'the oldest job first');
  layout.settings.dispatch = 'balanced';
  assert.equal(dispatchPhrase(layout), 'a balance of distance and waiting time');
  layout.settings.dispatch = 'nonsense';
  assert.equal(dispatchPhrase(layout), 'the nearest job first', 'an unknown strategy reads as the default');
});

// ---- which flows a fleet serves ---------------------------------------------------------------------------

test('servedFlows: unrestricted flows are served by every fleet, a restricted one only by its fleet', () => {
  const layout = plant();
  let served = servedFlows(layout, 'v1');
  assert.deepEqual(ids(served.any), ['f1', 'f2', 'f3']);
  assert.deepEqual(ids(served.only), []);
  assert.deepEqual(ids(served.other), []);
  assert.deepEqual(ids(served.all), ['f1', 'f2', 'f3']);

  updateFlow(layout, 'f2', { fleetId: 'v1' });
  updateFlow(layout, 'f3', { fleetId: 'v2' });
  served = servedFlows(layout, 'v1');
  assert.deepEqual(ids(served.any), ['f1']);
  assert.deepEqual(ids(served.only), ['f2']);
  assert.deepEqual(ids(served.other), ['f3'], 'a flow dedicated to the forklifts is not an AGV job');
  assert.deepEqual(ids(served.all), ['f1', 'f2'], 'layout order');
  const forklift = servedFlows(layout, 'v2');
  assert.deepEqual(ids(forklift.any), ['f1']);
  assert.deepEqual(ids(forklift.only), ['f3']);
  assert.deepEqual(ids(forklift.other), ['f2']);
  assert.deepEqual(checkInvariants(layout), []);
});

test('servedFlows: an unknown fleet serves nothing', () => {
  const served = servedFlows(plant(), 'nope');
  assert.deepEqual(served, { any: [], only: [], other: [], all: [] });
  assert.deepEqual(servedFlows(plant({ flows: [] }), 'v1').all, []);
});

test('servedFlows: deleting a fleet frees the flows that were dedicated to it', () => {
  const layout = plant();
  updateFlow(layout, 'f1', { fleetId: 'v2' });
  assert.deepEqual(ids(servedFlows(layout, 'v1').other), ['f1']);
  removeFleet(layout, 'v2');
  assert.deepEqual(ids(servedFlows(layout, 'v1').any), ['f1', 'f2', 'f3'], 'the model clears the restriction');
});

// ---- which fleets serve a flow ----------------------------------------------------------------------------

test('fleetsServing: every fleet with vehicles for an open flow, exactly one for a dedicated flow', () => {
  const layout = plant();
  let info = fleetsServing(layout, 'f1');
  assert.equal(info.restricted, false);
  assert.deepEqual(info.fleets.map((f) => [f.fleet.id, f.count]), [['v1', 2], ['v2', 1]]);
  assert.equal(info.vehicles, 3);
  assert.equal(info.servable, true);

  updateFlow(layout, 'f1', { fleetId: 'v2' });
  info = fleetsServing(layout, 'f1');
  assert.equal(info.restricted, true);
  assert.deepEqual(info.fleets.map((f) => [f.fleet.id, f.count]), [['v2', 1]]);
  assert.equal(info.vehicles, 1);
  assert.equal(info.servable, true);
});

test('fleetsServing: fleets without vehicles do not count for an open flow; a dedicated empty fleet cannot serve', () => {
  const layout = plant();
  updateFleet(layout, 'v2', { count: 0 });
  let info = fleetsServing(layout, 'f1');
  assert.deepEqual(info.fleets.map((f) => f.fleet.id), ['v1'], 'the empty forklift fleet is left out');
  assert.equal(info.vehicles, 2);

  updateFlow(layout, 'f1', { fleetId: 'v2' });
  info = fleetsServing(layout, 'f1');
  assert.deepEqual(info.fleets.map((f) => [f.fleet.id, f.count]), [['v2', 0]], 'listed, so the panel can say so');
  assert.equal(info.servable, false);
  assert.equal(info.missingFleet, false);

  updateFleet(layout, 'v1', { count: 0 });
  assert.equal(fleetsServing(layout, 'f2').servable, false, 'no vehicles anywhere');
  assert.equal(fleetsServing(layout, 'f2').vehicles, 0);
});

test('fleetsServing: a flow that does not exist, a fleet that does not exist', () => {
  const layout = plant();
  assert.deepEqual(fleetsServing(layout, 'zzz'), { restricted: false, fleets: [], vehicles: 0, servable: false, missingFleet: false });
  layout.flows[0].fleetId = 'ghost'; // a layout the model would never produce (normalizeLayout drops such references)
  const info = fleetsServing(layout, 'f1');
  assert.equal(info.restricted, true);
  assert.equal(info.missingFleet, true);
  assert.equal(info.servable, false);
});

test('describeServedBy: the "Served by" wording for any fleet, one fleet and the cases where nothing moves', () => {
  const layout = plant();
  assert.deepEqual(describeServedBy(layout, 'f1'), { value: 'any fleet (AGV ×2, Forklift ×1)', tone: 'ok', hint: '' });
  updateFlow(layout, 'f1', { fleetId: 'v1' });
  assert.deepEqual(describeServedBy(layout, 'f1'), { value: 'only AGV ×2', tone: 'ok', hint: '' });

  updateFleet(layout, 'v1', { count: 0 });
  const empty = describeServedBy(layout, 'f1');
  assert.equal(empty.tone, 'warn');
  assert.equal(empty.value, 'only AGV, which has no vehicles');
  assert.match(empty.hint, /Raise the number of AGV vehicles, or set the flow to any fleet/);

  updateFleet(layout, 'v2', { count: 0 });
  const nobody = describeServedBy(layout, 'f2');
  assert.equal(nobody.tone, 'warn');
  assert.match(nobody.value, /^nobody yet/);
  assert.match(nobody.hint, /Add vehicles in the Fleet tab/);

  layout.flows[0].fleetId = 'ghost';
  assert.equal(describeServedBy(layout, 'f1').tone, 'warn');
  assert.match(describeServedBy(layout, 'f1').value, /no longer exists/);
});

test('describeServedBy: only fleets with vehicles are named for an open flow', () => {
  const layout = plant({ fleets: [{ count: 3, name: 'AGV' }, { count: 0, preset: 'tugger', name: 'Tugger train' }] });
  assert.equal(describeServedBy(layout, 'f1').value, 'any fleet (AGV ×3)');
});

// ---- output split -----------------------------------------------------------------------------------------

test('describeSplit: a single flow takes 100 %, several split by weight and add up to 100', () => {
  const layout = plant({ flows: [['A', 'C'], ['A', 'D'], ['B', 'C']] });
  const single = describeSplit(layout, 'B');
  assert.equal(single.several, false);
  assert.deepEqual(single.flows.map((s) => [s.flow.id, s.to.id, s.percent, s.weight]), [['f3', 'C', 100, 1]]);

  const split = describeSplit(layout, 'A');
  assert.equal(split.several, true);
  assert.deepEqual(split.flows.map((s) => [s.flow.id, s.to.id, s.percent]), [['f1', 'C', 50], ['f2', 'D', 50]]);

  updateFlow(layout, 'f1', { weight: 2 });
  assert.deepEqual(describeSplit(layout, 'A').flows.map((s) => s.percent), [67, 33]);
  updateFlow(layout, 'f1', { weight: 0.5 });
  updateFlow(layout, 'f2', { weight: 0.25 });
  assert.deepEqual(describeSplit(layout, 'A').flows.map((s) => s.percent), [67, 33], 'only the ratio matters');
});

test('describeSplit: a station without outgoing flows (Goods out, unconnected Goods in, unknown id)', () => {
  const layout = plant({ flows: [] });
  for (const id of ['A', 'D', 'nope']) assert.deepEqual(describeSplit(layout, id), { several: false, flows: [] });
});

test('describeSplit: the percentages of every station of every example add up to 100', async () => {
  const { EXAMPLES } = await import('../js/model/examples.js');
  for (const example of EXAMPLES) {
    const layout = example.build();
    for (const station of layout.stations) {
      const { flows } = describeSplit(layout, station.id);
      if (flows.length) assert.equal(flows.reduce((sum, s) => sum + s.percent, 0), 100, `${example.id}/${station.id}`);
    }
  }
});

// ---- what a workstation takes -----------------------------------------------------------------------------

test('describeInflows: the bill of materials of a workstation in one sentence', () => {
  const layout = plant();
  const cell = describeInflows(layout, 'C');
  assert.deepEqual(cell.items.map((i) => [i.flow.id, i.from.id, i.perCycle]), [['f1', 'A', 1], ['f2', 'B', 1]]);
  assert.equal(cell.text, 'One cycle uses 1 load from A and 1 load from B.');
  updateFlow(layout, 'f1', { perCycle: 2 });
  assert.equal(describeInflows(layout, 'C').text, 'One cycle uses 2 loads from A and 1 load from B.');
  const one = plant({ flows: [['A', 'C']] });
  updateFlow(one, 'f1', { perCycle: 3 });
  assert.equal(describeInflows(one, 'C').text, 'One cycle uses 3 loads from A.');
  const three = layoutFromAscii(['.AA..BB..EE..CCC.', '.AA..BB..EE..CCC.', '+++++++++++++++++'], { stations: { A: 'source', B: 'source', E: 'storage', C: 'process' }, flows: [['A', 'C'], ['B', 'C'], ['E', 'C']] });
  assert.equal(describeInflows(three, 'C').text, 'One cycle uses 1 load from A, 1 load from B and 1 load from E.', 'a list of three reads with commas and "and"');
});

test('describeInflows: only a workstation has a per-cycle sentence; others list their origins', () => {
  const layout = layoutFromAscii(['.AA..EE..DD.', '.AA..EE..DD.', '++++++++++++'], { stations: { A: 'source', E: 'storage', D: 'sink' }, flows: [['A', 'E'], ['E', 'D']] });
  assert.equal(describeInflows(layout, 'E').text, '');
  assert.deepEqual(describeInflows(layout, 'E').items.map((i) => i.from.id), ['A']);
  assert.deepEqual(describeInflows(layout, 'D').items.map((i) => i.from.id), ['E']);
  assert.deepEqual(describeInflows(layout, 'A'), { items: [], text: '' });
  assert.deepEqual(describeInflows(layout, 'nope'), { items: [], text: '' });
});

// ---- the line at the top of a fleet's jobs ----------------------------------------------------------------

test('fleetJobsSummary: how many flows share how many vehicles', () => {
  const layout = plant();
  assert.deepEqual(fleetJobsSummary(layout, 'v1'), { flows: 3, vehicles: 2, text: '3 flows share these 2 AGVs' });
  assert.equal(fleetJobsSummary(layout, 'v2').text, '3 flows share this forklift');
  updateFlow(layout, 'f1', { fleetId: 'v2' });
  updateFlow(layout, 'f2', { fleetId: 'v2' });
  assert.deepEqual(fleetJobsSummary(layout, 'v1'), { flows: 1, vehicles: 2, text: '1 flow is served by these 2 AGVs' }, 'two flows are dedicated to the forklift');
  assert.equal(fleetJobsSummary(layout, 'v2').text, '3 flows share this forklift');
  updateFlow(layout, 'f3', { fleetId: 'v2' });
  assert.deepEqual(fleetJobsSummary(layout, 'v1'), { flows: 0, vehicles: 2, text: 'These 2 AGVs have no job yet.' });
});

test('fleetJobsSummary: one vehicle, no vehicles, no such fleet', () => {
  const layout = plant({ fleets: [{ count: 1, name: 'AGV' }, { count: 0, preset: 'tugger', name: 'Tugger train' }] });
  assert.equal(fleetJobsSummary(layout, 'v1').text, '3 flows share this AGV');
  assert.equal(fleetJobsSummary(layout, 'v2').text, 'Tugger train has no vehicles yet, so it serves no flow.');
  assert.equal(fleetJobsSummary(layout, 'v2').flows, 3, 'it could serve them once it has vehicles');
  const lone = plant({ flows: [['A', 'C']], fleets: [{ count: 1, name: 'AGV' }] });
  assert.equal(fleetJobsSummary(lone, 'v1').text, '1 flow is served by this AGV');
  const none = plant({ flows: [] });
  assert.equal(fleetJobsSummary(none, 'v1').text, 'These 2 AGVs have no job yet.');
  assert.deepEqual(fleetJobsSummary(layout, 'nope'), { flows: 0, vehicles: 0, text: '' });
});

// ---- flows nobody can carry -------------------------------------------------------------------------------

test('restrictedFleetProblems: none for a healthy plant', () => {
  assert.deepEqual(restrictedFleetProblems(plant()), []);
  const dedicated = plant();
  updateFlow(dedicated, 'f1', { fleetId: 'v2' });
  assert.deepEqual(restrictedFleetProblems(dedicated), [], 'a dedicated flow with vehicles is fine');
});

test('restrictedFleetProblems: a flow dedicated to a fleet without vehicles', () => {
  const layout = plant();
  updateFlow(layout, 'f2', { fleetId: 'v2' });
  updateFleet(layout, 'v2', { count: 0 });
  const problems = restrictedFleetProblems(layout);
  assert.equal(problems.length, 1);
  const [p] = problems;
  assert.equal(p.code, 'restricted-fleet-empty');
  assert.equal(p.flowId, 'f2');
  assert.equal(p.fleetId, 'v2');
  assert.equal(p.id, 'restricted-fleet-empty:f2', 'a stable id');
  assert.equal(p.message, '“B → C” is dedicated to Forklift, which has no vehicles, so nothing carries it.');
  assert.equal(p.hint, 'Raise the number of Forklift vehicles, or set the flow to any fleet.');
});

test('restrictedFleetProblems: with no vehicles at all every open flow has none to carry it', () => {
  const layout = plant({ fleets: [{ count: 0, name: 'AGV' }] });
  const problems = restrictedFleetProblems(layout);
  assert.deepEqual(problems.map((p) => [p.code, p.flowId]), [['no-vehicles', 'f1'], ['no-vehicles', 'f2'], ['no-vehicles', 'f3']]);
  assert.match(problems[0].message, /Nobody can carry “A → C” yet: there are no vehicles/);
  assert.equal(restrictedFleetProblems(plant({ fleets: [] })).length, 3, 'no fleet at all is the same');
  assert.deepEqual(restrictedFleetProblems(plant({ flows: [], fleets: [] })), [], 'no flows, nothing to carry');
});

test('restrictedFleetProblems: a fleet that no longer exists; flows with a missing station are skipped', () => {
  const layout = plant();
  layout.flows[0].fleetId = 'ghost';
  const [p, ...rest] = restrictedFleetProblems(layout);
  assert.equal(p.code, 'restricted-fleet-missing');
  assert.equal(rest.length, 0);
  layout.flows[1].to = 'gone';
  assert.equal(restrictedFleetProblems(layout).filter((x) => x.flowId === 'f2').length, 0);
});

test('restrictedFleetProblems agrees with the Checks tab: every flow it reports is one validateLayout also calls out', async () => {
  const { validateLayout } = await import('../js/model/validate.js');
  const layout = plant();
  updateFlow(layout, 'f1', { fleetId: 'v2' });
  updateFleet(layout, 'v2', { count: 0 });
  const mine = restrictedFleetProblems(layout).map((p) => p.flowId);
  const checks = validateLayout(layout).filter((i) => i.code === 'flow-fleet-missing').map((i) => i.refs.flowId);
  assert.deepEqual(mine, checks);
});

// ---- the guidance helpers the picker uses ------------------------------------------------------------------

test('the picker lists exactly the stations the model accepts, closest first (guidance.js)', () => {
  const layout = plant({ flows: [['A', 'C']] });
  assert.deepEqual(validDestinations(layout, 'A').map((s) => s.id), ['D'], 'A -> C exists already; a Goods in cannot send to a Goods in');
  assert.deepEqual(validDestinations(layout, 'B').map((s) => s.id), ['C', 'D']);
  assert.deepEqual(validOrigins(layout, 'C').map((s) => s.id), ['B'], 'A feeds C already');
  assert.deepEqual(validOrigins(layout, 'A'), [], 'nothing feeds a Goods in');
  const copy = structuredClone(layout);
  assert.ok(addFlow(copy, 'B', 'D'), 'what the picker offers, addFlow accepts');
  assert.equal(addFlow(copy, 'A', 'C'), null, 'what it leaves out, addFlow refuses');
});

// ---- welcome tips -----------------------------------------------------------------------------------------

test('welcome tips: a few tips, one about connecting a new Goods in and one about Shift, each with a title and a text', () => {
  assert.ok(WELCOME_TIPS.length >= 3);
  assert.equal(new Set(WELCOME_TIPS.map((t) => t.id)).size, WELCOME_TIPS.length, 'unique ids');
  const shift = WELCOME_TIPS.find((t) => t.id === 'shift-straight');
  assert.ok(shift, 'a tip about drawing straight roads with Shift');
  assert.match(shift.text, /Hold Shift/);
  assert.match(shift.text, /Shift\+click/);
  for (const tip of WELCOME_TIPS) {
    assert.ok(tip.title.length > 3 && tip.text.length > 30, tip.id);
    assert.ok(!/\s{2}/.test(tip.text), 'no stray double spaces');
  }
  const goodsIn = WELCOME_TIPS.find((t) => /second Goods in/i.test(t.title));
  assert.ok(goodsIn, 'a tip about adding a second Goods in');
  assert.match(goodsIn.text, /flow of its own/);
  assert.match(goodsIn.text, /automatically/);
});

test('welcome tips rotate: the next one after the last visit, wrapping, junk starts at the first', () => {
  assert.equal(nextTipIndex(null), 0);
  assert.equal(nextTipIndex(Number.NaN), 0);
  assert.equal(nextTipIndex(-1), 0);
  assert.equal(nextTipIndex(0), 1);
  assert.equal(nextTipIndex(1), 2);
  assert.equal(nextTipIndex(WELCOME_TIPS.length - 1), 0, 'wraps around');
  assert.equal(nextTipIndex(41), 42 % WELCOME_TIPS.length, 'an index from a longer list still lands inside this one');
  const seen = new Set();
  let last = null;
  for (let i = 0; i < WELCOME_TIPS.length; i++) {
    last = nextTipIndex(last);
    seen.add(last);
  }
  assert.equal(seen.size, WELCOME_TIPS.length, 'every tip comes up within one round');
});
