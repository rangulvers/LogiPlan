// Adversarial integration review of the simulation stack: js/sim/engine.js, js/sim/experiments.js, the tuned js/model/examples.js
// and tests/helpers/sim-invariants.js, together with the graph, traffic, logistics, stats and insights modules underneath.
//
// Nothing here trusts the builder's own checker: tests/helpers/engine-review-gen.js re-derives conservation, overlap, capacity and
// KPI figures from the public state of a running Simulation. Heavy loops run on worker threads (runParallel). The file takes about
// 110 s on four idle cores (it is a review, not a unit test): ENG_REVIEW_QUICK=1 shrinks the loops for a quick look while fixing.
//
// Two kinds of tests:
//   ENG-<AREA>-<n>      guards: behaviour that holds and must keep holding;
//   ENG-<n>             one regression test per REAL defect found by the review. They failed until the fix pass; each says what was wrong,
//                       what a planner would see and where the cause was. Two defects are rooted in modules the fix pass could not touch
//                       (traffic.js and validate.js): their tests are marked `todo` and say who has to fix what; they pass as soon as
//                       that is done (remove the todo then).
//
// Defects (severity: high = wrong numbers, collisions, crashes, stuck simulation, leaks, blocked event loop; medium = misleading KPIs,
// tips that do not reproduce; low = polish):
//   ENG-1  high         the first dispatch round ran one full graph search per vehicle and per dock of every flow in a single tick:
//                       0.2 s on a 120 x 100 plant, 2-4 s at 160 x 160, 18 s with 120 vehicles; advance() cannot interrupt a tick, so
//                       Play and runSimulation froze the page (the spec says never more than ~30 ms). Fixed: reachability is answered
//                       without searching (RouteCache.canReach), the searches left are limited per tick (RouteCache budget; vehicles
//                       wait a few ticks for theirs), advance() reads the clock after every tick when ticks are slow, runSimulation
//                       yields after building the simulation.
//   ENG-2  medium       vehicles were spread over ALL road cells at start, also over a region that can be entered but never left; the
//                       plant then delivered nothing. Fixed in vehicles.js (startRegion). The validator still says nothing: ENG-2b (todo).
//   ENG-3  medium       vehicles that "make room" were sent to any reachable cell, also one they can never leave again. Fixed in idle.js.
//   ENG-4  medium       one standing deadlock was counted again every time traffic lost track of it: 6 for one jam of three vehicles,
//                       while sim.deadlocks (which merged them) said 1. Fixed in engine.js and stats.js; the cause (traffic.js forgets
//                       the jam and re-reports it) is still there, see the report of the fix pass.
//   ENG-5  medium       fleets[].distance left out all driving to depots, chargers and waiting cells (40 % of the odometer in the examples).
//   ENG-6  low/medium   a vehicle held back at a free speed of 0.05 m/s or less (speed factor 0.05, a crawling fleet, a slow zone) is never
//                       flagged as waiting: wait share 0 % in a standing queue, deadlocks between such vehicles are never detected.
//                       Rooted in traffic.js (_bookkeep): todo.
//   ENG-7  medium       three tips printed with the examples had been verified over two simulated hours; at the default run length of 8 h
//                       they were wrong. The tips now quote the 8-hour figures; ENG-7a..e check each of them.
//   ENG-8  low          listSweepParameters: the factor parameters offered a range that excluded the current value.
//   ENG-9  low          advance(): "any positive request advances at least one tick" was not true below dt * 1e-6. Now documented: that
//                       tolerance absorbs the rounding of summed clocks, so the test asserts the documented behaviour.
//   ENG-10 low          setRuntime({ demandFactor }) before the first arrival also scaled the source's startDelay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import v8 from 'node:v8';
import vm from 'node:vm';
import { Simulation, DEADLOCK_HISTORY } from '../js/sim/engine.js';
import { runSimulation, runReplications, sweep, compareScenarios, listSweepParameters, summarizeReport } from '../js/sim/experiments.js';
import { EXAMPLES as ALL_EXAMPLES } from '../js/model/examples.js';
import { legacyExamples } from './helpers/golden.js';
import * as L from '../js/model/layout.js';
import { validateLayout } from '../js/model/validate.js';
import { SERIES_MAX_POINTS } from '../js/sim/stats.js';
import { createRng } from '../js/util/rng.js';
import {
  blockPlant, bridgePlant, createAuditor, emptyRoad, fingerprint, hostilePlant, jamPlant, runParallel, tuggerTwoLines,
} from './helpers/engine-review-gen.js';

/** ENG_REVIEW_QUICK=1 shrinks the loops (fewer seeds and plants) for a quick look while working on a fix; the default is the full review. */
const QUICK = process.env.ENG_REVIEW_QUICK === '1';
const scale = (full, quick) => (QUICK ? quick : full);

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, a.length - 1)); };
const sha = (text) => crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
/** This review attacks the engine with the three legacy plants (supply napkin checks, tips): the warehouse examples have trucks and their own tests (sim.examples.warehouse.test.js, sim.integration.test.js). */
const EXAMPLES = legacyExamples(ALL_EXAMPLES);
const example = (id) => EXAMPLES.find((e) => e.id === id).build();
const unitsNear = (a, b, tol) => Math.abs(a - b) <= tol * Math.max(1e-9, Math.abs(b));

/**
 * The longest time the event loop was blocked while `fn` ran (a 2 ms timer measures the gaps). The gap is the CPU time this thread used between two ticks
 * where Node offers it (process.threadCpuUsage): a machine under load (a neighbour on the cores, other test processes) deschedules the process, which
 * stretches the WALL clock gap without any code having blocked the loop (ENG-LOOP-1 failed once at a load average of 8 with a 156 ms gap, 6 ms over the
 * bound). Without it the wall clock is used, and the best of several runs (calmestStall) has to carry the noise.
 */
async function longestStall(fn) {
  const threadMillis = typeof process.threadCpuUsage === 'function' ? () => { const u = process.threadCpuUsage(); return (u.user + u.system) / 1000; } : null;
  const clock = threadMillis || (() => performance.now());
  let last = clock();
  let worst = 0;
  let ticks = 0;
  const timer = setInterval(() => {
    const now = clock();
    worst = Math.max(worst, now - last);
    last = now;
    ticks++;
  }, 2);
  try {
    await fn();
  } finally {
    clearInterval(timer);
  }
  return { worst, ticks };
}

// ---------------------------------------------------------------------------------------------------------------------------
// (1) The examples, 8 simulated hours, 10 seeds: do the numbers survive a planner's napkin?
// ---------------------------------------------------------------------------------------------------------------------------

/** Loads that leave the plant per product that leaves it (what the final workstation consumes): the supply is this many times the output. */
const LOADS_PER_PRODUCT = { starter: 1, 'two-lines': 3, 'congestion-lab': 2 };

test('ENG-KPI-1: each example, 8 simulated hours, 10 seeds (3 in quick mode): output, capacity, lead-time floor, distance, trips and loads all hang together', async (t) => {
  const jobs = [];
  for (const e of EXAMPLES) for (let seed = 1; seed <= scale(10, 3); seed++) jobs.push({ id: e.id, seed, hours: 8 });
  const results = await runParallel('handCheck', jobs);
  assert.deepEqual(results.flatMap((r) => r.problems), []);
  for (const e of EXAMPLES) {
    const facts = results.filter((r) => r.facts.id === e.id).map((r) => r.facts);
    const perHour = facts.map((f) => f.perHour);
    // a plant that is not overloaded delivers what it is fed: output x loads per product = supply, within the noise of the arrivals
    for (const f of facts) {
      assert.ok(unitsNear(f.perHour * LOADS_PER_PRODUCT[e.id], f.supplyPerHour, 0.08), `${e.id}/${f.seed}: ${f.perHour.toFixed(2)}/h x ${LOADS_PER_PRODUCT[e.id]} vs supply ${f.supplyPerHour.toFixed(2)}/h`);
    }
    assert.ok(sd(perHour) < 0.05 * mean(perHour), `${e.id}: throughput varies too much between seeds (${perHour.map((x) => x.toFixed(1))})`);
    t.diagnostic(`${e.id}: ${mean(perHour).toFixed(2)} loads/h (sd ${sd(perHour).toFixed(2)}), lead time min ${mean(facts.map((f) => f.leadMin)).toFixed(0)} s, mean ${mean(facts.map((f) => f.leadMean)).toFixed(0)} s`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// (2) Conservation, overlap, capacity, NaN: hundreds of hostile plants, an independent checker after every tick
// ---------------------------------------------------------------------------------------------------------------------------

test('ENG-FUZZ-1: 120 hostile plants (dead ends, no docks, islands, 1x1 stations, empty fleets, batteries without charger, crawlers, huge demand ...): every invariant after every tick', async (t) => {
  const results = await runParallel('fuzz', Array.from({ length: scale(120, 40) }, (_, i) => ({ seed: i + 1, seconds: 420 })));
  assert.deepEqual(results.filter((r) => r.violations.length > 0).map((r) => `${r.name}: ${r.violations.join(' | ')}`), []);
  const working = results.filter((r) => r.completed > 0).length;
  const withVehicles = results.filter((r) => r.vehicles > 0).length;
  t.diagnostic(`${results.length} plants, ${withVehicles} with vehicles, ${working} delivered something within 7 minutes`);
  assert.ok(working >= scale(15, 5), `only ${working} of the plants did any work: the generator is no longer a useful fuzzer`);
});

test('ENG-FUZZ-2: the examples with half and four times the vehicles and three times the demand: invariants hold and no vehicle stands still for ten minutes', async () => {
  const jobs = [];
  for (const e of EXAMPLES) for (const fleetFactor of [0.5, 4]) for (const demand of [1, 3]) jobs.push({ id: e.id, fleetFactor, demand, seconds: 900, seed: 3 });
  const results = await runParallel('scaled', jobs);
  assert.deepEqual(results.filter((r) => r.violations.length > 0).map((r) => `${r.id} x${r.fleetFactor} demand ${r.demand}: ${r.violations.join(' | ')}`), []);
  assert.deepEqual(results.filter((r) => r.stuck.length > 0).map((r) => `${r.id} x${r.fleetFactor} demand ${r.demand}: ${r.stuck.join(' | ')}`), []);
  for (const r of results) assert.ok(r.completed > 0, `${r.id} x${r.fleetFactor} demand ${r.demand} delivered nothing in 15 minutes`);
});

test('ENG-AUDIT-1: the independent checker has teeth - every planted fault is reported', () => {
  /** A busy plant after 20 minutes, with the auditor attached from the first tick on (its event ledger needs that). */
  const busyPlant = () => {
    const sim = new Simulation(example('congestion-lab'), { seed: 2 });
    const auditor = createAuditor(sim);
    for (let i = 0; i < Math.round(1200 / sim.dt); i++) {
      sim.step();
      const found = auditor.tick(500);
      if (found.length > 0) assert.fail(`a healthy plant passes: ${found}`);
    }
    return { sim, auditor };
  };
  const onRoad = (sim) => sim.vehicles.filter((v) => v.tv.onRoad);
  const queueOf = (sim, skip = null) => sim.stations.flatMap((s) => s.outLinks.map((l) => l.queue)).find((q) => q.length > 0 && q !== skip);
  /** Step once more, plant the fault, and return everything the auditor reports about that moment. */
  const audit = (sabotage) => {
    const { sim, auditor } = busyPlant();
    sim.step();
    assert.deepEqual(auditor.tick(1), [], 'a healthy plant passes the thorough check too');
    sim.step();
    sabotage(sim);
    return auditor.tick(1);
  };
  const expectFault = (pattern, sabotage) => {
    const messages = audit(sabotage);
    assert.ok(messages.some((m) => pattern.test(m)), `expected ${pattern}, got ${JSON.stringify(messages)}`);
  };
  expectFault(/overlap/, (sim) => {
    const [a, b] = onRoad(sim);
    Object.assign(b.tv, { x: a.tv.x, y: a.tv.y, heading: a.tv.heading });
  });
  expectFault(/NaN/, (sim) => { onRoad(sim)[0].tv.x = NaN; });
  expectFault(/left the road network/, (sim) => { Object.assign(onRoad(sim)[0].tv, { x: 1, y: 1 }); });
  expectFault(/live loads|conservation/, (sim) => { assert.ok(queueOf(sim), 'some queue holds a load'); queueOf(sim).pop(); });
  expectFault(/found twice/, (sim) => {
    const first = queueOf(sim);
    const second = sim.stations.flatMap((s) => s.outLinks.map((l) => l.queue)).find((q) => q !== first);
    second.push(first[0]);
  });
  expectFault(/output buffer/, (sim) => {
    const source = sim.stations.find((s) => s.type === 'source');
    const link = source.outLinks[0];
    for (let n = 0; link.queue.length <= link.cap; n++) link.queue.push({ id: -1000 - n, createdAt: 0, origin: source.id, readyAt: 0, claimed: false });
  });
  expectFault(/battery/, (sim) => { onRoad(sim)[0].battery = 1.5; });
  expectFault(/speed/, (sim) => { onRoad(sim)[0].tv.v = 99; });
  {
    const { sim } = busyPlant();
    const report = sim.kpis();
    report.fleets[Object.keys(report.fleets)[0]].shares.driving += 0.3;
    report.traffic.waitShare = NaN;
    const found = createAuditor(sim).report(report);
    assert.ok(found.some((m) => /shares sum/.test(m)) && found.some((m) => /waitShare/.test(m)), `report faults: ${JSON.stringify(found)}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// (3) Determinism: across runs, across processes and compilers, and independent of how advance() is called
// ---------------------------------------------------------------------------------------------------------------------------

test('ENG-DET-1: the same layout and seed give a bit-identical state - in a second run, in other processes, with and without the optimising compiler', () => {
  const hours = 0.25;
  const here = EXAMPLES.map((e) => {
    const sim = new Simulation(e.build(), { seed: 7 });
    sim.advance(hours * 3600);
    const again = new Simulation(e.build(), { seed: 7 });
    again.advance(hours * 3600);
    const other = new Simulation(e.build(), { seed: 8 });
    other.advance(hours * 3600);
    const digest = sha(fingerprint(sim));
    assert.equal(sha(fingerprint(again)), digest, `${e.id}: a second run in this process differs`);
    assert.notEqual(sha(fingerprint(other)), digest, `${e.id}: another seed gives the same run`);
    return `${e.id} ${digest}`;
  });
  const url = (path) => JSON.stringify(new URL(path, import.meta.url).href);
  const script = [
    `import { Simulation } from ${url('../js/sim/engine.js')};`,
    `import { EXAMPLES } from ${url('../js/model/examples.js')};`,
    `import { fingerprint } from ${url('./helpers/engine-review-gen.js')};`,
    `import crypto from 'node:crypto';`,
    `for (const e of EXAMPLES.filter((x) => ${JSON.stringify(EXAMPLES.map((x) => x.id))}.includes(x.id))) { const sim = new Simulation(e.build(), { seed: 7 }); sim.advance(${hours * 3600}); console.log(e.id + ' ' + crypto.createHash('sha1').update(fingerprint(sim)).digest('hex').slice(0, 16)); }`,
  ].join('\n');
  for (const flags of [[], ['--jitless'], ['--no-opt']]) {
    const child = spawnSync(process.execPath, [...flags, '--input-type=module', '-e', script], { encoding: 'utf8' });
    assert.equal(child.status, 0, `child ${flags.join(' ')} failed: ${child.stderr}`);
    assert.deepEqual(child.stdout.trim().split('\n'), here, `child process ${flags.join(' ') || '(default)'} differs from this process`);
  }
});

test('ENG-DET-2: the state does not depend on how a run is cut into advance() calls, budgets or tiny and huge requests', () => {
  const plants = [...EXAMPLES.map((e) => [e.id, e.build()]), ...[3, 7, 19, 28].map((s) => [`hostile ${s}`, hostilePlant(s)])];
  for (const [name, layout] of plants) {
    const reference = new Simulation(layout, { seed: 4 });
    reference.advance(2400);
    const sim = new Simulation(layout, { seed: 4 });
    const rng = createRng(11);
    let clock = 0;
    const fakeNow = () => (clock += 7);
    while (sim.time < reference.time - sim.dt * 1e-6) {
      const want = Math.min(Math.max(1e-3, rng.next() * rng.pick([0.3, 2, 40, 500])), reference.time - sim.time);
      sim.advance(want, rng.next() < 0.5 ? { maxMillis: 1, now: fakeNow } : {});
    }
    assert.equal(sim.time, reference.time, `${name}: the clock`);
    assert.equal(fingerprint(sim), fingerprint(reference), `${name}: chunked and unchunked runs differ`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// (4) setRuntime during a run
// ---------------------------------------------------------------------------------------------------------------------------

test('ENG-RT-1: vehicle speed swinging between x0.05 and x20 every few seconds: no overlap, NaN, lost load or stuck vehicle - and the plant recovers', async () => {
  const jobs = [
    ...EXAMPLES.map((e, i) => ({ example: e.id, seed: 1, seconds: 2400, mode: 'speed', rngSeed: 10 + i })),
    ...Array.from({ length: scale(16, 6) }, (_, i) => ({ seed: i + 1, seconds: 600, mode: 'speed', rngSeed: 100 + i })),
  ];
  const results = await runParallel('runtime', jobs);
  assert.deepEqual(results.filter((r) => r.violations.length > 0).map((r) => `${r.example ?? `hostile ${r.seed}`}: ${r.violations.join(' | ')}`), []);
  for (const r of results.filter((x) => x.example)) {
    assert.equal(r.speedFactor, 1, `${r.example}: the factor is back at 1`);
    assert.deepEqual(r.stuck, [], `${r.example}: vehicles still stand still after the speed is back at x1`);
    assert.ok(r.deliveredAfterStorm >= 0.5 * r.controlDelivered - 1, `${r.example}: delivered ${r.deliveredAfterStorm} in the 20 calm minutes after the storm, an undisturbed run ${r.controlDelivered}`);
  }
});

test('ENG-RT-2: every what-if setting (speed, demand, process time, dispatch, routing) switched at random: invariants hold on examples and hostile plants', async () => {
  const jobs = [
    ...EXAMPLES.map((e, i) => ({ example: e.id, seed: 2, seconds: 2400, mode: 'all', rngSeed: 20 + i })),
    ...Array.from({ length: scale(16, 6) }, (_, i) => ({ seed: 50 + i, seconds: 600, mode: 'all', rngSeed: 200 + i })),
  ];
  const results = await runParallel('runtime', jobs);
  assert.deepEqual(results.filter((r) => r.violations.length > 0).map((r) => `${r.example ?? `hostile ${r.seed}`}: ${r.violations.join(' | ')}`), []);
});

test('ENG-RT-3: setRuntime takes effect at once: x0.05 caps every speed within seconds, x1 restores it, a bad value changes nothing', () => {
  const sim = new Simulation(example('two-lines'), { seed: 3 });
  const auditor = createAuditor(sim);
  const problems = [];
  const run = (seconds) => {
    for (let i = 0; i < Math.round(seconds / sim.dt); i++) {
      sim.step();
      problems.push(...auditor.tick(20));
    }
  };
  const onRoad = () => sim.vehicles.filter((v) => v.tv.onRoad);
  const untilDriving = () => { for (let i = 0; i < 600 && !onRoad().some((v) => v.tv.v > 0.5); i++) run(1); };
  run(600);
  untilDriving();
  assert.ok(onRoad().some((v) => v.tv.v > 0.5), 'vehicles drive at normal speed');
  sim.setRuntime({ speedFactor: 0.05 });
  run(8);
  for (const v of onRoad()) assert.ok(v.tv.v <= v.tv.vmax * 0.05 + 1e-9, `${v.id} drives ${v.tv.v} m/s at x0.05`);
  sim.setRuntime({ speedFactor: NaN, demandFactor: 'fast', dispatch: 'teleport' });
  assert.equal(sim.settings.speedFactor, 0.05);
  run(60);
  sim.setRuntime({ speedFactor: 1 });
  untilDriving();
  assert.ok(onRoad().some((v) => v.tv.v > 0.5), 'back to normal speed');
  run(300);
  assert.deepEqual(problems.slice(0, 5), []);
});

// ---------------------------------------------------------------------------------------------------------------------------
// (5) Deadlocks end to end
// ---------------------------------------------------------------------------------------------------------------------------

/** Seeds of the jam plant that deadlock within 50 minutes when the jam is left standing (11 of 12 seeds do so within two hours). */
const JAM_SEEDS = scale([1, 2, 5, 8], [1, 2]);

test('ENG-DL-1: a plant engineered to deadlock, policy "ignore": detected once, reported unresolved, counted everywhere, and the plant really stands still', () => {
  for (const seed of JAM_SEEDS) {
    const sim = new Simulation(jamPlant('ignore'), { seed });
    const events = [];
    sim.on('deadlock', (d) => events.push(d));
    const auditor = createAuditor(sim);
    const audited = seed === 1; // the checker costs more than the plant: one seed is enough to cover the jam itself
    const violations = new Set();
    const steps = Math.round(7200 / sim.dt);
    let completedAtOneHour = 0;
    for (let i = 1; i <= steps; i++) {
      sim.step();
      if (audited) for (const m of auditor.tick(40)) violations.add(m);
      if (i === Math.round(3600 / sim.dt)) completedAtOneHour = sim.logistics.completed;
    }
    assert.deepEqual([...violations], [], `seed ${seed}`);
    assert.ok(events.length >= 1, `seed ${seed}: no deadlock was detected`);
    assert.ok(events.every((e) => e.resolved === false && e.victim === null), `seed ${seed}: with 'ignore' nobody is relocated`);
    assert.equal(events.length, 1, `seed ${seed}: one jam, ${events.length} reports`);
    const [d] = events;
    assert.ok(d.vehicles.length >= 2 && d.nodes.length >= 1 && d.t > 0);
    const report = sim.kpis();
    assert.equal(report.traffic.deadlocks, events.length);
    assert.equal(report.traffic.deadlockEvents.length, events.length);
    assert.equal(sim.deadlocks.length, events.length);
    assert.ok(sim.traffic.activeDeadlocks.length >= 1, `seed ${seed}: the jam is still standing`);
    assert.equal(sim.logistics.completed, completedAtOneHour, `seed ${seed}: the jam stands, so nothing is delivered between hour 1 and 2`);
    const critical = sim.insights(report).find((i) => i.id === 'deadlocks');
    assert.equal(critical && critical.severity, 'critical', `seed ${seed}: the Results tab must call an unresolved deadlock critical`);
  }
});

test('ENG-DL-2: the same plant, policy "resolve": every jam is relocated away, counted, and the plant keeps delivering at the normal rate hour after hour', () => {
  for (const seed of JAM_SEEDS) {
    const sim = new Simulation(jamPlant('resolve'), { seed });
    const events = [];
    sim.on('deadlock', (d) => events.push(d));
    const auditor = createAuditor(sim);
    const violations = new Set();
    const perHour = [];
    for (let hour = 1; hour <= 4; hour++) {
      const before = sim.logistics.completed;
      const steps = Math.round(3600 / sim.dt);
      for (let i = 1; i <= steps; i++) {
        sim.step();
        if (hour <= 2 && seed === 1) for (const m of auditor.tick(40)) violations.add(m);
      }
      perHour.push(sim.logistics.completed - before);
    }
    assert.deepEqual([...violations], [], `seed ${seed}: relocation must not break conservation, orders or poses`);
    assert.ok(events.length >= 1, `seed ${seed}: the plant should have deadlocked`);
    assert.ok(events.every((e) => e.resolved === true && e.victim !== null && e.vehicles.includes(e.victim)), `seed ${seed}: every report names the relocated victim`);
    const report = sim.kpis();
    assert.equal(report.traffic.deadlocks, events.length);
    assert.ok(report.traffic.deadlockEvents.every((e) => e.resolved));
    assert.equal(sim.traffic.activeDeadlocks.length, 0);
    for (let hour = 1; hour < 4; hour++) assert.ok(perHour[hour] >= 80, `seed ${seed}: only ${perHour[hour]} loads in hour ${hour + 1} (${perHour})`);
    const found = sim.insights(report).find((i) => i.id === 'deadlocks');
    assert.equal(found && found.severity, 'warning', `seed ${seed}: resolved deadlocks are a warning, not critical`);
  }
});

test('ENG-4: one standing deadlock is one deadlock - the KPI, the Deadlocks metric, the Results tab, the events and sim.deadlocks agree (they used to count it six times while sim.deadlocks said one)', () => {
  // The Two-lines plant with tugger-length vehicles (3.5 m on 2 m cells, the limit of the traffic engine) and policy "ignore":
  // three vehicles block each other on the junctions in front of the warehouse. The cycle flickers (a vehicle creeps, its wait
  // timer restarts), traffic forgets the jam and reports the same three vehicles anew after the next 20 s.
  for (const seed of [1, 2, 3]) {
    const sim = new Simulation(tuggerTwoLines('ignore'), { seed });
    const events = [];
    sim.on('deadlock', (d) => events.push(d));
    sim.advance(4 * 3600);
    const jams = new Set(events.map((e) => e.vehicles.slice().sort().join(',')));
    const report = sim.kpis();
    assert.ok(events.length >= 1, `seed ${seed}: the plant should jam`);
    assert.equal(events.length, jams.size, `seed ${seed}: ${events.length} reports for ${jams.size} different jams (${[...jams].join(' / ')})`);
    assert.equal(report.traffic.deadlocks, sim.deadlocks.length, `seed ${seed}: the KPI counts ${report.traffic.deadlocks} deadlocks, the engine's own list ${sim.deadlocks.length}`);
    assert.equal(summarizeReport(report).deadlocks, jams.size, `seed ${seed}: the Deadlocks metric of the Experiments tab`);
    const insight = sim.insights(report).find((i) => i.id === 'deadlocks');
    const times = Number((/(\d+) times/.exec(insight.title) || [, 1])[1]);
    assert.equal(times, jams.size, `seed ${seed}: the Results tab says "${insight.title}" about a single standing jam`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// (6) Experiments: abort, progress, yielding, seeds, consistency with direct runs, sweep parameters
// ---------------------------------------------------------------------------------------------------------------------------

test('ENG-EXP-1: runSimulation reports progress from 0 to exactly 1, yields to timers, and an abort rejects within a blink - also from inside a progress callback', async () => {
  const layout = example('two-lines');
  const progress = [];
  const { ticks } = await longestStall(() => runSimulation(layout, { duration: 3600, warmup: 600, seed: 1, yieldEveryMs: 10, onProgress: (p) => progress.push(p) }));
  assert.equal(progress[0].fraction, 0);
  assert.equal(progress[0].simTime, 0);
  assert.equal(progress.at(-1).fraction, 1);
  for (let i = 1; i < progress.length; i++) {
    assert.ok(progress[i].fraction >= progress[i - 1].fraction && progress[i].simTime >= progress[i - 1].simTime, 'progress never goes backwards');
    assert.ok(progress[i].fraction >= 0 && progress[i].fraction <= 1);
  }
  assert.ok(progress.length >= 5 && ticks >= 5, `a one-hour run must be cut into slices (${progress.length} progress reports, ${ticks} timer ticks)`);

  const controller = new AbortController();
  let abortedAt = 0;
  const started = performance.now();
  await assert.rejects(
    runSimulation(layout, {
      duration: 8 * 3600, seed: 1, signal: controller.signal, yieldEveryMs: 10,
      onProgress: (p) => { if (p.fraction > 0.05 && abortedAt === 0) { abortedAt = performance.now(); controller.abort(); } },
    }),
    (error) => error.name === 'AbortError',
  );
  const lag = performance.now() - abortedAt;
  assert.ok(abortedAt > 0 && lag < 250, `the abort took ${lag.toFixed(0)} ms to end the run`);
  assert.ok(performance.now() - started < 8000, 'an aborted 8-hour run must not run to its end');

  const late = new AbortController();
  late.abort();
  let called = 0;
  await assert.rejects(runSimulation(layout, { duration: 3600, signal: late.signal, onProgress: () => { called++; } }), { name: 'AbortError' });
  assert.equal(called, 0, 'an already aborted run does no work at all');

  const timed = new AbortController();
  setTimeout(() => timed.abort(), 50);
  await assert.rejects(runReplications(layout, { replications: 3, duration: 8 * 3600, signal: timed.signal }), { name: 'AbortError' });
});

test('ENG-EXP-2: replication r uses seed0 + r (wrapped to 32 bits), each run equals a direct run with that seed, and the replications really differ', async () => {
  const layout = example('congestion-lab');
  for (const seed0 of [1, 4294967295, -3, 7.9]) {
    const out = await runReplications(layout, { replications: 3, seed0, duration: 1800, warmup: 300 });
    const expected = [0, 1, 2].map((r) => (Math.trunc(seed0) + r) >>> 0);
    assert.deepEqual(out.seeds, expected, `seed0 ${seed0}`);
    for (let r = 0; r < 3; r++) {
      const direct = await runSimulation(layout, { duration: 1800, warmup: 300, seed: expected[r] });
      assert.deepEqual(out.runs[r], direct, `seed0 ${seed0} replication ${r}`);
    }
    assert.notEqual(JSON.stringify(out.runs[0]), JSON.stringify(out.runs[1]), 'consecutive seeds give different runs');
  }
  const settingsSeed = example('starter');
  settingsSeed.settings.seed = 41;
  const fromSettings = await runReplications(settingsSeed, { replications: 2, duration: 900, warmup: 0 });
  assert.deepEqual(fromSettings.seeds, [41, 42], 'without seed0 the layout\'s own seed is the first');
  const one = await runReplications(settingsSeed, { replications: 1, duration: 900, warmup: 0 });
  assert.equal(one.summary.throughput.sd, 0);
  assert.equal(one.summary.throughput.n, 1);
  await assert.rejects(runReplications(settingsSeed, { replications: 0 }), RangeError);
  await assert.rejects(runReplications(settingsSeed, { replications: 2.5 }), RangeError);
  await assert.rejects(runSimulation(settingsSeed, { duration: -5 }), RangeError);
  await assert.rejects(runSimulation(settingsSeed, { duration: 600, warmup: -1 }), RangeError);
  await assert.rejects(runSimulation(null, { duration: 600 }), TypeError);
});

test('ENG-EXP-3: sweep and compareScenarios equal direct runs of the modified layouts, in every number, and call apply() on copies only', async () => {
  const layout = example('congestion-lab');
  const before = structuredClone(layout);
  const params = listSweepParameters(layout);
  const count = params.find((p) => /\.count$/.test(p.key));
  const opts = { replications: 2, seed0: 5, duration: 1500, warmup: 300 };
  const labels = [];
  const swept = await sweep(layout, count, [4, 9], { ...opts, onProgress: (p) => labels.push(p.label) });
  assert.deepEqual(layout, before, 'sweep must not touch the layout it was given');
  for (const [i, value] of [4, 9].entries()) {
    const direct = await runReplications(count.apply(layout, value), opts);
    assert.equal(swept[i].value, value);
    assert.deepEqual(swept[i].runs, direct.runs);
    assert.deepEqual(swept[i].summary, direct.summary);
  }
  assert.ok(labels.some((l) => l.includes(count.label) && l.includes('= 4')) && labels.some((l) => l.includes('= 9')), `labels: ${[...new Set(labels)]}`);
  const byKey = await sweep(layout, count.key, [4], opts);
  assert.deepEqual(byKey[0].runs, swept[0].runs);

  const scenarios = [{ id: 'a', name: 'Nine AGVs', layout }, { id: 'b', name: 'Six AGVs', layout: count.apply(layout, 6) }];
  const compared = await compareScenarios(scenarios, opts);
  assert.deepEqual(compared.map((c) => [c.id, c.name]), [['a', 'Nine AGVs'], ['b', 'Six AGVs']]);
  assert.deepEqual(compared[0].runs, (await runReplications(layout, opts)).runs);
  assert.deepEqual(compared[1].runs, (await runReplications(scenarios[1].layout, opts)).runs);
  assert.deepEqual(layout, before);
  assert.ok(compared[1].summary.waitShare.mean < compared[0].summary.waitShare.mean, 'six AGVs wait less than nine in the congestion lab');
});

test('ENG-EXP-4: every sweep parameter of every example and of 12 hostile plants produces valid, canonical layouts that read back and simulate', () => {
  const plants = [...EXAMPLES.map((e) => [e.id, e.build()]), ...Array.from({ length: scale(12, 4) }, (_, i) => [`hostile ${i + 1}`, hostilePlant(i + 1)])]
    .filter(([, layout]) => !layout.stations.some((s) => s.type === 'source' && s.params.batch >= 20 && s.params.interArrival.mean <= 1));
  let applied = 0;
  for (const [name, layout] of plants) {
    const snapshot = structuredClone(layout);
    const errorsBefore = validateLayout(layout).filter((i) => i.severity === 'error').length;
    for (const p of listSweepParameters(layout)) {
      const label = `${name} / ${p.key}`;
      assert.ok(p.min <= p.max && p.step > 0 && p.values.length > 0 && p.label && typeof p.unit === 'string', `${label}: descriptor`);
      const current = p.get(layout);
      assert.ok(Number.isFinite(current), `${label}: get()`);
      for (const value of new Set([p.min, p.max, ...p.values])) {
        const next = p.apply(layout, value);
        applied++;
        assert.deepEqual(L.checkInvariants(next), [], `${label} = ${value}: invalid layout`);
        assert.deepEqual(L.normalizeLayout(next), next, `${label} = ${value}: apply() must return a canonical layout`);
        assert.ok(unitsNear(p.get(next), value, 1e-6), `${label}: set ${value}, read back ${p.get(next)}`);
        const errors = validateLayout(next).filter((i) => i.severity === 'error').length;
        assert.ok(errors <= errorsBefore || (/\.count$/.test(p.key) && value === 0), `${label} = ${value}: the variant has new validation errors`);
        if (value === p.min || value === p.max) {
          const sim = new Simulation(next, { seed: 1 });
          sim.advance(60);
          assert.deepEqual(createAuditor(sim).report(), [], `${label} = ${value}`);
        }
      }
    }
    assert.deepEqual(layout, snapshot, `${name}: listSweepParameters / apply() modified the layout`);
  }
  assert.ok(applied > scale(500, 150), `only ${applied} variants were checked`);
});

// ---------------------------------------------------------------------------------------------------------------------------
// (7) Performance and memory
// ---------------------------------------------------------------------------------------------------------------------------

test('ENG-PERF-1: simulated seconds per real second of the three examples (best of three) - report and regression gate', (t) => {
  const floors = { starter: 3000, 'two-lines': 1000, 'congestion-lab': 1000 };
  for (const e of EXAMPLES) {
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const sim = new Simulation(e.build(), { seed: 1 });
      const t0 = performance.now();
      sim.advance(2 * 3600);
      best = Math.min(best, performance.now() - t0);
    }
    const speed = 7200 / (best / 1000);
    t.diagnostic(`${e.id}: ${speed.toFixed(0)}x real time (2 simulated hours in ${best.toFixed(0)} ms)`);
    assert.ok(speed >= floors[e.id], `${e.id} runs at ${speed.toFixed(0)}x, below the gate of ${floors[e.id]}x`);
  }
});

test('ENG-PERF-2: after its first tick a 100 x 80 plant (80 stations, 40 vehicles) still simulates at least 100x real time, and a slice of advance() keeps its budget', (t) => {
  const sim = new Simulation(blockPlant(100, 80, 10, 20, 2), { seed: 1 });
  sim.step(); // the cold start is a defect of its own (ENG-1)
  const t0 = performance.now();
  sim.advance(120);
  const speed = 120 / ((performance.now() - t0) / 1000);
  t.diagnostic(`100 x 80 plant with ${sim.stations.length} stations and ${sim.vehicles.length} vehicles: ${speed.toFixed(0)}x real time`);
  assert.ok(speed >= 100, `${speed.toFixed(0)}x`);
  const slices = [];
  for (let i = 0; i < 15; i++) {
    const a = performance.now();
    sim.advance(1000, { maxMillis: 10 });
    slices.push(performance.now() - a);
  }
  slices.sort((x, y) => x - y);
  assert.ok(slices[7] < 25, `a 10 ms slice takes ${slices[7].toFixed(1)} ms (median)`);
});

test('ENG-MEM-1: 24 simulated hours of every example leave nothing growing but the series: lead-time store, deadlock list, orders, loads and heap stay bounded', () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const heap = () => { gc(); gc(); return process.memoryUsage().heapUsed / 1e6; };
  for (const e of EXAMPLES) {
    const layout = e.build();
    layout.settings.warmup = 600;
    const sim = new Simulation(layout, { seed: 9 });
    sim.advance(8 * 3600);
    const heap8 = heap();
    const orders8 = sim.logistics.activeOrders.size;
    sim.advance(24 * 3600 - sim.time);
    const heap24 = heap();
    const report = sim.kpis();
    const vehicles = sim.vehicles.length;
    assert.ok(report.series.t.length <= SERIES_MAX_POINTS, `${e.id}: ${report.series.t.length} series points`);
    assert.ok(report.series.t.length <= 24 * 60 + 1, `${e.id}: more than one series point per minute`);
    assert.ok(sim.stats.lead.size <= report.leadTime.count, `${e.id}: lead-time samples ${sim.stats.lead.size} for ${report.leadTime.count} loads`);
    assert.ok(sim.deadlocks.length <= DEADLOCK_HISTORY && report.traffic.deadlockEvents.length <= 50, `${e.id}: deadlock lists`);
    assert.ok(sim.logistics.activeOrders.size <= vehicles && orders8 <= vehicles, `${e.id}: ${sim.logistics.activeOrders.size} active orders for ${vehicles} vehicles`);
    assert.ok(sim.logistics.liveLoads < 100, `${e.id}: ${sim.logistics.liveLoads} loads in the plant`);
    assert.ok(heap24 - heap8 < 3, `${e.id}: the heap grew from ${heap8.toFixed(1)} to ${heap24.toFixed(1)} MB between hour 8 and hour 24`);
  }
});

test('ENG-MEM-2: a three-day run keeps its series within the cap, strictly increasing in time, with all five arrays the same length', () => {
  const layout = example('starter');
  layout.settings.warmup = 600;
  const sim = new Simulation(layout, { seed: 1 });
  for (const hours of [24, 48, 72]) {
    sim.advance(hours * 3600 - sim.time);
    const { series, window } = sim.kpis();
    const lengths = [series.t, series.throughput, series.wip, series.vehiclesWorking, series.vehiclesWaiting].map((a) => a.length);
    assert.ok(lengths.every((n) => n === lengths[0]) && lengths[0] <= SERIES_MAX_POINTS, `${hours} h: ${lengths}`);
    assert.ok(series.t.every((x, i) => i === 0 || x > series.t[i - 1]), `${hours} h: series time must increase`);
    assert.ok(series.t.at(-1) <= window.end + 1e-6 && series.t.at(-1) >= window.end - series.interval - 1e-6, `${hours} h: the last point is the latest interval`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
// (8) Cosmetic edits, the time step, insights
// ---------------------------------------------------------------------------------------------------------------------------

test('ENG-COS-1: cosmetic edits (name, notes, labels, obstacles, duration) change nothing in a run - the state stays bit-identical', () => {
  for (const e of EXAMPLES) {
    const base = e.build();
    const reference = new Simulation(base, { seed: 5 });
    reference.advance(1800);
    const digest = fingerprint(reference);
    const edits = {
      name: (l) => { l.name = 'renamed'; },
      notes: (l) => L.setNotes(l, 'new notes '.repeat(20)),
      label: (l) => L.addLabel(l, { x: 1, y: 1, text: 'hello' }),
      obstacle: (l) => { for (let x = 0; x < l.grid.cols; x++) if (L.addObstacle(l, { x, y: 0, w: 1, h: 1, kind: 'wall' })) break; },
      duration: (l) => L.updateSettings(l, { duration: 12345 }),
    };
    for (const [what, edit] of Object.entries(edits)) {
      const edited = structuredClone(base);
      edit(edited);
      assert.equal(L.layoutChangeKind(base, edited), 'cosmetic', `${e.id}: ${what}`);
      const sim = new Simulation(edited, { seed: 5 });
      sim.advance(1800);
      assert.equal(fingerprint(sim), digest, `${e.id}: a cosmetic edit (${what}) changed the run`);
    }
  }
});

test('ENG-DT-1: the time step is a numerical detail: dt 0.5 s gives the same throughput, lead time, utilization and wait share as dt 0.05 s within a few percent (twice as wide in quick mode: one hour of two seeds is noisy)', async () => {
  const jobs = [];
  for (const e of EXAMPLES) for (const dt of [0.05, 0.5]) for (const seed of [1, 2]) jobs.push({ id: e.id, dt, seed, hours: scale(2, 1) });
  const results = await runParallel('dt', jobs);
  EXAMPLES.forEach((e, i) => {
    const pick = (dt, key) => mean(results.slice(i * 4, i * 4 + 4).filter((_, k) => (k < 2) === (dt === 0.05)).map((r) => r[key]));
    for (const key of ['throughput', 'lead', 'utilization']) {
      assert.ok(unitsNear(pick(0.5, key), pick(0.05, key), scale(0.06, 0.12)), `${e.id}: ${key} ${pick(0.05, key).toFixed(3)} at dt 0.05 but ${pick(0.5, key).toFixed(3)} at dt 0.5`);
    }
    assert.ok(Math.abs(pick(0.5, 'waitShare') - pick(0.05, 'waitShare')) < scale(0.03, 0.05), `${e.id}: wait share ${pick(0.05, 'waitShare').toFixed(3)} vs ${pick(0.5, 'waitShare').toFixed(3)}`);
  });
});

test('ENG-INS-1: a plant whose batteries run flat says so - dead vehicles, collapsing output and a critical insight', () => {
  const layout = example('starter');
  L.updateFleet(layout, layout.fleets[0].id, { battery: { enabled: true, runtimeMin: 30, chargeTimeMin: 10, lowPct: 20, resumePct: 80 } });
  L.updateSettings(layout, { warmup: 0 });
  const sim = new Simulation(layout, { seed: 1 });
  const dead = [];
  sim.on('vehicleDead', (e) => dead.push(e.vehicleId));
  sim.advance(4 * 3600);
  const report = sim.kpis();
  const fleet = Object.values(report.fleets)[0];
  assert.equal(dead.length, 2, 'both AGVs run out of battery');
  assert.equal(fleet.minBattery, 0);
  assert.ok(fleet.shares.broken > 0.7, `broken share ${fleet.shares.broken}`);
  assert.ok(report.throughput.perHour < 5, `${report.throughput.perHour} loads/h from a plant without vehicles`);
  const severities = Object.fromEntries(sim.insights(report).map((i) => [i.id, i.severity]));
  assert.equal(severities['battery:v1'], 'critical');
  assert.equal(severities['supply:s1'], 'critical');
});

// ---------------------------------------------------------------------------------------------------------------------------
// (9) The event loop
// ---------------------------------------------------------------------------------------------------------------------------

/** Smallest "longest stall" of three runs: a noisy neighbour on the machine can only make a run worse, never better. */
async function calmestStall(layout, duration) {
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const { worst } = await longestStall(() => runSimulation(layout, { duration, warmup: 0, seed: 1 }));
    best = Math.min(best, worst);
  }
  return best;
}

test('ENG-LOOP-1: running the examples headless never blocks the event loop for long (spec: about 30 ms)', async (t) => {
  for (const e of EXAMPLES) {
    const worst = await calmestStall(e.build(), 3600);
    t.diagnostic(`${e.id}: longest stall ${worst.toFixed(0)} ms`);
    assert.ok(worst < 150, `${e.id}: the event loop was blocked for ${worst.toFixed(0)} ms`);
  }
});

test('ENG-1: a 120 x 100 plant (120 stations, 90 flows, 60 vehicles) does not block the event loop when a run starts - the first dispatch round used to run a graph search per vehicle and per dock in a single tick (0.2 s)', async (t) => {
  const layout = blockPlant(120, 100, 10, 30, 2);
  const worst = await calmestStall(layout, 300);
  t.diagnostic(`longest stall ${worst.toFixed(0)} ms`);
  assert.ok(worst < 80, `runSimulation blocked the event loop for ${worst.toFixed(0)} ms (spec: about 30 ms, slices of 30 ms)`);
});

test('ENG-1b: the largest legal plant (160 x 160 cells, 169 stations, 80 vehicles) used to need seconds for its first tick; it must not freeze the page', () => {
  const sim = new Simulation(blockPlant(160, 160, 12, 40, 2), { seed: 1 });
  const t0 = performance.now();
  sim.step();
  const first = performance.now() - t0;
  assert.ok(first < 1000, `the first tick took ${first.toFixed(0)} ms (the runner's frame budget is 10 ms)`);
});

// ---------------------------------------------------------------------------------------------------------------------------
// (10) More defects
// ---------------------------------------------------------------------------------------------------------------------------

test('ENG-2: vehicles do not start in a region they can enter but never leave (a plant with a one-way bridge used to deliver nothing)', () => {
  const layout = bridgePlant({ vehicles: 3 });
  const sim = new Simulation(layout, { seed: 1 });
  const g = sim.graph;
  const docksOfA = g.docks.get('A');
  const stranded = sim.vehicles.filter((v) => {
    const search = g.search(v.tv.node, {});
    return !docksOfA.some((dock) => dock === v.tv.node || search.dist(dock) < Infinity);
  });
  assert.deepEqual(stranded.map((v) => v.id), [], 'every vehicle must start where it can reach the source it has to serve');
  sim.advance(3600);
  assert.ok(sim.flows[0].delivered > 0, 'nothing was delivered in an hour');
});

test('ENG-2b: validateLayout warns about a road region that vehicles can enter but never leave (it only warns about single dead-end cells)', { todo: 'js/model/validate.js (model owner) needs a check for road regions without a way back, e.g. code road-trap with refs.cells; no change to the simulation is needed' }, () => {
  const issues = validateLayout(bridgePlant({ vehicles: 3 }));
  const trap = issues.filter((i) => i.refs && Array.isArray(i.refs.cells) && i.refs.cells.some(([cx]) => cx >= 10));
  assert.ok(trap.length > 0, `no issue points at the right-hand ring (issues: ${JSON.stringify(issues.map((i) => i.code))})`);
});

test('ENG-3: a vehicle that makes room for others is never sent to a cell it can never leave again (with 6 vehicles four used to end up stranded in the one-way region within an hour)', () => {
  for (const vehicles of [6, 9]) {
    const sim = new Simulation(bridgePlant({ vehicles, depot: true, arrival: 30 }), { seed: 2 });
    const g = sim.graph;
    const trapLegs = [];
    const seen = new Set();
    for (let i = 0; i < Math.round(3600 / sim.dt); i++) {
      sim.step();
      for (const v of sim.vehicles) {
        if (v.state === 'toPark' && v.spot >= 0 && v.route && !seen.has(`${v.id}:${v.spot}`)) {
          seen.add(`${v.id}:${v.spot}`);
          if (!g.sameScc(v.route.nodes[0], v.spot)) trapLegs.push(`${v.id} from ${g.cx(v.route.nodes[0])},${g.cy(v.route.nodes[0])} to ${g.cx(v.spot)},${g.cy(v.spot)}`);
        }
      }
    }
    assert.deepEqual(trapLegs, [], `${vehicles} vehicles: waiting cells that cannot be left again`);
    const stranded = sim.vehicles.filter((v) => v.tv.onRoad && v.tv.node >= 0 && g.cx(v.tv.node) >= 10);
    assert.equal(stranded.length, 0, `${vehicles} vehicles: ${stranded.length} are stranded in the one-way region`);
  }
});

test('ENG-5: KPI fleet distance includes all driving to depots, chargers and waiting cells (in the examples that is 20 to 40 % of the odometer)', () => {
  for (const e of EXAMPLES) {
    const layout = e.build();
    layout.settings.warmup = 0;
    const sim = new Simulation(layout, { seed: 2 });
    sim.advance(2 * 3600);
    const report = sim.kpis();
    const reported = Object.values(report.fleets).reduce((sum, f) => sum + f.distance, 0);
    const odometer = sim.vehicles.reduce((sum, v) => sum + v.tv.odometer, 0);
    const park = sim.vehicles.reduce((sum, v) => sum + v.parkDistance, 0);
    assert.ok(unitsNear(odometer, sim.vehicles.reduce((sum, v) => sum + v.loadedDistance + v.emptyDistance + v.parkDistance, 0), 1e-3), 'the logistics books add up');
    assert.ok(reported >= 0.98 * odometer, `${e.id}: the report says ${reported.toFixed(0)} m but the vehicles drove ${odometer.toFixed(0)} m (${park.toFixed(0)} m to depots, chargers and waiting cells are missing)`);
  }
});

test('ENG-6: a vehicle held back at 0.05 m/s or less is "waiting": the queue behind a broken vehicle must show its wait share at speed factor 0.05', { todo: 'js/sim/traffic.js _bookkeep (traffic owner): `waits` requires tv._vFree > MOVING_SPEED; use a rule relative to the free speed (v < 0.5 * vFree, vFree > 1e-6)' }, () => {
  const run = (speedFactor) => {
    const sim = new Simulation(emptyRoad(16), { seed: 1 });
    sim.setRuntime({ speedFactor });
    const spec = { length: 1, speed: 0.8, accel: 0.6, decel: 1 };
    const lead = sim.traffic.addVehicle({ id: 'lead', ...spec, node: 6 });
    const follower = sim.traffic.addVehicle({ id: 'follower', ...spec, node: 2 });
    assert.ok(lead && follower);
    lead.disabled = true; // a breakdown: the follower can only wait
    assert.ok(sim.traffic.drive(follower, sim.graph.path(2, 12, {})));
    sim.advance(120);
    return { follower, report: sim.kpis() };
  };
  const normal = run(1);
  assert.ok(normal.follower.waiting && normal.report.traffic.waitShare > 0.5, 'at normal speed the follower waits (control)');
  const slow = run(0.05);
  assert.ok(slow.follower.waiting, 'the follower has stood behind a broken vehicle for two minutes, but at x0.05 (free speed 0.04 m/s) it is not flagged as waiting');
  assert.ok(slow.follower.blockedBy && slow.follower.blockedBy.id === 'lead');
  assert.ok(slow.report.traffic.waitShare > 0.5, `wait share ${slow.report.traffic.waitShare}`);
});

test('ENG-8: listSweepParameters keeps the current value of a factor inside its range, and the suggested values too', () => {
  const layout = example('starter');
  L.updateSettings(layout, { speedFactor: 5, demandFactor: 0.1, processFactor: 8 });
  for (const p of listSweepParameters(layout).filter((x) => /Factor$/.test(x.key))) {
    const current = p.get(layout);
    assert.ok(p.min <= current && current <= p.max, `${p.key}: current ${current} lies outside the range ${p.min}..${p.max}`);
    assert.ok(p.values.every((v) => v >= p.min && v <= p.max), `${p.key}: values ${p.values} outside ${p.min}..${p.max}`);
  }
});

test('ENG-9: advance() steps at least one tick for a request longer than dt * 1e-6 and treats a shorter one as done (the tolerance that absorbs summed clocks)', () => {
  const sim = new Simulation(example('starter'), { seed: 1 });
  sim.advance(10);
  assert.ok(sim.advance(sim.dt * 1e-5) > 0, 'a tiny request above the tolerance advances a whole tick');
  const before = sim.time;
  assert.equal(sim.advance(1e-9), 0, 'below the tolerance nothing is left to do');
  assert.equal(sim.time, before);
  let calls = 0;
  while (sim.time < 5000 - 1e-9 && calls++ < 10) sim.advance(5000 - sim.time);
  assert.ok(calls <= 2 && Math.abs(sim.time - 5000) < 1e-6, `a caller that asks for the remainder arrives after ${calls} calls at ${sim.time}`);
});

test('ENG-10: setRuntime({ demandFactor }) before the first arrival does not scale the start delay (the first load used to arrive at 300 s instead of 600 s)', () => {
  const firstArrival = (setup) => {
    const layout = L.createLayout({ name: 'delay', cols: 20, rows: 10, cellSize: 2 });
    L.paintRoadPath(layout, [[2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [7, 4], [8, 4], [9, 4]], {});
    const source = L.addStation(layout, { type: 'source', x: 2, y: 2, w: 2, h: 2, params: { interArrival: { kind: 'const', mean: 100, spread: 0 }, startDelay: 600 } });
    const sink = L.addStation(layout, { type: 'sink', x: 8, y: 2, w: 2, h: 2 });
    L.addFlow(layout, source.id, sink.id, {});
    L.addFleet(layout, 'agv', { count: 1 });
    const sim = new Simulation(layout, { seed: 1 });
    setup(sim);
    let at = null;
    sim.on('loadCreated', (p) => { if (at === null) at = p.load.createdAt; });
    sim.advance(1500);
    return at;
  };
  assert.equal(firstArrival(() => {}), 600);
  assert.equal(firstArrival((sim) => sim.setRuntime({ demandFactor: 1 })), 600);
  const withFactor = firstArrival((sim) => sim.setRuntime({ demandFactor: 2 }));
  assert.equal(withFactor, 600, `the start delay is a fixed offset, but the first load arrived at ${withFactor} s`);
});

// ---------------------------------------------------------------------------------------------------------------------------
// (11) The tips printed with the examples, at the default run length (8 simulated hours)
// ---------------------------------------------------------------------------------------------------------------------------

/** Mean figures of example variants over a few seeds of 8 simulated hours (the default duration), computed once on worker threads. */
let tipMeasurements = null;
function tips() {
  tipMeasurements ??= (async () => {
    const hours = 8;
    const seeds = 3;
    const chargeTime = { fleet: 'AGVs', patch: { battery: { chargeTimeMin: 60 } } };
    const variants = {
      starterBase: { id: 'starter', edits: [], fleet: 'AGV', station: 'Assembly' },
      starterOneAgv: { id: 'starter', edits: [{ fleet: 'AGV', patch: { count: 1 } }], fleet: 'AGV' },
      starterOneAgvTwoHours: { id: 'starter', edits: [{ fleet: 'AGV', patch: { count: 1 } }], fleet: 'AGV', hours: 2 },
      starterBaseTwoHours: { id: 'starter', edits: [], fleet: 'AGV', hours: 2 },
      starterDemand: { id: 'starter', edits: [{ settings: { demandFactor: 1.5 } }], fleet: 'AGV', station: 'Assembly' },
      twoBase: { id: 'two-lines', edits: [], fleet: 'AGVs', station: 'Press line' },
      twoDemand: { id: 'two-lines', edits: [{ settings: { demandFactor: 1.3 } }], fleet: 'AGVs', station: 'Press line' },
      twoAgv5: { id: 'two-lines', edits: [{ fleet: 'AGVs', patch: { count: 5 } }], fleet: 'AGVs' },
      twoAgv8: { id: 'two-lines', edits: [{ fleet: 'AGVs', patch: { count: 8 } }], fleet: 'AGVs' },
      twoCharge60: { id: 'two-lines', edits: [chargeTime], fleet: 'AGVs' },
      twoCharge60OneCharger: { id: 'two-lines', edits: [chargeTime, { station: 'AGV charging', patch: { params: { chargers: 1 } } }], fleet: 'AGVs' },
      // stops strike at random: only the mean of many runs says anything
      twoBaseTenSeeds: { id: 'two-lines', edits: [], fleet: 'AGVs', seeds: 10 },
      twoRepair: { id: 'two-lines', edits: [{ station: 'Press line', patch: { params: { mttr: 1800 } } }], fleet: 'AGVs', seeds: 10 },
      labBase: { id: 'congestion-lab', edits: [], fleet: 'AGV' },
      labSixAgvs: { id: 'congestion-lab', edits: [{ fleet: 'AGV', patch: { count: 6 } }], fleet: 'AGV' },
      labTenAgvs: { id: 'congestion-lab', edits: [{ fleet: 'AGV', patch: { count: 10 } }], fleet: 'AGV' },
      labCapacity2: { id: 'congestion-lab', edits: [{ fleet: 'AGV', patch: { capacity: 2 } }], fleet: 'AGV' },
      labQuick: { id: 'congestion-lab', edits: [{ fleet: 'AGV', patch: { loadTime: 12, unloadTime: 12 } }], fleet: 'AGV' },
      labSecondDock: { id: 'congestion-lab', edits: [{ road: { cells: [[24, 4], [32, 4], [32, 8]], oneWay: true } }], fleet: 'AGV' },
    };
    const names = Object.keys(variants);
    const results = await runParallel('tips', names.map((n) => ({ seeds, hours, ...variants[n] })));
    return Object.fromEntries(names.map((n, i) => [n, results[i]]));
  })();
  return tipMeasurements;
}

/** Relative change from `base` to `other` (0.1 = 10 % more). */
const change = (other, base) => other / base - 1;
const pct = (x) => `${(100 * x).toFixed(1)} %`;
/** `x` lies in [lo, hi] (a claim "about N" is checked against a band around N, because the figures are means of a few seeds). */
const within = (x, lo, hi, what) => assert.ok(x >= lo && x <= hi, `${what}: ${x.toFixed(3)} is outside ${lo}..${hi}`);

test('ENG-7a: Starter tips - one AGV: busy all the time, output about 8 % lower, lead time about twice after 2 h and about five times after 8 h; demand x1.5: assembly flat out at 99 %, AGV about 90 %, output near 30', async () => {
  const m = await tips();
  assert.ok(m.starterOneAgv.fleetUtilization > 0.97, 'the single AGV is busy all the time');
  within(-change(m.starterOneAgv.throughput, m.starterBase.throughput), 0.04, 0.13, 'output falls by about 8 %');
  within(change(m.starterOneAgvTwoHours.lead, m.starterBaseTwoHours.lead) + 1, 1.6, 2.4, 'lead time after 2 h: about twice');
  within(change(m.starterOneAgv.lead, m.starterBase.lead) + 1, 3.8, 6, 'lead time after 8 h: about five times');
  assert.ok(m.starterOneAgv.yardMax > m.starterBase.yardMax || m.starterOneAgv.wip > 3 * m.starterBase.wip, 'pallets pile up');
  within(m.starterDemand.stationUtilization, 0.97, 1, 'demand x1.5: the assembly runs flat out (about 99 %)');
  within(m.starterDemand.fleetUtilization, 0.86, 0.94, 'demand x1.5: the AGVs follow at about 90 %');
  within(m.starterDemand.throughput, 28.5, 31, 'demand x1.5: the output tops out near 30 pallets/h');
});

test('ENG-7b: Two lines tips - demand x1.3: output +28 %, Press line about 90 %, AGVs about 85 %; 5 AGVs: pickup wait +45 %, lead time +13 %; 8 AGVs: only idle time grows', async () => {
  const m = await tips();
  within(change(m.twoDemand.throughput, m.twoBase.throughput), 0.23, 0.33, 'output rises by about 28 %');
  within(m.twoDemand.stationUtilization, 0.86, 0.94, 'the Press line is about 90 % busy');
  within(m.twoDemand.fleetUtilization, 0.81, 0.89, 'the AGVs are about 85 % busy');
  within(change(m.twoAgv5.pickupWait, m.twoBase.pickupWait), 0.3, 0.6, '5 AGVs: loads wait about 45 % longer for a vehicle');
  within(change(m.twoAgv5.lead, m.twoBase.lead), 0.05, 0.22, '5 AGVs: the lead time grows by about 13 %');
  within(change(m.twoAgv8.lead, m.twoBase.lead), -0.04, 0.04, '8 AGVs: the lead time stays');
  assert.ok(m.twoAgv8.fleetUtilization < m.twoBase.fleetUtilization - 0.04, '8 AGVs: only the idle time grows');
  for (const other of [m.twoAgv5, m.twoAgv8]) within(change(other.throughput, m.twoBase.throughput), -0.03, 0.03, 'the output stays the same');
});

test('ENG-7c: Two lines tips - charge time 60 min: about 28 % of the time on the chargers instead of 8 %, output holds, pickup wait +40 %; with 1 charger the output falls by more than 40 % and the WIP climbs', async () => {
  const m = await tips();
  within(m.twoBase.charging, 0.05, 0.11, 'base: the AGVs spend about 8 % of their time on the chargers');
  within(m.twoCharge60.charging, 0.22, 0.34, 'charge time 60 min: about 28 % of the time on the chargers');
  within(change(m.twoCharge60.throughput, m.twoBase.throughput), -0.03, 0.03, 'the output holds');
  within(change(m.twoCharge60.pickupWait, m.twoBase.pickupWait), 0.25, 0.55, 'loads wait about 40 % longer for a vehicle');
  within(-change(m.twoCharge60OneCharger.throughput, m.twoBase.throughput), 0.35, 0.55, 'with one charger the output falls by more than 40 %');
  assert.ok(m.twoCharge60OneCharger.wip > 5 * m.twoBase.wip, 'and the work in process climbs without limit');
});

test('ENG-7d: Two lines tip - Press line repair time 30 min: over ten runs the WIP doubles, the lead time grows by about 60 % and the output falls by about 5 %', async () => {
  const m = await tips();
  within(m.twoRepair.wip / m.twoBaseTenSeeds.wip, 1.6, 2.3, 'work in process roughly doubles');
  within(change(m.twoRepair.lead, m.twoBaseTenSeeds.lead), 0.4, 0.85, 'the lead time grows by about 60 %');
  within(-change(m.twoRepair.throughput, m.twoBaseTenSeeds.throughput), 0.02, 0.09, 'the output falls by about 5 %');
});

test('ENG-7e: Congestion lab tips - 6 AGVs: same output, wait share down by a third; 10 AGVs: a little more waiting; capacity 2 or 12 s hand-over: down by half or more; a second dock for Packing: down by about 40 %', async () => {
  const m = await tips();
  const fall = (variant) => -change(variant.waitShare, m.labBase.waitShare);
  for (const [name, variant] of [['6 AGVs', m.labSixAgvs], ['capacity 2', m.labCapacity2], ['12 s hand-over', m.labQuick], ['a second dock', m.labSecondDock], ['10 AGVs', m.labTenAgvs]]) {
    within(change(variant.throughput, m.labBase.throughput), -0.03, 0.03, `${name}: the output stays the same`);
  }
  within(fall(m.labSixAgvs), 0.25, 0.42, '6 AGVs: the wait share falls by about a third');
  within(fall(m.labSecondDock), 0.3, 0.46, 'a second dock: the wait share falls by about 40 % (a third before vehicles chose the free dock)');
  within(fall(m.labCapacity2), 0.4, 0.65, 'capacity 2: the wait share falls by about half');
  within(fall(m.labQuick), 0.4, 0.7, '12 s hand-over: the wait share falls by more than half');
  within(-fall(m.labTenAgvs), 0, 0.15, 'a 10th AGV only adds a little waiting');
});
