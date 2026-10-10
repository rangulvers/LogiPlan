// The view of the Statistics dock (js/ui/panels/stats-view.js; docs/ENTITY-INSIGHTS-DESIGN.md 2.3, 2.4, 4.2; acceptance S1.14 view part, S1.9 and S1.13 as drawn) in a fake DOM,
// drawn from REAL view-models (tests/fixtures/stats through the fake collector, and a real simulation):
//   * the structure: a strip of six numbers as a dl, three blocks, a counting rule behind every number, nothing from the model goes through innerHTML
//   * in place: a refresh keeps every node (tiles, rows, facts, bars) and changes only what changed; rows are kept by key and in order
//   * accessibility: no aria-live anywhere, the stacked bar and the sparkline are images with a sentence, a trip row is a button whose label is the whole sentence,
//     a table has column headers, every (i) is a button and opens its rule in place, touch areas on a coarse pointer
//   * routes: hover and focus draw a route, a click or Enter pins it, hovering does not override a pin, Esc unpins, a pinned route that disappears is let go
// The real browser (layout, the keyboard journey, pixels) is tests/e2e/stats-view.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { buildStatsModel, ROUND_FOCUS_ID, routeFocusId } from '../js/ui/panels/stats-model.js';
import { createStatsView, shapePoints } from '../js/ui/panels/stats-view.js';
import { installStatsDom } from './helpers/stats-dom.js';
import { readFixture, fixtureInput, layoutOfFixture, runExample, liveInput, everySelection } from './helpers/stats-fixtures.js';

const dom = installStatsDom();
after(() => dom.restore());

const TWO = readFixture('two-lines-agv1.json');
const WARE = readFixture('warehouse-goods-in.json');
const model = (fx, kind, ids, opts = {}) => buildStatsModel(fixtureInput(fx, { kind, ids }, opts));
const blockOf = (m, id) => m.blocks.find((b) => b.id === id);

/** A host that records what the view asks of the shell. */
function hostStub() {
  const calls = { focusRoute: [], showOnPlan: [], select: [], setWindow: [], announce: [] };
  return {
    calls,
    window: () => 'start', setWindow: (k) => calls.setWindow.push(k), state: () => 'open', select: (...a) => calls.select.push(a),
    showOnPlan: (r) => calls.showOnPlan.push(r), focusRoute: (id, opts) => calls.focusRoute.push([id, opts]), announce: (t) => calls.announce.push(t),
  };
}

function mount(m, host = hostStub()) {
  const view = createStatsView(host);
  view.update(m, { state: 'open', window: 'start' });
  return { view, host, root: view.el };
}

const tiles = (root) => dom.findAll(root, (e) => e.classList.contains('tile') && e.parentNode && e.parentNode.classList.contains('insight__strip'));
const tripRows = (root) => dom.findAll(root, (e) => e.localName === 'button' && e.classList.contains('trip'));
const tileTexts = (t) => ({
  label: dom.text(dom.find(t, (e) => e.classList.contains('tile__name'))),
  num: dom.text(dom.find(t, (e) => e.classList.contains('tile__num'))),
  unit: dom.text(dom.find(t, (e) => e.localName === 'small')),
  ref: dom.text(dom.find(t, (e) => e.classList.contains('tile__ref'))),
});

// ---------------------------------------------------------------------------------------------------------
// structure
// ---------------------------------------------------------------------------------------------------------

test('a vehicle is drawn as a dl of six numbers and three blocks, each number with its counting rule behind an (i) button', () => {
  const m = model(TWO, 'vehicle', ['v2#1']);
  const { root } = mount(m);
  assert.equal(root.getAttribute('data-status'), 'ready');
  assert.equal(root.getAttribute('data-kind'), 'vehicle');
  const strip = root.children[0];
  assert.equal(strip.localName, 'dl', 'the numbers are a description list');
  assert.ok(strip.classList.contains('insight__strip'));
  const ts = tiles(root);
  assert.equal(ts.length, 6);
  ts.forEach((t, k) => {
    const x = tileTexts(t);
    assert.equal(x.label.replace(/\s*·.*$/, ''), m.tiles[k].label);
    assert.equal(x.num, m.tiles[k].value);
    assert.equal(t.children[0].localName, 'dt');
    assert.equal(t.children[1].localName, 'dd');
    const def = dom.find(t, (e) => e.classList.contains('def'));
    assert.equal(def.localName, 'button', 'the (i) is a button, so the keyboard reaches it');
    assert.equal(def.getAttribute('type'), 'button');
    assert.equal(def.getAttribute('data-tip'), m.tiles[k].def, 'the hover text is the counting rule');
    assert.equal(def.getAttribute('aria-label'), `How is this counted? ${m.tiles[k].def}`, 'and a screen reader reads the rule');
    assert.equal(def.getAttribute('aria-expanded'), 'false');
  });
  const body = root.children[1];
  assert.ok(body.classList.contains('insight__body'));
  assert.deepEqual(body.children.map((b) => b.getAttribute('data-block')), ['time', 'facts', 'trips']);
  assert.ok(body.children.every((b) => b.classList.contains('insight__block') && b.children[0].localName === 'h3'), 'each block has a heading');
  assert.equal(dom.text(body.children[0].children[0]), 'Where its time goes2 h 6 min measured');
});

test('the fleet mates arrow is an image with a word and a good or bad colour class, only when the difference is real', () => {
  const busier = mount(model(TWO, 'vehicle', ['v1#1'])).root;
  const up = dom.find(tiles(busier)[1], (e) => e.classList.contains('up') || e.classList.contains('down'));
  assert.ok(up, 'Forklifts 1 is far busier than its fleet (75 % against 60 %): an arrow');
  assert.equal(up.getAttribute('role'), 'img');
  assert.equal(up.getAttribute('aria-label'), 'above');
  assert.equal(dom.text(up), '▲');
  assert.ok(up.classList.contains('up'), 'busier is good');
  const slower = mount(model(TWO, 'vehicle', ['v1#3'])).root;
  const down = dom.find(tiles(slower)[0], (e) => e.classList.contains('up') || e.classList.contains('down'));
  assert.equal(down.getAttribute('aria-label'), 'below');
  assert.equal(dom.text(down), '▼');
  assert.ok(down.classList.contains('down'), 'fewer trips than the fleet is the bad direction');
  const same = mount(model(TWO, 'vehicle', ['v2#1'])).root;
  for (const t of tiles(same)) assert.equal(dom.find(t, (e) => e.classList.contains('up') || e.classList.contains('down')), null, 'AGVs 1 is within the noise of its fleet: no arrow');
});

test('every kind of item is drawn without error: six numbers, the blocks of its model, and the texts of the model verbatim', () => {
  const sims = [[TWO, ['vehicle', 'station', 'flow', 'fleet', 'cell']], [WARE, ['vehicle', 'station', 'flow', 'fleet']]];
  let drawn = 0;
  for (const [fx, kinds] of sims) {
    for (const sel of everySelection(layoutOfFixture(fx), { cells: 2 })) {
      if (!kinds.includes(sel.kind) && sel.kind !== 'cell') continue;
      for (const win of ['start', 'last30']) {
        const m = buildStatsModel(fixtureInput(fx, sel, { window: win }));
        const { root } = mount(m);
        assert.equal(tiles(root).length, 6, `${sel.kind} ${sel.ids}`);
        assert.deepEqual(root.children[1].children.map((b) => b.getAttribute('data-block')), m.blocks.map((b) => (b.type === 'status' ? 'status' : b.id)));
        m.tiles.forEach((t, k) => assert.equal(tileTexts(tiles(root)[k]).num, t.value));
        assert.equal(dom.liveRegions(root).length, 0);
        drawn++;
      }
    }
  }
  assert.ok(drawn > 60, `${drawn} views`);
});

test('nothing from the model goes through innerHTML: markup in a name or a sentence is shown as text', () => {
  const m = model(TWO, 'vehicle', ['v2#1']);
  const evil = '<img src=x onerror="window.__pwned=1">';
  m.blocks[1].facts[0].text = evil;
  m.blocks[2].rows[0].name = evil;
  m.blocks[2].rows[0].label = evil;
  m.tiles[0].label = evil;
  m.tiles[0].def = evil;
  const before = dom.innerHtmlWrites.length;
  const { root } = mount(m);
  assert.ok(dom.text(root).includes(evil), 'shown literally');
  assert.equal(dom.find(root, (e) => e.localName === 'img'), null, 'and never parsed');
  assert.ok(dom.innerHtmlWrites.slice(before).every((w) => w.tag === 'template'), 'only the icon cache writes markup (its own svg strings)');
});

// ---------------------------------------------------------------------------------------------------------
// the bar, the sparkline, the rows
// ---------------------------------------------------------------------------------------------------------

test('S1.14: the stacked bar and the sparkline are images with a generated sentence, the legend lists every piece', () => {
  const m = model(TWO, 'vehicle', ['v2#1']);
  const { root } = mount(m);
  const time = blockOf(m, 'time');
  const bar = dom.find(root, (e) => e.classList.contains('progress'));
  assert.equal(bar.getAttribute('role'), 'img');
  assert.equal(bar.getAttribute('aria-label'), time.split.label);
  assert.match(bar.getAttribute('aria-label'), /^Time split: Driving loaded 24 %, Driving empty 18 %,/);
  assert.equal(bar.children.length, time.split.items.length);
  bar.children.forEach((piece, k) => {
    assert.ok(piece.classList.contains(`tone-${time.split.items[k].tone}`));
    assert.equal(piece.getAttribute('style:--w'), `${(time.split.items[k].share * 100).toFixed(2)}%`);
  });
  const legend = dom.find(root, (e) => e.classList.contains('split__legend'));
  assert.deepEqual(legend.children.map((li) => dom.text(li)), time.split.items.map((p) => `${p.label}${p.text}`));
  const chart = dom.find(root, (e) => e.classList.contains('split__chart'));
  assert.equal(chart.getAttribute('role'), 'img');
  assert.equal(chart.getAttribute('aria-label'), time.spark.label);
  assert.match(chart.getAttribute('aria-label'), /^Busy share of each 30 seconds over the last 30 min, smoothed over three of them: now \d+ %, lowest \d+ %, highest \d+ %$/);
  assert.match(chart.children[1].getAttribute('d'), /^M0\.0,[\d.]+ L/, 'a line from the left edge');
  assert.ok(chart.children[0].getAttribute('d').endsWith('L240,30 L0,30 Z'), 'and an area under it');
  assert.equal(dom.liveRegions(root).length, 0, 'S1.14: no aria-live anywhere in the dock (the chart of charts.js has one; this one does not)');
});

test('where it is held up: one row per place with minutes per hour, "other places" last, the note under it', () => {
  const m = model(TWO, 'vehicle', ['v2#1']);
  const { root } = mount(m);
  const held = blockOf(m, 'time').held;
  const where = dom.find(root, (e) => e.getAttribute('data-role') === 'held');
  assert.ok(!where.hidden);
  const rows = dom.findAll(where, (e) => e.classList.contains('hbar'));
  assert.equal(rows.length, held.rows.length);
  rows.forEach((row, k) => {
    assert.equal(dom.text(row.children[0]), held.rows[k].label);
    assert.equal(row.children[0].getAttribute('title'), held.rows[k].label, 'a long label is cut by the stylesheet, the whole one is the tooltip');
    assert.equal(dom.text(row.children[2]), held.rows[k].minPerHour.toFixed(held.rows[k].minPerHour < 10 ? 1 : 0));
  });
  assert.equal(dom.text(rows[rows.length - 1].children[0]), 'Other places');
  assert.equal(dom.text(dom.find(where, (e) => e.classList.contains('how'))), held.note);
  assert.equal(dom.text(dom.find(where, (e) => e.classList.contains('aside'))), held.aside);
  // a vehicle that was never held up has no such block
  const calm = structuredClone(m);
  blockOf(calm, 'time').held = null;
  const second = mount(calm);
  assert.ok(dom.find(second.root, (e) => e.getAttribute('data-role') === 'held').hidden);
});

test('S1.14: a trip row is a button whose label is the whole sentence; the list is a real list', () => {
  const m = model(TWO, 'vehicle', ['v2#1']);
  const { root } = mount(m);
  const trips = blockOf(m, 'trips');
  const list = dom.find(root, (e) => e.localName === 'ol' && e.classList.contains('trips'));
  assert.equal(list.children.length, trips.rows.length);
  assert.ok(list.children.every((li) => li.localName === 'li' && li.children.length === 1 && li.children[0].localName === 'button'));
  const rows = tripRows(root);
  assert.equal(rows.length, 3);
  rows.forEach((row, k) => {
    assert.equal(row.getAttribute('type'), 'button');
    assert.equal(row.getAttribute('aria-label'), trips.rows[k].label, 'the whole sentence');
    assert.equal(row.getAttribute('data-focus'), trips.rows[k].focusId);
    assert.equal(row.getAttribute('aria-pressed'), 'false');
    assert.equal(dom.text(dom.find(row, (e) => e.classList.contains('trip__rank'))), String(trips.rows[k].rank));
    assert.equal(dom.text(dom.find(row, (e) => e.classList.contains('trip__name'))), trips.rows[k].name);
    assert.equal(row.getAttribute('style'), 'width:100%;text-align:left', 'the two rules the stylesheet of a <button> row does not have');
  });
  assert.match(dom.text(rows[0]), /16 trips · 7\.6\/h · 54 m · 62 s.*waits 7 s/);
  const wait = dom.find(rows[1], (e) => e.classList.contains('trip__wait'));
  assert.equal(wait.getAttribute('data-tone'), 'much');
  const shape = dom.find(rows[0], (e) => e.classList.contains('trip__shape'));
  assert.equal(shape.getAttribute('aria-hidden'), 'true', 'the little picture is decoration: the sentence says it all');
  assert.match(shape.children[0].getAttribute('points'), /^[\d.]+,[\d.]+( [\d.]+,[\d.]+)+$/);
  assert.ok(shape.getAttribute('style:--c').startsWith('var(--route-') || shape.getAttribute('style:--c').startsWith('color-mix('), 'coloured with the route ramp');
  assert.equal(dom.text(dom.find(root, (e) => e.classList.contains('route-legend'))), 'Width = tripstime lost waiting: none → 25 %+');
  assert.equal(dom.find(root, (e) => e.classList.contains('route-legend__ramp')).getAttribute('role'), 'img');
});

test('trip rows with several docks show the dock pairs; a row with too few trips says so; the round and the other drives are there', () => {
  const m = model(WARE, 'vehicle', ['v1#1']);
  const { root } = mount(m);
  const withWays = blockOf(m, 'trips').rows.filter((r) => r.ways);
  assert.ok(withWays.length > 0);
  const rows = tripRows(root);
  withWays.forEach((r) => {
    const row = rows[blockOf(m, 'trips').rows.indexOf(r)];
    assert.ok(dom.text(row).includes(r.ways), r.ways);
  });
  const two = model(TWO, 'vehicle', ['v2#1']);
  const second = mount(two);
  const round = dom.find(second.root, (e) => e.getAttribute('data-role') === 'round');
  assert.ok(!round.hidden);
  assert.match(dom.text(round), /^Usual round Central warehouse → Press line, then Central warehouse → Press line 3 of 11 pairs of trips \(27 %\), empty drive between Show on plan$/);
  const show = dom.find(round, (e) => e.localName === 'button');
  assert.match(show.getAttribute('aria-label'), /^Show the usual round on the plan\. Usual round: Central warehouse to Press line/);
  const toggle = dom.find(second.root, (e) => e.getAttribute('data-role') === 'other-toggle');
  const list = dom.find(second.root, (e) => e.getAttribute('data-role') === 'other-list');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.ok(list.hidden);
  assert.match(dom.text(toggle), /Other drives39 empty · 27 to depot or charger/);
});

test('the docks of a station are a table with column headers and one row per dock', () => {
  const m = model(WARE, 'station', ['s1']);
  const { root } = mount(m);
  const table = dom.find(root, (e) => e.localName === 'table');
  assert.ok(table.classList.contains('compare'));
  const heads = dom.byTag(table, 'th');
  assert.deepEqual(heads.map((th) => dom.text(th)), ['Dock', 'Visits /h', 'In service', 'Queue / visit']);
  assert.ok(heads.every((th) => th.getAttribute('scope') === 'col'));
  const rows = dom.findAll(dom.byTag(table, 'tbody')[0], (e) => e.localName === 'tr');
  assert.equal(rows.length, 4);
  const docks = blockOf(m, 'docks').rows;
  rows.forEach((tr, k) => {
    assert.equal(dom.text(tr.children[0]), `${docks[k].name} ${docks[k].cell}`);
    assert.equal(dom.text(tr.children[1]), docks[k].visitsPerHour.toFixed(1));
    assert.equal(dom.text(tr.children[2]), `${Math.round(docks[k].inService * 100)} %`);
  });
});

// ---------------------------------------------------------------------------------------------------------
// in place
// ---------------------------------------------------------------------------------------------------------

/** Every element of a view with its place in the tree, to prove that a refresh kept every node. */
const nodesOf = (root) => dom.elements(root);

test('S1.9 in place: a refresh with other numbers keeps every node and changes only text', () => {
  const m = model(TWO, 'vehicle', ['v2#1']);
  const { view, root } = mount(m);
  const before = nodesOf(root);
  const next = structuredClone(m);
  next.tiles[0].value = '19.9';
  next.tiles[2].tone = 'warn';
  next.tiles[1].ref = { text: 'fleet 80 %', arrow: '▼', good: false };
  blockOf(next, 'time').split.items[0].share = 0.3;
  blockOf(next, 'time').held.rows[0].minPerHour = 7.7;
  blockOf(next, 'facts').facts[0].text = 'AGVs 1 is held up 9 % of its time.';
  blockOf(next, 'trips').rows[0].trips = 17;
  blockOf(next, 'trips').rows[0].meta = '17 trips · 8.1/h';
  view.update(next, { state: 'open', window: 'start' });
  const after = nodesOf(root);
  assert.equal(after.length, before.length, 'no node came, none went');
  assert.ok(after.every((n, i) => n === before[i]), 'and every one is the same node');
  assert.equal(tileTexts(tiles(root)[0]).num, '19.9');
  assert.equal(tiles(root)[2].getAttribute('data-tone'), 'warn');
  const arrow = dom.find(tiles(root)[1], (e) => e.classList.contains('down') || e.classList.contains('up'));
  assert.ok(arrow.classList.contains('down'));
  assert.equal(dom.text(arrow), '▼');
  assert.match(dom.text(dom.find(root, (e) => e.classList.contains('fact__text'))), /held up 9 %/);
  assert.match(dom.text(tripRows(root)[0]), /17 trips · 8\.1\/h/);
  assert.equal(dom.find(root, (e) => e.classList.contains('progress')).children[0].getAttribute('style:--w'), '30.00%');
});

test('S1.9 in place: rows are kept by key and in order when the list changes (a trip drops out, a new one comes in, two swap places)', () => {
  const m = model(TWO, 'vehicle', ['v2#1']);
  const { view, root } = mount(m);
  const rows0 = tripRows(root);
  const names = rows0.map((r) => r.getAttribute('data-focus'));
  const next = structuredClone(m);
  const trips = blockOf(next, 'trips');
  const dropped = trips.rows.splice(1, 1)[0];
  const fresh = { ...trips.rows[0], key: 'loaded:s9>s9', focusId: 'loaded:s9>s9', name: 'A → B', rank: 3, label: '3: A to B', trips: 2 };
  trips.rows.push(fresh);
  [trips.rows[0], trips.rows[1]] = [trips.rows[1], trips.rows[0]];
  trips.rows.forEach((r, k) => { r.rank = k + 1; });
  view.update(next, { state: 'open', window: 'start' });
  const rows1 = tripRows(root);
  assert.equal(rows1.length, 3);
  assert.deepEqual(rows1.map((r) => r.getAttribute('data-focus')), trips.rows.map((r) => r.focusId), 'the order of the model');
  assert.ok(rows1.includes(rows0[0]) && rows1.includes(rows0[2]), 'the two that stayed are the same nodes (a focused row keeps its focus)');
  assert.ok(!rows1.includes(rows0[1]), 'the one that left is gone');
  assert.equal(rows1.find((r) => r.getAttribute('data-focus') === 'loaded:s9>s9').getAttribute('aria-label'), '3: A to B');
  assert.ok(names.includes(dropped.focusId));
  assert.equal(dom.find(root, (e) => e.classList.contains('trips')).children.length, 3);
});

test('S1.9 in place: a view built for a model keeps working while the model changes shape (a fact comes and goes, a held-up row appears)', () => {
  const m = model(TWO, 'vehicle', ['v2#1']);
  const { view, root } = mount(m);
  const facts = dom.find(root, (e) => e.localName === 'ul' && e.classList.contains('facts'));
  assert.equal(facts.children.length, 4);
  const keep = facts.children[1];
  const next = structuredClone(m);
  blockOf(next, 'facts').facts = blockOf(next, 'facts').facts.filter((f) => f.id !== 'held');
  view.update(next, { state: 'open', window: 'start' });
  assert.equal(facts.children.length, 3);
  assert.ok(facts.children.includes(keep), 'the fact that stayed is the same node');
  view.update(m, { state: 'open', window: 'start' });
  assert.equal(facts.children.length, 4);
  assert.deepEqual(facts.children.map((li) => li.getAttribute('data-key')), ['held', 'main', 'depot', 'fleet']);
  const fewer = structuredClone(m);
  blockOf(fewer, 'facts').facts = [];
  blockOf(fewer, 'facts').empty = 'Nothing stands out.';
  view.update(fewer, { state: 'open', window: 'start' });
  assert.equal(facts.children.length, 0);
  const empty = dom.find(root, (e) => e.getAttribute('data-role') === 'facts-empty');
  assert.ok(!empty.hidden);
  assert.equal(dom.text(empty), 'Nothing stands out.');
});

test('a model with another signature rebuilds the view once; the same signature never does', () => {
  const m = model(TWO, 'vehicle', ['v2#1']);
  const { view, root } = mount(m);
  const first = tiles(root)[0];
  view.update(model(TWO, 'vehicle', ['v2#1'], { window: 'last30' }), { state: 'open', window: 'last30' });
  assert.equal(tiles(root)[0], first, 'another window of the same vehicle: the same tiles');
  assert.equal(tileTexts(tiles(root)[5]).label.replace(/\s*·.*$/, ''), 'Lowest, 30 min');
  view.update(model(TWO, 'station', ['s5']), { state: 'open', window: 'start' });
  assert.notEqual(tiles(root)[0], first, 'another kind of item: new tiles');
  assert.equal(tiles(root).length, 6);
  assert.equal(root.getAttribute('data-kind'), 'station');
  view.update(buildStatsModel({ ...fixtureInput(TWO, { kind: 'station', ids: ['s5'] }), sim: null, report: null }), { state: 'open', window: 'start' });
  assert.equal(root.getAttribute('data-status'), 'waiting');
  assert.deepEqual(root.children[1].children.map((b) => b.getAttribute('data-block')), ['status']);
  assert.match(dom.text(root.children[1]), /^Press play to see statistics for Press line\./);
  assert.ok(tiles(root).every((t) => tileTexts(t).num === '–'), 'six dashes before the first measured second');
});

test('S1.9 in place on a real run: as the simulation advances the same nodes show the new numbers', () => {
  const sim = runExample('two-lines', { seconds: 20 * 60 });
  const sel = { kind: 'vehicle', ids: ['v2#1'] };
  const first = buildStatsModel(liveInput(sim, sel));
  const { view, root } = mount(first);
  const before = nodesOf(root);
  const text0 = dom.text(root);
  sim.advance(10 * 60);
  const second = buildStatsModel(liveInput(sim, sel));
  assert.equal(second.signature, first.signature, 'ten simulated minutes later it is the same view');
  view.update(second, { state: 'open', window: 'start' });
  const after = nodesOf(root);
  // only the rows of a list may come and go; the strip, the headings, the bar and the legend keep every node
  assert.ok(before.slice(0, 120).every((n, i) => n === after[i]), 'the strip and the first block keep every node');
  assert.notEqual(dom.text(root), text0, 'and the numbers moved');
  assert.equal(tiles(root).length, 6);
  assert.equal(tileTexts(tiles(root)[0]).num, second.tiles[0].value);
});

// ---------------------------------------------------------------------------------------------------------
// routes: hover, focus, pin
// ---------------------------------------------------------------------------------------------------------

test('S1.11 hover and focus on a trip row draw its route (host.focusRoute), leaving or blurring lets go', async () => {
  const { root, host } = mount(model(TWO, 'vehicle', ['v2#1']));
  const row = tripRows(root)[0];
  await row.fire('pointerenter');
  assert.deepEqual(host.calls.focusRoute.at(-1), [row.getAttribute('data-focus'), { pinned: false }]);
  await row.fire('pointerleave');
  assert.deepEqual(host.calls.focusRoute.at(-1), [null, { pinned: false }]);
  await tripRows(root)[1].fire('focus');
  assert.deepEqual(host.calls.focusRoute.at(-1), [tripRows(root)[1].getAttribute('data-focus'), { pinned: false }], 'keyboard focus draws it too');
  await tripRows(root)[1].fire('blur');
  assert.deepEqual(host.calls.focusRoute.at(-1), [null, { pinned: false }]);
  assert.ok(tripRows(root).every((r) => r.getAttribute('data-focus').startsWith('loaded:')), 'the ids the overlay understands');
});

test('S1.11 Enter or a click pins a route, a pin is not overridden by hovering, a second click or Esc lets go (the first Esc is the view\'s, the second the editor\'s)', async () => {
  const { view, root, host } = mount(model(TWO, 'vehicle', ['v2#1']));
  const [a, b] = tripRows(root);
  await a.fire('click');
  assert.deepEqual(host.calls.focusRoute.at(-1), [a.getAttribute('data-focus'), { pinned: true }]);
  assert.equal(a.getAttribute('aria-pressed'), 'true');
  assert.ok(a.classList.contains('is-hot'));
  const n = host.calls.focusRoute.length;
  await b.fire('pointerenter');
  await b.fire('pointerleave');
  assert.equal(host.calls.focusRoute.length, n, 'hovering another row does not draw over the pin');
  await b.fire('click');
  assert.deepEqual(host.calls.focusRoute.at(-1), [b.getAttribute('data-focus'), { pinned: true }], 'a click on another row moves the pin');
  assert.equal(a.getAttribute('aria-pressed'), 'false');
  assert.ok(!a.classList.contains('is-hot'));
  assert.equal(view.escape(), true, 'Esc unpins first');
  assert.deepEqual(host.calls.focusRoute.at(-1), [null, { pinned: false }]);
  assert.equal(b.getAttribute('aria-pressed'), 'false');
  assert.equal(view.escape(), false, 'and the second Esc is for the editor (it clears the selection)');
  await a.fire('click');
  await a.fire('click');
  assert.deepEqual(host.calls.focusRoute.at(-1), [null, { pinned: false }], 'a second click unpins');
  assert.equal(view.inspect().pinned, null);
});

test('S1.11 the usual round is pinned with its own button, which also brings it into view; a pinned route that disappears is let go', async () => {
  const m = model(TWO, 'vehicle', ['v2#1']);
  const { view, root, host } = mount(m);
  const show = dom.find(root, (e) => e.getAttribute('data-role') === 'round-show');
  await show.fire('click');
  assert.deepEqual(host.calls.focusRoute.at(-1), [ROUND_FOCUS_ID, { pinned: true }]);
  assert.equal(show.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(host.calls.showOnPlan.at(-1), blockOf(m, 'trips').round.bounds, 'the rectangle of its two paths');
  const without = structuredClone(m);
  blockOf(without, 'trips').round = null;
  view.update(without, { state: 'open', window: 'start' });
  assert.deepEqual(host.calls.focusRoute.at(-1), [null, { pinned: false }], 'the round is gone: the pin is let go');
  // a pinned trip that leaves the list
  const [row] = tripRows(root);
  await row.fire('click');
  assert.equal(view.inspect().pinned, row.getAttribute('data-focus'));
  const moved = structuredClone(m);
  blockOf(moved, 'trips').rows = blockOf(moved, 'trips').rows.slice(1);
  view.update(moved, { state: 'open', window: 'start' });
  assert.deepEqual(host.calls.focusRoute.at(-1), [null, { pinned: false }]);
  assert.equal(view.inspect().pinned, null);
  // destroying the view lets go of whatever it hovered
  const n = host.calls.focusRoute.length;
  view.destroy();
  assert.equal(host.calls.focusRoute.length, n + 1);
  assert.deepEqual(host.calls.focusRoute.at(-1), [null, { pinned: false }]);
});

test('a fact with a place has a "Show on plan" link that asks the shell to show that rectangle', async () => {
  const m = model(TWO, 'station', ['s5']);
  const { root, host } = mount(m);
  const link = dom.find(root, (e) => e.getAttribute('data-role') === 'fact-show');
  assert.ok(link && !link.hidden, 'a finding of the Results tab that names the station');
  await link.fire('click');
  assert.deepEqual(host.calls.showOnPlan.at(-1), blockOf(m, 'facts').facts[0].rect);
  const none = model(TWO, 'station', ['s5']);
  blockOf(none, 'facts').facts.forEach((f) => { f.rect = null; });
  const second = mount(none);
  assert.ok(dom.find(second.root, (e) => e.getAttribute('data-role') === 'fact-show').hidden, 'no place: no link');
});

// ---------------------------------------------------------------------------------------------------------
// the counting rules in place, touch areas
// ---------------------------------------------------------------------------------------------------------

test('S1.14: the (i) of a number opens its rule in place and closes it again (touch screens have no hover)', async () => {
  const m = model(TWO, 'vehicle', ['v2#1']);
  const { root } = mount(m);
  const t = tiles(root)[1];
  const def = dom.find(t, (e) => e.classList.contains('def'));
  const note = dom.find(t, (e) => e.getAttribute('role') === 'note');
  assert.ok(note.hidden);
  await def.fire('click');
  assert.equal(def.getAttribute('aria-expanded'), 'true');
  assert.ok(!note.hidden);
  assert.equal(dom.text(note), m.tiles[1].def);
  assert.match(dom.text(note), /Waiting counts as busy/);
  await def.fire('click');
  assert.equal(def.getAttribute('aria-expanded'), 'false');
  assert.ok(note.hidden);
  assert.ok(tiles(root).filter((x) => x !== t).every((x) => dom.find(x, (e) => e.getAttribute('role') === 'note').hidden), 'the others stay closed');
});

test('"How is this counted?" lists the rule of every number and block of the page', async () => {
  const m = model(TWO, 'vehicle', ['v2#1']);
  const { root } = mount(m);
  const toggle = dom.find(root, (e) => e.getAttribute('data-role') === 'how-toggle');
  const defs = dom.find(root, (e) => e.getAttribute('data-role') === 'definitions');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.ok(defs.hidden);
  await toggle.fire('click');
  assert.ok(!defs.hidden);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  const facts = blockOf(m, 'facts');
  assert.equal(defs.children.length, facts.definitions.length);
  assert.equal(defs.children.length, 6 + 4, 'six numbers and four blocks');
  facts.definitions.forEach((d, k) => assert.equal(dom.text(defs.children[k]), `${d.label}. ${d.text}`));
  assert.equal(defs.getAttribute('role'), 'group');
  const howLines = dom.find(root, (e) => e.getAttribute('data-role') === 'how');
  assert.deepEqual(howLines.children.map((p) => dom.text(p)), facts.how);
});

test('the other drives open and close in place', async () => {
  const { root } = mount(model(TWO, 'vehicle', ['v2#1']));
  const toggle = dom.find(root, (e) => e.getAttribute('data-role') === 'other-toggle');
  const list = dom.find(root, (e) => e.getAttribute('data-role') === 'other-list');
  await toggle.fire('click');
  assert.ok(!list.hidden);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(list.children.length, 2);
  assert.match(dom.text(list.children[0]), /^Empty, to a pickup: 39 drives · \d[\d.,]* (m|km) · about \d+ s each$/);
  assert.match(dom.text(list.children[1]), /^To a depot or charger: 27 drives/);
  await toggle.fire('click');
  assert.ok(list.hidden);
});

test('S1.14: on a coarse pointer the (i), the links and the disclosure get a 40 px touch area; on a mouse nothing is added', () => {
  const m = model(TWO, 'vehicle', ['v2#1']);
  const plain = mount(m);
  assert.ok(dom.findAll(plain.root, (e) => e.classList.contains('def')).every((b) => b.getAttribute('style:padding') === null), 'a mouse: no padding');
  globalThis.matchMedia = (q) => ({ matches: q === '(pointer: coarse)' });
  try {
    const { root } = mount(m);
    const small = dom.findAll(root, (e) => e.classList.contains('def') || (e.classList.contains('link')) || e.classList.contains('disclose'));
    assert.ok(small.length >= 8, `${small.length} small controls`);
    for (const b of small) {
      assert.match(b.getAttribute('style:padding'), /^\d+px \d+px$/, b.className);
      assert.match(b.getAttribute('style:margin'), /^-\d+px -\d+px$/, 'a negative margin takes the padding back: the layout does not move');
    }
    const def = small.find((b) => b.classList.contains('def'));
    assert.equal(def.getAttribute('style:padding'), '12px 12px', '16 px of icon and 12 px on every side: 40 px');
    assert.ok(tripRows(root).length > 0 && tripRows(root).every((r) => r.getAttribute('style:padding') === null), 'a trip row is tall enough by itself');
  } finally {
    delete globalThis.matchMedia;
  }
});

// ---------------------------------------------------------------------------------------------------------
// the shape of a path
// ---------------------------------------------------------------------------------------------------------

test('a number that keeps its since-start value says so, and a row shows what its numbers are based on', () => {
  const m = model(TWO, 'vehicle', ['v2#1']);
  const { view, root } = mount(m);
  const t = tiles(root)[3];
  const since = dom.find(t, (e) => e.classList.contains('tile__since'));
  assert.ok(since.hidden, 'a number with its own window says nothing');
  const next = structuredClone(m);
  next.tiles[3].since = true;
  blockOf(next, 'trips').rows[0].note = 'times from 3 of 5 trips · 1 trip not drawn';
  view.update(next, { state: 'open', window: 'last30' });
  assert.ok(!since.hidden);
  assert.equal(dom.text(since), ' · since start');
  const note = dom.findAll(tripRows(root)[0], (e) => e.classList.contains('trip__share')).find((e) => /times from/.test(dom.text(e)));
  assert.ok(note && !note.hidden && dom.text(note) === ' · times from 3 of 5 trips · 1 trip not drawn');
});

test('the small picture of a trip scales its corner points into the box, keeping the proportions', () => {
  assert.deepEqual(shapePoints([]), []);
  assert.deepEqual(shapePoints(null), []);
  const pts = shapePoints([[0, 0], [10, 0], [10, 2]]);
  assert.equal(pts.length, 3);
  for (const [x, y] of pts) assert.ok(x >= 4 - 1e-9 && x <= 48 + 1e-9 && y >= 4 - 1e-9 && y <= 24 + 1e-9, `${x},${y} inside the box with its margin`);
  const k = (pts[1][0] - pts[0][0]) / 10;
  assert.ok(Math.abs((pts[2][1] - pts[1][1]) / 2 - k) < 1e-9, 'one scale for both axes');
  const dot = shapePoints([[5, 5]]);
  assert.equal(dot.length, 1);
  assert.ok(Number.isFinite(dot[0][0]) && Number.isFinite(dot[0][1]), 'a single point is a dot in the middle, not a division by zero');
  assert.deepEqual(shapePoints([[3, 3], [3, 3]]).every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])), true);
  // the box is the one of a trip row: 52 x 28
  const line = shapePoints([[0, 0], [100, 0]]);
  assert.ok(Math.abs(line[0][0] - 2) < 1e-9 || line[0][0] >= 4 - 1e-9);
});

test('the id of a route in the view is the id of the model', () => {
  assert.equal(routeFocusId('loaded', 's1', 's2'), 'loaded:s1>s2');
  const m = model(TWO, 'vehicle', ['v2#1']);
  const { root } = mount(m);
  assert.deepEqual(tripRows(root).map((r) => r.getAttribute('data-focus')), blockOf(m, 'trips').rows.map((r) => r.focusId));
});
