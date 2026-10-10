// The Help page "Statistics of an item" (js/ui/panels/stats-help.js; docs/ENTITY-INSIGHTS-DESIGN.md 5, 9.3 S3.7 in the part that S1 already has): the page lists the counting rule of
// EVERY number and block, from the same table as the (i) of the tiles, so that the two cannot drift apart; it says what the dock is and when it opens; it is registered in the Help dialog.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStatsHelp, STATS_HELP_GROUPS } from '../js/ui/panels/stats-help.js';
import { BLOCK_DEFINITIONS, DEFINITIONS, MIN_LEGS_FOR_USUAL } from '../js/ui/panels/stats-model.js';
import { installStatsDom } from './helpers/stats-dom.js';
import { ROOT } from './helpers/stats-fixtures.js';

const dom = installStatsDom();
after(() => dom.restore());

const page = () => createStatsHelp();

test('every counting rule of the dock is on the page, word for word (the page and the (i) of a tile come from one table)', () => {
  const root = page();
  const text = dom.text(root);
  for (const [id, def] of Object.entries(DEFINITIONS)) {
    assert.ok(text.includes(def.text), `${id}: the rule of "${def.label}" is on the page`);
    assert.ok(text.includes(def.label), `${id}: and its words`);
  }
  for (const [id, def] of Object.entries(BLOCK_DEFINITIONS)) assert.ok(text.includes(def.text), `block ${id}`);
  const terms = dom.byTag(root, 'dt').map((dt) => dom.text(dt));
  assert.ok(terms.length >= Object.keys(DEFINITIONS).length + Object.keys(BLOCK_DEFINITIONS).length, `${terms.length} terms`);
});

test('every definition belongs to exactly one group of the page, so none is forgotten and none is said twice under one heading', () => {
  const seen = new Map();
  for (const g of STATS_HELP_GROUPS) {
    for (const id of g.ids) { assert.ok(DEFINITIONS[id], `${g.id}: ${id} exists`); seen.set(id, (seen.get(id) || 0) + 1); }
    for (const id of g.blocks) assert.ok(BLOCK_DEFINITIONS[id], `${g.id}: block ${id} exists`);
  }
  for (const id of Object.keys(DEFINITIONS)) assert.equal(seen.get(id), 1, `${id} is in exactly one group`);
  assert.deepEqual(STATS_HELP_GROUPS.map((g) => g.id), ['vehicle', 'vehicleReport', 'process', 'source', 'storage', 'sink', 'depot', 'flow', 'fleet', 'cell', 'several']);
  assert.ok(STATS_HELP_GROUPS.every((g) => g.title && g.intro && g.ids.length > 0));
});

test('the page says what the dock is, when it opens, the two windows, the keys and how to read the routes', () => {
  const text = dom.text(page());
  for (const phrase of ['Statistics dock', 'opens over the bottom of the plan', 'Pressing and dragging an item moves it and does not open the dock', 'Since start', 'Last 30 min', 'indicative',
    'Esc', 'Fleet tab', 'Routes on plan', 'Enter pins it', 'share of the trip lost to waiting', 'the dock pair is shown', `at least ${MIN_LEGS_FOR_USUAL} complete trips`, 'Busy, incl. waiting', 'Held up', 'No job',
    'workload arithmetic', 'How every number is counted']) {
    assert.ok(text.toLowerCase().includes(phrase.toLowerCase()), `the page says "${phrase}"`);
  }
  assert.ok(text.includes('I opens or closes the dock'), 'the keys');
  assert.ok(text.includes('[ and ]'));
  assert.ok(!/\bWorking\b/.test(text) && !/Waiting for a job/i.test(text), 'the retired words are not on the page');
});

test('the page has no aria-live, no markup injected, and headings for every kind of item', () => {
  const root = page();
  assert.equal(dom.liveRegions(root).length, 0);
  assert.equal(root.getAttribute('data-help'), 'statistics');
  const headings = dom.byTag(root, 'h3').map((h) => dom.text(h));
  for (const g of STATS_HELP_GROUPS) assert.ok(headings.includes(g.title), g.title);
  assert.ok(dom.innerHtmlWrites.every((w) => w.tag === 'template'), 'built with textContent only');
});

test('the Help dialog lists the page after the trucks page, under the id "statistics"', () => {
  const dialogs = readFileSync(`${ROOT}/js/ui/dialogs.js`, 'utf8');
  assert.match(dialogs, /import \{ createStatsHelp \} from '\.\/panels\/stats-help\.js';/);
  const tabs = [...dialogs.matchAll(/\{ id: '([a-z]+)', label: '([^']+)', content: /g)].map((m) => [m[1], m[2]]);
  const at = tabs.findIndex(([id]) => id === 'statistics');
  assert.ok(at > 0, 'registered');
  assert.deepEqual(tabs[at], ['statistics', 'Statistics of an item']);
  assert.equal(tabs[at - 1][0], 'trucks', 'after the trucks page');
  assert.match(dialogs, /content: createStatsHelp\(\)/);
});
