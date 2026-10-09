// The clock of a plant: `layout.calendar` and, from M2, the shifts, breaks and demand profiles it holds (docs/WAREHOUSE-DESIGN.md 5.3, 6.2).
// Pure, no DOM, imports only ops.js (the shared clamping helpers) and util. Absent means today: no calendar, times are elapsed seconds.
//
// STATE OF THIS FILE (milestone M1): `layout.calendar = { startTod, startDay }`, the clock of a day plant.
//   sanitizeCalendar(raw, layout)   the sanitized block, or undefined when the plant has no clock. A clock EXISTS when the raw block is an
//                                   object (a file that has one keeps it) or when a station runs a truck timetable (`ops.trucks.mode ===
//                                   'schedule'`): the block is then created with startTod 0 and startDay 0 (5.3: a plant with a timetable
//                                   has a clock). Nothing removes a clock by itself; updateCalendar(layout, null) in layout.js does.
//   mergeCalendar(current, patch)   the block that results from a patch (`null` removes it)
//   makeClock(calendar)             { tod(t), day(t), label(t), ... }: the time of day for a simulation time t (6.2.1)
// M2 adds shifts, breaks and profiles plus `compileTimeline` and `tauInverse`. The sanitizers follow the rules in the header of ops.js.
//
// Everything that reads the schedule of a truck station (the expansion of a timetable into arrivals, the door check) is in doors.js.

import { SECONDS_PER_DAY, clampInt, timeOfDay } from './ops.js';

export { SECONDS_PER_DAY, timeOfDay };

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (obj, key) => (isObj(obj) && Object.hasOwn(obj, key) ? obj[key] : undefined);

/** Three-letter day names, Monday first (`startDay` 0 is Monday, 5.3). */
export const DAY_NAMES = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
/** The same in full, for the plant settings ("Clock starts at 06:00 on Monday"). */
export const DAY_NAMES_LONG = Object.freeze(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);

/**
 * Documented keys of `layout.calendar`, same shape as OPS_KEYS in ops.js (without `types`: the block belongs to the layout). The round
 * trip test of docs/WAREHOUSE-DESIGN.md 10.2 is driven from it.
 * @type {ReadonlyArray<{ key: string, schema: number, sample: unknown, cases?: ReadonlyArray<[unknown, unknown]> }>}
 */
export const CALENDAR_KEYS = Object.freeze([
  { key: 'startTod', schema: 2, sample: 21600, cases: [[-5, 0], [100000, 86399], ['06:30', 23400], ['7:05', 25500], ['30000', 30000], [21600.4, 21600], ['x', 0], [null, 0]] },
  { key: 'startDay', schema: 2, sample: 3, cases: [[-1, 0], [9, 6], ['2', 2], [1.6, 2], ['x', 0], [null, 0]] },
]);

/** Does a station of the layout run a truck timetable? Then the plant needs a clock. Reads `layout.stations[].ops.trucks.mode` only. */
export function usesTimetable(layout) {
  const stations = own(layout, 'stations');
  if (!Array.isArray(stations)) return false;
  return stations.some((s) => {
    const trucks = own(own(s, 'ops'), 'trucks');
    return isObj(trucks) && trucks.mode === 'schedule';
  });
}

/** startTod from a number, a numeric string or "H:MM" text: an integer 0..86399, junk gives 0, out of range is clamped. */
function readStartTod(v) {
  const parsed = typeof v === 'string' && v.includes(':') ? timeOfDay(v) : null;
  return parsed !== null ? parsed : clampInt(v, 0, SECONDS_PER_DAY - 1, 0);
}

/**
 * Sanitized `layout.calendar`, or undefined when the plant has no clock (see the header: a raw object keeps its clock, a timetable creates one).
 * @param {unknown} raw whatever a file holds
 * @param {object} layout the layout built so far (stations already sanitized): a timetable on a station creates the calendar
 * @returns {{ startTod: number, startDay: number }|undefined}
 */
export function sanitizeCalendar(raw, layout) {
  if (!isObj(raw) && !usesTimetable(layout)) return undefined;
  return { startTod: readStartTod(own(raw, 'startTod')), startDay: clampInt(own(raw, 'startDay'), 0, 6, 0) };
}

const NO_LAYOUT = Object.freeze({ stations: Object.freeze([]) });

/**
 * The calendar that results from merging `patch` into `current`, sanitized. `patch === null` removes it (undefined). An object patch
 * merges key by key and creates the clock when the plant had none; a patch that is not an object changes nothing. It does not know the
 * layout, so it cannot tell whether a timetable still needs the clock: updateCalendar (layout.js) lets reconcileLayout decide that.
 * @param {object|undefined} current
 * @param {unknown} patch
 * @returns {{ startTod: number, startDay: number }|undefined}
 */
export function mergeCalendar(current, patch) {
  if (patch === null) return undefined;
  const base = isObj(current) ? current : undefined;
  if (!isObj(patch)) return base === undefined ? undefined : sanitizeCalendar(base, NO_LAYOUT);
  return sanitizeCalendar({ ...(base ?? {}), ...patch }, NO_LAYOUT);
}

const pad2 = (n) => String(n).padStart(2, '0');
const mod = (x, n) => ((x % n) + n) % n;

/**
 * "06:00" for a time of day in seconds (rounded down to the minute; 0 .. 86399 gives 00:00 .. 23:59, anything else is wrapped into the day).
 * @param {number} seconds
 * @returns {string}
 */
export function formatTimeOfDay(seconds) {
  const s = Math.floor(mod(Number.isFinite(seconds) ? seconds : 0, SECONDS_PER_DAY));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}`;
}

/**
 * The clock of a day plant (6.2.1). With `c(t) = startTod + t` (t = simulation time, 0 = the start of the warm-up):
 *   tod(t)       seconds after midnight, 0 <= tod < 86400
 *   day(t)       weekday 0..6, 0 = Monday: (startDay + floor(c / 86400)) mod 7
 *   dayIndex(t)  the number of the clock day, floor(c / 86400): 0 is the day the run starts on
 *   dayStart(k)  the simulation time at which clock day k begins: k * 86400 - startTod (negative for k = 0 unless startTod is 0)
 *   label(t)     "Mon 06:42" (the minute is rounded down)
 * A calendar that is not an object, or has junk fields, gives the clock of startTod 0, startDay 0. Pure; the object is frozen.
 * @param {{ startTod?: number, startDay?: number }|null|undefined} calendar `layout.calendar`
 */
export function makeClock(calendar) {
  const startTod = readStartTod(own(calendar, 'startTod'));
  const startDay = clampInt(own(calendar, 'startDay'), 0, 6, 0);
  const dayIndex = (t) => Math.floor((startTod + t) / SECONDS_PER_DAY);
  const day = (t) => mod(startDay + dayIndex(t), 7);
  const tod = (t) => mod(startTod + t, SECONDS_PER_DAY);
  return Object.freeze({
    startTod,
    startDay,
    tod,
    day,
    dayIndex,
    dayStart: (k) => k * SECONDS_PER_DAY - startTod,
    label: (t) => `${DAY_NAMES[day(t)]} ${formatTimeOfDay(tod(t))}`,
  });
}
