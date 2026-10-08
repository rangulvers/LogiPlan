// Traffic engine, fix pass after the adversarial review (tests/sim.traffic.review.test.js): the lock protocol (chains,
// bends, fairness), long vehicles (swing locks, supported range), in-place manoeuvres, placing vehicles next to moving
// traffic, braking of followers in mixed fleets and the corner allowance. Every test states the failure it guards.
//
// Worlds come from tests/helpers/traffic-review-gen.js: an independent per-tick checker (poses, flags and the graph
// only) collects violations of nan / speed / jump / overlap / headway / pathgap / cell / stats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLEET_PRESETS } from '../js/model/defaults.js';
import { reviewWorld, runReviewScenario, bodyGap } from './helpers/traffic-review-gen.js';

const body = (name) => ({ length: FLEET_PRESETS[name].length, speed: FLEET_PRESETS[name].speed, accel: FLEET_PRESETS[name].accel, decel: FLEET_PRESETS[name].decel });
const PRESETS = ['agv', 'forklift', 'tugger', 'custom'];

/** Route made of several legs (each from where the previous one ended), for trips that turn round at a dead end. */
function viaRoute(w, tv, goals) {
  let at = tv.node;
  let arrival = tv.lastEdge;
  const nodes = [at];
  const edges = [];
  for (const [x, y] of goals) {
    const leg = w.graph.search(at, { arrivalEdge: arrival }).routeTo(w.node(x, y));
    nodes.push(...leg.nodes.slice(1));
    edges.push(...leg.edges);
    at = w.node(x, y);
    arrival = leg.edges[leg.edges.length - 1];
  }
  return { nodes, edges, cost: 0 };
}

// ---- lock chains ------------------------------------------------------------------------------------------------------

test('a street that is 2..6 junction cells wide: two vehicles per direction, any vehicle type, both handednesses - nobody deadlocks', () => {
  // Before the fix a request covered only the cells whose stop line lay before the exit of its FIRST cell, so opposing vehicles
  // each held half of a row of four or more adjacent junction cells and waited for the other half (hold and wait).
  const bad = [];
  for (const kind of ['agv', 'forklift', 'tugger']) {
    for (const width of [2, 3, 4, 5, 6]) {
      for (const cell of [2, 3]) {
        for (const handedness of ['right', 'left']) {
          const cols = width + 14;
          const lines = ['+'.repeat(cols), '.'.repeat(6) + '+'.repeat(width) + '.'.repeat(cols - 6 - width)];
          const w = reviewWorld(lines, { cell, traffic: { resolveDeadlocks: false, handedness } });
          const spec = kind === 'agv' ? {} : body(kind);
          const a = w.add({ id: 'A', x: 2, y: 0, ...spec });
          const a2 = w.add({ id: 'A2', x: 0, y: 0, ...spec });
          const b = w.add({ id: 'B', x: cols - 3, y: 0, ...spec });
          const b2 = w.add({ id: 'B2', x: cols - 1, y: 0, ...spec });
          w.go(a, cols - 4, 0);
          w.go(b, 3, 0);
          w.run(1.5);
          w.go(a2, cols - 6, 0);
          w.go(b2, 5, 0);
          w.runUntil(() => ![a, a2, b, b2].some((v) => v.driving), 300);
          const label = `${kind} width ${width} cell ${cell} ${handedness}`;
          if (w.traffic.stats.deadlocks > 0 || [a, a2, b, b2].some((v) => v.driving)) bad.push(`${label}: stuck`);
          else if (Object.keys(w.checker.counts).length > 0) bad.push(`${label}: ${JSON.stringify(w.checker.violations[0])}`);
        }
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('a bend next to a junction: a vehicle docking in the bend and one crossing it (junction, bend, junction) never deadlock, in any order of arrival', () => {
  // Before the fix a request locked junctions only, so the vehicle P that crossed junction (1,2) and bend (1,1) could be granted the
  // junction, and then find the bend taken by D (docking there, bound for the same junction): P held the junction and waited
  // for the bend, D held the bend and waited for the junction.
  //   row 0   +....      D: (0,0) -> dock on the bend (1,1) -> on to (3,2)
  //   row 1   ++...      P: (3,2) -> junction (1,2) -> bend (1,1) -> junction (0,1) -> (0,0)
  //   row 2   +++++
  let waitedForDock = 0;
  for (let pAt = 0; pAt <= 8; pAt += 0.5) {
    for (const dAt of [0, 1, 3]) {
      const w = reviewWorld(['+....', '++...', '+++++'], { cell: 2, traffic: { resolveDeadlocks: false } });
      const p = w.add({ id: 'P', x: 3, y: 2 });
      const d = w.add({ id: 'D', x: 0, y: 0 });
      w.traffic.onArrive = (tv) => { if (tv === d && d.node === w.node(1, 1)) w.go(d, 3, 2); };
      const todo = [[pAt, () => w.go(p, 0, 0)], [dAt, () => w.go(d, 1, 1)]];
      for (let i = 0; i < 200; i++) {
        for (const job of todo) if (job[0] !== null && w.traffic.time >= job[0] - 1e-9) { job[1](); job[0] = null; }
        w.run(0.1);
        if (p.waiting && p.blockedBy === d) waitedForDock++;
      }
      w.run(100);
      const label = `P starts at ${pAt} s, D at ${dAt} s`;
      assert.equal(w.traffic.stats.deadlocks, 0, label);
      assert.ok(!p.driving && !d.driving, `${label}: both arrive`);
      assert.deepEqual(w.checker.counts, {}, label);
    }
  }
  assert.ok(waitedForDock > 0, 'in some order P really waits for the docked D (the dock blocks its cell)');
});

test('requests for the same junction are served in the order of their arrival, whichever way the vehicles turn inside it', () => {
  // A broken vehicle stands just beyond the exit, so nobody has room to enter. When it is repaired and drives off, the vehicle
  // from the side road (S, waiting longest) and the one from the main street (M) become eligible in the same tick - S must go
  // first. Before the fix the room beyond the exit was measured along each vehicle's own route including the corner INSIDE the
  // junction, so a vehicle that turns right (an inner corner) needed more room and was overtaken by every straight one.
  for (const handedness of ['right', 'left']) {
    for (const goal of [10, 0]) {
      const w = reviewWorld(['+++++++++++', '.....+.....', '.....+.....', '.....+.....'], { cell: 2, check: false, traffic: { handedness } });
      const centre = [w.graph.x(w.node(5, 0)), w.graph.y(w.node(5, 0))];
      const blocker = w.add({ id: 'L', x: goal === 10 ? 6 : 4, y: 0 });
      blocker.disabled = true;
      const side = w.add({ id: 'S', x: 5, y: 3 });
      const main = w.add({ id: 'M', x: goal === 10 ? 0 : 10, y: 0 });
      w.go(side, goal, 0);
      w.run(8);
      w.go(main, goal, 0);
      w.run(40);
      assert.ok(side._req >= 0 && main._req >= 0, 'both have asked for the junction and are held back');
      blocker.disabled = false;
      w.go(blocker, goal, 0);
      const reached = {};
      for (let i = 0; i < 800; i++) {
        w.traffic.step(0.1);
        for (const [name, tv] of [['S', side], ['M', main]]) {
          if (!(name in reached) && Math.hypot(tv.x - centre[0], tv.y - centre[1]) < 1.5) reached[name] = w.traffic.time;
        }
      }
      assert.ok(reached.S > 0 && reached.M > 0, 'both cross');
      assert.ok(reached.S < reached.M, `${handedness}-hand traffic towards ${goal}: S crossed at ${reached.S} s, M at ${reached.M} s`);
    }
  }
});

test('free-flowing traffic on street layouts never ends in a standing deadlock (the layouts that deadlocked before the fixes)', () => {
  const stuck = [];
  for (const seed of [6, 9, 14, 25, 34, 35, 37, 39, 45, 53]) {
    const r = runReviewScenario({ seed, dt: 0.25, seconds: 200, vehicles: 16, chaos: 0, dwellProb: 0, plainOnly: true, resolve: false, headway: 0.5 });
    if (r.traffic.stats.deadlocks > 0) stuck.push(seed);
  }
  assert.deepEqual(stuck, []);
});

test('two vehicles circulate for ever in a 2 x 2 block of two-way road (every corner a tight bend, the leader is two corners ahead)', () => {
  // Followers once added twice the shortening of every corner between themselves and the leader to their gap; in a small loop
  // that made each stop for a leader that was physically far away.
  for (const cell of [2, 3]) {
    for (const handedness of ['right', 'left']) {
      const w = reviewWorld(['++', '++'], { cell, traffic: { handedness, resolveDeadlocks: false } });
      const ring = [w.node(0, 0), w.node(1, 0), w.node(1, 1), w.node(0, 1)];
      const vs = [0, 2].map((k) => w.add({ id: `q${k}`, x: w.graph.cx(ring[k]), y: w.graph.cy(ring[k]) }));
      const trips = new Map(vs.map((v) => [v, 0]));
      const onwards = (tv) => w.go(tv, w.graph.cx(ring[(ring.indexOf(tv.node) + 2) % 4]), w.graph.cy(ring[(ring.indexOf(tv.node) + 2) % 4]));
      w.traffic.onArrive = (tv) => { trips.set(tv, trips.get(tv) + 1); onwards(tv); };
      vs.forEach(onwards);
      w.run(300);
      assert.equal(w.traffic.stats.deadlocks, 0);
      assert.ok([...trips.values()].every((n) => n >= 20), `cell ${cell} ${handedness}: trips ${[...trips.values()]}`);
      assert.deepEqual(w.checker.counts, {});
    }
  }
});

test('a long vehicle lets go of the cells it overhung at its start, even if the route comes back to them later', () => {
  // The forklift (2.6 m) parks on (2,0) with its tail in junction (1,0). It drives to the far end of the street and back. Before
  // the fix the route's second visit of (1,0) kept the first lock until the vehicle came home, so G could not cross (1,0).
  const lines = ['+'.repeat(16), '.+.+............', '.+.+............', '.+..............'];
  const w = reviewWorld(lines, { cell: 2 });
  const forklift = w.add({ id: 'F', x: 2, y: 0, ...body('forklift') });
  const g = w.add({ id: 'G', x: 1, y: 2 });
  assert.ok(forklift._held.includes(w.node(1, 0)) && forklift._held.includes(w.node(3, 0)), 'it holds both junctions next to it');
  assert.equal(w.traffic.drive(forklift, viaRoute(w, forklift, [[15, 0], [2, 0]])), true);
  w.go(g, 0, 0);
  let gArrived = null;
  let farEnd = null;
  w.runUntil(() => {
    if (gArrived === null && !g.driving) gArrived = w.traffic.time;
    if (farEnd === null && Math.hypot(forklift.x - w.graph.x(w.node(15, 0)), forklift.y - w.graph.y(w.node(15, 0))) < 1.5) farEnd = w.traffic.time;
    return !forklift.driving && gArrived !== null;
  }, 300);
  assert.ok(!forklift.driving && !g.driving, 'both arrive');
  assert.ok(gArrived < farEnd, `G crossed (1,0) after ${gArrived} s, long before the forklift came back (it reached the far end at ${farEnd} s)`);
  assert.deepEqual(w.checker.counts, {});
});

// ---- braking of followers ---------------------------------------------------------------------------------------------

test('a follower never brakes harder than its own deceleration, for any pair of vehicle types and time step (leader cruises, stops, or breaks down)', () => {
  const worst = [];
  for (const dt of [0.1, 0.5]) {
    for (const folName of PRESETS) {
      for (const leadName of PRESETS) {
        for (const event of ['stops at the end', 'breaks down']) {
          const w = reviewWorld(['>'.repeat(60)], { cell: 2, check: false });
          const lead = w.add({ id: 'lead', x: 8, y: 0, ...body(leadName) });
          const fol = w.add({ id: 'fol', x: 0, y: 0, ...body(folName) });
          w.go(lead, 59, 0);
          w.go(fol, 59, 0);
          let braking = 0;
          let gap = Infinity;
          let last = 0;
          for (let i = 0, n = Math.round(120 / dt); i < n; i++) {
            if (event === 'breaks down' && Math.abs(w.traffic.time - 30) < dt / 2) lead.disabled = true;
            w.traffic.step(dt);
            braking = Math.max(braking, (last - fol.v) / dt);
            last = fol.v;
            gap = Math.min(gap, bodyGap(lead, fol));
          }
          const label = `${folName} behind ${leadName} (${event}, dt ${dt}): braking ${braking.toFixed(2)} of ${fol.decel}, gap ${gap.toFixed(3)}`;
          if (braking > fol.decel * 1.05 || gap < 0.5 - 1e-6) worst.push(label);
        }
      }
    }
  }
  assert.deepEqual(worst, []);
});

// ---- long vehicles ----------------------------------------------------------------------------------------------------

for (const cell of [2, 3]) {
  test(`long vehicles rounding a corner in opposite lanes (cell ${cell} m): bodies stay apart for every pair of types and both handednesses`, () => {
    // The rear of a rigid body sweeps into the opposite lane when the vehicle turns; the lane separation of a two-way road does
    // not leave room for that beyond about one cell of length, so vehicles longer than a cell lock the cell they turn in.
    for (const handedness of ['right', 'left']) {
      for (const [one, other] of [['forklift', 'forklift'], ['tugger', 'tugger'], ['tugger', 'forklift'], ['forklift', 'agv'], ['agv', 'agv']]) {
        const w = reviewWorld(['+.....', '+.....', '+.....', '+++++++'], { cell, traffic: { handedness } });
        const a = w.add({ id: 'A', x: 0, y: 0, ...body(one) });
        const b = w.add({ id: 'B', x: 6, y: 3, ...body(other) });
        w.go(a, 6, 3);
        w.go(b, 0, 0);
        let worst = Infinity;
        w.runUntil(() => { worst = Math.min(worst, bodyGap(a, b)); return !a.driving && !b.driving; }, 200);
        assert.ok(!a.driving && !b.driving, `${one}/${other} ${handedness}: both arrive`);
        assert.ok(worst >= 0, `${one}/${other} ${handedness}: bodies overlap by ${(-worst).toFixed(2)} m`);
        assert.deepEqual(w.checker.counts, {}, `${one}/${other} ${handedness}`);
        if (one === other) { // they meet in the corner at the same moment
          const waited = w.traffic.stats.waitJunction + w.traffic.stats.waitVehicle > 0;
          assert.equal(waited, FLEET_PRESETS[one].length > w.traffic.swingLength, `${one}/${other}: long vehicles take turns in the corner, short ones pass each other without waiting`);
        }
      }
    }
  });
}

test('long vehicles stay clear of each other on street layouts: up to 1.75 cells everywhere, 2 cells on streets (independent per-tick checks, breakdowns, attach / detach)', () => {
  // The supported range stated in the header of js/sim/traffic.js (cell 2 m). Deadlocks are not asserted: long vehicles lock
  // long stretches of road and meet the limits of exclusive cell locks more often; relocation resolves them.
  const hard = new Set(['nan', 'speed', 'jump', 'cell', 'headway', 'pathgap', 'stats', 'api']);
  const failures = [];
  let worstOverlap = 0;
  let runs = 0;
  for (const [length, kinds] of [[2.2, ['streets', 'spurs', 'blob']], [2.6, ['streets', 'spurs', 'blob']], [3.5, ['streets', 'spurs', 'blob']], [4, ['streets', 'spurs']]]) {
    for (const kind of kinds) {
      for (let seed = 1; seed <= 4; seed++) {
        const r = runReviewScenario({ seed, kind, dt: 0.1, seconds: 150, vehicles: 10, chaos: 0.3, cells: [2], fleets: [0], bodies: [{ length, speed: 1.5, accel: 0.6, decel: 1 }], headway: 0.5 });
        runs++;
        worstOverlap = Math.max(worstOverlap, r.checker.worst.overlap ?? 0);
        const bad = Object.keys(r.checker.counts).filter((k) => hard.has(k));
        if (bad.length) failures.push(`${length} m ${kind} seed ${seed}: ${bad.join(',')} ${JSON.stringify(r.checker.violations.find((v) => hard.has(v.kind)))}`);
      }
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(worstOverlap < 0.12, `bodies of ${runs} runs overlap by up to ${worstOverlap.toFixed(3)} m`); // (blob layouts, 2.6 m: 0.10 m)
});

// ---- in-place manoeuvres ----------------------------------------------------------------------------------------------

test('a vehicle bound for a dead end and back waits at the stop line while the lane it returns in is blocked, and turns round once it is free', () => {
  // X docks in the return lane just before the tip and breaks down. The forklift would have to stop with its tail in the
  // tip cell (no room beyond the exit for its length), so it waits in front of the cell - reason 'broken', blocked by X, body
  // unturned, nowhere near X - and completes the trip after the repair.
  const w = reviewWorld(['+++++++'], { cell: 2 });
  const x = w.add({ id: 'X', x: 6, y: 0 });
  w.go(x, 5, 0);
  w.runUntil(() => !x.driving, 30);
  x.disabled = true;
  const f = w.add({ id: 'F', x: 0, y: 0, ...body('forklift') });
  assert.equal(w.traffic.drive(f, viaRoute(w, f, [[6, 0], [2, 0]])), true);
  w.run(40);
  const tip = w.node(6, 0);
  assert.ok(f.driving && f.waiting && f.blockedBy === x && f.waitReason === 'broken', `F waits for the broken X (${f.waitReason})`);
  assert.ok(f.x + f.length / 2 < w.graph.x(tip) - w.graph.cellSize / 2, 'its nose is still in front of the tip cell');
  assert.ok(Math.abs(f.heading) < 1e-9 && f.v === 0 && f.waitTime > 15);
  assert.equal(w.traffic._lock[tip], null, 'it has not taken the tip');
  x.disabled = false;
  w.go(x, 0, 0);
  w.runUntil(() => !f.driving, 120);
  assert.equal(f.node, w.node(2, 0), 'F turned round and drove on');
  assert.deepEqual(w.checker.counts, {});
});

test('a vehicle queued exactly at the headway behind one that starts a trip with a lane shift is no obstacle for the manoeuvre', () => {
  // S stands on the centre line of a two-way road, F waits 0.5 m behind it. S's route puts it onto its lane line: a lateral
  // shift of 0.44 m. The swept body stays 0.5 m from F, so S starts at once instead of waiting for F (which waits for S).
  const w = reviewWorld(['+'.repeat(10)], { cell: 2 });
  const s = w.add({ id: 'S', x: 5, y: 0 });
  const f = w.add({ id: 'F', x: 0, y: 0 });
  w.go(f, 9, 0);
  w.runUntil(() => f.waiting, 60);
  w.run(5);
  assert.equal(f.blockedBy, s);
  assert.ok(Math.abs(bodyGap(s, f) - 0.5) < 0.05, `F queues at the headway (${bodyGap(s, f).toFixed(3)} m)`);
  w.go(s, 9, 0);
  let waited = 0;
  w.run(3, 0.1);
  for (let i = 0; i < 30; i++) {
    w.run(0.1);
    if (s.waiting) waited += 0.1;
  }
  assert.equal(waited, 0, 'S never waits for F');
  assert.ok(s.odometer > 1, `S drives (${s.odometer.toFixed(2)} m)`);
  w.runUntil(() => !s.driving && !f.driving, 100);
  assert.deepEqual(w.checker.counts, {});
  assert.equal(w.traffic.stats.deadlocks, 0);
});

test('vehicles on neighbouring nodes that start turning at the same moment finish without overlap, deadlock or waiting for each other for good', () => {
  for (const [length, cell] of [[1.2, 2], [2.6, 2], [3.5, 2], [2.6, 3]]) {
    const w = reviewWorld(['+++++++', '+.....+', '+.....+'], { cell, traffic: { resolveDeadlocks: false } });
    const spec = { length, speed: 1.5, accel: 0.6, decel: 1 };
    const a = w.add({ id: 'A', x: 2, y: 0, ...spec });
    const b = w.add({ id: 'B', x: 4, y: 0, ...spec });
    w.go(a, 0, 2); // both turn the other way: A towards the west spur, B towards the east spur
    w.go(b, 6, 2);
    w.runUntil(() => !a.driving && !b.driving, 200);
    assert.ok(!a.driving && !b.driving, `${length} m in ${cell} m cells: both arrive`);
    assert.equal(w.traffic.stats.deadlocks, 0);
    assert.deepEqual(w.checker.counts, {}, `${length} m`);
  }
});

// ---- placing vehicles ---------------------------------------------------------------------------------------------------

test('canAttach / attach / addVehicle / relocate accept a node exactly when the approaching traffic can still stop in front of it', () => {
  const stopping = (v, decel) => (v * v) / (2 * decel);
  const spec = { length: 1.2, speed: 3, accel: 1, decel: 2 };
  const spot = 14;
  const build = () => {
    const w = reviewWorld(['>'.repeat(30)], { cell: 2, check: false });
    const fast = w.add({ id: 'fast', x: 0, y: 0, ...spec });
    const spare = w.add({ id: 'spare', x: 29, y: 0 });
    w.traffic.detach(spare);
    w.go(fast, 28, 0);
    return { w, fast, spare, node: w.node(spot, 0) };
  };
  // 1. canAttach flips exactly where nose-to-tail distance = headway + stopping distance, for every tick of the approach
  const first = build();
  const lastOk = { tick: -1, gap: 0 };
  for (let tick = 0; tick < 400; tick++) {
    first.w.traffic.step(0.1);
    const centreDistance = first.w.graph.x(first.node) - first.fast.x;
    const need = (first.fast.length + 1.2) / 2 + 0.5 + stopping(first.fast.v, first.fast.decel);
    if (first.fast.v > 2.9 && centreDistance > 0) {
      assert.equal(first.w.traffic.canAttach(first.node), centreDistance >= need - 1e-9, `distance ${centreDistance.toFixed(2)} m, needed ${need.toFixed(2)} m`);
      if (first.w.traffic.canAttach(first.node)) { lastOk.tick = tick; lastOk.gap = centreDistance - need; }
    }
  }
  assert.ok(lastOk.tick > 0 && lastOk.gap < 0.35, `the last accepted tick was within one tick of travel of the limit (${lastOk.gap.toFixed(2)} m)`);
  // 2. attaching at the last accepted tick never forces an emergency stop on the approaching vehicle, a refused attach changes nothing
  const second = build();
  let braking = 0;
  let last = 0;
  for (let tick = 0; tick < 400; tick++) {
    if (tick === lastOk.tick) {
      assert.equal(second.w.traffic.attach(second.spare, second.node), true);
      second.w.traffic.relocate(second.spare, second.node);
    }
    second.w.traffic.step(0.1);
    braking = Math.max(braking, (last - second.fast.v) / 0.1);
    last = second.fast.v;
  }
  assert.ok(braking <= second.fast.decel * 1.02, `braked at ${braking.toFixed(2)} m/s^2 (decel ${second.fast.decel})`);
  assert.ok(bodyGap(second.fast, second.spare) >= 0.5 - 1e-6, 'it stopped a headway behind the new vehicle');
  const third = build();
  third.w.runUntil(() => third.w.graph.x(third.node) - third.fast.x < 3, 60);
  assert.equal(third.w.traffic.attach(third.spare, third.node), false);
  assert.equal(third.spare.onRoad, false);
  assert.equal(third.w.traffic.addVehicle({ id: 'extra', node: third.node, ...spec }), null);
  assert.equal(third.w.traffic.findFreeNode(third.node) !== third.node, true, 'findFreeNode does not offer that node');
});
