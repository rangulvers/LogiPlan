import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stats } from '../js/sim/stats.js';
import { generateInsights, MIN_DATA_SECONDS } from '../js/sim/insights.js';
import { createFakeSim, standardPlant } from './helpers/fake-sim.js';
import { layoutFromAscii } from './helpers/ascii.js';

// ---- builders --------------------------------------------------------------------------------------------

/** A line source A -> process B -> sink D with two AGVs (for rules that need a direct source or process neighbour). */
function lineLayout() {
  return layoutFromAscii(['AA.BB.DD', '++++++++'], {
    stations: { A: { type: 'source', name: 'Goods in' }, B: { type: 'process', name: 'Press' }, D: { type: 'sink', name: 'Shipping' } },
    flows: [['A', 'B'], ['B', 'D']],
    fleets: [{ count: 2 }],
  });
}

/** A line with a buffer in the middle: A -> B -> S -> C -> D. */
function bufferedLayout() {
  return layoutFromAscii(['AA.BB.SS.CC.DD', '++++++++++++++'], {
    stations: {
      A: { type: 'source', name: 'Goods in' }, B: { type: 'process', name: 'Press' }, S: { type: 'storage', name: 'Supermarket' },
      C: { type: 'process', name: 'Final assembly' }, D: { type: 'sink', name: 'Shipping' },
    },
    flows: [['A', 'B'], ['B', 'S'], ['S', 'C'], ['C', 'D']],
    fleets: [{ count: 2 }],
  });
}

/** A KpiReport without any problem for every station, fleet and flow of `layout`. Tests then break one thing. */
function healthyReport(layout, { duration = 3000 } = {}) {
  const stations = {};
  for (const st of layout.stations) {
    stations[st.id] = {
      type: st.type, name: st.name, utilization: st.type === 'process' ? 0.6 : st.type === 'source' ? 1 : 0.3,
      starved: st.type === 'process' ? 0.1 : 0, blocked: 0, down: 0, avgIn: 0.5, maxIn: 2, avgOut: 0.5, maxOut: 2,
      avgFill: 0.3, maxFill: 0.6, produced: 50, consumed: 50, arrivals: 50, yardMax: 0, yardNow: 0, breakdowns: 0,
    };
  }
  const fleets = {};
  for (const f of layout.fleets) {
    fleets[f.id] = {
      name: f.name, count: f.count, utilization: 0.5,
      shares: { driving: 0.35, waiting: 0.03, loading: 0.06, unloading: 0.06, idle: 0.3, parked: 0.2, charging: 0, broken: 0 },
      trips: 50, tripsPerVehicleHour: 6, distance: 2000, distancePerVehicle: 2000 / f.count, emptyShare: 0.5,
      avgPickupWait: 20, avgTransit: 30, minBattery: f.battery.enabled ? 0.6 : null,
    };
  }
  const flows = {};
  for (const f of layout.flows) flows[f.id] = { from: f.from, to: f.to, delivered: 50, trips: 50, avgPickupWait: 20, avgTransit: 30, backlog: 0 };
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

/** Insights of a healthy report after `mutate(report)` broke something. */
function insightsAfter(layout, mutate, opts) {
  const report = healthyReport(layout, opts);
  mutate(report);
  return generateInsights(report, layout);
}

const find = (list, id) => list.find((i) => i.id === id);
const ids = (list) => list.map((i) => i.id);

// ---- not enough data, good fallback ---------------------------------------------------------------------------

test('less than five simulated minutes yield a single info insight', () => {
  const layout = standardPlant();
  for (const duration of [0, 120, MIN_DATA_SECONDS - 1]) {
    const report = healthyReport(layout, { duration });
    report.stations.C.utilization = 0.99; // would be a bottleneck with enough data
    report.stations.C.avgIn = 9;
    const list = generateInsights(report, layout);
    assert.equal(list.length, 1);
    assert.equal(list[0].severity, 'info');
    assert.equal(list[0].title, 'Not enough data yet');
    assert.equal(list[0].id, 'not-enough-data');
  }
  const warming = healthyReport(layout, { duration: 10 });
  warming.window.warmingUp = true;
  assert.match(generateInsights(warming, layout)[0].detail, /warm-up/);
  assert.equal(generateInsights(healthyReport(layout, { duration: MIN_DATA_SECONDS }), layout).length > 0, true);
  assert.equal(find(generateInsights(healthyReport(layout, { duration: MIN_DATA_SECONDS }), layout), 'not-enough-data'), undefined);
});

test('while the warm-up is running nothing is analysed, however long the window already is', () => {
  const layout = standardPlant();
  const report = healthyReport(layout, { duration: 3000 });
  report.window.warmingUp = true;
  Object.assign(report.stations.C, { utilization: 0.99, avgIn: 8 }); // a cold plant looks broken: queues build, nothing has arrived yet
  report.throughput.total = 0;
  const list = generateInsights(report, layout);
  assert.deepEqual(ids(list), ['not-enough-data']);
  assert.equal(list[0].severity, 'info');
  assert.match(list[0].detail, /warm-up period/);
  assert.match(list[0].suggestion, /until the warm-up is over/);
  report.window.warmingUp = false;
  assert.deepEqual(ids(generateInsights(report, layout)), ['bottleneck:C', 'no-output'], 'the same numbers after the warm-up are real findings');
});

test('a healthy plant yields exactly one good insight that quotes the headline numbers', () => {
  const layout = standardPlant();
  const list = generateInsights(healthyReport(layout), layout);
  assert.equal(list.length, 1);
  const [good] = list;
  assert.equal(good.id, 'good');
  assert.equal(good.severity, 'good');
  assert.match(good.detail, /120 loads per hour/);
  assert.match(good.detail, /mean lead time of 10 min/);
  assert.match(good.detail, /busy 50 % of the time/);
  assert.ok(good.suggestion);
});

test('good is also shown next to info-level hints, but never next to a warning or critical insight', () => {
  const layout = standardPlant();
  const withInfo = insightsAfter(layout, (r) => { r.fleets.v1.utilization = 0.2; });
  assert.deepEqual(ids(withInfo), ['fleet-oversized:v1', 'good']);
  const withWarning = insightsAfter(layout, (r) => { r.traffic.waitShare = 0.15; });
  assert.equal(find(withWarning, 'good'), undefined);
});

test('a plant that delivered nothing is flagged instead of being called good', () => {
  const layout = standardPlant();
  const list = insightsAfter(layout, (r) => { r.throughput.total = 0; r.throughput.perHour = 0; });
  assert.deepEqual(ids(list), ['no-output']);
  assert.equal(list[0].severity, 'warning');
});

// ---- bottleneck -------------------------------------------------------------------------------------------------

test('bottleneck: busy workstation with a long queue in front of it', () => {
  const layout = standardPlant();
  const list = insightsAfter(layout, (r) => { Object.assign(r.stations.C, { utilization: 0.96, avgIn: 8, maxIn: 12 }); });
  const b = find(list, 'bottleneck:C');
  assert.equal(b.title, 'Final assembly is the bottleneck: busy 96 % of the time while 8 loads wait in front of it.');
  assert.equal(b.severity, 'warning');
  assert.deepEqual(b.refs, { stationIds: ['C'] });
  assert.match(b.detail, /at most 12/);
  assert.equal(b.suggestion, 'Add a machine to Final assembly (now 1), which would bring its load down to about 48 %, or shorten its cycle time by about 12 %.');
});

test('bottleneck: critical from 97 % busy; the suggestion adapts to the machine count', () => {
  const layout = standardPlant({ params: { C: { machines: 3 } } });
  const list = insightsAfter(layout, (r) => { Object.assign(r.stations.C, { utilization: 0.98, avgIn: 6 }); });
  const b = find(list, 'bottleneck:C');
  assert.equal(b.severity, 'critical');
  assert.match(b.suggestion, /\(now 3\).*about 74 %/);
});

test('bottleneck: time lost to breakdowns counts as load, so a failure-prone saturated machine is found', () => {
  const layout = standardPlant();
  const list = insightsAfter(layout, (r) => { Object.assign(r.stations.B, { utilization: 0.75, down: 0.2, avgIn: 5, breakdowns: 6 }); });
  const b = find(list, 'bottleneck:B');
  assert.equal(b.title, 'Press is the bottleneck: busy 75 % and broken down 20 % of the time while 5 loads wait in front of it.');
  assert.match(b.suggestion, /about 48 %/, '95 % load shared by two machines');
  assert.ok(find(list, 'breakdowns:B'), 'the cause is reported next to the effect');
  const idle = insightsAfter(layout, (r) => { Object.assign(r.stations.B, { utilization: 0.7, down: 0.1, avgIn: 5 }); });
  assert.equal(find(idle, 'bottleneck:B'), undefined, '80 % of the time is not saturation');
  const starvedAfter = find(insightsAfter(layout, (r) => { Object.assign(r.stations.B, { utilization: 0.75, down: 0.2 }); r.stations.C.starved = 0.5; }), 'starved:C');
  assert.match(starvedAfter.suggestion, /^Fix Press first \(busy 75 %, broken down 20 %\)/);
});

test('bottleneck: needs both a high load and a queue or a starved successor', () => {
  const layout = standardPlant();
  const noQueue = insightsAfter(layout, (r) => { r.stations.C.utilization = 0.96; });
  assert.equal(find(noQueue, 'bottleneck:C'), undefined, 'busy but nothing waits and nobody starves');
  const notBusy = insightsAfter(layout, (r) => { Object.assign(r.stations.C, { utilization: 0.85, avgIn: 8 }); });
  assert.equal(find(notBusy, 'bottleneck:C'), undefined, 'a long queue at a station that is not saturated');
});

test('bottleneck: the queue must be longer than the average workstation queue', () => {
  const layout = standardPlant();
  const list = insightsAfter(layout, (r) => {
    Object.assign(r.stations.B, { utilization: 0.95, avgIn: 2 });
    Object.assign(r.stations.C, { utilization: 0.95, avgIn: 8 });
  });
  assert.deepEqual(ids(list).filter((i) => i.startsWith('bottleneck')), ['bottleneck:C']);
});

test('bottleneck: a starved successor counts, even behind a buffer', () => {
  const layout = bufferedLayout();
  const list = insightsAfter(layout, (r) => {
    r.stations.B.utilization = 0.95;
    r.stations.C.starved = 0.4;
  });
  const b = find(list, 'bottleneck:B');
  assert.equal(b.title, 'Press is the bottleneck: busy 95 % of the time and Final assembly downstream is starved 40 % of the time.');
  const mild = insightsAfter(layout, (r) => { r.stations.B.utilization = 0.95; r.stations.C.starved = 0.15; });
  assert.equal(find(mild, 'bottleneck:B'), undefined);
});

// ---- blocked, starved, buffers, supply --------------------------------------------------------------------------

test('blocked workstation: fires from 20 % and points at the flow that has loads waiting for a vehicle', () => {
  const layout = standardPlant();
  const list = insightsAfter(layout, (r) => { r.stations.B.blocked = 0.25; r.flows.f3.avgBacklog = 4; });
  const b = find(list, 'blocked:B');
  assert.equal(b.title, 'Press is blocked 25 % of the time: its finished loads are not taken away fast enough.');
  assert.equal(b.severity, 'warning');
  assert.equal(b.suggestion, 'On average 4 loads wait at Press for a vehicle, although the vehicles have time to spare: check the room at Final assembly, the minimum batch of the flow Press to Final assembly and that its vehicles can reach both docks.');
  assert.deepEqual(b.refs, { stationIds: ['B'], flowIds: ['f3'] });
  assert.equal(find(insightsAfter(layout, (r) => { r.stations.B.blocked = 0.45; }), 'blocked:B').severity, 'critical');
  assert.equal(find(insightsAfter(layout, (r) => { r.stations.B.blocked = 0.19; }), 'blocked:B'), undefined);
  assert.match(find(insightsAfter(layout, (r) => { r.stations.B.blocked = 0.25; }), 'blocked:B').suggestion, /^Final assembly cannot take the loads fast enough/);
  const busy = find(insightsAfter(layout, (r) => {
    r.stations.B.blocked = 0.25;
    r.flows.f3.avgBacklog = 4;
    r.fleets.v1.utilization = 0.9;
    r.fleets.v2.utilization = 0.9;
  }), 'blocked:B');
  assert.equal(busy.suggestion, 'On average 4 loads wait at Press for a vehicle and every vehicle that may serve the flow is busy: add a vehicle or raise the priority of the flow Press to Final assembly.');
});

test('starved workstation: info from 30 %; a warning from 50 % only when loads wait to be moved to it, unless an upstream bottleneck explains it', () => {
  const layout = standardPlant();
  const info = find(insightsAfter(layout, (r) => { r.stations.C.starved = 0.4; }), 'starved:C');
  assert.equal(info.title, 'Final assembly waits for input 40 % of the time.');
  assert.equal(info.severity, 'info');
  assert.equal(find(insightsAfter(layout, (r) => { r.stations.C.starved = 0.29; }), 'starved:C'), undefined);
  const supplyLimited = find(insightsAfter(layout, (r) => { r.stations.C.starved = 0.6; }), 'starved:C');
  assert.equal(supplyLimited.severity, 'info', 'a machine that is simply fed less than it could do is spare capacity, not a fault');
  assert.equal(find(insightsAfter(layout, (r) => { r.stations.C.starved = 0.6; r.flows.f3.avgBacklog = 3; }), 'starved:C').severity, 'warning', 'ready loads wait to be moved to it');
  assert.equal(find(insightsAfter(layout, (r) => { r.stations.C.starved = 0.4; r.flows.f3.avgBacklog = 3; }), 'starved:C').severity, 'info');

  const explained = insightsAfter(layout, (r) => { r.stations.C.starved = 0.6; r.flows.f3.avgBacklog = 3; r.stations.B.utilization = 0.95; });
  const s = find(explained, 'starved:C');
  assert.equal(s.severity, 'info', 'the cause is upstream and already reported');
  assert.match(s.suggestion, /^Fix Press first \(busy 95 %\)/);
  assert.deepEqual(s.refs.stationIds, ['C', 'B']);
});

test('starved workstation: suggestion names the transport backlog or the slow source', () => {
  const layout = standardPlant();
  const transport = find(insightsAfter(layout, (r) => { r.stations.C.starved = 0.5; r.flows.f3.avgBacklog = 3; }), 'starved:C');
  assert.match(transport.suggestion, /^On average 3 loads wait at Press for a vehicle/);
  assert.deepEqual(transport.refs.flowIds, ['f3']);
  const line = lineLayout();
  const source = find(insightsAfter(line, (r) => { r.stations.B.starved = 0.5; }), 'starved:B');
  assert.match(source.suggestion, /^Goods in delivers too slowly/);
  const generic = find(insightsAfter(layout, (r) => { r.stations.C.starved = 0.5; }), 'starved:C');
  assert.match(generic.suggestion, /^Check the supply into Final assembly/);
});

test('buffer: fires on high average fill or time spent completely full', () => {
  const layout = standardPlant();
  const avg = find(insightsAfter(layout, (r) => { Object.assign(r.stations.S, { avgFill: 0.85, maxFill: 0.9 }); }), 'buffer-full:S');
  assert.equal(avg.title, 'Supermarket is nearly full: 85 % on average, peaking at 90 %.');
  assert.equal(avg.severity, 'warning');
  assert.match(avg.suggestion, /from 20 to 30 loads/);
  const full = find(insightsAfter(layout, (r) => { Object.assign(r.stations.S, { avgFill: 0.6, blocked: 0.15 }); }), 'buffer-full:S');
  assert.match(full.title, /completely full 15 % of the time/);
  assert.equal(find(insightsAfter(layout, (r) => { Object.assign(r.stations.S, { avgFill: 0.6, blocked: 0.35 }); }), 'buffer-full:S').severity, 'critical');
  assert.equal(find(insightsAfter(layout, (r) => { Object.assign(r.stations.S, { avgFill: 0.79, blocked: 0.09 }); }), 'buffer-full:S'), undefined);
});

test('supply: a source whose output is blocked and whose yard keeps growing', () => {
  const layout = lineLayout();
  const makeSupply = (r) => { Object.assign(r.stations.A, { blocked: 0.5, utilization: 0.5, yardNow: 12, yardMax: 14 }); };
  const base = find(insightsAfter(layout, makeSupply), 'supply:A');
  assert.equal(base.title, 'Goods in delivers more than the plant takes: 12 loads are piling up in its yard.');
  assert.equal(base.severity, 'warning');
  assert.match(base.detail, /full 50 % of the time.*peaked at 14 loads and stands at 12 now/);
  assert.match(base.suggestion, /^Slow the supply down/);

  const busyNext = find(insightsAfter(layout, (r) => { makeSupply(r); r.stations.B.utilization = 0.98; }), 'supply:A');
  assert.match(busyNext.suggestion, /^Add capacity at Press \(busy 98 %\)/);
  const transport = find(insightsAfter(layout, (r) => { makeSupply(r); r.flows.f1.avgBacklog = 4; }), 'supply:A');
  assert.match(transport.suggestion, /^On average 4 loads wait at Goods in for a vehicle, although the vehicles have time to spare/);
  const busy = find(insightsAfter(layout, (r) => { makeSupply(r); r.flows.f1.avgBacklog = 4; r.fleets.v1.utilization = 0.92; }), 'supply:A');
  assert.match(busy.suggestion, /every vehicle that may serve the flow is busy: add a vehicle or raise the priority of the flow Goods in to Press/);

  assert.equal(find(insightsAfter(layout, (r) => { makeSupply(r); r.stations.A.yardNow = 40; }), 'supply:A').severity, 'critical');
  assert.equal(find(insightsAfter(layout, (r) => { makeSupply(r); r.stations.A.blocked = 0.1; }), 'supply:A'), undefined);
  assert.equal(find(insightsAfter(layout, (r) => { makeSupply(r); r.stations.A.yardNow = 2; }), 'supply:A'), undefined);
});

// ---- transport verdict: one statement about vehicles per flow ----------------------------------------------------

/** A report where 4 loads wait on average at Press (flow f3) and Press is blocked, so `blocked:B` carries the transport advice. */
function waitingAtPress(layout, mutate = () => {}) {
  return find(insightsAfter(layout, (r) => {
    r.stations.B.blocked = 0.3;
    r.flows.f3.avgBacklog = 4;
    mutate(r);
  }), 'blocked:B').suggestion;
}

test('transport advice: "add a vehicle" only when every fleet that may serve the flow is busy and traffic is calm', () => {
  const layout = standardPlant();
  const busy = (r) => { r.fleets.v1.utilization = 0.9; r.fleets.v2.utilization = 0.9; };
  assert.match(waitingAtPress(layout, busy), /every vehicle that may serve the flow is busy: add a vehicle or raise the priority/);
  assert.match(waitingAtPress(layout, (r) => { busy(r); r.fleets.v2.utilization = 0.4; }), /although the vehicles have time to spare: check the room at Final assembly/, 'one free fleet is enough');
  assert.match(waitingAtPress(layout), /although the vehicles have time to spare/);

  const restricted = standardPlant();
  restricted.flows.find((f) => f.id === 'f3').fleetId = 'v1';
  assert.match(waitingAtPress(restricted, (r) => { r.fleets.v1.utilization = 0.9; }), /add a vehicle or raise the priority/, 'only the fleet that may serve the flow counts');
});

test('transport advice: congested traffic is answered with "relieve the congestion", never with more vehicles', () => {
  const layout = standardPlant();
  const spots = [{ node: 29, cx: 12, cy: 1, wait: 300 }];
  const plantWide = waitingAtPress(layout, (r) => { r.fleets.v1.utilization = 0.9; r.fleets.v2.utilization = 0.9; r.traffic.waitShare = 0.2; r.traffic.hotspots = spots; });
  assert.equal(plantWide, 'On average 4 loads wait at Press for a vehicle, but congestion holds the vehicles up around (12, 1): relieve the traffic before adding vehicles.');
  const ownFleet = waitingAtPress(layout, (r) => { r.fleets.v1.utilization = 0.9; r.fleets.v1.shares.waiting = 0.2; });
  assert.match(ownFleet, /^On average 4 loads wait at Press for a vehicle, but congestion holds the vehicles up: relieve/, 'the fleet itself loses 36 % of its driving time');
  assert.doesNotMatch(plantWide + ownFleet, /add a vehicle/);
});

test('transport advice: a flow that no vehicle may serve says so', () => {
  const noFleet = standardPlant({ fleets: [] });
  assert.match(waitingAtPress(noFleet), /^No vehicle may serve the flow Press to Final assembly: add a fleet or remove the fleet restriction/);
  const emptyFleet = standardPlant({ fleets: [{ count: 0 }] });
  assert.match(waitingAtPress(emptyFleet), /^No vehicle may serve the flow/);
  const wrongFleet = standardPlant();
  wrongFleet.flows.find((f) => f.id === 'f3').fleetId = 'v9';
  assert.match(waitingAtPress(wrongFleet), /^No vehicle may serve the flow/);
});

test('waiting loads are judged on the window average, not on the instantaneous backlog', () => {
  const layout = standardPlant();
  const instant = insightsAfter(layout, (r) => { r.stations.B.blocked = 0.3; r.flows.f3.backlog = 9; r.stations.C.starved = 0.6; });
  assert.match(find(instant, 'blocked:B').suggestion, /^Final assembly cannot take the loads fast enough/);
  assert.match(find(instant, 'starved:C').suggestion, /^Check the supply into Final assembly/);
  assert.equal(find(instant, 'starved:C').severity, 'info');
  const below = insightsAfter(layout, (r) => { r.stations.B.blocked = 0.3; r.flows.f3.avgBacklog = 0.9; });
  assert.match(find(below, 'blocked:B').suggestion, /^Final assembly cannot take/, 'less than one waiting load on average is no transport problem');
  const hostile = insightsAfter(layout, (r) => { r.stations.B.blocked = 0.3; r.flows.f3.avgBacklog = NaN; });
  assert.match(find(hostile, 'blocked:B').suggestion, /^Final assembly cannot take/);
});

// ---- fleets -----------------------------------------------------------------------------------------------------

test('saturated fleet: busy fleets get a concrete vehicle count', () => {
  const layout = standardPlant();
  const f = find(insightsAfter(layout, (r) => { r.fleets.v1.utilization = 0.92; }), 'fleet-saturated:v1');
  assert.equal(f.title, 'AGV fleet is saturated: its 3 vehicles are busy 92 % of the time.');
  assert.equal(f.severity, 'warning');
  assert.match(f.suggestion, /^Add 1 vehicle to the AGV fleet \(now 3\).*about 69 %/);
  assert.deepEqual(f.refs, { fleetIds: ['v1'] });
  assert.equal(find(insightsAfter(layout, (r) => { r.fleets.v1.utilization = 0.96; }), 'fleet-saturated:v1').severity, 'critical');
  assert.equal(find(insightsAfter(layout, (r) => { r.fleets.v1.utilization = 0.84; }), 'fleet-saturated:v1'), undefined);
});

test('saturated fleet: a long pickup wait counts when the fleet is reasonably busy, not when it is batching', () => {
  const layout = standardPlant();
  const slow = find(insightsAfter(layout, (r) => { Object.assign(r.fleets.v1, { utilization: 0.7, avgPickupWait: 200 }); }), 'fleet-saturated:v1');
  assert.match(slow.title, /busy 70 % of the time, and loads wait 3\.3 min for a pickup\.$/);
  assert.equal(find(insightsAfter(layout, (r) => { Object.assign(r.fleets.v1, { utilization: 0.5, avgPickupWait: 200 }); }), 'fleet-saturated:v1'), undefined);
  assert.equal(find(insightsAfter(layout, (r) => { Object.assign(r.fleets.v1, { utilization: 0.8, avgPickupWait: 100 }); }), 'fleet-saturated:v1'), undefined);
  assert.equal(find(insightsAfter(layout, (r) => { Object.assign(r.fleets.v1, { utilization: 0.99, count: 0 }); }), 'fleet-saturated:v1'), undefined, 'an empty fleet is not saturated');
});

test('saturated fleet: when much of the busy time is traffic, the advice is to fix the congestion first', () => {
  const layout = standardPlant();
  const list = insightsAfter(layout, (r) => {
    r.fleets.v1.utilization = 0.9;
    r.fleets.v1.shares.waiting = 0.3;
    r.traffic.hotspots = [{ node: 29, cx: 12, cy: 1, wait: 300 }];
  });
  assert.match(find(list, 'fleet-saturated:v1').suggestion, /before buying more vehicles/);
  assert.match(find(list, 'fleet-saturated:v1').suggestion, /around \(12, 1\)/);
});

test('saturated fleet: a long pickup wait is not blamed on the fleet when the destination has no room', () => {
  const layout = standardPlant();
  const slow = (r) => {
    Object.assign(r.fleets.v1, { utilization: 0.75, avgPickupWait: 231 });
    r.flows.f3.avgPickupWait = 400; // Press -> Final assembly
    r.flows.f1.avgPickupWait = 60;
  };
  assert.ok(find(insightsAfter(layout, slow), 'fleet-saturated:v1'), 'guard: nothing is wrong at the destinations, the fleet is the limit');
  const withBottleneck = insightsAfter(layout, (r) => { slow(r); Object.assign(r.stations.C, { utilization: 0.97, avgIn: 6 }); });
  assert.ok(find(withBottleneck, 'bottleneck:C'), 'precondition: Final assembly is the bottleneck');
  assert.equal(find(withBottleneck, 'fleet-saturated:v1'), undefined, 'the loads wait for room at Final assembly (the other flows wait 20-60 s)');
  const fullBuffer = insightsAfter(layout, (r) => { slow(r); r.flows.f3.avgPickupWait = 60; r.flows.f1.avgPickupWait = 400; Object.assign(r.stations.S, { avgFill: 0.9, blocked: 0.2 }); });
  assert.equal(find(fullBuffer, 'fleet-saturated:v1'), undefined, 'a full buffer is a destination without room, too');
  const mixed = insightsAfter(layout, (r) => {
    slow(r);
    r.flows.f1.avgPickupWait = 40;
    r.flows.f2.avgPickupWait = 380; // Supermarket -> Press: a destination with room
    Object.assign(r.stations.C, { utilization: 0.97, avgIn: 6 });
  });
  // f3 (400 s) is left out; the other flows have 40, 380 and 20 s: 146.7 s on average
  assert.match(find(mixed, 'fleet-saturated:v1').title, /loads wait 2\.4 min for a pickup/, 'the wait that remains comes from flows with free destinations only');
  const everything = standardPlant({ fleets: [{ count: 3 }] });
  const blockedAll = insightsAfter(everything, (r) => {
    Object.assign(r.fleets.v1, { utilization: 0.75, avgPickupWait: 300 });
    for (const id of ['B', 'C']) Object.assign(r.stations[id], { utilization: 0.97, avgIn: 6 });
    Object.assign(r.stations.S, { avgFill: 0.9 });
  });
  assert.equal(find(blockedAll, 'fleet-saturated:v1'), undefined, 'nothing is left to judge: no verdict on the fleet');
});

test('saturated fleet: when traffic is congested the advice is to relieve it, also when only the plant as a whole is affected', () => {
  const layout = standardPlant();
  const plant = find(insightsAfter(layout, (r) => {
    r.fleets.v1.utilization = 0.9;
    r.traffic.waitShare = 0.17;
    r.traffic.hotspots = [{ node: 29, cx: 12, cy: 1, wait: 300 }];
  }), 'fleet-saturated:v1');
  assert.equal(plant.suggestion, 'Traffic costs 17 % of the driving time across the plant: relieve the congestion around (12, 1) before buying more vehicles.');
  const consistent = find(insightsAfter(layout, (r) => {
    // driving 50 %, waiting 10 %: the same 17 % of the driving time that the traffic rule sees
    r.fleets.v1.utilization = 0.9;
    Object.assign(r.fleets.v1.shares, { driving: 0.5, waiting: 0.1, loading: 0.15, unloading: 0.15, idle: 0.1, parked: 0 });
  }), 'fleet-saturated:v1');
  assert.match(consistent.suggestion, /^A lot of the busy time is spent waiting in traffic \(10 % of the fleet's time\)/);
});

test('oversized fleet: charging and broken time is not idle time, and loads that wait are not a matter of fleet size', () => {
  const layout = standardPlant();
  const oversized = (mutate) => find(insightsAfter(layout, mutate), 'fleet-oversized:v1');
  const charging = (r) => {
    Object.assign(r.fleets.v1, { utilization: 0.27 });
    Object.assign(r.fleets.v1.shares, { driving: 0.2, waiting: 0.01, loading: 0.03, unloading: 0.03, idle: 0, parked: 0.41, charging: 0.32, broken: 0 });
  };
  assert.equal(oversized(charging), undefined, '0.27 of the 0.68 that the vehicles could work is 40 %');
  assert.ok(oversized((r) => { charging(r); r.fleets.v1.utilization = 0.2; }), 'guard: 0.2 of 0.68 is 29 %');
  assert.equal(oversized((r) => { r.fleets.v1.utilization = 0.2; r.flows.f3.avgBacklog = 2; }), undefined, 'loads wait although vehicles are free');
  assert.ok(oversized((r) => { r.fleets.v1.utilization = 0.2; r.flows.f3.avgBacklog = 0.5; }), 'less than a load on average does not count');
  const restricted = standardPlant();
  restricted.flows.find((f) => f.id === 'f3').fleetId = 'v2';
  assert.ok(find(insightsAfter(restricted, (r) => { r.fleets.v1.utilization = 0.2; r.flows.f3.avgBacklog = 2; }), 'fleet-oversized:v1'), 'loads of a flow this fleet may not serve do not count');
  const unused = oversized((r) => { r.fleets.v1.utilization = 0.01; r.flows.f1.avgBacklog = 5; });
  assert.match(unused.suggestion, /^None of the 3 AGV vehicles did any real work/, 'an unused fleet is always reported');
});

test('unplaced vehicles: a warning that the simulated fleet is smaller than the planned one', () => {
  const layout = standardPlant();
  const list = insightsAfter(layout, (r) => { r.fleets.v1.unplaced = 2; });
  const u = find(list, 'unplaced:v1');
  assert.equal(u.title, 'AGV fleet: 2 vehicles of 5 did not fit on the road and are not simulated.');
  assert.equal(u.severity, 'warning');
  assert.deepEqual(u.refs, { fleetIds: ['v1'] });
  assert.match(u.detail, /runs with 3 instead of 5 AGV vehicles/);
  assert.match(u.suggestion, /Add road length or a depot.*to 3\.$/);
  assert.equal(find(list, 'good'), undefined, 'a plant with missing vehicles is not "good"');
  assert.equal(find(insightsAfter(layout, (r) => { r.fleets.v1.unplaced = 1; }), 'unplaced:v1').title, 'AGV fleet: 1 vehicle of 4 did not fit on the road and is not simulated.');
  assert.equal(find(insightsAfter(layout, (r) => { r.fleets.v1.unplaced = 0; }), 'unplaced:v1'), undefined);
  assert.equal(find(insightsAfter(layout, () => {}), 'unplaced:v1'), undefined, 'reports without the field stay silent');
});

test('oversized fleet: info below 35 % utilization with at least two vehicles', () => {
  const layout = standardPlant();
  const f = find(insightsAfter(layout, (r) => { r.fleets.v1.utilization = 0.2; }), 'fleet-oversized:v1');
  assert.equal(f.title, 'AGV fleet is mostly idle: its 3 vehicles work only 20 % of the time.');
  assert.equal(f.severity, 'info');
  assert.match(f.suggestion, /^Try 1 vehicle instead of 3: utilization would rise to about 60 %/);
  assert.equal(find(insightsAfter(layout, (r) => { r.fleets.v1.utilization = 0.36; }), 'fleet-oversized:v1'), undefined);
  assert.match(find(insightsAfter(layout, (r) => { r.fleets.v1.utilization = 0.01; }), 'fleet-oversized:v1').suggestion, /^None of the 3 AGV vehicles did any real work/);
  const single = standardPlant({ fleets: [{ count: 1 }] });
  assert.equal(find(insightsAfter(single, (r) => { r.fleets.v1.utilization = 0.05; }), 'fleet-oversized:v1'), undefined);
});

test('empty driving: more than 60 % of the distance without a load, after enough trips, while the vehicles are busy', () => {
  const layout = standardPlant();
  const busy = (r, share = 0.7) => { r.fleets.v1.emptyShare = share; r.fleets.v1.utilization = 0.7; };
  const e = find(insightsAfter(layout, (r) => busy(r)), 'empty-driving:v1');
  assert.equal(e.title, 'AGV vehicles drive empty 70 % of the distance.');
  assert.equal(e.severity, 'info');
  assert.match(e.detail, /1\.4 km were without a load/);
  assert.match(e.detail, /busy 70 % of the time/);
  assert.match(e.suggestion, /^Place pickup and drop stations so a vehicle can return with a load/, 'an AGV carries one load: no point in "carry more"');
  const tugger = standardPlant({ fleets: [{ count: 3, preset: 'tugger' }, { count: 2, preset: 'forklift' }] });
  assert.match(find(insightsAfter(tugger, (r) => busy(r)), 'empty-driving:v1').suggestion, /carry more per trip/);
  const oldest = standardPlant({ settings: { dispatch: 'oldest' } });
  assert.match(find(insightsAfter(oldest, (r) => busy(r)), 'empty-driving:v1').suggestion, /Nearest job first/);
  assert.equal(find(insightsAfter(layout, (r) => busy(r, 0.6)), 'empty-driving:v1'), undefined);
  assert.equal(find(insightsAfter(layout, (r) => { busy(r, 0.9); r.fleets.v1.trips = 4; }), 'empty-driving:v1'), undefined);
  assert.equal(find(insightsAfter(layout, (r) => busy(r, null)), 'empty-driving:v1'), undefined);
  assert.equal(find(insightsAfter(layout, (r) => { busy(r, 0.9); r.fleets.v1.utilization = 0.4; }), 'empty-driving:v1'), undefined, 'idle vehicles can afford to drive empty');
});

test('battery: ran flat is critical, a deep dip a warning, heavy charging a hint', () => {
  const layout = standardPlant({ fleets: [{ count: 3, battery: { enabled: true, lowPct: 25 }, home: 'E' }, { count: 2, preset: 'forklift' }] });
  const dead = find(insightsAfter(layout, (r) => { r.fleets.v1.minBattery = 0; }), 'battery:v1');
  assert.equal(dead.severity, 'critical');
  assert.equal(dead.title, 'AGV vehicles ran out of battery: at least one stopped on the road.');
  assert.match(dead.suggestion, /from 25 % to 40 %.*add a charger at Charging bay \(now 1\)/);
  assert.deepEqual(dead.refs, { fleetIds: ['v1'], stationIds: ['E'] });

  const low = find(insightsAfter(layout, (r) => { r.fleets.v1.minBattery = 0.07; }), 'battery:v1');
  assert.equal(low.severity, 'warning');
  assert.equal(low.title, 'AGV battery dropped to 7 %: vehicles come close to running empty.');

  const charging = find(insightsAfter(layout, (r) => { Object.assign(r.fleets.v1.shares, { charging: 0.3, idle: 0, parked: 0.2 }); }), 'battery:v1');
  assert.equal(charging.severity, 'info');
  assert.equal(charging.title, 'AGV vehicles spend 30 % of their time charging.');

  assert.equal(find(insightsAfter(layout, (r) => { r.fleets.v1.minBattery = 0.5; }), 'battery:v1'), undefined);
  assert.equal(find(insightsAfter(layout, (r) => { r.fleets.v2.minBattery = null; }), 'battery:v2'), undefined, 'no battery model, nothing to report');
});

test('battery: without a charging depot the advice is to add one', () => {
  const layout = standardPlant({ fleets: [{ count: 3, battery: { enabled: true } }], params: { E: { chargers: 0 } } });
  const dead = find(insightsAfter(layout, (r) => { r.fleets.v1.minBattery = 0; }), 'battery:v1');
  assert.match(dead.suggestion, /add a depot with chargers\.$/);
  assert.deepEqual(dead.refs, { fleetIds: ['v1'] });
});

test('breakdowns: workstations need repeated outages and a noticeable downtime', () => {
  const layout = standardPlant();
  const info = find(insightsAfter(layout, (r) => { Object.assign(r.stations.B, { breakdowns: 3, down: 0.06 }); }), 'breakdowns:B');
  assert.equal(info.title, 'Press broke down 3 times and was out of service 6 % of the time.');
  assert.equal(info.severity, 'info');
  assert.match(info.suggestion, /^Add a second machine at Press/);
  assert.equal(find(insightsAfter(layout, (r) => { Object.assign(r.stations.B, { breakdowns: 3, down: 0.12 }); }), 'breakdowns:B').severity, 'warning');
  assert.equal(find(insightsAfter(layout, (r) => { Object.assign(r.stations.B, { breakdowns: 1, down: 0.3 }); }), 'breakdowns:B'), undefined);
  assert.equal(find(insightsAfter(layout, (r) => { Object.assign(r.stations.B, { breakdowns: 5, down: 0.04 }); }), 'breakdowns:B'), undefined);
  const twin = standardPlant({ params: { B: { machines: 2, mttr: 1200 } } });
  assert.match(find(insightsAfter(twin, (r) => { Object.assign(r.stations.B, { breakdowns: 3, down: 0.06 }); }), 'breakdowns:B').suggestion, /Cut the mean repair time of Press \(now 20 min\)/);
});

test('breakdowns: vehicles broken for 5 % of the time or more', () => {
  const layout = standardPlant();
  const v = find(insightsAfter(layout, (r) => { Object.assign(r.fleets.v1.shares, { broken: 0.08, idle: 0.22 }); r.traffic.brokenWait = 120; }), 'breakdowns:v1');
  assert.equal(v.title, 'AGV vehicles are broken down 8 % of the time.');
  assert.equal(v.severity, 'info');
  assert.match(v.detail, /2 min in total waiting behind broken ones/);
  assert.equal(find(insightsAfter(layout, (r) => { Object.assign(r.fleets.v1.shares, { broken: 0.12, idle: 0.18 }); }), 'breakdowns:v1').severity, 'warning');
  assert.equal(find(insightsAfter(layout, (r) => { Object.assign(r.fleets.v1.shares, { broken: 0.04, idle: 0.26 }); }), 'breakdowns:v1'), undefined);
});

test('breakdowns: a spare vehicle is only recommended when it can help', () => {
  const layout = standardPlant();
  const broken = (r) => { Object.assign(r.fleets.v1.shares, { broken: 0.08, idle: 0.22 }); };
  assert.match(find(insightsAfter(layout, broken), 'breakdowns:v1').suggestion, /^Add a spare vehicle to the fleet \(now 3\)/);
  const idleFleet = find(insightsAfter(layout, (r) => { broken(r); r.fleets.v1.utilization = 0.2; }), 'breakdowns:v1');
  assert.match(idleFleet.suggestion, /^Reduce the downtime/, 'a mostly idle fleet has spare vehicles already');
  const jam = find(insightsAfter(layout, (r) => { broken(r); r.traffic.waitShare = 0.2; }), 'breakdowns:v1');
  assert.match(jam.suggestion, /^Reduce the downtime/, 'more vehicles in a congested plant make it worse');
});

test('no rule tells the planner to add vehicles while another tells them to use fewer, across a grid of plausible reports', () => {
  const add = /\badd (?:a |an |[\d.]+ )?(?:spare )?vehicles?\b/i;
  const cut = /reduce the number of vehicles|fewer vehicles|try [\d.]+ vehicles? instead/i;
  const layout = standardPlant();
  for (const flow of layout.flows) flow.fleetId = 'v1'; // one fleet decides everything; the forklifts stay healthy
  let reports = 0;
  for (const utilization of [0.15, 0.3, 0.6, 0.9]) for (const charging of [0, 0.3]) for (const waiting of [0.02, 0.15]) {
    for (const plantWait of [0.02, 0.2]) for (const avgBacklog of [0, 3]) for (const broken of [0, 0.08]) for (const wait of [30, 200]) {
      reports++;
      const list = insightsAfter(layout, (r) => {
        const idle = Math.max(0, 1 - utilization - charging - broken);
        Object.assign(r.fleets.v1, { utilization, avgPickupWait: wait });
        Object.assign(r.fleets.v1.shares, { driving: utilization * 0.7, waiting: waiting * utilization, loading: utilization * 0.15, unloading: utilization * 0.15, idle, parked: 0, charging, broken });
        Object.assign(r.stations.A, { blocked: 0.5, utilization: 0.5, yardNow: 8, yardMax: 8 });
        Object.assign(r.stations.B, { blocked: 0.3, starved: 0.3 });
        Object.assign(r.stations.C, { starved: 0.6 });
        r.traffic.waitShare = plantWait;
        r.flows.f1.avgBacklog = avgBacklog;
        r.flows.f3.avgBacklog = avgBacklog;
      });
      const adds = list.filter((i) => add.test(i.suggestion || '')).map((i) => i.id);
      const cuts = list.filter((i) => cut.test(i.suggestion || '')).map((i) => i.id);
      assert.ok(!(adds.length && cuts.length), `add [${adds}] vs fewer [${cuts}] at utilization ${utilization}, charging ${charging}, waiting ${waiting}, plant wait ${plantWait}, backlog ${avgBacklog}, broken ${broken}, pickup ${wait}`);
    }
  }
  assert.equal(reports, 4 * 2 * 2 * 2 * 2 * 2 * 2);
});

// ---- traffic and deadlocks ----------------------------------------------------------------------------------------

const congested = (r) => {
  Object.assign(r.traffic, {
    waitShare: 0.18, vehicleWait: 600, junctionWait: 200, brokenWait: 0,
    hotspots: [{ node: 29, cx: 12, cy: 1, wait: 250 }, { node: 30, cx: 13, cy: 1, wait: 120 }, { node: 31, cx: 14, cy: 1, wait: 60 }, { node: 32, cx: 15, cy: 1, wait: 30 }],
  });
};

test('traffic: waiting share of 12 % or more, with the worst cells named', () => {
  const layout = standardPlant();
  const t = find(insightsAfter(layout, congested), 'traffic');
  assert.equal(t.title, 'Traffic is costing time: vehicles spend 18 % of their driving time waiting.');
  assert.equal(t.severity, 'warning');
  assert.deepEqual(t.refs, { cells: [[12, 1], [13, 1], [14, 1]] });
  assert.match(t.detail, /75 % behind other vehicles, 25 % for junctions and 0 % behind broken-down vehicles/);
  assert.match(t.detail, /\(12, 1\) with 4\.2 min/);
  assert.match(t.suggestion, /Vehicles queue behind each other around \(12, 1\), \(13, 1\), \(14, 1\)/);
  assert.equal(find(insightsAfter(layout, (r) => { congested(r); r.traffic.waitShare = 0.3; }), 'traffic').severity, 'critical');
  assert.equal(find(insightsAfter(layout, (r) => { congested(r); r.traffic.waitShare = 0.11; }), 'traffic'), undefined);
});

test('traffic: the advice follows the dominant cause of the waiting', () => {
  const layout = standardPlant();
  const junctions = find(insightsAfter(layout, (r) => { congested(r); Object.assign(r.traffic, { vehicleWait: 100, junctionWait: 700 }); }), 'traffic');
  assert.match(junctions.suggestion, /^Most waiting happens at junctions around/);
  const broken = find(insightsAfter(layout, (r) => { congested(r); Object.assign(r.traffic, { vehicleWait: 100, junctionWait: 100, brokenWait: 700 }); }), 'traffic');
  assert.match(broken.suggestion, /^Broken-down vehicles block the aisle around/);
  const noSpots = find(insightsAfter(layout, (r) => { r.traffic.waitShare = 0.2; }), 'traffic');
  assert.deepEqual(noSpots.refs, {});
  assert.doesNotMatch(noSpots.suggestion, /around/);
});

test('deadlocks: counted, located, and critical only when a jam was left standing', () => {
  const layout = standardPlant(); // 17 columns: node 31 = cell (14, 1)
  const resolved = find(insightsAfter(layout, (r) => {
    r.traffic.deadlocks = 3;
    r.traffic.deadlockEvents = [{ t: 100, nodes: [31, 32], vehicles: ['v1#1', 'v1#2'], resolved: true }, { t: 900, nodes: [31], vehicles: ['v1#1'], resolved: true }];
  }), 'deadlocks');
  assert.equal(resolved.title, 'Vehicles blocked each other in a deadlock 3 times.');
  assert.equal(resolved.severity, 'warning');
  assert.deepEqual(resolved.refs, { cells: [[14, 1], [15, 1]] }, 'the most frequent node first');
  assert.match(resolved.detail, /moved one vehicle out of the way/);
  assert.match(resolved.suggestion, /^Break the circle around \(14, 1\), \(15, 1\)/);

  const standing = find(insightsAfter(layout, (r) => {
    r.traffic.deadlocks = 1;
    r.traffic.deadlockEvents = [{ t: 100, nodes: [31], vehicles: ['v1#1'], resolved: false }];
  }), 'deadlocks');
  assert.equal(standing.title, 'Vehicles blocked each other in a deadlock 1 time.');
  assert.equal(standing.severity, 'critical');
  assert.match(standing.detail, /never moved again/);
  assert.equal(find(insightsAfter(layout, () => {}), 'deadlocks'), undefined);
});

// ---- ordering, determinism, robustness -----------------------------------------------------------------------------

function messyReport(layout) {
  const r = healthyReport(layout);
  Object.assign(r.stations.C, { utilization: 0.99, avgIn: 8 }); // critical bottleneck, magnitude 0.99
  r.fleets.v1.utilization = 0.96; // critical, 0.96
  Object.assign(r.stations.S, { avgFill: 0.85, maxFill: 0.9 }); // warning, 0.85
  r.traffic.waitShare = 0.15; // warning, 0.15
  r.fleets.v2.utilization = 0.2; // info, 0.8
  Object.assign(r.stations.B, { breakdowns: 3, down: 0.06 }); // info, 0.06
  return r;
}

test('ordering: severity first, then magnitude, never good next to a warning', () => {
  const layout = standardPlant();
  const list = generateInsights(messyReport(layout), layout);
  assert.deepEqual(ids(list), ['bottleneck:C', 'fleet-saturated:v1', 'buffer-full:S', 'traffic', 'fleet-oversized:v2', 'breakdowns:B']);
  assert.deepEqual(list.map((i) => i.severity), ['critical', 'critical', 'warning', 'warning', 'info', 'info']);
});

test('ordering: equal magnitudes fall back to the id, so the result is deterministic', () => {
  const layout = standardPlant();
  const report = healthyReport(layout);
  report.fleets.v1.utilization = 0.9;
  report.fleets.v2.utilization = 0.9;
  report.fleets = { v2: report.fleets.v2, v1: report.fleets.v1 }; // insertion order must not decide
  const list = generateInsights(report, layout);
  assert.deepEqual(ids(list), ['fleet-saturated:v1', 'fleet-saturated:v2']);
  assert.deepEqual(generateInsights(report, layout), list);
  assert.deepEqual(generateInsights(structuredClone(report), structuredClone(layout)), list);
});

test('insight ids are unique and stable between runs; refs point at things that exist', () => {
  const layout = standardPlant();
  const list = generateInsights(messyReport(layout), layout);
  assert.equal(new Set(ids(list)).size, list.length);
  const stationIds = new Set(layout.stations.map((s) => s.id));
  const fleetIds = new Set(layout.fleets.map((f) => f.id));
  for (const i of list) {
    for (const id of i.refs.stationIds || []) assert.ok(stationIds.has(id), `${i.id}: station ${id}`);
    for (const id of i.refs.fleetIds || []) assert.ok(fleetIds.has(id), `${i.id}: fleet ${id}`);
  }
  assert.deepEqual(ids(generateInsights(messyReport(layout), layout)), ids(list));
});

test('texts are complete sentences without placeholders, and the result is plain JSON', () => {
  const layout = standardPlant({ fleets: [{ count: 3, battery: { enabled: true }, home: 'E' }, { count: 2, preset: 'forklift' }] });
  const report = messyReport(layout);
  congested(report);
  Object.assign(report.stations.A, { blocked: 0.5, yardNow: 30, yardMax: 31 });
  report.fleets.v1.minBattery = 0;
  report.traffic.deadlocks = 2;
  report.traffic.deadlockEvents = [{ t: 1, nodes: [31], vehicles: [], resolved: false }];
  const list = generateInsights(report, layout);
  assert.ok(list.length >= 8);
  for (const i of list) {
    for (const text of [i.title, i.detail, i.suggestion]) {
      assert.equal(typeof text, 'string', i.id);
      assert.ok(text.length > 10, i.id);
      assert.doesNotMatch(text, /NaN|undefined|Infinity|null|\[object|\$\{/, `${i.id}: ${text}`);
    }
    assert.match(i.title, /\.$/, `${i.id} title ends with a full stop`);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(list)), list);
});

test('generateInsights does not modify its inputs and tolerates a missing layout', () => {
  const layout = standardPlant();
  const report = messyReport(layout);
  const freeze = (o) => { Object.values(o).forEach((v) => v && typeof v === 'object' && freeze(v)); return Object.freeze(o); };
  freeze(report);
  freeze(layout);
  const list = generateInsights(report, layout);
  assert.ok(list.length > 0);
  assert.deepEqual(ids(generateInsights(report, null)), ids(list));
  assert.deepEqual(ids(generateInsights(report, undefined)), ids(list));
});

test('odd reports never throw: missing sections, NaN, null and empty plants', () => {
  assert.deepEqual(ids(generateInsights(null, null)), ['not-enough-data']);
  assert.deepEqual(ids(generateInsights({}, null)), ['not-enough-data']);
  assert.doesNotThrow(() => generateInsights({ window: { duration: 3000 } }, null));
  const list = generateInsights({ window: { duration: 3000 } }, standardPlant());
  assert.deepEqual(ids(list), ['no-output']);

  const layout = standardPlant();
  const hostile = healthyReport(layout);
  for (const s of Object.values(hostile.stations)) Object.assign(s, { utilization: NaN, starved: undefined, avgIn: Infinity, blocked: null });
  for (const f of Object.values(hostile.fleets)) Object.assign(f, { utilization: NaN, shares: undefined, emptyShare: NaN, avgPickupWait: NaN });
  hostile.traffic = { waitShare: NaN, hotspots: undefined };
  assert.doesNotThrow(() => generateInsights(hostile, layout));
  for (const i of generateInsights(hostile, layout)) assert.doesNotMatch(`${i.title} ${i.detail} ${i.suggestion}`, /NaN|undefined|Infinity/);

  const empty = layoutFromAscii(['........', '........']);
  const emptyReport = healthyReport({ ...empty, stations: [{ id: 'X', type: 'sink', name: 'X' }] });
  emptyReport.stations = {};
  emptyReport.fleets = {};
  emptyReport.flows = {};
  assert.doesNotThrow(() => generateInsights(emptyReport, empty));
});

// ---- end to end through the fake sim ---------------------------------------------------------------------------------

test('end to end: scripted sim -> Stats -> insights', () => {
  const layout = standardPlant();
  const sim = createFakeSim(layout);
  const stats = (sim.stats = new Stats(sim));
  sim.setMachines('B', ['busy']);
  sim.setMachines('C', ['busy']);
  sim.st('C').inCount = 8;
  for (const v of sim.vehicles.filter((x) => x.fleetId === 'v1')) v.state = 'toDrop';
  sim.advance(600, (s, i) => {
    if (i % 60 === 0) s.complete('D', 500);
    if (i % 10 === 0) s.addWait({ vehicle: 40, driving: 20, node: 31 });
    else s.addWait({ driving: 20 });
  });
  const list = generateInsights(stats.report(), layout);
  assert.deepEqual(ids(list), ['bottleneck:C', 'fleet-saturated:v1', 'traffic', 'fleet-oversized:v2']);
  assert.deepEqual(list.map((i) => i.severity), ['critical', 'critical', 'warning', 'info']);
  assert.equal(list[0].title, 'Final assembly is the bottleneck: busy 100 % of the time while 8 loads wait in front of it.');
  assert.deepEqual(find(list, 'traffic').refs, { cells: [[14, 1]] });
  assert.match(find(list, 'traffic').title, /vehicles spend 20 % of their driving time waiting/); // 2400 of 12000 vehicle-seconds
  assert.match(find(list, 'fleet-oversized:v2').suggestion, /^None of the 2 Forklift vehicles did any real work/);
  assert.deepEqual(ids(generateInsights(stats.report(), layout)), ids(list));
});
