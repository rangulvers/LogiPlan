// Regression tests of the detail collector (js/sim/detail.js) named after the defects the design stage's spikes found (docs/ENTITY-INSIGHTS-DESIGN.md 10.2, 13), plus the
// engine seam (enableDetail / disableDetail / dropDetail). Each one runs the REAL engine; the scripted cases are in sim.detail.unit.test.js.
//   STAT-T0       warm-up 0: a state change in the very first tick keeps stateSince = 0 and must still be seen
//   STAT-STRAY    a held-up vehicle that is not in a driving state (a breakdown) is booked by traffic but is not "waiting" and not a cell row
//   STAT-ZERO     frozen dock plant 44: loaded legs balance against the deliveries; legs of zero length exist and are trips that are not drawn
//   STAT-BALANCE  a whole job inside one tick (unloadTime 0): the leg is filed from the order of the engine's own orderDelivered event
//   STAT-ORIGIN   a loaded leg that deadlock resolution relocated keeps the station of its order as origin
//   STAT-REMOVE   a vehicle removed under a running collector: the run goes on, the collector restarts its window with a notice, kpis are untouched
//   STAT-THROW    a listener that throws and an afterTick that throws: the run completes, the collector is dropped, the reason is kept, kpis are untouched
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../js/sim/engine.js';
import { EXAMPLES } from '../js/model/examples.js';
import { dist } from '../js/model/defaults.js';
import { Detail, FLAG, NO_STATION, SLOT_KEYS } from '../js/sim/detail.js';
import { layoutFromAscii } from './helpers/ascii.js';
import { DOCKPLANT_SEEDS, dockPlantLayoutFile, readGolden } from './helpers/golden.js';
import { hostilePlant, jamPlant, tuggerTwoLines } from './helpers/engine-review-gen.js';
import { createFakeDetailSim } from './helpers/fake-sim.js';

const example = (id, warmup = 600) => { const layout = EXAMPLES.find((e) => e.id === id).build(); layout.settings.warmup = warmup; return layout; };
const dockPlant = (seed) => JSON.parse(readGolden(dockPlantLayoutFile(seed)));
const total = (t) => SLOT_KEYS.reduce((n, k) => n + t[k], 0);
const legsOf = (det, pick) => { const out = []; const L = det.legs; for (let k = 0; k < L.size; k++) { const r = L.at(k); if (pick(L, r)) out.push(r); } return out; };

// ---- the engine seam ------------------------------------------------------------------------------------------------------------------

test('seam: a plain Simulation has no collector; enableDetail is idempotent, disableDetail lets go of it and of its listeners', () => {
  const sim = new Simulation(example('two-lines'), { seed: 1 });
  assert.equal(sim.detail, null); assert.equal(sim.detailError, null);
  assert.equal(sim._listeners.size, 0, 'nothing listens on a plain simulation');
  const det = sim.enableDetail();
  assert.ok(det instanceof Detail); assert.equal(sim.detail, det);
  assert.equal(sim.enableDetail(), det, 'idempotent');
  assert.ok(sim._listeners.size > 0);
  sim.advance(120);
  assert.ok(det.timeSplit(0).seconds > 100);
  sim.disableDetail();
  assert.equal(sim.detail, null); assert.equal(sim._listeners.size, 0, 'its listeners are gone');
  sim.advance(60);
  sim.disableDetail(); // twice is fine
  const again = sim.enableDetail();
  assert.notEqual(again, det);
  assert.equal(again.windowStart, sim.time, 'enabled late: the window starts now');
});

test('seam: a collector that cannot start does not stop the simulation: enableDetail answers null, detailError says why, nothing stays attached', () => {
  const sim = new Simulation(example('starter'), { seed: 1 });
  const stations = sim.logistics.stations;
  Object.defineProperty(sim.logistics, 'stations', { get() { throw new Error('stations unreadable'); }, configurable: true });
  assert.equal(sim.enableDetail(), null);
  assert.ok(sim.detailError instanceof Error && /stations unreadable/.test(sim.detailError.message));
  assert.equal(sim.detail, null);
  assert.equal(sim._listeners.size, 0, 'the listeners of the failed start are gone');
  Object.defineProperty(sim.logistics, 'stations', { value: stations, writable: true, configurable: true });
  assert.doesNotThrow(() => sim.advance(60));
  const det = sim.enableDetail();
  assert.ok(det, 'and it can be switched on again once the cause is gone'); assert.equal(sim.detailError, null);
});

// ---- STAT-T0 ------------------------------------------------------------------------------------------------------------------------------

test('STAT-T0: with warm-up 0 a state change in the very first tick is seen although stateSince stays 0', () => {
  const layout = layoutFromAscii(['AA..BB..', '++++++++'], {
    settings: { warmup: 0 }, stations: { A: { type: 'source', params: { interArrival: dist('const', 1), startDelay: 0 } }, B: 'sink' }, flows: [['A', 'B']], fleets: [{ count: 1, idle: 'stay' }],
  });
  const sim = new Simulation(layout, { seed: 1 });
  const det = sim.enableDetail();
  const vr = sim.vehicles[0];
  assert.equal(vr.state, 'idle'); assert.equal(vr.stateSince, 0);
  sim.step();
  assert.equal(vr.state, 'toPickup', 'the vehicle got its first order in tick 1');
  assert.equal(vr.stateSince, 0, 'and its stateSince did not move: comparing it alone would miss the change');
  assert.equal(det.open[0], 1, 'the collector opened the leg');
  assert.equal(det.slotBase[0], 0, 'and counts the vehicle as driving from this tick');
  sim.advance(600);
  assert.equal(sim.detailError, null);
  assert.ok(det.counts(0).trips > 0 && det.legsLoaded[0] >= det.counts(0).trips, 'trips were counted and every one has a loaded leg');
  const t = det.timeSplit(0);
  assert.ok(Math.abs(total(t) - sim.time) < 1e-6 && t.driving > 0);
});

// ---- STAT-STRAY ---------------------------------------------------------------------------------------------------------------------------

test('STAT-STRAY: waiting of a broken vehicle is in the engine\'s nodeWait but not in the Waiting tile, so the cell rows follow the tile and the two tables add up to nodeWait', () => {
  const layout = example('two-lines');
  for (const f of layout.fleets) { f.mtbf = 25 * 60; f.mttr = 5 * 60; }
  const sim = new Simulation(layout, { seed: 1 });
  const det = sim.enableDetail();
  sim.advance(600 + 3 * 3600);
  const heat = sim.heat();
  const byNode = new Float64Array(sim.graph.nodeCount);
  let stray = 0; let hotTotal = 0; let tile = 0;
  for (let i = 0; i < det.nV; i++) {
    const t = det.timeSplit(i);
    tile += t.waiting + t.dockQueue;
    for (const T of [det.hot, det.hotStray]) {
      for (let k = i * 24; k < (i + 1) * 24; k++) if (T.keys[k] >= 0) byNode[T.keys[k]] += T.secs[k];
    }
    if (det.curNode[i] >= 0) byNode[det.curNode[i]] += det.curSecs[i];
    for (let k = i * 24; k < (i + 1) * 24; k++) if (det.hotStray.keys[k] >= 0) stray += det.hotStray.secs[k];
    hotTotal += det.hotspots(i, 24).total;
    assert.ok(det.hotspots(i, 24).cells.reduce((n, c) => n + c.seconds, 0) <= t.waiting + t.dockQueue + 1e-3, `vehicle ${i}: the cell rows never exceed the tile`);
  }
  assert.ok(stray > 0, 'the scenario has held-up seconds of broken vehicles, or it proves nothing');
  assert.ok(Math.abs(hotTotal - tile) < 0.02 * tile + 1, `cell tables equal the tile: ${hotTotal} against ${tile}`);
  // every second the engine booked on a cell is in a table of some vehicle (hot or stray), cell by cell, except what was folded into `other`
  let folded = 0; for (let i = 0; i < det.nV; i++) folded += det.hot.other[i] + det.hotStray.other[i];
  let worst = 0; let booked = 0;
  for (let n = 0; n < byNode.length; n++) { booked += byNode[n]; if (folded === 0) worst = Math.max(worst, Math.abs(byNode[n] - heat.nodeWait[n])); }
  const engine = Array.from(heat.nodeWait).reduce((n, x) => n + x, 0);
  assert.ok(Math.abs(booked + folded - engine) < 0.01 * engine + 1, `tables + folded = nodeWait: ${booked + folded} against ${engine}`);
  if (folded === 0) assert.ok(worst < 1e-3, `cell by cell: ${worst}`);
});

// ---- STAT-ZERO and STAT-BALANCE ---------------------------------------------------------------------------------------------------------

test('STAT-ZERO: frozen dock plant 44: every delivery has a loaded leg, zero-length legs exist and are trips that are not drawn', () => {
  const sim = new Simulation(dockPlant(44));
  const det = sim.enableDetail();
  sim.advance(1800);
  const rep = sim.kpis();
  let zero = 0; let trips = 0; let deliveries = 0;
  for (let i = 0; i < det.nV; i++) {
    const diff = det.legsLoaded[i] - (det.V[i].trips - det.base[i * 4] - det.credit[i]);
    assert.ok(diff >= 0, `vehicle ${i} has fewer loaded legs than deliveries (${diff})`);
    assert.ok(diff <= 1 + 3, `and not many more (${diff}: the unloading in progress, orders cancelled on the way)`);
    deliveries += rep.fleets[det.V[i].fleetId].vehicleTrips[det.V[i].id];
    for (const g of det.routesOf(i, det.windowOf('start'), [1])) trips += g.trips;
  }
  for (const r of legsOf(det, (L, r) => L.kind[r] === 1 && (L.flags[r] & FLAG.ZERO))) { zero++; assert.equal(det.legs.path[r], -2); assert.equal(det.legs.dur[r], 0); }
  assert.ok(zero > 0, 'zero-length loaded legs are filed (the state sequence never shows them)');
  assert.ok(trips >= deliveries && trips - deliveries <= 6, `loaded legs ${trips} against deliveries ${deliveries}`);
  const undrawn = det.V.reduce((n, _, i) => n + det.routesOf(i, det.windowOf('start'), [0, 1]).reduce((m, g) => m + g.undrawn, 0), 0);
  assert.ok(undrawn >= zero, 'zero-length legs are "not drawn"');
  for (let i = 0; i < det.nV; i++) for (const g of det.routesOf(i, det.windowOf('start'), [0, 1])) assert.ok(g.pathShare <= 1 && (g.trips === g.undrawn || g.pathId >= 0), 'the usual route is always drawable');
});

test('STAT-BALANCE: a whole job inside one tick is filed from the order of the delivery, whether or not the event told it', () => {
  for (const withEvent of [true, false]) {
    const layout = layoutFromAscii(['AA..BB..DD', '++++++++++'], { stations: { A: 'source', B: 'sink', D: { type: 'depot', params: { slots: 4 } } }, flows: [['A', 'B']], fleets: [{ count: 1 }] });
    const sim = createFakeDetailSim(layout);
    const det = sim.enableDetail();
    const v = sim.vehicles[0];
    const order = sim.order('f1', 3);
    sim.go(v, 'toPickup', { order, targetId: 'A', route: sim.route([8, 1], [7, 1], [6, 1], [5, 1], [4, 1], [3, 1], [2, 1], [1, 1]) });
    sim.advance(5);
    // inside ONE tick: arrives, loads, drives nowhere, drops (loadTime = unloadTime = 0), the order is delivered and the vehicle is idle again
    sim.advance(0.5, () => { if (withEvent) sim.deliveries(v, 1, order); else v.trips += 1; sim.go(v, 'idle', { order: null, targetId: null, route: null }); });
    sim.advance(1);
    const loaded = legsOf(det, (L, r) => L.kind[r] === 1);
    assert.equal(loaded.length, 1, `event ${withEvent}: one loaded leg owed`);
    const L = det.legs; const r = loaded[0];
    assert.deepEqual([L.from[r], L.to[r], L.qty[r], L.path[r], L.flags[r]], [0, 1, 3, -2, FLAG.ZERO], 'from A to B, the quantity of the order, not drawn');
    assert.equal(det.balanceFiled, 1);
    assert.equal(det.routesOf(0, det.windowOf('start'), [1])[0].trips, 1);
    assert.equal(det.counts(0).trips, 1);
    sim.advance(5); // and nothing is filed twice later
    assert.equal(legsOf(det, (LL, rr) => LL.kind[rr] === 1).length, 1);
  }
});

test('STAT-BALANCE: a job that is given and finished inside ONE tick (the vehicle never showed an order) is filed from the order of the delivery event, and without one with no origin', () => {
  for (const withEvent of [true, false]) {
    const layout = layoutFromAscii(['AA..BB..DD', '++++++++++'], { stations: { A: 'source', B: 'sink', D: { type: 'depot', params: { slots: 4 } } }, flows: [['A', 'B']], fleets: [{ count: 1 }] });
    const sim = createFakeDetailSim(layout);
    const det = sim.enableDetail();
    const v = sim.vehicles[0];
    const order = sim.order('f1', 2);
    sim.advance(5); // idle, no order, no leg
    assert.equal(v.order ?? null, null);
    sim.advance(0.5, () => { if (withEvent) sim.deliveries(v, 1, order); else v.trips += 1; }); // the engine counted a delivery; the vehicle's own fields never held the order at a poll
    sim.advance(1);
    const loaded = legsOf(det, (L, r) => L.kind[r] === 1);
    assert.equal(loaded.length, 1, `event ${withEvent}: the delivery has its loaded leg`);
    const L = det.legs; const r = loaded[0];
    if (withEvent) assert.deepEqual([L.from[r], L.to[r], L.qty[r], L.flow[r], L.path[r], L.flags[r]], [0, 1, 2, 0, -2, FLAG.ZERO], 'from A to B with the quantity of the order the event carried');
    else assert.deepEqual([L.from[r], L.to[r], L.qty[r], L.path[r], L.flags[r]], [NO_STATION, NO_STATION, 0, -2, FLAG.ZERO], 'no order known: a trip with no origin and destination, not drawn');
    assert.equal(det.counts(0).trips, 1); assert.equal(det.balanceFiled, 1);
  }
});

// ---- STAT-ORIGIN --------------------------------------------------------------------------------------------------------------------------

test('STAT-ORIGIN: loaded legs that deadlock resolution relocated keep the station of their order as origin', () => {
  // plants known to relocate loaded vehicles: the jam plant, two frozen dock plants (13: 22 relocated legs in 30 min) and hostile plants 14 and 19 (10 and 5 of their loaded legs)
  const plants = [['jam resolve', jamPlant('resolve')], ['tugger two lines', tuggerTwoLines('resolve')], ['dock plant 13', dockPlant(13)], ['dock plant 44', dockPlant(44)], ['hostile 14', hostilePlant(14)], ['hostile 19', hostilePlant(19)]];
  let relocated = 0; let loaded = 0;
  for (const [name, layout] of plants) {
    const sim = new Simulation(layout, { seed: 1 });
    const det = sim.enableDetail();
    sim.advance(1500);
    for (const r of legsOf(det, (L, rr) => L.kind[rr] === 1)) {
      loaded++;
      if (det.legs.flags[r] & FLAG.RELOCATED) {
        relocated++;
        assert.notEqual(det.legs.from[r], NO_STATION, `${name}: a relocated loaded leg lost its origin`);
      }
    }
    for (let i = 0; i < det.nV; i++) for (const g of det.routesOf(i, det.windowOf('start'), [1])) assert.ok(g.disturbed === 0 || g.drawn + g.undrawn === g.trips);
  }
  assert.ok(loaded > 100, `${loaded} loaded legs`);
  assert.ok(relocated >= 10, `${relocated} relocated loaded legs: the plants relocate vehicles, or the test checks nothing`);
});

// ---- STAT-REMOVE ---------------------------------------------------------------------------------------------------------------------------

test('STAT-REMOVE: a vehicle removed from the running plant: the collector restarts its window with a notice, the run goes on, kpis equal the run without a collector', () => {
  const run = (withDetail) => {
    const sim = new Simulation(example('two-lines'), { seed: 3 });
    if (withDetail) sim.enableDetail();
    sim.advance(1500);
    assert.equal(sim.logistics.removeVehicle(sim.logistics.vehicles[2]), true);
    sim.advance(1200);
    return sim;
  };
  const off = run(false); const on = run(true);
  assert.equal(JSON.stringify(on.kpis()), JSON.stringify(off.kpis()), 'the collector changes no figure');
  assert.notEqual(on.detail, null, 'still attached'); assert.equal(on.detailError, null);
  const det = on.detail;
  assert.equal(det.nV, off.vehicles.length); assert.equal(det.notices.length, 1);
  assert.match(det.notices[0].text, /vehicles or stations changed.*start counting again/);
  assert.ok(Math.abs(det.windowStart - det.notices[0].t) < 1e-9);
  for (let i = 0; i < det.nV; i++) assert.ok(Math.abs(total(det.timeSplit(i)) - (on.time - det.windowStart)) < 1e-6, `vehicle ${i}: the split adds up to the restarted window`);
  assert.equal(det.vehicleIndex('v2#1') >= 0, true);
  assert.equal(det.vehicleIndex(sim0Removed(off, on)), -1, 'the removed vehicle has no index any more');
});
function sim0Removed(off, on) { return on.layout.fleets.flatMap((f) => Array.from({ length: f.count }, (_, k) => `${f.id}#${k + 1}`)).find((id) => !off.vehicles.some((v) => v.id === id)); }

// ---- STAT-THROW ----------------------------------------------------------------------------------------------------------------------------

test('STAT-THROW: a listener that throws and an afterTick that throws leave the run complete, the collector dropped, the reason kept and the kpis untouched', () => {
  const reference = new Simulation(example('two-lines'), { seed: 2 });
  reference.advance(2400);
  const refText = JSON.stringify(reference.kpis());
  for (const how of ['listener', 'afterTick', 'afterTick-late']) {
    const sim = new Simulation(example('two-lines'), { seed: 2 });
    const det = sim.enableDetail();
    if (how === 'listener') det.onDelivered = () => { throw new Error('boom in listener'); };
    else {
      const orig = det.afterTick.bind(det); let n = 0;
      det.afterTick = (dt, fresh) => { if (++n === (how === 'afterTick' ? 100 : 5000)) throw new Error('boom in afterTick'); orig(dt, fresh); };
    }
    assert.doesNotThrow(() => sim.advance(2400), how);
    assert.ok(Math.abs(sim.time - 2400) < 1e-6, `${how}: the run completed`);
    assert.equal(sim.detail, null, `${how}: the collector is dropped`);
    assert.ok(sim.detailError instanceof Error && /boom/.test(sim.detailError.message), `${how}: the reason is kept`);
    assert.equal(sim._listeners.size, 0, `${how}: and its listeners are gone`);
    assert.equal(JSON.stringify(sim.kpis()), refText, `${how}: kpis equal a run that never had a collector`);
    assert.ok(det.failed && det.afterTickSafe(0.1, false) === false, 'a failed collector stays failed');
  }
  // a non-Error thrown value is still kept as an Error
  const sim = new Simulation(example('starter'), { seed: 1 });
  sim.enableDetail().onDelivered = () => { throw 'a string'; };
  sim.advance(1800);
  assert.ok(sim.detailError instanceof Error); assert.match(sim.detailError.message, /a string/);
  // and a new collector can be turned on again afterwards, which clears the notice
  assert.ok(sim.enableDetail()); assert.equal(sim.detailError, null);
});

test('the collector is a pure observer: the position of every vehicle is the same with and without it (a plant with docks and breakdowns)', () => {
  const layout = dockPlant(DOCKPLANT_SEEDS[0]);
  const run = (on) => {
    const sim = new Simulation(layout);
    if (on) sim.enableDetail();
    sim.advance(900);
    return JSON.stringify(sim.vehicles.map((v) => [v.x, v.y, v.state, v.trips, v.odometer])) + JSON.stringify(sim.kpis());
  };
  assert.equal(run(true), run(false));
});

// ---- the core fixer's regressions (the reviews of the statistics: tests/stats.engine.review.test.js, tests/stats.truth.review.test.js) -------------------------------------------

test('STAT-ENG-REV-1 (collector side): once the leg log has wrapped, `since` is sound: every leg that started after it is in the log, and every query counts the same legs', () => {
  // The same seed twice: a log of 150 rows that wraps, and a log that never does. Determinism makes their legs identical, so the big one is the truth about which legs the small one lost.
  const make = (opts) => { const sim = new Simulation(example('two-lines'), { seed: 1 }); const det = sim.enableDetail(opts); sim.advance(3 * 3600); return { sim, det }; };
  const small = make({ legCap: 150, legStart: 64 });
  const big = make({ legCap: 1 << 16 });
  const cover = small.det.legCoverage();
  assert.ok(cover.wrapped && cover.rows === 150 && !big.det.legCoverage().wrapped);
  assert.ok(cover.since > small.det.windowStart + 3600, `the small log covers only the last stretch (since ${cover.since.toFixed(0)} s of ${small.sim.time.toFixed(0)})`);
  const startsAfter = (det, t) => { const L = det.legs; const out = []; for (let k = 0; k < L.size; k++) { const r = L.at(k); if (L.t0[r] > t) out.push(`${L.veh[r]}:${L.kind[r]}:${L.t0[r]}`); } return out.sort(); };
  assert.deepEqual(startsAfter(small.det, cover.since), startsAfter(big.det, cover.since), 'the legs that started after `since` are the same legs in both logs');
  // and the queries that read the legs count exactly those legs
  const ws = small.det.windowOf('start'); const wb = big.det.windowOf('start');
  const tripsAfter = (det, i, t) => { const L = det.legs; let n = 0; for (let k = 0; k < L.size; k++) { const r = L.at(k); if (L.veh[r] === i && L.kind[r] === 1 && L.t0[r] >= t - 1e-9) n++; } return n; };
  let compared = 0;
  for (let i = 0; i < small.det.nV; i++) {
    const got = small.det.routesOf(i, ws, [1]).reduce((n, r) => n + r.trips, 0);
    assert.equal(got, tripsAfter(big.det, i, cover.since), `vehicle ${i}: the loaded legs since ${cover.since.toFixed(0)} s`);
    compared += got;
  }
  assert.ok(compared > 20, `${compared} loaded legs compared`);
  assert.equal(small.det.loadedRoutes({}, ws).reduce((n, r) => n + r.trips, 0), big.det.loadedRoutes({}, { ...wb, t0: cover.since }).reduce((n, r) => n + r.trips, 0), 'the plant-wide query follows the same boundary');
  // the report counters do not depend on the log
  assert.equal(small.det.counts(0, ws).trips, big.det.counts(0, wb).trips);
});

test('STAT-ENG-REV-4: the cell tables hold their seconds in float64: a queue that adds 0.05 s every tick leaves no phantom seconds on its cell', () => {
  const sim = new Simulation(dockPlant(DOCKPLANT_SEEDS[3]), { seed: 1 });
  sim.settings.dt = 0.05;
  const det = sim.enableDetail();
  sim.advance(600);
  assert.ok(det.hotQ.secs instanceof Float64Array && det.hot.secs instanceof Float64Array && det.hotStray.secs instanceof Float64Array && det.idleHot.secs instanceof Float64Array);
  let queued = 0; let rows = 0;
  for (let i = 0; i < det.nV; i++) {
    for (let k = i * 24; k < (i + 1) * 24; k++) {
      const key = det.hotQ.keys[k];
      if (key < 0) continue;
      queued += det.hotQ.secs[k];
      // the part of a cell that is a queue can never be more than the cell (a float32 sum made it up to 2e-4 of itself more)
      let cell = 0; for (let m = i * 24; m < (i + 1) * 24; m++) if (det.hot.keys[m] === key) cell += det.hot.secs[m];
      if (det.curNode[i] === key) cell += det.curSecs[i];
      assert.ok(det.hotQ.secs[k] <= cell + 1e-9, `vehicle ${i} cell ${key}: ${det.hotQ.secs[k]} s queued of ${cell} s`);
    }
    for (const c of det.hotspots(i, 24).cells) { assert.ok(c.seconds > 1e-6, `vehicle ${i} cell ${c.node}: ${c.seconds} s is a phantom row`); rows++; }
  }
  assert.ok(queued > 20, `${queued.toFixed(0)} s of dock queue in the tables`);
  assert.ok(rows > 0);
});

test('STAT-ENG-REV-6: a restart of the collector keeps the path pool, so a path id means the same cells before and after', () => {
  const sim = new Simulation(example('two-lines'), { seed: 1 });
  const det = sim.enableDetail();
  sim.advance(900);
  const pool = det.pool;
  const before = [0, 1, 2].map((id) => Array.from(pool.nodes(id)).join());
  assert.ok(pool.size >= 3);
  sim.logistics.removeVehicle(sim.logistics.vehicles[0]);
  sim.advance(300);
  assert.ok(det.notices.length >= 1, 'the collector restarted');
  assert.equal(det.pool, pool, 'the same pool');
  assert.deepEqual([0, 1, 2].map((id) => Array.from(det.pool.nodes(id)).join()), before);
  assert.ok(det.pool.size >= pool.size);
});

test('STAT-ENG-REV-3: a charge session knows the depot it charged at; chargeStopsAt answers for one depot', () => {
  const layout = example('two-lines');
  const sim = new Simulation(layout, { seed: 1 });
  const det = sim.enableDetail();
  sim.advance(2 * 3600);
  const depots = det.stations.map((st, i) => [st, i]).filter(([st]) => st.type === 'depot');
  assert.ok(det.charges.count > 0, 'sessions were recorded');
  const w = det.windowOf('start');
  let total = 0;
  for (const [, i] of depots) {
    const here = det.chargeStopsAt(i, w);
    total += here.length;
    for (const s of here) assert.ok(Number.isInteger(s.veh) && s.minutes > 0 && s.b1 >= s.b0 - 1e-6, `${JSON.stringify(s)}`);
  }
  assert.equal(total, det.charges.count, 'every session belongs to a depot');
  for (let k = 0; k < det.charges.count; k++) assert.ok(det.charges.dep[k] !== NO_STATION, `session ${k} has a depot`);
  assert.deepEqual(det.chargeStopsAt(-1, w), []); assert.deepEqual(det.chargeStopsAt(9999, w), []);
  // a later window drops the sessions that ended before it
  assert.ok(det.chargeStopsAt(depots[0][1], { ...w, t0: sim.time + 1 }).length === 0);
});

test('STAT-ENG-REV-7: cellUse through the cell index equals a scan that decodes every path, also for paths interned after the index was built', () => {
  const sim = new Simulation(example('warehouse-first-day'), { seed: 1 });
  const det = sim.enableDetail();
  sim.advance(1800);
  const brute = (nodes, w) => {
    const want = new Set(nodes); const L = det.legs; const by = new Map(); let legs = 0;
    for (let k = 0; k < L.size; k++) {
      const r = L.at(k);
      if (L.t0[r] < w.t0 - 1e-9 || L.path[r] < 0 || !Array.from(det.pool.nodes(L.path[r])).some((n) => want.has(n))) continue;
      legs++;
      const key = `${L.kind[r] === 1 ? 'loaded' : L.kind[r] === 0 ? 'empty' : 'depot'}|${L.flow[r]}`;
      by.set(key, (by.get(key) || 0) + 1);
    }
    return { legs, byFlow: [...by].map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) };
  };
  const w = det.windowOf('start');
  const g = sim.graph;
  const some = [...new Set(Array.from({ length: det.pool.size }, (_, id) => det.pool.nodes(id)[3]).filter((n) => n !== undefined))].slice(0, 12);
  assert.ok(some.length > 3 && det.legs.size > 50);
  for (const nodes of [[some[0]], [some[1], some[2]], some.slice(0, 6), [-1, 1e9, some[3]], []]) assert.deepEqual(det.cellUse(nodes, w), brute(nodes.filter((n) => n >= 0 && n < g.nodeCount), w), JSON.stringify(nodes));
  // a path that is interned later (and a leg that uses it) is found by the next call
  const entries = det.pool.entries;
  const first = det.pool.nodes(0);
  const route = { nodes: Array.from(first), edges: Array.from(first).slice(1).map((n, k) => g.out[first[k]].find((e) => g.edges[e].to === n)) };
  route.nodes.push(...[]); const id = det.pool.intern({ nodes: route.nodes.slice(0, 6), edges: route.edges.slice(0, 5) });
  assert.ok(id >= 0);
  det.legs.push(0, 1, 0, 1, 0, id, sim.time, 5, 0, 0, 1, 0, 5);
  const cell = det.pool.nodes(id)[2];
  assert.deepEqual(det.cellUse([cell], w), brute([cell], w));
  assert.ok(det.pool.entries >= entries, 'the index was extended, not rebuilt');
  assert.ok(det.cellUse([cell], w).legs >= 1);
});
