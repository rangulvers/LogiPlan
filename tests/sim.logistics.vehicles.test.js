// Logistics: the vehicle state machine - placement, parking and leaving depots, idle policies, battery drain and
// charging, dead batteries, breakdowns, re-planning after a deadlock relocation, distance/time accounting, events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutFromAscii } from './helpers/ascii.js';
import { createWorld, injectLoads } from './helpers/logistics-invariants.js';
import { tripTicks } from './helpers/stub-traffic.js';
import { IDLE_GRACE, REASSIGN_AFTER } from '../js/sim/logistics/common.js';
import { dist } from '../js/model/defaults.js';

const node = (w, x, y) => y * w.graph.cols + x;
const AGV = { speed: 2, accel: 1, decel: 1, loadTime: 2, unloadTime: 2 };

/** Step until the vehicle's state changes and return the sequence of states seen (tick resolution). */
function trace(w, v, seconds) {
  const seq = [v.state];
  for (let i = 0, n = Math.round(seconds / w.dt); i < n; i++) {
    w.step();
    if (v.state !== seq[seq.length - 1]) seq.push(v.state);
  }
  return seq;
}

/** P (depot) .. A (source) ...... D (sink) on a line. */
function depotLine({ fleets = [{ count: 1, home: 'P', ...AGV }], depot = { slots: 2, chargers: 0 }, source = {}, settings } = {}) {
  return layoutFromAscii(['P..A.......D', '+'.repeat(12)], {
    stations: {
      P: { type: 'depot', params: depot },
      A: { type: 'source', params: { interArrival: dist('const', 1000), startDelay: 5, ...source } },
      D: 'sink',
    },
    flows: [['A', 'D']], fleets, settings,
  });
}

// ---- initial placement ---------------------------------------------------------------------------------------------------

test('placement: vehicles spread over plain road cells - not on docks, dead ends or junctions - deterministically', () => {
  const layout = layoutFromAscii([
    'A....B',
    '++++++',
    '..+...',
    '..+...',
  ], { stations: { A: 'source', B: 'sink' }, flows: [['A', 'B']], fleets: [{ count: 2 }, { count: 2, preset: 'forklift' }] });
  const w = createWorld(layout);
  const cells = w.lg.vehicles.map((v) => v.tv.node);
  assert.equal(w.lg.vehicles.length, 4);
  assert.equal(new Set(cells).size, 4, 'all on different cells');
  for (const n of cells) {
    assert.equal(w.graph.controlled[n], 0, `cell ${w.graph.cx(n)},${w.graph.cy(n)} is not a junction or dead end`);
    assert.equal(w.graph.stationsAt.has(n), false, 'not on a dock');
  }
  assert.ok(w.lg.vehicles.every((v) => v.state === 'idle' && v.visible && v.tv.onRoad));
  assert.deepEqual(createWorld(layout).lg.vehicles.map((v) => v.tv.node), cells);
  assert.deepEqual(w.lg.vehicles.map((v) => v.id), ['v1#1', 'v1#2', 'v2#1', 'v2#2']);
});

test('placement: vehicles beyond the plain cells use any free road cell; those without room are reported, not created', () => {
  const crowded = createWorld(layoutFromAscii(['+++'], { fleets: [{ count: 5 }] }));
  assert.equal(crowded.lg.vehicles.length, 3, 'one per road cell');
  assert.deepEqual(crowded.lg.unplaced, ['v1#4', 'v1#5']);
  crowded.run(20);
  const none = createWorld(layoutFromAscii(['A.D'], { stations: { A: 'source', D: 'sink' }, flows: [['A', 'D']], fleets: [{ count: 3 }, { count: 0 }, { count: NaN }] }));
  assert.equal(none.lg.vehicles.length, 0);
  assert.deepEqual(none.lg.unplaced, ['v1#1', 'v1#2', 'v1#3']);
  none.run(60);
  assert.equal(none.lg.completed, 0);
});

test('placement: fleets start parked in their home depot, overflowing into other depots and then the road', () => {
  const layout = layoutFromAscii(['P.Q.A..D', '++++++++'], {
    stations: { P: { type: 'depot', params: { slots: 2 } }, Q: { type: 'depot', params: { slots: 1 } }, A: { type: 'source', params: { interArrival: dist('const', 1000), startDelay: 100 } }, D: 'sink' },
    flows: [['A', 'D']], fleets: [{ count: 4, home: 'Q' }, { count: 1, idle: 'stay' }],
  });
  const w = createWorld(layout, { check: true });
  const [p, q] = ['P', 'Q'].map((id) => w.lg.stationById.get(id));
  assert.deepEqual(q.parked.map((v) => v.id), ['v1#1'], 'home first');
  assert.deepEqual(p.parked.map((v) => v.id), ['v1#2', 'v1#3'], 'then the next depot with free slots');
  assert.deepEqual(w.lg.vehicles.filter((v) => v.state === 'idle').map((v) => v.id), ['v1#4', 'v2#1'], 'the rest is on the road');
  for (const v of [...p.parked, ...q.parked]) {
    assert.equal(v.state, 'parked');
    assert.equal(v.visible, false);
    assert.equal(v.tv.onRoad, false);
    assert.equal(v.depot === p || v.depot === q, true);
  }
  assert.equal(p.fillLabel, '2/2');
  assert.equal(q.fill, 1);
});

// ---- parking, leaving, idle policies ---------------------------------------------------------------------------------------

test('depot: a parked vehicle goes back on the road for an order and parks again afterwards', () => {
  const w = createWorld(depotLine(), { dt: 0.25, check: true });
  const v = w.lg.vehicles[0];
  const p = w.lg.stationById.get('P');
  assert.equal(v.state, 'parked');
  assert.deepEqual(p.parked, [v]);
  const seq = trace(w, v, 200);
  assert.deepEqual(seq, ['parked', 'toPickup', 'loading', 'toDrop', 'unloading', 'idle', 'toPark', 'parked'], 'idle for the grace period first');
  assert.equal(v.trips, 1);
  assert.deepEqual(p.parked, [v]);
  assert.equal(v.visible, false);
  assert.equal(v.tv.onRoad, false);
  assert.equal(p.reservedSlots, 0);
  assert.equal(w.named('orderAssigned')[0].order.createdAt, 5, 'it left the depot in the tick the load appeared');
});

test('depot: vehicles parked at a single-dock depot leave one tick apart (the dock frees as the first one drives off)', () => {
  const layout = layoutFromAscii(['P....A....D', '+'.repeat(11)], {
    stations: { P: { type: 'depot', params: { slots: 3 } }, A: { type: 'source', params: { interArrival: dist('const', 1000), startDelay: 100, outCap: 5 } }, D: 'sink' },
    flows: [['A', 'D']], fleets: [{ count: 3, home: 'P', ...AGV }],
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  assert.equal(w.graph.docks.get('P').length, 1);
  injectLoads(w.lg, 'f1', 3, { createdAt: 0 });
  w.run(2);
  const starts = w.named('orderAssigned').map((e) => e.order.createdAt);
  assert.deepEqual(starts, [0, 0.25, 0.5], 'no waiting for the 0.5 s dispatch poll');
});

test('depot: idle "stay" leaves the vehicle where its last job ended', () => {
  const w = createWorld(depotLine({ fleets: [{ count: 1, home: 'P', idle: 'stay', ...AGV }] }), { dt: 0.25, check: true });
  const v = w.lg.vehicles[0];
  const seq = trace(w, v, 200);
  assert.deepEqual(seq, ['parked', 'toPickup', 'loading', 'toDrop', 'unloading', 'idle']);
  assert.equal(v.tv.node, node(w, 11, 1), 'at the sink dock');
  assert.equal(w.lg.stationById.get('P').parked.length, 0);
  assert.ok(v.timeIn.idle > 100);
});

test('depot: "park" vehicles return to their home depot even when another depot is nearer', () => {
  const layout = layoutFromAscii(['Q..A.......D.P', '+'.repeat(14)], {
    stations: { Q: { type: 'depot', params: { slots: 2 } }, P: { type: 'depot', params: { slots: 2 } }, A: { type: 'source', params: { interArrival: dist('const', 1000), startDelay: 5 } }, D: 'sink' },
    flows: [['A', 'D']], fleets: [{ count: 1, home: 'Q', ...AGV }],
  });
  const homeFirst = createWorld(layout, { dt: 0.25, check: true });
  homeFirst.run(300);
  assert.equal(homeFirst.lg.vehicles[0].depot.id, 'Q');
  assert.equal(homeFirst.lg.vehicles[0].state, 'parked');

  layout.fleets[0].home = null; // no home: the nearest depot with a free slot
  const nearest = createWorld(layout, { dt: 0.25, check: true });
  assert.equal(nearest.lg.vehicles[0].depot.id, 'Q', 'initial placement: first depot in layout order');
  nearest.run(300);
  assert.equal(nearest.lg.vehicles[0].depot.id, 'P');
});

test('depot: a full depot never gets more reservations than free slots; the other vehicle stays on the road', () => {
  const layout = depotLine({
    fleets: [{ count: 1, home: 'P', ...AGV }, { count: 1, ...AGV }], depot: { slots: 1, chargers: 0 },
    source: { interArrival: dist('const', 12), startDelay: 0 },
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  const p = w.lg.stationById.get('P');
  assert.equal(w.lg.vehicles[1].state, 'idle', 'the second vehicle found the depot full at the start');
  let maxPlaces = 0;
  let maxToPark = 0;
  for (let i = 0; i < 4 * 600; i++) {
    w.step();
    maxPlaces = Math.max(maxPlaces, p.parked.length + p.reservedSlots);
    maxToPark = Math.max(maxToPark, w.lg.vehicles.filter((v) => v.state === 'toPark').length);
  }
  assert.ok(maxPlaces <= 1, `parked + reserved never exceeded the single slot (${maxPlaces})`);
  assert.ok(maxToPark <= 1);
  assert.ok(w.lg.ordersDelivered > 20, 'both vehicles keep working');
  assert.ok(w.lg.vehicles.every((v) => v.trips > 0));
});

// ---- battery ----------------------------------------------------------------------------------------------------------------------------

const BATTERY = { enabled: true, runtimeMin: 20, chargeTimeMin: 10, lowPct: 25, resumePct: 90 };

test('battery: drains at the working rate while driving/loading/unloading, 20 % of it idle on the road, nothing parked', () => {
  const layout = layoutFromAscii(['P..A.......D', '+'.repeat(12)], {
    stations: { P: { type: 'depot', params: { slots: 2 } }, A: { type: 'source', params: { interArrival: dist('const', 60), startDelay: 5 } }, D: 'sink' },
    flows: [['A', 'D']],
    fleets: [{ count: 1, ...AGV, battery: BATTERY, idle: 'stay' }, { count: 1, ...AGV, battery: BATTERY, home: 'P', idle: 'park' }],
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  w.run(900);
  for (const v of w.lg.vehicles) {
    const work = ['toPickup', 'loading', 'toDrop', 'unloading', 'toPark', 'toCharger'].reduce((sum, s) => sum + v.timeIn[s], 0);
    const slow = v.timeIn.idle + v.timeIn.broken;
    assert.ok(work > 0 || v.timeIn.parked > 800);
    assert.ok(Math.abs(v.battery - (1 - (work + 0.2 * slow) / (20 * 60))) < 1e-9, `${v.id} battery ${v.battery}`);
    assert.equal(Object.values(v.timeIn).reduce((a, b) => a + b, 0), 900, 'time in state adds up to the elapsed time');
  }
  const stayer = w.lg.vehicles.find((v) => v.cfg.idle === 'stay');
  assert.ok(stayer.timeIn.idle > 0 && stayer.battery < 1);
});

test('battery: low battery sends an idle vehicle to a charger; it charges to the resume level and then works again', () => {
  const layout = layoutFromAscii(['P...A.......D', '+'.repeat(13)], {
    stations: { P: { type: 'depot', params: { slots: 2, chargers: 1 } }, A: { type: 'source', params: { interArrival: dist('const', 10), startDelay: 0, outCap: 3 } }, D: 'sink' },
    flows: [['A', 'D']],
    fleets: [{ count: 1, home: 'P', ...AGV, battery: { enabled: true, runtimeMin: 4, chargeTimeMin: 1, lowPct: 50, resumePct: 90 } }],
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  const v = w.lg.vehicles[0];
  const p = w.lg.stationById.get('P');
  const states = new Set();
  let minBattery = 1;
  let prev = null;
  let rateChecked = false;
  let deliveredAfterCharge = 0;
  for (let i = 0; i < 4 * 1500; i++) {
    w.step();
    states.add(v.state);
    minBattery = Math.min(minBattery, v.battery);
    if (v.state === 'charging' && prev !== null && prev.state === 'charging' && v.battery < 1 - 1e-9) {
      assert.ok(Math.abs(v.battery - prev.battery - 0.25 / 60) < 1e-12, 'charges 1/60 per second');
      rateChecked = true;
    }
    if (prev && prev.state === 'charging' && v.state !== 'charging') {
      assert.ok(prev.battery >= 0.9 - 0.25 / 60, `charging stops at the resume level (${prev.battery})`);
      deliveredAfterCharge = w.lg.ordersDelivered;
    }
    assert.ok(p.charging.length <= 1);
    prev = { state: v.state, battery: v.battery };
  }
  for (const s of ['toCharger', 'charging', 'toPickup', 'loading', 'toDrop']) assert.ok(states.has(s), `visited ${s}`);
  assert.ok(rateChecked);
  assert.ok(!states.has('dead'));
  assert.ok(minBattery > 0.3, `never ran dry (min ${minBattery})`);
  assert.ok(w.lg.ordersDelivered > deliveredAfterCharge, 'it works again after charging');
  assert.ok(v.timeIn.charging > 100);
});

test('battery: one charger serves two low vehicles in turn - never more charging than chargers', () => {
  const layout = layoutFromAscii(['P...A.......D', '+'.repeat(13)], {
    stations: { P: { type: 'depot', params: { slots: 4, chargers: 1 } }, A: { type: 'source', params: { interArrival: dist('const', 8), startDelay: 0, outCap: 4 } }, D: 'sink' },
    flows: [['A', 'D']],
    fleets: [{ count: 2, home: 'P', ...AGV, battery: { enabled: true, runtimeMin: 4, chargeTimeMin: 2, lowPct: 50, resumePct: 80 } }],
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  const p = w.lg.stationById.get('P');
  let maxCharging = 0;
  for (let i = 0; i < 4 * 2400; i++) {
    w.step();
    maxCharging = Math.max(maxCharging, p.charging.length);
    assert.ok(w.lg.vehicles.every((v) => v.state !== 'dead'));
  }
  assert.equal(maxCharging, 1);
  assert.ok(w.lg.vehicles.every((v) => v.timeIn.charging > 50), 'both get their turn');
});

test('battery: without any charger a vehicle keeps working until the battery is empty, then it is dead for good', () => {
  const layout = layoutFromAscii(['A.......D', '+'.repeat(9)], {
    stations: { A: { type: 'source', params: { interArrival: dist('const', 10), startDelay: 0, outCap: 3 } }, D: 'sink' },
    flows: [['A', 'D']],
    fleets: [{ count: 1, ...AGV, battery: { enabled: true, runtimeMin: 3, chargeTimeMin: 10, lowPct: 25, resumePct: 90 } }, { count: 1, ...AGV }],
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  const [mortal, healthy] = w.lg.vehicles;
  w.run(600);
  assert.equal(mortal.state, 'dead');
  assert.equal(mortal.battery, 0);
  assert.equal(mortal.tv.disabled, true);
  assert.equal(w.named('vehicleDead').length, 1);
  assert.equal(w.named('vehicleDead')[0].vehicle, mortal);
  const where = [mortal.x, mortal.y, mortal.tv.odometer, mortal.trips];
  const delivered = w.lg.ordersDelivered;
  w.run(300);
  assert.deepEqual([mortal.x, mortal.y, mortal.tv.odometer, mortal.trips], where, 'dead means stopped for good');
  assert.equal(mortal.state, 'dead');
  assert.ok(w.lg.ordersDelivered > delivered, 'the healthy vehicle carries on');
  assert.ok(healthy.trips > mortal.trips);
  assert.ok(mortal.timeIn.dead > 300);
  assert.ok(mortal.timeIn.toPickup + mortal.timeIn.toDrop + mortal.timeIn.loading + mortal.timeIn.unloading <= 3 * 60 + 1, 'it died after ~3 minutes of work');
});

test('battery: a vehicle that dies on its way to a charger gives its reservations back', () => {
  const layout = layoutFromAscii(['A.......D.......P', '+'.repeat(17)], {
    stations: { A: { type: 'source', params: { interArrival: dist('const', 1000), startDelay: 0 } }, D: 'sink', P: { type: 'depot', params: { slots: 1, chargers: 1 } } },
    flows: [['A', 'D']],
    fleets: [{ count: 1, ...AGV, battery: { enabled: true, runtimeMin: 10, chargeTimeMin: 10, lowPct: 99, resumePct: 100 } }],
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  const v = w.lg.vehicles[0];
  const p = w.lg.stationById.get('P');
  assert.ok(w.runUntil(() => v.state === 'toCharger', 200), 'after its order the tired vehicle heads for the charger');
  assert.equal(p.reservedSlots, 1);
  assert.equal(p.reservedChargers, 1);
  v.battery = 0.0001;
  w.run(5);
  assert.equal(v.state, 'dead');
  assert.equal(p.reservedSlots, 0);
  assert.equal(p.reservedChargers, 0);
  assert.equal(p.parked.length + p.charging.length, 0);
});

// ---- breakdowns ------------------------------------------------------------------------------------------------------------------------------

/** One AGV carrying a single load from A to D; `breakAt` forces a breakdown that many seconds into the trip. */
function breakdownRun({ breakAt = null, mttr = 25 }) {
  const layout = layoutFromAscii(['A.......D', '+'.repeat(9)], {
    stations: { A: { type: 'source', params: { interArrival: dist('const', 1000), startDelay: 2 } }, D: 'sink' },
    flows: [['A', 'D']], fleets: [{ count: 1, ...AGV, mtbf: 1e9, mttr }],
  });
  const w = createWorld(layout, { dt: 0.25, check: true, seed: 5 });
  const v = w.lg.vehicles[0];
  if (breakAt !== null) v.ttf = breakAt;
  const log = [];
  for (let i = 0; i < 4 * 300; i++) {
    w.step();
    log.push({ state: v.state, x: v.x, y: v.y, odo: v.tv.odometer, disabled: v.tv.disabled, delivered: w.lg.ordersDelivered });
  }
  return { w, v, log };
}

test('vehicle breakdown: the order stalls while the vehicle is broken and resumes after the repair', () => {
  const base = breakdownRun({});
  const stalled = breakdownRun({ breakAt: 4 });
  const deliveredAt = (r) => r.w.named('orderDelivered')[0].order.deliveredAt;
  const [down] = stalled.w.named('vehicleDown');
  const [up] = stalled.w.named('vehicleUp');
  assert.ok(down && up && up.t > down.t);
  assert.equal(stalled.w.named('vehicleDown').length, 1);
  assert.equal(down.vehicle, stalled.v);
  const brokenTicks = stalled.log.filter((e) => e.state === 'broken');
  assert.ok(brokenTicks.length > 8);
  assert.ok(brokenTicks.every((e) => e.disabled && e.x === brokenTicks[0].x && e.y === brokenTicks[0].y && e.odo === brokenTicks[0].odo), 'frozen in place while broken');
  assert.equal(stalled.log.at(-1).delivered, 1, 'it finishes the order after the repair');
  assert.ok(Math.abs(deliveredAt(stalled) - (deliveredAt(base) + (up.t - down.t))) <= 0.5 + 1e-9, `delay ${deliveredAt(stalled) - deliveredAt(base)} vs downtime ${up.t - down.t}`);
  assert.equal(stalled.v.tv.disabled, false);
  assert.equal(stalled.v.breakdowns, 1);
  assert.ok(Math.abs(stalled.v.timeIn.broken - (up.t - down.t - 0.25)) < 1e-9);
});

test('vehicle breakdown: random failures (mtbf/mttr) happen on the road, repair times add up', () => {
  const layout = layoutFromAscii(['P..A.......D', '+'.repeat(12)], {
    stations: { P: { type: 'depot', params: { slots: 2 } }, A: { type: 'source', params: { interArrival: dist('const', 15), startDelay: 0 } }, D: 'sink' },
    flows: [['A', 'D']], fleets: [{ count: 2, home: 'P', ...AGV, mtbf: 120, mttr: 30 }],
  });
  const w = createWorld(layout, { dt: 0.25, check: true, seed: 9 });
  w.run(2400);
  const downs = w.named('vehicleDown');
  const ups = w.named('vehicleUp');
  assert.ok(downs.length >= 4, `${downs.length} breakdowns`);
  assert.ok(ups.length >= downs.length - 2);
  for (const v of w.lg.vehicles) {
    const mine = downs.filter((e) => e.vehicleId === v.id).length;
    assert.equal(v.breakdowns, mine);
  }
  assert.ok(w.lg.ordersDelivered > 30);
});

// ---- deadlock relocation -------------------------------------------------------------------------------------------------------------------------

/** One AGV, source A (loads on demand: first at t=1) and sink D on a 9-cell line; vehicle placed at x=6. */
function relocationWorld(layout) {
  const l = layout || layoutFromAscii(['A.......D', '+'.repeat(9)], {
    stations: { A: { type: 'source', params: { interArrival: dist('const', 1000), startDelay: 1 } }, D: 'sink' },
    flows: [['A', 'D']], fleets: [{ count: 1, ...AGV }],
  });
  const w = createWorld(l, { dt: 0.25, check: true });
  w.traffic.relocate(w.lg.vehicles[0].tv, node(w, 6, 1));
  return w;
}

test('relocation: a vehicle moved by deadlock resolution plans its current leg again from the new node', () => {
  for (const notify of [true, false]) {
    const w = relocationWorld();
    const v = w.lg.vehicles[0];
    assert.ok(w.runUntil(() => v.state === 'toPickup' && v.tv.edge >= 0, 20));
    const orderId = v.order.id;
    assert.ok(w.traffic.relocate(v.tv, node(w, 7, 1)));
    assert.equal(v.tv.driving, false, 'relocation cleared the route');
    if (notify) w.lg.handleDeadlock({ victim: v.tv, resolved: true, vehicles: [v.tv], nodes: [] });
    w.step();
    assert.equal(v.tv.driving, true, 're-planned at once');
    assert.equal(v.order.id, orderId, 'same order');
    w.run(120);
    assert.equal(w.lg.completed, 1);
    assert.equal(w.lg.ordersDelivered, 1);
    assert.equal(w.lg.deadlocks, notify ? 1 : 0);
  }
});

test('relocation: a loaded vehicle that is moved still delivers its loads', () => {
  const w = relocationWorld();
  const v = w.lg.vehicles[0];
  assert.ok(w.runUntil(() => v.state === 'toDrop' && v.tv.edge >= 0, 60));
  assert.equal(v.load.length, 1);
  assert.ok(w.traffic.relocate(v.tv, node(w, 2, 1)));
  w.lg.handleDeadlock({ victim: v.tv, resolved: true });
  w.run(120);
  assert.equal(w.lg.completed, 1);
  assert.equal(w.named('orderDelivered').length, 1);
});

test('relocation: moved onto a dock of its target, the vehicle starts loading without driving', () => {
  const w = relocationWorld();
  const v = w.lg.vehicles[0];
  assert.ok(w.runUntil(() => v.state === 'toPickup' && v.tv.edge >= 0, 20));
  assert.ok(w.traffic.relocate(v.tv, node(w, 0, 1)));
  w.step();
  assert.equal(v.state, 'loading');
  w.run(60);
  assert.equal(w.lg.completed, 1);
});

test('relocation: if the target cannot be reached from the new node the vehicle waits, retries, and recovers', () => {
  const layout = layoutFromAscii(['..A...D.', '>>>>>>>>'], {
    stations: { A: { type: 'source', params: { interArrival: dist('const', 1000), startDelay: 1 } }, D: 'sink' },
    flows: [['A', 'D']], fleets: [{ count: 1, ...AGV }],
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  const v = w.lg.vehicles[0];
  w.traffic.relocate(v.tv, node(w, 0, 1));
  assert.ok(w.runUntil(() => v.state === 'toPickup' && v.tv.edge >= 0, 20));
  assert.ok(w.traffic.relocate(v.tv, node(w, 5, 1)), 'downstream of the pickup on a one-way road: unreachable');
  w.lg.handleDeadlock({ victim: v.tv, resolved: true });
  w.run(30);
  assert.equal(v.state, 'toPickup');
  assert.equal(v.tv.driving, false);
  assert.equal(w.lg.activeOrders.size, 1, 'the order is kept');
  assert.ok(w.runUntil(() => v.retryAt > w.t, 5), 'a retry is pending: the plan failed less than a second ago');
  assert.ok(w.traffic.relocate(v.tv, node(w, 1, 1)));
  w.lg.handleDeadlock({ victim: v.tv, resolved: true });
  w.step();
  assert.equal(v.tv.driving, true, 'a reported relocation is re-planned at once, without waiting for the retry timer');
  w.run(120);
  assert.equal(w.lg.completed, 1);
});

test('relocation: without a report the vehicle notices at its next retry (within a second)', () => {
  const layout = layoutFromAscii(['..A...D.', '>>>>>>>>'], {
    stations: { A: { type: 'source', params: { interArrival: dist('const', 1000), startDelay: 1 } }, D: 'sink' },
    flows: [['A', 'D']], fleets: [{ count: 1, ...AGV }],
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  const v = w.lg.vehicles[0];
  w.traffic.relocate(v.tv, node(w, 0, 1));
  assert.ok(w.runUntil(() => v.state === 'toPickup' && v.tv.edge >= 0, 20));
  assert.ok(w.traffic.relocate(v.tv, node(w, 5, 1)), 'the pickup (x=2) is now upstream: unreachable');
  w.run(10);
  assert.equal(v.state, 'toPickup');
  assert.ok(w.runUntil(() => v.retryAt > w.t, 5), 'a retry is pending');
  assert.ok(w.traffic.relocate(v.tv, node(w, 1, 1)));
  w.step();
  assert.equal(v.tv.driving, false, 'still waiting for its retry timer');
  w.run(1.25);
  assert.equal(v.tv.driving, true);
  w.run(100);
  assert.equal(w.lg.completed, 1);
});

test('relocation: odd deadlock reports and foreign arrivals are ignored', () => {
  const w = relocationWorld();
  const v = w.lg.vehicles[0];
  w.lg.handleDeadlock(undefined);
  w.lg.handleDeadlock({});
  w.lg.handleDeadlock({ victim: 'no such vehicle' });
  w.lg.handleDeadlock({ victim: v.id, resolved: false });
  w.lg.handleDeadlock({ victim: v });
  w.traffic.onArrive({ owner: null });
  w.traffic.onArrive({});
  w.traffic.onArrive(undefined);
  w.traffic.onArrive({ owner: { arrived: false, lg: {} } });
  w.run(60);
  assert.equal(w.lg.completed, 1);
  assert.equal(w.lg.deadlocks, 5);
});

// ---- accounting ---------------------------------------------------------------------------------------------------------------------------------------

test('distances: empty and loaded driving are told apart and add up to the odometer', () => {
  const layout = layoutFromAscii(['A......B', '++++++++'], {
    stations: { A: { type: 'source', params: { interArrival: dist('const', 1000), startDelay: 10 } }, B: 'sink' },
    flows: [['A', 'B']], fleets: [{ count: 1, ...AGV }],
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  const v = w.lg.vehicles[0];
  const startCell = w.graph.cx(v.tv.node);
  w.run(100);
  assert.equal(w.lg.completed, 1);
  assert.equal(v.emptyDistance, startCell * 2, 'start -> A');
  assert.equal(v.loadedDistance, 7 * 2, 'A -> B');
  assert.ok(Math.abs(v.emptyDistance + v.loadedDistance - v.tv.odometer) < 1e-9);
});

test('speedFactor: driving gets faster live and from the layout settings', () => {
  const leadTime = (settings, live) => {
    const layout = layoutFromAscii(['A......B', '++++++++'], {
      stations: { A: { type: 'source', params: { interArrival: dist('const', 1000), startDelay: 10 } }, B: 'sink' },
      flows: [['A', 'B']], fleets: [{ count: 1, ...AGV, loadTime: 4, unloadTime: 4 }], settings,
    });
    const w = createWorld(layout, { dt: 0.25 });
    if (live) w.lg.setRuntime({ speedFactor: live });
    const startCell = w.graph.cx(w.lg.vehicles[0].tv.node);
    w.run(100);
    return { lead: w.named('loadCompleted')[0].leadTime, startCell };
  };
  const slow = leadTime({});
  const fast = leadTime({ speedFactor: 2 });
  const liveFast = leadTime({}, 2);
  const drive = (cells, speed) => tripTicks(cells * 2, speed, 0.25) * 0.25;
  assert.equal(slow.lead, drive(slow.startCell, 2) + 4 + drive(7, 2) + 4);
  assert.equal(fast.lead, drive(fast.startCell, 4) + 4 + drive(7, 4) + 4);
  assert.equal(liveFast.lead, fast.lead);
  assert.ok(fast.lead < slow.lead);
});

test('pose mirrors follow the traffic vehicle; parked vehicles are hidden', () => {
  const w = createWorld(depotLine({ source: { startDelay: 0 } }), { dt: 0.25 });
  const v = w.lg.vehicles[0];
  let moved = false;
  for (let i = 0; i < 200; i++) {
    w.step();
    assert.equal(v.x, v.tv.x);
    assert.equal(v.y, v.tv.y);
    assert.equal(v.heading, v.tv.heading);
    assert.equal(v.prevX, v.tv.prevX);
    assert.equal(v.prevY, v.tv.prevY);
    assert.equal(v.prevHeading, v.tv.prevHeading);
    assert.equal(v.visible, v.state !== 'parked' && v.state !== 'charging');
    if (v.x !== v.prevX) moved = true;
  }
  assert.ok(moved);
});

// ---- events ---------------------------------------------------------------------------------------------------------------------------------------------

test('events: every event carries the documented payload', () => {
  const layout = layoutFromAscii(['P..A.....B.....D', '+'.repeat(16)], {
    stations: {
      P: { type: 'depot', params: { slots: 2 } }, A: { type: 'source', params: { interArrival: dist('const', 40), startDelay: 5 } },
      B: { type: 'process', params: { cycle: dist('const', 20), mtbf: 60, mttr: 10 } }, D: 'sink',
    },
    flows: [['A', 'B'], ['B', 'D']], fleets: [{ count: 1, home: 'P', ...AGV, mtbf: 100, mttr: 20, battery: { enabled: true, runtimeMin: 2, chargeTimeMin: 10 } }],
  });
  const w = createWorld(layout, { dt: 0.25, seed: 2, check: true });
  w.run(1500);
  const names = new Set(w.events.map((e) => e.name));
  for (const n of ['loadCreated', 'loadCompleted', 'orderAssigned', 'orderPickedUp', 'orderDelivered', 'machineDown', 'machineUp', 'vehicleDown', 'vehicleUp', 'vehicleDead']) assert.ok(names.has(n), `${n} was emitted`);
  for (const e of w.events) assert.ok(Number.isFinite(e.payload.t), `${e.name} has a time`);
  const [created] = w.named('loadCreated');
  // the last four keys of a load (ty, tk, at, slot) and of an order (pickAt, dropAt, pickExtra, dropExtra) are the fixed shapes of the warehouse module (docs/WAREHOUSE-DESIGN.md 5.4, M0): present, inert
  assert.deepEqual(Object.keys(created.load).sort(), ['at', 'claimed', 'createdAt', 'id', 'origin', 'readyAt', 'slot', 'tk', 'ty']);
  assert.equal(created.station.id, created.stationId);
  const [assigned] = w.named('orderAssigned');
  assert.deepEqual(Object.keys(assigned.order).sort(), ['createdAt', 'deliveredAt', 'dropAt', 'dropExtra', 'flowId', 'from', 'id', 'loads', 'pickAt', 'pickExtra', 'pickedAt', 'qty', 'readySince', 'to', 'vehicleId']);
  assert.equal(JSON.stringify(assigned.order.loads.length), '1', 'orders can be serialised (the FlowRT link is not enumerable)');
  assert.equal(assigned.order.flow, w.lg.flowById.get(assigned.order.flowId));
  assert.equal(assigned.vehicle.id, assigned.order.vehicleId);
  const delivered = w.named('orderDelivered')[0];
  assert.ok(delivered.waitForPickup >= 0 && delivered.transit > 0);
  assert.equal(delivered.waitForPickup, delivered.order.pickedAt - delivered.order.readySince);
  assert.equal(delivered.transit, delivered.order.deliveredAt - delivered.order.pickedAt);
  const done = w.named('loadCompleted')[0];
  assert.equal(done.leadTime, done.t - done.load.createdAt);
  assert.equal(done.station.id, 'D');
  const machine = w.named('machineDown')[0];
  assert.equal(machine.stationId, 'B');
  assert.equal(machine.machine, 0);
  assert.equal(w.named('vehicleDown')[0].vehicleId, 'v1#1');
});

// ---- idle grace ---------------------------------------------------------------------------------------------------------------------------

test('idle: a "park" vehicle waits IDLE_GRACE seconds before it drives to its depot', () => {
  const w = createWorld(depotLine(), { dt: 0.25, check: true });
  const v = w.lg.vehicles[0];
  assert.ok(w.runUntil(() => v.state === 'idle', 200));
  const idleFrom = w.t;
  assert.ok(w.runUntil(() => v.state === 'toPark', 100));
  assert.ok(Math.abs(w.t - idleFrom - IDLE_GRACE) <= 0.5 + 1e-9, `left for the depot ${w.t - idleFrom} s after it fell idle (grace ${IDLE_GRACE})`);
  assert.ok(Math.abs(v.timeIn.idle - IDLE_GRACE) <= 0.5 + 1e-9);
});

test('idle: a load that appears during the grace period is served at once - no trip to the depot and back', () => {
  const w = createWorld(depotLine({ source: { interArrival: dist('const', 25), startDelay: 5 } }), { dt: 0.25, check: true });
  const v = w.lg.vehicles[0];
  const seen = new Set();
  for (let i = 0; i < 4 * 400; i++) {
    w.step();
    seen.add(v.state);
  }
  assert.equal(seen.has('toPark'), false, 'a load is always due within the grace period (a round trip takes 20 s, a load comes every 25 s)');
  assert.ok(w.lg.ordersDelivered >= 14);
  assert.equal(v.parkDistance, 0);
});

test('idle: charging and the depot trip of a low vehicle do not wait for the grace period', () => {
  const layout = layoutFromAscii(['P...A.......D', '+'.repeat(13)], {
    stations: { P: { type: 'depot', params: { slots: 2, chargers: 1 } }, A: { type: 'source', params: { interArrival: dist('const', 1000), startDelay: 5 } }, D: 'sink' },
    flows: [['A', 'D']], fleets: [{ count: 1, home: 'P', ...AGV, battery: { enabled: true, runtimeMin: 20, chargeTimeMin: 10, lowPct: 99, resumePct: 100 } }],
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  const v = w.lg.vehicles[0];
  assert.ok(w.runUntil(() => v.state === 'unloading', 200));
  assert.ok(w.runUntil(() => v.state !== 'unloading', 20));
  assert.equal(v.state, 'toCharger', 'a tired vehicle sets off in the tick it is done');
});

// ---- distance accounting ------------------------------------------------------------------------------------------------------------------

test('distances: trips to depots and chargers are neither loaded nor empty driving - the three add up to the odometer', () => {
  const w = createWorld(depotLine(), { dt: 0.25, check: true });
  const v = w.lg.vehicles[0];
  w.run(200);
  assert.equal(v.state, 'parked');
  assert.equal(v.emptyDistance, 3 * 2, 'depot dock (x=0) -> source dock (x=3): 6 m');
  assert.equal(v.loadedDistance, 8 * 2, 'source dock -> sink dock (x=11): 16 m');
  assert.equal(v.parkDistance, 11 * 2, 'sink dock -> depot dock: 22 m');
  assert.ok(Math.abs(v.emptyDistance + v.loadedDistance + v.parkDistance - v.tv.odometer) < 1e-9);
});

// ---- orders that cannot be served any more ---------------------------------------------------------------------------------------------------------------

/** Source A (loads on demand), sink D and two battery AGVs on one line; the vehicles start at x=2 and x=6 cells... */
function twoBattery({ vehicle = {}, sink = 'sink', flowExtra = {}, batteryOn = true } = {}) {
  const layout = layoutFromAscii(['A.......D', '+'.repeat(9)], {
    stations: { A: { type: 'source', params: { interArrival: OFF, outCap: 6 } }, D: sink },
    flows: [['A', 'D', flowExtra]],
    fleets: [{ count: 2, ...AGV, idle: 'stay', ...(batteryOn ? { battery: { enabled: true, runtimeMin: 20, chargeTimeMin: 10, lowPct: 25, resumePct: 90 } } : {}), ...vehicle }],
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  w.traffic.relocate(w.lg.vehicles[0].tv, node(w, 2, 1));
  w.traffic.relocate(w.lg.vehicles[1].tv, node(w, 6, 1));
  return w;
}

const OFF = dist('const', 0);

test('orders: a vehicle that dies on its way to a pickup gives its order back - the load is free again, right behind the claimed ones', () => {
  const w = twoBattery();
  const [v1, v2] = w.lg.vehicles;
  const loads = injectLoads(w.lg, 'f1', 3, { createdAt: 0 });
  w.step();
  assert.deepEqual([v1.order.loads[0], v2.order.loads[0]], loads.slice(0, 2), 'the nearer vehicle took the first load, the other the second');
  const link = w.lg.flowById.get('f1').outLink;
  v1.battery = 1e-9;
  w.step();
  assert.equal(v1.state, 'dead');
  assert.equal(v1.order, null);
  const [cancelled] = w.named('orderCancelled');
  assert.equal(cancelled.vehicleId, 'v1#1');
  assert.equal(cancelled.reason, 'vehicle-dead');
  assert.equal(cancelled.order.pickedAt, null);
  assert.equal(link.claimed, 1);
  assert.deepEqual(link.queue, [loads[1], loads[0], loads[2]], 'claimed prefix first, the freed load behind it and before the younger one');
  assert.equal(loads[0].claimed, false);
  assert.equal(w.lg.stationById.get('D').inbound.get('f1'), 1, 'only the other vehicle\'s reservation is left');
  w.run(200);
  assert.equal(w.lg.flowById.get('f1').delivered, 3, 'the other vehicle delivered all three loads');
  assert.equal(w.lg.activeOrders.size, 0);
});

test('orders: a vehicle that dies carrying loads keeps them as work in progress, but the destination place is free again', () => {
  const layout = layoutFromAscii(['A.......W.......D', '+'.repeat(17)], {
    stations: {
      A: { type: 'source', params: { interArrival: OFF, outCap: 6 } }, W: { type: 'storage', params: { capacity: 1 } }, D: 'sink',
    },
    flows: [['A', 'W']], fleets: [{ count: 1, ...AGV, idle: 'stay', battery: { enabled: true, runtimeMin: 20, chargeTimeMin: 10, lowPct: 25, resumePct: 90 } }],
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  const v = w.lg.vehicles[0];
  const [load] = injectLoads(w.lg, 'f1', 1, { createdAt: 0 });
  assert.ok(w.runUntil(() => v.state === 'toDrop', 100));
  assert.equal(w.lg.stationById.get('W').inboundTotal, 1, 'the only place in the storage is promised to this load');
  v.battery = 1e-9;
  w.step();
  assert.equal(v.state, 'dead');
  assert.equal(w.named('orderCancelled')[0].order.pickedAt !== null, true);
  assert.equal(w.lg.stationById.get('W').inboundTotal, 0, 'the promised place is free again');
  assert.deepEqual(v.load, [load], 'the load stays on the dead vehicle');
  assert.equal(load.claimed, false);
  assert.equal(w.lg.liveLoads, 1, 'and still counts as work in progress');
  assert.equal(w.lg.completed, 0);
  w.run(60);
  assert.equal(w.lg.activeOrders.size, 0);
});

test('orders: a broken vehicle keeps its order for REASSIGN_AFTER seconds and then gives it back if it has not picked the loads up', () => {
  const w = twoBattery({ batteryOn: false, vehicle: { mtbf: 1e9, mttr: 1e7 } });
  const [v1, v2] = w.lg.vehicles;
  injectLoads(w.lg, 'f1', 1, { createdAt: 0 });
  w.step();
  assert.equal(v1.state, 'toPickup');
  v1.ttf = 0;
  w.step();
  assert.equal(v1.state, 'broken');
  const brokenAt = w.named('vehicleDown')[0].t;
  w.run(REASSIGN_AFTER - 1);
  assert.ok(v1.order, 'not given up yet');
  assert.equal(w.named('orderCancelled').length, 0);
  w.run(2);
  const [cancelled] = w.named('orderCancelled');
  assert.equal(cancelled.reason, 'vehicle-broken');
  assert.ok(cancelled.t - brokenAt >= REASSIGN_AFTER - 1e-9 && cancelled.t - brokenAt <= REASSIGN_AFTER + 0.5, `given back ${cancelled.t - brokenAt} s after the breakdown`);
  assert.equal(v1.order, null);
  w.run(120);
  assert.equal(w.lg.flowById.get('f1').delivered, 1);
  assert.equal(w.named('orderDelivered')[0].vehicle, v2);
});

test('orders: a broken vehicle that already carries the loads keeps its order for good, and delivers after the repair', () => {
  const w = twoBattery({ batteryOn: false, vehicle: { mtbf: 1e9, mttr: 100 } });
  const [v1] = w.lg.vehicles;
  injectLoads(w.lg, 'f1', 1, { createdAt: 0 });
  assert.ok(w.runUntil(() => v1.state === 'toDrop', 100));
  v1.ttf = 0;
  w.run(REASSIGN_AFTER * 3);
  assert.equal(v1.state, 'broken');
  assert.ok(v1.order && v1.order.pickedAt !== null, 'the loads cannot be taken over by anybody else');
  assert.equal(w.named('orderCancelled').length, 0);
  w.run(2000);
  assert.equal(w.lg.flowById.get('f1').delivered, 1);
});

test('orders: after a long breakdown the repaired vehicle is free again and takes new orders', () => {
  const w = twoBattery({ batteryOn: false, vehicle: { mtbf: 1e9, mttr: 120 } });
  const [v1] = w.lg.vehicles;
  injectLoads(w.lg, 'f1', 1, { createdAt: 0 });
  w.step();
  const first = w.lg.vehicles.find((v) => v.order);
  first.ttf = 0;
  w.step();
  assert.ok(w.runUntil(() => w.named('orderCancelled').length === 1, 100));
  assert.ok(w.runUntil(() => first.state !== 'broken', 2000), 'repaired in the end');
  assert.notEqual(first.state, 'toPickup', 'it has no order to resume');
  w.run(60);
  assert.equal(first.order, null);
  assert.equal(first.tv.driving, false);
  injectLoads(w.lg, 'f1', 2, { createdAt: w.t });
  w.run(200);
  assert.equal(w.lg.flowById.get('f1').delivered, 3);
  assert.ok(v1.trips + w.lg.vehicles[1].trips === 3);
});

// ---- charging liveness ----------------------------------------------------------------------------------------------------------------------------------------

/** H (depot without chargers), a source/sink pair and C (depot with one charger) on one line. */
function twoDepots({ home = 'H', battery, source = {} } = {}) {
  return layoutFromAscii(['HHH...A.....D.....CCC', '+'.repeat(21)], {
    stations: {
      H: { type: 'depot', params: { slots: 2, chargers: 0 } }, C: { type: 'depot', params: { slots: 2, chargers: 1 } },
      A: { type: 'source', params: { interArrival: dist('const', 5000), startDelay: 20, ...source } }, D: 'sink',
    },
    flows: [['A', 'D']], fleets: [{ count: 1, home, ...AGV, battery: { enabled: true, runtimeMin: 10, chargeTimeMin: 5, lowPct: 50, resumePct: 90, ...battery } }],
  });
}

test('charging: a parked vehicle with a low battery in a depot without chargers drives to one that has a charger', () => {
  const w = createWorld(twoDepots(), { dt: 0.25, check: true });
  const v = w.lg.vehicles[0];
  assert.equal(v.depot.id, 'H');
  v.battery = 0.3;
  const seq = [v.state];
  let atCharger = null;
  for (let i = 0; i < 4 * 400; i++) {
    w.step();
    if (v.state !== seq[seq.length - 1]) seq.push(v.state);
    if (atCharger === null && v.state === 'charging') atCharger = [v.parkDistance, v.emptyDistance, v.loadedDistance];
  }
  assert.deepEqual(seq.slice(0, 4), ['parked', 'toCharger', 'charging', 'toPickup'], 'the load that appeared meanwhile waited for it');
  assert.deepEqual(atCharger, [16 * 2, 0, 0], 'H dock (x=2) -> C dock (x=18): 32 m of depot driving, neither loaded nor empty');
  assert.ok(v.timeIn.charging >= (0.9 - 0.3) * 300 - 1, 'charged from 30 % to the resume level of 90 %');
  assert.equal(w.lg.flowById.get('f1').delivered, 1, 'back in service');
});

test('charging: a vehicle does not park at a depot without chargers if it would arrive below its low threshold', () => {
  const run = (battery) => {
    const w = createWorld(twoDepots({ source: { startDelay: 5 }, battery: { lowPct: 50 } }), { dt: 0.25, check: true });
    const v = w.lg.vehicles[0];
    assert.ok(w.runUntil(() => v.state === 'unloading', 200));
    v.battery = battery; // when it is done, 22 m to H cost 22 / 2 s of work = 11 s = 1.8 % of a 10 minute battery
    const headedFor = new Set();
    for (let i = 0; i < 4 * 250; i++) {
      w.step();
      if (v.state === 'toPark' || v.state === 'toCharger') headedFor.add(v.targetId);
    }
    return { v, headedFor };
  };
  const comfortable = run(0.8);
  assert.deepEqual([...comfortable.headedFor], ['H'], 'plenty of charge: it drives home to park');
  assert.equal(comfortable.v.depot.id, 'H');
  const marginal = run(0.51);
  assert.deepEqual([...marginal.headedFor], ['C'], '51 % minus the 56 m trip to H would be below 50 %: it never sets off for H, it goes where it can charge');
  assert.ok(marginal.v.timeIn.charging > 0);
});

test('charging: a low vehicle that cannot reach any charger keeps working instead of waiting for ever', () => {
  const layout = layoutFromAscii(['A.....D.....', '++++++++++++', '............', 'CCC.........', '+++.........'], {
    stations: {
      C: { type: 'depot', params: { slots: 1, chargers: 1 } }, A: { type: 'source', params: { interArrival: dist('const', 40), startDelay: 5 } }, D: 'sink',
    },
    flows: [['A', 'D', { fleetId: 'v2' }]],
    fleets: [{ count: 1, home: 'C', ...AGV }, { count: 1, idle: 'stay', ...AGV, battery: { enabled: true, runtimeMin: 30, chargeTimeMin: 5, lowPct: 50, resumePct: 90 } }],
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  assert.equal(w.lg.chargerDepots.length, 1, 'there is a charger depot - on a road of its own, with its only place taken by the first fleet');
  const v = w.lg.vehicles[1];
  assert.equal(v.state, 'idle');
  assert.ok(w.traffic.relocate(v.tv, node(w, 3, 1)));
  v.battery = 0.4;
  w.run(400);
  assert.ok(w.lg.flowById.get('f1').delivered >= 9, `${w.lg.flowById.get('f1').delivered} of 10 loads delivered although the battery is low and no charger can be reached`);
  assert.equal(v.timeIn.charging, 0);
});
