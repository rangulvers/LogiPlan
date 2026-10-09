// The "day plant" rule of the warehouse module in one place (docs/WAREHOUSE-DESIGN.md 6.2.1, 6.2.7), shared by the runner (cold restart), the impact
// card (hidden), the simulation bar (clock chip), the plant settings (the clock) and the toast that explains the cold restart. Pure, no DOM.
//
// A DAY PLANT is a plant whose results depend on the time of day: today (milestone M1) a plant in which a Goods in or Goods out follows a truck
// timetable. Such a plant never restarts warm after an edit, because a pre-roll of 10 to 40 minutes ends at another time of day than the plant
// on screen: it restarts cold at the start time of its clock, and the card "Effect of your change", which compares short windows of a
// stationary plant, is not shown for it. A plant with trucks in rate mode has no daily rhythm: it is stationary and keeps warm restart and the
// impact card, even when a clock is left over from a timetable it no longer uses (`layout.calendar` persists once created, ARCHITECTURE 4.10).
// M2 widens the definition (a plant with shifts or demand curves is a day plant too): change `isDayPlant` and nothing else.

import { DAY_NAMES_LONG, formatTimeOfDay, makeClock, usesTimetable } from '../model/calendar.js';

/** Does a clock-driven timetable shape this plant? (The one definition; see the header.) */
export function isDayPlant(layout) {
  return Boolean(layout && layout.calendar) && usesTimetable(layout);
}

/** "06:00" for the start of the clock of a layout (00:00 without a clock). */
export function clockStart(layout) {
  return formatTimeOfDay(makeClock(layout && layout.calendar).startTod);
}

/** "06:00 on Monday": where the clock of the plant starts (the sentence of the plant settings). */
export function clockStartText(layout) {
  const clock = makeClock(layout && layout.calendar);
  return `${formatTimeOfDay(clock.startTod)} on ${DAY_NAMES_LONG[clock.startDay]}`;
}

/**
 * The chip of the simulation bar: the time of day of simulation time `t` ("Mon 06:42"), or null for a plant without a daily rhythm.
 * @returns {{ label: string, title: string }|null}
 */
export function clockChip(layout, t) {
  if (!isDayPlant(layout)) return null;
  const clock = makeClock(layout.calendar);
  const time = Number.isFinite(t) && t > 0 ? t : 0;
  return { label: clock.label(time), title: `Time of day in the plant. The simulation started at ${clockStartText(layout)}.` };
}

/** Copy 7 of 7.6: why the simulation starts again from the beginning of the day after an edit of a day plant. */
export function coldRestartText(layout) {
  return `This plant follows a daily timetable. After an edit the simulation starts again at ${clockStart(layout)} instead of continuing, so the figures always describe a whole day.`;
}

let coldToastShown = false;

/** True the first time it is asked in this page session (the cold-restart toast is said once), false afterwards. */
export function shouldShowColdRestartToast() {
  if (coldToastShown) return false;
  coldToastShown = true;
  return true;
}

/** Tests only: the toast is said once per session, so a test that checks it must be able to start a new session. */
export function resetColdRestartToast() {
  coldToastShown = false;
}
