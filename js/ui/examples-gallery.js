// The examples gallery and the Examples page of the Help dialog (docs/EXAMPLES-DESIGN.md sections 7.1 to 7.4).
//
// The welcome dialog groups the cards by level, the Help dialog lists every example with its tips. Both read the registry
// (js/model/examples.js): `level` (1 to 5), `rank` (the recommended path), `learn` (one line), `chips` (short tags), `tips`.
// Entries without that metadata still show up (level 3, after the ranked ones), so a registry in the middle of an edit does not break the dialog.
//
//   sortExamples(examples) / groupByLevel(examples)   the display order, and the five sections
//   levelBadgeText(level)  cardChips(example)         "Level 2 of 5", up to three chip texts
//   isWideExample(layout)                             does the plan need a card across two columns (the twin plants)?
//   galleryLevel({ group, cards })                    one section: heading, caption and the grid of cards
//   createExamplesHelp({ examples, onOpen })          the Help page: { el, reveal(id) }
//
// Pure helpers and DOM builders only; the dialogs (js/ui/dialogs.js) own the behaviour (loading an example, closing the dialog).

import { h } from '../util/dom.js';

/** The five levels of the gallery, in order: heading and the one-line caption under it. */
export const EXAMPLE_LEVELS = Object.freeze([
  { level: 1, title: 'Start here', caption: 'One road, then one small plant.' },
  { level: 2, title: 'One idea at a time', caption: 'Each plant teaches one thing: energy, distance, docks.' },
  { level: 3, title: 'Several things at once', caption: 'Lines, traffic and trucks together in one plant.' },
  { level: 4, title: 'A whole plant', caption: 'A day on a timetable, or a hall with three kinds of vehicle.' },
  { level: 5, title: 'Two plants, one campus', caption: 'Shared goods, a shuttle fleet and one charging hall.' },
]);

/** Level used for an example that carries no (valid) level. */
export const DEFAULT_LEVEL = 3;
/** A card shows at most this many chips. */
export const MAX_CARD_CHIPS = 3;
/** A plan at least this much wider than high gets a card across two columns. */
export const WIDE_ASPECT = 3;

const isLevel = (n) => Number.isInteger(n) && n >= 1 && n <= EXAMPLE_LEVELS.length;

/** The level (1 to 5) of an example; DEFAULT_LEVEL when the entry has none. */
export const levelOf = (example) => (isLevel(example?.level) ? example.level : DEFAULT_LEVEL);

/** "Level 2 of 5". */
export const levelBadgeText = (level) => `Level ${level} of ${EXAMPLE_LEVELS.length}`;

/** Examples in display order: by level, then rank; entries without a rank keep their registry order after the ranked ones. */
export function sortExamples(examples) {
  const keyed = examples.map((example, index) => ({
    example, level: levelOf(example), rank: Number.isFinite(example.rank) ? example.rank : 1000 + index, index,
  }));
  keyed.sort((a, b) => a.level - b.level || a.rank - b.rank || a.index - b.index);
  return keyed.map((k) => k.example);
}

/** The sections of the gallery: [{ level, title, caption, examples }], only the levels that have examples, in order. */
export function groupByLevel(examples) {
  const sorted = sortExamples(examples);
  return EXAMPLE_LEVELS
    .map((entry) => ({ ...entry, examples: sorted.filter((e) => levelOf(e) === entry.level) }))
    .filter((group) => group.examples.length > 0);
}

/** The chips a card shows: the first MAX_CARD_CHIPS non-empty texts of `example.chips`. */
export const cardChips = (example) => (Array.isArray(example?.chips) ? example.chips : [])
  .filter((chip) => typeof chip === 'string' && chip.trim()).slice(0, MAX_CARD_CHIPS);

/** Does this plan (a layout) need a card across two columns? True for a plan much wider than high (the twin plants, 340 x 104 m). */
export function isWideExample(layout) {
  const { cols, rows } = layout.grid;
  return rows > 0 && cols / rows >= WIDE_ASPECT;
}

/** The text of the learn line of a card or help block ('' when the entry has none). */
export const learnOf = (example) => (typeof example?.learn === 'string' ? example.learn : '');

// ---------------------------------------------------------------------------------------------------------
// The gallery
// ---------------------------------------------------------------------------------------------------------

let galleryIds = 0;

/** The row of dots that goes with the badge text: decorative, the text carries the meaning. */
function levelDots(level) {
  return h('span', { class: 'example-dots', 'aria-hidden': 'true' },
    EXAMPLE_LEVELS.map((entry) => h('span', { class: `example-dots__dot${entry.level <= level ? ' example-dots__dot--on' : ''}` })));
}

/** Badge, learn line and chips of one card (the parts the dialog adds under the name). */
export function cardExtras(example) {
  const level = levelOf(example);
  const learn = learnOf(example);
  const chips = cardChips(example);
  return {
    badge: h('span', { class: 'example-badge', dataset: { role: 'level-badge' } }, levelDots(level), h('span', null, levelBadgeText(level))),
    learn: learn ? h('span', { class: 'example-learn', dataset: { role: 'learn' } }, learn) : null,
    chips: chips.length
      ? h('span', { class: 'example-chips', dataset: { role: 'chips' } }, chips.map((chip) => h('span', { class: 'chip' }, chip)))
      : null,
  };
}

/**
 * One level of the gallery: a real heading, its caption and the grid of its cards.
 * @param {{ level: number, title: string, caption: string }} group
 * @param {HTMLElement[]} cards the card elements of this level, in order
 */
export function galleryLevel(group, cards) {
  const titleId = `example-level-${group.level}-${++galleryIds}`;
  return h('section', { class: 'example-level', 'aria-labelledby': titleId, dataset: { level: String(group.level) } },
    h('h4', { class: 'example-level__title', id: titleId }, `${group.level}. ${group.title}`),
    h('p', { class: 'example-level__caption' }, group.caption),
    h('div', { class: 'example-grid-wrap' }, h('div', { class: 'example-grid' }, cards)));
}

// ---------------------------------------------------------------------------------------------------------
// The Help page "Examples"
// ---------------------------------------------------------------------------------------------------------

/** What the figures in the tips are: the first lines of the page. */
export const EXAMPLES_HELP_INTRO = 'The figures in the tips are means over five runs of 8 simulated hours (seeds 1 to 5). The app shows one run, so your numbers differ a little; '
  + 'use the Experiments tab for several runs. Set the speed in the bar above the plan to 600× and run to the hour the tip names. Every edit starts the run again.';

/** The element id of the block of one example on the Help page. */
export const helpBlockId = (id) => `help-example-${id}`;

/**
 * The Help page "Examples": every example in the order of the gallery (level, rank) with its level, learn line, an "Open this example" button
 * and its tips as an ordered list (the text of `example.tips`, one source of truth).
 * @param {{ examples: object[], onOpen: (example: object) => void }} spec
 * @returns {{ el: HTMLElement, reveal: (id: string) => boolean }} `reveal` scrolls the block of an example into view and puts focus on its heading
 */
export function createExamplesHelp({ examples, onOpen }) {
  const blocks = new Map();
  const list = h('div', { class: 'stack', style: { '--gap': '20px' } });
  for (const example of sortExamples(examples)) {
    const tips = Array.isArray(example.tips) ? example.tips : [];
    const learn = learnOf(example);
    const headingId = `${helpBlockId(example.id)}-title`;
    const title = h('h3', { id: headingId, tabindex: '-1', class: 'example-help__title' }, example.name);
    const block = h('section', { class: 'example-help', id: helpBlockId(example.id), 'aria-labelledby': headingId, dataset: { example: example.id } },
      h('div', { class: 'example-help__head' },
        h('div', { class: 'stack', style: { '--gap': '2px', minWidth: 0, flex: '1 1 260px' } },
          title,
          h('span', { class: 'text-dim' }, [levelBadgeText(levelOf(example)), learn].filter(Boolean).join(' · '))),
        h('button', {
          class: 'btn btn--sm', type: 'button', 'aria-label': `Open this example: ${example.name}`, dataset: { role: 'open-example' }, onclick: () => onOpen(example),
        }, 'Open this example')),
      tips.length ? h('ol', { class: 'example-help__tips' }, tips.map((tip) => h('li', null, tip))) : null);
    blocks.set(example.id, { block, title });
    list.append(block);
  }
  const el = h('div', { class: 'stack', style: { '--gap': '16px' } },
    h('p', { style: { margin: 0, lineHeight: 'var(--lh)', maxWidth: '78ch' } }, EXAMPLES_HELP_INTRO),
    list);
  return {
    el,
    reveal(id) {
      const found = blocks.get(id);
      if (!found) return false;
      found.title.focus({ preventScroll: true });
      if (typeof found.block.scrollIntoView === 'function') found.block.scrollIntoView({ block: 'start' });
      return true;
    },
  };
}
