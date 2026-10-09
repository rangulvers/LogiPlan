// The sparse top-level blocks of a layout that belong to optional modules (docs/WAREHOUSE-DESIGN.md 5.1, 5.3): today `calendar`, from
// M5 also `loadTypes`. Pure, no DOM. normalizeLayout calls normalizeExtensions once, after the stations are sanitized, and appends the
// result to the layout it builds, AFTER `settings` (rule 3 of 5.1: new keys come last, so legacy files stay byte-identical).
//
// A block is returned only when the plant uses the feature; an absent block means "feature off", so a legacy layout gets {} back.
// STATE (milestone M0): nothing is implemented, normalizeExtensions always returns {}.
//
// Later milestones also put `pruneRefs(layout)` here (5.1 rule 7): it removes staffing rows of deleted shifts, profile references to
// deleted profiles and type references to deleted types, and is called by normalizeLayout and by every remove mutator.

import { sanitizeCalendar } from './calendar.js';

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
