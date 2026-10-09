// The sparse top-level blocks of a layout that belong to optional modules (docs/WAREHOUSE-DESIGN.md 5.1, 5.3): today `calendar`, from
// M5 also `loadTypes`. Pure, no DOM. normalizeLayout calls normalizeExtensions once, after the stations are sanitized, and appends the
// result to the layout it builds, AFTER `settings` (rule 3 of 5.1: new keys come last, so legacy files stay byte-identical).
//
// A block is returned only when the plant uses the feature; an absent block means "feature off", so a legacy layout gets {} back.
// STATE (milestone M0): nothing is implemented, normalizeExtensions always returns {}.
//
// `reconcileLayout(layout)` is the other half: what normalizeLayout derives from the content of a layout (the optional blocks that other
// content implies, the schema stamp), re-derived in place for the mutators of layout.js. A derived value is maintained in ONE place, here,
// and a mutator that adds or removes persisted extension content ends with a call to it (3.1 of docs/ARCHITECTURE.md). Later milestones
// also run `pruneRefs(layout)` (5.1 rule 7) from it: it removes staffing rows of deleted shifts, profile references to deleted profiles and
// type references to deleted types.

import { sanitizeCalendar } from './calendar.js';
import { schemaNeeded } from './schema.js';

/**
 * The optional top-level blocks, in the order they are appended to the layout: { key, sanitize(raw[key], layout) => block | undefined }.
 * M1 makes `calendar` real, M5 adds `loadTypes`. (A list that milestones add to, so that a test can swap in a stand-in sanitizer.)
 */
export const EXTENSION_BLOCKS = [{ key: 'calendar', sanitize: sanitizeCalendar }];

/**
 * Sanitized optional top-level blocks.
 * @param {object} raw the raw layout being normalized
 * @param {object} layout the layout built so far (grid, stations with their sanitized `ops`, flows, fleets, settings)
 * @returns {Record<string, unknown>} only the blocks that exist
 */
export function normalizeExtensions(raw, layout) {
  const out = {};
  for (const { key, sanitize } of EXTENSION_BLOCKS) {
    const block = sanitize(raw[key], layout);
    if (block !== undefined) out[key] = block;
  }
  return out;
}

/**
 * Re-derive, in place, everything that depends on the content of `layout`, so that after a mutator `normalizeLayout(layout)` is the same
 * layout again (and `checkInvariants` finds nothing to say about the stamp): every optional block is sanitized from the layout itself (a
 * block that other content implies appears, one that nothing needs any more goes), then `layout.schema` is stamped with `schemaNeeded`.
 * Writes only what changed, so a layout that is already consistent is left untouched (also a frozen one).
 * @param {object} layout a normalized layout (or a store draft of one), edited in place
 * @returns {object} `layout`
 */
export function reconcileLayout(layout) {
  for (const { key, sanitize } of EXTENSION_BLOCKS) {
    const block = sanitize(layout[key], layout);
    if (block === undefined) {
      if (key in layout) delete layout[key];
    } else if (JSON.stringify(layout[key]) !== JSON.stringify(block)) {
      layout[key] = block;
    }
  }
  const need = schemaNeeded(layout);
  if (layout.schema !== need) layout.schema = need;
  return layout;
}
