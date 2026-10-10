// The live demo of the /how page, without a browser (how/js/demo-logic.js, demo.js): the plants it offers and the one edit it makes in each, the
// speed governor, the figures it reads from the engine's own report, a whole shift against a straight run, and the planner's renderer drawing a demo
// plant onto a fake canvas. What needs a real browser (pixels that move, long tasks, the page's layout) is tests/e2e/how.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Simulation } from '../js/sim/engine.js';
import { EXAMPLES } from '../js/model/examples.js';
import { Renderer } from '../js/ui/renderer.js';
import { Camera } from '../js/ui/camera.js';
import { getTheme } from '../js/ui/theme.js';
import { getScene } from '../js/ui/render/scene.js';
import { formatClock } from '../js/util/format.js';
import {
  DEMOS, SPEEDS, SHIFT_SECONDS, FIGURES, DemoCore, Pacer, demoById, layoutFor, changeFacts, contentRect, readFigures, describeFigures, primeSeconds, simBudget,
  MAX_FRAME_SECONDS, LAG_CAP_SECONDS, LIMITED_AFTER_MS, MIN_SIM_BUDGET_MS, MAX_SIM_BUDGET_MS,
} from '../how/js/demo-logic.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exampleOf = (id) => EXAMPLES.find((e) => e.id === id);
const newCore = (now) => new DemoCore({ Simulation, examples: EXAMPLES, ...(now ? { now } : {}) });

// ---- the plants -----------------------------------------------------------------------------------------------------------

test('every demo plant is an example of the planner, with a real fleet to change and figures that exist', () => {
  const ids = new Set();
  for (const demo of DEMOS) {
    assert.ok(!ids.has(demo.id), `duplicate demo id ${demo.id}`);
    ids.add(demo.id);
    const example = exampleOf(demo.exampleId);
    assert.ok(example, `${demo.id}: no example ${demo.exampleId}`);
    assert.ok(SPEEDS.includes(demo.speed), `${demo.id}: speed ${demo.speed} is not offered`);
    for (const key of demo.show) assert.ok(Object.hasOwn(FIGURES, key), `${demo.id}: unknown figure ${key}`);
    const base = layoutFor(demo, example.build, false);
    const changed = layoutFor(demo, example.build, true);
    const facts = changeFacts(demo, base);
    assert.ok(facts.fleetName, `${demo.id}: fleet not found`);
    assert.notEqual(facts.from, facts.to, `${demo.id}: the edit changes nothing`);
    const fleetOf = (layout) => (demo.change.fleet === null ? layout.fleets[0] : layout.fleets.find((f) => f.id === demo.change.fleet));
    assert.equal(fleetOf(base).count, facts.from);
    assert.equal(fleetOf(changed).count, facts.to);
    // one edit and nothing else: everything but that count is the same
    fleetOf(changed).count = facts.from;
    assert.deepEqual(changed, base, `${demo.id}: the changed plant differs in more than the one edit`);
  }
  assert.equal(demoById('nope'), DEMOS[0]);
});

test('the scenario and the seed are set in both plants, and the planner\'s example is not touched', () => {
  const hello = demoById('hello-pallet');
  const build = exampleOf('hello-pallet').build;
  const before = JSON.stringify(build());
  for (const changed of [false, true]) {
    const layout = layoutFor(hello, build, changed);
    assert.equal(layout.settings.demandFactor, 2);
    assert.equal(layout.settings.seed, hello.seed);
  }
  assert.equal(JSON.stringify(build()), before, 'build() must hand out a fresh layout every time');
  assert.equal(layoutFor(demoById('warehouse-first-day'), exampleOf('warehouse-first-day').build, false).settings.demandFactor, 1);
});

test('a camera target covers what the plant holds and stays on the baseplate', () => {
  for (const demo of DEMOS) {
    const layout = layoutFor(demo, exampleOf(demo.exampleId).build, false);
    const scene = getScene(layout);
    const rect = contentRect(scene);
    assert.ok(rect.x >= 0 && rect.y >= 0 && rect.x + rect.w <= scene.width + 1e-9 && rect.y + rect.h <= scene.height + 1e-9, `${demo.id}: outside the plate`);
    for (const s of scene.stations) {
      assert.ok(s.x >= rect.x - 1e-9 && s.x + s.w <= rect.x + rect.w + 1e-9 && s.y >= rect.y - 1e-9 && s.y + s.h <= rect.y + rect.h + 1e-9, `${demo.id}: ${s.st.name} not covered`);
    }
  }
  assert.deepEqual(contentRect({ cs: 2, width: 20, height: 10, roads: [], stations: [], obstacles: [], labels: [] }), { x: 0, y: 0, w: 20, h: 10 });
});

// ---- the governor ---------------------------------------------------------------------------------------------------------

test('the pacer turns real time into simulated time, drops seconds (never frames) when behind and says so after half a second', () => {
  const pacer = new Pacer();
  pacer.reset(0);
  // a normal frame: 16 ms at 600x
  assert.ok(Math.abs(pacer.want(0.016, 0, 0.1, 600) - 9.6) < 1e-9);
  // a stalled tab (3 s between frames) counts as MAX_FRAME_SECONDS only
  pacer.reset(0);
  assert.equal(pacer.want(3, 0, 0.1, 600), MAX_FRAME_SECONDS * 600);
  // an engine that never gets anywhere: the backlog is cut to LAG_CAP_SECONDS of the chosen speed, however long it lasts
  pacer.reset(0);
  let t = 0;
  let want = 0;
  for (let i = 0; i < 100; i++) {
    want = pacer.want(0.016, 0, 0.1, 600);
    t += 16;
    pacer.settle(0, 0.1, 0.016, 0, t);
  }
  assert.ok(want <= 600 * LAG_CAP_SECONDS + 1e-9, `backlog ${want} not capped`);
  assert.equal(pacer.limited, true);
  assert.ok(pacer.effective === 0 || pacer.effective < 1, 'nothing was advanced, so the effective speed is about zero');
  // once the engine catches up the flag goes away
  pacer.settle(pacer.target, 0.1, 0.016, 5, t + 16);
  assert.equal(pacer.limited, false);
  // the interpolation alpha stays in 0..1
  assert.equal(pacer.settle(pacer.target + 10, 0.1, 0.016, 0, t + 32) >= 0, true);
  assert.ok(pacer.settle(0, 0.1, 0.016, 0, t + 48) <= 1);
});

test('the frame budget leaves room for drawing and never goes outside its bounds', () => {
  assert.equal(simBudget(0), MAX_SIM_BUDGET_MS);
  assert.equal(simBudget(100), MIN_SIM_BUDGET_MS);
  assert.equal(simBudget(NaN), MAX_SIM_BUDGET_MS);
  assert.ok(simBudget(6) >= MIN_SIM_BUDGET_MS && simBudget(6) <= MAX_SIM_BUDGET_MS);
  assert.equal(LIMITED_AFTER_MS, 500);
});

test('on a machine that is slower than the chosen speed the core runs slower, keeps answering every frame and flags it', () => {
  let clock = 0;
  const now = () => clock;
  // an engine whose every simulated second costs 40 ms of wall clock: far too slow for 600x
  class SlowSim extends Simulation {
    advance(seconds, opts) {
      const done = super.advance(Math.min(seconds, 0.5), opts);
      clock += done * 40;
      return done;
    }
  }
  const core = new DemoCore({ Simulation: SlowSim, examples: EXAMPLES, now });
  core.load(demoById('hello-pallet'));
  while (!core.prime(5)) clock += 5;
  assert.ok(core.play());
  core.setSpeed(600);
  let limitedSeen = false;
  for (let i = 0; i < 120; i++) {
    clock += 16;
    const r = core.frame(0.016, 2);
    assert.ok(r.alpha >= 0 && r.alpha <= 1);
    limitedSeen ||= r.limited;
  }
  assert.ok(limitedSeen, 'a slow machine must be told it is slow');
  assert.ok(core.pacer.effective < 600, `effective ${core.pacer.effective}`);
  assert.ok(core.pacer.target - core.time <= 600 * LAG_CAP_SECONDS + 1e-6, 'the lag is capped: simulated seconds are dropped, not queued');
});

// ---- the real engine behind the figures ---------------------------------------------------------------------------------------

test('both plants run on the same seed, advance in lock step and give the same figures every time', () => {
  const run = () => {
    const core = newCore();
    core.load(demoById('hello-pallet'), { compare: true });
    while (!core.prime(50)) { /* slices */ }
    core.play();
    for (let i = 0; i < 90; i++) {
      core.frame(0.016, 1);
      const [a, b] = core.panes;
      assert.ok(Math.abs(a.sim.time - b.sim.time) <= 20 + 1e-9, 'the two runs drifted apart');
    }
    return core.figures(true);
  };
  const first = run();
  assert.deepEqual(run(), first);
  assert.equal(first.length, 2);
});

test('every figure shown is read from sim.kpis() and nothing else', () => {
  const core = newCore();
  core.load(demoById('warehouse-first-day'), { compare: false });
  while (!core.prime(50)) { /* slices */ }
  const sim = core.panes[0].sim;
  sim.advance(2 * 3600);
  const report = sim.kpis();
  const [fig] = core.figures(true);
  const byKey = Object.fromEntries(fig.items.map((i) => [i.key, i]));
  assert.equal(fig.warmingUp, false);
  assert.equal(byKey.delivered.value, String(report.throughput.total));
  assert.equal(byKey.perHour.value, String(Math.round(report.throughput.perHour * 10) / 10));
  assert.equal(byKey.inPlant.value, String(report.wip.now));
  const fleet = Object.values(report.fleets)[0];
  assert.equal(byKey.busy.value, `${Math.round(Math.min(1, fleet.utilization) * 100)} %`);
  assert.equal(byKey.busy.note, `${fleet.count} vehicles`);
  assert.equal(byKey.traffic.value, `${Math.round(report.traffic.waitShare * 100)} %`);
  const gate = Object.values(report.ops.trucks).find((t) => t.role === 'in');
  assert.ok(byKey.gate.value === '0 s' || byKey.gate.value.endsWith('s') || byKey.gate.value.endsWith('min'), byKey.gate.value);
  assert.ok(gate.gateWait.mean >= 0);
  assert.equal(fig.clock, formatClock(sim.time)); // the planner's own clock format
});

test('during the warm-up there are no figures at all, and a report without data shows dashes', () => {
  const core = newCore();
  core.load(demoById('hello-pallet'));
  const [fig] = core.figures(true);
  assert.equal(fig.warmingUp, true);
  assert.ok(fig.items.every((i) => i.value === '–'));
  assert.match(describeFigures('Hello', fig), /filling up/);
  const empty = readFigures(demoById('congestion-lab'), { window: { warmingUp: false, duration: 0 }, throughput: { total: 0, perHour: 0 }, leadTime: { mean: null }, wip: {}, fleets: {}, traffic: {} }, 700);
  const byKey = Object.fromEntries(empty.items.map((i) => [i.key, i.value]));
  assert.equal(byKey.delivered, '0');
  assert.equal(byKey.perHour, '–', 'no per-hour figure before a minute has been measured');
  assert.equal(byKey.lead, '–');
  assert.equal(byKey.busy, '–');
  assert.equal(readFigures(demoById('hello-pallet'), null, 0).warmingUp, true);
});

test('the figures in words say what the report says, with the notes where they read naturally', () => {
  const text = describeFigures('The example', { clock: '8:00:00', warmingUp: false, items: [
    { label: 'Pallets delivered', value: '257', note: '' },
    { label: 'Output per hour', value: '32.8', note: 'per hour' },
    { label: 'Forklift busy', value: '100 %', note: '1 vehicle' },
    { label: 'Time in the plant', value: '80.7 min', note: 'on average' },
    { label: 'Truck wait at the gate', value: '–', note: '' },
  ] });
  assert.equal(text, 'The example, simulated time 8:00:00: Pallets delivered 257; Output per hour 32.8; Forklift busy 100 % (1 vehicle); Time in the plant 80.7 min on average.');
});

test('the one edit shows in the real report: a second forklift empties the plant of the same pallets (Hello, pallet at twice the demand)', () => {
  const core = newCore();
  core.load(demoById('hello-pallet'), { compare: true });
  core.beginShift(SHIFT_SECONDS);
  let guard = 0;
  while (!core.shiftFrame(50).done && ++guard < 1000) { /* slices */ }
  const [example, changed] = core.figures(true);
  const val = (fig, key) => fig.items.find((i) => i.key === key).value;
  assert.equal(example.clock, '8:00:00');
  assert.equal(changed.clock, '8:00:00');
  const reports = core.reports(true);
  assert.ok(reports[0].leadTime.mean > 30 * reports[1].leadTime.mean, 'the lone forklift builds a queue, the second one clears it');
  assert.ok(reports[1].throughput.perHour > reports[0].throughput.perHour * 1.3);
  assert.equal(val(example, 'delivered'), String(reports[0].throughput.total));
  assert.equal(val(changed, 'inPlant'), String(reports[1].wip.now));
});

test('a whole shift in slices equals one straight run, and the computing time it reports is the clock\'s', () => {
  let clock = 0;
  const now = () => clock;
  class Ticking extends Simulation {
    advance(seconds, opts) {
      const done = super.advance(seconds, opts);
      clock += 3; // every advance call costs 3 ms of the fake clock
      return done;
    }
  }
  const core = new DemoCore({ Simulation: Ticking, examples: EXAMPLES, now });
  core.load(demoById('hello-pallet'));
  core.beginShift(3600);
  assert.equal(core.primed, true);
  let frames = 0;
  let result;
  do {
    result = core.shiftFrame(5);
    frames++;
  } while (!result.done && frames < 10000);
  assert.ok(frames > 1, 'a shift is spread over frames');
  assert.equal(result.progress, 1);
  assert.ok(result.computeMs > 0 && result.computeMs <= clock);
  const straight = new Simulation(layoutFor(demoById('hello-pallet'), exampleOf('hello-pallet').build, false));
  straight.advance(3600);
  assert.deepEqual(core.reports(true)[0], straight.kpis(), 'slicing must not change a single number');
  core.cancelShift();
  assert.equal(core.shift, null);
});

test('the silent start rolls past the warm-up, and pause, play and speed behave', () => {
  const core = newCore();
  core.load(demoById('hello-pallet'));
  assert.equal(core.play(), false, 'nothing plays before the plant is rolled forward');
  let slices = 0;
  while (!core.prime(1)) slices++;
  assert.ok(core.time >= primeSeconds(core.panes[0].sim.settings.warmup) - 1e-6);
  assert.equal(core.panes[0].sim.kpis().window.warmingUp, false);
  assert.ok(core.play());
  const t0 = core.time;
  core.frame(0.016, 0);
  assert.ok(core.time > t0);
  core.pause();
  const t1 = core.time;
  assert.deepEqual(core.frame(0.016, 0).advanced, 0);
  assert.equal(core.time, t1);
  assert.equal(core.setSpeed(12345), core.speed, 'an unknown speed is refused');
  assert.equal(core.setSpeed(60), 60);
  assert.ok(slices >= 0);
});

// ---- the planner's renderer on a demo plant ---------------------------------------------------------------------------------

/** A canvas context that accepts every drawing call and records the text it is asked to write. */
function fakeCanvas(width = 800, height = 500) {
  const texts = [];
  let calls = 0;
  const ctx = new Proxy({ canvas: null }, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'measureText') return (t) => ({ width: String(t).length * 6 });
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (prop === 'getLineDash') return () => [];
      if (prop === 'fillText' || prop === 'strokeText') return (t) => { calls++; if (prop === 'fillText') texts.push(String(t)); };
      return () => { calls++; };
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
  const canvas = { width, height, clientWidth: width, clientHeight: height, getContext: () => ctx, parentElement: null };
  ctx.canvas = canvas;
  return { canvas, texts, count: () => calls };
}

test('the planner\'s renderer draws a demo plant with its running simulation (stations, labels, vehicles) on a fake canvas', () => {
  const core = newCore();
  core.load(demoById('hello-pallet'));
  while (!core.prime(50)) { /* slices */ }
  const fake = fakeCanvas();
  const camera = new Camera();
  const renderer = new Renderer(fake.canvas, { camera, theme: getTheme('dark'), createCanvas: () => fakeCanvas().canvas, now: () => 0, dpr: 2, reducedMotion: true });
  const pane = core.panes[0];
  renderer.layout = pane.layout;
  renderer.sim = pane.sim;
  renderer.resize();
  camera.fitRect(contentRect(getScene(pane.layout)), renderer.cssW, renderer.cssH, 8);
  renderer.render(1);
  assert.equal(renderer.stats.frames, 1);
  assert.ok(fake.count() > 100, 'a plant is drawn with many calls');
  assert.ok(fake.texts.some((t) => /Goods in|Goods out|One road/.test(t)), `no station or label text drawn: ${fake.texts.join('|')}`);
  assert.equal(fake.canvas.width, 1600, 'the backing store follows devicePixelRatio');
  // vehicles are in the simulation the renderer reads
  assert.ok(pane.sim.vehicles.length >= 1 && pane.sim.vehicles.every((v) => v.tv && Number.isFinite(v.tv.x)));
  renderer.destroy();
});

// ---- the files ---------------------------------------------------------------------------------------------------------------

test('the demo makes no request to anywhere else: no absolute URLs, no bare imports, only files of this repository', () => {
  const dir = path.join(root, 'how', 'js');
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  assert.ok(files.includes('demo.js') && files.includes('demo-logic.js') && files.includes('demo-boot.js'));
  for (const file of files) {
    const source = readFileSync(path.join(dir, file), 'utf8');
    for (const m of source.matchAll(/(?:import|from)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      assert.ok(m[1].startsWith('.'), `${file}: non-relative import ${m[1]}`);
    }
    const urls = [...source.matchAll(/https?:\/\/[^\s'"`)]+/g)].map((m) => m[0]).filter((u) => u !== 'http://www.w3.org/2000/svg');
    assert.deepEqual(urls, [], `${file}: absolute URLs`);
    assert.ok(!/\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource)\b/.test(source.replace(/\/\/.*$/gm, '')), `${file}: network API`);
    assert.ok(!/localStorage|sessionStorage|document\.cookie|indexedDB/.test(source), `${file}: stores something in the browser`);
  }
  const css = readFileSync(path.join(root, 'how', 'css', 'demo.css'), 'utf8');
  assert.ok(!/https?:|@import|@font-face/.test(css), 'demo.css must not load anything');
});

test('every relative import of the demo resolves to a file that exports the imported names', () => {
  const dir = path.join(root, 'how', 'js');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js'))) {
    const source = readFileSync(path.join(dir, file), 'utf8');
    for (const m of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(dir, m[2]);
      const text = readFileSync(target, 'utf8');
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        assert.ok(new RegExp(`export\\s+(?:async\\s+)?(?:function\\*?|class|const|let|var)\\s+${name}\\b`).test(text) || new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(text), `${file}: ${name} is not exported by ${m[2]}`);
      }
    }
  }
});
