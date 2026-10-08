// Dock book: adversarial review (js/sim/logistics/docks.js, the dock choice in routing.js / vehicles.js, TrafficSystem.reroute).
//
// The dock book replaced "every vehicle takes the cheapest dock of the station" (the report: three docking spurs off one road, all vehicles
// queue at the same one while two stand free) by "take the dock where service starts soonest", with reservations and late rebinding. These
// tests attack it from the outside. They never call the book's own consistency functions (checkDockInvariants): the referee in
// tests/helpers/docks-review-gen.js keeps its own bookkeeping, and the "old rule" is written down again there from the contract.
//
//   A. By hand            the arithmetic of the estimate on a two-spur plant (travel time, occupant, queue, dead and broken vehicles)
//   B. The old rule       in legacy mode the choice IS the old rule; in the new mode it keeps the old rule's constraints (a dock the vehicle can
//                         get back from, a pickup dock that leads on to the drop), on 200 random dock-dense plants
//   C. Referee            200 random plants x 20 simulated minutes (several docks per station, spurs, lined-up docks, one-way rings, trap spurs,
//                         shared dock cells, depots, breakdowns, batteries, demand spikes, tick sizes 0.05 / 0.1 / 0.25): no leaked or doubled
//                         reservation, no vehicle on a dock it did not reserve, no flapping, the visit ledger adds up, every traffic and logistics
//                         invariant; vehicles removed at random times leave nothing behind
//   D. Behaviour          tick sizes, 50 vehicles on 8 docks, a demand spike, a trap spur, a dock cell shared by two stations, docks lined up on one
//                         lane, late rebinding at the hysteresis boundary, determinism, the example plants
//   E. Defects            DOCK-n tests, one per finding of the review. They were marked `todo` while they failed; every finding is FIXED now (docks.js,
//                         routing.js, stats.js, insights.js) and they run as ordinary tests. The "FIXED" lines below say how.
//
// FINDINGS (severity in brackets; the numbers are from this file, 2-hour runs unless said otherwise)
//   DOCK-1 [high]   The choice minimises the time until SERVICE STARTS and ignores the way out. A dock that is better by a tenth of a second wins
//                   although it lies 6 m farther away: the vehicle drives that detour twice. On plants with deeper spurs the dock book delivers LESS
//                   than the old static dock: 3 spurs 4 cells deep, 5 AGVs, 8 s loads, a load every 15 s: 429 loads old, 384 new (-10.5 %);
//                   3 spurs 3 deep, 4 AGVs: 345 -> 322; 2 deep, 4 AGVs: 399 -> 365. The old dock was the plant's bottleneck (one load per 20.7 s) and
//                   the new one is slower than that. Adding the extra route time of the exit (dock.dist - nearest.dist) to the estimate, or
//                   demanding a gain larger than the detour, brings all four back to the old numbers and keeps the gains on the report's plant.
//                   FIXED: choose() and rebind() rank by estimate + the way out of a farther dock (DOCK_EXIT_WEIGHT); a wait that is spent on a junction
//                   (a dock one cell off the main road) counts double (DOCK_BLOCK_WEIGHT); the cheapest dock is left only for a gain of more than
//                   DOCK_MIN_GAIN seconds. 144 comb plants against the old rule: +20 % overall, none more than 1 % worse.
//   DOCK-2 [medium] Vehicles longer than a cell (tugger 3.5 m, forklift 2.6 m on 2 m cells; the validator already warns) on one-cell spurs: the book
//                   sends them to docks behind a docked vehicle that overhangs the junction cell it holds. 9 tuggers, 3 one-cell spurs: 0 deadlocks
//                   and 93 loads before, 29 deadlocks and 30 loads in 30 minutes now. The estimate only sees vehicles standing ON the cells of the
//                   route (docks, idle), not the junction locks a long docked vehicle holds. (Docks lined up on one lane: no change, D7.)
//                   FIXED: the estimate sees the locks a standing vehicle holds (a junction cell it overhangs), and a vehicle longer than a cell keeps
//                   to the old rule (nearest dock, no switching) when its docks hang on spurs of one cell (docks.js overhangs): 72 plants of tuggers and
//                   forklifts, none more than 10 % worse any more, +25 % overall. The deadlocks themselves are the traffic engine's (the old rule has them too).
//   DOCK-3 [medium] busyShare counts any vehicle standing on the cell, also an idle 'stay' vehicle: a dock that served 21 % of the time reports 97 %
//                   busy, and the insight says "Add a second dock" where the fix is to let the idle vehicles park. A dock with an idle vehicle on
//                   it and no visit at all reports 100 %.
//                   FIXED: busyShare counts only service (loading, unloading, pulling out); docks taken by idle / broken vehicles report heldShare, and the
//                   new insight dock-idle-vehicles says "let the idle vehicles park" instead of "add a dock".
//   DOCK-4 [low]    The blocking estimate ignores the lane: a vehicle standing in the OPPOSITE lane of a two-way road holds up a route that passes
//                   it in the other direction (estimate 19.0 s for a drive that takes 11.4 s).
//                   FIXED: laneApart() / arrivesApart() - only a vehicle in the same lane (or on a junction cell) holds a passing route up.
//   DOCK-5 [low]    The turnaround of a cell is modelled from the speed only: forklift / tugger on a through lane need 8 / 13 s between "service over"
//                   and "next vehicle stands" (the model says 2.1 / 2.5 s), so reservations behind them are estimated far too early.
//                   FIXED: turnaround() scales with the vehicle length (through lane length^1.25, dead end 0.5 + 0.5 x length), calibrated on the AGV.
//   DOCK-6 [low]    Two vehicles can serve on one dock cell at the same time, one per lane of a two-way road; the book has one occupant per cell and
//                   books the busy time twice (60 s of busy time in 30 s).
//                   FIXED: a cell is listed once and the vehicle in service is its occupant; busy time is booked once per cell.
//   DOCK-7 [medium] The queue statistics (docks[].waitBefore, dockWaitTotal, and so the insights built on them) depend on whether the renderer looked:
//                   drawDockMarkers() calls refreshOccupants(true), which clears vehicle.leaving as a side effect, and waitsForDock() reads the raw field.
//                   Same plant, same seed: 56 vs 46 vehicle-seconds queued, 41 of 61 plants differ; the simulation itself (positions, states, loads) is
//                   identical. The live canvas and a headless run (Compare, warm restart) then disagree.
//                   FIXED: refreshOccupants() / status() only read the vehicles; the simulation forgets `leaving` itself at the start of every tick
//                   (forgetLeavers) and waitsForDock() validates it with stillLeaving().
//   DOCK-8 [low]    An idle 'stay' vehicle on a dock is expected to hold it for 5 s (YIELD_AFTER + the through-lane turnaround). It only starts making room
//                   once somebody has WAITED behind it for 2 s and then pulls out of a dead end (8 s): a vehicle that drives to such a dock waits about
//                   11 s longer than estimated (estimate 5.3 s, reality 16.6 s; 17.8 s against 28.6 s from farther away).
//                   FIXED: an idle occupant is expected to free the dock at (arrival of the first follower) + YIELD_AFTER + the turnaround of that cell
//                   (estimates 17.1 / 20.7 / 26.0 / 31.3 s against 18.1 / 20.6 / 26.6 / 32.1 s measured from x = 4 / 6 / 9 / 12).
//   Not defects, checked: no reservation leak or double booking in 200 plants x 20 min and 700+ random removals (1 000+ when explored); at most one
//   switch per reservation and 2 docks per undisturbed leg; the old choice is reproduced exactly with the book switched off (and equals the code at
//   HEAD); single-dock plants and the three examples are bit-identical to HEAD; tick sizes 0.05 / 0.1 / 0.25 / 0.5 agree within 4 %; a demand spike
//   is spread evenly over the docks; one-way trap spurs stay a last resort; the waiting that remains on the report's plant is junction lock
//   contention (4 613 of 5 284 vehicle-seconds), as the builder said; the physical checker finds only the few-centimetre overlaps the old rule has too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../js/sim/engine.js';
import { EXAMPLES } from '../js/model/examples.js';
import { FLEET_PRESETS, dist } from '../js/model/defaults.js';
import { generateInsights } from '../js/sim/insights.js';
import { createRng } from '../js/util/rng.js';
import { layoutFromAscii } from './helpers/ascii.js';
import { createSimChecker } from './helpers/sim-invariants.js';
import { assertInvariants } from './helpers/logistics-invariants.js';
import { DockWatch, combPlant, dockPlant, hostileDocks, legacy, shadowChoose } from './helpers/docks-review-gen.js';
import { hostilePlant } from './helpers/logistics-review-gen.js';
import { createReviewChecker } from './helpers/traffic-review-gen.js';

const CRUISE = 1.5 * 0.75; // m/s: AGV top speed x DOCK_CRUISE_SHARE
const text = (k) => JSON.stringify(k);

// =====================================================================================================================
// A. By hand
// =====================================================================================================================

/** Two spurs (docks (1,2) and (4,2)) off a main road (y = 3) of 2 m cells; A's vehicles are placed by hand, nothing is dispatched. */
function world(vehicles = 3, extra = {}) {
  const sim = new Simulation(combPlant({ spurs: 2, vehicles, spurLength: 1, interArrival: 1e6, seed: 1, ...extra }));
  const g = sim.graph;
  const at = (x, y) => y * g.cols + x;
  const [Y, X, Z] = sim.logistics.vehicles;
  const w = { sim, g, lg: sim.logistics, book: sim.logistics.docks, tr: sim.traffic, at, X, Y, Z, near: at(4, 2), far: at(1, 2) };
  assert.ok(w.tr.relocate(Y.tv, at(7, 3)));
  if (X) assert.ok(w.tr.relocate(X.tv, at(18, 3)));
  if (Z) assert.ok(w.tr.relocate(Z.tv, at(16, 3)));
  return w;
}
const routeTo = (w, from, to) => w.lg.routes.routeTo(w.lg.routes.get(from, -1, 0, false), to);
/** Y at (7,3) estimated to `node`. */
const est = (w, node) => w.book.estimate(w.Y, routeTo(w, w.at(7, 3), node), node, 0);
const standOn = (w, v, node, state, fields) => {
  assert.ok(w.tr.relocate(v.tv, node), 'the cell is free');
  Object.assign(v, { state, targetId: 'A' }, fields);
};

test('A1 hand arithmetic: travel time = route length / (top speed x 0.75): 4 cells = 8 m = 7.111 s, 7 cells = 14 m = 12.444 s', () => {
  const w = world();
  assert.ok(Math.abs(est(w, w.near) - 8 / CRUISE) < 1e-9, String(est(w, w.near)));
  assert.ok(Math.abs(est(w, w.far) - 14 / CRUISE) < 1e-9, String(est(w, w.far)));
  w.tr.speedFactor = 2; // the what-if slider: twice as fast, half the time
  assert.ok(Math.abs(est(w, w.near) - 4 / CRUISE) < 1e-9);
});

test('A2 hand arithmetic: an occupant that loads for 5 s more holds a DEAD-END dock for 5 + 8 s (max with the travel time), the other dock is unaffected', () => {
  const w = world();
  standOn(w, w.X, w.near, 'loading', { timer: 5 });
  assert.ok(Math.abs(est(w, w.near) - 13) < 1e-9, String(est(w, w.near)));
  assert.ok(Math.abs(est(w, w.far) - 14 / CRUISE) < 1e-9);
  w.X.timer = 1; // shorter than the drive: the drive decides
  assert.ok(Math.abs(est(w, w.near) - Math.max(8 / CRUISE, 9)) < 1e-9);
});

test('A3 hand arithmetic: a reservation that arrives before the vehicle queues ahead of it (its service = load time 12 + turnaround 8 = 20 s), one that arrives later does not', () => {
  const w = world();
  standOn(w, w.X, w.near, 'loading', { timer: 5 });
  w.Z.state = 'toPickup';
  w.Z.targetId = 'A';
  const res = w.book.reserve(w.Z, w.near, 'A', 0, 5);
  assert.equal(res.service, 20);
  assert.ok(Math.abs(est(w, w.near) - (13 + 20)) < 1e-9, `occupant free at 13, then Z's 20 s: ${est(w, w.near)}`);
  w.book.release(w.Z);
  w.book.reserve(w.Z, w.near, 'A', 0, 30); // Z arrives long after Y
  assert.ok(Math.abs(est(w, w.near) - 13) < 1e-9, 'Z comes later: not ahead');
  w.book.release(w.Z);
  assert.equal(w.book.cells.get(w.near).queue.length, 0);
});

test('A4 hand arithmetic: a broken occupant holds the dock for its repair + what it would still have needed, a dead one for ever; the other dock is chosen', () => {
  const w = world();
  standOn(w, w.X, w.near, 'broken', { repairLeft: 20, resumeState: 'loading', timer: 4 });
  w.X.tv.disabled = true;
  assert.ok(Math.abs(est(w, w.near) - (20 + 4 + 8)) < 1e-9, String(est(w, w.near)));
  w.X.state = 'dead';
  assert.ok(est(w, w.near) >= 7200, 'dead: the estimate is huge but finite');
  assert.ok(Number.isFinite(est(w, w.near)));
  const entry = w.lg.routes.get(w.at(7, 3), -1, 0, false);
  assert.equal(w.book.choose(w.Y, entry, 'A', null, 0).node, w.far, 'nobody drives to a dock with a dead vehicle on it');
});

test('A5 hand arithmetic: service and turnaround - dead end 8 s, through lane 3 s for the AGV (1.2 m), longer for longer vehicles (dead end 0.5 + 0.5 x length ratio, through lane ratio^1.25), stretched by the speed slider (x0.8 to x1.5)', () => {
  const w = world();
  const dead = w.near;
  const through = w.at(5, 3);
  assert.equal(w.g.deadEnd[dead], 1);
  assert.equal(w.g.deadEnd[through], 0);
  const long = (length) => ({ cfg: { body: { length } } });
  assert.equal(w.book.turnaround(w.Y, dead), 8);
  assert.equal(w.book.turnaround(w.Y, through), 3);
  assert.ok(Math.abs(w.book.turnaround(long(2.4), dead) - 8 * 1.5) < 1e-9, 'twice the length: 1.5 x at a dead end');
  assert.ok(Math.abs(w.book.turnaround(long(2.4), through) - 3 * 2 ** 1.25) < 1e-9, 'twice the length: 2^1.25 x on a through lane');
  assert.ok(Math.abs(w.book.turnaround(long(0.3), through) - 1.5) < 1e-9, 'a very short vehicle is floored at half the AGV time');
  w.tr.speedFactor = 0.25; // the what-if slider: four times slower -> the time is stretched, capped at 1.5
  assert.ok(Math.abs(w.book.turnaround(w.Y, dead) - 12) < 1e-9);
  w.tr.speedFactor = 4; // four times faster -> shortened, floored at 0.8
  assert.ok(Math.abs(w.book.turnaround(w.Y, dead) - 6.4) < 1e-9);
  w.tr.speedFactor = 1;
  assert.equal(w.book.serviceTime(w.Y, 'pickup', dead), 12 + 8);
  assert.equal(w.book.serviceTime(w.Y, 'drop', through), 12 + 3);
  assert.equal(w.book.serviceTime(w.Y, 'park', dead), 0);
  assert.equal(w.book.serviceTime(w.Y, 'charge', dead), 0);
});

test('A6 a vehicle that stands on a dock keeps it, and a vehicle is never counted as queueing behind itself', () => {
  const w = world();
  w.tr.relocate(w.Y.tv, w.near);
  const here = w.lg.routes.get(w.near, -1, 0, false);
  const route = w.lg.routes.routeTo(here, w.near);
  assert.equal(route.edges.length, 0);
  assert.equal(w.book.estimate(w.Y, route, w.near, 0), 0, 'standing on it: now');
  w.Y.state = 'toPickup';
  w.Y.targetId = 'A';
  w.book.reserve(w.Y, w.far, 'A', 0, 10);
  assert.equal(w.book.cells.get(w.far).queue.length, 1);
  const toFar = w.lg.routes.routeTo(here, w.far); // (4,2) -> (4,3) -> (3,3) -> (2,3) -> (1,3) -> (1,2): 5 cells = 10 m
  assert.equal(toFar.edges.length, 5);
  assert.ok(Math.abs(w.book.estimate(w.Y, toFar, w.far, 0) - 10 / CRUISE) < 1e-9, 'its own reservation is not ahead of itself');
  w.book.release(w.Y);
});

// =====================================================================================================================
// B + C. The old rule, and the referee, on 200 random dock-dense plants
// =====================================================================================================================

/** Run a plant; returns the referee and the shadow counters. `every`: also run the traffic + logistics invariant checkers every tick. */
function refereed(layout, seconds, { every = false, legacyMode = false } = {}) {
  const sim = new Simulation(layout);
  if (legacyMode) legacy(sim);
  const shadow = shadowChoose(sim);
  const watch = new DockWatch(sim);
  const checker = every ? createSimChecker(sim) : null;
  const ticks = Math.round(seconds / sim.dt);
  for (let i = 0; i < ticks; i++) {
    sim.step();
    watch.check();
    if (checker) checker.check();
  }
  return { sim, watch, shadow };
}

test('C1 referee: 200 random dock-dense plants x 20 minutes - no leaked or doubled reservation, no flapping, nobody on a dock they did not reserve, the visit ledger adds up, every invariant', () => {
  const total = { plants: 0, multi: 0, reservations: 0, switches: 0, arrivals: 0, calls: 0, diverted: 0, shared: 0, maxClean: 0 };
  const failures = [];
  const kinds = {};
  for (let seed = 1; seed <= 200; seed++) {
    const layout = dockPlant(seed);
    let r;
    try {
      r = refereed(layout, 1200, { every: seed % 5 === 0 });
      r.watch.ledger();
    } catch (e) {
      failures.push(`plant ${seed}: ${e.message.slice(0, 300)}`);
      continue;
    }
    if (r.watch.problems.length) failures.push(`plant ${seed} (dt ${r.sim.dt}): ${r.watch.problems.slice(0, 3).join(' | ')}`);
    if (r.shadow.mismatches.length) failures.push(`plant ${seed}: ${r.shadow.mismatches.slice(0, 3).join(' | ')}`);
    total.plants++;
    total.multi += [...r.sim.graph.docks.values()].filter((d) => d.length > 1).length;
    total.reservations += r.watch.stats.reservations;
    total.switches += r.watch.stats.switches;
    total.arrivals += r.watch.stats.arrivals;
    total.calls += r.shadow.calls;
    total.diverted += r.shadow.diverted;
    total.shared += r.watch.stats.sharedCells;
    total.maxClean = Math.max(total.maxClean, r.watch.stats.maxDocksPerCleanLeg);
    for (const [kind, n] of Object.entries(r.watch.stats.kinds)) kinds[kind] = (kinds[kind] || 0) + n;
  }
  assert.deepEqual(failures, []);
  assert.equal(total.plants, 200);
  assert.ok(total.multi >= 800, `stations with several docks: ${total.multi}`);
  assert.ok(total.reservations > 8000 && total.arrivals > 4000, `the vehicles really reserve and arrive (${total.reservations} / ${total.arrivals})`);
  assert.ok(total.switches >= 50, `late rebinding is exercised (${total.switches} switches)`);
  assert.ok(total.diverted > 500, `the book really deviates from the old rule (${total.diverted} of ${total.calls} choices)`);
  assert.ok(total.maxClean <= 2, `an undisturbed leg uses at most 2 docks (the plan and one switch): ${total.maxClean}`);
  for (const [kind, least] of [['pickup', 100], ['drop', 100], ['park', 20], ['charge', 3]]) assert.ok(kinds[kind] >= least, `reservations of kind ${kind}: at least ${least} (${JSON.stringify(kinds)})`);
});

test('B1 the old rule: with the book switched off the choice is exactly the old rule (cheapest dock the vehicle can get back from; a pickup dock that leads on) on 60 plants', () => {
  let calls = 0;
  for (let seed = 201; seed <= 260; seed++) {
    const { watch, shadow } = refereed(dockPlant(seed), 600, { legacyMode: true });
    assert.deepEqual(shadow.mismatches, [], `plant ${seed}`);
    assert.deepEqual(watch.problems, [], `plant ${seed}`);
    assert.equal(shadow.diverted, 0, `plant ${seed}: legacy mode never deviates`);
    calls += shadow.calls;
  }
  assert.ok(calls > 1500, `${calls} choices compared`);
});

test('B2 the three example plants: the dock book changes nothing against the old rule (the examples have one dock per station, or no choice that matters)', () => {
  for (const ex of EXAMPLES) {
    const layout = ex.build();
    const a = new Simulation(layout);
    a.advance(7200);
    const b = new Simulation(layout);
    legacy(b);
    b.advance(7200);
    assert.equal(a.kpis().throughput.total, b.kpis().throughput.total, ex.id);
    assert.equal(a.kpis().traffic.deadlocks, b.kpis().traffic.deadlocks, ex.id);
  }
});

test('C2 removal: 80 plants, vehicles taken out at random times in every state (driving to a dock, loading, broken, queued, leaving): nothing of them stays in a queue or on a cell, the rest goes on', () => {
  let removed = 0;
  const states = new Set();
  for (let seed = 1; seed <= 80; seed++) {
    const rng = createRng(seed + 999);
    const sim = new Simulation(dockPlant(seed, { vehicles: 6 + rng.int(8) }));
    const watch = new DockWatch(sim);
    const lg = sim.logistics;
    const ticks = Math.round(900 / sim.dt);
    for (let i = 1; i <= ticks; i++) {
      sim.step();
      watch.check();
      if (i % 25 === 0) assertInvariants(lg, `plant ${seed} t=${sim.time}`);
      if (rng.next() < 0.004 && lg.vehicles.length > 1) {
        const busy = lg.vehicles.filter((v) => v.dock !== null || v.state === 'loading' || v.state === 'unloading' || v.state === 'broken' || v.leaving >= 0);
        const vr = busy.length && rng.next() < 0.8 ? busy[rng.int(busy.length)] : lg.vehicles[rng.int(lg.vehicles.length)];
        states.add(vr.state);
        assert.ok(lg.removeVehicle(vr));
        removed++;
        lg.docks.refreshOccupants(true);
        for (const cell of lg.docks.cellList) {
          assert.ok(!cell.queue.some((res) => res.vr === vr), `plant ${seed}: ${vr.id} still queued at ${cell.node}`);
          assert.notEqual(cell.occupant, vr, `plant ${seed}: ${vr.id} still occupies ${cell.node}`);
        }
        watch.check();
      }
    }
    assert.deepEqual(watch.problems, [], `plant ${seed}`);
  }
  assert.ok(removed > 300, `${removed} vehicles removed`);
  for (const s of ['toPickup', 'toDrop', 'loading', 'unloading']) assert.ok(states.has(s), `a vehicle in state ${s} was removed`);
});

/** One load, Y drives to the near dock (4,2) of A from the east end; returns the world at the moment Y holds its reservation. */
function approach() {
  const layout = combPlant({ spurs: 2, vehicles: 2, spurLength: 1, interArrival: 1e6, loadTime: 12, unloadTime: 12 });
  layout.stations.find((st) => st.id === 'A').params.startDelay = 3;
  layout.stations.find((st) => st.id === 'A').params.interArrival = dist('const', 1e6, 0);
  const sim = new Simulation(layout);
  const { graph: g, logistics: lg, traffic: tr } = sim;
  const at = (x, y) => y * g.cols + x;
  const [Y, X] = lg.vehicles;
  assert.ok(tr.relocate(Y.tv, at(17, 3)));
  assert.ok(tr.relocate(X.tv, at(18, 3)));
  Object.assign(X, { state: 'broken', repairLeft: 1e9, resumeState: 'idle' });
  X.tv.disabled = true;
  const watch = new DockWatch(sim);
  for (let i = 0; i < 20 / sim.dt && !(Y.state === 'toPickup' && Y.dock); i++) { sim.step(); watch.check(); }
  assert.ok(Y.state === 'toPickup' && Y.dock, 'Y is on its way with a reservation');
  return { sim, g, lg, tr, X, Y, watch, at };
}
const queued = (lg) => lg.docks.cellList.reduce((n, cell) => n + cell.queue.length, 0);
const run = (w, seconds) => { for (let i = 0; i < seconds / w.sim.dt; i++) { w.sim.step(); w.watch.check(); } };

test('C3 an order given back: a vehicle that breaks down on its way to a dock and stays broken for 30 s loses its order AND its reservation; after the repair it works again', () => {
  const w = approach();
  const { Y, lg, sim } = w;
  Object.assign(Y, { resumeState: Y.state, state: 'broken', stateSince: sim.time, repairLeft: 70 });
  Y.tv.disabled = true;
  assert.equal(queued(lg), 1);
  run(w, 10);
  assert.equal(queued(lg), 1, 'a short breakdown keeps the plan (the reservation is ignored by others, not given up)');
  run(w, 30);
  assert.equal(Y.order, null, 'the order went back to the dispatcher');
  assert.equal(Y.dock, null);
  assert.equal(queued(lg), 0);
  run(w, 200);
  assert.deepEqual(w.watch.problems, []);
  assert.ok(Y.trips >= 1, 'after the repair the vehicle took the order again and delivered it');
  assertInvariants(lg, 'after the breakdown');
});

test('C4 a battery that dies on the way to a dock: no reservation is left behind, the order goes back, and a route past the dead vehicle is estimated as huge but finite', () => {
  const w = approach();
  const { Y, lg, sim } = w;
  Y.cfg.batteryOn = true;
  Y.cfg.drain = 1;
  Y.battery = 0.001;
  run(w, 2);
  assert.equal(Y.state, 'dead');
  assert.equal(Y.dock, null);
  assert.equal(Y.order, null);
  assert.equal(queued(lg), 0);
  // a second vehicle plans a route through the dead one: huge, finite
  const other = w.X;
  Object.assign(other, { state: 'idle', repairLeft: 0, resumeState: null });
  other.tv.disabled = false;
  const here = lg.routes.get(other.tv.node, -1, sim.time, false);
  const route = lg.routes.routeTo(here, w.g.docks.get('A')[1]);
  const estimate = lg.docks.estimate(other, route, w.g.docks.get('A')[1], sim.time);
  assert.ok(Number.isFinite(estimate) && estimate >= 7200, String(estimate));
  assert.deepEqual(w.watch.problems, []);
});

// =====================================================================================================================
// D. Behaviour
// =====================================================================================================================

test('D1 tick sizes: the report\'s plant gives the same plant at dt 0.05 / 0.1 / 0.25 / 0.5 (throughput within 4 %), always far above the old rule, referee clean', () => {
  const tp = [];
  for (const dt of [0.05, 0.1, 0.25, 0.5]) {
    const sim = new Simulation(combPlant({ spurs: 3, vehicles: 6, settings: { dt } }));
    const watch = new DockWatch(sim);
    const ticks = Math.round(5400 / dt);
    for (let i = 0; i < ticks; i++) { sim.step(); watch.check(); }
    assert.deepEqual(watch.problems, [], `dt ${dt}`);
    const old = new Simulation(combPlant({ spurs: 3, vehicles: 6, settings: { dt } }));
    legacy(old);
    old.advance(5400);
    tp.push(sim.kpis().throughput.total);
    assert.ok(sim.kpis().throughput.total > 1.2 * old.kpis().throughput.total, `dt ${dt}: ${sim.kpis().throughput.total} against ${old.kpis().throughput.total}`);
  }
  assert.ok(Math.max(...tp) <= 1.04 * Math.min(...tp), `throughput by tick size: ${tp}`);
});

test('D2 determinism: the same plant twice gives byte-identical KPIs and dock counters, also cut into pieces of odd length', () => {
  const layout = dockPlant(17);
  const a = new Simulation(layout);
  a.advance(3000);
  const b = new Simulation(layout);
  for (const s of [0.7, 411, 99.9, 1500, 3]) b.advance(s);
  b.advance(3000 - b.time);
  assert.equal(a.time, b.time);
  assert.equal(text(a.kpis()), text(b.kpis()));
  assert.equal(text(a.logistics.docks.counters('A')), text(b.logistics.docks.counters('A')));
  assert.equal(a.logistics.docks.switches, b.logistics.docks.switches);
});

test('D3 many vehicles, many docks: 50 AGVs on stations with 8 docks - referee clean, the load is spread, and far more is delivered than with the old rule', () => {
  const layout = combPlant({ spurs: 8, vehicles: 50, interArrival: 3, loadTime: 8, unloadTime: 8 });
  const sim = new Simulation(layout);
  const watch = new DockWatch(sim);
  const ticks = Math.round(1800 / sim.dt);
  for (let i = 0; i < ticks; i++) { sim.step(); watch.check(); }
  const old = new Simulation(layout);
  legacy(old);
  old.advance(1800);
  assert.deepEqual(watch.problems, []);
  const k = sim.kpis();
  assert.ok(k.throughput.total > 3 * old.kpis().throughput.total, `${k.throughput.total} against ${old.kpis().throughput.total}`);
  const used = k.stations.A.docks.filter((d) => d.visits > 0).length;
  assert.ok(used >= 5, `${used} of 8 docks of A are used`);
  assert.ok(watch.stats.maxQueue >= 8, 'and there were plenty of reservations at once');
});

test('D4 a demand spike: 60 loads and 12 / 24 / 50 vehicles at once - the reservations are spread over the docks (no dock gets more than half, 3 docks: a third + 1)', () => {
  for (const [spurs, veh] of [[3, 12], [8, 24], [8, 50]]) {
    const layout = combPlant({ spurs, vehicles: veh, sourceCap: 80, idle: 'stay' });
    const a = layout.stations.find((s) => s.id === 'A');
    Object.assign(a.params, { batch: 60, startDelay: 5, interArrival: dist('const', 400, 0) });
    const sim = new Simulation(layout);
    const watch = new DockWatch(sim);
    let hist = null;
    const ticks = Math.round(1200 / sim.dt);
    for (let i = 0; i < ticks; i++) {
      sim.step();
      watch.check();
      if (sim.time > 5 && sim.time < 40) { // the moment with the most reservations: the burst has been planned, nobody has been served yet
        const now = new Map();
        for (const v of sim.logistics.vehicles) if (v.dock) now.set(v.dock.node, (now.get(v.dock.node) || 0) + 1);
        const size = (m) => [...m.values()].reduce((x, y) => x + y, 0);
        if (hist === null || size(now) > size(hist)) hist = now;
      }
    }
    assert.deepEqual(watch.problems, [], `${spurs} docks, ${veh} vehicles`);
    const counts = [...hist.values()];
    const planned = counts.reduce((x, y) => x + y, 0);
    assert.ok(planned >= 0.75 * veh, `${planned} of ${veh} vehicles have a reservation after the burst`);
    assert.ok(Math.max(...counts) <= Math.ceil(Math.max(planned / 2, planned / spurs + 1)), `${spurs} docks, ${veh} vehicles: ${counts.sort((x, y) => y - x)}`);
  }
});

test('D5 a one-way trap spur next to a free normal dock: nobody drives into the trap (returnable constraint), also not by late rebinding; the plant keeps delivering', () => {
  // A has a normal spur at x = 0 and a one-way dead end ('^': enter, never leave) at x = 4 - the nearer one for vehicles coming from B.
  const rows = [
    'AAAAA..BBB',
    'AAAAA..BBB',
    '+...^...+.',
    '++++++++++',
  ];
  const layout = layoutFromAscii(rows, {
    stations: { A: { type: 'source', params: { interArrival: dist('const', 12, 0), outCap: 30 } }, B: 'sink' },
    flows: [['A', 'B']],
    fleets: [{ count: 5, preset: 'agv', idle: 'stay', loadTime: 8, unloadTime: 8 }],
    settings: { warmup: 0, seed: 2 },
  });
  const { sim, watch, shadow } = refereed(layout, 3600);
  const g = sim.graph;
  const trap = g.docks.get('A').find((d) => g.cx(d) === 4 && g.cy(d) === 2);
  assert.ok(trap !== undefined && !g.sameScc(trap, g.docks.get('A').find((d) => g.cx(d) === 0)), 'the plant has a trap dock');
  assert.deepEqual(watch.problems, []);
  assert.deepEqual(shadow.mismatches, []);
  const visits = sim.logistics.docks.counters('A');
  assert.equal(visits.find((d) => d.node === trap).visits, 0, 'the trap is never used');
  assert.ok(sim.kpis().throughput.total > 150, `${sim.kpis().throughput.total} loads in an hour`);
});

test('D6 two stations share a dock cell (a road between them): one queue for the cell, visits booked to the station served, the referee and every invariant hold', () => {
  const rows = [
    '.AAA+BBB.',
    '.AAA+BBB.',
    '.+..+..+.',
    '+++++++++',
  ];
  for (const vehicles of [2, 4, 8]) {
    const layout = layoutFromAscii(rows, {
      stations: { A: { type: 'source', params: { interArrival: dist('const', 12, 0), outCap: 30 } }, B: 'sink' },
      flows: [['A', 'B']],
      fleets: [{ count: vehicles, preset: 'agv', idle: 'stay', loadTime: 10, unloadTime: 10 }],
      settings: { warmup: 0, seed: 4 },
    });
    const { sim, watch, shadow } = refereed(layout, 3600, { every: true });
    assert.deepEqual(watch.problems, [], `${vehicles} vehicles`);
    assert.deepEqual(watch.ledger(), [], `${vehicles} vehicles`);
    assert.deepEqual(shadow.mismatches, []);
    const g = sim.graph;
    const shared = g.docks.get('A').filter((d) => g.docks.get('B').includes(d));
    assert.equal(shared.length, 2, 'two cells are docks of both stations');
    const book = sim.logistics.docks;
    for (const node of shared) assert.equal(book.cells.get(node).records.length, 2, 'the cell has a record per station');
    const k = sim.kpis();
    // every unloading at B and every loading at A is one visit of the station served, on whichever cell
    assert.ok(Math.abs(k.stations.A.docks.reduce((n, d) => n + d.visits, 0) - sim.logistics.flows[0].trips) <= vehicles + 1);
    assert.ok(Math.abs(k.stations.B.docks.reduce((n, d) => n + d.visits, 0) - sim.logistics.flows[0].delivered) <= vehicles + 1);
  }
});

test('D7 docks lined up on one lane (no side road): 30 plants - the book changes nothing that matters (throughput within 3 %), no deadlock epidemic', () => {
  let tpNew = 0;
  let tpOld = 0;
  let dlNew = 0;
  let dlOld = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const layout = dockPlant(seed, { topSpur: 0, botSpur: 0, ring: false, traps: false, depot: false, breakdowns: false, vehicles: 2 + (seed % 6) });
    layout.fleets.forEach((f) => { f.mtbf = 0; f.mttr = 0; f.battery.enabled = false; f.length = Math.min(f.length, 1.2); });
    const a = new Simulation(layout);
    a.advance(1800);
    const b = new Simulation(layout);
    legacy(b);
    b.advance(1800);
    const ka = a.kpis();
    const kb = b.kpis();
    tpNew += ka.throughput.total;
    tpOld += kb.throughput.total;
    dlNew += ka.traffic.deadlocks;
    dlOld += kb.traffic.deadlocks;
  }
  assert.ok(tpOld > 300, `${tpOld} loads`);
  assert.ok(tpNew >= 0.97 * tpOld && tpNew <= 1.05 * tpOld, `${tpNew} against ${tpOld}`);
  assert.ok(dlNew <= 1.3 * dlOld + 5, `deadlocks ${dlNew} against ${dlOld}`);
});

test('D8 healthy random plants (the old rule works there: <= 2 deadlocks, waiting below half): the book is not worse beyond noise (mean over 2 seeds each, aggregate >= 0.97)', () => {
  let newTotal = 0;
  let oldTotal = 0;
  let plants = 0;
  for (let seed = 1; seed <= 200 && plants < 14; seed++) {
    const layout = dockPlant(seed, { breakdowns: false, ring: false });
    layout.fleets.forEach((f) => { f.mtbf = 0; f.mttr = 0; f.battery.enabled = false; f.length = Math.min(f.length, 1.2); });
    const run = (legacyMode, s) => {
      const sim = new Simulation(layout, { seed: s });
      if (legacyMode) legacy(sim);
      sim.advance(1800);
      const k = sim.kpis();
      return { tp: k.throughput.total, dl: k.traffic.deadlocks, wait: k.traffic.waitShare };
    };
    const o1 = run(true, layout.settings.seed);
    if (o1.dl > 2 || o1.wait > 0.5 || o1.tp < 10) continue;
    plants++;
    const o2 = run(true, layout.settings.seed + 7);
    const n1 = run(false, layout.settings.seed);
    const n2 = run(false, layout.settings.seed + 7);
    oldTotal += o1.tp + o2.tp;
    newTotal += n1.tp + n2.tp;
  }
  assert.ok(plants >= 10, `${plants} healthy plants found`);
  assert.ok(newTotal >= 0.97 * oldTotal, `${newTotal} against ${oldTotal} loads`);
});

test('D9 late rebinding at the hysteresis boundary: as the wait at the planned dock grows, a vehicle switches ONCE (no switch for a wait that is not worth the detour, never back)', () => {
  /** Y drives to the near dock (4,2); then X (broken, repair time `repair`) stands on it. Returns the docks Y's reservation had. */
  const scenario = (repair) => {
    const layout = combPlant({ spurs: 2, vehicles: 2, spurLength: 1, interArrival: 3, loadTime: 12, unloadTime: 12 });
    const sim = new Simulation(layout);
    const { graph: g, logistics: lg, traffic: tr } = sim;
    const at = (x, y) => y * g.cols + x;
    const [Y, X] = lg.vehicles;
    assert.ok(tr.relocate(Y.tv, at(17, 3)));
    assert.ok(tr.relocate(X.tv, at(18, 3)));
    Object.assign(X, { state: 'broken', repairLeft: 1e9, resumeState: 'idle' });
    X.tv.disabled = true;
    const near = at(4, 2);
    const nodes = [];
    let placed = false;
    for (let i = 0; i < 200 / sim.dt; i++) {
      sim.step();
      if (!placed && Y.state === 'toPickup' && Y.dock) {
        assert.equal(Y.dock.node, near, 'planned for the nearer dock first');
        Object.assign(X, { state: 'broken', repairLeft: repair, resumeState: 'idle', targetId: 'A' });
        assert.ok(tr.relocate(X.tv, near));
        placed = true;
      }
      if (placed && Y.dock && nodes[nodes.length - 1] !== Y.dock.node) nodes.push(Y.dock.node);
      if (placed && !Y.dock) break;
    }
    return { nodes: nodes.map((n) => g.cx(n)), switches: lg.docks.switches };
  };
  const results = [];
  for (let repair = 0; repair <= 60; repair += 3) results.push({ repair, ...scenario(repair) });
  let flipped = false;
  for (const r of results) {
    assert.ok(r.switches <= 1, `repair ${r.repair}: ${r.switches} switches`);
    const switched = r.nodes.length === 2;
    if (flipped) assert.ok(switched, `repair ${r.repair}: switched for a shorter wait but not for this one`);
    if (switched) { flipped = true; assert.deepEqual(r.nodes, [4, 1], 'from the near dock to the far one, never back'); }
  }
  assert.ok(results[0].nodes.length === 1 && results[3].nodes.length === 1, 'a short wait is waited out');
  assert.ok(flipped && results[results.length - 1].nodes.length === 2, 'a long wait is not');
  const at = results.findIndex((r) => r.nodes.length === 2);
  // the round trip to the far dock is 2 x 6 m at 1.125 m/s = 10.7 s; a wait that is spent on the junction (the dock is one cell off the road) counts double,
  // so the first switch comes earlier than the 24 s the review measured with the plain estimate - but never for a wait shorter than the detour
  assert.ok(results[at].repair >= 10, `no switch for less than the detour is worth: first switch at a repair time of ${results[at].repair} s`);
});

test('D10 the opposite lane really is free: a vehicle drives past one that stands in the other lane of a two-way road without waiting (the premise of DOCK-4)', () => {
  const lane = laneWorld();
  const t0 = lane.sim.time;
  lane.tr.drive(lane.Y.tv, lane.route);
  for (let i = 0; i < 1200 && lane.Y.tv.driving; i++) lane.sim.step();
  const drive = lane.sim.time - t0;
  assert.ok(Math.abs(lane.X.tv.y - lane.Y.tv.y) > 0.5, 'different lanes');
  assert.ok(drive < lane.plain + 1.5, `the drive took ${drive.toFixed(1)} s, plain travel ${lane.plain.toFixed(1)} s`);
});

// =====================================================================================================================
// E. Defects (one test per finding of the review; all fixed)
// =====================================================================================================================

/** Two lined-up docks on a two-way lane; X stands in the eastbound lane on dock (3,2), Y waits in the westbound lane at the east end. */
function laneWorld() {
  const layout = layoutFromAscii(['.AAAAAA..BB', '.AAAAAA..BB', '+++++++++++'], {
    stations: { A: { type: 'process', params: { cycle: dist('const', 1e6, 0) } }, B: 'sink' },
    flows: [['A', 'B']],
    fleets: [{ count: 2, preset: 'agv', idle: 'stay', loadTime: 20, unloadTime: 20 }],
    settings: { warmup: 0, seed: 1, deadlock: 'ignore' },
  });
  const sim = new Simulation(layout);
  const { graph: g, traffic: tr, logistics: lg } = sim;
  const at = (x, y) => y * g.cols + x;
  const [X, Y] = lg.vehicles;
  tr.relocate(X.tv, at(1, 2));
  tr.drive(X.tv, g.path(at(1, 2), at(3, 2), { arrivalEdge: -1 }));
  for (let i = 0; i < 400 && X.tv.driving; i++) sim.step();
  Object.assign(X, { state: 'loading', timer: 20, targetId: 'A' });
  tr.relocate(Y.tv, at(10, 2));
  tr.drive(Y.tv, g.path(at(10, 2), at(9, 2), { arrivalEdge: -1 }));
  for (let i = 0; i < 400 && Y.tv.driving; i++) sim.step();
  Object.assign(Y, { state: 'toPickup', targetId: 'A', order: null });
  const entry = lg.routes.get(Y.tv.node, Y.tv.lastEdge, sim.time, false);
  const route = entry.search.routeTo(at(2, 2)); // passes the dock (3,2) that X holds, in the other lane
  assert.ok(route.nodes.includes(at(3, 2)));
  return { sim, g, tr, lg, X, Y, route, node: at(2, 2), plain: (route.edges.length * 2) / CRUISE };
}

test('DOCK-1 [high] on plants with deeper spurs the dock book does not deliver less than the old static dock (the choice counts the way out, and a small gain does not win)', () => {
    const plants = [
      { vehicles: 5, loadTime: 8, spurLength: 4, interArrival: 15 }, //  old 429, new 384
      { vehicles: 4, loadTime: 8, spurLength: 2, interArrival: 15 }, //  old 399, new 365
      { vehicles: 4, loadTime: 12, spurLength: 3, interArrival: 20 }, // old 345, new 322
      { vehicles: 3, loadTime: 20, spurLength: 2, interArrival: 15 }, // old 222, new 208
    ];
    const lost = [];
    for (const p of plants) {
      const layout = combPlant({ spurs: 3, unloadTime: p.loadTime, seed: 1, ...p });
      const a = new Simulation(layout);
      a.advance(7200);
      const b = new Simulation(layout);
      legacy(b);
      b.advance(7200);
      const now = a.kpis().throughput.total;
      const before = b.kpis().throughput.total;
      if (now < 0.97 * before) lost.push(`${p.vehicles} AGVs, spurs ${p.spurLength} deep, ${p.loadTime} s loads: ${now} loads against ${before} before (${((now / before - 1) * 100).toFixed(1)} %)`);
    }
    assert.deepEqual(lost, []);
  });

test('DOCK-1u [high] a dock that is better by 0.06 s of waiting is not worth a 5.3 s detour in and 5.3 s out: with the near dock free in 12.5 s and the far one reachable in 12.44 s the vehicle stays with the near one', () => {
    const w = world();
    standOn(w, w.X, w.near, 'loading', { timer: 4.5 }); // 4.5 + 8 s dead-end turnaround = 12.5 s
    assert.ok(Math.abs(est(w, w.near) - 12.5) < 1e-9 && Math.abs(est(w, w.far) - 14 / CRUISE) < 1e-9);
    const entry = w.lg.routes.get(w.at(7, 3), -1, 0, false);
    assert.equal(w.book.choose(w.Y, entry, 'A', null, 0).node, w.near, `it drives to (${w.g.cx(w.book.choose(w.Y, entry, 'A', null, 0).node)},2), 6 m farther away, to save 0.06 s`);
  });

test('DOCK-2 [medium] vehicles longer than a cell (tugger, 3.5 m on 2 m cells) on one-cell spurs: the dock book creates no deadlocks the old choice did not have (it keeps to the old rule there)', () => {
    const p = FLEET_PRESETS.tugger;
    const fleet = { length: p.length, speed: p.speed, accel: p.accel, decel: p.decel, loadTime: p.loadTime, unloadTime: p.unloadTime, capacity: p.capacity };
    const layout = combPlant({ spurs: 3, vehicles: 9, spurLength: 1, interArrival: 15, fleet, loadTime: p.loadTime, unloadTime: p.unloadTime, seed: 1 });
    const a = new Simulation(layout);
    a.advance(1800);
    const b = new Simulation(layout);
    legacy(b);
    b.advance(1800);
    const now = a.kpis();
    const before = b.kpis();
    assert.ok(now.traffic.deadlocks <= before.traffic.deadlocks + 3, `${now.traffic.deadlocks} deadlocks against ${before.traffic.deadlocks}`);
    assert.ok(now.throughput.total >= 0.9 * before.throughput.total, `${now.throughput.total} loads against ${before.throughput.total}`);
  });

/** Four 'stay' AGVs, a load every 2 minutes, one dock per station: the sink's dock is mostly occupied by idle vehicles, not by unloading. */
function idleDockRun() {
  const layout = layoutFromAscii(['AAA....BBB', 'AAA....BBB', '.+......+.', '.++++++++.'], {
    stations: { A: { type: 'source', params: { interArrival: dist('exp', 120, 0), outCap: 20 } }, B: 'sink' },
    flows: [['A', 'B']],
    fleets: [{ count: 4, preset: 'agv', idle: 'stay' }],
    settings: { warmup: 0, seed: 2 },
  });
  const sim = new Simulation(layout);
  let serving = 0;
  const ticks = Math.round(14400 / sim.dt);
  for (let i = 0; i < ticks; i++) {
    sim.step();
    for (const v of sim.logistics.vehicles) if (v.state === 'unloading' && v.targetId === 'B') serving += sim.dt;
  }
  return { sim, kpi: sim.kpis(), serving };
}

test('DOCK-3 [medium] busyShare must not count an idle vehicle that stays on the dock: a dock that unloads 21 % of the time reports 97 % busy', () => {
    const { sim, kpi, serving } = idleDockRun();
    const dock = kpi.stations.B.docks[0];
    const real = serving / kpi.window.duration + (dock.visits * 8) / kpi.window.duration; // unloading + the turnaround after it
    assert.ok(real < 0.4, `the premise: the dock is really used ${(real * 100).toFixed(0)} % of the time`);
    assert.ok(dock.busyShare <= real + 0.15, `reports ${(dock.busyShare * 100).toFixed(0)} % busy`);
    assert.ok(sim.logistics.docks.cells.size > 0);
  });

test('DOCK-3b [medium] the dock-bottleneck insight must not tell the planner to add a second dock where idle vehicles sit on the one dock', () => {
    const { sim, kpi } = idleDockRun();
    const hit = generateInsights(kpi, sim.layout).find((i) => i.id === 'dock-bottleneck:B');
    assert.equal(hit, undefined, hit && hit.title);
  });

test('DOCK-4 [low] the estimate must not count a vehicle in the OPPOSITE lane of a two-way road as holding up a route that passes it in the other direction', () => {
    const lane = laneWorld();
    const estimate = lane.lg.docks.estimate(lane.Y, lane.route, lane.node, lane.sim.time);
    assert.ok(estimate <= lane.plain + 2, `estimate ${estimate.toFixed(1)} s for a drive of ${lane.plain.toFixed(1)} s (it really takes 11.4 s)`);
  });

/** Median seconds between the end of a service at a saturated single dock and the start of the next one, for a preset on a through lane. */
function turnGap(preset) {
  const layout = layoutFromAscii(['.A.....B.', '+++++++++'], {
    stations: { A: { type: 'source', params: { interArrival: dist('const', 1, 0), outCap: 500 } }, B: 'sink' },
    flows: [['A', 'B']],
    fleets: [{ count: 4, preset, idle: 'stay' }],
    settings: { warmup: 0, seed: 1, deadlock: 'ignore' },
  });
  const sim = new Simulation(layout);
  const gaps = [];
  let last = null;
  const state = new Map();
  for (let i = 0; i < 36000; i++) {
    sim.step();
    for (const v of sim.logistics.vehicles) {
      const was = state.get(v);
      if (v.state !== was) {
        if (v.state === 'loading' && was !== 'loading' && last !== null) gaps.push(sim.time - last);
        if (was === 'loading') last = sim.time;
      }
      state.set(v, v.state);
    }
  }
  gaps.sort((x, y) => x - y);
  const v0 = sim.logistics.vehicles[0];
  return { gap: gaps[gaps.length >> 1], model: sim.logistics.docks.turnaround(v0, sim.graph.docks.get('A')[0]), n: gaps.length };
}

test('DOCK-5 [low] the turnaround of a through-lane dock for forklifts and tuggers is not modelled 4 to 5 times too short (it depends on the length of the vehicle)', () => {
    const agv = turnGap('agv');
    assert.ok(agv.n > 100 && Math.abs(agv.gap - agv.model) < 1.5, `the AGV model is right: ${agv.model} s against ${agv.gap.toFixed(1)} s`);
    for (const preset of ['forklift', 'tugger']) {
      const r = turnGap(preset);
      assert.ok(r.n > 30, `${preset}: ${r.n} services`);
      assert.ok(r.model >= 0.5 * r.gap, `${preset}: the model says ${r.model.toFixed(1)} s, the vehicles need ${r.gap.toFixed(1)} s`);
    }
  });

test('DOCK-6 [low] two vehicles serving on one dock cell (one per lane) are booked as 60 s of busy time in 30 s', () => {
    const lane = laneWorld();
    const { sim, g, tr, lg, X, Y } = lane;
    const cell = g.cx(X.tv.node) === 3 ? X.tv.node : -1;
    tr.drive(Y.tv, g.path(Y.tv.node, cell, { arrivalEdge: Y.tv.lastEdge }));
    for (let i = 0; i < 800 && Y.tv.driving; i++) sim.step();
    assert.equal(Y.tv.node, cell, 'both stand on the cell');
    for (const v of [X, Y]) Object.assign(v, { state: 'broken', repairLeft: 1e9, resumeState: 'loading', targetId: 'A', timer: 1e9 });
    X.tv.disabled = true;
    Y.tv.disabled = true;
    const record = lg.docks.byStation.get('A').find((d) => d.node === cell);
    const busy0 = record.busy;
    const t0 = sim.time;
    for (let i = 0; i < 300; i++) sim.step();
    assert.ok(record.busy - busy0 <= sim.time - t0 + 1, `${(record.busy - busy0).toFixed(0)} s of busy time booked in ${(sim.time - t0).toFixed(0)} s`);
  });

// ---------------------------------------------------------------------------------------------------------------------

function watched(layout, seconds) {
  const quiet = new Simulation(layout);
  const looked = new Simulation(layout);
  const nodes = [...looked.logistics.docks.cells.keys()];
  const ticks = Math.round(seconds / quiet.dt);
  for (let i = 0; i < ticks; i++) {
    quiet.step();
    looked.step();
    looked.logistics.docks.refreshOccupants(true); // what drawDockMarkers() does once per frame ...
    for (const node of nodes) looked.logistics.docks.status(node); // ... and for every marker on screen
  }
  return { quiet, looked };
}
const withoutQueues = (kpi) => {
  const k = JSON.parse(JSON.stringify(kpi));
  for (const st of Object.values(k.stations || {})) {
    for (const d of st.docks || []) delete d.waitBefore;
    delete st.dockWaitTotal;
    delete st.dockSkew;
  }
  return k;
};

test('D11 looking at the plant does not change it: with the dock markers drawn every frame the vehicles, loads and every KPI except the queue statistics are identical (40 plants)', () => {
  const layouts = [combPlant({ spurs: 3, vehicles: 6 }), ...Array.from({ length: 39 }, (_, i) => dockPlant(i + 1))];
  for (const layout of layouts) {
    const { quiet, looked } = watched(layout, 600);
    assert.equal(text(withoutQueues(quiet.kpis())), text(withoutQueues(looked.kpis())), layout.name);
    for (let k = 0; k < quiet.vehicles.length; k++) {
      assert.equal(quiet.vehicles[k].state, looked.vehicles[k].state);
      assert.equal(quiet.vehicles[k].tv.x, looked.vehicles[k].tv.x);
      assert.equal(quiet.vehicles[k].dock && quiet.vehicles[k].dock.node, looked.vehicles[k].dock && looked.vehicles[k].dock.node);
    }
  }
});

test('DOCK-7 [medium] the queue statistics must not depend on whether the renderer looked (same plant, same seed: dockWaitTotal 56 s headless, 46 s with the Jobs overlay zoomed in)', () => {
  const { quiet, looked } = watched(combPlant({ spurs: 3, vehicles: 6 }), 900);
  assert.equal(text(quiet.kpis()), text(looked.kpis()));
});

test('C5 hostile settings (the logistics review\'s hostile plants: one-way streets, zero cycles, huge batches, flat batteries, 0..6 machines): 40 plants, the referee and the physics stay quiet', () => {
  let reservations = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const sim = new Simulation(hostilePlant(seed));
    const watch = new DockWatch(sim);
    const physics = createReviewChecker(sim.traffic);
    const ticks = Math.round(600 / sim.dt);
    for (let i = 0; i < ticks; i++) { sim.step(); watch.check(); physics.check(); }
    watch.ledger();
    assert.deepEqual(watch.problems, [], `plant ${seed}`);
    reservations += watch.stats.reservations;
    for (const kind of ['nan', 'speed', 'jump', 'cell', 'stats']) assert.equal(physics.counts[kind] || 0, 0, `plant ${seed}: ${kind}: ${JSON.stringify(physics.violations.slice(0, 2))}`);
  }
  assert.ok(reservations > 500, `${reservations} reservations`);
});

test('C6 physics after late rebinding: 40 dock-dense plants x 10 minutes, the independent physical checker (no NaN, no jump, no speeding, no two vehicles in one controlled cell, overlaps below 15 cm - the same few centimetres the old rule has)', () => {
  let switches = 0;
  let worstOverlap = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const sim = new Simulation(dockPlant(seed));
    const physics = createReviewChecker(sim.traffic);
    const ticks = Math.round(600 / sim.dt);
    for (let i = 0; i < ticks; i++) { sim.step(); physics.check(); }
    switches += sim.logistics.docks.switches;
    for (const kind of ['nan', 'speed', 'jump', 'cell', 'stats']) assert.equal(physics.counts[kind] || 0, 0, `plant ${seed}: ${kind}: ${JSON.stringify(physics.violations.slice(0, 2))}`);
    worstOverlap = Math.max(worstOverlap, physics.worst.overlap || 0);
  }
  assert.ok(switches > 10, `${switches} rebindings happened`);
  assert.ok(worstOverlap < 0.15, `worst overlap ${worstOverlap.toFixed(3)} m`);
});

/** One 'stay' vehicle idles on the only dock of A; Y (the only vehicle allowed to serve the flow) is sent from (startX, 3): estimate against reality. */
function idleOccupant(startX) {
  const layout = combPlant({ spurs: 1, vehicles: 1, spurLength: 1, interArrival: 1e6, idle: 'stay' });
  Object.assign(layout.stations.find((st) => st.id === 'A').params, { startDelay: 20, interArrival: dist('const', 1e6, 0) });
  layout.fleets.push({ ...layout.fleets[0], id: 'v2', name: 'Idle', count: 1 });
  layout.flows[0].fleetId = layout.fleets[0].id;
  const sim = new Simulation(layout);
  const { graph: g, logistics: lg, traffic: tr } = sim;
  const at = (x, y) => y * g.cols + x;
  const Y = lg.vehicles.find((v) => v.fleetId === layout.fleets[0].id);
  const X = lg.vehicles.find((v) => v.fleetId === 'v2');
  const dock = g.docks.get('A')[0];
  tr.relocate(X.tv, at(g.cx(dock), 3));
  tr.drive(X.tv, g.path(at(g.cx(dock), 3), dock, { arrivalEdge: -1 }));
  for (let i = 0; i < 300 && X.tv.driving; i++) sim.step();
  X.state = 'idle';
  X.stateSince = sim.time;
  assert.ok(tr.relocate(Y.tv, at(startX, 3)));
  let assigned = null;
  let estimate = null;
  let service = null;
  for (let i = 0; i < 400 / sim.dt && service === null; i++) {
    sim.step();
    if (assigned === null && Y.state === 'toPickup') {
      assigned = sim.time;
      estimate = lg.docks.estimate(Y, Y.route, dock, sim.time);
    }
    if (assigned !== null && Y.state === 'loading') service = sim.time;
  }
  assert.ok(assigned !== null && service !== null, 'Y was sent and served');
  return { estimate, actual: service - assigned };
}

test('DOCK-8 [low] a vehicle that drives to a dock where an idle vehicle stays does not wait 11 s longer than the book thinks (the idle one starts to make room when somebody has waited 2 s, then reverses out of the dead end)', () => {
  for (const startX of [6, 9, 12]) { // (the road of this plant ends at x = 12: the review first had 14 and 17, which are no road cells, so relocate() failed before anything was measured)
    const r = idleOccupant(startX);
    assert.ok(r.estimate >= 0.7 * r.actual, `from x=${startX}: estimate ${r.estimate.toFixed(1)} s, reality ${r.actual.toFixed(1)} s`);
  }
});

test('the hostile plants (zero load times, 20 to 50 vehicles, a load every 0.5 to 20 s) keep the referee quiet', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const { watch, shadow, sim } = refereed(hostileDocks(seed), 400);
    assert.deepEqual(watch.problems, [], `plant ${seed}`);
    assert.deepEqual(shadow.mismatches, [], `plant ${seed}`);
    assert.ok(sim.vehicles.length >= 10, `${sim.vehicles.length} vehicles found room`);
  }
});
