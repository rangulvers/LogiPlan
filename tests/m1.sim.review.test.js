// Adversarial review of milestone M1 (trucks and dock doors), SIMULATION angle: the truck engine (js/sim/logistics/trucks.js), its statistics
// (js/sim/stats-ops.js), its insight rules (js/sim/insights-ops.js) and the hooks in the legacy files, attacked from outside.
//
// What is different from tests/sim.trucks*.test.js:
//  * the plants come from an INDEPENDENT generator (tests/helpers/m1-sim-review-gen.js: built with the layout.js mutators, run on the real engine with
//    real traffic), not from the builder's;
//  * the checks are recomputed from the raw state and from the event stream (an independent ledger), not read from the engine's own counters; the
//    checker is itself attacked: test 1.2 installs 15 engine bugs one by one and demands that the audit catches each;
//  * the neutrality claim "legacy plants run bit for bit as before" is checked against the real old tree (commit a2af6d8, git archive), not against a
//    recorded number.
//
// The defects this review found (M1-SIM-REV-1, 1b, 2, 3, 4) were todo tests while they were open; the fixer fixed them (docs/ARCHITECTURE.md 5.7) and they
// are ordinary regression tests now (M1_SIM_REVIEW_STRICT is no longer needed and has no effect). Switches (environment): M1_SIM_REVIEW_HEAVY=1 runs the expensive versions (160 random plants,
// 3 examples x 4 seeds x 8 h against the old tree, 72 h of memory, allocation per tick in child processes); without it the file takes about 8 s of CPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXAMPLES } from '../js/model/examples.js';
import { addFlow, addStation, normalizeLayout, removeStation, updateCalendar } from '../js/model/layout.js';
import { Simulation } from '../js/sim/engine.js';
import { MIN_DATA_SECONDS, generateInsights } from '../js/sim/insights.js';
import * as insightsOps from '../js/sim/insights-ops.js';
import { TruckDesk } from '../js/sim/logistics/trucks.js';
import {
  allLoads, audit, compareOps, hostileTruckPlant, legacyPlant, makeLedger, microLine, newTally, nonFinite, runAudited, withoutVehicles,
} from './helpers/m1-sim-review-gen.js';

const HEAVY = process.env.M1_SIM_REVIEW_HEAVY === '1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD_REV = process.env.M1_SIM_REVIEW_OLD_REV || 'a2af6d8'; // the end of milestone M0: the last commit before the trucks

/** A defect this review found and the fixer fixed: an ordinary regression test. */
const defect = (id, name, fn) => test(`${id}: ${name}`, fn);
const heavy = (name, fn) => test(name, HEAVY ? {} : { skip: 'expensive: set M1_SIM_REVIEW_HEAVY=1' }, fn);

const K = (mean) => ({ kind: 'const', mean, spread: 0 });
/** Replace a method of the truck desk for a while: `replacement(original)` gives the new method; the returned function puts the original back. */
const P = TruckDesk.prototype;
const patch = (name, replacement) => { const original = P[name]; P[name] = replacement(original); return () => { P[name] = original; }; };
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const sum = (list) => list.reduce((a, b) => a + b, 0);
const cpuSeconds = (since) => { const c = process.cpuUsage(since); return (c.user + c.system) / 1e6; };

// ---- the old tree -------------------------------------------------------------------------------------------------------------------------

/** Directory of the tree of OLD_REV (it holds js/ and package.json), cached in the temp directory; null when git cannot produce it. */
function oldTreeRoot() {
  if (process.env.M1_SIM_REVIEW_OLD_TREE) {
    const given = path.resolve(process.env.M1_SIM_REVIEW_OLD_TREE);
    return existsSync(path.join(given, 'js', 'sim', 'engine.js')) ? given : null;
  }
  const dir = path.join(os.tmpdir(), `logiplan-m1-sim-review-${OLD_REV}`);
  if (existsSync(path.join(dir, 'js', 'sim', 'engine.js'))) return dir;
  try {
    const archive = spawnSync('git', ['archive', OLD_REV, 'js', 'package.json'], { cwd: ROOT, maxBuffer: 1 << 28 });
    if (archive.status !== 0 || !archive.stdout || archive.stdout.length === 0) return null;
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'logiplan-m1-sim-review-part-'));
    const untar = spawnSync('tar', ['-x', '-C', scratch], { input: archive.stdout, maxBuffer: 1 << 28 });
    if (untar.status !== 0) { rmSync(scratch, { recursive: true, force: true }); return null; }
    try { renameSync(scratch, dir); } catch { rmSync(scratch, { recursive: true, force: true }); }
    return existsSync(path.join(dir, 'js', 'sim', 'engine.js')) ? dir : null;
  } catch {
    return null;
  }
}
const OLD_ROOT = oldTreeRoot();
const SKIP_OLD = 'the tree of the commit before M1 cannot be produced (git archive failed); set M1_SIM_REVIEW_OLD_TREE=<dir with js/>';
const old = OLD_ROOT
  ? await Promise.all([
    import(pathToFileURL(path.join(OLD_ROOT, 'js/sim/engine.js')).href),
    import(pathToFileURL(path.join(OLD_ROOT, 'js/model/examples.js')).href),
  ]).then(([engine, examples]) => ({ Simulation: engine.Simulation, EXAMPLES: examples.EXAMPLES }))
  : null;

// ---- 1. hostile plants: conservation and the invariants of 6.3.5, recomputed ---------------------------------------------------------------

/** Plants for the fast run: cheap seeds that together reach every corner of the engine (calibrated with the generator; see 1.1's coverage check). */
const FUZZ_SEEDS = HEAVY ? range(1, 160) : [100, 90, 35, 80, 110, 34, 68];
const FUZZ_SECONDS = HEAVY ? 1800 : 900;

/**
 * The insight rules of trucks against the literal reading of Appendix B, station by station: returns the violations. The oracle reads only the
 * report and the insights, never the engine.
 */
function oracle(sim, report, insights) {
  const bad = [];
  const has = (rule, id) => insights.some((i) => i.id === `${rule}:${id}`);
  const duration = report.window.duration;
  if (!(duration >= MIN_DATA_SECONDS)) { // a window that was restarted a moment ago (a vehicle was removed: Stats.reset) is too short for any rule
    if (insights.some((i) => i.id !== 'not-enough-data')) bad.push(`a window of ${duration} s speaks: ${insights.map((i) => i.id)}`);
    return bad;
  }
  for (const [id, t] of Object.entries(report.ops.trucks)) {
    const arrived = t.trucks.arrived;
    const enough = arrived >= 3;
    const wait = Math.max(t.gateWait.mean ?? 0, arrived > 0 ? (t.gateQueue.mean * duration) / arrived : 0); // the mean wait: of those that docked, or from the queue (Little)
    const util = t.doorUtilization;
    const gq = has('gate-queue-long', id); const db = has('doors-bottleneck', id); const ul = has('unload-limited-by-vehicles', id);
    const di = has('doors-idle', id); const os = has('outbound-short', id);
    const tag = `${id} (${t.role}, ${t.doors} doors, arrived ${arrived}, wait ${wait.toFixed(0)} s, util ${util.toFixed(2)})`;
    if (gq !== (enough && wait >= 15 * 60)) bad.push(`${tag}: gate-queue-long is ${gq}`);
    if (gq) {
      const severity = insights.find((i) => i.id === `gate-queue-long:${id}`).severity;
      if (severity !== (wait >= 45 * 60 ? 'critical' : 'warning')) bad.push(`${tag}: gate-queue-long is ${severity}`);
    }
    const fewer = Math.max(1, Math.ceil((util * t.doors) / 0.85 - 1e-9));
    if (di !== (enough && t.doors >= 2 && util < 0.3 && wait < 60 && fewer < t.doors)) bad.push(`${tag}: doors-idle is ${di}`);
    const shortShare = t.trucks.departed > 0 ? t.trucks.short / t.trucks.departed : 0;
    if (os !== (t.role === 'out' && t.trucks.departed >= 3 && shortShare >= 0.1)) bad.push(`${tag}: outbound-short is ${os}`);
    if (db && !(enough && util >= 0.85 && wait >= 5 * 60)) bad.push(`${tag}: doors-bottleneck without its symptom`);
    if (db && ul) bad.push(`${tag}: doors-bottleneck and unload-limited-by-vehicles together`);
    if (ul && (t.role !== 'in' || !(util >= 0.85 || wait >= 5 * 60))) bad.push(`${tag}: unload-limited-by-vehicles without its symptom`);
    if (di && (gq || db || ul)) bad.push(`${tag}: doors-idle together with a finding about waiting`);
    if (enough && util >= 0.85 && wait >= 5 * 60 && !db && !ul && !(t.role === 'out' && shortShare >= 0.1)) {
      // the doors are the symptom and no rule names a cause: only allowed when the vehicles or the room downstream are the reason (evidence in the report)
      const s = report.stations[id];
      const flows = sim.layout.flows.filter((f) => f.from === id).map((f) => report.flows[f.id]).filter(Boolean);
      const trips = sum(flows.map((f) => f.trips));
      const pickup = trips > 0 ? sum(flows.map((f) => (f.avgPickupWait || 0) * f.trips)) / trips : null;
      const evidence = s.blocked >= 0.25 || (pickup !== null && pickup >= 120);
      if (t.role === 'out' || !evidence) bad.push(`${tag}: the doors are busy and trucks wait, but no rule says why`);
    }
  }
  const warned = insights.some((i) => /^(gate-queue-long|doors-bottleneck|unload-limited-by-vehicles|outbound-short):/.test(i.id));
  if (warned && insights.some((i) => i.severity === 'good')) bad.push('a "good" insight next to a warning about trucks');
  for (const i of insights) {
    const text = [i.title, i.detail, i.suggestion || ''].join(' ');
    if (/NaN|undefined|Infinity|\bnull\b/.test(text)) bad.push(`${i.id}: junk in the text: ${text.slice(0, 120)}`);
  }
  return bad;
}

test('M1-SIM-REV 1.1 hostile plants: conservation and every invariant of 6.3.5 on every tick, report.ops equal to an independent ledger, the insight rules equal to Appendix B', () => {
  const tally = newTally();
  // a Goods out truck starts its check-out short only when it is closing AND no pallet is on its way (6.3.3): watched at the moment it happens
  const departures = { full: 0, short: 0, bad: [] };
  const restoreProgress = patch('progress', (original) => function (st, truck, t, lg) {
    const before = truck.state;
    original.call(this, st, truck, t, lg);
    if (this.role !== 'out' || before === 'checkout' || truck.state !== 'checkout') return;
    if (truck.loaded >= truck.plan) departures.full++;
    else {
      departures.short++;
      if (!truck.closing || st.inboundTotal !== 0 || t + 1e-9 < truck.closeAt) departures.bad.push(`truck ${truck.id}: closing ${truck.closing}, ${st.inboundTotal} pallets on their way, t ${t}, closeAt ${truck.closeAt}`);
    }
  });
  const seen = { events: new Set(), noShow: 0, turnedAway: 0, short: 0, full: 0, removals: 0, zeroDemand: 0, warmups: 0, noVehicles: 0, findings: 0 };
  const runOne = (seed) => {
    const { layout, actions } = hostileTruckPlant(seed, { horizon: FUZZ_SECONDS });
    const sim = new Simulation(layout, { seed });
    const ledger = makeLedger(sim);
    seen.removals += actions.filter((a) => a.kind === 'removeVehicle').length;
    seen.zeroDemand += actions.filter((a) => a.kind === 'demand' && a.value === 0).length;
    if (sim.settings.warmup > 0) seen.warmups++;
    if (sim.vehicles.length === 0) seen.noVehicles++;
    for (const part of [0.34, 0.33, 0.33]) {
      runAudited(sim, FUZZ_SECONDS * part, { actions, ledger, tally, label: `seed ${seed}` });
      assert.deepEqual(nonFinite(sim.kpis()), [], `seed ${seed}: no NaN or Infinity in the report at t=${sim.time}`);
    }
    const report = sim.kpis();
    assert.deepEqual(compareOps(sim, report, ledger), [], `seed ${seed}: report.ops against the ledger`);
    for (const [id, t] of Object.entries(report.ops.trucks)) assert.equal(t.gateQueueSeries.length, report.series.t.length, `seed ${seed}/${id}: one gate-queue point per point of the series`);
    for (const e of ledger.events) if (e.name.startsWith('truck')) seen.events.add(e.name);
    for (const w of ledger.byStation.values()) { seen.noShow += w.noShow; seen.turnedAway += w.turnedAway; seen.short += w.short; seen.full += w.departed - w.short; }
    const insights = sim.insights(report);
    assert.deepEqual(oracle(sim, report, insights), [], `seed ${seed}: insight rules against Appendix B`);
    seen.findings += insights.filter((i) => /^(gate-queue-long|doors-|unload-limited|outbound-short)/.test(i.id)).length;
  };
  try { for (const seed of FUZZ_SEEDS) runOne(seed); } finally { restoreProgress(); }
  assert.deepEqual(departures.bad, [], 'a truck left short while pallets were on their way, or before maxDwell');
  assert.ok(departures.short > 0 && departures.full > 0, `both kinds of departure happened: ${JSON.stringify({ full: departures.full, short: departures.short })}`);
  // a pass means something only if the corners were reached
  assert.ok(tally.allDoorsBusy > 0 && tally.gateQueue > 0 && tally.checkIn > 0 && tally.outWork > 0 && tally.yard > 0, `corners: ${JSON.stringify(tally)}`);
  assert.ok(tally.staged > 0 && tally.closing > 0 && tally.closingWaits > 0, `staged pallets, closing trucks and closing trucks that wait for pallets on their way: ${JSON.stringify(tally)}`);
  assert.ok(seen.events.size === 6, `all six truck events seen: ${[...seen.events]}`);
  assert.ok(seen.noShow > 0 && seen.turnedAway > 0 && seen.short > 0 && seen.full > 0 && seen.removals > 0 && seen.zeroDemand > 0 && seen.warmups > 0 && seen.noVehicles > 0 && seen.findings > 0, `corners: ${JSON.stringify({ ...seen, events: undefined })}`);
});

// ---- 1.2 the audit is not vacuous ------------------------------------------------------------------------------------------------------------

/** Engine bugs, installed on TruckDesk.prototype one at a time: [name, install -> restore, seeds that expose it, seconds]. Seeds were calibrated with the generator. */
const MUTANTS = [
  ['the pallet is loaded onto the LAST truck at work, not the earliest', 'fifoLoading', () => patch('receive', (o) => function (st, loads, t, lg) { const real = this.docked; this.docked = real.slice().reverse(); try { o.call(this, st, loads, t, lg); } finally { this.docked = real; } })],
  ['a truck docks although all doors are busy', 'doorCount', () => patch('dock', (o) => function (st, t, lg) { const d = this.doors; this.doors = d + 5; this.doorsOpen = () => d + 5; try { o.call(this, st, t, lg); } finally { this.doors = d; delete this.doorsOpen; } })],
  ['the gate is LIFO', 'gateLifo', () => patch('dock', (o) => function (st, t, lg) { this.gate.reverse(); try { o.call(this, st, t, lg); } finally { this.gate.reverse(); } })],
  ['a pickup forgets one pallet of its truck', 'pickedUp', () => patch('pickedUp', (o) => function (loads, t) { o.call(this, loads.slice(1), t); })],
  ['room() ignores the pallets already on their way', 'roomIgnoresInbound', () => patch('room', (o) => function (st) { const saved = st.inboundTotal; st.inboundTotal = 0; try { return o.call(this, st); } finally { st.inboundTotal = saved; } })],
  ['room() counts trucks that are still in check-in', 'roomCountsCheckIn', () => patch('room', (o) => function (st) { let r = o.call(this, st); for (const k of this.docked) if (k.state === 'checkin') r += k.plan; return r; })],
  ['a closing truck leaves although pallets are on their way', 'closingLeavesEarly', () => patch('progress', (o) => function (st, truck, t, lg) { const saved = st.inboundTotal; if (this.role === 'out' && truck.state === 'work' && !truck.closing && truck.closeAt <= t + 1e-9) st.inboundTotal = 0; try { o.call(this, st, truck, t, lg); } finally { st.inboundTotal = saved; } })],
  ['a short truck is not counted as short', 'shortNotCounted', () => patch('depart', (o) => function (st, truck, t, lg) { o.call(this, st, truck, t, lg); if (this.short > 0 && truck.loaded < truck.plan) this.short--; })],
  ['every truck gets door 0', 'doorReuse', () => patch('freeDoor', () => function () { return 0; })],
  ['a truck arrives with one pallet too few', 'palletLost', () => patch('arrive', (o) => function (st, at, plan, t, lg) { o.call(this, st, at, plan, t, lg); if (this.role === 'in') { const k = this.gate[this.gate.length - 1]; if (k && k.pending.length > 1 && k.at === at) { k.pending.pop(); lg.liveLoads--; lg.createdBySources--; } } })],
  ['check-in is over after half the time', 'checkInShort', () => patch('dock', (o) => function (st, t, lg) { const ci = this.checkIn; this.checkIn = ci / 2; try { o.call(this, st, t, lg); } finally { this.checkIn = ci; } })],
  ['a Goods out truck stops waiting after half of maxDwell', 'closesTooEarly', () => patch('ready', (o) => function (st, truck, t, lg) { o.call(this, st, truck, t, lg); if (this.role === 'out' && this.maxDwell > 0) truck.closeAt = t + this.maxDwell / 2; })],
  ['the pallets are created when the truck docks, not when it arrives', 'createdAtDock', () => patch('dock', (o) => function (st, t, lg) { for (const k of this.gate) for (const l of k.pending) l.createdAt = t; o.call(this, st, t, lg); })],
  ['the door is free after half of the check-out', 'doorFreedEarly', () => patch('beginCheckout', (o) => function (truck, t) { o.call(this, truck, t); truck.freeAt = t + this.checkOut / 2; })],
  ['the door stays blocked half a minute after the check-out', 'doorFreedLate', () => patch('beginCheckout', (o) => function (truck, t) { o.call(this, truck, t); truck.freeAt = t + this.checkOut + 30; })],
];
/** For each mutant the plants (seeds) that expose it quickly: calibrated, cheapest first. */
const MUTANT_SEEDS = {
  fifoLoading: [12], doorCount: [1], gateLifo: [1], pickedUp: [1], roomIgnoresInbound: [6], roomCountsCheckIn: [2], closingLeavesEarly: [24], shortNotCounted: [22], // [2] before M1-SIM-REV-2 was fixed: the short departures of seed 2 were the starvation by the minimum batch
  doorReuse: [1], palletLost: [1], checkInShort: [6], closesTooEarly: [2], createdAtDock: [12], doorFreedEarly: [9], doorFreedLate: [6],
};

test('M1-SIM-REV 1.2 the audit is not vacuous: 15 bugs put into the engine one by one are all caught', () => {
  const missed = [];
  for (const [what, key, install] of MUTANTS) {
    const restore = install();
    let caught = null;
    try {
      for (const seed of HEAVY ? range(1, 40) : MUTANT_SEEDS[key]) {
        if (caught) break;
        const { layout, actions } = hostileTruckPlant(seed, { horizon: 900 });
        const sim = new Simulation(layout, { seed });
        try { runAudited(sim, HEAVY ? 900 : 700, { actions, ledger: makeLedger(sim), label: `${key} seed ${seed}` }); } catch (e) { caught = e.message.split('\n').slice(0, 2).join(' | '); }
      }
    } finally { restore(); }
    if (!caught) missed.push(`${key}: ${what}`);
  }
  assert.deepEqual(missed, [], 'bugs the audit does not see');
  // and the unpatched engine passes the plants that exposed them (the patches are really gone)
  const { layout, actions } = hostileTruckPlant(12, { horizon: 900 });
  const sim = new Simulation(layout, { seed: 12 });
  runAudited(sim, 520, { actions, ledger: makeLedger(sim) });
});

// ---- 2. semantics ---------------------------------------------------------------------------------------------------------------------------

/** Run a micro plant tick by tick; `during(sim)` is called after every tick. */
function drive(layout, seconds, { seed = 1, during = null, setup = null } = {}) {
  const sim = new Simulation(layout, { seed });
  if (setup) setup(sim);
  const end = seconds - sim.dt * 1e-6;
  while (sim.time < end) { sim.step(); if (during) during(sim); }
  return sim;
}

/** The ledger identity: the integral of the work in progress over a whole run equals the sum of the lead times of the pallets that left plus the ages of those still here. */
function littleGap(sim, seconds, setup = null) {
  let integral = 0;
  let lead = 0;
  let completed = 0;
  sim.on('loadCompleted', (p) => { lead += p.leadTime; completed++; });
  if (setup) setup(sim);
  const dt = sim.dt;
  const end = seconds - dt * 1e-6;
  while (sim.time < end) { sim.step(); integral += sim.logistics.liveLoads * dt; }
  let ages = 0;
  const live = allLoads(sim.logistics);
  for (const { load } of live) ages += sim.time - load.createdAt;
  const lg = sim.logistics;
  const pallets = lg.createdBySources + lg.createdByProcesses;
  return { integral, lead, ages, pallets, completed, live: live.length, gap: Math.abs(integral - lead - ages), tolerance: pallets * 1.5 * dt };
}

test('M1-SIM-REV 2.1 lead time starts at the arrival at the gate: the work in progress integrated over a run equals the lead times plus the ages (Little, exactly), in rate mode and in a timetable', () => {
  const rate = microLine({
    inbound: { doors: 1, checkIn: 300, checkOut: 300, interArrival: { kind: 'exp', mean: 1500, spread: 0 }, pallets: { kind: 'uniform', mean: 12, spread: 0.5 } },
    outbound: { doors: 2, checkIn: 60, checkOut: 60, interArrival: K(900), pallets: K(12), staging: 12, maxDwell: 1800 }, fleet: { count: 3 }, settings: { dt: 0.25 },
  });
  const rows = Array.from({ length: 18 }, (_, i) => ({ at: 600 + i * 1500, pallets: i % 3 === 0 ? null : 8 + (i % 5) }));
  const table = microLine({
    inbound: { doors: 2, checkIn: 120, checkOut: 120, mode: 'schedule', schedule: rows, jitter: 200, noShow: 0.1, pallets: { kind: 'uniform', mean: 10, spread: 0.5 } },
    outbound: { doors: 1, checkIn: 60, checkOut: 60, interArrival: K(1200), pallets: K(10), staging: 6, maxDwell: 1200 }, fleet: { count: 2 }, settings: { dt: 0.25 }, calendar: { startTod: 0 },
  });
  const hours = HEAVY ? 24 : 6;
  for (const [name, layout, setup] of [['rate', rate, null], ['timetable with a demand change', table, (sim) => sim.on('truckArrived', () => { if (sim.time > 3 * 3600 && sim.settings.demandFactor === 1) sim.setRuntime({ demandFactor: 1.5 }); })]]) {
    const sim = new Simulation(layout, { seed: 5 });
    const r = littleGap(sim, hours * 3600, setup);
    assert.ok(r.pallets > 50, `${name}: enough pallets to mean something (${r.pallets})`);
    assert.ok(r.gap <= r.tolerance, `${name}: integral ${r.integral.toFixed(1)} vs leads ${r.lead.toFixed(1)} + ages ${r.ages.toFixed(1)}: gap ${r.gap.toFixed(2)} s over ${r.pallets} pallets (allowed ${r.tolerance.toFixed(1)})`);
  }
});

test('M1-SIM-REV 2.1b Little at the doors (A1.5), own plant: the time-average number of trucks at the doors equals the departure rate times the mean door time, within 5 %', () => {
  const layout = microLine({ inbound: { doors: 4, checkIn: 60, checkOut: 60, interArrival: { kind: 'exp', mean: 400, spread: 0 }, pallets: K(6) }, fleet: { count: 4 }, settings: { dt: 0.25 } });
  const sim = new Simulation(layout, { seed: 9 });
  sim.advance((HEAVY ? 24 : 10) * 3600);
  const t = sim.kpis().ops.trucks.s1;
  const window = sim.kpis().window.duration;
  assert.ok(t.trucks.departed > 60, `trucks: ${t.trucks.departed}`);
  const inside = t.doorUtilization * t.doors; // mean trucks at the doors
  const little = (t.trucks.departed / window) * t.doorTime.mean;
  assert.ok(Math.abs(inside - little) / little < 0.05, `L = ${inside.toFixed(3)} against lambda x W = ${little.toFixed(3)}`);
});

test('M1-SIM-REV 2.2 door time depends on the vehicles: with half the forklifts the same trucks hold their doors much longer', () => {
  const doorTime = (forklifts) => {
    const layout = microLine({ inbound: { doors: 3, checkIn: 120, checkOut: 120, interArrival: K(3000), pallets: K(24) }, fleet: { count: forklifts, loadTime: 20, unloadTime: 20 }, settings: { dt: 0.25 } });
    const sim = new Simulation(layout, { seed: 1 });
    sim.advance(5 * 3600);
    const t = sim.kpis().ops.trucks.s1;
    assert.equal(t.gateQueue.max, 0, 'doors are not the limit here: nobody waits at the gate');
    return t.doorTime.mean - 240; // minus check-in and check-out: what the vehicles take
  };
  const [one, two, four] = [1, 2, 4].map(doorTime);
  assert.ok(one > 1.6 * two, `1 forklift ${one.toFixed(0)} s of unloading against 2 forklifts ${two.toFixed(0)} s`);
  assert.ok(two > 1.4 * four, `2 forklifts ${two.toFixed(0)} s against 4 forklifts ${four.toFixed(0)} s`);
});

test('M1-SIM-REV 2.3 a door is held until the last pallet is picked up, for exactly the check-out after it: the next truck waits at the gate while pallets stand in the yard', () => {
  const layout = microLine({ inbound: { doors: 1, checkIn: 60, checkOut: 30, interArrival: K(600), pallets: K(12) }, aParams: { outCap: 2 }, fleet: { count: 1, loadTime: 20, unloadTime: 20 } });
  const departures = [];
  const lastPick = new Map();
  let overlap = 0;
  const sim = drive(layout, 4000, {
    setup: (s) => {
      s.on('orderPickedUp', (p) => { for (const l of p.order.loads) if (l.tk >= 0 && p.order.from === 's1') lastPick.set(l.tk, p.t); });
      s.on('truckDeparted', (p) => departures.push({ id: p.truck.id, t: p.t, last: lastPick.get(p.truck.id) }));
    },
    during: (s) => { const a = s.logistics.stationById.get('s1'); if (a.trucks.gate.length > 0 && a.yardQ.length > 0 && a.trucks.docked.length === 1 && a.trucks.docked[0].state === 'work') overlap++; },
  });
  assert.ok(departures.length >= 2, 'at least two trucks went through the door');
  for (const d of departures) assert.ok(d.t - 30 >= d.last - 1e-6 && d.t - 30 <= d.last + sim.dt + 1e-6, `truck ${d.id} freed its door at ${d.t}, last pallet picked up at ${d.last}, check-out 30 s`);
  assert.ok(overlap > 100, `trucks waited at the gate while the docked truck still had pallets in the yard (${overlap} ticks)`);
  const t = sim.kpis().ops.trucks.s1;
  assert.ok(t.doorTime.mean > 600 && t.gateQueue.max >= 2, `the single door is the queue: door time ${t.doorTime.mean}, gate queue max ${t.gateQueue.max}`);
});

test('M1-SIM-REV 2.4 the demand slider: rate mode scales the frequency of trucks (both directions) and not their pallets, a timetable scales the pallets and not the times, 0 means nobody comes', () => {
  const arrivalsOf = (layout, seconds, id, setup = null) => {
    const list = [];
    const sim = new Simulation(layout, { seed: 3 });
    sim.on('truckArrived', (p) => { if (p.stationId === id) list.push([p.at, p.truck.plan]); });
    if (setup) setup(sim);
    sim.advance(seconds);
    return { list, sim };
  };
  // rate mode, Goods in: arrivals at i x gap / factor, pallets unchanged
  for (const factor of [0.5, 1, 2]) {
    const layout = microLine({ inbound: { doors: 32, checkIn: 0, checkOut: 0, interArrival: K(1000), pallets: K(5) }, fleet: null, settings: { demandFactor: factor, dt: 0.5 } });
    const { list } = arrivalsOf(layout, 6000, 's1');
    list.forEach(([at, plan], i) => { assert.ok(Math.abs(at - (i * 1000) / factor) < 1e-6, `Goods in, factor ${factor}: truck ${i} at ${at}`); assert.equal(plan, 5); });
    assert.ok(list.length >= Math.floor((6000 * factor) / 1000) - 1, `Goods in, factor ${factor}: ${list.length} trucks`);
  }
  // rate mode, Goods out: the first truck after one gap / factor
  for (const factor of [0.5, 2]) {
    const layout = microLine({ outbound: { doors: 32, checkIn: 0, checkOut: 0, interArrival: K(1000), pallets: K(5), staging: 0, maxDwell: 10 }, storage: false, flows: [], fleet: null, settings: { demandFactor: factor, dt: 0.5 } });
    const { list } = arrivalsOf(layout, 6000, 's3');
    list.forEach(([at, plan], i) => { assert.ok(Math.abs(at - ((i + 1) * 1000) / factor) < 1e-6, `Goods out, factor ${factor}: truck ${i} at ${at}`); assert.equal(plan, 5); });
  }
  // a change in the middle: the arrival that is pending keeps its place in the rescaled process (remaining time x old / new); the first truck of a Goods in does not move
  {
    const layout = microLine({ inbound: { doors: 32, checkIn: 0, checkOut: 0, interArrival: K(1000), pallets: K(5) }, fleet: null, settings: { dt: 0.5 } });
    const sim = new Simulation(layout, { seed: 3 });
    const at = [];
    sim.on('truckArrived', (p) => at.push(p.at));
    sim.advance(300);
    const now = sim.logistics.now;
    sim.setRuntime({ demandFactor: 2 });
    sim.advance(2000);
    assert.equal(at[0], 0);
    assert.ok(Math.abs(at[1] - (now + (1000 - now) / 2)) < 1e-6, `the pending arrival: ${at[1]} expected ${now + (1000 - now) / 2}`);
    assert.ok(Math.abs(at[2] - at[1] - 500) < 1e-6, 'then every 500 s');
    // demand 0 (only the brain accepts it): nobody comes; back to 1 a fresh gap starts from now
    sim.logistics.setRuntime({ demandFactor: 0 });
    const count = at.length;
    sim.advance(3000);
    assert.equal(at.length, count, 'nobody arrives while the demand is 0');
    const resumed = sim.logistics.now;
    sim.logistics.setRuntime({ demandFactor: 1 });
    sim.advance(1100);
    assert.ok(Math.abs(at[count] - (resumed + 1000)) < 1e-6, `the first truck after the pause comes one gap after the demand returns (${at[count]} vs ${resumed + 1000})`);
  }
  // timetable: times fixed, pallets x factor rounded, at least 1; 0 and nobody comes
  const rows = [{ at: 100, pallets: 4 }, { at: 5000, pallets: 10 }, { at: 7000, pallets: 4 }];
  const timetable = (factor) => microLine({ inbound: { doors: 32, checkIn: 0, checkOut: 0, mode: 'schedule', schedule: rows }, fleet: null, calendar: { startTod: 0 }, settings: { demandFactor: factor, dt: 0.5 } });
  for (const [factor, plans] of [[2.5, [10, 25, 10]], [1, [4, 10, 4]], [0.1, [1, 1, 1]], [0.05, [1, 1, 1]]]) {
    const { list } = arrivalsOf(timetable(factor), 8000, 's1');
    assert.deepEqual(list.map((x) => x[0]), [100, 5000, 7000], `factor ${factor}: appointments do not move`);
    assert.deepEqual(list.map((x) => x[1]), plans, `factor ${factor}: pallets per truck`);
  }
  // demand 0 in a timetable: the appointments that fall into the pause bring no truck at all (not even a no-show), the later ones come
  const sim = new Simulation(timetable(1), { seed: 3 });
  const names = [];
  sim.on('*', (p, name) => { if (/^truck(Arrived|NoShow|TurnedAway)$/.test(name)) names.push(`${name}@${p.at}`); });
  sim.logistics.setRuntime({ demandFactor: 0 });
  sim.advance(6000);
  sim.logistics.setRuntime({ demandFactor: 1 });
  sim.advance(2000);
  assert.deepEqual(names, ['truckArrived@7000'], 'with the demand at 0 until t=6000 only the last appointment comes');
});

test('M1-SIM-REV 2.5 outbound pull as in 6.3.3: with staging 0 nothing is fetched before a truck is ready, with staging pallets wait up to the staging space and a truck takes them at once', () => {
  for (const staging of [0, 3]) {
    const layout = microLine({
      aParams: { interArrival: K(60), outCap: 20 },
      outbound: { doors: 2, checkIn: 0, checkOut: 0, mode: 'schedule', schedule: [{ at: 3600, pallets: 4 }], staging, maxDwell: 3600 }, fleet: { count: 3 }, calendar: { startTod: 0 },
    });
    const sim = new Simulation(layout, { seed: 1 });
    const lg = sim.logistics;
    const c = lg.stationById.get('s3');
    const flow = lg.flows.find((f) => f.to.id === 's3');
    sim.advance(3590);
    assert.equal(c.trucks.stagingCap, staging * 2);
    assert.equal(c.trucks.staged.length, staging * 2, `staging ${staging}: the staging space is full before the truck comes, not more`);
    assert.equal(flow.delivered, staging * 2, `staging ${staging}: nothing else was fetched`);
    assert.equal(c.inboundTotal, 0);
    assert.ok(lg.stationById.get('s2').outCount > 30, 'the storage keeps the rest');
    const events = [];
    sim.on('*', (p, name) => { if (name.startsWith('truck') && p.stationId === 's3') events.push([name, p.truck ? p.truck.loaded : null]); });
    sim.advance(400);
    const names = events.map((e) => e[0]);
    assert.deepEqual(names.slice(0, 3), ['truckArrived', 'truckDocked', 'truckReady']);
    assert.ok(names.includes('truckDeparted'), 'the truck left');
    assert.equal(events.find((e) => e[0] === 'truckDeparted')[1], 4, 'full');
    if (staging > 0) assert.equal(events.find((e) => e[0] === 'truckReady')[1], 4, 'the staged pallets went on the truck at once, when check-in was over');
    sim.advance(600);
    assert.equal(c.trucks.staged.length, staging * 2, `staging ${staging}: after the truck left the staging space is refilled to its size and no further`);
    assert.equal(flow.delivered, 4 + staging * 2);
  }
});

test('M1-SIM-REV 2.6 outbound FIFO and closing: the earliest-docked truck fills first; at maxDwell a truck waits for the pallets on their way, takes them, and leaves short', () => {
  // FIFO: two trucks at work at once; truck 2 gets pallets only when truck 1 is full
  const fifo = microLine({
    aParams: { interArrival: K(40), outCap: 20 },
    outbound: { doors: 2, checkIn: 0, checkOut: 0, mode: 'schedule', schedule: [{ at: 2000, pallets: 5 }, { at: 2000, pallets: 5 }], staging: 0, maxDwell: 3600 }, fleet: { count: 3 }, calendar: { startTod: 0 },
  });
  let both = 0;
  drive(fifo, 3000, { during: (sim) => { const d = sim.logistics.stationById.get('s3').trucks.docked; if (d.length === 2) { both++; assert.ok(!(d[1].loaded > 0 && d[0].loaded < d[0].plan), `truck 2 loaded ${d[1].loaded} while truck 1 has ${d[0].loaded}/${d[0].plan}`); } } });
  assert.ok(both > 5, 'both trucks were at work together');
  // closing: slow vehicles keep pallets in flight when maxDwell runs out
  const slow = microLine({
    aParams: { interArrival: K(20), outCap: 50 },
    outbound: { doors: 1, checkIn: 0, checkOut: 0, mode: 'schedule', schedule: [{ at: 3000, pallets: 10 }], staging: 0, maxDwell: 100, pallets: K(10) }, fleet: { count: 6, loadTime: 60, unloadTime: 60 }, calendar: { startTod: 0 },
  });
  const trace = { readyAt: null, closedWithInbound: null, deliveredAt: [], departedAt: null, loaded: null };
  const sim = drive(slow, 3600, {
    setup: (s) => {
      s.on('truckReady', (p) => { if (p.stationId === 's3') trace.readyAt = p.t; });
      s.on('loadCompleted', (p) => { if (p.stationId === 's3') trace.deliveredAt.push(p.t); });
      s.on('truckDeparted', (p) => { trace.departedAt = p.t; trace.loaded = p.truck.loaded; trace.short = p.short; });
    },
    during: (s) => {
      const c = s.logistics.stationById.get('s3');
      const k = c.trucks.docked[0];
      if (k && k.closing && trace.closedWithInbound === null) trace.closedWithInbound = c.inboundTotal;
    },
  });
  assert.ok(trace.closedWithInbound > 0, `the truck closed with pallets on their way (${trace.closedWithInbound}): the scenario exercises the waiting`);
  assert.ok(trace.departedAt > trace.readyAt + 100, 'it waited longer than maxDwell');
  assert.ok(trace.deliveredAt.length >= 1 && trace.departedAt >= Math.max(...trace.deliveredAt) - 1e-6, 'it left only after the last pallet on its way was delivered');
  assert.ok(trace.loaded === trace.deliveredAt.length && trace.loaded < 10 && trace.short === true, `it took exactly what came (${trace.loaded}) and left short`);
  assert.equal(sim.kpis().ops.trucks.s3.fillRate, trace.loaded / 10);
});

// ---- 3. determinism ---------------------------------------------------------------------------------------------------------------------------

const arrivalLists = (layout, dt, seconds, seed) => {
  const copy = JSON.parse(JSON.stringify(layout));
  copy.settings.dt = dt;
  const sim = new Simulation(copy, { seed });
  const out = {};
  for (const name of ['truckArrived', 'truckTurnedAway', 'truckNoShow']) sim.on(name, (p) => { (out[p.stationId] ||= []).push(`${name.slice(5, 6)}${p.at.toFixed(6)}`); });
  sim.advance(seconds);
  return out;
};
/** Nominal times only (arrived and turned away are the same moment; which of the two it was depends on the state of the plant). */
const timesOf = (list, horizon) => (list || []).map((s) => s.slice(1)).filter((t) => Number(t) < horizon).join(',');

test('M1-SIM-REV 3.1 determinism: the same seed gives the same digest even after other plants ran in between, another seed does not', () => {
  const seeds = HEAVY ? [3, 8, 11, 17, 22, 29] : [78];
  for (const seed of seeds) {
    const run = (s, plant = hostileTruckPlant(seed, { horizon: 900 })) => {
      const sim = new Simulation(plant.layout, { seed: s });
      const ledger = makeLedger(sim);
      runAudited(sim, 900, { actions: [...plant.actions], ledger });
      return `${JSON.stringify(sim.kpis())}#${ledger.events.map((e) => `${e.name}:${e.stationId ?? ''}:${e.truckId ?? ''}:${e.t.toFixed(6)}`).join('|')}#${JSON.stringify(sim.insights())}`;
    };
    const first = run(seed);
    run(seed + 1000, hostileTruckPlant(seed + 1, { horizon: 900 })); // something else in between: no module-level state may leak
    assert.equal(run(seed), first, `seed ${seed}: identical`);
    assert.notEqual(run(seed + 5000), first, `seed ${seed}: another seed differs`);
  }
});

test('M1-SIM-REV 3.2 the nominal arrival times do not depend on dt: 0.1, 0.25 and 0.05 give the same list (rate mode and timetables, jitter, no-shows, demand slider)', () => {
  const seeds = HEAVY ? range(1, 60) : [2, 4, 16, 22, 29];
  const seconds = HEAVY ? 3000 : 1200;
  let compared = 0;
  for (const seed of seeds) {
    const layout = withoutVehicles(hostileTruckPlant(seed, { horizon: seconds }).layout);
    const ref = arrivalLists(layout, 0.1, seconds, seed);
    for (const dt of [0.25, 0.05]) {
      const got = arrivalLists(layout, dt, seconds, seed);
      for (const id of new Set([...Object.keys(ref), ...Object.keys(got)])) {
        compared++;
        assert.equal(timesOf(got[id], seconds - 0.3), timesOf(ref[id], seconds - 0.3), `seed ${seed}, station ${id}, dt ${dt}`);
      }
    }
  }
  assert.ok(compared >= 14, `stations compared: ${compared}`);
});

test('M1-SIM-REV 3.3 fork independence: adding trucks to the plant and REMOVING another truck station leave the arrival times of every other station unchanged', () => {
  const seeds = HEAVY ? range(1, 120) : [3, 6, 8, 14, 17, 20];
  const seconds = HEAVY ? 3000 : 900;
  let removed = 0; let added = 0;
  for (const seed of seeds) {
    const base = withoutVehicles(hostileTruckPlant(seed, { horizon: seconds }).layout);
    const trucked = base.stations.filter((s) => s.ops && s.ops.trucks);
    const ref = arrivalLists(base, base.settings.dt, seconds, seed);
    if (trucked.length >= 2) {
      for (const victim of trucked.slice(0, 2)) {
        const copy = JSON.parse(JSON.stringify(base));
        assert.ok(removeStation(copy, victim.id));
        const got = arrivalLists(normalizeLayout(copy), base.settings.dt, seconds, seed);
        removed++;
        for (const st of trucked) if (st.id !== victim.id) assert.equal(timesOf(got[st.id], seconds - 0.3), timesOf(ref[st.id], seconds - 0.3), `seed ${seed}: station ${st.id} after removing ${victim.id}`);
      }
    }
    const copy = JSON.parse(JSON.stringify(base));
    const extra = addStation(copy, { type: 'source', x: 2, y: 26, w: 4, h: 2, ops: { trucks: { doors: 2, interArrival: K(300) } } });
    const out = addStation(copy, { type: 'sink', x: 10, y: 26, w: 4, h: 2, ops: { trucks: { doors: 1, interArrival: K(400) } } });
    if (extra && out) {
      addFlow(copy, extra.id, out.id);
      const got = arrivalLists(normalizeLayout(copy), base.settings.dt, seconds, seed);
      added++;
      for (const st of trucked) assert.equal(timesOf(got[st.id], seconds - 0.3), timesOf(ref[st.id], seconds - 0.3), `seed ${seed}: station ${st.id} after adding two truck stations`);
    }
  }
  assert.ok(removed >= 4 && added >= 3, `compared ${removed} removals and ${added} additions`);
});

test('M1-SIM-REV 3.4 a run cut into pieces (also a warm restart: pre-roll, then on) gives the same result as one advance()', () => {
  for (const seed of HEAVY ? [3, 8, 22, 24, 29] : [22, 24]) {
    const { layout } = hostileTruckPlant(seed, { horizon: 900 });
    const whole = new Simulation(layout, { seed });
    whole.advance(900);
    const pieces = new Simulation(layout, { seed });
    for (const part of [123.4, 0.1, 300, 76.5, 400]) pieces.advance(part); // multiples of dt: the same tick sequence
    assert.equal(pieces.time.toFixed(6), whole.time.toFixed(6));
    assert.equal(JSON.stringify(pieces.kpis()), JSON.stringify(whole.kpis()), `seed ${seed}`);
  }
});

test('M1-SIM-REV 3.5 common random numbers in rate mode: changing the pallets distribution (its kind, its spread) does not move a single arrival', () => {
  const times = (pallets) => {
    const layout = microLine({ inbound: { doors: 32, checkIn: 0, checkOut: 0, interArrival: { kind: 'normal', mean: 900, spread: 0.4 }, pallets }, fleet: null, settings: { dt: 0.5 } });
    const sim = new Simulation(layout, { seed: 4 });
    const out = [];
    sim.on('truckArrived', (p) => out.push(p.at.toFixed(6)));
    sim.advance(20000);
    return out.join(' ');
  };
  const reference = times(K(10));
  assert.equal(times({ kind: 'uniform', mean: 10, spread: 0.5 }), reference);
  assert.equal(times({ kind: 'exp', mean: 40, spread: 0 }), reference);
  assert.equal(times({ kind: 'normal', mean: 10, spread: 0.9 }), reference);
});

// ---- 4. legacy neutrality ------------------------------------------------------------------------------------------------------------------

function digestOf(S, layoutText, seed, seconds) {
  const sim = new S(JSON.parse(layoutText), { seed });
  let h = 2166136261;
  let n = 0;
  sim.on('*', (p, name) => {
    const text = `${name}:${p.t ?? ''}:${p.stationId ?? ''}:${p.vehicleId ?? ''}:${p.load ? p.load.id : ''}:${p.order ? p.order.id : ''}`;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
    n++;
  });
  sim.advance(seconds);
  const report = sim.kpis();
  return { kpis: JSON.stringify(report), insights: JSON.stringify(sim.insights(report)), events: `${n}:${(h >>> 0).toString(16)}`, hasOps: Object.hasOwn(report, 'ops'), completed: sim.logistics.completed };
}
const sameRun = (a, b, what) => {
  assert.equal(b.kpis, a.kpis, `${what}: kpis`);
  assert.equal(b.insights, a.insights, `${what}: insights`);
  assert.equal(b.events, a.events, `${what}: event stream`);
};

test('M1-SIM-REV 4.1 legacy neutrality against the real old tree: the examples and random plants without trucks give identical kpis, insights and event streams', { skip: OLD_ROOT ? false : SKIP_OLD }, () => {
  const ids = HEAVY ? ['starter', 'two-lines', 'congestion-lab'] : ['two-lines'];
  const seeds = HEAVY ? [1, 2, 3, 4] : [1];
  const hours = HEAVY ? 8 : 0.4;
  let events = 0;
  for (const id of ids) {
    const fresh = EXAMPLES.find((e) => e.id === id);
    const legacy = old.EXAMPLES.find((e) => e.id === id);
    assert.equal(JSON.stringify(fresh.build()), JSON.stringify(legacy.build()), `${id}: the example itself is unchanged`);
    for (const seed of seeds) {
      const text = JSON.stringify(legacy.build());
      const a = digestOf(old.Simulation, text, seed, hours * 3600);
      const b = digestOf(Simulation, text, seed, hours * 3600);
      sameRun(a, b, `${id} seed ${seed}`);
      assert.equal(b.hasOps, false, `${id}: a legacy report has no ops key`);
      events += Number(a.events.split(':')[0]);
    }
  }
  const plants = HEAVY ? range(1, 100) : [22, 6, 24, 37, 20]; // the busiest of the first thirty
  for (const seed of plants) {
    const text = JSON.stringify(legacyPlant(seed));
    const a = digestOf(old.Simulation, text, seed, HEAVY ? 1500 : 450);
    const b = digestOf(Simulation, text, seed, HEAVY ? 1500 : 450);
    sameRun(a, b, `legacy plant ${seed}`);
    assert.equal(b.hasOps, false);
    events += Number(a.events.split(':')[0]);
  }
  assert.ok(events > (HEAVY ? 40000 : 700), `the runs did work (${events} events compared)`);
});

test('M1-SIM-REV 4.2 a clock alone, ops blocks on stations that cannot have trucks, and ops on a Goods in that has none change nothing', { skip: OLD_ROOT ? false : SKIP_OLD }, () => {
  for (const seed of [2, 5, 9]) {
    const plain = legacyPlant(seed);
    const plainText = JSON.stringify(plain);
    // (a) a plant clock that nothing uses
    const withClock = JSON.parse(plainText);
    updateCalendar(withClock, { startTod: 6 * 3600, startDay: 2 });
    assert.ok(withClock.calendar && withClock.schema === 2);
    // (b) options on station types that have none: dropped by the sanitizer
    const junk = JSON.parse(plainText);
    for (const st of junk.stations) if (st.type !== 'source' && st.type !== 'sink') st.ops = { trucks: { doors: 3, mode: 'schedule', schedule: [{ at: 1, pallets: 5 }] } };
    const reference = digestOf(old.Simulation, plainText, seed, 600);
    sameRun(reference, digestOf(Simulation, JSON.stringify(withClock), seed, 600), `seed ${seed}: a plant clock`);
    sameRun(reference, digestOf(Simulation, JSON.stringify(normalizeLayout(junk)), seed, 600), `seed ${seed}: ops on a workstation, storage and depot`);
  }
});

// ---- 5. statistics and insights --------------------------------------------------------------------------------------------------------------

/** A real report with the numbers of one truck station changed (paths such as 'gateWait.mean'). */
function changed(report, station, patchObject) {
  const copy = structuredClone(report);
  for (const [p, value] of Object.entries(patchObject)) {
    const keys = p.split('.');
    let at = copy.ops.trucks[station];
    for (const key of keys.slice(0, -1)) at = at[key];
    at[keys[keys.length - 1]] = value;
  }
  return copy;
}
const idsOf = (insights) => insights.filter((i) => /^(gate-queue-long|doors-bottleneck|unload-limited-by-vehicles|doors-idle|outbound-short):/.test(i.id)).map((i) => i.id).sort();

test('M1-SIM-REV 5.1 thresholds are in seconds, not minutes: one second under each limit is silent, the limit speaks; 15 SECONDS is nothing', () => {
  const layout = microLine({ inbound: { doors: 2, checkIn: 60, checkOut: 60, interArrival: K(1200), pallets: K(6) }, outbound: { doors: 2, checkIn: 60, checkOut: 60, interArrival: K(1500), pallets: K(6), staging: 2, maxDwell: 600 }, fleet: { count: 4 } });
  const sim = new Simulation(layout, { seed: 2 });
  sim.advance(4 * 3600);
  const base = sim.kpis();
  // make the station quiet and sure of its trucks, then move one number at a time
  const quiet = { 'trucks.arrived': 10, 'trucks.docked': 10, 'trucks.departed': 10, 'trucks.short': 0, 'gateWait.mean': 0, 'gateQueue.mean': 0, 'gateQueue.max': 0, doorUtilization: 0.5 };
  const at = (patchObject, extra = {}) => idsOf(generateInsights(changed(base, 's1', { ...quiet, ...patchObject }), sim.layout)).filter((id) => id.endsWith(':s1') && !(extra.keep === false));
  assert.deepEqual(at({}), [], 'a quiet station says nothing');
  assert.deepEqual(at({ 'gateWait.mean': 899 }), []);
  assert.deepEqual(at({ 'gateWait.mean': 15 }), [], '15 seconds of waiting is not 15 minutes');
  assert.deepEqual(at({ 'gateWait.mean': 900 }), ['gate-queue-long:s1']);
  const sev = (w) => generateInsights(changed(base, 's1', { ...quiet, 'gateWait.mean': w }), sim.layout).find((i) => i.id === 'gate-queue-long:s1').severity;
  assert.equal(sev(2699), 'warning');
  assert.equal(sev(2700), 'critical');
  assert.deepEqual(at({ 'gateWait.mean': 299, doorUtilization: 0.9 }), []);
  assert.ok(at({ 'gateWait.mean': 300, doorUtilization: 0.85 }).some((id) => id.startsWith('doors-bottleneck') || id.startsWith('unload-limited')), '5 minutes and 85 %');
  assert.deepEqual(at({ 'gateWait.mean': 300, doorUtilization: 0.8499 }), []);
  assert.deepEqual(at({ 'gateWait.mean': 61, doorUtilization: 0.1 }).filter((id) => id.startsWith('doors-idle')), []);
  assert.deepEqual(at({ 'gateWait.mean': 59, doorUtilization: 0.29 }).filter((id) => id.startsWith('doors-idle')), ['doors-idle:s1']);
  assert.deepEqual(at({ 'gateWait.mean': 59, doorUtilization: 0.31 }), []);
});

test('M1-SIM-REV 5.2 engineered plants: each finding appears where it must and the others do not', () => {
  const run = (layout, hours) => { const sim = new Simulation(layout, { seed: 1 }); sim.advance(hours * 3600); const report = sim.kpis(); return { report, ids: idsOf(sim.insights(report)) }; };
  const doors = run(microLine({ inbound: { doors: 1, checkIn: 900, checkOut: 900, interArrival: K(1800), pallets: K(12) }, fleet: { count: 6 }, settings: { dt: 0.25 } }), 5);
  assert.deepEqual(doors.ids, ['doors-bottleneck:s1', 'gate-queue-long:s1'], 'one door, long check-in and check-out, ample forklifts: the doors');
  const vehicles = run(microLine({ inbound: { doors: 3, checkIn: 120, checkOut: 120, interArrival: K(1800), pallets: K(24) }, fleet: { count: 1, loadTime: 60, unloadTime: 60 }, settings: { dt: 0.25 } }), 5);
  assert.deepEqual(vehicles.ids, ['gate-queue-long:s1', 'unload-limited-by-vehicles:s1'], 'one slow forklift: the vehicles, not the doors');
  const short = run(microLine({ aParams: { interArrival: K(360) }, outbound: { doors: 2, checkIn: 120, checkOut: 120, interArrival: K(1800), pallets: K(24), staging: 4, maxDwell: 1200 }, fleet: { count: 4 }, settings: { dt: 0.25 } }), 4);
  assert.deepEqual(short.ids, ['outbound-short:s3'], 'supply 10 an hour for trucks of 24: the supply');
  const idle = run(microLine({ inbound: { doors: 4, checkIn: 120, checkOut: 120, interArrival: K(2400), pallets: K(12) }, fleet: { count: 4 }, settings: { dt: 0.25 } }), 4);
  assert.deepEqual(idle.ids, ['doors-idle:s1'], 'four doors for a truck every 40 minutes');
});

// ---- 6. performance and memory ---------------------------------------------------------------------------------------------------------------

test('M1-SIM-REV 6.1 a plant with trucks runs at least 500 times real time (10.5), also with 32 doors, 200 pallets a truck and a 500-row timetable', () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ at: (i * 173) % 86400, pallets: i % 4 === 0 ? 200 : null }));
  const layout = microLine({
    inbound: { doors: 32, checkIn: 0, checkOut: 0, mode: 'schedule', schedule: rows, jitter: 600, noShow: 0.2, pallets: { kind: 'uniform', mean: 60, spread: 1 } },
    outbound: { doors: 32, checkIn: 0, checkOut: 0, interArrival: K(60), pallets: K(200), staging: 50, maxDwell: 60 }, fleet: { count: 10 }, calendar: { startTod: 0 },
  });
  const sim = new Simulation(layout, { seed: 1 });
  const since = process.cpuUsage();
  sim.advance(1800);
  const seconds = cpuSeconds(since);
  assert.ok(1800 / seconds >= 500, `${(1800 / seconds).toFixed(0)} times real time (${seconds.toFixed(2)} CPU s for half an hour)`);
  assert.deepEqual(nonFinite(sim.kpis()), []);
});

heavy('M1-SIM-REV 6.2 memory: 72 simulated hours with two timetables stay flat after the first day, and the lists stay short', () => {
  const layout = microLine({
    inbound: { doors: 3, checkIn: 120, checkOut: 120, mode: 'schedule', schedule: Array.from({ length: 48 }, (_, i) => ({ at: i * 1800, pallets: i % 3 === 0 ? null : 24 })), jitter: 600, noShow: 0.1 },
    outbound: { doors: 2, checkIn: 120, checkOut: 120, mode: 'schedule', schedule: Array.from({ length: 48 }, (_, i) => ({ at: (i * 1800 + 900) % 86400, pallets: 24 })), jitter: 300, staging: 6 },
    fleet: { count: 6 }, calendar: { startTod: 0 },
  });
  const sim = new Simulation(layout, { seed: 2 });
  const gc = typeof globalThis.gc === 'function' ? globalThis.gc : null;
  const heap = () => { if (gc) { gc(); gc(); } return process.memoryUsage().heapUsed; };
  sim.advance(24 * 3600);
  const day1 = heap();
  sim.advance(48 * 3600);
  const day3 = heap();
  for (const st of sim.logistics.stations) if (st.trucks) assert.ok(st.trucks.due.length <= 2 * 48 && st.trucks.gate.length <= 50, `${st.id}: due ${st.trucks.due.length}, gate ${st.trucks.gate.length}`);
  assert.ok(sim.logistics.liveLoads < 500, `live pallets ${sim.logistics.liveLoads}`);
  if (gc) assert.ok(day3 - day1 < 6e6, `heap grew from ${(day1 / 1e6).toFixed(1)} to ${(day3 / 1e6).toFixed(1)} MB over two more days`);
});

heavy('M1-SIM-REV 6.3 allocation per tick of a legacy plant is the same on the old and the new tree (child processes, heap growth with a large semi-space)', { skip: OLD_ROOT ? false : SKIP_OLD }, () => {
  const script = `
    const [root, id, ticks] = process.argv.slice(2);
    const { EXAMPLES } = await import(root + '/js/model/examples.js');
    const { Simulation } = await import(root + '/js/sim/engine.js');
    const sim = new Simulation(EXAMPLES.find((e) => e.id === id).build(), { seed: 1 });
    sim.advance(1200);
    global.gc(); global.gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < Number(ticks); i++) sim.step();
    console.log(((process.memoryUsage().heapUsed - before) / Number(ticks)).toFixed(1));`;
  for (const id of ['starter', 'two-lines', 'congestion-lab']) {
    const bytes = [OLD_ROOT, ROOT].map((root) => {
      const r = spawnSync(process.execPath, ['--expose-gc', '--max-semi-space-size=1024', '--min-semi-space-size=1024', '--input-type=module', '-e', script, pathToFileURL(root).href, id, '30000'], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return Number(r.stdout.trim());
    });
    assert.ok(Math.abs(bytes[1] - bytes[0]) <= 0.1 * bytes[0] + 64, `${id}: old ${bytes[0]} B per tick, new ${bytes[1]} B per tick`);
  }
});

// ---- 7. documents against the code -------------------------------------------------------------------------------------------------------------

test('M1-SIM-REV 7.1 ARCHITECTURE 5.7 against the code: the events, their payloads and the report.ops keys are the documented ones', () => {
  const text = readFileSync(path.join(ROOT, 'docs', 'ARCHITECTURE.md'), 'utf8');
  const section = text.slice(text.indexOf('### 5.7 Trucks and dock doors'), text.indexOf('## 6. UI'));
  const events = section.slice(section.indexOf('**Events**'), section.indexOf('**Invariants**'));
  const documented = new Map();
  for (const m of events.matchAll(/`(truck[A-Z]\w+)(?: \{ ([^}`]*) \})?`/g)) documented.set(m[1], (m[2] || '').replace(/\/\*.*?\*\//g, '').split(',').map((s) => s.trim()).filter(Boolean).sort());
  assert.equal(documented.size, 6, `six documented events: ${[...documented.keys()]}`);
  // the events a run really emits, with their payload keys, over a few hostile plants
  const emitted = new Map();
  for (const seed of [80, 34]) {
    const { layout, actions } = hostileTruckPlant(seed, { horizon: 900 });
    const sim = new Simulation(layout, { seed });
    sim.on('*', (p, name) => {
      if (!name.startsWith('truck')) return;
      assert.ok(p.station && p.station.id === p.stationId && Number.isFinite(p.t), `${name}: station, stationId and t are always there`);
      const keys = Object.keys(p).filter((k) => !['station', 'stationId', 't'].includes(k)).sort();
      if (!emitted.has(name)) emitted.set(name, keys);
      assert.deepEqual(keys, emitted.get(name), `${name}: a payload always has the same keys`);
    });
    runAudited(sim, 900, { actions });
  }
  for (const [name, keys] of emitted) assert.deepEqual(keys, documented.get(name), `${name}: payload keys against the document`);
  assert.deepEqual([...emitted.keys()].sort(), [...documented.keys()].sort(), 'the documented events are the emitted ones');
  // report.ops.trucks keys
  const block = section.slice(section.indexOf('TruckKpis = {'), section.indexOf('```', section.indexOf('TruckKpis = {')));
  let inside = block.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  inside = inside.slice(inside.indexOf('{') + 1, inside.lastIndexOf('}'));
  while (/\{[^{}]*\}/.test(inside)) inside = inside.replace(/\{[^{}]*\}/g, '');
  const top = [...inside.matchAll(/(\w+)(?=\s*[:,])/g)].map((m) => m[1]);
  const { layout } = hostileTruckPlant(38, { horizon: 900 });
  const sim = new Simulation(layout, { seed: 38 });
  sim.advance(900);
  const entry = Object.values(sim.kpis().ops.trucks)[0];
  assert.deepEqual(Object.keys(entry), top, 'report.ops.trucks[id] keys in the documented order');
  for (const [key, inner] of Object.entries({ trucks: ['arrived', 'docked', 'departed', 'short', 'noShow', 'turnedAway'], gateWait: ['mean', 'p90', 'max'], doorTime: ['mean', 'p90'], turnaround: ['mean', 'p90'], gateQueue: ['mean', 'max', 'now'] })) {
    assert.deepEqual(Object.keys(entry[key]), inner, key);
    for (const name of inner) assert.ok(block.includes(name), `${key}.${name} is in the document`);
  }
  // the five rules of the document are the five of the code, in order, and every finding a run produced is one of them
  const named = [...section.matchAll(/`(gate-queue-long|doors-bottleneck|unload-limited-by-vehicles|doors-idle|outbound-short)`/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(named)], ['gate-queue-long', 'doors-bottleneck', 'unload-limited-by-vehicles', 'doors-idle', 'outbound-short']);
  assert.deepEqual(insightsOps.OPS_INSIGHT_RULES.map((f) => f.name), ['gateQueueLong', 'doorsBottleneck', 'unloadLimitedByVehicles', 'doorsIdle', 'outboundShort']);
});

// ---- the defects of this review, fixed: regression tests ----------------------------------------------------------------------------------------------------------

defect('M1-SIM-REV-1', 'the last pallets of a truck are held back by the minimum batch of the flow: with one door the door is blocked for good (Goods in)', () => {
  // Trucks of 6 pallets, a flow whose batch is 4 (a tugger train that waits to be full), one door. After the first batch of 4 the 2 pallets left
  // wait for 2 more, which only the NEXT truck could bring, and it cannot dock: the door is held for ever and the gate fills up.
  const layout = microLine({
    inbound: { doors: 1, checkIn: 0, checkOut: 0, interArrival: K(600), pallets: K(6) }, storage: false, flows: [['A', 'C', { batchMin: 4 }]],
    fleet: { count: 2, capacity: 4 }, settings: { dt: 0.25 },
  });
  const sim = new Simulation(layout, { seed: 1 });
  sim.advance(2 * 3600);
  const t = sim.kpis().ops.trucks.s1;
  assert.ok(t.trucks.departed >= 8, `the door must be freed when the vehicles have taken what they can: ${t.trucks.arrived} trucks arrived, ${t.trucks.departed} left, ${t.gateQueue.now} wait at the gate`);
});

defect('M1-SIM-REV-1b', 'the last truck of a timetable keeps its door all night when its pallets do not fill the last batch of the flow', () => {
  const layout = microLine({
    inbound: { doors: 2, checkIn: 0, checkOut: 0, mode: 'schedule', schedule: [{ at: 600, pallets: 6 }, { at: 1200, pallets: 6 }, { at: 1800, pallets: 6 }] },
    storage: false, flows: [['A', 'C', { batchMin: 4 }]], fleet: { count: 2, capacity: 4 }, calendar: { startTod: 0 }, settings: { dt: 0.25 },
  });
  const sim = new Simulation(layout, { seed: 1 });
  sim.advance(4 * 3600);
  const t = sim.kpis().ops.trucks.s1;
  assert.equal(t.trucks.departed, 3, `all three trucks must leave: ${t.trucks.departed} left, the last one still holds its door after 4 h (${t.doorsBusyNow} doors busy)`);
});

defect('M1-SIM-REV-2', 'a Goods out truck whose plan is not a multiple of the flow batch never fills: with maxDwell 0 no truck ever leaves, with maxDwell 1 h every truck leaves short with the storage full of pallets', () => {
  const plant = (maxDwell) => microLine({
    aParams: { interArrival: K(30) }, outbound: { doors: 1, checkIn: 0, checkOut: 0, interArrival: K(900), pallets: K(22), staging: 0, maxDwell },
    flows: [['A', 'S'], ['S', 'C', { batchMin: 4 }]], fleet: { count: 3, capacity: 4 }, settings: { dt: 0.25 },
  });
  const run = (maxDwell) => { const sim = new Simulation(plant(maxDwell), { seed: 1 }); sim.advance(4 * 3600); return sim; };
  const forever = run(0).kpis().ops.trucks.s3;
  assert.ok(forever.trucks.departed >= 3, `maxDwell 0 means until full, and the pallets are there: ${forever.trucks.arrived} trucks arrived, ${forever.trucks.departed} left`);
  const sim = run(3600);
  const hour = sim.kpis().ops.trucks.s3;
  assert.equal(hour.trucks.short, 0, `the storage holds ${sim.stations.find((s) => s.id === 's2').held} pallets, yet ${hour.trucks.short} of ${hour.trucks.departed} trucks left short (outbound-short blames the vehicles)`);
});

defect('M1-SIM-REV-3', 'the older `supply` rule calls a healthy truck plant overloaded: "Goods in delivers more than the plant takes" while no truck ever waits and every truck leaves full', () => {
  const falsePositives = [];
  for (const seed of HEAVY ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : [7]) {
    const layout = microLine({
      inbound: { doors: 2, checkIn: 300, checkOut: 300, interArrival: { kind: 'normal', mean: 3600, spread: 0.2 }, pallets: K(24) },
      outbound: { doors: 2, checkIn: 300, checkOut: 300, interArrival: K(3600), pallets: K(24), staging: 12, maxDwell: 3600 }, fleet: { count: 1 }, settings: { warmup: 600 },
    });
    const sim = new Simulation(layout, { seed });
    sim.advance(8 * 3600);
    const report = sim.kpis();
    const a = report.ops.trucks.s1; const c = report.ops.trucks.s3;
    // the plant is healthy by every measure of the trucks
    assert.ok(a.gateQueue.max === 0 && c.trucks.short === 0 && a.doorTime.mean < 3600 && a.doorUtilization < 0.6, `seed ${seed}: the plant is healthy`);
    if (sim.insights(report).some((i) => i.id === 'supply:s1')) falsePositives.push(seed);
  }
  assert.deepEqual(falsePositives, [], 'seeds on which a healthy plant is told to slow its supply down');
});

defect('M1-SIM-REV-4', 'in a timetable the pallets distribution shares one random stream with the no-shows and the jitter: changing only the KIND of the pallets distribution moves later appointments and turns another truck into the no-show (rate mode has a stream of its own)', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ at: 600 + i * 900, pallets: i % 2 ? null : 10 }));
  const list = (pallets) => {
    const layout = microLine({ inbound: { doors: 32, checkIn: 0, checkOut: 0, mode: 'schedule', schedule: rows, jitter: 120, noShow: 0.2, pallets }, fleet: null, calendar: { startTod: 0 }, settings: { dt: 0.5 } });
    const sim = new Simulation(layout, { seed: 4 });
    const out = [];
    sim.on('truckArrived', (p) => out.push(`${p.at.toFixed(1)}`));
    sim.on('truckNoShow', (p) => out.push(`no-show ${p.at.toFixed(0)}`));
    sim.advance(12000);
    return out.join(' ');
  };
  const reference = list(K(10));
  assert.equal(list({ kind: 'uniform', mean: 10, spread: 0.5 }), reference, 'appointments and no-shows must not depend on how the pallets of the open rows are drawn');
});
