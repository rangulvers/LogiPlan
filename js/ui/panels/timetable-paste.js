// "Paste from spreadsheet" for the truck timetable (docs/WAREHOUSE-DESIGN.md 7.2): text copied from a spreadsheet in, rows and skipped lines out.
// A PURE module, no DOM: parseTimetable(text) reads nothing but its argument and applies nothing; the dialog shows the result as a
// preview (good rows, and the bad rows marked in place with their line number and reason) and only the button "Use N rows" writes
// `rowsOf(result)` into `ops.trucks.schedule` (the sanitizer sorts them). Tested in Node (tests/ui.timetable-paste.test.js).
//
// What is read (7.2; German and many other European Excel exports use semicolons, decimal commas and `06.00` or `6:00 Uhr`):
//   Separator  a TAB if any data line has one, else a SEMICOLON if any has one, else a COMMA, but only when every data line has exactly one
//              comma outside quotes and is not itself a decimal number ("24,0"; so "0600,24" is NOT split: it could be one number). With
//              none of these every line is one column: a time and no pallets. Fields are trimmed; double quotes around a field are removed.
//   Time       H:MM, HH:MM, H:MM:00 and HH:MM:00 (seconds only when they are zero: database and warehouse-system exports write 06:00:00),
//              HH.MM (two digits before and after the point), HHMM (exactly four digits), hours 0..23, minutes 0..59, with a trailing "h" or "Uhr" (any case,
//              spaces allowed) ignored; H.MM (one digit before the point) only WITH that suffix ("6.30 Uhr"): a bare "0.25" is Excel's time as a fraction of a
//              day (06:00), not 00:25, and is refused with a hint rather than guessed. 12-hour times of English Excel: "6:00 AM", "6:00:00 PM", "6 a.m. " forms
//              with a colon, hours 1..12 ("12:00 AM" is midnight, "12:30 PM" is half past noon). Nothing else: no seconds other than zero, no "6 Uhr", no "6.5".
//   Pallets    a whole number 1..200; "24,0", "24.0", "24,00" and "24.00" are accepted as 24; "24,5" and "1.000" are refused (never guessed);
//              an empty or missing column means "draw the pallets from the distribution" (`pallets: null`).
//   Header     the first non-empty line is skipped when it contains no digit ("Arrival;Pallets", "Ankunft<TAB>Paletten").
//   Lines      \n, \r\n and \r end a line; empty lines are ignored (line numbers still count them); a UTF-8 BOM is ignored. Trailing empty
//              columns ("6:00;24;") are ignored; a line with more than two columns is refused.
//   Cap        a timetable holds MAX_SCHEDULE_ROWS (500) rows: from the 501st good row on nothing is read, and ONE skipped entry says so.

import { MAX_SCHEDULE_ROWS, TRUCK_RANGES } from '../../model/ops.js';

const [PALLETS_MIN, PALLETS_MAX] = TRUCK_RANGES.rowPallets;
const OPEN = '“';
const CLOSE = '”';
const quoted = (text) => `${OPEN}${text}${CLOSE}`;
const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** Fields of one line, split at `sep` outside double quotes, trimmed, quotes removed ("" is a quote); trailing empty columns beyond the second dropped. */
function splitFields(line, sep, dropTrailing = true) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; } else inQuotes = !inQuotes;
    } else if (ch === sep && !inQuotes) {
      fields.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  fields.push(cur.trim());
  while (dropTrailing && fields.length > 2 && fields[fields.length - 1] === '') fields.pop();
  return fields;
}

const NO_SEPARATOR = '\u0000';
const SEPARATOR_CHARS = { tab: '\t', semicolon: ';', comma: ',' };
/** A line that is one decimal number written with a comma ("24,0"): not a pair of columns. */
const DECIMAL_LINE = /^\s*\d+,\d+\s*$/;

/** Which separator the data lines use (see the header), or null for a single column. */
function detectSeparator(lines) {
  for (const name of ['tab', 'semicolon']) {
    if (lines.some((l) => splitFields(l.text, SEPARATOR_CHARS[name]).length > 1)) return name;
  }
  const commaPairs = lines.length > 0 && lines.every((l) => splitFields(l.text, ',', false).length === 2 && !DECIMAL_LINE.test(l.text.replace(/"/g, '')));
  return commaPairs ? 'comma' : null;
}

const SUFFIX = /(?:uhr|h)$/i;
const MERIDIEM = /([ap])\.?\s*m\.?$/i;

/**
 * Seconds after midnight from a spreadsheet time ("6:00", "06:00", "06:00:00", "06.00", "0600", "6:00 Uhr", "06:00h", "6.30 Uhr", "6:00 AM"), or null.
 * (No pattern starts with optional white space: a field of many spaces must stay linear to parse, the dialog parses on every keystroke.)
 * @param {string} field
 * @returns {number|null}
 */
export function parseTimeField(field) {
  let s = String(field).trim();
  let meridiem = '';
  const pm = MERIDIEM.exec(s);
  if (pm) {
    meridiem = pm[1].toLowerCase();
    s = s.slice(0, pm.index).trim();
  }
  const suffix = !meridiem && SUFFIX.test(s);
  if (suffix) s = s.replace(SUFFIX, '').trim();
  let hours;
  let minutes;
  const colon = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (colon) {
    if (colon[3] !== undefined && colon[3] !== '00') return null;
    hours = Number(colon[1]);
    minutes = Number(colon[2]);
  } else if (meridiem) {
    return null;
  } else {
    const m = /^(\d{2})\.(\d{2})$/.exec(s) || (suffix ? /^(\d)\.(\d{2})$/.exec(s) : null) || /^(\d{2})(\d{2})$/.exec(s);
    if (!m) return null;
    hours = Number(m[1]);
    minutes = Number(m[2]);
  }
  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === 'p' ? 12 : 0);
  } else if (hours > 23) return null;
  return hours * 3600 + minutes * 60;
}

/** A short hint for a time that was not read, when the text looks like a known spreadsheet notation, else ''. */
export function timeHint(field) {
  const s = String(field).trim();
  if (/^\d{1,2}:\d{2}:\d{2}/.test(s)) return 'times are whole minutes, like 06:00';
  if (/^\d*[.,]\d+$/.test(s) && Number(s.replace(',', '.')) < 1) return 'a number between 0 and 1 is Excel\u2019s time as a fraction of a day: format the column as hh:mm and copy it again';
  if (/^\d[.,]\d{2}$/.test(s)) return 'write the hour with two digits (06.30) or with a colon (6:30)';
  return '';
}

/**
 * Pallets from a cell: `{ value }` (a whole number 1..200) or `{ error: 'number' | 'whole' | 'range' }`.
 * @param {string} field
 */
export function parsePalletsField(field) {
  const s = String(field).trim();
  const whole = /^\+?(\d+)(?:[.,]0{1,2})?$/.exec(s);
  if (!whole) return { error: /^\d+[.,]\d+$/.test(s) ? 'whole' : 'number' };
  const value = Number(whole[1]);
  return value >= PALLETS_MIN && value <= PALLETS_MAX ? { value } : { error: 'range' };
}

function palletsReason(text, error) {
  if (error === 'whole') return `${quoted(text)} is not a whole number of pallets`;
  if (error === 'range') return `${quoted(text)} is not between ${PALLETS_MIN} and ${PALLETS_MAX} pallets`;
  return `${quoted(text)} is not a number of pallets`;
}

/**
 * Read a pasted timetable.
 * @param {string} text what the clipboard held (anything else is read as empty text)
 * @returns {{
 *   rows: Array<{ at: number, pallets: number|null, line: number }>,
 *   skipped: Array<{ line: number, text: string, reason: string, message: string, code: 'time'|'pallets'|'columns'|'no-time'|'too-many' }>,
 *   header: { line: number, text: string }|null,
 *   separator: 'tab'|'semicolon'|'comma'|null,
 *   omitted: number
 * }} `rows`: the good rows in the order of the text, at most MAX_SCHEDULE_ROWS, `at` seconds after midnight, `pallets` a whole number or null
 *   (draw from the distribution); `line`: 1-based line of the text. `skipped`: the rows that were not read, each with `reason`
 *   ("“25:70” is not a time") and `message` ("row 7 “25:70” is not a time"); the cap adds one entry (`code` 'too-many', `line` the first
 *   row left out). `header`: the skipped header line. `separator`: what split the columns (null: one column). `omitted`: the data lines
 *   left out because of the cap (0 normally). Nothing is applied: that is the dialog's job.
 */
export function parseTimetable(text) {
  const source = typeof text === 'string' ? text.replace(/^﻿/, '') : '';
  const all = source.split(/\r\n|\r|\n/).map((raw, i) => ({ line: i + 1, text: raw.trim() })).filter((l) => l.text !== '');
  const result = { rows: [], skipped: [], header: null, separator: null, omitted: 0 };
  if (all.length === 0) return result;

  let data = all;
  if (!/\d/.test(all[0].text)) { // the first non-empty line has no digit: a header such as "Arrival;Pallets"
    result.header = { line: all[0].line, text: all[0].text };
    data = all.slice(1);
  }
  const separator = detectSeparator(data);
  result.separator = separator;
  const sep = separator ? SEPARATOR_CHARS[separator] : NO_SEPARATOR;

  const skip = (entry, code, reason) => result.skipped.push({
    line: entry.line, text: entry.text, reason, message: `row ${entry.line} ${reason}`, code,
  });

  for (let i = 0; i < data.length; i++) {
    const entry = data[i];
    if (result.rows.length >= MAX_SCHEDULE_ROWS) {
      result.omitted = data.length - i;
      const reason = `only ${MAX_SCHEDULE_ROWS} rows fit in a timetable; this row and ${plural(result.omitted - 1, 'row', 'rows')} after it were left out`;
      result.skipped.push({ line: entry.line, text: entry.text, reason, message: `from row ${entry.line} on, ${reason}`, code: 'too-many' });
      break;
    }
    const fields = splitFields(entry.text, sep);
    if (fields.length > 2) {
      skip(entry, 'columns', `has ${fields.length} columns; expected an arrival time and a number of pallets`);
      continue;
    }
    if (fields[0] === '') {
      skip(entry, 'no-time', 'has no arrival time');
      continue;
    }
    const at = parseTimeField(fields[0]);
    if (at === null) {
      const comma = separator === null && fields[0].includes(',')
        ? ' (a comma between the columns only works when every row has exactly one; use a semicolon or a tab)' : '';
      const hint = comma || (timeHint(fields[0]) ? ` (${timeHint(fields[0])})` : '');
      skip(entry, 'time', `${quoted(fields[0])} is not a time${hint}`);
      continue;
    }
    let pallets = null;
    if (fields.length === 2 && fields[1] !== '') {
      const parsed = parsePalletsField(fields[1]);
      if (parsed.error) {
        skip(entry, 'pallets', palletsReason(fields[1], parsed.error));
        continue;
      }
      pallets = parsed.value;
    }
    result.rows.push({ at, pallets, line: entry.line });
  }
  return result;
}

/** The rows of a parse as the timetable stores them: `[{ at, pallets }]`, ready for `updateStation(layout, id, { ops: { trucks: { schedule } } })`. */
export function rowsOf(result) {
  return result.rows.map(({ at, pallets }) => ({ at, pallets }));
}

/**
 * Copy 5 of 7.6: "12 rows read, 2 skipped: row 7 “25:70” is not a time. Nothing is applied until you press Use 12 rows." The first skipped row is
 * quoted, the others counted.
 * @param {ReturnType<typeof parseTimetable>} result
 * @returns {string}
 */
export function summarizeTimetable(result) {
  const n = result.rows.length;
  const k = result.skipped.length;
  if (n === 0 && k === 0) {
    return result.header
      ? 'Only a header row was found. Paste the rows too: an arrival time and a number of pallets.'
      : 'Nothing to read yet. Paste two columns from your spreadsheet: the arrival time and the number of pallets.';
  }
  let text = `${plural(n, 'row', 'rows')} read`;
  if (k > 0) text += `, ${k} skipped: ${result.skipped[0].message}${k > 1 ? ` (and ${plural(k - 1, 'more', 'more')})` : ''}`;
  text += '.';
  if (n > 0) text += ` Nothing is applied until you press Use ${plural(n, 'row', 'rows')}.`;
  return text;
}
