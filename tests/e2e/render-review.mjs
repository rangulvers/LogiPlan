// Independent review of the plant renderer (js/ui/camera.js, theme.js, renderer.js, render/*.js) in headless
// Chromium, plus a few DOM-free checks of the palette and the scene index.
//
//   node tests/e2e/render-review.mjs                  run every check (exit code 1 when a check fails)
//   REVIEW_TOUR=plants|cues|interaction|misc|none     which screenshot tours to take (default: all, `none` = skip)
//   REVIEW_ONLY=<text>                                run only checks whose title or id contains <text>
//
// Screenshots go to e2e-output/review-*.png - LOOK at them. Unlike the builder's harness this page drives the
// renderer with a REAL simulation: the road graph, TrafficSystem, Logistics and Stats of js/sim/, assembled the
// way the future engine (js/sim/engine.js, not written yet) will, running the shipped example plants. Field names
// and shapes that the renderer reads from docs/ARCHITECTURE.md §5 are therefore checked against real objects.
//
// A check titled "[ID severity] ..." pins a defect that is real today (it FAILS until the renderer is fixed);
// checks without an ID guard behaviour that is correct and must stay so. Camera math lives in
// tests/ui.camera.review.test.js (Node). Frame times are measured in headless Chromium with CPU rasterisation on a
// shared machine: use them as an upper bound, not as GPU numbers.

import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { withBrowser, OUT } from './browser.mjs';
import { getTheme, statusColor, contrast, STATUS_COLORS } from '../../js/ui/theme.js';
import { getScene } from '../../js/ui/render/scene.js';
import { createLayout, addStation, addFlow } from '../../js/model/layout.js';

const PAGE_PATH = '/__review.html';
const FRAME_BUDGET_MS = 8;

// ---------------------------------------------------------------------------------------------------------
// The page (runs in the browser)
// ---------------------------------------------------------------------------------------------------------

/** Builds scenarios on top of the real sim modules and exposes window.R. Serialised into the page. */
async function pageMain() {
  const { Renderer, createView } = await import('/js/ui/renderer.js');
  const { Camera, MIN_ZOOM, MAX_ZOOM } = await import('/js/ui/camera.js');
  const { buildGraph } = await import('/js/sim/graph.js');
  const { TrafficSystem } = await import('/js/sim/traffic.js');
  const { Logistics } = await import('/js/sim/logistics.js');
  const { Stats } = await import('/js/sim/stats.js');
  const { createRng } = await import('/js/util/rng.js');
  const { EXAMPLES } = await import('/js/model/examples.js');
  const M = await import('/js/model/layout.js');
  const { layoutFromAscii } = await import('/tests/helpers/ascii.js');
  const { dist, defaultFleet } = await import('/js/model/defaults.js');
  const { drawBrick } = await import('/js/ui/render/bricks.js');

  /** The engine of docs/ARCHITECTURE.md 5.5 reduced to what the renderer reads. */
  function makeSim(layout) {
    const dt = layout.settings.dt || 0.1;
    const graph = buildGraph(layout);
    const traffic = new TrafficSystem(graph, { handedness: layout.settings.handedness, resolveDeadlocks: layout.settings.deadlock !== 'ignore' });
    const sim = { time: 0, layout, graph, traffic, settings: layout.settings, logistics: null, stats: null, dt, tick: 0 };
    const emit = (name, payload) => { if (sim.stats) sim.stats.onEvent(name, payload); };
    sim.logistics = new Logistics({ layout, graph, traffic, rng: createRng(layout.settings.seed), emit });
    traffic.onDeadlock = (info) => { sim.logistics.handleDeadlock(info); emit('deadlock', { ...info, t: sim.time }); };
    sim.stats = new Stats(sim);
    sim.stations = sim.logistics.stations;
    sim.vehicles = sim.logistics.vehicles;
    sim.heat = () => sim.stats.heat();
    sim.step = () => {
      sim.logistics.step(dt, sim.tick * dt);
      traffic.step(dt);
      sim.tick++;
      sim.time = sim.tick * dt;
      sim.stats.sample(dt);
    };
    sim.advance = (seconds) => { for (let i = 0, n = Math.round(seconds / dt); i < n; i++) sim.step(); };
    return sim;
  }

  /** 160 x 160 cells, a road mesh, 40 stations in 8 production lines and 100 vehicles. */
  function bigPlant() {
    const l = M.createLayout({ name: 'Big plant', cols: 160, rows: 160, cellSize: 2 });
    for (let k = 10; k < 160; k += 20) {
      M.paintRoadPath(l, [[2, k], [157, k]]);
      M.paintRoadPath(l, [[k, 2], [k, 157]]);
    }
    const types = ['source', 'process', 'process', 'storage', 'sink'];
    const names = ['In', 'Press', 'Weld', 'Buffer', 'Out'];
    for (let row = 0; row < 8; row++) {
      const k = 10 + row * 20;
      const made = types.map((type, i) => M.addStation(l, { type, name: `${names[i]} ${row + 1}`, x: 13 + i * 20, y: k - 3 }));
      for (let i = 0; i + 1 < made.length; i++) if (made[i] && made[i + 1]) M.addFlow(l, made[i].id, made[i + 1].id);
    }
    M.addFleet(l, 'agv', { count: 60 });
    M.addFleet(l, 'forklift', { count: 40 });
    return l;
  }

  /** Compact plant with breakdowns, batteries, a charging depot and a buffer: every vehicle cue shows up quickly. */
  function busyPlant() {
    return layoutFromAscii(['AA..PP..SS..DD..EE', '++++++++++++++++++'], {
      stations: {
        A: { type: 'source', name: 'Goods in', params: { interArrival: dist('const', 25), outCap: 3 } },
        P: { type: 'process', name: 'Press', params: { cycle: dist('uniform', 40, 0.3), machines: 2, mtbf: 400, mttr: 60, inCap: 3, outCap: 2 } },
        S: { type: 'storage', name: 'Buffer', params: { capacity: 4, dwell: 5 } },
        D: { type: 'sink', name: 'Shipping' },
        E: { type: 'depot', name: 'Bay', params: { slots: 4, chargers: 2 } },
      },
      flows: [['A', 'P'], ['P', 'S'], ['S', 'D']],
      fleets: [{ count: 4, mtbf: 900, mttr: 90, home: 'E', battery: { enabled: true, runtimeMin: 12, chargeTimeMin: 6, lowPct: 40, resumePct: 80 } }],
      settings: { seed: 7, warmup: 300 },
    });
  }

  /** A depot with 4 slots, 2 of them chargers, and 3 AGVs that never need charging: they simply park. */
  function parkLab() {
    return layoutFromAscii(['AA..EE', '++++++'], {
      stations: {
        A: { type: 'source', name: 'Goods in', params: { interArrival: dist('const', 100000) } },
        E: { type: 'depot', name: 'Parking', params: { slots: 4, chargers: 2 } },
      },
      flows: [],
      fleets: [{ count: 3, home: 'E' }],
    });
  }

  /** 40 x 24 cells with a dense road mesh, a short production line and 100 AGVs: everything on screen at once. */
  function densePlant() {
    const l = M.createLayout({ name: 'Dense plant', cols: 40, rows: 24, cellSize: 2 });
    for (const y of [3, 9, 15, 20]) M.paintRoadPath(l, [[1, y], [38, y]]);
    for (const x of [3, 12, 21, 30, 37]) M.paintRoadPath(l, [[x, 1], [x, 22]]);
    const slow = { kind: 'const', mean: 20, spread: 0 };
    const a = M.addStation(l, { type: 'source', name: 'In A', x: 5, y: 1, w: 3, h: 2, params: { interArrival: { kind: 'const', mean: 15, spread: 0 }, outCap: 8 } });
    const b = M.addStation(l, { type: 'process', name: 'Press', x: 14, y: 4, w: 3, h: 3, params: { cycle: slow, machines: 3 } });
    const c = M.addStation(l, { type: 'storage', name: 'Buffer', x: 23, y: 4, w: 4, h: 3 });
    const d = M.addStation(l, { type: 'process', name: 'Weld', x: 14, y: 16, w: 3, h: 3, params: { cycle: slow, machines: 2 } });
    const e = M.addStation(l, { type: 'sink', name: 'Out', x: 31, y: 10, w: 3, h: 2 });
    M.addStation(l, { type: 'depot', name: 'Park', x: 5, y: 21, w: 3, h: 2, params: { slots: 8, chargers: 2 } });
    for (const [f, t] of [[a, b], [b, c], [c, d], [d, e]]) if (f && t) M.addFlow(l, f.id, t.id);
    M.addFleet(l, 'agv', { count: 100, idle: 'stay' });
    return l;
  }

  /** The starter plant with slow zones and a tugger + forklift fleet (long vehicles turning in 2 m corners). */
  function zonesAndTuggers() {
    const l = EXAMPLES[0].build();
    for (const [x, y] of [[20, 4], [21, 4], [22, 4], [23, 4], [24, 4]]) M.setRoadLimit(l, x, y, 0.5);
    for (const [x, y] of [[8, 8], [8, 9]]) M.setRoadLimit(l, x, y, 0.25);
    l.fleets = [defaultFleet('tugger', { id: 'v1', count: 2, capacity: 4 }), defaultFleet('forklift', { id: 'v2', count: 2 })];
    return l;
  }

  /** Small cells (0.5 m) with stations one cell apart, and two touching stations: flow arrows get very short. */
  function tinyCells() {
    const l = M.createLayout({ name: 'Tiny cells', cols: 60, rows: 30, cellSize: 0.5 });
    M.paintRoadPath(l, [[2, 10], [57, 10]]);
    const a = M.addStation(l, { type: 'source', name: 'A', x: 4, y: 6, w: 3, h: 3 });
    const b = M.addStation(l, { type: 'process', name: 'B', x: 8, y: 6, w: 3, h: 3 });
    const c = M.addStation(l, { type: 'process', name: 'C', x: 11, y: 6, w: 3, h: 3 });
    const d = M.addStation(l, { type: 'sink', name: 'D', x: 20, y: 6, w: 3, h: 3 });
    M.addFlow(l, a.id, b.id);
    M.addFlow(l, b.id, c.id);
    M.addFlow(l, c.id, d.id);
    M.addFleet(l, 'agv', { count: 1 });
    return l;
  }

  const SCENARIOS = {
    zones: zonesAndTuggers,
    tiny: tinyCells,
    dense: densePlant,
    busy: busyPlant,
    parkLab,
    starter: () => EXAMPLES[0].build(),
    twoLines: () => EXAMPLES[1].build(),
    congestion: () => EXAMPLES[2].build(),
    big: bigPlant,
  };

  const canvas = document.getElementById('c');
  const camera = new Camera();
  const renderer = new Renderer(canvas, { camera, theme: 'light' });
  renderer.view = createView();
  let layout = null;
  let sim = null;

  const scratch = document.createElement('canvas');
  scratch.width = 1;
  scratch.height = 1;
  const sctx = scratch.getContext('2d', { willReadFrequently: true });
  const normCtx = document.createElement('canvas').getContext('2d');
  /** A CSS colour as the canvas reports it back (so strings compare equal). */
  const norm = (c) => { normCtx.fillStyle = '#000000'; normCtx.fillStyle = c; return normCtx.fillStyle; };

  const R = {
    renderer, camera, canvas, M, MIN_ZOOM, MAX_ZOOM, createView, Camera, Renderer, layoutFromAscii, makeSim, buildGraph, drawBrick, norm,
    get layout() { return layout; },
    get sim() { return sim; },
    /** Build a scenario, run the sim for `run` seconds, fit the camera and render. */
    load(name, { run = 0, dark = false, settings = null } = {}) {
      layout = SCENARIOS[name]();
      if (settings) Object.assign(layout.settings, settings);
      sim = makeSim(layout);
      sim.advance(run);
      renderer.layout = layout;
      renderer.sim = sim;
      renderer.view = createView();
      R.theme(dark ? 'dark' : 'light');
      camera.fit(layout, canvas.clientWidth, canvas.clientHeight, 24);
      renderer.render(1);
      return { cols: layout.grid.cols, rows: layout.grid.rows, cs: layout.grid.cellSize, vehicles: sim.vehicles.length };
    },
    /** Show an arbitrary layout / simulation (sim may be null). */
    use(newLayout, newSim = null) {
      layout = newLayout;
      sim = newSim;
      renderer.layout = layout;
      renderer.sim = sim;
      renderer.view = createView();
      camera.fit(layout, canvas.clientWidth, canvas.clientHeight, 24);
      renderer.render(1);
    },
    theme(mode) {
      renderer.theme = mode;
      document.body.classList.toggle('dark', mode === 'dark');
      renderer.render(1);
    },
    view(patch) {
      const { overlays, ...rest } = patch;
      Object.assign(renderer.view, rest);
      if (overlays) Object.assign(renderer.view.overlays, overlays);
      renderer.render(1);
    },
    advance(seconds) { sim.advance(seconds); renderer.render(1); },
    /** Step the sim in 2 s slices until a vehicle shows `kind`; returns the vehicle index or -1. */
    runUntil(kind, maxSeconds = 3000) {
      const test = {
        broken: (v) => v.tv.disabled && v.visible,
        waiting: (v) => v.tv.waiting && v.visible,
        loaded: (v) => v.load.length > 0 && v.visible,
        lowBattery: (v) => v.fleet.battery.enabled && v.battery < 0.45 && v.visible,
        charging: (v) => v.state === 'charging',
        turning: (v) => v.tv.driving && v.visible && Math.abs(Math.sin(2 * v.heading)) > 0.5 && v.tv.length > 3,
      }[kind];
      for (let t = 0; t < maxSeconds; t += 2) {
        sim.advance(2);
        const i = sim.vehicles.findIndex(test);
        if (i >= 0) { renderer.render(1); return i; }
      }
      return -1;
    },
    /** Centre the camera on cell (cx, cy) at `zoom` px per metre. */
    focus(cx, cy, zoom) {
      const cs = layout.grid.cellSize;
      camera.zoomTo(zoom);
      camera.centerOn((cx + 0.5) * cs, (cy + 0.5) * cs);
      renderer.render(1);
    },
    focusWorld(x, y, zoom) {
      camera.zoomTo(zoom);
      camera.centerOn(x, y);
      renderer.render(1);
    },
    fit(pad = 24) {
      camera.fit(layout, canvas.clientWidth, canvas.clientHeight, pad);
      renderer.render(1);
    },
    vehicleInfo() {
      return sim.vehicles.map((v, i) => ({
        i, id: v.id, state: v.state, x: v.x, y: v.y, heading: v.heading, visible: v.visible, waiting: v.tv.waiting,
        loads: v.load.length, battery: v.battery, disabled: v.tv.disabled, driving: v.tv.driving,
      }));
    },
    /** RGB of the on-screen canvas pixel at device position (x, y). */
    pixel(x, y) {
      sctx.clearRect(0, 0, 1, 1);
      sctx.drawImage(canvas, x, y, 1, 1, 0, 0, 1, 1);
      return Array.from(sctx.getImageData(0, 0, 1, 1).data.slice(0, 3));
    },
    /** RGBA bytes of the whole on-screen canvas (device pixels). */
    snapshot() {
      const c = document.createElement('canvas');
      c.width = canvas.width;
      c.height = canvas.height;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(canvas, 0, 0);
      return g.getImageData(0, 0, c.width, c.height);
    },
    /** Wait two animation frames (so a screenshot sees final pixels). */
    settle: () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    /** Log the calls of the given CanvasRenderingContext2D methods made while `fn` runs. */
    capture(fn, names) {
      const proto = CanvasRenderingContext2D.prototype;
      const saved = {};
      const log = [];
      for (const n of names) {
        saved[n] = proto[n];
        proto[n] = function patched(...a) {
          log.push({ n, a, fill: this.fillStyle, stroke: this.strokeStyle, font: this.font, main: this.canvas === canvas });
          return saved[n].apply(this, a);
        };
      }
      try { fn(); } finally { for (const n of names) proto[n] = saved[n]; }
      return log;
    },
    /** Filled / stroked path shapes (bounding box, style, which primitives built them) made while `fn` runs. */
    shapes(fn) {
      const proto = CanvasRenderingContext2D.prototype;
      const names = ['beginPath', 'moveTo', 'lineTo', 'arcTo', 'arc', 'rect', 'quadraticCurveTo', 'fill', 'stroke', 'fillRect'];
      const saved = {};
      const out = [];
      let cur = { pts: [], kinds: new Set() };
      const box = (pts) => {
        let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
        for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
        return { x0, y0, x1, y1 };
      };
      const hooks = {
        beginPath() { cur = { pts: [], kinds: new Set() }; },
        moveTo(x, y) { cur.pts.push([x, y]); },
        lineTo(x, y) { cur.pts.push([x, y]); },
        quadraticCurveTo(cx, cy, x, y) { cur.pts.push([cx, cy], [x, y]); },
        arcTo(x1, y1, x2, y2) { cur.pts.push([x1, y1], [x2, y2]); cur.kinds.add('arcTo'); },
        arc(x, y, r) { cur.pts.push([x - r, y - r], [x + r, y + r]); cur.kinds.add('arc'); },
        rect(x, y, w, h) { cur.pts.push([x, y], [x + w, y + h]); cur.kinds.add('rect'); },
      };
      for (const n of names) {
        saved[n] = proto[n];
        proto[n] = function patched(...a) {
          if (hooks[n]) hooks[n](...a);
          else if (n === 'fillRect') out.push({ op: 'fillRect', fill: this.fillStyle, kinds: ['fillRect'], ...box([[a[0], a[1]], [a[0] + a[2], a[1] + a[3]]]) });
          else if (cur.pts.length) out.push({ op: n, fill: this.fillStyle, stroke: this.strokeStyle, kinds: [...cur.kinds], ...box(cur.pts) });
          return saved[n].apply(this, a);
        };
      }
      try { fn(); } finally { for (const n of names) proto[n] = saved[n]; }
      return out;
    },
  };
  window.R = R;
  window.__ready = true;
}

export const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>render review</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#eef1f6}body.dark{background:#12161d}
canvas{display:block;width:100vw;height:100vh}</style></head>
<body><canvas id="c"></canvas>
<script type="module">(${pageMain.toString()})().catch((e) => { console.error('page init failed: ' + e.stack); });</script>
</body></html>`;

/** Load the review page. The sim modules are being edited by other engineers: retry a few times if they do not import. */
export async function openPage({ page, url, errors }) {
  await page.route(url(PAGE_PATH), (route) => route.fulfill({ status: 200, contentType: 'text/html', body: PAGE_HTML }));
  for (let attempt = 1; ; attempt++) {
    const before = errors ? errors.length : 0;
    await page.goto(url(PAGE_PATH));
    try {
      await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });
      return;
    } catch (e) {
      const why = errors ? errors.slice(before).join(' ') : String(e.message);
      if (attempt >= 4) throw new Error(`review page failed to initialise: ${why}`);
      if (errors) errors.length = before;
      await new Promise((r) => setTimeout(r, 6000));
    }
  }
}

// ---------------------------------------------------------------------------------------------------------
// Check registry
// ---------------------------------------------------------------------------------------------------------

const registry = [];
/** Register a check. `id` is '' for guards of correct behaviour. */
function check(id, severity, title, fn, opts = {}) {
  registry.push({ id, severity, title, fn, opts });
}

const P = (ctx, fn, arg) => ctx.page.evaluate(fn, arg);
const shotPaths = [];

/** Screenshot the canvas (optionally a clip) as e2e-output/review-<name>.png. */
async function snap(ctx, name, clip) {
  await ctx.page.evaluate(() => window.R.settle());
  const file = path.join(OUT, `review-${name}.png`);
  await ctx.page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  shotPaths.push(file);
  return file;
}

// ---------------------------------------------------------------------------------------------------------
// DOM-free checks: palette and scene index
// ---------------------------------------------------------------------------------------------------------

check('THEME-1', 'medium', 'state dot: the white mark inside the dot (the colour-independent cue) needs >= 2.5:1 against every state colour', async () => {
  // glyphs.drawStatusMark draws a white mark inside a dot filled with statusColor(state); WCAG asks 3:1 for graphical objects
  const bad = [];
  for (const state of Object.keys(STATUS_COLORS)) {
    const ratio = contrast('#ffffff', statusColor(state));
    if (ratio < 2.5) bad.push(`${state} ${statusColor(state)} -> ${ratio.toFixed(2)}:1`);
  }
  assert.deepEqual(bad, [], 'white status mark is hard to read on: ' + bad.join(', '));
}, { node: true });

check('THEME-3', 'low', 'brick ink (fill labels, counts) reaches 4.5:1 on every brick colour in both themes', async () => {
  const bad = [];
  for (const mode of ['light', 'dark']) {
    for (const [type, pal] of Object.entries(getTheme(mode).station)) {
      const ratio = contrast(pal.top, pal.ink);
      if (ratio < 4.5) bad.push(`${mode} ${type}: ${pal.ink} on ${pal.top} = ${ratio.toFixed(2)}:1`);
    }
  }
  assert.deepEqual(bad, [], bad.join('; '));
}, { node: true });

check('FLOW-1', 'medium', 'every flow between two stations is drawable and selectable, also between touching stations / 0.5 m cells', async () => {
  const l = createLayout({ cols: 20, rows: 10, cellSize: 0.5 });
  const a = addStation(l, { type: 'source', x: 1, y: 1, w: 3, h: 3 });
  const b = addStation(l, { type: 'process', x: 4, y: 1, w: 3, h: 3 }); // touching A
  const c = addStation(l, { type: 'process', x: 8, y: 1, w: 3, h: 3 }); // one 0.5 m cell after B
  assert.ok(a && b && c);
  addFlow(l, a.id, b.id);
  addFlow(l, b.id, c.id);
  const scene = getScene(l);
  assert.equal(l.flows.length, 2);
  assert.equal(scene.flows.length, l.flows.length, `${l.flows.length - scene.flows.length} of ${l.flows.length} flows have no arrow, so they are invisible and cannot be clicked`);
}, { node: true });

// ---------------------------------------------------------------------------------------------------------
// hitTest
// ---------------------------------------------------------------------------------------------------------

const hitGuard = async (ctx) => {
  const res = await P(ctx, () => {
    const R = window.R;
    const fails = [];
    R.load('twoLines', { run: 300 });
    const cs = R.layout.grid.cellSize;
    const noLabels = R.M.cloneLayout(R.layout);
    noLabels.labels = [];
    // ---- stations at several zooms, no vehicles / labels in the way
    R.use(noLabels, null);
    for (const zoom of [6, 20, 40, 70]) {
      for (const st of noLabels.stations) {
        R.focusWorld((st.x + st.w / 2) * cs, (st.y + st.h / 2) * cs, zoom);
        const cam = R.camera;
        const [x0, y0] = cam.worldToScreen(st.x * cs, st.y * cs);
        const [x1, y1] = cam.worldToScreen((st.x + st.w) * cs, (st.y + st.h) * cs);
        const mx = (x0 + x1) / 2;
        const my = (y0 + y1) / 2;
        const probes = [['centre', mx, my, true], ['left+1.5', x0 + 1.5, my, true], ['right-1.5', x1 - 1.5, my, true], ['top+1.5', mx, y0 + 1.5, true], ['bottom-1.5', mx, y1 - 1.5, true],
          ['left-2.5', x0 - 2.5, my, false], ['right+2.5', x1 + 2.5, my, false], ['top-2.5', mx, y0 - 2.5, false], ['bottom+2.5', mx, y1 + 2.5, false]];
        for (const [label, px, py, inside] of probes) {
          const hit = R.renderer.hitTest(px, py);
          const isThis = hit.kind === 'station' && hit.id === st.id;
          if (isThis !== inside) fails.push(`zoom ${zoom} ${st.id} ${label}: got ${hit.kind}/${hit.id}`);
        }
      }
    }
    // ---- handles
    R.fit();
    const target = noLabels.stations.find((s) => s.type === 'storage');
    R.view({ selection: { kind: 'station', ids: [target.id] }, resizeHandles: true });
    const tl = R.camera.worldToScreen(target.x * cs, target.y * cs);
    const br = R.camera.worldToScreen((target.x + target.w) * cs, (target.y + target.h) * cs);
    const midx = (tl[0] + br[0]) / 2;
    const midy = (tl[1] + br[1]) / 2;
    const expectHandle = { nw: [tl[0], tl[1]], n: [midx, tl[1]], ne: [br[0], tl[1]], e: [br[0], midy], se: [br[0], br[1]], s: [midx, br[1]], sw: [tl[0], br[1]], w: [tl[0], midy] };
    for (const [name, [px, py]] of Object.entries(expectHandle)) {
      for (const [dx, dy] of [[0, 0], [2, -2], [-3, 3]]) {
        const hit = R.renderer.hitTest(px + dx, py + dy);
        if (hit.handle !== name || hit.id !== target.id) fails.push(`handle ${name} (${dx},${dy}): got ${hit.kind}/${hit.id}/${hit.handle}`);
      }
    }
    const body = R.renderer.hitTest(midx, midy);
    if (body.kind !== 'station' || body.handle !== 'move') fails.push(`body of selected station: ${JSON.stringify(body)}`);
    R.view({ resizeHandles: false });
    const noHandle = R.renderer.hitTest(tl[0], tl[1]);
    if (noHandle.handle !== 'move' && noHandle.handle !== undefined) fails.push(`resizeHandles off must not return a resize handle: ${noHandle.handle}`);
    R.view({ selection: { kind: 'station', ids: [target.id, noLabels.stations[0].id] }, resizeHandles: true });
    const two = R.renderer.hitTest(br[0], br[1]);
    if (two.handle && two.handle !== 'move') fails.push(`two selected stations must not offer resize handles, got ${two.handle}`);
    R.view({ selection: { kind: null, ids: [] }, resizeHandles: false });
    const un = R.renderer.hitTest(midx, midy);
    if (un.handle !== undefined) fails.push(`unselected station has a handle: ${un.handle}`);
    // ---- flows: 6 px band
    R.use(noLabels, null);
    R.fit();
    const fr = R.renderer._fr;
    let flowProbes = 0;
    for (const e of fr.scene.flows) {
      const c = e.curve;
      const t = (c.t0 + c.t1) / 2;
      const s = 1 - t;
      const wx = s * s * c.ax + 2 * s * t * c.qx + t * t * c.bx;
      const wy = s * s * c.ay + 2 * s * t * c.qy + t * t * c.by;
      const dx = 2 * s * (c.qx - c.ax) + 2 * t * (c.bx - c.qx);
      const dy = 2 * s * (c.qy - c.ay) + 2 * t * (c.by - c.qy);
      const len = Math.hypot(dx, dy);
      const nx = -dy / len;
      const ny = dx / len;
      const [sx, sy] = R.camera.worldToScreen(wx, wy);
      const covered = fr.scene.stations.some((st) => wx >= st.x && wx < st.x + st.w && wy >= st.y && wy < st.y + st.h);
      if (covered) continue;
      flowProbes++;
      for (const [off, expect] of [[0, true], [5, true], [-5, true], [9.5, false], [-9.5, false]]) {
        const hit = R.renderer.hitTest(sx + nx * off, sy + ny * off);
        const isFlow = hit.kind === 'flow' && hit.id === e.flow.id;
        if (isFlow !== expect && !(hit.kind === 'station' || hit.kind === 'flow')) fails.push(`flow ${e.flow.id} offset ${off}: got ${hit.kind}`);
        if (expect && !isFlow) fails.push(`flow ${e.flow.id} offset ${off} px should hit the flow, got ${hit.kind}/${hit.id}`);
        if (!expect && isFlow) fails.push(`flow ${e.flow.id} offset ${off} px is outside the 6 px band but hit the flow`);
      }
    }
    if (flowProbes < 3) fails.push(`only ${flowProbes} flows could be probed`);
    // ---- vehicles and labels on the real sim
    R.load('twoLines', { run: 300 });
    R.fit();
    let vehicleProbes = 0;
    const seen = [];
    for (const v of R.sim.vehicles) {
      if (!v.visible) continue;
      const [px, py] = R.camera.worldToScreen(v.x, v.y);
      const hit = R.renderer.hitTest(px, py);
      vehicleProbes++;
      if (hit.kind !== 'vehicle') seen.push(`${v.id} -> ${hit.kind}`);
    }
    if (seen.length) fails.push('vehicle centres not hit: ' + seen.join(', '));
    if (vehicleProbes === 0) fails.push('no visible vehicles to probe');
    const hidden = R.sim.vehicles.find((v) => !v.visible);
    if (hidden) {
      const [px, py] = R.camera.worldToScreen(hidden.x, hidden.y);
      if (R.renderer.hitTest(px, py).kind === 'vehicle') fails.push('a parked (invisible) vehicle was hit');
    }
    for (const l of R.layout.labels) {
      R.focusWorld(l.x * cs, l.y * cs, 20);
      const hit = R.renderer.hitTest(R.camera.width / 2, R.camera.height / 2);
      if (hit.kind !== 'label' || hit.id !== l.id) fails.push(`label ${l.id} centre: got ${hit.kind}/${hit.id}`);
    }
    // ---- negative / odd coordinates
    for (const [px, py] of [[-1, -1], [-1e6, -1e6], [1e9, -1e9], [NaN, 5], [5, Infinity], [0, 0], [R.camera.width, R.camera.height]]) {
      const hit = R.renderer.hitTest(px, py);
      if (!Array.isArray(hit.cell) || hit.cell.length !== 2 || !hit.cell.every((c) => Number.isFinite(c) && Number.isInteger(c))) fails.push(`hitTest(${px}, ${py}) cell ${JSON.stringify(hit.cell)}`);
      if (hit.cell.some((c) => Object.is(c, -0))) fails.push(`hitTest(${px}, ${py}) returned a negative zero cell`);
    }
    const far = R.renderer.hitTest(-1e6, -1e6);
    if (far.kind !== 'cell' || far.cell[0] >= 0 || far.cell[1] >= 0) fails.push(`far outside: ${JSON.stringify(far)}`);
    return { fails, flowProbes, vehicleProbes };
  });
  assert.deepEqual(res.fails, [], res.fails.slice(0, 12).join('\n'));
};
check('', '', 'hitTest: station centres and edges, resize handles, flows (6 px band), vehicles, labels, negative coordinates', hitGuard);
for (const dpr of [1.5, 2]) {
  check('', '', `hitTest: the same guard at devicePixelRatio ${dpr} (coordinates stay CSS pixels)`, hitGuard, { viewport: { width: 1000, height: 700 }, deviceScaleFactor: dpr });
}

check('', '', 'hitTest priority: vehicle > resize handle > label > station > flow > obstacle > cell', async (ctx) => {
  const res = await P(ctx, () => {
    const R = window.R;
    const fails = [];
    const cs = 2;
    const base = () => {
      const l = R.M.createLayout({ cols: 24, rows: 12, cellSize: cs });
      const st = (id, type, x, y, w, h) => l.stations.push({ id, type, name: id, x, y, w, h, params: {} });
      st('A', 'source', 1, 4, 3, 3);
      st('C', 'sink', 18, 4, 3, 3);
      st('B', 'process', 9, 4, 4, 3); // sits on the A -> C arrow
      l.flows.push({ id: 'f1', from: 'A', to: 'C', weight: 1, perCycle: 1, batchMin: 1, batchMax: 0, maxWait: 0, priority: 1, fleetId: null });
      return l;
    };
    const vehicle = (x, y) => ({ id: 'veh', fleetId: 'v', color: '#2d7ff9', state: 'idle', load: [], battery: 1, visible: true, x, y, heading: 0, prevX: x, prevY: y, prevHeading: 0, tv: { length: 1.2, width: 0.66 }, fleet: { id: 'v', battery: { enabled: false } } });
    const simWith = (vehicles) => ({ vehicles, logistics: { stationById: new Map() } });
    // layouts are immutable snapshots (scene index cached per object): every scenario gets a fresh object
    const show = (l, sim = null, view = {}) => { R.use(l, sim); R.view(view); };
    const at = (wx, wy) => {
      R.camera.zoomTo(20);
      R.camera.centerOn(wx, wy);
      R.renderer.render(1);
      return R.renderer.hitTest(R.camera.width / 2, R.camera.height / 2);
    };
    const expect = (label, hit, kind, id) => { if (hit.kind !== kind || (id !== undefined && hit.id !== id && hit.handle !== id)) fails.push(`${label}: expected ${kind}${id ? '/' + id : ''}, got ${hit.kind}/${hit.id}/${hit.handle}`); };

    const B = { x: 11 * cs, y: 5.5 * cs }; // centre of B (x 9..13 cells, y 4..7)
    const plain = base();
    show(plain);
    const c = R.renderer._fr.scene.flows[0].curve;
    const t = c.t0 + (c.t1 - c.t0) * 0.25; // a point of the arrow between A and B
    const s1 = 1 - t;
    const pt = { x: s1 * s1 * c.ax + 2 * s1 * t * c.qx + t * t * c.bx, y: s1 * s1 * c.ay + 2 * s1 * t * c.qy + t * t * c.by };
    expect('station over flow (arrow runs under B)', at(B.x, B.y), 'station', 'B');
    expect('flow alone', at(pt.x, pt.y), 'flow', 'f1');
    expect('empty cell', at(2 * cs, 10 * cs), 'cell');
    const withObstacle = base();
    withObstacle.obstacles.push({ id: 'o1', x: Math.floor(pt.x / cs) - 1, y: Math.floor(pt.y / cs) - 1, w: 3, h: 3, kind: 'rack' });
    show(withObstacle);
    expect('flow over obstacle', at(pt.x, pt.y), 'flow', 'f1');
    expect('obstacle beside the flow', at((Math.floor(pt.x / cs) - 0.5) * cs, (Math.floor(pt.y / cs) + 1.5) * cs), 'obstacle', 'o1');
    const withLabel = base();
    withLabel.labels.push({ id: 'lab', x: 11, y: 5.5, text: 'Label over brick' });
    show(withLabel);
    expect('label over station', at(B.x, B.y), 'label', 'lab');
    const withCorner = base();
    withCorner.labels.push({ id: 'lab2', x: 9, y: 4, text: 'Corner label' });
    show(withCorner, null, { selection: { kind: 'station', ids: ['B'] }, resizeHandles: true });
    expect('resize handle over label', at(9 * cs, 4 * cs), 'station', 'nw');
    show(base(), simWith([vehicle(9 * cs, 4 * cs)]), { selection: { kind: 'station', ids: ['B'] }, resizeHandles: true });
    expect('vehicle over resize handle', at(9 * cs, 4 * cs), 'vehicle', 'veh');
    const both = base();
    both.labels.push({ id: 'lab', x: 11, y: 5.5, text: 'Label over brick' });
    show(both, simWith([vehicle(B.x, B.y)]));
    expect('vehicle over label and station', at(B.x, B.y), 'vehicle', 'veh');
    return fails;
  });
  assert.deepEqual(res, [], res.join('\n'));
});

check('HIT-1', 'medium', 'hitTest must not return labels that are hidden by the "labels" overlay', async (ctx) => {
  const res = await P(ctx, () => {
    const R = window.R;
    R.load('twoLines', { run: 5 });
    const l = R.layout.labels[1];
    const cs = R.layout.grid.cellSize;
    R.focusWorld(l.x * cs, l.y * cs, 20);
    const c = [R.camera.width / 2, R.camera.height / 2];
    const shown = R.renderer.hitTest(...c);
    R.view({ overlays: { labels: false } });
    const hidden = R.renderer.hitTest(...c);
    return { shown: `${shown.kind}/${shown.id}`, hidden: `${hidden.kind}/${hidden.id}` };
  });
  assert.equal(res.shown, 'label/' + res.shown.split('/')[1], 'control: the label is hit while visible');
  assert.notEqual(res.hidden.split('/')[0], 'label', `with view.overlays.labels = false the invisible label "${res.hidden}" is still picked`);
});

check('HIT-2', 'low', 'hitTest: when a station is hit, hit.cell must lie inside that station (renderer rounds the origin, camera does not)', async (ctx) => {
  const res = await P(ctx, () => {
    const R = window.R;
    R.load('twoLines', { run: 5 });
    const noLabels = R.M.cloneLayout(R.layout);
    noLabels.labels = [];
    R.use(noLabels, null);
    const cs = noLabels.grid.cellSize;
    let bad = 0;
    let total = 0;
    let example = null;
    for (const zoom of [4, 7.3, 12.4, 20, 33.3]) {
      for (const [cx, cy] of [[56, 33], [50.37, 31.61], [60.123, 40.77]]) {
        R.focusWorld(cx, cy, zoom);
        for (const st of noLabels.stations) {
          const edges = [[st.x * cs, st.y * cs, st.x * cs, (st.y + st.h) * cs], [(st.x + st.w) * cs, st.y * cs, (st.x + st.w) * cs, (st.y + st.h) * cs],
            [st.x * cs, st.y * cs, (st.x + st.w) * cs, st.y * cs], [st.x * cs, (st.y + st.h) * cs, (st.x + st.w) * cs, (st.y + st.h) * cs]];
          for (const [ax, ay, bx, by] of edges) {
            for (let t = 0.1; t < 1; t += 0.2) {
              const [sx, sy] = R.camera.worldToScreen(ax + (bx - ax) * t, ay + (by - ay) * t);
              for (let d = -1; d <= 1; d += 0.25) for (const [ox, oy] of [[d, 0], [0, d]]) {
                const hit = R.renderer.hitTest(sx + ox, sy + oy);
                if (hit.kind !== 'station' || hit.id !== st.id) continue;
                total++;
                const [hx, hy] = hit.cell;
                if (hx < st.x || hy < st.y || hx >= st.x + st.w || hy >= st.y + st.h) { bad++; example = example || `zoom ${zoom} ${st.id} at (${(sx + ox).toFixed(2)}, ${(sy + oy).toFixed(2)}) reports cell ${hit.cell} outside [${st.x},${st.y},${st.w},${st.h}]`; }
              }
            }
          }
        }
      }
    }
    return { bad, total, example };
  });
  assert.equal(res.bad, 0, `${res.bad} of ${res.total} border probes disagree between kind and cell, e.g. ${res.example}`);
});

// ---------------------------------------------------------------------------------------------------------
// real-simulation integration
// ---------------------------------------------------------------------------------------------------------

check('DEPOT-1', 'medium', 'depot bays show every parked / charging vehicle (4 slots, 2 chargers, 3 parked AGVs)', async (ctx) => {
  const res = await P(ctx, () => {
    const R = window.R;
    R.load('parkLab', { run: 5 });
    const depot = R.sim.logistics.stationById.get('E');
    R.focus(5, 1, 40);
    // the parked vehicle silhouette is the only thing drawn with rotate(-PI/2)
    const log = R.capture(() => R.renderer.render(1), ['rotate']);
    const icons = log.filter((c) => Math.abs(c.a[0] + Math.PI / 2) < 1e-9).length;
    return { slots: depot.slots, chargers: depot.chargers, parked: depot.parked.length, charging: depot.charging.length, label: depot.fillLabel, icons };
  });
  assert.equal(res.icons, res.parked + res.charging,
    `depot says ${res.label} (${res.parked} parked, ${res.charging} charging, ${res.chargers} charger slots) but draws ${res.icons} vehicle icons`);
});

check('', '', 'depot bays over a whole run of the busy plant (parking and charging vehicles): icons == parked + charging at every sample (depends on how the sim parks: the parkLab check above is the deterministic one)', async (ctx) => {
  const res = await P(ctx, () => {
    const R = window.R;
    R.load('busy', { run: 0 });
    const depot = R.sim.logistics.stationById.get('E');
    R.focus(17, 0, 40);
    const rows = [];
    for (let t = 0; t < 2400; t += 40) {
      R.sim.advance(40);
      const log = R.capture(() => R.renderer.render(1), ['rotate']);
      const icons = log.filter((c) => Math.abs(c.a[0] + Math.PI / 2) < 1e-9).length;
      rows.push({ t: t + 40, parked: depot.parked.length, charging: depot.charging.length, icons });
    }
    return rows;
  });
  const bad = res.filter((r) => r.icons !== r.parked + r.charging);
  assert.ok(res.some((r) => r.parked + r.charging > 0), 'nobody ever entered the depot: scenario is broken');
  assert.deepEqual(bad.map((r) => `t=${r.t}s: ${r.parked} parked + ${r.charging} charging but ${r.icons} icons`), []);
});

const poseGuard = async (ctx) => {
  const res = await P(ctx, () => {
    const R = window.R;
    const out = [];
    for (const alpha of [0, 0.5, 1]) {
      R.load('dense', { run: 600 });
      R.view({ overlays: { grid: false } });
      R.renderer.render(alpha);
      const cs = R.layout.grid.cellSize;
      const live = R.sim.vehicles;
      const withV = R.snapshot();
      R.renderer.sim = Object.assign(Object.create(R.sim), { vehicles: [] });
      R.renderer.render(alpha);
      const without = R.snapshot();
      R.renderer.sim = R.sim;
      const dpr = devicePixelRatio;
      const w = withV.width;
      const h = withV.height;
      const windows = [];
      let missing = 0;
      let drawn = 0;
      for (const v of live) {
        if (!v.visible) continue;
        let x = v.x; let y = v.y;
        if (Math.abs(v.x - v.prevX) <= cs * 1.5 && Math.abs(v.y - v.prevY) <= cs * 1.5) { x = v.prevX + (v.x - v.prevX) * alpha; y = v.prevY + (v.y - v.prevY) * alpha; }
        const [sx, sy] = R.camera.worldToScreen(x, y);
        const r = (1.2 * Math.max(v.tv.length * R.camera.zoom, 9) + 22) * dpr;
        windows.push([sx * dpr, sy * dpr, r]);
      }
      const inWindow = (px, py) => windows.some(([cx, cy, r]) => Math.abs(px - cx) <= r && Math.abs(py - cy) <= r);
      const perWindow = windows.map(() => 0);
      let stray = 0;
      let strayExample = null;
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const i = (py * w + px) * 4;
          if (Math.abs(withV.data[i] - without.data[i]) + Math.abs(withV.data[i + 1] - without.data[i + 1]) + Math.abs(withV.data[i + 2] - without.data[i + 2]) < 30) continue;
          let found = false;
          for (let k = 0; k < windows.length; k++) {
            const [cx, cy, r] = windows[k];
            if (Math.abs(px - cx) <= r && Math.abs(py - cy) <= r) { perWindow[k]++; found = true; }
          }
          if (!found && !inWindow(px, py)) { stray++; strayExample = strayExample || [px, py]; }
        }
      }
      perWindow.forEach((n) => { if (n === 0) missing++; else drawn++; });
      out.push({ alpha, vehicles: windows.length, drawn, missing, stray, strayExample });
    }
    return out;
  });
  for (const r of res) {
    assert.ok(r.vehicles >= 80, `alpha ${r.alpha}: only ${r.vehicles} visible vehicles`);
    assert.equal(r.missing, 0, `alpha ${r.alpha}: ${r.missing} visible vehicles left no pixels at their pose`);
    assert.equal(r.stray, 0, `alpha ${r.alpha}: ${r.stray} pixels changed far from every vehicle (first at ${r.strayExample})`);
  }
};
check('', '', 'real sim: every visible vehicle is drawn at its interpolated pose and nothing else is drawn on the plant', poseGuard);
for (const dpr of [1.5, 2]) {
  check('', '', `real sim: vehicle poses on screen at devicePixelRatio ${dpr}`, poseGuard, { viewport: { width: 1000, height: 700 }, deviceScaleFactor: dpr });
}

check('', '', 'real sim: heat strips lie in the lane the vehicles drive in (right- and left-hand traffic)', async (ctx) => {
  const res = await P(ctx, () => {
    const R = window.R;
    const out = [];
    for (const handedness of ['right', 'left']) {
      R.load('twoLines', { run: 200, settings: { handedness } });
      const g = R.sim.graph;
      R.sim.heat = () => ({ edgePasses: new Int32Array(g.edges.length).fill(7), edgeWait: new Float64Array(g.edges.length), nodeWait: new Float64Array(g.nodeCount) });
      R.view({ overlays: { heat: 'traffic' } });
      let checked = 0;
      const bad = [];
      for (let step = 0; step < 40 && checked < 12; step++) {
        R.sim.advance(10);
        R.renderer._heat.at = -Infinity; // force a heat refresh for this frame
        R.renderer.render(1);
        const heat = R.renderer._heat;
        for (const v of R.sim.vehicles) {
          if (!v.visible || v.tv.edge < 0) continue;
          const e = g.edges[v.tv.edge];
          if (Math.abs(Math.sin(2 * v.heading)) >= 0.02 || e.rev < 0) continue; // straight stretches of two-way roads only
          checked++;
          let inside = false;
          for (let i = 0; i < heat.count && !inside; i++) {
            const x = heat.rects[i * 4]; const y = heat.rects[i * 4 + 1]; const w = heat.rects[i * 4 + 2]; const h = heat.rects[i * 4 + 3];
            if (v.x >= x && v.x <= x + w && v.y >= y && v.y <= y + h) inside = true;
          }
          if (!inside) bad.push(`${v.id} at (${v.x.toFixed(2)}, ${v.y.toFixed(2)}) heading ${v.heading.toFixed(2)}`);
        }
      }
      out.push({ handedness, checked, bad });
    }
    return out;
  });
  for (const r of res) {
    assert.ok(r.checked >= 4, `${r.handedness}: only ${r.checked} vehicle samples on straight two-way lanes to compare`);
    assert.deepEqual(r.bad, [], `${r.handedness}-hand traffic: vehicles outside their heat strip`);
  }
});

check('', '', 'real sim: fill labels, delivered chips, yard badge and consumed count come from the real station / flow objects', async (ctx) => {
  const res = await P(ctx, () => {
    const R = window.R;
    R.load('busy', { run: 300 });
    const sink = R.sim.logistics.stationById.get('D');
    for (let t = 0; t < 3000 && !(sink.consumed > 0); t += 50) R.sim.advance(50);
    R.view({ overlays: { grid: false } });
    R.focus(9, 0, 60);
    const log = R.capture(() => R.renderer.render(1), ['fillText']);
    const texts = new Set(log.map((c) => String(c.a[0])));
    const lg = R.sim.logistics;
    const expected = [];
    for (const rt of lg.stations) {
      if (rt.type === 'sink') expected.push(['sink consumed', String(rt.consumed)]);
      else if (rt.type === 'process' || rt.type === 'storage') expected.push([`${rt.id} fillLabel`, rt.fillLabel]); // the 2-cell source drops a long label by design
    }
    for (const f of lg.flows) if (f.delivered > 0) expected.push([`flow ${f.id} delivered`, String(f.delivered)]);
    const missing = expected.filter(([, t]) => !texts.has(t)).map(([n, t]) => `${n} "${t}"`);
    return { missing, texts: [...texts].slice(0, 30), count: expected.length };
  });
  assert.ok(res.count >= 4, 'scenario produced too little to compare');
  // bricks are only labelled when they have room; at 60 px/m every brick of this plant has
  assert.deepEqual(res.missing, [], `texts not drawn: ${res.missing.join(', ')}; drawn: ${res.texts.join(' | ')}`);
});

check('', '', 'real sim: deadlock rings are drawn on the nodes of sim.traffic.activeDeadlocks (shape { nodes, vehicleIds, t })', async (ctx) => {
  const res = await P(ctx, () => {
    const R = window.R;
    R.load('congestion', { run: 5 });
    const g = R.sim.graph;
    const node = g.nodes[Math.floor(g.nodes.length / 2)];
    R.sim.traffic.activeDeadlocks = [{ nodes: [node], vehicleIds: ['a', 'b'], t: 12 }];
    R.focusWorld(g.x(node), g.y(node), 40);
    const theme = R.renderer.theme.deadlock;
    const log = R.capture(() => R.renderer.render(1), ['arc']);
    const [sx, sy] = R.camera.worldToScreen(g.x(node), g.y(node));
    const rings = log.filter((c) => c.main && Math.abs(c.a[0] - sx) < 1.5 && Math.abs(c.a[1] - sy) < 1.5 && R.norm(c.stroke) === R.norm(theme));
    return { rings: rings.length };
  });
  assert.ok(res.rings >= 3, `expected a steady ring plus pulsing rings on the deadlocked node, saw ${res.rings}`);
});

// ---------------------------------------------------------------------------------------------------------
// visual measurements that can be asserted
// ---------------------------------------------------------------------------------------------------------

check('VIS-1', 'medium', 'heatmap: a stretch of road with the same traffic level must have a uniform colour (no banding at cell boundaries)', async (ctx) => {
  const res = await P(ctx, () => {
    const R = window.R;
    R.load('twoLines', { run: 5 });
    const g = R.sim.graph;
    // a run of >= 8 eastbound two-way edges on one row
    let run = null;
    for (const e of g.edges) {
      if (e.dir !== 1 || e.rev < 0) continue;
      const cx = g.cx(e.from); const cy = g.cy(e.from);
      let n = 0;
      while (g.edgeBetween(cy * g.cols + cx + n, cy * g.cols + cx + n + 1) >= 0 && g.edges[g.edgeBetween(cy * g.cols + cx + n, cy * g.cols + cx + n + 1)].rev >= 0 && n < 12) n++;
      if (n >= 8) { run = { cx, cy, n }; break; }
    }
    if (!run) return { error: 'no straight two-way run found' };
    const stub = Object.create(R.sim);
    stub.vehicles = [];
    // one hot edge elsewhere makes every other edge a mid-level (about 30 %) edge: translucent, so overlaps show
    stub.heat = () => { const p = new Int32Array(g.edges.length).fill(30); p[0] = 100; return { edgePasses: p, edgeWait: new Float64Array(g.edges.length), nodeWait: new Float64Array(g.nodeCount) }; };
    R.renderer.sim = stub;
    R.view({ overlays: { heat: 'traffic', grid: false, flows: false, labels: false, studs: false } });
    const cs = g.cellSize;
    const laneY = (run.cy + 0.5) * cs + 0.22 * cs; // right-hand traffic, heading east
    R.focusWorld((run.cx + run.n / 2 + 0.5) * cs, laneY, 40);
    const dpr = devicePixelRatio;
    const samples = [];
    for (let x = (run.cx + 1.2) * cs; x < (run.cx + run.n - 1) * cs; x += 0.07) {
      const [sx, sy] = R.camera.worldToScreen(x, laneY);
      samples.push(R.pixel(Math.round(sx * dpr), Math.round(sy * dpr)));
    }
    const span = [0, 1, 2].map((c) => Math.max(...samples.map((s) => s[c])) - Math.min(...samples.map((s) => s[c])));
    return { n: samples.length, span, first: samples[0], min: samples.reduce((a, b) => (a[0] < b[0] ? a : b)), max: samples.reduce((a, b) => (a[0] > b[0] ? a : b)) };
  });
  assert.ok(!res.error, res.error);
  assert.ok(Math.max(...res.span) <= 6, `colour along one uniform lane varies by ${res.span} (darkest ${res.min}, brightest ${res.max}): overlapping translucent strips of consecutive edges show as stripes`);
});

check('VIS-2', 'medium', 'bricks: the state dot and the yard badge must not collide with the name tile (default brick sizes, 8 - 30 px/m = the usual fit zoom)', async (ctx) => {
  const res = await P(ctx, () => {
    const R = window.R;
    const fails = [];
    const sizes = { source: [3, 2], process: [3, 3], storage: [4, 3], sink: [3, 2], depot: [3, 2] };
    const names = { source: 'Goods receiving', process: 'Final assembly', storage: 'Central warehouse', sink: 'Dispatch', depot: 'AGV charging' };
    let tiles = 0;
    for (const [type, [w, h]] of Object.entries(sizes)) {
      for (const zoom of [8, 10, 12, 16, 20, 30]) {
        const l = R.M.createLayout({ cols: 12, rows: 8, cellSize: 2 });
        l.stations.push({ id: 'A', type, name: names[type], x: 2, y: 2, w, h, params: { slots: 4, chargers: 1 } });
        const rt = { id: 'A', type, state: 'blocked', fill: 0.5, fillLabel: '3/8', yard: 5, consumed: 12, slots: 4, chargers: 1, parked: [], charging: [], machines: [{ state: 'busy', progress: 0.5 }, { state: 'blocked' }] };
        R.use(l, { vehicles: [], logistics: { stationById: new Map([['A', rt]]) } });
        R.focusWorld((2 + w / 2) * 2, (2 + h / 2) * 2, zoom);
        const fr = R.renderer._fr;
        const entry = fr.scene.stations[0];
        const tileFill = R.norm(R.renderer.theme.tile);
        const white = R.norm('#ffffff');
        const shapes = R.shapes(() => {
          R.renderer.ctx.setTransform(fr.dpr, 0, 0, fr.dpr, 0, 0);
          R.drawBrick(R.renderer.ctx, fr, type, entry, entry.st, rt, 1);
        });
        const tile = shapes.find((s) => s.op === 'fill' && R.norm(s.fill) === tileFill);
        if (!tile) continue;
        tiles++;
        const badge = shapes.find((s) => s.op === 'fill' && R.norm(s.fill) === white && s.kinds.includes('arcTo'));
        const dot = shapes.find((s) => s.op === 'fill' && R.norm(s.fill) === white && s.kinds.includes('arc') && !s.kinds.includes('arcTo'));
        // the dot is a circle: how deep does it reach into the tile rectangle?
        let dotDepth = 0;
        if (dot) {
          const cx = (dot.x0 + dot.x1) / 2; const cy = (dot.y0 + dot.y1) / 2; const r = (dot.x1 - dot.x0) / 2;
          const dx = Math.max(tile.x0 - cx, 0, cx - tile.x1); const dy = Math.max(tile.y0 - cy, 0, cy - tile.y1);
          dotDepth = r - Math.hypot(dx, dy);
        }
        const badgeArea = badge ? Math.max(0, Math.min(tile.x1, badge.x1) - Math.max(tile.x0, badge.x0)) * Math.max(0, Math.min(tile.y1, badge.y1) - Math.max(tile.y0, badge.y0)) : 0;
        if (dotDepth > 1.5) fails.push(`${type} ${w}x${h} "${names[type]}" @${zoom} px/m: state dot reaches ${dotDepth.toFixed(1)} px into the name tile`);
        if (badgeArea > 12) fails.push(`${type} ${w}x${h} @${zoom} px/m: yard badge covers ${Math.round(badgeArea)} px2 of the name tile`);
      }
    }
    return { fails, tiles };
  });
  assert.ok(res.tiles >= 20, `only ${res.tiles} name tiles found: the probe is broken`);
  assert.deepEqual(res.fails, [], `${res.fails.length} collisions:\n` + res.fails.join('\n'));
});

check('VIS-3', 'low', 'bricks: a 2-cell-wide source with a backlog (yard badge) keeps the name tile clear at 20 and 40 px/m', async (ctx) => {
  const res = await P(ctx, () => {
    const R = window.R;
    const fails = [];
    for (const zoom of [20, 40]) {
      const l = R.M.createLayout({ cols: 12, rows: 8, cellSize: 2 });
      l.stations.push({ id: 'A', type: 'source', name: 'Goods in', x: 2, y: 2, w: 2, h: 1, params: {} });
      const rt = { id: 'A', type: 'source', state: 'blocked', fill: 1, fillLabel: '3/3 +3', yard: 3 };
      R.use(l, { vehicles: [], logistics: { stationById: new Map([['A', rt]]) } });
      R.focusWorld(6, 5, zoom);
      const fr = R.renderer._fr;
      const entry = fr.scene.stations[0];
      const tileFill = R.norm(R.renderer.theme.tile);
      const white = R.norm('#ffffff');
      const shapes = R.shapes(() => { R.renderer.ctx.setTransform(fr.dpr, 0, 0, fr.dpr, 0, 0); R.drawBrick(R.renderer.ctx, fr, 'source', entry, entry.st, rt, 1); });
      const tile = shapes.find((s) => s.op === 'fill' && R.norm(s.fill) === tileFill);
      const badge = shapes.find((s) => s.op === 'fill' && R.norm(s.fill) === white && s.kinds.includes('arcTo'));
      if (!tile || !badge) { fails.push(`@${zoom}: tile ${!!tile} badge ${!!badge}`); continue; }
      const area = Math.max(0, Math.min(tile.x1, badge.x1) - Math.max(tile.x0, badge.x0)) * Math.max(0, Math.min(tile.y1, badge.y1) - Math.max(tile.y0, badge.y0));
      if (area > 12) fails.push(`@${zoom} px/m the yard badge covers ${Math.round(area)} px2 of the "Goods in" tile`);
    }
    return fails;
  });
  assert.deepEqual(res, [], res.join('\n'));
});

check('LABEL-1', 'medium', 'free labels: `size` is "a text height in grid cells" (js/model/layout.js), so the font must scale with the cell size', async (ctx) => {
  const res = await P(ctx, () => {
    const R = window.R;
    const px = [];
    for (const cs of [2, 4]) {
      const l = R.M.createLayout({ cols: 20, rows: 10, cellSize: cs });
      l.labels.push({ id: 'l1', x: 5, y: 5, text: 'LABELX', size: 1 });
      R.use(l, null);
      R.focusWorld(5 * cs, 5 * cs, 20);
      R.renderer.invalidate();
      const log = R.capture(() => R.renderer.render(1), ['fillText']);
      const hit = log.find((c) => c.a[0] === 'LABELX');
      px.push(hit ? parseFloat(/(\d+(\.\d+)?)px/.exec(hit.font)[1]) : NaN);
    }
    return px;
  });
  assert.ok(res.every(Number.isFinite), 'the label was not drawn: ' + res);
  assert.ok(Math.abs(res[1] / res[0] - 2) < 0.05, `label size 1 is ${res[0]} px with 2 m cells and ${res[1]} px with 4 m cells at 20 px/m: the font ignores the cell size (renderer: size x 0.8 m)`);
});

check('', '', 'prefers-reduced-motion: the deadlock rings stand still (and pulse without the preference)', async (ctx) => {
  const sample = async () => P(ctx, async () => {
    const R = window.R;
    R.load('congestion', { run: 5 });
    const g = R.sim.graph;
    const node = g.nodes[Math.floor(g.nodes.length / 2)];
    R.sim.traffic.activeDeadlocks = [{ nodes: [node], vehicleIds: [], t: 0 }];
    R.focusWorld(g.x(node), g.y(node), 40);
    const radii = () => R.capture(() => R.renderer.render(1), ['arc']).filter((c) => c.main && R.norm(c.stroke) === R.norm(R.renderer.theme.deadlock)).map((c) => Math.round(c.a[2] * 10) / 10);
    const first = radii();
    await new Promise((r) => setTimeout(r, 350));
    return { first, second: radii() };
  });
  await ctx.page.emulateMedia({ reducedMotion: 'reduce' });
  await openPage(ctx);
  const still = await sample();
  await ctx.page.emulateMedia({ reducedMotion: 'no-preference' });
  await openPage(ctx);
  const moving = await sample();
  assert.ok(still.first.length >= 3, 'no rings drawn');
  assert.deepEqual(still.first, still.second, 'rings animate although prefers-reduced-motion is set');
  assert.notDeepEqual(moving.first, moving.second, 'control: without the preference the rings should pulse');
});

// ---------------------------------------------------------------------------------------------------------
// robustness (real canvas)
// ---------------------------------------------------------------------------------------------------------

check('', '', 'robustness: null / tiny / huge layouts, 0 x 0 canvas, extreme zoom, layout swaps, sims with missing fields, devicePixelRatio changes', async (ctx) => {
  const res = await P(ctx, async () => {
    const R = window.R;
    const rows = [];
    const t = (name, fn) => {
      const t0 = performance.now();
      try { fn(); rows.push([name, 'ok', performance.now() - t0]); } catch (e) { rows.push([name, `${e && e.name}: ${e && e.message}`, performance.now() - t0]); }
    };
    const r = R.renderer;
    R.load('twoLines', { run: 200 });
    const sim = R.sim;
    const layout = R.layout;
    t('layout null', () => { r.layout = null; r.render(0.5); r.hitTest(5, 5); r.toDataURL({ scale: 0.2 }); });
    t('layout back', () => { r.layout = layout; r.render(1); });
    for (const [cols, rows2, cs] of [[8, 8, 10], [8, 8, 0.5], [160, 160, 0.5], [160, 160, 10]]) {
      t(`empty layout ${cols}x${rows2} @${cs} m`, () => { R.use(R.M.createLayout({ cols, rows: rows2, cellSize: cs }), null); r.render(1); r.hitTest(100, 100); r.toDataURL({ scale: 0.1 }); R.fit(); R.focusWorld(0, 0, 80); R.focusWorld(cols * cs, rows2 * cs, 4); });
    }
    R.use(layout, sim);
    t('0 x 0 canvas', () => { R.canvas.style.display = 'none'; r.resize(); r.render(1); r.hitTest(1, 1); r.toDataURL({ scale: 0.1 }); });
    t('canvas back', () => { R.canvas.style.display = 'block'; r.resize(); R.fit(); });
    const px = R.pixel(10, 10);
    const bg = R.renderer.theme.bg.replace('#', '').match(/../g).map((h) => parseInt(h, 16));
    rows.push(['plate visible after restoring the canvas', R.pixel(R.canvas.width / 2 | 0, R.canvas.height / 2 | 0).join() !== bg.join() ? 'ok' : 'canvas still blank', 0]);
    void px;
    for (const z of [1e9, 1e-9, NaN, 0, -5]) t(`camera.zoom assigned ${z}`, () => { R.camera.zoom = z; r.render(1); r.hitTest(10, 10); R.camera.zoom = 20; });
    t('camera.x NaN / Infinity', () => { R.camera.x = NaN; r.render(1); R.camera.x = Infinity; r.render(1); R.camera.y = -Infinity; r.render(1); R.fit(); });
    t('50 layout swaps (identity change)', () => { for (let i = 0; i < 50; i++) { r.layout = R.M.cloneLayout(layout); r.render(1); } r.layout = layout; });
    const odd = [
      ['sim {}', {}], ['sim without arrays', { vehicles: null, stations: 3, logistics: 5 }],
      ['vehicles with junk', { vehicles: [{}, null, { x: NaN, y: 1 }, { x: 1, y: 2, tv: { length: -3, width: NaN } }, { x: 5, y: 5, heading: 'a', load: 7, battery: 'x', fleet: 3 }] }],
      ['logistics without stationById', { logistics: { stations: [{ id: 's1', state: 'busy', fill: 5, machines: 'no' }, null] }, vehicles: [] }],
      ['heat throws', { vehicles: [], graph: layout && sim.graph, heat() { throw new Error('sim is rebuilding'); } }],
      ['heat returns nothing', { vehicles: [], graph: sim.graph, heat: () => null }],
      ['heat arrays too short', { vehicles: [], graph: sim.graph, heat: () => ({ edgePasses: new Int32Array(3), edgeWait: [1], nodeWait: null }) }],
      ['deadlocks junk', { vehicles: [], graph: sim.graph, traffic: { activeDeadlocks: [null, 5, -1, { nodes: 'x' }, { node: NaN }, { nodes: [1e9, -4] }] } }],
      ['deadlocks not iterable', { vehicles: [], traffic: { activeDeadlocks: 7 } }],
    ];
    for (const [name, s] of odd) t(`${name}, heat overlay on`, () => { r.sim = s; R.view({ overlays: { heat: 'traffic', ids: true, docks: true } }); r.render(0.3); r.hitTest(100, 100); R.view({ overlays: { heat: 'waiting' } }); r.render(1); r.toDataURL({ scale: 0.1 }); });
    R.view({ overlays: { heat: 'off', ids: false, docks: false } });
    r.sim = sim;
    t('view = {}', () => { r.view = {}; r.render(1); r.hitTest(10, 10); });
    t('view overlays heat junk', () => { r.view = { overlays: { heat: 'bogus', grid: 0, studs: null } }; r.render(1); });
    t('view ghost / previews with odd numbers', () => {
      r.view = {
        ghost: { kind: 'station', type: 'nope', rect: { x: NaN, y: 1, w: 3, h: 2 }, valid: true }, paintPreview: { cells: [[1, 1], [NaN, 2], [3, 3]], oneWay: true }, flowPreview: { fromId: 'zz', toPoint: [1] },
        marquee: { x: 1, y: 1, w: NaN, h: 5 }, selection: { kind: 'cell', ids: ['3,4', [5, 6], 'x', 7] }, hover: { kind: 'cell', cell: [1] },
      };
      r.render(1);
    });
    t('ghost obstacle huge', () => { r.view = { ghost: { kind: 'obstacle', rect: { x: -1e9, y: 1e9, w: 1e12, h: 1e12 }, valid: false } }; r.render(1); });
    r.view = R.createView();
    for (const alpha of [-1, 2, NaN, undefined, Infinity]) t(`render(${alpha})`, () => r.render(alpha));
    t('devicePixelRatio 2 then 1.5 then 1', () => {
      for (const d of [2, 1.5, 1]) {
        Object.defineProperty(window, 'devicePixelRatio', { value: d, configurable: true });
        r.render(1);
        const expectW = Math.round(R.canvas.clientWidth * d);
        if (R.canvas.width !== expectW) throw new Error(`dpr ${d}: canvas.width ${R.canvas.width} != ${expectW}`);
      }
      delete window.devicePixelRatio;
    });
    t('destroy() then render', () => { const r2 = new R.Renderer(document.createElement('canvas'), { camera: new R.Camera() }); r2.destroy(); r2.render(1); r2.hitTest(1, 1); });
    return rows;
  });
  const bad = res.filter(([, status]) => status !== 'ok');
  assert.deepEqual(bad.map(([n, s]) => `${n}: ${s}`), [], 'cases failed');
  const slow = res.filter(([, , ms]) => ms > 1500);
  assert.deepEqual(slow.map(([n, , ms]) => `${n}: ${Math.round(ms)} ms`), [], 'cases took longer than 1.5 s');
});

check('', '', 'robustness: 160 randomised, normalised layouts x odd sims x odd views x random cameras and devicePixelRatios (real canvas, no exceptions)', async (ctx) => {
  const res = await P(ctx, () => {
    const R = window.R;
    const mulberry = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const failures = [];
    const rng = mulberry(7);
    const int = (a, b) => a + Math.floor(rng() * (b - a + 1));
    const pick = (list) => list[int(0, list.length - 1)];
    const maybe = (p) => rng() < p;
    const types = ['source', 'process', 'storage', 'sink', 'depot'];
    const states = ['normal', 'blocked', 'full', 'busy', 'starved', 'down', 'idle', undefined, 'weird'];
    const vstates = ['idle', 'parked', 'toPickup', 'loading', 'toDrop', 'unloading', 'toCharger', 'charging', 'toPark', 'broken', 'dead'];
    for (let round = 0; round < 160; round++) {
      const seed = round;
      try {
        const cols = pick([8, 9, 16, 31, 48, 80, 160]);
        const rows = pick([8, 11, 20, 32, 60, 160]);
        const cs = pick([0.5, 1, 2, 2, 2, 3.7, 10]);
        const raw = R.M.createLayout({ cols, rows, cellSize: cs });
        const nSt = int(0, 14);
        for (let i = 0; i < nSt; i++) {
          const type = pick(types);
          const w = pick([1, 1, 2, 3, 4, 7, 12]); const h = pick([1, 2, 3, 5, 9]);
          const st = R.M.addStation(raw, { type, x: int(0, Math.max(0, cols - w)), y: int(0, Math.max(0, rows - h)), w, h, name: pick(['', 'A', 'Goods receiving dock north', 'Ünïcödé 机器 ✓', 'x'.repeat(80), 'W'.repeat(40)]) || undefined });
          if (st && maybe(0.3)) st.name = pick(['', ' ', 'long '.repeat(30)]);
        }
        for (let i = 0; i < int(0, 25); i++) { const w = int(1, 9); const h = int(1, 4); R.M.addObstacle(raw, { x: int(0, cols - 1), y: int(0, rows - 1), w, h, kind: pick(['wall', 'rack', 'column']) }); }
        for (let i = 0; i < int(0, 6); i++) R.M.addLabel(raw, { x: rng() * cols, y: rng() * rows, text: pick(['Hall', '', 'A very long label that keeps going and going', '日本語ラベル']), size: pick([0.25, 1, 1, 3, 8, undefined]) });
        for (let i = 0; i < int(0, 6); i++) {
          const x = int(0, cols - 1); const y = int(0, rows - 1);
          const pts = [[x, y]];
          for (let k = 0; k < int(1, 30); k++) { const [lx, ly] = pts[pts.length - 1]; pts.push(pick([[lx + 1, ly], [lx, ly + 1], [lx - 1, ly], [lx, ly - 1]])); }
          R.M.paintRoadPath(raw, pts.filter(([a, b]) => a >= 0 && b >= 0 && a < cols && b < rows), { oneWay: maybe(0.3) });
        }
        for (const key of Object.keys(raw.roads)) if (maybe(0.08)) R.M.setRoadLimit(raw, ...key.split(',').map(Number), pick([0.1, 0.25, 0.5, 0.9]));
        for (let i = 0; i < raw.stations.length; i++) if (maybe(0.5) && raw.stations.length > 1) R.M.addFlow(raw, raw.stations[i].id, pick(raw.stations).id);
        const layout = R.M.normalizeLayout(raw);
        // fake sim with plausible runtime objects, some fields missing / odd
        const stations = layout.stations.map((s) => {
          const rt = { id: s.id, type: s.type, state: pick(states), fill: pick([0, 0.4, 1, 3, -1, NaN, undefined]), fillLabel: pick(['', '3/8', '12/12 +9999', undefined]), yard: pick([0, 0, 5, 1e6, undefined]), consumed: pick([0, 7, 1e9, undefined]) };
          if (s.type === 'process') rt.machines = Array.from({ length: pick([0, 1, 2, 4, 5, 30, 200]) }, () => ({ state: pick(['idle', 'busy', 'blocked', 'down', 'x']), progress: pick([0, 0.5, 1, 2, NaN, undefined]) }));
          if (s.type === 'depot') { rt.slots = pick([0, 1, 4, 17, 400, NaN, undefined]); rt.chargers = pick([0, 2, 9, undefined]); rt.parked = []; rt.charging = []; }
          return rt;
        });
        const vehicles = Array.from({ length: pick([0, 0, 3, 40]) }, (_, i) => {
          const x = rng() * cols * cs; const y = rng() * rows * cs;
          const v = {
            id: `f#${i}`, fleetId: 'f', color: pick(['#2d7ff9', '#e8590c', undefined, 'red', '#12']), state: pick(vstates), load: Array.from({ length: pick([0, 0, 1, 4, 9]) }, () => ({})), battery: pick([1, 0.5, 0, 0.2, undefined, NaN]),
            visible: maybe(0.9), x, y, heading: (rng() - 0.5) * 20, prevX: x - pick([0, 0.1, 5, 100]), prevY: y, prevHeading: rng() * 7,
            tv: maybe(0.9) ? { length: pick([0.1, 1.2, 3.5, 60, 1e9]), width: pick([0.2, 0.7, 5, 1e9, 0, undefined]), waiting: maybe(0.3), disabled: maybe(0.1) } : undefined,
            fleet: { id: 'f', color: '#2d7ff9', battery: { enabled: maybe(0.5) } },
          };
          return v;
        });
        const graph = R.buildGraph(layout);
        const sim = {
          vehicles, stations, graph, settings: { handedness: pick(['right', 'left']) },
          logistics: { stationById: maybe(0.7) ? new Map(stations.map((s) => [s.id, s])) : undefined, stations, flows: layout.flows.map((f) => ({ id: f.id, delivered: pick([0, 5, 1e6, undefined]) })) },
          traffic: { activeDeadlocks: maybe(0.3) ? [{ nodes: [pick(graph.nodes.length ? graph.nodes : [0])] }] : [] },
          heat: () => ({ edgePasses: Int32Array.from(graph.edges, () => int(0, 50)), edgeWait: Float64Array.from(graph.edges, () => rng() * 30), nodeWait: Float64Array.from({ length: graph.nodeCount }, () => (maybe(0.05) ? rng() * 60 : 0)) }),
        };
        if (maybe(0.2)) sim.heat = undefined;
        const d = pick([1, 1, 1.25, 1.5, 2, 3]);
        Object.defineProperty(window, 'devicePixelRatio', { value: d, configurable: true });
        R.use(layout, maybe(0.1) ? null : sim);
        R.theme(pick(['light', 'dark']));
        const view = R.createView();
        Object.assign(view.overlays, { grid: maybe(0.8), studs: maybe(0.8), labels: maybe(0.8), docks: maybe(0.4), ids: maybe(0.3), flows: maybe(0.8), heat: pick(['off', 'off', 'traffic', 'waiting']) });
        const stIds = layout.stations.map((s) => s.id);
        view.selection = pick([{ kind: null, ids: [] }, { kind: 'station', ids: stIds.slice(0, int(0, 3)) }, { kind: 'flow', ids: layout.flows.slice(0, 2).map((f) => f.id) }, { kind: 'obstacle', ids: layout.obstacles.slice(0, 1).map((o) => o.id) }, { kind: 'label', ids: layout.labels.slice(0, 1).map((o) => o.id) }, { kind: 'cell', ids: ['2,3', [4, 5]] }, { kind: 'fleet', ids: ['f'] }]);
        view.resizeHandles = maybe(0.5);
        view.hover = pick([null, { kind: 'station', id: pick(stIds.length ? stIds : ['none']) }, { kind: 'cell', cell: [int(-3, cols + 3), int(-3, rows + 3)] }, { kind: 'vehicle', id: 'f#1' }, { kind: 'flow', id: 'f1' }]);
        view.ghost = maybe(0.4) ? { kind: pick(['station', 'obstacle']), type: pick(types), rect: { x: int(-3, cols), y: int(-3, rows), w: int(0, 8), h: int(0, 6) }, valid: maybe(0.5), obstacleKind: pick(['wall', 'rack', 'column', 'x']) } : null;
        view.paintPreview = maybe(0.3) ? { cells: Array.from({ length: int(0, 12) }, () => [int(-2, cols + 2), int(-2, rows + 2)]), oneWay: maybe(0.5), blocked: maybe(0.5) ? [[int(0, cols), int(0, rows)]] : undefined } : null;
        view.flowPreview = maybe(0.3) && stIds.length ? { fromId: pick(stIds), toPoint: [rng() * cols * cs, rng() * rows * cs] } : null;
        view.marquee = maybe(0.3) ? { x: rng() * 50, y: rng() * 50, w: (rng() - 0.5) * 80, h: (rng() - 0.5) * 80 } : null;
        R.renderer.view = view;
        for (let k = 0; k < 3; k++) {
          R.camera.zoomTo(pick([4, 5.5, 12.4, 20, 33, 47.7, 70, 80]));
          R.camera.centerOn(rng() * cols * cs * 1.2 - cols * cs * 0.1, rng() * rows * cs * 1.2 - rows * cs * 0.1);
          R.renderer.render(rng());
          R.renderer.hitTest(rng() * R.camera.width, rng() * R.camera.height);
        }
        if (round % 8 === 0) { const url = R.renderer.toDataURL({ scale: 0.15 }); if (!url.startsWith('data:image/png')) throw new Error('export did not return a PNG: ' + url.slice(0, 30)); }
      } catch (e) {
        failures.push(`round ${seed}: ${e && e.name}: ${e && e.message}`);
      }
    }
    delete window.devicePixelRatio;
    return failures;
  });
  assert.deepEqual(res, [], res.slice(0, 8).join('\n'));
});

check('ROB-1', 'low', 'robustness: structurally broken layouts / sims (null entries, wrong types) are tolerated instead of throwing in the frame loop', async (ctx) => {
  const res = await P(ctx, () => {
    const R = window.R;
    R.load('twoLines', { run: 100 });
    const good = R.layout;
    const sim = R.sim;
    const rows = [];
    const t = (name, fn) => {
      try { fn(); rows.push([name, 'ok']); } catch (e) { rows.push([name, String(e.message).slice(0, 70)]); }
    };
    const withLayout = (name, patch) => t(name, () => {
      const l = R.M.cloneLayout(good);
      patch(l);
      R.renderer.layout = l; R.renderer.sim = null; R.renderer.view = R.createView();
      R.renderer.render(1); R.renderer.hitTest(300, 300); R.renderer.toDataURL({ scale: 0.1 });
    });
    withLayout('stations: [null]', (l) => { l.stations = [null]; });
    withLayout('obstacles: [null]', (l) => { l.obstacles = [null]; });
    withLayout('labels: [null]', (l) => { l.labels = [null]; });
    withLayout('flows: [null]', (l) => { l.flows = [null]; });
    withLayout('label text is a number', (l) => { l.labels[0].text = 42; });
    withLayout('label text is an object', (l) => { l.labels[0].text = { a: 1 }; });
    withLayout('station without params / name', (l) => { delete l.stations[0].params; delete l.stations[0].name; });
    withLayout('station coordinates as strings', (l) => { l.stations[0].x = '3'; l.stations[0].w = '3'; });
    withLayout('flow to a missing station', (l) => { l.flows.push({ id: 'zz', from: 's1', to: 'nope', weight: 1 }); });
    withLayout('road keys garbage', (l) => { l.roads['a,b'] = { out: 3 }; l.roads['-4,2'] = { out: 'x' }; l.roads['5'] = null; l.roads['1,1'] = undefined; });
    withLayout('grid.cellSize string', (l) => { l.grid.cellSize = '2'; });
    withLayout('grid missing', (l) => { delete l.grid; });
    withLayout('labels missing', (l) => { delete l.labels; delete l.obstacles; delete l.flows; });
    const withSim = (name, patch) => t(name, () => {
      const s2 = Object.create(sim);
      patch(s2);
      R.renderer.layout = good; R.renderer.sim = s2; R.renderer.view = R.createView();
      R.renderer.view.overlays.heat = 'traffic';
      R.renderer.render(1); R.renderer.hitTest(300, 300); R.renderer.toDataURL({ scale: 0.1 });
    });
    withSim('vehicles contain null', (s) => { s.vehicles = [null, undefined, ...sim.vehicles]; });
    withSim('logistics.flows contain null', (s) => { s.logistics = { ...sim.logistics, flows: [null, ...sim.logistics.flows] }; });
    withSim('stationById returns numbers', (s) => { s.logistics = { stationById: { get: () => 7 }, flows: [] }; });
    withSim('machines is a number', (s) => { s.logistics = { stationById: new Map(sim.stations.map((x) => [x.id, { id: x.id, state: 'busy', machines: 3, fill: 0.2 }])), flows: [] }; });
    withSim('station.parked not an array', (s) => { s.logistics = { stationById: new Map(sim.stations.map((x) => [x.id, { id: x.id, parked: 3, charging: 'x', slots: 4, chargers: 1 }])), flows: [] }; });
    t('paintPreview with a null cell', () => { R.renderer.layout = good; R.renderer.sim = null; R.renderer.view = R.createView(); R.renderer.view.paintPreview = { cells: [[1, 1], null], oneWay: false }; R.renderer.render(1); });
    t('ghost without rect / paintPreview without cells', () => { R.renderer.view = R.createView(); R.renderer.view.ghost = { kind: 'station', type: 'sink' }; R.renderer.view.paintPreview = {}; R.renderer.render(1); });
    for (const [name, sel] of [['no ids', { kind: 'station' }], ['ids null', { kind: 'station', ids: null }]]) {
      t(`selection ${name} + resizeHandles: hitTest`, () => { R.renderer.layout = good; R.renderer.sim = null; R.renderer.view = R.createView(); R.renderer.view.selection = sel; R.renderer.view.resizeHandles = true; R.renderer.render(1); R.renderer.hitTest(10, 10); });
    }
    t('selection ids with null for stations', () => { R.renderer.view = R.createView(); R.renderer.view.selection = { kind: 'station', ids: [null, undefined, 3] }; R.renderer.view.resizeHandles = true; R.renderer.render(1); R.renderer.hitTest(10, 10); });
    return rows;
  });
  const bad = res.filter(([, s]) => s !== 'ok');
  assert.ok(res.length >= 20);
  assert.deepEqual(bad.map(([n, s]) => `${n}: ${s}`), [], `${bad.length} of ${res.length} broken-input cases throw`);
});

check('', '', 'toDataURL: absurd options are clamped, empty layouts export, the export is independent of the camera and of selection / hover', async (ctx) => {
  const res = await P(ctx, async () => {
    const R = window.R;
    const fails = [];
    R.load('twoLines', { run: 200 });
    const dim = async (url) => { const img = new Image(); img.src = url; await img.decode(); return [img.width, img.height]; };
    for (const opts of [{ scale: 0 }, { scale: -3 }, { scale: NaN }, { scale: 1e9 }, { scale: 1e-9 }, { padding: -5 }, { padding: 1e9 }, { padding: NaN }, { background: 'not a colour' }, { theme: 'bogus' }, { scale: 3, background: null }]) {
      try {
        const url = R.renderer.toDataURL(opts);
        if (!url.startsWith('data:image/png;base64,')) { fails.push(`${JSON.stringify(opts)}: ${url.slice(0, 30)}`); continue; }
        const [w, h] = await dim(url);
        if (w < 1 || h < 1 || w > 8192 || h > 8192 || w * h > 36.5e6) fails.push(`${JSON.stringify(opts)}: size ${w} x ${h}`);
      } catch (e) { fails.push(`${JSON.stringify(opts)}: ${e.message}`); }
    }
    const a = R.renderer.toDataURL({ scale: 0.5 });
    R.focusWorld(3, 3, 80);
    R.view({ selection: { kind: 'station', ids: ['s4'] }, hover: { kind: 'station', id: 's5' }, ghost: { kind: 'station', type: 'process', rect: { x: 2, y: 2, w: 3, h: 3 }, valid: true } });
    const b = R.renderer.toDataURL({ scale: 0.5 });
    if (a !== b) fails.push('export changed with camera / selection / hover / ghost');
    R.use(R.M.createLayout({ cols: 12, rows: 8, cellSize: 2 }), null);
    const [ew, eh] = await dim(R.renderer.toDataURL());
    if (ew !== (24 + 2) * 20 || eh !== (16 + 2) * 20) fails.push(`empty layout export ${ew} x ${eh}`);
    R.renderer.layout = null;
    const [nw, nh] = await dim(R.renderer.toDataURL());
    if (!(nw > 0 && nh > 0)) fails.push('null layout export has no size');
    return fails;
  });
  assert.deepEqual(res, [], res.join('\n'));
});

check('', '', 'theme "auto" follows prefers-color-scheme at construction time', async (ctx) => {
  await ctx.page.emulateMedia({ colorScheme: 'dark' });
  await openPage(ctx);
  const dark = await P(ctx, () => {
    const R = window.R;
    const c = document.createElement('canvas');
    c.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:100px';
    document.body.appendChild(c);
    const r = new R.Renderer(c, { camera: new R.Camera(), theme: 'auto' });
    return r.theme.mode;
  });
  await ctx.page.emulateMedia({ colorScheme: 'light' });
  await openPage(ctx);
  const light = await P(ctx, () => {
    const R = window.R;
    const c = document.createElement('canvas');
    c.style.cssText = 'position:fixed;left:0;top:0;width:200px;height:100px';
    document.body.appendChild(c);
    return new R.Renderer(c, { camera: new R.Camera(), theme: 'auto' }).theme.mode;
  });
  assert.deepEqual([dark, light], ['dark', 'light']);
});

// ---------------------------------------------------------------------------------------------------------
// static layer caching and performance
// ---------------------------------------------------------------------------------------------------------

check('', '', 'static layer: idle frames, sim ticks, hover / selection / overlay toggles and small pans never rebuild it; real toggles and zoom buckets do', async (ctx) => {
  const res = await P(ctx, async () => {
    const R = window.R;
    const fails = [];
    R.load('twoLines', { run: 100 });
    R.fit();
    const builds = () => R.renderer.stats.staticBuilds;
    const expectDelta = (label, fn, min, max) => {
      const b0 = builds();
      fn();
      const d = builds() - b0;
      if (d < min || d > max) fails.push(`${label}: ${d} rebuilds, expected ${min}..${max}`);
    };
    expectDelta('120 idle frames with alpha sweep', () => { for (let i = 0; i < 120; i++) R.renderer.render((i % 10) / 10); }, 0, 0);
    expectDelta('200 sim ticks, a frame after each', () => { for (let i = 0; i < 200; i++) { R.sim.step(); R.renderer.render(0.5); } }, 0, 0);
    expectDelta('hover and selection changes', () => { for (const [k, id] of [['station', 's1'], ['station', 's4'], ['vehicle', 'v2#1'], ['flow', 'f1']]) { R.view({ hover: { kind: k, id }, selection: { kind: k, ids: [id] } }); } R.view({ hover: null, selection: { kind: null, ids: [] } }); }, 0, 0);
    expectDelta('ids / docks / heat / flows overlays', () => { for (const o of [{ ids: true }, { docks: true }, { heat: 'traffic' }, { heat: 'waiting' }, { flows: false }, { ids: false, docks: false, heat: 'off', flows: true }]) R.view({ overlays: o }); }, 0, 0);
    expectDelta('ghost, previews, marquee', () => { R.view({ ghost: { kind: 'station', type: 'sink', rect: { x: 3, y: 3, w: 3, h: 2 }, valid: true }, paintPreview: { cells: [[1, 1], [2, 1]], oneWay: false }, marquee: { x: 1, y: 1, w: 10, h: 10 } }); R.view({ ghost: null, paintPreview: null, marquee: null }); }, 0, 0);
    expectDelta('12 px pan x 20 inside the cached window', () => { for (let i = 0; i < 20; i++) { R.camera.pan(12, 0); R.renderer.render(1); } }, 0, 0);
    expectDelta('studs toggle', () => R.view({ overlays: { studs: false } }), 1, 1);
    expectDelta('grid toggle', () => R.view({ overlays: { grid: false } }), 1, 1);
    expectDelta('labels toggle', () => R.view({ overlays: { labels: false } }), 1, 1);
    R.view({ overlays: { studs: true, grid: true, labels: true } });
    expectDelta('theme switch', () => R.theme('dark'), 1, 1);
    expectDelta('same layout reassigned', () => { R.renderer.layout = R.layout; R.renderer.render(1); }, 0, 0);
    expectDelta('new layout object', () => { R.renderer.layout = R.M.cloneLayout(R.layout); R.renderer.render(1); }, 1, 1);
    expectDelta('canvas resize', () => { R.canvas.style.width = '90vw'; R.renderer.resize(); R.renderer.render(1); R.canvas.style.width = ''; R.renderer.resize(); R.renderer.render(1); }, 1, 2);
    expectDelta('1.1x zoom keeps the stand-in', () => { R.camera.zoomAt(1.1, 300, 300); R.renderer.render(1); }, 0, 0);
    // pan across the whole plant at 20 px/m on the big plant: one rebuild per 35 % of a viewport
    R.load('big', { run: 0 });
    R.focus(10, 10, 20);
    R.renderer.render(1);
    let dist = 0;
    const b0 = builds();
    for (let i = 0; i < 700; i++) { R.camera.pan(-6, -3); dist += Math.hypot(6, 3); R.renderer.render(1); }
    const panBuilds = builds() - b0;
    const bound = Math.ceil(dist / (0.3 * Math.min(R.camera.width, R.camera.height))) + 1;
    if (panBuilds > bound) fails.push(`panning ${Math.round(dist)} px rebuilt ${panBuilds} times (bound ${bound})`);
    return { fails, panBuilds, dist: Math.round(dist), bound };
  });
  console.log(`       long pan: ${res.dist} px -> ${res.panBuilds} static rebuilds (bound ${res.bound})`);
  assert.deepEqual(res.fails, [], res.fails.join('\n'));
});

check('', '', 'static layer: a wheel zoom sequence rebuilds a handful of times and the settle timer re-renders sharp without another frame request', async (ctx) => {
  const res = await P(ctx, async () => {
    const R = window.R;
    R.load('twoLines', { run: 50 });
    R.focus(28, 16, 12);
    R.renderer.render(1);
    const builds = () => R.renderer.stats.staticBuilds;
    const b0 = builds();
    for (let i = 0; i < 45; i++) { R.camera.zoomAt(1.06, 700, 400); R.renderer.render(1); }
    const during = builds() - b0;
    const z = R.camera.zoom;
    const frames0 = R.renderer.stats.frames;
    await new Promise((r) => setTimeout(r, 400));
    return { during, afterSettle: builds() - b0, extraFrames: R.renderer.stats.frames - frames0, zoom: z };
  });
  assert.ok(res.during <= 7, `a 45-step wheel zoom (x${(1.06 ** 45).toFixed(1)}) rebuilt the static layer ${res.during} times`);
  assert.equal(res.afterSettle, res.during + 1, `settle timer: ${res.afterSettle - res.during} rebuilds after the zoom came to rest, expected 1`);
  assert.ok(res.extraFrames >= 1 && res.extraFrames <= 3, `the settle timer drew ${res.extraFrames} extra frames`);
});

check('', '', `frame time: render() with 100 moving vehicles stays under ${FRAME_BUDGET_MS} ms/frame (dense 40 x 24 plant, several overlay mixes)`, async (ctx) => {
  const res = await P(ctx, async () => {
    const R = window.R;
    R.load('dense', { run: 600 });
    const out = [];
    const flush = () => R.pixel(0, 0);
    const bench = async (label, frames = 240) => {
      await new Promise((r) => setTimeout(r, 300)); // let the settle timer re-render the static layer after the camera move
      const runs = [];
      for (let rep = 0; rep < 3; rep++) {
        for (let i = 0; i < 15; i++) R.renderer.render(0.5);
        flush();
        const b0 = R.renderer.stats.staticBuilds;
        const t0 = performance.now();
        for (let i = 0; i < frames; i++) R.renderer.render((i % 10) / 10);
        flush();
        runs.push({ ms: (performance.now() - t0) / frames, builds: R.renderer.stats.staticBuilds - b0 });
      }
      runs.sort((a, b) => a.ms - b.ms);
      out.push({ label, ms: +runs[1].ms.toFixed(2), best: +runs[0].ms.toFixed(2), worst: +runs[2].ms.toFixed(2), builds: runs[1].builds });
    };
    const waiting = R.sim.vehicles.filter((v) => v.tv.waiting).length;
    R.fit(); await bench(`fit ${R.camera.zoom.toFixed(1)} px/m`);
    R.view({ overlays: { ids: true, docks: true, heat: 'traffic' } }); await bench('fit + ids + docks + traffic heat');
    R.view({ overlays: { heat: 'waiting' } }); await bench('fit + ids + docks + waiting heat');
    R.theme('dark'); await bench('fit + ids + docks + waiting heat, dark');
    R.view({ overlays: { ids: false, docks: false, heat: 'off' } }); R.theme('light');
    R.focus(20, 12, 20); await bench('20 px/m centre');
    R.focus(20, 12, 40); await bench('40 px/m centre');
    R.focus(8, 6, 70); await bench('70 px/m close-up');
    return { out, vehicles: R.sim.vehicles.filter((v) => v.visible).length, waiting };
  });
  console.log(`       ${res.vehicles} visible vehicles, ${res.waiting} waiting; mean ms/frame (median of 3 runs of 240 frames, canvas flushed):`);
  for (const r of res.out) console.log(`         ${r.label.padEnd(40)} ${String(r.ms).padStart(6)} ms  (best ${r.best}, worst ${r.worst}, static rebuilds ${r.builds})`);
  assert.ok(res.vehicles >= 80);
  const over = res.out.filter((r) => r.ms > FRAME_BUDGET_MS);
  assert.deepEqual(over.map((r) => `${r.label}: ${r.ms} ms`), [], `frames over the ${FRAME_BUDGET_MS} ms budget`);
  assert.deepEqual(res.out.filter((r) => r.builds > 0).map((r) => r.label), [], 'the static layer was rebuilt during steady rendering');
});

check('', '', 'frame pacing: a real requestAnimationFrame loop (render + 2 sim ticks per frame, 100 vehicles) keeps the 60 Hz cadence', async (ctx) => {
  const res = await P(ctx, () => new Promise((resolve) => {
    const R = window.R;
    R.load('dense', { run: 600 });
    const times = [];
    let last = performance.now();
    let n = 0;
    const loop = () => {
      const now = performance.now();
      times.push(now - last);
      last = now;
      R.sim.advance(0.2);
      R.renderer.render(0.5);
      if (++n < 240) requestAnimationFrame(loop);
      else {
        times.shift();
        times.sort((a, b) => a - b);
        resolve({ median: times[Math.floor(times.length / 2)], p95: times[Math.floor(times.length * 0.95)], max: times[times.length - 1], over25: times.filter((t) => t > 25).length, n: times.length });
      }
    };
    requestAnimationFrame(loop);
  }));
  console.log(`       rAF intervals: median ${res.median.toFixed(1)} ms, p95 ${res.p95.toFixed(1)} ms, max ${res.max.toFixed(1)} ms, ${res.over25} of ${res.n} frames over 25 ms (software raster stalls)`);
  assert.ok(res.median < 18, `median frame interval ${res.median.toFixed(1)} ms`);
  assert.ok(res.over25 / res.n < 0.1, `${res.over25} of ${res.n} frames took more than 25 ms`);
});

check('', '', `frame time: 160 x 160 cells with 100 vehicles (big plant) stays under ${FRAME_BUDGET_MS} ms/frame, static layer rebuild cost is reported`, async (ctx) => {
  const res = await P(ctx, () => {
    const R = window.R;
    R.load('big', { run: 900 });
    const out = [];
    const flush = () => R.pixel(0, 0);
    const bench = (label, frames = 160) => {
      for (let i = 0; i < 15; i++) R.renderer.render(0.5);
      flush();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) R.renderer.render((i % 10) / 10);
      flush();
      out.push({ label, ms: +((performance.now() - t0) / frames).toFixed(2) });
    };
    const moving = R.sim.vehicles.filter((v) => v.tv.driving).length;
    R.fit(); bench(`fit (${R.camera.zoom.toFixed(1)} px/m, whole grid on screen)`);
    R.view({ overlays: { ids: true, docks: true, heat: 'traffic' } }); bench('fit + ids + docks + traffic heat');
    R.view({ overlays: { ids: false, docks: false, heat: 'off' } });
    R.focus(80, 80, 20); bench('20 px/m');
    const rebuild = (label) => {
      const times = [];
      for (let i = 0; i < 7; i++) { R.renderer.invalidate(); const t0 = performance.now(); R.renderer.render(1); flush(); times.push(performance.now() - t0); }
      times.sort((a, b) => a - b);
      out.push({ label: `static rebuild at ${label} (median of 7, flushed)`, ms: +times[3].toFixed(1), rebuild: true });
    };
    R.fit(); rebuild(`fit ${R.camera.zoom.toFixed(1)} px/m`);
    R.focus(80, 80, 20); rebuild('20 px/m');
    R.focus(80, 80, 60); rebuild('60 px/m');
    return { out, moving, vehicles: R.sim.vehicles.length };
  });
  console.log(`       ${res.vehicles} vehicles (${res.moving} driving) on 160 x 160 cells:`);
  for (const r of res.out) console.log(`         ${r.label.padEnd(58)} ${String(r.ms).padStart(6)} ms`);
  const frames = res.out.filter((r) => !r.rebuild);
  assert.deepEqual(frames.filter((r) => r.ms > FRAME_BUDGET_MS).map((r) => `${r.label}: ${r.ms} ms`), []);
});

check('', '', 'memory: 4500 frames with 100 vehicles leave the heap flat after a GC; allocation volume per frame is reported (young-generation garbage from boxed canvas arguments)', async (ctx) => {
  await P(ctx, () => window.R.load('dense', { run: 600 }));
  const cdp = await ctx.context.newCDPSession(ctx.page);
  await cdp.send('HeapProfiler.enable');
  const frames = (n) => P(ctx, (k) => { for (let i = 0; i < k; i++) window.R.renderer.render((i % 10) / 10); }, n);
  await frames(300);
  await cdp.send('HeapProfiler.collectGarbage');
  const before = (await cdp.send('Runtime.getHeapUsage')).usedSize;
  await cdp.send('HeapProfiler.startSampling', { samplingInterval: 64, includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true });
  await frames(1500);
  const { profile } = await cdp.send('HeapProfiler.stopSampling');
  let total = 0;
  const byFn = new Map();
  const walk = (node) => {
    if (node.selfSize > 0) { total += node.selfSize; const k = `${node.callFrame.functionName || '(anon)'} ${node.callFrame.url.split('/').pop()}`; byFn.set(k, (byFn.get(k) || 0) + node.selfSize); }
    node.children.forEach(walk);
  };
  walk(profile.head);
  await frames(2700);
  await cdp.send('HeapProfiler.collectGarbage');
  const after = (await cdp.send('Runtime.getHeapUsage')).usedSize;
  const top = [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${(v / 1500 / 1024).toFixed(1)} KB/frame`).join('; ');
  console.log(`       allocation volume ${(total / 1500 / 1024).toFixed(0)} KB/frame (~${(total / 1500 * 60 / 1e6).toFixed(1)} MB/s at 60 fps), top: ${top}; heap after GC ${(before / 1e6).toFixed(2)} -> ${(after / 1e6).toFixed(2)} MB`);
  assert.ok(after - before < 1.5e6, `heap grew by ${((after - before) / 1e6).toFixed(2)} MB over 4500 frames`);
  assert.ok(total / 1500 < 200 * 1024, `${(total / 1500 / 1024).toFixed(0)} KB allocated per frame`);
});

check('PERF-1', 'medium', 'very large hi-dpi canvases (2560 x 1440 CSS px at devicePixelRatio 2 = 5120 x 2880 px): panning must not rebuild the static layer every frame', async (ctx) => {
  const res = await P(ctx, () => {
    const R = window.R;
    R.load('big', { run: 0 }); // 320 m wide: the cached window is limited by the viewport, not by the plate
    R.focus(80, 80, 20);
    R.renderer.render(1);
    const b0 = R.renderer.stats.staticBuilds;
    const t0 = performance.now();
    for (let i = 0; i < 12; i++) { R.camera.pan(-3, 0); R.renderer.render(1); }
    R.pixel(0, 0);
    return { canvas: [R.canvas.width, R.canvas.height], builds: R.renderer.stats.staticBuilds - b0, msPerFrame: (performance.now() - t0) / 12 };
  });
  console.log(`       canvas ${res.canvas.join(' x ')}: 12 pan frames of 3 px -> ${res.builds} static rebuilds, ${res.msPerFrame.toFixed(1)} ms/frame`);
  assert.ok(res.builds <= 1, `${res.builds} of 12 pan frames rebuilt the static layer (${res.msPerFrame.toFixed(0)} ms/frame): the cache window falls back to "no margin" above ~12 megapixels`);
}, { viewport: { width: 2560, height: 1440 }, deviceScaleFactor: 2 });

check('', '', 'devicePixelRatio 1.5 with an odd CSS size: backing store matches the CSS box within 0.1 % (no blur from a non-integer scale)', async (ctx) => {
  const res = await P(ctx, () => {
    const R = window.R;
    R.load('twoLines', { run: 5 });
    return { dpr: devicePixelRatio, cssW: R.canvas.clientWidth, w: R.canvas.width, cssH: R.canvas.clientHeight, h: R.canvas.height };
  });
  const sx = res.w / (res.cssW * res.dpr);
  const sy = res.h / (res.cssH * res.dpr);
  assert.ok(Math.abs(sx - 1) < 1e-3 && Math.abs(sy - 1) < 1e-3, `backing store ${res.w} x ${res.h} for a ${res.cssW} x ${res.cssH} CSS box at ${res.dpr}: scale ${sx.toFixed(5)} x ${sy.toFixed(5)}`);
}, { viewport: { width: 1001, height: 701 }, deviceScaleFactor: 1.5 });

// ---------------------------------------------------------------------------------------------------------
// screenshot tours (look at them)
// ---------------------------------------------------------------------------------------------------------

async function tourPlants(ctx) {
  for (const dark of [false, true]) {
    const t = dark ? 'dark' : 'light';
    await P(ctx, (d) => window.R.load('congestion', { run: 240, dark: d }), dark);
    await snap(ctx, `${t}-cong-fit`);
    await P(ctx, (d) => window.R.load('twoLines', { run: 1500, dark: d }), dark);
    await snap(ctx, `${t}-two-fit`);
    for (const z of [20, 40, 70]) {
      await P(ctx, (zz) => window.R.focus(30, 12, zz), z);
      await snap(ctx, `${t}-two-${z}ppm-centre`);
    }
  }
}

/** Vehicle cues on the compact busy plant: broken, waiting, loaded, low battery, depot bays with chargers. */
async function tourCues(ctx) {
  for (const dark of [false, true]) {
    const t = dark ? 'dark' : 'light';
    await P(ctx, (d) => window.R.load('busy', { run: 0, dark: d }), dark);
    for (const kind of ['broken', 'waiting', 'loaded', 'lowBattery']) {
      const i = await P(ctx, (k) => window.R.runUntil(k, 4000), kind);
      if (i < 0) { console.log(`  ${t} cue ${kind}: not reached`); continue; }
      const info = (await P(ctx, () => window.R.vehicleInfo()))[i];
      for (const z of [20, 40, 70]) {
        await P(ctx, ([x, y, zz]) => window.R.focusWorld(x, y, zz), [info.x, info.y, z]);
        await snap(ctx, `${t}-cue-${kind}-${z}ppm`);
      }
    }
    await P(ctx, () => window.R.runUntil('charging', 4000));
    for (const z of [20, 40, 70]) {
      await P(ctx, (zz) => window.R.focus(17, 0, zz), z);
      await snap(ctx, `${t}-cue-depot-${z}ppm`);
    }
  }
}

/** Heatmaps, selection, handles, ghosts and previews on the two-lines plant (real sim). */
async function tourInteraction(ctx) {
  for (const dark of [false, true]) {
    const t = dark ? 'dark' : 'light';
    await P(ctx, (d) => window.R.load('twoLines', { run: 1800, dark: d }), dark);
    for (const mode of ['traffic', 'waiting']) {
      await P(ctx, (m) => { window.R.view({ overlays: { heat: m } }); window.R.fit(); }, mode);
      await snap(ctx, `${t}-heat-${mode}-fit`);
    }
    await P(ctx, () => window.R.view({ overlays: { heat: 'traffic' } }));
    for (const z of [20, 40, 70]) {
      await P(ctx, (zz) => window.R.focus(8, 12, zz), z);
      await snap(ctx, `${t}-heat-traffic-${z}ppm`);
    }
    await P(ctx, () => window.R.view({ overlays: { heat: 'off' } }));
    await P(ctx, () => window.R.view({
      selection: { kind: 'station', ids: ['s4'] }, resizeHandles: true, hover: { kind: 'station', id: 's7' },
      ghost: { kind: 'station', type: 'storage', rect: { x: 8, y: 14, w: 4, h: 3 }, valid: true },
      paintPreview: { cells: [[40, 8], [40, 9], [40, 10], [41, 10]], oneWay: true, blocked: [[42, 10]] },
      marquee: { x: 60, y: 30, w: 40, h: 24 },
    }));
    for (const z of [20, 40]) {
      await P(ctx, (zz) => window.R.focus(24, 11, zz), z);
      await snap(ctx, `${t}-select-${z}ppm`);
    }
    await P(ctx, () => {
      window.R.view({
        selection: { kind: 'flow', ids: ['f1'] }, resizeHandles: false, hover: { kind: 'cell', cell: [18, 18] },
        ghost: { kind: 'station', type: 'process', rect: { x: 26, y: 12, w: 3, h: 3 }, valid: false },
        paintPreview: null, flowPreview: { fromId: 's1', toPoint: [60, 24] }, marquee: null,
      });
      window.R.fit();
    });
    await snap(ctx, `${t}-flow-selected-invalid-ghost`);
  }
}

/** Speed zones, tuggers in corners, tiny cells. */
async function tourMisc(ctx) {
  for (const dark of [false, true]) {
    const t = dark ? 'dark' : 'light';
    await P(ctx, (d) => window.R.load('zones', { run: 120, dark: d }), dark);
    const i = await P(ctx, () => window.R.runUntil('turning', 3000));
    if (i < 0) { console.log(`  ${t}: no turning tugger found`); continue; }
    await P(ctx, (idx) => { window.R.sim.vehicles[idx].load = [{}, {}, {}, {}]; }, i);
    const info = (await P(ctx, () => window.R.vehicleInfo()))[i];
    for (const z of [20, 40, 70]) {
      await P(ctx, ([x, y, zz]) => window.R.focusWorld(x, y, zz), [info.x, info.y, z]);
      await snap(ctx, `${t}-tugger-corner-${z}ppm`);
    }
  }
  await P(ctx, () => { window.R.load('tiny', { run: 5 }); window.R.focus(12, 8, 40); });
  await snap(ctx, 'light-tiny-cells-40ppm');
}

async function tour(ctx) {
  await openPage(ctx);
  const which = process.env.REVIEW_TOUR || 'all';
  if (which === 'none') return;
  if (which === 'all' || which === 'plants') await tourPlants(ctx);
  if (which === 'all' || which === 'cues') await tourCues(ctx);
  if (which === 'all' || which === 'interaction') await tourInteraction(ctx);
  if (which === 'all' || which === 'misc') await tourMisc(ctx);
}

// ---------------------------------------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------------------------------------

async function main() {
  const only = process.env.REVIEW_ONLY;
  const selected = registry.filter((c) => !only || c.title.includes(only) || c.id.includes(only));
  const outcomes = [];
  const record = (c, error) => {
    outcomes.push({ c, error });
    const tag = c.id ? `[${c.id} ${c.severity}] ` : '';
    if (error) console.error(`  FAIL ${tag}${c.title}\n       ${String(error.message).split('\n').join('\n       ')}`);
    else console.log(`  ok   ${tag}${c.title}`);
  };
  for (const c of selected.filter((x) => x.opts.node)) {
    try { await c.fn(); record(c, null); } catch (e) { record(c, e); }
  }
  // checks that need the default 1440 x 900 viewport share one browser; others get their own
  const groups = new Map();
  for (const c of selected.filter((x) => !x.opts.node)) {
    const key = c.opts.viewport ? JSON.stringify([c.opts.viewport, c.opts.deviceScaleFactor || 1]) : 'default';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  for (const [key, list] of groups) {
    const first = list[0].opts;
    await withBrowser(async (ctx) => {
      for (const c of list) {
        try {
          await openPage(ctx);
          await c.fn(ctx);
          record(c, null);
        } catch (e) {
          record(c, e);
        }
      }
      if (ctx.errors.length) {
        const err = new Error(ctx.errors.slice(0, 6).join('\n'));
        record({ id: 'CONSOLE-1', severity: 'high', title: `console errors / warnings during the checks (${key})` }, err);
      }
    }, first.viewport ? { viewport: first.viewport, deviceScaleFactor: first.deviceScaleFactor || 1 } : {});
  }
  if (!only) {
    await withBrowser(async (ctx) => {
      await tour(ctx);
      if (ctx.errors.length) record({ id: 'CONSOLE-2', severity: 'high', title: 'console errors / warnings during the screenshot tour' }, new Error(ctx.errors.slice(0, 6).join('\n')));
    });
    if (shotPaths.length) console.log(`\n${shotPaths.length} screenshots in ${OUT} (review-*.png)`);
  }
  const failed = outcomes.filter((o) => o.error);
  const known = failed.filter((o) => o.c.id);
  console.log(`\n${outcomes.length - failed.length} of ${outcomes.length} checks pass; ${failed.length} fail`
    + (known.length ? ` (${known.map((o) => o.c.id).join(', ')})` : ''));
  if (failed.length) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
