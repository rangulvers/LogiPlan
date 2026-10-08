// Warm restart of the runner (js/ui/runner.js): an edit to a plant that has already run does not restart it from an empty plant, the
// replacement simulation is pre-rolled silently in time slices behind the displayed one and swapped in at once; the baseline
// of the change-impact card is kept across consecutive edits. Everything runs on a fake clock, fake animation frames and a fake
// Simulation (tests/ui.runner.test.js uses the same technique); the last tests use the real engine to prove determinism.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRunner, primeSeconds, isMeasured, PRIME_SLICE_MS, PRIME_MIN_SECONDS, PRIME_MAX_SECONDS, BASELINE_MIN_SECONDS, REBUILD_DEBOUNCE_MS,
  CONSTRUCT_SLOW_MS, MAX_LABELS,
} from '../js/ui/runner.js';
import { createStore } from '../js/store/store.js';
import * as L from '../js/model/layout.js';
import { EXAMPLES } from '../js/model/examples.js';
import { Simulation } from '../js/sim/engine.js';

// ---------------------------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------------------------

/** A Simulation stand-in with a KpiReport-shaped window. knobs: capacity (sim s per advance call), failConstruct, failAdvance, noProgress, constructMs. */
function createFakeSimClass(knobs, clock) {
  class FakeSim {
    constructor(layout) {
      if (knobs.failConstruct) throw new Error(knobs.failConstruct);
      if (knobs.constructMs) clock.t += knobs.constructMs;
      this.layout = layout;
      this.settings = layout.settings;
      this.dt = 0.1;
      this.ticks = 0;
      this.advances = [];
      this.runtimePatches = [];
      this.number = FakeSim.instances.length + 1;
      FakeSim.instances.push(this);
    }

    get time() {
      return this.ticks * this.dt;
    }

    advance(seconds, opts = {}) {
      this.advances.push({ seconds, maxMillis: opts.maxMillis, now: opts.now, from: this.time });
      if (knobs.failAdvance) throw new Error(knobs.failAdvance);
      if (!(seconds > 0) || knobs.noProgress) return 0;
      const wanted = Math.ceil((seconds - this.dt * 1e-6) / this.dt);
      const n = Math.max(0, Math.min(wanted, Math.floor((knobs.capacity ?? Infinity) / this.dt)));
      this.ticks += n;
      return n * this.dt;
    }

    setRuntime(patch) {
      this.runtimePatches.push(patch);
    }

    kpis() {
      const warmup = this.settings.warmup;
      const duration = Math.max(0, this.time - warmup);
      return {
        window: { start: Math.min(warmup, this.time), end: this.time, duration, warmingUp: this.time < warmup },
        throughput: { total: 0, perHour: 10 * this.number },
        sim: this.number,
      };
    }

    insights() {
      return [];
    }
  }
  FakeSim.instances = [];
  return FakeSim;
}

function makeHarness(opts = {}) {
  const knobs = { ...opts.knobs };
  const clock = { t: 5000 };
  const SimulationClass = opts.SimulationClass ?? createFakeSimClass(knobs, clock);
  let pending = null;
  let nextHandle = 0;
  const raf = (cb) => {
    pending = { handle: ++nextHandle, cb };
    return pending.handle;
  };
  const caf = (handle) => {
    if (pending && pending.handle === handle) pending = null;
  };
  const store = createStore({ storage: undefined });
  const renderer = { sim: null, layout: null, render() {} };
  const document = {
    hidden: false,
    listeners: new Set(),
    addEventListener(type, fn) { if (type === 'visibilitychange') this.listeners.add(fn); },
    removeEventListener(type, fn) { if (type === 'visibilitychange') this.listeners.delete(fn); },
    fire() { for (const fn of [...this.listeners]) fn(); },
  };
  const errors = [];
  const runner = createRunner({
    store, renderer, raf, caf, now: () => clock.t, document, SimulationClass, onError: (err, context) => errors.push({ err, context }),
    speed: opts.speed,
  });
  const events = [];
  for (const name of ['state', 'frame', 'kpis', 'rebuild', 'baseline', 'error']) runner.on(name, (payload) => events.push([name, payload]));
  const h = {
    knobs, clock, store, renderer, document, runner, events, errors, SimulationClass,
    frame(ms = 16) {
      assert.ok(pending, 'a frame must be scheduled');
      clock.t += ms;
      const { cb } = pending;
      pending = null;
      cb(clock.t);
    },
    frames(n, ms = 16) {
      for (let i = 0; i < n; i++) h.frame(ms);
    },
    /** Run frames until `cond()` holds (at most `max`); returns the number of frames it took. */
    until(cond, max = 400) {
      for (let i = 0; i < max; i++) {
        if (cond()) return i;
        h.frame();
      }
      assert.fail('the condition was not reached');
      return max;
    },
    of: (name) => events.filter(([n]) => n === name).map(([, payload]) => payload),
    sims: () => SimulationClass.instances,
    pending: () => pending,
  };
  let n = 0;
  /** A structural edit with a readable label: one more source station. */
  h.edit = (label = 'Add Goods in') => {
    const i = n++;
    return store.commit(label, (l) => { L.addStation(l, { type: 'source', x: 2 + 5 * (i % 8), y: 2 + 5 * Math.floor(i / 8) }); });
  };
  return h;
}

/** Play with a primed frame loop and run for about `seconds` of simulated time. */
async function runFor(h, seconds, speed = 1200) {
  h.frame(16);
  h.runner.setSpeed(speed);
  assert.equal(await h.runner.play(), true);
  h.until(() => h.runner.time >= seconds, 2000);
}

/** Make a structural edit and run frames until the debounce is over and priming has started. */
function editAndStartPriming(h, label) {
  h.edit(label);
  h.until(() => h.runner.priming || h.sims().length > 1);
}

// ---------------------------------------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------------------------------------

test('primeSeconds: warm-up plus 10 minutes, at least 10 and at most 40 minutes', () => {
  assert.equal(primeSeconds(600), 1200);
  assert.equal(primeSeconds(0), PRIME_MIN_SECONDS);
  assert.equal(primeSeconds(-5), PRIME_MIN_SECONDS);
  assert.equal(primeSeconds(60), 660);
  assert.equal(primeSeconds(1800), PRIME_MAX_SECONDS);
  assert.equal(primeSeconds(100000), PRIME_MAX_SECONDS);
  assert.equal(primeSeconds(NaN), PRIME_MIN_SECONDS);
  assert.equal(PRIME_MAX_SECONDS, 2400);
  assert.equal(PRIME_SLICE_MS, 12);
});

test('isMeasured: a finished warm-up and at least ten measured minutes (tolerating tick rounding)', () => {
  const report = (duration, warmingUp = false) => ({ window: { duration, warmingUp } });
  assert.equal(BASELINE_MIN_SECONDS, 600);
  assert.equal(isMeasured(report(600)), true);
  assert.equal(isMeasured(report(599.5)), true);
  assert.equal(isMeasured(report(598)), false);
  assert.equal(isMeasured(report(5000, true)), false);
  assert.equal(isMeasured(report(NaN)), false);
  assert.equal(isMeasured({}), false);
  assert.equal(isMeasured(null), false);
});

// ---------------------------------------------------------------------------------------------------------
// the warm restart itself
// ---------------------------------------------------------------------------------------------------------

test('an edit to a plant that has run is pre-rolled behind the displayed simulation and swapped in at once', async () => {
  const h = makeHarness({ knobs: { capacity: 300 } });
  await runFor(h, 100);
  const first = h.runner.sim;
  assert.ok(first.time >= 100);
  h.edit('Add fleet');
  h.frames(Math.floor(REBUILD_DEBOUNCE_MS / 16)); // 240 ms
  assert.equal(h.sims().length, 1, 'still debouncing');
  assert.equal(h.runner.priming, false);
  h.frame();
  assert.equal(h.sims().length, 2, 'priming has started');
  const second = h.sims()[1];
  const frozenAt = first.time; // the old simulation ran on while the edit was debounced, and stands still from here
  assert.equal(h.runner.priming, true);
  assert.equal(h.runner.sim, first, 'the previous simulation stays on screen');
  assert.equal(h.renderer.sim, first);
  assert.equal(second.layout, h.store.getState().layout);

  // the first slice ran in the same frame: 300 s of 1200 s
  assert.equal(second.time, 300);
  assert.ok(Math.abs(h.runner.primeProgress - 0.25) < 1e-9, `progress ${h.runner.primeProgress}`);
  const firstAdvances = first.advances.length;
  const snapshots = [];
  while (h.runner.priming) {
    h.frame();
    snapshots.push([h.runner.sim === first, first.time, h.runner.priming]);
  }
  // priming took three more frames (300 s each); the displayed simulation never moved meanwhile
  assert.deepEqual(snapshots.map(([displayed]) => displayed), [true, true, false]);
  assert.ok(snapshots.every(([, time]) => time === frozenAt), 'the clock of the displayed simulation stood still');
  assert.equal(first.advances.length, firstAdvances, 'the old simulation was not advanced while priming');
  assert.equal(h.runner.sim, second);
  assert.equal(h.renderer.sim, second);
  assert.equal(second.time, 1200, 'the new simulation is shown after its pre-roll, not at 0:00');
  assert.equal(h.runner.time, 1200);
  assert.equal(h.runner.primeProgress, 0);
  assert.equal(h.runner.playing, true);
  assert.deepEqual(h.runner.warm, { preRoll: 1200 });

  // each slice asks the engine for the rest of the pre-roll with the slice budget and the runner's clock
  for (const call of second.advances) {
    assert.equal(call.maxMillis, PRIME_SLICE_MS);
    assert.equal(typeof call.now, 'function');
  }
  assert.deepEqual(second.advances.map((c) => c.from), [0, 300, 600, 900]);

  const rebuild = h.of('rebuild').at(-1);
  assert.equal(rebuild.reason, 'structural');
  assert.equal(rebuild.warm, true);
  assert.equal(rebuild.label, 'Add fleet');
  assert.deepEqual(rebuild.labels, ['Add fleet']);
  assert.equal(rebuild.sim, second);
  assert.equal(rebuild.previous.simTime, frozenAt);
  assert.equal(rebuild.previous.report.sim, 1, 'the report of the replaced simulation');
  assert.equal(rebuild.baseline, false, 'the old simulation had run for less than ten minutes: nothing reliable to compare against');

  // and it goes on from the pre-roll time
  h.frames(10);
  assert.ok(second.time > 1200);
});

test('a frame that primes does one slice and does not advance the displayed simulation', async () => {
  const h = makeHarness({ knobs: { capacity: 100 } });
  await runFor(h, 50);
  const first = h.runner.sim;
  editAndStartPriming(h, 'Add fleet');
  const before = first.advances.length;
  const t = first.time;
  h.frames(3);
  assert.equal(first.advances.length, before);
  assert.equal(first.time, t);
  assert.equal(h.runner.priming, true);
  assert.ok(h.runner.primeProgress > 0 && h.runner.primeProgress < 1);
  const second = h.sims()[1];
  const calls = second.advances.length;
  h.frame();
  assert.equal(second.advances.length, calls + 1, 'exactly one slice per frame');
});

test('a slow construction uses up its frame; the first slice comes with the next one', async () => {
  const h = makeHarness({ knobs: { capacity: 100 } });
  await runFor(h, 50);
  h.knobs.constructMs = CONSTRUCT_SLOW_MS + 6;
  h.edit('Add fleet');
  h.until(() => h.sims().length > 1);
  const second = h.sims()[1];
  assert.equal(second.advances.length, 0, 'no slice in the frame that built the simulation');
  assert.equal(h.runner.priming, true);
  h.frame();
  assert.equal(second.advances.length, 1);
});

test('an engine that cannot go further does not keep the runner priming for ever', async () => {
  const h = makeHarness({ knobs: { capacity: 300 } });
  await runFor(h, 50);
  h.knobs.noProgress = true;
  editAndStartPriming(h, 'Add fleet');
  h.frames(3);
  assert.equal(h.runner.priming, false);
  assert.equal(h.runner.sim, h.sims()[1]);
});

test('an edit during priming throws the half-primed simulation away and primes again from the newest layout', async () => {
  const h = makeHarness({ knobs: { capacity: 200 } });
  await runFor(h, 100);
  const first = h.runner.sim;
  editAndStartPriming(h, 'Add fleet');
  h.frames(2);
  assert.equal(h.runner.priming, true);
  h.edit('Add Goods out');
  assert.equal(h.runner.priming, false, 'the half-primed simulation is stale');
  assert.equal(h.runner.sim, first, 'and the displayed one still stands');
  assert.equal(h.sims().length, 2);
  h.until(() => h.runner.priming);
  assert.equal(h.sims().length, 3);
  assert.equal(h.sims()[2].layout, h.store.getState().layout, 'built from the newest layout');
  h.until(() => !h.runner.priming);
  assert.equal(h.runner.sim, h.sims()[2]);
  assert.ok(!h.of('rebuild').some((e) => e.sim === h.sims()[1]), 'the stale simulation was never shown');
  assert.deepEqual(h.of('rebuild').at(-1).labels, ['Add fleet', 'Add Goods out']);
  assert.equal(h.of('rebuild').at(-1).label, 'Add fleet, Add Goods out');
});

test('undoing the edit during priming cancels the restart', async () => {
  const h = makeHarness({ knobs: { capacity: 200 } });
  await runFor(h, 100);
  const first = h.runner.sim;
  editAndStartPriming(h, 'Add fleet');
  h.frames(2);
  h.store.undo();
  assert.equal(h.runner.priming, false);
  h.frames(60);
  assert.equal(h.runner.sim, first);
  assert.equal(h.sims().length, 2);
  assert.equal(h.runner.baseline, null);
});

test('an edit that cannot change a result (the plant name) does not restart a primed simulation', async () => {
  const h = makeHarness({ knobs: { capacity: 200 } });
  await runFor(h, 100);
  editAndStartPriming(h, 'Add fleet');
  h.frames(2);
  const second = h.sims()[1];
  h.store.commit('Rename plant', (l) => { l.name = 'Another name'; });
  assert.equal(h.runner.priming, true);
  h.until(() => !h.runner.priming);
  assert.equal(h.sims().length, 2);
  assert.equal(h.runner.sim, second);
  assert.deepEqual(h.of('rebuild').at(-1).labels, ['Add fleet'], 'a rename is no edit worth naming');
});

test('a runtime edit during priming restarts it (the pre-roll would have used the old factor)', async () => {
  const h = makeHarness({ knobs: { capacity: 200 } });
  await runFor(h, 100);
  editAndStartPriming(h, 'Add fleet');
  h.frames(2);
  h.store.commit('Demand', (l) => { l.settings.demandFactor = 2; });
  assert.equal(h.runner.priming, false);
  h.until(() => h.runner.priming);
  h.until(() => !h.runner.priming);
  assert.equal(h.runner.sim.layout.settings.demandFactor, 2);
});

test('a paused simulation is warm-restarted too and stays paused', async () => {
  const h = makeHarness({ knobs: { capacity: 600 } });
  await runFor(h, 100);
  h.runner.pause();
  const first = h.runner.sim;
  h.edit('Add fleet');
  h.until(() => h.runner.sim !== first);
  assert.equal(h.runner.playing, false);
  assert.equal(h.runner.time, 1200);
});

test('a step() asked for during priming goes on in the new simulation', async () => {
  const h = makeHarness({ knobs: { capacity: 300 } });
  await runFor(h, 100);
  h.runner.pause();
  editAndStartPriming(h, 'Add fleet');
  const stepping = h.runner.step(5);
  h.until(() => h.runner.sim === h.sims()[1]);
  let advanced = null;
  stepping.then((v) => { advanced = v; });
  h.frames(10);
  await Promise.resolve();
  assert.ok(advanced >= 5, `advanced ${advanced}`);
  assert.ok(h.runner.sim.time >= 1205);
});

test('play() during priming just plays: the displayed simulation waits for the swap', async () => {
  const h = makeHarness({ knobs: { capacity: 300 } });
  await runFor(h, 100);
  h.runner.pause();
  editAndStartPriming(h, 'Add fleet');
  assert.equal(await h.runner.play(), true);
  assert.equal(h.runner.playing, true);
  h.until(() => !h.runner.priming);
  const second = h.runner.sim;
  const t = second.time;
  h.frames(5);
  assert.ok(second.time > t, 'running on the new simulation');
});

// ---------------------------------------------------------------------------------------------------------
// what stays a cold start
// ---------------------------------------------------------------------------------------------------------

test('the first play of a plant is a cold start from time 0', async () => {
  const h = makeHarness();
  h.frame();
  await h.runner.play();
  assert.equal(h.runner.sim.time, 0);
  assert.equal(h.runner.warm, null);
  assert.deepEqual(h.of('rebuild').map((e) => [e.reason, e.warm]), [['create', false]]);
});

test('reset() is a cold start: empty plant at 0:00, no baseline, priming cancelled', async () => {
  const h = makeHarness({ knobs: { capacity: 600 } });
  await runFor(h, 1500);
  h.edit('Add fleet');
  h.until(() => h.runner.baseline !== null);
  assert.ok(h.runner.baseline);
  h.edit('Add Goods out');
  h.until(() => h.runner.priming);
  h.runner.reset();
  assert.equal(h.runner.priming, false);
  assert.equal(h.runner.baseline, null);
  assert.equal(h.runner.warm, null);
  assert.equal(h.runner.sim.time, 0);
  const rebuild = h.of('rebuild').at(-1);
  assert.equal(rebuild.reason, 'reset');
  assert.equal(rebuild.warm, false);
  assert.equal(rebuild.baseline, false);
  h.frames(60);
  assert.equal(h.runner.priming, false, 'the cancelled priming never comes back');
  assert.equal(h.sims().filter((s) => s === h.runner.sim).length, 1);
});

test('an edit before anything has run (clock at 0) rebuilds cold', async () => {
  const h = makeHarness();
  h.frame();
  await h.runner.play();
  h.runner.pause();
  assert.equal(h.runner.time, 0);
  h.edit('Add fleet');
  h.until(() => h.sims().length > 1);
  assert.equal(h.runner.sim, h.sims()[1]);
  assert.equal(h.runner.time, 0);
  assert.equal(h.runner.priming, false);
  assert.equal(h.of('rebuild').at(-1).warm, false);
});

test('with the preference off an edit restarts from an empty plant at once (the old behaviour)', async () => {
  const h = makeHarness({ knobs: { capacity: 600 } });
  await runFor(h, 100);
  h.store.setUi({ warmRestart: false });
  h.edit('Add fleet');
  h.until(() => h.sims().length > 1);
  assert.equal(h.runner.priming, false);
  assert.equal(h.runner.sim, h.sims()[1]);
  assert.ok(h.runner.sim.time < 50, `time ${h.runner.sim.time}`);
  assert.equal(h.of('rebuild').at(-1).warm, false);
  assert.equal(h.of('rebuild').at(-1).label, 'Add fleet');
  assert.equal(h.runner.baseline, null);
  assert.equal(h.runner.playing, true);
});

test('the preference is read when the rebuild happens: switching it off during the debounce gives a cold restart', async () => {
  const h = makeHarness({ knobs: { capacity: 600 } });
  await runFor(h, 100);
  h.edit('Add fleet');
  h.frames(3);
  h.store.setUi({ warmRestart: false });
  h.until(() => h.sims().length > 1);
  assert.equal(h.runner.priming, false);
  assert.ok(h.runner.sim.time < 50, `time ${h.runner.sim.time}`);
});

test('loading another plant or switching to another variant is a cold start, not an edit', async () => {
  const h = makeHarness({ knobs: { capacity: 600 } });
  await runFor(h, 100);
  const other = L.createLayout({ name: 'Other plant' });
  L.addStation(other, { type: 'sink', x: 4, y: 4 });
  h.store.addScenario('B', other);
  h.until(() => h.sims().length > 1);
  assert.equal(h.runner.priming, false);
  assert.ok(h.runner.sim.time < 50, `time ${h.runner.sim.time}`);
  assert.equal(h.runner.sim.layout.name, 'Other plant');
  assert.equal(h.of('rebuild').at(-1).warm, false);
  assert.equal(h.of('rebuild').at(-1).label, '', 'no edit label: it is another plant');
  h.frames(30);
  h.store.newProject(L.createLayout({ name: 'Third plant' }));
  h.until(() => h.sims().length > 2);
  assert.equal(h.runner.sim.layout.name, 'Third plant');
  assert.equal(h.runner.priming, false);
});

test('nothing is primed before the first play, whatever the layout does', () => {
  const h = makeHarness();
  h.edit('Add fleet');
  h.frames(40);
  assert.equal(h.sims().length, 0);
  assert.equal(h.runner.priming, false);
});

// ---------------------------------------------------------------------------------------------------------
// tab visibility, destroy, errors
// ---------------------------------------------------------------------------------------------------------

test('a long warm-up is not pre-rolled to its end: the pre-roll stops at 40 minutes and the new simulation is still warming up', async () => {
  const h = makeHarness({ knobs: { capacity: 3000 } });
  await runFor(h, 100);
  h.store.commit('Longer warm-up', (l) => { l.settings.warmup = 3600; });
  const first = h.runner.sim;
  h.until(() => h.runner.sim !== first);
  assert.equal(h.runner.sim.time, PRIME_MAX_SECONDS);
  assert.equal(h.runner.kpis().window.warmingUp, true, 'Results honestly say it is still warming up');
  assert.deepEqual(h.runner.warm, { preRoll: PRIME_MAX_SECONDS });
});

test('a hidden tab does not prime; priming goes on when the tab is back', async () => {
  const h = makeHarness({ knobs: { capacity: 300 } });
  await runFor(h, 100);
  editAndStartPriming(h, 'Add fleet');
  const second = h.sims()[1];
  h.document.hidden = true;
  h.document.fire();
  assert.equal(h.runner.playing, false, 'the tab was hidden: the simulation paused');
  const calls = second.advances.length;
  h.frames(10);
  assert.equal(second.advances.length, calls, 'no slice while hidden');
  assert.equal(h.runner.priming, true);
  h.document.hidden = false;
  h.until(() => !h.runner.priming);
  assert.equal(h.runner.sim, second);
  assert.equal(h.runner.playing, false, 'and it stays paused');
});

test('destroy() in the middle of priming stops all work', async () => {
  const h = makeHarness({ knobs: { capacity: 300 } });
  await runFor(h, 100);
  editAndStartPriming(h, 'Add fleet');
  const second = h.sims()[1];
  const calls = second.advances.length;
  h.runner.destroy();
  assert.equal(h.runner.priming, false);
  assert.equal(h.runner.primeProgress, 0);
  assert.equal(h.pending(), null, 'the frame loop is cancelled');
  assert.equal(h.renderer.sim, null);
  assert.equal(second.advances.length, calls);
  assert.doesNotThrow(() => h.runner.destroy());
});

test('a rebuild listener may destroy the runner at the moment of the swap', async () => {
  const h = makeHarness({ knobs: { capacity: 600 } });
  await runFor(h, 100);
  h.runner.on('rebuild', (e) => { if (e.warm) h.runner.destroy(); });
  h.edit('Add fleet');
  assert.doesNotThrow(() => h.until(() => h.pending() === null, 60));
  assert.equal(h.renderer.sim, null);
  assert.deepEqual(h.errors, []);
});

test('a construction error while priming drops the simulation like any failed rebuild', async () => {
  const h = makeHarness({ knobs: { capacity: 300 } });
  await runFor(h, 100);
  h.knobs.failConstruct = 'bad layout';
  h.edit('Add fleet');
  h.until(() => h.runner.sim === null);
  assert.equal(h.runner.playing, false);
  assert.equal(h.runner.priming, false);
  assert.equal(h.renderer.sim, null);
  assert.equal(h.of('error')[0].phase, 'create');
  assert.deepEqual(h.of('rebuild').at(-1), { reason: 'structural', sim: null });
});

test('an engine error while priming reports it and keeps the loop alive', async () => {
  const h = makeHarness({ knobs: { capacity: 300 } });
  await runFor(h, 100);
  editAndStartPriming(h, 'Add fleet');
  h.knobs.failAdvance = 'boom';
  h.frame();
  assert.equal(h.runner.sim, null);
  assert.equal(h.runner.priming, false);
  assert.equal(h.of('error')[0].phase, 'advance');
  assert.ok(h.pending(), 'the loop goes on');
});

// ---------------------------------------------------------------------------------------------------------
// the baseline
// ---------------------------------------------------------------------------------------------------------

test('the first warm restart after 10 measured minutes stores the old report as baseline, with the edit label', async () => {
  const h = makeHarness({ knobs: { capacity: 2400 } });
  await runFor(h, 1300);
  const first = h.runner.sim;
  assert.equal(h.runner.baseline, null);
  h.edit('Add fleet');
  h.until(() => h.runner.sim !== first);
  const b = h.runner.baseline;
  assert.ok(b);
  assert.equal(b.report.sim, 1);
  assert.ok(isMeasured(b.report));
  assert.deepEqual(b.labels, ['Add fleet']);
  assert.equal(b.edits, 1);
  assert.equal(b.simTime, first.time);
  assert.equal(h.of('baseline').length, 1);
  assert.equal(h.of('baseline')[0], b);
});

test('consecutive edits keep the ORIGINAL baseline and collect all labels', async () => {
  const h = makeHarness({ knobs: { capacity: 2400 } });
  await runFor(h, 1300);
  h.edit('Add fleet');
  h.until(() => h.runner.baseline !== null && !h.runner.priming);
  const original = h.runner.baseline.report;
  h.frames(40);
  h.edit('Connect Goods in 2 → Assembly');
  const second = h.runner.sim;
  h.until(() => h.runner.sim !== second);
  h.frames(20);
  h.edit('Add Goods out');
  const third = h.runner.sim;
  h.until(() => h.runner.sim !== third);
  const b = h.runner.baseline;
  assert.equal(b.report, original, 'the very same numbers as after the first edit');
  assert.deepEqual(b.labels, ['Add fleet', 'Connect Goods in 2 → Assembly', 'Add Goods out']);
  assert.equal(b.edits, 3);
  assert.equal(h.of('rebuild').at(-1).label, 'Add Goods out');
});

test('the same label twice (typing in a field) is listed once; undo and redo are named as such', async () => {
  const h = makeHarness({ knobs: { capacity: 2400 } });
  await runFor(h, 1300);
  h.edit('Change vehicle count');
  h.edit('Change vehicle count');
  h.until(() => h.runner.baseline !== null && !h.runner.priming);
  assert.deepEqual(h.runner.baseline.labels, ['Change vehicle count']);
  const sim = h.runner.sim;
  h.store.undo();
  h.until(() => h.runner.sim !== sim);
  assert.deepEqual(h.runner.baseline.labels, ['Change vehicle count', 'Undo Change vehicle count']);
});

test('no baseline when the replaced simulation had measured less than ten minutes', async () => {
  const h = makeHarness({ knobs: { capacity: 2400 } });
  await runFor(h, 900); // 15 min on the clock = 5 min measured
  const first = h.runner.sim;
  h.edit('Add fleet');
  h.until(() => h.runner.sim !== first);
  assert.equal(h.runner.baseline, null);
  assert.equal(h.of('baseline').length, 0);
  assert.equal(h.of('rebuild').at(-1).baseline, false);
});

test('no baseline while the replaced simulation was still warming up', async () => {
  const h = makeHarness({ knobs: { capacity: 2400 } });
  await runFor(h, 300);
  const first = h.runner.sim;
  h.edit('Add fleet');
  h.until(() => h.runner.sim !== first);
  assert.equal(h.runner.baseline, null);
});

test('keepBaseline() promotes the current numbers; the next edit is compared against them', async () => {
  const h = makeHarness({ knobs: { capacity: 2400 } });
  await runFor(h, 1300);
  h.edit('Add fleet');
  h.until(() => h.runner.baseline !== null && !h.runner.priming);
  h.frames(30);
  const old = h.runner.baseline;
  assert.equal(h.runner.keepBaseline(), true);
  const kept = h.runner.baseline;
  assert.notEqual(kept, old);
  assert.deepEqual(kept.labels, [], 'the card has nothing to name any more');
  assert.equal(kept.report.sim, 2, 'the numbers of the simulation that runs now');
  assert.equal(h.of('baseline').at(-1), kept);
  const second = h.runner.sim;
  h.edit('Add Goods out');
  h.until(() => h.runner.sim !== second);
  assert.equal(h.runner.baseline.report, kept.report);
  assert.deepEqual(h.runner.baseline.labels, ['Add Goods out']);
});

test('dismissBaseline() drops it; the next edit takes the numbers of the simulation it replaces', async () => {
  const h = makeHarness({ knobs: { capacity: 2400 } });
  await runFor(h, 1300);
  h.edit('Add fleet');
  h.until(() => h.runner.baseline !== null && !h.runner.priming);
  assert.equal(h.runner.dismissBaseline(), true);
  assert.equal(h.runner.baseline, null);
  assert.equal(h.runner.dismissBaseline(), false, 'nothing left to drop');
  h.frames(30);
  const second = h.runner.sim;
  h.edit('Add Goods out');
  h.until(() => h.runner.sim !== second);
  assert.equal(h.runner.baseline.report.sim, 2, 'compared with the simulation before this edit, not the original one');
  assert.deepEqual(h.runner.baseline.labels, ['Add Goods out']);
});

test('keepBaseline() with numbers that are not reliable yet just drops the baseline', async () => {
  const h = makeHarness({ knobs: { capacity: 2400, } });
  await runFor(h, 1300);
  h.edit('Add fleet');
  h.until(() => h.runner.baseline !== null && !h.runner.priming);
  h.knobs.capacity = 0.1;
  h.runner.reset();
  assert.equal(h.runner.baseline, null);
  assert.equal(h.runner.keepBaseline(), false);
  assert.equal(h.runner.baseline, null);
});

test('the label list is bounded', async () => {
  const h = makeHarness({ knobs: { capacity: 2400 } });
  await runFor(h, 1300);
  for (let i = 0; i < MAX_LABELS + 5; i++) {
    const sim = h.runner.sim;
    h.edit(`Edit number ${i}`);
    h.until(() => h.runner.sim !== sim);
  }
  assert.equal(h.runner.baseline.labels.length, MAX_LABELS);
  assert.equal(h.runner.baseline.labels[0], 'Edit number 0', 'the first edit explains the baseline best');
});

test('many edits in one go are named in words: three at most, then "and n more"', async () => {
  const h = makeHarness({ knobs: { capacity: 2400 } });
  await runFor(h, 1300);
  for (const label of ['Add fleet', 'Add Goods in', 'Add Goods out', 'Add Storage']) h.edit(label);
  h.until(() => h.runner.baseline !== null && !h.runner.priming);
  assert.equal(h.of('rebuild').at(-1).label, 'Add fleet, Add Goods in and 2 more');
  assert.equal(h.of('rebuild').at(-1).labels.length, 4);
});

// ---------------------------------------------------------------------------------------------------------
// determinism, with the real engine
// ---------------------------------------------------------------------------------------------------------

test('the pre-roll does not depend on how it is cut into slices: same layout and seed give the same state', async () => {
  const calls = [];
  class SpySim extends Simulation {
    advance(seconds, opts) {
      calls.push(opts && opts.maxMillis);
      return super.advance(seconds, opts);
    }
  }
  // a clock that moves with every reading cuts the engine's time budget into many small slices
  const clock = { t: 5000 };
  let pending = null;
  const store = createStore({ storage: undefined });
  store.replaceLayout(EXAMPLES[0].build(), { label: 'Load example' });
  const renderer = { sim: null, layout: null, render() {} };
  const runner = createRunner({
    store, renderer, raf: (cb) => { pending = cb; return 1; }, caf: () => { pending = null; }, document: null, SimulationClass: SpySim,
    now: () => { clock.t += 0.2; return clock.t; },
  });
  const frame = () => { const cb = pending; pending = null; cb(clock.t += 16); };
  frame();
  runner.setSpeed(600);
  await runner.play();
  for (let i = 0; i < 40; i++) frame();
  assert.ok(runner.sim.time > 100);
  store.commit('One more AGV', (l) => { l.fleets[0].count += 1; });
  let guard = 0;
  while (!runner.warm && guard++ < 2000) frame();
  assert.ok(runner.warm, 'the restart finished');
  const sliced = calls.filter((m) => m === PRIME_SLICE_MS).length;
  assert.ok(sliced > 3, `the pre-roll was cut into ${sliced} slices`);

  const layout = store.getState().layout;
  const reference = new Simulation(layout);
  reference.advance(primeSeconds(layout.settings.warmup));
  assert.equal(runner.warm.preRoll, reference.time);
  // the runner went on from the pre-roll for a frame or two at most: compare at the pre-roll time itself
  const probe = new Simulation(layout);
  while (probe.time < reference.time) probe.advance(Math.min(7.3, reference.time - probe.time));
  assert.deepEqual(JSON.parse(JSON.stringify(probe.kpis())), JSON.parse(JSON.stringify(reference.kpis())));
  assert.equal(runner.sim.seed, reference.seed);
  runner.destroy();
});

test('a warm restart reaches the same state as a straight run of the new layout (state and results)', async () => {
  const store = createStore({ storage: undefined });
  store.replaceLayout(EXAMPLES[0].build(), { label: 'Load example' });
  const renderer = { sim: null, layout: null, render() {} };
  let pending = null;
  let t = 5000;
  const runner = createRunner({ store, renderer, raf: (cb) => { pending = cb; return 1; }, caf: () => {}, document: null, now: () => t });
  const frame = () => { const cb = pending; pending = null; t += 16; cb(t); };
  frame();
  runner.setSpeed(600);
  await runner.play();
  for (let i = 0; i < 30; i++) frame();
  store.commit('One more AGV', (l) => { l.fleets[0].count += 1; });
  let guard = 0;
  while (!runner.warm && guard++ < 2000) frame();
  assert.ok(runner.warm);
  const layout = store.getState().layout;
  const direct = new Simulation(layout);
  direct.advance(runner.sim.time);
  assert.equal(direct.time, runner.sim.time);
  assert.deepEqual(JSON.parse(JSON.stringify(runner.sim.kpis())), JSON.parse(JSON.stringify(direct.kpis())));
  assert.equal(runner.sim.logistics.liveLoads, direct.logistics.liveLoads);
  assert.equal(runner.sim.vehicles.length, direct.vehicles.length);
  assert.ok(runner.kpis().window.duration >= 599 && !runner.kpis().window.warmingUp, 'the statistics window is running at the swap');
  runner.destroy();
});
