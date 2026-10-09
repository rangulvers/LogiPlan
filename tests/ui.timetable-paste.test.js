// "Paste from spreadsheet" (docs/WAREHOUSE-DESIGN.md 7.2, acceptance A1.11): parseTimetable is a PURE function, tested here in Node with a table of
// inputs (tab, semicolon and comma separators; 6:00, 06:00, 06.00, 0600, 6:00 Uhr; decimal comma; header; bad rows; empty text; Windows line
// endings; thousands of rows capped at 500). Each line of the table gives the expected good rows [seconds after midnight, pallets|null] and the
// expected skipped rows [line, code]. Nothing is applied by the parser: rowsOf() is what the dialog writes after "Use N rows".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePalletsField, parseTimeField, parseTimetable, rowsOf, summarizeTimetable } from '../js/ui/panels/timetable-paste.js';
import { MAX_SCHEDULE_ROWS } from '../js/model/ops.js';
import { sanitizeOps } from '../js/model/ops.js';

const h = (hours, minutes = 0) => hours * 3600 + minutes * 60;

/** [name, input, rows [[at, pallets]], skipped [[line, code]], extras { separator, header }] */
const TABLE = [
  // --- nothing -----------------------------------------------------------------------------------------------------------
  ['empty text', '', [], [], { separator: null }],
  ['only blanks and line breaks', ' \n\t\n  \r\n\n', [], [], { separator: null }],
  // --- separators ---------------------------------------------------------------------------------------------------------
  ['tab separated (a spreadsheet copy)', '6:00\t24\n7:30\t12', [[h(6), 24], [h(7, 30), 12]], [], { separator: 'tab' }],
  ['semicolon separated (a German CSV)', '6:00;24\n7:30;12', [[h(6), 24], [h(7, 30), 12]], [], { separator: 'semicolon' }],
  ['comma separated, one comma in every row', '6:00,24\n7:30,12', [[h(6), 24], [h(7, 30), 12]], [], { separator: 'comma' }],
  ['comma separated with a header', 'Time,Pallets\n6:00,24\n7:30,12', [[h(6), 24], [h(7, 30), 12]], [], { separator: 'comma', header: 1 }],
  ['tab wins over semicolon and comma', '6:00\t24\n7:00\t12', [[h(6), 24], [h(7), 12]], [], { separator: 'tab' }],
  ['a single column of times: the pallets are drawn from the distribution', '6:00\n7:00\n8:30', [[h(6), null], [h(7), null], [h(8, 30), null]], [], { separator: null }],
  // --- times ------------------------------------------------------------------------------------------------------------
  ['H:MM', '6:00;1', [[h(6), 1]], []],
  ['HH:MM', '06:30;1', [[h(6, 30), 1]], []],
  ['HH.MM with a point (two digits after it)', '06.45;1', [[h(6, 45), 1]], []],
  ['H.MM', '6.05;1', [[h(6, 5), 1]], []],
  ['HHMM', '0600;1\n1430;2\n2359;3', [[h(6), 1], [h(14, 30), 2], [h(23, 59), 3]], []],
  ['a trailing Uhr', '6:00 Uhr;1\n07:15 UHR;2\n8.30 uhr;3', [[h(6), 1], [h(7, 15), 2], [h(8, 30), 3]], []],
  ['a trailing h', '6:00h;1\n7:00 h;2\n0830h;3', [[h(6), 1], [h(7), 2], [h(8, 30), 3]], []],
  ['midnight and the last minute', '0:00;1\n00:00;2\n23:59;3', [[0, 1], [0, 2], [h(23, 59), 3]], []],
  ['the same time twice stays twice', '6:00;1\n6:00;2', [[h(6), 1], [h(6), 2]], []],
  ['surrounding spaces and non-breaking spaces', '  6:00 ;  24  \n 7:00 ; 12 ', [[h(6), 24], [h(7), 12]], []],
  // --- bad times ----------------------------------------------------------------------------------------------------------
  ['hours out of range', '24:00;1\n25:00;1\n99:99;1', [], [[1, 'time'], [2, 'time'], [3, 'time']]],
  ['minutes out of range (the example of 7.2: 25:70)', '12:60;1\n25:70;4', [], [[1, 'time'], [2, 'time']]],
  ['not times at all', 'abc;1\n6;1\n6.5;1\n6:5;1\n06:0;1\n6:00:00;1\n6 Uhr;1\n2400;1\n9999;1\n600;1\n-6:00;1', [], [[1, 'time'], [2, 'time'], [3, 'time'], [4, 'time'], [5, 'time'], [6, 'time'], [7, 'time'], [8, 'time'], [9, 'time'], [10, 'time'], [11, 'time']]],
  ['a missing time', ';24\n6:00;24', [[h(6), 24]], [[1, 'no-time']]],
  // --- pallets ------------------------------------------------------------------------------------------------------------
  ['a decimal comma that is a whole number (24,0 and 24,00)', '6:00;24,0\n7:00;18,00', [[h(6), 24], [h(7), 18]], []],
  ['a decimal point that is a whole number', '6:00\t24.0\n7:00\t18.00', [[h(6), 24], [h(7), 18]], []],
  ['a fraction is refused, never rounded', '6:00;24,5\n7:00;12.25', [], [[1, 'pallets'], [2, 'pallets']]],
  ['a thousands separator is refused, never read as 1', '6:00;1.000\n7:00;1,000', [], [[1, 'pallets'], [2, 'pallets']]],
  ['pallets out of range (1 to 200)', '6:00;0\n7:00;201\n8:00;200\n9:00;1\n10:00;-3\n11:00;1e3', [[h(8), 200], [h(9), 1]], [[1, 'pallets'], [2, 'pallets'], [5, 'pallets'], [6, 'pallets']]],
  ['not a number of pallets', '6:00;abc\n7:00;n/a\n8:00;24 pallets', [], [[1, 'pallets'], [2, 'pallets'], [3, 'pallets']]],
  ['an empty pallets cell means draw them', '6:00;\n7:00;24\n8:00; ', [[h(6), null], [h(7), 24], [h(8), null]], []],
  ['a trailing separator is ignored', '6:00;24;\n7:00;12;;', [[h(6), 24], [h(7), 12]], []],
  ['more than two columns is refused', '6:00;24;DHL\n7:00;12', [[h(7), 12]], [[1, 'columns']]],
  // --- headers ------------------------------------------------------------------------------------------------------------
  ['an English header', 'Arrival;Pallets\n6:00;24', [[h(6), 24]], [], { header: 1 }],
  ['a German header and decimal commas (a typical Excel export)', 'Ankunft;Paletten\n06:00;24,0\n06:30;18,0\n07:15;30', [[h(6), 24], [h(6, 30), 18], [h(7, 15), 30]], [], { separator: 'semicolon', header: 1 }],
  ['a header on a tab separated copy, after an empty line', '\nZeit\tMenge\n6:00\t24', [[h(6), 24]], [], { header: 2 }],
  ['only a header', 'Arrival;Pallets', [], [], { header: 1 }],
  ['a first line with digits is data, not a header', 'Truck 1;24\n6:00;24', [[h(6), 24]], [[1, 'time']]],
  ['a second header-like line is a bad row, one header is skipped', 'Arrival;Pallets\nNotes;x\n6:00;24', [[h(6), 24]], [[2, 'time']], { header: 1 }],
  // --- line endings and layout of the text ---------------------------------------------------------------------------------
  ['Windows line endings', '6:00;24\r\n7:00;12\r\n', [[h(6), 24], [h(7), 12]], []],
  ['old Mac line endings', '6:00;24\r7:00;12', [[h(6), 24], [h(7), 12]], []],
  ['mixed line endings and a BOM', '﻿6:00;24\r\n7:00;12\n8:00;6\r', [[h(6), 24], [h(7), 12], [h(8), 6]], []],
  ['blank lines are ignored but counted in the line numbers', '\n\n6:00;24\n\nx;1\n', [[h(6), 24]], [[5, 'time']]],
  // --- quotes -------------------------------------------------------------------------------------------------------------
  ['quoted fields with a semicolon', '"6:00";"24,0"\n"7:00";"12"', [[h(6), 24], [h(7), 12]], [], { separator: 'semicolon' }],
  ['quoted fields with a comma: the decimal comma inside quotes is not a separator', '6:00,"24,0"\n"7:00","12"', [[h(6), 24], [h(7), 12]], [], { separator: 'comma' }],
  // --- commas that cannot be told from a decimal comma ----------------------------------------------------------------------
  ['0600,24 could be one number: not split', '0600,24', [], [[1, 'time']], { separator: null }],
  ['two commas in a row: not split', '6:00,24,0', [], [[1, 'time']], { separator: null }],
  ['a comma file where one row has none: not split, so the first row is bad and the single time of the second is read', '6:00,24\n7:00', [[h(7), null]], [[1, 'time']], { separator: null }],
  // --- mixed good and bad (the example of 7.2) ------------------------------------------------------------------------------
  ['12 rows read, 2 skipped', 'Time;Pallets\n6:00;24\n6:30;24\n7:00;24\n7:30;24\n8:00;24\n25:70;24\n8:30;24\n9:00;24\n9:30;24\n10:00;x\n10:30;24\n11:00;24\n11:30;24\n12:00;24',
    [[h(6), 24], [h(6, 30), 24], [h(7), 24], [h(7, 30), 24], [h(8), 24], [h(8, 30), 24], [h(9), 24], [h(9, 30), 24], [h(10, 30), 24], [h(11), 24], [h(11, 30), 24], [h(12), 24]], [[7, 'time'], [11, 'pallets']], { header: 1 }],
];

for (const [name, input, rows, skipped, extras = {}] of TABLE) {
  test(`A1.11 parseTimetable: ${name}`, () => {
    const before = typeof input === 'string' ? input : null;
    const result = parseTimetable(input);
    assert.deepEqual(result.rows.map((r) => [r.at, r.pallets]), rows, 'rows');
    assert.deepEqual(result.skipped.map((s) => [s.line, s.code]), skipped, 'skipped');
    if ('separator' in extras) assert.equal(result.separator, extras.separator, 'separator');
    if ('header' in extras) assert.equal(result.header && result.header.line, extras.header, 'header line');
    else assert.equal(result.header, null, 'no header');
    for (const row of result.rows) assert.ok(Number.isInteger(row.line) && row.line >= 1);
    for (const s of result.skipped) {
      assert.ok(s.reason.length > 5 && s.message === `row ${s.line} ${s.reason}`, s.message);
      assert.ok(typeof s.text === 'string' && s.text.length > 0);
    }
    assert.equal(result.omitted, 0);
    if (before !== null) assert.equal(input, before);
    assert.equal(JSON.stringify(parseTimetable(input)), JSON.stringify(result), 'pure: the same text gives the same result');
    // what the dialog would write is always a valid timetable
    const stored = sanitizeOps('source', { trucks: { mode: 'schedule', schedule: rowsOf(result) } }).trucks.schedule;
    assert.equal(stored.length, rows.length);
  });
}

test('A1.11 the table has at least 25 inputs, covering every separator and every time form of 7.2', () => {
  assert.ok(TABLE.length >= 25, `${TABLE.length} inputs`);
  const separators = new Set(TABLE.map((row) => (row[4] || {}).separator).filter(Boolean));
  assert.deepEqual([...separators].sort(), ['comma', 'semicolon', 'tab']);
});

test('A1.11 non-text input is read as empty text', () => {
  for (const input of [undefined, null, 5, {}, [], true, () => 1]) {
    const result = parseTimetable(input);
    assert.deepEqual([result.rows, result.skipped, result.header, result.separator, result.omitted], [[], [], null, null, 0]);
  }
});

test('A1.11 thousands of rows are capped at 500: the first 500 are kept, one skipped entry says how many were left out', () => {
  const lines = (n) => Array.from({ length: n }, (_, i) => `${String(Math.floor(i / 60) % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')};${1 + (i % 30)}`).join('\n');
  const big = parseTimetable(`Arrival;Pallets\n${lines(2000)}`);
  assert.equal(MAX_SCHEDULE_ROWS, 500);
  assert.equal(big.rows.length, 500);
  assert.equal(big.rows[0].line, 2);
  assert.equal(big.rows[499].line, 501);
  assert.equal(big.omitted, 1500);
  assert.equal(big.skipped.length, 1);
  assert.deepEqual([big.skipped[0].line, big.skipped[0].code], [502, 'too-many']);
  assert.equal(big.skipped[0].reason, 'only 500 rows fit in a timetable; this row and 1,499 rows after it were left out');
  assert.equal(big.skipped[0].message, 'from row 502 on, only 500 rows fit in a timetable; this row and 1,499 rows after it were left out');
  assert.equal(parseTimetable(lines(500)).skipped.length, 0, 'exactly 500 fit');
  assert.equal(parseTimetable(lines(500)).omitted, 0);
  const one = parseTimetable(lines(501));
  assert.equal(one.omitted, 1);
  assert.equal(one.skipped[0].reason, 'only 500 rows fit in a timetable; this row and 0 rows after it were left out');
  assert.equal(rowsOf(big).length, 500);
  // bad rows before the cap are reported on their own, and the cap counts good rows
  const mixed = parseTimetable(`${Array.from({ length: 10 }, () => 'x;1').join('\n')}\n${lines(600)}`);
  assert.equal(mixed.rows.length, 500);
  assert.equal(mixed.skipped.filter((s) => s.code === 'time').length, 10);
  assert.equal(mixed.skipped.filter((s) => s.code === 'too-many').length, 1);
  // a flood of bad rows is reported row by row (the dialog shows the first ones) and is cheap
  const started = process.cpuUsage();
  const junk = parseTimetable(Array.from({ length: 20000 }, (_, i) => `row ${i};1`).join('\n'));
  assert.equal(junk.skipped.length, 20000);
  assert.equal(junk.rows.length, 0);
  const cpu = process.cpuUsage(started);
  assert.ok((cpu.user + cpu.system) / 1e3 < 1500, `20,000 bad rows took ${((cpu.user + cpu.system) / 1e3).toFixed(0)} ms of CPU`);
});

test('A1.11 the reasons are plain language and quote the text (7.2: row 7 “25:70” is not a time)', () => {
  const r = parseTimetable('6:00;24\n6:30;24\n7:00;24\n7:30;24\n8:00;24\n8:30;24\n25:70;24');
  assert.equal(r.skipped[0].message, 'row 7 “25:70” is not a time');
  const reason = (text) => parseTimetable(text).skipped[0].reason;
  assert.equal(reason('6:00;24,5'), '“24,5” is not a whole number of pallets');
  assert.equal(reason('6:00;1.000'), '“1.000” is not a whole number of pallets');
  assert.equal(reason('6:00;0'), '“0” is not between 1 and 200 pallets');
  assert.equal(reason('6:00;300'), '“300” is not between 1 and 200 pallets');
  assert.equal(reason('6:00;abc'), '“abc” is not a number of pallets');
  assert.equal(reason('6:00;24;x'), 'has 3 columns; expected an arrival time and a number of pallets');
  assert.equal(reason(';24\n'), 'has no arrival time');
  assert.match(reason('0600,24'), /^“0600,24” is not a time \(a comma between the columns only works when every row has exactly one; use a semicolon or a tab\)$/);
  assert.equal(reason('"6:7";1'), '“6:7” is not a time', 'quotes are not part of the quoted text');
});

test('A1.11 summarizeTimetable: copy 5 of 7.6, and the cases around it', () => {
  const twelve = 'Time;Pallets\n6:00;24\n6:30;24\n7:00;24\n7:30;24\n8:00;24\n25:70;24\n8:30;24\n9:00;24\n9:30;24\n10:00;x\n10:30;24\n11:00;24\n11:30;24\n12:00;24';
  assert.equal(summarizeTimetable(parseTimetable(twelve)), '12 rows read, 2 skipped: row 7 “25:70” is not a time (and 1 more). Nothing is applied until you press Use 12 rows.');
  assert.equal(summarizeTimetable(parseTimetable('6:00;24\n25:70;24')), '1 row read, 1 skipped: row 2 “25:70” is not a time. Nothing is applied until you press Use 1 row.');
  assert.equal(summarizeTimetable(parseTimetable('6:00;24\n7:00;12')), '2 rows read. Nothing is applied until you press Use 2 rows.');
  assert.equal(summarizeTimetable(parseTimetable('x;1')), '0 rows read, 1 skipped: row 1 “x” is not a time.');
  assert.equal(summarizeTimetable(parseTimetable('')), 'Nothing to read yet. Paste two columns from your spreadsheet: the arrival time and the number of pallets.');
  assert.equal(summarizeTimetable(parseTimetable('Arrival;Pallets')), 'Only a header row was found. Paste the rows too: an arrival time and a number of pallets.');
  assert.match(summarizeTimetable(parseTimetable(Array.from({ length: 800 }, () => '6:00;1').join('\n'))), /^500 rows read, 1 skipped: from row 501 on, only 500 rows fit/);
});

test('A1.11 nothing is applied by the parser: rowsOf gives the rows as the timetable stores them (no line numbers), in the order of the text', () => {
  const result = parseTimetable('9:00;3\n6:00;24\n7:00;');
  assert.deepEqual(rowsOf(result), [{ at: h(9), pallets: 3 }, { at: h(6), pallets: 24 }, { at: h(7), pallets: null }]);
  assert.deepEqual(Object.keys(result.rows[0]), ['at', 'pallets', 'line']);
  const stored = sanitizeOps('sink', { trucks: { mode: 'schedule', schedule: rowsOf(result) } }).trucks.schedule;
  assert.deepEqual(stored.map((r) => r.at), [h(6), h(7), h(9)], 'the sanitizer sorts them');
});

test('A1.11 the field parsers on their own', () => {
  for (const [text, seconds] of [['6:00', h(6)], ['06:00', h(6)], ['06.00', h(6)], ['0600', h(6)], ['6:00 Uhr', h(6)], ['06:00h', h(6)], ['23:59', h(23, 59)], ['0:05', 300]]) assert.equal(parseTimeField(text), seconds, text);
  for (const text of ['', 'x', '24:00', '6:60', '6', '600', '6.5', '6:5', '12:30:00', '6:00 pm', '-1:00']) assert.equal(parseTimeField(text), null, text);
  for (const [text, value] of [['24', 24], ['24,0', 24], ['24.0', 24], ['24,00', 24], ['1', 1], ['200', 200], [' 12 ', 12], ['+7', 7]]) assert.deepEqual(parsePalletsField(text), { value }, text);
  assert.deepEqual(parsePalletsField('24,5'), { error: 'whole' });
  assert.deepEqual(parsePalletsField('1.000'), { error: 'whole' });
  assert.deepEqual(parsePalletsField('0'), { error: 'range' });
  assert.deepEqual(parsePalletsField('201'), { error: 'range' });
  assert.deepEqual(parsePalletsField('abc'), { error: 'number' });
  assert.deepEqual(parsePalletsField('-4'), { error: 'number' });
});
