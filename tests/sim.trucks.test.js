// Trucks and dock doors (docs/WAREHOUSE-DESIGN.md 6.3, milestone M1), on micro plants with the stub traffic: the lifecycle of an inbound and an
// outbound truck, the gate and the doors, rate mode and timetable, jitter, no-shows, the demand slider, the pull of a Goods out (A1.7), dt
// independence of the arrival times (A1.8), determinism and fork independence (A1.9), and that a plant without trucks is untouched.
// The invariants of 6.3.5 and the conservation law are asserted on EVERY tick (createWorld with check: true).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertInvariants, createWorld, eventDigest, injectLoads, nonFinitePaths } from './helpers/logistics-invariants.js';
import { attachStats, fuzzPlant, microPlant, runTrucks, truckDigest } from './helpers/trucks-gen.js';
import { layoutFromAscii } from './helpers/ascii.js';
import { dist } from '../js/model/defaults.js';
import { normalizeLayout } from '../js/model/layout.js';
import { Simulation } from '../js/sim/engine.js';
import { BATCH_WAIT, GATE_LIMIT, TruckDesk } from '../js/sim/logistics/trucks.js';

const CONST = (mean) => dist('const', mean, 0);
const arrivals = (w, id) => w.named('truckArrived').filter((p) => p.stationId === id).map((p) => p.at);
const named = (w, name, id) => w.named(name).filter((p) => p.stationId === id);

/** Goods in A (trucks) -> Goods out C without trucks: unloading is the vehicles' work. */
const inbound = (trucks, o = {}) => microPlant({ inbound: { checkIn: 0, checkOut: 0, interArrival: CONST(600), pallets: CONST(3), ...trucks }, ...o });

// ---- inbound trucks ------------------------------------------------------------------------------------------------------

test('inbound: a truck arrives, takes a door, is checked in, its pallets reach the yard, vehicles unload it, check-out frees the door', () => {
  const layout = inbound({ doors: 1, checkIn: 60, checkOut: 30, pallets: CONST(3), interArrival: CONST(2000) });
  const w = createWorld(layout, { dt: 0.5, check: true });
  w.run(59.5);
  const a = w.lg.stationById.get('A');
  const [truck] = a.trucks.docked;
  assert.equal(a.trucks.gate.length, 0);
  assert.equal(truck.state, 'checkin');
  assert.equal(truck.dockedAt, 0);
  assert.equal(truck.pending.length, 3, 'the pallets exist from the arrival but are still on the truck');
  assert.equal(a.yard, 0);
  assert.equal(w.lg.liveLoads, 3, 'pallets on a truck are live loads');
  assert.deepEqual(w.named('loadCreated').map((p) => p.load.createdAt), [0, 0, 0], 'created at the arrival time');
  assert.ok(w.named('loadCreated').every((p) => p.load.tk === truck.id), 'each pallet knows its truck');
  w.run(1);
  assert.equal(truck.state, 'work', 'check-in is over at 60 s');
  assert.equal(truck.pending.length, 0);
  assert.equal(truck.left, 3);
  const ready = named(w, 'truckReady', 'A')[0];
  assert.equal(ready.t, 60);
  assert.ok(w.named('loadCreated').every((p) => p.load.readyAt >= 60 || p.load.claimed), 'released at the end of check-in');
  const picked = [];
  w.runUntil((x) => { picked.push(truck.left); return truck.state === 'checkout'; }, 300);
  assert.equal(truck.left, 0);
  assert.deepEqual([...new Set(picked)].sort(), ['0', '1', '2', '3'].map(Number).sort(), 'unloading is emergent: every pickup takes one pallet off the truck');
  const freeAt = truck.freeAt;
  assert.ok(truck.freeAt - 30 > 60, 'check-out starts at the last pickup');
  assert.equal(a.trucks.docked.length, 1, 'the door is held during check-out');
  w.runUntil(() => a.trucks.docked.length === 0, 60);
  const departed = named(w, 'truckDeparted', 'A')[0];
  assert.equal(departed.t, freeAt, 'the door is free when check-out is over');
  assert.equal(departed.doorTime, freeAt - 0);
  assert.equal(departed.gateWait, 0);
  assert.equal(departed.turnaround, freeAt);
  assert.equal(a.trucks.departed, 1);
});

test('inbound: the legacy arrival loop does not run for a Goods in with trucks (params.interArrival and batch are ignored)', () => {
  const layout = inbound({ doors: 4, pallets: CONST(2), interArrival: CONST(1000) }, { aParams: { interArrival: CONST(10), batch: 7, startDelay: 0 } });
  const w = createWorld(layout, { dt: 1, check: true });
  w.run(2500);
  assert.deepEqual(arrivals(w, 'A'), [0, 1000, 2000]);
  assert.equal(w.lg.stationById.get('A').nextArrival, Infinity);
  assert.equal(w.lg.createdBySources, 6, '3 trucks of 2 pallets, not 250 arrivals of 7');
  assert.equal(w.lg.stationById.get('A').arrivals, 3, 'arrivals counts trucks');
  assert.equal(w.lg.stationById.get('A').produced, 6);
});

test('inbound: startDelay delays the first truck in rate mode, the gap follows from the nominal time', () => {
  const layout = inbound({ doors: 2, interArrival: CONST(700), pallets: CONST(1) }, { aParams: { startDelay: 250 } });
  const w = createWorld(layout, { dt: 0.5, check: true });
  w.run(2500);
  assert.deepEqual(arrivals(w, 'A'), [250, 950, 1650, 2350]);
});

test('gate and doors: first come first served, a truck docks only while docked < doors, and the wait at the gate is measured', () => {
  // no way out for the pallets: nobody picks them up, so every docked truck keeps its door
  const layout = inbound({ doors: 2, checkIn: 10, interArrival: CONST(100), pallets: CONST(2) }, { flows: [], fleet: null });
  const w = createWorld(layout, { dt: 1, check: true });
  w.run(1000);
  const a = w.lg.stationById.get('A');
  assert.equal(a.trucks.docked.length, 2);
  assert.deepEqual(a.trucks.docked.map((k) => k.id), [1, 2], 'the first two trucks got the doors');
  assert.deepEqual(a.trucks.docked.map((k) => k.door), [0, 1]);
  assert.deepEqual(a.trucks.gate.map((k) => k.id), [3, 4, 5, 6, 7, 8, 9, 10], 'the others wait in arrival order');
  assert.equal(a.trucks.arrived, 10);
  assert.equal(a.state, 'blocked', 'pallets with no way on wait in the yard');
});

test('gate guard: at most GATE_LIMIT trucks wait, a further arrival is turned away and creates no pallets', () => {
  const layout = inbound({ doors: 1, checkIn: 0, interArrival: CONST(60), pallets: CONST(1) }, { flows: [], fleet: null });
  const w = createWorld(layout, { dt: 10, check: true });
  w.run(60 * (GATE_LIMIT + 40));
  const a = w.lg.stationById.get('A');
  assert.equal(a.trucks.gate.length, GATE_LIMIT);
  assert.ok(a.trucks.turnedAway >= 30, `turned away ${a.trucks.turnedAway}`);
  assert.equal(w.lg.createdBySources, a.trucks.arrived, 'a truck that was turned away created nothing');
  assert.equal(named(w, 'truckTurnedAway', 'A').length, a.trucks.turnedAway);
  assert.equal(a.trucks.arrived, a.trucks.gate.length + a.trucks.nDocked);
});

test('a Goods in with no outgoing flow keeps its trucks at the doors, never leaks memory beyond the guards and breaks no invariant', () => {
  const layout = inbound({ doors: 3, interArrival: CONST(60), pallets: CONST(40) }, { flows: [], fleet: null });
  const w = createWorld(layout, { dt: 20, check: true });
  w.run(60 * 300);
  const a = w.lg.stationById.get('A');
  assert.ok(a.trucks.docked.length === 3 && a.trucks.departed === 0);
  assert.ok(a.trucks.gate.length <= GATE_LIMIT);
  assert.ok(w.lg.liveLoads <= (GATE_LIMIT + 3) * 40);
});

// ---- the pallets of a truck -------------------------------------------------------------------------------------------

test('pallets per truck: drawn per truck from the pallets distribution, rounded and kept in 1..200', () => {
  for (const [pallets, lo, hi, mean, tol] of [[dist('const', 7, 0), 7, 7, 7, 0], [dist('uniform', 24, 0.25), 18, 30, 24, 0.6], [dist('exp', 200, 0), 1, 200, null, 0], [dist('normal', 1, 1), 1, 200, null, 0]]) {
    const layout = inbound({ doors: 32, interArrival: CONST(60), pallets, checkOut: 0 }, { flows: [], fleet: null });
    const w = createWorld(layout, { dt: 10, seed: 5 });
    w.run(60 * 300);
    const plans = w.named('truckArrived').map((p) => p.truck.plan);
    assert.ok(plans.length >= 200, `${plans.length} trucks`);
    assert.ok(plans.every((n) => Number.isInteger(n) && n >= lo && n <= hi), `${pallets.kind}: plans in ${lo}..${hi}`);
    if (mean !== null) assert.ok(Math.abs(plans.reduce((s, n) => s + n, 0) / plans.length - mean) <= tol, `${pallets.kind}: mean plan`);
  }
});

test('the demand slider scales the truck frequency in rate mode (both directions), not the pallets per truck', () => {
  const layout = inbound({ doors: 8, interArrival: CONST(600), pallets: CONST(5) }, { flows: [], fleet: null });
  const w = createWorld(layout, { dt: 1, runtime: { demandFactor: 2 } });
  w.run(3000);
  assert.deepEqual(arrivals(w, 'A'), [0, 300, 600, 900, 1200, 1500, 1800, 2100, 2400, 2700], 'twice the demand: a truck every 300 s');
  assert.ok(w.named('truckArrived').every((p) => p.truck.plan === 5));
  const slow = createWorld(layout, { dt: 1, runtime: { demandFactor: 0.5 } });
  slow.run(3000);
  assert.deepEqual(arrivals(slow, 'A'), [0, 1200, 2400]);
  const none = createWorld(layout, { dt: 1, runtime: { demandFactor: 0 } });
  none.run(3000);
  assert.deepEqual(arrivals(none, 'A'), [], 'with demand 0 no truck arrives');
});

test('setRuntime(demandFactor) rescales the pending arrival like it does for a legacy source; from 0 and back to 0', () => {
  const layout = inbound({ doors: 8, interArrival: CONST(1000), pallets: CONST(1) }, { flows: [], fleet: null });
  const w = createWorld(layout, { dt: 1, check: true });
  w.run(400);
  assert.equal(w.lg.stationById.get('A').trucks.nextArrival, 1000);
  w.lg.setRuntime({ demandFactor: 2 });
  assert.equal(w.lg.stationById.get('A').trucks.nextArrival, 700, '400 + (1000 - 400) / 2');
  w.run(400);
  assert.deepEqual(arrivals(w, 'A'), [0, 700], 'the arrival came at the rescaled time');
  w.lg.setRuntime({ demandFactor: 0 });
  assert.equal(w.lg.stationById.get('A').trucks.nextArrival, Infinity);
  w.run(3000);
  assert.deepEqual(arrivals(w, 'A'), [0, 700], 'nobody comes while the demand is 0');
  const now = w.lg.now;
  w.lg.setRuntime({ demandFactor: 1 });
  assert.equal(w.lg.stationById.get('A').trucks.nextArrival, now + 1000, 'back from 0: one gap from now');
  // a plant that starts with demand 0 starts its first truck at startDelay when the demand comes
  const cold = createWorld(layout, { dt: 1, runtime: { demandFactor: 0 } });
  cold.run(100);
  cold.lg.setRuntime({ demandFactor: 1 });
  assert.equal(cold.lg.stationById.get('A').trucks.nextArrival, 100, 'the first truck is at startDelay (0), not before now');
});

// ---- timetable ---------------------------------------------------------------------------------------------------------

/** A calendar plant: the run starts at 05:50 on a Monday, so 06:00 is at t = 600. */
function timetable(trucks, o = {}) {
  const layout = microPlant({ inbound: { mode: 'schedule', checkIn: 0, checkOut: 0, ...trucks }, ...o });
  layout.calendar = { startTod: 5 * 3600 + 50 * 60, startDay: 0 };
  return normalizeLayout(layout);
}

test('timetable: rows arrive at their time of day on the clock, rows in the past of the run are skipped, the next day repeats', () => {
  const layout = timetable({ doors: 4, pallets: CONST(9), schedule: [{ at: 5 * 3600, pallets: 3 }, { at: 6 * 3600, pallets: 4 }, { at: 6 * 3600 + 900, pallets: null }] }, { flows: [], fleet: null });
  assert.equal(layout.calendar.startTod, 21000);
  const w = createWorld(layout, { dt: 10, check: true });
  assert.equal(w.lg.clock.label(0), 'Mon 05:50');
  w.run(86400 + 3000);
  const got = w.named('truckArrived').map((p) => [p.at, p.truck.plan]);
  assert.deepEqual(got, [[600, 4], [1500, 9], [86400 - 21000 + 18000, 3], [86400 + 600, 4], [86400 + 1500, 9]], '05:00 of day 0 is in the past; the null row draws the distribution (const 9)');
});

test('timetable: pallets of a row are scaled by the demand slider on arrival (at least 1), appointments do not move, factor 0 means no truck', () => {
  const rows = [{ at: 21600, pallets: 10 }, { at: 22500, pallets: 2 }];
  for (const [factor, plans] of [[1, [10, 2]], [2, [20, 4]], [0.5, [5, 1]], [0.01, [1, 1]], [0, []]]) {
    const layout = timetable({ doors: 2, schedule: rows }, { flows: [], fleet: null });
    const w = createWorld(layout, { dt: 10, runtime: { demandFactor: factor } });
    w.run(3000);
    assert.deepEqual(w.named('truckArrived').map((p) => p.truck.plan), plans, `factor ${factor}`);
    if (factor > 0) assert.deepEqual(arrivals(w, 'A'), [600, 1500], 'the appointments stay where they are');
  }
});

test('timetable: no-shows are drawn per row from the truck stream and counted at their nominal time', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ at: 21600 + i * 60, pallets: 1 }));
  const layout = timetable({ doors: 32, noShow: 0.5, schedule: rows }, { flows: [], fleet: null });
  const w = createWorld(layout, { dt: 10, check: true });
  w.run(600 + 200 * 60 + 100);
  const missed = w.named('truckNoShow');
  const came = w.named('truckArrived');
  assert.equal(missed.length + came.length, 200, 'every row either came or did not');
  assert.ok(missed.length >= 70 && missed.length <= 130, `${missed.length} no-shows of 200 at 50 %`);
  assert.equal(w.lg.stationById.get('A').trucks.noShow, missed.length);
  assert.ok(missed.every((p) => p.at === 600 + p.row * 60), 'at the nominal time of the row');
  assert.equal(w.lg.createdBySources, came.length, 'a no-show creates no pallet');
  const again = createWorld(layout, { dt: 5 });
  again.run(600 + 200 * 60 + 100);
  assert.deepEqual(again.named('truckNoShow').map((p) => p.row), missed.map((p) => p.row), 'the same rows miss, whatever the dt');
});

test('timetable: jitter moves a truck by at most +-jitter, never before time 0; trucks of two days are merged by their time', () => {
  const rows = [{ at: 86300, pallets: 1 }, { at: 100, pallets: 1 }, { at: 400, pallets: 1 }, { at: 86400 - 1, pallets: 1 }];
  const layout = microPlant({ inbound: { mode: 'schedule', doors: 8, checkIn: 0, jitter: 600, schedule: rows }, flows: [], fleet: null });
  layout.calendar = { startTod: 86000, startDay: 6 };
  const w = createWorld(normalizeLayout(layout), { dt: 5, check: true });
  w.run(3 * 86400);
  const times = arrivals(w, 'A');
  // day 0 starts at 23:53 (startTod 86000): its rows at 00:01:40 and 00:06:40 are in the past, the two late rows come at t = 300 and 399; days 1 and 2 bring
  // all four rows, day 3 begins at t = 173200 and brings its two early rows, while its two late rows (t = 259500 and 259599, after the end of the run) come
  // inside the run only when their jitter moves them forward by more than 300 s / 399 s: 12 trucks for sure, 14 at most (which of the two depends on the draws)
  assert.ok(times.length >= 12 && times.length <= 14, `${times.length} arrivals`);
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'the arrivals come in time order, also when a jittered truck of the next day beats the last one of this day');
  const nominal = [];
  for (let day = 0; day < 4; day++) for (const r of rows) nominal.push(day * 86400 + r.at - 86000);
  for (const at of times) assert.ok(nominal.some((n) => Math.abs(at - n) <= 600 + 1e-9) && at >= 0, `arrival ${at} is within 600 s of a row`);
  assert.ok(times.some((at) => !nominal.includes(at)), 'and the times are really moved');
});

test('timetable: an empty timetable never sends a truck, a 500-row one is handled', () => {
  const empty = createWorld(timetable({ schedule: [] }, { flows: [], fleet: null }), { dt: 10, check: true });
  empty.run(86400);
  assert.equal(empty.named('truckArrived').length, 0);
  const rows = Array.from({ length: 500 }, (_, i) => ({ at: 21600 + i * 10, pallets: 1 }));
  const big = createWorld(timetable({ doors: 32, schedule: rows, jitter: 7200, noShow: 0.5 }, { flows: [], fleet: null }), { dt: 10, check: true });
  big.run(79000); // day 0 only: the jitter of 7200 s lets a row of the next day (from 87000) come at the earliest at 79800
  // nothing picks the pallets up (no flow, no fleet), so the 32 doors and the 200 places at the gate fill up and the rest is turned away
  assert.equal(big.named('truckArrived').length + big.named('truckNoShow').length + big.named('truckTurnedAway').length, 500, 'every row either came, did not come or was turned away');
});

// ---- outbound trucks: the pull of the Goods out (A1.7) ---------------------------------------------------------------

/** Storage S feeds a Goods out C with trucks; S is filled by hand, so the supply is exact. */
function outbound(trucks, { stock = 20, ...o } = {}) {
  const layout = microPlant({
    storage: true, goodsIn: false,
    outbound: { checkIn: 30, checkOut: 30, interArrival: CONST(1000), pallets: CONST(5), maxDwell: 600, staging: 0, ...trucks }, ...o,
  });
  const w = createWorld(layout, { dt: 0.5, check: true });
  const loads = injectLoads(w.lg, 'f1', stock);
  void loads;
  return w;
}

test('outbound, staging 0: with no truck at work nothing reaches the Goods out and the storage keeps its pallets; with a truck pallets flow', () => {
  const w = outbound({ doors: 1, staging: 0, interArrival: CONST(1000), pallets: CONST(5) }, { stock: 20 });
  const c = w.lg.stationById.get('C');
  const s = w.lg.stationById.get('S');
  w.run(990);
  assert.equal(c.trucks.room(c), 0, 'no truck, no room');
  assert.equal(c.trucks.staged.length, 0);
  assert.equal(w.lg.completed, 0);
  assert.equal(s.outCount, 20, 'the pallets stay in the storage');
  assert.equal(w.lg.activeOrders.size, 0, 'and no vehicle is sent');
  w.run(10 + 30 + 1);
  assert.equal(c.trucks.docked[0].state, 'work', 'the truck came at 1000, check-in is over at 1030');
  assert.equal(c.trucks.room(c) + c.inboundTotal, 5, 'the truck at work has room for its plan: some of it is already promised to vehicles on their way, the rest is the room');
  assert.ok(c.inboundTotal > 0, 'and the dispatcher woke up and sent vehicles for it');
  w.runUntil(() => c.trucks.docked.length === 0 || c.trucks.docked[0].state === 'checkout', 200);
  assert.equal(c.trucks.docked[0].loaded, 5);
  assert.equal(w.lg.completed, 5, 'a pallet leaves the plant when it is loaded onto a truck');
  assert.equal(s.outCount, 15);
  w.run(100);
  assert.equal(c.trucks.departed, 1);
  assert.equal(c.trucks.short, 0);
  assert.equal(c.trucks.planned, 5);
  assert.equal(c.trucks.loadedTotal, 5);
  assert.equal(s.outCount, 15, 'no more pallets are fetched while no truck is at work (the next truck comes at 2000)');
});

test('outbound, staging 3 per door: pallets are fetched up to the staging space before any truck is there and are loaded at once when one is ready', () => {
  const w = outbound({ doors: 2, staging: 3, interArrival: CONST(1000), pallets: CONST(4), checkIn: 60 }, { stock: 20 });
  const c = w.lg.stationById.get('C');
  w.run(900);
  assert.equal(c.trucks.stagingCap, 6);
  assert.equal(c.trucks.staged.length, 6, 'the staging space is filled, no more');
  assert.equal(w.lg.stationById.get('S').outCount, 14);
  assert.equal(w.lg.completed, 0, 'staged pallets are live loads, they have not left yet');
  assert.equal(c.state, 'normal');
  assert.ok(Math.abs(c.fill - 1) < 1e-12 && c.fillLabel === '6/6');
  w.run(100 + 60 - 0.5);
  assert.equal(c.trucks.docked[0].state, 'checkin');
  assert.equal(w.lg.completed, 0);
  w.run(1);
  assert.equal(c.trucks.docked[0].loaded, 4, 'a truck that finishes check-in takes up to its plan from the staging at once');
  assert.equal(w.lg.completed, 4);
  assert.equal(c.trucks.staged.length, 2);
});

test('outbound: a delivered pallet goes to the earliest-docked truck at work with room, FIFO', () => {
  // two trucks of 20 pallets, a minute apart, at work together: the supply (one forklift trip every ~20 s) is slower than a truck fills
  const w = outbound({ doors: 2, staging: 0, interArrival: CONST(60), pallets: CONST(20), checkIn: 0, checkOut: 600, maxDwell: 3000 }, { stock: 60 });
  const c = w.lg.stationById.get('C');
  let overlap = 0;
  let overtaken = 0;
  let fullAt = null; // when the first truck had its 20 pallets, and when the second truck got its first one
  let secondAt = null;
  for (let i = 0; i < 600 / 0.5; i++) {
    w.step();
    const first = c.trucks.docked.find((k) => k.id === 1);
    const second = c.trucks.docked.find((k) => k.id === 2);
    if (!first || !second) continue;
    if (first.state === 'work' && second.state === 'work') overlap++;
    if (second.loaded > 0 && first.state === 'work' && first.loaded < first.plan) overtaken++;
    if (fullAt === null && first.loaded === first.plan) fullAt = w.t;
    if (secondAt === null && second.loaded > 0) secondAt = w.t;
  }
  assert.ok(overlap > 50, `the two trucks were at work together for ${overlap * 0.5} s`);
  assert.equal(overtaken, 0, 'the second truck never got a pallet while the first still had room');
  assert.ok(fullAt !== null && secondAt !== null && secondAt >= fullAt, `the first truck was full at ${fullAt} s, the second got its first pallet at ${secondAt} s`);
});

test('outbound: a truck leaves short maxDwell after check-in, never while a pallet is on its way, and fillRate is loaded over planned', () => {
  // 3 pallets of supply for a truck of 5: the truck waits its maxDwell (600 s after check-in) and leaves with 3
  const w = outbound({ doors: 1, staging: 0, interArrival: CONST(1000), pallets: CONST(5), maxDwell: 600, checkIn: 30, checkOut: 30 }, { stock: 3 });
  const c = w.lg.stationById.get('C');
  w.run(1030 + 599);
  const truck = c.trucks.docked[0];
  assert.equal(truck.loaded, 3);
  assert.equal(truck.state, 'work', 'it waits for the 2 missing pallets');
  assert.equal(truck.closing, false);
  w.run(2);
  assert.equal(truck.closing, true, 'marked closing at maxDwell');
  assert.equal(c.trucks.room(c), 0, 'and it stops counting in the room');
  assert.equal(truck.state, 'checkout', 'nothing is on its way, so it leaves');
  w.run(31);
  assert.equal(c.trucks.departed, 1);
  assert.equal(c.trucks.short, 1);
  assert.equal(c.trucks.planned, 5);
  assert.equal(c.trucks.loadedTotal, 3);
  const departed = named(w, 'truckDeparted', 'C')[0];
  assert.equal(departed.short, true);
  assert.equal(departed.doorTime, departed.t - truck.dockedAt);
});

test('outbound: at maxDwell a truck with pallets on their way waits for them (inboundTotal > 0) and takes them, then leaves short', () => {
  const w = outbound({ doors: 1, staging: 0, interArrival: CONST(1000), pallets: CONST(5), maxDwell: 20, checkIn: 0, checkOut: 0 }, { stock: 5 });
  const c = w.lg.stationById.get('C');
  // slow forklifts (2 of them, one pallet each): loading and unloading take longer than the 20 s the truck is willing to wait
  w.lg.vehicles.forEach((vr) => { vr.cfg.loadTime = 40; vr.cfg.unloadTime = 40; });
  w.run(1000 + 21);
  const truck = c.trucks.docked[0];
  assert.equal(truck.closing, true, 'maxDwell is over');
  const promised = c.inboundTotal;
  assert.equal(promised, 2, 'two pallets were promised to the truck while it still had room');
  assert.equal(truck.state, 'work', 'a closing truck does not leave while pallets are promised to it');
  w.run(400);
  assert.equal(c.trucks.docked.length, 0);
  assert.equal(c.trucks.departed, 1);
  assert.equal(c.trucks.loadedTotal, promised, 'it took exactly the pallets that were on their way, no more (a closing truck no longer counts in the room)');
  assert.equal(c.trucks.short, 1);
  assert.equal(w.lg.stationById.get('S').outCount, 3, 'the other pallets stay in the storage');
});

test('outbound: maxDwell 0 means until full', () => {
  const w = outbound({ doors: 1, staging: 0, interArrival: CONST(1000), pallets: CONST(5), maxDwell: 0, checkIn: 0, checkOut: 0 }, { stock: 3 });
  w.run(1000 + 5000);
  const c = w.lg.stationById.get('C');
  assert.equal(c.trucks.docked.length, 1);
  assert.equal(c.trucks.docked[0].loaded, 3);
  assert.equal(c.trucks.departed, 0, 'a truck that is never full never leaves');
});

test('outbound: the first truck of a Goods out comes after one gap, the demand slider scales the frequency', () => {
  const layout = microPlant({ storage: true, flows: [['S', 'C']], outbound: { interArrival: CONST(900), pallets: CONST(2) }, fleet: null });
  const w = createWorld(layout, { dt: 1, runtime: { demandFactor: 3 } });
  w.run(2000);
  assert.deepEqual(arrivals(w, 'C'), [300, 600, 900, 1200, 1500, 1800]);
});

// ---- time: dt independence, determinism, fork independence (A1.8, A1.9) --------------------------------------------------

test('A1.8: the arrival times of the trucks are identical for dt 0.1 and 0.25 (rate mode with random gaps and a timetable with jitter and no-shows)', () => {
  const rate = inbound({ doors: 3, interArrival: dist('normal', 700, 0.4), pallets: dist('uniform', 20, 0.5), checkIn: 60, checkOut: 40 }, { storage: true });
  const table = timetable({ doors: 3, jitter: 900, noShow: 0.2, pallets: dist('uniform', 10, 0.5), checkIn: 60, schedule: Array.from({ length: 40 }, (_, i) => ({ at: 21600 + i * 300, pallets: i % 3 === 0 ? null : 8 })) }, { storage: true });
  for (const layout of [rate, table]) {
    const run = (dt) => {
      const w = createWorld(layout, { dt, seed: 11 });
      w.run(12000);
      return arrivals(w, 'A');
    };
    const a = run(0.1);
    const b = run(0.25);
    assert.ok(a.length >= 10);
    assert.deepEqual(a, b, 'bit-identical arrival times');
  }
});

test('A1.8: the mean gate wait of dt 0.1 and 0.25 differs by less than the recorded margin', () => {
  // One door that is a little too slow for the trucks (a truck every 200 s, 180 s of check-in and check-out plus the unloading), so a real queue builds
  // up. The event times are exact, but a truck is APPLIED on the first tick at or after its time, so the door time of every truck is rounded up to a
  // tick and the queue adds that up: the coarser dt waits a little longer. Recorded at build time: 1438.6 s (dt 0.1) against 1445.7 s (dt 0.25),
  // a difference of 7.1 s or 0.5 %; the margin is twice the observed difference, rounded up to a clean 15 s.
  const MARGIN = 15;
  const layout = inbound({ doors: 1, interArrival: dist('normal', 200, 0.3), pallets: CONST(4), checkIn: 120, checkOut: 60 }, { storage: true });
  const wait = (dt) => {
    const w = createWorld(layout, { dt, seed: 4 });
    w.run(6 * 3600);
    const waits = w.named('truckDocked').map((p) => p.wait);
    return { mean: waits.reduce((s, x) => s + x, 0) / waits.length, n: waits.length };
  };
  const a = wait(0.1);
  const b = wait(0.25);
  assert.ok(a.mean > 1000, `a real queue: ${a.mean.toFixed(1)} s`);
  assert.equal(a.n, b.n, 'the same trucks');
  assert.ok(Math.abs(a.mean - b.mean) < MARGIN, `dt 0.1: ${a.mean.toFixed(3)} s, dt 0.25: ${b.mean.toFixed(3)} s`);
});

test('A1.9: the same seed gives the same event digest and the same truck events; another seed does not', () => {
  const layout = inbound({ doors: 2, interArrival: dist('exp', 400, 0), pallets: dist('uniform', 8, 0.5), checkIn: 30 }, { storage: true, outbound: { interArrival: dist('normal', 500, 0.3), pallets: CONST(6), staging: 2, maxDwell: 300 } });
  const run = (seed) => {
    const w = createWorld(layout, { dt: 0.5, seed, check: true });
    w.run(4000);
    return [eventDigest(w.events), truckDigest(w.events)];
  };
  const [d1, t1] = run(9);
  const [d2, t2] = run(9);
  const [d3, t3] = run(10);
  assert.equal(d1, d2);
  assert.equal(t1, t2);
  assert.ok(t1.length > 100, 'there is something to compare');
  assert.notEqual(t1, t3);
  assert.notEqual(d1, d3);
});

test('A1.9: adding a truck station elsewhere does not change the arrival times of another station (fork independence)', () => {
  const one = microPlant({ inbound: { doors: 2, interArrival: dist('normal', 600, 0.4), pallets: dist('uniform', 10, 0.4) }, storage: true, flows: [['A', 'S']] });
  // the same plant with a second Goods in (own trucks), a Goods out with trucks and a different order of the stations
  const layout = layoutFromAscii(['AAA..SSS..CCC..BBB', '+++++++++++++++++++'], {
    stations: {
      A: { type: 'source', ops: { trucks: one.stations[0].ops.trucks } }, S: { type: 'storage' },
      C: { type: 'sink', ops: { trucks: { doors: 1, interArrival: dist('exp', 500, 0) } } },
      B: { type: 'source', ops: { trucks: { doors: 3, interArrival: dist('exp', 200, 0), pallets: dist('normal', 5, 0.5) } } },
    },
    flows: [['A', 'S'], ['B', 'S'], ['S', 'C']], fleets: [{ preset: 'forklift', count: 3, loadTime: 5, unloadTime: 5 }],
  });
  const times = (lay, seed) => {
    const w = createWorld(normalizeLayout(lay), { dt: 0.5, seed });
    w.run(6000);
    return { at: arrivals(w, 'A'), plans: w.named('truckArrived').filter((p) => p.stationId === 'A').map((p) => p.truck.plan) };
  };
  const alone = times(one, 21);
  const together = times(layout, 21);
  assert.ok(alone.at.length >= 8);
  assert.deepEqual(together, alone, 'station A sees exactly the same trucks, with or without B and C');
});

// ---- a plant without trucks ---------------------------------------------------------------------------------------------

test('a plant without trucks has no truck desk, no extension object and no ops section; a Goods in with ops.trucks has all three', () => {
  const plain = createWorld(microPlant({ storage: true }), { dt: 1 });
  assert.ok(plain.lg.stations.every((st) => st.trucks === null));
  assert.equal(plain.lg.ext, null);
  assert.equal(plain.lg.truckSeq, 0);
  const trucks = createWorld(inbound({ doors: 1 }), { dt: 1 });
  assert.notEqual(trucks.lg.stationById.get('A').trucks, null);
  assert.equal(trucks.lg.stationById.get('C').trucks, null);
  assert.equal(typeof trucks.lg.ext.stats, 'function');
});

test('the option works through a hand-made layout that skipped normalizeLayout: junk is sanitized, a block on another type is ignored', () => {
  const raw = layoutFromAscii(['AAA.PPP.CCC', '+++++++++++'], {
    stations: { A: { type: 'source', ops: { trucks: { doors: 'x', interArrival: { kind: 'nope', mean: -3 }, pallets: 9, checkIn: -5 } } }, P: { type: 'process', ops: { trucks: { doors: 2 } } }, C: 'sink' },
    flows: [['A', 'P'], ['P', 'C']],
  });
  const w = createWorld(raw, { dt: 1, check: true });
  w.run(5000);
  assert.equal(w.lg.stationById.get('P').trucks, null, 'a workstation has no trucks');
  const tr = w.lg.stationById.get('A').trucks;
  assert.equal(tr.doors, 2, 'junk takes the default');
  assert.equal(tr.checkIn, 0);
  assert.ok(w.named('truckArrived').length >= 1);
});

// ---- the lead time includes the gate; the vehicles set the door time --------------------------------------------------------

test('lead time starts at the arrival of the truck: a pallet of a truck that waited at the gate has a lead time of at least that wait', () => {
  // one door, a truck every 150.3 s (between two ticks of 0.5 s) that holds its door for ~150 s plus unloading: the gate fills and the later trucks wait for long
  const layout = inbound({ doors: 1, checkIn: 60, checkOut: 60, interArrival: CONST(150.3), pallets: CONST(3) }, { storage: true });
  const w = createWorld(layout, { dt: 0.5, check: true });
  w.run(3 * 3600);
  const truckOf = new Map(w.named('truckArrived').map((p) => [p.truck.id, p.truck]));
  const waitOf = new Map(w.named('truckDocked').map((p) => [p.truck.id, p.wait]));
  const done = w.named('loadCompleted').filter((p) => p.stationId === 'C');
  assert.ok(done.length > 50);
  let checked = 0;
  for (const p of done) {
    const truck = truckOf.get(p.load.tk);
    assert.ok(truck, 'the pallet knows its truck');
    assert.equal(p.load.createdAt, truck.at, 'created at the arrival time of its truck, not at the tick that handled it');
    if (waitOf.has(truck.id)) {
      assert.ok(p.leadTime >= waitOf.get(truck.id) + truck.plan * 0 - 1e-9, `lead time ${p.leadTime} < gate wait ${waitOf.get(truck.id)}`);
      checked++;
    }
  }
  assert.ok(checked > 50);
  assert.ok(Math.max(...done.map((p) => p.leadTime)) > 1000, 'and the queue at the gate really is part of the lead time');
});

test('the vehicles set the door time: with fewer forklifts the same trucks hold their doors longer, and doors are held while pallets wait in the yard', () => {
  const doorTime = (forklifts) => {
    const layout = inbound({ doors: 3, checkIn: 30, checkOut: 30, interArrival: CONST(900), pallets: CONST(12) }, { storage: true, fleet: { count: forklifts } });
    const w = createWorld(layout, { dt: 0.5, check: true });
    w.run(4 * 3600);
    const times = w.named('truckDeparted').map((p) => p.doorTime);
    return times.reduce((s, x) => s + x, 0) / times.length;
  };
  const [one, two, four] = [doorTime(1), doorTime(2), doorTime(4)];
  assert.ok(one > two && two > four, `door time with 1, 2, 4 forklifts: ${one.toFixed(0)}, ${two.toFixed(0)}, ${four.toFixed(0)} s`);
  assert.ok(one > 1.5 * four, 'by a lot');
  // staging of 1 pallet: the Goods in is blocked while the truck's pallets wait in the yard, and the doors stay busy
  const layout = inbound({ doors: 2, checkIn: 0, checkOut: 0, interArrival: CONST(600), pallets: CONST(20) }, { storage: true, aParams: { outCap: 1 } });
  const w = createWorld(layout, { dt: 0.5, check: true });
  w.run(1500);
  const a = w.lg.stationById.get('A');
  assert.equal(a.params.outCap, 1);
  assert.ok(a.yard > 0 || a.trucks.docked.some((k) => k.left > 0), 'pallets wait for staging space');
  assert.equal(a.state, 'blocked');
});

// ---- A differential test against the legacy arrivals --------------------------------------------------------------------------

test('differential: a Goods in whose trucks bring one pallet (or a batch) every g seconds, with one door and no check-in or check-out, delivers exactly what the legacy source delivers', () => {
  // What is compared and why equality is right: with constant gaps nothing random is drawn, so both sources create their pallets at the very same
  // instants (startDelay, then every g); with check-in 0 the pallets of a truck go to the yard on the tick the truck arrives, as the legacy ones do;
  // and while the vehicles are quicker than g the single door is free again before the next truck, so no truck ever waits. The vehicles then see the
  // same plant, tick by tick: the lead time of every single pallet and the order of the deliveries are identical, not just their count.
  for (const [gap, batch, fleet] of [[100, 1, 2], [180, 1, 1], [240, 3, 3], [90, 2, 4]]) {
    const common = { storage: true, fleet: { count: fleet } };
    const legacy = createWorld(microPlant({ ...common, aParams: { interArrival: CONST(gap), batch, startDelay: 20 } }), { dt: 0.5, seed: 4 });
    const trucks = createWorld(microPlant({ ...common, aParams: { startDelay: 20 }, inbound: { doors: 1, checkIn: 0, checkOut: 0, interArrival: CONST(gap), pallets: CONST(batch) } }), { dt: 0.5, seed: 4, check: true });
    legacy.run(4 * 3600);
    trucks.run(4 * 3600);
    const leads = (w) => w.named('loadCompleted').map((p) => [p.t, p.leadTime]);
    assert.ok(legacy.lg.completed > 50, `gap ${gap}, batch ${batch}: ${legacy.lg.completed} delivered`);
    assert.equal(trucks.lg.completed, legacy.lg.completed, `gap ${gap}, batch ${batch}: same number delivered`);
    assert.deepEqual(leads(trucks), leads(legacy), `gap ${gap}, batch ${batch}: every pallet at the same time with the same lead time`);
    assert.equal(trucks.lg.stationById.get('A').trucks.turnedAway, 0);
    assert.equal(Math.max(...trucks.named('truckDocked').map((p) => p.wait)), 0, 'no truck waited at the gate');
  }
});

test('differential: when the vehicles cannot keep up, trucks queue at the gate where the legacy source piles pallets up - the same pallets are delivered, later', () => {
  const common = { storage: true, fleet: { count: 1, loadTime: 20, unloadTime: 20 } };
  const legacy = createWorld(microPlant({ ...common, aParams: { interArrival: CONST(60), batch: 1 } }), { dt: 1, seed: 4 });
  const trucks = createWorld(microPlant({ ...common, inbound: { doors: 1, checkIn: 0, checkOut: 0, interArrival: CONST(60), pallets: CONST(1) } }), { dt: 1, seed: 4, check: true });
  legacy.run(3600);
  trucks.run(3600);
  const a = trucks.lg.stationById.get('A');
  assert.ok(a.trucks.gate.length > 5, `${a.trucks.gate.length} trucks wait at the gate`);
  assert.ok(Math.abs(trucks.lg.completed - legacy.lg.completed) <= 2, `delivered ${trucks.lg.completed} against ${legacy.lg.completed}: the vehicles are the limit in both`);
  assert.equal(trucks.lg.liveLoads + trucks.lg.completed, trucks.lg.createdBySources, 'conservation, pallets at the gate included');
});

// ---- hostile plants ----------------------------------------------------------------------------------------------------------

test('hostile: more doors than dock cells, a Goods out nothing feeds, 0 staging, and a truck that never fills break nothing', () => {
  // 32 doors on a 3-cell station (the Checks tab warns, the simulation must not care)
  const wide = createWorld(inbound({ doors: 32, checkIn: 0, checkOut: 0, interArrival: CONST(60), pallets: CONST(2) }), { dt: 1, check: true });
  wide.run(3600);
  assert.ok(wide.lg.completed > 50);
  // a Goods out that nothing feeds: every truck waits its maxDwell and leaves with nothing; fillRate 0, no NaN
  const layout = microPlant({ outbound: { doors: 2, checkIn: 10, checkOut: 10, interArrival: CONST(300), pallets: CONST(6), maxDwell: 200, staging: 0 }, flows: [], fleet: null });
  const w = attachStats(createWorld(layout, { dt: 1, check: true }));
  w.run(3 * 3600);
  const c = w.lg.stationById.get('C').trucks;
  assert.ok(c.departed >= 30 && c.short === c.departed && c.loadedTotal === 0, `${c.departed} trucks, ${c.short} short, ${c.loadedTotal} loaded`);
  const entry = w.stats.report().ops.trucks.C;
  assert.equal(entry.fillRate, 0);
  assert.equal(entry.trucks.short, c.departed);
  assert.deepEqual(nonFinitePaths(w.stats.report().ops), []);
  // maxDwell shorter than the check-in: the truck is closing the moment it is ready and leaves at once
  const quick = createWorld(microPlant({ storage: true, flows: [['S', 'C']], outbound: { doors: 1, checkIn: 100, checkOut: 0, interArrival: CONST(500), pallets: CONST(4), maxDwell: 1, staging: 0 } }), { dt: 0.5, check: true });
  injectLoads(quick.lg, 'f1', 10);
  quick.run(2000);
  assert.ok(quick.lg.stationById.get('C').trucks.departed >= 2);
});

// ---- time: runtime what-ifs, restarts, long runs -----------------------------------------------------------------------------

test('runtime what-if: the demand slider moved up, to 0 and back mid-run keeps every invariant, trucks at the doors finish, nobody comes at 0', () => {
  const layout = microPlant({
    storage: true,
    inbound: { doors: 2, checkIn: 30, checkOut: 30, interArrival: CONST(200), pallets: CONST(6) },
    outbound: { doors: 1, checkIn: 30, checkOut: 30, interArrival: CONST(400), pallets: CONST(6), staging: 3, maxDwell: 400 },
    fleet: { count: 3 },
  });
  const w = createWorld(layout, { dt: 0.5 });
  runTrucks(w, 3000, { whatIf: [{ at: 600, patch: { demandFactor: 3 } }, { at: 1500, patch: { demandFactor: 0 } }, { at: 2200, patch: { demandFactor: 0.5 } }, { at: 2600, patch: { demandFactor: 1 } }] });
  const at = (id) => w.named('truckArrived').filter((p) => p.stationId === id).map((p) => p.at);
  const inbound600 = at('A').filter((x) => x < 600);
  const inbound3 = at('A').filter((x) => x >= 600 && x < 1500);
  assert.ok(inbound3.length > 2 * inbound600.length, `${inbound3.length} trucks in 900 s at demand 3 against ${inbound600.length} in 600 s at demand 1`);
  assert.deepEqual(at('A').filter((x) => x > 1500 + 1 && x < 2200 - 1), [], 'no truck comes while the demand is 0');
  assert.ok(at('A').some((x) => x > 2200), 'and trucks come again afterwards');
  assert.ok(w.named('truckDeparted').some((p) => p.t > 1500), 'the trucks that were at the doors when the demand went to 0 finish');
});

test('advance() in pieces gives the same trucks and the same report.ops however the run is cut', () => {
  const layout = microPlant({
    storage: true,
    inbound: { doors: 2, checkIn: 30, checkOut: 30, interArrival: dist('exp', 300, 0), pallets: dist('uniform', 6, 0.5), noShow: 0 },
    outbound: { doors: 1, checkIn: 30, checkOut: 30, interArrival: dist('normal', 500, 0.3), pallets: CONST(6), staging: 3, maxDwell: 400 },
    fleet: { count: 3 },
  });
  const digest = (cuts) => {
    const sim = new Simulation(layout, { seed: 6 });
    let t = 0;
    for (const cut of cuts) { t += cut; sim.advance(cut); }
    return [t, JSON.stringify(sim.kpis().ops), sim.logistics.truckSeq];
  };
  const whole = digest([7200]);
  assert.deepEqual(digest([100, 3000.5, 4099.5]), whole);
  assert.deepEqual(digest(Array.from({ length: 72 }, () => 100)), whole);
  assert.ok(whole[2] > 20, `${whole[2]} trucks`);
});

test('24 hours: a plant with two truck stations and a timetable runs in bounded memory, the lists stay short and the cost is small', () => {
  const rows = Array.from({ length: 48 }, (_, i) => ({ at: i * 1800 + 60, pallets: i % 4 === 0 ? null : 10 }));
  const layout = microPlant({
    storage: true,
    inbound: { mode: 'schedule', doors: 3, checkIn: 60, checkOut: 60, schedule: rows, pallets: CONST(8), jitter: 600, noShow: 0.1 },
    outbound: { doors: 2, checkIn: 60, checkOut: 60, interArrival: CONST(1200), pallets: CONST(12), staging: 6, maxDwell: 900 },
    fleet: { count: 4 },
  });
  layout.calendar = { startTod: 0, startDay: 0 };
  const w = createWorld(normalizeLayout(layout), { dt: 1, seed: 2 });
  const cpu = process.cpuUsage();
  let longest = 0;
  for (let hour = 0; hour < 24; hour++) {
    w.run(3600);
    for (const id of ['A', 'C']) {
      const d = w.lg.stationById.get(id).trucks;
      longest = Math.max(longest, d.gate.length, d.docked.length, d.staged.length, d.due.length - d.dueIdx);
      assert.ok(d.due.length <= 2 * rows.length + 1, `${id}: the due list holds ${d.due.length} entries`);
    }
    assertInvariants(w.lg, `hour ${hour}`);
  }
  const used = process.cpuUsage(cpu);
  const seconds = (used.user + used.system) / 1e6;
  assert.ok(longest <= 100, `the longest list: ${longest}`);
  assert.ok(w.lg.liveLoads < 500, `${w.lg.liveLoads} live pallets after a day`);
  assert.ok(w.named('truckArrived').length > 60 && w.lg.completed > 300, `${w.named('truckArrived').length} trucks, ${w.lg.completed} pallets`);
  assert.ok(seconds < 20, `24 simulated hours took ${seconds.toFixed(1)} s of CPU`);
});

// ---- the minimum batch of a flow at a truck station (M1-SIM-REV-1 and 2) -----------------------------------------------------

/** The sizes of the orders of the plant, in the order they were given. */
const orderSizes = (w, flowId = null) => w.named('orderAssigned').filter((p) => flowId === null || p.order.flowId === flowId).map((p) => p.order.qty);

test('a minimum batch does not hold the last pallets of a truck back: they go as a smaller batch, the door is freed (Goods in)', () => {
  const layout = inbound(
    { doors: 1, checkIn: 0, checkOut: 0, interArrival: CONST(600), pallets: CONST(6) },
    { flows: [['A', 'C', { batchMin: 4 }]], fleet: { count: 2, capacity: 4 } },
  );
  const w = createWorld(layout, { dt: 0.25, check: true });
  w.run(3600);
  const desk = w.lg.stationById.get('A').trucks;
  assert.equal(desk.arrived, 6, 'a truck every 10 minutes, the first at 0');
  assert.ok(desk.departed >= 5, `${desk.departed} of ${desk.arrived} trucks left: only the last one may still be at its door, nothing waits for a batch that only the next truck could bring`);
  assert.equal(desk.gate.length, 0);
  assert.deepEqual([...new Set(orderSizes(w))].sort(), [2, 4], 'six pallets go as 4 and 2');
  assert.equal(orderSizes(w).length % 2, 0, 'two trips per truck');
});

test('a minimum batch still waits for pallets that are on their way: the check-in of the next truck keeps the remainder back, a truck at the gate does not', () => {
  // two doors; truck 1 (6 pallets) is released at 160, truck 2 (6 pallets) at 161: the 2 pallets left of truck 1 wait for them, so the batches are 4, 4, 4
  const timetable = (doors) => inbound(
    { mode: 'schedule', doors, checkIn: 60, checkOut: 0, schedule: [{ at: 100, pallets: 6 }, { at: 101, pallets: 6 }] },
    { flows: [['A', 'C', { batchMin: 4 }]], fleet: { count: 1, capacity: 4, loadTime: 5, unloadTime: 5 }, calendar: { startTod: 0 } },
  );
  const together = createWorld(timetable(2), { dt: 0.25, check: true });
  together.run(1500);
  assert.deepEqual(orderSizes(together), [4, 4, 4]);
  // with ONE door the second truck cannot dock, so it cannot complete the batch: it waits at the gate and is not counted
  const queue = createWorld(timetable(1), { dt: 0.25, check: true });
  queue.run(1500);
  assert.deepEqual(orderSizes(queue), [4, 2, 4, 2], 'the second truck waits at the gate (it is not counted), so the 2 left of the first one go on their own');
  assert.equal(queue.lg.stationById.get('A').trucks.departed, 2);
});

test('a minimum batch waits for the next truck while a door is free for it - small trucks still make full batches - but not longer than BATCH_WAIT', () => {
  // six doors, a truck of ONE pallet every minute, a batch of three: the trucks hold their doors for a few minutes and every trip carries three pallets
  const small = createWorld(inbound(
    { doors: 6, checkIn: 0, checkOut: 0, interArrival: CONST(60), pallets: CONST(1) },
    { flows: [['A', 'C', { batchMin: 3 }]], fleet: { count: 2, capacity: 4 } },
  ), { dt: 0.25, check: true });
  small.run(1800);
  assert.ok(orderSizes(small).length >= 5 && orderSizes(small).every((q) => q === 3), `trips: ${orderSizes(small)}`);
  // the last truck of a timetable (a door is free, nobody comes): its remainder waits BATCH_WAIT for a batch that never fills, then goes and frees the door
  const last = createWorld(inbound(
    { mode: 'schedule', doors: 2, checkIn: 0, checkOut: 0, schedule: [{ at: 600, pallets: 6 }] },
    { flows: [['A', 'C', { batchMin: 4 }]], fleet: { count: 1, capacity: 4, loadTime: 5, unloadTime: 5 }, calendar: { startTod: 0 } },
  ), { dt: 0.25, check: true });
  last.run(600 + BATCH_WAIT - 20);
  assert.deepEqual(orderSizes(last), [4], 'the 2 left over still wait: a second truck could complete the batch');
  assert.equal(last.lg.stationById.get('A').trucks.docked.length, 1);
  last.run(60 + 200);
  assert.deepEqual(orderSizes(last), [4, 2], 'after BATCH_WAIT the remainder goes');
  const sent = last.named('orderAssigned').map((p) => p.t);
  assert.ok(sent[1] - 600 >= BATCH_WAIT - 1 && sent[1] - 600 < BATCH_WAIT + 30, `the remainder was sent ${sent[1] - 600} s after the truck was ready`);
  assert.equal(last.lg.stationById.get('A').trucks.departed, 1, 'and the truck left');
  // a second truck within that time completes the batch
  const joined = createWorld(inbound(
    { mode: 'schedule', doors: 2, checkIn: 0, checkOut: 0, schedule: [{ at: 600, pallets: 6 }, { at: 1000, pallets: 6 }] },
    { flows: [['A', 'C', { batchMin: 4 }]], fleet: { count: 1, capacity: 4, loadTime: 5, unloadTime: 5 }, calendar: { startTod: 0 } },
  ), { dt: 0.25, check: true });
  joined.run(1300);
  assert.deepEqual(orderSizes(joined), [4, 4, 4], '2 + 6 pallets: two full batches and the first truck is done');
});

test('a minimum batch is only lowered at a truck station: legacy flows and flows between other stations keep it', () => {
  // Goods in without trucks: 6 pallets arrive at once, the batch of 4 sends 4 and the other 2 wait for more (they do not arrive)
  const legacy = microPlant({ storage: false, aParams: { interArrival: CONST(100000), batch: 6 }, flows: [['A', 'C', { batchMin: 4 }]], fleet: { count: 2, capacity: 4 } });
  const w = createWorld(legacy, { dt: 0.25, check: true });
  w.run(600);
  assert.deepEqual(orderSizes(w), [4], 'the remainder of 2 waits for ever, as before');
  // a flow from a Goods in with trucks into a storage: same rule as into a sink
  const viaStorage = createWorld(microPlant({
    storage: true, inbound: { doors: 1, checkIn: 0, checkOut: 0, interArrival: CONST(600), pallets: CONST(6) },
    flows: [['A', 'S', { batchMin: 4 }], ['S', 'C']], fleet: { count: 2, capacity: 4 },
  }), { dt: 0.25, check: true });
  viaStorage.run(3600);
  assert.ok(viaStorage.lg.stationById.get('A').trucks.departed >= 5);
});

test('a minimum batch with several flows out of a Goods in: the remainder of each flow goes, nothing is held for a flow that gets no more', () => {
  const layout = inbound(
    { doors: 1, checkIn: 0, checkOut: 0, interArrival: CONST(900), pallets: CONST(9) },
    { storage: true, flows: [['A', 'S', { batchMin: 4 }], ['A', 'C', { batchMin: 4 }], ['S', 'C']], fleet: { count: 3, capacity: 4 } },
  );
  const w = createWorld(layout, { dt: 0.25, check: true });
  w.run(5400);
  const desk = w.lg.stationById.get('A').trucks;
  assert.equal(desk.arrived, 6);
  assert.ok(desk.departed >= 5, `${desk.departed} of ${desk.arrived} trucks left`);
});

test('Goods out: the places left on a truck are filled although they are fewer than the minimum batch (maxDwell 0 = until full)', () => {
  const layout = microPlant({
    storage: true, goodsIn: false,
    outbound: { doors: 1, checkIn: 0, checkOut: 0, interArrival: CONST(900), pallets: CONST(22), staging: 0, maxDwell: 0 },
    flows: [['S', 'C', { batchMin: 4 }]], fleet: { count: 3, capacity: 4 },
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  injectLoads(w.lg, 'f1', 200);
  w.run(4 * 3600);
  const desk = w.lg.stationById.get('C').trucks;
  assert.ok(desk.departed >= 3, `${desk.arrived} trucks arrived, ${desk.departed} left`);
  assert.equal(desk.short, 0, 'every truck left with its 22 pallets');
  assert.equal(desk.loadedTotal, desk.planned);
  assert.ok(orderSizes(w).includes(2), 'the last two places are filled by a trip of 2');
  assert.ok(orderSizes(w).every((q) => q === 4 || q === 2));
});

test('Goods out: with maxDwell a truck fills up too, and a short departure is only the supply being short', () => {
  const layout = microPlant({
    storage: true, goodsIn: false,
    outbound: { doors: 1, checkIn: 0, checkOut: 0, interArrival: CONST(1200), pallets: CONST(22), staging: 0, maxDwell: 3600 },
    flows: [['S', 'C', { batchMin: 4 }]], fleet: { count: 3, capacity: 4 },
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  injectLoads(w.lg, 'f1', 200);
  w.run(4 * 3600);
  const desk = w.lg.stationById.get('C').trucks;
  assert.ok(desk.departed >= 6 && desk.short === 0, `${desk.departed} trucks left, ${desk.short} short, with 200 pallets in the storage`);
});

test('Goods out with staging: the staging space is filled in batches as before, only the remainder is smaller', () => {
  const layout = microPlant({
    storage: true, goodsIn: false,
    outbound: { doors: 2, checkIn: 0, checkOut: 0, interArrival: CONST(2400), pallets: CONST(10), staging: 3, maxDwell: 1800 },
    flows: [['S', 'C', { batchMin: 4 }]], fleet: { count: 3, capacity: 4 },
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  injectLoads(w.lg, 'f1', 100);
  w.run(3 * 3600);
  const desk = w.lg.stationById.get('C').trucks;
  assert.equal(desk.short, 0);
  assert.ok(desk.departed >= 3);
  assert.equal(w.lg.stationById.get('C').fillLabel, `${desk.staged.length}/6`);
});

test('a Goods out without staging space shows no "0/0" on its brick', () => {
  const none = createWorld(microPlant({ storage: true, outbound: { doors: 1, staging: 0 }, fleet: null }), { dt: 1 });
  const c = none.lg.stationById.get('C');
  assert.equal(c.fillLabel, '');
  assert.equal(c.fill, 0);
  const some = createWorld(microPlant({ storage: true, outbound: { doors: 2, staging: 3 }, fleet: null }), { dt: 1 });
  assert.equal(some.lg.stationById.get('C').fillLabel, '0/6');
});

// ---- the invariants helper is not vacuous --------------------------------------------------------------------------------------

test('the invariants of 6.3.5 catch engine bugs: a door freed at half the check-out or half a minute late, a room that forgets the places promised or counts a truck in check-in', () => {
  // (the seeds were calibrated: each plant reaches the bug within 900 s; if an engine change moves them, scan seeds 1..30 for one that does and put it here)
  const P = TruckDesk.prototype;
  const bugs = [
    ['the door is free after half of the check-out', 'beginCheckout', (o) => function (truck, t) { o.call(this, truck, t); truck.freeAt = t + this.checkOut / 2; }, 5, /began its check-out/],
    ['the door stays blocked half a minute after the check-out', 'beginCheckout', (o) => function (truck, t) { o.call(this, truck, t); truck.freeAt = t + this.checkOut + 30; }, 2, /began its check-out/],
    ['room() ignores the places already promised', 'room', (o) => function (st) { const saved = st.inboundTotal; st.inboundTotal = 0; try { return o.call(this, st); } finally { st.inboundTotal = saved; } }, 2, /room \d+ is not|places promised/],
    ['room() counts a truck that is still in check-in', 'room', (o) => function (st) { let room = o.call(this, st); for (const k of this.docked) if (k.state === 'checkin') room += k.plan; return room; }, 3, /room \d+ is not|places promised/],
  ];
  for (const [what, method, make, seed, message] of bugs) {
    const original = P[method];
    P[method] = make(original);
    let failure = null;
    try {
      createWorld(fuzzPlant(seed, { style: seed % 2 ? 'hostile' : 'busy' }), { dt: 0.5, seed, check: true }).run(900);
    } catch (e) { failure = e.message; } finally { P[method] = original; }
    assert.ok(failure !== null && message.test(failure), `${what}: ${failure === null ? 'not caught' : failure.split('\n').slice(0, 2).join(' | ')}`);
  }
  createWorld(fuzzPlant(5, { style: 'hostile' }), { dt: 0.5, seed: 5, check: true }).run(900); // and the real engine passes the same plants
});
