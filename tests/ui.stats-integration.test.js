// Three defects that only showed when the pieces of the Statistics dock ran together in the real app (found by tests/e2e/entity-stats.mjs, fixed with small edits in the
// MODEL builder's files; docs/ENTITY-INSIGHTS-DESIGN.md 9.1, VERIFY part). Each has its unit test here so that it cannot come back without the browser:
//   * the fleet values next to the numbers of a vehicle (the mean over its fleet) are cached for a second; when the simulation is paused that cache must not serve figures
//     from before the pause (nothing refreshes the dock again, so they stayed on screen: 16.5 against 15.8 trips an hour at 600x);
//   * before the first measured second the header of the dock says "Press play" (the compact dock hides the blocks, so the planner saw six dashes and no word);
//   * the dock pairs of a trip ("Dock 1 -> Dock 1 65 % . Dock 2 -> Dock 2 18 %") break between the pairs, never inside one, and a refresh keeps their nodes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatsModel } from '../js/ui/panels/stats-model.js';
import { createStatsView } from '../js/ui/panels/stats-view.js';
import { EXAMPLES } from '../js/model/examples.js';
import { installStatsDom } from './helpers/stats-dom.js';
import { readFixture, fixtureInput, runExample, liveInput } from './helpers/stats-fixtures.js';

const dom = installStatsDom();
after(() => dom.restore());

const refs = (m) => m.tiles.map((t) => (t.ref && t.ref.text) || '');

test('the fleet values of a vehicle are the figures of this moment when the simulation stands still; while it runs they are at most a second old and at most a few percent of the window behind', () => {
  const sim = runExample('two-lines', { seconds: 20 * 60 });
  const sel = { kind: 'vehicle', ids: ['v2#1'] };
  const input = (playing, now) => ({ ...liveInput(sim, sel, { now }), runner: { playing } });
  const peers = (m) => refs(m).slice(0, 3).map((x) => x.replace(/ · indicative$/, '')); // the fleet figures of the first three tiles (the "indicative" mark belongs to the window)
  const before = buildStatsModel(input(false, 1_000_000));
  sim.advance(5); // 5 simulated seconds: far less than 5 % of a 10 minute window
  const running = buildStatsModel(input(true, 1_000_010)); // 10 ms later, the simulation is running: the cached fleet figures are fine
  assert.deepEqual(peers(running), peers(before), 'while it runs the fleet figures are refreshed at most once a second');
  sim.advance(10 * 60); // at 600x that is one wall second: the vehicle\'s own figures are live, the fleet figures must not stay ten simulated minutes behind
  const later = buildStatsModel(input(true, 1_000_020)); // 20 ms of wall time, but 5 % of the window is long gone
  assert.notDeepEqual(peers(later), peers(before), 'a simulation that moved on by more than 5 % of the window refreshes the fleet figures before a second has passed');
  const paused = buildStatsModel(input(false, 1_000_030)); // the simulation stands still: nothing will refresh these again
  const fresh = buildStatsModel(input(false, 9_000_000)); // far past any cache
  assert.deepEqual(refs(paused), refs(fresh), 'paused: every reference line is the one of this very moment, not of the second before');
  assert.deepEqual(peers(later), peers(fresh), 'and the refreshed running figures are the ones of this moment too');
  assert.notDeepEqual([refs(paused)[0], refs(paused)[1], refs(paused)[2], refs(paused)[5]], [refs(before)[0], refs(before)[1], refs(before)[2], refs(before)[5]], 'and ten simulated minutes did change the fleet figures (the test is not vacuous)');
});

test('before the first measured second the header says what to do, for every kind', () => {
  const layout = EXAMPLES.find((e) => e.id === 'two-lines').build();
  const base = { layout, runner: { playing: false }, sim: null, detail: null, report: null, insights: [], window: 'start', routes: true, state: 'compact', narrow: false };
  const selections = [
    { kind: 'vehicle', ids: [`${layout.fleets[0].id}#1`] },
    { kind: 'station', ids: [layout.stations[1].id] },
    { kind: 'flow', ids: [layout.flows[0].id] },
    { kind: 'fleet', ids: [layout.fleets[0].id] },
    { kind: 'cell', ids: [Object.keys(layout.roads)[0]] },
  ];
  for (const selection of selections) {
    const m = buildStatsModel({ ...base, selection });
    assert.equal(m.status, 'waiting', selection.kind);
    assert.deepEqual([m.header.live.strong, m.header.live.rest], ['Press play', 'to see the numbers'], `${selection.kind}: the header, which the compact dock shows, says it`);
  }
  const TWO = readFixture('two-lines-agv1.json');
  const measured = buildStatsModel(fixtureInput(TWO, { kind: 'vehicle', ids: ['v2#1'] }));
  assert.ok(!/Press play/.test(measured.header.live.strong), 'with data the header carries the live state instead');
});

test('the dock pairs of a trip keep each pair on one line and a refresh keeps the nodes', () => {
  const WARE = readFixture('warehouse-goods-in.json');
  const m = buildStatsModel(fixtureInput(WARE, { kind: 'vehicle', ids: ['v1#1'] }));
  const trips = m.blocks.find((b) => b.id === 'trips');
  const row = trips.rows.find((r) => r.ways && r.ways.includes(' · '));
  assert.ok(row, 'a trip with several docks, so that there are pairs');
  const view = createStatsView({ window: () => 'start', setWindow() {}, state: () => 'open', select() {}, showOnPlan() {}, focusRoute() {}, announce() {} });
  view.update(m, { state: 'open', window: 'start' });
  const find = () => dom.findAll(view.el, (e) => e.classList.contains('trip') && e.getAttribute('data-focus') === row.focusId)[0];
  const ways = find();
  assert.ok(ways && dom.text(ways).includes(row.ways), 'the whole string is the text of the row');
  const spans = dom.findAll(ways, (e) => e.localName === 'span' && /white-space:\s*nowrap/.test(e.getAttribute('style') || ''));
  assert.equal(spans.length, row.ways.split(' · ').length, 'one unbreakable span per pair');
  const next = structuredClone(m);
  const nextRow = next.blocks.find((b) => b.id === 'trips').rows.find((r) => r.focusId === row.focusId);
  nextRow.ways = row.ways.split(' · ').map((g) => g.replace(/\d+ %/, '99 %')).join(' · ');
  view.update(next, { state: 'open', window: 'start' });
  const spansAfter = dom.findAll(find(), (e) => e.localName === 'span' && /white-space:\s*nowrap/.test(e.getAttribute('style') || ''));
  assert.ok(spansAfter.length === spans.length && spansAfter.every((s, i) => s === spans[i]), 'the same spans, only their text changed');
  assert.ok(dom.text(find()).includes(nextRow.ways));
});
