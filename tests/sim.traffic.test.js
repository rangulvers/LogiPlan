// TrafficSystem: kinematics, lanes and poses, headway / platoons, disabled vehicles, bookkeeping and the
// add / remove / detach / attach / relocate API. Junctions and deadlocks are in sim.traffic.junctions.test.js.
// Every scenario runs with the invariant checker of tests/helpers/traffic-invariants.js after each tick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, bodyGap, AGV } from './helpers/traffic-invariants.js';

const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? 'value'}: ${actual} not within ${tol} of ${expected}`);
const LINE = ['>>>>>>>>>>']; // ten cells, one-way: 18 m between the first and the last centre

/** Drive `tv` to (x, y) and return the time it took. */
function tripTime(w, tv, x, y, dt = 0.1) {
  w.drive(tv, x, y);
  return w.runUntil(() => !tv.driving, 600, dt);
}

// ---- kinematics (requirement 1) -------------------------------------------------------------------------------

test('trapezoid profile: accelerate, cruise, brake to the final node centre (analytic 14 s for 18 m)', () => {
  // 1.5 m/s needs 2.5 s / 1.875 m at 0.6 m/s^2 and 1.5 s / 1.125 m at 1.0 m/s^2; the remaining 15 m take 10 s.
  for (const dt of [0.05, 0.1, 0.25, 0.5]) {
    const w = createWorld(LINE);
    const a = w.add({ id: 'a', x: 0, y: 0 });
    near(tripTime(w, a, 9, 0, dt), 14, 0.1 + dt / 2, `trip time at dt ${dt}`);
    near(a.odometer, 18, 1e-6, 'odometer');
  }
});

test('short trip is triangular: accel-limited, never reaches the cruise speed', () => {
  const w = createWorld(LINE);
  const a = w.add({ id: 'a', x: 0, y: 0 });
  w.drive(a, 1, 0);
  let peak = 0;
  w.runUntil(() => { peak = Math.max(peak, a.v); return !a.driving; });
  // 2 m = v^2/(2*0.6) + v^2/(2*1.0) -> v = 1.2247 m/s, t = v/0.6 + v/1.0 = 3.266 s
  near(peak, 1.2247, 0.08, 'peak speed');
  near(w.traffic.time, 3.266, 0.15, 'trip time');
});

test('the vehicle stops exactly on the final node centre, parked, no longer driving', () => {
  const w = createWorld(LINE);
  const a = w.add({ id: 'a', x: 0, y: 0 });
  const arrivals = [];
  w.traffic.onArrive = (tv) => arrivals.push(tv.id);
  w.drive(a, 6, 0);
  w.runUntil(() => !a.driving);
  assert.deepEqual(arrivals, ['a']);
  assert.equal(a.node, w.node(6, 0));
  assert.equal(a.edge, -1);
  assert.equal(a.v, 0);
  assert.equal(a.moving, false);
  near(a.x, w.graph.x(w.node(6, 0)), 1e-9, 'x');
  near(a.y, w.graph.y(w.node(6, 0)), 1e-9, 'y');
  near(a.heading, 0, 1e-9, 'heading east');
});

test('speed never exceeds vmax*speedFactor*edge limit; acceleration and braking respect accel / decel', () => {
  const w = createWorld(LINE);
  const a = w.add({ id: 'a', x: 0, y: 0 });
  let last = 0;
  let maxUp = 0;
  let maxDown = 0;
  let peak = 0;
  w.drive(a, 9, 0);
  w.run(20, 0.1, () => {
    maxUp = Math.max(maxUp, (a.v - last) / 0.1);
    maxDown = Math.max(maxDown, (last - a.v) / 0.1);
    peak = Math.max(peak, a.v);
    last = a.v;
  });
  near(peak, 1.5, 1e-9, 'peak speed');
  assert.ok(maxUp <= 0.6 + 1e-9, `acceleration ${maxUp}`);
  assert.ok(maxDown <= 1.0 + 1e-9, `deceleration ${maxDown}`);
});

test('speedFactor scales the cruise speed (analytic 25 s at half speed) and can change while driving', () => {
  const w = createWorld(LINE);
  w.traffic.speedFactor = 0.5;
  const a = w.add({ id: 'a', x: 0, y: 0 });
  near(tripTime(w, a, 9, 0), 25, 0.2, 'trip time at half speed'); // 1.25 s + 0.75 s ramps (0.75 m) + 17.25 m / 0.75

  const w2 = createWorld(LINE);
  const b = w2.add({ id: 'b', x: 0, y: 0 });
  w2.drive(b, 9, 0);
  w2.run(8);
  assert.equal(b.v, 1.5);
  w2.traffic.speedFactor = 0.5;
  let last = b.v;
  let maxDrop = 0;
  w2.run(2, 0.1, () => { maxDrop = Math.max(maxDrop, last - b.v); last = b.v; });
  near(b.v, 0.75, 1e-9, 'slowed down to the new cap');
  near(maxDrop, 0.1, 1e-9, 'it brakes at 1 m/s^2 instead of jumping to the new speed');
});

test('a zero speedFactor freezes vehicles without waiting or errors', () => {
  const w = createWorld(LINE);
  const a = w.add({ id: 'a', x: 0, y: 0 });
  w.drive(a, 9, 0);
  w.run(3);
  w.traffic.speedFactor = 0;
  w.run(5);
  assert.equal(a.v, 0);
  assert.equal(a.waiting, false);
  const x = a.x;
  w.run(3);
  assert.equal(a.x, x);
  w.traffic.speedFactor = 1;
  w.runUntil(() => !a.driving);
  assert.equal(a.node, w.node(9, 0));
});

test('slow zones (road limit) cap the speed on the edges that touch them and are anticipated', () => {
  const w = createWorld(LINE, { mutate: (l) => { l.roads['5,0'].limit = 0.5; } });
  const a = w.add({ id: 'a', x: 0, y: 0 });
  const g = w.graph;
  let inZone = 0;
  let before = 0;
  w.drive(a, 9, 0);
  w.runUntil(() => {
    const x = a.x / g.cellSize - 0.5; // cell coordinate
    if (x >= 4.0 && x <= 6.0) inZone = Math.max(inZone, a.v);
    if (x < 3) before = Math.max(before, a.v);
    return !a.driving;
  });
  assert.ok(inZone <= 0.75 + 1e-9, `speed inside the slow zone ${inZone}`);
  near(before, 1.5, 1e-9, 'full speed before the zone');
  assert.ok(w.traffic.time > 14 + 2, 'the zone costs time');
});

test('corners are taken at no more than half of the maximum speed', () => {
  const w = createWorld(['>>>>v', '....v', '....v']);
  const a = w.add({ id: 'a', x: 0, y: 0 });
  const g = w.graph;
  let inCorner = 0;
  let outside = 0;
  w.drive(a, 4, 2);
  w.runUntil(() => {
    const cx = a.x / g.cellSize;
    const cy = a.y / g.cellSize;
    if (Math.hypot(cx - 4.5, cy - 0.5) < 0.5) inCorner = Math.max(inCorner, a.v);
    else outside = Math.max(outside, a.v);
    return !a.driving;
  });
  assert.ok(inCorner <= 0.75 + 1e-9, `corner speed ${inCorner}`);
  assert.ok(outside > 1.0, 'it does speed up on the straight');
});

test('dead end: the vehicle comes to rest at the tip, turns around at speed 0 and leaves on the other lane', () => {
  const w = createWorld(['++++++']);
  const a = w.add({ id: 'a', x: 1, y: 0 });
  const g = w.graph;
  const tip = w.node(5, 0);
  w.drive(a, 5, 0);
  w.runUntil(() => !a.driving);
  assert.equal(a.node, tip);
  near(a.y, g.y(tip) + 0.44, 1e-9, 'parked in the right-hand (eastbound) lane');
  // the way back starts with the reversal
  const route = g.search(tip, { arrivalEdge: a.lastEdge }).routeTo(w.node(1, 0));
  assert.equal(route.edges[0], g.edges[a.lastEdge].rev);
  w.traffic.drive(a, route);
  let turningSteps = 0;
  let turnedWhileMoving = 0;
  w.run(8, 0.1, () => {
    const h = Math.abs(a.heading);
    if (h > 0.05 && h < Math.PI - 0.05) { // somewhere in the middle of the turn
      turningSteps++;
      if (a.v !== 0 || a.moving) turnedWhileMoving++;
    }
  });
  assert.ok(turningSteps >= 3, 'the U-turn takes time');
  assert.equal(turnedWhileMoving, 0, 'speed is 0 while the vehicle turns around');
  w.runUntil(() => !a.driving);
  near(a.y, g.y(w.node(1, 0)) - 0.44, 1e-9, 'parked in the westbound lane');
  near(Math.abs(a.heading), Math.PI, 1e-9, 'heading west');
  assert.equal(w.traffic.stats.waitJunction + w.traffic.stats.waitVehicle, 0);
});

// ---- lanes, poses, headings (requirement 3) ---------------------------------------------------------------------

test('right-hand traffic: eastbound vehicles ride 0.22 cells south of the centre line, westbound north of it', () => {
  const w = createWorld(['++++++++']);
  const east = w.add({ id: 'e', x: 0, y: 0 });
  const west = w.add({ id: 'w', x: 7, y: 0 });
  w.drive(east, 7, 0);
  w.drive(west, 0, 0);
  let eastY = null;
  let westY = null;
  w.run(8, 0.1, () => { if (Math.abs(east.x - 8) < 0.05) eastY = east.y; if (Math.abs(west.x - 8) < 0.3) westY = west.y; });
  near(eastY, 1 + 0.44, 1e-6, 'eastbound lane y');
  near(westY, 1 - 0.44, 1e-6, 'westbound lane y');
  assert.equal(w.traffic.stats.totalWait, 0, 'opposite lanes do not interact');
});

test('left-hand traffic mirrors the lanes', () => {
  const w = createWorld(['++++++++'], { traffic: { handedness: 'left' } });
  const east = w.add({ id: 'e', x: 0, y: 0 });
  w.drive(east, 7, 0);
  w.runUntil(() => !east.driving);
  near(east.y, 1 - 0.44, 1e-9, 'eastbound lane y with left-hand traffic');
});

test('one-way roads are driven on the centre line', () => {
  const w = createWorld(LINE);
  const a = w.add({ id: 'a', x: 0, y: 0 });
  w.drive(a, 9, 0);
  w.run(10, 0.1, () => assert.equal(a.y, 1));
});

test('a stationary vehicle docked on a two-way road occupies the right-hand lane; a fresh one sits on the centre', () => {
  const w = createWorld(['+++++', '..+..']);
  const fresh = w.add({ id: 'f', x: 1, y: 0 });
  assert.equal(fresh.lastEdge, -1);
  assert.equal(fresh.x, w.graph.x(w.node(1, 0)));
  assert.equal(fresh.y, w.graph.y(w.node(1, 0)));
  assert.equal(fresh.node, w.node(1, 0));
  w.drive(fresh, 3, 0);
  w.runUntil(() => !fresh.driving);
  near(fresh.y, w.graph.y(w.node(3, 0)) + 0.44, 1e-9, 'docked in the right-hand lane');
  assert.equal(fresh.lastEdge, w.graph.edgeBetween(w.node(2, 0), w.node(3, 0)));
});

test('poses are continuous around corners, lane changes and U-turns (max step <= vmax*dt + 5 cm) for both handednesses', () => {
  for (const handedness of ['right', 'left']) {
    for (const dt of [0.1, 0.5]) {
      // a one-way feeder into a two-way loop with a dead-end spur: S-curves, corners and a U-turn
      const w = createWorld([
        '>>++++++',
        '..+....+',
        '..+....+',
        '..++++++',
        '..+.....',
      ], { traffic: { handedness } });
      const a = w.add({ id: 'a', x: 0, y: 0 });
      let maxStep = 0;
      let maxTurn = 0;
      let px = a.x;
      let py = a.y;
      let ph = a.heading;
      const legs = [[7, 3], [2, 4], [7, 0], [3, 3], [2, 0]];
      let leg = 0;
      w.traffic.onArrive = (tv) => { leg++; if (leg < legs.length && !w.drive(tv, ...legs[leg])) assert.fail(`no route to leg ${leg}`); };
      w.drive(a, ...legs[0]);
      w.run(300, dt, () => {
        maxStep = Math.max(maxStep, Math.hypot(a.x - px, a.y - py));
        let dh = Math.abs(a.heading - ph) % (2 * Math.PI);
        if (dh > Math.PI) dh = 2 * Math.PI - dh;
        maxTurn = Math.max(maxTurn, dh);
        px = a.x; py = a.y; ph = a.heading;
      });
      assert.equal(leg, legs.length, 'all legs completed');
      assert.ok(maxStep <= 1.5 * dt + 0.05, `max displacement ${maxStep} at dt ${dt} (${handedness})`);
      assert.ok(maxTurn < 1.6, `heading changed by ${maxTurn} rad in one step`);
    }
  }
});

test('heading follows the direction of motion (east 0, south pi/2, west pi, north -pi/2)', () => {
  const w = createWorld([
    '>>>v',
    '^..v',
    '^<<<',
  ]);
  const a = w.add({ id: 'a', x: 0, y: 0 });
  const seen = [];
  const goals = [[3, 0], [3, 2], [0, 2], [0, 0]];
  let i = 0;
  w.traffic.onArrive = (tv) => { seen.push(tv.heading); if (++i < goals.length) w.drive(tv, ...goals[i]); };
  w.drive(a, ...goals[0]);
  w.runUntil(() => i >= goals.length);
  near(seen[0], 0, 1e-9, 'east');
  near(seen[1], Math.PI / 2, 1e-9, 'south');
  near(Math.abs(seen[2]), Math.PI, 1e-9, 'west');
  near(seen[3], -Math.PI / 2, 1e-9, 'north');
});

// ---- headway and collisions (requirement 2) -----------------------------------------------------------------------

test('a follower queues behind a parked vehicle at exactly vehicle length + headway, on both sides of an edge boundary', () => {
  for (const leaderCell of [6, 7]) { // the follower stops on the leader's edge or on the edge before it
    const w = createWorld(LINE);
    const leader = w.add({ id: 'l', x: leaderCell, y: 0 });
    const follower = w.add({ id: 'f', x: 0, y: 0 });
    w.drive(follower, leaderCell, 0);
    w.run(40);
    assert.equal(follower.driving, true, 'the dock is occupied, so the trip cannot finish');
    near(leader.x - follower.x, 1.2 + 0.5, 1e-6, 'centre distance = length + headway');
    assert.equal(follower.waiting, true);
    assert.equal(follower.waitReason, 'vehicle');
    assert.equal(follower.blockedBy, leader);
    assert.ok(follower.waitTime > 20);
  }
});

test('the headway is an option', () => {
  const w = createWorld(LINE, { traffic: { headway: 1.25 } });
  const leader = w.add({ id: 'l', x: 6, y: 0 });
  const follower = w.add({ id: 'f', x: 0, y: 0 });
  w.drive(follower, 6, 0);
  w.run(40);
  near(leader.x - follower.x, 1.2 + 1.25, 1e-6, 'centre distance');
});

test('a platoon starting from rest keeps its spacing and everybody arrives in order', () => {
  const w = createWorld(['>'.repeat(30)]);
  const vs = [];
  for (let i = 0; i < 6; i++) vs.push(w.add({ id: `p${i}`, x: 5 - i, y: 0 }));
  const arrivals = [];
  w.traffic.onArrive = (tv) => arrivals.push(tv.id);
  vs.forEach((v, i) => w.drive(v, 25 - i, 0));
  let minGap = Infinity;
  w.run(80, 0.1, () => {
    for (let i = 1; i < vs.length; i++) minGap = Math.min(minGap, vs[i - 1].x - vs[i].x - 1.2);
  });
  assert.deepEqual(arrivals, ['p0', 'p1', 'p2', 'p3', 'p4', 'p5']);
  assert.ok(minGap >= 0.5 - 1e-9, `closest approach ${minGap}`);
  vs.forEach((v, i) => near(v.x, w.graph.x(w.node(25 - i, 0)), 1e-9, `${v.id} parked`));
});

test('followers with weaker brakes than the leader stay safe (mixed fleet, leader brakes hard)', () => {
  const w = createWorld(['>'.repeat(30)]);
  const leader = w.add({ id: 'lead', x: 6, y: 0, speed: 3, accel: 1, decel: 3, length: 2.0 });
  const slow = w.add({ id: 'slow', x: 1, y: 0, speed: 3, accel: 1, decel: 0.5, length: 1.0 });
  w.drive(leader, 29, 0);
  w.drive(slow, 28, 0);
  w.run(60);
  assert.equal(slow.node, w.node(28, 0));
  assert.equal(leader.node, w.node(29, 0));
});

test('safe even if the leader stops instantly: the follower never gets closer than the headway', () => {
  for (const dt of [0.1, 0.5]) {
    const w = createWorld(['>'.repeat(40)]);
    const leader = w.add({ id: 'lead', x: 2, y: 0 });
    const follower = w.add({ id: 'f', x: 0, y: 0, speed: 3, accel: 1, decel: 1.5 }); // faster: catches up and tails it
    w.drive(leader, 38, 0);
    w.drive(follower, 37, 0);
    w.run(24, dt);
    assert.equal(leader.v, 1.5);
    assert.ok(leader.x - follower.x < 1.7 + 1.5 * dt + 0.1, `the follower tails the leader (${leader.x - follower.x} m)`); // one tick of lag
    leader.v = 0; // an impossible, instantaneous stop
    leader.disabled = true;
    let minGap = Infinity;
    w.run(20, dt, () => { minGap = Math.min(minGap, leader.x - follower.x - 1.2); });
    assert.ok(minGap >= 0.5 - 1e-9, `closest approach ${minGap} at dt ${dt}`);
    assert.equal(follower.v, 0);
  }
});

test('opposite lanes of a two-way road do not interact: two vehicles swap ends without waiting', () => {
  const w = createWorld(['+'.repeat(12)]);
  const a = w.add({ id: 'a', x: 0, y: 0 });
  const b = w.add({ id: 'b', x: 11, y: 0 });
  w.drive(a, 11, 0);
  w.drive(b, 0, 0);
  let minSeparation = Infinity;
  w.runUntil(() => !a.driving && !b.driving, 120, 0.1);
  assert.equal(a.node, w.node(11, 0));
  assert.equal(b.node, w.node(0, 0));
  assert.equal(w.traffic.stats.totalWait, 0);
  // replay to measure the lateral clearance while passing
  const w2 = createWorld(['+'.repeat(12)]);
  const a2 = w2.add({ id: 'a', x: 0, y: 0 });
  const b2 = w2.add({ id: 'b', x: 11, y: 0 });
  w2.drive(a2, 11, 0);
  w2.drive(b2, 0, 0);
  w2.run(20, 0.1, () => {
    if (Math.abs(a2.x - b2.x) < 1.2) minSeparation = Math.min(minSeparation, Math.abs(a2.y - b2.y));
  });
  assert.ok(minSeparation > a2.width, `lateral clearance ${minSeparation} vs width ${a2.width}`);
});

test('several vehicles circulate on a one-way loop without ever stopping for good', () => {
  const lines = ['>>>>>>>v', '^......v', '^......v', '^......v', '^......v', '^<<<<<<<'];
  const w = createWorld(lines);
  const g = w.graph;
  // ring order starting at (0,0)
  const ring = [];
  for (let n = w.node(0, 0); ring.length === 0 || n !== ring[0]; n = g.edges[g.out[n][0]].to) ring.push(n);
  assert.equal(ring.length, 24);
  const vs = [0, 3, 6, 9, 12, 15, 18].map((k, i) => w.add({ id: `r${i}`, x: g.cx(ring[k]), y: g.cy(ring[k]) }));
  const plan = (tv) => {
    const at = ring.indexOf(tv.node);
    const route = g.search(tv.node, { arrivalEdge: tv.lastEdge }).routeTo(ring[(at + 7) % ring.length]);
    w.traffic.drive(tv, route);
  };
  w.traffic.onArrive = plan;
  vs.forEach(plan);
  w.run(300);
  for (const v of vs) assert.ok(v.odometer > 150, `${v.id} drove ${v.odometer} m`);
  assert.equal(w.traffic.stats.deadlocks, 0);
});

test('followers keep their bodies apart through the tight right-hand corners of a one-way loop', () => {
  // clockwise loop: every corner is an inner (right) turn with a radius of about a quarter of a cell
  const lines = ['>>>>>>>v', '^......v', '^......v', '^......v', '^......v', '^<<<<<<<'];
  for (const [cell, length, tolerance] of [[1.5, 1.35, 0.1], [2, 1.2, 0.05], [2, 1.8, 0.05], [3, 1.2, -0.05]]) {
    const w = createWorld(lines, { cell, geometry: false });
    const g = w.graph;
    const ring = [];
    for (let n = w.node(0, 0); ring.length === 0 || n !== ring[0]; n = g.edges[g.out[n][0]].to) ring.push(n);
    const vs = Array.from({ length: 12 }, (_, i) => w.add({ id: `r${i}`, x: g.cx(ring[2 * i]), y: g.cy(ring[2 * i]), length }));
    const plan = (tv) => w.traffic.drive(tv, g.search(tv.node, { arrivalEdge: tv.lastEdge }).routeTo(ring[(ring.indexOf(tv.node) + 5) % ring.length]));
    w.traffic.onArrive = plan;
    vs.forEach(plan);
    let closest = Infinity;
    w.run(240, 0.1, () => { for (let i = 0; i < vs.length; i++) closest = Math.min(closest, bodyGap(vs[i], vs[(i + 1) % vs.length])); });
    assert.ok(closest >= tolerance, `cell ${cell} m, vehicle ${length} m: closest approach of two bodies ${closest.toFixed(3)} m`);
  }
});

// ---- disabled vehicles (requirement 7) ------------------------------------------------------------------------------

test('a disabled vehicle brakes at once with maximum deceleration, stays, blocks followers and clears', () => {
  const w = createWorld(['>'.repeat(30)]);
  const lead = w.add({ id: 'lead', x: 4, y: 0 });
  const f1 = w.add({ id: 'f1', x: 2, y: 0 });
  const f2 = w.add({ id: 'f2', x: 0, y: 0 });
  [lead, f1, f2].forEach((v, i) => w.drive(v, 29 - i, 0));
  w.run(12);
  assert.equal(lead.v, 1.5);
  lead.disabled = true;
  let last = lead.v;
  let maxDecel = 0;
  w.run(5, 0.1, () => { maxDecel = Math.max(maxDecel, (last - lead.v) / 0.1); last = lead.v; });
  assert.equal(lead.v, 0);
  assert.ok(Math.abs(maxDecel - 1.0) < 1e-9, `braked at ${maxDecel}`);
  const stopX = lead.x;
  w.run(30);
  assert.equal(lead.x, stopX, 'it stays');
  assert.ok(f1.x <= stopX - 1.7 + 1e-6 && f2.x <= f1.x - 1.7 + 1e-6, 'followers queue behind it');
  assert.equal(f1.waitReason, 'broken');
  assert.equal(f2.waitReason, 'broken', 'the whole queue is blamed on the breakdown');
  assert.ok(w.traffic.stats.waitBroken > 40 && w.traffic.stats.waitVehicle === 0);
  lead.disabled = false;
  w.runUntil(() => !lead.driving && !f1.driving && !f2.driving);
  assert.equal(lead.node, w.node(29, 0));
  assert.equal(f2.node, w.node(27, 0));
});

// ---- waiting bookkeeping and statistics (requirement 5) -------------------------------------------------------------

test('parked vehicles are stopped, not waiting; a blocked driver is waiting with reason and blocker', () => {
  const w = createWorld(LINE);
  const a = w.add({ id: 'a', x: 5, y: 0 });
  const b = w.add({ id: 'b', x: 0, y: 0 });
  w.run(5);
  assert.equal(a.waiting, false);
  assert.equal(a.waitReason, null);
  assert.equal(a.blockedBy, null);
  assert.equal(a.waitTime, 0);
  w.drive(b, 5, 0);
  w.run(30);
  assert.equal(b.waiting, true);
  assert.equal(b.waitReason, 'vehicle');
  assert.equal(b.blockedBy, a);
  assert.ok(b.waitTime > 10 && b.waitTime < 30);
  assert.equal(a.waiting, false);
  a.disabled = false;
  w.drive(a, 9, 0);
  w.run(4);
  assert.equal(b.waiting, false, 'it moves again once the way is free');
  assert.equal(b.waitTime, 0);
});

test('a vehicle held to a crawl by a slow leader is waiting while it moves; one that only follows at a good speed is not', () => {
  for (const [leaderSpeed, waiting] of [[0.3, true], [1.0, false]]) {
    const w = createWorld(['>'.repeat(40)]);
    const leader = w.add({ id: 'lead', x: 3, y: 0, speed: leaderSpeed });
    const follower = w.add({ id: 'f', x: 0, y: 0 });
    w.drive(leader, 38, 0);
    w.drive(follower, 37, 0);
    w.run(30);
    near(follower.v, leaderSpeed, 0.02, 'it follows at the leader speed');
    assert.equal(follower.moving, true);
    assert.equal(follower.waiting, waiting, `leader at ${leaderSpeed} m/s`);
    if (waiting) {
      assert.equal(follower.waitReason, 'vehicle');
      assert.equal(follower.blockedBy, leader);
    } else {
      assert.equal(follower.blockedBy, null);
    }
  }
});

test('statistics: edgePasses counts every edge entry, waits are attributed to edge and cell, totals add up', () => {
  const w = createWorld(LINE);
  const a = w.add({ id: 'a', x: 6, y: 0 });
  const b = w.add({ id: 'b', x: 0, y: 0 });
  const g = w.graph;
  w.drive(b, 6, 0);
  w.run(60);
  const st = w.traffic.stats;
  const passes = Array.from(st.edgePasses);
  // b queues behind a and stops 1.7 m short of cell 6, on the edge 5 -> 6: six edges entered
  assert.equal(passes.reduce((x, y) => x + y, 0), 6, 'six edges entered');
  for (let x = 0; x < 6; x++) assert.equal(passes[g.edgeBetween(w.node(x, 0), w.node(x + 1, 0))], 1);
  assert.equal(st.waitVehicle + st.waitJunction + st.waitBroken, st.totalWait);
  assert.ok(st.totalWait > 30 && st.waitVehicle === st.totalWait);
  const queueEdge = g.edgeBetween(w.node(5, 0), w.node(6, 0));
  assert.ok(st.edgeWait[queueEdge] > 30, 'waited on the last edge before the dock');
  assert.equal(st.edgeWait.reduce((x, y) => x + y, 0), st.totalWait);
  assert.equal(st.nodeWait.reduce((x, y) => x + y, 0), st.totalWait);
  near(st.drivingTime, 60, 1e-6, 'one driving vehicle for 60 s');
  assert.equal(a.waiting, false);
});

// ---- API: add / remove / detach / attach / relocate (requirement 8) ------------------------------------------------

test('addVehicle: parked on the node centre, refuses a taken or too crowded node and non-road cells', () => {
  const w = createWorld(['+++++...']);
  const a = w.add({ id: 'a', x: 1, y: 0 });
  assert.equal(a.onRoad, true);
  assert.equal(a.driving, false);
  assert.equal(a.v, 0);
  assert.equal(w.traffic.addVehicle({ id: 'dup', ...AGV, node: w.node(1, 0) }), null);
  assert.ok(w.traffic.addVehicle({ id: 'ok', ...AGV, node: w.node(2, 0) }), '0.8 m between bumpers is enough');
  assert.equal(w.traffic.addVehicle({ id: 'long', ...AGV, length: 2.6, node: w.node(3, 0) }), null, 'a 2.6 m vehicle does not fit next to it');
  assert.equal(w.traffic.addVehicle({ id: 'off', ...AGV, node: w.node(6, 0) }), null, 'not a road cell');
  assert.equal(w.traffic.addVehicle({ id: 'oob', ...AGV, node: -3 }), null);
  const odd = w.traffic.addVehicle({ id: 'odd', node: w.node(4, 0), length: NaN, speed: -1, accel: 0, decel: Infinity });
  assert.ok(odd && odd.length > 0 && odd.vmax > 0 && odd.accel > 0 && odd.decel > 0 && Number.isFinite(odd.decel), 'bad numbers fall back to defaults');
});

test('drive: validates the call, an empty route finishes during the next step', () => {
  const w = createWorld(LINE);
  const a = w.add({ id: 'a', x: 2, y: 0 });
  const n = w.node(2, 0);
  const arrived = [];
  w.traffic.onArrive = (tv) => arrived.push(tv.id);
  assert.equal(w.traffic.drive(a, { nodes: [w.node(3, 0)], edges: [] }), false, 'must start at the parked node');
  assert.equal(w.traffic.drive(a, { nodes: [n, w.node(4, 0)], edges: [w.graph.edgeBetween(n, w.node(3, 0))] }), false, 'edges must match nodes');
  assert.equal(w.traffic.drive(a, null), false);
  const x = a.x;
  assert.equal(w.traffic.drive(a, { nodes: [n], edges: [], cost: 0 }), true);
  assert.equal(a.driving, true);
  assert.deepEqual(arrived, []);
  w.run(0.1);
  assert.deepEqual(arrived, ['a']);
  assert.equal(a.driving, false);
  assert.equal(a.x, x);
  assert.equal(a.node, n);
  const route = w.graph.path(n, w.node(5, 0));
  assert.equal(w.traffic.drive(a, route), true);
  assert.equal(w.traffic.drive(a, route), false, 'already driving');
});

test('detach and attach leave no stale state; attach needs room', () => {
  const w = createWorld(LINE);
  const a = w.add({ id: 'a', x: 3, y: 0 });
  const b = w.add({ id: 'b', x: 0, y: 0 });
  w.traffic.detach(a);
  w.checker.check(); // nothing of `a` is left in lane lists, fresh lists, locks or the request queue
  assert.equal(a.onRoad, false);
  assert.equal(a.node, -1);
  assert.equal(w.traffic.canAttach(w.node(3, 0)), true);
  w.drive(b, 6, 0); // the cell is empty now: b drives through it
  w.runUntil(() => !b.driving);
  assert.equal(b.node, w.node(6, 0));
  assert.equal(w.traffic.canAttach(w.node(6, 0)), false, 'occupied');
  assert.equal(w.traffic.attach(a, w.node(6, 0)), false);
  assert.equal(a.onRoad, false);
  assert.equal(w.traffic.attach(a, w.node(3, 0)), true);
  assert.equal(a.onRoad, true);
  assert.equal(a.node, w.node(3, 0));
  assert.equal(a.lastEdge, -1);
  near(a.x, w.graph.x(w.node(3, 0)), 1e-12, 'back on the node centre');
  assert.equal(w.traffic.attach(a, w.node(8, 0)), false, 'already on the road');
  w.run(1);
});

test('detaching a driving vehicle cancels its route and frees lane and queue', () => {
  const w = createWorld(LINE);
  const a = w.add({ id: 'a', x: 0, y: 0 });
  const b = w.add({ id: 'b', x: 6, y: 0 });
  w.drive(a, 9, 0);
  w.run(5);
  w.traffic.detach(a);
  w.checker.check();
  assert.equal(a.driving, false);
  assert.equal(w.traffic.edgeCount(w.graph.edgeBetween(w.node(2, 0), w.node(3, 0))), 0);
  w.run(2);
  w.drive(b, 9, 0);
  w.runUntil(() => !b.driving);
  assert.equal(b.node, w.node(9, 0));
});

test('relocate teleports to a free node, clears the route and frees locks', () => {
  const w = createWorld(['+++++', '..+..']);
  const a = w.add({ id: 'a', x: 2, y: 1 });
  const g = w.graph;
  assert.equal(g.controlled[w.node(2, 1)], 1, 'the stem end is a dead end');
  assert.equal(w.traffic._lock[w.node(2, 1)], a, 'a parked vehicle holds the lock of its cell');
  w.drive(a, 0, 0);
  w.run(2);
  const target = w.node(3, 0);
  assert.equal(w.traffic.relocate(a, target), true);
  w.checker.check();
  assert.equal(a.driving, false);
  assert.equal(a.node, target);
  assert.equal(a.v, 0);
  assert.equal(a.lastEdge, -1);
  assert.equal(w.traffic._lock[w.node(2, 1)], null);
  assert.equal(w.traffic.relocate(a, w.node(1, 0)), true);
  const b = w.add({ id: 'b', x: 3, y: 0 });
  assert.equal(w.traffic.relocate(a, b.node), false, 'occupied');
  w.run(2);
});

test('removeVehicle takes a vehicle out of lanes, locks and the vehicle list', () => {
  const w = createWorld(['+++++', '..+..']);
  const a = w.add({ id: 'a', x: 0, y: 0 });
  const b = w.add({ id: 'b', x: 2, y: 1 });
  w.drive(a, 4, 0);
  w.run(2);
  assert.equal(w.traffic.removeVehicle(a), true);
  w.checker.check();
  assert.equal(w.traffic.removeVehicle(a), false);
  assert.equal(w.traffic.removeVehicle(b), true);
  w.checker.check();
  assert.equal(w.traffic.vehicles.length, 0);
  assert.equal(w.traffic._lock[w.node(2, 1)], null);
  w.run(2);
  assert.ok(w.add({ id: 'c', x: 2, y: 1 }));
});

test('findFreeNode returns the closest node with room and prefers cells that are not junctions', () => {
  const w = createWorld(['++++++']);
  const g = w.graph;
  for (let x = 1; x <= 3; x++) w.add({ id: `v${x}`, x, y: 0 });
  assert.equal(w.traffic.findFreeNode(w.node(2, 0)), w.node(4, 0), 'closest free (x=0 is a dead end, a junction cell)');
  assert.equal(w.traffic.findFreeNode(w.node(0, 0)), w.node(4, 0));
  const n = w.traffic.findFreeNode(w.node(1, 0), 1);
  assert.ok(n === w.node(4, 0) || n === w.node(0, 0));
  assert.equal(w.traffic.findFreeNode(-5), -1);
  assert.equal(g.isNode[w.traffic.findFreeNode(w.node(3, 0))], 1);
});

test('edgeCount reports vehicles driving on an edge (not the one parked at its head)', () => {
  const w = createWorld(LINE);
  const a = w.add({ id: 'a', x: 0, y: 0 });
  w.drive(a, 9, 0);
  w.run(5);
  const counts = w.graph.edges.map((e) => w.traffic.edgeCount(e.id));
  assert.equal(counts.reduce((x, y) => x + y, 0), 1);
  assert.equal(counts[a.edge], 1);
  w.runUntil(() => !a.driving);
  assert.equal(w.graph.edges.reduce((sum, e) => sum + w.traffic.edgeCount(e.id), 0), 0);
});

test('a TV exposes the documented fields; prevX / prevY / prevHeading are the pose at the start of the last tick', () => {
  const w = createWorld(LINE);
  const a = w.add({ id: 'a', owner: 'fleet-1', x: 0, y: 0, width: 0.6 });
  for (const field of ['id', 'owner', 'length', 'width', 'vmax', 'accel', 'decel', 'onRoad', 'node', 'edge', 's', 'lastEdge', 'v', 'x', 'y',
    'heading', 'prevX', 'prevY', 'prevHeading', 'driving', 'moving', 'waiting', 'waitReason', 'blockedBy', 'disabled', 'odometer', 'waitTime']) {
    assert.ok(field in a, `missing ${field}`);
  }
  assert.equal(a.owner, 'fleet-1');
  assert.equal(a.width, 0.6);
  assert.equal(a.vmax, 1.5);
  w.drive(a, 5, 0);
  w.run(3);
  for (let i = 0; i < 5; i++) {
    const before = { x: a.x, y: a.y, h: a.heading };
    w.run(0.1);
    assert.deepEqual([a.prevX, a.prevY, a.prevHeading], [before.x, before.y, before.h]);
  }
  assert.ok(a.moving && a.v > 0.05 && a.edge >= 0 && a.node === -1 && a.s >= 0 && a.s < 2);
  const st = w.traffic.stats;
  assert.ok(st.edgePasses instanceof Int32Array && st.edgePasses.length === w.graph.edges.length);
  assert.ok(st.edgeWait instanceof Float64Array && st.edgeWait.length === w.graph.edges.length);
  assert.ok(st.nodeWait instanceof Float64Array && st.nodeWait.length === w.graph.nodeCount);
  assert.deepEqual(w.traffic.activeDeadlocks, []);
});

test('an invalid speedFactor is ignored instead of poisoning the simulation', () => {
  const w = createWorld(LINE);
  const a = w.add({ id: 'a', x: 0, y: 0 });
  w.drive(a, 9, 0);
  for (const bad of [NaN, -2, Infinity, undefined]) {
    w.traffic.speedFactor = bad;
    w.run(1);
    assert.equal(w.traffic.speedFactor, 1);
  }
  w.runUntil(() => !a.driving);
  assert.equal(a.node, w.node(9, 0));
});

// ---- robustness and determinism ------------------------------------------------------------------------------------

test('step ignores zero, negative and non-finite time steps', () => {
  const w = createWorld(LINE);
  const a = w.add({ id: 'a', x: 0, y: 0 });
  w.drive(a, 5, 0);
  w.traffic.step(0);
  w.traffic.step(-1);
  w.traffic.step(NaN);
  w.traffic.step(Infinity);
  assert.equal(w.traffic.time, 0);
  assert.equal(a.s, 0);
});

test('an empty network and an empty traffic system run without trouble', () => {
  const w = createWorld(['........']);
  w.run(5);
  assert.equal(w.traffic.vehicles.length, 0);
  assert.equal(w.traffic.addVehicle({ id: 'x', ...AGV, node: 3 }), null);
  assert.equal(w.traffic.findFreeNode(3), -1);
  assert.equal(w.traffic.canAttach(3), false);
});

test('the simulation is deterministic: two identical runs produce identical poses', () => {
  const run = () => {
    const w = createWorld(['..+..', '..+..', '+++++', '..+..', '..+..'], { check: false });
    const vs = [[0, 2, 4, 2], [4, 2, 0, 2], [2, 0, 2, 4], [2, 4, 2, 0]].map(([x, y], i) => w.add({ id: `c${i}`, x, y }));
    const goals = [[4, 2], [0, 2], [2, 4], [2, 0]];
    const snapshot = [];
    w.traffic.onArrive = (tv) => { const i = vs.indexOf(tv); w.drive(tv, ...goals[(i + 1) % 4]); };
    vs.forEach((v, i) => w.drive(v, ...goals[i]));
    w.run(120, 0.1, (t) => { if (Math.round(t.time * 10) % 50 === 0) snapshot.push(t.vehicles.map((v) => [v.x, v.y, v.heading, v.v]).flat()); });
    return JSON.stringify(snapshot);
  };
  assert.equal(run(), run());
});
