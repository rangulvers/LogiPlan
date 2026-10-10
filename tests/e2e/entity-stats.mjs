// Statistics on click, the whole of step S1 together, in the REAL app in real Chromium (docs/ENTITY-INSIGHTS-DESIGN.md 9.1 and 10.10; the VERIFY part of S1).
// The other scripts test the pieces on their own: stats-dock.mjs the shell (gestures, states, camera), stats-view.mjs what the dock shows, the unit tests the model, the
// collector and the overlay. This one clicks like a planner and checks that the pieces fit: the real runner with its collector, the dock with the real model and view, and the
// route layer on the canvas, on the shipped examples.
//
//   vehicle    Congestion lab at 600x to 40 minutes. A click on a vehicle: the dock is closed while the button is down and open (compact, six numbers) after pointerup, the canvas
//              and the zoom are as before. Every number equals the collector's own answer for the shown window and the Results tab (S1.9): trips per hour, busy, held up, the
//              rows of "where it is held up" add up to the tile, the time split to 100 %, no printed share above 100 %, no NaN or Infinity anywhere. The routes are on the plan
//              (pixel probe: the route colour on the cells of the usual path, nothing on bare ground; S1.11), hovering a trip row dims the other routes, Enter pins, Esc unpins,
//              the second Esc clears the selection and closes the dock. Last 30 min (S1.10): the same checks for the other window, the cell rows say why they are missing.
//   examples   the same checks on Two lines, Dock lab and Warehouse first day (docks: the trips are grouped by the docks they use; a vehicle that does not move at all shows no NaN)
//   kinds      one click each on Goods in (with trucks and doors), a workstation, a storage, Goods out, a depot, a flow arrow, a road cell, a dock cell, a marquee of three stations,
//              a fleet and two vehicles: six numbers each, a counting rule behind every (i), no console error (S1.13)
//   edit       the plant is edited while a vehicle is selected: the warm restart keeps the selection and the dock, the numbers continue with the new collector (S1.6)
//   gesture    S1.7 with real pointer events on the finished app: dragging an unselected station by 5 cells never opens the dock or moves the camera, a click opens it after pointerup,
//              clicking empty ground moves nothing
//   keyboard   Fleet tab -> Enter -> Tab through the dock to a trip row (the path is drawn) -> Enter pins -> Esc unpins -> Esc closes; [ and ] cycle the vehicles; I toggles
//   phone      390 x 844 with touch: tap a vehicle, the sheet peeks, the grip opens it to half and full, the plan stays tappable
//   theme      light and dark: the route colours are the ones of the theme (pixel probe in both)
//   frame      the exclusive frame-time probe (S1.11): the 100-vehicle plant of tests/helpers/big-plant.js at 600x, the route layer on against the same view without it, at most
//              +0.5 ms per frame at the median (the numbers are printed)
//   shots      e2e-output/entity-*.png: vehicle compact, open, Last 30 min, one strip of another kind, the routes, light and dark at 1440 x 900 and 390 x 844 (open and look at them)
//
// Run: node tests/e2e/entity-stats.mjs [section ...]       (no section = all; names as above)
// It is an `exclusive` script of tests/e2e/run.mjs: the frame probe wants a quiet machine.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../../scripts/serve.mjs';
import { OUT } from './browser.mjs';

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };
const near = (a, b, tol, msg) => { assert.ok(Number.isFinite(a) && Math.abs(a - b) <= tol, `${msg}: ${a} against ${b} (tolerance ${tol})`); checks++; };
mkdirSync(OUT, { recursive: true });

const wanted = new Set(process.argv.slice(2));
const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const problems = [];
const measurements = {};
let section = '';
const shotPath = (name) => path.join(OUT, `entity-${name}.png`);

/** A new visitor. Console errors and warnings, page errors and failed requests are collected in `problems` and asserted empty at the end of every section. */
async function session({ viewport = { width: 1440, height: 900 }, colorScheme = 'light', touch = false } = {}) {
  const context = await browser.newContext({ viewport, colorScheme, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${section}] [console.${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${section}] [pageerror] ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`[${section}] [requestfailed] ${r.url()}`));
  await page.goto(`${origin}/index.html`);
  await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
  if (await page.locator('[role=dialog]').count()) {
    await page.keyboard.press('Escape');
    await page.locator('[role=dialog]').waitFor({ state: 'detached' });
  }
  return { context, page };
}

const frames = (page, n = 3) => page.evaluate((count) => new Promise((resolve) => { const next = (left) => (left ? requestAnimationFrame(() => next(left - 1)) : resolve()); next(count); }), n);
/** Let the dock refresh (it runs at 4 Hz from the runner's kpis event) and the route layer rebuild (twice a second at most). */
const settle = async (page) => { await frames(page, 3); await page.waitForTimeout(700); await frames(page, 2); };

/** Load an example, let it run past its warm-up and `seconds` of measured time at `speed`, then pause: everything has data to show. */
async function measured(page, example, seconds = 2400, speed = 600) {
  await page.evaluate(async (id) => { await window.__logiplan.ctx.actions.loadExample(id); }, example);
  await frames(page, 3);
  await page.evaluate(async (sp) => { const r = window.__logiplan.runner; r.setSpeed(sp); await r.play(); }, speed);
  await page.waitForFunction((s) => { const w = window.__logiplan.runner.kpis()?.window; return Boolean(w) && w.warmingUp !== true && w.duration >= s; }, seconds, { timeout: 240000 });
  await page.evaluate(() => window.__logiplan.runner.pause());
  await frames(page, 4);
}

const selection = (page) => page.evaluate(() => structuredClone(window.__logiplan.store.getState().ui.selection));
const dock = (page) => page.evaluate(() => {
  const el = document.querySelector('.stats-dock');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { hidden: el.hidden, state: el.dataset.state, snap: el.dataset.snap, kind: el.dataset.kind, label: el.getAttribute('aria-label'), top: r.top, bottom: r.bottom, height: r.height, width: r.width, left: r.left };
});
const view = (page) => page.evaluate(() => {
  const { ctx } = window.__logiplan;
  const r = ctx.canvas.getBoundingClientRect();
  return { camera: { x: ctx.camera.x, y: ctx.camera.y, zoom: ctx.camera.zoom }, canvas: { x: r.x, y: r.y, w: r.width, h: r.height } };
});
const status = (page) => page.locator('.statusbar__text').innerText();
const dockText = (page) => page.evaluate(() => document.querySelector('.stats-dock').innerText);

/** The six numbers of the open dock: [{ id, label, value, unit, ref, rule }]. */
const tiles = (page) => page.evaluate(() => [...document.querySelectorAll('.stats-dock [data-tile]')].map((t) => ({
  id: t.dataset.tile, label: t.querySelector('.tile__name').textContent.trim(), since: !t.querySelector('.tile__since').hidden,
  value: t.querySelector('.tile__num').textContent.trim(), unit: t.querySelector('.tile__value small').hidden ? '' : t.querySelector('.tile__value small').textContent.trim(),
  ref: t.querySelector('.tile__ref').textContent.replace(/\s+/g, ' ').trim(), rule: t.querySelector('button.def').getAttribute('aria-label'),
  visible: t.getBoundingClientRect().height > 0,
})));

/** Where a vehicle is on the screen; `pick` is a page-side condition on the simulation's vehicle `v` and its index `i`. */
const vehicleAt = (page, pick = "v.visible && v.state !== 'parked'", skip = []) => page.evaluate(([cond, skipIds]) => {
  const { ctx, runner } = window.__logiplan;
  const r = ctx.canvas.getBoundingClientRect();
  const dockEl = document.querySelector('.stats-dock');
  const free = dockEl && !dockEl.hidden ? dockEl.getBoundingClientRect().top - r.top : r.height;
  const test = new Function('v', 'i', `return ${cond}`);
  const fits = (v) => { const [px, py] = ctx.camera.worldToScreen(v.x, v.y); return px > 70 && px < r.width - 90 && py > 130 && py < free - 30; };
  const list = runner.sim.vehicles.map((v, i) => ({ v, i })).filter(({ v, i }) => !skipIds.includes(v.id) && test(v, i));
  const best = list.filter(({ v }) => fits(v)).sort((a, b) => b.v.trips - a.v.trips)[0] || list.sort((a, b) => b.v.trips - a.v.trips)[0];
  if (!best) return null;
  const [px, py] = ctx.camera.worldToScreen(best.v.x, best.v.y);
  return { x: r.left + px, y: r.top + py, id: best.v.id, fleetId: best.v.fleetId, name: best.v.name, trips: best.v.trips, inView: fits(best.v) };
}, [pick, skip]);

/** What the collector and the report say about vehicle `id` for window `kind`: the numbers every tile of the dock must equal. */
const truthOf = (page, id, kind) => page.evaluate(([vid, win]) => {
  const { runner } = window.__logiplan;
  const d = runner.detail();
  const i = d.vehicleIndex(vid);
  const w = d.windowOf(win);
  const t = d.timeSplit(i, w);
  const c = d.counts(i, w);
  const hours = t.seconds / 3600;
  const rep = runner.kpis();
  const fleet = rep.fleets[vid.split('#')[0]];
  const fleetN = fleet.count;
  const fleetId = vid.split('#')[0];
  let mates = 0; let mTrips = 0; let mBusy = 0; let mHeld = 0; let mParked = 0;
  for (let k = 0; k < d.V.length; k++) {
    if (d.V[k].fleetId !== fleetId) continue;
    const tk = d.timeSplit(k, w);
    if (!(tk.seconds > 0)) continue;
    mates++; mTrips += d.counts(k, w).trips / (tk.seconds / 3600); mBusy += (tk.driving + tk.waiting + tk.dockQueue + tk.loading + tk.unloading) / tk.seconds; mHeld += (tk.waiting + tk.dockQueue) / tk.seconds; mParked += tk.parked / tk.seconds;
  }
  return {
    fleet: { mates, tripsPerHour: mTrips / mates, busy: mBusy / mates, held: mHeld / mates, parked: mParked / mates },
    seconds: t.seconds, tripsPerHour: c.trips / hours, trips: c.trips,
    busy: (t.driving + t.waiting + t.dockQueue + t.loading + t.unloading) / t.seconds, held: (t.waiting + t.dockQueue) / t.seconds, parked: t.parked / t.seconds,
    drivenKmH: (c.loaded + c.empty + c.park) / hours / 1000,
    split: { driving: t.driving, waiting: t.waiting, dockQueue: t.dockQueue, loading: t.loading, unloading: t.unloading, idle: t.idle, parked: t.parked, charging: t.charging, broken: t.broken },
    subs: [t.drivingLoaded, t.drivingEmpty, t.drivingDepot], driving: t.driving,
    report: { trips: fleet.vehicleTrips[vid], duration: rep.window.duration, fleetHeld: fleet.shares.waiting, fleetUtil: fleet.utilization, tripsPerVehicleHour: fleet.tripsPerVehicleHour, count: fleetN },
    windowSeconds: w.seconds,
  };
}, [id, kind]);

const num = (s) => Number.parseFloat(String(s).replace(',', '.'));

/** The text of the dock has no NaN, Infinity, undefined, null or [object]; and every percentage in it is at most 100 (a share never exceeds 100 %, design 3.0 rule C). */
async function plainNumbers(page, what) {
  const text = await dockText(page);
  ok(!/NaN|Infinity|undefined|\bnull\b|\[object/.test(text), `${what}: no NaN, Infinity, undefined or null in the dock (${(/.{0,30}(NaN|Infinity|undefined|\bnull\b|\[object).{0,30}/.exec(text) || [''])[0].replace(/\n/g, ' ')})`);
  const over = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s?%/g)].map((m) => num(m[1])).filter((v) => v > 100);
  eq(over, [], `${what}: no share above 100 %`);
  return text;
}

/**
 * The cells of the usual path of a loaded pair of the vehicle, as [x, y] cell coordinates, plus the cell size in metres. The pair is a rank (the busiest first) or a focus id of
 * the dock's trip list ('loaded:s2>s3', station ids); null when the vehicle has no such trips.
 */
const pathCells = (page, vehicleId, win, which = 0) => page.evaluate(([vid, w, pick]) => {
  const { runner, store } = window.__logiplan;
  const d = runner.detail();
  const cols = runner.sim.graph.cols;
  const i = d.vehicleIndex(vid);
  const rows = d.routesOf(i, d.windowOf(w), [1]).filter((r) => r.drawn > 0 && r.pathId >= 0);
  rows.sort((x, y) => y.trips - x.trips);
  let r = rows[pick];
  if (pick === 'visible') { // the pair whose usual path has the most cells on the part of the plan that nothing covers (the bars at the top, the dock, the zoom buttons)
    const cv = window.__logiplan.ctx.canvas;
    const dockEl = document.querySelector('.stats-dock');
    const freeBottom = (dockEl && !dockEl.hidden ? dockEl.getBoundingClientRect().top - cv.getBoundingClientRect().top : cv.clientHeight) - 8;
    const cs = store.getState().layout.grid.cellSize;
    const count = (row) => Array.from(d.pool.nodes(row.pathId)).filter((n) => {
      const [px, py] = window.__logiplan.ctx.camera.worldToScreen(((n % cols) + 0.5) * cs, (Math.floor(n / cols) + 0.5) * cs);
      return px > 70 && px < cv.clientWidth - 90 && py > 95 && py < freeBottom && !(px > cv.clientWidth - 470 && py > freeBottom - 110);
    }).length;
    r = rows.slice(0, 3).sort((x, y) => count(y) - count(x))[0];
  } else if (typeof pick === 'string') {
    const m = /^loaded:(.*)>(.*)$/.exec(pick);
    r = rows.find((x) => d.stations[x.from] && d.stations[x.to] && d.stations[x.from].id === m[1] && d.stations[x.to].id === m[2]);
  }
  if (!r) return null;
  const nodes = Array.from(d.pool.nodes(r.pathId));
  return { cells: nodes.map((n) => [n % cols, Math.floor(n / cols)]), from: r.from, to: r.to, trips: r.trips, cs: store.getState().layout.grid.cellSize, rows: rows.length };
}, [vehicleId, win, which]);

/** Keep the pixels of the canvas under a name in the page (window.__grabs), to compare two frames of the same view. */
const grab = (page, name) => page.evaluate((k) => {
  const cv = window.__logiplan.ctx.canvas;
  const copy = document.createElement('canvas'); // a copy that is meant to be read often: the plan's own canvas must not log a readback warning
  copy.width = cv.width;
  copy.height = cv.height;
  const c = copy.getContext('2d', { willReadFrequently: true });
  c.drawImage(cv, 0, 0);
  (window.__grabs ||= {})[k] = c.getImageData(0, 0, cv.width, cv.height);
}, name);

/** The page-side helper of both probes: the windows around the centres of cells, as pixel boxes of the canvas, limited to the part of the plan that nothing covers. */
const PROBE_LIB = `
  const { ctx, store } = window.__logiplan;
  const cv = ctx.canvas;
  const k = cv.width / cv.clientWidth;
  const dockEl = document.querySelector('.stats-dock');
  const freeBottom = (dockEl && !dockEl.hidden ? dockEl.getBoundingClientRect().top - cv.getBoundingClientRect().top : cv.clientHeight) - 8;
  const cs = store.getState().layout.grid.cellSize;
  const half = Math.max(2, Math.floor(cs * ctx.camera.zoom * 0.42 * k));
  const boxOf = (cx, cy) => { const [px, py] = ctx.camera.worldToScreen((cx + 0.5) * cs, (cy + 0.5) * cs); return { px, py, x: Math.round(px * k), y: Math.round(py * k) }; };
  const visible = (b) => b.px > 70 && b.px < cv.clientWidth - 90 && b.py > 95 && b.py < freeBottom && !(b.px > cv.clientWidth - 470 && b.py > freeBottom - 110); // not under the bars, the zoom buttons, the dock or the key of the route layer
  const diff = (A, B, o) => Math.abs(A.data[o] - B.data[o]) + Math.abs(A.data[o + 1] - B.data[o + 1]) + Math.abs(A.data[o + 2] - B.data[o + 2]);
  const changedShare = (A, B, b, pick) => {
    let changed = 0; let n = 0; let like = 0;
    for (let y = b.y - half; y <= b.y + half; y++) for (let x = b.x - half; x <= b.x + half; x++) {
      if (x < 0 || y < 0 || x >= cv.width || y >= cv.height) continue;
      const o = (y * cv.width + x) * 4;
      n++;
      if (diff(A, B, o) > 30) { changed++; if (pick && pick([A.data[o], A.data[o + 1], A.data[o + 2]])) like++; }
    }
    return { share: n ? changed / n : 0, changed, like };
  };
`;

/**
 * The pixel probe of the route layer (S1.11). It draws the same view twice, with the overlay switch of the routes on and off, and compares the canvas pixels in a window
 * around the centre of every cell of the path: the route is on the plan when most of the visible cells changed, and what changed has the colour of the route (a point of the
 * blue -> amber -> red ramp of the theme). Bare ground away from the route must not change at all.
 */
async function routeProbe(page, route, theme, vehicleId) {
  // the job lines of the other vehicles disappear while the route layer shows (design 4.2): leave them out of both frames, so that the comparison is about the routes only
  const jobsBefore = await page.evaluate(() => window.__logiplan.store.getState().ui.overlays.jobs);
  await page.evaluate(() => window.__logiplan.store.setUi({ overlays: { routes: true, jobs: false } }));
  await settle(page);
  await grab(page, 'on');
  await page.evaluate(() => window.__logiplan.store.setUi({ overlays: { routes: false } }));
  await settle(page);
  await grab(page, 'off');
  await page.evaluate((jobs) => window.__logiplan.store.setUi({ overlays: { routes: true, jobs } }), jobsBefore);
  await settle(page);
  return page.evaluate(async ([cells, th, lib, vid]) => {
    // eslint-disable-next-line no-new-func
    const run = new Function('cells', 'th', 'ROUTE_COLORS', 'vid', `${lib}
      const pal = ROUTE_COLORS[th];
      const rgb = (hex) => [1, 3, 5].map((q) => parseInt(hex.slice(q, q + 2), 16));
      const stops = [rgb(pal.calm), rgb(pal.some), rgb(pal.much)];
      const distRamp = (p) => {
        let best = 1e9;
        for (let s = 0; s < 2; s++) {
          const a = stops[s]; const b = stops[s + 1];
          const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
          const len2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
          const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / len2));
          best = Math.min(best, Math.hypot(p[0] - (a[0] + ab[0] * t), p[1] - (a[1] + ab[1] * t), p[2] - (a[2] + ab[2] * t)));
        }
        return best;
      };
      const A = window.__grabs.on; const B = window.__grabs.off;
      const onPath = cells.map((c) => boxOf(c[0], c[1])).filter(visible);
      const l = store.getState().layout;
      const veh = window.__logiplan.runner.sim.vehicles.find((q) => q.id === vid);
      const vcell = veh ? [veh.x / cs, veh.y / cs] : [-99, -99]; // the ring of the selected vehicle pulses: not a place to look for bare ground
      const bare = [];
      for (let cy = 2; cy < l.grid.rows - 2; cy += 2) for (let cx = 2; cx < l.grid.cols - 2; cx += 2) {
        if (l.roads[cx + ',' + cy] || l.stations.some((s) => cx >= s.x - 2 && cx < s.x + s.w + 2 && cy >= s.y - 2 && cy < s.y + s.h + 2)) continue;
        if (cells.some((q) => Math.abs(q[0] - cx) < 7 && Math.abs(q[1] - cy) < 7) || (Math.abs(vcell[0] - cx) < 6 && Math.abs(vcell[1] - cy) < 6)) continue; // the chips of the route sit along it
        const b = boxOf(cx, cy);
        if (!visible(b)) continue;
        const reach = half / k + 7; // a flow arrow recedes to 35 % while the layer shows: leave out windows that a flow curve crosses
        let clear = true;
        for (const [dx, dy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, 1], [-1, 1], [1, -1]]) if (ctx.renderer.hitTest(b.px + dx * reach, b.py + dy * reach).kind !== 'cell') clear = false;
        if (clear) bare.push(b);
      }
      const m = onPath.map((b) => changedShare(A, B, b, (p) => distRamp(p) < 70));
      const bareList = bare.map((b) => ({ x: Math.round(b.px), y: Math.round(b.py), share: changedShare(A, B, b).share }));
      const bareShares = bareList.map((q) => q.share).sort((x, y) => x - y);
      const changed = m.reduce((a, q) => a + q.changed, 0);
      const like = m.reduce((a, q) => a + q.like, 0);
      const painted = m.filter((q) => q.share >= 0.06).length;
      return { visibleCells: onPath.length, painted, paintedShare: onPath.length ? painted / onPath.length : 0, routeColourShare: changed ? like / changed : 0,
        bareCells: bare.length, bareMedian: bareShares.length ? bareShares[bareShares.length >> 1] : 0, bareP90: bareShares.length ? bareShares[Math.floor(bareShares.length * 0.9)] : 0, bareTouched: bareShares.filter((q) => q > 0.02).length, touched: bareList.filter((q) => q.share > 0.02) };`);
    const { ROUTE_COLORS } = await import('/js/ui/render/routes.js');
    return run(cells, th, ROUTE_COLORS, vid);
  }, [route.cells, theme, PROBE_LIB, vehicleId]);
}

/**
 * Hovering a trip row dims the other routes (S1.11): the cells of route `a` that are not on route `b` (and the other way round) are compared with the same view without any
 * route, once with the row hovered (the caller did it) and once with the pointer away. A route drawn at 28 % is far closer to the bare plan than one drawn in full, the hovered one
 * is as strong as before or stronger. Leaves the row hovered again.
 */
async function dimProbe(page, a, b, row) {
  const jobsBefore = await page.evaluate(() => window.__logiplan.store.getState().ui.overlays.jobs);
  await page.evaluate(() => window.__logiplan.store.setUi({ overlays: { jobs: false } }));
  await settle(page);
  await grab(page, 'hover');
  await page.mouse.move(700, 120);
  await settle(page);
  await grab(page, 'calm');
  await page.evaluate(() => window.__logiplan.store.setUi({ overlays: { routes: false } }));
  await settle(page);
  await grab(page, 'bare');
  await page.evaluate((jobs) => window.__logiplan.store.setUi({ overlays: { routes: true, jobs } }), jobsBefore);
  const out = await page.evaluate(async ([ca, cb, lib]) => {
    // eslint-disable-next-line no-new-func
    const run = new Function('ca', 'cb', `${lib}
      const H = window.__grabs.hover; const C = window.__grabs.calm; const O = window.__grabs.bare;
      const setA = new Set(ca.map((q) => q[0] + ',' + q[1])); const setB = new Set(cb.map((q) => q[0] + ',' + q[1]));
      const away = (F, boxes) => { let sum = 0; for (const bx of boxes) for (let y = bx.y - half; y <= bx.y + half; y++) for (let x = bx.x - half; x <= bx.x + half; x++) sum += diff(F, O, (y * cv.width + x) * 4); return sum; };
      const own = (cells, other) => cells.filter((q) => !other.has(q[0] + ',' + q[1])).map((q) => boxOf(q[0], q[1])).filter(visible);
      const boxesA = own(ca, setB); const boxesB = own(cb, setA);
      return { nA: boxesA.length, nB: boxesB.length, aCalm: away(C, boxesA), aHover: away(H, boxesA), bCalm: away(C, boxesB), bHover: away(H, boxesB) };`);
    return run(ca, cb);
  }, [a.cells, b.cells, PROBE_LIB]);
  await settle(page);
  await page.locator('.stats-dock .trip').nth(row).hover();
  await settle(page);
  return out;
}

/**
 * The numbers of the dock for vehicle `id` and window `win` ('start' | 'last30') against what the collector and the Results tab say (S1.9, S1.10), plus the properties that must
 * hold for every vehicle: six tiles in order, every one with a value and a counting rule, no NaN, no share above 100 %, the time split adds up to 100 %, "where it is held up" adds
 * up to the Held up tile. The blocks are checked only when the dock is open. Returns the truth and the text for further checks.
 */
async function checkNumbers(page, id, win, label) {
  const t = await tiles(page);
  const truth = await truthOf(page, id, win);
  const hasBattery = t[5].id === 'battery';
  eq(t.map((x) => x.id), ['trips', 'busy', 'held', 'driven', 'loaded', hasBattery ? 'battery' : 'parked'], `${label}: six numbers in the order of the design`);
  eq(t.slice(0, 5).map((x) => x.label), ['Trips per hour', 'Busy, incl. waiting', 'Held up', 'Driven', 'Avg loaded trip'], `${label}: the first five carry the fixed words of the design`);
  ok(t.every((x) => x.value !== '' && x.rule.length > 40 && /^How is this counted\?/.test(x.rule)), `${label}: every number has a value and a counting rule behind its (i)`);
  const text = await plainNumbers(page, label);
  near(num(t[0].value), truth.tripsPerHour, 0.051, `${label}: trips per hour equals the collector`);
  near(num(t[1].value), truth.busy * 100, 0.51, `${label}: busy equals the collector`);
  near(num(t[2].value), truth.held * 100, 0.51, `${label}: held up equals the collector`);
  near(num(t[3].value), truth.drivenKmH, 0.051, `${label}: driven equals the odometers`);
  if (!hasBattery) near(num(t[5].value), truth.parked * 100, 0.51, `${label}: parked equals the collector`);
  // the fleet value next to each number is the mean of the fleet's vehicles over the same window, from the collector: it must be as current as the vehicle's own number (a paused simulation shows its last second)
  const peer = (ref, label) => { const m = /fleet (?:about )?([\d.]+)/.exec(ref); ok(m !== null, `${label}: a fleet value is shown (${ref})`); return num(m[1]); };
  near(peer(t[0].ref, `${label} trips`), truth.fleet.tripsPerHour, 0.051, `${label}: the fleet value of trips per hour is the fleet mean over this window`);
  near(peer(t[1].ref, `${label} busy`), truth.fleet.busy * 100, 0.51, `${label}: the fleet value of busy is the fleet mean over this window`);
  near(peer(t[2].ref, `${label} held up`), truth.fleet.held * 100, 0.51, `${label}: the fleet value of held up is the fleet mean over this window`);
  if (!hasBattery) near(peer(t[5].ref, `${label} parked`), truth.fleet.parked * 100, 0.51, `${label}: the fleet value of parked is the fleet mean over this window`);
  if (win === 'start') {
    // the Results tab: the report's deliveries of this vehicle over the report's window (the collector may differ by one trip)
    near(num(t[0].value), (truth.report.trips / truth.report.duration) * 3600, 3600 / truth.report.duration + 0.06, `${label}: trips per hour equals the Results fleet table`);
    const fleetTrips = /fleet (?:about )?([\d.]+)/.exec(t[0].ref);
    if (fleetTrips) near(num(fleetTrips[1]), truth.report.tripsPerVehicleHour, 0.06, `${label}: the fleet value of the trips tile is the Results tripsPerVehicleHour`);
    const fleetHeld = /fleet (?:about )?(\d+)/.exec(t[2].ref);
    if (fleetHeld) near(num(fleetHeld[1]), truth.report.fleetHeld * 100, 0.51, `${label}: the fleet value of the held up tile is the Results waiting share`);
  }
  const open = (await dock(page)).state === 'open' && (await page.locator('.stats-dock .insight__body').isVisible());
  if (open) {
    const split = await page.evaluate(() => [...document.querySelectorAll('.stats-dock .split__legend li')].map((li) => ({ label: li.children[1].textContent, share: parseFloat(li.children[2].textContent) })));
    if (truth.seconds > 0) {
      near(split.reduce((a, q) => a + q.share, 0), 100, 3.1, `${label}: the pieces of the time split add up to 100 % (rounding of up to 11 pieces)`);
      const sub = Object.fromEntries(split.map((q) => [q.label, q.share]));
      near((sub['Driving loaded'] || 0) + (sub['Driving empty'] || 0) + (sub['To depot / charger'] || 0), (truth.driving / truth.seconds) * 100, 1.6, `${label}: the three kinds of driving add up to the driving share`);
    }
    const held = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('.stats-dock [data-role="held"] .hbar')].map((r) => ({ label: r.children[0].textContent, minPerHour: parseFloat(r.children[2].textContent) }));
      const aside = document.querySelector('.stats-dock [data-role="held"] .aside');
      return { rows, together: aside ? parseFloat(/together ([\d.]+)/.exec(aside.textContent)[1]) : null };
    });
    if (truth.held * truth.seconds >= 1) {
      ok(held.rows.length >= 1 && held.rows.length <= 5 && held.rows[held.rows.length - 1].label.startsWith('Other places'), `${label}: "where it is held up" has at most four rows plus "Other places" (${held.rows.length})`);
      const rounding = (x) => (x >= 10 ? 0.5 : 0.05); // the dock prints one decimal below 10 min per hour and whole minutes above
      near(held.rows.reduce((a, r) => a + r.minPerHour, 0), held.together, rounding(held.together) + held.rows.reduce((a, r) => a + rounding(r.minPerHour), 0), `${label}: the rows add up to the figure in their heading`);
      near(held.together, truth.held * 60, Math.max(rounding(held.together) + 0.02, truth.held * 60 * 0.03), `${label}: the rows plus other places equal the Held up tile (3 %)`);
      if (win === 'last30') {
        ok(/Road cells are listed for Since start only/.test(text), `${label}: says why there are no road cells under Last 30 min`);
        ok(held.rows.every((r) => !/^(junction|road near|dock of)/i.test(r.label)), `${label}: no cell row (${held.rows.map((r) => r.label).join(' / ')})`);
      }
    }
    const trips = await page.evaluate(() => [...document.querySelectorAll('.stats-dock .trip')].map((r) => ({ focus: r.getAttribute('data-focus'), label: r.getAttribute('aria-label'), text: r.innerText.replace(/\s+/g, ' ') })));
    ok(trips.length <= 3, `${label}: the trips block lists at most the top 3 pairs (${trips.length})`);
    ok(trips.every((r) => /\d+ trips?/.test(r.text) && r.label && /^\d/.test(r.label)), `${label}: each trip row is a button with the whole sentence as its label`);
    const listed = trips.reduce((a, r) => a + Number(/(\d+) trips?/.exec(r.text)[1]), 0);
    ok(listed <= truth.trips + 1, `${label}: the listed trips (${listed}) are not more than the deliveries (${truth.trips})`);
    if (win === 'last30') {
      ok(/last 30 minutes/i.test(text) && /counted since/i.test(text), `${label}: the dock says which window it shows and since when it counts`);
      ok(!/\nFleet: /.test(text), `${label}: the fleet question is a since-start figure and says so (rule B)`);
    }
    return { truth, text, held, trips, split };
  }
  return { truth, text, held: null, trips: null, split: null };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The sections
// ---------------------------------------------------------------------------------------------------------------------------------------------
const sections = [];
const define = (name, what, fn) => sections.push({ name, what, fn });

define('vehicle', 'Congestion lab: the click, the numbers, the routes, the windows', async () => {
  const { page, context } = await session();
  await measured(page, 'congestion-lab', 2400);
  ok((await dock(page)).hidden, 'the dock is closed before the first click');
  const v = await vehicleAt(page, 'v.visible && v.state !== \'parked\' && v.trips >= 3');
  ok(v !== null && v.inView, `a moving vehicle with trips on the free part of the plan (${v && v.id})`);
  const before = await view(page);
  await page.mouse.move(v.x, v.y);
  await frames(page, 2);
  ok(/Click for statistics/.test(await status(page)), `the hover text says "Click for statistics" (${await status(page)})`);
  await page.mouse.down();
  await frames(page, 3);
  ok((await dock(page)).hidden, 'the dock is closed while the button is down');
  await page.mouse.up();
  await frames(page, 5);
  const d0 = await dock(page);
  ok(!d0.hidden && d0.state === 'compact', 'after pointerup the dock is open, compact the first time');
  eq(await selection(page), { kind: 'vehicle', ids: [v.id] }, 'a click on a vehicle selects the vehicle');
  const after = await view(page);
  eq(after.canvas, before.canvas, 'the canvas keeps its size');
  eq(after.camera.zoom, before.camera.zoom, 'and its zoom');
  await settle(page);
  ok(d0.height < 200, `compact is about 150 px high (${Math.round(d0.height)})`);

  // ---- the six numbers (compact) ----
  ok((await tiles(page)).every((x) => x.visible), 'all six numbers are visible in the compact state');
  eq(await page.locator('.stats-dock .insight__body').isVisible(), false, 'the blocks stay closed in the compact state');
  await checkNumbers(page, v.id, 'start', 'compact');
  eq(await page.locator('.stats-dock [data-role="routes"]').isChecked(), true, 'the routes switch is on by default');

  // ---- open: the three blocks ----
  await page.locator('.stats-dock .insight__details').click();
  await settle(page);
  eq((await dock(page)).state, 'open', 'the details button opens the dock');
  ok((await dock(page)).height <= 900 * 0.44 + 2, `the open dock is at most 44 % of the viewport (${Math.round((await dock(page)).height)} px)`);
  for (const b of ['time', 'facts', 'trips']) ok(await page.locator(`.stats-dock [data-block="${b}"]`).count() === 1, `the block "${b}" exists`);
  const opened = await checkNumbers(page, v.id, 'start', 'open');
  const { text, trips } = opened;
  ok(/Where its time goes/i.test(text) && /Worth knowing/i.test(text) && /Trips/i.test(text), 'the three blocks have their headings');
  ok(/\d+ min measured/.test(text) && /Counted since \d+:\d\d \(warm-up excluded\)/.test(text), 'the dock says how long it measured and since when it counts (warm-up excluded)');
  ok(trips.length >= 1, 'the vehicle has trips to show');

  // ---- the routes on the plan: pixel probe (S1.11) ----
  const usual = await pathCells(page, v.id, 'start', 'visible');
  ok(usual !== null && usual.cells.length >= 4, `the collector has a usual path for this vehicle (${usual && usual.cells.length} cells)`);
  const probe = await routeProbe(page, usual, 'light', v.id);
  console.log(`   route pixels: ${probe.painted} of ${probe.visibleCells} visible cells of the usual path changed (${Math.round(probe.paintedShare * 100)} %), ${Math.round(probe.routeColourShare * 100)} % of the changed pixels have the route colour; ${probe.bareCells} bare-ground windows, ${probe.bareTouched} changed`);
  measurements.routeProbeCongestion = probe;
  ok(probe.visibleCells >= 4, `enough of the usual path is on the free part of the plan to probe (${probe.visibleCells} cells)`);
  ok(probe.paintedShare >= 0.7, `the route colour is on the cells of the usual path: ${probe.painted} of ${probe.visibleCells}`);
  ok(probe.routeColourShare >= 0.3, `and what changed has the colour of the route ramp (${Math.round(probe.routeColourShare * 100)} %)`);
  ok(probe.bareCells >= 10 && probe.bareTouched <= Math.ceil(probe.bareCells * 0.1), `bare ground away from the route and the flows is not touched, but for the odd label of a ring or chip (${probe.bareTouched} of ${probe.bareCells} windows changed: ${JSON.stringify(probe.touched)})`);
  const flowsRecede = await page.evaluate(() => window.__logiplan.ctx.renderer.view.stats);
  eq([flowsRecede.open, flowsRecede.window], [true, 'start'], 'the dock tells the renderer that it is open, for the window since start');

  // ---- hover a trip row: the others dim ----
  if (trips.length >= 2) {
    const a = await pathCells(page, v.id, 'start', trips[0].focus);
    const b = await pathCells(page, v.id, 'start', trips[1].focus);
    const keyB = trips[1].focus;
    ok(a !== null && b !== null, 'the collector has the usual path of both of the first two rows');
    await page.locator('.stats-dock .trip').nth(1).hover();
    await settle(page);
    eq(await page.evaluate(() => window.__logiplan.ctx.renderer.view.stats.focus), { id: keyB, pinned: false }, 'hovering a trip row tells the renderer which route it is');
    await page.evaluate(() => window.__logiplan.ctx.actions.fitView()); // the whole plant into the part the (44 vh) dock leaves free: the cells of both routes are in view
    await settle(page);
    const dim = await dimProbe(page, a, b, 1);
    console.log(`   dim probe: distance of route 1 (not hovered) from the bare plan ${dim.aCalm} -> ${dim.aHover}, of route 2 (hovered) ${dim.bCalm} -> ${dim.bHover} (cells ${dim.nA} / ${dim.nB})`);
    // the rings, chips and the vehicle sit on some cells and are not dimmed, so the figures are coarse: the other route clearly weaker, the hovered one not
    ok(dim.nA >= 3 && dim.nB >= 3, `both routes have cells to look at (${dim.nA} / ${dim.nB})`);
    ok(dim.aHover <= dim.aCalm * 0.75, `the other route is drawn dimmed while a row is hovered (${dim.aCalm} -> ${dim.aHover}, its distance from the bare plan)`);
    ok(dim.bHover >= dim.bCalm * 0.8, `the hovered route is not dimmed (${dim.bCalm} -> ${dim.bHover})`);
    await page.mouse.move(700, 120);
    await settle(page);
    eq(await page.evaluate(() => window.__logiplan.ctx.renderer.view.stats.focus), null, 'moving away lets go of the route');
    // Enter pins, Esc unpins (the selection stays)
    await page.locator('.stats-dock .trip').nth(0).focus();
    await page.keyboard.press('Enter');
    await settle(page);
    eq(await page.evaluate(() => window.__logiplan.ctx.renderer.view.stats.focus), { id: trips[0].focus, pinned: true }, 'Enter pins the route of the focused row');
    eq(await page.locator('.stats-dock .trip').nth(0).getAttribute('aria-pressed'), 'true', 'the row says it is pinned');
    await page.keyboard.press('Escape');
    await settle(page);
    eq(await page.evaluate(() => window.__logiplan.ctx.renderer.view.stats.focus), null, 'Esc unpins');
    eq((await selection(page)).kind, 'vehicle', 'and keeps the selection');
  }

  // ---- Last 30 min (S1.10) ----
  await page.getByRole('button', { name: 'Last 30 min', exact: true }).click();
  await settle(page);
  eq(await page.evaluate(() => window.__logiplan.ctx.renderer.view.stats.window), 'last30', 'the window switch reaches the route layer');
  const last30 = await checkNumbers(page, v.id, 'last30', 'last 30 min');
  near(last30.truth.windowSeconds, 1800, 31, 'the collector reads 30 minutes');
  await page.getByRole('button', { name: 'Since start', exact: true }).click();
  await settle(page);

  // ---- the crumb: the fleet is one click away; then back to the vehicle, Esc closes everything ----
  await page.locator('.stats-dock .insight__crumb a, .stats-dock .insight__crumb button').first().click();
  await settle(page);
  eq((await selection(page)).kind, 'fleet', 'the crumb "in AGV" selects the fleet');
  eq((await tiles(page)).length, 6, 'and the dock shows the six numbers of the fleet');
  await plainNumbers(page, 'fleet');
  await page.evaluate((id) => window.__logiplan.store.select('vehicle', [id]), v.id);
  await settle(page);
  await page.keyboard.press('Escape');
  await frames(page, 3);
  eq(await selection(page), { kind: null, ids: [] }, 'Esc clears the selection');
  ok((await dock(page)).hidden, 'and closes the dock');
  eq(await page.evaluate(() => window.__logiplan.ctx.renderer.view.stats.open), false, 'the route layer is told that the dock is closed');
  await context.close();
});

/** Click the busiest vehicle that can be hit with the pointer, open the details; returns the vehicle. */
async function clickBusiestVehicle(page, { open = true } = {}) {
  const cond = "v.visible && v.state !== 'parked' && v.trips >= 2";
  for (let k = 0; k < 60 && !(await vehicleAt(page, cond)); k++) { await page.evaluate(() => window.__logiplan.runner.step(2)); await frames(page, 2); } // all of them may be parked or in a dock at this very second
  const v = await vehicleAt(page, cond);
  ok(v !== null, 'a moving vehicle with trips');
  await page.mouse.click(v.x, v.y);
  await frames(page, 5);
  eq((await selection(page)).kind, 'vehicle', `a click on ${v.name} selects the vehicle`);
  if (open && (await dock(page)).state !== 'open') await page.locator('.stats-dock .insight__details').click();
  await settle(page);
  return v;
}

for (const ex of [
  { id: 'two-lines', seconds: 2400, docks: false, label: 'Two lines' },
  { id: 'dock-lab', seconds: 2000, docks: true, label: 'Dock lab' },
  { id: 'warehouse-first-day', seconds: 3600, docks: true, label: 'Warehouse first day' },
]) {
  define(`examples-${ex.id}`, `${ex.label}: click a vehicle, the numbers in both windows, the routes${ex.docks ? ', trips grouped by dock' : ''}`, async () => {
    const { page, context } = await session();
    await measured(page, ex.id, ex.seconds);
    const v = await clickBusiestVehicle(page);
    const open = await checkNumbers(page, v.id, 'start', `${ex.label} since start`);
    ok(open.trips.length >= 1, `${ex.label}: ${v.name} has trips to list (${open.trips.length})`);
    if (ex.docks) ok(/Dock \d → Dock \d/.test(open.text), `${ex.label}: the trips are grouped by the docks they use`);
    ok(/Usual round|usual route|ways|too few trips/.test(open.text), `${ex.label}: the trips say how usual they are`);
    await page.evaluate(() => window.__logiplan.ctx.actions.fitView()); // the whole plant into the part of the plan that the dock leaves free
    await settle(page);
    const usual = await pathCells(page, v.id, 'start', 'visible');
    if (usual) {
      const probe = await routeProbe(page, usual, 'light', v.id);
      console.log(`   ${ex.label}: route pixels ${probe.painted} of ${probe.visibleCells} visible cells (path has ${usual.cells.length}) changed, ${Math.round(probe.routeColourShare * 100)} % route-coloured, ${probe.bareTouched} of ${probe.bareCells} bare windows changed`);
      ok(probe.visibleCells >= 3, `${ex.label}: the usual path is on the free part of the plan (${probe.visibleCells} cells)`);
      ok(probe.paintedShare >= 0.7, `${ex.label}: the route colour is on the cells of the usual path (${probe.painted} of ${probe.visibleCells})`);
      ok(probe.bareTouched <= Math.ceil(probe.bareCells * 0.1), `${ex.label}: bare ground is not touched (${probe.bareTouched} of ${probe.bareCells})`);
    }
    await page.getByRole('button', { name: 'Last 30 min', exact: true }).click();
    await settle(page);
    await checkNumbers(page, v.id, 'last30', `${ex.label} last 30 min`);
    await page.screenshot({ path: shotPath(`${ex.id}-vehicle-last30-light`) });
    // the vehicle that did the least: no NaN, nothing above 100 %, a sentence that says what happened
    await page.getByRole('button', { name: 'Since start', exact: true }).click();
    const least = await page.evaluate(() => { const { runner } = window.__logiplan; return [...runner.sim.vehicles].sort((a, b) => a.trips - b.trips)[0].id; });
    await page.evaluate((id) => window.__logiplan.store.select('vehicle', [id]), least);
    await settle(page);
    await checkNumbers(page, least, 'start', `${ex.label} ${least} (the one with the fewest trips)`);
    await context.close();
  });
}

/** A point on the screen where the renderer says `pred(hit)`, on the part of the plan that nothing covers; null when there is none. */
const findPoint = (page, predSource) => page.evaluate((src) => {
  const { ctx } = window.__logiplan;
  const pred = new Function('hit', `return ${src}`);
  const cv = ctx.canvas;
  const r = cv.getBoundingClientRect();
  const dockEl = document.querySelector('.stats-dock');
  const free = (dockEl && !dockEl.hidden ? dockEl.getBoundingClientRect().top - r.top : r.height) - 12;
  for (let y = 92; y < free; y += 5) {
    for (let x = 70; x < r.width - 90; x += 5) {
      const hit = ctx.renderer.hitTest(x, y);
      if (pred(hit)) return { x: r.left + x, y: r.top + y, hit: { kind: hit.kind, id: hit.id, cell: hit.cell } };
    }
  }
  return null;
}, predSource);

const stationPoint = (page, id) => page.evaluate((sid) => {
  const { ctx, store } = window.__logiplan;
  const l = store.getState().layout;
  const st = l.stations.find((x) => x.id === sid);
  const cs = l.grid.cellSize;
  const r = ctx.canvas.getBoundingClientRect();
  const [px, py] = ctx.camera.worldToScreen((st.x + st.w / 2) * cs, (st.y + st.h / 2) * cs);
  const dockEl = document.querySelector('.stats-dock');
  const free = (dockEl && !dockEl.hidden ? dockEl.getBoundingClientRect().top - r.top : r.height) - 12;
  return { x: r.left + px, y: r.top + py, inView: px > 70 && px < r.width - 90 && py > 92 && py < free };
}, id);

/** Open the dock with any vehicle (so the camera knows how much is covered) and fit the whole plant into the part of the plan that is left. */
async function dockOpenFitted(page) {
  await page.evaluate(() => { const { store, runner, ctx } = window.__logiplan; store.select('vehicle', [runner.sim.vehicles[0].id]); ctx.actions.showStatistics(); });
  await settle(page);
  await page.evaluate(() => window.__logiplan.ctx.actions.fitView());
  await settle(page);
  await page.evaluate(() => { // the stations in the middle of the free band between the bars at the top and the dock, whatever the height of the dock
    const { ctx, store } = window.__logiplan;
    const l = store.getState().layout; const cs = l.grid.cellSize;
    const ys = l.stations.flatMap((st) => [ctx.camera.worldToScreen(0, st.y * cs)[1], ctx.camera.worldToScreen(0, (st.y + st.h) * cs)[1]]);
    const r = ctx.canvas.getBoundingClientRect();
    const top = 100; const bottom = document.querySelector('.stats-dock').getBoundingClientRect().top - r.top - 20;
    ctx.camera.pan(0, (top + bottom) / 2 - (Math.min(...ys) + Math.max(...ys)) / 2);
  });
  await settle(page);
}

/** One click on an item of a kind: what the dock shows. */
async function clickKind(page, what, point, expect) {
  await page.mouse.click(point.x, point.y);
  await settle(page);
  const sel = await selection(page);
  const d = await dock(page);
  eq([sel.kind, d.hidden], [expect.kind, false], `${what}: the click selects a ${expect.kind} and the dock is open (${JSON.stringify(sel)})`);
  const t = await tiles(page);
  eq(t.length, 6, `${what}: six numbers (${t.map((x) => x.label).join(' | ')})`);
  ok(t.every((x) => x.value !== '' && x.rule.length > 40), `${what}: every number has a value and a counting rule`);
  const text = await plainNumbers(page, what);
  ok(d.label && /^Statistics for/.test(d.label), `${what}: the region is labelled (${d.label})`);
  return { t, text, sel, d };
}

define('kinds', 'one click on every kind of item: six numbers each (Two lines, Warehouse first day, Dock lab)', async () => {
  const { page, context } = await session();
  // ---- Two lines: workstation, flow, road cell, marquee, fleet, two vehicles ----
  await measured(page, 'two-lines', 2400);
  await dockOpenFitted(page);
  const info = await page.evaluate(() => { const l = window.__logiplan.store.getState().layout; return { stations: l.stations.map((s) => ({ id: s.id, type: s.type, name: s.name })), flows: l.flows.map((f) => f.id), fleets: l.fleets.map((f) => f.id), roads: Object.keys(l.roads).length }; });
  const report = () => page.evaluate(() => { const r = window.__logiplan.runner.kpis(); return { stations: r.stations, flows: r.flows, duration: r.window.duration }; });
  const kinds = {};
  for (const type of ['process', 'source', 'sink', 'depot', 'storage']) {
    const st = info.stations.find((q) => q.type === type);
    if (!st) continue;
    const pt = await stationPoint(page, st.id);
    if (!pt.inView) continue;
    const got = await clickKind(page, `${type} ${st.name}`, pt, { kind: 'station' });
    kinds[type] = got.t.map((x) => `${x.label}: ${x.value}${x.unit}`);
    eq((await selection(page)).ids, [st.id], `${type}: the right station is selected`);
    ok(got.d.height < 200, `${type}: the strip alone is compact (${Math.round(got.d.height)} px)`);
    if (type === 'process') {
      const rep = (await report());
      const out = got.t.find((x) => x.id === 'output');
      if (out) near(num(out.value), rep.stations[st.id].produced / (rep.duration / 3600), 0.06, 'a workstation: output per hour equals the Results tab');
    }
  }
  console.log(`   strips: ${JSON.stringify(kinds)}`);
  eq(Object.keys(kinds).sort(), ['depot', 'process', 'sink', 'source', 'storage'], 'a workstation, a storage, Goods in, Goods out and a depot were all clicked');
  // a flow arrow
  const flowId = info.flows[0];
  const fp = await findPoint(page, `hit.kind === 'flow' && hit.id === ${JSON.stringify(flowId)}`);
  ok(fp !== null, 'a flow arrow can be hit on the plan');
  const flow = await clickKind(page, 'flow', fp, { kind: 'flow' });
  const delivered = flow.t.find((x) => x.id === 'delivered');
  if (delivered) near(num(delivered.value), (await report()).flows[flowId].delivered / ((await report()).duration / 3600), 0.06, 'a flow: delivered per hour equals the Results tab');
  // a road cell that is neither a station nor a flow nor a vehicle
  const rp = await findPoint(page, "hit.kind === 'cell' && Boolean(window.__logiplan.store.getState().layout.roads[hit.cell[0] + ',' + hit.cell[1]])");
  ok(rp !== null, 'a road cell can be hit on the plan');
  const cell = await clickKind(page, 'road cell', rp, { kind: 'cell' });
  eq(cell.d.kind, 'cell', 'the dock is labelled as a road cell');
  // a marquee of stations: drag from bare ground over several of them
  const box = await page.evaluate(() => {
    const { ctx, store } = window.__logiplan;
    const l = store.getState().layout; const cs = l.grid.cellSize; const r = ctx.canvas.getBoundingClientRect();
    const dockEl = document.querySelector('.stats-dock'); const free = dockEl.getBoundingClientRect().top - r.top - 12;
    const pts = l.stations.map((st) => ({ id: st.id, a: ctx.camera.worldToScreen(st.x * cs, st.y * cs), b: ctx.camera.worldToScreen((st.x + st.w) * cs, (st.y + st.h) * cs) })).filter((q) => q.a[1] > 100 && q.b[1] < free && q.a[0] > 70 && q.b[0] < r.width - 90);
    pts.sort((p, q) => p.a[0] - q.a[0]);
    const three = pts.slice(0, 3);
    if (three.length < 3) return null;
    const x0 = Math.min(...three.map((q) => q.a[0])) - 6; const y0 = Math.min(...three.map((q) => q.a[1])) - 6;
    const x1 = Math.max(...three.map((q) => q.b[0])) + 6; const y1 = Math.max(...three.map((q) => q.b[1])) + 6;
    return { x0: r.left + x0, y0: r.top + y0, x1: r.left + x1, y1: r.top + y1, ids: three.map((q) => q.id) };
  });
  ok(box !== null, 'three stations on the free part of the plan');
  await page.keyboard.press('Escape');
  await settle(page);
  ok((await dock(page)).hidden, 'Esc closed the dock before the marquee');
  const startOk = await page.evaluate(([x, y]) => { const r = window.__logiplan.ctx.canvas.getBoundingClientRect(); const hit = window.__logiplan.ctx.renderer.hitTest(x - r.left, y - r.top); return hit.kind === 'cell' && !window.__logiplan.store.getState().layout.roads[hit.cell[0] + ',' + hit.cell[1]]; }, [box.x0, box.y0]);
  if (startOk) {
    await page.mouse.move(box.x0, box.y0);
    await page.mouse.down();
    await page.mouse.move(box.x1, box.y1, { steps: 8 });
    ok((await dock(page)).hidden, 'the dock stays closed while the marquee is dragged');
    await page.mouse.up();
    await settle(page);
    const sel = await selection(page);
    ok(sel.kind === 'station' && sel.ids.length >= 2, `a marquee selects the stations it covers (${sel.ids.length})`);
    ok((await dock(page)).hidden, 'and a marquee never opens the dock');
    await page.keyboard.press('i'); // the explicit request: I shows the statistics of the selection whatever the gesture was
    await settle(page);
    ok(!(await dock(page)).hidden, 'the key I shows the statistics of the several items');
    eq((await tiles(page)).length, 6, 'six numbers for several stations too');
    await plainNumbers(page, 'several stations');
  } else console.log('   (the marquee start point was not bare ground: the marquee is covered by stats-dock.mjs)');
  // the fleet, and two vehicles
  await page.evaluate((id) => window.__logiplan.store.select('fleet', [id]), info.fleets[0]);
  await settle(page);
  eq((await tiles(page)).length, 6, 'the fleet: six numbers');
  await plainNumbers(page, 'fleet');
  const v1 = await vehicleAt(page, "v.visible && v.state !== 'parked'");
  const v2 = v1 && await vehicleAt(page, "v.visible && v.state !== 'parked'", [v1.id]);
  if (v1 && v2) {
    await page.mouse.click(v1.x, v1.y);
    await page.keyboard.down('Shift');
    await page.mouse.click(v2.x, v2.y);
    await page.keyboard.up('Shift');
    await settle(page);
    eq((await selection(page)).ids.length, 2, 'Shift adds a second vehicle');
    eq((await tiles(page)).length, 6, 'two vehicles: six numbers');
    await plainNumbers(page, 'two vehicles');
  }
  await context.close();
});

define('kinds-docks', 'Goods in with trucks and doors, Goods out, and a dock cell (Warehouse first day, Dock lab)', async () => {
  const { page, context } = await session();
  await measured(page, 'warehouse-first-day', 2400);
  await dockOpenFitted(page);
  const st = await page.evaluate(() => window.__logiplan.store.getState().layout.stations.map((s) => ({ id: s.id, type: s.type, name: s.name })));
  const rep = () => page.evaluate(() => { const r = window.__logiplan.runner.kpis(); return { stations: r.stations, duration: r.window.duration, throughput: r.throughput }; });
  const goodsIn = st.find((q) => q.type === 'source');
  const pin = await stationPoint(page, goodsIn.id);
  ok(pin.inView, 'Goods in is on the free part of the plan');
  const got = await clickKind(page, 'Goods in with trucks', pin, { kind: 'station' });
  console.log(`   Goods in with trucks: ${got.t.map((x) => `${x.label}: ${x.value}${x.unit} (${x.ref})`).join(' | ')}`);
  const arrivals = got.t.find((x) => x.id === 'arrivals');
  ok(arrivals !== undefined, 'the strip of a Goods in starts with its arrivals');
  const r1 = await rep();
  near(num(arrivals.value), r1.stations[goodsIn.id].produced / (r1.duration / 3600), 0.06, 'arrivals per hour equal the Results tab (pallets released per hour)');
  ok(/trucks? in/.test(arrivals.ref), `with trucks the reference line says how many trucks came (${arrivals.ref})`);
  ok(got.t.some((x) => /Door/i.test(x.label)) || got.t.some((x) => x.id === 'gate'), `a Goods in with doors shows its doors or gate (${got.t.map((x) => x.label).join(', ')})`);
  const goodsOut = st.find((q) => q.type === 'sink');
  const pout = await stationPoint(page, goodsOut.id);
  if (pout.inView) {
    const o = await clickKind(page, 'Goods out', pout, { kind: 'station' });
    const shipped = o.t.find((x) => x.id === 'shipped');
    const r2 = await rep();
    ok(shipped !== undefined, 'the strip of a Goods out starts with what it shipped');
    near(num(shipped.value), r2.throughput.bySink[goodsOut.id].perHour, 0.06, 'Goods out: shipped per hour equals the Results tab (throughput.bySink)');
  }
  await context.close();

  // a dock cell of Dock lab
  const second = await session();
  const page2 = second.page;
  await measured(page2, 'dock-lab', 2000);
  await dockOpenFitted(page2);
  const dockCell = await page2.evaluate(() => {
    const { runner, store } = window.__logiplan;
    const cols = runner.sim.graph.cols;
    const rep = runner.kpis();
    for (const [sid, s] of Object.entries(rep.stations)) if (Array.isArray(s.docks) && s.docks.length) return { sid, cell: [s.docks[0].node % cols, Math.floor(s.docks[0].node / cols)], name: store.getState().layout.stations.find((q) => q.id === sid).name };
    return null;
  });
  ok(dockCell !== null, 'Dock lab has a station with docks');
  const cellPoint = await page2.evaluate(([cx, cy]) => { // a spot inside the dock cell that is not covered by a flow arrow, a label or a vehicle
    const { ctx, store } = window.__logiplan;
    const cs = store.getState().layout.grid.cellSize; const r = ctx.canvas.getBoundingClientRect();
    const [x0, y0] = ctx.camera.worldToScreen(cx * cs, cy * cs);
    const size = cs * ctx.camera.zoom;
    for (let fy = 0.15; fy < 0.9; fy += 0.15) for (let fx = 0.15; fx < 0.9; fx += 0.15) {
      const hit = ctx.renderer.hitTest(x0 + fx * size, y0 + fy * size);
      if (hit.kind === 'cell' && hit.cell[0] === cx && hit.cell[1] === cy) return { x: r.left + x0 + fx * size, y: r.top + y0 + fy * size, hit: 'cell' };
    }
    return { hit: ctx.renderer.hitTest(x0 + size / 2, y0 + size / 2).kind };
  }, dockCell.cell);
  if (cellPoint.hit === 'cell') {
    const c = await clickKind(page2, `a dock cell of ${dockCell.name}`, cellPoint, { kind: 'cell' });
    console.log(`   dock cell: ${c.t.map((x) => `${x.label}: ${x.value}${x.unit}`).join(' | ')}`);
    ok(c.text.includes(dockCell.name) || /dock/i.test(c.text), 'the dock cell page names the station it belongs to');
  } else console.log(`   (a vehicle or label covers the dock cell: ${cellPoint.hit})`);
  await second.context.close();
});

define('edit', 'edit the plant while a vehicle is selected: warm restart, runtime change, collector off and on, a failing collector', async () => {
  const { page, context } = await session();
  await measured(page, 'two-lines', 2400);
  const v = await clickBusiestVehicle(page);
  await checkNumbers(page, v.id, 'start', 'before the edit');
  const before = await page.evaluate(() => ({ time: window.__logiplan.runner.time, start: window.__logiplan.runner.detail().windowStart }));
  const tripsBefore = num((await tiles(page))[0].value);

  // ---- a structural edit while the simulation runs: the warm restart keeps the selection and the dock ----
  await page.evaluate(() => { window.__before = window.__logiplan.runner.sim; window.__detailBefore = window.__logiplan.runner.detail(); });
  await page.evaluate(async () => { const r = window.__logiplan.runner; r.setSpeed(60); await r.play(); });
  await page.evaluate(async () => {
    const M = await import('/js/model/layout.js');
    window.__logiplan.store.commit('Add Goods in 2', (l) => {
      M.paintRoadPath(l, [[27, 6], [27, 4]]);
      const gi = M.addStation(l, { type: 'source', name: 'Goods in 2', x: 26, y: 2, w: 3, h: 2, params: { interArrival: { kind: 'normal', mean: 240, spread: 0.2 }, outCap: 6 } });
      M.addFlow(l, gi.id, l.stations.find((st) => st.name === 'Central warehouse').id, {});
    });
  });
  await page.waitForFunction(() => { const r = window.__logiplan.runner; return r.sim !== window.__before && !r.priming && Boolean(r.warm); }, null, { polling: 'raf', timeout: 90000 });
  await page.evaluate(() => window.__logiplan.runner.pause()); // the numbers are compared with the collector at one instant: stand still for that
  await settle(page);
  eq(await selection(page), { kind: 'vehicle', ids: [v.id] }, 'the vehicle is still selected after the warm restart');
  ok(!(await dock(page)).hidden, 'and the dock is still open');
  const afterRestart = await page.evaluate(() => ({ same: window.__logiplan.runner.detail() === window.__detailBefore, has: Boolean(window.__logiplan.runner.detail()), err: window.__logiplan.runner.sim.detailError, start: window.__logiplan.runner.detail() && window.__logiplan.runner.detail().windowStart, time: window.__logiplan.runner.time }));
  ok(afterRestart.has && !afterRestart.same && afterRestart.err === null, 'the replacement simulation has a collector of its own, and it did not fail');
  const second = await checkNumbers(page, v.id, 'start', 'after the warm restart');
  const tripsAfter = num((await tiles(page))[0].value);
  console.log(`   trips per hour before ${tripsBefore}, after the restart ${tripsAfter}; the dock says: ${/[\d.]+ min measured[^\n]*/.exec(second.text)}`);
  ok(tripsAfter > 0 && tripsAfter < tripsBefore * 3 + 5, 'the numbers continue: the pre-rolled collector has a measured window to show, of the same order');
  ok(/[\d.]+ min measured/.test(second.text), 'and says how long it measured');
  void before; void afterRestart;

  // ---- a runtime setting (demand) changes under the collector: the dock says earlier figures mix both ----
  await page.evaluate(async () => { const M = await import('/js/model/layout.js'); window.__logiplan.store.commit('More demand', (l) => { M.updateSettings(l, { demandFactor: 1.4 }); }); });
  await page.evaluate(async () => { const r = window.__logiplan.runner; r.setSpeed(600); await r.play(); }); // the collector notes the change when the next 30 s bucket closes
  await page.waitForFunction(() => { const d = window.__logiplan.runner.detail(); return d && d.whatIf.length >= 1; }, null, { timeout: 60000 });
  await page.evaluate(() => window.__logiplan.runner.pause());
  await settle(page);
  const note = await dockText(page);
  ok(/changed \d+ (s|min)[^.]*ago: figures from before then mix both/.test(note) || /changed [^.]*ago: figures from before then mix both/.test(note), `a change of a runtime setting is noted in the dock (${(/[^.\n]*figures from before[^.\n]*/.exec(note) || ['no note'])[0]})`);

  // ---- the preference off and on: the dock shows the report-only strip, then counts from the moment it is switched on ----
  await page.evaluate(() => window.__logiplan.store.setUi({ detail: false }));
  await settle(page);
  ok(await page.evaluate(() => window.__logiplan.runner.detail() === null), 'switching the collection off drops the collector');
  ok(/not running/.test(await dockText(page)), 'the dock says that the statistics of single vehicles are not running');
  eq((await tiles(page)).length, 6, 'and still shows six numbers (the report only)');
  await plainNumbers(page, 'collector off');
  await page.evaluate(async () => { const r = window.__logiplan.runner; r.setSpeed(600); await r.play(); await new Promise((res) => setTimeout(res, 1500)); r.pause(); window.__logiplan.store.setUi({ detail: true }); });
  await page.evaluate(async () => { const r = window.__logiplan.runner; await r.play(); await new Promise((res) => setTimeout(res, 1200)); r.pause(); });
  await settle(page);
  const late = await dockText(page);
  ok(/counting since \d+:\d\d|Counting since \d+:\d\d/.test(late), `switched on late, the dock says "counting since" (${(/[Cc]ounting since [^\n]*/.exec(late) || ['no such text'])[0]})`);
  await plainNumbers(page, 'late');

  // ---- a collector that fails: the simulation runs on, the dock says so, Count again starts a new one ----
  await page.evaluate(() => { window.__logiplan.runner.detail().pool = null; }); // fault injection: the next leg that closes throws inside the collector (and the collector says why)
  await page.evaluate(async () => { const r = window.__logiplan.runner; window.__t0 = r.time; await r.play(); await new Promise((res) => setTimeout(res, 800)); r.pause(); });
  await settle(page);
  const failed = await page.evaluate(() => ({ detail: window.__logiplan.runner.detail(), err: window.__logiplan.runner.sim.detailError ? window.__logiplan.runner.sim.detailError.message : null, advanced: window.__logiplan.runner.time - window.__t0 }));
  ok(failed.detail === null && failed.err !== null, `the engine dropped the failing collector and kept the reason (${failed.err})`);
  ok(failed.advanced > 30, `the simulation went on (${Math.round(failed.advanced)} s)`);
  ok((await page.locator('.stats-dock [data-role=stopped]').innerText()).includes('Statistics stopped'), 'the dock says "Statistics stopped" with the reason');
  await page.locator('.stats-dock [data-role=count-again]').click();
  await settle(page);
  ok(await page.evaluate(() => Boolean(window.__logiplan.runner.detail()) && window.__logiplan.runner.sim.detailError === null), 'Count again: a new collector, counting from now');
  await context.close();
});

define('gesture', 'S1.7 on the finished app: a drag never opens the dock or moves the camera, a click opens it after pointerup, empty ground moves nothing', async () => {
  const { page, context } = await session();
  await measured(page, 'two-lines', 2400);
  const stations = await page.evaluate(() => window.__logiplan.store.getState().layout.stations.map((st) => ({ id: st.id, type: st.type, x: st.x, y: st.y })));
  const target = stations.find((st) => st.type === 'storage') || stations[0];
  const at = await stationPoint(page, target.id);
  const cellPx = await page.evaluate(() => window.__logiplan.store.getState().layout.grid.cellSize * window.__logiplan.ctx.camera.zoom);
  // (a) press and drag an unselected station by 5 cells
  const before = await view(page);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await frames(page, 2);
  eq((await selection(page)).ids, [target.id], 'the press selects the unselected station');
  ok((await dock(page)).hidden, 'but the dock does not open on pointerdown');
  await page.mouse.move(at.x + cellPx * 2.5, at.y, { steps: 4 });
  await page.mouse.move(at.x + cellPx * 5, at.y, { steps: 4 });
  await page.mouse.up();
  await settle(page);
  eq(await page.evaluate((id) => { const st = window.__logiplan.store.getState().layout.stations.find((q) => q.id === id); return [st.x, st.y]; }, target.id), [target.x + 5, target.y], '(a) the station moved exactly 5 cells');
  eq(await view(page), before, '(a) the canvas box and the camera (x, y, zoom) are identical before and after');
  ok((await dock(page)).hidden, '(a) a drag never opens the dock');
  await page.evaluate(() => window.__logiplan.store.undo());
  await page.evaluate(() => window.__logiplan.store.clearSelection());
  await settle(page);
  // (b) a click on a vehicle opens the dock after pointerup
  const v = await vehicleAt(page, "v.visible && v.state !== 'parked'");
  const b0 = await view(page);
  await page.mouse.move(v.x, v.y);
  await page.mouse.down();
  await frames(page, 3);
  ok((await dock(page)).hidden, '(b) the dock is closed while the button is down');
  await page.mouse.up();
  await frames(page, 4);
  ok(!(await dock(page)).hidden, '(b) and open after pointerup');
  const b1 = await view(page);
  eq(b1.canvas, b0.canvas, '(b) the canvas size is unchanged');
  eq(b1.camera.zoom, b0.camera.zoom, '(b) the zoom is identical');
  // (c) clicking empty ground to deselect moves nothing
  await settle(page);
  const stable = await view(page);
  const bare = await findPoint(page, "hit.kind === 'cell' && !window.__logiplan.store.getState().layout.roads[hit.cell[0] + ',' + hit.cell[1]]");
  ok(bare !== null, 'bare ground exists');
  await page.mouse.click(bare.x, bare.y);
  await settle(page);
  eq(await selection(page), { kind: null, ids: [] }, '(c) the click on empty ground deselects');
  eq(await view(page), stable, '(c) and moves nothing: the canvas and the camera are the same');
  ok((await dock(page)).hidden, '(c) and the dock closes');
  // a click with the pointer pressed on a vehicle and released far away is a drag, not a click
  await page.mouse.move(v.x, v.y);
  await page.mouse.down();
  await page.mouse.move(v.x + 60, v.y + 40, { steps: 5 });
  await page.mouse.up();
  await settle(page);
  ok((await dock(page)).hidden, 'a press on a vehicle that travels beyond the drag threshold is a marquee, it does not open the dock');
  await context.close();
});

define('keyboard', 'keyboard only: Fleet tab, Enter, Tab to a trip row, the path is drawn, Enter pins, Esc unpins, Esc closes; [ ] cycle; I toggles', async () => {
  const { page, context } = await session();
  await measured(page, 'two-lines', 2400);
  await page.evaluate(() => window.__logiplan.store.setUi({ rightTab: 'fleet' }));
  await frames(page, 3);
  const rows = page.locator('[data-panel=fleet] [data-role=vehicles] button[data-vehicle]');
  ok((await rows.count()) >= 3, 'the Fleet tab lists the vehicles as buttons');
  const ids = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-vehicle')));
  await rows.first().focus();
  await page.keyboard.press('Enter');
  await settle(page);
  eq(await selection(page), { kind: 'vehicle', ids: [ids[0]] }, 'Enter on a vehicle button selects that vehicle');
  ok(!(await dock(page)).hidden, 'and opens the dock');
  ok(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('stats-dock')), 'the keyboard focus is in the dock');
  // Tab to the details button, Enter, then Tab on to a trip row
  const focusOrder = [];
  for (let k = 0; k < 30; k++) {
    await page.keyboard.press('Tab');
    const el = await page.evaluate(() => { const a = document.activeElement; return a ? { cls: a.className && String(a.className), label: a.getAttribute('aria-label') || a.textContent.trim().slice(0, 30), inDock: Boolean(a.closest('.stats-dock')), trip: a.classList && a.classList.contains('trip') } : null; });
    focusOrder.push(el);
    if (el && /insight__details/.test(el.cls || '')) { await page.keyboard.press('Enter'); await settle(page); break; }
    if (el && !el.inDock) break;
  }
  eq((await dock(page)).state, 'open', 'Tab reaches the details button and Enter opens the details');
  let onRow = null;
  for (let k = 0; k < 40 && !onRow; k++) {
    await page.keyboard.press('Tab');
    const el = await page.evaluate(() => { const a = document.activeElement; return a && a.classList.contains('trip') ? { focus: a.getAttribute('data-focus'), label: a.getAttribute('aria-label') } : (a && !a.closest('.stats-dock') ? 'outside' : null); });
    if (el === 'outside') break;
    if (el) onRow = el;
  }
  ok(onRow !== null, 'Tab reaches a trip row inside the dock');
  ok(/^\d: /.test(onRow.label) && /trips?/.test(onRow.label), `the row is a button with the whole sentence (${onRow.label})`);
  await settle(page);
  eq(await page.evaluate(() => window.__logiplan.ctx.renderer.view.stats.focus), { id: onRow.focus, pinned: false }, 'the focus on a row draws its path on the plan');
  await page.keyboard.press('Enter');
  await settle(page);
  eq(await page.evaluate(() => window.__logiplan.ctx.renderer.view.stats.focus), { id: onRow.focus, pinned: true }, 'Enter pins it');
  await page.keyboard.press('Escape');
  await settle(page);
  eq([(await selection(page)).kind, (await dock(page)).hidden, await page.evaluate(() => window.__logiplan.ctx.renderer.view.stats.focus)], ['vehicle', false, null], 'the first Esc unpins and keeps the selection and the dock');
  await page.keyboard.press('Escape');
  await settle(page);
  eq([(await selection(page)).kind, (await dock(page)).hidden], [null, true], 'the second Esc clears the selection and closes the dock');
  // [ and ] cycle the vehicles of the plant, I shows and hides the dock
  await page.evaluate((id) => window.__logiplan.store.select('vehicle', [id]), ids[0]);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('i');
  await settle(page);
  ok(!(await dock(page)).hidden, 'I shows the statistics of the selected item');
  await page.keyboard.press(']');
  await settle(page);
  eq((await selection(page)).ids, [ids[1]], ']: the next vehicle');
  ok(!(await dock(page)).hidden, 'the dock follows');
  await page.keyboard.press('[');
  await settle(page);
  eq((await selection(page)).ids, [ids[0]], '[: the one before');
  await page.keyboard.press('i');
  await settle(page);
  ok((await dock(page)).hidden, 'I hides the dock again');
  eq((await selection(page)).ids, [ids[0]], 'and keeps the selection');
  await context.close();
});

define('phone', '390 x 844 with touch: tap a vehicle, the sheet peeks, the grip opens it to half and full, the plan stays tappable', async () => {
  const { page, context } = await session({ viewport: { width: 390, height: 844 }, touch: true });
  await measured(page, 'two-lines', 2400);
  const v = await vehicleAt(page, "v.visible && v.state !== 'parked' && v.trips >= 2");
  ok(v !== null, 'a moving vehicle with trips');
  await page.touchscreen.tap(v.x, v.y);
  await settle(page);
  eq((await selection(page)).kind, 'vehicle', `a tap on a vehicle selects it (${JSON.stringify(await selection(page))})`);
  let d = await dock(page);
  ok(!d.hidden && d.snap === 'peek', `the sheet opens at peek (${d.snap}, ${Math.round(d.height)} px)`);
  ok(d.height <= 844 * 0.34, `the peek leaves most of the plan free (${Math.round(d.height)} px of 844)`);
  ok(d.width >= 380, `the sheet is as wide as the screen (${Math.round(d.width)})`);
  const peek = await tiles(page);
  ok(peek.slice(0, 3).every((x) => x.visible && x.value !== ''), 'the peek shows the three headline numbers');
  await plainNumbers(page, 'phone peek');
  eq(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal page scroll');
  // the grip: tap for the next snap point
  const grip = page.locator('.stats-dock .insight__grip');
  await grip.tap();
  await settle(page);
  d = await dock(page);
  eq(d.snap, 'half', 'a tap on the grip opens the sheet to half');
  ok(d.height > 844 * 0.35 && d.height < 844 * 0.7, `half is about half of the stage (${Math.round(d.height)} px)`);
  const half = await tiles(page);
  ok(half.every((x) => x.visible), 'at half all six numbers are visible');
  await checkNumbers(page, v.id, 'start', 'phone half');
  const small = await page.evaluate(() => [...document.querySelectorAll('.stats-dock button, .stats-dock [role=button], .stats-dock .switch')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).map((e) => ({ what: (e.getAttribute('aria-label') || e.textContent || e.className).trim().slice(0, 40), h: Math.round(e.getBoundingClientRect().height) })).filter((e) => e.h < 40));
  eq(small, [], 'every control of the sheet is at least 40 px high on the coarse pointer');
  await grip.tap();
  await settle(page);
  d = await dock(page);
  eq(d.snap, 'full', 'another tap: full');
  ok(d.height > 844 * 0.6, `full is most of the stage (${Math.round(d.height)} px)`);
  await grip.tap();
  await settle(page);
  eq((await dock(page)).snap, 'peek', 'and a third tap goes round to peek again');
  // the plan stays tappable: a tap on another vehicle changes the selection, the sheet stays
  const w = await vehicleAt(page, "v.visible && v.state !== 'parked'", [v.id]);
  if (w && w.inView) {
    await page.touchscreen.tap(w.x, w.y);
    await settle(page);
    ok(!(await dock(page)).hidden, 'a tap on the plan does not close the sheet');
    ok((await selection(page)).kind === 'vehicle', `and selects what was tapped (${JSON.stringify(await selection(page))})`);
  }
  await context.close();
});

/**
 * The contrast of the text of the dock in the current theme (WCAG: 4.5 for normal text, 3 for large). Every visible text node of the dock is looked at against the first opaque
 * background behind it; a text without a visible box is skipped. Returns the worst few.
 */
const contrastOfDock = (page) => page.evaluate(() => {
  const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const mixOn = (fg, bg) => ({ r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 });
  const backdrop = (el) => {
    const stack = [];
    for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    if (!stack.length || stack[stack.length - 1].a < 1) base = parse(getComputedStyle(document.body).backgroundColor) || base;
    for (let k = stack.length - 1; k >= 0; k--) base = stack[k].a >= 1 ? stack[k] : mixOn(stack[k], base);
    return base;
  };
  const out = [];
  const walker = document.createTreeWalker(document.querySelector('.stats-dock'), NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent.trim();
    if (!text) continue;
    const el = n.parentElement;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || el.closest('[hidden]') || el.closest('.sr-only')) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = backdrop(el);
    const f = fg.a < 1 ? mixOn(fg, bg) : fg;
    const [l1, l2] = [lum(f), lum(bg)].sort((a, b) => b - a);
    const ratio = (l1 + 0.05) / (l2 + 0.05);
    const size = parseFloat(cs.fontSize); const bold = Number(cs.fontWeight) >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    out.push({ text: text.slice(0, 40), ratio: Math.round(ratio * 100) / 100, need: large ? 3 : 4.5, size });
  }
  return { count: out.length, worst: out.sort((a, b) => a.ratio / a.need - b.ratio / b.need).slice(0, 6) };
});

for (const scheme of ['light', 'dark']) {
  define(`theme-${scheme}`, `${scheme} theme: the dock reads, the routes have the colours of the theme`, async () => {
    const { page, context } = await session({ colorScheme: scheme });
    await measured(page, 'congestion-lab', 2400);
    const v = await clickBusiestVehicle(page, { open: false });
    await page.evaluate(() => window.__logiplan.ctx.actions.fitView());
    await settle(page);
    eq(await page.evaluate(() => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')), scheme, `the app is in the ${scheme} theme`);
    const usual = await pathCells(page, v.id, 'start', 'visible');
    const probe = await routeProbe(page, usual, scheme, v.id);
    console.log(`   ${scheme}: route pixels ${probe.painted} of ${probe.visibleCells} cells, ${Math.round(probe.routeColourShare * 100)} % with the colours of the ${scheme} ramp, ${probe.bareTouched} of ${probe.bareCells} bare windows changed`);
    ok(probe.visibleCells >= 4 && probe.paintedShare >= 0.7, `${scheme}: the route is on the plan (${probe.painted} of ${probe.visibleCells} cells)`);
    ok(probe.routeColourShare >= 0.3, `${scheme}: and has the colours of the ${scheme} ramp (${Math.round(probe.routeColourShare * 100)} %)`);
    ok(probe.bareTouched <= Math.ceil(probe.bareCells * 0.1), `${scheme}: bare ground is not touched (${probe.bareTouched} of ${probe.bareCells})`);
    const tokens = await page.evaluate(() => { const cs = getComputedStyle(document.documentElement); return ['--route-calm', '--route-some', '--route-much'].map((k) => cs.getPropertyValue(k).trim().toLowerCase()); });
    const { ROUTE_COLORS } = { ROUTE_COLORS: { light: ['#2f6fdd', '#e39a0b', '#d23a45'], dark: ['#62a0ff', '#ffb92e', '#ff6b73'] } };
    eq(tokens, ROUTE_COLORS[scheme], `${scheme}: the route tokens of the stylesheet are the colours the canvas layer uses`);
    const compact = await contrastOfDock(page);
    const bad = compact.worst.filter((w) => w.ratio < w.need);
    eq(bad, [], `${scheme}: the text of the compact dock has the contrast it needs (${compact.count} texts; worst ${JSON.stringify(compact.worst[0])})`);
    await page.locator('.stats-dock .insight__details').click();
    await settle(page);
    const open = await contrastOfDock(page);
    const badOpen = open.worst.filter((w) => w.ratio < w.need);
    eq(badOpen, [], `${scheme}: and of the open dock (${open.count} texts; worst ${JSON.stringify(open.worst[0])})`);
    console.log(`   ${scheme}: lowest text contrast ${compact.worst[0].ratio} (${JSON.stringify(compact.worst[0].text)}) compact, ${open.worst[0].ratio} (${JSON.stringify(open.worst[0].text)}) open`);
    await context.close();
  });
}

define('frame', 'the exclusive frame-time probe: the route layer on the 100-vehicle plant at 600x costs at most 0.5 ms a frame (S1.11)', async () => {
  const { page, context } = await session();
  // the largest plant the app allows (tests/helpers/big-plant.js): 320 x 320 cells, 225 stations, 100 vehicles
  const plant = await page.evaluate(async () => {
    const { bigPlant320 } = await import('/tests/helpers/big-plant.js');
    const built = bigPlant320({ vehicles: 100 });
    window.__logiplan.store.newProject(built.layout, 'Big plant 320');
    window.__logiplan.ctx.actions.fitView();
    return { stations: built.stations, roadCells: built.roadCells, vehicles: built.layout.fleets.reduce((a, f) => a + f.count, 0) };
  });
  await frames(page, 3);
  console.log(`   plant: ${plant.stations} stations, ${plant.roadCells} road cells, ${plant.vehicles} vehicles`);
  eq(plant.vehicles, 100, 'the plant has 100 vehicles');
  await page.evaluate(async () => { const r = window.__logiplan.runner; r.setSpeed(600); await r.play(); });
  // a vehicle that has driven a lot, once the collector has legs to show
  await page.waitForFunction(() => { const d = window.__logiplan.runner.detail(); return d && d.legs.count >= 1500; }, null, { timeout: 300000, polling: 500 }); // about 1.5 simulated hours: the vehicles have several pairs, empty drives and trips to the depots
  const pick = await page.evaluate(() => {
    const { runner } = window.__logiplan;
    const d = runner.detail();
    const w = d.windowOf('start');
    let best = null;
    for (let i = 0; i < d.V.length; i++) { // the vehicle with the most routes to draw: loaded, empty and to a depot, every drawn way
      const rows = d.routesOf(i, w, [1, 0, 2, 3]).filter((r) => r.drawn > 0);
      const loaded = rows.filter((r) => r.kind === 1);
      const drawn = rows.reduce((a, r) => a + Math.max(1, r.pathIds.length), 0);
      const trips = loaded.reduce((a, r) => a + r.trips, 0);
      if (!best || drawn > best.drawn) best = { id: runner.sim.vehicles[i].id, trips, pairs: loaded.length, drawn };
    }
    return { ...best, legs: d.legs.count, time: runner.time, limited: runner.limited };
  });
  console.log(`   after ${Math.round(pick.time)} s: ${pick.legs} legs in the log; ${pick.id} has ${pick.trips} loaded trips on ${pick.pairs} pairs and ${pick.drawn} ways to draw; the runner is ${pick.limited ? '' : 'not '}limited by the CPU`);
  ok(pick.trips >= 2, 'a vehicle with loaded routes to draw');
  await page.evaluate((id) => { window.__logiplan.store.select('vehicle', [id]); window.__logiplan.ctx.actions.showStatistics(); window.__logiplan.ctx.actions.fitView(); }, pick.id);
  await settle(page);
  ok(await page.evaluate(() => Boolean(window.__logiplan.ctx.renderer.view.stats && window.__logiplan.ctx.renderer.view.stats.open)), 'the dock is open, so the route layer is drawn');
  // time every call of renderer.render while the plant runs at 600x
  await page.evaluate(() => {
    const r = window.__logiplan.ctx.renderer;
    window.__frames = [];
    const original = r.render.bind(r);
    r.render = (alpha) => { const t0 = performance.now(); const out = original(alpha); window.__frames.push(performance.now() - t0); return out; };
  });
  const setLayers = (routes, jobs) => page.evaluate(([a, b]) => window.__logiplan.store.setUi({ overlays: { routes: a, jobs: b } }), [routes, jobs]);
  const block = async (routes, jobs, n) => {
    await setLayers(routes, jobs);
    await frames(page, 4);
    await page.evaluate(() => { window.__frames.length = 0; });
    await page.waitForFunction((count) => window.__frames.length >= count, n, { timeout: 120000, polling: 100 });
    return page.evaluate((count) => window.__frames.slice(0, count), n);
  };
  const median = (xs) => { const a = [...xs].sort((x, y) => x - y); return a[a.length >> 1]; };
  const pct = (xs, q) => { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(a.length * q))]; };
  const N = 80;
  const results = {};
  for (const [name, jobs] of [['default view (the job lines on)', true], ['the job lines off in both (the layer alone)', false]]) {
    const on = []; const off = [];
    for (let round = 0; round < 4; round++) { // interleaved, so that a drift of the machine hits both alike
      off.push(...await block(false, jobs, N));
      on.push(...await block(true, jobs, N));
    }
    const d = median(on) - median(off);
    results[name] = { medianOn: median(on), medianOff: median(off), p95On: pct(on, 0.95), p95Off: pct(off, 0.95), meanOn: on.reduce((a, x) => a + x, 0) / on.length, meanOff: off.reduce((a, x) => a + x, 0) / off.length, diff: d, frames: on.length };
    console.log(`   ${name}: render() median ${median(off).toFixed(2)} ms without, ${median(on).toFixed(2)} ms with the routes (${d >= 0 ? '+' : ''}${d.toFixed(2)} ms); p95 ${pct(off, 0.95).toFixed(2)} -> ${pct(on, 0.95).toFixed(2)}; mean ${results[name].meanOff.toFixed(2)} -> ${results[name].meanOn.toFixed(2)} (${on.length} frames each)`);
  }
  measurements.frameProbe = results;
  const def = results['default view (the job lines on)'];
  const alone = results['the job lines off in both (the layer alone)'];
  ok(def.diff <= 0.5, `the route layer costs at most 0.5 ms a frame in the default view (${def.diff.toFixed(2)} ms at the median)`);
  ok(alone.diff <= 0.5, `and at most 0.5 ms a frame on its own (${alone.diff.toFixed(2)} ms at the median)`);
  await context.close();
});

/** How many pixels around the selected vehicle change over 0.8 s while nothing moves: the pulse of its ring (0 with reduced motion). */
async function ringPulse(page, id) {
  for (let k = 0; k < 8; k++) {
    await grab(page, `m${k}`);
    await page.waitForTimeout(100);
  }
  return page.evaluate((vid) => {
    const { ctx, runner } = window.__logiplan;
    const cv = ctx.canvas; const k = cv.width / cv.clientWidth;
    const v = runner.sim.vehicles.find((q) => q.id === vid);
    const [px, py] = ctx.camera.worldToScreen(v.x, v.y);
    const radius = Math.round(window.__logiplan.store.getState().layout.grid.cellSize * ctx.camera.zoom * 2.5 * k);
    let most = 0;
    for (let m = 1; m < 8; m++) {
      let n = 0;
      for (let y = Math.round(py * k) - radius; y <= Math.round(py * k) + radius; y++) for (let x = Math.round(px * k) - radius; x <= Math.round(px * k) + radius; x++) {
        const o = (y * cv.width + x) * 4; const a = window.__grabs.m0; const b = window.__grabs[`m${m}`];
        if (Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) + Math.abs(a.data[o + 2] - b.data[o + 2]) > 10) n++;
      }
      most = Math.max(most, n);
    }
    return most;
  }, id);
}

define('a11y', 'accessibility of the finished dock: the region, one polite announcement, no aria-live in the dock, images with sentences, names on every control, reduced motion', async () => {
  const { page, context } = await session();
  await measured(page, 'two-lines', 2400);
  const v = await clickBusiestVehicle(page);
  const d = await dock(page);
  eq(d.label, `Statistics for ${v.name}`, 'the region is labelled with the item');
  eq(await page.evaluate(() => document.querySelector('.stats-dock').getAttribute('role')), 'region', 'and is a region');
  eq(await page.locator('.stats-dock [aria-live]').count(), 0, 'nothing inside the dock is aria-live (it would speak ten times a second at 600x)');
  eq(await page.evaluate(() => document.querySelector('.stats-dock').hasAttribute('aria-live')), false, 'nor the dock itself');
  const status = await page.evaluate(() => { const el = document.querySelector('[data-role="stats-announce"]'); return { live: el.getAttribute('aria-live'), role: el.getAttribute('role'), text: el.textContent, inside: Boolean(el.closest('.stats-dock')) }; });
  eq([status.live, status.role, status.inside], ['polite', 'status', false], 'one polite status NEXT TO the dock');
  ok(status.text.includes(v.name) && /selected/.test(status.text), `it announced the selection (${status.text})`);
  const imgs = await page.evaluate(() => [...document.querySelectorAll('.stats-dock [role=img]:not(.tile__ref *)')].map((e) => ({ label: e.getAttribute('aria-label') || '', cls: String(e.getAttribute('class')) })));
  ok(imgs.some((i) => /^Time split: .*Driving/.test(i.label)), 'the stacked bar says its parts in a sentence');
  ok(imgs.some((i) => /^Busy share of each 30 seconds/.test(i.label)), 'the sparkline says what it shows');
  ok(imgs.every((i) => i.label.length > 12), `every image has a sentence (${imgs.length}): ${JSON.stringify(imgs.filter((i) => i.label.length <= 12))}`);
  eq(await page.evaluate(() => [...document.querySelectorAll('.tile__ref [role=img]')].every((e) => ['above', 'below'].includes(e.getAttribute('aria-label')))), true, 'the arrows next to a peer value say above or below');
  const unnamed = await page.evaluate(() => [...document.querySelectorAll('.stats-dock button')].filter((b) => b.getBoundingClientRect().width > 0 && !(b.getAttribute('aria-label') || b.textContent).trim()).map((b) => b.className));
  eq(unnamed, [], 'every visible button of the dock has a name');
  eq(await page.evaluate(() => document.querySelector('.insight__strip').tagName), 'DL', 'the numbers are a description list');
  eq(await page.evaluate(() => document.querySelectorAll('.stats-dock header, .stats-dock [role=banner]').length), 0, 'the dock adds no header landmark (the page has exactly one)');
  const pressed = await page.evaluate(() => [...document.querySelectorAll('.stats-dock [data-window]')].map((b) => [b.dataset.window, b.getAttribute('aria-pressed')]));
  eq(pressed, [['start', 'true'], ['last30', 'false']], 'the window switch is a button group with aria-pressed');
  const live = await ringPulse(page, v.id);
  ok(live > 20, `with motion the ring of the selected vehicle pulses (${live} pixels change in 0.8 s)`);
  await context.close();

  const calm = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page2 = await calm.newPage();
  page2.setDefaultTimeout(90000);
  page2.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${section}] [console.${m.type()}] ${m.text()}`); });
  await page2.goto(`${origin}/index.html`);
  await page2.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
  if (await page2.locator('[role=dialog]').count()) { await page2.keyboard.press('Escape'); await page2.locator('[role=dialog]').waitFor({ state: 'detached' }); }
  await measured(page2, 'two-lines', 2400);
  const v2 = await clickBusiestVehicle(page2);
  const still = await ringPulse(page2, v2.id);
  eq(still, 0, 'with reduced motion the ring does not pulse: no pixel changes while nothing moves');
  await calm.close();
});

define('paused', 'pause a running simulation with the dock open: what stays on screen is the last second, not an older one (S1.9)', async () => {
  const { page, context } = await session();
  await page.evaluate(async () => { await window.__logiplan.ctx.actions.loadExample('two-lines'); });
  await frames(page, 3);
  await page.evaluate(async () => { const r = window.__logiplan.runner; r.setSpeed(600); await r.play(); });
  await page.waitForFunction(() => { const w = window.__logiplan.runner.kpis()?.window; return Boolean(w) && w.warmingUp !== true && w.duration >= 900; }, null, { timeout: 120000 });
  const id = await page.evaluate(() => window.__logiplan.runner.sim.vehicles[1].id);
  await page.evaluate((vid) => { window.__logiplan.store.select('vehicle', [vid]); window.__logiplan.ctx.actions.showStatistics(); }, id);
  await page.waitForTimeout(600);
  await page.evaluate(() => { // what report did the dock's last refresh read, and what time was it then?
    const r = window.__logiplan.runner;
    const original = r.kpis.bind(r);
    window.__lastRead = null;
    r.kpis = (...args) => { const out = original(...args); window.__lastRead = { reportEnd: out && out.window ? out.window.end : null, simTime: r.sim ? r.sim.time : null }; return out; };
  });
  for (let round = 0; round < 4; round++) {
    await page.waitForTimeout(700 + round * 230); // a different place in the one-second rhythm of the fleet figures each time
    await page.evaluate(() => window.__logiplan.runner.pause());
    await settle(page);
    await checkNumbers(page, id, 'start', `paused (round ${round + 1})`);
    const read = await page.evaluate(() => ({ ...window.__lastRead, now: window.__logiplan.runner.sim.time }));
    near(read.reportEnd, read.now, 0.15, `paused (round ${round + 1}): the report the dock last read ends where the simulation stopped`);
    await page.evaluate(async () => { await window.__logiplan.runner.play(); });
  }
  await page.evaluate(() => window.__logiplan.runner.pause());
  await context.close();
});

define('early', 'before the first measured second and under 20 minutes: the placeholder, "Press play", "indicative", Last 30 min equal to Since start and saying so (S1.9, S1.10, S1.13)', async () => {
  const { page, context } = await session();
  await page.evaluate(async () => { await window.__logiplan.ctx.actions.loadExample('two-lines'); });
  await frames(page, 4);
  ok(await page.evaluate(() => window.__logiplan.runner.sim === null), 'nothing has run yet');
  // a click on a station: one line in the status bar, no dock (the figures of an empty report would be zeros)
  const st = await page.evaluate(() => window.__logiplan.store.getState().layout.stations[1].id);
  const at = await stationPoint(page, st);
  await page.mouse.click(at.x, at.y);
  await settle(page);
  ok(/^Press play to see statistics for /.test(await status(page)), `a click before the first run says "Press play" (${await status(page)})`);
  ok((await dock(page)).hidden, 'and opens no dock');
  // the explicit request, from the Fleet tab: the dock opens with the placeholder, the numbers are dashes, nothing is NaN
  await page.evaluate(() => window.__logiplan.store.setUi({ rightTab: 'fleet' }));
  await frames(page, 3);
  const btn = page.locator('[data-panel=fleet] [data-role=vehicles] button[data-vehicle]').first();
  await btn.focus();
  await page.keyboard.press('Enter');
  await settle(page);
  ok(!(await dock(page)).hidden, 'a vehicle button of the Fleet tab opens the dock even before the first run');
  const t0 = await tiles(page);
  eq(t0.length, 6, 'six numbers, as dashes');
  ok(t0.every((x) => x.value === '–'), `the placeholder shows a dash for each (${t0.map((x) => x.value).join(' ')})`);
  ok(/Press play\s+to see the numbers/.test(await dockText(page)), 'and the header says what to do, in the compact state too (the blocks are closed there)');
  await plainNumbers(page, 'placeholder');
  // under 20 minutes
  await page.evaluate(async () => { const r = window.__logiplan.runner; r.setSpeed(600); await r.play(); });
  await page.waitForFunction(() => { const w = window.__logiplan.runner.kpis()?.window; return Boolean(w) && w.warmingUp !== true && w.duration >= 600; }, null, { timeout: 120000 });
  await page.evaluate(() => window.__logiplan.runner.pause());
  await settle(page);
  const id = await page.evaluate(() => window.__logiplan.store.getState().ui.selection.ids[0]);
  await page.locator('.stats-dock .insight__details').click();
  await settle(page);
  const short = await checkNumbers(page, id, 'start', 'ten minutes, since start');
  ok(/[\d.]+ min measured, indicative/.test(short.text), 'under 20 minutes the dock says "indicative"');
  ok(/\(indicative\)/.test(short.text) || !/Fleet: /.test(short.text), 'and the facts are marked indicative (the fleet question is withheld)');
  await page.getByRole('button', { name: 'Last 30 min', exact: true }).click();
  await settle(page);
  const same = await checkNumbers(page, id, 'last30', 'ten minutes, last 30 min');
  ok(/Under 30 minutes have been measured, so the last 30 minutes are the same as Since start/.test(same.text), 'under 30 minutes the dock says that Last 30 min is the same as Since start');
  eq((await tiles(page)).map((x) => x.value), (await (async () => { await page.getByRole('button', { name: 'Since start', exact: true }).click(); await settle(page); return tiles(page); })()).map((x) => x.value), 'and shows the same numbers');
  await context.close();
});

for (const scheme of ['light', 'dark']) {
  define(`shots-${scheme}`, `screenshots, ${scheme}: e2e-output/entity-*-${scheme}*.png (vehicle compact, open, Last 30 min, a route hovered, docks, other strips; 1440 x 900 and 390 x 844)`, async () => {
    // ---- desktop 1440 x 900 ----
    {
      const { page, context } = await session({ colorScheme: scheme });
      await measured(page, 'congestion-lab', 2400);
      const v = await clickBusiestVehicle(page, { open: false });
      await page.screenshot({ path: shotPath(`vehicle-compact-${scheme}`) });
      await page.locator('.stats-dock .insight__details').click();
      await settle(page);
      await page.screenshot({ path: shotPath(`vehicle-open-${scheme}`) });
      await page.locator('.stats-dock .trip').nth(1).hover();
      await settle(page);
      await page.screenshot({ path: shotPath(`vehicle-route-hover-${scheme}`) });
      await page.mouse.move(700, 120);
      await page.getByRole('button', { name: 'Last 30 min', exact: true }).click();
      await settle(page);
      await page.screenshot({ path: shotPath(`vehicle-last30-${scheme}`) });
      void v;
      await context.close();
    }
    {
      const { page, context } = await session({ colorScheme: scheme });
      await measured(page, 'dock-lab', 2000);
      await clickBusiestVehicle(page);
      await page.evaluate(() => window.__logiplan.ctx.actions.fitView());
      await settle(page);
      await page.screenshot({ path: shotPath(`vehicle-docks-${scheme}`) });
      await context.close();
    }
    {
      const { page, context } = await session({ colorScheme: scheme });
      await measured(page, 'warehouse-first-day', 2400);
      await dockOpenFitted(page);
      const goodsIn = await page.evaluate(() => window.__logiplan.store.getState().layout.stations.find((q) => q.type === 'source').id);
      await clickKind(page, 'Goods in', await stationPoint(page, goodsIn), { kind: 'station' });
      await page.screenshot({ path: shotPath(`strip-goodsin-${scheme}`) });
      await context.close();
    }
    {
      const { page, context } = await session({ colorScheme: scheme });
      await measured(page, 'two-lines', 2400);
      await dockOpenFitted(page);
      const work = await page.evaluate(() => window.__logiplan.store.getState().layout.stations.find((q) => q.type === 'process').id);
      await clickKind(page, 'workstation', await stationPoint(page, work), { kind: 'station' });
      await page.screenshot({ path: shotPath(`strip-workstation-${scheme}`) });
      await context.close();
    }
    // ---- phone 390 x 844 ----
    {
      const { page, context } = await session({ colorScheme: scheme, viewport: { width: 390, height: 844 }, touch: true });
      await measured(page, 'congestion-lab', 2400);
      const v = await vehicleAt(page, "v.visible && v.state !== 'parked' && v.trips >= 3");
      await page.touchscreen.tap(v.x, v.y);
      await settle(page);
      await page.screenshot({ path: shotPath(`vehicle-peek-${scheme}-phone`) });
      await page.locator('.stats-dock .insight__grip').tap();
      await settle(page);
      await page.screenshot({ path: shotPath(`vehicle-half-${scheme}-phone`) });
      await page.locator('.stats-dock .insight__grip').tap();
      await settle(page);
      await page.screenshot({ path: shotPath(`vehicle-full-${scheme}-phone`) });
      await context.close();
    }
    {
      const { page, context } = await session({ colorScheme: scheme, viewport: { width: 390, height: 844 }, touch: true });
      await measured(page, 'warehouse-first-day', 2400);
      const goodsIn = await page.evaluate(() => window.__logiplan.store.getState().layout.stations.find((q) => q.type === 'source').id);
      await page.evaluate((id) => { window.__logiplan.store.select('station', [id]); window.__logiplan.ctx.actions.showStatistics(); }, goodsIn);
      await settle(page);
      await page.locator('.stats-dock .insight__grip').tap();
      await settle(page);
      await page.screenshot({ path: shotPath(`strip-goodsin-${scheme}-phone`) });
      await context.close();
    }
  });
}

define('preference', 'Simulate > Statistics on click: never, when the simulation has data, always', async () => {
  const { page, context } = await session();
  await page.evaluate(async () => { await window.__logiplan.ctx.actions.loadExample('two-lines'); });
  await frames(page, 3);
  // the Simulate tab has the two switches, with the words of the design
  await page.evaluate(() => window.__logiplan.store.setUi({ rightTab: 'simulate' }));
  await frames(page, 3);
  const panel = await page.locator('[data-panel=simulate]').innerText();
  ok(/Collect statistics for clicked items/.test(panel) && /Statistics on click/.test(panel), 'the Simulate tab has "Collect statistics for clicked items" and "Statistics on click"');
  const sel = page.locator('[data-panel=simulate] select').filter({ has: page.locator('option', { hasText: 'always' }) });
  ok((await sel.count()) >= 1, 'with the choices never, when the simulation has data, always');
  eq(await page.evaluate(() => window.__logiplan.store.getState().ui.statsDock), 'data', 'the default is "when the simulation has data"');
  // always: a click before the first run opens the dock (with dashes)
  await page.evaluate(() => window.__logiplan.store.setUi({ statsDock: 'always' }));
  const st = await page.evaluate(() => window.__logiplan.store.getState().layout.stations[1].id);
  const at = await stationPoint(page, st);
  await page.mouse.click(at.x, at.y);
  await settle(page);
  ok(!(await dock(page)).hidden, '"always": a click before the first run opens the dock');
  eq((await tiles(page)).length, 6, 'with its six numbers, as dashes');
  await page.keyboard.press('Escape');
  await settle(page);
  // never: a click on a vehicle selects it and opens nothing; I still shows it
  await page.evaluate(() => window.__logiplan.store.setUi({ statsDock: 'never' }));
  await measured(page, 'two-lines', 1200);
  const v = await vehicleAt(page, "v.visible && v.state !== 'parked'");
  await page.mouse.click(v.x, v.y);
  await settle(page);
  eq((await selection(page)).kind, 'vehicle', '"never": the click still selects the vehicle');
  ok((await dock(page)).hidden, '"never": and opens no dock');
  await page.keyboard.press('i');
  await settle(page);
  ok(!(await dock(page)).hidden, '"never": the key I shows it anyway (an explicit request)');
  await page.keyboard.press('Escape');
  // the collector switch: off, a click shows the report-only strip (checked in "edit"), the label says what it does
  await page.evaluate(() => window.__logiplan.store.setUi({ statsDock: 'data' }));
  await context.close();
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------------------------------------------------------
let failed = null;
try {
  for (const s of sections) {
    if (wanted.size && !wanted.has(s.name)) continue;
    section = s.name;
    const t0 = Date.now();
    console.log(`-- ${s.name}: ${s.what}`);
    problems.length = 0;
    await s.fn();
    eq(problems, [], `${s.name}: no console error, warning, page error or failed request`);
    console.log(`   (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  }
} catch (err) {
  failed = err;
} finally {
  writeFileSync(path.join(OUT, 'entity-stats.json'), JSON.stringify(measurements, null, 2));
  await browser.close();
  await new Promise((r) => server.close(r));
}
if (failed) {
  console.error(`\nFAILED after ${checks} checks in section "${section}": ${failed.message}`);
  if (problems.length) console.error(`console problems so far:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`\n${checks} checks passed`);
