// The KPI section of trucks and dock doors, `report.ops.trucks[stationId]` (docs/WAREHOUSE-DESIGN.md 6.8; js/sim/stats-ops.js), and what is built on it:
// its exact shape (the Doors card reads it), its numbers against independent sums of the events and of the per-tick state, the window and the
// warm-up, the gate queue series, no NaN, A1.5 (Little's law over 8 h), the metrics and sweep parameters of js/sim/experiments.js and the
// classification of a door edit by layoutChangeKind.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, nonFinitePaths } from './helpers/logistics-invariants.js';
import { attachStats, microPlant } from './helpers/trucks-gen.js';
import { dist } from '../js/model/defaults.js';
import { EXAMPLES } from '../js/model/examples.js';
import { getStation, layoutChangeKind, normalizeLayout, updateSettings, updateStation } from '../js/model/layout.js';
import { Simulation } from '../js/sim/engine.js';
import { SampleSet, SERIES_INTERVAL, SERIES_MAX_POINTS } from '../js/sim/stats.js';
import { METRICS, listSweepParameters, summarizeReport, sweep } from '../js/sim/experiments.js';

const CONST = (mean) => dist('const', mean, 0);
const TRUCK_KEYS = 'name,role,doors,trucks,gateWait,doorTime,turnaround,doorUtilization,gateQueue,doorsBusyNow,fillRate,gateQueueSeries';
const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;

/** Goods in A (trucks) -> Storage S -> Goods out C (trucks): both ends of the plant have doors. */
function bothEnds(over = {}) {
  return microPlant({
    storage: true,
    inbound: { doors: 2, checkIn: 60, checkOut: 30, interArrival: CONST(400), pallets: CONST(4), ...(over.inbound || {}) },
    outbound: { doors: 1, checkIn: 30, checkOut: 30, interArrival: CONST(500), pallets: CONST(4), staging: 2, maxDwell: 300, ...(over.outbound || {}) },
    fleet: { count: 3 },
  });
}

// ---- the shape ----------------------------------------------------------------------------------------------------------

test('report.ops: a plant without trucks has no `ops` key; a plant with trucks has ops.trucks and nothing else, one entry per Goods in / Goods out with the documented keys', () => {
  const legacy = new Simulation(microPlant({ storage: true }), { seed: 1 });
  legacy.advance(600);
  assert.equal('ops' in legacy.kpis(), false, 'a legacy report is byte-identical: no ops key');
  for (const example of EXAMPLES) {
    const sim = new Simulation(example.build(), { seed: 1 });
    sim.advance(60);
    const report = sim.kpis();
    assert.equal('ops' in report, sim.layout.stations.some((st) => st.ops && st.ops.trucks), `${example.name}: ops exists exactly when a station has trucks`);
  }
  const sim = new Simulation(bothEnds(), { seed: 2 });
  sim.advance(3 * 3600);
  const report = sim.kpis();
  assert.deepEqual(Object.keys(report.ops), ['trucks']);
  assert.deepEqual(Object.keys(report.ops.trucks), ['A', 'C']);
  for (const id of ['A', 'C']) assert.equal(Object.keys(report.ops.trucks[id]).join(), TRUCK_KEYS);
  const a = report.ops.trucks.A;
  assert.equal(a.name, 'A');
  assert.equal(a.role, 'in');
  assert.equal(a.doors, 2);
  assert.equal(Object.keys(a.trucks).join(), 'arrived,docked,departed,short,noShow,turnedAway');
  assert.equal(Object.keys(a.gateWait).join(), 'mean,p90,max');
  assert.equal(Object.keys(a.doorTime).join(), 'mean,p90');
  assert.equal(Object.keys(a.turnaround).join(), 'mean,p90');
  assert.equal(Object.keys(a.gateQueue).join(), 'mean,max,now');
  assert.equal(a.fillRate, null, 'a Goods in has no fill rate');
  assert.equal(report.ops.trucks.C.role, 'out');
  assert.ok(report.ops.trucks.C.fillRate > 0 && report.ops.trucks.C.fillRate <= 1);
  assert.deepEqual(nonFinitePaths(report.ops), []);
  assert.deepEqual(JSON.parse(JSON.stringify(report.ops)), report.ops, 'plain JSON: it can be exported, cloned and posted to a worker');
  assert.equal(a.gateQueueSeries.length, report.series.t.length);
});

test('report.ops before the first truck: counts 0, times null, no NaN; Goods in and Goods out alike', () => {
  const layout = bothEnds({ inbound: { interArrival: CONST(4000) }, outbound: { interArrival: CONST(4000) } });
  layout.stations.find((st) => st.id === 'A').params.startDelay = 3000;
  const sim = new Simulation(layout, { seed: 1 });
  sim.advance(120);
  const { A, C } = sim.kpis().ops.trucks;
  for (const entry of [A, C]) {
    assert.deepEqual(entry.trucks, { arrived: 0, docked: 0, departed: 0, short: 0, noShow: 0, turnedAway: 0 });
    assert.deepEqual(entry.gateWait, { mean: null, p90: null, max: null });
    assert.deepEqual(entry.doorTime, { mean: null, p90: null });
    assert.deepEqual(entry.turnaround, { mean: null, p90: null });
    assert.equal(entry.doorUtilization, 0);
    assert.deepEqual(entry.gateQueue, { mean: 0, max: 0, now: 0 });
    assert.equal(entry.fillRate, null);
  }
  assert.deepEqual(nonFinitePaths(sim.kpis().ops), []);
});

// ---- the numbers, against independent sums -------------------------------------------------------------------------------

test('report.ops numbers equal independent sums of the events and of the per-tick state (counts, gate wait, door time, turnaround, utilization, gate queue, fill rate)', () => {
  const layout = bothEnds({ inbound: { doors: 1, interArrival: CONST(110), pallets: CONST(5) } }); // one door that needs about 135 s per truck, a truck every 110 s: a queue builds up
  const w = attachStats(createWorld(layout, { dt: 0.5, seed: 8 }));
  const seen = { A: { gate: 0, doors: 0, maxGate: 0 }, C: { gate: 0, doors: 0, maxGate: 0 } };
  for (let i = 0; i < 2 * 3600 / 0.5; i++) {
    w.step();
    for (const id of ['A', 'C']) {
      const desk = w.lg.stationById.get(id).trucks;
      seen[id].gate += desk.gate.length * 0.5;
      seen[id].doors += desk.docked.length * 0.5;
      seen[id].maxGate = Math.max(seen[id].maxGate, desk.gate.length);
    }
  }
  const T = 2 * 3600;
  const report = w.stats.report();
  for (const id of ['A', 'C']) {
    const entry = report.ops.trucks[id];
    const desk = w.lg.stationById.get(id).trucks;
    const docked = w.named('truckDocked').filter((p) => p.stationId === id);
    const departed = w.named('truckDeparted').filter((p) => p.stationId === id);
    const waits = new SampleSet();
    docked.forEach((p) => waits.add(p.wait));
    const doorTimes = new SampleSet();
    departed.forEach((p) => doorTimes.add(p.doorTime));
    const turn = new SampleSet();
    departed.forEach((p) => turn.add(p.turnaround));
    assert.equal(entry.trucks.arrived, w.named('truckArrived').filter((p) => p.stationId === id).length);
    assert.equal(entry.trucks.docked, docked.length);
    assert.equal(entry.trucks.departed, departed.length);
    assert.equal(entry.trucks.short, departed.filter((p) => p.short).length);
    assert.ok(docked.length >= 8 && departed.length >= 8, `${id}: ${docked.length} docked, ${departed.length} departed`);
    assert.ok(Math.abs(entry.gateWait.mean - waits.sum / waits.count) < 1e-9);
    assert.equal(entry.gateWait.max, waits.max);
    assert.ok(Math.abs(entry.gateWait.p90 - waits.percentile(0.9)) < 1e-9);
    assert.ok(Math.abs(entry.doorTime.mean - doorTimes.sum / doorTimes.count) < 1e-9);
    assert.ok(Math.abs(entry.doorTime.p90 - doorTimes.percentile(0.9)) < 1e-9);
    assert.ok(Math.abs(entry.turnaround.mean - turn.sum / turn.count) < 1e-9);
    assert.ok(Math.abs(entry.doorUtilization - seen[id].doors / (desk.doors * T)) < 1e-9, `${id}: utilization ${entry.doorUtilization}`);
    assert.ok(Math.abs(entry.gateQueue.mean - seen[id].gate / T) < 1e-9, `${id}: gate queue mean ${entry.gateQueue.mean}`);
    assert.equal(entry.gateQueue.max, seen[id].maxGate);
    assert.equal(entry.gateQueue.now, desk.gate.length);
    assert.equal(entry.doorsBusyNow, desk.docked.length);
    // a truck's door time is its turnaround less the wait at the gate
    assert.ok(Math.abs(entry.turnaround.mean - entry.gateWait.mean - entry.doorTime.mean) < entry.gateWait.mean * 0.3 + 60, 'turnaround is about gate wait + door time (different truck sets: the departed ones)');
  }
  const a = report.ops.trucks.A;
  assert.ok(a.gateWait.mean > 60 && a.gateQueue.max >= 2, `the single door is overloaded: wait ${a.gateWait.mean.toFixed(0)} s, queue up to ${a.gateQueue.max}`);
  assert.ok(a.doorUtilization > 0.85 && a.doorUtilization <= 1, `utilization ${a.doorUtilization}`);
  // Goods out: pallets loaded over pallets planned, over the trucks that left
  const out = w.named('truckDeparted').filter((p) => p.stationId === 'C');
  const planned = out.reduce((n, p) => n + p.truck.plan, 0);
  const loaded = out.reduce((n, p) => n + p.truck.loaded, 0);
  assert.ok(planned > 0);
  assert.ok(Math.abs(report.ops.trucks.C.fillRate - loaded / planned) < 1e-12, `fill rate ${report.ops.trucks.C.fillRate} = ${loaded}/${planned}`);
  assert.equal(report.ops.trucks.C.trucks.short, out.filter((p) => p.truck.loaded < p.truck.plan).length);
});

test('report.ops follows the measurement window: a warm-up discards the counters, not the trucks at the doors', () => {
  const layout = bothEnds();
  layout.settings.warmup = 1800;
  const sim = new Simulation(layout, { seed: 3 });
  const after = { docked: 0, departed: 0, arrived: 0 };
  sim.on('truckDocked', (p) => { if (sim.time > 1800 + sim.dt && p.stationId === 'A') after.docked++; });
  sim.on('truckDeparted', (p) => { if (sim.time > 1800 + sim.dt && p.stationId === 'A') after.departed++; });
  sim.on('truckArrived', (p) => { if (sim.time > 1800 + sim.dt && p.stationId === 'A') after.arrived++; });
  sim.advance(3 * 3600);
  const report = sim.kpis();
  const a = report.ops.trucks.A;
  assert.ok(Math.abs(report.window.start - 1800) < 1e-6, `the window starts at the end of the warm-up (${report.window.start})`);
  assert.ok(Math.abs(a.trucks.arrived - after.arrived) <= 1 && Math.abs(a.trucks.docked - after.docked) <= 1 && Math.abs(a.trucks.departed - after.departed) <= 1, `window counts ${JSON.stringify(a.trucks)} against ${JSON.stringify(after)}`);
  const desk = sim.logistics.stationById.get('A').trucks;
  assert.ok(desk.arrived > a.trucks.arrived + 3, 'the desk keeps counting since the start, the report only the window');
  assert.ok(a.doorUtilization > 0 && a.doorUtilization <= 1);
  assert.equal(a.gateQueueSeries.length, report.series.t.length, 'the series restarted with the window');
});

test('the gate queue series has one point per point of the run series, also after the run series has been decimated (40 hours)', () => {
  // one door that needs about 110 s per truck, a truck every 100 s: the queue grows until the gate is full (200 trucks) and stays there
  const layout = microPlant({ storage: true, inbound: { doors: 1, checkIn: 60, checkOut: 30, interArrival: dist('normal', 100, 0.3), pallets: CONST(4) }, fleet: { count: 4 } });
  const w = attachStats(createWorld(layout, { dt: 5, seed: 5 }));
  w.run(40 * 3600);
  const report = w.stats.report();
  const series = report.ops.trucks.A.gateQueueSeries;
  assert.ok(40 * 3600 / SERIES_INTERVAL > SERIES_MAX_POINTS, 'long enough to decimate');
  assert.equal(series.length, report.series.t.length);
  assert.ok(series.length < SERIES_MAX_POINTS && series.length > SERIES_MAX_POINTS / 2 - 1, `${series.length} points`);
  assert.ok(series.every((x) => Number.isFinite(x) && x >= 0));
  const overall = report.ops.trucks.A.gateQueue.mean;
  assert.ok(overall > 1, `a queue: ${overall}`);
  assert.ok(Math.abs(mean(series) - overall) < 0.05 * overall + 0.05, `mean of the series ${mean(series).toFixed(3)} against ${overall.toFixed(3)}`);
});

// ---- A1.5 Little's law ---------------------------------------------------------------------------------------------------------

test('A1.5 Little: in a rate-mode plant with ample vehicles over 8 h, the time-average number of docked trucks equals the arrival rate times the mean door time within 5 %', () => {
  for (const [label, trucks] of [
    ['one door, busy', { doors: 1, interArrival: dist('normal', 135, 0.3), pallets: dist('uniform', 6, 0.5) }],
    ['three doors, light', { doors: 3, interArrival: dist('exp', 400, 0), pallets: dist('uniform', 8, 0.5) }],
    ['two doors, queueing', { doors: 2, interArrival: dist('normal', 105, 0.25), pallets: dist('const', 5, 0), checkIn: 120, checkOut: 60 }],
  ]) {
    const layout = microPlant({ storage: true, inbound: { checkIn: 60, checkOut: 30, ...trucks }, fleet: { count: 6, loadTime: 3, unloadTime: 3 } });
    const w = attachStats(createWorld(layout, { dt: 0.5, seed: 21 }));
    const T = 8 * 3600;
    let docked = 0; // integral of the number of docked trucks, measured here tick by tick
    for (let i = 0; i < T / 0.5; i++) {
      w.step();
      docked += w.lg.stationById.get('A').trucks.docked.length * 0.5;
    }
    const entry = w.stats.report().ops.trucks.A;
    const lambda = entry.trucks.docked / T; // trucks that took a door per second (nobody was turned away: arrivals = docked + gate queue)
    const L = docked / T;
    const W = entry.doorTime.mean;
    assert.equal(entry.trucks.turnedAway, 0, label);
    if (label !== 'three doors, light') assert.ok(entry.doorUtilization > 0.7, `${label}: busy enough to mean something (${entry.doorUtilization.toFixed(2)})`);
    assert.ok(entry.trucks.departed >= 50, `${label}: ${entry.trucks.departed} trucks left`);
    assert.ok(Math.abs(L - lambda * W) / L < 0.05, `${label}: time-average docked ${L.toFixed(4)} against rate x door time ${(lambda * W).toFixed(4)}`);
    // and the report says the same thing in its own words
    assert.ok(Math.abs(entry.doorUtilization * entry.doors - L) < 1e-9, `${label}: utilization x doors = ${L.toFixed(4)}`);
  }
});

// ---- metrics and sweeps ---------------------------------------------------------------------------------------------------------

test('METRICS gateWaitMean, gateWaitP90, doorUtilization, trucksShort: null for a plant without trucks, the numbers of report.ops for one with', () => {
  const ids = ['gateWaitMean', 'gateWaitP90', 'doorUtilization', 'trucksShort'];
  for (const id of ids) assert.ok(METRICS.some((m) => m.id === id), id);
  const legacy = new Simulation(microPlant({ storage: true }), { seed: 1 });
  legacy.advance(1200);
  const none = summarizeReport(legacy.kpis());
  for (const id of ids) assert.equal(none[id], null, `${id} is null without trucks`);
  const sim = new Simulation(bothEnds({ inbound: { doors: 1, interArrival: CONST(110), pallets: CONST(5) } }), { seed: 8 });
  sim.advance(2 * 3600);
  const report = sim.kpis();
  const flat = summarizeReport(report);
  const { A, C } = report.ops.trucks;
  assert.ok(flat.gateWaitMean > 0 && Number.isFinite(flat.gateWaitMean));
  assert.ok(Math.abs(flat.gateWaitMean - (A.gateWait.mean * A.trucks.docked + C.gateWait.mean * C.trucks.docked) / (A.trucks.docked + C.trucks.docked)) < 1e-9, 'the mean over the trucks of all stations');
  assert.equal(flat.gateWaitP90, Math.max(A.gateWait.p90, C.gateWait.p90), 'the worst station');
  assert.ok(Math.abs(flat.doorUtilization - 100 * (A.doorUtilization * A.doors + C.doorUtilization * C.doors) / (A.doors + C.doors)) < 1e-9, 'a percentage, weighted by doors');
  assert.equal(flat.trucksShort, C.trucks.short, 'only Goods out trucks can leave short');
  for (const m of METRICS.filter((x) => ids.includes(x.id))) assert.ok(typeof m.label === 'string' && m.label.length > 3 && ['higher', 'lower', null].includes(m.better), m.id);
  // a plant with only a Goods in: trucksShort has nothing to count
  const only = new Simulation(microPlant({ inbound: { doors: 2, interArrival: CONST(300) } }), { seed: 1 });
  only.advance(1800);
  assert.equal(summarizeReport(only.kpis()).trucksShort, null);
});

test('sweep parameters: doors, truck gap and pallets per truck replace the arrival interval of a Goods in with trucks; a timetable has no gap; every apply gives a valid plant', () => {
  const layout = bothEnds();
  const params = listSweepParameters(layout);
  const keys = params.map((p) => p.key);
  for (const key of ['doors:A', 'truckGap:A', 'palletsPerTruck:A', 'doors:C', 'truckGap:C', 'palletsPerTruck:C', 'demandFactor']) assert.ok(keys.includes(key), key);
  assert.ok(!keys.some((k) => k.startsWith('station.A.interArrival')), 'the legacy interval of a Goods in with trucks is not offered');
  const doors = params.find((p) => p.key === 'doors:A');
  assert.equal(doors.get(layout), 2);
  assert.ok(doors.values.includes(2) && doors.values.every((v) => Number.isInteger(v) && v >= 1 && v <= 32), JSON.stringify(doors.values));
  const gap = params.find((p) => p.key === 'truckGap:A');
  assert.equal(gap.get(layout), 400);
  const pallets = params.find((p) => p.key === 'palletsPerTruck:A');
  assert.equal(pallets.get(layout), 4);
  for (const p of [doors, gap, pallets]) {
    for (const v of p.values) {
      const changed = p.apply(layout, v);
      assert.equal(p.get(changed), v, `${p.key} = ${v}`);
      assert.deepEqual(normalizeLayout(changed), changed, `${p.key} = ${v}: the plant stays valid and normalized`);
      assert.equal(p.get(layout), p.key === 'doors:A' ? 2 : p.key === 'truckGap:A' ? 400 : 4, 'the input is left alone');
    }
  }
  assert.equal(doors.apply(layout, 5).stations.find((st) => st.id === 'A').ops.trucks.interArrival.spread, layout.stations.find((st) => st.id === 'A').ops.trucks.interArrival.spread, 'kind and spread are kept');
  // a timetable: no gap; pallets per truck only while a row leaves the pallets open
  const table = microPlant({ inbound: { mode: 'schedule', doors: 2, schedule: [{ at: 21600, pallets: 10 }, { at: 25200, pallets: 12 }] } });
  const tableKeys = listSweepParameters(table).map((p) => p.key);
  assert.ok(tableKeys.includes('doors:A') && !tableKeys.includes('truckGap:A') && !tableKeys.includes('palletsPerTruck:A'), tableKeys.join());
  const open = microPlant({ inbound: { mode: 'schedule', doors: 2, schedule: [{ at: 21600, pallets: null }] } });
  assert.ok(listSweepParameters(open).some((p) => p.key === 'palletsPerTruck:A'));
  // a legacy plant keeps its parameters
  const legacy = listSweepParameters(microPlant({ storage: true })).map((p) => p.key);
  assert.ok(legacy.includes('station.A.interArrival') && !legacy.some((k) => k.startsWith('doors:')), legacy.join());
});

test('layoutChangeKind: a change of doors, trucks or the clock rebuilds the simulation (structural); only the demand slider is a runtime change', () => {
  const layout = bothEnds();
  const edited = (edit) => {
    const copy = structuredClone(layout);
    edit(copy);
    return copy;
  };
  const doors = edited((l) => updateStation(l, 'A', { ops: { trucks: { doors: 5 } } }));
  assert.equal(getStation(doors, 'A').ops.trucks.doors, 5, 'the edit happened');
  assert.equal(layoutChangeKind(layout, doors), 'structural');
  const pallets = edited((l) => updateStation(l, 'A', { ops: { trucks: { pallets: { mean: 30 } } } }));
  assert.equal(getStation(pallets, 'A').ops.trucks.pallets.mean, 30);
  assert.equal(layoutChangeKind(layout, pallets), 'structural');
  const clock = edited((l) => { l.calendar = { startTod: 3600, startDay: 1 }; });
  assert.equal(layoutChangeKind(layout, clock), 'structural');
  const demand = edited((l) => updateSettings(l, { demandFactor: 2 }));
  assert.equal(demand.settings.demandFactor, 2);
  assert.equal(layoutChangeKind(layout, demand), 'runtime');
  assert.equal(layoutChangeKind(layout, structuredClone(layout)), 'none');
});

test('a sweep over the doors: more doors, less waiting at the gate and a lower door utilization (replicated, same seeds)', async () => {
  // a truck every 90 s on average; one door needs about 100 s per truck (a queue that grows), two doors about 45 %, three about 30 %
  const layout = microPlant({ storage: true, inbound: { doors: 1, checkIn: 60, checkOut: 30, interArrival: dist('normal', 90, 0.3), pallets: CONST(4) }, fleet: { count: 4 } });
  const results = await sweep(layout, 'doors:A', [1, 2, 3], { duration: 3 * 3600, warmup: 900, replications: 2, seed0: 5 });
  const wait = results.map((r) => r.summary.gateWaitMean.mean);
  const util = results.map((r) => r.summary.doorUtilization.mean);
  assert.ok(wait[0] > wait[1] && wait[1] >= wait[2], `gate wait ${wait.map((x) => x.toFixed(0))}`);
  assert.ok(util[0] > util[1] && util[1] > util[2], `utilization ${util.map((x) => x.toFixed(0))}`);
  assert.ok(wait[0] > 300 && wait[2] < 60, 'from a real queue to almost none');
});
