// Logistics: adversarial review. Section A holds the regression tests of the defects the review found (idle vehicles that
// lock a plant, orders leaked by dead or broken vehicles, vehicles stranded without chargers, dock choice, lag of the dispatcher);
// each of them failed before the fix. Everything after it pins behaviour that a later change must
// not break: hostile configurations, dispatch races, vehicle depots and batteries, determinism, hand-computed numbers, the
// hand-over fields read by stats.js and the renderer, random hostile plants, performance. Most scenarios run against the REAL
// traffic engine (js/sim/traffic.js), a few against the stub (tests/helpers/stub-traffic.js) where exact travel times are needed.
// Plant builders and the real-engine world live in tests/helpers/logistics-review-gen.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutFromAscii } from './helpers/ascii.js';
import { checkInvariants, createWorld, eventDigest, injectLoads } from './helpers/logistics-invariants.js';
import { createInvariantChecker } from './helpers/traffic-invariants.js';
import { createRealWorld, gridPlant, hostilePlant, runChecked, waitBehindIdle } from './helpers/logistics-review-gen.js';
import { EXAMPLES } from '../js/model/examples.js';
import { defaultFleet, defaultStation, dist } from '../js/model/defaults.js';

const OFF = dist('const', 0);
const at = (w, x, y) => y * w.graph.cols + x;
const delivered = (w, flowId) => w.lg.flowById.get(flowId).delivered;
const total = (list) => list.reduce((a, b) => a + b, 0);

// ================================================================================================================================
// A. Fixed defects: the plant locks up, vehicles or flows are lost
// ================================================================================================================================

/**
 * Two sources A, B feed a workstation P with a bill of materials (2 x A + 1 x B per cycle) that sits at the end of a one-cell
 * spur: its only dock is a dead end. D takes the product away. Nothing exotic - this is the shape of "Two production lines +
 * warehouse" (Final assembly has exactly one dock cell at the end of a spur).
 */
function bomPlant({ vehicles, idle, depotSlots = 0, seed = 1 }) {
  const width = depotSlots > 0 ? 16 : 13;
  const row = (text, fill = '.') => text.padEnd(width, fill);
  const rows = [
    row('A.....B.....D' + (depotSlots > 0 ? '.GG' : '')),
    '+'.repeat(width),
    row('......+'), row('......+'), row('......+'),
    row('.....PPP'), row('.....PPP'),
  ];
  const stations = {
    A: { type: 'source', params: { interArrival: dist('exp', 40), outCap: 6 } },
    B: { type: 'source', params: { interArrival: dist('exp', 40), outCap: 6 } },
    D: 'sink',
    P: { type: 'process', params: { cycle: dist('exp', 30), inCap: 4, outCap: 4 } },
  };
  if (depotSlots > 0) stations.G = { type: 'depot', params: { slots: depotSlots, chargers: 0 } };
  return layoutFromAscii(rows, {
    stations,
    flows: [['A', 'P', { perCycle: 2 }], ['B', 'P', { perCycle: 1 }], ['P', 'D']],
    fleets: [{ count: vehicles, idle, speed: 1.5, loadTime: 8, unloadTime: 8, home: depotSlots > 0 ? 'G' : null }],
    settings: { seed },
  });
}

/** Demand arrives at 1 load of A and of B per 40 s each: about 90 finished units in two hours when nothing is jammed. */
function assertKeepsFlowing(layout, label) {
  const w = createRealWorld(layout, { dt: 0.2 });
  let worst = 0;
  for (let i = 0; i < 7200 / 10; i++) {
    w.run(10);
    worst = Math.max(worst, waitBehindIdle(w));
  }
  assert.ok(w.lg.completed >= 60, `${label}: only ${w.lg.completed} of about 90 units shipped in 2 h - the plant is locked up`);
  assert.ok(worst < 300, `${label}: a vehicle queued ${worst.toFixed(0)} s behind a vehicle that stands idle`);
}

test('regression: locked plant: idle vehicles that "stay" on the only dock of a station block the vehicles that carry its inputs', () => {
  // Four vehicles. One finishes a delivery and idles on P's dead-end dock; the three behind it carry the very loads P needs;
  // no demand is left for the idle one (everything is claimed by the queue), so nobody ever moves again.
  assertKeepsFlowing(bomPlant({ vehicles: 4, idle: 'stay' }), 'idle: stay');
});

test('regression: locked plant: the same happens with idle "park" when the depot has fewer places than the fleet has vehicles', () => {
  for (const seed of [1, 2]) assertKeepsFlowing(bomPlant({ vehicles: 6, idle: 'park', depotSlots: 2, seed }), `park, 2 places for 6 vehicles, seed ${seed}`);
});

test('regression: locked plant: the shipped example "Two production lines + warehouse" with every fleet on "stay" jams within a few hours', () => {
  const layout = EXAMPLES[1].build();
  for (const f of layout.fleets) f.idle = 'stay';
  const w = createRealWorld(layout, { dt: 0.2 });
  let worst = 0;
  for (let i = 0; i < 5 * 360; i++) {
    w.run(10);
    worst = Math.max(worst, waitBehindIdle(w));
  }
  assert.ok(worst < 300, `after 5 h a vehicle has been queued for ${worst.toFixed(0)} s behind an idle one; ${w.lg.completed} units shipped (about 100 expected)`);
});

test('regression: a parked vehicle cannot leave its depot while an idle "stay" vehicle of another fleet stands on the only gate cell', () => {
  // G is a depot whose only dock cell (5,1) is also the dock of the sink K. Fleet v1 (stay) delivers to K and idles right there;
  // fleet v2 (parked in G) is the only one allowed to serve flow f2, but it can neither attach nor be asked to wait.
  const layout = layoutFromAscii(['Q....G....R.', '++++++++++++', '.....K......'], {
    stations: {
      G: { type: 'depot', params: { slots: 2, chargers: 0 } }, K: 'sink',
      Q: { type: 'source', params: { interArrival: OFF } }, R: { type: 'source', params: { interArrival: OFF } },
    },
    flows: [['Q', 'K', { fleetId: 'v1' }], ['R', 'K', { fleetId: 'v2' }]],
    fleets: [{ count: 1, idle: 'stay', home: 'G' }, { count: 1, idle: 'park', home: 'G' }],
  });
  const w = createRealWorld(layout, { dt: 0.5 });
  injectLoads(w.lg, 'f1', 1);
  w.run(200);
  assert.equal(delivered(w, 'f1'), 1);
  assert.equal(w.lg.vehicles[0].state, 'idle', 'the "stay" vehicle idles on the gate cell');
  injectLoads(w.lg, 'f2', 1);
  w.run(600);
  assert.equal(delivered(w, 'f2'), 1, 'flow f2 is never served: its vehicle is shut in');
});

/**
 * A road with a source S at the west end and a one-cell side road (a spur) at x=1: a vehicle that stops on the spur blocks only the
 * spur, so the other vehicle can still reach S. (A vehicle that dies on the main road blocks its lane for good - that is spec'd
 * and no dispatch decision can drive another vehicle through it.)
 */
function spurPlant({ fleet, process = false }) {
  const rows = process ? ['S.........P.........D', '+'.repeat(21), '.+', '.+'] : ['S.........D', '+'.repeat(11), '.+', '.+'];
  const stations = process
    ? { S: { type: 'source', params: { interArrival: dist('const', 20), outCap: 4 } }, P: { type: 'process', params: { cycle: dist('const', 5), inCap: 1 } }, D: 'sink' }
    : { S: { type: 'source', params: { interArrival: OFF } }, D: 'sink' };
  return layoutFromAscii(rows, { stations, flows: process ? [['S', 'P'], ['P', 'D']] : [['S', 'D']], fleets: [fleet] });
}

test('regression: a vehicle that dies holding an order that was not picked up yet takes the flow down with it', () => {
  // Two AGVs on a battery. One runs flat on its way to the pickup. Its claim on the load and its reservation of the only free
  // input place at P used to stay for ever, so the healthy vehicle had nothing it may do - one dead vehicle halted the whole flow.
  const layout = spurPlant({ process: true, fleet: { count: 2, battery: { enabled: true, runtimeMin: 120, chargeTimeMin: 10, lowPct: 25, resumePct: 90 } } });
  const w = createRealWorld(layout, { dt: 0.5, check: true });
  const [victim, healthy] = w.lg.vehicles;
  assert.ok(w.traffic.relocate(victim.tv, at(w, 1, 2)) && w.traffic.relocate(healthy.tv, at(w, 14, 1)));
  assert.ok(w.runUntil(() => victim.order !== null && victim.state === 'toPickup', 60), 'the nearest vehicle is sent to the first load');
  victim.battery = 1e-6;
  assert.ok(w.runUntil(() => victim.state === 'dead', 60));
  const [cancelled] = w.named('orderCancelled');
  assert.equal(cancelled.vehicleId, victim.id);
  assert.equal(cancelled.reason, 'vehicle-dead');
  w.run(1500);
  assert.ok(delivered(w, 'f1') >= 3, `the healthy vehicle delivered ${delivered(w, 'f1')} loads in 25 minutes (one arrives every 20 s)`);
  assert.equal(victim.order, null);
});

test('regression: a vehicle that breaks down for hours gives back an unpicked order, so an idle vehicle can do the job', () => {
  const layout = spurPlant({ fleet: { count: 2, mtbf: 1e9, mttr: 1e7 } });
  const w = createRealWorld(layout, { dt: 0.5, check: true });
  const [first, other] = w.lg.vehicles;
  assert.ok(w.traffic.relocate(first.tv, at(w, 1, 2)) && w.traffic.relocate(other.tv, at(w, 8, 1)));
  injectLoads(w.lg, 'f1', 1);
  w.step();
  assert.ok(first.order && first.state === 'toPickup');
  first.ttf = 0; // a breakdown now, repaired in about 116 days
  w.run(600);
  assert.equal(first.state, 'broken');
  assert.equal(first.order, null, 'the order was given back');
  assert.equal(w.named('orderCancelled')[0].reason, 'vehicle-broken');
  assert.equal(delivered(w, 'f1'), 1, 'the other vehicle took over the load within ten minutes');
});

test('regression: a short breakdown keeps the order (the vehicle is back before the dispatcher gives up on it)', () => {
  const layout = spurPlant({ fleet: { count: 1, mtbf: 1e9, mttr: 10 } });
  const w = createRealWorld(layout, { dt: 0.5, check: true, seed: 3 });
  const v = w.lg.vehicles[0];
  injectLoads(w.lg, 'f1', 1);
  w.step();
  v.ttf = 0;
  w.run(300);
  assert.equal(v.breakdowns, 1);
  assert.equal(w.named('orderCancelled').length, 0);
  assert.equal(delivered(w, 'f1'), 1);
});

test('regression: an idle vehicle commits to the trip to its depot at once, so a load that appears seconds later waits for the whole round trip', () => {
  // G (depot) is 34 m away from the sink. The AGV delivers, sets off for the depot - and 3 s later the next load is ready.
  const layout = layoutFromAscii(['GGG...............S.D', '+'.repeat(21)], {
    stations: { G: { type: 'depot', params: { slots: 1, chargers: 0 } }, S: { type: 'source', params: { interArrival: OFF } }, D: 'sink' },
    flows: [['S', 'D']], fleets: [{ count: 1, home: 'G', loadTime: 2, unloadTime: 2 }],
  });
  const w = createWorld(layout, { dt: 0.1, check: true });
  injectLoads(w.lg, 'f1', 1);
  assert.ok(w.runUntil(() => w.named('orderDelivered').length === 1, 600));
  w.run(3);
  const readyAt = w.t;
  injectLoads(w.lg, 'f1', 1, { createdAt: readyAt, readyAt });
  assert.ok(w.runUntil(() => w.named('orderAssigned').length === 2, 600));
  const wait = w.named('orderAssigned')[1].t - readyAt;
  assert.ok(wait <= 10, `the load waited ${wait.toFixed(1)} s for an assignment (the vehicle was driving to the depot)`);
});

test('regression: a low vehicle that parks in a depot without chargers is out of service for ever although a charger depot exists', () => {
  // H (home) has no chargers, C has one. The AGV leaves a delivery with just over the low threshold, decides to park at home and
  // drops below the threshold on the way. In H it is "low" - so it is never given work - but H cannot charge it either.
  const layout = layoutFromAscii(['HHH...S.....D.....CCC', '+++++++++++++++++++++'], {
    stations: {
      H: { type: 'depot', params: { slots: 2, chargers: 0 } }, C: { type: 'depot', params: { slots: 2, chargers: 1 } },
      S: { type: 'source', params: { interArrival: dist('const', 5000), startDelay: 30 } }, D: 'sink',
    },
    flows: [['S', 'D']],
    fleets: [{ count: 1, home: 'H', battery: { enabled: true, runtimeMin: 5, chargeTimeMin: 5, lowPct: 50, resumePct: 90 } }],
  });
  const w = createRealWorld(layout, { dt: 0.5, check: true });
  const v = w.lg.vehicles[0];
  let tweaked = false;
  w.runUntil(() => {
    if (!tweaked && v.state === 'unloading') { v.battery = 0.5 + v.timer / 300 + 0.001; tweaked = true; } // 50.1 % when it finishes
    return false;
  }, 120);
  assert.ok(tweaked && delivered(w, 'f1') === 1);
  w.run(600);
  assert.ok(v.timeIn.charging > 0, `it never charged (state ${v.state}, battery ${v.battery.toFixed(2)})`);
  injectLoads(w.lg, 'f1', 1);
  w.run(300);
  assert.equal(delivered(w, 'f1'), 2, 'back in service: the next load is delivered');
});

test('regression: docks are chosen by distance only: a one-way dead-end dock next to a station swallows a vehicle that had a good dock', () => {
  // Station D has a trap cell on its left (7,1): the road leads in, nothing leads out (validateLayout warns "one-way-dead-end").
  // The vehicle unloads there, because that dock is the nearest, and is lost for ever; the remaining loads are never moved.
  const layout = layoutFromAscii(['SS......DD..', 'SS.....^DD..', '++++++++++++'], {
    stations: { S: { type: 'source', params: { interArrival: OFF } }, D: 'sink' }, flows: [['S', 'D']], fleets: [{ count: 1 }],
  });
  const w = createRealWorld(layout, { dt: 0.5, check: true });
  assert.ok(w.traffic.relocate(w.lg.vehicles[0].tv, at(w, 2, 2)));
  injectLoads(w.lg, 'f1', 3);
  w.run(900);
  assert.equal(delivered(w, 'f1'), 3, 'the vehicle must use a dock it can get away from');
});

test('regression: docks are chosen by distance only: the nearest pickup dock may be a trap, then the flow is not served from some positions', () => {
  const layout = layoutFromAscii(['..SS........', '.^SS...D....', '++++++++++++'], {
    stations: { S: { type: 'source', params: { interArrival: OFF } }, D: 'sink' }, flows: [['S', 'D']], fleets: [{ count: 1 }],
  });
  const w = createRealWorld(layout, { dt: 0.5 });
  assert.ok(w.traffic.relocate(w.lg.vehicles[0].tv, at(w, 0, 2)));
  injectLoads(w.lg, 'f1', 1);
  w.run(300);
  assert.equal(delivered(w, 'f1'), 1, 'a load is ready, the dock (2,2) is two cells away, yet nothing is assigned');
});

test('regression: a load whose dwell has just ended (or whose maxWait has just run out) is only picked up at the next 0.5 s poll', () => {
  const lags = [];
  for (const readyAt of [5.0, 5.03, 5.12, 5.31, 5.49]) {
    const layout = layoutFromAscii(['W....K', '++++++'], {
      stations: { W: { type: 'storage', params: { capacity: 5, dwell: 10 } }, K: 'sink' }, flows: [['W', 'K']], fleets: [{ count: 1, idle: 'stay' }],
    });
    const w = createWorld(layout, { dt: 0.1 });
    w.step(3);
    injectLoads(w.lg, 'f1', 1, { createdAt: 0, readyAt });
    w.lg.nextDispatch = w.lg.now;
    let assignedAt = null;
    for (let i = 0; i < 100 && assignedAt === null; i++) {
      w.step();
      const orders = w.named('orderAssigned');
      if (orders.length > 0) assignedAt = orders[0].t;
    }
    lags.push(assignedAt - readyAt);
  }
  assert.ok(Math.max(...lags) <= 0.1 + 1e-9, `lag between "ready" and "assigned" (s): ${lags.map((l) => l.toFixed(2)).join(', ')}`);
});

// ================================================================================================================================
// B. Hostile configurations: conservation, capacities, no crash, no spin
// ================================================================================================================================

/** S .... P .... D on one road; `proc` / `src` override the workstation / source params, `extra` the stations or the fleets. */
function lineOf({ proc = {}, src = {}, flowP = {}, flowQ = {}, fleets = [{ count: 2 }], noSource = false, settings } = {}) {
  const rows = [noSource ? 'P......D' : 'S......P......D', '+'.repeat(noSource ? 8 : 15)];
  const stations = { P: { type: 'process', params: proc }, D: 'sink' };
  if (!noSource) stations.S = { type: 'source', params: { interArrival: dist('const', 10), ...src } };
  return layoutFromAscii(rows, { stations, flows: noSource ? [['P', 'D', flowQ]] : [['S', 'P', flowP], ['P', 'D', flowQ]], fleets, settings });
}

const HOSTILE = {
  'perCycle above inCap': lineOf({ proc: { cycle: dist('const', 5), inCap: 2 }, flowP: { perCycle: 3 } }),
  'no machines': lineOf({ proc: { machines: 0 } }),
  'five machines': lineOf({ proc: { machines: 5, cycle: dist('const', 30) } }),
  'three outputs into one place': lineOf({ proc: { outPerCycle: 3, outCap: 1, cycle: dist('const', 5) } }),
  'zero-length cycle': lineOf({ proc: { cycle: dist('const', 0) } }),
  'zero-length cycle, no way out': layoutFromAscii(['S......P', '++++++++'], {
    stations: { S: { type: 'source', params: { interArrival: dist('const', 10) } }, P: { type: 'process', params: { cycle: dist('const', 0) } } },
    flows: [['S', 'P']], fleets: [{ count: 1 }],
  }),
  'breakdowns every 10 ms': lineOf({ proc: { cycle: dist('const', 5), mtbf: 0.01, mttr: 0.01 } }),
  'breakdowns never, repairs for ever': lineOf({ proc: { cycle: dist('const', 5), mtbf: 1e12, mttr: 1e12 } }),
  'breaks at once, repaired never': lineOf({ proc: { cycle: dist('const', 5), mtbf: 0.001, mttr: 1e12 } }),
  'batches of 50': lineOf({ src: { batch: 50 } }),
  'no vehicles': lineOf({ fleets: [{ count: 0 }] }),
  'a hundred vehicles on fifteen cells': lineOf({ fleets: [{ count: 100 }] }),
  'junk parameters': lineOf({ proc: { cycle: { kind: 'zzz', mean: NaN, spread: NaN }, inCap: NaN, outCap: -3, machines: 'x', outPerCycle: NaN }, src: { batch: NaN, outCap: NaN, interArrival: null } }),
  'batchMin far above batchMax': lineOf({ flowP: { batchMin: 50, batchMax: 1 }, flowQ: { batchMin: 50 } }),
  'vehicles that carry nothing, run nowhere': lineOf({ fleets: [{ count: 2, capacity: 0, speed: 0, accel: 0, decel: 0, length: 0, loadTime: -5, unloadTime: NaN }] }),
};

function assertSane(w, label) {
  const bad = [];
  for (const st of w.lg.stations) {
    for (const k of ['fill', 'inCount', 'outCount', 'produced', 'consumed', 'arrivals']) if (!Number.isFinite(st[k])) bad.push(`${st.id}.${k}=${st[k]}`);
    for (const m of st.machines || []) for (const k of ['remaining', 'cycleTime', 'progress']) if (!Number.isFinite(m[k])) bad.push(`${st.id}.machine.${k}=${m[k]}`);
  }
  for (const v of w.lg.vehicles) for (const k of ['battery', 'x', 'y', 'heading', 'loadedDistance', 'emptyDistance']) if (!Number.isFinite(v[k])) bad.push(`${v.id}.${k}=${v[k]}`);
  assert.deepEqual(bad, [], `${label}: non-finite values`);
}

for (const [name, layout] of Object.entries(HOSTILE)) {
  test(`hostile config on the stub: ${name} - invariants hold every tick, nothing is NaN, no hang`, () => {
    const w = createWorld(layout, { dt: 0.25, check: true });
    w.run(900);
    assertSane(w, name);
  });
}

test('hostile configs on the real traffic engine: the same plants stay consistent', () => {
  for (const name of ['perCycle above inCap', 'three outputs into one place', 'breakdowns every 10 ms', 'batches of 50', 'a hundred vehicles on fifteen cells', 'junk parameters']) {
    const w = createRealWorld(HOSTILE[name], { dt: 0.25 });
    runChecked(w, 600, 4);
    assertSane(w, name);
  }
});

test('perCycle above inCap: the workstation never starts, the buffer never overfills, the source backs up - and the run ends', () => {
  const w = createWorld(HOSTILE['perCycle above inCap'], { dt: 0.25, check: true });
  w.run(1200);
  const p = w.lg.stationById.get('P');
  assert.equal(p.produced, 0);
  assert.equal(p.machines[0].state, 'idle');
  assert.equal(p.state, 'starved');
  assert.ok(p.inCount <= 2);
  assert.equal(w.lg.completed, 0);
  assert.equal(w.lg.stationById.get('S').state, 'blocked');
  assert.equal(w.lg.liveLoads, w.lg.createdBySources, 'every load is still somewhere');
});

test('machines: 0 reports "down" and passes nothing, 5 run exactly five times the single rate', () => {
  const none = createWorld(HOSTILE['no machines'], { dt: 0.25, check: true });
  none.run(300);
  assert.equal(none.lg.stationById.get('P').state, 'down');
  assert.equal(none.lg.stationById.get('P').produced, 0);
  const five = createWorld(lineOf({ noSource: true, proc: { machines: 5, cycle: dist('const', 10), outCap: 1000 }, fleets: [{ count: 0 }] }), { dt: 0.25, check: true });
  five.run(1005); // cycles end at 10, 20 ... 1000
  assert.equal(five.lg.stationById.get('P').produced, 500);
  assert.equal(five.lg.stationById.get('P').state, 'busy');
});

test('three outputs per cycle into one output place: held loads never exceed one cycle, every load is accounted for', () => {
  const w = createWorld(HOSTILE['three outputs into one place'], { dt: 0.25, check: true });
  w.run(1200);
  const p = w.lg.stationById.get('P');
  assert.equal(p.produced % 3, 0);
  assert.ok(p.machines[0].holding.length <= 3);
  assert.ok(p.outCount <= 1);
  assert.ok(w.lg.completed > 0, 'the product still reaches the sink');
});

test('weights split the output exactly (smooth weighted round robin): 0:1:3 and a station with ten flows', () => {
  const split = (letters, weights, batch) => {
    const layout = layoutFromAscii(['A' + letters, '+'.repeat(letters.length + 1)], {
      stations: { A: { type: 'source', params: { interArrival: dist('const', 1e6), batch, outCap: 1000 } }, ...Object.fromEntries([...letters].map((l) => [l, 'sink'])) },
      flows: [...letters].map((l, i) => ['A', l, { weight: weights[i] }]), fleets: [{ count: 0 }],
    });
    const w = createWorld(layout, { dt: 0.5, check: true });
    w.step();
    return w.lg.flows.map((f) => f.outLink.queue.length);
  };
  assert.deepEqual(split('BCD', [0, 1, 3], 400), [0, 100, 300]);
  assert.deepEqual(split('BCDEFGHIJK', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 550), [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
});

test('breakdowns: none when the mean time between failures is astronomically large, many when it is tiny; state always valid', () => {
  const huge = createWorld(HOSTILE['breakdowns never, repairs for ever'], { dt: 0.25 });
  huge.run(900);
  assert.equal(huge.lg.stationById.get('P').breakdowns, 0);
  const tiny = createWorld(HOSTILE['breakdowns every 10 ms'], { dt: 0.25 });
  tiny.run(900);
  assert.ok(tiny.lg.stationById.get('P').breakdowns > 100);
  assert.ok(['busy', 'idle', 'starved', 'blocked', 'down'].includes(tiny.lg.stationById.get('P').state));
});

test('batch of 50 with nowhere to go: the yard holds exactly what the output place cannot, memory grows only with the arrivals', () => {
  const layout = lineOf({ src: { batch: 50, interArrival: dist('const', 100), outCap: 6 }, fleets: [{ count: 0 }] });
  const w = createWorld(layout, { dt: 0.5, check: true });
  w.run(250); // arrivals at 0, 100, 200
  const s = w.lg.stationById.get('S');
  assert.equal(s.produced, 150);
  assert.equal(s.arrivals, 3);
  assert.equal(s.yard, 144);
  assert.equal(w.lg.liveLoads, 150);
});

test('a vehicle of capacity 0 is a vehicle of capacity 1, and fleets of 0 and 100 are fine', () => {
  const w = createWorld(HOSTILE['vehicles that carry nothing, run nowhere'], { dt: 0.25, check: true });
  w.run(600);
  assert.ok(w.events.filter((e) => e.name === 'orderAssigned').every((e) => e.payload.order.qty === 1));
  const none = createWorld(HOSTILE['no vehicles'], { dt: 0.25, check: true });
  none.run(300);
  assert.equal(none.lg.vehicles.length, 0);
  assert.equal(none.lg.completed, 0);
  const many = createWorld(HOSTILE['a hundred vehicles on fifteen cells'], { dt: 0.25, check: true });
  assert.equal(many.lg.vehicles.length + many.lg.unplaced.length, 100);
  assert.ok(many.lg.vehicles.length <= 15, 'one per road cell at most');
});

test('a destination storage that is full for ever, and a storage with no outflow: no overflow, no lost load, upstream backs up', () => {
  const layout = layoutFromAscii(['S.....W.....D', '+++++++++++++'], {
    stations: { S: { type: 'source', params: { interArrival: dist('const', 10), outCap: 6 } }, W: { type: 'storage', params: { capacity: 3, dwell: 5 } }, D: 'sink' },
    flows: [['S', 'W']], fleets: [{ count: 2 }],
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  w.run(1500);
  const st = w.lg.stationById.get('W');
  assert.equal(st.outCount, 3);
  assert.equal(st.state, 'full');
  assert.equal(st.inboundTotal, 0, 'no reservation is left hanging once the vehicles are idle');
  assert.equal(w.lg.liveLoads, w.lg.createdBySources);
  assert.ok(w.lg.stationById.get('S').yard > 0);
});

test('circular flows (storage to storage and back) conserve loads and respect both capacities', () => {
  const layout = layoutFromAscii(['S....W....X....D', '++++++++++++++++'], {
    stations: {
      S: { type: 'source', params: { interArrival: dist('const', 8), outCap: 4 } },
      W: { type: 'storage', params: { capacity: 4, dwell: 2 } }, X: { type: 'storage', params: { capacity: 3, dwell: 2 } }, D: 'sink',
    },
    flows: [['S', 'W'], ['W', 'X'], ['X', 'W', { weight: 3 }], ['X', 'D']], fleets: [{ count: 3 }],
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  w.run(2400);
  assert.ok(w.lg.completed > 0 || w.lg.stationById.get('W').state === 'full', 'either goods leave or the loop is legitimately full');
});

// ================================================================================================================================
// C. Dispatch: races, batches
// ================================================================================================================================

test('three vehicles race for one load: exactly one order, one claim, the others stay idle', () => {
  const layout = layoutFromAscii(['L.......S.......R', '+++++++++++++++++'], {
    stations: { L: 'sink', S: { type: 'source', params: { interArrival: OFF } }, R: 'sink' }, flows: [['S', 'L']], fleets: [{ count: 3, idle: 'stay' }],
  });
  const w = createWorld(layout, { dt: 0.5, check: true });
  [2, 14, 11].forEach((x, i) => assert.ok(w.traffic.relocate(w.lg.vehicles[i].tv, at(w, x, 1))));
  injectLoads(w.lg, 'f1', 1);
  w.step();
  assert.equal(w.lg.activeOrders.size, 1);
  assert.equal(w.lg.vehicles.filter((v) => v.state === 'toPickup').length, 1);
  assert.equal(w.lg.vehicles.filter((v) => v.state === 'idle').length, 2);
  assert.equal(w.lg.flowById.get('f1').outLink.claimed, 1);
  w.run(120);
  assert.equal(delivered(w, 'f1'), 1);
});

test('maxWait: a partial batch leaves when the oldest load has waited maxWait, never earlier; with maxWait 0 it waits for batchMin', () => {
  const run = (maxWait) => {
    const layout = layoutFromAscii(['S....D', '++++++'], {
      stations: { S: { type: 'source', params: { interArrival: OFF } }, D: 'sink' },
      flows: [['S', 'D', { batchMin: 4, maxWait }]], fleets: [{ count: 1, preset: 'tugger', idle: 'stay' }],
    });
    const w = createWorld(layout, { dt: 0.1, check: true });
    w.run(10);
    injectLoads(w.lg, 'f1', 2, { createdAt: 10, readyAt: 10 });
    w.run(300);
    return w;
  };
  const timed = run(60);
  const order = timed.named('orderAssigned')[0];
  assert.equal(order.order.qty, 2, 'both waiting loads travel together');
  assert.ok(order.t >= 70 - 1e-6 && order.t <= 70.6, `released at ${order.t}, expected 70 (10 + maxWait) within one dispatch poll`);
  assert.equal(run(0).named('orderAssigned').length, 0, 'maxWait 0 = wait for batchMin without a time limit');
  const two = run(0);
  injectLoads(two.lg, 'f1', 2, { createdAt: two.t, readyAt: two.t });
  two.run(5);
  assert.equal(two.named('orderAssigned')[0].order.qty, 4, 'the batch leaves as soon as it is complete');
});

test('dwell: a load that entered a storage is not offered to a vehicle before its dwell time is over', () => {
  const layout = layoutFromAscii(['S....W....D', '+++++++++++'], {
    stations: { S: { type: 'source', params: { interArrival: dist('const', 1000), startDelay: 5 } }, W: { type: 'storage', params: { capacity: 4, dwell: 30 } }, D: 'sink' },
    flows: [['S', 'W'], ['W', 'D']], fleets: [{ count: 1, idle: 'stay' }],
  });
  const w = createWorld(layout, { dt: 0.1, check: true });
  w.run(200);
  const stored = w.named('orderDelivered').find((p) => p.order.flowId === 'f1').t;
  const leaves = w.named('orderAssigned').find((p) => p.order.flowId === 'f2').t;
  assert.ok(leaves >= stored + 30 - 1e-6 && leaves < stored + 31, `stored at ${stored}, offered to a vehicle at ${leaves}`);
});

test('contract with the traffic engine: drive() always gets a route of at least one edge for a stopped vehicle standing at its first node, never a U-turn on the spot', () => {
  const seen = { drive: 0, bad: [] };
  const plants = [EXAMPLES[1].build(), ...[3, 5, 9, 12, 21, 30].map((seed) => hostilePlant(seed))];
  for (const layout of plants) {
    const w = createRealWorld(layout, { dt: 0.25 });
    const { traffic, graph } = w;
    const drive = traffic.drive.bind(traffic);
    traffic.drive = (tv, route) => {
      seen.drive++;
      if (!route || route.edges.length === 0) seen.bad.push('empty route');
      else if (tv.driving || !tv.onRoad || tv.node !== route.nodes[0]) seen.bad.push(`${tv.id} is not stopped at the route start`);
      else if (tv.lastEdge >= 0 && graph.edges[tv.lastEdge].to === tv.node && graph.edges[tv.lastEdge].rev === route.edges[0] && graph.out[tv.node].length > 1) seen.bad.push(`${tv.id} turns on the spot`);
      const started = drive(tv, route);
      if (!started) seen.bad.push(`${tv.id}: drive() refused the route`);
      return started;
    };
    w.run(600);
  }
  assert.deepEqual(seen.bad, []);
  assert.ok(seen.drive > 50, `${seen.drive} drive calls observed`);
});

// ================================================================================================================================
// D. Vehicles: batteries, depots
// ================================================================================================================================

test('lowPct 100 with chargers: the vehicle works between charges for ever and ends up neither dead nor stuck', () => {
  const layout = layoutFromAscii(['P..S.....D', '+++++++++++'], {
    stations: { P: { type: 'depot', params: { slots: 1, chargers: 1 } }, S: { type: 'source', params: { interArrival: dist('const', 40) } }, D: 'sink' },
    flows: [['S', 'D']],
    fleets: [{ count: 1, home: 'P', loadTime: 2, unloadTime: 2, battery: { enabled: true, runtimeMin: 10, chargeTimeMin: 2, lowPct: 100, resumePct: 100 } }],
  });
  const w = createRealWorld(layout, { dt: 0.25 });
  runChecked(w, 2400, 4);
  const v = w.lg.vehicles[0];
  assert.notEqual(v.state, 'dead');
  assert.ok(v.timeIn.charging > 0);
  assert.ok(delivered(w, 'f1') >= 30, `${delivered(w, 'f1')} of 60 loads delivered`);
});

test('three vehicles share one charger: everyone charges in turn, nobody runs flat, the reservations never exceed the chargers', () => {
  const layout = layoutFromAscii(['GGG..S.......D', '+'.repeat(14)], {
    stations: { G: { type: 'depot', params: { slots: 3, chargers: 1 } }, S: { type: 'source', params: { interArrival: dist('exp', 40) } }, D: 'sink' },
    flows: [['S', 'D']],
    fleets: [{ count: 3, home: 'G', loadTime: 5, unloadTime: 5, battery: { enabled: true, runtimeMin: 8, chargeTimeMin: 6, lowPct: 60, resumePct: 90 } }],
  });
  const w = createRealWorld(layout, { dt: 0.25 });
  runChecked(w, 7200, 4);
  assert.ok(w.lg.vehicles.every((v) => v.state !== 'dead'), 'nobody ran flat');
  assert.ok(w.lg.vehicles.every((v) => v.timeIn.charging > 600), 'everybody got charged');
  assert.ok(w.lg.completed >= 120, `${w.lg.completed} of about 180 loads delivered`);
});

test('a vehicle that runs flat on the way to the charger gives its reserved place and charger back', () => {
  const layout = layoutFromAscii(['P....S.....D', '++++++++++++'], {
    stations: { P: { type: 'depot', params: { slots: 1, chargers: 1 } }, S: { type: 'source', params: { interArrival: dist('const', 3000) } }, D: 'sink' },
    flows: [['S', 'D']], fleets: [{ count: 1, home: 'P', battery: { enabled: true, runtimeMin: 5, chargeTimeMin: 5, lowPct: 50, resumePct: 90 } }],
  });
  const w = createRealWorld(layout, { dt: 0.25, check: true });
  const v = w.lg.vehicles[0];
  assert.ok(w.runUntil(() => v.state === 'unloading', 300));
  v.battery = 0.4; // below the threshold when it is done: next stop is the charger
  assert.ok(w.runUntil(() => v.state === 'toCharger', 60));
  const depot = w.lg.stationById.get('P');
  assert.equal(depot.reservedChargers, 1);
  v.battery = 1e-6;
  assert.ok(w.runUntil(() => v.state === 'dead', 30));
  assert.equal(depot.reservedSlots, 0);
  assert.equal(depot.reservedChargers, 0);
});

test('a full home depot sends the surplus vehicle to another depot', () => {
  const layout = layoutFromAscii(['H..G.....S....D', '+++++++++++++++'], {
    stations: {
      H: { type: 'depot', params: { slots: 1, chargers: 0 } }, G: { type: 'depot', params: { slots: 3, chargers: 0 } },
      S: { type: 'source', params: { interArrival: dist('const', 200), startDelay: 20 } }, D: 'sink',
    },
    flows: [['S', 'D']], fleets: [{ count: 3, home: 'H', loadTime: 2, unloadTime: 2 }],
  });
  const w = createRealWorld(layout, { dt: 0.25 });
  runChecked(w, 600, 4);
  const where = w.lg.vehicles.map((v) => (v.state === 'parked' ? v.depot.id : v.state));
  assert.equal(w.lg.stationById.get('H').parked.length <= 1, true);
  assert.ok(where.filter((x) => x === 'H' || x === 'G').length >= 2, `vehicles: ${where.join(', ')}`);
});

test('after a deadlock relocation on the real engine the vehicle plans its leg again and the order completes, in every phase it can be caught', () => {
  for (const phase of ['toPickup', 'toDrop']) {
    for (const resolved of [true, false]) {
      const layout = layoutFromAscii(['S.........D', '+++++++++++'], {
        stations: { S: { type: 'source', params: { interArrival: OFF } }, D: 'sink' }, flows: [['S', 'D']], fleets: [{ count: 1, idle: 'stay' }],
      });
      const w = createRealWorld(layout, { dt: 0.1, check: true });
      const v = w.lg.vehicles[0];
      injectLoads(w.lg, 'f1', 1);
      assert.ok(w.runUntil(() => v.state === phase && v.tv.driving, 200));
      w.run(3);
      const free = w.graph.nodes.find((n) => w.graph.cx(n) === 5 && n !== v.tv.node);
      assert.ok(w.traffic.relocate(v.tv, free));
      w.lg.handleDeadlock({ victim: v.tv, resolved, vehicles: [v.tv], nodes: [free] });
      w.run(300);
      assert.equal(delivered(w, 'f1'), 1, `relocated while ${phase} (resolved: ${resolved})`);
      assert.equal(v.state, 'idle');
    }
  }
});

// ================================================================================================================================
// E. Determinism (real engine)
// ================================================================================================================================

test('determinism: same seed, same event log; another seed, another log; unrelated additions leave a source and a machine alone', () => {
  const build = () => bomPlant({ vehicles: 3, idle: 'park', depotSlots: 3, seed: 7 });
  const log = (layout, opts) => {
    const w = createRealWorld(layout, { dt: 0.2, ...opts });
    w.run(1500);
    return w;
  };
  const a = log(build());
  assert.equal(eventDigest(log(build()).events), eventDigest(a.events));
  assert.notEqual(eventDigest(log(build(), { seed: 8 }).events), eventDigest(a.events));
  const bigger = build();
  bigger.stations.unshift(defaultStation('source', { id: 'Z', x: 0, y: 12, w: 1, h: 1, params: { interArrival: dist('exp', 25) } }));
  bigger.fleets.push(defaultFleet('forklift', { id: 'vz', count: 1 }));
  const b = log(bigger);
  const arrivals = (w) => w.named('loadCreated').filter((p) => p.stationId === 'A').map((p) => p.load.createdAt);
  assert.deepEqual(arrivals(b), arrivals(a), 'source A draws the same arrival times');
  assert.ok(arrivals(a).length > 20);
});

// ================================================================================================================================
// F. The numbers, by hand (stub traffic: constant speed, exact travel times)
// ================================================================================================================================

test('S -> P -> D, one AGV: every event time, lead time, pickup wait and transit time equals the hand calculation', () => {
  // Cells are 2 m, the AGV drives 1.5 m/s, loads and unloads take 12 s, P cycles 30 s, dt = 0.25 s.
  // The AGV stands at x=6 (cell 6). The first load appears at t=10 at x=0: 12 m = 8 s -> loading 18..30 -> 10 m = 6.667 s, rounded up
  // to 6.75 s by the tick -> unloading 36.75..48.75 -> P cycles 48.75..78.75 -> the AGV waits on P's dock, loads 78.75..90.75 ->
  // 6.75 s -> unloads 97.5..109.5.
  const layout = layoutFromAscii(['S....P....D', '+++++++++++'], {
    stations: { S: { type: 'source', params: { interArrival: dist('const', 1000), startDelay: 10 } }, P: { type: 'process', params: { cycle: dist('const', 30) } }, D: 'sink' },
    flows: [['S', 'P'], ['P', 'D']], fleets: [{ count: 1 }],
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  w.run(130);
  const times = (name) => w.named(name).map((p) => p.t);
  assert.deepEqual(w.named('loadCreated').map((p) => [p.stationId, p.t]), [['S', 10], ['P', 78.75]]);
  assert.deepEqual(times('orderAssigned'), [10, 78.75]);
  assert.deepEqual(times('orderPickedUp'), [30, 90.75]);
  assert.deepEqual(w.named('orderDelivered').map((p) => [p.t, p.waitForPickup, p.transit]), [[48.75, 20, 18.75], [109.5, 12, 18.75]]);
  const done = w.named('loadCompleted')[0];
  assert.equal(done.t, 109.5);
  assert.equal(done.leadTime, 99.5, 'end to end: from the arrival at S (10) to the sink (109.5)');
  assert.equal(done.load.createdAt, 10, 'the product inherits the creation time of its input');
});

test('throughput does not depend on the time step: machines and sources produce floor(T / interval) whatever dt is', () => {
  for (const dt of [0.05, 0.1, 0.25, 0.5]) {
    const machine = createWorld(lineOf({ noSource: true, proc: { machines: 3, cycle: dist('const', 7.3), outCap: 1000 }, fleets: [{ count: 0 }] }), { dt });
    machine.run(1000);
    assert.equal(machine.lg.stationById.get('P').produced, 3 * Math.floor(1000 / 7.3), `machine, dt ${dt}`);
    const source = createWorld(lineOf({ src: { interArrival: dist('const', 7.3), outCap: 1000 }, fleets: [{ count: 0 }] }), { dt });
    source.run(1000);
    assert.equal(source.lg.stationById.get('S').arrivals, 1 + Math.floor(1000 / 7.3), `source, dt ${dt}`);
  }
});

test('a bill of materials takes perCycle loads from each flow and the product is as old as the OLDEST input', () => {
  const layout = layoutFromAscii(['A.B.PPP.D', '+++++++++'], {
    stations: {
      A: { type: 'source', params: { interArrival: OFF } }, B: { type: 'source', params: { interArrival: OFF } },
      P: { type: 'process', params: { cycle: dist('const', 20), inCap: 4, outPerCycle: 2 } }, D: 'sink',
    },
    flows: [['A', 'P', { perCycle: 2 }], ['B', 'P', { perCycle: 1 }], ['P', 'D']], fleets: [{ count: 0 }],
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  injectLoads(w.lg, 'f1', 2, { side: 'in', createdAt: 5, readyAt: 5 });
  injectLoads(w.lg, 'f2', 1, { side: 'in', createdAt: 1, readyAt: 1 });
  w.run(25);
  const p = w.lg.stationById.get('P');
  assert.equal(p.consumed, 3);
  assert.equal(p.produced, 2);
  assert.deepEqual(p.machines[0].holding.map((l) => l.createdAt).concat(p.outQ.get('f3').map((l) => l.createdAt)), [1, 1]);
  assert.equal(w.lg.liveLoads, 2, 'three inputs retired, two products created');
});

// ================================================================================================================================
// G. Hand-over: what stats.js and the renderer read
// ================================================================================================================================

const VEHICLE_STATES = ['idle', 'parked', 'toPickup', 'loading', 'toDrop', 'unloading', 'toCharger', 'charging', 'toPark', 'broken', 'dead'];
const MACHINE_STATES = ['idle', 'busy', 'blocked', 'down'];
const isCount = (n) => Number.isInteger(n) && n >= 0;

test('hand-over: StationRT, VehicleRT and FlowRT carry the documented fields, types and units while a real plant runs', () => {
  const layout = EXAMPLES[1].build();
  layout.fleets[1].mtbf = 600;
  layout.fleets[1].mttr = 60;
  const w = createRealWorld(layout, { dt: 0.2 });
  w.run(1800);
  const lg = w.lg;
  assert.equal(lg.stations.length, layout.stations.length);
  for (const st of lg.stations) {
    assert.equal(lg.stationById.get(st.id), st);
    assert.ok(['normal', 'blocked', 'busy', 'starved', 'down', 'full'].includes(st.state), `${st.id} state ${st.state}`);
    assert.ok(st.fill >= 0 && st.fill <= 1, `${st.id} fill ${st.fill}`);
    assert.equal(typeof st.fillLabel, 'string');
    for (const key of ['inCount', 'outCount', 'produced', 'consumed', 'arrivals']) assert.ok(isCount(st[key]), `${st.id}.${key} = ${st[key]}`);
    for (const key of ['inQ', 'outQ', 'inbound']) assert.ok(st[key] instanceof Map, `${st.id}.${key} is a Map`);
    if (st.type === 'source') assert.ok(isCount(st.yard));
    if (st.type === 'process') {
      for (const m of st.machines) {
        assert.ok(MACHINE_STATES.includes(m.state));
        assert.ok(m.progress >= 0 && m.progress <= 1 && Number.isFinite(m.remaining) && Number.isFinite(m.cycleTime));
        assert.ok(Array.isArray(m.holding));
      }
    }
    if (st.type === 'depot') {
      assert.ok(isCount(st.slots) && isCount(st.chargers) && st.chargers <= st.slots);
      for (const v of [...st.parked, ...st.charging]) assert.equal(v.visible, false);
      assert.ok(st.parked.length + st.charging.length <= st.slots);
    }
  }
  const elapsed = w.t;
  for (const v of lg.vehicles) {
    assert.match(v.id, /^v[12]#\d+$/);
    assert.equal(v.fleet.id, v.fleetId);
    assert.equal(typeof v.name, 'string');
    assert.match(v.color, /^#[0-9a-f]{6}$/i);
    assert.ok(VEHICLE_STATES.includes(v.state));
    assert.ok(Array.isArray(v.load));
    assert.ok(v.battery >= 0 && v.battery <= 1);
    assert.equal(v.visible, v.tv.onRoad);
    assert.ok(v.stateSince >= 0 && v.stateSince <= elapsed);
    for (const key of ['x', 'y', 'heading', 'prevX', 'prevY', 'prevHeading']) assert.ok(Number.isFinite(v[key]), `${v.id}.${key}`);
    assert.deepEqual(Object.keys(v.timeIn).sort(), [...VEHICLE_STATES].sort());
    assert.ok(Math.abs(total(Object.values(v.timeIn)) - elapsed) < 1e-6, `${v.id}: time in states ${total(Object.values(v.timeIn))} vs ${elapsed}`);
    assert.ok(isCount(v.trips));
    assert.ok(Math.abs(v.loadedDistance + v.emptyDistance + v.parkDistance - v.tv.odometer) <= v.fleet.speed * 0.2 + 1e-6, `${v.id}: loaded + empty + depot trips add up to the odometer`);
    if (v.order) for (const key of ['id', 'flowId', 'from', 'to', 'qty', 'vehicleId', 'loads', 'createdAt', 'readySince', 'pickedAt', 'deliveredAt']) assert.ok(key in v.order, `order.${key}`);
  }
  assert.equal(total(lg.flows.map((f) => f.delivered)), total(w.named('orderDelivered').map((p) => p.order.qty)));
  for (const f of lg.flows) assert.ok(isCount(f.delivered) && isCount(f.trips) && typeof f.id === 'string');
});

test('hand-over: a live Stats on a real plant agrees with the counters of the logistics layer', () => {
  const run = (layout, seconds) => {
    const w = createRealWorld(layout, { dt: 0.2, stats: true });
    w.run(seconds);
    return { w, report: w.stats.report() };
  };
  const plants = [...EXAMPLES.map((ex) => ex.build()), hostilePlant(5), hostilePlant(12)];
  for (const layout of plants) {
    const { w, report } = run(layout, 900);
    const lg = w.lg;
    assert.equal(report.throughput.total, lg.completed);
    assert.equal(report.leadTime.count, lg.completed);
    assert.equal(report.orders.completed, lg.ordersDelivered);
    assert.equal(report.wip.now, lg.liveLoads);
    for (const f of lg.flows) assert.equal(report.flows[f.id].delivered, f.delivered);
    for (const st of lg.stations) {
      assert.equal(report.stations[st.id].produced, st.produced);
      assert.equal(report.stations[st.id].consumed, st.consumed);
    }
    for (const fleet of Object.values(report.fleets)) assert.ok(Math.abs(total(Object.values(fleet.shares)) - 1) < 1e-6);
    assert.doesNotMatch(JSON.stringify(report), /null.*NaN|NaN/);
  }
});

test('the shipped examples run for 90 minutes on the real engine with every invariant intact and goods leaving', () => {
  // 90 minutes, not an hour: a pipeline ships late (twin-plants: the first load leaves at minute 84, docs/EXAMPLES-DESIGN.md 3.3 rule 5 and 8.5)
  for (const ex of EXAMPLES) {
    const w = createRealWorld(ex.build(), { dt: 0.2 });
    runChecked(w, 5400, 10);
    assert.ok(w.lg.completed > 0, `${ex.name}: nothing was shipped`);
    assert.equal(w.lg.unplaced.length, 0, `${ex.name}: every vehicle found a place`);
  }
});

// ================================================================================================================================
// H. Random hostile plants on both engines
// ================================================================================================================================

test('random hostile plants (one-way lines, zero weights, batches, breakdowns, flat batteries): invariants hold on the stub', () => {
  for (let seed = 1; seed <= 8; seed++) {
    const w = createWorld(hostilePlant(seed), { dt: 0.25, check: true });
    w.run(300);
    assertSane(w, `hostile plant ${seed}`);
  }
});

test('random hostile plants on the real engine: invariants hold, nothing is NaN, no exception', () => {
  for (const seed of [2, 9, 17, 23, 36]) {
    const w = createRealWorld(hostilePlant(seed), { dt: 0.25 });
    runChecked(w, 300, 4);
    assertSane(w, `hostile plant ${seed}`);
  }
});

test('cross-module: vehicle footprints never overlap while the logistics layer drives hostile plants (one-way junctions)', () => {
  for (const seed of [41, 47, 54]) {
    const w = createRealWorld(hostilePlant(seed), { dt: 0.2 });
    const checker = createInvariantChecker(w.traffic);
    for (let i = 0; i < 1500; i++) {
      w.step();
      checker.check();
    }
  }
});

// ================================================================================================================================
// I. Performance
// ================================================================================================================================

test('performance: 100 vehicles x 60 flows on a 60 x 40 plant simulate at least 600x real time (stub traffic)', () => {
  const layout = gridPlant({ vehicles: 100, flows: 60, interArrival: 4, cycle: 6 });
  const w = createWorld(layout, { dt: 0.1 });
  const started = performance.now();
  w.run(600);
  const seconds = (performance.now() - started) / 1000;
  assert.ok(w.lg.completed > 100, 'the plant really works');
  assert.ok(seconds < 1, `600 sim-s took ${seconds.toFixed(2)} s`);
  assert.deepEqual(checkInvariants(w.lg), []);
});
