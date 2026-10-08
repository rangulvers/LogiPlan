// Insights about resources that are not used (js/sim/insights.js): fleet-unused, vehicle-idle-some, source-unconnected-activity and
// station-never-used. Reports are built by hand (a healthy plant, then one thing is broken); the last tests run the real engine.
// The rules must not contradict the older ones: an unused fleet is never also "oversized", a saturated fleet is never told to add
// vehicles while another fleet that may do the same jobs stands idle, an unconnected goods-in is not "delivering more than the plant takes".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateInsights, UNUSED_MIN_WINDOW, FLEET_BARELY_USED_TRIPS_PER_HOUR, FLEET_UNUSED_MIN_OTHER_TRIPS, VEHICLE_IDLE_SHARE,
  VEHICLE_IDLE_MIN_MEAN_TRIPS, SOURCE_UNCONNECTED_MIN_YARD, STATION_NEVER_USED_WINDOW, STATION_NEVER_USED_MIN_SUPPLY,
} from '../js/sim/insights.js';
import { layoutFromAscii } from './helpers/ascii.js';
import { createRng } from '../js/util/rng.js';
import { EXAMPLES } from '../js/model/examples.js';
import { Simulation } from '../js/sim/engine.js';
import * as L from '../js/model/layout.js';

// ---- builders --------------------------------------------------------------------------------------------

/** Goods in A -> Press B -> Shipping D with a second goods-in G that nothing is connected to, an AGV fleet v1 and a forklift fleet v2. */
function plant({ flows = [['A', 'B'], ['B', 'D']], fleets } = {}) {
  return layoutFromAscii(['AA.BB.DD.GG', '+++++++++++'], {
    stations: {
      A: { type: 'source', name: 'Goods in' }, B: { type: 'process', name: 'Press' }, D: { type: 'sink', name: 'Shipping' },
      G: { type: 'source', name: 'Goods in 2' },
    },
    flows,
    fleets: fleets || [{ count: 3, name: 'AGVs' }, { count: 2, name: 'Forklifts', preset: 'forklift' }],
  });
}

const vehicleIds = (fleetId, count) => Array.from({ length: count }, (_, i) => `${fleetId}#${i + 1}`);

/** A healthy KpiReport of `layout`: every vehicle makes 20 trips, every station is fine. Tests then break one thing. */
function healthyReport(layout, { duration = 7200 } = {}) {
  const stations = {};
  for (const st of layout.stations) {
    stations[st.id] = {
      type: st.type, name: st.name, utilization: st.type === 'process' ? 0.6 : 0.5, starved: st.type === 'process' ? 0.1 : 0, blocked: 0, down: 0,
      avgIn: 0.5, maxIn: 2, avgOut: 0.5, maxOut: 2, avgFill: 0.3, maxFill: 0.6, produced: 50, consumed: 50, arrivals: 50, yardMax: 0, yardNow: 0, breakdowns: 0,
    };
  }
  const fleets = {};
  for (const f of layout.fleets) {
    const perVehicle = Object.fromEntries(vehicleIds(f.id, f.count).map((id) => [id, 20]));
    fleets[f.id] = {
      name: f.name, count: f.count, utilization: 0.5,
      shares: { driving: 0.35, waiting: 0.03, loading: 0.06, unloading: 0.06, idle: 0.3, parked: 0.2, charging: 0, broken: 0 },
      trips: 20 * f.count, vehicleTrips: perVehicle, tripsPerVehicleHour: 20 / (duration / 3600), distance: 2000, distancePerVehicle: 2000 / f.count, emptyShare: 0.5,
      avgPickupWait: 20, avgTransit: 30, minBattery: null,
    };
  }
  const flows = {};
  for (const f of layout.flows) flows[f.id] = { from: f.from, to: f.to, delivered: 50, trips: 50, avgPickupWait: 20, avgTransit: 30, backlog: 0, avgBacklog: 0 };
  const sink = layout.stations.find((s) => s.type === 'sink');
  return {
    window: { start: 600, end: 600 + duration, duration, warmingUp: false },
    throughput: { total: 100, perHour: 120, bySink: { [sink.id]: { name: sink.name, count: 100, perHour: 120 } } },
    leadTime: { count: 100, mean: 600, min: 300, p50: 580, p90: 800, p95: 900, max: 1100 },
    wip: { mean: 5, max: 9, now: 6 },
    stations, fleets, flows,
    traffic: { waitShare: 0.02, vehicleWait: 60, junctionWait: 20, brokenWait: 0, deadlocks: 0, hotspots: [], deadlockEvents: [] },
    orders: { completed: 100, avgPickupWait: 20, avgTransit: 30 },
    series: { interval: 60, t: [], throughput: [], wip: [], vehiclesWorking: [], vehiclesWaiting: [] },
  };
}

/** Make a fleet of the report hardly work: `trips` trips in total, spread over its vehicles. */
function quiet(report, fleetId, trips = 1) {
  const f = report.fleets[fleetId];
  const ids = vehicleIds(fleetId, f.count);
  f.vehicleTrips = Object.fromEntries(ids.map((id, i) => [id, i === 0 ? trips : 0]));
  f.trips = trips;
  f.tripsPerVehicleHour = trips / f.count / (report.window.duration / 3600);
  f.utilization = 0.01;
  f.shares = { ...f.shares, driving: 0.01, idle: 0.0, parked: 0.97, waiting: 0, loading: 0, unloading: 0 };
}

const insightsOf = (layout, mutate, opts) => {
  const report = healthyReport(layout, opts);
  mutate?.(report);
  return generateInsights(report, layout);
};
const find = (list, id) => list.find((i) => i.id === id);
const idsOf = (list) => list.map((i) => i.id);

// ---- the named thresholds ------------------------------------------------------------------------------

test('the thresholds are exported by name', () => {
  assert.equal(UNUSED_MIN_WINDOW, 600);
  assert.equal(FLEET_BARELY_USED_TRIPS_PER_HOUR, 0.3);
  assert.equal(FLEET_UNUSED_MIN_OTHER_TRIPS, 3);
  assert.equal(VEHICLE_IDLE_SHARE, 0.2);
  assert.equal(VEHICLE_IDLE_MIN_MEAN_TRIPS, 3);
  assert.equal(SOURCE_UNCONNECTED_MIN_YARD, 2);
  assert.equal(STATION_NEVER_USED_WINDOW, 900);
  assert.equal(STATION_NEVER_USED_MIN_SUPPLY, 3);
});

test('a healthy plant yields none of the four new insights', () => {
  const layout = plant({ flows: [['A', 'B'], ['B', 'D'], ['G', 'D']] });
  const list = insightsOf(layout);
  for (const rule of ['fleet-unused', 'vehicle-idle-some', 'source-unconnected-activity', 'station-never-used']) {
    assert.deepEqual(idsOf(list).filter((id) => id.startsWith(rule)), [], rule);
  }
});

// ---- fleet-unused --------------------------------------------------------------------------------------

test('fleet-unused: two forklifts with one trip in two hours while the AGVs carry everything', () => {
  const layout = plant({ flows: [['A', 'B'], ['B', 'D'], ['G', 'D']] });
  const list = insightsOf(layout, (r) => quiet(r, 'v2', 1));
  const unused = find(list, 'fleet-unused:v2');
  assert.ok(unused, idsOf(list).join(', '));
  assert.match(unused.title, /^The 2 vehicles of the Forklifts fleet hardly work \(1 trip in 2 h\)\.$/);
  assert.match(unused.detail, /Over 2 h the Forklifts vehicles made 1 trip/);
  assert.match(unused.suggestion, /The other vehicles already cover every job\. Remove them \(now 2\), or give them their own flows under Fleet → Jobs this fleet serves\./);
  assert.deepEqual(unused.refs, { fleetIds: ['v2'] });
  assert.ok(['info', 'warning'].includes(unused.severity));
  assert.equal(find(list, 'fleet-unused:v1'), undefined, 'the busy fleet is not reported');
});

test('fleet-unused: a single vehicle is worded in the singular', () => {
  const layout = plant({ fleets: [{ count: 3, name: 'AGVs' }, { count: 1, name: 'Truck', preset: 'forklift' }] });
  const list = insightsOf(layout, (r) => quiet(r, 'v2', 0));
  const unused = find(list, 'fleet-unused:v2');
  assert.ok(unused);
  assert.match(unused.title, /^The 1 vehicle of the Truck fleet hardly works \(0 trips in 2 h\)\.$/);
  assert.match(unused.suggestion, /Remove it \(now 1\), or give it their own flows/);
});

test('fleet-unused is a warning when the idle vehicles also add to congested traffic, else info', () => {
  const layout = plant();
  assert.equal(find(insightsOf(layout, (r) => quiet(r, 'v2', 1)), 'fleet-unused:v2').severity, 'info');
  const congested = insightsOf(layout, (r) => { quiet(r, 'v2', 1); r.traffic.waitShare = 0.2; });
  assert.equal(find(congested, 'fleet-unused:v2').severity, 'warning');
});

test('fleet-unused needs a long window: nothing under ten minutes', () => {
  const layout = plant();
  const short = insightsOf(layout, (r) => quiet(r, 'v2', 0), { duration: UNUSED_MIN_WINDOW - 1 });
  assert.equal(find(short, 'fleet-unused:v2'), undefined);
  const enough = insightsOf(layout, (r) => quiet(r, 'v2', 0), { duration: UNUSED_MIN_WINDOW });
  assert.ok(find(enough, 'fleet-unused:v2'));
});

test('fleet-unused does not fire at 0.3 trips per vehicle and hour or more', () => {
  const layout = plant();
  const list = insightsOf(layout, (r) => {
    quiet(r, 'v2', 0);
    r.fleets.v2.tripsPerVehicleHour = FLEET_BARELY_USED_TRIPS_PER_HOUR;
  });
  assert.equal(find(list, 'fleet-unused:v2'), undefined);
});

test('fleet-unused needs other vehicles that do the jobs: without them the older rule speaks', () => {
  const layout = plant();
  const list = insightsOf(layout, (r) => {
    quiet(r, 'v2', 0);
    for (const flow of Object.values(r.flows)) flow.trips = 1; // 2 trips in all, fewer than FLEET_UNUSED_MIN_OTHER_TRIPS
  });
  assert.equal(find(list, 'fleet-unused:v2'), undefined, 'nobody else covers the jobs');
  assert.ok(find(list, 'fleet-oversized:v2'), 'the fleet is still reported as mostly idle');
});

test('fleet-unused does not fire for a fleet that may not serve any flow (restricted flows): that is a restriction matter', () => {
  const layout = plant();
  for (const flow of layout.flows) flow.fleetId = 'v1';
  const list = insightsOf(layout, (r) => quiet(r, 'v2', 0));
  assert.equal(find(list, 'fleet-unused:v2'), undefined);
  assert.match(find(list, 'fleet-oversized:v2').suggestion, /fleet restriction/);
});

test('fleet-unused does not fire for vehicles that make no trips because they stand in a queue all the time (they are busy)', () => {
  const layout = plant();
  const list = insightsOf(layout, (r) => { quiet(r, 'v2', 0); r.fleets.v2.utilization = 0.6; r.fleets.v2.shares.waiting = 0.5; });
  assert.equal(find(list, 'fleet-unused:v2'), undefined);
});

test('fleet-unused does not fire while loads wait for a vehicle (then something else is wrong)', () => {
  const layout = plant();
  const list = insightsOf(layout, (r) => { quiet(r, 'v2', 0); r.flows[layout.flows[0].id].avgBacklog = 2.5; });
  assert.equal(find(list, 'fleet-unused:v2'), undefined);
});

test('an unused fleet is not also called oversized or in need of a spare', () => {
  const layout = plant();
  const list = insightsOf(layout, (r) => { quiet(r, 'v2', 1); r.fleets.v2.shares.broken = 0.08; r.fleets.v2.shares.parked = 0.89; });
  assert.ok(find(list, 'fleet-unused:v2'));
  assert.equal(find(list, 'fleet-oversized:v2'), undefined);
  const breakdown = list.find((i) => i.id === 'breakdowns:v2');
  assert.ok(breakdown);
  assert.doesNotMatch(breakdown.suggestion, /Add a spare vehicle/);
});

test('a saturated fleet is not told to add vehicles while another fleet that may do the same jobs hardly works', () => {
  const layout = plant();
  const list = insightsOf(layout, (r) => {
    quiet(r, 'v2', 1);
    r.fleets.v1.utilization = 0.93;
    r.fleets.v1.shares = { ...r.fleets.v1.shares, driving: 0.8, waiting: 0.03, loading: 0.05, unloading: 0.05, idle: 0.07, parked: 0 };
  });
  const saturated = find(list, 'fleet-saturated:v1');
  assert.ok(saturated);
  assert.doesNotMatch(saturated.suggestion, /\bAdd \d/);
  assert.match(saturated.suggestion, /Forklifts fleet may serve the same flows but hardly works/);
  assert.ok(find(list, 'fleet-unused:v2'));
});

test('a saturated fleet is still told to add vehicles when the other fleets are busy too', () => {
  const layout = plant();
  const list = insightsOf(layout, (r) => {
    r.fleets.v1.utilization = 0.93;
    r.fleets.v1.shares = { ...r.fleets.v1.shares, driving: 0.8, waiting: 0.03, loading: 0.05, unloading: 0.05, idle: 0.07, parked: 0 };
  });
  assert.match(find(list, 'fleet-saturated:v1').suggestion, /^Add \d/);
});

// ---- vehicle-idle-some ---------------------------------------------------------------------------------

const withTrips = (fleetId, trips) => (r) => {
  const f = r.fleets[fleetId];
  const ids = vehicleIds(fleetId, f.count);
  f.vehicleTrips = Object.fromEntries(ids.map((id, i) => [id, trips[i]]));
  f.trips = trips.reduce((a, b) => a + b, 0);
  f.tripsPerVehicleHour = f.trips / f.count / (r.window.duration / 3600);
};

test('vehicle-idle-some: two of four vehicles do almost nothing while their fleet-mates make 20 trips', () => {
  const layout = plant({ fleets: [{ count: 4, name: 'AGVs' }, { count: 2, name: 'Forklifts', preset: 'forklift' }] });
  const list = insightsOf(layout, withTrips('v1', [21, 20, 1, 0]));
  const idle = find(list, 'vehicle-idle-some:v1');
  assert.ok(idle, idsOf(list).join(', '));
  assert.equal(idle.severity, 'info');
  assert.equal(idle.title, '2 of 4 vehicles in the AGVs fleet hardly work.');
  assert.match(idle.detail, /#3 \(1 trip\), #4 \(0 trips\) made far fewer trips than their fleet-mates, who averaged 21 trips each\./);
  assert.match(idle.suggestion, /^Try 2 vehicles instead of 4/);
  assert.deepEqual(idle.refs, { fleetIds: ['v1'] });
});

test('vehicle-idle-some: names at most three vehicles', () => {
  const layout = plant({ fleets: [{ count: 8, name: 'AGVs' }, { count: 2, name: 'Forklifts', preset: 'forklift' }] });
  const list = insightsOf(layout, withTrips('v1', [30, 30, 30, 0, 0, 0, 0, 0]));
  assert.match(find(list, 'vehicle-idle-some:v1').detail, /#4 \(0 trips\), #5 \(0 trips\), #6 \(0 trips\) and 2 more made far fewer trips/);
});

test('vehicle-idle-some does not fire for an even fleet, a quiet fleet, or without per-vehicle numbers', () => {
  const layout = plant({ fleets: [{ count: 4, name: 'AGVs' }, { count: 2, name: 'Forklifts', preset: 'forklift' }] });
  assert.equal(find(insightsOf(layout), 'vehicle-idle-some:v1'), undefined, 'every vehicle makes 20 trips');
  assert.equal(find(insightsOf(layout, withTrips('v1', [4, 3, 1, 0])), 'vehicle-idle-some:v1'), undefined, 'fleet-mates averaged fewer than 3 trips');
  assert.equal(find(insightsOf(layout, withTrips('v1', [10, 10, 10, 8])), 'vehicle-idle-some:v1'), undefined);
  const without = insightsOf(layout, (r) => { delete r.fleets.v1.vehicleTrips; });
  assert.equal(find(without, 'vehicle-idle-some:v1'), undefined);
  const short = insightsOf(layout, withTrips('v1', [21, 20, 1, 0]), { duration: UNUSED_MIN_WINDOW - 1 });
  assert.equal(find(short, 'vehicle-idle-some:v1'), undefined, 'window too short');
});

test('vehicle-idle-some stays silent when the fleet as a whole is oversized, unused or saturated: those verdicts fit better', () => {
  const layout = plant({ fleets: [{ count: 4, name: 'AGVs' }, { count: 2, name: 'Forklifts', preset: 'forklift' }] });
  const oversized = insightsOf(layout, (r) => { withTrips('v1', [21, 20, 1, 0])(r); r.fleets.v1.utilization = 0.1; });
  assert.ok(find(oversized, 'fleet-oversized:v1'));
  assert.equal(find(oversized, 'vehicle-idle-some:v1'), undefined);
  const saturated = insightsOf(layout, (r) => { withTrips('v1', [21, 20, 1, 0])(r); r.fleets.v1.utilization = 0.95; });
  assert.ok(find(saturated, 'fleet-saturated:v1'));
  assert.equal(find(saturated, 'vehicle-idle-some:v1'), undefined);
});

// ---- source-unconnected-activity -----------------------------------------------------------------------

test('source-unconnected-activity: a goods-in without any flow whose yard grows', () => {
  const layout = plant();
  const list = insightsOf(layout, (r) => Object.assign(r.stations[layout.stations.find((s) => s.name === 'Goods in 2').id], { arrivals: 24, yardNow: 24, yardMax: 24, blocked: 1, utilization: 0 }));
  const g = layout.stations.find((s) => s.name === 'Goods in 2').id;
  const hit = find(list, `source-unconnected-activity:${g}`);
  assert.ok(hit, idsOf(list).join(', '));
  assert.equal(hit.severity, 'warning');
  assert.match(hit.title, /^Goods in 2 receives loads, but no flow takes them away: 24 loads are piling up in its yard\.$/);
  assert.match(hit.detail, /received 24 loads\. No flow starts at this station/);
  assert.match(hit.suggestion, /Connect Goods in 2 to a workstation/);
  assert.deepEqual(hit.refs, { stationIds: [g] });
  assert.equal(find(list, `supply:${g}`), undefined, 'it is not also said to deliver more than the plant takes');
});

test('source-unconnected-activity is only info for a yard of two loads, and silent for an empty yard or a source with a flow', () => {
  const layout = plant();
  const g = layout.stations.find((s) => s.name === 'Goods in 2').id;
  const small = insightsOf(layout, (r) => Object.assign(r.stations[g], { arrivals: 2, yardNow: SOURCE_UNCONNECTED_MIN_YARD }));
  assert.equal(find(small, `source-unconnected-activity:${g}`).severity, 'info');
  const none = insightsOf(layout, (r) => Object.assign(r.stations[g], { arrivals: 5, yardNow: SOURCE_UNCONNECTED_MIN_YARD - 1 }));
  assert.equal(find(none, `source-unconnected-activity:${g}`), undefined);
  const connected = plant({ flows: [['A', 'B'], ['B', 'D'], ['G', 'D']] });
  const gc = connected.stations.find((s) => s.name === 'Goods in 2').id;
  const list = insightsOf(connected, (r) => Object.assign(r.stations[gc], { arrivals: 24, yardNow: 24, blocked: 1 }));
  assert.equal(find(list, `source-unconnected-activity:${gc}`), undefined, 'it has a flow: the older supply rule applies');
  assert.ok(find(list, `supply:${gc}`));
});

// ---- station-never-used --------------------------------------------------------------------------------

/** Press B receives nothing although Goods in produced loads and the vehicles are free. */
const nothingReaches = (layout, name = 'Press') => (r) => {
  const station = layout.stations.find((s) => s.name === name);
  for (const flow of layout.flows.filter((f) => f.to === station.id)) Object.assign(r.flows[flow.id], { delivered: 0, trips: 0 });
};

test('station-never-used: nothing reached the press in 2 h although goods in produced loads and the vehicles have time', () => {
  const layout = plant();
  const list = insightsOf(layout, nothingReaches(layout));
  const b = layout.stations.find((s) => s.name === 'Press').id;
  const hit = find(list, `station-never-used:${b}`);
  assert.ok(hit, idsOf(list).join(', '));
  assert.equal(hit.severity, 'warning');
  assert.equal(hit.title, 'Nothing reaches Press: no load arrived there in 2 h.');
  assert.match(hit.detail, /Goods in supplies Press and the vehicles have time to spare/);
  assert.match(hit.suggestion, /^Check the road to Press/);
  assert.deepEqual(hit.refs.stationIds, [b]);
  assert.deepEqual(hit.refs.flowIds, [layout.flows[0].id]);
});

test('station-never-used: loads waiting at the supplier count as supply too', () => {
  const layout = plant();
  const b = layout.stations.find((s) => s.name === 'Press').id;
  const a = layout.stations.find((s) => s.name === 'Goods in').id;
  const list = insightsOf(layout, (r) => {
    nothingReaches(layout)(r);
    Object.assign(r.stations[a], { produced: 0, arrivals: 0 });
    r.flows[layout.flows[0].id].avgBacklog = 4;
  });
  assert.ok(find(list, `station-never-used:${b}`));
});

test('station-never-used stays silent in every case where the cause is clear or unknown', () => {
  const layout = plant();
  const b = layout.stations.find((s) => s.name === 'Press').id;
  const a = layout.stations.find((s) => s.name === 'Goods in').id;
  const id = `station-never-used:${b}`;
  assert.equal(find(insightsOf(layout, nothingReaches(layout), { duration: STATION_NEVER_USED_WINDOW - 1 }), id), undefined, 'window too short');
  assert.equal(find(insightsOf(layout), id), undefined, 'loads were delivered');
  assert.equal(find(insightsOf(layout, (r) => { nothingReaches(layout)(r); Object.assign(r.stations[a], { produced: 0, arrivals: STATION_NEVER_USED_MIN_SUPPLY - 1 }); }), id), undefined, 'no supply upstream');
  const busy = insightsOf(layout, (r) => {
    nothingReaches(layout)(r);
    for (const f of Object.values(r.fleets)) { f.utilization = 0.95; f.shares = { ...f.shares, driving: 0.8, idle: 0.02, parked: 0 }; }
  });
  assert.equal(find(busy, id), undefined, 'every vehicle is busy: that is the transport verdict');
  const traffic = insightsOf(layout, (r) => { nothingReaches(layout)(r); r.traffic.waitShare = 0.3; });
  assert.equal(find(traffic, id), undefined, 'congestion explains it');
  const noVehicles = plant({ fleets: [{ count: 0, name: 'AGVs' }] });
  const bn = noVehicles.stations.find((s) => s.name === 'Press').id;
  assert.equal(find(insightsOf(noVehicles, nothingReaches(noVehicles)), `station-never-used:${bn}`), undefined, 'no vehicle at all: other rules and the Checks tab say that');
});

test('station-never-used also names a shipping station nothing reaches', () => {
  const layout = plant();
  const d = layout.stations.find((s) => s.name === 'Shipping').id;
  const list = insightsOf(layout, nothingReaches(layout, 'Shipping'));
  assert.ok(find(list, `station-never-used:${d}`));
});

// ---- no contradictions, whatever the numbers -----------------------------------------------------------

test('fuzz: no combination of numbers makes the rules contradict each other', () => {
  const rng = createRng(2024);
  const layout = plant({ fleets: [{ count: 4, name: 'AGVs' }, { count: 3, name: 'Forklifts', preset: 'forklift' }, { count: 2, name: 'Tugger', preset: 'tugger' }] });
  const fleetIds = layout.fleets.map((f) => f.id);
  for (let round = 0; round < 400; round++) {
    const report = healthyReport(layout, { duration: rng.pick([300, 650, 1000, 3600, 7200]) });
    for (const id of fleetIds) {
      const f = report.fleets[id];
      const trips = f.trips ? Array.from({ length: f.count }, () => rng.pick([0, 0, 1, 2, 5, 12, 25, 40])) : [];
      withTrips(id, trips)(report);
      f.utilization = rng.pick([0.01, 0.1, 0.3, 0.5, 0.8, 0.9, 0.97]);
    }
    for (const flow of Object.values(report.flows)) {
      flow.avgBacklog = rng.pick([0, 0, 0.5, 2, 6]);
      if (rng.next() < 0.3) Object.assign(flow, { delivered: 0, trips: 0 });
    }
    report.traffic.waitShare = rng.pick([0.01, 0.05, 0.15, 0.3]);
    const g = layout.stations.find((s) => s.name === 'Goods in 2').id;
    Object.assign(report.stations[g], { arrivals: rng.pick([0, 5, 30]), yardNow: rng.pick([0, 1, 3, 20]), blocked: rng.pick([0, 1]) });
    const list = generateInsights(report, layout);
    const ids = new Set(idsOf(list));
    for (const id of fleetIds) {
      if (ids.has(`fleet-unused:${id}`)) {
        assert.ok(!ids.has(`fleet-oversized:${id}`), `round ${round}: ${id} unused and oversized`);
        assert.ok(!ids.has(`vehicle-idle-some:${id}`), `round ${round}: ${id} unused and partly idle`);
        assert.ok(!ids.has(`fleet-saturated:${id}`), `round ${round}: ${id} unused and saturated`);
        const spare = list.find((i) => i.id === `breakdowns:${id}`);
        if (spare) assert.doesNotMatch(spare.suggestion, /Add a spare vehicle/, `round ${round}`);
      }
      if (ids.has(`vehicle-idle-some:${id}`)) assert.ok(!ids.has(`fleet-oversized:${id}`) && !ids.has(`fleet-saturated:${id}`), `round ${round}`);
    }
    // "add vehicles" is never said while a fleet that could do the same jobs is called unused
    const unusedFleets = fleetIds.filter((id) => ids.has(`fleet-unused:${id}`));
    if (unusedFleets.length) {
      for (const i of list.filter((x) => x.suggestion && /\bAdd \d+(\.\d+)? vehicles?\b/.test(x.suggestion))) {
        assert.ok(!i.id.startsWith('fleet-saturated:') || !unusedFleets.length, `round ${round}: ${i.id} asks for vehicles next to ${unusedFleets}`);
      }
    }
    assert.ok(!(ids.has(`supply:${g}`) && ids.has(`source-unconnected-activity:${g}`)), `round ${round}: the unconnected goods-in is explained twice`);
    for (const insight of list) {
      assert.equal(typeof insight.title, 'string');
      assert.ok(!/NaN|undefined|Infinity/.test(`${insight.title} ${insight.detail} ${insight.suggestion || ''}`), `round ${round}: ${insight.id}: ${insight.title}`);
    }
  }
});

// ---- with the real engine ------------------------------------------------------------------------------

const run = (layout, seconds) => {
  const sim = new Simulation(layout);
  sim.advance(seconds);
  const report = sim.kpis();
  return { report, insights: sim.insights(report) };
};

test('real engine: extra forklifts next to enough AGVs are named once, with agreeing advice', () => {
  const layout = EXAMPLES.find((e) => e.id === 'starter').build();
  L.addFleet(layout, 'forklift', { name: 'Forklifts', count: 4, home: layout.stations.find((s) => s.type === 'depot').id });
  const { report, insights } = run(layout, 7200);
  const extra = layout.fleets[1].id;
  assert.ok(report.fleets[extra].tripsPerVehicleHour < report.fleets[layout.fleets[0].id].tripsPerVehicleHour);
  assert.deepEqual(Object.keys(report.fleets[extra].vehicleTrips), ['v2#1', 'v2#2', 'v2#3', 'v2#4']);
  const forFleet = insights.filter((i) => i.id.endsWith(`:${extra}`));
  assert.ok(forFleet.length >= 1, 'the idle fleet is reported');
  assert.ok(forFleet.length <= 2, `not more than two statements about one fleet: ${forFleet.map((i) => i.id)}`);
  assert.ok(!insights.some((i) => i.id === `fleet-saturated:${extra}`));
});

test('real engine: three forklifts that stay at the depot next to five AGVs make no trip in two hours and are called unused', () => {
  const layout = EXAMPLES.find((e) => e.id === 'starter').build();
  const depot = layout.stations.find((s) => s.type === 'depot');
  L.updateFleet(layout, layout.fleets[0].id, { count: 5 });
  const extra = L.addFleet(layout, 'forklift', { name: 'Forklifts', count: 3, home: depot.id, idle: 'stay' });
  const { report, insights } = run(layout, 7800);
  assert.ok(report.fleets[extra.id].tripsPerVehicleHour < FLEET_BARELY_USED_TRIPS_PER_HOUR, `trips per vehicle and hour: ${report.fleets[extra.id].tripsPerVehicleHour}`);
  const hit = insights.find((i) => i.id === `fleet-unused:${extra.id}`);
  assert.ok(hit, insights.map((i) => i.id).join(', '));
  assert.match(hit.title, /^The 3 vehicles of the Forklifts fleet hardly work \(\d+ trips? in 2 h\)\.$/);
  assert.match(hit.suggestion, /Fleet → Jobs this fleet serves/);
  assert.ok(!insights.some((i) => i.id === `fleet-oversized:${extra.id}`), 'and not also called oversized');
});

test('real engine: a goods-in that nothing is connected to piles up loads and is named; the supply rule stays silent about it', () => {
  const layout = EXAMPLES.find((e) => e.id === 'starter').build();
  L.paintRoadPath(layout, [[25, 7], [25, 5]]);
  const lonely = L.addStation(layout, { type: 'source', name: 'Lonely goods in', x: 24, y: 3, w: 3, h: 2, params: { interArrival: { kind: 'const', mean: 60, spread: 0 }, outCap: 4 } });
  assert.ok(lonely);
  const { insights } = run(layout, 3600);
  const hit = insights.find((i) => i.id === `source-unconnected-activity:${lonely.id}`);
  assert.ok(hit, insights.map((i) => i.id).join(', '));
  assert.match(hit.title, /^Lonely goods in receives loads, but no flow takes them away: \d+ loads are piling up in its yard\.$/);
  assert.ok(!insights.some((i) => i.id === `supply:${lonely.id}`));
});

test('real engine: a destination vehicles cannot reach is named "nothing reaches"', () => {
  const layout = EXAMPLES.find((e) => e.id === 'starter').build();
  // an island: a sink on the baseplate with no road next to it, fed by the assembly
  const island = L.addStation(layout, { type: 'sink', name: 'Island', x: 2, y: 20, w: 3, h: 2 });
  assert.ok(island);
  const assembly = layout.stations.find((s) => s.name === 'Assembly');
  assert.ok(L.addFlow(layout, assembly.id, island.id, {}));
  const { insights } = run(layout, 3600);
  const hit = insights.find((i) => i.id === `station-never-used:${island.id}`);
  assert.ok(hit, insights.map((i) => i.id).join(', '));
  assert.equal(hit.title, 'Nothing reaches Island: no load arrived there in 50 min.');
});
