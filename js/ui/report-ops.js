// Rows of the HTML report for trucks and dock doors (docs/WAREHOUSE-DESIGN.md 7.2 "Guidance": "assumption rows (doors, truck rate or timetable, check-in and
// check-out)"). Pure strings, no DOM; report.js calls the three functions below at its three places (the assumptions of a station, the plant at a glance, the
// results), so a plant without trucks gets exactly the report it got before.
//
//   withTrucks(station, rows, describeDist)   the assumption rows of a Goods in / Goods out: with trucks the arrivals come from them, so the rows they replace
//                                             ("Time between arrivals", "Loads per arrival") go, "Output buffer" becomes "Staging space" and the truck rows follow
//   clockRow(layout)                          ["Clock", "starts at 06:00 on Monday"] for a plant with a clock, else null
//   doorResultRows(report, layout)            one row per station with trucks: doors, trucks served, gate wait, door time, door use, gate queue, trucks left short
//
// The figures of the door check are labelled indicative, as in the inspector; the results are what the run measured (report.ops.trucks, absent without a run).

import { formatDuration, formatNumber, formatPercent } from '../util/format.js';
import { trucksOf } from '../model/ops.js';
import { describeTrucks, doorCheck } from '../model/doors.js';
import { DAY_NAMES_LONG, formatTimeOfDay } from '../model/calendar.js';

const NONE = '–';
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const count = (n, one, many) => `${formatNumber(n)} ${n === 1 ? one : many}`;

/** A distribution of a number of pallets: "24 pallets on average, ±25 % (evenly spread)". */
function palletsText(d) {
  if (!d || !finite(d.mean)) return NONE;
  const mean = `${formatNumber(d.mean, 1)} pallets`;
  const spread = `${Math.round((d.spread || 0) * 100)} %`;
  switch (d.kind) {
    case 'const': return `${mean} (constant)`;
    case 'exp': return `${mean} on average (random, exponential)`;
    case 'uniform': return `${formatNumber(d.mean * (1 - (d.spread || 0)), 0)} to ${formatNumber(d.mean * (1 + (d.spread || 0)), 0)} pallets (evenly spread)`;
    default: return `${mean} on average, ±${spread} (bell curve)`;
  }
}

/** "06:00 to 17:30, 12 trucks a day, 288 pallets" for a timetable. */
function timetableText(trucks) {
  const rows = trucks.schedule;
  if (rows.length === 0) return 'empty: no truck ever arrives';
  const d = describeTrucks(trucks);
  return `${count(rows.length, 'truck', 'trucks')} a day from ${formatTimeOfDay(rows[0].at)} to ${formatTimeOfDay(rows[rows.length - 1].at)}, about ${formatNumber(d.palletsPerTruck * rows.length, 0)} pallets`;
}

/** The truck rows of one station (see the header), [label, value] pairs. */
export function truckRows(station) {
  const trucks = trucksOf(station);
  if (!trucks) return [];
  const rows = [['Dock doors', formatNumber(trucks.doors)], ['Check-in / check-out', `${formatDuration(trucks.checkIn)} / ${formatDuration(trucks.checkOut)}`]];
  if (trucks.mode === 'schedule') {
    rows.push(['Trucks', `follow a timetable: ${timetableText(trucks)}`]);
    if (trucks.jitter > 0) rows.push(['Arrival variation', `up to ${formatDuration(trucks.jitter)} early or late`]);
    if (trucks.noShow > 0) rows.push(['No-shows', formatPercent(trucks.noShow, 1)]);
    rows.push(['Pallets of a row without a number', palletsText(trucks.pallets)]);
  } else {
    const d = trucks.interArrival;
    const gap = d.kind === 'const' ? `${formatDuration(d.mean)} (constant)` : d.kind === 'exp' ? `${formatDuration(d.mean)} on average (random, exponential)`
      : d.kind === 'uniform' ? `${formatDuration(d.mean * (1 - d.spread))} to ${formatDuration(d.mean * (1 + d.spread))} (evenly spread)` : `${formatDuration(d.mean)} on average, ±${Math.round(d.spread * 100)} % (bell curve)`;
    rows.push(['Time between trucks', gap], ['Pallets per truck', palletsText(trucks.pallets)]);
  }
  if (station.type === 'sink') {
    rows.push(['Staging per door', count(trucks.staging, 'pallet', 'pallets')], ['A truck waits for its pallets', trucks.maxDwell > 0 ? `at most ${formatDuration(trucks.maxDwell)}` : 'until it is full']);
  }
  return rows;
}

/**
 * The assumption rows of a Goods in / Goods out. Without trucks `rows` are returned as they are (a plant without trucks is reported as before).
 * @param {object} station
 * @param {Array<[string, string]>} rows the legacy rows of stationParams
 * @returns {Array<[string, string]>}
 */
export function withTrucks(station, rows) {
  if (!trucksOf(station)) return rows;
  const kept = rows
    .filter(([label]) => label !== 'Time between arrivals' && label !== 'Loads per arrival')
    .map(([label, value]) => (label === 'Output buffer' ? ['Staging space', value] : [label, value]));
  return [...kept, ...truckRows(station)];
}

/** The clock of the plant for "the plant at a glance", or null. */
export function clockRow(layout) {
  const c = layout && layout.calendar;
  if (!c) return null;
  return ['Clock', `starts at ${formatTimeOfDay(c.startTod)} on ${DAY_NAMES_LONG[c.startDay] || DAY_NAMES_LONG[0]}`];
}

/** One line of the door check of a station, for the assumptions (labelled indicative). */
export function doorCheckRow(station, layout) {
  const trucks = trucksOf(station);
  if (!trucks) return null;
  const check = doorCheck(trucks, { demandFactor: layout.settings && layout.settings.demandFactor });
  return ['Door check (indicative)', check.text];
}

/**
 * The Doors table of the results: one row per station with trucks, [name, doors, served, gate wait, door time, busy, gate queue, left short]; [] without trucks.
 * A run that produced no truck figures yet gives dashes.
 */
export function doorResultRows(report, layout) {
  const rows = [];
  const ops = report && report.ops && report.ops.trucks ? report.ops.trucks : {};
  for (const station of layout.stations) {
    if (!trucksOf(station)) continue;
    const e = ops[station.id] || null;
    const num = (v) => ({ v, num: true });
    const t = e && e.trucks ? e.trucks : {};
    const dur = (v) => (finite(v) ? formatDuration(v) : NONE);
    rows.push([
      station.name, num(formatNumber(e && finite(e.doors) ? e.doors : trucksOf(station).doors)), num(finite(t.departed) ? formatNumber(t.departed) : NONE),
      num(e && e.gateWait ? `${dur(e.gateWait.mean)} (90 %: ${dur(e.gateWait.p90)})` : NONE), num(e && e.doorTime ? `${dur(e.doorTime.mean)} (90 %: ${dur(e.doorTime.p90)})` : NONE),
      num(e && finite(e.doorUtilization) ? formatPercent(e.doorUtilization) : NONE), num(e && e.gateQueue ? `${formatNumber(e.gateQueue.mean, 1)} (most ${formatNumber(e.gateQueue.max)})` : NONE),
      num(station.type === 'sink' && finite(t.short) ? `${formatNumber(t.short)} of ${formatNumber(t.departed || 0)}` : NONE),
    ]);
  }
  return rows;
}
