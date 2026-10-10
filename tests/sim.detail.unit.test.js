// The detail collector (js/sim/detail.js, docs/ENTITY-INSIGHTS-DESIGN.md 6, 10.1) on a scripted fake simulation: one fact at a time, with the numbers worked out by hand.
// The fake (tests/helpers/fake-sim.js createFakeDetailSim) lets a test put a vehicle into any state at any moment, hand it a route, make it wait, break it, or remove it,
// and runs the collector's poll after every tick exactly as Simulation.step does. Nothing here depends on the real engine's behaviour; the regressions that need the
// engine are in sim.detail.regress.test.js, the cross-checks against the report in sim.detail.exact.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeDetailSim } from './helpers/fake-sim.js';
import { layoutFromAscii } from './helpers/ascii.js';
import { BUCKET_S, Detail, FLAG, LEG_START, NO_STATION, RING, SLOT_KEYS } from '../js/sim/detail.js';

// A on the left (source), B in the middle (sink), D on the right (depot); a straight two-way road under them.
//   y=0  A A . . B B . . D D        road cells (x, 1), x = 0..9; node id = 10 * y + x (the layout is padded to 10 columns)
//   y=1  + + + + + + + + + +
const LINES = ['AA..BB..DD', '++++++++++'];
function plant({ vehicles = 2, settings, dt = 0.5, fleets } = {}) {
  const layout = layoutFromAscii(LINES, {
    settings, stations: { A: 'source', B: 'sink', D: { type: 'depot', params: { slots: 4, chargers: 1 } } }, flows: [['A', 'B']], fleets: fleets || [{ count: vehicles }],
  });
  const sim = createFakeDetailSim(layout, { dt });
  return { sim, det: sim.enableDetail(), A: 0, B: 1, D: 2 };
}
const cells = (from, to) => { const out = []; const step = from <= to ? 1 : -1; for (let x = from; x !== to + step; x += step) out.push([x, 1]); return out; };
const at = (sim, from, to) => sim.route(...cells(from, to));
const total = (t) => SLOT_KEYS.reduce((n, k) => n + t[k], 0);

/** One whole job on the road: 10 s empty to A, 2 s loading, 6 s loaded to B (waiting `held` s of it, `queue` of those in the queue for B's dock), 1 s unloading, a delivery. */
function job(sim, v, { held = 0, queue = false, cell = 33 } = {}) {
  const order = sim.order('f1', 2);
  sim.go(v, 'toPickup', { order, targetId: 'A', route: at(sim, 8, 1) });
  sim.advance(10);
  sim.go(v, 'loading', { tv: { driving: false } });
  sim.advance(2);
  sim.go(v, 'toDrop', { targetId: 'B', route: at(sim, 1, 4), dock: queue ? { station: 'B', queue: true } : null });
  if (held > 0) { v.tv.waiting = true; v.tv._cell = cell; sim.advance(held); v.tv.waiting = false; }
  sim.advance(6 - held);
  sim.go(v, 'unloading', { tv: { driving: false } });
  sim.advance(1);
  sim.deliveries(v, 1, order);
  sim.go(v, 'idle', { order: null, targetId: null, route: null, dock: null });
  sim.advance(1);
  return order;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// legs
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('a drive is one row of the leg log: kind, origin, destination, flow, path, start, duration, held-up seconds, queue seconds and loads', () => {
  const { sim, det, A, B, D } = plant();
  const v = sim.veh('v1#1');
  job(sim, v, { held: 3, queue: true });
  const L = det.legs;
  assert.equal(L.count, 2, 'an empty drive and a loaded one');
  assert.deepEqual([L.kind[0], L.from[0], L.to[0], L.veh[0], L.flow[0]], [0, D, A, 0, 0], 'the empty leg starts at the depot dock cell (8, 1) and ends at A');
  assert.equal(L.t0[0], 0); assert.equal(L.dur[0], 10); assert.equal(L.qty[0], 0); assert.equal(L.flags[0], 0);
  assert.deepEqual([L.kind[1], L.from[1], L.to[1], L.qty[1]], [1, A, B, 2], 'the loaded leg runs from A to B and carries the order quantity');
  assert.equal(L.t0[1], 12); assert.equal(L.dur[1], 6); assert.equal(L.wait[1], 3); assert.equal(L.dockWait[1], 3, 'the 3 s held up were a queue for the dock of B');
  assert.equal(L.wait[0], 0);
  assert.ok(L.path[0] >= 0 && L.path[1] >= 0 && L.path[0] !== L.path[1]);
  const t = det.timeSplit(0, det.windowOf('start'));
  assert.equal(t.drivingLoaded, 3, '6 s loaded, 3 of them counted as dock queue'); assert.equal(t.dockQueue, 3);
  assert.equal(t.drivingEmpty, 10); assert.equal(t.loading, 2); assert.equal(t.unloading, 1);
  assert.equal(det.counts(0).trips, 1); assert.equal(det.counts(0).qty, 2);
});

test('routesOf groups the legs of a vehicle by kind, origin and destination, with trips, means and the usual path', () => {
  const { sim, det, A, B } = plant();
  const v = sim.veh('v1#1');
  job(sim, v); job(sim, v, { held: 2 }); job(sim, v);
  const loaded = det.routesOf(0, det.windowOf('start'), [1]);
  assert.equal(loaded.length, 1);
  const r = loaded[0];
  assert.deepEqual([r.kind, r.from, r.to, r.trips, r.complete, r.drawn, r.undrawn, r.variants], [1, A, B, 3, 3, 3, 0, 1]);
  assert.equal(r.pathShare, 1); assert.equal(r.metres, 3 * 2, 'three steps of 2 m from cell 1 to cell 4');
  assert.ok(Math.abs(r.meanTime - 6) < 1e-9 && Math.abs(r.meanWait - 2 / 3) < 1e-6);
  assert.equal(det.routesOf(0, det.windowOf('start'), [0]).length, 1, 'the empty drives are their own group');
  assert.equal(det.routesOf(0, det.windowOf('start'), [0, 1]).length, 2);
  assert.deepEqual(det.routesOf(0, det.windowOf('start'), [2, 3]), []);
  assert.deepEqual(det.routesOf(1, det.windowOf('start')), [], 'the other vehicle did not drive');
});

test('a breakdown pauses a leg: its duration excludes the repair, the held-up seconds are only those of driving', () => {
  const { sim, det } = plant();
  const v = sim.veh('v1#1');
  const order = sim.order('f1');
  sim.go(v, 'toDrop', { order, targetId: 'B', route: at(sim, 1, 4) });
  sim.advance(2);
  sim.go(v, 'broken', { tv: { disabled: true } }); // resumeState would be toDrop
  v.tv.waiting = true; v.tv._cell = 44; // a broken vehicle that is still "held up": booked by traffic, not part of the leg
  sim.advance(20);
  v.tv.waiting = false;
  sim.go(v, 'toDrop', { tv: { disabled: false } });
  sim.advance(3);
  sim.go(v, 'unloading', { tv: { driving: false } });
  sim.advance(1);
  const L = det.legs;
  assert.equal(L.count, 1);
  assert.equal(L.dur[0], 5, '2 s before the breakdown plus 3 s after the repair; the 20 s of repair are not in it');
  assert.ok(L.flags[0] & FLAG.PAUSED, 'flagged as paused by a breakdown');
  assert.equal(L.wait[0], 0, 'the broken vehicle was not held up by traffic');
  const t = det.timeSplit(0, det.windowOf('start'));
  assert.equal(t.broken, 20); assert.equal(t.waiting, 0, 'seconds of a held-up vehicle that is not in a driving state are not "waiting"');
  assert.equal(det.hotspots(0, 5).total, 0, 'and no cell row either (they go to the stray table)');
});

test('a dead battery drops the leg (no row), and the vehicle counts as broken from then on', () => {
  const { sim, det } = plant();
  const v = sim.veh('v1#1');
  sim.go(v, 'toPickup', { order: sim.order('f1'), targetId: 'A', route: at(sim, 8, 1) });
  sim.advance(4);
  sim.go(v, 'dead', { order: null, targetId: null, route: null });
  sim.advance(6);
  assert.equal(det.legs.count, 0);
  const t = det.timeSplit(0, det.windowOf('start'));
  assert.equal(t.broken, 6); assert.equal(t.driving, 4);
  assert.equal(det.open[0], 0);
});

test('a state left and entered again inside one tick still gives two legs', () => {
  const { sim, det } = plant();
  const v = sim.veh('v1#1');
  sim.go(v, 'toPickup', { order: sim.order('f1'), targetId: 'A', route: at(sim, 8, 1) });
  sim.advance(2);
  // the engine ended the leg and began another one of the same kind within one tick: only stateSince tells
  sim.go(v, 'toPickup', { order: sim.order('f1'), targetId: 'A', route: at(sim, 7, 1) });
  sim.advance(2);
  sim.go(v, 'idle', { order: null, targetId: null, route: null });
  sim.advance(1);
  assert.equal(det.legs.count, 2);
  assert.equal(det.legs.dur[0], 2); assert.equal(det.legs.dur[1], 2);
});

test('a leg whose order is given back before the vehicle left makes no row; a new order or target while a leg is open starts a new leg', () => {
  const { sim, det } = plant();
  const v = sim.veh('v1#1');
  sim.go(v, 'toPickup', { order: sim.order('f1'), targetId: 'A' }); // no route yet: nothing drives
  sim.advance(2);
  sim.go(v, 'idle', { order: null, targetId: null });
  sim.advance(1);
  assert.equal(det.legs.count, 0, 'never drove, no row');
  sim.go(v, 'toPickup', { order: sim.order('f1'), targetId: 'A', route: at(sim, 8, 1) });
  sim.advance(2);
  v.order = sim.order('f1'); v.targetId = 'B'; // re-assigned on the move, state and stateSince unchanged
  v.route = at(sim, 6, 4);
  sim.advance(2);
  sim.go(v, 'idle', { order: null, targetId: null, route: null });
  sim.advance(1);
  assert.equal(det.legs.count, 2, 'the change of target closed the first leg and opened the second');
});

test('a route object that is used again has one path id; equal cells in another object intern to the same id; different cells are another id', () => {
  const { sim, det } = plant();
  const r1 = at(sim, 8, 1);
  const r2 = at(sim, 8, 1); // equal cells, another object
  const r3 = at(sim, 8, 2);
  const pool = det.pool;
  const id1 = pool.intern(r1);
  assert.equal(pool.intern(r1), id1, 'same object');
  assert.equal(pool.intern(r2), id1, 'same cells');
  assert.notEqual(pool.intern(r3), id1);
  assert.equal(pool.size, 2);
  const rev = sim.route(...cells(1, 8));
  assert.notEqual(pool.intern(rev), id1, 'the way back is another path');
});

test('packed paths decode to the cells of their routes, including turns', () => {
  // an L-shaped plant: east along the top road, then south
  const layout = layoutFromAscii(['A.......', '+++++++.', '......+.', '......+B'], { stations: { A: 'source', B: 'sink' }, flows: [['A', 'B']] });
  const sim = createFakeDetailSim(layout);
  const det = sim.enableDetail();
  const route = sim.route([0, 1], [1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [6, 2], [6, 3]);
  const id = det.pool.intern(route);
  assert.deepEqual(Array.from(det.pool.nodes(id)), route.nodes);
  assert.equal(det.pool.len[id], 8); assert.equal(det.pool.start[id], route.nodes[0]);
  assert.deepEqual(Array.from(det.pool.nodes(999)), [], 'an unknown id decodes to nothing');
});

test('a full path pool keeps counting: the leg is a trip with path -1, not a variant, not drawn', () => {
  const { sim, det } = plant();
  det.pool.cap = 1;
  const v = sim.veh('v1#1');
  job(sim, v);
  const r = det.routesOf(0, det.windowOf('start'), [1])[0];
  assert.equal(det.pool.size, 1);
  assert.equal(det.pool.overflow, 1);
  assert.equal(r.trips, 1); assert.equal(r.undrawn, 1); assert.equal(r.drawn, 0); assert.equal(r.pathId, -1); assert.equal(r.pathShare, 0); assert.equal(r.variants, 0);
  assert.equal(det.counts(0).trips, 1, 'the delivery is still counted');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// time and waiting
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('the time split of every vehicle adds up to the elapsed time after every tick, in whatever state it is', () => {
  const { sim, det } = plant({ vehicles: 3 });
  const [a, b, c] = sim.vehicles;
  const states = ['idle', 'toPickup', 'loading', 'toDrop', 'unloading', 'toPark', 'parked', 'toCharger', 'charging', 'broken', 'dead'];
  let n = 0;
  for (let i = 0; i < 60; i++) {
    const s = states[(i * 7 + n++) % states.length];
    sim.go(a, s, DRIVING(s) ? { order: sim.order('f1'), targetId: 'A', route: at(sim, 8, 1) } : { route: null });
    sim.go(b, states[(i * 3) % states.length], {});
    c.tv.waiting = i % 5 === 0; c.tv._cell = 15;
    sim.advance(1);
    for (let k = 0; k < 3; k++) {
      const t = det.timeSplit(k, det.windowOf('start'));
      assert.ok(Math.abs(total(t) - sim.time) < 1e-9, `vehicle ${k} after ${sim.time} s: ${total(t)}`);
      assert.ok(Math.abs(t.drivingLoaded + t.drivingEmpty + t.drivingDepot - t.driving) < 1e-9, 'the three parts of driving add up to driving');
    }
  }
});
function DRIVING(s) { return s === 'toPickup' || s === 'toDrop' || s === 'toCharger' || s === 'toPark'; }

test('waiting seconds are booked on the cell that blocks; the part that was a queue for a dock is also in hotQ; hotspots() leaves the queue seconds out', () => {
  const { sim, det } = plant();
  const v = sim.veh('v1#1');
  sim.go(v, 'toDrop', { order: sim.order('f1'), targetId: 'B', route: at(sim, 1, 4), dock: { station: 'B', queue: false } });
  v.tv.waiting = true; v.tv._cell = 12;
  sim.advance(4); // 4 s of plain traffic wait on cell 12
  v.dock.queue = true; v.tv._cell = 13;
  sim.advance(6); // 6 s in the queue for the dock, booked on cell 13
  v.tv.waiting = false;
  sim.advance(1);
  const t = det.timeSplit(0, det.windowOf('start'));
  assert.equal(t.waiting, 4); assert.equal(t.dockQueue, 6);
  const h = det.hotspots(0, 5);
  assert.equal(h.total, 10, 'everything the vehicle waited, booked on cells');
  assert.deepEqual(h.cells, [{ node: 12, seconds: 4 }], 'the queue seconds are the dock queue row (queuesOf), not a cell row');
  assert.equal(det.queueSecondsAt(0, 13), 6);
  // the running streak is part of the answer without being flushed into the table: asking twice, or in between, changes nothing
  const before = JSON.stringify([det.hot.keys, det.hot.secs, det.hotQ.secs]);
  det.hotspots(0, 5); det.hotspots(0, 5);
  assert.equal(JSON.stringify([det.hot.keys, det.hot.secs, det.hotQ.secs]), before);
});

test('a held-up vehicle that is not in a driving state goes to the stray table only: not "waiting", not a cell row, still booked', () => {
  const { sim, det } = plant();
  const v = sim.veh('v1#1');
  sim.go(v, 'idle', {});
  v.tv.waiting = true; v.tv._cell = 17; // the engine's nodeWait books it, the Waiting tile does not
  sim.advance(8);
  const t = det.timeSplit(0, det.windowOf('start'));
  assert.equal(t.waiting + t.dockQueue, 0); assert.equal(t.idle, 8);
  assert.deepEqual(det.hotspots(0, 5).cells, []);
  let stray = 0;
  for (let k = 0; k < 24; k++) if (det.hotStray.keys[k] === 17) stray += det.hotStray.secs[k];
  assert.equal(stray, 8);
});

test('the cell table of a vehicle holds 24 cells; the 25th is folded into `other` and the total still adds up', () => {
  const { sim, det } = plant();
  const v = sim.veh('v1#1');
  sim.go(v, 'toDrop', { order: sim.order('f1'), targetId: 'B', route: at(sim, 1, 4) });
  v.tv.waiting = true;
  let sum = 0;
  for (let cell = 0; cell < 40; cell++) {
    v.tv._cell = 100 + cell;
    const dt = 1 + (cell % 3); // 1, 2 or 3 s on each of 40 different cells
    sim.advance(dt); sum += dt;
    v.tv.waiting = false; sim.advance(0.5); v.tv.waiting = true; // end the streak so the cell is flushed into the table
  }
  v.tv.waiting = false;
  sim.advance(1);
  const h = det.hotspots(0, 100);
  assert.ok(h.folded > 0, 'cells were folded into other');
  assert.ok(h.cells.length <= 24);
  assert.ok(Math.abs(h.total - sum) < 1e-4, `the total is every second booked: ${h.total} against ${sum}`);
  const listed = h.cells.reduce((n, c) => n + c.seconds, 0);
  assert.ok(Math.abs(listed + h.folded - sum) < 1e-4);
});

test('idleSpots: where a vehicle stood without a job, longest first', () => {
  const { sim, det } = plant();
  const v = sim.veh('v1#1');
  sim.go(v, 'idle', { tv: { node: 14 } });
  sim.advance(9);
  sim.go(v, 'idle', { tv: { node: 16 } }); // a new idle period on another cell
  sim.advance(3);
  assert.deepEqual(det.idleSpots(0, 3), [{ node: 14, seconds: 9 }, { node: 16, seconds: 3 }]);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// windows
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('reset(t) starts a fresh window: the logs are empty, the counters are relative, a drive in progress becomes a partial leg that starts at t', () => {
  const { sim, det } = plant();
  const v = sim.veh('v1#1');
  job(sim, v);
  sim.go(v, 'toPickup', { order: sim.order('f1'), targetId: 'A', route: at(sim, 8, 1) });
  sim.advance(5);
  sim.fresh = true; // the end of the warm-up
  sim.advance(0.5);
  assert.equal(det.windowStart, sim.time, 'the window starts at the end of the tick that ended the warm-up');
  assert.equal(det.legs.count, 0);
  assert.equal(det.counts(0).trips, 0, 'the delivery before the reset is not in the window');
  assert.equal(det.timeSplit(0).seconds, 0);
  sim.advance(4);
  sim.go(v, 'loading', { tv: { driving: false } });
  sim.advance(1);
  assert.equal(det.legs.count, 1);
  assert.ok(det.legs.flags[0] & FLAG.PARTIAL, 'it started before the window');
  assert.equal(det.legs.t0[0], det.windowStart, 'and is counted from the window start');
  assert.equal(det.legs.dur[0], 4, 'the duration is the part inside the window');
  const r = det.routesOf(0, det.windowOf('start'), [0])[0];
  assert.equal(r.trips, 1); assert.equal(r.complete, 0, 'a partial leg is a trip but not in the time statistics'); assert.equal(r.meanTime, null);
});

test('a leg that ends in the very tick that ends the warm-up belongs to the warm-up; the leg that begins in it is a partial leg of the window', () => {
  const { sim, det, A, B } = plant();
  const v = sim.veh('v1#1');
  const order = sim.order('f1', 1);
  sim.go(v, 'toDrop', { order, targetId: 'B', route: at(sim, 1, 4) });
  sim.advance(5);
  sim.fresh = true;
  // inside the last tick of the warm-up: the drive ends (unloading begins) ...
  sim.advance(0.5, () => sim.go(v, 'unloading', { tv: { driving: false } }));
  assert.equal(det.windowStart, sim.time);
  sim.advance(1);
  sim.deliveries(v, 1, order);
  sim.go(v, 'toPickup', { order: sim.order('f1'), targetId: 'A', route: at(sim, 8, 1) });
  sim.advance(2);
  sim.go(v, 'loading', { tv: { driving: false } });
  sim.advance(1);
  const loaded = det.routesOf(0, det.windowOf('start'), [1]);
  assert.deepEqual(loaded, [], 'the loaded leg ended in the warm-up: no trip, no bogus leg of zero duration');
  assert.equal(det.counts(0).trips, 1, 'but the delivery that followed is in the window (it began unloading before it, credit 1)');
  assert.equal(det.credit[0], 1);
  assert.equal(det.legsLoaded[0] - (v.trips - det.base[0] - det.credit[0]), 0, 'the balance is exact');
  // a second vehicle begins a drive in that very tick
  const w = plant();
  const u = w.sim.veh('v1#1');
  w.sim.advance(3);
  w.sim.fresh = true;
  w.sim.advance(0.5, () => w.sim.go(u, 'toPickup', { order: w.sim.order('f1'), targetId: 'A', route: at(w.sim, 8, 1) }));
  w.sim.advance(2);
  w.sim.go(u, 'loading', { tv: { driving: false } });
  w.sim.advance(1);
  const empty = w.det.routesOf(0, w.det.windowOf('start'), [0]);
  assert.equal(empty.length, 1); assert.equal(empty[0].trips, 1); assert.equal(empty[0].complete, 0, 'adopted as a partial leg');
  assert.equal(A, 0); assert.equal(B, 1);
});

test('the snapshot ring: "Last 30 min" is the difference of now and the row 30 minutes ago; before 30 minutes it is the whole run (zero)', () => {
  const { sim, det } = plant({ dt: 1 });
  const v = sim.veh('v1#1');
  sim.go(v, 'idle', {});
  sim.advance(600);
  let w = det.windowOf('last30');
  assert.equal(w.kind, 'last30'); assert.equal(w.zero, true, 'ten minutes in: Last 30 min equals Since start'); assert.equal(w.t0, det.windowStart);
  assert.equal(det.timeSplit(0, w).idle, 600);
  sim.go(v, 'parked', {});
  sim.advance(3600 - 600);
  w = det.windowOf('last30');
  assert.equal(w.zero, false);
  assert.equal(w.t0, det.windowStart + (det.bCount - (RING - 1)) * BUCKET_S);
  assert.ok(w.seconds >= 1800 && w.seconds < 1800 + BUCKET_S + 1e-9, `${w.seconds}`);
  const t = det.timeSplit(0, w);
  assert.equal(t.idle, 0, 'idle stopped 50 minutes ago'); assert.ok(Math.abs(t.parked - w.seconds) < 1e-3, 'the last 30 minutes were parked');
  assert.ok(Math.abs(total(t) - w.seconds) < 1e-3, 'the split adds up to the window');
  const s = det.timeSplit(0, det.windowOf('start'));
  assert.equal(s.idle, 600); assert.equal(s.parked, 3000);
  assert.equal(det.bCount, 3600 / BUCKET_S); assert.ok(det.bCount > RING, 'the ring has wrapped');
});

test('workingSeries gives the busy share of each 30 s bucket, oldest first', () => {
  const { sim, det } = plant({ dt: 1 });
  const v = sim.veh('v1#1');
  sim.go(v, 'loading', {});
  sim.advance(60); // two buckets fully busy
  sim.go(v, 'idle', {});
  sim.advance(30); // one bucket idle
  sim.go(v, 'loading', {});
  sim.advance(15); sim.go(v, 'idle', {}); sim.advance(15); // half busy
  assert.deepEqual(det.workingSeries(0).map((x) => Math.round(x * 100) / 100), [1, 1, 0, 0.5]);
  assert.deepEqual(det.workingSeries(0, 2).map((x) => Math.round(x * 100) / 100), [0, 0.5]);
});

test('the leg ring grows by doubling, wraps at its cap, keeps the newest rows in order and says where it now begins', () => {
  const { sim, det } = plant({ dt: 1 });
  det.legs = new det.legs.constructor(8, 2); // 8 rows at most, 2 at the start
  const v = sim.veh('v1#1');
  for (let k = 0; k < 13; k++) job(sim, v);
  const L = det.legs;
  assert.equal(L.count, 26); assert.equal(L.size, 8); assert.equal(L.rows, 8);
  const starts = []; for (let k = 0; k < L.size; k++) starts.push(L.t0[L.at(k)]);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b), 'oldest first');
  const cov = det.legCoverage();
  assert.equal(cov.wrapped, true); assert.equal(cov.rows, 8); assert.equal(cov.since, starts[0]); assert.ok(cov.since > det.windowStart);
  const r = det.routesOf(0, det.windowOf('start'), [1])[0];
  assert.equal(r.trips, 4, 'the four loaded legs among the eight newest rows');
  assert.equal(det.counts(0).trips, 13, 'the report counters are not limited by the ring');
  // growth keeps the rows: a log that starts small holds what a big one holds
  const small = new det.legs.constructor(64, 2); const big = new det.legs.constructor(64, 64);
  for (let k = 0; k < 40; k++) { small.push(1, 1, 2, 3, 4, 5, k, 6, 7, 8, 9, 0); big.push(1, 1, 2, 3, 4, 5, k, 6, 7, 8, 9, 0); }
  assert.equal(small.rows, 64); assert.equal(small.bytes, 64 * 36);
  for (let k = 0; k < 40; k++) assert.equal(small.t0[small.at(k)], big.t0[big.at(k)]);
  const extra = new Detail(sim, { legStart: 4 });
  assert.equal(extra.legs.rows, 4);
  extra.detach();
  assert.equal(LEG_START, 2048);
});

test('charge sessions: the stop starts when charging starts, ends when it stops, with the battery before and after', () => {
  const { sim, det } = plant({ dt: 1 });
  const v = sim.veh('v1#1');
  v.battery = 0.2;
  sim.go(v, 'charging', { depot: sim.st('D') });
  sim.advance(30);
  v.battery = 0.9;
  sim.go(v, 'parked', {});
  sim.advance(5);
  const b = det.batteryOf(0, det.windowOf('start'));
  assert.equal(b.stops.length, 1);
  assert.deepEqual([b.stops[0].t0, b.stops[0].minutes], [0, 0.5]);
  assert.ok(Math.abs(b.stops[0].b0 - 0.2) < 1e-6 && Math.abs(b.stops[0].b1 - 0.9) < 1e-6);
  assert.ok(Math.abs(b.min - 0.2) < 1e-6, 'the lowest charge inside the window'); assert.equal(b.now, 0.9);
  const depotSecs = det.depotSecs; // [parked, charging] of the depot
  assert.equal(depotSecs[2 * 2 + 1], 30); assert.equal(depotSecs[2 * 2], 5);
});

test('the lowest battery is the lowest inside the window, per window: a dip 40 minutes ago is not in "Last 30 min"', () => {
  const { sim, det } = plant({ dt: 1 });
  const v = sim.veh('v1#1');
  sim.go(v, 'idle', {});
  v.battery = 0.3; sim.advance(10); v.battery = 0.9; // a dip at the start
  sim.advance(2700);
  assert.ok(Math.abs(det.batteryOf(0, det.windowOf('start')).min - 0.3) < 1e-6);
  const l = det.batteryOf(0, det.windowOf('last30'));
  assert.ok(Math.abs(l.min - 0.9) < 1e-6, `${l.min}`);
});

test('a change of a runtime setting is noted at the next bucket', () => {
  const { sim, det } = plant({ dt: 1 });
  sim.advance(45);
  sim.settings.demandFactor = 1.5;
  sim.advance(40);
  assert.equal(det.whatIf.length, 1);
  assert.deepEqual([det.whatIf[0].key, det.whatIf[0].from, det.whatIf[0].to], ['demandFactor', 1, 1.5]);
  assert.ok(det.whatIf[0].t >= 60 && det.whatIf[0].t <= 90);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// the origin of a loaded leg, the round, the stations
// ---------------------------------------------------------------------------------------------------------------------------------------------

test('the origin of a loaded leg is the station of its order, even when a replan starts the route on a road cell', () => {
  const layout = layoutFromAscii(['AA........BB', '++++++++++++'], { stations: { A: 'source', B: 'sink' }, flows: [['A', 'B']], fleets: [{ count: 1 }] });
  const sim = createFakeDetailSim(layout);
  const det = sim.enableDetail();
  const v = sim.veh('v1#1');
  const order = sim.order('f1');
  const route = (from, to) => sim.route(...cells(from, to));
  assert.equal(det.stationOfNode(sim.node(5, 1), 'A'), 0xffff, 'no station touches the middle of the road');
  sim.go(v, 'toDrop', { order, targetId: 'B', route: route(5, 9) });
  sim.advance(2);
  v.route = route(6, 9); v.tv.teleports++; // a deadlock relocation: a new route that starts on a road cell, in a new place
  sim.advance(2);
  sim.go(v, 'unloading', { tv: { driving: false } });
  sim.advance(1);
  const L = det.legs;
  assert.equal(L.count, 1);
  assert.deepEqual([L.kind[0], L.from[0], L.to[0]], [1, 0, 1], 'from A to B');
  assert.ok(L.flags[0] & FLAG.RELOCATED); assert.ok(L.flags[0] & FLAG.REROUTED);
  const r = det.routesOf(0, det.windowOf('start'), [1])[0];
  assert.equal(r.trips, 1); assert.equal(r.disturbed, 1); assert.equal(r.drawn, 0, 'a relocated leg is a trip but not a variant'); assert.equal(r.undrawn, 1);
});

test('the usual round: the most frequent pair of consecutive loaded trips between two visits of a depot, three occurrences at least', () => {
  const { sim, det, A, B } = plant();
  const v = sim.veh('v1#1');
  for (let k = 0; k < 4; k++) { job(sim, v); job(sim, v); sim.go(v, 'toPark', { route: at(sim, 4, 8), targetId: 'D' }); sim.advance(3); sim.go(v, 'parked', { route: null, targetId: null }); sim.advance(1); }
  const round = det.roundOf(0, det.windowOf('start'), 2);
  assert.deepEqual(round.jobs, [{ from: A, to: B }, { from: A, to: B }]);
  assert.equal(round.count, 4); assert.equal(round.of, 4); assert.equal(round.share, 1);
  const single = det.roundOf(0, det.windowOf('start'), 1);
  assert.equal(single.count, 8);
  assert.equal(det.roundOf(1, det.windowOf('start'), 2), null, 'the other vehicle: nothing');
  const short = plant();
  job(short.sim, short.sim.veh('v1#1')); job(short.sim, short.sim.veh('v1#1'));
  assert.equal(short.det.roundOf(0, short.det.windowOf('start'), 2), null, 'one pair of trips is not a round');
});

test('queuesOf: seconds in the queue for a dock by destination station, and the dock cell the legs ended at', () => {
  const { sim, det, B } = plant();
  const v = sim.veh('v1#1');
  job(sim, v, { held: 4, queue: true }); job(sim, v, { held: 2, queue: true }); job(sim, v, { held: 3, queue: false });
  const q = det.queuesOf(0, det.windowOf('start'));
  assert.equal(q.length, 1);
  assert.deepEqual([q[0].station, q[0].seconds, q[0].legs], [B, 6, 3], 'three loaded legs ended at B, two of them queued for 4 s and 2 s');
  assert.equal(q[0].dockNode, 14, 'the usual path of the queued legs ends at cell (4, 1)');
});

test('loadedRoutes and busiestRoutes agree with routesOf: a relocated leg is a trip, not a variant, and has no metres', () => {
  const { sim, det, A, B } = plant();
  const v = sim.veh('v1#1');
  job(sim, v); job(sim, v);
  const order = sim.order('f1', 1); // a third trip whose route was replanned after a deadlock relocation
  sim.go(v, 'toDrop', { order, targetId: 'B', route: at(sim, 1, 4) });
  sim.advance(2);
  v.route = at(sim, 3, 4); v.tv.teleports++;
  sim.advance(2);
  sim.go(v, 'unloading', { tv: { driving: false } });
  sim.advance(1);
  sim.deliveries(v, 1, order);
  sim.go(v, 'idle', { order: null, targetId: null, route: null });
  sim.advance(1);
  const w = det.windowOf('start');
  const r = det.routesOf(0, w, [1])[0];
  assert.deepEqual([r.trips, r.drawn, r.undrawn, r.disturbed, r.variants], [3, 2, 1, 1, 1]);
  const lr = det.loadedRoutes({}, w);
  assert.equal(lr.length, 1);
  const pick = (x) => [x.from, x.to, x.trips, x.drawn, x.undrawn, x.disturbed, x.variants, x.pathId, x.metres];
  assert.deepEqual(pick(lr[0]), pick(r), 'the same route, counted the same way');
  assert.equal(lr[0].share, r.pathShare);
  assert.equal(lr[0].share, 1, 'the share is that of the usual path among the drawn trips, not among all trips');
  assert.equal(det.loadedRoutes({ from: B }, w).length, 0); assert.equal(det.loadedRoutes({ to: B }, w).length, 1); assert.equal(det.loadedRoutes({ from: A }, w).length, 1);
  const busy = det.busiestRoutes(w, 4);
  assert.equal(busy.routes.length, 1); assert.equal(busy.routes[0].trips, 3);
  assert.equal(busy.total, 2 * 3 * 2, 'two drawable trips of three steps of 2 m; the relocated one has no metres');
  assert.equal(busy.routes[0].share, 1); assert.equal(busy.routes[0].pathId, r.pathId);
});

test('cellUse: the legs whose path touches a cell, by kind and flow; a drive to the depot is its own kind', () => {
  const { sim, det } = plant();
  const v = sim.veh('v1#1');
  job(sim, v);
  sim.go(v, 'toPark', { route: at(sim, 4, 8), targetId: 'D' });
  sim.advance(3);
  sim.go(v, 'parked', { route: null, targetId: null });
  sim.advance(1);
  const w = det.windowOf('start');
  const cell = (x) => sim.node(x, 1);
  assert.deepEqual(det.cellUse([cell(2)], w), { legs: 2, byFlow: [{ key: 'empty|0', n: 1 }, { key: 'loaded|0', n: 1 }] }, 'the empty drive 8 to 1 and the loaded drive 1 to 4 both cross cell 2');
  assert.deepEqual(det.cellUse([cell(7)], w), { legs: 2, byFlow: [{ key: 'depot|65535', n: 1 }, { key: 'empty|0', n: 1 }] }, 'the drive to park (no flow) and the empty drive cross cell 7');
  assert.deepEqual(det.cellUse([cell(0)], w), { legs: 0, byFlow: [] });
  assert.equal(det.cellUse([cell(2), cell(7)], w).legs, 3, 'a stretch counts each leg once, however many of its cells it touches');
});

test('station figures: shares are time-weighted samples, counters are exact, queueNow is live', () => {
  const layout = layoutFromAscii(['AA..PP..DD', '++++++++++'], { stations: { A: 'source', P: { type: 'process', params: { machines: 2 } }, D: 'sink' }, flows: [['A', 'P'], ['P', 'D']] });
  const sim = createFakeDetailSim(layout, { dt: 0.5 });
  const det = sim.enableDetail();
  const p = det.stIndex.get('P');
  sim.setMachines('P', ['busy', 'busy']);
  sim.advance(30);
  sim.setMachines('P', ['busy', 'down']);
  sim.advance(10);
  sim.st('P').produced += 7;
  sim.st('A').arrivals += 3;
  const w = det.stationWindow(p, det.windowOf('start'));
  assert.ok(Math.abs(w.seconds - 39) < 1.01, `${w.seconds}`);
  assert.ok(w.busy > 0.85 && w.busy < 0.95, `busy ${w.busy}`);
  assert.ok(w.down > 0.05 && w.down < 0.15);
  assert.ok(Math.abs(w.busy + w.starved + w.blocked + w.down - 1) < 1e-9, 'the four shares add up to 1');
  assert.equal(w.produced, 7); assert.equal(det.stationWindow(det.stIndex.get('A')).arrivals, 3);
  // loads that are ready and not claimed
  const link = { queue: [{ readyAt: 5 }, { readyAt: 20 }, { readyAt: 1000 }], claimed: 0 };
  sim.st('A').outLinks = [link];
  assert.deepEqual(det.queueNow(det.stIndex.get('A')), { loads: 2, oldest: sim.time - 5 }, 'the third load is not ready yet');
  link.claimed = 2;
  assert.deepEqual(det.queueNow(det.stIndex.get('A')), { loads: 0, oldest: 0 });
});

test('time-weighted sampling: a tick length that does not divide a second still gives the right number of seconds and shares', () => {
  const layout = layoutFromAscii(['AA..PP..DD', '++++++++++'], { stations: { A: 'source', P: { type: 'process', params: { machines: 1 } }, D: 'sink' }, flows: [['A', 'P'], ['P', 'D']] });
  for (const dt of [0.3, 0.45, 0.5, 1]) {
    const sim = createFakeDetailSim(layout, { dt });
    const det = sim.enableDetail();
    sim.setMachines('P', ['busy']);
    sim.advance(120);
    const w = det.stationWindow(det.stIndex.get('P'), det.windowOf('start'));
    assert.ok(w.seconds <= sim.time + 1e-9 && w.seconds > sim.time - 1.5 * Math.max(1, dt), `dt ${dt}: ${w.seconds} of ${sim.time}`);
    assert.ok(Math.abs(w.busy - 1) < 1e-9, `dt ${dt}: busy ${w.busy}`);
    assert.ok(Math.abs(w.seconds - (det.lastCoarse - det.windowStart)) < 1e-9, `dt ${dt}: the seconds are the time the samples stand for (from the window start to the last sample), not a count: ${w.seconds}`);
  }
});

test('a bad index never throws: the answer is the empty one', () => {
  const { det } = plant();
  const w = det.windowOf('start');
  for (const i of [-1, 99, NaN, 1.5, undefined, null]) {
    assert.equal(total(det.timeSplit(i, w)), 0);
    assert.deepEqual(det.counts(i, w), { trips: 0, loaded: 0, empty: 0, park: 0, qty: 0 });
    assert.deepEqual(det.routesOf(i, w), []); assert.equal(det.roundOf(i, w), null); assert.deepEqual(det.queuesOf(i, w), []);
    assert.deepEqual(det.hotspots(i, 3), { cells: [], total: 0, folded: 0 }); assert.deepEqual(det.idleSpots(i, 3), []);
    assert.equal(det.metresToGo(i), null); assert.deepEqual(det.workingSeries(i), []);
    assert.deepEqual(det.batteryOf(i, w).stops, []);
    assert.equal(det.stationWindow(i, w).seconds, 0); assert.deepEqual(det.queueNow(i), { loads: 0, oldest: 0 }); assert.equal(det.visitsTo(i, w).visits, 0);
  }
  assert.equal(det.vehicleIndex('v1#2'), 1); assert.equal(det.vehicleIndex('nope'), -1);
  assert.deepEqual(det.windowOf('anything'), { ...det.windowOf('start') }, 'an unknown window kind is Since start');
  assert.equal(NO_STATION, 0xffff);
});

test('metresToGo: the metres left on the open route of a driving vehicle, null otherwise', () => {
  const { sim, det } = plant();
  const v = sim.veh('v1#1');
  assert.equal(det.metresToGo(0), null);
  const route = at(sim, 1, 6);
  sim.go(v, 'toDrop', { order: sim.order('f1'), targetId: 'B', route, tv: { edge: route.edges[1], s: 0.5 } });
  assert.equal(det.metresToGo(0), (route.edges.length - 1) * 2 - 0.5);
  v.tv.driving = false;
  assert.equal(det.metresToGo(0), null);
});

test('a plant without vehicles, without stations, or without flows: the collector runs, every query answers, nothing is NaN', () => {
  for (const lines of [LINES, ['........', '........'], ['AA..BB..', '++++++++']]) {
    for (const fleets of [[{ count: 0 }], [{ count: 2 }]]) {
      const layout = layoutFromAscii(lines, { stations: { A: 'source', B: 'sink', D: 'depot' }, flows: lines === LINES ? [] : [['A', 'B']], fleets });
      const sim = createFakeDetailSim(layout, { dt: 1 });
      const det = sim.enableDetail();
      sim.advance(200);
      const w = det.windowOf('last30');
      for (let i = 0; i < det.nV; i++) { assert.equal(total(det.timeSplit(i, w)), 200); det.routesOf(i, w, [0, 1, 2, 3]); det.hotspots(i, 3); det.workingSeries(i); }
      for (let k = 0; k < det.nS; k++) { det.stationWindow(k, w); det.queueNow(k); det.visitsTo(k, w); }
      assert.deepEqual(det.busiestRoutes(w, 4), { total: 0, routes: [] });
      assert.deepEqual(det.loadedRoutes({}, w), []);
      assert.deepEqual(det.cellUse([1, 2], w), { legs: 0, byFlow: [] });
      assert.ok(det.memoryBytes > 0 && Number.isFinite(det.memoryBytes));
      assert.equal(det.legCoverage().wrapped, false);
    }
  }
});

test('a collector that cannot start leaves nothing behind: enableDetail answers null, sim.detailError says why, no listener stays', () => {
  const layout = layoutFromAscii(LINES, { stations: { A: 'source', B: 'sink', D: 'depot' }, flows: [['A', 'B']], fleets: [{ count: 1 }] });
  const sim = createFakeDetailSim(layout);
  const real = sim.logistics.vehicles;
  Object.defineProperty(sim.logistics, 'vehicles', { get() { throw new Error('no vehicles today'); }, configurable: true });
  assert.throws(() => new Detail(sim), /no vehicles today/);
  assert.equal(sim.listenerCount('orderDelivered'), 0, 'the listeners of the failed collector are gone');
  Object.defineProperty(sim.logistics, 'vehicles', { value: real, configurable: true });
  // the engine's enableDetail catches it (the real Simulation: tests/sim.detail.regress.test.js); here: too many items for 16-bit columns
  const big = new Proxy(real, { get: (t, k) => (k === 'length' ? 70000 : t[k]) });
  Object.defineProperty(sim.logistics, 'vehicles', { value: big, configurable: true });
  assert.throws(() => new Detail(sim), /at most 65534/);
});

test('a leg that carried more than 65,535 loads is filed with the largest number a column holds, not a wrapped one', () => {
  const { det } = plant();
  det.legs.push(0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 70000, 0);
  assert.equal(det.legs.qty[0], 65535);
});
