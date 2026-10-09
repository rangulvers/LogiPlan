// The clock in the plant settings (Properties tab with nothing selected; docs/WAREHOUSE-DESIGN.md 7.2 "Plant settings"). A plant has a clock when a Goods in or
// Goods out follows a truck timetable (the first timetable creates it, model/calendar.js). The section appears only then:
//
//   Clock starts at [06:00] on [Monday]       the time of day at simulation time 0, the start of the warm-up (6.2.1); an edit restarts the simulation there
//   [Run one day] [Run one week]              set the run length of the plant (Simulate > Experiment length) to the span with no warm-up, start the simulation again
//                                             from the beginning of the clock and let it run exactly that span as fast as the computer can (runner.step), then pause:
//                                             the Results then describe whole days
//   Remove the clock                          only while no timetable needs it (a clock left over from a timetable that was switched back to rate mode)
//
// Pure helpers (no DOM) are exported and tested in tests/ui.ops-panels.test.js.

import { h } from '../../util/dom.js';
import { formatDuration } from '../../util/format.js';
import { icon } from '../icons.js';
import { updateCalendar, updateSettings } from '../../model/layout.js';
import { DAY_NAMES_LONG, SECONDS_PER_DAY, formatTimeOfDay, timeOfDay, usesTimetable } from '../../model/calendar.js';
import { isDayPlant } from '../day-plant.js';
import { addStyles } from '../ops-styles.js';
import { section } from './fields.js';

/** "Run one day": 24 hours. */
export const DAY_SECONDS = SECONDS_PER_DAY;
/** "Run one week": 7 days. */
export const WEEK_SECONDS = 7 * SECONDS_PER_DAY;
/** What one simulated day costs on a plant of the size of the examples (WAREHOUSE-DESIGN 4.2: 9 to 43 s), as the words of the buttons say it. */
export const DAY_COST_TEXT = 'roughly 10 to 40 seconds';

const CSS = `
.clock-line{display:flex;flex-wrap:wrap;align-items:center;gap:var(--sp-2)}
.clock-line .input{width:auto}
.clock-run{display:flex;flex-wrap:wrap;gap:var(--sp-2)}
`;

/** The settings patch of "Run one day" / "Run one week": the whole span, nothing discarded as warm-up. */
export function runPatch(seconds) {
  return { duration: seconds, warmup: 0 };
}

/** What a run of `seconds` costs, in words: "roughly 10 to 40 seconds" for a day, seven times that for a week. */
export function runCostText(seconds) {
  return seconds >= WEEK_SECONDS ? 'roughly 1 to 5 minutes' : DAY_COST_TEXT;
}

/** The text under the buttons (and in the toast): what a run of `seconds` does. */
export function runText(seconds) {
  const span = seconds === DAY_SECONDS ? 'one day' : seconds === WEEK_SECONDS ? 'one week' : formatDuration(seconds);
  return `Runs ${span} of the plant from the start of the clock, as fast as this computer can (${runCostText(seconds)} for a plant of this size), and then stops. Results cover the whole span.`;
}

/**
 * Press "Run one day" or "Run one week": one undo step "Run one day" that sets the run length of the plant, then the simulation starts again from the start of
 * the clock and runs exactly that span (runner.step) and pauses. The week asks first (its cost: seven days of simulation).
 * @param {object} ctx the shared ctx: store, runner, toast, dialogs.confirm
 * @param {number} seconds DAY_SECONDS or WEEK_SECONDS
 * @returns {Promise<boolean>} whether the run was started (the promise settles when the span has been simulated)
 */
export async function runSpan(ctx, seconds) {
  const name = seconds === DAY_SECONDS ? 'Run one day' : 'Run one week';
  if (seconds >= WEEK_SECONDS && ctx.dialogs && typeof ctx.dialogs.confirm === 'function') {
    const ok = await ctx.dialogs.confirm({
      title: 'Run one week?',
      text: `One week is seven days of simulated time, seven times as much as one day. ${runText(seconds)} You can pause at any time.`,
      confirmLabel: 'Run one week',
    });
    if (!ok) return false;
  }
  ctx.store.commit(name, (d) => { updateSettings(d, runPatch(seconds)); });
  ctx.toast?.(runText(seconds), { kind: 'info', ms: 6000 });
  if (ctx.runner) {
    ctx.runner.reset(); // a fresh simulation at the start of the clock (a no-op while there is none; step() then builds it)
    await ctx.runner.step(seconds);
  }
  return true;
}

/**
 * The section for the plant settings. `memory` is the form's Map of collapsed sections (inspector.js).
 * @returns {{ el: HTMLElement, update(layout: object): void }}
 */
export function createClockSection(ctx, memory) {
  addStyles('ops-clock-styles', CSS);
  const { store } = ctx;
  const title = 'Clock';
  const time = h('input', { class: 'input input--sm tnum', type: 'time', step: '60', id: 'plant-clock-time', 'data-role': 'clock-time', 'aria-label': 'Time of day at the start of the simulation' });
  const day = h('select', { class: 'input input--sm', id: 'plant-clock-day', 'data-role': 'clock-day', 'aria-label': 'Weekday at the start of the simulation' },
    DAY_NAMES_LONG.map((name, i) => h('option', { value: String(i) }, name)));
  const edit = (what, patch) => store.commit(`Change clock ${what}`, (d) => updateCalendar(d, patch), { coalesce: `plant:clock:${what}` });
  time.addEventListener('change', () => {
    const at = timeOfDay(time.value);
    if (at === null) { time.value = formatTimeOfDay(store.getState().layout.calendar?.startTod ?? 0); return; }
    edit('start time', { startTod: at });
  });
  day.addEventListener('change', () => { edit('start day', { startDay: Number(day.value) }); });

  const hint = h('p', { class: 'field__hint' }, 'The simulation starts at this time. After an edit it starts again here, so the figures always describe whole days.');
  const day1 = h('button', { class: 'btn btn--sm', type: 'button', 'data-role': 'run-day', onclick: () => { void runSpan(ctx, DAY_SECONDS); } }, icon('play', { size: 14 }), 'Run one day');
  const week = h('button', { class: 'btn btn--sm', type: 'button', 'data-role': 'run-week', onclick: () => { void runSpan(ctx, WEEK_SECONDS); } }, icon('play', { size: 14 }), 'Run one week');
  const runNote = h('p', { class: 'field__hint' }, `${runText(DAY_SECONDS)} The week takes seven times as long.`);
  const unused = h('p', { class: 'field__hint', hidden: true, 'data-role': 'clock-unused' }, 'No timetable uses this clock. ');
  const removeClock = h('button', {
    class: 'btn btn--sm btn--ghost', type: 'button', 'data-role': 'remove-clock',
    onclick: () => { store.commit('Remove the clock', (d) => { updateCalendar(d, null); }); },
  }, 'Remove the clock');
  unused.append(removeClock);

  const panel = section({ title, aside: '', open: memory.get(title) !== false },
    h('div', { class: 'clock-line', role: 'group', 'aria-label': 'Clock start' }, h('label', { class: 'field__label', for: 'plant-clock-time' }, 'Clock starts at'), time, h('label', { class: 'field__label', for: 'plant-clock-day' }, 'on'), day),
    hint,
    h('div', { class: 'clock-run' }, day1, week), runNote, unused);
  panel.el.dataset.role = 'clock-section';
  panel.el.addEventListener('toggle', () => memory.set(title, panel.el.open));
  panel.el.hidden = true;

  return {
    el: panel.el,
    update(layout) {
      const calendar = layout.calendar;
      panel.el.hidden = !calendar;
      if (!calendar) return;
      const t = formatTimeOfDay(calendar.startTod);
      if (document.activeElement !== time && time.value !== t) time.value = t;
      if (document.activeElement !== day && day.value !== String(calendar.startDay)) day.value = String(calendar.startDay);
      panel.setAside(`${t} ${DAY_NAMES_LONG[calendar.startDay].slice(0, 3)}`);
      unused.hidden = usesTimetable(layout);
      week.title = `Seven days of simulation, ${runCostText(WEEK_SECONDS)} for a plant of this size`;
      day1.title = `One day of simulation, ${runCostText(DAY_SECONDS)} for a plant of this size`;
      panel.el.dataset.dayPlant = String(isDayPlant(layout));
    },
  };
}
