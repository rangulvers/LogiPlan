// "Paste from spreadsheet" for the truck timetable (docs/WAREHOUSE-DESIGN.md 7.2, 7.6 copy 5): a dialog around the pure parser
// js/ui/panels/timetable-paste.js. The planner pastes two columns (arrival time, pallets); the dialog shows a PREVIEW that follows every keystroke:
// the rows that were read, and the rows that were not, marked in place with their line number and the reason ("row 7 “25:70” is not a time").
// NOTHING is applied until the primary button "Use N rows" is pressed; Cancel, Escape and the backdrop leave the timetable as it was. Excel in a German
// or other European locale (semicolons, decimal commas, 06.00, 6:00 Uhr) is read as well as tabs and commas: the parser knows, this file only shows.
//
//   openTimetableDialog(ctx, { stationId, text? })    ctx: store, dialogs.show
//   previewLines(result)                              pure: every line of the pasted text in order, as the preview table shows it
//
// The rows replace the timetable of the station in one undo step ("Paste timetable into “Goods in”").

import { h } from '../../util/dom.js';
import { formatTimeOfDay } from '../../model/calendar.js';
import { getStation, updateStation } from '../../model/layout.js';
import { trucksOf } from '../../model/ops.js';
import { icon } from '../icons.js';
import { addStyles } from '../ops-styles.js';
import { parseTimetable, rowsOf, summarizeTimetable } from './timetable-paste.js';

/** The preview shows this many lines; the rest is counted ("and 1,200 more lines"). */
export const PREVIEW_LINES = 200;

const CSS = `
.paste{display:flex;flex-direction:column;gap:var(--sp-3);min-width:0}
.paste__text{font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:var(--fs-sm);white-space:pre;overflow:auto;min-height:120px;resize:vertical}
.paste__summary{margin:0;font-size:var(--fs-sm);line-height:1.45}
.paste__summary.is-warn{color:var(--warn-text)}
.paste__table{border:1px solid var(--border);border-radius:var(--radius-md);overflow:hidden}
.paste__scroll{max-height:260px;overflow:auto}
.paste__table table{width:100%;border-collapse:collapse;font-size:var(--fs-sm)}
.paste__table th{position:sticky;top:0;background:var(--surface-2);text-align:left;font-weight:var(--fw-semibold);color:var(--text-dim);padding:5px var(--sp-2);border-bottom:1px solid var(--border)}
.paste__table td{padding:4px var(--sp-2);border-top:1px solid var(--border);vertical-align:top}
.paste__table tbody tr:first-child td{border-top:0}
.paste__table .num{text-align:right;font-variant-numeric:tabular-nums}
.paste__row--bad td{background:var(--warn-soft);color:var(--warn-text)}
.paste__row--head td{color:var(--text-faint);font-style:italic}
.paste__line{width:44px;color:var(--text-faint);font-variant-numeric:tabular-nums}
.paste__more{margin:0;padding:var(--sp-2);color:var(--text-dim);font-size:var(--fs-sm);border-top:1px solid var(--border)}
`;

const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * Every non-empty line of the pasted text, in the order of the text, as the preview table shows it.
 * @param {ReturnType<typeof parseTimetable>} result
 * @returns {Array<{ line: number, kind: 'good'|'bad'|'header', time?: string, pallets?: string, text?: string, reason?: string }>}
 *   good: a row that was read (`time` "06:00", `pallets` "24" or "from the distribution"); bad: a line that was skipped (`text`, `reason`);
 *   header: the skipped header line
 */
export function previewLines(result) {
  const lines = [];
  if (result.header) lines.push({ line: result.header.line, kind: 'header', text: result.header.text, reason: 'Header, not a timetable row' });
  for (const row of result.rows) {
    lines.push({ line: row.line, kind: 'good', time: formatTimeOfDay(row.at), pallets: row.pallets === null ? 'drawn' : String(row.pallets) });
  }
  for (const skip of result.skipped) lines.push({ line: skip.line, kind: 'bad', text: skip.text, reason: skip.reason, code: skip.code });
  return lines.sort((a, b) => a.line - b.line);
}

/** The label of the primary button: "Use 12 rows", "Use 1 row", "Use rows" while there is nothing to use. */
export function useLabel(result) {
  const n = result.rows.length;
  return n === 0 ? 'Use rows' : `Use ${plural(n, 'row', 'rows')}`;
}

/**
 * Open the dialog for the timetable of `stationId`.
 * @param {object} ctx the shared ctx: store, dialogs.show, toast
 * @param {{ stationId: string, text?: string }} spec `text`: what the text area starts with (tests)
 * @returns {{ close(): void, el: HTMLElement, buttons: HTMLButtonElement[], isOpen(): boolean }|null} null when the station has no trucks
 */
export function openTimetableDialog(ctx, { stationId, text = '' }) {
  const { store } = ctx;
  const station = getStation(store.getState().layout, stationId);
  const trucks = trucksOf(station);
  if (!station || !trucks) return null;
  addStyles('ops-timetable-dialog-styles', CSS);

  const area = h('textarea', {
    class: 'input paste__text', id: 'paste-text', rows: 6, spellcheck: 'false', autocomplete: 'off', wrap: 'off', 'data-role': 'paste-text',
    placeholder: '06:00\t24\n07:30\t18\n09:00\t26',
  });
  area.value = text;
  const label = h('label', { class: 'field__label', for: 'paste-text' }, 'Pasted rows');
  const summary = h('p', { class: 'paste__summary', 'data-role': 'paste-summary', 'aria-live': 'polite' });
  const replaces = h('p', { class: 'field__hint', hidden: trucks.schedule.length === 0, 'data-role': 'paste-replaces' },
    `The ${plural(trucks.schedule.length, 'row', 'rows')} of the timetable now will be replaced.`);
  const tbody = h('tbody');
  const more = h('p', { class: 'paste__more', hidden: true });
  const scroll = h('div', { class: 'paste__scroll' }, h('table', { 'aria-label': 'Preview of the pasted rows' },
    h('thead', null, h('tr', null, h('th', { scope: 'col', class: 'paste__line' }, 'Line'), h('th', { scope: 'col' }, 'Arrival'), h('th', { scope: 'col', class: 'num' }, 'Pallets'), h('th', { scope: 'col' }, 'Note'))),
    tbody));
  const preview = h('div', { class: 'paste__table', hidden: true, 'data-role': 'paste-preview' }, scroll, more);
  const fromClipboard = h('button', { class: 'btn btn--sm', type: 'button', 'data-role': 'paste-clipboard', onclick: async () => {
    try {
      area.value = await navigator.clipboard.readText();
      render();
      area.focus();
    } catch {
      summary.textContent = 'The browser did not let this page read the clipboard. Click in the box and press Ctrl+V (or Cmd+V) instead.';
      summary.classList.add('is-warn');
    }
  } }, icon('import', { size: 14 }), 'Paste from clipboard');

  let result = parseTimetable('');
  let dialog = null;

  function render() {
    result = parseTimetable(area.value);
    const lines = previewLines(result);
    const shown = lines.slice(0, PREVIEW_LINES);
    tbody.replaceChildren(...shown.map((l) => h('tr', { class: `paste__row paste__row--${l.kind}`, 'data-kind': l.kind },
      h('td', { class: 'paste__line' }, String(l.line)),
      l.kind === 'good' ? h('td', null, l.time) : h('td', { colspan: 2 }, l.text),
      l.kind === 'good' ? h('td', { class: 'num' }, l.pallets) : null,
      h('td', null, l.kind === 'good' ? '' : l.reason))));
    preview.hidden = lines.length === 0;
    more.hidden = lines.length <= PREVIEW_LINES;
    if (!more.hidden) more.textContent = `…and ${plural(lines.length - PREVIEW_LINES, 'more line', 'more lines')}.`;
    summary.textContent = summarizeTimetable(result);
    summary.classList.toggle('is-warn', result.skipped.length > 0);
    if (dialog) {
      const use = dialog.buttons[1];
      use.textContent = useLabel(result);
      use.disabled = result.rows.length === 0;
    }
  }
  area.addEventListener('input', render);

  const body = h('div', { class: 'paste' },
    h('p', { style: { margin: 0 } }, 'Copy two columns in your spreadsheet, the arrival time and the number of pallets, and paste them below. Tabs, semicolons and commas between the columns work, and so do German Excel times (06.00, 6:00 Uhr) and numbers (24,0).'),
    h('div', { class: 'field' }, label, area),
    h('div', { class: 'row row--wrap' }, fromClipboard),
    summary, replaces, preview);

  dialog = ctx.dialogs.show({
    title: 'Paste a timetable from your spreadsheet',
    size: 'lg',
    body,
    actions: [
      { label: 'Cancel' },
      {
        label: 'Use rows', variant: 'primary', disabled: true,
        onClick: () => {
          const rows = rowsOf(result);
          if (!rows.length) return false;
          let applied = false;
          const name = getStation(store.getState().layout, stationId)?.name ?? station.name;
          store.commit(`Paste timetable into “${name}”`, (d) => {
            if (!trucksOf(getStation(d, stationId))) return false;
            applied = updateStation(d, stationId, { ops: { trucks: { schedule: rows } } });
            if (!applied) return false;
          });
          if (!applied) {
            ctx.toast?.('That station has no trucks any more, so the timetable was not changed.', { kind: 'warn' });
            return false;
          }
          return undefined;
        },
      },
    ],
  });
  render();
  area.focus();
  return dialog;
}
