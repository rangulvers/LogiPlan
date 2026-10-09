// A1.13: the restart policy of the runner for trucks and dock doors (docs/WAREHOUSE-DESIGN.md 6.2.7, js/ui/day-plant.js, js/ui/runner.js warmWanted).
// A DAY plant (a Goods in or Goods out follows a truck timetable, so the plant has a clock) never restarts warm after an edit: the simulation starts again
// at the start time of its clock (sim.time 0) and there is no baseline, hence no "Effect of your change" card. A plant with trucks in rate mode is
// stationary and restarts warm, as before. Runs on fake frames and a fake Simulation (tests/ui.runner.warm.test.js uses the same technique); the last test
// uses the real engine, where the simulation really is built again at time 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner, REBUILD_DEBOUNCE_MS } from '../js/ui/runner.js';
import { createStore } from '../js/store/store.js';
import * as L from '../js/model/layout.js';
import { EXAMPLES } from '../js/model/examples.js';
import { convertToDoors } from '../js/model/doors.js';
import { Simulation } from '../js/sim/engine.js';
import { isDayPlant, clockChip, coldRestartText, clockStartText, shouldShowColdRestartToast, resetColdRestartToast } from '../js/ui/day-plant.js';

function createFakeSimClass(clock) {
  class FakeSim {
    constructor(layout) {
      this.layout = layout;
      this.settings = layout.settings;
      this.dt = 0.1;
      this.ticks = 0;
      this.number = FakeSim.instances.length + 1;
      FakeSim.instances.push(this);
    }

    get time() { return this.ticks * this.dt; }

    advance(seconds) {
      const wanted = Math.ceil((seconds - this.dt * 1e-6) / this.dt);
      const n = Math.max(0, Math.min(wanted, Math.floor(300 / this.dt))); // at most 300 simulated seconds per call, so that a pre-roll takes several frames
      this.ticks += n;
      return n * this.dt;
    }

    setRuntime() {}

    kpis() {
      const warmup = this.settings.warmup;
      return { window: { start: Math.min(warmup, this.time), end: this.time, duration: Math.max(0, this.time - warmup), warmingUp: this.time < warmup }, throughput: { total: 0, perHour: 10 } };
    }

    insights() { return []; }
  }
  FakeSim.instances = [];
  return FakeSim;
}

function makeHarness(layout) {
  const clock = { t: 5000 };
  const SimulationClass = createFakeSimClass(clock);
  let pending = null;
  let handle = 0;
  const raf = (cb) => { pending = { handle: ++handle, cb }; return handle; };
  const caf = (hd) => { if (pending && pending.handle === hd) pending = null; };
  const store = createStore({ storage: undefined });
  store.replaceLayout(layout, { label: 'Load' });
  const renderer = { sim: null, layout: null, render() {} };
  const document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const runner = createRunner({ store, renderer, raf, caf, now: () => clock.t, document, SimulationClass, onError: (e) => { throw e; } });
  const events = [];
  for (const name of ['rebuild', 'baseline', 'priming']) runner.on(name, (payload) => events.push([name, payload]));
  const h = {
    store, runner, events, renderer,
    frame(ms = 16) { assert.ok(pending, 'a frame must be scheduled'); clock.t += ms; const { cb } = pending; pending = null; cb(clock.t); },
    frames(n) { for (let i = 0; i < n; i++) h.frame(); },
    until(cond, max = 600) { for (let i = 0; i < max; i++) { if (cond()) return i; h.frame(); } assert.fail('the condition was not reached'); return max; },
    sims: () => SimulationClass.instances,
    of: (name) => events.filter(([n]) => n === name).map(([, p]) => p),
  };
  return h;
}

/** Play the plant for `seconds` of simulated time, at the top speed. */
async function runFor(h, seconds) {
  h.frame(16);
  h.runner.setSpeed(1200);
  assert.equal(await h.runner.play(), true);
  h.until(() => h.runner.time >= seconds, 4000);
}

function plant() {
  const layout = L.createLayout({ name: 'Doors', cols: 30, rows: 14, cellSize: 2 });
  L.paintRoadPath(layout, [[2, 8], [26, 8]]);
  const src = L.addStation(layout, { type: 'source', name: 'Goods in', x: 6, y: 5, w: 3, h: 2, params: { interArrival: { kind: 'const', mean: 180, spread: 0 } } });
  const sink = L.addStation(layout, { type: 'sink', name: 'Goods out', x: 18, y: 5, w: 3, h: 2 });
  L.addFlow(layout, src.id, sink.id);
  L.addFleet(layout, 'forklift', { count: 2 });
  layout.settings.warmup = 0;
  return { layout, src, sink };
}

const withTrucks = (mode) => {
  const p = plant();
  L.updateStation(p.layout, p.src.id, { ops: { trucks: { ...convertToDoors(L.getStation(p.layout, p.src.id)), mode, schedule: mode === 'schedule' ? [{ at: 21600, pallets: 24 }, { at: 25200, pallets: 12 }] : [] } } });
  return p;
};

/** An edit that changes the simulation: one door more. */
const moreDoors = (h, id) => h.store.commit('Change doors', (d) => { L.updateStation(d, id, { ops: { trucks: { doors: (L.getStation(d, id).ops.trucks.doors % 6) + 1 } } }); });

test('isDayPlant: a truck timetable makes a day plant; rate mode, a leftover clock and a plant without trucks do not', () => {
  assert.equal(isDayPlant(plant().layout), false, 'no trucks');
  assert.equal(isDayPlant(withTrucks('rate').layout), false, 'trucks in rate mode: stationary');
  const day = withTrucks('schedule').layout;
  assert.equal(isDayPlant(day), true);
  assert.ok(day.calendar, 'a timetable has a clock');
  const leftover = withTrucks('schedule');
  L.updateStation(leftover.layout, leftover.src.id, { ops: { trucks: { mode: 'rate' } } });
  assert.ok(leftover.layout.calendar, 'the clock stays when the timetable goes (the planner start time survives)');
  assert.equal(isDayPlant(leftover.layout), false, 'but the plant is stationary again: warm restart and the impact card');
  assert.equal(isDayPlant(null), false);
  assert.equal(isDayPlant({}), false);
});

test('the clock chip of the simulation bar and the cold-restart copy', () => {
  const day = withTrucks('schedule').layout;
  L.updateCalendar(day, { startTod: 6 * 3600, startDay: 0 });
  assert.deepEqual(clockChip(day, 0).label, 'Mon 06:00');
  assert.equal(clockChip(day, 42 * 60).label, 'Mon 06:42');
  assert.equal(clockChip(day, 18 * 3600).label, 'Tue 00:00', 'it wraps into the next day');
  assert.equal(clockChip(plant().layout, 100), null, 'no chip for a plant without a daily rhythm');
  assert.equal(clockChip(withTrucks('rate').layout, 100), null);
  assert.equal(clockStartText(day), '06:00 on Monday');
  assert.equal(coldRestartText(day), 'This plant follows a daily timetable. After an edit the simulation starts again at 06:00 instead of continuing, so the figures always describe a whole day.');
  resetColdRestartToast();
  assert.equal(shouldShowColdRestartToast(), true, 'the first time per session');
  assert.equal(shouldShowColdRestartToast(), false);
  resetColdRestartToast();
});

test('an edit to a stationary truck plant restarts warm: pre-rolled behind the displayed simulation', async () => {
  const p = withTrucks('rate');
  const h = makeHarness(p.layout);
  await runFor(h, 100);
  const first = h.runner.sim;
  moreDoors(h, p.src.id);
  h.until(() => h.runner.priming || h.sims().length > 1);
  assert.equal(h.runner.priming, true, 'priming has started');
  assert.equal(h.runner.sim, first, 'the old simulation stays on screen');
  h.until(() => !h.runner.priming);
  const rebuild = h.of('rebuild').at(-1);
  assert.equal(rebuild.warm, true);
  assert.ok(h.runner.sim.time >= 600, `the new simulation is shown after its pre-roll (${h.runner.sim.time} s)`);
});

test('an edit to a day plant restarts cold: the simulation starts again at time 0 and there is no baseline', async () => {
  const p = withTrucks('schedule');
  const h = makeHarness(p.layout);
  await runFor(h, 100);
  const first = h.runner.sim;
  assert.ok(first.time >= 100);
  h.runner.pause();
  moreDoors(h, p.src.id);
  h.frames(Math.ceil(REBUILD_DEBOUNCE_MS / 16) + 2);
  assert.equal(h.runner.priming, false, 'a day plant is never pre-rolled');
  assert.notEqual(h.runner.sim, first, 'a new simulation replaced the old one');
  assert.equal(h.runner.sim.time, 0, 'it starts at the start of the clock');
  assert.equal(h.sims().length, 2);
  const rebuild = h.of('rebuild').at(-1);
  assert.equal(rebuild.warm, false);
  assert.equal(rebuild.reason, 'structural');
  assert.equal(rebuild.baseline, false);
  assert.equal(h.runner.baseline, null, 'no old-versus-new window: the impact card has nothing to show');
  assert.equal(h.runner.warm, null);
  // and a second edit is cold again
  moreDoors(h, p.src.id);
  h.frames(Math.ceil(REBUILD_DEBOUNCE_MS / 16) + 2);
  assert.equal(h.runner.sim.time, 0);
  assert.equal(h.sims().length, 3);
  assert.equal(h.runner.priming, false);
});

test('switching a stationary plant to a timetable, and back, restarts cold both times', async () => {
  const p = withTrucks('rate');
  const h = makeHarness(p.layout);
  await runFor(h, 100);
  h.runner.pause();
  h.store.commit('Use a timetable', (d) => { L.updateStation(d, p.src.id, { ops: { trucks: { mode: 'schedule', schedule: [{ at: 21600, pallets: 24 }] } } }); });
  assert.ok(h.store.getState().layout.calendar, 'the first timetable creates the clock');
  h.frames(Math.ceil(REBUILD_DEBOUNCE_MS / 16) + 2);
  assert.equal(h.runner.sim.time, 0, 'the new plant is a day plant: cold');
  assert.equal(h.runner.priming, false);
  await runFor(h, 60);
  h.runner.pause();
  h.store.commit('Generate trucks from a rate', (d) => { L.updateStation(d, p.src.id, { ops: { trucks: { mode: 'rate' } } }); });
  h.frames(Math.ceil(REBUILD_DEBOUNCE_MS / 16) + 2);
  assert.equal(h.runner.sim.time, 0, 'the displayed plant was a day plant: cold, although the new one is stationary');
  assert.equal(h.runner.priming, false);
});

test('real engine: after an edit of a day plant the displayed simulation really is at time 0 of its clock', async () => {
  const layout = EXAMPLES.find((e) => e.id === 'starter').build();
  const src = layout.stations.find((s) => s.type === 'source');
  L.updateStation(layout, src.id, { ops: { trucks: { ...convertToDoors(L.getStation(layout, src.id)), mode: 'schedule', schedule: [{ at: 0, pallets: 6 }, { at: 600, pallets: 6 }] } } });
  L.updateCalendar(layout, { startTod: 6 * 3600, startDay: 2 });
  assert.equal(isDayPlant(layout), true);
  let pending = null;
  const store = createStore({ storage: undefined });
  store.replaceLayout(layout, { label: 'Load' });
  let t = 0;
  const runner = createRunner({ store, renderer: { render() {} }, raf: (cb) => { pending = cb; return 1; }, caf: () => { pending = null; }, now: () => t, document: { hidden: false, addEventListener() {}, removeEventListener() {} }, SimulationClass: Simulation, onError: (e) => { throw e; } });
  const frame = () => { t += 16; const cb = pending; pending = null; cb(t); };
  frame();
  const stepped = runner.step(300);
  for (let i = 0; i < 400 && runner.time < 299.9; i++) frame();
  await stepped;
  assert.ok(runner.time >= 299.9, `ran ${runner.time} s`);
  const first = runner.sim;
  store.commit('Change doors', (d) => { L.updateStation(d, src.id, { ops: { trucks: { doors: 3 } } }); });
  for (let i = 0; i < 40; i++) frame();
  assert.notEqual(runner.sim, first);
  assert.equal(runner.sim.time, 0, 'cold: at the start of the clock, not at the end of a pre-roll');
  assert.equal(runner.priming, false);
  assert.equal(runner.baseline, null);
  runner.destroy();
});
