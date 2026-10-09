// Milestone M1 of the warehouse module, the pure helpers of js/model/doors.js and the clock of js/model/calendar.js:
//   A1.6   the door check reproduces Appendix A.1 (6 trucks an hour, 26 pallets, 90 s: 4.9 doors; 5 doors at 98 %, 6 doors at 82 %)
//   A1.10  "Add dock doors" keeps the pallet rate: Starter (180 s, batch 1) gives 24 pallets every 72 min, a 600 s floor raises the pallets
//   plus the helpers the simulation needs (6.2.1 clock, 6.2.6 timetable expansion, 5.3 demand slider) and the copy of 7.6 numbers 1 and 2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as L from '../js/model/layout.js';
import { EXAMPLES } from '../js/model/examples.js';
import {
  ASSUMED_UNLOAD_PER_PALLET, DOORS_TOO_FEW_UTILISATION, DOOR_TARGET_UTILISATION, MIN_TRUCK_GAP, OUT_TRUCK_GAP, PALLETS_PER_TRUCK, PEAK_WINDOW,
  convertToDoors, describeTrucks, dockDoorsToast, doorCheck, doorCheckText, drawPallets, expandScheduleDay, expansionTime, legacyPalletsPerHour, peakRowsPerHour,
  scalePallets, truckGap,
} from '../js/model/doors.js';
import { DAY_NAMES_LONG, formatTimeOfDay, makeClock } from '../js/model/calendar.js';
import { defaultTrucks, sanitizeOps, trucksOf } from '../js/model/ops.js';
import { createRng, sampleDist } from '../js/util/rng.js';

const bytes = (v) => JSON.stringify(v);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} is not ${b}`);
const exampleStation = (id, type, index = 0) => EXAMPLES.find((e) => e.id === id).build().stations.filter((s) => s.type === type)[index];

/** A trucks block with the given fields (sanitized). */
const trucks = (patch) => sanitizeOps('source', { trucks: patch }).trucks;
/** Rate mode with a constant time between trucks and a constant number of pallets: the arithmetic of the examples is exact. */
const constant = (gap, pallets, rest = {}) => trucks({ interArrival: { kind: 'const', mean: gap, spread: 0 }, pallets: { kind: 'const', mean: pallets, spread: 0 }, ...rest });

// ---------------------------------------------------------------------------------------------------------------------------
// A1.10: Add dock doors (6.3.1, Appendix A.5)
// ---------------------------------------------------------------------------------------------------------------------------

test('A1.10 the constants are those of 6.3.1 and 6.3.4', () => {
  assert.equal(PALLETS_PER_TRUCK, 24);
  assert.equal(MIN_TRUCK_GAP, 600);
  assert.equal(OUT_TRUCK_GAP, 1800);
  assert.equal(ASSUMED_UNLOAD_PER_PALLET, 90);
  assert.equal(DOOR_TARGET_UTILISATION, 0.85);
  assert.equal(DOORS_TOO_FEW_UTILISATION, 0.95);
  assert.equal(PEAK_WINDOW, 3600);
});

test('A1.10 Starter (a pallet every 180 s, batch 1) becomes 24 pallets every 72 minutes: the same 20 pallets an hour, kind and spread of the old distribution kept', () => {
  const station = exampleStation('starter', 'source');
  assert.deepEqual(station.params.interArrival, { kind: 'normal', mean: 180, spread: 0.15 });
  const block = convertToDoors(station);
  assert.equal(block.pallets.mean, 24);
  assert.deepEqual(block.interArrival, { kind: 'normal', mean: 4320, spread: 0.15 });
  assert.equal(block.interArrival.mean / 60, 72);
  assert.deepEqual([block.doors, block.checkIn, block.checkOut, block.mode, block.jitter, block.noShow, block.staging, block.maxDwell], [2, 300, 300, 'rate', 0, 0, 4, 3600]);
  assert.deepEqual(block.schedule, []);
  assert.equal(bytes(sanitizeOps('source', { trucks: block }).trucks), bytes(block), 'a fixed point of the sanitizer');
  const d = describeTrucks(block);
  assert.deepEqual([d.mode, d.doors, d.palletsPerTruck, d.gapSeconds], ['rate', 2, 24, 4320]);
  near(d.trucksPerHour, 3600 / 4320);
  near(d.palletsPerHour, 20);
  near(d.palletsPerHour, legacyPalletsPerHour(station.params));
});

test('A1.10 Appendix A.5: the Congestion lab (4 pallets every 400 s) becomes 24 pallets every 40 minutes, 36 an hour; Two lines keeps its 63 an hour', () => {
  const lab = exampleStation('congestion-lab', 'source');
  assert.equal(lab.params.batch, 4);
  const block = convertToDoors(lab);
  assert.deepEqual([block.pallets.mean, block.interArrival.mean, block.interArrival.kind, block.interArrival.spread], [24, 2400, 'normal', 0.15]);
  near(describeTrucks(block).palletsPerHour, 36);
  const two = exampleStation('two-lines', 'source');
  const b2 = convertToDoors(two);
  assert.deepEqual([b2.pallets.mean, b2.interArrival.mean, b2.interArrival.spread], [24, 24 * 57, 0.2]);
  near(describeTrucks(b2).palletsPerHour, legacyPalletsPerHour(two.params));
});

test('A1.10 a gap of 600 s is the floor: below it the pallets per truck rise instead and the pallet rate stays exactly the same', () => {
  const source = (g, b = 1, extra = {}) => ({ type: 'source', params: { interArrival: { kind: 'normal', mean: g, spread: 0.1, ...extra }, batch: b } });
  assert.deepEqual([convertToDoors(source(25)).pallets.mean, convertToDoors(source(25)).interArrival.mean], [24, 600], 'exactly 600 s: nothing to raise');
  const raised = convertToDoors(source(20));
  assert.deepEqual([raised.pallets.mean, raised.interArrival.mean], [30, 600], 'a pallet every 20 s: 30 pallets every 10 minutes');
  const odd = convertToDoors(source(24.5));
  assert.equal(odd.pallets.mean, 25);
  near(odd.interArrival.mean, 612.5);
  const rng = createRng(6);
  let floored = 0;
  let capped = 0;
  for (let i = 0; i < 3000; i++) {
    const g = i < 1500 ? 0.5 + rng.next() * 1500 : 1 + rng.int(1e6);
    const b = 1 + rng.int(i % 5 === 0 ? 60 : 6);
    const kind = rng.pick(['const', 'normal', 'uniform', 'exp']);
    const spread = rng.pick([0, 0.1, 0.5, 1]);
    const block = convertToDoors({ type: 'source', params: { interArrival: { kind, mean: g, spread }, batch: b } });
    assert.equal(bytes(sanitizeOps('source', { trucks: block }).trucks), bytes(block), `g ${g} b ${b}: valid`);
    assert.equal(block.interArrival.kind, kind);
    assert.equal(block.interArrival.spread, spread);
    const p = block.pallets.mean;
    const gap = block.interArrival.mean;
    assert.ok(Number.isInteger(p) && p >= 1 && p <= 200, `g ${g} b ${b}: pallets ${p}`);
    const wanted = b / g; // pallets per second
    if (p === 200 && gap < MIN_TRUCK_GAP) {
      capped++; // the 200 pallets of a full truck: the floor of 600 s cannot be kept (a station that makes more than a pallet every 3 s)
      assert.ok(gap >= 60);
      if (gap > 60) near(p / gap, wanted, 1e-9); // still the same rate, unless the gap hit the 60 s the block allows
      continue;
    }
    assert.ok(gap >= MIN_TRUCK_GAP - 1e-9 || p === 200, `g ${g} b ${b}: gap ${gap} is below the floor`);
    if (gap >= MIN_TRUCK_GAP - 1e-9 && g * 24 / b < MIN_TRUCK_GAP) floored++;
    near(p / gap, wanted, 1e-9);
    if (g * 24 / b >= MIN_TRUCK_GAP && g * 24 / b <= 1e6) assert.equal(p, 24, `g ${g} b ${b}: a plant that needs no floor gets 24 pallets`);
  }
  assert.ok(floored > 200 && capped > 0, `the table exercised the floor (${floored}) and the cap (${capped})`);
});

test('A1.10 a pallet every few days: the gap would exceed what the block holds, so the pallets per truck fall instead (the rate is kept)', () => {
  const block = convertToDoors({ type: 'source', params: { interArrival: { kind: 'const', mean: 1e6, spread: 0 }, batch: 1 } });
  assert.deepEqual([block.pallets.mean, block.interArrival.mean], [1, 1e6]);
  const two = convertToDoors({ type: 'source', params: { interArrival: { kind: 'const', mean: 300000, spread: 0 }, batch: 1 } });
  near(describeTrucks(two).palletsPerHour, 3600 / 300000);
});

test('A1.10 a Goods out has no rate to keep: 24 pallets every 30 minutes (48 an hour), 2 doors, staging 4, a truck waits at most 3,600 s', () => {
  const block = convertToDoors(exampleStation('starter', 'sink'));
  assert.deepEqual([block.doors, block.checkIn, block.checkOut, block.mode, block.staging, block.maxDwell], [2, 300, 300, 'rate', 4, 3600]);
  assert.deepEqual([block.pallets.mean, block.interArrival.mean], [24, 1800]);
  near(describeTrucks(block).palletsPerHour, 48);
  assert.equal(bytes(convertToDoors('sink')), bytes(convertToDoors({ type: 'sink', params: { anything: 1 } })));
  assert.equal(bytes(sanitizeOps('sink', { trucks: block }).trucks), bytes(block));
});

test('A1.10 convertToDoors: other station types have no doors; junk parameters give the defaults; the arguments are never modified; the old parameters stay', () => {
  for (const type of ['process', 'storage', 'depot', 'x', undefined, null]) assert.equal(convertToDoors({ type, params: {} }), null);
  assert.equal(convertToDoors(null), null);
  assert.equal(convertToDoors(undefined), null);
  assert.equal(convertToDoors('process', {}), null);
  for (const params of [undefined, null, {}, { interArrival: null }, { interArrival: 'x', batch: 'y' }, { interArrival: { mean: 0 } }, { interArrival: { mean: -5, kind: 'normal' } }, { batch: 0, interArrival: { mean: NaN } }]) {
    const block = convertToDoors({ type: 'source', params });
    assert.equal(bytes(block), bytes(defaultTrucks()), bytes(params));
  }
  assert.equal(convertToDoors('source', { interArrival: { kind: 'exp', mean: 180, spread: 0.3 }, batch: 1 }).interArrival.kind, 'exp', 'the type name and the params as two arguments');
  const bare = { interArrival: { kind: 'exp', mean: 180, spread: 0.3 }, batch: 1 };
  assert.equal(bytes(convertToDoors(bare)), bytes(convertToDoors('source', bare)), 'the params of a Goods in on their own');
  assert.equal(bytes(convertToDoors(bare, 'sink')), bytes(convertToDoors('sink')), 'or with the type name second');
  assert.equal(bytes(convertToDoors({})), bytes(defaultTrucks()), 'an empty object is the params of a Goods in with nothing to keep');
  const station = exampleStation('two-lines', 'source');
  const before = bytes(station);
  convertToDoors(station);
  assert.equal(bytes(station), before);
  const layout = EXAMPLES[0].build();
  const source = layout.stations.find((s) => s.type === 'source');
  const params = bytes(source.params);
  assert.equal(L.updateStation(layout, source.id, { ops: { trucks: convertToDoors(source) } }), true);
  assert.equal(bytes(source.params), params, 'params.interArrival and params.batch stay, so "Remove trucks" goes back (6.3.1)');
  assert.equal(layout.schema, 2);
  assert.deepEqual(L.checkInvariants(layout), []);
  assert.equal(L.updateStation(layout, source.id, { ops: null }), true);
  assert.equal(bytes(layout), bytes(EXAMPLES[0].build()), 'Remove trucks: the legacy plant again, byte for byte');
});

test('7.6 number 1: the toast after "Add dock doors" (the Starter example sentence word for word)', () => {
  const source = exampleStation('starter', 'source');
  const text = dockDoorsToast({ name: 'Goods receiving', trucks: convertToDoors(source), before: legacyPalletsPerHour(source.params) });
  assert.equal(text, 'Goods receiving now receives trucks: 2 doors, 24 pallets per truck, about one truck every 72 min. That is the same 20 pallets an hour as before, but they now arrive in bunches.');
  assert.match(dockDoorsToast({ name: 'Dispatch', type: 'sink', trucks: convertToDoors('sink') }), /^Dispatch now loads trucks: 2 doors, 24 pallets per truck, about one truck every 30 min\. That is 48 pallets an hour\.$/);
  const capped = convertToDoors({ type: 'source', params: { interArrival: { kind: 'const', mean: 0.5, spread: 0 }, batch: 50 } });
  assert.match(dockDoorsToast({ name: 'X', trucks: capped, before: 360000 }), /instead of 360,000, and they now arrive in bunches\.$/);
  assert.match(dockDoorsToast({ name: 'X', trucks: convertToDoors('source', {}), before: 0 }), /That is 32 pallets an hour\.$/);
  assert.match(dockDoorsToast({ name: 'Y', trucks: trucks({ doors: 1 }), before: 1 }), /1 door,/, 'singular');
});

// ---------------------------------------------------------------------------------------------------------------------------
// A1.6: the door check (6.3.4, Appendix A.1)
// ---------------------------------------------------------------------------------------------------------------------------

/** Appendix A.1: 6 trucks an hour of 26 pallets, check-in and check-out 300 s, 90 s per pallet. */
const appendixA = (doors) => constant(600, 26, { doors });

test('A1.6 Appendix A.1: 6 trucks an hour of 26 pallets at 90 s need 4.9 doors; 5 doors run at 98 %, 6 doors at 82 %', () => {
  const four = doorCheck(appendixA(4));
  assert.equal(four.mode, 'rate');
  assert.equal(four.trucksPerHour, 6);
  assert.equal(four.pallets, 26);
  assert.equal(four.tPallet, 90);
  assert.equal(four.basis, 'assumed');
  assert.equal(four.doorSeconds, 300 + 26 * 90 + 300, '49 minutes');
  near(four.doorHours, 2940 / 3600);
  near(four.needed, 4.9);
  near(four.utilisation, 4.9 / 4);
  assert.equal(four.tooFew, true);
  assert.equal(four.suggestedDoors, 6, '"Use 6 doors"');
  assert.deepEqual(four.action, { label: 'Use 6 doors', doors: 6 });
  near(four.suggestedUtilisation, 0.8167, 1e-3);
  const five = doorCheck(appendixA(5));
  near(five.utilisation, 0.98);
  assert.equal(five.tooFew, true, 'the gate queue explodes at 98 %');
  assert.equal(Math.round(five.utilisation * 100), 98);
  const six = doorCheck(appendixA(6));
  assert.equal(Math.round(six.utilisation * 100), 82);
  assert.equal(six.tooFew, false);
  assert.equal(six.action, null);
  assert.equal(six.suggestedDoors, 6);
  // the numbers of the sentence
  assert.deepEqual([four.parts.need, four.parts.trucks, four.parts.minutes, four.parts.doors, four.parts.better, four.parts.util, four.parts.tPallet], ['4.9', '6', '49', '4', '6', '82', '90']);
});

test('7.6 number 2: the sentence of the door check, word for word for the example of the design (4 doors) and for 6 doors', () => {
  assert.equal(doorCheck(appendixA(4)).text, 'At the busiest hour you need about 4.9 doors busy at once (6 trucks an hour, 49 minutes at a door each). You have 4 doors, so trucks will queue at the gate. '
    + '6 doors would be busy 82 % of the time. Door time includes waiting for forklifts, so more forklifts shorten it. Estimated from 90 s per pallet; Results shows the real figure after a run.');
  assert.equal(doorCheck(appendixA(6)).text, 'At the busiest hour you need about 4.9 doors busy at once (6 trucks an hour, 49 minutes at a door each). You have 6 doors, busy about 82 % of the time. '
    + 'Door time includes waiting for forklifts, so more forklifts shorten it. Estimated from 90 s per pallet; Results shows the real figure after a run.');
  const one = doorCheck(constant(3600, 2, { doors: 1, checkIn: 0, checkOut: 0 }));
  assert.match(one.text, /^At the busiest hour you need about 0\.1 doors busy at once \(1 truck an hour, 3 minutes at a door each\)\. You have 1 door, busy about 5 % of the time\./);
  assert.deepEqual(doorCheck(appendixA(4)).sentences.length, 5);
  assert.equal(doorCheckText(doorCheck(appendixA(4))).text, doorCheck(appendixA(4)).text, 'the text builder gives the same paragraph');
});

test('A1.6 the measured door time of a run replaces the assumption: the formula uses it whole, and the sentence says so', () => {
  const check = doorCheck(appendixA(4), { measuredDoorSeconds: 1800 });
  assert.equal(check.basis, 'measured');
  assert.equal(check.doorSeconds, 1800);
  near(check.needed, 3);
  assert.equal(check.tooFew, false);
  near(check.tPallet, (1800 - 600) / 26, 1e-9);
  assert.match(check.text, /30 minutes at a door each/);
  assert.match(check.text, /Measured in the last run: a truck held a door for 30 minutes on average\.$/);
  assert.doesNotMatch(check.text, /Estimated from/);
  for (const bad of [0, -5, NaN, null, undefined, '1800', Infinity]) assert.equal(doorCheck(appendixA(4), { measuredDoorSeconds: bad }).basis, 'assumed', String(bad));
  assert.equal(doorCheck(appendixA(4), { tPallet: 60 }).doorSeconds, 300 + 26 * 60 + 300, 'a different assumption can be given');
  assert.equal(doorCheck(appendixA(4), { tPallet: 0 }).tPallet, 90);
  const odd = doorCheck(appendixA(4), { measuredDoorSeconds: 400 });
  assert.equal(odd.tPallet, null, 'a door time shorter than check-in plus check-out leaves no pallet time');
  assert.doesNotThrow(() => odd.text);
});

test('A1.6 peak trucks per hour in schedule mode is the largest number of rows in any sliding hour (cyclic, half open)', () => {
  const rows = (...times) => times.map((t) => ({ at: typeof t === 'string' ? Number(t.slice(0, 2)) * 3600 + Number(t.slice(3)) * 60 : t }));
  assert.equal(peakRowsPerHour([]), 0);
  assert.equal(peakRowsPerHour(undefined), 0);
  assert.equal(peakRowsPerHour(rows('06:00')), 1);
  assert.equal(peakRowsPerHour(rows('06:00', '07:00')), 1, 'exactly an hour apart: different hours');
  assert.equal(peakRowsPerHour(rows('06:00', '06:59')), 2);
  assert.equal(peakRowsPerHour(rows('06:00', '06:10', '06:20', '06:30', '06:40', '06:50', '07:00', '08:30')), 6);
  assert.equal(peakRowsPerHour(rows('06:30', '06:45', '07:10', '07:20', '07:25', '08:00', '09:00')), 5, 'a window that starts at a row: 06:30..07:25');
  assert.equal(peakRowsPerHour(rows('23:40', '00:20', '12:00')), 2, 'the hour wraps past midnight: the timetable repeats every day');
  assert.equal(peakRowsPerHour(rows('23:40', '00:20', '23:50', '00:30')), 4);
  assert.equal(peakRowsPerHour(rows('06:00', '06:00', '06:00')), 3, 'trucks at the same time');
  assert.equal(peakRowsPerHour(Array.from({ length: 500 }, (_, i) => ({ at: i * 100 }))), 36, '500 rows every 100 s: 36 in an hour');
  assert.equal(peakRowsPerHour(Array.from({ length: 24 }, (_, i) => ({ at: i * 3600 }))), 1, 'one truck an hour all day');
  assert.equal(peakRowsPerHour([{ at: 5 }, { at: NaN }, null, 'x', { at: 'y' }]), 1, 'junk rows are not counted');
  const check = doorCheck(trucks({ mode: 'schedule', doors: 3, schedule: [{ at: 21600, pallets: 26 }, { at: 22200, pallets: 26 }, { at: 22800, pallets: 26 }, { at: 23400, pallets: 26 }, { at: 24000, pallets: 26 }, { at: 24600, pallets: 26 }, { at: 36000, pallets: 26 }] }));
  assert.equal(check.mode, 'schedule');
  assert.equal(check.trucksPerHour, 6);
  assert.equal(check.pallets, 26);
  near(check.needed, 6 * 2940 / 3600, 1e-9);
  assert.equal(check.tooFew, true);
  assert.equal(check.empty, false);
});

test('A1.6 the demand slider: rate mode scales the truck frequency (both directions), schedule mode scales the pallets per truck and never moves an appointment', () => {
  const rate = (f, doors = 4) => doorCheck(appendixA(doors), { demandFactor: f });
  near(rate(1).trucksPerHour, 6);
  near(rate(0.5).trucksPerHour, 3);
  near(rate(2).trucksPerHour, 12);
  assert.equal(rate(2).pallets, 26, 'the pallets per truck stay');
  near(rate(0.5).needed, 2.45);
  assert.equal(rate(0).empty, true);
  assert.equal(rate(0).needed, 0);
  assert.equal(rate(0).tooFew, false);
  assert.match(rate(0).text, /^No truck arrives, so no door is needed\.$/);
  const schedule = (f) => doorCheck(trucks({ mode: 'schedule', doors: 2, schedule: [{ at: 21600, pallets: 24 }, { at: 25200, pallets: null }, { at: 28800, pallets: 10 }] }), { demandFactor: f });
  assert.equal(schedule(1).trucksPerHour, 1);
  assert.equal(schedule(2).trucksPerHour, 1, 'the appointments do not move');
  near(schedule(1).pallets, (24 + 24 + 10) / 3, 1e-9);
  near(schedule(2).pallets, (48 + 48 + 20) / 3, 1e-9);
  near(schedule(0.5).pallets, (12 + 12 + 5) / 3, 1e-9);
  near(schedule(0.01).pallets, 1, 1e-9);
  assert.equal(schedule(0).empty, true);
  for (const f of [-1, NaN, 'x', null, undefined]) near(rate(f).trucksPerHour, 6);
  assert.equal(doorCheck(trucks({ mode: 'schedule' })).empty, true, 'an empty timetable');
  assert.equal(doorCheck(trucks({ mode: 'schedule' })).trucksPerHour, 0);
});

test('A1.6 doorCheck is total: junk blocks, the limits of the block, 32 doors, no suggestion that cannot help', () => {
  for (const block of [undefined, null, 5, 'x', [], {}, { doors: 'x' }, { interArrival: null, pallets: 7 }, { mode: 'schedule', schedule: 'x' }, { mode: 'schedule', schedule: [null, 1, { at: 'q' }] }]) {
    const check = doorCheck(block);
    assert.ok(Number.isFinite(check.needed) && Number.isFinite(check.utilisation) && check.suggestedDoors >= 1 && check.suggestedDoors <= 32, bytes(block));
    assert.equal(typeof check.text, 'string');
    assert.ok(!/NaN|undefined|Infinity/.test(check.text), `${bytes(block)}: ${check.text}`);
  }
  const huge = doorCheck(constant(60, 200, { doors: 32 }));
  assert.ok(huge.tooFew && huge.suggestedDoors === 32 && huge.action === null, 'with 32 doors no "Use N doors" can help');
  assert.ok(!/would be busy/.test(huge.text));
  assert.equal(doorCheck(constant(3600, 1, { doors: 3 })).suggestedDoors >= 1, true);
  assert.equal(doorCheck(constant(600, 24, { doors: 1, checkIn: 0, checkOut: 0 }), { tPallet: 90 }).suggestedDoors, Math.ceil(6 * 2160 / 3600 / 0.85 - 1e-9));
});

// ---------------------------------------------------------------------------------------------------------------------------
// 6.2.1: the clock
// ---------------------------------------------------------------------------------------------------------------------------

test('6.2.1 makeClock: time of day, weekday and label for a simulation time (startTod is the time of day at time 0)', () => {
  const clock = makeClock({ startTod: 6 * 3600, startDay: 0 });
  assert.equal(clock.startTod, 21600);
  assert.equal(clock.tod(0), 21600);
  assert.equal(clock.label(0), 'Mon 06:00');
  assert.equal(clock.label(42 * 60), 'Mon 06:42');
  assert.equal(clock.label(18 * 3600 - 1), 'Mon 23:59');
  assert.equal(clock.label(18 * 3600), 'Tue 00:00');
  assert.equal(clock.day(18 * 3600 - 1), 0);
  assert.equal(clock.day(18 * 3600), 1);
  assert.equal(clock.dayIndex(0), 0);
  assert.equal(clock.dayIndex(18 * 3600), 1);
  assert.equal(clock.dayStart(0), -21600, 'day 0 began before time 0');
  assert.equal(clock.dayStart(1), 18 * 3600);
  assert.equal(clock.tod(clock.dayStart(3)), 0);
  assert.equal(makeClock({ startTod: 0, startDay: 0 }).dayStart(0), 0);
  const sunday = makeClock({ startTod: 0, startDay: 6 });
  assert.equal(sunday.label(0), 'Sun 00:00');
  assert.equal(sunday.label(86400), 'Mon 00:00', 'the week wraps');
  assert.equal(makeClock({ startTod: 23 * 3600 + 30 * 60, startDay: 2 }).label(1800), 'Thu 00:00');
  assert.equal(makeClock({ startDay: 3 }).day(7 * 86400 + 5), 3);
  assert.equal(clock.label(-3600), 'Mon 05:00');
  assert.equal(clock.day(-21601), 6, 'before the first midnight it is Sunday');
  assert.equal(makeClock({ startTod: 0, startDay: 0 }).tod(86400 * 2 + 61), 61);
  assert.ok(Object.isFrozen(clock));
  assert.equal(DAY_NAMES_LONG[0], 'Monday');
  for (const t of [0, 1, 3599.9, 86399.5, 1e7]) assert.ok(clock.tod(t) >= 0 && clock.tod(t) < 86400);
});

test('formatTimeOfDay rounds down to the minute and wraps into the day', () => {
  assert.equal(formatTimeOfDay(0), '00:00');
  assert.equal(formatTimeOfDay(21600), '06:00');
  assert.equal(formatTimeOfDay(21659), '06:00');
  assert.equal(formatTimeOfDay(86399), '23:59');
  assert.equal(formatTimeOfDay(86400), '00:00');
  assert.equal(formatTimeOfDay(-60), '23:59');
  assert.equal(formatTimeOfDay(NaN), '00:00');
});

// ---------------------------------------------------------------------------------------------------------------------------
// 6.2.6 and 5.3: the arrival process
// ---------------------------------------------------------------------------------------------------------------------------

/** A stream that counts its draws. */
function countingRng(seed) {
  const rng = createRng(seed);
  const counted = { draws: 0, next: () => { counted.draws++; return rng.next(); }, range: (lo, hi) => { counted.draws++; return rng.range(lo, hi); }, gauss: () => { counted.draws += 2; return rng.gauss(); }, exp: (m) => { counted.draws++; return rng.exp(m); } };
  return counted;
}

test('6.2.6 expandScheduleDay: a row falls at day x 86400 + at - startTod; rows before the start of the run are in the past; equal times keep the order of the rows', () => {
  const block = trucks({ mode: 'schedule', schedule: [{ at: 21600, pallets: 24 }, { at: 21600, pallets: 12 }, { at: 25200, pallets: 7 }, { at: 3600, pallets: 3 }] });
  const sorted = block.schedule;
  assert.deepEqual(sorted.map((r) => r.at), [3600, 21600, 21600, 25200]);
  const clock = makeClock({ startTod: 6 * 3600, startDay: 0 });
  const rng = countingRng(1);
  const day0 = expandScheduleDay(block, clock, 0, rng);
  assert.deepEqual(day0.map((d) => [d.at, d.pallets, d.noShow, d.row]), [[0, 24, false, 1], [0, 12, false, 2], [3600, 7, false, 3]], '03:00 is before the start at 06:00; the two trucks at 06:00 keep their order');
  assert.equal(rng.draws, 0, 'no jitter, no no-show, pallets given: not a single draw');
  const day1 = expandScheduleDay(block, clock, 1, rng);
  assert.deepEqual(day1.map((d) => d.at), [68400, 86400, 86400, 90000], 'day 1 begins at 18:00 of the run: 03:00 -> 19:00, 06:00 -> 24:00 (twice), 07:00 -> 25:00');
  assert.deepEqual(day1.map((d) => d.row), [0, 1, 2, 3]);
  assert.equal(expandScheduleDay(block, makeClock({ startTod: 0, startDay: 0 }), 2, rng)[0].at, 2 * 86400 + 3600);
  assert.deepEqual(expandScheduleDay(trucks({ mode: 'schedule' }), clock, 0, rng), []);
  assert.deepEqual(expandScheduleDay({}, null, 0, rng), []);
});

test('6.2.6 expandScheduleDay: a row without pallets draws them from the pallets distribution (1..200, whole), in row order', () => {
  const block = trucks({ mode: 'schedule', pallets: { kind: 'uniform', mean: 20, spread: 0.5 }, schedule: Array.from({ length: 60 }, (_, i) => ({ at: i * 600, pallets: i % 3 === 0 ? 7 : null })) });
  const clock = makeClock({ startTod: 0, startDay: 0 });
  const a = expandScheduleDay(block, clock, 0, createRng(9));
  const b = expandScheduleDay(block, clock, 0, createRng(9));
  assert.equal(bytes(a), bytes(b), 'same stream, same day');
  assert.notEqual(bytes(a), bytes(expandScheduleDay(block, clock, 0, createRng(10))));
  for (const d of a) assert.ok(Number.isInteger(d.pallets) && d.pallets >= 1 && d.pallets <= 200);
  assert.ok(a.filter((d) => d.row % 3 === 0).every((d) => d.pallets === 7));
  const drawn = a.filter((d) => d.row % 3 !== 0).map((d) => d.pallets);
  assert.ok(drawn.every((p) => p >= 10 && p <= 30), 'uniform 20 +- 50 %');
  assert.ok(new Set(drawn).size > 5);
  const rng = countingRng(3);
  expandScheduleDay(block, clock, 0, rng);
  assert.equal(rng.draws, 40, 'one draw per row without pallets');
});

test('6.2.6 expandScheduleDay: jitter moves a truck by at most +-jitter and never before time 0; a no-show stays in the list at its nominal time and draws nothing more', () => {
  const rows = Array.from({ length: 300 }, (_, i) => ({ at: 600 + i * 250, pallets: 10 }));
  const clock = makeClock({ startTod: 0, startDay: 0 });
  const block = trucks({ mode: 'schedule', jitter: 900, noShow: 0.2, schedule: rows });
  const rng = countingRng(11);
  const due = expandScheduleDay(block, clock, 0, rng);
  assert.equal(due.length, 300);
  const shows = due.filter((d) => !d.noShow);
  const absent = due.filter((d) => d.noShow);
  assert.ok(absent.length > 30 && absent.length < 90, `${absent.length} of 300 did not come (20 %)`);
  for (const d of absent) assert.deepEqual([d.at, d.pallets], [rows[d.row].at, 0], 'at the nominal time, no pallets');
  let moved = 0;
  for (const d of shows) {
    const nominal = rows[d.row].at;
    assert.ok(d.at >= 0 && Math.abs(d.at - nominal) <= 900 + 1e-9 || d.at === 0, `row ${d.row}: ${d.at} vs ${nominal}`);
    if (d.at !== nominal) moved++;
  }
  assert.ok(moved > shows.length * 0.9);
  assert.ok(due.every((d, i) => i === 0 || due[i - 1].at <= d.at), 'sorted by time');
  assert.equal(rng.draws, 300 + shows.length, 'a no-show draw per row, a jitter draw per truck that comes, no pallets draw');
  const early = expandScheduleDay(trucks({ mode: 'schedule', jitter: 7200, schedule: [{ at: 0, pallets: 1 }, { at: 100, pallets: 1 }] }), clock, 0, createRng(2));
  assert.ok(early.every((d) => d.at >= 0), 'never before 0');
  assert.ok(early.some((d) => d.at === 0) || early.length === 2);
  assert.equal(expansionTime(block, clock, 0), 0);
  assert.equal(expansionTime(block, clock, 2), 2 * 86400 - 900, 'the day is expanded early enough for its first trucks to come early');
  assert.equal(expansionTime(trucks({}), makeClock({ startTod: 21600 }), 1), 86400 - 21600);
});

test('6.2.6 the draws of one station do not depend on another: the stream is the one given (fork independence)', () => {
  const block = trucks({ mode: 'schedule', jitter: 300, noShow: 0.1, schedule: Array.from({ length: 50 }, (_, i) => ({ at: 3600 + i * 600, pallets: null })) });
  const clock = makeClock({ startTod: 0, startDay: 0 });
  const base = createRng(42);
  const first = expandScheduleDay(block, clock, 0, base.fork('trucks:a'));
  const withOther = createRng(42);
  expandScheduleDay(block, clock, 0, withOther.fork('trucks:b')); // another station expands its day first
  const second = expandScheduleDay(block, clock, 0, withOther.fork('trucks:a'));
  assert.equal(bytes(first), bytes(second));
});

test('5.3 the demand slider in the process: scalePallets, truckGap and drawPallets', () => {
  assert.equal(scalePallets(24, 1), 24);
  assert.equal(scalePallets(24, 1.5), 36);
  assert.equal(scalePallets(24, 0.5), 12);
  assert.equal(scalePallets(10, 0.04), 1, 'at least 1');
  assert.equal(scalePallets(7, 0.5), 4, 'rounded');
  assert.equal(scalePallets(24, 0), 0, 'a factor of 0: no truck');
  assert.equal(scalePallets(24, -1), 0);
  assert.equal(scalePallets(24, NaN), 0);
  const block = constant(2700, 24);
  const rng = createRng(1);
  assert.equal(truckGap(rng, block, 1), 2700);
  assert.equal(truckGap(rng, block, 2), 1350, 'twice the frequency');
  assert.equal(truckGap(rng, block, 0.5), 5400);
  assert.equal(truckGap(rng, block, 0), Infinity);
  assert.equal(truckGap(rng, block, -3), Infinity);
  const a = createRng(5);
  const b = createRng(5);
  const normal = trucks({ interArrival: { kind: 'normal', mean: 1000, spread: 0.3 } });
  assert.equal(truckGap(a, normal, 2), sampleDist(b, normal.interArrival, 1 / 2), 'the same draw the legacy arrivals make');
  const small = { kind: 'const', mean: 0.2, spread: 0 };
  assert.equal(drawPallets(rng, small), 1);
  assert.equal(drawPallets(rng, { kind: 'const', mean: 900, spread: 0 }), 200);
  assert.equal(drawPallets(rng, { kind: 'const', mean: 24.5, spread: 0 }), 25);
  const wide = { kind: 'uniform', mean: 24, spread: 1 };
  const draws = Array.from({ length: 500 }, () => drawPallets(rng, wide));
  assert.ok(draws.every((p) => Number.isInteger(p) && p >= 1 && p <= 48));
  near(draws.reduce((s, p) => s + p, 0) / draws.length, 24, 0.1);
});

test('the trucks block of a station is read through trucksOf; a station without trucks gives null', () => {
  const layout = EXAMPLES[0].build();
  const source = layout.stations.find((s) => s.type === 'source');
  assert.equal(trucksOf(source), null);
  assert.equal(trucksOf(null), null);
  assert.equal(trucksOf({ ops: {} }), null);
  L.updateStation(layout, source.id, { ops: { trucks: { doors: 3 } } });
  assert.equal(trucksOf(source).doors, 3);
});
