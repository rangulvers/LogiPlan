// The examples gallery and the Examples page of the Help dialog (js/ui/examples-gallery.js, docs/EXAMPLES-DESIGN.md 7). The DOM behaviour in the real browser is
// covered by tests/e2e/examples.mjs and tests/e2e/panels2.mjs; here the pure helpers and the builders run in Node on a fake DOM.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXAMPLES } from '../js/model/examples.js';
import {
  EXAMPLE_LEVELS, DEFAULT_LEVEL, MAX_CARD_CHIPS, levelOf, levelBadgeText, sortExamples, groupByLevel, cardChips, isWideExample, learnOf,
  cardExtras, galleryLevel, createExamplesHelp, helpBlockId, EXAMPLES_HELP_INTRO,
} from '../js/ui/examples-gallery.js';
import { installStatsDom } from './helpers/stats-dom.js';

const dom = installStatsDom();
after(() => dom.restore());

const ROOT = new URL('..', import.meta.url).pathname;

test('five levels with a heading and a caption each, in the order of the design', () => {
  assert.deepEqual(EXAMPLE_LEVELS.map((l) => l.level), [1, 2, 3, 4, 5]);
  assert.deepEqual(EXAMPLE_LEVELS.map((l) => l.title), ['Start here', 'One idea at a time', 'Several things at once', 'A whole plant', 'Two plants, one campus']);
  assert.ok(EXAMPLE_LEVELS.every((l) => l.caption.length > 10 && l.caption.endsWith('.')));
});

test('the registry carries the gallery metadata: a level, a unique rank, a learn line and some chips on every entry (the card shows three; the limits of the design belong to the registry test)', () => {
  const ranks = new Set();
  for (const e of EXAMPLES) {
    assert.ok(Number.isInteger(e.level) && e.level >= 1 && e.level <= 5, `${e.id}: level`);
    assert.ok(Number.isInteger(e.rank) && !ranks.has(e.rank), `${e.id}: rank`);
    ranks.add(e.rank);
    assert.ok(learnOf(e).length > 0 && learnOf(e).length <= 110, `${e.id}: learn line of at most 110 characters`);
    assert.ok(Array.isArray(e.chips) && e.chips.length >= 1 && e.chips.every((c) => typeof c === 'string' && c.trim()), `${e.id}: chips`);
    assert.ok(Array.isArray(e.tips) && e.tips.length >= 1, `${e.id}: tips`);
  }
});

test('sortExamples orders by level, then rank, and does not touch the registry array', () => {
  const before = EXAMPLES.map((e) => e.id);
  const sorted = sortExamples(EXAMPLES);
  assert.deepEqual(EXAMPLES.map((e) => e.id), before, 'the registry order stays (tests pin it)');
  assert.equal(sorted.length, EXAMPLES.length);
  for (let i = 1; i < sorted.length; i++) {
    const [a, b] = [sorted[i - 1], sorted[i]];
    assert.ok(a.level < b.level || (a.level === b.level && a.rank < b.rank), `${a.id} before ${b.id}`);
  }
  assert.equal(sorted[0].id, 'hello-pallet', 'the simplest comes first');
  assert.equal(sorted.at(-1).id, 'twin-plants', 'the finale comes last');
});

test('entries without metadata still show up: level 3, after the ranked ones, in registry order', () => {
  const bare = [{ id: 'x' }, { id: 'y', level: 1, rank: 2 }, { id: 'z', level: 9, rank: 'a' }, { id: 'w', level: 3, rank: 1 }];
  assert.deepEqual(sortExamples(bare).map((e) => e.id), ['y', 'w', 'x', 'z']);
  assert.equal(levelOf({}), DEFAULT_LEVEL);
  assert.equal(levelOf({ level: 0 }), DEFAULT_LEVEL);
  assert.equal(levelOf({ level: 2.5 }), DEFAULT_LEVEL);
  assert.equal(levelOf(null), DEFAULT_LEVEL);
  assert.equal(learnOf({}), '');
});

test('groupByLevel gives only the levels that have examples, each with its examples in rank order', () => {
  const groups = groupByLevel(EXAMPLES);
  assert.deepEqual(groups.map((g) => g.level), [1, 2, 3, 4, 5]);
  assert.deepEqual(groups.flatMap((g) => g.examples.map((e) => e.id)), sortExamples(EXAMPLES).map((e) => e.id));
  assert.deepEqual(groupByLevel([{ id: 'a', level: 4, rank: 1 }]).map((g) => g.level), [4], 'empty levels are left out');
  assert.deepEqual(groupByLevel([]), []);
});

test('the badge is text ("Level 2 of 5"), a card shows at most three chips, empty ones are dropped', () => {
  assert.equal(levelBadgeText(2), 'Level 2 of 5');
  assert.deepEqual(cardChips({ chips: ['a', 'b', 'c', 'd', 'e'] }), ['a', 'b', 'c']);
  assert.deepEqual(cardChips({ chips: ['', ' ', 7, 'ok'] }), ['ok']);
  assert.deepEqual(cardChips({}), []);
  assert.equal(MAX_CARD_CHIPS, 3);
});

test('only the plan of the twin plants is wide enough for a card across two columns', () => {
  const wide = EXAMPLES.filter((e) => isWideExample(e.build())).map((e) => e.id);
  assert.deepEqual(wide, ['twin-plants']);
  assert.equal(isWideExample({ grid: { cols: 0, rows: 0 } }), false);
});

test('card extras: badge text, learn line and chips as text, the dots are decoration', () => {
  const hello = EXAMPLES.find((e) => e.id === 'hello-pallet');
  const x = cardExtras(hello);
  assert.equal(dom.text(x.badge), 'Level 1 of 5');
  assert.equal(dom.findAll(x.badge, (e) => e.getAttribute('aria-hidden') === 'true').length, 1, 'the dots are aria-hidden');
  assert.equal(dom.text(x.learn), hello.learn);
  assert.deepEqual(dom.byClass(x.chips, 'chip').map((c) => dom.text(c)), cardChips(hello));
  const bare = cardExtras({ id: 'q' });
  assert.equal(bare.learn, null);
  assert.equal(bare.chips, null);
  assert.equal(dom.text(bare.badge), 'Level 3 of 5');
});

test('a level section is labelled by its real heading and holds its cards', () => {
  const group = groupByLevel(EXAMPLES)[1];
  const card = document.createElement('button');
  const el = galleryLevel(group, [card]);
  const heading = dom.byTag(el, 'h4')[0];
  assert.equal(dom.text(heading), `${group.level}. ${group.title}`);
  assert.equal(el.getAttribute('aria-labelledby'), heading.id);
  assert.ok(heading.id.length > 0);
  assert.equal(dom.text(dom.byTag(el, 'p')[0]), group.caption);
  assert.equal(dom.byClass(el, 'example-grid')[0].childNodes[0], card);
  const other = galleryLevel(group, []);
  assert.notEqual(dom.byTag(other, 'h4')[0].id, heading.id, 'ids are unique even for the same level');
});

test('the Examples page lists every example in gallery order with the tips of the registry as an ordered list', () => {
  const opened = [];
  const page = createExamplesHelp({ examples: EXAMPLES, onOpen: (e) => opened.push(e.id) });
  const blocks = dom.byClass(page.el, 'example-help');
  assert.deepEqual(blocks.map((b) => b.getAttribute('data-example')), sortExamples(EXAMPLES).map((e) => e.id));
  assert.ok(dom.text(page.el).includes(EXAMPLES_HELP_INTRO));
  for (const example of EXAMPLES) {
    const block = blocks.find((b) => b.getAttribute('data-example') === example.id);
    assert.equal(block.id, helpBlockId(example.id));
    const heading = dom.byTag(block, 'h3')[0];
    assert.equal(dom.text(heading), example.name);
    assert.equal(block.getAttribute('aria-labelledby'), heading.id);
    assert.equal(heading.getAttribute('tabindex'), '-1', 'the heading can take the focus');
    assert.ok(dom.text(block).includes(`Level ${example.level} of 5`) && dom.text(block).includes(example.learn));
    assert.deepEqual(dom.byTag(dom.byTag(block, 'ol')[0], 'li').map((li) => dom.text(li)), example.tips, `${example.id}: the text of the tips is the registry's`);
    const button = dom.byRole(block, 'open-example')[0];
    assert.equal(dom.text(button), 'Open this example');
    assert.equal(button.getAttribute('aria-label'), `Open this example: ${example.name}`);
  }
  dom.byRole(blocks[3], 'open-example')[0].click();
  assert.deepEqual(opened, [sortExamples(EXAMPLES)[3].id], 'the button opens its own example');
});

test('reveal puts the focus on the heading of that example and says whether it exists; an entry without tips has no list', () => {
  const page = createExamplesHelp({ examples: [...EXAMPLES, { id: 'bare', name: 'Bare one' }], onOpen: () => {} });
  let scrolled = 0;
  for (const el of dom.elements(page.el)) el.scrollIntoView = () => { scrolled++; };
  assert.equal(page.reveal('twin-plants'), true);
  assert.equal(dom.text(document.activeElement), EXAMPLES.find((e) => e.id === 'twin-plants').name);
  assert.equal(scrolled, 1);
  assert.equal(page.reveal('nope'), false);
  assert.equal(dom.byTag(dom.byClass(page.el, 'example-help').find((b) => b.getAttribute('data-example') === 'bare'), 'ol').length, 0);
});

test('the Help dialog registers the Examples page after the Tips page, and the toast action opens it at the example', () => {
  const dialogs = readFileSync(`${ROOT}/js/ui/dialogs.js`, 'utf8');
  const tabs = [...dialogs.matchAll(/\{ id: '([a-z]+)', label: '([^']+)', content: /g)].map((m) => m[1]);
  assert.equal(tabs.at(-1), 'examples');
  assert.equal(tabs.at(-2), 'tips');
  assert.match(dialogs, /openHelp\(ctx, dlg, options/, 'the Help gets the context: "Open this example" needs ctx.actions.loadExample');
  const app = readFileSync(`${ROOT}/js/ui/app.js`, 'utf8');
  assert.match(app, /label: 'Things to try', onClick: \(\) => ctx\.dialogs\.openHelp\(\{ tab: 'examples', example: id \}\)/);
});

test('no number or currency in the gallery texts beyond the level badge: the level captions and the intro name no figure a test does not check', () => {
  for (const l of EXAMPLE_LEVELS) assert.ok(!/[€$£]/.test(l.caption) && !/\d/.test(l.caption), l.title);
  assert.ok(!/[€$£]/.test(EXAMPLES_HELP_INTRO));
  assert.match(EXAMPLES_HELP_INTRO, /five runs of 8 simulated hours \(seeds 1 to 5\)/);
  assert.match(EXAMPLES_HELP_INTRO, /600×/);
});
