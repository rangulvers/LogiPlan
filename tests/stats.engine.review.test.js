// Adversarial review of the ENGINE side of the click-an-item statistics (docs/ENTITY-INSIGHTS-DESIGN.md, step S1): the optional detail collector js/sim/detail.js and its seams
// (Simulation.step, enableDetail / disableDetail / dropDetail, TrafficSystem.waitNodeOf, the two exports of insights.js), attacked from outside for NEUTRALITY (the collector may not
// change anything a simulation does), CONTAINMENT (it may not be able to stop one, and the UI is told), DETERMINISM, MEMORY, COST and the honesty of what it records.
//
// What is different from the builder's own tests (tests/sim.detail.*.test.js, tests/sim.golden.detail.test.js, the ledgers of tests/sim.seams.test.js):
//  * the plants come from the OTHER generators of the repository (tests/helpers/stats-engine-gen.js composes engine-review-gen, m1-sim-review-gen, docks-review-gen, trucks-gen), and
//    what a run is compared with is read from the public surface of a Simulation after each tick (events, poses, states, counters, kpis, heat map, traffic statistics, deadlock list);
//  * "reads only, mutates nothing" is PROVED, not inferred from equal outputs: the collector runs on a deep read-only view of the simulation that records every write (B1), and the
//    view itself is attacked by eight mutants of the collector (B2);
//  * the figures are checked against an independent observer that tallies the same quantities from outside (tick by tick), for dt that do not divide 30 s, with and without warm-up;
//  * the runner, the store and the real engine are attacked together (R1): an edit, a pre-roll, a swap, a forced failure, the preference switched off and on.
//
// Two kinds of tests (same convention as sim.engine.review.test.js):
//   STAT-ENG-GUARD-<area>-<n>   guards: attacks that did NOT break anything; they document what was tried and keep it that way.
//   STAT-ENG-REV-<n>            one test per REAL defect the review found. Each was marked `todo` while it was open (it ran and failed, the suite stayed green); the core fixer repaired
//                               all seven and the tests are plain regression tests now. What was wrong, and what was done:
//
// Defects (severity: high = any change of kpis / behaviour, a throw into step(), a hang, unbounded memory, a missed budget; medium = a wrong collector figure, a seam the next step
// cannot use, a vacuous test; low = polish). Nothing high was found.
//   STAT-ENG-REV-1  medium  (fixed: detail.js legCoverage().since is the latest filing time of a dropped leg and every leg query counts from it; stats-model.js divides the trip rows by that
//                           span and says "the last N drives, since H:MM") Once the leg log has wrapped (32,768 legs: 17 simulated hours on the 100-vehicle plant, about 3 days on Two lines)
//                           the Trips block, the queue rows and the usual round were made from the LAST legs only, but the dock said "Counted since 0:10" and divided the trips by the whole window:
//                           a route that ran 6.7 trips an hour in the 36 minutes the log still holds read "4 trips, 1.4/h" (Two lines, 3 h, a log of 300 legs).
//   STAT-ENG-REV-2  low     (fixed: tests/helpers/detail-ledger.js, one function shared with tests/sim.seams.test.js) The ledger of who may read .detail was a regex; it missed
//                           `const { detail } = sim`, `sim['detail']`, an alias, `this.detail`, a double-quoted import of sim/detail.js and a dynamic import.
//   STAT-ENG-REV-3  low     (fixed: a Uint16 column `dep` in the charge sessions, det.chargeStopsAt(depot, w)) A charge session did not record the depot it charged at.
//   STAT-ENG-REV-4  low     (fixed: the cell tables hold float64 seconds) hotQ and hotStray were float32 sums of 0.05 s steps, which drifted by 5e-5 to 2e-4 of themselves; hotspots() subtracts
//                           the queue seconds from the streak, so a cell where the vehicle ONLY queued showed phantom seconds (0.02 s after 383 s at dt 0.05, 0.18 s at worst on hostile dock plants).
//   STAT-ENG-REV-5  low     (fixed: docs/ARCHITECTURE.md 5.5) said `sim.enableDetail(opts?) -> Detail`; the engine returns null (and sets sim.detailError) when the collector cannot start.
//   STAT-ENG-REV-6  low     (fixed: alloc() keeps the path pool) A restart of the collector (the vehicle or station list changed) made a NEW path pool, so path ids handed out before meant other
//                           cells afterwards; ui/render/routes.js caches the geometry of a path id.
//   STAT-ENG-REV-7  low     (fixed: an index of the paths by cell, built on the first cellUse call) cellUse took 37 to 60 ms per call on a full leg log and path pool of the 100-vehicle
//                           plant; the cache by `version` that the design proposed cannot hit (version changes with every leg that closes). Now about 40 ms once, then about 1 ms.
//
// Attacks that found nothing (the guards; numbers of the scratch runs that this file repeats at a smaller scale, `STATS_ENGINE_REVIEW_HEAVY=1` repeats them at the full one):
//   neutrality   200 plants (hostile, truck, dock, hostile dock and fuzz plants of seeds 1 to 40) x 7 collector modes against the UNTOUCHED tree (git a09f30e, the merge of PR #10): 1,400 runs,
//                kpis, heat map, traffic statistics, every pose, the deadlock list and the event stream bit-identical, also with the collector dropped by a throwing handler or afterTick, switched
//                off and on in the middle, enabled late and twice; 5 examples x 4 seeds x 2 tick lengths x 8 simulated hours x 7 modes (280 runs) identical; tick lengths 0.07 to 0.5 s, warm-ups
//                0 to 200 s, runtime changes of all five what-if settings in the middle of a run; corrupted vehicle state (NaN battery, NaN stateSince, NaN position)
//   read-only    the collector on a deep read-only view of the simulation: 0 writes by its poll, its five event handlers, the dock-queue test, waitNodeOf and every query on 14 plants
//                (and every one of 10 injected writes caught)
//   exactness    an independent per-tick observer of the time split equals the collector's Since start and Last 30 min to 3e-5 s at tick lengths 0.07, 0.1, 0.3 and 0.45 (68 runs); legs never hold more
//                seconds than the vehicle spent in a driving state; every delivery has its loaded leg (except the one in progress when the window began) on 295 plants and 6,829 deliveries; every
//                logged path decodes to the route object it came from; the cell tables equal traffic's nodeWait (and cell by cell an independent tally) except for the known one-tick gap per deadlock
//                relocation (up to 0.8 % on a hostile plant with 38 relocations in 1,500 s at dt 0.25; the documentation says 0.1 %)
//   containment  six entries throwing, a constructor that throws, 300 switches on and off, the vehicle and station lists replaced and emptied, the runner (edit, pre-roll, swap, forced failure,
//                preference off and on, the paired control run has no collector)
//   memory       24 simulated hours on the 320 x 320 plant with the routing switched every three hours: heap 87 to 113 MB with no trend, resident set flat at 440 MB, typed columns 1.5 MB after one hour
//                and 3.8 MB after 24 (the path pool fills towards its cap of 16,384; every other structure is bounded from the first hours)
//   the model    4,116 dock models of every item of 61 hostile plants in both windows: no NaN, no Infinity, no negative amount, no share above 100 %
//   cost         see PERF at the end (opt-in): on a quiet machine the collector on keeps 545 to 647 x real time on the big plant (gate 500 x), 25,000 to 87,000 x on the examples
//
// Switches (environment): STATS_ENGINE_REVIEW_HEAVY=1 runs the expensive versions (150 plants, 8 hours of the examples, 24 hours of the biggest plant, the cost measurements);
// STATS_ENGINE_REVIEW_OLD_TREE=<dir> compares with an untouched tree (a directory that holds js/ and package.json, e.g. `git archive a09f30e js package.json | tar -x -C <dir>`; no git is
// run by this file). Without them the file takes about 8 seconds; with STATS_ENGINE_REVIEW_HEAVY=1 about 15 minutes (the 24 hours of the big plant are 6 of them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Simulation } from '../js/sim/engine.js';
import { runSimulation } from '../js/sim/experiments.js';
import { Detail, NOTICE_CAP, WHATIF_CAP, SLOT_KEYS } from '../js/sim/detail.js';
import * as L from '../js/model/layout.js';
import { EXAMPLES } from '../js/model/examples.js';
import { buildStatsModel } from '../js/ui/panels/stats-model.js';
import { callEveryQuery, detailDigest } from './helpers/detail-digest.js';
import { detailStrays } from './helpers/detail-ledger.js';
import { everySelection, liveInput, modelProblems } from './helpers/stats-fixtures.js';
import {
  MODES, REVIEW_PLANTS, SPLIT_KEYS, chargingPlant, exampleOf, featuresOf, listenerCount, observedRun, plantOf, readOnlyView, reviewCorpus, runTrace, runnerRig, withSettings,
} from './helpers/stats-engine-gen.js';

const HEAVY = process.env.STATS_ENGINE_REVIEW_HEAVY === '1';
const OLD_TREE = process.env.STATS_ENGINE_REVIEW_OLD_TREE ? path.resolve(process.env.STATS_ENGINE_REVIEW_OLD_TREE) : null;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const heavy = (name, fn) => test(name, HEAVY ? {} : { skip: 'expensive: set STATS_ENGINE_REVIEW_HEAVY=1' }, fn);
/** A defect this review found (marked `todo` while it was open, a plain test since the core fixer repaired it): the arguments after the name are what was wrong and where, kept as documentation. */
const defect = (id, name, why, fn) => test(`${id}: ${name}`, fn);
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
/** Identity or value equality that never prints its operands (a collector or a KPI text is megabytes: assert.equal would spend minutes on a diff). */
const same = (a, b, message = 'values differ') => assert.ok(a === b, typeof a === 'object' || typeof b === 'object' || (typeof a === 'string' && a.length > 60) ? message : `${message}: ${String(a)} against ${String(b)}`);

/** The plants of the default corpus (and of the heavy one: every family of seeds 1 to 30). */
const corpus = () => (HEAVY ? [...reviewCorpus(range(1, 30)), chargingPlant()] : [...REVIEW_PLANTS.map(([family, seed]) => plantOf(family, seed)), chargingPlant()]);
const HORIZON = HEAVY ? 900 : 450;

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// 1. neutrality: the collector changes nothing a simulation does
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

test('STAT-ENG-GUARD-N1: every collector mode (on, switched off and on, late, enabled twice, dropped by a throwing handler or afterTick, dropped and enabled again) runs the same simulation as no collector', () => {
  const plants = corpus();
  const reached = { relocated: 0, zero: 0, paused: 0, partial: 0, rerouted: 0, dead: 0, broken: 0, charged: 0, deadlocks: 0, balanced: 0, forcedDrops: 0, reattached: 0, events: 0 };
  for (const plant of plants) {
    const ref = runTrace(plant, 'plain', { horizon: HORIZON });
    reached.events += ref.events;
    same(ref.sim.detail, null, `${plant.name}: a plain Simulation has no collector`);
    same(listenerCount(ref.sim), 1, `${plant.name}: a plain Simulation has only this test's own listener`);
    for (const mode of MODES.filter((m) => m !== 'plain')) {
      const run = runTrace(plant, mode, { horizon: HORIZON });
      same(run.digest, ref.digest, `${plant.name}: mode ${mode} changed what the simulation did`);
      if (mode === 'on') {
        const f = featuresOf(run.sim);
        for (const k of ['relocated', 'zero', 'paused', 'partial', 'rerouted', 'dead', 'broken', 'charged', 'deadlocks', 'balanced']) reached[k] += f[k] > 0 ? 1 : 0;
      }
      if (mode === 'dropped-afterTick' && run.forced) { reached.forcedDrops++; same(run.sim.detail, null, `${plant.name}: dropped`); assert.match(run.sim.detailError.message, /boom/); same(listenerCount(run.sim), 1, `${plant.name}: a dropped collector leaves no listener behind`); }
      if (mode === 'drop-reenable' && run.forced) { reached.reattached += run.sim.detail !== null && run.sim.detailError === null ? 1 : 0; }
      if (mode === 'on' || mode === 'toggle') assert.ok(run.sim.detail !== null, `${plant.name} ${mode}: the collector is still attached at the end`);
      if (mode === 'enableTwice') assert.ok(run.sim.detail === null, `${plant.name}: switched off by the script at 60 %`);
    }
  }
  assert.ok(reached.events > 200, `${reached.events} events were compared`);
  assert.ok(reached.forcedDrops >= plants.length - 1, `${reached.forcedDrops} of ${plants.length} forced drops happened`);
  assert.ok(reached.reattached >= plants.length - 1, `${reached.reattached} collectors were enabled again after a drop`);
  // the corners the comparison is about were really there (a generator that loses one weakens every test below without a word)
  const need = HEAVY ? 3 : 1; // charge sessions come from the one plant built for them
  for (const k of ['relocated', 'zero', 'paused', 'partial', 'rerouted', 'dead', 'broken', 'charged', 'deadlocks', 'balanced']) assert.ok(reached[k] >= (k === 'charged' ? 1 : need), `too few plants of the corpus reached "${k}" (${JSON.stringify(reached)})`);
});

test('STAT-ENG-GUARD-N2: runtime what-if changes in the middle of the run (demand, speed, process time, dispatch, routing), odd tick lengths and warm-ups change nothing either', () => {
  const runtime = [
    { at: 100, kind: 'runtime', patch: { demandFactor: 1.5 } }, { at: 180, kind: 'runtime', patch: { speedFactor: 0.5 } }, { at: 260, kind: 'runtime', patch: { routing: 'congestion' } },
    { at: 340, kind: 'runtime', patch: { dispatch: 'oldest', processFactor: 2 } }, { at: 420, kind: 'runtime', patch: { demandFactor: 1, speedFactor: 1, processFactor: 1 } },
  ];
  const base = { ...exampleOf('two-lines'), actions: runtime };
  let compared = 0;
  for (const [dt, warmup] of HEAVY ? [[0.07, 0], [0.3, 61.3], [0.45, 200], [0.5, 90]] : [[0.07, 0], [0.3, 61.3], [0.45, 200]]) {
    const plant = withSettings(base, { dt, warmup });
    const ref = runTrace(plant, 'plain', { horizon: 600, sampleEvery: 20 });
    for (const mode of HEAVY ? ['on', 'toggle', 'late', 'dropped-afterTick'] : ['on', 'toggle', 'dropped-afterTick']) {
      const run = runTrace(plant, mode, { horizon: 600, sampleEvery: 20 });
      same(run.digest, ref.digest, `dt ${dt} warm-up ${warmup} mode ${mode}`);
      compared++;
      if (mode === 'on') assert.ok(run.sim.detail.whatIf.length >= 4, `the collector noted ${run.sim.detail.whatIf.length} what-if changes at dt ${dt}`);
    }
  }
  assert.ok(compared >= 9);
});

test('STAT-ENG-GUARD-N3: a plain Simulation, the experiments (runSimulation) and the paired control run of the runner never switch the collector on', async () => {
  let enabled = 0;
  const original = Simulation.prototype.enableDetail;
  Simulation.prototype.enableDetail = function counted(...args) { enabled++; return original.apply(this, args); };
  try {
    const plant = exampleOf('starter');
    const sim = new Simulation(plant.layout, { seed: 1 });
    same(sim.detail, null);
    same(sim.detailError, null);
    same(listenerCount(sim), 0, 'nothing listens on a new simulation');
    await runSimulation(plant.layout, { duration: 300, warmup: 60 });
    same(enabled, 0, 'runSimulation never asks for a collector');
    const rig = runnerRig({ tick: 0 });
    await rig.runTo(1500);
    same(enabled, 1, 'the runner asked once, for the simulation on screen');
    rig.store.commit('Add Goods in', (l) => { L.addStation(l, { type: 'source', x: 2, y: 2 }); });
    rig.until(() => rig.runner.sim !== rig.made[0] && !rig.runner.priming);
    same(enabled, 2, 'one more for the replacement; the paired control run (the old plant, simulated afresh) asked for none');
    const control = rig.made.filter((s) => s !== rig.made[0] && s !== rig.runner.sim);
    assert.ok(control.length >= 1, 'the comparison with the old plant was simulated');
    for (const s of control) same(s.detail, null, 'a control run has no collector');
    rig.runner.destroy();
  } finally {
    Simulation.prototype.enableDetail = original;
  }
});

const untouched = OLD_TREE && existsSync(path.join(OLD_TREE, 'js', 'sim', 'engine.js')) ? await import(pathToFileURL(path.join(OLD_TREE, 'js', 'sim', 'engine.js')).href) : null;
test('STAT-ENG-GUARD-N4: against the UNTOUCHED tree (before the collector) every mode is bit-identical, on the whole corpus', { skip: untouched ? false : 'set STATS_ENGINE_REVIEW_OLD_TREE=<a directory with js/ and package.json of the tree before the collector>' }, () => {
  let compared = 0;
  for (const plant of corpus()) {
    const ref = runTrace(plant, 'plain', { horizon: HORIZON, Sim: untouched.Simulation });
    for (const mode of MODES) { same(runTrace(plant, mode, { horizon: HORIZON }).digest, ref.digest, `${plant.name} ${mode} against the untouched tree`); compared++; }
  }
  assert.ok(compared >= 40, `${compared} runs compared`);
});

heavy('STAT-ENG-GUARD-N5: 5 examples x 2 seeds x 2 tick lengths x 8 simulated hours: the working tree without a collector and with every mode equals the plain run', () => {
  let compared = 0;
  for (const seed of [1, 2]) {
    for (const dt of [0.1, 0.25]) {
      for (const id of ['starter', 'two-lines', 'congestion-lab', 'dock-lab', 'warehouse-first-day']) {
        const plant = withSettings(exampleOf(id, seed), { dt });
        const ref = runTrace(plant, 'plain', { horizon: 8 * 3600, sampleEvery: 20000 });
        for (const mode of ['on', 'toggle', 'late', 'dropped-afterTick', 'drop-reenable']) { same(runTrace(plant, mode, { horizon: 8 * 3600, sampleEvery: 20000 }).digest, ref.digest, `${id} seed ${seed} dt ${dt} ${mode}`); compared++; }
        if (untouched) { same(runTrace(plant, 'plain', { horizon: 8 * 3600, sampleEvery: 20000, Sim: untouched.Simulation }).digest, ref.digest, `${id} seed ${seed} dt ${dt}: working tree off against the untouched tree`); compared++; }
      }
    }
  }
  assert.ok(compared >= 100);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// 2. the collector reads and records; it writes nothing (a deep read-only view, and the view attacked)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

/** Run `plant` with a collector built on a read-only view; returns the violations and the collector. */
function onReadOnlyView(plant, seconds, mutant = null) {
  const sim = new Simulation(plant.layout, { seed: plant.seed });
  const violations = [];
  const view = readOnlyView(sim, violations);
  const Collector = mutant ? class extends Detail { afterTick(dt, fresh) { mutant(this); super.afterTick(dt, fresh); } } : Detail;
  const det = new Collector(view);
  sim.detail = det;
  const actions = (plant.actions || []).map((a) => ({ ...a }));
  while (sim.time < seconds && sim.detail) {
    while (actions.length && actions[0].at <= sim.time) {
      const a = actions.shift();
      if (a.kind === 'removeVehicle' && sim.logistics.vehicles.length) sim.logistics.removeVehicle(sim.logistics.vehicles[a.index % sim.logistics.vehicles.length]);
      else if (a.kind === 'demand') sim.setRuntime({ demandFactor: a.value || 0.0001 });
    }
    sim.step();
  }
  return { sim, det, violations };
}

test('STAT-ENG-GUARD-B1: on a deep read-only view of the simulation the poll, the five event handlers, the dock-queue test, waitNodeOf and every query make no write at all', () => {
  const plants = [withSettings(exampleOf('two-lines'), { warmup: 0 }), ...REVIEW_PLANTS.slice(0, 3).map(([family, seed]) => plantOf(family, seed)), ...(HEAVY ? [exampleOf('dock-lab'), exampleOf('warehouse-first-day')] : [])];
  let legs = 0;
  let queued = 0;
  for (const plant of plants) {
    const { sim, det, violations } = onReadOnlyView(plant, 420);
    assert.ok(sim.detail === det, `${plant.name}: the collector survived on the view`);
    callEveryQuery(det);
    det.hotspots(0, 64);
    assert.deepEqual(violations, [], `${plant.name}: the collector wrote to the simulation`);
    legs += det.legs.count;
    queued += det.hotQ.secs.reduce((a, b) => a + b, 0) > 0 ? 1 : 0;
  }
  assert.ok(legs > 40, `${legs} legs were filed through the view (the run was not idle)`);
  assert.ok(queued >= 1, 'a dock queue was seen through the view, so waitsForDock ran');
});

test('STAT-ENG-GUARD-B2: the read-only view catches an injected write of every kind (a vehicle, a traffic vehicle, a statistics array, the dock book, a route, a load queue, a Map, the clock)', () => {
  const mutants = {
    vehicle: (d) => { d.V[0].trips = d.V[0].trips; },
    trafficVehicle: (d) => { d.V[0].tv.waiting = d.V[0].tv.waiting; },
    statisticsArray: (d) => { d.traffic.stats.nodeWait[3] += 0; },
    dockBook: (d) => { d.lg.docks.zzz = 1; },
    route: (d) => { for (const v of d.V) if (v.route) { v.route.nodes[0] = v.route.nodes[0]; return; } },
    loadQueue: (d) => { for (const s of d.stations) for (const l of s.outLinks || []) if (l.queue.length) { l.claimed = l.claimed; return; } },
    map: (d) => { d.graph.stationsAt.set(-5, []); },
    clock: (d) => { d.sim.time = d.sim.time; },
  };
  for (const [name, mutant] of Object.entries(mutants)) {
    const { violations } = onReadOnlyView(exampleOf('two-lines'), 120, mutant);
    assert.ok(violations.length > 0, `the write "${name}" was not seen: the view cannot prove anything`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// 3. containment: the collector is optional and cannot stop the run; the UI is told
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

/** The kpis of a twin that never had a collector, advanced to the same time. */
const plainKpis = (plant, seconds) => { const twin = new Simulation(plant.layout, { seed: plant.seed }); twin.advance(seconds); return JSON.stringify(twin.kpis()); };

test('STAT-ENG-GUARD-C1: each entry of the collector throwing (afterTick and the five event handlers) drops it within the tick, keeps the reason, leaves no listener, and the run goes on identical', () => {
  const plant = exampleOf('warehouse-first-day'); // trucks: all five events happen
  const entries = HEAVY ? ['afterTick', 'onCompleted', 'onPicked', 'onDelivered', 'onTruckReady', 'onTruckDeparted'] : ['afterTick', 'onDelivered', 'onTruckReady']; // the other three are broken by the 'dropped-listener' mode of N1
  for (const entry of entries) {
    const sim = new Simulation(plant.layout, { seed: 1 });
    const det = sim.enableDetail();
    let thrown = false;
    det[entry] = () => { thrown = true; throw new Error(`boom ${entry}`); };
    let calls = 0;
    const eventName = { onCompleted: 'loadCompleted', onPicked: 'orderPickedUp', onDelivered: 'orderDelivered', onTruckReady: 'truckReady', onTruckDeparted: 'truckDeparted' }[entry];
    if (eventName) sim.on(eventName, () => { calls++; });
    let guard = 0;
    while (sim.detail && !thrown && guard++ < 40000) sim.step();
    assert.ok(thrown, `${entry} was never called in ${sim.time} s`);
    assert.ok(sim.detail === null, `${entry}: dropped in the very tick that threw (at ${sim.time} s)`);
    assert.match(sim.detailError.message, new RegExp(`boom ${entry}`), `${entry}: the reason is kept`);
    if (eventName) assert.ok(calls >= 1, `${entry}: the event it listens to did happen`);
    same(listenerCount(sim), eventName ? 1 : 0, `${entry}: no listener of the collector is left (only the probe)`);
    const stoppedAt = sim.time;
    assert.ok(det.failed && det.error, 'the collector says that it failed');
    sim.advance(120);
    same(JSON.stringify(sim.kpis()), plainKpis(plant, sim.time), `${entry}: the run after the drop equals the run without a collector`);
    assert.ok(sim.time > stoppedAt, 'the simulation ran on');
  }
});

test('STAT-ENG-GUARD-C2: a collector that cannot start leaves the simulation as it was (enableDetail answers null and says why); it starts later when the cause is gone', () => {
  const plant = exampleOf('two-lines');
  const sim = new Simulation(plant.layout, { seed: 1 });
  const before = listenerCount(sim);
  const original = Detail.prototype.alloc;
  Detail.prototype.alloc = () => { throw new RangeError('cannot start'); };
  try {
    same(sim.enableDetail(), null);
    same(sim.detail, null);
    assert.match(sim.detailError.message, /cannot start/);
    same(listenerCount(sim), before, 'the failed constructor took its listeners off again');
  } finally {
    Detail.prototype.alloc = original;
  }
  sim.advance(120);
  assert.ok(sim.enableDetail() instanceof Detail, 'it starts now');
  same(sim.detailError, null, 'and the old reason is gone');
  sim.advance(600);
  const twin = new Simulation(plant.layout, { seed: 1 });
  twin.advance(sim.time);
  same(JSON.stringify(sim.kpis()), JSON.stringify(twin.kpis()));
});

test('STAT-ENG-GUARD-C3: 300 switches on and off in a running simulation leave no listener and no change; a collector enabled twice is the same collector', () => {
  const plant = exampleOf('two-lines');
  const sim = new Simulation(plant.layout, { seed: 1 });
  const first = sim.enableDetail();
  same(sim.enableDetail(), first, 'idempotent');
  sim.disableDetail();
  const bare = listenerCount(sim);
  for (let i = 0; i < 300; i++) {
    sim.enableDetail();
    sim.step();
    sim.disableDetail();
    same(sim.detail, null);
  }
  same(listenerCount(sim), bare, 'every collector took its listeners with it');
  sim.disableDetail(); // switching off a simulation that has none is not an error
  sim.advance(400);
  same(JSON.stringify(sim.kpis()), plainKpis(plant, sim.time));
});

test('STAT-ENG-GUARD-C4: the fleet or the station list changes under a running collector (the lists replaced by copies, vehicles removed one by one down to none): it restarts with a notice, never throws, and the simulation equals one without a collector', () => {
  const plant = exampleOf('two-lines');
  const drive = (withCollector) => {
    const sim = new Simulation(plant.layout, { seed: 1 });
    const det = withCollector ? sim.enableDetail() : null;
    sim.advance(700);
    sim.logistics.vehicles = sim.logistics.vehicles.slice(); // a new array with the same vehicles
    sim.advance(60);
    sim.logistics.stations = sim.logistics.stations.slice(); // and the same for the stations
    sim.advance(60);
    while (sim.logistics.vehicles.length) {
      sim.logistics.removeVehicle(sim.logistics.vehicles[0]);
      sim.advance(40);
    }
    sim.advance(200);
    return { sim, det };
  };
  const on = drive(true);
  const off = drive(false);
  same(JSON.stringify(on.sim.kpis()), JSON.stringify(off.sim.kpis()));
  assert.ok(on.sim.detail === on.det, 'still attached');
  same(on.det.nV, 0);
  assert.ok(on.det.notices.length >= 3 && on.det.notices.length <= NOTICE_CAP, `${on.det.notices.length} notices (a copy of the vehicle list, a copy of the station list, the first removal)`);
  assert.match(on.det.notices[0].text, /vehicles or stations changed/);
  assert.deepEqual([on.det.routesOf(0, on.det.windowOf('start')), on.det.hotspots(0).cells, on.det.workingSeries(0)], [[], [], []], 'a vehicle that is gone answers the empty result');
  same(on.det.stationWindow(0, on.det.windowOf('start')).seconds > 0, true, 'the stations are still counted');
});

test('STAT-ENG-GUARD-C5: corrupted vehicle state (NaN battery, NaN stateSince, NaN position on the road, a target that is not an id) does not throw out of the collector or change what the simulation does', () => {
  const plant = exampleOf('two-lines');
  for (const corrupt of HEAVY ? ['battery', 'stateSince', 'position', 'target'] : ['battery', 'stateSince']) {
    const run = (withCollector) => {
      const sim = new Simulation(plant.layout, { seed: 1 });
      if (withCollector) sim.enableDetail();
      sim.advance(900);
      const v = sim.vehicles[2];
      if (corrupt === 'battery') v.battery = NaN;
      else if (corrupt === 'stateSince') v.stateSince = NaN;
      else if (corrupt === 'position') v.tv.s = NaN;
      else v.targetId = {};
      let threw = null;
      try { sim.advance(200); } catch (error) { threw = error.message; }
      return { sim, threw };
    };
    const on = run(true);
    const off = run(false);
    same(on.threw, off.threw, `${corrupt}: the simulation fails in the same way with and without the collector`);
    same(JSON.stringify(on.sim.kpis()), JSON.stringify(off.sim.kpis()), corrupt);
    same(on.sim.time, off.sim.time);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// 4. determinism and read-only queries
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

test('STAT-ENG-GUARD-D1: the recorded state is the same for a straight run and one cut into slices of 7.3 s, 0.07 s, 61 s, 250 s and 33.3 s, at tick lengths that do not divide 30 s', () => {
  for (const dt of HEAVY ? [0.07, 0.45] : [0.45]) {
    const plant = withSettings(exampleOf('two-lines'), { dt, warmup: 100 });
    const straight = new Simulation(plant.layout, { seed: 1 });
    const a = straight.enableDetail();
    straight.advance(1900);
    const cut = new Simulation(plant.layout, { seed: 1 });
    const b = cut.enableDetail();
    const slices = [7.3, 0.07, 61, 250, 33.3];
    for (let k = 0; cut.time < straight.time - 1e-9; k++) cut.advance(Math.min(slices[k % slices.length], straight.time - cut.time));
    assert.ok(Math.abs(cut.time - straight.time) < 1e-6, `dt ${dt}: both stand at ${straight.time}`);
    same(detailDigest(b), detailDigest(a), `dt ${dt}: the digest of the collector depends on how the run was cut`);
  }
});

test('STAT-ENG-GUARD-D2: asking every query of the collector every 5 simulated seconds of a run does not change the recorded state or the simulation', () => {
  for (const plant of HEAVY ? [withSettings(exampleOf('two-lines'), { dt: 0.45 }), exampleOf('dock-lab')] : [withSettings(exampleOf('two-lines'), { dt: 0.45 })]) {
    const quiet = new Simulation(plant.layout, { seed: 1 });
    const q = quiet.enableDetail();
    const busy = new Simulation(plant.layout, { seed: 1 });
    const b = busy.enableDetail();
    let next = 0;
    let asked = 0;
    while (busy.time < 1500) {
      busy.step();
      if (busy.time >= next) { callEveryQuery(b); asked++; next = busy.time + 5; }
    }
    quiet.advance(busy.time);
    assert.ok(asked > 200, `${asked} rounds of queries`);
    same(detailDigest(b), detailDigest(q), `${plant.name}: a query changed what the collector records`);
    same(JSON.stringify(busy.kpis()), JSON.stringify(quiet.kpis()));
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// 5. memory: nothing grows with the length of a run
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

test('STAT-ENG-GUARD-M1: 2 simulated hours with small caps and a what-if change every 100 s: the typed columns stop growing, the logs wrap, the notices and the what-if log stay capped, no listener is added', () => {
  const sim = new Simulation(withSettings(exampleOf('two-lines'), { warmup: 120 }).layout, { seed: 1 });
  const det = sim.enableDetail({ legCap: 300, legStart: 64, pathCap: 20 });
  const sizes = [];
  let change = 0;
  for (let half = 1; half <= 4; half++) { // four half hours
    for (let k = 0; k < 18; k++) { // 72 changes, more than the log keeps
      change++;
      sim.setRuntime({ demandFactor: 1 + (change % 3) * 0.25, dispatch: ['nearest', 'oldest', 'balanced'][change % 3] });
      sim.advance(100);
    }
    sizes.push(det.memoryBytes);
  }
  assert.ok(sim.detail === det, 'still attached');
  assert.deepEqual([...new Set(sizes.slice(1))], [sizes[1]], `the typed columns still grew after the first half hour: ${sizes.join(' ')}`);
  assert.ok(det.legs.count > det.legs.cap, `the leg log wrapped (${det.legs.count} legs filed into ${det.legs.cap} rows)`);
  same(det.legs.size, 300);
  assert.ok(det.legCoverage().wrapped && det.legCoverage().since > det.windowStart, 'and it says so');
  assert.ok(det.pool.size <= 20 && det.pool.overflow > 0, `the path pool stopped at its cap (${det.pool.size} paths, ${det.pool.overflow} legs found it full)`);
  same(det.whatIf.length, WHATIF_CAP);
  assert.ok(det.notices.length <= NOTICE_CAP);
  assert.ok(det.charges.count <= det.charges.cap && det.pickWait.size <= det.nS && det.releaseAt.size === 0);
  same(listenerCount(sim), 5, 'the five handlers of the collector and nothing else');
  // a leg that found the pool full is a trip that is counted and not drawn
  for (const r of det.routesOf(0, det.windowOf('start'), [0, 1, 2, 3])) same(r.drawn + r.undrawn, r.trips, 'drawn and undrawn trips add up to the trips');
});

heavy('STAT-ENG-GUARD-M2: 24 simulated hours on the 320 x 320 plant with the routing switched every three hours: the heap has no trend, the typed columns stay below their bound', async () => {
  const { bigPlant320 } = await import('./helpers/big-plant.js');
  const sim = new Simulation(bigPlant320().layout, { seed: 1 });
  const det = sim.enableDetail();
  const heap = [];
  for (let hour = 1; hour <= 24; hour++) {
    if (hour % 3 === 0) sim.setRuntime({ demandFactor: 1 + (hour % 2) * 0.1, routing: hour % 2 ? 'congestion' : 'shortest' });
    sim.advance(3600);
    if (typeof globalThis.gc === 'function') { globalThis.gc(); globalThis.gc(); heap.push(process.memoryUsage().heapUsed); }
  }
  assert.ok(sim.detail === det);
  assert.ok(det.pool.size <= 16384 && det.legs.size <= 32768);
  assert.ok(det.memoryBytes < 4.6 * 1024 * 1024, `${(det.memoryBytes / 1048576).toFixed(2)} MB of typed columns after 24 h (path pool at its cap 16,384 included)`);
  if (heap.length === 24) {
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const early = mean(heap.slice(3, 9));
    const late = mean(heap.slice(18, 24));
    assert.ok(late < early * 1.35, `the heap grew from ${(early / 1048576).toFixed(0)} MB (hours 4 to 9) to ${(late / 1048576).toFixed(0)} MB (hours 19 to 24)`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// 6. the figures against an independent observer
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

/** The plants of the oracle tests: trucks and dock queues, deadlocks and relocations, zero-length legs, the charging plant and Two lines (the heavy corpus: all of them). */
const oraclePlants = () => (HEAVY ? corpus() : [...REVIEW_PLANTS.filter(([family, seed]) => !(family === 'truck' && seed === 35)).map(([family, seed]) => plantOf(family, seed)), chargingPlant(), exampleOf('two-lines')]);
const removes = (plant) => (plant.actions || []).some((a) => a.kind === 'removeVehicle');

test('STAT-ENG-GUARD-O1: the time split of every vehicle, Since start and Last 30 min, equals an independent per-tick tally to 2 ms at tick lengths that do not divide 30 s, with and without warm-up', () => {
  assert.deepEqual([...SPLIT_KEYS], [...SLOT_KEYS], 'the review uses the slots the collector has');
  let windows = 0;
  const plants = oraclePlants().filter((p) => !removes(p));
  for (const [n, plant] of plants.entries()) {
    for (const dt of HEAVY ? [0.07, 0.3, 0.45, 0.1] : n < 2 ? [0.07, 0.45] : [0.45]) {
      const obs = observedRun(plant, { horizon: 1960, dt, warmup: n % 2 ? 0 : 61.3 });
      const det = obs.det;
      assert.ok(det && !obs.dropped, `${plant.name} dt ${dt}: the collector stayed`);
      assert.ok(Math.abs(det.windowStart - obs.sim.kpis().window.start) < 1e-6, `${plant.name} dt ${dt}: the collector's window begins at ${det.windowStart} s, the report's at ${obs.sim.kpis().window.start} s`);
      assert.ok(det.bCount > 60, `${plant.name} dt ${dt}: more than 30 minutes were measured (${det.bCount} buckets)`);
      for (const kind of ['start', 'last30']) {
        const w = det.windowOf(kind);
        const jb = Math.round((w.t0 - det.windowStart) / 30);
        assert.ok(kind === 'start' ? jb === 0 : jb >= 1, `${kind}: ${jb} buckets back`);
        const base = obs.snapshots[jb].cum;
        for (let i = 0; i < obs.n; i++) {
          const got = det.timeSplit(i, w);
          for (let k = 0; k < 9; k++) {
            const want = obs.cum[i * 9 + k] - base[i * 9 + k];
            assert.ok(Math.abs(got[SPLIT_KEYS[k]] - want) < 2e-3, `${plant.name} dt ${dt} ${kind} vehicle ${i} ${SPLIT_KEYS[k]}: ${got[SPLIT_KEYS[k]]} against ${want}`);
          }
        }
        windows++;
      }
    }
  }
  assert.ok(windows >= 8, `${windows} windows compared`);
});

test('STAT-ENG-GUARD-O2: legs never hold more seconds than the vehicle spent in a driving state, every delivery has its loaded leg, every logged path decodes to its route, the cell tables match traffic and an independent tally', () => {
  const problems = [];
  let deliveries = 0;
  let cellsChecked = 0;
  let pathsChecked = 0;
  for (const plant of oraclePlants()) {
    const obs = observedRun(plant, { horizon: 1500 });
    const { det, sim } = obs;
    assert.ok(det && !obs.dropped, `${plant.name}: the collector stayed`);
    // 1. legs against the time in driving states (an open leg counts up to now or to its pause)
    for (let i = 0; i < det.nV; i++) {
      const s = det.timeSplit(i, det.windowOf('start'));
      const driving = s.driving + s.waiting + s.dockQueue;
      let legSeconds = 0;
      for (let k = 0; k < det.legs.size; k++) { const r = det.legs.at(k); if (det.legs.veh[r] === i) legSeconds += det.legs.dur[r]; }
      if (det.open[i]) legSeconds += Math.max(0, (det.pauseAt[i] >= 0 ? det.pauseAt[i] : sim.time) - det.oT0[i] - det.oPaused[i]);
      if (legSeconds > driving + 0.2 + 1e-5 * driving) problems.push(`${plant.name} vehicle ${i}: legs hold ${legSeconds.toFixed(2)} s, the vehicle was in a driving state ${driving.toFixed(2)} s`);
    }
    // 2. every logged path decodes to the route object it came from
    for (const [id, nodes] of obs.routes) {
      pathsChecked++;
      const decoded = Array.from(det.pool.nodes(id));
      if (decoded.length !== nodes.length || decoded.some((n, k) => n !== nodes[k])) problems.push(`${plant.name}: path ${id} does not decode to its route`);
    }
    if (obs.restarts > 0) continue; // a removal restarted the window: the tallies below are of the new window and the removal is attacked in C4
    // 3. deliveries against loaded legs (per vehicle, origin, destination, quantity); the vehicle that was unloading when the window began owns one delivery without a leg
    const have = new Map();
    for (let k = 0; k < det.legs.size; k++) {
      const r = det.legs.at(k);
      if (det.legs.kind[r] !== 1) continue;
      const key = `${det.V[det.legs.veh[r]].id}|${det.stations[det.legs.from[r]] ? det.stations[det.legs.from[r]].id : '-'}|${det.stations[det.legs.to[r]] ? det.stations[det.legs.to[r]].id : '-'}|${det.legs.qty[r]}`;
      have.set(key, (have.get(key) || 0) + 1);
    }
    const want = new Map();
    for (const d of obs.deliveries) { const key = `${d.veh}|${d.from}|${d.to}|${d.qty}`; want.set(key, (want.get(key) || 0) + 1); }
    for (const [key, n] of want) {
      deliveries += n;
      const missing = n - (have.get(key) || 0);
      if (missing > (det.credit[det.vehicleIndex(key.split('|')[0])] ? 1 : 0)) problems.push(`${plant.name}: ${missing} delivery(ies) ${key} without a loaded leg`);
    }
    // 4. the cell tables: the total against traffic's nodeWait (a deadlock relocation costs one tick of the waiting flag), cell by cell against the tally
    let total = 0;
    for (let i = 0; i < det.nV; i++) {
      for (const t of [det.hot, det.hotStray]) { for (let k = i * 24; k < i * 24 + 24; k++) if (t.keys[k] >= 0) total += t.secs[k]; total += t.other[i]; }
      if (det.curNode[i] >= 0) total += det.curSecs[i];
    }
    const tolerance = sim.traffic.stats.deadlocks === 0 ? 2e-4 : 1.5e-2; // float32 tables add 5e-5 of drift (STAT-ENG-REV-4); a deadlock relocation costs one tick of the waiting flag
    if (obs.nodeWait > 1 && Math.abs(total - obs.nodeWait) > tolerance * obs.nodeWait) problems.push(`${plant.name}: the cell tables hold ${total.toFixed(2)} s, traffic booked ${obs.nodeWait.toFixed(2)} s`);
    for (let i = 0; i < det.nV; i++) {
      const hs = det.hotspots(i, 64);
      if (hs.folded > 0) continue; // more than 24 cells: approximate by design
      const got = new Map(hs.cells.map((c) => [c.node, c.seconds]));
      for (const [node, seconds] of obs.cells[i]) {
        const wantCell = Math.max(0, seconds - (obs.queueCells[i].get(node) || 0));
        cellsChecked++;
        if (Math.abs((got.get(node) || 0) - wantCell) > 0.5 + 1e-3 * wantCell) problems.push(`${plant.name} vehicle ${i} cell ${node}: ${(got.get(node) || 0).toFixed(3)} against ${wantCell.toFixed(3)}`);
      }
    }
  }
  assert.deepEqual(problems, []);
  assert.ok(deliveries >= 20 && pathsChecked >= 20 && cellsChecked >= 20, `${deliveries} deliveries, ${pathsChecked} paths, ${cellsChecked} cells were compared`);
});

test('STAT-ENG-GUARD-O3: every query answers for any index (below 0, above the fleet, fractions, strings, NaN) with the empty result, never throws, and holds no NaN or Infinity', () => {
  const sim = new Simulation(exampleOf('warehouse-first-day').layout, { seed: 1 });
  const det = sim.enableDetail();
  sim.advance(2400);
  const w = det.windowOf('start');
  const bad = [undefined, null, NaN, -1, 1e9, Infinity, -Infinity, 2.5, '1', 'x', {}, [], [1], true];
  const nonFinite = (v, at = '$', out = []) => {
    if (typeof v === 'number') { if (!Number.isFinite(v)) out.push(at); } else if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) for (const k of Object.keys(v)) nonFinite(v[k], `${at}.${k}`, out);
    return out;
  };
  const vehicleQueries = ['timeSplit', 'counts', 'routesOf', 'roundOf', 'queuesOf', 'batteryOf'];
  for (const i of bad) {
    for (const name of vehicleQueries) assert.deepEqual(nonFinite(det[name](i, w)), [], `${name}(${String(i)})`);
    for (const name of ['workingSeries', 'hotspots', 'idleSpots', 'metresToGo']) assert.deepEqual(nonFinite(det[name](i)), [], `${name}(${String(i)})`);
    for (const name of ['stationWindow', 'visitsTo']) assert.deepEqual(nonFinite(det[name](i, w)), [], `${name}(${String(i)})`);
    assert.deepEqual(nonFinite(det.queueNow(i)), [], `queueNow(${String(i)})`);
    same(det.vehicleIndex(i), -1, `vehicleIndex(${String(i)})`);
  }
  assert.deepEqual([det.timeSplit(-1, w).seconds, det.routesOf(99, w).length, det.metresToGo(99), det.roundOf(NaN, w)], [0, 0, null, null]);
  assert.deepEqual(nonFinite(det.busiestRoutes(w)), []);
  assert.deepEqual(nonFinite(det.cellUse([1, 2, 3], w)), []);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// 7. the runner, the store and the real engine
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

test('STAT-ENG-GUARD-R1: edit, pre-roll, swap, a collector forced to fail, the preference switched off and on: the runner hands out the right collector and the simulation never notices', async () => {
  const rig = runnerRig({ tick: 1 });
  const { runner, store } = rig;
  await rig.runTo(1500);
  const first = runner.detail();
  assert.ok(first instanceof Detail && first.sim === runner.sim, 'the collector of the displayed simulation');
  assert.ok(Math.abs(first.windowStart - 600) < 1, 'its window begins when the warm-up ends');
  const shown = runner.sim;
  store.commit('Add Goods in', (l) => { L.addStation(l, { type: 'source', x: 2, y: 2 }); });
  rig.until(() => runner.priming);
  const priming = rig.made[rig.made.length - 1];
  assert.ok(priming.detail instanceof Detail, 'the replacement being pre-rolled has its own collector from the start');
  assert.ok(runner.sim === shown && runner.detail() === first, 'the displayed one is untouched meanwhile');
  rig.until(() => runner.sim !== shown && !runner.priming);
  const second = runner.detail();
  assert.ok(second && second !== first && second.sim === runner.sim, 'after the swap the collector of the new simulation');
  const twin = new Simulation(runner.sim.layout, { seed: runner.sim.seed });
  twin.enableDetail();
  twin.advance(runner.sim.time);
  same(detailDigest(second), detailDigest(twin.detail), 'pre-rolled in slices behind the display, it recorded what a straight run records');
  // a failure inside the displayed collector
  const t0 = runner.time;
  second.afterTick = () => { throw new Error('boom in afterTick'); };
  rig.until(() => runner.time >= t0 + 60);
  same(runner.detail(), null, 'the runner no longer offers it');
  assert.match(runner.sim.detailError.message, /boom in afterTick/, 'and the simulation says why (the dock shows it)');
  same(rig.errors.length, 0, 'the run itself reported no error');
  assert.ok(runner.time > t0 + 59, 'the simulation ran on');
  // the preference
  store.setUi({ detail: false });
  rig.frame();
  same(runner.detail(), null);
  store.setUi({ detail: true });
  rig.frame();
  const third = runner.detail();
  assert.ok(third instanceof Detail && third !== second && runner.sim.detailError === null, 'switched on again: a new collector, the old reason forgotten');
  assert.ok(third.windowStart > 100 && Math.abs(third.windowStart - runner.sim.time) < 15, `its window begins now (${third.windowStart} s, the simulation stands at ${runner.sim.time} s)`);
  // the preference changes while a replacement is being pre-rolled
  store.commit('Add Goods in', (l) => { L.addStation(l, { type: 'source', x: 2, y: 20 }); });
  rig.until(() => runner.priming);
  const next = rig.made[rig.made.length - 1];
  assert.ok(next.detail !== null);
  store.setUi({ detail: false });
  rig.frame();
  same(next.detail, null, 'switched off for the simulation being pre-rolled too');
  rig.until(() => runner.sim === next && !runner.priming);
  same(runner.detail(), null);
  store.setUi({ detail: true });
  rig.frame();
  assert.ok(runner.detail() instanceof Detail, 'and on again');
  // a scenario switch is a cold restart: another simulation, another collector, and back
  const home = store.getState().project.activeId;
  const homeName = runner.sim.layout.name;
  const before = runner.sim;
  const other = store.addScenario('Starter', EXAMPLES.find((e) => e.id === 'starter').build());
  assert.ok(other !== null && store.getState().project.activeId === other);
  rig.until(() => runner.sim !== before && runner.sim.layout.name !== homeName && !runner.priming);
  assert.ok(runner.detail() instanceof Detail && runner.detail().sim === runner.sim, 'the new scenario has its own collector');
  store.switchScenario(home);
  rig.until(() => runner.sim.layout.name === homeName && !runner.priming);
  assert.ok(runner.detail() instanceof Detail && runner.detail().sim === runner.sim && runner.sim.detailError === null, 'and so has the first one when it comes back');
  same(rig.errors.length, 0);
  runner.destroy();
});

test('STAT-ENG-GUARD-U1: the dock model of every item of hostile plants (relocations, zero-length legs, dock queues, a removed vehicle), in both windows, holds no NaN, Infinity, negative amount or share above 100 %', () => {
  let models = 0;
  const plants = HEAVY ? [...reviewCorpus(range(1, 12)), chargingPlant()] : [plantOf('dock', 16), plantOf('truck', 37)];
  for (const plant of plants) {
    const layout = structuredClone(plant.layout);
    layout.settings.warmup = Math.min(layout.settings.warmup, 120);
    const sim = new Simulation(layout, { seed: plant.seed });
    sim.enableDetail();
    const actions = (plant.actions || []).map((a) => ({ ...a }));
    while (sim.time < 2100 && sim.detail) {
      while (actions.length && actions[0].at <= sim.time) {
        const a = actions.shift();
        if (a.kind === 'demand') sim.setRuntime({ demandFactor: a.value || 0.0001 });
        else if (a.kind === 'removeVehicle' && sim.logistics.vehicles.length) sim.logistics.removeVehicle(sim.logistics.vehicles[a.index % sim.logistics.vehicles.length]);
      }
      sim.advance(30);
    }
    let now = 1e6;
    for (const window of ['start', 'last30']) {
      for (const selection of everySelection(sim.layout, { cells: 3 })) {
        now += 5000;
        const model = buildStatsModel(liveInput(sim, selection, { window, now }));
        assert.deepEqual(modelProblems(model), [], `${plant.name} ${window} ${JSON.stringify(selection)}`);
        models++;
      }
    }
  }
  assert.ok(models >= (HEAVY ? 1000 : 60), `${models} models`);
});

/** Every file of js/sim (recursively) as { rel, code } with the comments taken out. */
function simSources() {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.js')) out.push({ rel: path.relative(path.join(ROOT, 'js'), file).split(path.sep).join('/'), code: readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '') });
    }
  };
  walk(path.join(ROOT, 'js', 'sim'));
  return out;
}

const BROWSER_API = /\b(?:window\.(?:addEventListener|removeEventListener|location|innerWidth|innerHeight|matchMedia|devicePixelRatio|requestAnimationFrame|localStorage|sessionStorage|document|navigator|setTimeout|open)|document\.(?:createElement|getElementById|querySelector\w*|body|head|addEventListener|documentElement|hidden)|globalThis\.(?:window|document)|localStorage|sessionStorage|requestAnimationFrame\s*\(|HTMLElement|HTMLCanvasElement|CanvasRenderingContext2D|ResizeObserver|IntersectionObserver)\b/;

test('STAT-ENG-GUARD-I1: js/sim imports only js/sim, js/model and js/util (static and dynamic imports, either quote), touches no browser API, and imports in plain Node', async () => {
  const files = simSources();
  assert.ok(files.length >= 15, `${files.length} files in js/sim`);
  const problems = [];
  let imports = 0;
  for (const { rel, code } of files) {
    const specifiers = [
      ...code.matchAll(/^\s*(?:import|export)\s[^;'"]*?\sfrom\s*['"]([^'"]+)['"]/gm), ...code.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm), ...code.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
    ].map((m) => m[1]);
    for (const spec of specifiers) {
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.')) { problems.push(`${rel} imports the package ${spec}`); continue; }
      const top = path.relative(path.join(ROOT, 'js'), path.resolve(path.dirname(path.join(ROOT, 'js', rel)), spec)).split(path.sep)[0];
      if (!['sim', 'model', 'util'].includes(top)) problems.push(`${rel} imports ${spec} (js/${top})`);
    }
    imports += specifiers.length;
    const api = code.match(BROWSER_API);
    if (api) problems.push(`${rel} uses the browser API ${api[0]}`);
  }
  assert.deepEqual(problems, []);
  assert.ok(imports >= 30, `${imports} imports were read`);
  assert.ok(BROWSER_API.test('const x = window.addEventListener;') && BROWSER_API.test('document.createElement("div")') && !BROWSER_API.test('const window = report.window; window.duration'), 'the browser-API pattern sees a browser and not a local variable called window');
  for (const g of ['document', 'window', 'localStorage', 'requestAnimationFrame']) assert.ok(!(g in globalThis), `this test process has no ${g}: the import below proves js/sim needs none`);
  const engine = await import('../js/sim/engine.js');
  const detail = await import('../js/sim/detail.js');
  assert.ok(typeof engine.Simulation === 'function' && typeof detail.Detail === 'function');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// 8. the ledgers
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

const STRAYS = [
  ['sim.detail', 'export const f = (sim) => sim.detail;', true],
  ['runner.detail()', 'export const f = (r) => r.detail();', true],
  ['enableDetail', 'export const f = (a) => a.enableDetail();', true],
  ["import { KIND } from '../sim/detail.js'", "import { KIND } from '../sim/detail.js'; export const f = KIND;", true],
  ['const { detail } = sim', 'export const f = (sim) => { const { detail } = sim; return detail; };', false],
  ["sim['detail']", "export const f = (sim) => sim['detail'];", false],
  ['an alias: s.detail', 'export const f = (a) => { const s = a.getSim(); return s.detail; };', false],
  ['this.detail in a class that holds a simulation', 'export class K { constructor(sim) { this.sim = sim; } get d() { return this.detail; } }', false],
  ['a double-quoted import of sim/detail.js', 'import { KIND } from "../sim/detail.js"; export const f = KIND;', false],
  ['a dynamic import of sim/detail.js', "export const f = () => import('../sim/detail.js');", false],
];
// The rules of the ledger are tests/helpers/detail-ledger.js, the file that tests/sim.seams.test.js applies to every file of js/ (this review used to read two regular expressions out of the
// source of that test; the rules grew past a regular expression and became a function, so the review calls the function: detailStrays(rel, code) lists how a file touches the collector).
const caught = (code, rel = 'ui/somewhere.js') => detailStrays(rel, code).length > 0;

test('STAT-ENG-GUARD-L1: the reader ledger catches a plain read of the collector, the runner accessor, the seam names and a single-quoted import', () => {
  for (const [name, code, expected] of STRAYS.filter((s) => s[2])) assert.ok(caught(code), `the ledger does not catch ${name}`);
  assert.ok(!caught('export const text = insight.detail + state.ui.detail;'), 'and not the texts called detail (an insight, the preference)');
  assert.ok(!caught('export const f = (sim) => sim.detail;', 'ui/panels/stats-dock.js'), 'nor the owners');
});

defect('STAT-ENG-REV-2', 'the reader ledger catches a destructured read, a bracket read, an alias, this.detail, a double-quoted import and a dynamic import of the collector', 'tests/sim.seams.test.js DETAIL_READ was a regex of variable names; widen it (destructuring, ["detail"], double quotes, import()) or ban the identifier `detail` as a property outside the owners with an allowlist for the texts', () => {
  const missed = STRAYS.filter(([, code, expected]) => !expected && !caught(code)).map(([name]) => name);
  assert.deepEqual(missed, [], 'a file outside the owners that reads the collector in one of these forms passes the ledger');
  // and the allowlist is narrow: a short name is a text only in the file that says so
  assert.equal(caught('export const f = (e) => e.detail === 0;', 'ui/panels/fleet.js'), false, 'a DOM click count in the fleet panel');
  assert.equal(caught('export const f = (e) => e.detail === 0;', 'ui/elsewhere.js'), true, 'the same words anywhere else are a read of something called detail');
  assert.equal(caught('const css = ".list .detail, .list .hint { display: block; }";'), false, 'a CSS rule is not code');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// 9. defects
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

defect('STAT-ENG-REV-1', 'once the leg log has wrapped the Trips block divides the last legs by the whole window and the dock still says "counted since" the start', 'stats-model.js never reads detail.legCoverage(); SIM exposes { wrapped, since }, MODEL must use the span since `since` for the per-hour figures of the trip rows, the queue rows and the round, and say "the last N trips since H:MM"', () => {
  const sim = new Simulation(exampleOf('two-lines').layout, { seed: 1 });
  const det = sim.enableDetail({ legCap: 150, legStart: 64 }); // a small log wraps in minutes; the default one (32,768 legs) after 17 simulated hours on the biggest plant
  sim.advance(1.5 * 3600);
  const cover = det.legCoverage();
  assert.ok(cover.wrapped && cover.since > det.windowStart + 1800, `the log holds only the last ${cover.rows} legs, since ${cover.since.toFixed(0)} s (the window began at ${det.windowStart})`);
  const id = det.V.find((v) => v.fleetId === 'v2').id;
  const model = buildStatsModel(liveInput(sim, { kind: 'vehicle', ids: [id] }, { window: 'start', now: 1e6 }));
  const trips = model.blocks.find((b) => b.id === 'trips');
  const spanHours = (sim.time - cover.since) / 3600;
  const says = /last [\d,.]+ (trips|drives|legs)|only the last|trips are kept/i.test(JSON.stringify(trips));
  const ratesOfTheSpan = trips.rows.length > 0 && trips.rows.every((row) => Math.abs(row.perHour - row.trips / spanHours) <= 0.06 * (row.trips / spanHours));
  assert.ok(says || ratesOfTheSpan, `the rows say ${trips.rows.map((r) => `${r.trips} trips, ${r.perHour.toFixed(1)}/h`).join(' | ')} for legs of the last ${(spanHours * 60).toFixed(0)} minutes of a ${((sim.time - det.windowStart) / 3600).toFixed(1)} h window, and nothing says that the log wrapped`);
});

defect('STAT-ENG-REV-3', 'a charge session does not know the depot it charged at', 'detail.js endCharge(): store depotIdx[i] in the session (a Uint16Array column like veh); the Depot page of S2 needs it for a plant with two depots', () => {
  const plant = chargingPlant();
  const sim = new Simulation(plant.layout, { seed: 1 });
  const det = sim.enableDetail();
  sim.advance(1800);
  assert.ok(det.charges.count > 0, `${det.charges.count} charge sessions in 30 minutes`);
  const stop = det.batteryOf(det.charges.veh[0], det.windowOf('start')).stops[0];
  assert.ok('depot' in stop || 'dep' in det.charges || 'depot' in det.charges, `a session has ${Object.keys(stop).join(', ')} and no depot`);
});

defect('STAT-ENG-REV-4', 'a cell where a vehicle only queued for a dock shows phantom waiting seconds (float32 sum of the queue against the float64 streak)', 'detail.js hotQ.add(i, node, dt) every tick into a Float32Array; add the queue seconds through the streak like `hot` (or keep the secs of the tables in Float64Array)', () => {
  const plant = plantOf('hdock', 3);
  const obs = observedRun(plant, { horizon: 300 });
  const det = obs.det;
  let worstRelative = 0;
  let worst = '';
  for (let i = 0; i < det.nV; i++) {
    const got = new Map(det.hotspots(i, 64).cells.map((c) => [c.node, c.seconds]));
    for (const [node, seconds] of obs.cells[i]) {
      const queued = obs.queueCells[i].get(node) || 0;
      if (queued < 50) continue;
      const wantCell = Math.max(0, seconds - queued);
      const err = Math.abs((got.get(node) || 0) - wantCell) / queued;
      if (err > worstRelative) { worstRelative = err; worst = `vehicle ${i} cell ${node}: ${(got.get(node) || 0).toFixed(3)} s against ${wantCell.toFixed(3)} s of ${queued.toFixed(0)} s queued`; }
    }
  }
  assert.ok(worstRelative < 1e-6, `the cell rows drift from the queue seconds by ${worstRelative.toExponential(2)} of them (${worst})`);
});

defect('STAT-ENG-REV-6', 'a restart of the collector replaces its path pool: every path id handed out before means other cells afterwards', 'detail.js alloc(): keep this.pool across rebind() (a path does not depend on the fleet); routes.js geometryOf() caches the cells of a path id per collector', () => {
  const sim = new Simulation(exampleOf('two-lines').layout, { seed: 1 });
  const det = sim.enableDetail();
  sim.advance(900);
  assert.ok(det.pool.size >= 3, `${det.pool.size} paths`);
  const cells = (ids) => ids.map((id) => Array.from(det.pool.nodes(id)).join());
  const before = cells([0, 1, 2]);
  sim.logistics.removeVehicle(sim.logistics.vehicles[0]);
  sim.advance(300);
  assert.ok(det.notices.length >= 1, 'the collector restarted');
  assert.deepEqual(cells([0, 1, 2]), before, 'the path ids handed out before the restart mean other cells now');
});

const defectHeavy = (id, name, why, fn) => test(`${id}: ${name}`, HEAVY ? {} : { skip: 'expensive: set STATS_ENGINE_REVIEW_HEAVY=1' }, fn);

defectHeavy('STAT-ENG-REV-7', 'cellUse (the road cell page of S2) takes 40 to 60 ms on a full leg log with a full path pool, and the cache by `version` that the design proposes cannot hit', 'detail.js cellUse() scans the log and decodes every distinct path per call; version changes with every leg close (30,000 a second of wall clock at 600x on the 100-vehicle plant). S2 needs an incremental per-node index of paths, built when a path is interned', async () => {
  const { bigPlant320 } = await import('./helpers/big-plant.js');
  const sim = new Simulation(bigPlant320().layout, { seed: 1 });
  const det = sim.enableDetail();
  const g = sim.graph;
  const roads = [];
  for (let n = 0; n < g.out.length; n++) if (g.out[n].length) roads.push(n);
  let seed = 12345; // random walks on the real graph: 16,384 distinct paths of 100 to 200 cells, as a day of congestion routing makes
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
  while (det.pool.size < 16000) {
    let node = roads[Math.floor(next() * roads.length)];
    const nodes = [node];
    const edges = [];
    for (let k = 100 + Math.floor(next() * 100); k > 0 && g.out[node].length; k--) { const e = g.out[node][Math.floor(next() * g.out[node].length)]; edges.push(e); node = g.edges[e].to; nodes.push(node); }
    if (edges.length > 1) det.pool.intern({ nodes, edges });
  }
  for (let k = 0; k < det.legs.cap; k++) det.legs.push(k % det.nV, 1, 0, 1, 0, k % det.pool.size, 600 + k, 30, 0, 0, 1, 0);
  const w = det.windowOf('start');
  // The first call builds the index of the paths by cell (once; it costs about what every call cost before: a decoding of every path). The review averaged the build into three calls
  // of the same cell; what the road cell page needs is the call after it, for any cell, so the two are measured apart.
  const t0 = performance.now();
  det.cellUse([roads[1000]], w);
  const first = performance.now() - t0;
  const t1 = performance.now();
  for (let k = 0; k < 3; k++) det.cellUse([roads[1001 + k * 77]], w);
  const ms = (performance.now() - t1) / 3;
  assert.ok(ms < 10, `cellUse of one cell on ${det.legs.size} legs and ${det.pool.size} paths took ${ms.toFixed(1)} ms once the index exists`);
  assert.ok(first < 250, `and ${first.toFixed(0)} ms for the first call, which builds the index of ${det.pool.size} paths (${(det.pool.indexBytes / 1048576).toFixed(0)} MB, built on demand, for a day of congestion routing on the biggest plant)`);
});

defect('STAT-ENG-REV-5', 'docs/ARCHITECTURE.md 5.5 gives sim.enableDetail the result "Detail" although it answers null when the collector cannot start', 'docs/ARCHITECTURE.md 5.5 (SIM): `sim.enableDetail(opts?) → Detail | null`', () => {
  const doc = readFileSync(path.join(ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8');
  assert.match(doc, /sim\.enableDetail\(opts\?\)\s*→\s*Detail\s*\|\s*null/);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------
// 10. cost (opt-in; the gates of the design are 500 x real time on the examples and on the 320 x 320 / 225 stations / 100 vehicles plant, +25 % over off on Two lines)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------

const cpuSeconds = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1e6; };
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

/** Best and median CPU seconds of `rounds` alternating rounds of off and on. */
function alternate(makeLayout, seconds, rounds) {
  const once = (on) => {
    const sim = new Simulation(makeLayout(), { seed: 1 });
    if (on) sim.enableDetail();
    const t0 = cpuSeconds();
    sim.advance(seconds);
    return { cpu: cpuSeconds() - t0, text: JSON.stringify(sim.kpis()) };
  };
  once(true);
  const rows = { off: [], on: [] };
  let equal = true;
  for (let r = 0; r < rounds; r++) {
    const order = r % 2 ? [true, false] : [false, true];
    const texts = [];
    for (const on of order) { const run = once(on); rows[on ? 'on' : 'off'].push(run.cpu); texts.push(run.text); }
    equal = equal && texts[0] === texts[1];
  }
  return { best: { off: Math.min(...rows.off), on: Math.min(...rows.on) }, median: { off: median(rows.off), on: median(rows.on) }, equal };
}

heavy('STAT-ENG-GUARD-P1: the collector on is at least 500 x real time on the five examples and at most +25 % over off on Two lines (alternating rounds, best and median)', () => {
  for (const id of ['starter', 'two-lines', 'congestion-lab', 'dock-lab', 'warehouse-first-day']) {
    const r = alternate(() => { const layout = exampleOf(id).layout; layout.settings.warmup = 600; return layout; }, 3600, 7);
    assert.ok(r.equal, `${id}: the kpis changed with the collector on`);
    assert.ok(3600 / r.best.on > 500, `${id}: ${Math.round(3600 / r.best.on)} x real time with the collector on`);
    if (id === 'two-lines') assert.ok(Math.min(r.best.on / r.best.off, r.median.on / r.median.off) - 1 < 0.25, `two-lines: +${((r.best.on / r.best.off - 1) * 100).toFixed(1)} % (best), +${((r.median.on / r.median.off - 1) * 100).toFixed(1)} % (median)`);
  }
});

heavy('STAT-ENG-GUARD-P2: the 320 x 320 plant with 225 stations and 100 vehicles: the collector on costs at most +40 % over off, keeps at least 450 x real time when the machine is quiet (the design gate is 500 x), and a dock refresh is a few milliseconds', async () => {
  const { bigPlant320 } = await import('./helpers/big-plant.js');
  const { loadavg } = await import('node:os');
  const { layout } = bigPlant320();
  const load = loadavg()[0];
  const r = alternate(() => structuredClone(layout), 1200, 6);
  assert.ok(r.equal);
  const on = 1200 / r.best.on;
  console.log(`    perf: big plant, load average ${load.toFixed(2)}: ${Math.round(on)} x on, ${Math.round(1200 / r.best.off)} x off (best of 6; medians ${Math.round(1200 / r.median.on)} x on, ${Math.round(1200 / r.median.off)} x off)`);
  assert.ok(r.best.on / r.best.off - 1 < 0.4, `+${((r.best.on / r.best.off - 1) * 100).toFixed(1)} % over off`);
  if (load < 1) assert.ok(on > 450, `${Math.round(on)} x real time with the collector on on a quiet machine (load average ${load.toFixed(2)}), ${Math.round(1200 / r.best.off)} x off`);
  const sim = new Simulation(structuredClone(layout), { seed: 1 });
  const det = sim.enableDetail();
  sim.advance(2 * 3600);
  let worst = 0;
  for (let i = 0; i < det.nV; i += 9) {
    const input = liveInput(sim, { kind: 'vehicle', ids: [det.V[i].id] }, { window: 'start', now: 1e7 + i * 5000 });
    const t0 = performance.now();
    buildStatsModel(input);
    worst = Math.max(worst, performance.now() - t0);
  }
  assert.ok(worst < 40, `building the model of a vehicle took ${worst.toFixed(1)} ms at worst`);
});
