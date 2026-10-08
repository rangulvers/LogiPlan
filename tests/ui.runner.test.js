import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRunner, SPEEDS, DEFAULT_SPEED, REBUILD_DEBOUNCE_MS, FRAME_BUDGET_MS, LIMITED_AFTER_MS, KPI_INTERVAL_MS,
} from '../js/ui/runner.js';
import { createStore } from '../js/store/store.js';
import * as L from '../js/model/layout.js';
import { EXAMPLES } from '../js/model/examples.js';

// ---------------------------------------------------------------------------------------------------------
// harness: fake animation frames, fake clock, fake Simulation (mimics the engine: whole ticks, rounded up)
// ---------------------------------------------------------------------------------------------------------

/** A Simulation stand-in. `knobs` can be changed while a test runs: capacity (sim seconds per advance call), failConstruct, failAdvance, failKpis. */
function createFakeSimClass(knobs = {}) {
  class FakeSim {
    constructor(layout) {
      if (knobs.failConstruct) throw new Error(knobs.failConstruct);
      this.layout = layout;
      this.dt = knobs.dt ?? 0.1;
      this.ticks = 0;
      this.busy = false;
      this.advances = [];
      this.runtimePatches = [];
      this.kpiCalls = 0;
      this.insightArgs = [];
      FakeSim.instances.push(this);
    }

    get time() {
      return this.ticks * this.dt;
    }

    advance(seconds, opts = {}) {
      this.advances.push({ seconds, maxMillis: opts.maxMillis, now: opts.now });
      if (knobs.failAdvance) throw new Error(knobs.failAdvance);
      if (!(seconds > 0)) return 0;
      const wanted = Math.ceil((seconds - this.dt * 1e-6) / this.dt);
      const n = Math.max(0, Math.min(wanted, Math.floor((knobs.capacity ?? Infinity) / this.dt)));
      this.busy = true;
      this.ticks += n;
      this.busy = false;
      return n * this.dt;
    }

    setRuntime(patch) {
      this.runtimePatches.push(patch);
    }

    kpis() {
      this.kpiCalls++;
      if (knobs.failKpis) throw new Error(knobs.failKpis);
      return { at: this.time, call: this.kpiCalls };
    }

    insights(report) {
      this.insightArgs.push(report);
      return [{ id: 'insight', at: this.time }];
    }
  }
  FakeSim.instances = [];
  return FakeSim;
}

function makeHarness(opts = {}) {
  const knobs = { ...opts.knobs };
  const SimulationClass = 'SimulationClass' in opts ? opts.SimulationClass : createFakeSimClass(knobs);
  const clock = { t: 5000 };
  let pending = null;
  let nextHandle = 0;
  const cancelled = [];
  const raf = (cb) => {
    pending = { handle: ++nextHandle, cb };
    return pending.handle;
  };
  const caf = (handle) => {
    cancelled.push(handle);
    if (pending && pending.handle === handle) pending = null;
  };
  const store = createStore({ storage: undefined });
  const renderer = {
    sim: null,
    layout: null,
    alphas: [],
    failRender: null,
    render(alpha) {
      this.alphas.push(alpha);
      if (this.failRender) throw this.failRender;
    },
  };
  const visibility = new Set();
  const document = {
    hidden: false,
    addEventListener: (type, fn) => type === 'visibilitychange' && visibility.add(fn),
    removeEventListener: (type, fn) => type === 'visibilitychange' && visibility.delete(fn),
    fire() {
      for (const fn of [...visibility]) fn();
    },
  };
  const listenerErrors = [];
  const runner = createRunner({
    store: opts.wrapStore ? opts.wrapStore(store) : store,
    renderer,
    raf,
    caf,
    now: () => clock.t,
    document,
    SimulationClass: SimulationClass ?? undefined,
    onError: (err, context) => listenerErrors.push({ err, context }),
    ...(opts.runner || {}),
  });
  const events = [];
  for (const name of ['state', 'frame', 'kpis', 'rebuild', 'error']) {
    if (name === 'error' && opts.observeErrors === false) continue;
    runner.on(name, (payload) => events.push([name, payload]));
  }
  const harness = {
    knobs, SimulationClass, clock, store, renderer, document, runner, events, listenerErrors, cancelled, visibility,
    pending: () => pending,
    /** Run one animation frame `ms` milliseconds after the previous one. */
    frame(ms = 16) {
      assert.ok(pending, 'a frame must be scheduled');
      clock.t += ms;
      const { cb } = pending;
      pending = null;
      cb(clock.t);
    },
    frames(n, ms = 16) {
      for (let i = 0; i < n; i++) harness.frame(ms);
    },
    of: (name) => events.filter(([n]) => n === name).map(([, payload]) => payload),
    sims: () => (SimulationClass ? SimulationClass.instances : []),
  };
  let stations = 0;
  /** A structural edit: one more source station, each in its own spot. */
  harness.addStation = () => store.commit('Add station', (l) => { L.addStation(l, { type: 'source', x: 2 + 5 * stations++, y: 2 }); });
  return harness;
}

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

/** Start playing with a primed frame loop so that the next frame has a real delta time. */
async function startPlaying(h) {
  h.frame(16);
  assert.equal(await h.runner.play(), true);
}

// ---------------------------------------------------------------------------------------------------------
// construction, lazy simulation, play / pause / toggle
// ---------------------------------------------------------------------------------------------------------

test('createRunner needs a store and a renderer', () => {
  const store = createStore({ storage: undefined });
  const renderer = { render() {} };
  assert.throws(() => createRunner({ renderer }), TypeError);
  assert.throws(() => createRunner({ store: {}, renderer }), TypeError);
  assert.throws(() => createRunner({ store }), TypeError);
  assert.throws(() => createRunner(), TypeError);
});

test('initial state: paused, speed 10, no simulation, and a frame is already scheduled', () => {
  const h = makeHarness();
  assert.equal(h.runner.playing, false);
  assert.equal(h.runner.limited, false);
  assert.equal(h.runner.speed, DEFAULT_SPEED);
  assert.equal(h.runner.sim, null);
  assert.equal(h.runner.time, 0);
  assert.equal(h.runner.kpis(), null);
  assert.equal(h.runner.insights(), null);
  assert.ok(h.pending());
});

test('the simulation is built lazily by play() from the store layout and handed to the renderer', async () => {
  const h = makeHarness();
  h.frames(3);
  assert.equal(h.sims().length, 0);
  assert.equal(h.renderer.sim, null);
  assert.equal(await h.runner.play(), true);
  assert.equal(h.sims().length, 1);
  assert.equal(h.runner.sim, h.sims()[0]);
  assert.equal(h.runner.sim.layout, h.store.getState().layout);
  assert.equal(h.renderer.sim, h.runner.sim);
  assert.deepEqual(h.of('rebuild').map((e) => e.reason), ['create']);
  assert.equal(h.of('rebuild')[0].sim, h.runner.sim);
});

test('play, pause and toggle report their state once per change', async () => {
  const h = makeHarness();
  await h.runner.play();
  await h.runner.play();
  assert.equal(h.runner.playing, true);
  assert.deepEqual(h.of('state'), [{ playing: true, speed: 10, limited: false }]);
  h.runner.pause();
  h.runner.pause();
  assert.equal(h.runner.playing, false);
  assert.equal(h.of('state').length, 2);
  assert.equal(await h.runner.toggle(), true);
  assert.equal(h.runner.playing, true);
  assert.equal(await h.runner.toggle(), false);
  assert.equal(h.runner.playing, false);
  assert.equal(h.sims().length, 1, 'play / pause cycles reuse the simulation');
});

test('speeds: the option and setSpeed snap to the allowed values; junk is ignored; changes are announced', () => {
  assert.deepEqual([...SPEEDS], [1, 2, 5, 10, 30, 60, 120, 300, 600, 1200]);
  assert.equal(makeHarness({ runner: { speed: 100 } }).runner.speed, 120);
  assert.equal(makeHarness({ runner: { speed: 'fast' } }).runner.speed, DEFAULT_SPEED);
  const h = makeHarness();
  assert.equal(h.runner.setSpeed(3), 2);
  assert.equal(h.runner.setSpeed(7), 5);
  assert.equal(h.runner.setSpeed(25), 30);
  assert.equal(h.runner.setSpeed(5000), 1200);
  assert.equal(h.runner.setSpeed(0.2), 1);
  assert.equal(h.runner.setSpeed('60'), 60);
  for (const junk of [NaN, 0, -3, 'abc', null, undefined, Infinity]) assert.equal(h.runner.setSpeed(junk), 60, String(junk));
  assert.deepEqual(h.of('state').map((s) => s.speed), [2, 5, 30, 1200, 1, 60], 'only real changes are announced');
});

// ---------------------------------------------------------------------------------------------------------
// the frame: clock arithmetic, budget, interpolation
// ---------------------------------------------------------------------------------------------------------

test('each frame advances to target += realDt * speed within the 10 ms budget using the injected clock', async () => {
  const h = makeHarness();
  await startPlaying(h);
  h.frame(16);
  const sim = h.runner.sim;
  assert.equal(sim.advances.length, 1);
  assert.ok(near(sim.advances[0].seconds, 0.16));
  assert.equal(sim.advances[0].maxMillis, FRAME_BUDGET_MS);
  assert.equal(sim.advances[0].now(), h.clock.t);
  assert.equal(sim.time, 0.2, 'whole ticks, rounded up');
  h.frames(61);
  const target = 62 * 0.016 * 10;
  assert.ok(sim.time >= target - 1e-6 && sim.time < target + sim.dt, `time ${sim.time} vs target ${target}`);
});

test('one frame never contributes more than 0.1 real seconds, however long the tab slept', async () => {
  const h = makeHarness();
  await startPlaying(h);
  h.frame(5000);
  assert.ok(near(h.runner.sim.advances[0].seconds, 1), 'min(realDt, 0.1) * speed 10');
  h.runner.setSpeed(60);
  h.frame(30000);
  assert.ok(h.runner.sim.advances.at(-1).seconds <= 0.1 * 60 + 1e-6, `asked for ${h.runner.sim.advances.at(-1).seconds} s`);
});

test('the render alpha places the display clock inside the last tick: alpha = 1 + (target - time) / dt', async () => {
  const h = makeHarness({ runner: { speed: 1 } });
  await startPlaying(h);
  h.frame(50); // target 0.05, one tick (0.1) is taken: the display lags the sim by half a tick
  assert.ok(near(h.renderer.alphas.at(-1), 0.5));
  h.frame(50); // target 0.10, time 0.1
  assert.ok(near(h.renderer.alphas.at(-1), 1));
  h.frame(30); // target 0.13: next tick not needed yet? it is (0.13 > 0.1), time 0.2
  assert.ok(near(h.renderer.alphas.at(-1), 1 + (0.13 - 0.2) / 0.1));
  for (const a of h.renderer.alphas) assert.ok(a >= 0 && a <= 1);
});

test('alpha is 1 while paused and the renderer is told about the simulation and the layout', async () => {
  const h = makeHarness();
  await h.runner.play();
  h.runner.pause();
  h.frames(4, 40);
  assert.deepEqual(h.renderer.alphas, [1, 1, 1, 1]);
  assert.equal(h.renderer.layout, h.store.getState().layout);
  h.store.commit('Rename', (l) => { l.name = 'Other'; });
  h.frame(40);
  assert.equal(h.renderer.layout, h.store.getState().layout);
});

test('every frame is drawn while playing; paused frames are thinned to about 30 fps; each drawn frame emits one frame event', async () => {
  const h = makeHarness();
  h.frames(10);
  assert.equal(h.renderer.alphas.length, 5, 'paused: every second 16 ms frame');
  h.frame(40);
  assert.equal(h.renderer.alphas.length, 6, 'a slow frame is always drawn');
  await h.runner.play();
  const before = h.renderer.alphas.length;
  h.frames(10);
  assert.equal(h.renderer.alphas.length, before + 10);
  assert.equal(h.of('frame').length, h.renderer.alphas.length);
  const last = h.of('frame').at(-1);
  assert.deepEqual(Object.keys(last).sort(), ['alpha', 'limited', 'playing', 'speed', 'time']);
  assert.equal(last.time, h.runner.sim.time);
});

test('speed scales the simulated time per frame', async () => {
  const h = makeHarness();
  await startPlaying(h);
  h.runner.setSpeed(60);
  h.frame(16);
  assert.ok(near(h.runner.sim.advances[0].seconds, 0.96));
});

test('pausing and playing again does not fast-forward the time that passed while paused', async () => {
  const h = makeHarness();
  await startPlaying(h);
  h.runner.setSpeed(60);
  h.frames(5);
  h.runner.pause();
  h.frames(50, 100);
  h.frame(8000);
  await h.runner.play();
  h.frame(16);
  assert.ok(h.runner.sim.advances.at(-1).seconds < 1.5, `asked for ${h.runner.sim.advances.at(-1).seconds} s`);
});

// ---------------------------------------------------------------------------------------------------------
// "speed limited" handling
// ---------------------------------------------------------------------------------------------------------

test('limited is raised only after the simulation has been behind for MORE than 0.5 s and is cleared when it catches up', async () => {
  const h = makeHarness({ knobs: { capacity: 0.5 }, runner: { speed: 600 } });
  await startPlaying(h);
  h.frame(250);
  h.frame(250);
  h.frame(250);
  assert.equal(LIMITED_AFTER_MS, 500);
  assert.equal(h.runner.limited, false, 'exactly 0.5 s behind is not yet limited');
  h.frame(250);
  assert.equal(h.runner.limited, true);
  assert.deepEqual(h.of('state').at(-1), { playing: true, speed: 600, limited: true });
  h.knobs.capacity = Infinity;
  h.frame(16);
  assert.equal(h.runner.limited, false);
  assert.deepEqual(h.of('state').at(-1), { playing: true, speed: 600, limited: false });
});

test('a short hiccup (behind for less than 0.5 s) never raises limited', async () => {
  const h = makeHarness({ knobs: { capacity: 0.5 }, runner: { speed: 600 } });
  await startPlaying(h);
  h.frames(10, 16);
  h.knobs.capacity = Infinity;
  h.frames(60, 16);
  assert.equal(h.runner.limited, false);
  assert.equal(h.of('state').filter((s) => s.limited).length, 0);
});

test('the backlog is capped, so a slow phase is not paid back by racing through old time later', async () => {
  const h = makeHarness({ knobs: { capacity: 0.5 }, runner: { speed: 600 } });
  await startPlaying(h);
  h.frames(20, 250);
  assert.equal(h.runner.limited, true);
  h.knobs.capacity = Infinity;
  h.frame(250);
  const asked = h.runner.sim.advances.at(-1).seconds;
  assert.ok(asked <= 300 + 60 + 1e-6, `asked for ${asked} s; an uncapped backlog would be more than 1000 s`);
  assert.ok(asked > 300, 'but the capped backlog itself is still worked off');
});

test('play() starts from where the simulation is, not from a backlog left over from a slow phase', async () => {
  const h = makeHarness({ knobs: { capacity: 0.5 }, runner: { speed: 600 } });
  await startPlaying(h);
  h.frames(8, 250);
  assert.equal(h.runner.limited, true);
  h.runner.pause();
  h.knobs.capacity = Infinity;
  await h.runner.play();
  h.frame(16);
  assert.ok(h.runner.sim.advances.at(-1).seconds < 20, `asked for ${h.runner.sim.advances.at(-1).seconds} s`);
});

test('limited is cleared by pause and by a rebuild', async () => {
  const h = makeHarness({ knobs: { capacity: 0.5 }, runner: { speed: 600 } });
  await startPlaying(h);
  h.frames(8, 250);
  assert.equal(h.runner.limited, true);
  h.runner.pause();
  assert.equal(h.runner.limited, false);
  await h.runner.play();
  h.frames(8, 250);
  assert.equal(h.runner.limited, true);
  h.runner.reset();
  assert.equal(h.runner.limited, false);
});

// ---------------------------------------------------------------------------------------------------------
// layout changes
// ---------------------------------------------------------------------------------------------------------

test('a structural change rebuilds the simulation after 250 ms, keeps playing and restarts the clock', async () => {
  const h = makeHarness();
  await startPlaying(h);
  h.frames(10);
  const first = h.runner.sim;
  assert.ok(first.time > 0);
  h.addStation();
  assert.equal(REBUILD_DEBOUNCE_MS, 250);
  h.frames(15); // 240 ms
  assert.equal(h.runner.sim, first, 'still debouncing');
  h.frame(16);
  const second = h.runner.sim;
  assert.notEqual(second, first);
  assert.equal(h.sims().length, 2);
  assert.equal(second.layout, h.store.getState().layout);
  assert.equal(h.renderer.sim, second);
  assert.ok(second.time < 0.5, 'statistics and clock restarted');
  assert.equal(h.runner.playing, true);
  assert.deepEqual(h.of('rebuild').map((e) => e.reason), ['create', 'structural']);
  h.frames(10);
  assert.ok(second.time > 0.5, 'and it keeps running');
});

test('further structural edits restart the debounce, and only one rebuild happens', async () => {
  const h = makeHarness();
  await startPlaying(h);
  h.addStation();
  h.frames(12); // 192 ms
  h.addStation();
  h.frames(15);
  assert.equal(h.sims().length, 1);
  h.frames(2);
  assert.equal(h.sims().length, 2);
  assert.equal(h.runner.sim.layout.stations.length, 2, 'built from the latest layout');
});

test('a paused simulation is rebuilt too (fresh at time 0) and stays paused', async () => {
  const h = makeHarness();
  await startPlaying(h);
  h.frames(10);
  h.runner.pause();
  h.addStation();
  h.frames(20, 16);
  assert.equal(h.sims().length, 2);
  assert.equal(h.runner.playing, false);
  assert.equal(h.runner.time, 0);
});

test('nothing is built or rebuilt before the first play, whatever the layout does', () => {
  const h = makeHarness();
  h.addStation();
  h.frames(40);
  assert.equal(h.sims().length, 0);
  assert.equal(h.runner.sim, null);
});

test('runtime changes are applied live with sim.setRuntime: no rebuild, the clock keeps running', async () => {
  const h = makeHarness();
  await startPlaying(h);
  h.frames(5);
  const sim = h.runner.sim;
  const time = sim.time;
  h.store.commit('Demand', (l) => { l.settings.demandFactor = 2; l.settings.dispatch = 'oldest'; });
  assert.equal(sim.runtimePatches.length, 1);
  assert.deepEqual(sim.runtimePatches[0], { demandFactor: 2, speedFactor: 1, processFactor: 1, dispatch: 'oldest', routing: 'shortest' });
  h.frames(40);
  assert.equal(h.runner.sim, sim);
  assert.equal(h.sims().length, 1);
  assert.ok(sim.time > time);
  h.store.commit('Back', (l) => { l.settings.demandFactor = 1; l.settings.dispatch = 'nearest'; });
  assert.equal(sim.runtimePatches.length, 2, 'going back to the built-in values is a change for the running simulation');
  assert.equal(sim.runtimePatches[1].demandFactor, 1);
});

test('cosmetic changes (name, notes, labels, obstacles, duration) touch nothing', async () => {
  const h = makeHarness();
  await startPlaying(h);
  const sim = h.runner.sim;
  h.store.commit('Name', (l) => { l.name = 'Renamed'; l.notes = 'hello'; });
  h.store.commit('Label', (l) => { L.addLabel(l, { x: 3, y: 3, text: 'Dock' }); });
  h.store.commit('Wall', (l) => { L.addObstacle(l, { x: 20, y: 20, w: 2, h: 1, kind: 'wall' }); });
  h.store.commit('Duration', (l) => { l.settings.duration = 7200; });
  h.frames(40);
  assert.equal(h.runner.sim, sim);
  assert.equal(sim.runtimePatches.length, 0);
  assert.equal(h.sims().length, 1);
});

test('undoing a structural edit before the debounce ends cancels the rebuild', async () => {
  const h = makeHarness();
  await startPlaying(h);
  h.addStation();
  h.frames(5);
  h.store.undo();
  h.frames(40);
  assert.equal(h.sims().length, 1);
});

test('a runtime edit during a pending rebuild is carried by the new simulation, not sent to the old one', async () => {
  const h = makeHarness();
  await startPlaying(h);
  const old = h.runner.sim;
  h.addStation();
  h.store.commit('Demand', (l) => { l.settings.demandFactor = 3; });
  assert.equal(old.runtimePatches.length, 0);
  h.frames(20);
  assert.equal(h.sims().length, 2);
  assert.equal(h.runner.sim.layout.settings.demandFactor, 3);
});

test('play() and step() apply a pending rebuild at once instead of running the stale simulation', async () => {
  const h = makeHarness();
  await h.runner.play();
  h.runner.pause();
  h.addStation();
  await h.runner.play();
  assert.equal(h.sims().length, 2);
  assert.equal(h.runner.sim.layout.stations.length, 1);
  h.runner.pause();
  h.addStation();
  const stepping = h.runner.step(1);
  assert.equal(h.sims().length, 3);
  h.frame(16);
  await stepping;
});

test('switching scenario rebuilds the simulation for the other layout', async () => {
  const h = makeHarness();
  await startPlaying(h);
  const other = L.createLayout({ name: 'Other plant' });
  L.addStation(other, { type: 'sink', x: 4, y: 4 });
  h.store.addScenario('B', other);
  h.frames(20);
  assert.equal(h.sims().length, 2);
  assert.equal(h.runner.sim.layout.name, 'Other plant');
  h.store.addScenario('C', L.createLayout({ name: 'Same plant, other name only' }));
  h.store.switchScenario(h.store.getState().project.scenarios[1].id);
  h.frames(20);
  assert.equal(h.sims().length, 2, 'switching to an equal layout keeps the running simulation');
});

// ---------------------------------------------------------------------------------------------------------
// hidden tab
// ---------------------------------------------------------------------------------------------------------

test('hiding the tab pauses the simulation, and it stays paused when the tab comes back', async () => {
  const h = makeHarness();
  await startPlaying(h);
  h.document.hidden = true;
  h.document.fire();
  assert.equal(h.runner.playing, false);
  assert.deepEqual(h.of('state').at(-1), { playing: false, speed: 10, limited: false });
  h.document.hidden = false;
  h.document.fire();
  assert.equal(h.runner.playing, false);
});

test('a frame that finds the tab hidden pauses too, even without a visibility event', async () => {
  const h = makeHarness();
  await startPlaying(h);
  h.document.hidden = true;
  h.frame(16);
  assert.equal(h.runner.playing, false);
  assert.equal(h.runner.sim.advances.length, 0, 'not advanced in a hidden frame');
});

// ---------------------------------------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------------------------------------

test('step(seconds) advances exactly that much simulated time while staying paused', async () => {
  const h = makeHarness();
  const stepping = h.runner.step(5);
  assert.equal(h.runner.playing, false);
  assert.ok(h.runner.sim, 'the simulation is created by step()');
  assert.equal(h.runner.sim.time, 0, 'the work is done in frames, not inside the call');
  h.frame(16);
  assert.ok(near(await stepping, 5, 1e-9));
  assert.ok(near(h.runner.sim.time, 5, 1e-9));
  assert.equal(h.runner.sim.advances[0].maxMillis, FRAME_BUDGET_MS);
  h.frames(10);
  assert.ok(near(h.runner.sim.time, 5, 1e-9), 'nothing moves after the step');
});

test('a long step is cut into budgeted chunks, one per frame, and the page keeps drawing', async () => {
  const h = makeHarness({ knobs: { capacity: 2 } });
  const stepping = h.runner.step(5);
  const drawn = h.renderer.alphas.length;
  h.frame(16);
  assert.ok(near(h.runner.sim.time, 2));
  h.frame(16);
  assert.ok(near(h.runner.sim.time, 4));
  h.frame(16);
  assert.ok(near(await stepping, 5, 1e-9));
  assert.equal(h.renderer.alphas.length, drawn + 3, 'a frame is drawn for every chunk');
});

test('a step is as exact as whole ticks allow: it ends at the first tick boundary at or after the target', async () => {
  const h = makeHarness();
  const stepping = h.runner.step(0.25);
  h.frame(16);
  const advanced = await stepping;
  assert.ok(advanced >= 0.25 - 1e-9 && advanced < 0.25 + 0.1);
  assert.ok(near(advanced, 0.3, 1e-9));
});

test('step() pauses a playing simulation first', async () => {
  const h = makeHarness();
  await startPlaying(h);
  h.frames(3);
  const stepping = h.runner.step(1);
  assert.equal(h.runner.playing, false);
  const before = h.runner.sim.time;
  h.frame(16);
  assert.ok(near(await stepping, 1, 1e-9));
  assert.ok(near(h.runner.sim.time, before + 1, 1e-9));
});

test('steps requested while a step runs extend it, and everybody hears about the total', async () => {
  const h = makeHarness({ knobs: { capacity: 1 } });
  const first = h.runner.step(1);
  const second = h.runner.step(2);
  h.frames(3);
  assert.ok(near(await first, 3, 1e-9));
  assert.ok(near(await second, 3, 1e-9));
  assert.ok(near(h.runner.sim.time, 3, 1e-9));
});

test('pause() ends a running step early with what was done so far', async () => {
  const h = makeHarness({ knobs: { capacity: 1 } });
  const stepping = h.runner.step(10);
  h.frame(16);
  h.runner.pause();
  assert.ok(near(await stepping, 1, 1e-9));
  h.frames(5);
  assert.ok(near(h.runner.sim.time, 1, 1e-9));
});

test('a step that cannot make progress ends instead of spinning forever', async () => {
  const h = makeHarness({ knobs: { capacity: 0 } });
  const stepping = h.runner.step(5);
  h.frame(16);
  assert.equal(await stepping, 0);
  const calls = h.runner.sim.advances.length;
  h.frames(5);
  assert.equal(h.runner.sim.advances.length, calls, 'no further attempts once it has ended');
});

test('step with nothing sensible to do resolves 0 and builds nothing', async () => {
  const h = makeHarness();
  for (const bad of [0, -1, NaN, Infinity, 'x']) assert.equal(await h.runner.step(bad), 0, String(bad));
  assert.equal(h.sims().length, 0);
  const stepping = h.runner.step();
  h.frame(16);
  assert.ok(near(await stepping, 1, 1e-9), 'default: one second');
});

test('reset() during a step ends it', async () => {
  const h = makeHarness({ knobs: { capacity: 1 } });
  const stepping = h.runner.step(10);
  h.frame(16);
  h.runner.reset();
  assert.ok(near(await stepping, 1, 1e-9));
  assert.equal(h.runner.time, 0);
});

// ---------------------------------------------------------------------------------------------------------
// reset
// ---------------------------------------------------------------------------------------------------------

test('reset() pauses and builds a fresh simulation at time 0', async () => {
  const h = makeHarness();
  await startPlaying(h);
  h.frames(20);
  const old = h.runner.sim;
  h.runner.reset();
  assert.equal(h.runner.playing, false);
  assert.notEqual(h.runner.sim, old);
  assert.equal(h.runner.time, 0);
  assert.equal(h.renderer.sim, h.runner.sim);
  assert.equal(h.of('rebuild').at(-1).reason, 'reset');
});

test('reset() without a simulation does nothing but pause', () => {
  const h = makeHarness();
  h.runner.reset();
  assert.equal(h.sims().length, 0);
  assert.deepEqual(h.of('rebuild'), []);
});

// ---------------------------------------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------------------------------------

test('a simulation that cannot be built: error event, still paused, and the frame loop lives on', async () => {
  const h = makeHarness({ knobs: { failConstruct: 'no roads, no plant' } });
  h.frame(16);
  assert.equal(await h.runner.play(), false);
  assert.equal(h.runner.playing, false);
  assert.equal(h.runner.sim, null);
  assert.equal(h.renderer.sim, null);
  assert.deepEqual(h.of('error').map((e) => [e.phase, e.error.message]), [['create', 'no roads, no plant']]);
  const drawn = h.renderer.alphas.length;
  assert.doesNotThrow(() => h.frames(10, 40));
  assert.equal(h.renderer.alphas.length, drawn + 10);
  assert.equal(await h.runner.step(1), 0);
  h.knobs.failConstruct = null;
  assert.equal(await h.runner.play(), true);
  assert.equal(h.runner.playing, true);
});

test('a rebuild that fails while playing leaves the runner paused with no simulation', async () => {
  const h = makeHarness();
  await startPlaying(h);
  h.knobs.failConstruct = 'bad layout';
  h.addStation();
  h.frames(20);
  assert.equal(h.runner.playing, false);
  assert.equal(h.runner.sim, null);
  assert.equal(h.renderer.sim, null);
  assert.equal(h.of('error')[0].phase, 'create');
  assert.deepEqual(h.of('rebuild').at(-1), { reason: 'structural', sim: null });
  h.knobs.failConstruct = null;
  assert.equal(await h.runner.play(), true);
});

test('an exception inside sim.advance pauses the run, reports an error and does not stop the frame loop', async () => {
  const h = makeHarness();
  await startPlaying(h);
  h.knobs.failAdvance = 'tick exploded';
  assert.doesNotThrow(() => h.frame(16));
  assert.equal(h.runner.playing, false);
  assert.deepEqual(h.of('error').map((e) => [e.phase, e.error.message]), [['advance', 'tick exploded']]);
  const drawn = h.renderer.alphas.length;
  h.frames(6, 40);
  assert.equal(h.renderer.alphas.length, drawn + 6);
});

test('a renderer that throws is reported (rate limited) and drawing continues', async () => {
  const h = makeHarness();
  h.renderer.failRender = new Error('context lost');
  assert.doesNotThrow(() => h.frames(30, 40)); // 1.2 s
  const errors = h.of('error');
  assert.ok(errors.length >= 1 && errors.length <= 2, `${errors.length} errors for 30 failing frames`);
  assert.equal(errors[0].phase, 'render');
  assert.equal(h.renderer.alphas.length, 30);
});

test('errors nobody listens for go to onError', async () => {
  const h = makeHarness({ knobs: { failConstruct: 'nope' }, observeErrors: false });
  await h.runner.play();
  assert.equal(h.listenerErrors.length, 1);
  assert.equal(h.listenerErrors[0].err.message, 'nope');
  assert.equal(h.listenerErrors[0].context.phase, 'create');
});

test('an exception in an event listener goes to onError and does not stop the others', async () => {
  const h = makeHarness();
  const seen = [];
  h.runner.on('state', () => { throw new Error('ui bug'); });
  h.runner.on('state', (s) => seen.push(s.playing));
  await h.runner.play();
  assert.deepEqual(seen, [true]);
  assert.equal(h.listenerErrors.length, 1);
  assert.equal(h.listenerErrors[0].context.event, 'state');
});

test('even a throwing onError sink and throwing listeners cannot stop the frame loop', async () => {
  const h = makeHarness({ knobs: { failConstruct: 'nope' }, observeErrors: false, runner: { onError: () => { throw new Error('sink down'); } } });
  h.runner.on('frame', () => { throw new Error('ui bug'); });
  await assert.doesNotReject(h.runner.play());
  const drawn = h.renderer.alphas.length;
  assert.doesNotThrow(() => h.frames(5, 40));
  assert.equal(h.renderer.alphas.length, drawn + 5);
  assert.ok(h.pending());
});

test('on() validates its arguments and returns an unsubscribe function', async () => {
  const h = makeHarness();
  assert.throws(() => h.runner.on('explode', () => {}), /Unknown runner event/);
  assert.throws(() => h.runner.on('state', null), TypeError);
  const seen = [];
  const off = h.runner.on('state', (s) => seen.push(s.playing));
  await h.runner.play();
  off();
  h.runner.pause();
  assert.deepEqual(seen, [true]);
});

// ---------------------------------------------------------------------------------------------------------
// results: kpis event, kpis() / insights() caching
// ---------------------------------------------------------------------------------------------------------

test('kpis events come at about 4 Hz of wall time, with the report, and never from inside sim.advance', async () => {
  const h = makeHarness();
  const insideAdvance = [];
  h.runner.on('kpis', () => insideAdvance.push(h.sims().some((s) => s.busy)));
  await startPlaying(h);
  h.frames(63); // about 1 s
  const reports = h.of('kpis');
  assert.ok(reports.length >= 3 && reports.length <= 5, `${reports.length} kpis events in 1 s`);
  assert.deepEqual(insideAdvance, reports.map(() => false));
  assert.ok(reports.every((r) => typeof r.at === 'number'));
  assert.equal(KPI_INTERVAL_MS, 250);
});

test('no kpis events while nothing moves', async () => {
  const h = makeHarness();
  await startPlaying(h);
  h.frames(30);
  h.runner.pause();
  h.frames(40);
  const settled = h.of('kpis').length;
  h.frames(60);
  assert.equal(h.of('kpis').length, settled);
  assert.equal(h.of('kpis').at(-1).at, h.runner.sim.time, 'the last event reflects the final state');
});

test('a kpis event carries the state it announces, even if the UI asked for results a moment earlier', async () => {
  const h = makeHarness();
  await startPlaying(h);
  h.frame(16);
  assert.equal(h.of('kpis').length, 1);
  h.frames(15); // 240 ms later the next event is not due yet
  h.clock.t += 12;
  h.runner.kpis(); // the UI asks for results (this refreshes the cache) ...
  h.frame(16); // ... and the simulation moves on in the very frame that announces them
  assert.equal(h.of('kpis').length, 2);
  assert.equal(h.of('kpis').at(-1).at, h.runner.sim.time);
});

test('kpis() is cached for 250 ms and as long as the simulation has not moved; a new simulation starts fresh', async () => {
  const h = makeHarness();
  await h.runner.play();
  h.runner.pause();
  const sim = h.runner.sim;
  const a = h.runner.kpis();
  assert.equal(h.runner.kpis(), a);
  assert.equal(sim.kpiCalls, 1);
  sim.ticks += 10;
  assert.equal(h.runner.kpis(), a, 'moved, but the result is not 250 ms old yet');
  h.clock.t += 251;
  const b = h.runner.kpis();
  assert.notEqual(b, a);
  assert.equal(b.at, sim.time);
  h.clock.t += 5000;
  assert.equal(h.runner.kpis(), b, 'unchanged simulation: still valid however old');
  assert.equal(sim.kpiCalls, 2);
  h.runner.reset();
  assert.equal(h.runner.kpis().call, 1, 'the new simulation has its own results');
});

test('insights() analyses the cached KPI report and is cached the same way', async () => {
  const h = makeHarness();
  await h.runner.play();
  h.runner.pause();
  const report = h.runner.kpis();
  const first = h.runner.insights();
  assert.equal(h.runner.insights(), first);
  assert.equal(h.runner.sim.insightArgs.length, 1);
  assert.equal(h.runner.sim.insightArgs[0], report);
  assert.deepEqual(first, [{ id: 'insight', at: 0 }]);
});

test('a failing kpis() is reported once, returns null and is not retried inside the cache window', async () => {
  const h = makeHarness({ knobs: { failKpis: 'stats broke' } });
  await h.runner.play();
  h.runner.pause();
  assert.equal(h.runner.kpis(), null);
  assert.equal(h.runner.kpis(), null);
  assert.equal(h.runner.sim.kpiCalls, 1);
  assert.deepEqual(h.of('error').map((e) => e.phase), ['results']);
  assert.equal(h.runner.insights(), h.runner.insights());
});

// ---------------------------------------------------------------------------------------------------------
// destroy
// ---------------------------------------------------------------------------------------------------------

test('destroy() cancels the frame loop, detaches from the store and the page, and silences everything', async () => {
  let unsubscribed = 0;
  const h = makeHarness({
    wrapStore: (store) => ({
      getState: store.getState,
      subscribe: (fn) => {
        const off = store.subscribe(fn);
        return () => { unsubscribed++; off(); };
      },
    }),
  });
  assert.equal(h.visibility.size, 1);
  await h.runner.play();
  const handle = h.pending().handle;
  const seen = [];
  h.runner.on('state', (s) => seen.push(s));
  const stepping = h.runner.step(5);
  seen.length = 0;
  h.runner.destroy();
  assert.deepEqual(h.cancelled, [handle]);
  assert.equal(h.pending(), null);
  assert.equal(unsubscribed, 1);
  assert.equal(h.visibility.size, 0);
  assert.equal(h.renderer.sim, null);
  assert.equal(h.runner.sim, null);
  assert.equal(h.runner.playing, false);
  assert.equal(await stepping, 0, 'a pending step is released');
  assert.equal(await h.runner.play(), false);
  assert.equal(await h.runner.step(1), 0);
  assert.doesNotThrow(() => { h.runner.pause(); h.runner.reset(); h.runner.setSpeed(60); h.runner.destroy(); });
  assert.deepEqual(seen, [], 'listeners are dropped');
  assert.equal(h.sims().length, 1, 'nothing is built after destroy');
});

test('a frame callback that fires after destroy() does nothing', async () => {
  const h = makeHarness();
  h.frame(16);
  const { cb } = h.pending();
  h.runner.destroy();
  const drawn = h.renderer.alphas.length;
  cb(h.clock.t + 16);
  assert.equal(h.renderer.alphas.length, drawn);
  assert.equal(h.pending(), null);
});

// ---------------------------------------------------------------------------------------------------------
// lazily loaded engine
// ---------------------------------------------------------------------------------------------------------

function gatedEngine(Simulation) {
  const gate = { loads: 0, failWith: null };
  gate.promise = new Promise((resolve) => { gate.release = resolve; });
  gate.loadEngine = async () => {
    gate.loads++;
    await gate.promise;
    if (gate.failWith) throw gate.failWith;
    return { Simulation };
  };
  return gate;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('without an injected class, play() loads the engine on demand; the button flips at once and the sim appears when loaded', async () => {
  const Fake = createFakeSimClass();
  const gate = gatedEngine(Fake);
  const h = makeHarness({ SimulationClass: null, runner: { loadEngine: gate.loadEngine } });
  const playing = h.runner.play();
  assert.equal(h.runner.playing, true);
  assert.equal(h.runner.sim, null);
  assert.doesNotThrow(() => h.frames(3));
  gate.release();
  assert.equal(await playing, true);
  assert.equal(Fake.instances.length, 1);
  assert.equal(h.runner.sim, Fake.instances[0]);
  assert.deepEqual(h.of('rebuild').map((e) => e.reason), ['create']);
  h.frames(10);
  assert.ok(h.runner.time > 0);
  h.runner.pause();
  await h.runner.play();
  assert.equal(gate.loads, 1, 'the engine is loaded once');
});

test('concurrent play() calls load the engine once and create one simulation', async () => {
  const Fake = createFakeSimClass();
  const gate = gatedEngine(Fake);
  const h = makeHarness({ SimulationClass: null, runner: { loadEngine: gate.loadEngine } });
  const first = h.runner.play();
  const second = h.runner.play();
  gate.release();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(gate.loads, 1);
  assert.equal(Fake.instances.length, 1);
});

test('step() before the engine is loaded waits for it and then steps', async () => {
  const Fake = createFakeSimClass();
  const gate = gatedEngine(Fake);
  const h = makeHarness({ SimulationClass: null, runner: { loadEngine: gate.loadEngine } });
  const stepping = h.runner.step(2);
  assert.equal(h.runner.sim, null);
  gate.release();
  await flush();
  assert.equal(Fake.instances.length, 1);
  h.frame(16);
  assert.ok(near(await stepping, 2, 1e-9));
});

test('pausing while the engine loads cancels the start: no simulation is created', async () => {
  const Fake = createFakeSimClass();
  const gate = gatedEngine(Fake);
  const h = makeHarness({ SimulationClass: null, runner: { loadEngine: gate.loadEngine } });
  const playing = h.runner.play();
  h.runner.pause();
  gate.release();
  assert.equal(await playing, false);
  assert.equal(h.runner.sim, null);
  assert.equal(h.runner.playing, false);
});

test('an engine that cannot be loaded: error event, paused, and a later play() tries again', async () => {
  const Fake = createFakeSimClass();
  const gate = gatedEngine(Fake);
  gate.failWith = new Error('engine.js is missing');
  const h = makeHarness({ SimulationClass: null, runner: { loadEngine: gate.loadEngine } });
  const playing = h.runner.play();
  gate.release();
  assert.equal(await playing, false);
  assert.equal(h.runner.playing, false);
  assert.deepEqual(h.of('error').map((e) => [e.phase, e.error.message]), [['load', 'engine.js is missing']]);
  assert.equal(await h.runner.step(1), 0);
  gate.failWith = null;
  assert.equal(await h.runner.play(), true);
  assert.equal(gate.loads, 3, 'play, step and the retry each tried once');
  assert.equal(Fake.instances.length, 1);
});

test('a module without Simulation is reported as a load error', async () => {
  const h = makeHarness({ SimulationClass: null, runner: { loadEngine: async () => ({}) } });
  assert.equal(await h.runner.play(), false);
  assert.equal(h.of('error')[0].phase, 'load');
});

// ---------------------------------------------------------------------------------------------------------
// with the real engine (skipped where js/sim/engine.js does not exist)
// ---------------------------------------------------------------------------------------------------------

let engineModule = null;
try {
  engineModule = await import('../js/sim/engine.js');
} catch {
  engineModule = null;
}

test('integration: the default engine loader runs a real example; structural edits rebuild, runtime edits apply live', { skip: engineModule === null }, async () => {
  const h = makeHarness({ SimulationClass: null });
  h.store.replaceLayout(EXAMPLES[0].build(), { label: 'Load example' });
  h.runner.setSpeed(60);
  h.frame(16);
  assert.equal(await h.runner.play(), true);
  h.frames(120);
  const sim = h.runner.sim;
  assert.ok(sim instanceof engineModule.Simulation);
  assert.ok(sim.time > 100 && sim.time < 125, `time ${sim.time}`);
  assert.equal(h.runner.limited, false);
  const report = h.runner.kpis();
  assert.ok(report && report.window && report.throughput);
  assert.ok(Array.isArray(h.runner.insights()));
  assert.ok(h.of('kpis').length >= 3);
  h.store.commit('Demand', (l) => { l.settings.demandFactor = 2; });
  assert.equal(sim.runtime.demandFactor, 2);
  assert.equal(h.runner.sim, sim);
  h.store.commit('More vehicles', (l) => { l.fleets[0].count += 1; });
  h.frames(20);
  assert.notEqual(h.runner.sim, sim);
  assert.equal(h.runner.sim.settings.demandFactor, 2);
  assert.ok(h.runner.sim.time < 30);
  const stepping = h.runner.step(30);
  h.frames(10);
  assert.ok((await stepping) >= 30);
  assert.deepEqual(h.of('error'), []);
});
