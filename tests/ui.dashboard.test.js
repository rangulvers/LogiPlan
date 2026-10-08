// Pure view models of the Results dashboard (js/ui/dashboard.js): what the cards, tables and lists show for a KpiReport,
// and that no report - however broken - can make them throw or print "NaN" / "undefined" / "null".
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES } from '../js/model/examples.js';
import { Simulation } from '../js/sim/engine.js';
import { MIN_DATA_SECONDS } from '../js/sim/insights.js';
import { formatNumber, formatPercent } from '../js/util/format.js';
import {
  INSIGHTS_COLLAPSED, KPI_IDS, bottleneckIds, dataState, fleetModels, fleetUtilization, flowRows, focusTarget, hotspotRows, kpiModels,
  noticeModel, runStatus, sortStationRows, stationRows, trafficBreakdown, visibleInsights,
} from '../js/ui/dashboard.js';

const DASH = '–';
const win = (duration, warmingUp = false) => ({ start: 0, end: duration, duration, warmingUp });

/** A small hand-made report with round numbers. */
function report(overrides = {}) {
  return {
    window: win(3600),
    throughput: { total: 120, perHour: 120, bySink: {} },
    leadTime: { count: 120, mean: 750, min: 300, p50: 700, p90: 1000, p95: 1200, max: 1500 },
    wip: { mean: 14.2, max: 20, now: 16 },
    stations: {
      a: { type: 'source', name: 'Goods in', utilization: 1, starved: 0, blocked: 0, down: 0, avgIn: 0, maxIn: 0, avgOut: 2, maxOut: 6, avgFill: 0.3, maxFill: 1 },
      b: { type: 'process', name: 'Press', utilization: 0.92, starved: 0.03, blocked: 0.02, down: 0.03, avgIn: 3.4, maxIn: 8, avgOut: 0.5, maxOut: 2, avgFill: 0.4, maxFill: 1 },
      c: { type: 'process', name: 'Assembly', utilization: 0.55, starved: 0.4, blocked: 0, down: 0.05, avgIn: 0.2, maxIn: 2, avgOut: 0, maxOut: 1, avgFill: 0.1, maxFill: 0.5 },
      d: { type: 'storage', name: 'Supermarket', utilization: 0.35, starved: 0.1, blocked: 0, down: 0, avgIn: 0, maxIn: 0, avgOut: 14, maxOut: 30, avgFill: 0.35, maxFill: 0.7 },
      e: { type: 'sink', name: 'Shipping', utilization: 0, starved: 0, blocked: 0, down: 0, avgIn: 0, maxIn: 0, avgOut: 0, maxOut: 0, avgFill: 0, maxFill: 0 },
    },
    fleets: {
      v1: { name: 'AGV', count: 3, unplaced: 0, utilization: 0.6, shares: { driving: 0.4, waiting: 0.1, loading: 0.05, unloading: 0.05, idle: 0.2, parked: 0.2, charging: 0, broken: 0 }, trips: 60, tripsPerVehicleHour: 20, distance: 9000, distancePerVehicle: 3000, emptyShare: 0.45, avgPickupWait: 80, avgTransit: 50, minBattery: null },
      v2: { name: 'Forklift', count: 1, unplaced: 2, utilization: 0.9, shares: { driving: 0.5, waiting: 0.2, loading: 0.1, unloading: 0.1, idle: 0, parked: 0, charging: 0, broken: 0.1 }, trips: 30, tripsPerVehicleHour: 30, distance: 1500, distancePerVehicle: 1500, emptyShare: null, avgPickupWait: null, avgTransit: null, minBattery: 0.42 },
    },
    flows: {
      f1: { from: 'a', to: 'b', delivered: 120, trips: 100, avgPickupWait: 45, avgTransit: 30, backlog: 3, avgBacklog: 1.4 },
      f2: { from: 'b', to: 'zz', delivered: 0, trips: 0, avgPickupWait: null, avgTransit: null, backlog: 0, avgBacklog: 0.2 },
    },
    traffic: {
      waitShare: 0.13, vehicleWait: 600, junctionWait: 300, brokenWait: 0, deadlocks: 0,
      hotspots: [{ node: 1, cx: 4, cy: 2, wait: 400 }, { node: 2, cx: 5, cy: 2, wait: 100 }], deadlockEvents: [],
    },
    orders: { completed: 100, avgPickupWait: 50, avgTransit: 40 },
    series: { interval: 60, t: [60, 120], throughput: [100, 120], wip: [10, 14], vehiclesWorking: [2, 3], vehiclesWaiting: [0, 1] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------------------------------

test('dataState: no report, warming up, too little data, ready', () => {
  assert.equal(dataState(null), 'none');
  assert.equal(dataState(undefined), 'none');
  assert.equal(dataState(7), 'none');
  assert.equal(dataState(report({ window: win(100, true) })), 'warming');
  assert.equal(dataState(report({ window: win(MIN_DATA_SECONDS - 1) })), 'short');
  assert.equal(dataState(report({ window: win(MIN_DATA_SECONDS) })), 'ready');
  assert.equal(dataState({}), 'short', 'a report without a window has measured nothing');
  assert.equal(dataState({ window: null }), 'short');
});

test('runStatus: one chip state at a time, never 100 % while warming up', () => {
  const warming = (duration, extra = {}) => runStatus({ report: report({ window: win(duration, true) }), warmup: 600, playing: true, ...extra });
  assert.deepEqual(runStatus(), { key: 'idle', label: 'Not started', clock: '0:00:00', windowText: '', progress: null });
  assert.equal(warming(60).label, 'Warming up 10 %');
  assert.equal(warming(60).progress, 0.1);
  assert.equal(warming(599.99).label, 'Warming up 99 %', 'a clock that stops a tick early must not read 100 %');
  assert.equal(warming(0).label, 'Warming up 0 %');
  assert.equal(runStatus({ report: report({ window: win(30, true) }), warmup: 0 }).label, 'Warming up', 'unknown warm-up length: no percent');
  assert.equal(warming(60).windowText, '');
  assert.equal(warming(60, { playing: false }).windowText, 'Paused');
  const run = runStatus({ report: report(), playing: true, time: 4000, warmup: 600 });
  assert.deepEqual([run.key, run.label, run.clock, run.windowText], ['running', 'Running', '1:06:40', '60 min measured']);
  assert.equal(runStatus({ report: report(), playing: false }).label, 'Paused');
  assert.equal(runStatus({ report: report(), time: null }).clock, '1:00:00', 'the clock falls back to the end of the window');
  assert.equal(runStatus({ report: report({ window: { duration: null, warmingUp: false } }) }).windowText, '');
});

test('noticeModel: warm-up and short-data notices carry a progress fraction; nothing once the data is enough', () => {
  const warm = noticeModel(report({ window: win(150, true) }), runStatus({ report: report({ window: win(150, true) }), warmup: 600 }));
  assert.equal(warm.key, 'warming');
  assert.equal(warm.progress, 0.25);
  assert.match(warm.title, /Warming up: 25 % done/);
  const short = noticeModel(report({ window: win(120) }), runStatus({ report: report() }));
  assert.equal(short.key, 'short');
  assert.equal(short.title, 'Not enough data yet');
  assert.equal(short.progress, 120 / MIN_DATA_SECONDS);
  assert.match(short.text, /2 min .*preliminary/);
  assert.equal(noticeModel(report(), runStatus({ report: report() })), null);
  assert.equal(noticeModel(null, runStatus()), null);
});

test('fleetUtilization: weighted by vehicles, null without vehicles or data', () => {
  assert.equal(fleetUtilization(report().fleets), (3 * 0.6 + 1 * 0.9) / 4);
  assert.equal(fleetUtilization({}), null);
  assert.equal(fleetUtilization(null), null);
  assert.equal(fleetUtilization({ a: { count: 0, utilization: 1 }, b: { count: 2, utilization: null } }), null);
  assert.equal(fleetUtilization({ a: { count: 2, utilization: 3 } }), 1, 'utilization is clamped to 0..1');
});

test('kpiModels: six cards in a fixed order with formatted values, units and notes', () => {
  const cards = kpiModels(report());
  assert.deepEqual(cards.map((c) => c.id), [...KPI_IDS]);
  const by = Object.fromEntries(cards.map((c) => [c.id, c]));
  assert.deepEqual([by.throughput.value, by.throughput.unit, by.throughput.note], ['120', '/h', '120 loads delivered']);
  assert.deepEqual(by.throughput.spark, [100, 120]);
  assert.deepEqual([by.leadTime.value, by.leadTime.unit, by.leadTime.note], ['12.5', 'min', '95 % within 20 min']);
  assert.deepEqual([by.wip.value, by.wip.unit, by.wip.note], ['16', 'loads', 'avg 14 · peak 20']);
  assert.deepEqual(by.wip.spark, [10, 14]);
  assert.deepEqual([by.fleet.value, by.fleet.unit, by.fleet.note], ['68', '%', '4 vehicles']);
  assert.deepEqual([by.traffic.value, by.traffic.unit], ['13', '%']);
  assert.deepEqual(by.deadlocks.status, { tone: 'good', label: 'None' });
  assert.ok(cards.every((c) => c.muted === false));
  assert.equal(kpiModels(report({ throughput: { total: 1, perHour: 4.25 } })).find((c) => c.id === 'throughput').value, '4.3', 'one decimal below 10');
  assert.equal(kpiModels(report({ throughput: { total: 1, perHour: 1 } })).find((c) => c.id === 'throughput').note, '1 load delivered');
});

test('kpiModels: status words follow the thresholds of the insights', () => {
  const fleet = (utilization) => kpiModels(report({ fleets: { v: { count: 2, utilization } } })).find((c) => c.id === 'fleet').status;
  assert.deepEqual(fleet(0.5), { tone: 'good', label: 'Healthy' });
  assert.deepEqual(fleet(0.34), { tone: 'info', label: 'Mostly idle' });
  assert.deepEqual(fleet(0.85), { tone: 'warn', label: 'Saturated' });
  assert.deepEqual(fleet(0.95), { tone: 'bad', label: 'Overloaded' });
  const traffic = (waitShare) => kpiModels(report({ traffic: { waitShare } })).find((c) => c.id === 'traffic').status;
  assert.deepEqual(traffic(0.05), { tone: 'good', label: 'Flowing' });
  assert.deepEqual(traffic(0.12), { tone: 'warn', label: 'Queues forming' });
  assert.deepEqual(traffic(0.25), { tone: 'bad', label: 'Congested' });
  const dead = (deadlocks, deadlockEvents) => kpiModels(report({ traffic: { waitShare: 0, deadlocks, deadlockEvents } })).find((c) => c.id === 'deadlocks').status;
  assert.deepEqual(dead(2, [{ resolved: true }, { resolved: true }]), { tone: 'warn', label: 'Resolved by moving a vehicle' });
  assert.deepEqual(dead(2, [{ resolved: true }, { resolved: false }]), { tone: 'bad', label: 'Jam not resolved' });
  // a saturated-fleet insight wins over the utilization (loads can wait long for a fleet that is not that busy)
  const verdict = kpiModels(report({ fleets: { v: { count: 2, utilization: 0.7 } } }), 'ready', [{ id: 'fleet-saturated:v', severity: 'warning' }]).find((c) => c.id === 'fleet').status;
  assert.deepEqual(verdict, { tone: 'warn', label: 'Saturated' });
});

test('kpiModels: dashes while warming up or without a report, dimmed while the data is short', () => {
  for (const state of ['none', 'warming']) {
    const cards = kpiModels(state === 'none' ? null : report({ window: win(100, true) }), state);
    assert.equal(cards.length, 6);
    assert.ok(cards.every((c) => c.value === DASH && c.unit === '' && c.status === null && c.spark === null && c.muted));
  }
  assert.ok(kpiModels(report({ window: win(100) })).every((c) => c.muted), 'short: shown but muted');
  assert.ok(kpiModels(report({ window: win(100) })).some((c) => c.value !== DASH));
});

test('kpiModels: null fields are no data, shown as an en dash with no unit', () => {
  const cards = kpiModels({
    window: win(4000), throughput: { total: null, perHour: null }, leadTime: { count: 0, mean: null, p95: null }, wip: { mean: null, max: null, now: null },
    fleets: null, traffic: { waitShare: null, deadlocks: null }, series: null,
  });
  for (const c of cards) assert.deepEqual([c.value, c.unit], [DASH, ''], c.id);
  assert.equal(cards.find((c) => c.id === 'leadTime').note, 'No load delivered yet');
  assert.equal(cards.find((c) => c.id === 'fleet').note, 'No vehicles');
  assert.deepEqual(cards.find((c) => c.id === 'throughput').spark, []);
});

test('fleetModels: shares in bar order, metrics formatted, null means no data, battery only when there is one', () => {
  const [agv, fork] = fleetModels(report());
  assert.equal(agv.id, 'v1');
  assert.equal(agv.name, 'AGV');
  assert.equal(agv.countText, '3 vehicles');
  assert.equal(agv.utilText, '60 %');
  assert.deepEqual(agv.states.map((s) => s.key), ['driving', 'waiting', 'loading', 'unloading', 'idle', 'parked', 'charging', 'broken']);
  assert.deepEqual(agv.states.map((s) => s.label), ['Driving', 'Waiting', 'Loading', 'Unloading', 'Idle', 'Parked', 'Charging', 'Broken']);
  assert.equal(agv.aria, 'AGV: Driving 40 %, Waiting 10 %, Loading 5 %, Unloading 5 %, Idle 20 %, Parked 20 %');
  assert.deepEqual(agv.metrics, { traffic: '10 %', trips: '20 /h', distance: '3 km', empty: '45 %', pickup: '80 s', battery: null });
  assert.equal(fork.countText, '1 of 3 vehicles on the road');
  assert.equal(fork.metrics.empty, DASH);
  assert.equal(fork.metrics.pickup, DASH);
  assert.equal(fork.metrics.battery, '42 %');
  assert.deepEqual(fleetModels(null), []);
  assert.deepEqual(fleetModels({}), [], 'a report without that section has no fleets');
  const bare = fleetModels({ fleets: { x: null, y: { name: '', shares: 'bad' } } });
  assert.deepEqual(bare.map((f) => f.name), ['x', 'y'], 'a missing name falls back to the id');
  assert.ok(bare.every((f) => f.states.every((s) => s.frac === 0)));
});

test('stationRows: workstations and buffers only, bottleneck flag, time-in-state shares', () => {
  const rows = stationRows(report(), bottleneckIds([{ id: 'bottleneck:b' }, { id: 'traffic' }]));
  assert.deepEqual(rows.map((r) => r.id), ['b', 'c', 'd']);
  const [press, assembly, store] = rows;
  assert.equal(press.bottleneck, true);
  assert.equal(assembly.bottleneck, false);
  assert.deepEqual(press.shares.map((s) => [s.key, s.frac]), [['busy', 0.92], ['starved', 0.03], ['blocked', 0.02], ['down', 0.03]]);
  assert.deepEqual([press.utilText, press.avgText, press.maxText], ['92 %', '3.4', '8']);
  assert.equal(store.shares, null, 'a buffer shows its fill, not workstation states');
  assert.equal(store.fill, 0.35);
  assert.deepEqual([store.utilText, store.avgText, store.maxText], ['35 %', '14', '30'], 'buffers: loads held');
  assert.match(press.aria, /^Press: Busy 92 %, Starved 3 %, Blocked 2 %, Down 3 %$/);
  assert.match(store.aria, /35 % full/);
});

test('sortStationRows: highest utilization first, rows without data last, ties by name', () => {
  const row = (id, name, util) => ({ id, name, util });
  const sorted = sortStationRows([row('1', 'Zeta', 0.5), row('2', 'Alpha', 0.5), row('3', 'Mid', null), row('4', 'Top', 0.9), row('5', 'Low', 0)]);
  assert.deepEqual(sorted.map((r) => r.id), ['4', '2', '1', '5', '3']);
  const input = [row('1', 'a', 0.1), row('2', 'b', 0.2)];
  sortStationRows(input);
  assert.deepEqual(input.map((r) => r.id), ['1', '2'], 'the input is not reordered');
});

test('flowRows: names from the report, average backlog preferred, long backlog flagged', () => {
  const [f1, f2] = flowRows(report());
  assert.equal(f1.name, 'Goods in → Press');
  assert.deepEqual([f1.delivered, f1.trips, f1.pickup, f1.transit, f1.backlog, f1.backlogNow, f1.waiting], ['120', '100', '45 s', '30 s', '1.4', '3', true]);
  assert.equal(f2.name, 'Press → zz', 'an unknown station falls back to its id');
  assert.deepEqual([f2.pickup, f2.transit, f2.backlog, f2.waiting], [DASH, DASH, '0.2', false]);
  const fallback = flowRows({ flows: { x: { from: 'a', to: 'b', backlog: 2 } } })[0];
  assert.deepEqual([fallback.backlog, fallback.waiting], ['2', true], 'no average: the current count');
  assert.equal(flowRows({ flows: { x: { from: null, to: undefined } } })[0].name, '– → –');
});

test('hotspotRows: coordinates, wait text and the share of the worst spot; junk entries are dropped', () => {
  assert.deepEqual(hotspotRows(report()), [
    { cx: 4, cy: 2, label: '(4, 2)', waitText: '6.7 min', seconds: '400 s', frac: 1 },
    { cx: 5, cy: 2, label: '(5, 2)', waitText: '1.7 min', seconds: '100 s', frac: 0.25 },
  ]);
  const junk = hotspotRows({ traffic: { hotspots: [null, { cx: 1 }, { cx: 1, cy: 1, wait: null }, { cx: 2, cy: 3, wait: 0 }, 'x'] } });
  assert.deepEqual(junk.map((s) => [s.label, s.frac]), [['(2, 3)', 0]]);
  assert.deepEqual(hotspotRows(null), []);
});

test('trafficBreakdown: three causes in a fixed order', () => {
  assert.deepEqual(trafficBreakdown(report()), [['Behind other vehicles', '10 min'], ['At junctions', '5 min'], ['Behind broken-down vehicles', '0 s']]);
  assert.deepEqual(trafficBreakdown(null).map((p) => p[1]), [DASH, DASH, DASH]);
});

test('visibleInsights: placeholder and junk are left out, six shown until "show all"', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `i${i}`, title: `Insight ${i}` }));
  const withJunk = [{ id: 'not-enough-data', title: 'x' }, null, { id: 'no-title' }, { title: 'no id' }, ...many];
  const collapsed = visibleInsights(withJunk);
  assert.deepEqual([collapsed.shown.length, collapsed.total, collapsed.hidden], [INSIGHTS_COLLAPSED, 9, 3]);
  assert.deepEqual(visibleInsights(withJunk, true).shown.map((i) => i.id), many.map((i) => i.id));
  assert.deepEqual(visibleInsights(null), { shown: [], total: 0, hidden: 0 });
});

test('focusTarget and bottleneckIds', () => {
  assert.deepEqual(focusTarget({ stationIds: ['s1'], flowIds: [], fleetIds: ['v1'], cells: [[1, 2, 3], 'x', [4, 5]] }), { stationIds: ['s1'], fleetIds: ['v1'], cells: [[1, 2], [4, 5]] });
  assert.equal(focusTarget({}), null);
  assert.equal(focusTarget(null), null);
  assert.equal(focusTarget({ stationIds: [] }), null);
  const refs = { stationIds: ['s1'] };
  focusTarget(refs).stationIds.push('x');
  assert.deepEqual(refs.stationIds, ['s1'], 'the refs are copied');
  assert.deepEqual([...bottleneckIds([{ id: 'bottleneck:s5' }, { id: 'bottleneck:s7' }, { id: 'blocked:s2' }, null, { id: 3 }])], ['s5', 's7']);
  assert.equal(bottleneckIds(undefined).size, 0);
});

test('numbers are formatted like js/util/format.js (the dashboard only memoizes them)', () => {
  for (let i = 0; i <= 1000; i++) {
    const v = i / 1000;
    const digits = v > 0 && v < 0.1 ? 1 : 0;
    const got = fleetModels({ fleets: { x: { shares: { waiting: v } } } })[0].metrics.traffic;
    assert.equal(got, formatPercent(v, digits), `percent ${v}`);
  }
  for (const v of [0, 0.04, 0.05, 1.25, 9.94, 9.95, 10, 12.5, 999.5, 1234.5, 98765.4, 1e7]) {
    const card = kpiModels(report({ throughput: { total: 1, perHour: v } })).find((c) => c.id === 'throughput');
    assert.equal(card.value, formatNumber(v, v < 10 ? 1 : 0), `amount ${v}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------

/** Every string in a value, depth first. */
function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out);
  return out;
}

function everything(rep, insights) {
  const state = dataState(rep);
  const status = runStatus({ report: rep, playing: true, time: 10, warmup: 600 });
  return {
    status, notice: noticeModel(rep, status), kpis: kpiModels(rep, state, insights), fleets: fleetModels(rep),
    stations: sortStationRows(stationRows(rep, bottleneckIds(insights))), flows: flowRows(rep), spots: hotspotRows(rep), breakdown: trafficBreakdown(rep),
    insights: visibleInsights(insights, true),
  };
}

test('real reports from the engine: every model is complete and prints no NaN / undefined / null', () => {
  for (const example of EXAMPLES) {
    const sim = new Simulation(example.build());
    for (const seconds of [0, 30, 870]) {
      if (seconds) sim.advance(seconds);
      const rep = sim.kpis();
      const models = everything(rep, sim.insights(rep));
      for (const text of strings(models)) assert.ok(!/NaN|undefined|null|Infinity/.test(text), `${example.id} @ ${sim.time}: "${text}"`);
      assert.equal(models.kpis.length, 6);
      assert.equal(models.fleets.length, Object.keys(rep.fleets).length);
    }
  }
});

test('fuzzed reports (junk in random places, missing sections) never throw and never print junk', () => {
  const sim = new Simulation(EXAMPLES.find((e) => e.id === 'two-lines').build());
  sim.advance(1000);
  const base = JSON.parse(JSON.stringify(sim.kpis()));
  const insights = sim.insights();
  const junk = [null, undefined, NaN, Infinity, -Infinity, -5, 'x', {}, [], true, 1e308];
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const leaves = [];
  const walk = (o, path) => { for (const k of Object.keys(o)) (o[k] && typeof o[k] === 'object' ? walk(o[k], [...path, k]) : leaves.push([...path, k])); };
  walk(base, []);
  for (let i = 0; i < 400; i++) {
    const copy = structuredClone(base);
    for (let n = 1 + Math.floor(rnd() * 15); n > 0; n--) {
      const path = leaves[Math.floor(rnd() * leaves.length)];
      let o = copy;
      for (const k of path.slice(0, -1)) o = o?.[k];
      if (o && typeof o === 'object') o[path[path.length - 1]] = junk[Math.floor(rnd() * junk.length)];
    }
    if (rnd() < 0.3) { const keys = Object.keys(copy); copy[keys[Math.floor(rnd() * keys.length)]] = junk[Math.floor(rnd() * junk.length)]; }
    const models = everything(copy, rnd() < 0.5 ? insights : [null, { id: 'bottleneck:s5', title: 7 }, 'x']);
    for (const text of strings(models)) assert.ok(!/NaN|undefined|null|Infinity/.test(text), `iteration ${i}: "${text}"`);
  }
  for (const rep of [null, undefined, 0, 'x', [], {}, { window: 5 }]) assert.doesNotThrow(() => everything(rep, null));
});
