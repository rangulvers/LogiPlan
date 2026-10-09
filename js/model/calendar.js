// The clock of a plant: `layout.calendar` and, from M2, the shifts, breaks and demand profiles it holds (docs/WAREHOUSE-DESIGN.md 5.3, 6.2).
// Pure, no DOM, imports only ops.js (the shared clamping helpers) and util. Absent means today: no calendar, times are elapsed seconds.
//
// STATE OF THIS FILE (milestone M0): a seam only.
//   sanitizeCalendar(raw, layout) -> undefined    no calendar is implemented yet: normalizeLayout leaves `calendar` off the layout
//   mergeCalendar(current, patch) -> undefined    the same for a patch (`null` removes the calendar)
// M1 adds `startTod`/`startDay` (and creates the calendar for a plant whose trucks use a timetable), M2 shifts, breaks and profiles plus
// `compileTimeline`, `makeClock` and `tauInverse`. The sanitizers there follow the rules in the header of ops.js.

import { numberOf } from './ops.js';

/** Documented keys of `layout.calendar`, same shape as OPS_KEYS in ops.js (empty until a milestone adds keys). */
export const CALENDAR_KEYS = Object.freeze([]);

export const SECONDS_PER_DAY = 86400;

/**
 * A time of day in seconds after midnight (an integer 0..86399) from a number or numeric string, or from "H:MM", "HH:MM" or
 * "HH:MM:SS"; null for anything else (5.1: the UI shows HH:MM, the sanitizer accepts the string).
 * @param {unknown} v
 * @returns {number|null}
 */
export function timeOfDay(v) {
  if (typeof v === 'string') {
    const m = /^\s*(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\s*$/.exec(v);
    if (m) return Number(m[1]) < 24 ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0) : null;
  }
  const n = numberOf(v);
  if (n === null) return null;
  const seconds = Math.round(n) + 0;
  return seconds >= 0 && seconds < SECONDS_PER_DAY ? seconds : null;
}

/**
 * Sanitized `layout.calendar`, or undefined when the plant has no clock (M0: always undefined).
 * @param {unknown} raw whatever a file holds
 * @param {object} layout the layout built so far (stations already sanitized): a timetable on a station may create the calendar
 * @returns {object|undefined}
 */
export function sanitizeCalendar(raw, layout) {
  return undefined;
}

/**
 * The calendar that results from merging `patch` into `current`, sanitized; undefined when the plant then has no clock (M0: always
 * undefined). `patch === null` removes it.
 * @param {object|undefined} current
 * @param {unknown} patch
 * @returns {object|undefined}
 */
export function mergeCalendar(current, patch) {
  return undefined;
}
