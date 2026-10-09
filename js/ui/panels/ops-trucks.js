// "Trucks and doors" in the Properties tab of a Goods in and a Goods out (docs/WAREHOUSE-DESIGN.md 7.2, 7.6, 7.7).
//
//   const sections = trucksSections(ctx, env);     // env = the station form's environment (inspector.js stationView); [] for other station types
//
// A station without trucks shows a quiet block with one button, "Add dock doors" (guidance-ops.js addDockDoors: the conversion of 6.3.1 in one undo
// step, a toast with the numbers). With trucks it shows the controls: doors, check-in and check-out in minutes, the switch between "Generate from
// rate" and "Use a timetable", the time between trucks and the pallets per truck (the same distribution control as the other panels, here in minutes
// and pallets), the timetable table with its paste dialog, the variation of a timetable, on a Goods out the staging and the longest wait, the live
// DOOR CHECK (Little's law, with its arithmetic and a button "Use N doors") and the link "Remove trucks". Every edit is one store.commit with a
// readable label, so Undo works; typing and stepping coalesce. The form is built once; update() only refreshes values and never touches a field that
// has focus (the golden rule of fields.js). The sim may not produce numbers yet: every reading of `report.ops` tolerates its absence.
//
// What the legacy fields of the Goods in do while trucks are on (ARCHITECTURE 4.10): "Time between arrivals" and "Loads per arrival" are ignored
// (they stay in `params` so that "Remove trucks" goes back), so they are hidden and a note says where the arrivals come from; the output buffer
// field is relabelled "Staging space (pallets) per destination". inspector.js marks those elements with data-role, this file finds them by it.
//
// Pure helpers (no DOM) are exported and tested in tests/ui.ops-trucks.test.js.

import { h } from '../../util/dom.js';
import { formatNumber, round } from '../../util/format.js';
import { icon } from '../icons.js';
import { getStation, updateCalendar, updateStation } from '../../model/layout.js';
import { TRUCK_RANGES, TRUCK_TYPES, MAX_SCHEDULE_ROWS, defaultTrucks, timeOfDay, trucksOf } from '../../model/ops.js';
import { doorCheck, peakRowsPerHour, describeTrucks } from '../../model/doors.js';
import { formatTimeOfDay, usesTimetable } from '../../model/calendar.js';
import { FIX_ROW_AT } from '../../model/validate-ops.js';
import { addDockDoors } from '../guidance-ops.js';
import { coldRestartText, shouldShowColdRestartToast } from '../day-plant.js';
import { addStyles } from '../ops-styles.js';
import { createReading, describeDoors, readDoors } from '../render/ops.js';
import { numberField, selectField, stepperField, segmentedField, section, humanSeconds } from './fields.js';
import { openTimetableDialog } from './timetable-dialog.js';

export const SECTION_TITLE = 'Trucks and doors';
const INLINE_W = '120px';
const quoted = (name) => `“${name}”`;
const isObj = (v) => v !== null && typeof v === 'object';
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// ---------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------

/** Seconds as the minutes a field shows ("300" -> 5, 150 -> 2.5). */
export const toMinutes = (seconds) => round(seconds / 60, 4);
/** Minutes typed in a field as the whole seconds the model stores. */
export const toSeconds = (minutes) => Math.round(minutes * 60);

/** The aside of the section header: "2 doors", "timetable, 4 doors". */
export function sectionAside(trucks) {
  if (!trucks) return 'off';
  const doors = `${trucks.doors} ${trucks.doors === 1 ? 'door' : 'doors'}`;
  return trucks.mode === 'schedule' ? `timetable · ${doors}` : doors;
}

/** The row "Add a row" appends: one hour after the last one (at 06:00 when the table is empty), with the pallets of an average truck. */
export function nextRow(schedule, trucks) {
  const last = schedule.length ? schedule[schedule.length - 1].at : null;
  const at = last === null ? FIX_ROW_AT : Math.min(86340, last + 3600);
  const mean = trucks && trucks.pallets && finite(trucks.pallets.mean) ? trucks.pallets.mean : 24;
  return { at, pallets: Math.max(1, Math.min(TRUCK_RANGES.rowPallets[1], Math.round(mean))) };
}

/** The schedule with row `index` changed by `patch` ({ at?, pallets? }); a new array of new row objects (the model sorts it). */
export function scheduleWith(schedule, index, patch) {
  return schedule.map((row, i) => (i === index ? { ...row, ...patch } : { ...row }));
}

/** The schedule without row `index`. */
export function scheduleWithout(schedule, index) {
  return schedule.filter((_, i) => i !== index).map((row) => ({ ...row }));
}

/** "12 trucks a day, 288 pallets, at most 3 in any hour": what a timetable amounts to. null for an empty one. */
export function timetableSummary(trucks, demandFactor = 1) {
  const rows = Array.isArray(trucks && trucks.schedule) ? trucks.schedule : [];
  if (rows.length === 0) return null;
  const d = describeTrucks(trucks, { demandFactor });
  const peak = peakRowsPerHour(rows);
  const pallets = Math.round(d.palletsPerTruck * rows.length);
  return `${formatNumber(rows.length)} ${rows.length === 1 ? 'truck' : 'trucks'} a day, ${formatNumber(pallets)} ${pallets === 1 ? 'pallet' : 'pallets'}, at most ${formatNumber(peak)} in any hour`;
}

/** "About 1.3 trucks an hour of 24 pallets: 32 pallets an hour." for rate mode (the average over the day); the timetable has its own summary. */
export function rateSummary(trucks, demandFactor = 1) {
  const d = describeTrucks(trucks, { demandFactor });
  if (d.mode !== 'rate' || !(d.trucksPerHour > 0)) return d.mode === 'rate' ? 'No truck arrives at this demand.' : '';
  return `About ${formatNumber(d.trucksPerHour, 1)} ${d.trucksPerHour === 1 ? 'truck' : 'trucks'} an hour of ${formatNumber(d.palletsPerTruck, 1)} pallets: ${formatNumber(d.palletsPerHour, 1)} pallets an hour.`;
}

/**
 * The mean time a truck held a door in the last run (s), or null: `report.ops.trucks[stationId].doorTime.mean` (WAREHOUSE-DESIGN 6.8). The door check
 * uses it instead of its assumed 90 s per pallet once a run has measured it. Tolerates a report without `ops`.
 */
export function measuredDoorSeconds(report, stationId) {
  const entry = report && report.ops && report.ops.trucks ? report.ops.trucks[stationId] : null;
  const mean = entry && entry.doorTime ? entry.doorTime.mean : null;
  const served = entry && entry.trucks ? entry.trucks.departed : null;
  return finite(mean) && mean > 0 && (served === null || served === undefined || served > 0) ? mean : null;
}

/** The door check of a station with trucks, as doors.js computes it, with the plan's demand slider and, after a run, the measured door time. */
export function doorCheckFor(layout, station, report = null) {
  const trucks = trucksOf(station);
  if (!trucks) return null;
  return doorCheck(trucks, { demandFactor: layout.settings && layout.settings.demandFactor, measuredDoorSeconds: measuredDoorSeconds(report, station.id) });
}

/** The arithmetic of the door check in one line (principle 3 of 7.1: show the formula): "6 trucks an hour × 49 min at a door = 4.9 doors busy at once". */
export function doorFormula(check) {
  if (!check || check.empty) return '';
  const p = check.parts;
  const door = check.basis === 'measured'
    ? `${p.minutes} min at a door (measured)`
    : `${p.minutes} min at a door (${Math.round(check.checkIn / 60)} min + ${p.pallets} pallets × ${p.tPallet} s + ${Math.round(check.checkOut / 60)} min)`;
  return `${p.trucks} ${Number(check.trucksPerHour) === 1 ? 'truck' : 'trucks'} an hour × ${door} = ${p.need} doors busy at once`;
}

/**
 * Goods out only: what the plant delivered to it per hour in the last run, set against what its trucks can take (WAREHOUSE-DESIGN 6.3.1: "so that
 * shipping is not silently the limit"). '' without a report or when nothing arrived.
 */
export function shippedLine(report, station, trucks, demandFactor = 1) {
  const sink = report && report.throughput && report.throughput.bySink ? report.throughput.bySink[station.id] : null;
  if (!sink || !finite(sink.perHour) || sink.perHour <= 0 || !trucks) return '';
  const d = describeTrucks(trucks, { demandFactor });
  const can = d.palletsPerHour > 0 ? ` The trucks here take up to ${formatNumber(d.palletsPerHour, 0)} an hour.` : '';
  return `In the last run ${formatNumber(sink.perHour, 1)} pallets an hour reached this Goods out.${can}`;
}

// ---------------------------------------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------------------------------------

const CSS = `
.trucks-off{display:flex;flex-direction:column;gap:6px;padding:10px var(--sp-3) var(--sp-3);border-top:1px solid var(--border)}
.trucks-off__head{display:flex;align-items:center;gap:var(--sp-2);min-height:26px}
.trucks-off__title{font-size:var(--fs-sm);font-weight:var(--fw-semibold)}
.trucks-off .field__hint{margin:0}
.trucks-sub{display:flex;flex-direction:column;gap:var(--sp-2);padding-top:var(--sp-2);border-top:1px dashed var(--border)}
.trucks-sub__title{display:flex;align-items:center;gap:var(--sp-2);flex-wrap:wrap}
.trucks-table{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:var(--radius-md);overflow:hidden}
.trucks-table__scroll{max-height:264px;overflow-y:auto}
.trucks-row{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr) 28px;align-items:center;gap:var(--sp-2);padding:4px var(--sp-2)}
.trucks-row+.trucks-row{border-top:1px solid var(--border)}
.trucks-row--head{position:sticky;top:0;z-index:1;background:var(--surface-2);border-bottom:1px solid var(--border);color:var(--text-dim);font-size:var(--fs-xs);font-weight:var(--fw-semibold)}
.trucks-row .input{width:100%;min-width:0}
.trucks-table__empty{margin:0;padding:var(--sp-3);color:var(--text-dim);font-size:var(--fs-sm)}
.trucks-actions{display:flex;flex-wrap:wrap;gap:var(--sp-2)}
.doorcheck{display:flex;flex-direction:column;gap:6px;padding:var(--sp-2) var(--sp-3);border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface-2)}
.doorcheck.is-warn{border-color:var(--warn);background:var(--warn-soft)}
.doorcheck__head{display:flex;align-items:center;gap:var(--sp-2);flex-wrap:wrap}
.doorcheck__text{margin:0;font-size:var(--fs-sm);line-height:1.45;color:var(--text)}
.doorcheck__formula{margin:0;font-size:var(--fs-xs);color:var(--text-dim);font-variant-numeric:tabular-nums}
.doorcheck__actions{display:flex;flex-wrap:wrap;gap:var(--sp-2)}
.trucks-link{align-self:flex-start;padding:2px 0;border:0;background:none;color:var(--accent-text);font:inherit;font-size:var(--fs-sm);text-decoration:underline;cursor:pointer}
.trucks-link:hover{color:var(--accent-hover)}
.trucks-link:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}
`;

// ---------------------------------------------------------------------------------------------------------
// A time distribution in the unit of its field
// ---------------------------------------------------------------------------------------------------------

const KIND_OPTIONS = Object.freeze([
  { value: 'const', label: 'Constant' },
  { value: 'normal', label: 'Normal (bell curve)' },
  { value: 'uniform', label: 'Uniform (min–max)' },
  { value: 'exp', label: 'Exponential (random arrivals)' },
]);

/**
 * The distribution control of the other panels (kind, average, spread), for a quantity that is not in seconds: `scale` converts the shown unit into
 * the stored one (60: minutes shown, seconds stored; 1: pallets). `onChange(dist)` gets a complete { kind, mean, spread } in stored units, only for
 * valid input. opts: { label, hint, unit, scale, min, max (in the shown unit), value, describe(dist) -> string, onChange }.
 */
function truckDistField(opts) {
  const { label, unit, scale, min, max, describe, onChange } = opts;
  let dist = { kind: 'normal', mean: min * scale, spread: 0, ...(opts.value || {}) };
  const emit = () => onChange({ ...dist });
  const shown = (mean) => round(mean / scale, 4);
  const kind = selectField({
    label: 'Variation', options: KIND_OPTIONS, value: dist.kind,
    onChange: (k) => { dist = { ...dist, kind: k, spread: k === 'normal' || k === 'uniform' ? (dist.spread || 0.1) : 0 }; refresh(); emit(); },
  });
  const mean = numberField({ label: 'Average', unit, min, max, value: shown(dist.mean), onChange: (v) => { dist = { ...dist, mean: v * scale }; refresh(); emit(); } });
  const spread = numberField({ label: 'Spread', unit: '%', min: 0, max: 100, value: Math.round(dist.spread * 100), onChange: (v) => { dist = { ...dist, spread: v / 100 }; emit(); } });
  const hint = h('p', { class: 'field__hint' });
  const el = h('div', { class: 'stack', style: { '--gap': '8px' } }, h('span', { class: 'field__label' }, label), kind.el, h('div', { class: 'field-grid' }, mean.el, spread.el), hint);
  function refresh() {
    spread.el.hidden = !(dist.kind === 'normal' || dist.kind === 'uniform');
    const text = describe ? describe(dist) : '';
    hint.textContent = [opts.hint, text].filter(Boolean).join(' · ');
  }
  refresh();
  return {
    el,
    set(v) {
      if (!isObj(v)) return;
      dist = { kind: v.kind || 'const', mean: finite(v.mean) ? v.mean : dist.mean, spread: finite(v.spread) ? v.spread : 0 };
      kind.set(dist.kind);
      mean.set(shown(dist.mean));
      spread.set(Math.round(dist.spread * 100));
      refresh();
    },
    get: () => ({ ...dist }),
  };
}

// ---------------------------------------------------------------------------------------------------------
// The timetable table
// ---------------------------------------------------------------------------------------------------------

/**
 * The table of arrivals: a time and a number of pallets per row (an empty number: drawn from the pallets-per-truck distribution), add and delete,
 * paste from a spreadsheet. Edits go to `edit(schedule)` as a complete list; the model sorts it. `sync(schedule)` shows the stored rows.
 */
function createTimetable({ edit, openPaste, maxRows = MAX_SCHEDULE_ROWS }) {
  let rows = []; // { row, time, pallets, del } per displayed line
  let schedule = [];
  let pendingFocus = null; // { at, col } | { index, col } after an edit that re-sorts or removes rows
  const scroll = h('div', { class: 'trucks-table__scroll' });
  const empty = h('p', { class: 'trucks-table__empty' }, 'No rows yet. Add a row, or paste a timetable from your spreadsheet.');
  const head = h('div', { class: 'trucks-row trucks-row--head', 'aria-hidden': 'true' }, h('span', null, 'Arrival'), h('span', null, 'Pallets'), h('span'));
  const table = h('div', { class: 'trucks-table', role: 'group', 'aria-label': 'Truck timetable', 'data-role': 'timetable' }, head, scroll, empty);
  const add = h('button', { class: 'btn btn--sm', type: 'button', 'data-role': 'add-row', onclick: () => { pendingFocus = { index: schedule.length, col: 'time' }; edit([...schedule.map((r) => ({ ...r })), nextRow(schedule, currentTrucks())]); } },
    icon('plus', { size: 14 }), 'Add a row');
  const paste = h('button', { class: 'btn btn--sm', type: 'button', 'data-role': 'paste', onclick: () => openPaste() }, icon('import', { size: 14 }), 'Paste from spreadsheet');
  const clear = h('button', { class: 'btn btn--sm btn--ghost', type: 'button', 'data-role': 'clear-rows', onclick: () => edit([]) }, icon('trash', { size: 14 }), 'Remove all rows');
  const full = h('p', { class: 'field__hint', hidden: true }, `A timetable holds at most ${MAX_SCHEDULE_ROWS} rows.`);
  const summary = h('p', { class: 'field__hint', 'data-role': 'timetable-summary', 'aria-live': 'polite' });
  let trucksNow = null;
  const currentTrucks = () => trucksNow;

  function makeRow(index) {
    const time = h('input', { class: 'input input--sm tnum', type: 'time', step: '60', required: true });
    const pallets = h('input', { class: 'input input--sm tnum', type: 'number', min: TRUCK_RANGES.rowPallets[0], max: TRUCK_RANGES.rowPallets[1], step: '1', inputmode: 'numeric', placeholder: 'drawn' });
    const del = h('button', { class: 'btn btn--icon btn--sm btn--ghost', type: 'button', 'data-role': 'delete-row' }, icon('trash', { size: 14 }));
    const line = { row: h('div', { class: 'trucks-row', 'data-row': String(index) }, time, pallets, del), time, pallets, del, index };
    time.addEventListener('change', () => {
      const at = timeOfDay(time.value);
      if (at === null || !schedule[line.index]) { time.value = formatTimeOfDay(schedule[line.index]?.at ?? 0); return; }
      if (at === schedule[line.index].at) return;
      pendingFocus = { at, col: 'time' };
      edit(scheduleWith(schedule, line.index, { at }));
    });
    pallets.addEventListener('change', () => {
      const raw = pallets.value.trim();
      const row = schedule[line.index];
      if (!row) return;
      const n = raw === '' ? null : Math.round(Number(raw));
      if (n !== null && !(n >= TRUCK_RANGES.rowPallets[0] && n <= TRUCK_RANGES.rowPallets[1])) { pallets.value = row.pallets === null ? '' : String(row.pallets); return; }
      if (n !== row.pallets) edit(scheduleWith(schedule, line.index, { pallets: n }));
    });
    del.addEventListener('click', () => { pendingFocus = { index: line.index, col: 'delete' }; edit(scheduleWithout(schedule, line.index)); });
    return line;
  }

  const focused = (el) => typeof document !== 'undefined' && document.activeElement === el;

  function paintRow(line, row, index) {
    line.index = index;
    const label = `row ${index + 1}`;
    line.row.dataset.row = String(index);
    const t = formatTimeOfDay(row.at);
    if (!focused(line.time) && line.time.value !== t) line.time.value = t;
    const p = row.pallets === null ? '' : String(row.pallets);
    if (!focused(line.pallets) && line.pallets.value !== p) line.pallets.value = p;
    line.time.setAttribute('aria-label', `Arrival time, ${label}`);
    line.pallets.setAttribute('aria-label', `Pallets, ${label} (empty: drawn from the pallets per truck)`);
    line.del.setAttribute('aria-label', `Delete ${label}: ${t}`);
    line.del.title = `Delete ${label}`;
  }

  function applyFocus() {
    if (!pendingFocus) return;
    const want = pendingFocus;
    pendingFocus = null;
    let line = null;
    if (want.at !== undefined) line = rows.find((r) => schedule[r.index] && schedule[r.index].at === want.at);
    else line = rows[Math.min(want.index, rows.length - 1)];
    if (!line) { add.focus(); return; }
    (want.col === 'delete' ? line.del : line.time).focus();
  }

  return {
    el: h('div', { class: 'stack', style: { '--gap': '8px' } }, table, h('div', { class: 'trucks-actions' }, add, paste, clear), full, summary),
    sync(next, trucks, demandFactor) {
      trucksNow = trucks;
      schedule = next;
      while (rows.length > next.length) rows.pop().row.remove();
      while (rows.length < next.length) {
        const line = makeRow(rows.length);
        rows.push(line);
        scroll.append(line.row);
      }
      next.forEach((row, i) => paintRow(rows[i], row, i));
      empty.hidden = next.length > 0;
      head.hidden = next.length === 0;
      scroll.hidden = next.length === 0;
      clear.hidden = next.length === 0;
      add.disabled = next.length >= maxRows;
      full.hidden = next.length < maxRows;
      summary.textContent = timetableSummary(trucks, demandFactor) || '';
      summary.hidden = next.length === 0;
      applyFocus();
    },
  };
}

// ---------------------------------------------------------------------------------------------------------
// The section
// ---------------------------------------------------------------------------------------------------------

const STAGING_LABEL = 'Staging space (pallets) per destination';
const STAGING_HINT = 'Pallets of a truck that can wait for a vehicle, for each destination. When it is full the truck keeps its door and waits.';

/** The hint under the switch for each mode. */
const MODE_HINT = {
  rate: 'Trucks come at random intervals around the average you set.',
  schedule: 'Trucks come at the times of your timetable, every day. The plant then has a clock.',
};

/**
 * The "Trucks and doors" part of the station form of a Goods in or Goods out.
 * @param {object} ctx the shared ctx: store, runner, toast, dialogs, actions
 * @param {{ initial: object, id: string, memory: Map, syncs: Array<Function> }} env the environment of inspector.js stationView
 * @returns {HTMLElement[]} the element to put into the form ([] for a station type that cannot have trucks); update goes through env.syncs
 */
export function trucksSections(ctx, env) {
  const { initial, id, memory, syncs } = env;
  if (!TRUCK_TYPES.includes(initial.type)) return [];
  addStyles('ops-trucks-styles', CSS);
  const { store } = ctx;
  const outbound = initial.type === 'sink';
  const current = () => getStation(store.getState().layout, id);
  const label = (what) => `Change ${what} of ${quoted(current().name)}`;
  const edit = (what, trucks, key = what) => store.commit(label(what), (d) => updateStation(d, id, { ops: { trucks } }), { coalesce: `trucks:${id}:${key}` });
  const seed = trucksOf(initial) || null;
  const shownTrucks = seed || defaultTrucks(); // the values the controls start with; update() sets the real ones before they are seen

  // ---- off: one button
  const addButton = h('button', {
    class: 'btn btn--sm', type: 'button', 'data-role': 'add-doors', title: 'Let trucks bring (or collect) the pallets at doors, and see how many doors you need',
    onclick: () => { addDockDoors(ctx, id); },
  }, icon('truck', { size: 14 }), 'Add dock doors');
  const offHint = h('p', { class: 'field__hint' }, outbound
    ? 'Trucks collect the pallets at doors. See how many doors you need and whether the doors or the forklifts limit the shipping.'
    : 'Trucks bring the pallets to doors, in bunches. See how many doors you need and whether the doors or the forklifts limit the unloading.');
  const helpLink = () => h('button', { class: 'trucks-link', type: 'button', 'data-role': 'trucks-help', onclick: () => ctx.dialogs?.openHelp?.({ tab: 'trucks' }) }, 'How trucks and dock doors work');
  const off = h('div', { class: 'trucks-off', 'data-role': 'trucks-off' },
    h('div', { class: 'trucks-off__head' }, h('span', { class: 'trucks-off__title' }, SECTION_TITLE), h('span', { class: 'spacer' }), addButton), offHint, helpLink());

  // ---- on: the controls. Built the first time the station has trucks: a station without trucks carries no hidden copies of the fields in the form.
  function buildControls(shownTrucks) {
    const doors = stepperField({ label: 'Doors', min: TRUCK_RANGES.doors[0], max: TRUCK_RANGES.doors[1], value: shownTrucks.doors, controlW: INLINE_W, onChange: (n) => edit('doors', { doors: n }) });
    doors.input.dataset.role = 'doors';
    const minutesField = (key, text, hint) => numberField({
      label: text, unit: 'min', inline: true, controlW: INLINE_W, min: 0, max: TRUCK_RANGES[key][1] / 60, value: toMinutes(shownTrucks[key]), hint,
      onChange: (v) => edit(text.toLowerCase(), { [key]: toSeconds(v) }, key),
    });
    const checkIn = minutesField('checkIn', 'Check-in', 'Paperwork at the door before the first pallet is released.');
    const checkOut = minutesField('checkOut', 'Check-out', 'Paperwork after the last pallet, then the door is free.');
    const mode = segmentedField({
      label: 'Trucks', value: shownTrucks.mode,
      options: [{ value: 'rate', label: 'Generate from rate' }, { value: 'schedule', label: 'Use a timetable' }],
      onChange: (m) => setMode(m),
    });
    mode.el.dataset.role = 'mode';
    const modeHint = h('p', { class: 'field__hint' }, MODE_HINT[shownTrucks.mode]);
    mode.el.append(modeHint);

    const gap = truckDistField({
      label: 'Time between trucks', unit: 'min', scale: 60, min: TRUCK_RANGES.interArrivalMean[0] / 60, max: TRUCK_RANGES.interArrivalMean[1] / 60, value: shownTrucks.interArrival,
      hint: 'How long until the next truck arrives.', describe: (d) => `Average ${humanSeconds(d.mean)}`,
      onChange: (dist) => edit('time between trucks', { interArrival: dist }, 'interArrival'),
    });
    const pallets = truckDistField({
      label: 'Pallets per truck', unit: 'pallets', scale: 1, min: TRUCK_RANGES.palletsMean[0], max: TRUCK_RANGES.palletsMean[1], value: shownTrucks.pallets,
      hint: '', describe: (d) => `Average ${round(d.mean, 1)} pallets`,
      onChange: (dist) => edit('pallets per truck', { pallets: dist }, 'pallets'),
    });
    const palletsNote = h('p', { class: 'field__hint', hidden: true }, 'Used for timetable rows without a number of pallets.');
    const rateLine = h('p', { class: 'field__hint', 'data-role': 'rate-summary', 'aria-live': 'polite' });

    const timetable = createTimetable({
      edit: (schedule) => edit('truck timetable', { schedule }, 'schedule'),
      openPaste: () => openTimetableDialog(ctx, { stationId: id }),
    });
    const jitter = numberField({
      label: 'Trucks arrive up to', unit: 'min early or late', inline: true, controlW: '160px', min: 0, max: TRUCK_RANGES.jitter[1] / 60, value: toMinutes(shownTrucks.jitter),
      hint: 'Each truck comes at its time plus or minus a random amount up to this.', onChange: (v) => edit('arrival variation', { jitter: toSeconds(v) }, 'jitter'),
    });
    const noShow = numberField({
      label: 'No-shows', unit: '%', inline: true, controlW: INLINE_W, min: 0, max: TRUCK_RANGES.noShow[1] * 100, value: round(shownTrucks.noShow * 100, 2),
      hint: 'Share of the timetable trucks that do not come at all.', onChange: (v) => edit('no-shows', { noShow: round(v / 100, 4) }, 'noShow'),
    });
    const scheduleOnly = [timetable.el, jitter.el, noShow.el];

    const staging = numberField({
      label: 'Staging per door', unit: 'pallets', inline: true, controlW: INLINE_W, int: true, step: 1, min: TRUCK_RANGES.staging[0], max: TRUCK_RANGES.staging[1], value: shownTrucks.staging,
      hint: 'Pallets that may wait next to each door for a truck. 0 = fetch a pallet only while a truck is ready to take it.', onChange: (v) => edit('staging', { staging: v }, 'staging'),
    });
    const maxDwell = numberField({
      label: 'A truck waits at most', unit: 'min', inline: true, controlW: INLINE_W, min: 0, max: TRUCK_RANGES.maxDwell[1] / 60, value: toMinutes(shownTrucks.maxDwell),
      hint: 'for its pallets, then it leaves with what it has. 0 = until it is full.', onChange: (v) => edit('longest wait of a truck', { maxDwell: toSeconds(v) }, 'maxDwell'),
    });
    const shipped = h('p', { class: 'field__hint', hidden: true, 'data-role': 'shipped' });
    const outOnly = [staging.el, maxDwell.el, shipped];

    // ---- the doors now (the words of the picture on the plan)
    const doorsNow = h('p', { class: 'field__hint', 'data-role': 'doors-now', hidden: true });
    const reading = createReading();

    // ---- the door check
    const checkTitle = h('div', { class: 'doorcheck__head' }, h('span', { class: 'eyebrow' }, 'Door check'), h('span', { class: 'chip chip--outline', title: 'A rule of thumb from typical values. Change the numbers above to your own; Results shows the measured figures after a run.' }, 'Indicative'));
    const checkText = h('p', { class: 'doorcheck__text', 'data-role': 'door-check-text' });
    const checkFormula = h('p', { class: 'doorcheck__formula', 'data-role': 'door-check-formula' });
    const useDoors = h('button', { class: 'btn btn--sm btn--primary', type: 'button', 'data-role': 'use-doors', hidden: true }, 'Use doors');
    let useDoorsCount = 0;
    useDoors.addEventListener('click', () => {
      if (!useDoorsCount) return;
      const n = useDoorsCount;
      store.commit('Set dock doors', (d) => { if (!updateStation(d, id, { ops: { trucks: { doors: n } } })) return false; });
    });
    const checkBox = h('div', { class: 'doorcheck', 'data-role': 'door-check', role: 'group', 'aria-label': 'Door check' }, checkTitle, checkText, checkFormula, h('div', { class: 'doorcheck__actions' }, useDoors));

    const remove = h('button', {
      class: 'trucks-link', type: 'button', 'data-role': 'remove-trucks', title: 'Back to the plain arrivals of this station. Nothing you set before is lost.',
      onclick: () => { store.commit('Remove dock doors', (d) => { updateStation(d, id, { ops: { trucks: null } }); tidyClock(d); }); },
    }, 'Remove trucks');
    const removeNote = h('p', { class: 'field__hint' }, outbound ? 'Removing the trucks goes back to a Goods out that takes every pallet at once.' : 'Removing the trucks goes back to the plain arrivals of the Deliveries section.');

    const panel = section({ title: SECTION_TITLE, aside: sectionAside(shownTrucks), open: memory.get(SECTION_TITLE) !== false },
      doors.el, checkIn.el, checkOut.el, mode.el,
      gap.el, pallets.el, palletsNote, rateLine,
      ...scheduleOnly, ...(outbound ? outOnly : []),
      doorsNow, checkBox, removeNote, h('div', { class: 'row row--wrap', style: { '--gap': '16px' } }, remove, helpLink()));
    panel.el.dataset.role = 'trucks-on';
    panel.el.addEventListener('toggle', () => memory.set(SECTION_TITLE, panel.el.open));


    let lastCheck = '';

    /** Show the stored values (never in a field that has focus) and the live readings. */
    function update(st, state, trucks) {
        panel.setAside(sectionAside(trucks));
        const schedule = trucks.mode === 'schedule';
        doors.set(trucks.doors);
        checkIn.set(toMinutes(trucks.checkIn));
        checkOut.set(toMinutes(trucks.checkOut));
        mode.set(trucks.mode);
        modeHint.textContent = MODE_HINT[trucks.mode];
        gap.el.hidden = schedule;
        rateLine.hidden = schedule;
        gap.set(trucks.interArrival);
        pallets.set(trucks.pallets);
        palletsNote.hidden = !schedule;
        const demand = state.layout.settings && state.layout.settings.demandFactor;
        rateLine.textContent = rateSummary(trucks, demand);
        for (const el of scheduleOnly) el.hidden = !schedule;
        if (schedule) {
          timetable.sync(trucks.schedule, trucks, demand);
          jitter.set(toMinutes(trucks.jitter));
          noShow.set(round(trucks.noShow * 100, 2));
        }
        const report = ctx.runner && typeof ctx.runner.kpis === 'function' ? ctx.runner.kpis() : null;
        if (outbound) {
          staging.set(trucks.staging);
          maxDwell.set(toMinutes(trucks.maxDwell));
          const line = shippedLine(report, st, trucks, demand);
          shipped.hidden = !line;
          shipped.textContent = line;
        }
        const rt = ctx.runner?.sim?.logistics?.stationById?.get(id) || null;
        if (rt && rt.trucks) {
          const sim = ctx.runner.sim;
          const text = describeDoors(readDoors(rt, trucks, Number.isFinite(sim.time) ? sim.time : 0, outbound, reading), outbound);
          if (doorsNow.textContent !== `Doors now: ${text}`) doorsNow.textContent = `Doors now: ${text}`;
          doorsNow.hidden = false;
        } else doorsNow.hidden = true;
        const check = doorCheckFor(state.layout, st, report);
        const signature = JSON.stringify([check.text, check.action && check.action.doors, check.tooFew, check.basis]);
        if (signature !== lastCheck) {
          lastCheck = signature;
          checkText.textContent = check.text;
          checkFormula.textContent = doorFormula(check);
          checkFormula.hidden = !checkFormula.textContent;
          checkBox.classList.toggle('is-warn', check.tooFew);
          useDoorsCount = check.action ? check.action.doors : 0;
          useDoors.hidden = !check.action;
          useDoors.textContent = check.action ? check.action.label : 'Use doors';
          useDoors.setAttribute('aria-label', check.action ? `${check.action.label} for ${current().name}` : 'Use more doors');
        }
    }
    return { el: panel.el, panel, update };
  }

  const root = h('div', { 'data-role': 'trucks-section', 'data-station': id }, off);
  let controls = null;
  let wasOn = Boolean(seed);

  /** A clock that is still at its default start and no timetable needs any more goes with the last timetable (the plant is stationary again). */
  function tidyClock(draft) {
    const c = draft.calendar;
    if (c && !usesTimetable(draft) && c.startTod === 0 && c.startDay === 0) updateCalendar(draft, null);
  }

  function setMode(next) {
    const before = store.getState().layout;
    const label2 = next === 'schedule' ? `Use a timetable for ${quoted(current().name)}` : `Generate trucks from a rate for ${quoted(current().name)}`;
    if (!store.commit(label2, (d) => { updateStation(d, id, { ops: { trucks: { mode: next } } }); if (next === 'rate') tidyClock(d); })) return;
    if (next === 'schedule' && !usesTimetable(before) && shouldShowColdRestartToast()) ctx.toast(coldRestartText(store.getState().layout), { kind: 'info', ms: 9000 });
  }

  /** The legacy fields of the Deliveries section while trucks are on: relabel the output buffer, hide what the trucks replace, show the note. */
  function relabelStaging(on) {
    const form = root.parentElement;
    if (!form) return;
    const field = form.querySelector('[data-role=out-buffer]');
    if (field) {
      const labelEl = field.querySelector('.field__label');
      const hintEl = field.querySelector('.field__hint');
      if (labelEl && labelEl.dataset.original === undefined) { labelEl.dataset.original = labelEl.textContent; if (hintEl) hintEl.dataset.original = hintEl.textContent; }
      const put = (el, text) => { if (el && text !== undefined && el.textContent !== text) el.textContent = text; };
      put(labelEl, on ? STAGING_LABEL : labelEl && labelEl.dataset.original);
      put(hintEl, on ? STAGING_HINT : hintEl && hintEl.dataset.original);
    }
    for (const el of form.querySelectorAll('[data-role=legacy-arrivals]')) if (el.hidden !== on) el.hidden = on;
    const note = form.querySelector('[data-role=trucks-note]');
    if (note && note.hidden === on) note.hidden = !on;
  }

  syncs.push((st, state) => {
    const trucks = trucksOf(st);
    const on = Boolean(trucks);
    off.hidden = on;
    if (on && !controls) {
      controls = buildControls(trucks);
      root.append(controls.el);
    }
    if (controls) controls.el.hidden = !on;
    if (!outbound) relabelStaging(on);
    if (on && !wasOn) controls.panel.el.open = true; // "Add dock doors" opens the section it just filled
    wasOn = on;
    if (on) controls.update(st, state, trucks);
  });
  return [root];
}
