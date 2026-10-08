// Adversarial review of the edit-feedback work: the warm restart of js/ui/runner.js (pre-roll behind the displayed simulation), the
// baseline and the "Effect of your change" model of js/ui/panels/impact.js, and the unused-resource rules of js/sim/insights.js.
// The browser side (card layout at 390 px, dark mode, focus, toast wording, jank, persistence) is tests/e2e/edit-feedback-review.mjs.
//
// Everything runs on a fake clock and fake animation frames (rAF handles are counted), with a counting fake Simulation for the
// lifecycle attacks (WeakRef + gc: how many Simulation objects are alive) and with the REAL engine wherever a number is judged.
// The builder's own tests (ui.runner.warm.test.js, ui.impact.test.js, sim.insights.unused.test.js) are not repeated here.
//
// Two kinds of tests (same convention as sim.engine.review.test.js):
//   WARM-GUARD-<area>-<n>   guards: attacks that did NOT break anything; they document what was tried and keep it that way.
//   WARM-<n>                one test per REAL defect. Each is marked `todo` (it runs and fails today, the suite stays green) and
//                           names what is wrong and where; remove the `todo` when the defect is fixed.
//
// Defects (severity: high = wrong numbers, leaks, runaway loops, a sim that never swaps, lost edits; medium = misleading messages or
// jank; low = polish). Attacks that found nothing: 20 commits in 200 ms, edit/undo/redo, scenario switch, loadProject, reset, destroy,
// play/pause/step mid-priming, hidden tab (400-step fuzz over 60 seeds: one rAF handle at most, the displayed simulation never moves
// while priming, no lost edit, no stale simulation shown, only one Simulation alive after gc, nothing constructed after destroy);
// bit-identical pre-roll for dt 0.05..0.3 and warm-up 0..1700 s; baseline taken from the OLD simulation and never mutated; 25 real
// edits leave one Simulation alive.
//   WARM-1  high    The card colours verdicts the data cannot carry. "Before" is the cumulative window of the old run (an hour or more), "after" is
//                   the first 10 minutes after the warm-up of a fresh run, and the noise rule is a fixed 3 % / 1 load per hour. Measured over 8
//                   seeds: the first 10 min differ from the long-run figure by up to 19 % (Starter) and, systematically, by -11..-15 % on Two
//                   lines; 20 min by up to 28 %; waiting in traffic by 5-9 points; lead time by up to 35 %. So renaming a station (a restart that
//                   cannot change anything) reads "Throughput 19.9 -> 18 /h, -9.4 % worse" and "Work in progress -10 % better", and adding vehicles
//                   nobody needs reads "worse". Fix: compare like with like (a control run of the OLD layout pre-rolled the same way, deterministic
//                   and paired, gives exactly +-0 for a no-op) or at least scale the noise threshold with the window and keep every chip neutral
//                   while the window is "indicative".
//   WARM-2  medium  A change that breaks the plant (no road, nothing finishes) reads "Time waiting in traffic 2.2 -> 0 %, better" (green: nothing
//                   drives any more) and "Lead time -> -, not comparable"; nothing says that no load was finished or where to look.
//   WARM-3  medium  The toast says "Updated simulation is warmed up" also when the warm-up is longer than the 40 min pre-roll cap and the card
//                   directly below says "still warming up" (e2e).
//   WARM-4  medium  Priming has no wall-clock bound and no progress is shown: with 300 vehicles on a 160 x 160 plant the 1200 s pre-roll needs 13 s
//                   (Node; 100 vehicles 0.9 s, 250 vehicles 2.4 s), during which the old simulation stands still, and every further edit starts it again.
//   WARM-5  low     "Keep as baseline" while the numbers are not reliable (or while priming) answers "nothing to keep" and then silently DROPS the
//                   existing baseline and the card.
//   WARM-6  medium  "Compare properly..." opens the Experiments tab, which says "Create a variant to compare": the old plant is not kept anywhere
//                   (runner.baseline has no layout), so the promised comparison of the old and the new plant cannot be run (e2e shows the tab).
//   WARM-7  low     station-never-used blames the road ("Most likely no vehicle can drive to its dock") for a destination behind a storage whose
//                   dwell is longer than the window.
//   WARM-8  low     vehicle-idle-some grammar: "1 of 4 vehicles ... hardly work", "#4 (0 trips) made far fewer trips than their fleet-mates".
//   WARM-9  low     One new vehicle that may serve no flow (all flows dedicated to other fleets, the Two lines example) gets NO insight (fleet-oversized
//                   needs two vehicles, fleet-unused needs other vehicles on the same flows); a fleet of two gets fleet-oversized but its strip shows no badge.
//   WARM-10 low     (e2e only) a: the card clips the list of edits to two lines and gives no way to read the rest; b: the "Hide this hint" button is 22 x 22 px;
//                   c: at 390 px the hint is cut off and nothing gives it in full; d: the honesty line and the figures change without being announced.
//   Not defects, but worth knowing: every commit on a 160 x 160 plant blocks the page for about 190-270 ms in the app's own update (ui/app.js, not the pre-roll: no
//   long animation frame during priming); the unused-resource verdict flickers with the window (at the 10 minute window right after a restart 7 of 90 random plants
//   raised fleet-unused / vehicle-idle-some / station-never-used and 5 of those 7 were gone after 2 h; a new fleet of two forklifts next to 5 AGVs is "barely used" at
//   10 minutes in most seeds and carries 1 trip per vehicle and hour two hours later); a restarted simulation keeps one replaced simulation referenced until the next
//   'kpis' event (kpiSeen), at most 250 ms; runtime what-if edits made earlier still dilute the old baseline (known, reported by the builder).
//   (The UI findings, the toast wording, "Compare properly..." and the long-label layout are in tests/e2e/edit-feedback-review.mjs.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createRunner, primeSeconds, REBUILD_DEBOUNCE_MS, PRIME_SLICE_MS } from '../js/ui/runner.js';
import { createStore } from '../js/store/store.js';
import * as L from '../js/model/layout.js';
import { EXAMPLES } from '../js/model/examples.js';
import { Simulation } from '../js/sim/engine.js';
import { METRICS } from '../js/sim/experiments.js';
import { impactModel, impactHintText, classifyDelta, IMPACT_FIGURES, NOISE_RELATIVE } from '../js/ui/panels/impact.js';
import { usageBadge } from '../js/ui/panels/fleet-status.js';
import { createRng } from '../js/util/rng.js';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
/** Collect garbage for real: a WeakRef target stays alive until the end of the job that touched it, so yield to the event loop between runs. */
async function collect() {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
    gc();
  }
}

const example = (id) => EXAMPLES.find((e) => e.id === id).build();
const NEW_RULES = ['fleet-unused', 'vehicle-idle-some', 'source-unconnected-activity', 'station-never-used'];
const isNewRule = (id) => NEW_RULES.some((rule) => id === rule || id.startsWith(`${rule}:`));

// ---------------------------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------------------------

/** A counting Simulation stand-in: `capacity` ticks per advance() call, every instance tracked by a WeakRef (never by a strong reference). */
function fakeSimClass({ capacity = 400 } = {}) {
  class FakeSim {
    constructor(layout) {
      if (FakeSim.forbidden) throw new Error('a Simulation was constructed after destroy()');
      this.layout = layout;
      this.settings = layout.settings;
      this.dt = 0.1;
      this.ticks = 0;
      this.number = ++FakeSim.made;
      FakeSim.refs.push(new WeakRef(this));
    }

    get time() {
      return this.ticks * this.dt;
    }

    advance(seconds) {
      if (!(seconds > 0)) return 0;
      const wanted = Math.ceil((seconds - this.dt * 1e-6) / this.dt);
      const n = Math.max(0, Math.min(wanted, capacity));
      this.ticks += n;
      return n * this.dt;
    }

    setRuntime() {}

    kpis() {
      const warmup = this.settings.warmup;
      const duration = Math.max(0, this.time - warmup);
      return { window: { start: Math.min(warmup, this.time), end: this.time, duration, warmingUp: this.time < warmup }, throughput: { total: 0, perHour: 10 } };
    }

    insights() {
      return [];
    }
  }
  FakeSim.made = 0;
  FakeSim.refs = [];
  FakeSim.forbidden = false;
  FakeSim.alive = () => FakeSim.refs.filter((ref) => ref.deref() !== undefined).length;
  return FakeSim;
}

/**
 * The runner on a fake clock and fake animation frames. `tick` (ms) is added to the clock at every reading, which cuts the engine's time
 * budget into slices like a real clock would. Every requestAnimationFrame handle is counted: `outstanding()` must be 1 while the runner lives.
 */
function makeRig({ Sim = Simulation, layout = null, id = 'starter', tick = 0, speed = 1200 } = {}) {
  const clock = { t: 5000 };
  const handles = new Set();
  let queued = null;
  let seq = 0;
  const raf = (cb) => {
    const handle = ++seq;
    handles.add(handle);
    queued = { handle, cb };
    return handle;
  };
  const caf = (handle) => {
    handles.delete(handle);
    if (queued && queued.handle === handle) queued = null;
  };
  const store = createStore({ storage: undefined });
  store.newProject(layout ?? example(id));
  const renderer = { sim: null, layout: null, render() {} };
  const doc = {
    hidden: false,
    listeners: new Set(),
    addEventListener(type, fn) { if (type === 'visibilitychange') this.listeners.add(fn); },
    removeEventListener(type, fn) { this.listeners.delete(fn); },
    fire() { for (const fn of [...this.listeners]) fn(); },
  };
  const errors = [];
  const runner = createRunner({ store, renderer, raf, caf, now: () => { clock.t += tick; return clock.t; }, document: doc, SimulationClass: Sim, onError: (err) => errors.push(err), speed });
  const events = [];
  // payloads are stored without their simulations: the test must not keep alive what it counts
  for (const name of ['rebuild', 'baseline', 'priming', 'state', 'error']) {
    runner.on(name, (payload) => events.push([name, name === 'rebuild' ? { reason: payload.reason, warm: payload.warm, label: payload.label, labels: payload.labels, hasSim: Boolean(payload.sim) } : null]));
  }
  const rig = {
    clock, store, renderer, doc, runner, errors, events,
    outstanding: () => handles.size,
    frame(ms = 16) {
      assert.ok(queued, 'a frame must be scheduled');
      const { handle, cb } = queued;
      queued = null;
      handles.delete(handle);
      clock.t += ms;
      cb(clock.t);
    },
    frames(n, ms = 16) { for (let i = 0; i < n; i++) rig.frame(ms); },
    until(cond, max = 100000, ms = 16) {
      for (let i = 0; i < max; i++) {
        if (cond()) return i;
        rig.frame(ms);
      }
      assert.fail('the condition was not reached');
      return max;
    },
    /** Play and run until the simulation clock has passed `seconds`. */
    async runTo(seconds) {
      rig.frame();
      runner.setSpeed(speed);
      assert.equal(await runner.play(), true);
      rig.until(() => runner.time >= seconds);
    },
    /** Frames until the replacement of the displayed simulation is in place. */
    swap() {
      const before = runner.sim;
      rig.until(() => runner.sim !== before && !runner.priming);
    },
    commit(label, fn) { return store.commit(label, fn); },
  };
  return rig;
}

/** One more Goods in on a free spot (a structural edit with a readable label). */
function addSource(rig, n = 0) {
  return rig.commit('Add Goods in', (l) => { L.addStation(l, { type: 'source', x: 2 + 4 * (n % 9), y: 2 + 4 * (Math.floor(n / 9) % 8) }); });
}

const json = (value) => JSON.stringify(value);

// ---------------------------------------------------------------------------------------------------------
// lifecycle: nothing runs invisibly, nothing leaks, no edit is lost
// ---------------------------------------------------------------------------------------------------------

test('WARM-GUARD-L1: 20 commits in 200 ms, one per frame, during priming give one more replacement built from the newest layout; one Simulation stays alive', async () => {
  const Fake = fakeSimClass({ capacity: 40 });
  const rig = makeRig({ Sim: Fake });
  await rig.runTo(700);
  let first = rig.runner.sim;
  addSource(rig, 0);
  rig.until(() => rig.runner.priming);
  assert.equal(Fake.made, 2, 'priming of the first edit has started');
  for (let i = 1; i <= 20; i++) {
    addSource(rig, i);
    assert.equal(rig.runner.priming, false, 'an edit throws the half-primed simulation away');
    rig.frame(10);
    assert.equal(rig.runner.sim, first, 'the displayed simulation stays');
  }
  assert.equal(Fake.made, 2, 'the burst (200 ms < 250 ms debounce) built nothing');
  rig.until(() => rig.runner.sim !== first && !rig.runner.priming);
  assert.equal(Fake.made, 3, 'one more replacement, from the newest layout only');
  assert.equal(rig.runner.sim.layout, rig.store.getState().layout);
  assert.ok(rig.runner.sim.layout.stations.length > example('starter').stations.length + 10, 'the burst\'s stations are in');
  assert.equal(rig.outstanding(), 1, 'one animation-frame handle');
  assert.equal(rig.errors.length, 0);
  first = null;
  await collect();
  assert.equal(Fake.alive(), 1, 'only the displayed simulation is alive');
  rig.runner.destroy();
});

test('WARM-GUARD-L2: edit, undo, redo around priming: nothing is lost, nothing stale is shown, nothing leaks', async () => {
  const Fake = fakeSimClass({ capacity: 40 });
  const rig = makeRig({ Sim: Fake });
  await rig.runTo(700);
  let first = rig.runner.sim;
  const stations = first.layout.stations.length;
  addSource(rig);
  rig.until(() => rig.runner.priming);
  rig.store.undo(); // back to the layout of the displayed simulation: the restart is cancelled
  assert.equal(rig.runner.priming, false);
  rig.frames(30);
  assert.equal(rig.runner.sim, first, 'the old simulation was never replaced');
  assert.equal(rig.runner.baseline, null);
  rig.store.redo();
  rig.swap();
  assert.equal(rig.runner.sim.layout.stations.length, stations + 1, 'the redone edit is in the simulation');
  assert.deepEqual(rig.events.filter(([name]) => name === 'rebuild').map(([, e]) => e.reason), ['create', 'structural']);
  // and the other way round: undo AFTER the swap is a new edit and gets its own warm restart
  rig.store.undo();
  rig.swap();
  assert.equal(rig.runner.sim.layout.stations.length, stations);
  first = null;
  await collect();
  assert.equal(Fake.alive(), 1);
  rig.runner.destroy();
});

test('WARM-GUARD-L3: Reset during priming is a cold start: the half-primed simulation is never shown, the baseline is gone, one frame handle', async () => {
  const Fake = fakeSimClass({ capacity: 40 });
  const rig = makeRig({ Sim: Fake });
  await rig.runTo(700);
  addSource(rig);
  rig.until(() => rig.runner.priming);
  const made = Fake.made;
  rig.runner.reset();
  assert.equal(rig.runner.priming, false);
  assert.equal(Fake.made, made + 1, 'reset built exactly one simulation');
  assert.equal(rig.runner.time, 0);
  assert.equal(rig.runner.warm, null);
  assert.equal(rig.runner.baseline, null);
  assert.equal(rig.renderer.sim, rig.runner.sim);
  rig.frames(60);
  assert.equal(rig.runner.time, 0, 'paused at 0:00, the stale primed simulation did not take over');
  assert.equal(rig.runner.sim.layout, rig.store.getState().layout, 'the cold simulation includes the edit');
  assert.equal(rig.outstanding(), 1);
  await collect();
  assert.equal(Fake.alive(), 1);
  rig.runner.destroy();
});

test('WARM-GUARD-L4: destroy() during priming ends all work: no frame handle, no construction, no event', async () => {
  const Fake = fakeSimClass({ capacity: 40 });
  const rig = makeRig({ Sim: Fake });
  await rig.runTo(700);
  addSource(rig);
  rig.until(() => rig.runner.priming);
  const made = Fake.made;
  const eventsBefore = rig.events.length;
  rig.runner.destroy();
  Fake.forbidden = true;
  assert.equal(rig.outstanding(), 0, 'the pending frame was cancelled');
  assert.equal(rig.renderer.sim, null);
  addSource(rig, 3); // an edit after destroy must not wake anything
  await rig.runner.play();
  rig.runner.reset();
  assert.equal(Fake.made, made);
  assert.equal(rig.events.length, eventsBefore, 'no event after destroy');
  await collect();
  assert.ok(Fake.alive() <= 1, 'at most the last results of the destroyed runner are alive');
});

test('WARM-GUARD-L5: Play, Pause, toggle and step while priming: the displayed simulation never advances, the last word on playing wins', async () => {
  const Fake = fakeSimClass({ capacity: 40 });
  const rig = makeRig({ Sim: Fake });
  await rig.runTo(700);
  const first = rig.runner.sim;
  addSource(rig);
  rig.until(() => rig.runner.priming);
  const frozen = first.time;
  const steps = [];
  for (let i = 0; i < 6 && rig.runner.priming; i++) {
    if (i % 3 === 0) rig.runner.pause();
    else if (i % 3 === 1) await rig.runner.play();
    else steps.push(rig.runner.step(5));
    rig.frame();
    if (rig.runner.priming) assert.equal(first.time, frozen);
  }
  rig.runner.pause();
  rig.swap();
  assert.equal(rig.runner.playing, false);
  const at = rig.runner.time;
  rig.frames(20);
  assert.equal(rig.runner.time, at, 'a paused runner does not run after the swap');
  const advanced = await Promise.all(steps);
  assert.ok(advanced.every((s) => Number.isFinite(s)), 'every step() promise settled');
  await rig.runner.play();
  rig.frames(5);
  assert.ok(rig.runner.time > at, 'and plays again when told to');
  assert.equal(rig.outstanding(), 1);
  rig.runner.destroy();
});

test('WARM-GUARD-L6: a hidden tab does not prime and does not play; priming resumes when the tab is back, paused', async () => {
  const Fake = fakeSimClass({ capacity: 40 });
  const rig = makeRig({ Sim: Fake });
  await rig.runTo(700);
  addSource(rig);
  rig.until(() => rig.runner.priming);
  const primed = () => rig.runner.primeProgress;
  rig.frames(2);
  rig.doc.hidden = true;
  rig.doc.fire();
  assert.equal(rig.runner.playing, false);
  const at = primed();
  rig.frames(50);
  assert.equal(primed(), at, 'no pre-roll while hidden');
  rig.doc.hidden = false;
  rig.doc.fire();
  rig.swap();
  assert.equal(rig.runner.playing, false, 'the tab came back paused');
  rig.runner.destroy();
});

test('WARM-GUARD-L7: switching the variant or loading a plant during priming is a cold start; the primed simulation of the other plant is never shown', async () => {
  for (const how of ['scenario', 'load']) {
    const Fake = fakeSimClass({ capacity: 40 });
    const rig = makeRig({ Sim: Fake });
    await rig.runTo(700);
    let first = rig.runner.sim;
    addSource(rig);
    rig.until(() => rig.runner.priming);
    const primingSim = Fake.made; // number of the simulation being pre-rolled
    if (how === 'scenario') {
      const id = rig.store.addScenario('B', example('two-lines'));
      assert.ok(id);
    } else {
      rig.store.newProject(example('two-lines'));
    }
    assert.equal(rig.runner.priming, false);
    rig.until(() => rig.runner.sim !== first);
    assert.equal(rig.runner.sim.number > primingSim, true, `${how}: a new simulation, not the half-primed one`);
    assert.equal(rig.runner.sim.layout, rig.store.getState().layout);
    assert.ok(rig.runner.time < 120, `${how}: from an empty plant (it has run ${rig.runner.time} s since)`);
    assert.equal(rig.events.filter(([name]) => name === 'rebuild').at(-1)[1].warm, false, `${how}: a cold rebuild`);
    assert.equal(rig.runner.warm, null);
    assert.equal(rig.runner.baseline, null);
    assert.equal(rig.outstanding(), 1);
    rig.frames(40); // the runner keeps the replaced simulation in its last-results bookkeeping until the next 'kpis' event, 250 ms
    first = null;
    await collect();
    assert.equal(Fake.alive(), 1, `${how}: one alive`);
    rig.runner.destroy();
  }
});

test('WARM-GUARD-L8: 400-step fuzz over 60 seeds (edits, undo/redo, play/pause/step, reset, hide, scenarios, loads, keep/dismiss, switch off): the invariants hold', async () => {
  const problems = [];
  for (let seed = 1; seed <= 60; seed++) {
    const rng = createRng(seed);
    const int = (a, b) => a + Math.floor(rng.next() * (b - a + 1));
    const pick = (list) => list[int(0, list.length - 1)];
    const Fake = fakeSimClass({ capacity: 400 });
    const rig = makeRig({ Sim: Fake, id: pick(['starter', 'two-lines', 'congestion-lab']) });
    const { runner, store, doc } = rig;
    const replaced = new WeakSet();
    let shown = null;
    const watch = () => {
      if (runner.sim !== shown) {
        if (shown) replaced.add(shown);
        shown = runner.sim;
        if (shown && replaced.has(shown)) problems.push(`seed ${seed}: a replaced simulation came back`);
      }
    };
    const frame = (ms) => {
      const before = runner.sim;
      const t = before ? before.time : null;
      const priming = runner.priming;
      rig.frame(ms);
      if (priming && runner.sim === before && before && before.time !== t) problems.push(`seed ${seed}: the displayed simulation moved while priming`);
      if (rig.outstanding() > 1) problems.push(`seed ${seed}: ${rig.outstanding()} frame handles`);
      if (rig.renderer.sim !== runner.sim) problems.push(`seed ${seed}: the renderer shows another simulation than the runner`);
      watch();
    };
    let k = 0;
    const ops = [
      () => addSource(rig, k++), () => addSource(rig, k++),
      () => store.commit('Fleet count', (l) => { l.fleets[0].count = int(1, 9); }),
      () => store.commit('Rename plant', (l) => { l.name = `n${int(0, 99)}`; }),
      () => store.commit('Demand', (l) => { l.settings.demandFactor = 0.5 + rng.next(); }),
      () => store.undo(), () => store.redo(),
      () => runner.play(), () => runner.pause(), () => runner.toggle(), () => runner.step(int(1, 200)),
      () => runner.reset(),
      () => { doc.hidden = !doc.hidden; doc.fire(); },
      () => store.setUi({ warmRestart: rng.next() < 0.7 }),
      () => { if (rng.next() < 0.3) store.newProject(example(pick(['starter', 'two-lines', 'congestion-lab']))); },
      () => { if (rng.next() < 0.5) store.addScenario(`V${k++}`, null); else { const all = store.getState().project.scenarios; store.switchScenario(pick(all).id); } },
      () => runner.keepBaseline(), () => runner.dismissBaseline(), () => runner.setSpeed(pick([1, 10, 600, 1200])),
    ];
    frame(16);
    for (let i = 0; i < 400; i++) {
      if (rng.next() < 0.5) {
        try { pick(ops)(); } catch (err) { problems.push(`seed ${seed}: an operation threw ${err.message}`); }
        watch();
      }
      const n = int(0, rng.next() < 0.2 ? 40 : 6);
      for (let f = 0; f < n; f++) frame(int(5, 40));
    }
    doc.hidden = false;
    doc.fire();
    for (let i = 0; i < 400; i++) frame(16);
    if (runner.priming) problems.push(`seed ${seed}: still priming after 400 quiet frames`);
    if (runner.sim && L.layoutChangeKind(runner.sim.layout, store.getState().layout) === 'structural') problems.push(`seed ${seed}: an edit was lost (the simulation differs structurally from the plant)`);
    await collect();
    if (Fake.alive() > 1) problems.push(`seed ${seed}: ${Fake.alive()} simulations alive after quiet`);
    const made = Fake.made;
    runner.destroy();
    Fake.forbidden = true;
    if (rig.outstanding() !== 0) problems.push(`seed ${seed}: a frame handle outlives destroy()`);
    if (Fake.made !== made) problems.push(`seed ${seed}: constructed after destroy`);
    if (rig.errors.length) problems.push(`seed ${seed}: errors ${rig.errors.map((e) => e.message).join('; ')}`);
  }
  assert.deepEqual(problems, []);
});

test('WARM-GUARD-L9: 25 real edits (real engine, sliced pre-roll) leave one Simulation alive and bounded labels', async () => {
  const refs = [];
  class Counting extends Simulation {
    constructor(...args) {
      super(...args);
      refs.push(new WeakRef(this));
    }
  }
  const rig = makeRig({ Sim: Counting, tick: 0.2 });
  await rig.runTo(1500);
  for (let i = 0; i < 25; i++) {
    const before = rig.runner.sim;
    rig.commit(`Fleet ${i}`, (l) => { l.fleets[0].count = i % 2 ? 4 : 3; });
    rig.until(() => rig.runner.sim !== before && !rig.runner.priming);
  }
  assert.ok(refs.length >= 26);
  await collect();
  assert.equal(refs.filter((ref) => ref.deref() !== undefined).length, 1);
  assert.ok(rig.runner.baseline.labels.length <= 12, 'labels stay bounded');
  assert.equal(rig.runner.baseline.edits, 25);
  assert.equal(rig.errors.length, 0);
  rig.runner.destroy();
});

// ---------------------------------------------------------------------------------------------------------
// correctness: determinism and the baseline
// ---------------------------------------------------------------------------------------------------------

test('WARM-GUARD-C1: the warm simulation is bit-identical to a direct run of the same layout for the same simulated seconds (dt, warm-up, restarted priming)', async () => {
  for (const [dt, warmup] of [[0.1, 600], [0.1, 0], [0.05, 120], [0.25, 600], [0.3, 1700], [0.1, 3000]]) {
    const layout = example('starter');
    L.updateSettings(layout, { dt, warmup });
    const rig = makeRig({ layout, tick: 0.2 });
    await rig.runTo(200);
    const wanted = rig.store.getState().layout.fleets[0].count + 2;
    rig.commit('One more AGV', (l) => { l.fleets[0].count += 1; });
    rig.until(() => rig.runner.priming);
    assert.ok(rig.runner.primeProgress < 1);
    rig.commit('One more AGV again', (l) => { l.fleets[0].count += 1; }); // throws the half-primed simulation away: priming starts again from the newest layout
    assert.equal(rig.runner.priming, false);
    rig.until(() => rig.runner.warm && !rig.runner.priming && rig.runner.sim.layout.fleets[0].count === wanted);
    const swapped = rig.runner.sim;
    assert.equal(swapped.time, rig.runner.warm.preRoll, `dt ${dt}, warm-up ${warmup}: the swap happens at the end of the pre-roll`);
    const direct = new Simulation(rig.store.getState().layout);
    direct.advance(swapped.time);
    assert.equal(direct.time, swapped.time, `dt ${dt}, warm-up ${warmup}: the same number of ticks`);
    assert.equal(json(swapped.kpis()), json(direct.kpis()), `dt ${dt}, warm-up ${warmup}: KPI JSON`);
    assert.equal(swapped.logistics.liveLoads, direct.logistics.liveLoads);
    assert.equal(json(swapped.vehicles.map((v) => [v.id, v.state, v.trips])), json(direct.vehicles.map((v) => [v.id, v.state, v.trips])));
    assert.equal(swapped.layout.fleets[0].count, wanted, 'the newest edit is in');
    assert.equal(primeSeconds(warmup) >= swapped.time - dt, true);
    rig.runner.destroy();
  }
});

test('WARM-GUARD-C2: the baseline is the OLD simulation\'s report with its full window and is never mutated afterwards (edits, keep, dismiss, running on)', async () => {
  const rig = makeRig({ id: 'two-lines', tick: 0.2 });
  await rig.runTo(3000);
  const old = rig.runner.sim;
  rig.commit('Add Goods in', (l) => { L.addStation(l, { type: 'source', x: 26, y: 2, w: 3, h: 2 }); });
  rig.until(() => rig.runner.priming || rig.runner.sim !== old);
  const standing = json(old.kpis()); // the old simulation stands still from here on
  rig.swap();
  assert.equal(rig.runner.sim !== old, true);
  const base = rig.runner.baseline;
  assert.ok(base);
  assert.equal(json(base.report), standing, 'the baseline is the report of the old simulation, not of the new one');
  assert.ok(base.report.window.duration > 1500, `with its full window: ${base.report.window.duration} s`);
  assert.equal(base.report.window.warmingUp, false);
  assert.equal(base.simTime, old.time);
  const frozen = json(base);
  rig.frames(80); // the new simulation runs on
  assert.equal(json(rig.runner.baseline), frozen);
  // a second edit keeps the ORIGINAL report (same object), a third after keepBaseline() takes the current numbers
  const second = rig.runner.sim;
  rig.commit('Add Goods out', (l) => { L.addStation(l, { type: 'sink', x: 40, y: 2, w: 3, h: 2 }); });
  rig.swap();
  assert.equal(rig.runner.baseline.report, base.report, 'the same report object, not a copy of a newer one');
  assert.equal(json(rig.runner.baseline.report), standing);
  assert.deepEqual(rig.runner.baseline.labels, ['Add Goods in', 'Add Goods out']);
  rig.frames(400);
  assert.equal(rig.runner.keepBaseline(), true);
  const kept = json(rig.runner.baseline);
  rig.frames(200);
  assert.equal(json(rig.runner.baseline), kept, 'a kept baseline does not follow the running simulation');
  assert.notEqual(second, rig.runner.sim);
  rig.runner.destroy();
});

test('WARM-GUARD-C3: delta semantics: lower-is-better figures are bad when they rise, utilization is never coloured, signs follow the change, nothing is NaN', () => {
  const rng = createRng(2024);
  const better = new Map(METRICS.map((m) => [m.id, m.better]));
  for (const figure of IMPACT_FIGURES) {
    const direction = better.get(figure.metric);
    for (let i = 0; i < 400; i++) {
      const before = rng.next() < 0.1 ? 0 : rng.next() * 100;
      const after = rng.next() < 0.1 ? 0 : before * (0.3 + rng.next() * 1.7);
      const c = classifyDelta(figure, before, after);
      assert.equal(c.known, true);
      assert.ok(!/NaN|undefined|Infinity/.test(c.text), `${figure.id}: ${c.text}`);
      const delta = after - before;
      if (delta !== 0) assert.equal(c.text.startsWith(delta > 0 ? '+' : '−'), true, `${figure.id}: ${before} -> ${after} reads "${c.text}"`);
      if (direction === null) assert.equal(c.tone, 'neutral', `${figure.id} is never coloured`);
      else if (!c.noise) assert.equal(c.tone, (direction === 'higher') === (delta > 0) ? 'good' : 'bad', `${figure.id}: ${before} -> ${after}`);
      else assert.equal(c.tone, 'neutral');
      // the exact documented noise rule
      const noise = Math.abs(delta) < figure.floor || (before !== 0 && Math.abs(delta / before) < NOISE_RELATIVE);
      assert.equal(c.noise, noise, `${figure.id}: ${before} -> ${after}`);
    }
    for (const bad of [null, undefined, NaN, Infinity, -Infinity]) {
      assert.equal(classifyDelta(figure, bad, 5).known, false);
      assert.equal(classifyDelta(figure, 5, bad).known, false);
    }
  }
});

test('WARM-GUARD-C4: the impact model and the hint survive every odd report (missing, NaN, Infinity, negative durations) without throwing or printing NaN', () => {
  const odd = [null, undefined, {}, { window: {} }, { window: { duration: NaN, warmingUp: false } }, { window: { duration: Infinity } }, { window: { duration: -5 } },
    { throughput: null, leadTime: { mean: NaN }, wip: {}, fleets: null, traffic: null },
    { window: { duration: 700 }, throughput: { perHour: '12' }, fleets: { a: { utilization: NaN, count: 0 } }, traffic: { waitShare: Infinity }, leadTime: { mean: -1 } }];
  for (const before of odd) {
    for (const after of odd) {
      const model = impactModel({ report: before ?? {}, labels: ['x'], edits: 1 }, after);
      assert.ok(!/NaN|undefined|Infinity/.test(json(model).replace(/"key":"[^"]*"/g, '')), json(model));
      assert.equal(typeof impactHintText(model), 'string');
    }
  }
});

// ---------------------------------------------------------------------------------------------------------
// honesty of the card
// ---------------------------------------------------------------------------------------------------------

/** Run a plant for `seconds`, apply one edit, wait for the warm swap and return the card's model. */
async function afterEdit({ id, seed = 1, before = 3600, edit, label = 'Edit' }) {
  const layout = example(id);
  layout.settings.seed = seed;
  const rig = makeRig({ layout, tick: 0.2 });
  await rig.runTo(before);
  rig.commit(label, edit);
  rig.until(() => rig.runner.warm && !rig.runner.priming && rig.runner.baseline);
  const model = () => impactModel(rig.runner.baseline, rig.runner.kpis(), { priming: rig.runner.priming });
  return { rig, model };
}

test('WARM-GUARD-H1: a real, large effect is still reported as worse once the window is solid (halving the vehicles on Two lines)', async () => {
  const { rig, model } = await afterEdit({ id: 'two-lines', edit: (l) => { for (const f of l.fleets) f.count = 1; }, label: 'Fewer vehicles' });
  rig.until(() => rig.runner.kpis().window.duration >= 1300);
  const rows = Object.fromEntries(model().rows.map((r) => [r.id, r.change]));
  assert.equal(rows.throughput.tone, 'bad');
  assert.equal(rows.wip.tone, 'bad');
  assert.equal(rows.fleet.tone, 'neutral');
  assert.equal(model().status.key, 'solid');
  rig.runner.destroy();
});

test('WARM-GUARD-H2: cosmetic edits (label, obstacle, plant name, run duration) rebuild nothing and show no card; a runtime edit applies live; only a structural one restarts', async () => {
  const Fake = fakeSimClass({ capacity: 400 });
  const rig = makeRig({ Sim: Fake });
  await rig.runTo(1500);
  const sim = rig.runner.sim;
  const made = Fake.made;
  rig.commit('Add label', (l) => { L.addLabel(l, { x: 20, y: 20, text: 'Hello' }); });
  rig.commit('Rename plant', (l) => { l.name = 'Another name'; });
  rig.commit('Run length', (l) => { L.updateSettings(l, { duration: 7200 }); });
  const obstacle = rig.commit('Add obstacle', (l) => { L.addObstacle(l, { x: 1, y: 28, w: 2, h: 1, kind: 'wall' }); });
  rig.frames(80);
  assert.equal(Fake.made, made, 'nothing was built');
  assert.equal(rig.runner.sim, sim);
  assert.equal(rig.runner.baseline, null);
  assert.equal(rig.runner.priming, false);
  rig.commit('Demand', (l) => { l.settings.demandFactor = 1.5; });
  rig.frames(80);
  assert.equal(Fake.made, made, 'a runtime change is applied to the running simulation');
  assert.equal(rig.runner.sim, sim);
  rig.commit('Rename a station', (l) => { l.stations[0].name = 'Renamed'; });
  rig.until(() => rig.runner.warm && !rig.runner.priming);
  assert.equal(Fake.made, made + 1, 'a station rename IS a structural change and restarts (that is what WARM-1 is about)');
  assert.equal(typeof obstacle, 'boolean');
  rig.runner.destroy();
});

test('WARM-1: a restart that cannot change anything (renaming a station) must not produce a red or green verdict', { todo: 'js/ui/panels/impact.js classifyDelta + js/ui/runner.js baseline: the 3 % / 1 load-per-hour noise rule is far inside the run-to-run noise of a 10-20 minute window compared with a long baseline (measured: throughput up to 19-28 %, lead time 35 %, waiting 9 points); compare like with like (a control run of the old layout, pre-rolled the same way) or scale the threshold with the window' }, async () => {
  const verdicts = [];
  for (const id of ['starter', 'two-lines', 'congestion-lab']) {
    for (const seed of [1, 2, 3]) {
      const { rig, model } = await afterEdit({ id, seed, edit: (l) => { l.stations[0].name = 'Renamed station'; }, label: 'Rename station' });
      for (const row of model().rows) if (row.change.tone !== 'neutral') verdicts.push(`${id} seed ${seed}: ${row.label} ${row.pair} ${row.change.text} (${row.change.label}, window ${model().status.text})`);
      rig.runner.destroy();
    }
  }
  assert.equal(verdicts.length, 0, `a pure rename is shown ${verdicts.length} times (of 54 figures) as a change that is better or worse, e.g.\n  ${verdicts.slice(0, 8).join('\n  ')}`);
});

test('WARM-1b: the one-line hint under the simulation bar does not quote noise as a result either', { todo: 'same cause as WARM-1: impactHintText prints every non-neutral row, "Throughput 19.9 -> 18 /h (indicative)" for a rename' }, async () => {
  const { rig, model } = await afterEdit({ id: 'starter', seed: 1, edit: (l) => { l.stations[0].name = 'Renamed station'; }, label: 'Rename station' });
  const hint = impactHintText(model());
  assert.match(hint, /^No clear change/, hint);
  rig.runner.destroy();
});

test('WARM-2: a change that breaks the plant says so (nothing was finished) and does not call the traffic better', { todo: 'js/ui/panels/impact.js: with no driving at all "Time waiting in traffic 2.2 -> 0 %" is green "better" and lead time is "not comparable"; the card needs a note (no load finished since the change, check Checks) and a neutral traffic row when nothing drove' }, async () => {
  const { rig, model } = await afterEdit({
    id: 'starter', edit: (l) => { for (const key of Object.keys(l.roads)) { const [x, y] = key.split(',').map(Number); L.eraseRoadCell(l, x, y); } }, label: 'Erase all roads',
  });
  rig.until(() => rig.runner.kpis().window.duration >= 700);
  const m = model();
  const throughput = m.rows.find((r) => r.id === 'throughput');
  assert.equal(throughput.after, 0, 'the plant delivers nothing');
  assert.equal(throughput.change.tone, 'bad');
  assert.deepEqual(m.rows.filter((r) => r.change.tone === 'good').map((r) => `${r.label} ${r.pair}`), [], 'nothing about a plant that stands still is "better"');
  assert.match(m.note, /no load|nothing/i, `the card explains where to look: "${m.note}"`);
  rig.runner.destroy();
});

test('WARM-5: "Keep as baseline" while the numbers are not reliable must not throw the existing baseline away', { todo: 'js/ui/runner.js keepBaseline(): the refusal calls dismissBaseline(), so the click answers "nothing to keep" and the card disappears; return false and leave the baseline alone (also while priming)' }, async () => {
  const { rig } = await afterEdit({ id: 'starter', edit: (l) => { l.fleets[0].count += 1; }, label: 'More AGVs' });
  const base = rig.runner.baseline;
  assert.ok(base);
  rig.commit('Even more AGVs', (l) => { l.fleets[0].count += 1; });
  rig.until(() => rig.runner.priming);
  assert.equal(rig.runner.keepBaseline(), false, 'nothing reliable to keep while the replacement is being primed');
  assert.ok(rig.runner.baseline === base, 'but the comparison in progress stays (the baseline is now null)');
  rig.runner.destroy();
});

test('WARM-6: the baseline carries the plant it was measured on, so that "Compare properly..." can offer the old plant as a variant', { todo: 'js/ui/runner.js recordBaseline + js/ui/panels/impact.js: runner.baseline has { report, simTime, labels, edits } and no layout; the Experiments tab lists only the current plant ("Create a variant to compare"), so the promised run of the old and the new plant is impossible' }, async () => {
  const before = example('starter');
  const { rig } = await afterEdit({ id: 'starter', edit: (l) => { l.fleets[0].count += 1; }, label: 'More AGVs' });
  assert.ok(rig.runner.baseline.layout, 'baseline.layout');
  assert.equal(rig.runner.baseline.layout.fleets[0].count, before.fleets[0].count);
  rig.runner.destroy();
});

test('WARM-4: priming ends within a bounded wall-clock time however slow the plant is (and the planner is told how far it is)', { todo: 'js/ui/runner.js stepPriming: a 160 x 160 plant with 300 vehicles needs 13 s of engine time for the 1200 s pre-roll (Node), the old simulation stands still all that time and every further edit starts over; cap the pre-roll by wall-clock time (swap with what is done and call the figures indicative) and show primeProgress' }, async () => {
  const Fake = fakeSimClass({ capacity: 1 }); // one tick (0.1 s) per frame: a plant that is 100 times too slow for its pre-roll
  const rig = makeRig({ Sim: Fake });
  await rig.runTo(700);
  const first = rig.runner.sim;
  addSource(rig);
  const patience = 20000; // ms of wall-clock time the planner waits for an edit to show
  let frames = 0;
  while (rig.runner.sim === first && frames * 16 < patience + 600) { // + the 250 ms debounce and the first frames
    rig.frame(16);
    frames++;
  }
  assert.ok(rig.runner.sim !== first, `still priming after ${Math.round((frames * 16) / 1000)} s of wall-clock time (${Math.round(rig.runner.primeProgress * 100)} % of the pre-roll), the old simulation stands still`);
  rig.runner.destroy();
});

// ---------------------------------------------------------------------------------------------------------
// the unused-resource insights
// ---------------------------------------------------------------------------------------------------------

function simulate(layout, seconds) {
  const sim = new Simulation(layout);
  sim.advance(seconds);
  const report = sim.kpis();
  return { sim, report, insights: sim.insights(report) };
}

test('WARM-GUARD-I1: healthy examples (3 examples x 3 seeds x 1 h and 4 h) raise none of the four unused-resource insights', () => {
  const hits = [];
  for (const id of ['starter', 'two-lines', 'congestion-lab']) {
    for (const seed of [1, 2, 3]) {
      for (const hours of [1, 4]) {
        const layout = example(id);
        layout.settings.seed = seed;
        for (const i of simulate(layout, hours * 3600).insights) if (isNewRule(i.id)) hits.push(`${id} seed ${seed} ${hours} h: ${i.id}`);
      }
    }
  }
  assert.deepEqual(hits, []);
});

test('WARM-GUARD-I2: 24 random edited plants (fleet sizes, extra fleets, dispatch, restrictions): the unused rules never contradict the older ones', () => {
  const rng = createRng(777);
  const int = (a, b) => a + Math.floor(rng.next() * (b - a + 1));
  const pick = (list) => list[int(0, list.length - 1)];
  const problems = [];
  for (let n = 0; n < 24; n++) {
    const id = ['starter', 'two-lines', 'congestion-lab'][n % 3];
    const layout = example(id);
    layout.settings.seed = int(1, 1e6);
    layout.settings.dispatch = pick(['nearest', 'oldest', 'balanced']);
    for (const f of layout.fleets) L.updateFleet(layout, f.id, { count: int(1, 7) });
    const depots = layout.stations.filter((s) => s.type === 'depot');
    if (rng.next() < 0.6) L.addFleet(layout, pick(['agv', 'forklift', 'tugger']), { count: int(1, 5), home: depots.length ? pick(depots).id : null, idle: pick(['park', 'stay']) });
    if (rng.next() < 0.3 && layout.flows.length) L.updateFlow(layout, pick(layout.flows).id, { fleetId: pick(layout.fleets).id });
    const { insights } = simulate(layout, int(1200, 3 * 3600));
    const ids = insights.map((i) => i.id);
    for (const f of layout.fleets) {
      const has = (rule) => ids.includes(`${rule}:${f.id}`);
      if (has('fleet-unused') && (has('fleet-oversized') || has('fleet-saturated'))) problems.push(`${id} #${n}: unused together with oversized or saturated for ${f.id}`);
      if (has('vehicle-idle-some') && (has('fleet-unused') || has('fleet-oversized') || has('fleet-saturated'))) problems.push(`${id} #${n}: idle-some together with a fleet verdict for ${f.id}`);
    }
    if (ids.some((i) => i.startsWith('fleet-unused'))) {
      for (const i of insights.filter((x) => x.id.startsWith('fleet-saturated') && /add (a|one|more) vehicle|more vehicles/i.test(x.suggestion || ''))) problems.push(`${id} #${n}: ${i.id} asks for vehicles while a fleet is unused`);
    }
    for (const s of layout.stations.filter((x) => x.type === 'source')) {
      if (ids.includes(`source-unconnected-activity:${s.id}`) && ids.includes(`supply:${s.id}`)) problems.push(`${id} #${n}: ${s.id} is both unconnected and over-supplying`);
    }
  }
  assert.deepEqual(problems, []);
});

test('WARM-7: station-never-used does not blame the road for a destination behind a storage whose dwell is longer than the window', { todo: 'js/sim/insights.js neverUsedStations: the supplier is a storage with dwell 1800 s and the window is 20 min; "Most likely no vehicle can drive to its dock" is wrong, skip origins that hold their loads for at least the window (layout dwell is available through ctx.layout)' }, () => {
  const layout = example('starter');
  const assembly = layout.stations.find((s) => s.name === 'Assembly');
  const dispatch = layout.stations.find((s) => s.type === 'sink');
  L.removeFlow(layout, layout.flows.find((f) => f.from === assembly.id && f.to === dispatch.id).id);
  const store = L.addStation(layout, { type: 'storage', name: 'Curing store', x: 24, y: 20, w: 3, h: 2, params: { dwell: 1800, capacity: 50 } });
  assert.ok(store);
  assert.ok(L.addFlow(layout, assembly.id, store.id, {}));
  assert.ok(L.addFlow(layout, store.id, dispatch.id, {}));
  const { report, insights } = simulate(layout, 1800); // 30 min: a 20 min window, the first load leaves the store after 30 min of dwell
  assert.ok(report.window.duration >= 15 * 60);
  assert.deepEqual(insights.filter((i) => i.id.startsWith('station-never-used')).map((i) => `${i.id}: ${i.title} ${i.detail}`), []);
});

test('WARM-8: vehicle-idle-some agrees in number ("1 of 4 vehicles ... hardly works", "made none")', { todo: 'js/sim/insights.js idleVehicles: title and detail are written for the plural also when exactly one vehicle is quiet' }, () => {
  const layout = example('starter');
  layout.settings.seed = 5;
  L.updateFleet(layout, layout.fleets[0].id, { count: 4 });
  const { insights } = simulate(layout, 3 * 3600);
  const hit = insights.find((i) => i.id.startsWith('vehicle-idle-some'));
  assert.ok(hit, 'the scenario must raise the insight');
  assert.match(hit.title, /^1 of 4 vehicles in the AGV fleet hardly works\.$/);
  assert.doesNotMatch(hit.detail, /#\d+ \(\d+ trips?\) made far fewer trips than their /, hit.detail);
});

test('WARM-9: a single new vehicle that may serve no flow (Two lines: every flow is dedicated) is not silent', { todo: 'js/sim/insights.js: fleet-oversized needs 2 vehicles and fleet-unused needs other vehicles on the same flows, so one added vehicle with no job gets no insight and no badge in its strip; say "no flow may use this fleet" (the Fleet tab says it, Results do not)' }, () => {
  const layout = example('two-lines');
  const depot = layout.stations.find((s) => s.type === 'depot');
  const added = L.addFleet(layout, 'forklift', { name: 'New forklift', count: 1, home: depot.id });
  const { report, insights } = simulate(layout, 2 * 3600);
  assert.equal(report.fleets[added.id].trips, 0, 'it never gets a job');
  assert.deepEqual(insights.filter((i) => i.id.endsWith(`:${added.id}`)).map((i) => i.id).length > 0, true, 'some insight names the idle vehicle');
});

test('WARM-9b: the strip of a fleet the insights call mostly idle (two vehicles, no job) shows a badge', { todo: 'js/ui/panels/fleet-status.js usageBadge: only fleet-unused and vehicle-idle-some produce a badge; fleet-oversized with utilization ~0 says the same thing in Results and leaves the strip silent' }, () => {
  const layout = example('two-lines');
  const depot = layout.stations.find((s) => s.type === 'depot');
  const added = L.addFleet(layout, 'forklift', { name: 'New forklifts', count: 2, home: depot.id });
  const { insights } = simulate(layout, 2 * 3600);
  assert.ok(insights.some((i) => i.id === `fleet-oversized:${added.id}`), 'Results call the fleet mostly idle');
  assert.ok(usageBadge(insights, added.id), 'so the strip must say so too');
});

test('WARM-GUARD-X: the pre-roll length is what the documentation says and a slice is the documented budget', () => {
  assert.equal(PRIME_SLICE_MS, 12);
  assert.equal(REBUILD_DEBOUNCE_MS, 250);
  assert.equal(primeSeconds(600), 1200);
});
