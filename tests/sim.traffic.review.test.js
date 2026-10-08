// Adversarial review of the traffic engine (js/sim/traffic.js, docs/ARCHITECTURE.md 5.2).
//
// DEFECT tests assert what the architecture promises and FAIL on the engine as reviewed; each says what is wrong.
// GUARD tests pin behaviour that was attacked and held (they pass today and must keep passing).
// The helper tests/helpers/traffic-review-gen.js judges poses and flags only, never the engine's underscore fields.
//
// Run the big randomised sweep (about 330 layouts, three time steps; ~13 s) with   TRAFFIC_REVIEW_FUZZ=full npm test
//
//   1. lock protocol     DEFECT  two vehicles deadlock on a street with four adjacent junction cells
//                        DEFECT  ... on a bend that one of them docks at
//                        DEFECT  ... free-flowing random traffic, nobody parked, nobody broken
//                        DEFECT  a vehicle first in line at a junction is overtaken by every later arrival (starvation)
//   2. deadlock detector GUARD   a loading dock and its queue are no deadlock; resolution; resolveDeadlocks = false
//   3. lock leaks        GUARD   detach / remove / relocate / drive away / repair release the cell
//   4. physics           DEFECT  a strong-braking follower behind a weak-braking leader brakes far beyond its decel
//                        DEFECT  easing onto the lane line drives into the opposite lane
//                        DEFECT  vehicles longer than a cell overlap in opposite lanes round a corner
//                        DEFECT  a vehicle that starts a trip turns in place into a vehicle standing ahead
//                        DEFECT  attach() beside traffic that cannot stop any more
//                        GUARD   speed factor sweeps, dead-end spurs
//   5. API               GUARD   refused calls change nothing; random abuse and callbacks never throw or produce NaN
//   6. statistics        GUARD   drivingTime / wait totals by reason / per edge equal an independent count
//   7. GUARD  determinism, performance (200 vehicles in one queue), independent fuzz (invariants checked on every tick)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { FLEET_PRESETS } from '../js/model/defaults.js';
import { createRng } from '../js/util/rng.js';
import { layoutFromAscii } from './helpers/ascii.js';
import { buildGraph } from '../js/sim/graph.js';
import { TrafficSystem } from '../js/sim/traffic.js';
import { reviewWorld, runReviewScenario, bodyGap, mainComponent, streetLines, blobLines } from './helpers/traffic-review-gen.js';

const FULL = process.env.TRAFFIC_REVIEW_FUZZ === 'full';
const body = (name) => ({ length: FLEET_PRESETS[name].length, speed: FLEET_PRESETS[name].speed, accel: FLEET_PRESETS[name].accel, decel: FLEET_PRESETS[name].decel });

// ---- 1. the lock protocol must neither deadlock nor starve ----------------------------------------------------------

test('DEFECT lock chain: two vehicles driving in opposite directions along four adjacent junction cells deadlock', () => {
  // A street that is two cells wide for four cells (a loading apron): cells 2..5 of the street are junctions in a row.
  // Nothing is parked, nobody is broken, each trip is 14 m. A is granted cells 2+3 and B cells 5+4 (a request only
  // covers the cells whose stop line is before the exit of the first one), then A waits for 4 and B for 3 while each
  // still stands in the cell it holds: hold and wait.
  for (const cell of [2, 3]) {
    const w = reviewWorld(['++++++++', '..++++..'], { cell, check: false, traffic: { resolveDeadlocks: false } });
    const a = w.add({ id: 'A', x: 0, y: 0 });
    const b = w.add({ id: 'B', x: 7, y: 0 });
    w.go(a, 7, 0);
    w.go(b, 0, 0);
    w.run(90);
    assert.equal(w.traffic.stats.deadlocks, 0, `cell ${cell} m: A (${a.waitReason}, blocked by ${a.blockedBy?.id}) and B (${b.waitReason}, blocked by ${b.blockedBy?.id}) stand in a deadlock`);
    assert.ok(!a.driving && a.node === w.node(7, 0) && !b.driving && b.node === w.node(0, 0), `cell ${cell} m: both vehicles arrive`);
  }
});

test('DEFECT lock protocol: a vehicle docking on a bend next to a junction deadlocks with one passing the bend the other way', () => {
  // B ends its trip on the bend (1,1) and takes the junction (1,2) on the way; A passes the bend towards (1,2). A bend
  // is only locked once somebody parks on it, so A stands in the bend while B holds the junction and waits for the bend.
  // Correct behaviour: B docks on the bend, A waits behind it (a dock blocks its cell, that is the point) and drives on
  // as soon as B is gone.
  for (const delay of [0, 0.5]) {
    const w = reviewWorld(['+....', '++...', '+++++'], { cell: 2, check: false, traffic: { resolveDeadlocks: false } });
    const a = w.add({ id: 'A', x: 0, y: 0 });
    const b = w.add({ id: 'B', x: 4, y: 2 });
    w.go(a, 2, 2);
    w.run(delay);
    w.go(b, 1, 1);
    w.run(60);
    assert.equal(w.traffic.stats.deadlocks, 0, `B starts ${delay} s after A: A (${a.waitReason}) and B (${b.waitReason}) wait for each other`);
    assert.ok(!b.driving && b.node === w.node(1, 1), 'B docks on the bend');
    assert.ok(a.driving && a.waiting && a.blockedBy === b, 'A waits behind the docked B');
    w.traffic.detach(b);
    w.run(30);
    assert.ok(!a.driving && a.node === w.node(2, 2), 'A arrives once the dock is free');
  }
});

test('DEFECT free-flowing traffic deadlocks: 12 random street layouts, 16 vehicles each, trips end on plain cells only', () => {
  // No vehicle ever stops for long, none breaks down, nobody starts on a junction: any deadlock is the protocol's own.
  const deadlocked = [];
  for (let seed = 1; seed <= 12; seed++) {
    const r = runReviewScenario({ seed, dt: 0.25, seconds: 200, vehicles: 16, chaos: 0, dwellProb: 0, plainOnly: true, resolve: false, headway: 0.5 });
    if (r.traffic.stats.deadlocks > 0) deadlocked.push(`seed ${seed}`);
  }
  assert.deepEqual(deadlocked, [], `${deadlocked.length} of 12 layouts end in a standing deadlock`);
});

test('DEFECT starvation: a vehicle that is first in line at a junction and has to turn into the main stream is overtaken by every later arrival', () => {
  // Main street with a stream of 12 vehicles (one every 2 s, to the east end); at t = 8 s a vehicle starts on the side
  // road and turns east into the same stream. Its lock request is the oldest, but it needs a little more room beyond
  // the junction than a vehicle driving straight on (turn), so every time the junction is free a later request that
  // fits is granted first: the lock queue skips what cannot proceed. FIFO would let at most the queue ahead pass.
  const w = reviewWorld(['+++++++++++++++++', '......+..........', '......+..........', '......+..........'], { cell: 2, check: false });
  const jx = w.graph.x(w.node(6, 0));
  const jy = w.graph.y(w.node(6, 0));
  const side = w.add({ id: 'side', x: 6, y: 3 });
  const seen = new Map(); // vehicle -> { near: first time within 4 m of the junction, crossed: first time within 1 m of its centre }
  const stream = [];
  const watch = (tv) => {
    const r = seen.get(tv) ?? { near: null, crossed: null };
    seen.set(tv, r);
    const d = Math.hypot(tv.x - jx, tv.y - jy);
    if (r.near === null && d <= 4) r.near = w.traffic.time;
    if (r.crossed === null && d < 1) r.crossed = w.traffic.time;
  };
  let released = 0;
  for (let i = 0; i < 2400 && !(seen.get(side)?.crossed > 0); i++) {
    if (i % 20 === 0 && released < 12) {
      const tv = w.traffic.addVehicle({ id: `m${released}`, node: w.node(0, 0), length: 1.2, speed: 1.5, accel: 0.6, decel: 1 });
      if (tv && w.go(tv, 16, 0)) { stream.push(tv); released++; }
    }
    if (i === 80) w.go(side, 16, 0);
    w.traffic.step(0.1);
    if (i >= 80) watch(side);
    for (const tv of stream) watch(tv);
    for (const tv of [...stream]) if (!tv.driving && tv.onRoad) { w.traffic.removeVehicle(tv); stream.splice(stream.indexOf(tv), 1); }
  }
  const s = seen.get(side);
  assert.ok(s.crossed > 0, 'the side vehicle crosses at all');
  const overtakers = [...seen.entries()].filter(([tv, r]) => tv !== side && r.near > s.near + 1.5 && r.crossed !== null && r.crossed < s.crossed).length;
  assert.ok(overtakers <= 1, `${overtakers} vehicles that reached the junction more than 1.5 s after the side vehicle crossed before it (it arrived at ${s.near.toFixed(0)} s, crossed at ${s.crossed.toFixed(0)} s)`);
});

// ---- 2. the deadlock detector ----------------------------------------------------------------------------------------

/** Two docked vehicles on adjacent junction cells that want each other's cell: a swap nothing can untie. */
function swapWorld(traffic) {
  const w = reviewWorld(['+++++++', '..++...'], { cell: 2, traffic });
  const a = w.add({ id: 'A', x: 2, y: 0 });
  const b = w.add({ id: 'B', x: 3, y: 0 });
  w.go(a, 3, 0);
  w.go(b, 2, 0);
  return { w, a, b };
}

test('GUARD a vehicle that loads for ten minutes on a junction cell and the queue behind it are no deadlock', () => {
  const w = reviewWorld(['+++++++', '...+...', '...+...'], { cell: 2, traffic: { deadlockTime: 20 } });
  const events = [];
  w.traffic.onDeadlock = (e) => events.push(e);
  const dock = w.add({ id: 'dock', x: 3, y: 0 }); // never gets a route: it is loading
  const q1 = w.add({ id: 'q1', x: 1, y: 0 });
  const q2 = w.add({ id: 'q2', x: 0, y: 0 });
  const q3 = w.add({ id: 'q3', x: 3, y: 2 });
  w.go(q1, 5, 0);
  w.go(q2, 4, 0);
  w.go(q3, 1, 0);
  w.run(300);
  assert.equal(events.length, 0);
  assert.equal(w.traffic.stats.deadlocks, 0);
  assert.deepEqual(w.traffic.activeDeadlocks, []);
  assert.equal(dock.waiting, false, 'the loading vehicle is not waiting');
  assert.deepEqual([q1.blockedBy, q2.blockedBy, q3.blockedBy], [dock, q1, dock]);
  assert.ok([q1, q2, q3].every((q) => q.waiting && q.waitTime > 100), 'the queue has waited for minutes');
  w.go(dock, 6, 0);
  w.run(80);
  assert.ok([dock, q1, q2, q3].every((v) => !v.driving), 'everybody arrives once the dock is free');
  assert.equal(w.traffic.stats.deadlocks, 0);
  assert.equal(w.checker.counts.overlap, undefined);
});

test('GUARD a swap between two docked vehicles is detected after deadlockTime, one victim moves to free ground and the other arrives', () => {
  const { w, a, b } = swapWorld({ deadlockTime: 20 });
  const events = [];
  w.traffic.onDeadlock = (e) => events.push({ t: w.traffic.time, ...e });
  w.run(19);
  assert.equal(events.length, 0, 'not before deadlockTime');
  w.run(6);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.resolved, true);
  assert.ok(e.t >= 20 && e.t <= 23, `reported at ${e.t}`);
  assert.deepEqual([...e.vehicles].map((v) => v.id).sort(), ['A', 'B']);
  assert.ok(e.victim === a || e.victim === b);
  const other = e.victim === a ? b : a;
  assert.equal(e.victim.driving, false);
  assert.ok(e.victim.node >= 0 && e.victim.node !== w.node(2, 0) && e.victim.node !== w.node(3, 0), 'the victim stands on a free cell');
  assert.ok(bodyGap(e.victim, other) > 0, 'the relocated victim does not overlap anybody');
  assert.deepEqual(w.traffic.activeDeadlocks, []);
  assert.equal(w.traffic.stats.deadlocks, 1);
  w.run(40);
  assert.equal(other.driving, false, 'the jam dissolved');
  assert.equal(events.length, 1, 'no second report');
  assert.equal(w.checker.counts.overlap, undefined);
});

test('GUARD resolveDeadlocks = false: the swap is reported once, stays active, and clears when a member is taken away', () => {
  const { w, a, b } = swapWorld({ deadlockTime: 20, resolveDeadlocks: false });
  const events = [];
  w.traffic.onDeadlock = (e) => events.push(e);
  w.run(400);
  assert.equal(events.length, 1);
  assert.equal(events[0].resolved, false);
  assert.equal(events[0].victim, null);
  assert.equal(w.traffic.stats.deadlocks, 1, 'counted once however long it stands');
  assert.equal(w.traffic.activeDeadlocks.length, 1);
  assert.deepEqual([...w.traffic.activeDeadlocks[0].vehicleIds].sort(), ['A', 'B']);
  assert.ok(a.waiting && b.waiting && a.waitTime > 300 && b.waitTime > 300);
  w.traffic.removeVehicle(b);
  w.run(30);
  assert.deepEqual(w.traffic.activeDeadlocks, []);
  assert.equal(a.driving, false, 'A drives on');
  assert.equal(w.traffic.stats.deadlocks, 1);
  assert.equal(events.length, 1);
});

// ---- 3. no lock leaks ---------------------------------------------------------------------------------------------

/** A parks ON the junction (holds it), B wants to cross it; `release` frees the junction in some way. */
function leakScenario(release) {
  const w = reviewWorld(['...+...', '...+...', '+++++++', '...+...', '...+...'], { cell: 2 });
  const a = w.add({ id: 'A', x: 3, y: 2 });
  const b = w.add({ id: 'B', x: 0, y: 2 });
  w.go(b, 6, 2);
  w.run(15);
  assert.ok(b.waiting && b.blockedBy === a, 'B waits for A');
  release(w, a);
  w.run(40);
  assert.ok(!b.driving && b.node === w.node(6, 2), 'B crosses after the release');
  assert.deepEqual(w.checker.counts, {});
}
test('GUARD lock leak: detach frees the junction a parked vehicle holds', () => leakScenario((w, a) => w.traffic.detach(a)));
test('GUARD lock leak: removeVehicle frees it', () => leakScenario((w, a) => w.traffic.removeVehicle(a)));
test('GUARD lock leak: relocate frees it', () => leakScenario((w, a) => w.traffic.relocate(a, w.node(3, 0))));
test('GUARD lock leak: driving away frees it', () => leakScenario((w, a) => w.go(a, 3, 4)));
test('GUARD lock leak: a breakdown holds it, the repair frees it', () => leakScenario((w, a) => { a.disabled = true; w.run(5); a.disabled = false; w.go(a, 3, 0); }));

test('GUARD lock leak: removing or detaching a vehicle that holds a chain of cells or stands inside the junction', () => {
  const w = reviewWorld(['...+...', '...+...', '+++++++', '...+...', '...+...'], { cell: 2 });
  const a = w.add({ id: 'A', x: 3, y: 0 });
  const b = w.add({ id: 'B', x: 0, y: 2 });
  w.go(a, 3, 4);
  w.go(b, 6, 2);
  const centre = { x: w.graph.x(w.node(3, 2)), y: w.graph.y(w.node(3, 2)) };
  w.runUntil(() => Math.hypot(a.x - centre.x, a.y - centre.y) < 0.5, 30);
  assert.ok(Math.hypot(a.x - centre.x, a.y - centre.y) < 0.6, 'A is inside the junction');
  w.traffic.removeVehicle(a);
  w.run(30);
  assert.ok(!b.driving && b.node === w.node(6, 2));

  const c = reviewWorld(['++++++++', '.++++++.'], { cell: 2 });
  const p = c.add({ id: 'P', x: 0, y: 0 });
  const q = c.add({ id: 'Q', x: 7, y: 0 });
  c.go(p, 7, 0);
  c.go(q, 0, 0);
  c.run(4);
  c.traffic.detach(p);
  c.run(40);
  assert.ok(!q.driving && q.node === c.node(0, 0), 'Q passes the cells P held');
});

// ---- 4. physics ----------------------------------------------------------------------------------------------------

/** Follower behind a leader on a straight one-way road: strongest braking of the follower and the smallest bumper gap. */
function follow(leadSpec, folSpec, dt) {
  const w = reviewWorld(['>'.repeat(40)], { cell: 2, check: false });
  const lead = w.add({ id: 'lead', x: 6, y: 0, ...leadSpec });
  const fol = w.add({ id: 'fol', x: 0, y: 0, ...folSpec });
  w.go(lead, 39, 0);
  w.go(fol, 39, 0);
  let braking = 0;
  let gap = Infinity;
  let last = 0;
  for (let i = 0, n = Math.round(80 / dt); i < n; i++) {
    w.traffic.step(dt);
    braking = Math.max(braking, (last - fol.v) / dt);
    last = fol.v;
    gap = Math.min(gap, bodyGap(lead, fol));
  }
  return { braking, gap };
}

for (const [folName, leadName] of [['forklift', 'AGV'], ['forklift', 'tugger'], ['custom vehicle', 'AGV']]) {
  test(`DEFECT a ${folName} behind ${leadName === 'AGV' ? 'an' : 'a'} ${leadName} brakes far beyond its own decel (it counts on the leader braking, then the hard clamp slams it)`, () => {
    for (const dt of [0.05, 0.1, 0.5]) {
      const { braking, gap } = follow(body(leadName.toLowerCase()), body(folName.split(' ')[0]), dt);
      const decel = body(folName.split(' ')[0]).decel;
      assert.ok(gap >= 0.5 - 1e-6, `dt ${dt}: the headway holds (gap ${gap.toFixed(3)})`);
      assert.ok(braking <= decel * 1.05, `dt ${dt}: braked at ${braking.toFixed(2)} m/s^2, its decel is ${decel}`);
    }
  });
}

test('DEFECT easing onto the lane line at a one-way / two-way transition drives into the vehicle passing in the opposite lane', () => {
  // Column 0: two-way down to row 2, one-way south below. A comes down and docks on (0,2) in the right-hand lane; B
  // leaves (0,2) northwards in the other lane. A's next trip starts with an in-place shift to the centre line (0.44 m)
  // while B passes: 0.72 m wide bodies, 0.44 m between their centres.
  for (const handedness of ['right', 'left']) {
    const w = reviewWorld(['+.', '++', '+.', 'v.', 'v.', 'v.'], { cell: 2, check: false, traffic: { handedness } });
    const a = w.add({ id: 'A', x: 0, y: 0 });
    const b = w.add({ id: 'B', x: 0, y: 2 });
    w.traffic.onArrive = (tv) => { if (tv === a) w.go(a, 0, 5); };
    w.go(a, 0, 2);
    w.go(b, 0, 0);
    let worst = Infinity;
    for (let i = 0; i < 600; i++) {
      w.traffic.step(0.1);
      worst = Math.min(worst, bodyGap(a, b));
    }
    assert.ok(worst >= -0.02, `${handedness}-hand traffic: the bodies of A and B overlap by ${(-worst).toFixed(2)} m`);
  }
});

for (const name of ['forklift', 'tugger']) {
  test(`DEFECT two ${name}s (${FLEET_PRESETS[name].length} m, default 2 m cells) rounding a corner in opposite lanes overlap`, () => {
    for (const handedness of ['right', 'left']) {
      const w = reviewWorld(['+.....', '+.....', '+.....', '+++++++'], { cell: 2, check: false, traffic: { handedness } });
      const a = w.add({ id: 'A', x: 0, y: 0, ...body(name) });
      const b = w.add({ id: 'B', x: 6, y: 3, ...body(name) });
      w.go(a, 6, 3);
      w.go(b, 0, 0);
      let worst = Infinity;
      for (let i = 0; i < 1500; i++) {
        w.traffic.step(0.1);
        worst = Math.min(worst, bodyGap(a, b));
      }
      assert.ok(worst >= -0.03, `${handedness}-hand traffic: bodies overlap by ${(-worst).toFixed(2)} m (${(FLEET_PRESETS[name].length / 2).toFixed(2)} cells long)`);
    }
  });
}

for (const name of ['forklift', 'tugger']) {
  test(`DEFECT a ${name} (${FLEET_PRESETS[name].length} m, default 2 m cells) that starts a trip turns in place into the broken vehicle standing ahead of it`, () => {
    // L leaves the junction (2,0) westwards and breaks down just outside it. T comes up the stem, parks on the junction
    // (its route ends there, L is not on it) and is then sent west: its body swings round in place, nose first towards L.
    const w = reviewWorld(['+++++', '..+..', '..+..'], { cell: 2, check: false });
    const junction = w.node(2, 0);
    const l = w.add({ id: 'L', x: 2, y: 0 });
    w.go(l, 0, 0);
    w.runUntil(() => l.driving && w.graph.x(junction) - l.x >= 1 + l.length / 2 + 0.05, 30); // its rear has left the junction cell
    l.disabled = true;
    w.run(5);
    const t = w.add({ id: 'T', x: 2, y: 2, ...body(name) });
    w.go(t, 2, 0);
    w.runUntil(() => !t.driving, 60);
    assert.ok(!t.driving && t.node === junction, 'T parks on the junction');
    w.go(t, 0, 0);
    let gap = Infinity;
    for (let i = 0; i < 100; i++) {
      w.traffic.step(0.1);
      gap = Math.min(gap, bodyGap(t, l));
    }
    assert.ok(gap >= 0.5 - 0.02, `after turning west T is ${gap.toFixed(2)} m from the vehicle ahead (the headway is 0.5 m)`);
  });
}

test('DEFECT attach() accepts a spot right in front of a fast vehicle that can no longer stop (emergency stop at many times its decel)', () => {
  // 3 m/s with decel 2 m/s^2 needs 2.25 m to stop; the new vehicle is put 2.1 m ahead of the nose (canAttach: yes).
  const w = reviewWorld(['>'.repeat(20)], { cell: 2, check: false });
  const fast = w.add({ id: 'fast', x: 0, y: 0, speed: 3, accel: 1, decel: 2 });
  const spare = w.add({ id: 'spare', x: 19, y: 0 });
  w.traffic.detach(spare);
  w.go(fast, 18, 0);
  const spot = w.node(12, 0);
  const tail = w.graph.x(spot) - spare.length / 2;
  let last = 0;
  let braking = 0;
  let offered = false;
  for (let i = 0; i < 400 && fast.driving; i++) {
    if (!offered && fast.v >= 2.99 && tail - (fast.x + fast.length / 2) <= 2.1) {
      offered = true;
      if (w.traffic.canAttach(spot)) assert.equal(w.traffic.attach(spare, spot), true);
    }
    w.traffic.step(0.1);
    braking = Math.max(braking, (last - fast.v) / 0.1);
    last = fast.v;
  }
  assert.ok(offered, 'the fast vehicle came by at full speed');
  assert.ok(braking <= fast.decel * 1.05, `the approaching vehicle had to brake at ${braking.toFixed(1)} m/s^2 (its decel is ${fast.decel}); canAttach / attach should have refused`);
});

test('GUARD the speed factor can swing between 0 and 3 under a platoon: brakes never exceed decel, nobody overlaps', () => {
  for (const dt of [0.05, 0.1, 0.5]) {
    const w = reviewWorld(['>'.repeat(90)], { cell: 2 });
    const vs = [0, 1, 2, 3, 4, 5].map((i) => w.add({ id: `p${i}`, x: 10 - 2 * i, y: 0 }));
    vs.forEach((v) => w.go(v, 89, 0));
    const schedule = [[10, 0.1], [30, 3], [45, 0], [55, 1], [75, 0.3], [90, 2]];
    let step = 0;
    let braking = 0;
    const last = new Map(vs.map((v) => [v, 0]));
    for (let i = 0, n = Math.round(160 / dt); i < n; i++) {
      if (step < schedule.length && w.traffic.time >= schedule[step][0]) w.traffic.speedFactor = schedule[step++][1];
      w.traffic.step(dt);
      w.checker.check();
      for (const v of vs) { braking = Math.max(braking, (last.get(v) - v.v) / dt); last.set(v, v.v); }
    }
    assert.deepEqual(w.checker.counts, { }, `dt ${dt}`);
    assert.ok(braking <= 1.0 + 1e-6, `dt ${dt}: braking ${braking}`);
  }
});

test('GUARD dead-end spurs: vehicles turn round at the tip, queue in the spur and never overlap (random spur depths)', () => {
  for (let seed = 1; seed <= 4; seed++) {
    const r = runReviewScenario({ seed, kind: 'spurs', dt: 0.1, seconds: 120, vehicles: 14, chaos: 0.2, headway: 0.5 });
    assert.deepEqual(Object.keys(r.checker.counts).filter((k) => k !== 'overlap'), [], `seed ${seed}: ${JSON.stringify(r.checker.violations.slice(0, 2))}`);
    assert.ok((r.checker.worst.overlap ?? 0) < 0.1, `seed ${seed}: overlap ${r.checker.worst.overlap}`);
    assert.ok(r.arrivals > 10, `seed ${seed}: ${r.arrivals} arrivals`);
  }
});

// ---- 5. API ---------------------------------------------------------------------------------------------------------

test('GUARD refused calls change nothing: drive on a driving / detached / removed vehicle, invalid routes, double attach, double remove', () => {
  const w = reviewWorld(['>>>>>>>>'], { cell: 2, check: false });
  const a = w.add({ id: 'a', x: 0, y: 0 });
  const route = w.route(a, 5, 0);
  assert.equal(w.traffic.drive(a, route), true);
  w.run(2);
  const snap = () => [a.node, a.edge, a.s, a.v, a.x, a.y, a.odometer, a.driving].join();
  const before = snap();
  assert.equal(w.traffic.drive(a, route), false, 'a driving vehicle');
  assert.equal(w.traffic.drive(a, w.route(a, 3, 0) ?? route), false);
  assert.equal(snap(), before);
  w.runUntil(() => !a.driving, 60);
  assert.equal(a.node, w.node(5, 0));
  assert.equal(w.traffic.drive(a, { nodes: [w.node(5, 0), w.node(6, 0)], edges: [999999] }), false, 'edge id out of range');
  assert.equal(w.traffic.drive(a, { nodes: [w.node(5, 0), w.node(6, 0)], edges: [-1] }), false);
  assert.equal(w.traffic.drive(a, { nodes: [w.node(1, 0), w.node(2, 0)], edges: route.edges.slice(0, 1) }), false, 'route not starting where the vehicle stands');
  assert.equal(w.traffic.drive(a, null), false);
  assert.equal(a.driving, false);
  w.traffic.detach(a);
  assert.equal(w.traffic.drive(a, route), false, 'a detached vehicle');
  assert.equal(w.traffic.relocate(a, w.node(1, 0)), false, 'relocate needs a vehicle on the road');
  assert.equal(w.traffic.attach(a, w.node(1, 0)), true);
  assert.equal(w.traffic.attach(a, w.node(2, 0)), false, 'already on the road');
  assert.equal(w.traffic.removeVehicle(a), true);
  assert.equal(w.traffic.removeVehicle(a), false);
  assert.equal(w.traffic.drive(a, route), false, 'a removed vehicle');
  assert.equal(w.traffic.attach(a, w.node(1, 0)), false);
  assert.equal(w.traffic.edgeCount(-1), 0);
  assert.equal(w.traffic.edgeCount(1e9), 0);
});

test('GUARD a zero-length route arrives in the next step exactly once, also if the vehicle is detached or removed in between', () => {
  const w = reviewWorld(['>>>>'], { cell: 2, check: false });
  const a = w.add({ id: 'a', x: 1, y: 0 });
  const b = w.add({ id: 'b', x: 3, y: 0 });
  const arrived = [];
  w.traffic.onArrive = (tv) => arrived.push(tv.id);
  const stay = (tv) => ({ nodes: [tv.node], edges: [], cost: 0 });
  assert.equal(w.traffic.drive(a, stay(a)), true);
  w.run(0.3);
  assert.deepEqual(arrived, ['a']);
  w.traffic.drive(a, stay(a));
  w.traffic.drive(b, stay(b));
  w.traffic.detach(a);
  w.traffic.removeVehicle(b);
  w.run(0.5);
  assert.deepEqual(arrived, ['a'], 'a detached or removed vehicle does not arrive');
});

test('GUARD random API abuse (NaN, 0, Infinity, strings, huge / tiny values, wrong calls) never throws and never produces NaN poses', () => {
  const junk = [NaN, -1, 0, Infinity, undefined, null, 'x', 1e-9];
  for (let seed = 1; seed <= 30; seed++) {
    const rng = createRng(seed);
    const lines = seed % 2 ? streetLines(rng.fork('l')) : blobLines(rng.fork('l'));
    const graph = buildGraph(layoutFromAscii(lines, { cellSize: rng.pick([1, 2, 3]) }));
    const traffic = new TrafficSystem(graph, { headway: rng.pick([0.5, 0, 1, NaN, -2]), handedness: rng.pick(['right', 'left', 'x']), deadlockTime: rng.pick([20, 5, 0, NaN]), resolveDeadlocks: rng.pick([true, false, undefined]) });
    const nodes = graph.nodes;
    if (nodes.length < 4) continue;
    for (let i = 0; i < 700; i++) {
      const tv = traffic.vehicles.length ? traffic.vehicles[rng.int(traffic.vehicles.length)] : null;
      const node = nodes[rng.int(nodes.length)];
      switch (rng.int(13)) {
        case 0: if (traffic.vehicles.length < 40) traffic.addVehicle({ id: `n${i}`, node, length: rng.pick([1.2, 0.5, 3, 1e-3, ...junk]), speed: rng.pick([1.5, 3, ...junk]), accel: rng.pick([0.6, 2, ...junk]), decel: rng.pick([1, 0.1, ...junk]) }); break;
        case 1: if (tv) traffic.removeVehicle(tv); break;
        case 2: if (tv) traffic.detach(tv); break;
        case 3: if (tv) traffic.attach(tv, node); break;
        case 4: if (tv) traffic.relocate(tv, node); break;
        case 5: case 6: case 7: if (tv) {
          const route = graph.search(tv.node >= 0 ? tv.node : node, { arrivalEdge: tv.lastEdge }).routeTo(nodes[rng.int(nodes.length)]);
          if (route) traffic.drive(tv, route);
        } break;
        case 8: if (tv) tv.disabled = !tv.disabled; break;
        case 9: traffic.speedFactor = rng.pick([1, 0, 0.1, 2, ...junk]); break;
        case 10: if (tv) traffic.drive(tv, rng.pick([{}, null, { nodes: [1], edges: [] }, { nodes: [node, node], edges: [999999] }, { nodes: [], edges: [] }])); break;
        case 11: traffic.edgeCount(rng.pick([0, -1, 1e9, NaN])); traffic.findFreeNode(rng.pick([node, -1, NaN, 1e9]), rng.pick([1, 5, NaN, undefined])); traffic.canAttach(rng.pick([node, -3, NaN])); break;
        default: traffic.step(rng.pick([0.1, 0.1, 0.1, 0.5, 1, 5, 0.01, 0, -1, NaN, Infinity]));
      }
      for (const v of traffic.vehicles) {
        for (const k of ['x', 'y', 'heading', 'v', 'odometer', 'waitTime']) assert.ok(Number.isFinite(v[k]), `seed ${seed} op ${i}: ${v.id}.${k} = ${v[k]}`);
        assert.ok(v.v >= 0);
      }
    }
  }
});

test('GUARD callbacks may remove, detach, attach, relocate and re-route vehicles while the system steps', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const rng = createRng(seed);
    const graph = buildGraph(layoutFromAscii(streetLines(rng.fork('l')), { cellSize: 2 }));
    const domain = mainComponent(graph);
    if (domain.length < 12) continue;
    const traffic = new TrafficSystem(graph, { deadlockTime: 8 });
    const vs = [];
    for (let i = 0; i < 14; i++) {
      const v = traffic.addVehicle({ id: `v${i}`, node: domain[rng.int(domain.length)], length: 1.2, speed: 1.5, accel: 0.6, decel: 1 });
      if (v) vs.push(v);
    }
    const go = (tv) => {
      if (!tv.onRoad || tv.driving || tv.node < 0) return;
      const r = graph.search(tv.node, { arrivalEdge: tv.lastEdge }).routeTo(domain[rng.int(domain.length)]);
      if (r && r.edges.length > 0) traffic.drive(tv, r);
    };
    traffic.onArrive = (tv) => {
      const other = vs[rng.int(vs.length)];
      switch (rng.int(8)) {
        case 0: traffic.removeVehicle(other); break;
        case 1: traffic.detach(other); break;
        case 2: if (!other.onRoad) traffic.attach(other, domain[rng.int(domain.length)]); break;
        case 3: if (other.onRoad) traffic.relocate(other, domain[rng.int(domain.length)]); break;
        default:
      }
      go(tv);
    };
    traffic.onDeadlock = (e) => {
      const roll = rng.int(3);
      if (roll === 0 && e.victim) traffic.removeVehicle(e.victim);
      else if (roll === 1) for (const v of e.vehicles) traffic.detach(v);
    };
    for (let i = 0; i < 2500; i++) {
      if (i % 20 === 0) for (const v of vs) go(v);
      if (i % 100 === 0) for (const v of vs) if (!v.onRoad && traffic.vehicles.includes(v)) traffic.attach(v, domain[rng.int(domain.length)]);
      traffic.step(0.1);
      for (const v of traffic.vehicles) assert.ok(Number.isFinite(v.x + v.y + v.heading + v.v), `seed ${seed}: ${v.id} has a NaN`);
    }
  }
});

// ---- 6. statistics ---------------------------------------------------------------------------------------------------

test('GUARD statistics are exact: drivingTime, wait totals by reason and per edge / cell equal an independent per-tick count', () => {
  // T junction: D loads on the junction, a queue builds behind it; later a breakdown blocks the street for a while.
  const w = reviewWorld(['+++++++++', '....+....', '....+....'], { cell: 2, check: false });
  const d = w.add({ id: 'D', x: 4, y: 0 });
  const q1 = w.add({ id: 'q1', x: 2, y: 0 });
  const q2 = w.add({ id: 'q2', x: 0, y: 0 });
  const side = w.add({ id: 'side', x: 4, y: 2 });
  const free = w.add({ id: 'free', x: 8, y: 0 });
  w.go(q1, 8, 0);
  w.go(q2, 6, 0);
  w.go(side, 0, 0);
  w.go(free, 5, 0);
  const own = { driving: 0, wait: 0, junction: 0, vehicle: 0, broken: 0, edge: new Map(), edgeSeconds: 0 };
  for (let i = 0; i < 1200; i++) {
    if (i === 300) w.go(d, 8, 0);
    if (i === 450) q1.disabled = true;
    if (i === 700) q1.disabled = false;
    w.traffic.step(0.1);
    for (const v of w.traffic.vehicles) {
      if (v.driving && !v.disabled) own.driving += 0.1;
      if (!v.waiting) continue;
      own.wait += 0.1;
      own[v.waitReason] += 0.1;
      own.edge.set(v.edge, (own.edge.get(v.edge) ?? 0) + 0.1);
    }
  }
  const st = w.traffic.stats;
  assert.ok(own.junction > 5 && own.vehicle > 5 && own.broken > 5, `all three reasons occur (${own.junction.toFixed(1)} / ${own.vehicle.toFixed(1)} / ${own.broken.toFixed(1)} s)`);
  const near = (x, y, what) => assert.ok(Math.abs(x - y) < 1e-6, `${what}: engine ${x}, counted ${y}`);
  near(st.drivingTime, own.driving, 'drivingTime');
  near(st.totalWait, own.wait, 'totalWait');
  near(st.waitJunction, own.junction, 'waitJunction');
  near(st.waitVehicle, own.vehicle, 'waitVehicle');
  near(st.waitBroken, own.broken, 'waitBroken');
  near(st.waitVehicle + st.waitJunction + st.waitBroken, st.totalWait, 'sum of reasons');
  for (const [edge, seconds] of own.edge) near(st.edgeWait[edge], seconds, `edgeWait[${edge}]`);
  near(Array.from(st.nodeWait).reduce((a, b) => a + b, 0), st.totalWait, 'sum of nodeWait');
  near(Array.from(st.edgeWait).reduce((a, b) => a + b, 0), st.totalWait, 'sum of edgeWait');
});

// ---- 7. determinism, performance, independent fuzz ---------------------------------------------------------------------

test('GUARD the same seed gives bit-identical runs (poses, statistics, deadlock counts) for 6 chaotic scenarios', () => {
  const signature = (r) => JSON.stringify([r.traffic.time, r.traffic.stats.deadlocks, r.traffic.stats.totalWait, r.traffic.stats.drivingTime,
    Array.from(r.traffic.stats.edgePasses), Array.from(r.traffic.stats.nodeWait),
    r.traffic.vehicles.map((v) => [v.id, v.x, v.y, v.heading, v.v, v.odometer, v.waitTime, v.waitReason])]);
  for (let seed = 1; seed <= 6; seed++) {
    const opts = { seed, dt: 0.25, seconds: 100, vehicles: 16, kind: ['streets', 'blob', 'spurs'][seed % 3], chaos: 0.5 };
    assert.equal(signature(runReviewScenario(opts)), signature(runReviewScenario(opts)), `seed ${seed}`);
  }
});

test('GUARD performance: a queue of 200 vehicles behind a breakdown (and its release) stays far faster than real time', () => {
  const N = 60; // a one-way ring of 4 x 60 cells
  const lines = ['>'.repeat(N) + 'v', ...Array.from({ length: N - 1 }, () => '^' + '.'.repeat(N - 1) + 'v'), '^' + '<'.repeat(N)];
  const graph = buildGraph(layoutFromAscii(lines, { cellSize: 2 }));
  const traffic = new TrafficSystem(graph);
  const ring = [];
  for (let n = graph.nodes[0]; ring.length === 0 || n !== ring[0]; n = graph.edges[graph.out[n][0]].to) ring.push(n);
  const vs = [];
  for (let i = 0; i < 200; i++) {
    const tv = traffic.addVehicle({ id: `v${i}`, node: ring[Math.floor(i * 1.2)], length: 1.2, speed: 1.5, accel: 0.6, decel: 1 });
    if (tv) vs.push(tv);
  }
  assert.ok(vs.length >= 190, `${vs.length} vehicles placed`);
  const goal = (tv) => ring[(ring.indexOf(tv.node) + 120) % ring.length];
  traffic.onArrive = (tv) => traffic.drive(tv, graph.search(tv.node, { arrivalEdge: tv.lastEdge }).routeTo(goal(tv)));
  for (const v of vs) traffic.drive(v, graph.search(v.node, { arrivalEdge: -1 }).routeTo(goal(v)));
  for (let i = 0; i < 300; i++) traffic.step(0.1); // warm-up
  vs[7].disabled = true;
  const started = performance.now();
  for (let i = 0; i < 3000; i++) traffic.step(0.1);
  const queued = vs.filter((v) => v.waiting).length;
  vs[7].disabled = false;
  for (let i = 0; i < 1000; i++) traffic.step(0.1);
  const factor = 400 / ((performance.now() - started) / 1000);
  assert.ok(queued >= 150, `${queued} vehicles queue up`);
  assert.equal(traffic.stats.deadlocks, 0);
  assert.ok(factor >= 300, `only ${factor.toFixed(0)}x real time with ${vs.length} vehicles in one queue`);
});

test(`GUARD independent fuzz: ${FULL ? 'about 330' : '36'} random layouts, dt 0.1 / 0.25 / 0.5, breakdowns, speed changes, detach / attach / remove / add`, () => {
  const per = FULL ? 37 : 4; // layouts per road picture and time step
  const seconds = FULL ? 150 : 90;
  const kinds = ['streets', 'blob', 'spurs'];
  const dts = [0.1, 0.25, 0.5];
  const hard = new Set(['nan', 'speed', 'jump', 'cell', 'headway', 'pathgap', 'stats', 'api']);
  const failures = [];
  let layouts = 0;
  let worstOverlap = 0;
  for (const [k, kind] of kinds.entries()) {
    for (const [d, dt] of dts.entries()) {
      for (let i = 0; i < per; i++) {
        const seed = 1000 + ((k * 3 + d) * per + i);
        const r = runReviewScenario({ seed, kind, dt, seconds, vehicles: 14, chaos: 0.3, headway: 0.5, fleets: [0, 2, 3], cells: [2, 3, 5], slowZones: 0.2 });
        layouts++;
        worstOverlap = Math.max(worstOverlap, r.checker.worst.overlap ?? 0);
        const bad = Object.keys(r.checker.counts).filter((kind2) => hard.has(kind2));
        if (bad.length) failures.push(`${kind} dt ${dt} seed ${seed}: ${bad.join(',')} ${JSON.stringify(r.checker.violations.filter((v) => hard.has(v.kind)).slice(0, 1))}`);
      }
    }
  }
  assert.deepEqual(failures, [], `${failures.length} of ${layouts} scenarios violate an invariant`);
  assert.ok(worstOverlap < 0.35, `vehicle bodies overlap by up to ${worstOverlap.toFixed(2)} m`);
});
