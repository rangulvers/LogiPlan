// Trucks and dock doors, the pure helpers (docs/WAREHOUSE-DESIGN.md 6.2.6, 6.3.1, 6.3.4, Appendix A.1 and A.5).
// Pure, no DOM, imports only util, defaults.js and ops.js. The simulation (sim/logistics/trucks.js), the validator (validate-ops.js) and the
// inspector all call the same functions, so the numbers a planner reads before a run and the numbers the run uses are one set of formulas.
//
//   conversion        convertToDoors(station)            the ops.trucks block "Add dock doors" writes (6.3.1)
//                     describeTrucks(trucks, opts)       what a block means in trucks and pallets per hour
//                     dockDoorsToast(...)                copy 1 of 7.6
//   the door check    doorCheck(trucks, opts)            Little's law (6.3.4, A.1): doors busy at once, utilisation, the doors to use
//                     doorCheckText(check)               copy 2 of 7.6, built from the same numbers
//                     peakRowsPerHour(rows)              the busiest sliding hour of a timetable
//   the simulation    truckGap, drawPallets, scalePallets, expandScheduleDay, expansionTime
//                                                        the arrival process of rate mode and of a timetable (6.2.6), with the demand slider (5.3)
//
// Every default here that describes real equipment or practice (24 pallets per truck, 5 minutes of check-in, 90 s per pallet at the door) is
// a typical value written from memory and TO VERIFY against supplier or site data before release (R15, definition of done 7): the UI labels
// the results indicative, and every one of them can be overwritten in the inspector.

import { clamp, formatDuration, formatNumber } from '../util/format.js';
import { sampleDist } from '../util/rng.js';
import {
  MAX_SCHEDULE_ROWS, SECONDS_PER_DAY, TRUCK_DEFAULTS, TRUCK_RANGES, defaultTrucks, sanitizeOps,
} from './ops.js';

// ---------------------------------------------------------------------------------------------------------
// Constants (named, so that tests and copy refer to them rather than to numbers)
// ---------------------------------------------------------------------------------------------------------

/** Pallets on a truck when a Goods in is converted and by default for a Goods out: the euro pallet, 24 per truck (question 4). TO VERIFY. */
export const PALLETS_PER_TRUCK = 24;
/** A converted Goods in never receives trucks more often than this (s); the pallets per truck rise instead (6.3.1). */
export const MIN_TRUCK_GAP = 600;
/** A new Goods out: one truck every 30 minutes (6.3.1), so 48 pallets an hour. */
export const OUT_TRUCK_GAP = 1800;
/** Seconds per pallet a truck holds a door, assumed until a run has measured it (6.3.4). Doors and forklifts are traded together: the vehicles set it. TO VERIFY. */
export const ASSUMED_UNLOAD_PER_PALLET = 90;
/** "Use N doors" proposes the fewest doors that would be busy at most this share of the time (the insight `doors-bottleneck` uses the same 85 %). */
export const DOOR_TARGET_UTILISATION = 0.85;
/** The door check calls the doors too few from this utilisation upwards: the queue at the gate grows without bound well before 100 % (A.1: 5 doors at 98 %). */
export const DOORS_TOO_FEW_UTILISATION = 0.95;
/** The length of the "sliding hour" in which a timetable is searched for its peak (s). */
export const PEAK_WINDOW = 3600;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const finite = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const [PALLETS_MIN, PALLETS_MAX] = TRUCK_RANGES.palletsMean;
const [GAP_MIN, GAP_MAX] = TRUCK_RANGES.interArrivalMean;
const [DOORS_MIN, DOORS_MAX] = TRUCK_RANGES.doors;

// ---------------------------------------------------------------------------------------------------------
// 6.3.1: Add dock doors
// ---------------------------------------------------------------------------------------------------------

/** Pallets an hour a legacy Goods in makes: `batch` loads every `interArrival.mean` seconds. 0 when its parameters are unusable. */
export function legacyPalletsPerHour(params) {
  const mean = finite(params && params.interArrival && params.interArrival.mean, 0);
  const batch = finite(params && params.batch, 1);
  return mean > 0 && batch > 0 ? (batch * 3600) / mean : 0;
}

/**
 * The `ops.trucks` block that "Add dock doors" writes (6.3.1), ready for `updateStation(layout, id, { ops: { trucks: block } })`.
 *
 * Goods in ('source'): the plant's load stays unchanged, so the planner sees only the effect of bunching. With `params.interArrival.mean = g`
 * seconds and `params.batch = b`: P = 24 pallets per truck and a mean gap of P x g / b (the kind and the spread of the old distribution are
 * kept), 2 doors, check-in and check-out 300 s. The gap is never below 600 s: a plant that makes a pallet every 20 s would need a truck
 * every 480 s, so the gap stays 600 s and P is raised to the next whole pallet that keeps the rate (P = ceil(600 x b / g), gap = P x g / b).
 * The pallet rate P / gap equals b / g exactly except where the block's own limits bite (at most 200 pallets per truck, a gap of 60 to
 * 1,000,000 s, at least one pallet; a gap above that lowers P instead): `describeTrucks` shows the rate that results. The old `params` stay as they are, so "Remove trucks" goes back.
 *
 * Goods out ('sink') has no existing rate: 24 pallets every 30 minutes (48 an hour), 2 doors, check-in and check-out 300 s, staging 4 per
 * door, a truck waits at most 3,600 s for its pallets. Any other type has no doors: null.
 *
 * Options (what the screen knows and this pure function does not; the button passes them, see ui/guidance-ops.js addDockDoors):
 *  * `shippedPerHour` (Goods out): the pallets an hour that reached the Goods out in the last run. A plant that ships 20 an hour gets trucks that carry
 *    exactly that (24 pallets every 72 minutes, the same floor of 10 minutes between trucks as for a Goods in) instead of the default 48 an hour,
 *    which would leave every truck short: the load of the plant stays unchanged, as for a Goods in. Without a run the default stands.
 *    (A `docks` option that took the doors down to the number of road cells was tried and dropped: on the Starter, with one dock, one door means
 *    that the 10 minutes of check-in and check-out are dead time for the dock, and the single door saturates (gate queue of an hour, `doors-bottleneck`)
 *    where two doors run with an empty gate. The warning `doors-exceed-docks` is the milder message and says what the second door does.)
 *
 * @param {{ type: string, params?: object }|object|string} station a layout station; or the type name when `params` follows; or the `params` of a
 *   Goods in on their own (then the type is 'source', or the type name given as the second argument)
 * @param {object|string} [params] the station's `params` when the first argument is a type name; when the first argument is a station, an options object
 * @param {{ shippedPerHour?: number }} [options]
 * @returns {object|null} a sanitized trucks block, or null for a type that cannot have doors
 */
export function convertToDoors(station, params, options) {
  let type;
  let p;
  let opts = isObj(options) ? options : null;
  if (typeof station === 'string') { // (type, params, options)
    type = station;
    p = params;
  } else if (isObj(station) && Object.hasOwn(station, 'type')) { // (station, options)
    type = station.type;
    p = station.params;
    if (opts === null && isObj(params)) opts = params;
  } else if (isObj(station)) { // (params) of a Goods in, or (params, type)
    type = typeof params === 'string' ? params : 'source';
    p = station;
  }
  if (type !== 'source' && type !== 'sink') return null;
  const block = defaultTrucks();
  const shipped = opts ? finite(opts.shippedPerHour, 0) : 0;
  if (type === 'sink') {
    block.interArrival.mean = OUT_TRUCK_GAP;
    if (shipped > 0) {
      let pallets = PALLETS_PER_TRUCK;
      let gap = (pallets * 3600) / shipped;
      if (gap < MIN_TRUCK_GAP) {
        pallets = Math.min(PALLETS_MAX, Math.ceil((MIN_TRUCK_GAP * shipped) / 3600 - 1e-9));
        gap = (pallets * 3600) / shipped;
      } else if (gap > GAP_MAX) {
        pallets = Math.max(PALLETS_MIN, Math.floor((GAP_MAX * shipped) / 3600));
        gap = (pallets * 3600) / shipped;
      }
      block.pallets.mean = pallets;
      block.interArrival.mean = clamp(gap, GAP_MIN, GAP_MAX);
    }
  } else {
    const old = isObj(p) && isObj(p.interArrival) ? p.interArrival : {};
    const g = finite(old.mean, 0);
    const b = Math.max(1, Math.round(finite(p && p.batch, 1)));
    if (g > 0) {
      let pallets = PALLETS_PER_TRUCK;
      let gap = (pallets * g) / b;
      if (gap < MIN_TRUCK_GAP) {
        pallets = Math.min(PALLETS_MAX, Math.ceil((MIN_TRUCK_GAP * b) / g - 1e-9));
        gap = (pallets * g) / b; // at least MIN_TRUCK_GAP, unless the 200 pallets of a full truck cap P first
      } else if (gap > GAP_MAX) { // a pallet every few days: fewer pallets per truck, not a gap the block cannot hold
        pallets = Math.max(PALLETS_MIN, Math.floor((GAP_MAX * b) / g));
        gap = (pallets * g) / b;
      }
      block.pallets.mean = pallets;
      block.interArrival = { kind: old.kind || block.interArrival.kind, mean: clamp(gap, GAP_MIN, GAP_MAX), spread: finite(old.spread, block.interArrival.spread) };
    }
  }
  return sanitizeOps(type, { trucks: block }).trucks;
}

/**
 * What a trucks block means in trucks and pallets, for the toast, the inspector and the tests. `demandFactor` is the slider of the plant:
 * in rate mode it scales the truck frequency, in schedule mode the pallets per truck (appointments do not move), 5.3.
 * @param {object} trucks a sanitized `ops.trucks` block
 * @param {{ demandFactor?: number }} [opts]
 * @returns {{ mode: string, doors: number, palletsPerTruck: number, gapSeconds: number|null, trucksPerHour: number, palletsPerHour: number, rows: number }}
 *   `gapSeconds`: the mean time between trucks (rate mode, otherwise null); `trucksPerHour` and `palletsPerHour`: the average over the day
 *   (a timetable: its rows per 24 h); `rows`: timetable rows (0 in rate mode)
 */
export function describeTrucks(trucks, opts = {}) {
  const f = demandOf(opts);
  const t = isObj(trucks) ? trucks : defaultTrucks();
  const doors = finite(t.doors, TRUCK_DEFAULTS.doors);
  if (t.mode === 'schedule') {
    const rows = Array.isArray(t.schedule) ? t.schedule : [];
    const palletsPerTruck = meanRowPallets(t, f);
    const trucksPerDay = rows.length;
    return {
      mode: 'schedule', doors, palletsPerTruck, gapSeconds: null, rows: rows.length,
      trucksPerHour: trucksPerDay / 24, palletsPerHour: (trucksPerDay * palletsPerTruck) / 24,
    };
  }
  const gap = finite(t.interArrival && t.interArrival.mean, TRUCK_DEFAULTS.interArrival.mean);
  const palletsPerTruck = finite(t.pallets && t.pallets.mean, TRUCK_DEFAULTS.pallets.mean);
  const trucksPerHour = f > 0 && gap > 0 ? (3600 / gap) * f : 0;
  return { mode: 'rate', doors, palletsPerTruck, gapSeconds: gap, rows: 0, trucksPerHour, palletsPerHour: trucksPerHour * palletsPerTruck };
}

const count = (n, one, many) => `${n} ${Number(n) === 1 ? one : many}`;
/** 24 -> "24", 1.25 -> "1.3", 360000 -> "360,000": one decimal, none when it would be .0. */
const num1 = (n) => formatNumber(n, 1);

/**
 * Copy 1 of 7.6, the toast after "Add dock doors": "{name} now receives trucks: {doors} doors, {pallets} pallets per truck, about one truck
 * every {gap}. That is the same {rate} pallets an hour as before, but they now arrive in bunches." For a Goods out (no `before`) the second
 * sentence names the load the defaults make instead of a "before".
 * @param {{ name: string, type?: string, trucks: object, before?: number, shipped?: number }} info `before`: the pallets an hour of the legacy station
 *   (legacyPalletsPerHour); the sentence says "the same" when the new rate agrees with it to within 1 %, else it names both rates. `shipped`: a Goods
 *   out whose trucks were sized to the pallets an hour the plant shipped in the last run (convertToDoors option); without it the defaults are a guess
 *   and the toast says that the plant may ship less.
 * @returns {string}
 */
export function dockDoorsToast({ name, type = 'source', trucks, before, shipped }) {
  const d = describeTrucks(trucks);
  const head = `${name} now ${type === 'sink' ? 'loads' : 'receives'} trucks: ${count(d.doors, 'door', 'doors')}, ${num1(d.palletsPerTruck)} pallets per truck, about one truck every ${formatDuration(d.gapSeconds)}.`;
  if (type === 'sink' && shipped > 0) {
    return Math.abs(d.palletsPerHour - shipped) <= 0.01 * shipped
      ? `${head} That is the same ${num1(shipped)} pallets an hour that reached it in the last run.`
      : `${head} That is ${num1(d.palletsPerHour)} pallets an hour; ${num1(shipped)} an hour reached it in the last run.`;
  }
  if (type === 'sink') return `${head} That is ${num1(d.palletsPerHour)} pallets an hour: if the plant ships less, trucks leave without a full load.`;
  if (!(before > 0)) return `${head} That is ${num1(d.palletsPerHour)} pallets an hour.`;
  const same = Math.abs(d.palletsPerHour - before) <= 0.01 * before;
  return same
    ? `${head} That is the same ${num1(before)} pallets an hour as before, but they now arrive in bunches.`
    : `${head} That is ${num1(d.palletsPerHour)} pallets an hour instead of ${num1(before)}, and they now arrive in bunches.`;
}

// ---------------------------------------------------------------------------------------------------------
// 6.3.4 and Appendix A.1: the door check
// ---------------------------------------------------------------------------------------------------------

function demandOf(opts) {
  const f = opts && opts.demandFactor;
  return typeof f === 'number' && Number.isFinite(f) && f >= 0 ? f : 1;
}

/**
 * The pallets of a timetable truck after the demand slider: a row's own pallets, else the mean of the `pallets` distribution, times the
 * factor, rounded, at least 1 (`scalePallets`). The mean over all rows (0 when there are none).
 */
function meanRowPallets(trucks, f) {
  const rows = Array.isArray(trucks.schedule) ? trucks.schedule : [];
  if (!rows.length) return 0;
  const fallback = finite(trucks.pallets && trucks.pallets.mean, TRUCK_DEFAULTS.pallets.mean);
  let sum = 0;
  for (const row of rows) sum += scalePallets(row && typeof row.pallets === 'number' ? row.pallets : Math.round(fallback), f);
  return sum / rows.length;
}

/**
 * The largest number of timetable rows in any sliding hour. The timetable repeats every day, so the hour may wrap past midnight (23:40 and
 * 00:20 are 40 minutes apart). A window is half open, [a, a + 3600): rows exactly an hour apart are in different hours.
 * @param {Array<{ at: number }>} rows
 * @returns {number}
 */
export function peakRowsPerHour(rows) {
  const times = (Array.isArray(rows) ? rows : []).map((r) => (r && Number.isFinite(r.at) ? r.at : null)).filter((at) => at !== null).sort((a, b) => a - b);
  const n = times.length;
  if (n === 0) return 0;
  const wrapped = times.concat(times.map((at) => at + SECONDS_PER_DAY));
  let best = 0;
  let end = 0;
  for (let i = 0; i < n; i++) {
    if (end < i) end = i;
    while (end < wrapped.length && wrapped[end] < times[i] + PEAK_WINDOW) end++;
    best = Math.max(best, end - i);
  }
  return Math.min(best, n);
}

/**
 * The door check (6.3.4, A.1): `doorsNeeded = peakTrucksPerHour x doorHours`, `doorHours = (checkIn + pallets x tPallet + checkOut) / 3600`.
 * By Little's law that is the number of doors busy at once at the busiest hour. Rate mode: `3600 / mean(interArrival)` trucks an hour times
 * the demand factor; schedule mode: the most rows in any sliding hour, with the pallets of every truck scaled by the demand factor.
 * `tPallet` is ASSUMED_UNLOAD_PER_PALLET before a run; after one, pass the measured mean time a truck held a door (`measuredDoorSeconds`, from
 * docking to the door being free again, check-in and check-out included) and it replaces the whole `checkIn + pallets x tPallet + checkOut`.
 *
 * The result carries the numbers and the sentence parts the inspector prints. `utilisation` is `needed / doors` (above 1 means the queue at
 * the gate grows without bound); `tooFew` is true from DOORS_TOO_FEW_UTILISATION; `suggestedDoors` is the fewest doors (1..32) that would be
 * busy at most DOOR_TARGET_UTILISATION of the time (4.9 needed: 6 doors, 82 %).
 *
 * @param {object} trucks a sanitized `ops.trucks` block
 * @param {{ demandFactor?: number, tPallet?: number, measuredDoorSeconds?: number|null }} [opts]
 * @returns {{
 *   mode: 'rate'|'schedule', empty: boolean, doors: number, trucksPerHour: number, pallets: number, tPallet: number|null,
 *   basis: 'assumed'|'measured', checkIn: number, checkOut: number, doorSeconds: number, doorHours: number, needed: number,
 *   utilisation: number, tooFew: boolean, suggestedDoors: number, suggestedUtilisation: number,
 *   parts: Record<string, string>, sentences: string[], text: string, action: null|{ label: string, doors: number }
 * }} `empty`: no truck ever arrives (an empty timetable, a demand factor of 0), `needed` is 0; `action`: the "Use N doors" button, or null
 *   when the doors are enough
 */
export function doorCheck(trucks, opts = {}) {
  const t = isObj(trucks) ? trucks : defaultTrucks();
  const f = demandOf(opts);
  const doors = clamp(Math.round(finite(t.doors, TRUCK_DEFAULTS.doors)), DOORS_MIN, DOORS_MAX);
  const checkIn = finite(t.checkIn, TRUCK_DEFAULTS.checkIn);
  const checkOut = finite(t.checkOut, TRUCK_DEFAULTS.checkOut);
  const schedule = t.mode === 'schedule';
  const rows = schedule && Array.isArray(t.schedule) ? t.schedule : [];
  const gap = finite(t.interArrival && t.interArrival.mean, TRUCK_DEFAULTS.interArrival.mean);

  let trucksPerHour;
  let pallets;
  if (schedule) {
    trucksPerHour = peakRowsPerHour(rows);
    pallets = meanRowPallets(t, f);
  } else {
    trucksPerHour = f > 0 && gap > 0 ? (3600 / gap) * f : 0;
    pallets = finite(t.pallets && t.pallets.mean, TRUCK_DEFAULTS.pallets.mean);
  }
  const measured = opts.measuredDoorSeconds;
  const useMeasured = typeof measured === 'number' && Number.isFinite(measured) && measured > 0;
  const given = opts.tPallet;
  const assumed = typeof given === 'number' && Number.isFinite(given) && given > 0 ? given : ASSUMED_UNLOAD_PER_PALLET;
  const doorSeconds = useMeasured ? measured : checkIn + pallets * assumed + checkOut;
  const tPallet = useMeasured ? (pallets > 0 && measured > checkIn + checkOut ? (measured - checkIn - checkOut) / pallets : null) : assumed;
  const doorHours = doorSeconds / 3600;
  const needed = trucksPerHour * doorHours;
  const empty = trucksPerHour === 0 || pallets === 0;
  const utilisation = needed / doors;
  const suggestedDoors = clamp(Math.ceil(needed / DOOR_TARGET_UTILISATION - 1e-9), DOORS_MIN, DOORS_MAX);
  const suggestedUtilisation = needed / suggestedDoors;
  const tooFew = !empty && utilisation > DOORS_TOO_FEW_UTILISATION;

  const check = {
    mode: schedule ? 'schedule' : 'rate', empty, doors, trucksPerHour, pallets, tPallet, basis: useMeasured ? 'measured' : 'assumed',
    checkIn, checkOut, doorSeconds, doorHours, needed, utilisation, tooFew, suggestedDoors, suggestedUtilisation,
    action: tooFew && suggestedDoors > doors ? { label: `Use ${suggestedDoors} doors`, doors: suggestedDoors } : null,
  };
  return { ...check, ...doorCheckText(check) };
}

/** Number of trucks an hour: whole when 10 or more ("12"), else one decimal without a trailing ".0" ("6", "1.3"). */
const trucksText = (n) => (n >= 10 ? String(Math.round(n)) : num1(n));

/**
 * Copy 2 of 7.6, built from a door check (the fields `doorCheck` fills before it adds the text): the parts as strings, the sentences, and the
 * whole paragraph. "At the busiest hour you need about 4.9 doors busy at once (6 trucks an hour, 49 minutes at a door each). You have 4
 * doors, so trucks will queue at the gate. 6 doors would be busy 82 % of the time. Door time includes waiting for forklifts, so more
 * forklifts shorten it. Estimated from 90 s per pallet; Results shows the real figure after a run."
 * @param {object} check
 * @returns {{ parts: Record<string, string>, sentences: string[], text: string }}
 */
export function doorCheckText(check) {
  const parts = {
    need: num1(check.needed),
    trucks: trucksText(check.trucksPerHour),
    minutes: String(Math.round(check.doorSeconds / 60)),
    doors: String(check.doors),
    utilNow: String(Math.round(check.utilisation * 100)),
    better: String(check.suggestedDoors),
    util: String(Math.round(check.suggestedUtilisation * 100)),
    pallets: num1(check.pallets),
    tPallet: check.tPallet === null ? '' : String(Math.round(check.tPallet)),
  };
  const doorsHave = count(check.doors, 'door', 'doors');
  const sentences = [];
  if (check.empty) {
    sentences.push('No truck arrives, so no door is needed.');
  } else {
    sentences.push(`At the busiest hour you need about ${parts.need} ${parts.need === '1' ? 'door' : 'doors'} busy at once (${count(parts.trucks, 'truck', 'trucks')} an hour, ${count(parts.minutes, 'minute', 'minutes')} at a door each).`);
    if (check.tooFew) {
      sentences.push(`You have ${doorsHave}, so trucks will queue at the gate.`);
      if (check.suggestedDoors > check.doors) sentences.push(`${count(parts.better, 'door', 'doors')} would be busy ${parts.util} % of the time.`);
    } else {
      sentences.push(`You have ${doorsHave}, busy about ${parts.utilNow} % of the time.`);
    }
    sentences.push('Door time includes waiting for forklifts, so more forklifts shorten it.');
    sentences.push(check.basis === 'measured'
      ? `Measured in the last run: a truck held a door for ${count(parts.minutes, 'minute', 'minutes')} on average.`
      : `Estimated from ${parts.tPallet} s per pallet; Results shows the real figure after a run.`);
  }
  return { parts, sentences, text: sentences.join(' ') };
}

// ---------------------------------------------------------------------------------------------------------
// 5.3 and 6.2.6: the arrival process, for the simulation
// ---------------------------------------------------------------------------------------------------------

/**
 * Pallets of a truck after the demand slider (schedule mode: appointments do not move, the trucks get bigger or smaller): rounded, at least
 * 1; a factor of 0 (or below) means no truck, 0.
 * @param {number} pallets pallets of the row (or the draw)
 * @param {number} demandFactor `settings.demandFactor`
 */
export function scalePallets(pallets, demandFactor) {
  if (!(demandFactor > 0)) return 0;
  return Math.max(1, Math.round(pallets * demandFactor));
}

/** One draw of the pallets of a truck from a `pallets` distribution: rounded, kept in 1..200. Consumes the draws `sampleDist` consumes. */
export function drawPallets(rng, dist) {
  return clamp(Math.round(sampleDist(rng, dist)), PALLETS_MIN, PALLETS_MAX);
}

/**
 * Rate mode: the time to the next truck, `sampleDist(rng, interArrival, 1 / demandFactor)` like a Goods in does for its pallets (the demand
 * slider scales the frequency, in both directions); Infinity when the factor is 0 or below (no truck arrives).
 */
export function truckGap(rng, trucks, demandFactor) {
  if (!(demandFactor > 0)) return Infinity;
  return sampleDist(rng, trucks.interArrival, 1 / demandFactor);
}

/**
 * The simulation time at which clock day `dayIndex` has to be expanded (`expandScheduleDay`): its midnight less the jitter (a truck of its
 * first hour may come early), never before 0. Expand day 0 at time 0, day k when the clock reaches `expansionTime(trucks, clock, k)`.
 * @param {object} trucks
 * @param {{ dayStart(k: number): number }} clock from makeClock
 * @param {number} dayIndex
 */
export function expansionTime(trucks, clock, dayIndex) {
  return Math.max(0, clock.dayStart(dayIndex) - finite(trucks.jitter, 0));
}

/**
 * Timetable mode, 6.2.6: the arrivals of one clock day, as simulation times, sorted (equal times keep the order of the rows).
 *
 * A row is a time of day `at`; on clock day `k` it falls at `t = k x 86400 + at - clock.startTod`. A row whose `t` is before the start of
 * the run (day 0, `at` earlier than `startTod`) is in the past and does not exist. Per row, in row order, the station's truck stream `rng`
 * is drawn in this order and only as far as the settings need it: (1) `noShow > 0`: `rng.next() < noShow` makes the row a no-show (it stays
 * in the list with `noShow: true`, at its nominal time, so that the run can count it then, and draws nothing more); (2) `jitter > 0`:
 * `t += rng.range(-jitter, +jitter)`, never before 0; (3) a row without `pallets` draws them with `drawPallets(rng, trucks.pallets)`.
 * The pallets are NOT scaled by the demand slider here: it can move at any time, so the run applies `scalePallets` when the truck arrives.
 *
 * Call it once per clock day, in increasing order, at `expansionTime(...)`; a jittered truck may arrive before an earlier day's last one,
 * so the run merges the lists by `at`. Pure given `rng`.
 *
 * @param {object} trucks a sanitized `ops.trucks` block (reads schedule, noShow, jitter, pallets)
 * @param {{ startTod: number }} clock from makeClock(layout.calendar)
 * @param {number} dayIndex the clock day, 0 = the day the run starts on
 * @param {{ next(): number, range(lo: number, hi: number): number }} rng
 * @returns {Array<{ at: number, pallets: number, noShow: boolean, row: number }>} `row`: index in the timetable
 */
export function expandScheduleDay(trucks, clock, dayIndex, rng) {
  const rows = Array.isArray(trucks.schedule) ? trucks.schedule : [];
  const noShow = finite(trucks.noShow, 0);
  const jitter = finite(trucks.jitter, 0);
  const base = dayIndex * SECONDS_PER_DAY - finite(clock && clock.startTod, 0);
  const due = [];
  for (let i = 0; i < Math.min(rows.length, MAX_SCHEDULE_ROWS); i++) {
    const row = rows[i];
    const nominal = base + row.at;
    if (nominal < 0) continue;
    if (noShow > 0 && rng.next() < noShow) {
      due.push({ at: nominal, pallets: 0, noShow: true, row: i });
      continue;
    }
    const at = jitter > 0 ? Math.max(0, nominal + rng.range(-jitter, jitter)) : nominal;
    const pallets = typeof row.pallets === 'number' ? row.pallets : drawPallets(rng, trucks.pallets);
    due.push({ at, pallets, noShow: false, row: i });
  }
  return due.sort((a, b) => a.at - b.at); // Array#sort is stable
}
