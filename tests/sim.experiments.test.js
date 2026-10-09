// Tests of the headless experiment runner (js/sim/experiments.js): single runs, replications, the metric table, sweep parameters,
// sweeps and scenario comparisons - including progress reporting, cooperative yielding and aborting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  METRICS, compareScenarios, listSweepParameters, runReplications, runSimulation, summarizeReport, sweep,
} from '../js/sim/experiments.js';
import { Simulation } from '../js/sim/engine.js';
import { EXAMPLES as ALL_EXAMPLES } from '../js/model/examples.js';
import { legacyExamples } from './helpers/golden.js';

/** The three legacy examples: the catalogue also holds the warehouse examples since M1 (trucks, schema 2), which have their own tests (sim.examples.warehouse.test.js). */
const EXAMPLES = legacyExamples(ALL_EXAMPLES);
import { validateLayout } from '../js/model/validate.js';
import {
  checkInvariants, cloneLayout, createLayout, docksOf, getFleet, getStation, moveStation, normalizeLayout, paintRoadPath, updateFleet, updateSettings,
  updateStation,
} from '../js/model/layout.js';
import { assertAllFinite, exampleLayout, lineLayout, measureRuns, pairedDiffs, variantOf } from './helpers/sim-invariants.js';

const example = exampleLayout;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => (a.length < 2 ? 0 : Math.sqrt(a.reduce((x, y) => x + (y - mean(a)) ** 2, 0) / (a.length - 1)));

/** A plant whose output is limited by the number of vehicles: a fast source, a long road, quick machines. */
const transportLimited = (vehicles = 1, settings = {}) => lineLayout({ vehicles, gap: 16, arrival: 8, cycle: 5, settings, source: { outCap: 200 } });

// ---------------------------------------------------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------------------------------------------------

test('METRICS: a flat table of numbers with label, unit, direction and decimals', () => {
  assert.ok(METRICS.length >= 10);
  assert.equal(new Set(METRICS.map((m) => m.id)).size, METRICS.length);
  for (const m of METRICS) {
    assert.match(m.id, /^[a-zA-Z][a-zA-Z0-9]*$/);
    assert.ok(typeof m.label === 'string' && m.label.length > 3, m.id);
    assert.equal(typeof m.unit, 'string', m.id);
    assert.ok(['higher', 'lower', null].includes(m.better), m.id);
    assert.ok(Number.isInteger(m.digits) && m.digits >= 0 && m.digits <= 3, m.id);
    assert.equal(typeof m.get, 'function');
  }
  for (const id of ['throughput', 'leadMean', 'leadP95', 'wip', 'fleetUtilization', 'waitShare', 'emptyShare', 'deadlocks', 'maxBacklog']) {
    assert.ok(METRICS.some((m) => m.id === id), id);
  }
});

test('METRICS: every getter returns a finite number or null on the example plants and on an empty plant', () => {
  const reports = [...EXAMPLES.map((e) => new Simulation(e.build())), new Simulation(createLayout())].map((sim) => {
    sim.advance(1800);
    return sim.kpis();
  });
  for (const report of reports) {
    for (const m of METRICS) {
      const v = m.get(report);
      assert.ok(v === null || Number.isFinite(v), `${m.id}: ${v}`);
    }
    const flat = summarizeReport(report);
    assert.deepEqual(Object.keys(flat), METRICS.map((m) => m.id));
    assert.deepEqual(JSON.parse(JSON.stringify(flat)), flat);
  }
  const lab = summarizeReport(reports[2]);
  assert.ok(lab.throughput > 20 && lab.waitShare > 5 && lab.fleetUtilization > 30, 'real numbers for a busy plant');
  const empty = summarizeReport(reports[3]);
  assert.equal(empty.throughput, 0);
  assert.deepEqual([empty.fleetUtilization, empty.emptyShare, empty.maxBacklog, empty.bottleneck, empty.minBattery, empty.leadMean], [null, null, null, null, null, null]);
});

test('METRICS: values are computed from the report the documented way (percentages, weighted means, extremes)', () => {
  const report = {
    throughput: { perHour: 12.5 },
    leadTime: { mean: 300, p95: 450 },
    wip: { mean: 4 },
    fleets: {
      a: { count: 2, utilization: 0.5, emptyShare: 0.4, distance: 100, minBattery: 0.3 },
      b: { count: 6, utilization: 0.9, emptyShare: 0.6, distance: 300, minBattery: null },
      c: { count: 0, utilization: 0, emptyShare: null, distance: 0, minBattery: 0.1 },
    },
    traffic: { waitShare: 0.125, deadlocks: 2 },
    stations: {
      s1: { type: 'source', yardMax: 7 }, s2: { type: 'source', yardMax: 3 },
      p1: { type: 'process', utilization: 0.8 }, p2: { type: 'process', utilization: 0.6 },
      st: { type: 'storage', utilization: 0.99, yardMax: 99 },
    },
    orders: { avgPickupWait: 42 },
  };
  const v = summarizeReport(report);
  assert.equal(v.throughput, 12.5);
  assert.equal(v.leadMean, 300);
  assert.equal(v.leadP95, 450);
  assert.equal(v.wip, 4);
  assert.ok(Math.abs(v.fleetUtilization - 80) < 1e-9, 'weighted by the number of vehicles: (0.5*2 + 0.9*6) / 8');
  assert.equal(v.waitShare, 12.5);
  assert.ok(Math.abs(v.emptyShare - 55) < 1e-9, 'weighted by the distance driven: (0.4*100 + 0.6*300) / 400');
  assert.equal(v.deadlocks, 2);
  assert.equal(v.maxBacklog, 7, 'the largest yard of a goods-in station, not of a storage');
  assert.equal(v.bottleneck, 80, 'the busiest workstation, not the fullest storage');
  assert.equal(v.pickupWait, 42);
  assert.ok(Math.abs(v.minBattery - 10) < 1e-9);
  const metric = (id) => METRICS.find((m) => m.id === id);
  assert.equal(metric('throughput').better, 'higher');
  assert.equal(metric('leadMean').better, 'lower');
  assert.equal(metric('waitShare').unit, '%');
});

test('METRICS: missing parts of a report give null, never NaN or an exception', () => {
  const partials = [{}, { fleets: {}, stations: {} }, { throughput: {}, leadTime: { mean: null }, traffic: { waitShare: NaN }, fleets: { a: { count: 3 } } }];
  for (const partial of partials) {
    for (const value of Object.values(summarizeReport(partial))) assert.equal(value, null);
  }
  assert.ok(Object.values(summarizeReport(null)).every((x) => x === null));
  assert.ok(Object.values(summarizeReport(undefined)).every((x) => x === null));
});

// ---------------------------------------------------------------------------------------------------------------------
// runSimulation
// ---------------------------------------------------------------------------------------------------------------------

test('runSimulation: the same report as stepping a Simulation yourself, for the duration, warm-up and seed asked for', async () => {
  const layout = example('starter');
  const report = await runSimulation(layout, { duration: 1800, warmup: 300, seed: 9 });
  const direct = new Simulation({ ...cloneLayout(layout), settings: { ...layout.settings, warmup: 300 } }, { seed: 9 });
  direct.advance(1800);
  assert.deepEqual(report, JSON.parse(JSON.stringify(direct.kpis())));
  assert.ok(Math.abs(report.window.start - 300) < 1e-6 && Math.abs(report.window.end - 1800) < 1e-6);
  assert.equal(layout.settings.warmup, 600, 'the caller\'s layout is untouched');
});

test('runSimulation: defaults to settings.duration and settings.warmup, the warm-up capped at half of a short run', async () => {
  const layout = lineLayout({ settings: { warmup: 600, duration: 3600, seed: 4 } });
  const full = await runSimulation(layout);
  assert.ok(Math.abs(full.window.start - 600) < 1e-6 && Math.abs(full.window.end - 3600) < 1e-6);
  const short = await runSimulation(layout, { duration: 400 });
  assert.ok(Math.abs(short.window.start - 200) < 1e-6 && Math.abs(short.window.end - 400) < 1e-6, 'a 600 s warm-up would leave nothing to measure');
  const explicit = await runSimulation(layout, { duration: 400, warmup: 350 });
  assert.ok(Math.abs(explicit.window.start - 350) < 1e-6, 'an explicit warm-up is honoured');
  const none = await runSimulation(layout, { duration: 400, warmup: 0 });
  assert.equal(none.window.start, 0);
});

test('runSimulation: the seed option changes the run, the same seed reproduces it', async () => {
  const layout = example('starter');
  const [a, b, c] = await Promise.all([1, 1, 2].map((seed) => runSimulation(layout, { duration: 1500, seed })));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('runSimulation: invalid options and layouts reject', async () => {
  const layout = lineLayout();
  for (const duration of [0, -5, NaN, Infinity, '100']) await assert.rejects(runSimulation(layout, { duration }), RangeError, `duration ${duration}`);
  for (const warmup of [-1, NaN, Infinity, '5']) await assert.rejects(runSimulation(layout, { duration: 100, warmup }), RangeError, `warmup ${warmup}`);
  await assert.rejects(runSimulation(null), TypeError);
  await assert.rejects(runSimulation('layout'), TypeError);
});

test('runSimulation: progress is reported from 0 to 1 in non-decreasing steps with the clock and the label', async () => {
  const calls = [];
  await runSimulation(transportLimited(2), { duration: 600, warmup: 0, yieldEveryMs: 1, label: 'Base case', onProgress: (p) => calls.push(p) });
  assert.ok(calls.length > 5, `${calls.length} progress reports`);
  assert.equal(calls[0].fraction, 0);
  assert.equal(calls[0].simTime, 0);
  assert.equal(calls.at(-1).fraction, 1);
  assert.ok(Math.abs(calls.at(-1).simTime - 600) < 1e-6);
  for (let i = 1; i < calls.length; i++) {
    assert.ok(calls[i].fraction >= calls[i - 1].fraction && calls[i].simTime >= calls[i - 1].simTime);
    assert.ok(calls[i].fraction >= 0 && calls[i].fraction <= 1);
    assert.equal(calls[i].label, 'Base case');
    assert.ok(i === calls.length - 1 || Math.abs(calls[i].fraction - calls[i].simTime / 600) < 1e-9);
  }
});

test('runSimulation: hands the event loop a turn between slices, so timers keep firing during a long run', async () => {
  let timerTurns = 0;
  const timer = setInterval(() => { timerTurns++; }, 1);
  let slices = 0;
  try {
    await runSimulation(example('two-lines'), { duration: 4 * 3600, yieldEveryMs: 5, onProgress: () => { slices++; } });
  } finally {
    clearInterval(timer);
  }
  assert.ok(slices > 10, `${slices} slices`);
  assert.ok(timerTurns >= 3, `the timer fired ${timerTurns} times while the simulation ran`);
});

test('runSimulation: yieldEveryMs = Infinity runs everything in one slice', async () => {
  const calls = [];
  await runSimulation(lineLayout(), { duration: 600, warmup: 0, yieldEveryMs: Infinity, onProgress: (p) => calls.push(p.fraction) });
  assert.deepEqual(calls, [0, 1]);
});

test('abort: an already aborted signal rejects at once with an AbortError, before any work', async () => {
  const controller = new AbortController();
  controller.abort();
  let progress = 0;
  await assert.rejects(runSimulation(lineLayout(), { signal: controller.signal, onProgress: () => { progress++; } }), (err) => {
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'AbortError');
    return true;
  });
  assert.equal(progress, 0);
});

test('abort: aborting in the middle of a run stops it at the next slice', async () => {
  const controller = new AbortController();
  const fractions = [];
  const run = runSimulation(example('starter'), {
    duration: 100 * 3600, yieldEveryMs: 2, signal: controller.signal,
    onProgress: (p) => {
      fractions.push(p.fraction);
      if (p.fraction > 0.0005) controller.abort();
    },
  });
  await assert.rejects(run, (err) => err.name === 'AbortError' && err instanceof Error);
  assert.ok(fractions.length >= 2 && fractions.at(-1) < 0.01, 'only a tiny part of the 100 h was simulated');
  const reported = fractions.length;
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  assert.equal(fractions.length, reported, 'no work after the rejection');
});

test('abort: aborting from a timer works too, and the run does not finish', async () => {
  const controller = new AbortController();
  let last = 0;
  let armed = false;
  const onProgress = (p) => {
    last = p.fraction;
    if (!armed) { armed = true; setTimeout(() => controller.abort(), 15); } // the run has started: a timer ends it
  };
  await assert.rejects(runSimulation(example('starter'), { duration: 300 * 3600, signal: controller.signal, onProgress }), { name: 'AbortError' });
  assert.ok(last > 0 && last < 1, `stopped at ${last}`);
});

// ---------------------------------------------------------------------------------------------------------------------
// runReplications
// ---------------------------------------------------------------------------------------------------------------------

test('runReplications: replication r uses the seed (seed0 ?? settings.seed) + r', async () => {
  const layout = example('starter');
  updateSettings(layout, { seed: 40 });
  const base = await runReplications(layout, { replications: 3, duration: 1200 });
  assert.deepEqual(base.seeds, [40, 41, 42]);
  assert.equal(base.runs.length, 3);
  for (let r = 0; r < 3; r++) assert.deepEqual(base.runs[r], await runSimulation(layout, { duration: 1200, seed: 40 + r }));
  const custom = await runReplications(layout, { replications: 2, seed0: 100, duration: 1200 });
  assert.deepEqual(custom.seeds, [100, 101]);
  assert.deepEqual(custom.runs[1], await runSimulation(layout, { duration: 1200, seed: 101 }));
  assert.notDeepEqual(base.runs[0], base.runs[1], 'the seeds really differ');
  const wrap = await runReplications(layout, { replications: 2, seed0: 4294967295, duration: 300 });
  assert.deepEqual(wrap.seeds, [4294967295, 0], 'seeds wrap around at 32 bits');
});

test('runReplications: the summary holds mean, sample standard deviation, min, max and count of every metric', async () => {
  const { runs, summary } = await runReplications(example('congestion-lab'), { replications: 4, duration: 1800 });
  assert.deepEqual(Object.keys(summary), METRICS.map((m) => m.id));
  for (const m of METRICS) {
    const values = runs.map((r) => m.get(r)).filter((x) => x !== null);
    const s = summary[m.id];
    if (values.length === 0) {
      assert.deepEqual(s, { mean: null, sd: null, min: null, max: null, n: 0 });
      continue;
    }
    assert.equal(s.n, values.length);
    assert.ok(Math.abs(s.mean - mean(values)) < 1e-9, m.id);
    assert.ok(Math.abs(s.sd - sd(values)) < 1e-9, m.id);
    assert.equal(s.min, Math.min(...values));
    assert.equal(s.max, Math.max(...values));
  }
  assert.ok(summary.throughput.sd > 0 && summary.waitShare.sd > 0, 'different seeds give different results');
});

test('runReplications: one replication has zero spread; the options must make sense', async () => {
  const single = await runReplications(lineLayout(), { replications: 1, duration: 600 });
  assert.equal(single.runs.length, 1);
  for (const s of Object.values(single.summary)) assert.ok(s.n === 0 || (s.sd === 0 && s.min === s.max && s.mean === s.min));
  for (const replications of [0, -1, 1.5, NaN, '3']) await assert.rejects(runReplications(lineLayout(), { replications }), RangeError, `replications ${replications}`);
  const defaults = await runReplications(lineLayout(), { duration: 200 });
  assert.equal(defaults.runs.length, 3, 'three replications by default');
});

test('runReplications: progress covers all replications, labelled; an abort between runs rejects', async () => {
  const calls = [];
  await runReplications(lineLayout(), { replications: 3, duration: 300, warmup: 0, yieldEveryMs: 1, label: 'Case A', onProgress: (p) => calls.push(p) });
  assert.equal(calls[0].fraction, 0);
  assert.equal(calls.at(-1).fraction, 1);
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i].fraction >= calls[i - 1].fraction);
  assert.deepEqual([...new Set(calls.map((c) => c.label))], ['Case A: run 1 of 3', 'Case A: run 2 of 3', 'Case A: run 3 of 3']);
  const second = calls.find((c) => c.label.endsWith('2 of 3'));
  assert.ok(second.fraction >= 1 / 3 - 1e-9 && second.fraction <= 2 / 3 + 1e-9);

  const controller = new AbortController();
  let finishedRuns = 0;
  const run = runReplications(lineLayout(), {
    replications: 5, duration: 600, signal: controller.signal,
    onProgress: (p) => { if (p.fraction >= 1 / 5 && finishedRuns++ === 0) controller.abort(); },
  });
  await assert.rejects(run, { name: 'AbortError' });
});

// ---------------------------------------------------------------------------------------------------------------------
// Sweep parameters
// ---------------------------------------------------------------------------------------------------------------------

test('listSweepParameters: the parameters of THIS plant - fleets, global factors, machines, buffers, arrival intervals', () => {
  const keys = (layout) => listSweepParameters(layout).map((p) => p.key);
  assert.deepEqual(keys(example('starter')), [
    'fleet.v1.count', 'fleet.v1.speed', 'fleet.v1.capacity', 'speedFactor', 'demandFactor', 'processFactor', 'station.s1.interArrival', 'station.s2.machines',
  ]);
  const two = keys(example('two-lines'));
  for (const key of ['fleet.v1.count', 'fleet.v2.speed', 'fleet.v2.capacity', 'station.s4.capacity', 'station.s5.machines', 'station.s6.machines', 'station.s7.machines', 'station.s1.interArrival']) {
    assert.ok(two.includes(key), key);
  }
  assert.equal(two.length, 14);
  assert.ok(!two.includes('slowZones'), 'no slow zones in the plant, no slow-zone parameter');
  assert.deepEqual(keys(createLayout()), [], 'an empty plant has nothing to sweep');
  const noFleet = example('starter');
  noFleet.fleets = [];
  assert.ok(!keys(noFleet).some((k) => k.startsWith('fleet.') || k === 'speedFactor'));
  const noSource = example('starter');
  noSource.flows = [];
  noSource.stations = noSource.stations.filter((s) => s.type !== 'source');
  assert.ok(!keys(noSource).includes('demandFactor') && keys(noSource).includes('processFactor'));
  const noProcess = example('starter');
  noProcess.stations = noProcess.stations.filter((s) => s.type !== 'process');
  noProcess.flows = [];
  assert.ok(!keys(noProcess).includes('processFactor') && !keys(noProcess).some((k) => k.endsWith('.machines')));
  const zoned = example('two-lines');
  zoned.roads['10,6'].limit = 0.5;
  assert.ok(keys(zoned).includes('slowZones'));
});

test('listSweepParameters: labels, units and ranges are sensible and the suggested values lie inside them', () => {
  for (const e of EXAMPLES) {
    const layout = e.build();
    const params = listSweepParameters(layout);
    assert.equal(new Set(params.map((p) => p.key)).size, params.length);
    for (const p of params) {
      const where = `${e.id}/${p.key}`;
      assert.ok(typeof p.label === 'string' && p.label.length > 5 && typeof p.unit === 'string', where);
      for (const k of ['min', 'max', 'step']) assert.ok(Number.isFinite(p[k]), `${where}.${k}`);
      assert.ok(p.min < p.max && p.step > 0 && p.step <= p.max - p.min, where);
      const current = p.get(layout);
      assert.ok(Number.isFinite(current), `${where}: current value`);
      assert.ok(p.min <= current && current <= p.max, `${where}: ${p.min} <= ${current} <= ${p.max}`);
      assert.ok(p.values.length >= 3 && p.values.length <= 8, `${where}: ${p.values.length} suggested values`);
      assert.deepEqual(p.values, [...new Set(p.values)].sort((a, b) => a - b), `${where}: ascending and unique`);
      assert.ok(p.values.every((v) => Number.isFinite(v) && v >= p.min && v <= p.max), where);
      assert.ok(p.values.includes(current), `${where}: contains the current value ${current} in ${p.values}`);
    }
  }
});

test('listSweepParameters: apply() returns a modified deep copy, never touches its input, and get() reads the value back', () => {
  for (const e of EXAMPLES) {
    const layout = e.build();
    const frozen = structuredClone(layout);
    for (const p of listSweepParameters(layout)) {
      for (const v of p.values) {
        const next = p.apply(layout, v);
        assert.deepEqual(layout, frozen, `${e.id}/${p.key}: input modified by apply(${v})`);
        assert.notEqual(next, layout);
        assert.notEqual(next.stations, layout.stations);
        assert.notEqual(next.fleets, layout.fleets);
        assert.ok(Math.abs(p.get(next) - v) < 1e-9, `${e.id}/${p.key}: set ${v}, read back ${p.get(next)}`);
        assert.deepEqual(checkInvariants(next), [], `${e.id}/${p.key}=${v}`);
        assert.deepEqual(normalizeLayout(next), next, `${e.id}/${p.key}=${v} stays a normal layout`);
      }
      const current = p.get(layout);
      assert.deepEqual(p.apply(layout, current), layout, `${e.id}/${p.key}: applying the current value changes nothing`);
    }
  }
});

test('listSweepParameters: apply() changes exactly what the label says', () => {
  const layout = example('two-lines');
  const by = (key) => listSweepParameters(layout).find((p) => p.key === key);
  assert.equal(getFleet(by('fleet.v2.count').apply(layout, 9), 'v2').count, 9);
  assert.equal(getFleet(by('fleet.v2.count').apply(layout, 9), 'v1').count, 3, 'other fleets keep theirs');
  assert.equal(getFleet(by('fleet.v1.speed').apply(layout, 2.5), 'v1').speed, 2.5);
  assert.equal(getFleet(by('fleet.v1.capacity').apply(layout, 4), 'v1').capacity, 4);
  assert.equal(by('speedFactor').apply(layout, 1.5).settings.speedFactor, 1.5);
  assert.equal(by('demandFactor').apply(layout, 2).settings.demandFactor, 2);
  assert.equal(by('processFactor').apply(layout, 0.75).settings.processFactor, 0.75);
  assert.equal(getStation(by('station.s5.machines').apply(layout, 2), 's5').params.machines, 2);
  assert.equal(getStation(by('station.s4.capacity').apply(layout, 120), 's4').params.capacity, 120);
  const slower = getStation(by('station.s1.interArrival').apply(layout, 90), 's1');
  assert.equal(slower.params.interArrival.mean, 90);
  assert.equal(slower.params.interArrival.kind, 'normal', 'the rest of the distribution stays');
  assert.equal(slower.params.interArrival.spread, getStation(layout, 's1').params.interArrival.spread);
});

test('listSweepParameters: values outside the model\'s limits are clamped, junk values change nothing, missing entities read null', () => {
  const layout = example('starter');
  const count = listSweepParameters(layout).find((p) => p.key === 'fleet.v1.count');
  assert.equal(getFleet(count.apply(layout, 100000), 'v1').count, 500);
  assert.equal(getFleet(count.apply(layout, 0), 'v1').count, 0, 'a fleet may be switched off in a sweep');
  assert.equal(getFleet(count.apply(layout, 2.6), 'v1').count, 3);
  for (const junk of [NaN, Infinity, undefined, null, '3']) assert.deepEqual(count.apply(layout, junk), layout);
  const other = example('congestion-lab');
  other.fleets = [];
  assert.equal(count.get(other), null);
  assert.deepEqual(count.apply(other, 5), other, 'nothing to change in a plant without that fleet');
});

test('listSweepParameters: slow zones are one parameter for all zone cells; 1 removes them', () => {
  const layout = example('starter');
  layout.roads['5,9'].limit = 0.5;
  layout.roads['6,9'].limit = 0.7;
  const zones = listSweepParameters(layout).find((p) => p.key === 'slowZones');
  assert.equal(zones.get(layout), 0.5, 'the current value is the slowest zone');
  const quick = zones.apply(layout, 0.8);
  assert.equal(quick.roads['5,9'].limit, 0.8);
  assert.equal(quick.roads['6,9'].limit, 0.8);
  assert.equal(quick.roads['7,9'].limit, undefined, 'plain road cells stay plain');
  const none = zones.apply(layout, 1);
  assert.ok(Object.values(none.roads).every((cell) => cell.limit === undefined));
  assert.equal(zones.get(none), 1);
  assert.equal(layout.roads['5,9'].limit, 0.5);
  assert.deepEqual(checkInvariants(quick), []);
});

// ---------------------------------------------------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------------------------------------------------

test('sweep: throughput of a transport-limited plant grows with the number of vehicles and never drops by more than noise', async () => {
  const layout = transportLimited(1);
  const count = listSweepParameters(layout).find((p) => p.key === 'fleet.v1.count');
  const results = await sweep(layout, count, [1, 2, 3, 4, 5, 6], { replications: 3, duration: 3600, warmup: 600 });
  assert.deepEqual(results.map((r) => r.value), [1, 2, 3, 4, 5, 6]);
  const thr = results.map((r) => r.summary.throughput.mean);
  for (let i = 1; i < thr.length; i++) assert.ok(thr[i] >= thr[i - 1] * 0.97, `${thr[i - 1].toFixed(1)} -> ${thr[i].toFixed(1)} loads/h with one more vehicle`);
  assert.ok(thr[2] > 1.8 * thr[0], `three vehicles move ${thr[2].toFixed(1)} against ${thr[0].toFixed(1)} loads/h`);
  assert.ok(thr[5] > thr[0] * 2.5);
  const util = results.map((r) => r.summary.fleetUtilization.mean);
  for (let i = 1; i < util.length; i++) assert.ok(util[i] <= util[i - 1] + 2, 'the same work spread over more vehicles: lower utilization');
  for (const r of results) {
    assert.equal(r.runs.length, 3);
    assert.deepEqual(Object.keys(r.summary), METRICS.map((m) => m.id));
  }
});

test('sweep: every value is simulated with the same seeds, exactly like a direct run of the modified layout', async () => {
  const layout = lineLayout({ vehicles: 4, gap: 6, arrival: 60, cycle: 10, settings: { seed: 5 } });
  const demand = listSweepParameters(layout).find((p) => p.key === 'demandFactor');
  const results = await sweep(layout, demand, [0.5, 1, 2], { replications: 2, duration: 2400, warmup: 300 });
  for (const r of results) {
    const direct = await runReplications(demand.apply(layout, r.value), { replications: 2, duration: 2400, warmup: 300 });
    assert.deepEqual(r.runs, direct.runs);
    assert.deepEqual(direct.seeds, [5, 6]);
  }
  const thr = results.map((x) => x.summary.throughput.mean);
  assert.ok(thr[1] > 1.7 * thr[0] && thr[2] > 1.7 * thr[1], `a source-limited plant delivers what arrives: ${thr.map((x) => x.toFixed(1))} loads/h at 0.5x, 1x, 2x demand`);
});

test('sweep: accepts a parameter key, rejects unknown ones, leaves the layout alone, reports progress over all values', async () => {
  const layout = transportLimited(2);
  const frozen = structuredClone(layout);
  const calls = [];
  const results = await sweep(layout, 'fleet.v1.count', [1, 2], { replications: 2, duration: 300, warmup: 0, yieldEveryMs: 1, onProgress: (p) => calls.push(p) });
  assert.equal(results.length, 2);
  assert.deepEqual(layout, frozen);
  assert.equal(calls.at(-1).fraction, 1);
  assert.ok(calls.every((c, i) => i === 0 || c.fraction >= calls[i - 1].fraction));
  const labels = [...new Set(calls.map((c) => c.label))];
  assert.equal(labels.length, 4, 'one label per value and replication');
  assert.deepEqual(labels.slice(0, 2), ['AGV: number of vehicles = 1 vehicles: run 1 of 2', 'AGV: number of vehicles = 1 vehicles: run 2 of 2']);
  await assert.rejects(sweep(layout, 'fleet.nope.count', [1]), TypeError);
  await assert.rejects(sweep(layout, undefined, [1]), TypeError);
  await assert.rejects(sweep(layout, 'fleet.v1.count', 'not an array'), TypeError);
  assert.deepEqual(await sweep(layout, 'fleet.v1.count', [], { duration: 100 }), []);
});

test('sweep: an abort stops the sweep', async () => {
  const controller = new AbortController();
  const run = sweep(transportLimited(1), 'fleet.v1.count', [1, 2, 3, 4], {
    replications: 2, duration: 1800, signal: controller.signal,
    onProgress: (p) => { if (p.fraction > 0.3) controller.abort(); },
  });
  await assert.rejects(run, { name: 'AbortError' });
});

// ---------------------------------------------------------------------------------------------------------------------
// compareScenarios
// ---------------------------------------------------------------------------------------------------------------------

test('compareScenarios: the variant with more vehicles ranks higher on a transport-limited plant', async () => {
  const scenarios = [
    { id: 'a', name: 'One truck', layout: transportLimited(1) },
    { id: 'b', name: 'Four trucks', layout: transportLimited(4) },
    { id: 'c', name: 'Two trucks', layout: transportLimited(2) },
  ];
  const frozen = structuredClone(scenarios);
  const results = await compareScenarios(scenarios, { replications: 2, duration: 3600, warmup: 600 });
  assert.deepEqual(scenarios, frozen, 'the scenarios are not modified');
  assert.deepEqual(results.map((r) => [r.id, r.name]), [['a', 'One truck'], ['b', 'Four trucks'], ['c', 'Two trucks']]);
  const thr = Object.fromEntries(results.map((r) => [r.id, r.summary.throughput.mean]));
  assert.ok(thr.b > thr.c && thr.c > thr.a, JSON.stringify(thr));
  const ranking = [...results].sort((x, y) => y.summary.throughput.mean - x.summary.throughput.mean).map((r) => r.id);
  assert.deepEqual(ranking, ['b', 'c', 'a']);
  assert.ok(results[1].summary.leadMean.mean < results[0].summary.leadMean.mean, 'and the loads get through faster');
  for (const r of results) {
    assert.equal(r.runs.length, 2);
    assert.deepEqual(Object.keys(r.summary), METRICS.map((m) => m.id));
    for (const run of r.runs) assertAllFinite(run);
  }
});

test('compareScenarios: identical scenarios give identical results; progress covers every scenario with its name', async () => {
  const layout = example('starter');
  const calls = [];
  const results = await compareScenarios(
    [{ id: 'x', name: 'Plan A', layout }, { id: 'y', name: 'Plan B', layout: cloneLayout(layout) }],
    { replications: 2, duration: 300, warmup: 0, yieldEveryMs: 1, onProgress: (p) => calls.push(p) },
  );
  assert.deepEqual(results[0].summary, results[1].summary);
  assert.deepEqual(results[0].runs, results[1].runs);
  assert.equal(calls.at(-1).fraction, 1);
  const labels = [...new Set(calls.map((c) => c.label))];
  assert.deepEqual(labels, ['Plan A: run 1 of 2', 'Plan A: run 2 of 2', 'Plan B: run 1 of 2', 'Plan B: run 2 of 2']);
  assert.deepEqual(await compareScenarios([], { duration: 100 }), []);
  await assert.rejects(compareScenarios('nope'), TypeError);
});

test('compareScenarios: scenarios with their own seeds are simulated with those seeds unless seed0 is given', async () => {
  const a = lineLayout({ settings: { seed: 3 } });
  const b = lineLayout({ settings: { seed: 4 } });
  const [ra, rb] = await compareScenarios([{ id: 'a', name: 'A', layout: a }, { id: 'b', name: 'B', layout: b }], { replications: 1, duration: 600 });
  assert.deepEqual(ra.runs[0], await runSimulation(a, { duration: 600, seed: 3 }));
  assert.deepEqual(rb.runs[0], await runSimulation(b, { duration: 600, seed: 4 }));
  const [sa, sb] = await compareScenarios([{ id: 'a', name: 'A', layout: a }, { id: 'b', name: 'B', layout: b }], { replications: 1, duration: 600, seed0: 9 });
  assert.deepEqual(sa.runs[0], await runSimulation(a, { duration: 600, seed: 9 }));
  assert.deepEqual(sb.runs[0], await runSimulation(b, { duration: 600, seed: 9 }));
});

// ---------------------------------------------------------------------------------------------------------------------
// The tips of the examples refer to real things: the numbers, stations and variants they name exist and can be run.
// That the figures they promise are true over the default run length of 8 simulated hours is tested in
// tests/sim.engine.review.test.js ('tips': worker threads, several seeds, every figure).
// ---------------------------------------------------------------------------------------------------------------------

const stationNamed = (layout, name) => layout.stations.find((s) => s.name === name);

/** The variant a tip describes must be a valid layout that simulates without a fault. */
function assertRuns(layout, what) {
  assert.deepEqual(checkInvariants(layout), [], what);
  assert.deepEqual(validateLayout(layout).filter((i) => i.severity === 'error'), [], `${what}: no errors in the Checks tab`);
  const sim = new Simulation(layout, { seed: 1 });
  sim.advance(900);
  assertAllFinite(sim.kpis());
  assert.ok(sim.logistics.completed > 0 || sim.logistics.liveLoads > 0, `${what}: something happens`);
}

test('Starter tips: the plant has the two AGVs and the Assembly they talk about; the variants run; a station without a road is reported', () => {
  const layout = example('starter');
  assert.equal(getFleet(layout, 'v1').count, 2, 'the tip lowers the count of two AGVs to 1');
  assert.ok(stationNamed(layout, 'Assembly') && stationNamed(layout, 'Goods receiving'));
  assertRuns(variantOf('starter', (l) => updateFleet(l, 'v1', { count: 1 })), 'one AGV');
  assertRuns(variantOf('starter', (l) => updateSettings(l, { demandFactor: 1.5 })), 'demand x 1.5');

  const moved = example('starter');
  const dispatch = stationNamed(moved, 'Dispatch');
  const oldBay = [dispatch.x - 1, dispatch.y + dispatch.h - 1];
  assert.ok(moveStation(moved, dispatch.id, dispatch.x, dispatch.y - 4));
  assert.deepEqual(validateLayout(moved).filter((i) => i.severity === 'error').map((i) => [i.code, i.refs.stationId]), [['station-no-dock', dispatch.id]]);
  paintRoadPath(moved, [oldBay, [oldBay[0], oldBay[1] - 4]]);
  assert.deepEqual(validateLayout(moved).filter((i) => i.severity === 'error'), [], 'redrawing the road so that it touches again clears the error');
});

test('Two lines tips: the AGVs, chargers and the Press line they talk about are there with the values they start from; the variants run', () => {
  const layout = example('two-lines');
  assert.equal(getFleet(layout, 'v2').count, 7, 'the tip names the real number of AGVs');
  assert.equal(getFleet(layout, 'v2').battery.chargeTimeMin, 15);
  assert.equal(stationNamed(layout, 'AGV charging').params.chargers, 4);
  assert.equal(stationNamed(layout, 'Press line').params.mttr, 420);
  assertRuns(variantOf('two-lines', (l) => updateSettings(l, { demandFactor: 1.3 })), 'demand x 1.3');
  for (const count of [5, 8]) assertRuns(variantOf('two-lines', (l) => updateFleet(l, 'v2', { count })), `${count} AGVs`);
  assertRuns(variantOf('two-lines', (l) => {
    updateFleet(l, 'v2', { battery: { chargeTimeMin: 60 } });
    updateStation(l, stationNamed(l, 'AGV charging').id, { params: { chargers: 1 } });
  }), 'slow charging and one charger');
  assertRuns(variantOf('two-lines', (l) => updateStation(l, stationNamed(l, 'Press line').id, { params: { mttr: 1800 } })), 'repair time 30 min');
});

test('Congestion lab tips: the vehicles, hand-over time and docks they talk about are there; the variants run; a second dock for Packing shortens the queue', async () => {
  const layout = example('congestion-lab');
  const opts = { replications: 3, hours: 1.5 };
  const base = await measureRuns(layout, opts);
  const run = (edit) => measureRuns(variantOf('congestion-lab', edit), opts);
  const wait = (r) => r.traffic.waitShare;

  assert.equal(layout.fleets[0].count, 9, 'the tip names the real number of AGVs');
  assert.equal(layout.fleets[0].loadTime, 24, 'the tip names the real hand-over time');
  assert.equal(layout.fleets[0].capacity, 1);
  const packingDock = docksOf(layout, stationNamed(layout, 'Packing').id);
  assert.ok(packingDock.every(([, cy]) => cy === 8), 'Packing\'s docks are on the main aisle');
  for (const patch of [{ count: 6 }, { count: 10 }, { capacity: 2 }, { loadTime: 12, unloadTime: 12 }]) {
    assertRuns(variantOf('congestion-lab', (l) => updateFleet(l, 'v1', patch)), JSON.stringify(patch));
  }

  // moving the one dock off the aisle alone does not help: the queue just moves into the bay (a dock serves one vehicle at a time)
  const spur = await run((l) => {
    assert.ok(moveStation(l, stationNamed(l, 'Packing').id, 29, 2));
    paintRoadPath(l, [[30, 8], [30, 5]]);
  });
  assert.ok(pairedDiffs(base, spur, wait).every((d) => d > 0), 'Packing on a short dead-end spur waits more for every seed');

  const second = await run((l) => paintRoadPath(l, [[24, 4], [32, 4], [32, 8]], { oneWay: true }));
  assert.ok(pairedDiffs(base, second, wait).every((d) => d < 0), 'for every seed Packing\'s second dock removes waiting');
  assert.ok(mean(pairedDiffs(base, second, (r) => r.leadTime.mean)) < 0, 'the lead time falls');
  assert.ok(second.every((r) => r.traffic.deadlocks === 0));
});
