// Independent review of "statistics on click" (step S1 of docs/ENTITY-INSIGHTS-DESIGN.md) from the PLANNER'S and the ACCESSIBILITY side, in the REAL app (index.html + js/main.js) in real Chromium.
// The reviewer played a logistics planner who has a plant and a question ("why is my forklift slow, which way does it drive, is the dock the bottleneck?") and then a hostile
// tester: every kind of item (Goods in, Goods out, workstation, storage, depot, flow, road cell, dock cell, vehicle, fleet, several at once, wall, label) stopped, running at 1x
// to 1200x, before any data exists, after a warm restart and an undo, while dragging, panning, zooming and in the middle of a drawing tool; then readability (numbers, units, words,
// the counting rules, the facts, the route overlay on a busy plan with heat and flow arrows, in light and dark), the dock states, Last 30 min, the phone sheet (peek, half, full,
// swipes), 320 px to 4K, 300 % zoom, forced colours, reduced motion, touch targets, the keyboard-only journey, the accessibility tree, focus handling, the Simulate switches and the
// preference "Statistics on click", the frame pacing at 600x on the 100-vehicle plant, and whether anything else in the app moved.
//
// Two kinds of checks (the convention of tests/e2e/doors-review.mjs and edit-feedback-review.mjs):
//   ok / eq             GUARDS: things that must hold; a failed one aborts the section with the assertion message.
//   defect(id, cond, severity, text)   a FINDING of the review: printed as OPEN while `cond` is false and as FIXED once it holds (then turn it into a guard with `fixed`).
//                       severity: high = crash, data loss, a blocked journey, a false or misleading number, or the dock fighting the editing gesture; medium = confusing, ugly or
//                       inaccessible enough that a planner would misread it or give up; low = polish. The run exits with code 1 while any finding is OPEN.
//   note(text)          an observation that cannot be asserted (a screenshot to look at, a measurement); printed, never fails.
//
// Run: node tests/e2e/entity-stats-review.mjs [section ...]
//   sections: cold kinds vehicle windows routes keyboard phone access hostile shell perf
// Screenshots: e2e-output/entity-review-*.png (open them and look). Every section asserts that the page logged no console error or warning and made no request outside the app.
// It is an opt-in review script of tests/e2e/run.mjs (`--review`), and `exclusive`: the frame-pacing section wants a quiet machine.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../../scripts/serve.mjs';
import { OUT } from './browser.mjs';

mkdirSync(OUT, { recursive: true });
const wanted = new Set(process.argv.slice(2));

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };
const findings = [];
/** A finding that has been fixed: now a guard. */
const fixed = (id, cond, text) => ok(cond, `${id}: ${text}`);
/** A finding of the review: OPEN while `cond` is false. Never aborts. */
const defect = (id, cond, severity, text) => {
  findings.push({ id, severity, open: !cond, text });
  console.log(`   ${cond ? 'FIXED' : 'OPEN '} ${id} [${severity}] ${text}`);
};
const note = (text) => console.log(`   note: ${text}`);

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const problems = [];
const foreign = [];
let section = '';

/** A new visitor. Console errors and warnings, page errors, failed requests and requests outside the app are collected and asserted empty at the end of every section. */
async function session({ viewport = DESKTOP, colorScheme = 'light', touch = false, reducedMotion = 'no-preference', forcedColors = 'none', welcome = false } = {}) {
  const context = await browser.newContext({ viewport, colorScheme, hasTouch: touch, isMobile: touch, reducedMotion, forcedColors, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(90000);
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${section}] [console.${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${section}] [pageerror] ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`[${section}] [requestfailed] ${r.url()}`));
  page.on('request', (r) => { if (!r.url().startsWith(origin) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) foreign.push(r.url()); });
  await page.goto(`${origin}/index.html`);
  await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
  if (!welcome && (await page.locator('[role=dialog]').count())) {
    await page.keyboard.press('Escape');
    await page.locator('[role=dialog]').waitFor({ state: 'detached' });
  }
  return { context, page };
}
const frames = (page, n = 3) => page.evaluate((count) => new Promise((resolve) => { const next = (left) => (left ? requestAnimationFrame(() => next(left - 1)) : resolve()); next(count); }), n);
/** Let the dock refresh (4 Hz from the runner) and the route layer rebuild (twice a second at most). */
const settle = async (page) => { await frames(page, 3); await page.waitForTimeout(700); await frames(page, 2); };
const snap = (page, name, opts = {}) => page.screenshot({ path: path.join(OUT, `entity-review-${name}.png`), ...opts });
const noErrors = (what) => {
  eq(problems.splice(0).filter((e) => !/willReadFrequently/.test(e)), [], `${what}: console errors or warnings`);
  eq(foreign.splice(0), [], `${what}: requests outside the app`);
};
const run = async (name, fn) => {
  if (wanted.size && !wanted.has(name)) return;
  const t0 = Date.now();
  section = name;
  console.log(`-- ${name}`);
  await fn();
  noErrors(name);
  console.log(`   (${Math.round((Date.now() - t0) / 100) / 10} s)`);
};

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// plumbing on the page
// ---------------------------------------------------------------------------------------------------------------------------------------------------

async function loadExample(page, id) {
  await page.evaluate(async (x) => { await window.__logiplan.ctx.actions.loadExample(x); }, id);
  await frames(page, 3);
}
/** Run an example past its warm-up and `seconds` of measured time at `speed`, then pause: everything has data to show. */
async function measured(page, example, seconds = 2400, speed = 600) {
  await loadExample(page, example);
  await page.evaluate(async (sp) => { const r = window.__logiplan.runner; r.setSpeed(sp); await r.play(); }, speed);
  await page.waitForFunction((s) => { const w = window.__logiplan.runner.kpis()?.window; return Boolean(w) && w.warmingUp !== true && w.duration >= s; }, seconds, { timeout: 300000 });
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
const status = (page) => page.locator('.statusbar__text').innerText().catch(() => '');
const dockText = async (page) => (await page.evaluate(() => document.querySelector('.stats-dock')?.innerText ?? '')).replace(/\n+/g, ' | ');
const select = (page, kind, ids) => page.evaluate(([k, i]) => window.__logiplan.store.select(k, i), [kind, ids]);
const showStatistics = (page) => page.evaluate(() => window.__logiplan.ctx.actions.showStatistics());
const setUi = (page, patch) => page.evaluate((p) => window.__logiplan.store.setUi(p), patch);
const setTab = (page, t) => page.evaluate((x) => window.__logiplan.ctx.actions.setRightTab(x), t);
const fitView = async (page) => { await page.evaluate(() => window.__logiplan.ctx.actions.fitView()); await settle(page); };
const tiles = (page) => page.evaluate(() => [...document.querySelectorAll('.stats-dock [data-tile]')].map((t) => ({
  id: t.dataset.tile, label: t.querySelector('.tile__name').textContent.trim(),
  value: t.querySelector('.tile__num').textContent.trim(), unit: t.querySelector('.tile__value small').hidden ? '' : t.querySelector('.tile__value small').textContent.trim(),
  ref: t.querySelector('.tile__ref').textContent.replace(/\s+/g, ' ').trim(), rule: (t.querySelector('button.def') || { getAttribute: () => '' }).getAttribute('aria-label'),
  visible: t.getBoundingClientRect().height > 0,
})));
const num = (s) => Number.parseFloat(String(s).replace(',', '.'));

/** Where a vehicle is on the screen; `pick` is a page-side condition on the simulation's vehicle `v`. */
const vehicleAt = (page, pick = "v.visible && v.state !== 'parked'", skip = []) => page.evaluate(([cond, skipIds]) => {
  const { ctx, runner } = window.__logiplan;
  const r = ctx.canvas.getBoundingClientRect();
  const dockEl = document.querySelector('.stats-dock');
  const free = dockEl && !dockEl.hidden ? dockEl.getBoundingClientRect().top - r.top : r.height;
  const test = new Function('v', `return ${cond}`);
  const fits = (v) => { const [px, py] = ctx.camera.worldToScreen(v.x, v.y); return px > 70 && px < r.width - 90 && py > 130 && py < free - 30; };
  const list = runner.sim.vehicles.filter((v) => !skipIds.includes(v.id) && test(v));
  const best = list.filter(fits).sort((a, b) => b.trips - a.trips)[0] || list.sort((a, b) => b.trips - a.trips)[0];
  if (!best) return null;
  const [px, py] = ctx.camera.worldToScreen(best.x, best.y);
  return { x: r.left + px, y: r.top + py, id: best.id, fleetId: best.fleetId, name: best.name, trips: best.trips, inView: fits(best), state: best.state };
}, [pick, skip]);
const stationPx = (page, id) => page.evaluate((sid) => {
  const { ctx, store } = window.__logiplan;
  const layout = store.getState().layout;
  const s = layout.stations.find((x) => x.id === sid || x.name === sid);
  if (!s) return null;
  const cs = layout.grid.cellSize;
  const r = ctx.canvas.getBoundingClientRect();
  const [x0, y0] = ctx.camera.worldToScreen(s.x * cs, s.y * cs);
  const [x1, y1] = ctx.camera.worldToScreen((s.x + s.w) * cs, (s.y + s.h) * cs);
  return { id: s.id, x: r.left + (x0 + x1) / 2, y: r.top + (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
}, id);
/** The first spot of the free part of the plan (above the dock, clear of the bars and buttons) where the renderer's hit test says `pred(hit)`. */
const findPoint = (page, predSource) => page.evaluate((src) => {
  const { ctx } = window.__logiplan;
  const pred = new Function('hit', `return ${src}`);
  const r = ctx.canvas.getBoundingClientRect();
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
/** The pixel of the plan canvas at a screen position, as [r, g, b]. */
const pixelAt = (page, x, y) => page.evaluate(([px, py]) => {
  const cv = window.__logiplan.ctx.canvas;
  const r = cv.getBoundingClientRect();
  const k = cv.width / r.width;
  const copy = document.createElement('canvas');
  copy.width = 1; copy.height = 1;
  const c = copy.getContext('2d', { willReadFrequently: true });
  c.drawImage(cv, (px - r.left) * k, (py - r.top) * k, 1, 1, 0, 0, 1, 1);
  return Array.from(c.getImageData(0, 0, 1, 1).data.slice(0, 3));
}, [x, y]);
/** After an edit the runner warms a new simulation up in the background: wait until it has been swapped in. */
const waitIdle = (page) => page.waitForFunction(() => !window.__logiplan.runner.priming, null, { timeout: 90000 });
const closeToasts = async (page) => { for (const b of await page.locator('[data-region=toasts] .toast__close').all()) await b.click({ timeout: 1500 }).catch(() => {}); await frames(page, 3); };

/** The text of the dock has no NaN, Infinity, undefined, null or [object]; every percentage in it is at most 100 (a share never exceeds 100 %); no internal word. */
async function plainText(page, what) {
  const text = await dockText(page);
  ok(!/NaN|Infinity|undefined|\bnull\b|\[object/.test(text), `${what}: no NaN, Infinity, undefined or null in the dock (${(/.{0,30}(NaN|Infinity|undefined|\bnull\b|\[object).{0,30}/.exec(text) || [''])[0]})`);
  const over = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s?%/g)].map((m) => num(m[1])).filter((v) => v > 100);
  eq(over, [], `${what}: no share above 100 %`);
  ok(!/\b(collector|nodeWait|pathId|kpis|enableDetail|float32|ring buffer)\b/i.test(text), `${what}: no internal word in the dock`);
  return text;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// cold: a planner with a plant and no data yet
// ---------------------------------------------------------------------------------------------------------------------------------------------------
await run('cold', async () => {
  const { page, context } = await session({ welcome: true });
  await page.locator('[role=dialog] [data-example="starter"]').click();
  await page.locator('[role=dialog]').waitFor({ state: 'detached' });
  await frames(page, 4);
  await snap(page, 'cold-01-starter-loaded');
  // stopped, nothing measured: a click on every kind of item
  const items = await page.evaluate(() => window.__logiplan.store.getState().layout.stations.map((s) => ({ id: s.id, type: s.type, name: s.name })));
  for (const st of items) {
    await page.evaluate(() => window.__logiplan.store.select(null, []));
    const p = await stationPx(page, st.id);
    await page.mouse.click(p.x, p.y);
    await frames(page, 4);
    eq((await selection(page)).ids, [st.id], `${st.name}: the click selects it`);
    ok((await dock(page)).hidden, `${st.name}: with nothing measured the dock stays closed (preference "when the simulation has data")`);
    ok(/Press play to see statistics/.test(await status(page)), `${st.name}: the status line tells why (${await status(page)})`);
  }
  // I always opens it, with dashes and a sentence, never a NaN
  await page.keyboard.press('i');
  await settle(page);
  const d = await dock(page);
  ok(!d.hidden, 'the key I opens the dock whatever the data');
  const text = await plainText(page, 'the dock before any data');
  ok(/Press play/.test(text), 'before data it says "Press play"');
  await snap(page, 'cold-02-I-before-data');
  await page.keyboard.press('Escape');
  await settle(page);
  ok((await dock(page)).hidden, 'Esc closes it again');

  // THE DEFAULT SPEED: play at 10x and click while it warms up (600 s of warm-up are 60 s of real time at 10x)
  await page.evaluate(() => window.__logiplan.store.select(null, []));
  await page.evaluate(async () => { const r = window.__logiplan.runner; r.setSpeed(10); await r.play(); });
  await page.waitForTimeout(2500);
  const info = await page.evaluate(() => { const r = window.__logiplan.runner; const w = r.kpis() && r.kpis().window; return { playing: r.playing, warming: Boolean(w && w.warmingUp), speed: r.speed }; });
  ok(info.playing && info.warming, `the simulation is playing at ${info.speed}x and still warming up`);
  const p = await stationPx(page, 's2');
  await page.mouse.click(p.x, p.y);
  await frames(page, 4);
  const said = await status(page);
  await snap(page, 'cold-03-click-while-warming-up');
  fixed('UX-1', !/Press play/i.test(said), `click on a station while the simulation IS playing (10x, still in its 10 min warm-up): the status line says "${said}", and nothing else happens on screen; it should say that the numbers start after the warm-up (about ${Math.round(630 / 10)} s at 10x, 10 min at 1x)`);
  ok((await dock(page)).hidden, 'while warming up the dock stays closed (nothing to show yet)');
  note(`at 10x the first click opens the dock after (600 s warm-up + 30 s) / 10 = 63 s of real time; at 1x after 10.5 minutes; the planner is told neither`);
  await context.close();
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// kinds: a click on every kind of item, with data
// ---------------------------------------------------------------------------------------------------------------------------------------------------
await run('kinds', async () => {
  const { page, context } = await session();
  await measured(page, 'two-lines', 2400);
  await select(page, 'vehicle', ['v2#1']);
  await showStatistics(page);
  await settle(page);
  await fitView(page);
  await page.keyboard.press('Escape');
  await settle(page);
  await fitView(page);
  const info = await page.evaluate(() => { const l = window.__logiplan.store.getState().layout; return { st: l.stations.map((s) => ({ id: s.id, type: s.type, name: s.name })), flows: l.flows.map((f) => f.id), fleets: l.fleets.map((f) => f.id) }; });
  const strips = {};
  let depotShot = false;
  for (const st of info.st) {
    const p = await stationPx(page, st.id);
    await page.mouse.click(p.x, p.y);
    await settle(page);
    const d = await dock(page);
    eq([(await selection(page)).ids, d.hidden], [[st.id], false], `${st.type} ${st.name}: the click selects it and opens the dock`);
    const t = await tiles(page);
    eq(t.length, 6, `${st.name}: six numbers`);
    ok(t.every((x) => x.value !== '' && x.rule && x.rule.length > 40), `${st.name}: every number has a value and a counting rule behind its (i)`);
    ok(/^Statistics for /.test(d.label), `${st.name}: the region is labelled (${d.label})`);
    await plainText(page, st.name);
    strips[`${st.type} ${st.name}`] = t.map((x) => `${x.label}: ${x.value}${x.unit}`).join(' | ');
    if (st.type === 'process') await snap(page, 'kinds-workstation');
    if (st.type === 'source') await snap(page, 'kinds-goods-in');
    if (st.type === 'depot' && !depotShot) { depotShot = true; await snap(page, 'kinds-depot'); }
    await page.keyboard.press('Escape');
    await settle(page);
  }
  console.log(`   strips: ${JSON.stringify(strips)}`);

  // a flow arrow, a road cell, the fleet, several stations, several vehicles
  const fp = await findPoint(page, `hit.kind === 'flow' && hit.id === ${JSON.stringify(info.flows[0])}`);
  ok(fp !== null, 'a flow arrow can be hit on the plan');
  await page.mouse.click(fp.x, fp.y);
  await settle(page);
  eq((await selection(page)).kind, 'flow', 'a click on an arrow selects the flow');
  eq((await tiles(page)).length, 6, 'a flow: six numbers');
  await plainText(page, 'flow');
  await snap(page, 'kinds-flow');
  await page.keyboard.press('Escape');
  await settle(page);
  const rp = await findPoint(page, "hit.kind === 'cell' && Boolean(window.__logiplan.store.getState().layout.roads[hit.cell[0] + ',' + hit.cell[1]])");
  await page.mouse.click(rp.x, rp.y);
  await settle(page);
  eq((await selection(page)).kind, 'cell', 'a click on a road cell selects it');
  eq((await tiles(page)).length, 6, 'a road cell: six numbers');
  await plainText(page, 'road cell');
  await snap(page, 'kinds-road-cell');
  await page.keyboard.press('Escape');
  await settle(page);
  // the dock cell of Goods receiving (a stub of two-way road that ends at the station): what does the strip call it, and what does Properties say?
  const dockCell = await page.evaluate(() => {
    const { runner } = window.__logiplan; const cols = runner.sim.graph.cols;
    for (const [sid, st] of Object.entries(runner.kpis().stations)) if (Array.isArray(st.docks) && st.docks.length) return { sid, col: st.docks[0].node % cols, row: Math.floor(st.docks[0].node / cols) };
    return null;
  });
  ok(dockCell !== null, 'the plant has a station with a dock cell');
  const spot = await page.evaluate(({ col, row }) => {
    const { ctx, store } = window.__logiplan; const cs = store.getState().layout.grid.cellSize; const r = ctx.canvas.getBoundingClientRect();
    const [x0, y0] = ctx.camera.worldToScreen(col * cs, row * cs); const size = cs * ctx.camera.zoom;
    for (let fy = 0.15; fy < 0.9; fy += 0.15) for (let fx = 0.15; fx < 0.9; fx += 0.15) {
      const hit = ctx.renderer.hitTest(x0 + fx * size, y0 + fy * size);
      if (hit.kind === 'cell' && hit.cell[0] === col && hit.cell[1] === row) return { x: r.left + x0 + fx * size, y: r.top + y0 + fy * size };
    }
    return null;
  }, dockCell);
  if (spot !== null) {
    await page.mouse.click(spot.x, spot.y);
    await settle(page);
    eq((await selection(page)).ids, [`${dockCell.col},${dockCell.row}`], 'a click on the dock cell selects that road cell');
    const what = (await tiles(page)).find((x) => x.id === 'what');
    await setTab(page, 'properties');
    await frames(page, 3);
    const props = await page.evaluate(() => document.querySelector('[data-panel=properties]')?.innerText || document.body.innerText);
    await snap(page, 'kinds-dock-cell');
    fixed('UX-24', !(/one-way/.test(what.ref) && /Two-way/.test(props)), `the dock cell (${dockCell.col}, ${dockCell.row}) of ${dockCell.sid}: the strip says "What it is: ${what.value}, ${what.ref}" while the Properties panel beside it says "Two-way": the strip counts the exits of the cell in the graph (a dead end has one) and calls that "one-way"; every dock stub and every end of a two-way road is mislabelled`);
    await page.keyboard.press('Escape');
    await settle(page);
  } else note('the dock cell is covered by a vehicle or a label: UX-24 was not checked');
  await select(page, 'fleet', [info.fleets[1]]);
  await showStatistics(page);
  await settle(page);
  eq((await tiles(page)).length, 6, 'a fleet: six numbers');
  await plainText(page, 'fleet');
  await snap(page, 'kinds-fleet');
  await select(page, 'station', info.st.filter((s) => s.type === 'process').map((s) => s.id));
  await showStatistics(page);
  await settle(page);
  eq((await tiles(page)).length, 6, 'several stations: six numbers');
  await plainText(page, 'several stations');
  await select(page, 'vehicle', ['v2#1', 'v2#2', 'v2#3']);
  await showStatistics(page);
  await settle(page);
  eq((await tiles(page)).length, 6, 'several vehicles: six numbers');
  await plainText(page, 'several vehicles');
  await snap(page, 'kinds-several-vehicles');

  // walls and labels have no statistics: with the dock open, selecting one closes it and the status line says why
  for (const [kind, pred] of [['wall', "hit.kind === 'obstacle'"], ['label', "hit.kind === 'label'"]]) {
    await select(page, 'station', ['s5']);
    await showStatistics(page);
    await settle(page);
    const pt = await findPoint(page, pred);
    if (!pt) { note(`no ${kind} found on the free part of the plan to click`); continue; }
    await page.mouse.click(pt.x, pt.y);
    await settle(page);
    ok((await dock(page)).hidden, `a ${kind} has no dock: clicking one with the dock open closes it`);
    ok(/no statistics/i.test(await status(page)), `a ${kind}: the status line says so (${await status(page)})`);
    await page.keyboard.press('Escape');
    await settle(page);
  }

  // the unit of a count is the same whether it is 1 or 5: "1 vehicles" (the depot strip), "1 loads" (Goods in, flows, Goods out)
  await page.evaluate(() => window.__logiplan.runner.pause());
  await select(page, 'station', ['s2']);
  await showStatistics(page);
  let oneVehicles = null;
  for (let k = 0; k < 40 && oneVehicles === null; k++) {
    await settle(page);
    const t = await tiles(page);
    const parked = t.find((x) => x.id === 'parked');
    if (parked && parked.value === '1') oneVehicles = parked;
    else await page.evaluate(async () => { await window.__logiplan.runner.step(7); });
  }
  ok(oneVehicles !== null, 'a depot with exactly one parked vehicle was found');
  defect('UX-10', oneVehicles.unit === 'vehicle', 'low', `the depot strip says "${oneVehicles.value} ${oneVehicles.unit}" (a fixed unit; the same for "1 loads" on the Goods in, flow and Goods out strips)`);

  // Last 30 min on an item that has no 30-minute figure: dimmed (aria-disabled), still focusable, and a tap or Enter shows the reason on the screen (the title alone reached no touch screen and no keyboard)
  const l30 = page.locator('[data-window=last30]');
  ok(await l30.isDisabled(), 'Last 30 min is dimmed (aria-disabled) for a station');
  const title = await l30.getAttribute('title');
  eq(await l30.getAttribute('aria-describedby'), 'stats-window-note', 'a screen reader hears the reason with the button');
  await l30.focus();
  eq(await page.evaluate(() => document.activeElement && document.activeElement.dataset.window), 'last30', 'the dimmed button can be focused with the keyboard');
  ok(!/available for vehicles|figures are since start/i.test(await dockText(page)), 'the reason is not on the screen until it is asked for (the dock does not nag on every station)');
  await page.keyboard.press('Enter');
  await frames(page, 2);
  const reachable = /available for vehicles|since start only|figures are since start/i.test(await dockText(page));
  fixed('UX-9', reachable, `the dimmed "Last 30 min" explained itself only in its title ("${title}"): a tap or Enter now shows the sentence on the screen`);
  eq(await page.evaluate(() => document.querySelector('.stats-dock [data-window=start]').getAttribute('aria-pressed')), 'true', 'and the window stays Since start');
  await context.close();
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// vehicle: the centrepiece, read as a planner
// ---------------------------------------------------------------------------------------------------------------------------------------------------
await run('vehicle', async () => {
  const { page, context } = await session();
  await measured(page, 'two-lines', 2400);
  const v = await vehicleAt(page, "v.id === 'v1#1'");
  await page.mouse.click(v.x, v.y);
  await settle(page);
  eq((await selection(page)).ids, ['v1#1'], 'a click on the forklift selects that vehicle (not its fleet)');
  await snap(page, 'vehicle-01-compact');
  const t = await tiles(page);
  eq(t.map((x) => x.id), ['trips', 'busy', 'held', 'driven', 'loaded', 'parked'], 'the six numbers of a vehicle');

  // the live line: the destination is the useful part, and it is cut off while the header has a spacer as wide as the line
  const liveProbe = () => page.evaluate(() => {
    const head = document.querySelector('.stats-dock .insight__head');
    const liveEl = head.querySelector('.insight__live');
    const inner = liveEl.querySelector(':scope > span:not(.dot)');
    const spacer = head.querySelector('.spacer');
    return { text: inner ? inner.textContent.trim() : '', truncated: Boolean(inner) && inner.scrollWidth > inner.clientWidth + 1, shownPx: inner ? Math.round(inner.clientWidth) : 0, spacerPx: Math.round(spacer.getBoundingClientRect().width) };
  });
  let live = await liveProbe();
  for (let k = 0; k < 12 && !live.truncated; k++) { // a short state ("Parked") fits: look at the vehicle a few seconds later, when it carries something somewhere
    await page.evaluate(async () => { await window.__logiplan.runner.step(5); });
    await settle(page);
    live = await liveProbe();
  }
  fixed('UX-2', !(live.truncated && live.spacerPx > 24), `the live line "${live.text}" (what the vehicle is doing and where it goes) is cut off at ${live.shownPx} px while the empty spacer beside it in the same header is ${live.spacerPx} px wide (both are flex: 1 and share the free space equally)`);

  // the reference line of the first tile: "fleet 16.6 · 34.2 loads/h" - the second number is THIS vehicle's, not the fleet's
  const truth = await page.evaluate(() => {
    const { runner } = window.__logiplan; const d = runner.detail(); const i = d.vehicleIndex('v1#1'); const w = d.windowOf('start');
    const own = d.counts(i, w).qty / (d.timeSplit(i, w).seconds / 3600);
    let q = 0; let n = 0;
    for (let k = 0; k < d.V.length; k++) { if (d.V[k].fleetId !== 'v1') continue; const tk = d.timeSplit(k, w); q += d.counts(k, w).qty / (tk.seconds / 3600); n++; }
    return { own, fleet: q / n };
  });
  const loadsH = /(\d+(?:\.\d+)?) loads\/h/.exec(t[0].ref);
  ok(loadsH !== null, `the trips tile carries a loads-per-hour figure for a fleet that carries two loads (${t[0].ref})`);
  const isOwn = Math.abs(num(loadsH[1]) - truth.own) < 0.15 && Math.abs(num(loadsH[1]) - truth.fleet) > 0.5;
  fixed('UX-6', !(isOwn && /^fleet /.test(t[0].ref)), `the first tile reads "${t[0].value}${t[0].unit} ${t[0].ref}": the "${loadsH[1]} loads/h" is THIS vehicle's (${truth.own.toFixed(1)}), the fleet's would be ${truth.fleet.toFixed(1)}, but it stands after the word "fleet" in the fleet's line`);

  // the open dock: how much of the body is on the screen
  await page.locator('.insight__details').click();
  await settle(page);
  await snap(page, 'vehicle-02-open');
  const body = await page.evaluate(() => { const b = document.querySelector('.stats-dock .insight__body'); return { client: b.clientHeight, scroll: b.scrollHeight, dock: document.querySelector('.stats-dock').getBoundingClientRect().height, vh: innerHeight }; });
  fixed('UX-7', body.client / body.scroll >= 0.6, `the open dock (${Math.round(body.dock)} px of ${body.vh}, the 44 vh cap) shows ${body.client} of ${body.scroll} px of its body (${Math.round((100 * body.client) / body.scroll)} %): "Where it is held up" and the fleet question sit below the fold, the sparkline and the second and third trip are cut in half, and the only cue that the body scrolls is a thin scrollbar (headless Chromium hides scrollbars, so the screenshot shows none) and text cut off at the edge (docs/ENTITY-INSIGHTS-DESIGN.md 12 lists it as a known defect of the mock-ups; it is still the first thing a planner meets)`);

  // the numbers add up
  const split = await page.evaluate(() => [...document.querySelectorAll('.stats-dock .insight__body ul li, .stats-dock .insight__body .legend li')].map((e) => e.textContent.trim()).filter((s) => /\d\s?%$/.test(s)).map((s) => Number.parseFloat(/(\d+)\s?%$/.exec(s)[1])));
  ok(split.length >= 9, `the time split lists its pieces (${split.length})`);
  const sum = split.slice(0, 9).reduce((a, x) => a + x, 0);
  ok(sum >= 98 && sum <= 102, `the nine pieces of "where its time goes" add up to 100 % (${sum})`);
  const held = num(t[2].value);
  const together = Number.parseFloat(/together ([\d.]+)/.exec(await dockText(page))?.[1]);
  ok(Math.abs(together - (held * 60) / 100) <= 0.3, `"where it is held up" (${together} min/h together) equals the Held up tile (${held} % = ${(held * 0.6).toFixed(1)} min/h)`);

  // contrast of every text in the dock, light and dark
  const probe = () => {
    const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = ({ r, g, b }) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
    const bgOf = (el) => { const stack = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } } let base = { r: 255, g: 255, b: 255, a: 1 }; for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base); return base; };
    const out = [];
    const walker = document.createTreeWalker(document.querySelector('.stats-dock'), NodeFilter.SHOW_TEXT);
    const seen = new Set();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent.trim(); const el = n.parentElement;
      if (!text || seen.has(el)) continue;
      seen.add(el);
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden') continue;
      const bg = bgOf(el); const fg = over(parse(cs.color), bg);
      const ratio = (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05);
      const size = parseFloat(cs.fontSize); const large = size >= 24 || (size >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
      if (ratio < (large ? 3 : 4.5)) out.push(`${text.slice(0, 30)} ${ratio.toFixed(2)}`);
    }
    return out;
  };
  eq(await page.evaluate(probe), [], 'light: every text of the open dock has AA contrast');
  await setUi(page, { theme: 'dark' });
  await settle(page);
  await snap(page, 'vehicle-03-open-dark');
  eq(await page.evaluate(probe), [], 'dark: every text of the open dock has AA contrast');
  eq(await page.evaluate(async () => { const m = await import('/js/ui/render/routes.js'); return [m.rampColor(0.02, 0.08, 'light') === m.ROUTE_COLORS.light.calm, m.rampColor(0.02, 0.08, 'dark') === m.ROUTE_COLORS.dark.calm]; }), [true, true], 'a usual trip that loses 2 % of its time to waiting ("waits 0 s") is the calm blue, not the grey-brown blend of blue and amber (CALM_SHARE)');
  await setUi(page, { theme: 'light' });
  await settle(page);

  // reading while it runs: the scroll position of the body and an opened counting rule survive the refreshes of 600x
  await page.evaluate(() => { document.querySelector('.stats-dock .insight__body').scrollTop = 120; });
  await page.locator('.stats-dock [data-tile=busy] button.def').click();
  await page.evaluate(async () => { const r = window.__logiplan.runner; r.setSpeed(600); await r.play(); });
  const kept = [];
  for (let k = 0; k < 12; k++) {
    await page.waitForTimeout(250);
    kept.push(await page.evaluate(() => ({ top: Math.round(document.querySelector('.stats-dock .insight__body').scrollTop), how: !document.querySelector('.stats-dock [data-tile=busy] .how').hidden })));
  }
  await page.evaluate(() => window.__logiplan.runner.pause());
  eq([...new Set(kept.map((x) => x.top))], [120], 'the body keeps its scroll position while the dock refreshes at 600x');
  ok(kept.every((x) => x.how), 'an opened counting rule stays open while the dock refreshes at 600x');
  await page.locator('.stats-dock [data-tile=busy] button.def').click();

  // plain language: words that belong to the engine, not to a planner
  const text = await dockText(page);
  const jargon = ['Booked on the cell that blocks', 'the insights aim', 'Workload arithmetic'].filter((s) => text.includes(s));
  defect('UX-22', jargon.length === 0, 'low', `internal wording in sentences a planner reads: ${jargon.map((s) => `"${s}"`).join(', ')} ("booked" is the sim's bookkeeping, "the insights" is the product's own tab name for something the planner sees as advice, "workload arithmetic" is a modelling term)`);
  await context.close();
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// windows: Last 30 min before 30 minutes exist
// ---------------------------------------------------------------------------------------------------------------------------------------------------
await run('windows', async () => {
  const { page, context } = await session();
  await measured(page, 'two-lines', 700);
  await select(page, 'vehicle', ['v1#1']);
  await showStatistics(page);
  await settle(page);
  const before = await tiles(page);
  const head1 = await page.locator('.stats-dock .insight__head').innerText();
  ok(/indicative/.test(head1), `under 20 minutes the dock says "indicative" (${head1.replace(/\n/g, ' ')})`);
  await page.locator('[data-window=last30]').click();
  await settle(page);
  const after = await tiles(page);
  eq(after.map((x) => x.value), before.map((x) => x.value), 'under 30 minutes measured the two windows show the same numbers');
  const compactText = await dockText(page);
  await snap(page, 'windows-01-last30-at-13-min');
  fixed('UX-8', /same as|until 30 min|under 30 min|less than 30/i.test(compactText), `at 13 minutes measured a click on "Last 30 min" changes nothing and the compact dock does not say why; the explanation ("Under 30 minutes have been measured, so the last 30 minutes are the same as Since start") is a sentence of the open dock, below the fold`);
  await context.close();

  // the first seconds of data: 45 s measured on the Starter plant, every kind of item, no NaN, no Infinity, no share above 100 %
  const early = await session();
  await measured(early.page, 'starter', 45);
  const kinds = [['vehicle', ['v1#1']], ['fleet', ['v1']], ['station', ['s1']], ['station', ['s2']], ['station', ['s3']], ['station', ['s4']], ['flow', [await early.page.evaluate(() => window.__logiplan.store.getState().layout.flows[0].id)]]];
  for (const [kind, ids] of kinds) {
    await select(early.page, kind, ids);
    await showStatistics(early.page);
    await settle(early.page);
    const text = await plainText(early.page, `${kind} ${ids[0]} after 45 s`);
    ok(/indicative|measured/.test(text), `${kind} ${ids[0]}: the dock says how long it has measured`);
    if (kind === 'vehicle') { await early.page.locator('[data-window=last30]').click(); await settle(early.page); await plainText(early.page, 'vehicle, Last 30 min after 45 s'); await early.page.locator('[data-window=start]').click(); }
  }
  await snap(early.page, 'windows-02-first-45-seconds');
  await early.context.close();
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// routes: the overlay on a busy plan
// ---------------------------------------------------------------------------------------------------------------------------------------------------
await run('routes', async () => {
  const { page, context } = await session();
  await measured(page, 'congestion-lab', 1800);
  await select(page, 'vehicle', ['v1#4']);
  await showStatistics(page);
  await settle(page);
  await page.locator('.insight__details').click();
  await settle(page);
  await snap(page, 'routes-01-congestion-lab-light');
  note('routes-01: the overlay labels ("Queue for Packing\'s dock", the vehicle chip, "n trips, usual route") are drawn over the plan\'s own text ("Crossing", "Narrow one-way aisle", the station names) and cannot be moved; the key card sits at the bottom right, above the dock, over whatever is there (on Congestion lab the Dispatch station, the end of the main trip)');
  const stats = await page.evaluate(() => window.__logiplan.ctx.renderer.view.stats);
  ok(stats && stats.open === true, 'the overlay knows the dock is open');
  // hover a trip row: the others dim; leave: back; the pin survives a refresh and is dropped with the item
  const row = page.locator('.stats-dock button.trip').first();
  await row.hover();
  await frames(page, 3);
  const hovered = await page.evaluate(() => window.__logiplan.ctx.renderer.view.stats.focus);
  ok(hovered && hovered.pinned === false, `hovering a trip row focuses its route (${JSON.stringify(hovered)})`);
  await snap(page, 'routes-02-hover-row');
  await page.mouse.move(700, 250);
  await frames(page, 3);
  eq(await page.evaluate(() => window.__logiplan.ctx.renderer.view.stats.focus), null, 'leaving the row lets go of the route');
  await row.click();
  await page.mouse.move(700, 250);
  await settle(page);
  eq(await row.getAttribute('aria-pressed'), 'true', 'a click pins the route (aria-pressed)');
  await snap(page, 'routes-03-pinned');
  await select(page, 'vehicle', ['v1#5']);
  await settle(page);
  eq(await page.evaluate(() => window.__logiplan.ctx.renderer.view.stats.focus), null, 'a pinned route is dropped when another vehicle is selected (nothing stays dimmed for ever)');

  // heat map and flow arrows together with the routes: still readable?
  await page.locator('[data-heat=waiting]').click();
  await settle(page);
  await snap(page, 'routes-04-with-waiting-heat');
  note('routes-04: the Waiting heat map and the routes on Congestion lab; the routes keep their halo, the heat colours sit under them (look at the screenshot)');
  await page.locator('[data-heat=off]').click();
  // dark, with the key
  await setUi(page, { theme: 'dark' });
  await settle(page);
  await snap(page, 'routes-05-congestion-lab-dark');
  // the colours of the theme: a route cell is the dark ramp's blue/amber/red, not the light one
  await setUi(page, { theme: 'light' });
  await settle(page);

  // the long dashed drive to the depot is drawn with the same alarm colour and the same weight as the trips a planner asked about
  await select(page, 'vehicle', ['v1#1']);
  await settle(page);
  note('routes: "empty or to depot" drives are dashed, drawn at 70 % opacity with a narrower halo (OTHER_ALPHA): quieter than the loaded trips, but they still take the ramp colour of the time they lose waiting, so a drive to park through a queue is red (look at entity-review-vehicle-01-compact.png)');
  await context.close();
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// keyboard: Fleet tab -> Enter -> Tab -> Esc, and the keys that cycle
// ---------------------------------------------------------------------------------------------------------------------------------------------------
await run('keyboard', async () => {
  const { page, context } = await session();
  await measured(page, 'congestion-lab', 1800);
  await setTab(page, 'fleet');
  await frames(page, 3);
  const btn = page.getByRole('button', { name: 'Statistics for AGV 3' });
  ok(await btn.count() === 1, 'the Fleet tab lists a button for every vehicle');
  await btn.scrollIntoViewIfNeeded();
  await btn.focus();
  await page.keyboard.press('Enter');
  await settle(page);
  eq((await selection(page)).ids, ['v1#3'], 'Enter on a vehicle button selects that vehicle');
  ok(!(await dock(page)).hidden, 'and opens the dock');
  const where = () => page.evaluate(() => { const a = document.activeElement; const d = document.querySelector('.stats-dock'); return { inDock: d.contains(a), body: a === document.body, tag: a.tagName, label: (a.getAttribute('aria-label') || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50) }; });
  ok((await where()).inDock, `the focus moved into the dock (${(await where()).label})`);
  await page.locator('.insight__details').focus().catch(() => {});
  await page.keyboard.press('Enter');
  await settle(page);
  // Tab through the open dock: a trip row, then out of the dock (no trap)
  const seq = [];
  await page.locator('.insight__grip').focus();
  let leftAt = -1;
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press('Tab');
    const w = await where();
    seq.push(w);
    if (!w.inDock && leftAt < 0) { leftAt = i + 1; break; }
  }
  ok(leftAt > 0, `Tab leaves the dock (after ${leftAt} presses): no focus trap`);
  ok(seq.some((w) => /^1: /.test(w.label)), 'a trip row is reachable by Tab');
  ok(seq.some((w) => /^How is this counted/.test(w.label)), 'the counting rules (i) are reachable by Tab');
  // a trip row: focus draws its route, and has a visible focus ring
  const row = page.locator('.stats-dock button.trip').first();
  await row.focus();
  await frames(page, 3);
  eq((await page.evaluate(() => window.__logiplan.ctx.renderer.view.stats.focus))?.pinned, false, 'focusing a trip row draws its route (the same as hover)');
  const ring = await row.evaluate((e) => { const cs = getComputedStyle(e); return { outline: cs.outlineStyle, width: cs.outlineWidth, shadow: cs.boxShadow }; });
  ok(ring.outline !== 'none' || ring.shadow !== 'none', `a focused trip row has a visible focus indicator (${JSON.stringify(ring)})`);
  await snap(page, 'keyboard-01-row-focus');

  // ] with the focus on a trip row: the dock is rebuilt for the next vehicle and the focus falls to the page
  await page.keyboard.press(']');
  await settle(page);
  eq((await selection(page)).ids, ['v1#4'], 'the key ] selects the next vehicle');
  const after = await where();
  fixed('UX-3', !after.body, `with the focus on a trip row of the dock, ] shows the next vehicle but the focus is lost to the page (document.activeElement is <${after.tag.toLowerCase()}>); a keyboard-only planner has to Tab from the top of the page again, through the whole toolbar`);

  // [ and ] on a German or Nordic keyboard are AltGr+8 / AltGr+9 (Ctrl+Alt on Windows) and Option+5 / Option+6 on a Mac
  const sel0 = (await selection(page)).ids[0];
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: ']', code: 'Digit9', ctrlKey: true, altKey: true, bubbles: true, cancelable: true })));
  await settle(page);
  const afterAltGr = (await selection(page)).ids[0];
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: ']', code: 'Digit6', altKey: true, bubbles: true, cancelable: true })));
  await settle(page);
  const afterOption = (await selection(page)).ids[0];
  fixed('UX-4', afterAltGr !== sel0 && afterOption !== afterAltGr, `the keys [ and ] (listed in Help) do nothing when typed the way a German, Nordic or Mac keyboard types them: the handler returns on ctrlKey / altKey, and AltGr is Ctrl+Alt (selection stays ${sel0} -> ${afterAltGr} -> ${afterOption}); the Fleet tab buttons are the only keyboard route left`);

  // a counting rule opened with Enter, then Esc
  await select(page, 'vehicle', ['v1#3']);
  await showStatistics(page);
  await settle(page);
  const def = page.locator('.stats-dock [data-tile=busy] button.def');
  await def.focus();
  await page.keyboard.press('Enter');
  await frames(page, 2);
  eq(await def.getAttribute('aria-expanded'), 'true', 'Enter on (i) opens the counting rule in place');
  await page.keyboard.press('Escape');
  await settle(page);
  const gone = (await dock(page)).hidden;
  fixed('UX-19', !gone, `Esc with a counting rule open closes the whole dock and clears the selection (a disclosure should close first); the planner who was reading a definition has lost the item`);

  // Esc from inside the dock: the selection is cleared, the dock closes, and the focus goes to the plan (not to the top of the page)
  await select(page, 'vehicle', ['v1#3']);
  await showStatistics(page);
  await settle(page);
  await page.locator('.insight__grip').focus();
  await page.keyboard.press('Escape');
  await settle(page);
  ok((await dock(page)).hidden, 'Esc inside the dock closes it');
  eq(await page.evaluate(() => document.activeElement.tagName), 'CANVAS', 'and the focus lands on the plan');

  // I toggles, Esc clears
  await select(page, 'vehicle', ['v1#3']);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await page.keyboard.press('i');
  await settle(page);
  ok(!(await dock(page)).hidden, 'I opens the dock');
  await page.keyboard.press('i');
  await settle(page);
  ok((await dock(page)).hidden, 'I closes it again');
  await context.close();
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// phone: the sheet, touch, the small and the enlarged screens
// ---------------------------------------------------------------------------------------------------------------------------------------------------
await run('phone', async () => {
  const { page, context } = await session({ viewport: PHONE, touch: true });
  await measured(page, 'two-lines', 2400);
  const v = await vehicleAt(page, "v.id === 'v2#1'");
  await page.touchscreen.tap(v.x, v.y);
  await settle(page);
  eq((await selection(page)).ids, ['v2#1'], 'a tap on a vehicle selects it');
  let d = await dock(page);
  eq([d.hidden, d.snap], [false, 'peek'], 'the sheet opens as a peek');
  await snap(page, 'phone-01-peek');
  ok(d.top > 400, `the peek leaves most of the plan free (sheet top at ${Math.round(d.top)} of ${PHONE.height})`);
  const where = () => page.evaluate(() => { const { ctx, runner } = window.__logiplan; const r = ctx.canvas.getBoundingClientRect(); const veh = runner.sim.vehicles.find((x) => x.id === 'v2#1'); const [, py] = ctx.camera.worldToScreen(veh.x, veh.y); const el = document.querySelector('.stats-dock'); return { vehicleY: Math.round(r.top + py), dockTop: Math.round(el.getBoundingClientRect().top), zoom: ctx.camera.zoom }; });
  const peek = await where();
  ok(peek.vehicleY < peek.dockTop, `at peek the vehicle is above the sheet (${peek.vehicleY} < ${peek.dockTop})`);
  const grip = page.locator('.insight__grip');
  let gb = await grip.boundingBox();
  await page.touchscreen.tap(gb.x + gb.width / 2, gb.y + 5);
  await settle(page);
  eq((await dock(page)).snap, 'half', 'a tap on the grip goes to half');
  const half = await where();
  await snap(page, 'phone-02-half');
  fixed('UX-5', half.vehicleY < half.dockTop, `at the half and full snap points the camera does not follow: the selected vehicle is at y = ${half.vehicleY}, ${half.vehicleY - half.dockTop} px below the sheet's top (${half.dockTop}), so the route of the vehicle (the point of the click) is hidden whenever the numbers are readable (the plant is drawn under the sheet); the view is not moved to keep the vehicle in the free part, and the way back is a "Show on plan" link inside the scrolling body`);
  await page.touchscreen.tap(gb.x + gb.width / 2, (await grip.boundingBox()).y + 5);
  await settle(page);
  eq((await dock(page)).snap, 'full', 'a second tap goes to full');
  await snap(page, 'phone-03-full');
  // swipes: the grip (40 px) is the only handle
  const cdp = await context.newCDPSession(page);
  const swipe = async (x, y0, y1) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] });
    for (let i = 1; i <= 8; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / 8 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await settle(page);
  };
  gb = await grip.boundingBox();
  await swipe(195, gb.y + 20, gb.y + 400);
  const afterGripSwipe = (await dock(page)).snap;
  ok(afterGripSwipe !== 'full', `a swipe down on the grip lowers the sheet (${afterGripSwipe})`);
  const snapBefore = (await dock(page)).snap;
  const head = await page.locator('.insight__head').boundingBox();
  await swipe(120, head.y + 12, head.y - 300);
  const afterHeader = (await dock(page)).snap;
  fixed('UX-23', afterHeader !== snapBefore, `a swipe on the sheet's title row (where a thumb lands first) does nothing (${snapBefore} -> ${afterHeader}); only the 40 px grip handle swipes`);
  // a one-finger swipe on the plan with the Select tool is a marquee: it clears the selection and closes the sheet
  await select(page, 'vehicle', ['v2#1']);
  await showStatistics(page);
  await settle(page);
  await swipe(200, 250, 150);
  const closedBySwipe = (await dock(page)).hidden;
  note(`a one-finger swipe on empty plan with the Select tool (a marquee, existing editor behaviour) ${closedBySwipe ? 'clears the selection and closes the sheet: a planner who tries to scroll the plan to look at the route loses it; the Pan tool or two fingers pan' : 'leaves the sheet open'}`);

  // touch targets and overflow
  await select(page, 'vehicle', ['v2#1']);
  await showStatistics(page);
  await settle(page);
  gb = await grip.boundingBox();
  await page.touchscreen.tap(gb.x + gb.width / 2, gb.y + 5);
  await settle(page);
  const targets = await page.evaluate(() => [...document.querySelectorAll('.stats-dock button, .stats-dock a, .stats-dock [role=separator], .stats-dock summary, .stats-dock label.switch')].map((e) => { const r = e.getBoundingClientRect(); return { label: (e.getAttribute('aria-label') || e.textContent || e.className).trim().replace(/\s+/g, ' ').slice(0, 40), w: Math.round(r.width), h: Math.round(r.height) }; }).filter((t) => t.w > 0 && t.h > 0));
  const small = targets.filter((t) => t.w < 40 || t.h < 40);
  eq(small, [], `every control of the sheet is at least 40 x 40 px on a coarse pointer (${targets.length} checked)`);
  for (const [w, h] of [[390, 844], [360, 640], [320, 568]]) {
    await page.setViewportSize({ width: w, height: h });
    await settle(page);
    const o = await page.evaluate(() => ({ page: document.documentElement.scrollWidth - document.documentElement.clientWidth, dock: (() => { const e = document.querySelector('.stats-dock'); const r = e.getBoundingClientRect(); return [...e.querySelectorAll('*')].filter((c) => { const b = c.getBoundingClientRect(); return b.width > 0 && (b.right > r.right + 1 || b.left < r.left - 1); }).length; })() }));
    eq(o, { page: 0, dock: 0 }, `${w} px wide: no horizontal scroll, nothing sticks out of the sheet`);
  }
  await snap(page, 'phone-04-320');
  await context.close();

  // 300 % browser zoom of a 1440 x 900 screen is a 480 x 300 viewport
  const z = await session({ viewport: { width: 480, height: 300 } });
  await measured(z.page, 'two-lines', 2400);
  await select(z.page, 'vehicle', ['v2#1']);
  await showStatistics(z.page);
  await settle(z.page);
  const peekH = (await dock(z.page)).height;
  const stageH = (await view(z.page)).canvas.h;
  await snap(z.page, 'phone-05-zoom-300-peek');
  const g2 = await z.page.locator('.insight__grip').boundingBox();
  await z.page.locator('.insight__grip').click({ position: { x: g2.width / 2, y: 5 } });
  await settle(z.page);
  const halfH = (await dock(z.page)).height;
  await snap(z.page, 'phone-06-zoom-300-half');
  fixed('UX-15', halfH >= peekH, `at 300 % zoom (480 x 300 CSS px, stage ${Math.round(stageH)} px high) the "half" snap point (${Math.round(halfH)} px) is lower than the peek (${Math.round(peekH)} px, as high as its content) and shows no number at all; the peek alone takes ${Math.round((100 * peekH) / stageH)} % of the plan`);
  await z.context.close();

  // the other sizes: 50 % zoom of a 1440 x 900 screen, a laptop, a 1100 px window, 200 % zoom
  for (const [w, h] of [[2880, 1800], [1100, 700], [720, 450]]) {
    const q = await session({ viewport: { width: w, height: h } });
    await measured(q.page, 'two-lines', 2000);
    await select(q.page, 'vehicle', ['v1#1']);
    await showStatistics(q.page);
    await settle(q.page);
    const o = await q.page.evaluate(() => { const d = document.querySelector('.stats-dock').getBoundingClientRect(); return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, topOk: d.top >= 0, bottomOk: d.bottom <= innerHeight + 1, rightOk: d.right <= innerWidth + 1 }; });
    eq(o, { page: 0, topOk: true, bottomOk: true, rightOk: true }, `${w} x ${h}: the dock is inside the window and nothing scrolls sideways`);
    await snap(q.page, `phone-07-${w}x${h}`);
    if (w === 1100) {
      const live = await q.page.evaluate(() => { const i = document.querySelector('.stats-dock .insight__live > span:not(.dot)'); return { text: i ? i.textContent.trim() : '', px: i ? Math.round(i.clientWidth) : 0 }; });
      fixed('UX-2b', live.px >= 100, `at 1100 x 700 (a laptop window with the side panel open: the dock is ${Math.round((await dock(q.page)).width)} px wide) the live line "${live.text}" has ${live.px} px: only its status dot is left in the header (phone-07-1100x700.png), so what the vehicle is doing and where it goes is not on the screen at all`);
    }
    await q.context.close();
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// access: the accessibility tree, forced colours, reduced motion
// ---------------------------------------------------------------------------------------------------------------------------------------------------
await run('access', async () => {
  const { page, context } = await session();
  await measured(page, 'two-lines', 2400);
  await select(page, 'vehicle', ['v2#1']);
  await showStatistics(page);
  await settle(page);
  await page.locator('.insight__details').click();
  await settle(page);
  const tree = await page.locator('.stats-dock').ariaSnapshot();
  ok(/region "Statistics for AGVs 1"/.test(tree), 'the dock is a region labelled with the item');
  ok(/img "Time split: Driving loaded \d+ %/.test(tree), 'the time split is an image with a generated sentence');
  ok(/img "Busy share of each 30 seconds/.test(tree), 'the sparkline is an image with a generated sentence');
  ok(/group "Time window"/.test(tree) && /button "Since start" \[pressed\]/.test(tree), 'the window switch is a button group with the pressed state');
  ok(/button "1: .*trips?, /.test(tree), 'a trip row is a button whose name is the whole sentence');
  eq(await page.evaluate(() => document.querySelectorAll('.stats-dock [aria-live]').length), 0, 'no aria-live anywhere inside the dock');
  eq(await page.evaluate(() => document.querySelectorAll('[data-role=stats-announce][aria-live=polite]').length), 1, 'one polite announcement element sits next to the dock');
  ok(/AGVs 1 selected: /.test(await page.evaluate(() => document.querySelector('[data-role=stats-announce]').textContent)), 'it announces the selection with its busy and held-up shares');
  eq(await page.evaluate(() => [...document.querySelectorAll('.stats-dock h1, .stats-dock h2, .stats-dock h3')].map((h) => h.tagName)), ['H2', 'H3', 'H3', 'H3'], 'the headings are a title and three blocks');
  const longest = await page.evaluate(() => Math.max(...[...document.querySelectorAll('.stats-dock button.def')].map((b) => b.getAttribute('aria-label').length)));
  note(`the (i) buttons carry the whole counting rule as their accessible name (up to ${longest} characters): a screen reader reads the rule when it reads the number's label`);
  await context.close();

  // forced colours (Windows high contrast): borders and the pressed state survive
  const fc = await session({ forcedColors: 'active', colorScheme: 'dark' });
  await measured(fc.page, 'two-lines', 2400);
  await select(fc.page, 'vehicle', ['v1#1']);
  await showStatistics(fc.page);
  await settle(fc.page);
  await fc.page.locator('.insight__details').click();
  await settle(fc.page);
  await snap(fc.page, 'access-forced-colors');
  const states = await fc.page.evaluate(() => [...document.querySelectorAll('.stats-dock .segmented__item')].map((e) => ({ pressed: e.getAttribute('aria-pressed'), bg: getComputedStyle(e).backgroundColor, color: getComputedStyle(e).color })));
  ok(states[0].bg !== states[1].bg, `forced colours: the pressed window button differs from the other one (${JSON.stringify(states)})`);
  const border = await fc.page.evaluate(() => getComputedStyle(document.querySelector('.stats-dock')).borderTopColor);
  ok(border !== 'rgba(0, 0, 0, 0)', `forced colours: the dock keeps a border (${border})`);
  await fc.context.close();

  // reduced motion: no transition on the dock, no pulse
  const rm = await session({ reducedMotion: 'reduce' });
  await measured(rm.page, 'two-lines', 2400);
  await select(rm.page, 'vehicle', ['v1#1']);
  await showStatistics(rm.page);
  await settle(rm.page);
  const tr = await rm.page.evaluate(() => getComputedStyle(document.querySelector('.stats-dock')).transitionDuration);
  ok(/^0s(, 0s)*$/.test(tr), `reduced motion: the dock has no transition (${tr})`);
  await rm.context.close();
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// hostile: gestures, tools, undo, the collector, toasts, speed
// ---------------------------------------------------------------------------------------------------------------------------------------------------
await run('hostile', async () => {
  const { page, context } = await session();
  await measured(page, 'two-lines', 2400);
  await fitView(page);

  const step = (n, what) => console.log(`   .. ${n}. ${what}`);
  step(1, 'drag a station');
  // 1. dragging a station never opens the dock and nothing moves
  const p0 = await stationPx(page, 's6');
  const camBefore = await view(page);
  await page.mouse.move(p0.x, p0.y);
  await page.mouse.down();
  await page.mouse.move(p0.x + 40, p0.y - 30, { steps: 8 });
  ok((await dock(page)).hidden, 'while a station is dragged the dock stays closed');
  await page.mouse.up();
  await settle(page);
  ok((await dock(page)).hidden, 'after the drag the dock is still closed');
  eq((await view(page)).camera, camBefore.camera, 'the camera did not move');
  await page.keyboard.press('Control+z');
  await waitIdle(page);
  await settle(page);

  step(2, 'wheel zoom and Space-pan');
  // 2. wheel zoom and Space + drag with the dock open: the dock stays, no reveal pan fights the planner
  await select(page, 'vehicle', ['v1#1']);
  await showStatistics(page);
  await settle(page);
  const c1 = (await view(page)).camera;
  await page.mouse.move(600, 300);
  await page.mouse.wheel(0, -300);
  await settle(page);
  const c2 = (await view(page)).camera;
  ok(c2.zoom > c1.zoom, 'the wheel zooms the plan with the dock open');
  ok(!(await dock(page)).hidden, 'and the dock stays');
  await page.keyboard.down('Space');
  await page.mouse.move(500, 300);
  await page.mouse.down();
  await page.mouse.move(420, 280, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await settle(page);
  ok(!(await dock(page)).hidden, 'Space + drag pans the plan and the dock stays');
  await fitView(page);

  step(3, 'pan tool and a road drawn into the dock area');
  // 3. a drawing tool: a click on a vehicle with the Pan tool opens nothing; a road drawn from bare ground down into the area the dock covers is not swallowed by the dock
  await page.keyboard.press('Escape');
  await settle(page);
  await page.keyboard.press('h');
  const v = await vehicleAt(page);
  await page.mouse.click(v.x, v.y);
  await settle(page);
  ok((await dock(page)).hidden, 'with the Pan tool a click on a vehicle opens nothing');
  await page.keyboard.press('v');
  await select(page, 'vehicle', ['v1#1']);
  await showStatistics(page);
  await settle(page);
  await fitView(page);
  const geo = await page.evaluate(() => {
    const { ctx, store } = window.__logiplan; const r = ctx.canvas.getBoundingClientRect(); const d = document.querySelector('.stats-dock').getBoundingClientRect();
    const l = store.getState().layout;
    for (let y = d.top - r.top - 20; y > 120; y -= 6) for (let x = 90; x < r.width - 100; x += 6) {
      const hit = ctx.renderer.hitTest(x, y); const k = hit.cell.join(',');
      const near = [[0, 0], [0, 1], [0, 2], [0, 3], [1, 0], [-1, 0]].every(([dx, dy]) => !l.roads[`${hit.cell[0] + dx},${hit.cell[1] + dy}`]);
      if (hit.kind === 'cell' && !l.roads[k] && near) return { x: r.left + x, y: r.top + y, dockTop: d.top, roads: Object.keys(l.roads).length };
    }
    return null;
  });
  ok(geo !== null, 'bare ground just above the dock was found');
  await page.keyboard.press('r');
  await page.mouse.move(geo.x, geo.y);
  await page.mouse.down();
  await page.mouse.move(geo.x, geo.dockTop + 60, { steps: 10 });
  const during = await dock(page);
  ok(await page.evaluate(() => document.querySelector('.stats-dock').classList.contains('is-dragging')), 'while a road is drawn the dock steps aside (dimmed, no pointer)');
  await page.mouse.up();
  await frames(page, 4);
  const roadsAfter = await page.evaluate(() => Object.keys(window.__logiplan.store.getState().layout.roads).length);
  ok(roadsAfter > geo.roads, `the road drawn into the area under the dock was drawn (${geo.roads} -> ${roadsAfter} road cells)`);
  await page.keyboard.press('v');
  await page.keyboard.press('Control+z');
  await waitIdle(page);
  await settle(page);
  eq(await page.evaluate(() => Object.keys(window.__logiplan.store.getState().layout.roads).length), geo.roads, 'and one undo takes it back');
  await page.keyboard.press('Escape');
  await settle(page);

  step(4, 'delete and undo');
  // 4. delete and undo with a station selected: no dock left behind, no console error
  await fitView(page);
  const p6 = await stationPx(page, 's6');
  await page.mouse.click(p6.x, p6.y);
  await settle(page);
  await page.keyboard.press('Delete');
  await settle(page);
  ok((await dock(page)).hidden, 'deleting the selected station closes the dock');
  await page.keyboard.press('Control+z');
  await waitIdle(page);
  await settle(page);
  ok(!(await page.evaluate(() => Boolean(window.__logiplan.runner.sim && window.__logiplan.runner.sim.detailError))), 'after the undo the statistics did not stop');

  step(5, 'fleet cut under a selected vehicle');
  // 5. a fleet cut under the selected vehicle: the fleet is selected, the planner is told
  await select(page, 'vehicle', ['v1#3']);
  await showStatistics(page);
  await settle(page);
  await setTab(page, 'fleet');
  await frames(page, 3);
  await page.getByRole('button', { name: 'Decrease Vehicles' }).first().click();
  await settle(page);
  eq((await selection(page)).kind, 'fleet', 'a vehicle that no longer exists falls back to its fleet');
  const toasts = await page.evaluate(() => [...document.querySelectorAll('[data-region=toasts] > *')].map((t) => t.textContent));
  ok(toasts.some((t) => /no longer exists/.test(t)), 'and a toast says so');
  await page.keyboard.press('Control+z');
  await waitIdle(page);
  await settle(page);

  step(6, 'toasts over the dock');
  // 6. a toast over the dock: the two-line toast of every example load covers the bottom of the numbers
  await select(page, 'vehicle', ['v1#1']);
  await showStatistics(page);
  await settle(page);
  await closeToasts(page);
  await page.evaluate(() => window.__logiplan.ctx.toast('Opened the example "Two production lines + warehouse". Press Space or the play button to run it.', { kind: 'success', ms: 30000 }));
  await frames(page, 4);
  const overlap = await page.evaluate(() => {
    const t = [...document.querySelectorAll('[data-region=toasts] > *')].pop().getBoundingClientRect();
    const d = document.querySelector('.stats-dock .insight__strip').getBoundingClientRect();
    return Math.max(0, Math.min(t.bottom, d.bottom) - Math.max(t.top, d.top)) * Math.max(0, Math.min(t.right, d.right) - Math.max(t.left, d.left));
  });
  await snap(page, 'hostile-01-toast-over-dock');
  fixed('UX-11', overlap === 0, `a two-line toast (every example load, every warm restart) is drawn over the numbers of the dock (${Math.round(overlap)} px² of the strip covered): the toasts do not move up with the dock like the zoom buttons and the guide chip do`);
  await closeToasts(page);

  step(7, 'collector off');
  // 7. the collector switched off: what does the planner see?
  await setUi(page, { detail: false });
  await settle(page);
  const offText = await dockText(page);
  const routesDrawn = await page.evaluate(() => Boolean(window.__logiplan.runner.detail()));
  ok(!routesDrawn, 'with the collector off there is no detail');
  ok(!/NaN|Infinity|undefined/.test(offText), 'the dock still shows only plain numbers');
  await snap(page, 'hostile-02-collector-off');
  fixed('UX-13', /Simulate|switched off|turned off|statistics are off/i.test(offText), `with "Collect statistics for clicked items" off the dock quietly turns into fleet figures ("Fleet busy", "Fleet held up") and the routes vanish from the plan; no sentence says why or where to turn it on again (only the (i) texts mention it)`);
  await setUi(page, { detail: true });
  await settle(page);

  step(8, 'preference Never');
  // 8. the preference "never": a click opens nothing, the key still does; the hover text still promises statistics
  await setUi(page, { statsDock: 'never' });
  await page.evaluate(() => window.__logiplan.store.select(null, []));
  await settle(page);
  const v2 = await vehicleAt(page);
  await page.mouse.click(v2.x, v2.y);
  await settle(page);
  ok((await dock(page)).hidden, 'with "Never" a click selects but does not open the dock');
  note(`the status line while hovering a vehicle still reads "${await status(page)}" with the preference on Never`);
  await page.keyboard.press('i');
  await settle(page);
  ok(!(await dock(page)).hidden, 'the key I still opens it');
  await setUi(page, { statsDock: 'data' });
  await page.keyboard.press('Escape');
  await context.close();

  step(9, 'clicks at 600x');
  // 9. a click on a moving vehicle at 600x usually lands on the road under it
  const fast = await session();
  await measured(fast.page, 'two-lines', 2000);
  await fitView(fast.page);
  await fast.page.evaluate(async () => { const r = window.__logiplan.runner; r.setSpeed(600); await r.play(); });
  await fast.page.waitForTimeout(600);
  let miss = null; let tries = 0; let misses = 0;
  for (let k = 0; k < 24; k++) {
    await fast.page.evaluate(() => window.__logiplan.store.select(null, []));
    const pt = await fast.page.evaluate((i) => {
      const { ctx, runner } = window.__logiplan; const r = ctx.canvas.getBoundingClientRect();
      const c = runner.sim.vehicles.filter((v) => v.visible && v.state !== 'parked').map((v) => { const [px, py] = ctx.camera.worldToScreen(v.x, v.y); return { x: r.left + px, y: r.top + py, ok: px > 70 && px < r.width - 90 && py > 130 && py < r.height - 100 }; }).filter((q) => q.ok);
      return c.length ? c[i % c.length] : null;
    }, k);
    if (!pt) continue;
    tries++;
    await fast.page.mouse.click(pt.x, pt.y);
    await frames(fast.page, 2);
    const s = await selection(fast.page);
    if (s.kind !== 'vehicle') { misses++; if (miss === null) miss = { kind: s.kind, status: await status(fast.page) }; }
  }
  note(`at 600x ${misses} of ${tries} clicks aimed at a moving vehicle (read from the page an instant before) selected what is under it instead`);
  await snap(fast.page, 'hostile-03-click-at-600x');
  if (miss !== null) fixed('UX-14', /pause|slow|fleet tab/i.test(miss.status), `at 600x a click aimed at a vehicle can select what is under it instead (here a ${miss.kind}) and the status line says "${miss.status}": nothing hints that a vehicle is easier to pick when paused or from the Fleet tab`);
  else note('UX-14 (a click at 600x selects the road under a fast vehicle) was not reproduced in this run');
  // deterministic: a click on a road cell while the plan plays at 600x says why a vehicle was missed (the hint is not left to a lucky miss)
  await fast.page.evaluate(() => window.__logiplan.store.select(null, []));
  const roadPt = await findPoint(fast.page, "hit.kind === 'cell' && Boolean(window.__logiplan.store.getState().layout.roads[hit.cell[0] + ',' + hit.cell[1]])");
  ok(roadPt !== null, 'a road cell can be hit on the plan');
  await fast.page.mouse.click(roadPt.x, roadPt.y);
  await frames(fast.page, 3);
  ok(/pause \(Space\) first, or choose it in the Fleet tab/.test(await status(fast.page)), `a click on a road cell at 600x says that a vehicle cannot be clicked at that speed (${await status(fast.page)})`);
  // what the planner reads at 600x: how often does the dock rewrite itself?
  await select(fast.page, 'vehicle', ['v1#1']);
  await showStatistics(fast.page);
  await settle(fast.page);
  const flicker = await fast.page.evaluate(async () => {
    const dockEl = document.querySelector('.stats-dock'); const samples = []; const t0 = performance.now();
    while (performance.now() - t0 < 5000) {
      samples.push({ live: dockEl.querySelector('.insight__live').textContent.replace(/\s+/g, ' ').trim(), tiles: [...dockEl.querySelectorAll('[data-tile] .tile__num')].map((e) => e.textContent.trim()).join('|') });
      await new Promise((r) => setTimeout(r, 50));
    }
    let live = 0; let tiles = 0;
    for (let i = 1; i < samples.length; i++) { if (samples[i].live !== samples[i - 1].live) live++; if (samples[i].tiles !== samples[i - 1].tiles) tiles++; }
    return { seconds: (performance.now() - t0) / 1000, live, tiles };
  });
  note(`at 600x the header line changed ${flicker.live} times and the six numbers ${flicker.tiles} times in ${flicker.seconds.toFixed(0)} s (about ${(flicker.live / flicker.seconds).toFixed(1)} and ${(flicker.tiles / flicker.seconds).toFixed(1)} a second): a figure like "22 m to go" cannot be read while it runs; the planner has to pause`);
  await fast.context.close();
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// shell: does anything else move or break
// ---------------------------------------------------------------------------------------------------------------------------------------------------
await run('shell', async () => {
  const { page, context } = await session();
  await measured(page, 'two-lines', 2400);
  const boxes = () => page.evaluate(() => {
    const q = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(','); };
    return { zoom: q('.stage__zoom'), chip: q('.guide-chip'), canvas: q('canvas.stage__canvas'), status: q('.statusbar'), simbar: q('.simbar, .stage__sim'), topbar: q('.topbar') };
  });
  const before = await boxes();
  await snap(page, 'shell-01-before');
  const camBefore = (await view(page)).camera;
  const v = await vehicleAt(page);
  await page.mouse.click(v.x, v.y);
  await settle(page);
  await page.locator('.insight__details').click();
  await settle(page);
  await snap(page, 'shell-02-open');
  const during = await boxes();
  eq([during.canvas, during.status, during.topbar, during.simbar], [before.canvas, before.status, before.topbar, before.simbar], 'with the dock open the canvas, the status line, the top bar and the sim bar are where they were');
  ok(during.zoom !== before.zoom, 'the zoom buttons moved up above the dock');
  await page.locator('.insight__close').click();
  await settle(page);
  await page.evaluate(() => window.__logiplan.store.select(null, []));
  await page.mouse.move(5, 5);
  await settle(page);
  const afterClose = await boxes();
  eq(afterClose, before, 'after the dock is closed every box is exactly where it was before the first click');
  await snap(page, 'shell-03-after');
  ok((await view(page)).camera.zoom === camBefore.zoom, 'the zoom is unchanged by the whole episode');

  // the Simulate tab
  await setTab(page, 'simulate');
  await frames(page, 3);
  const collect = page.getByLabel('Collect statistics for clicked items');
  const when = page.getByLabel('Statistics on click');
  ok(await collect.isChecked(), 'the collector is on by default');
  eq(await when.inputValue(), 'data', 'the preference is "When the simulation has data" by default');
  eq(await when.evaluate((s) => [...s.options].map((o) => o.textContent)), ['When the simulation has data', 'Always', 'Never'], 'its three choices are in plain words');
  await when.selectOption('never');
  await page.waitForTimeout(900); // the autosave
  await page.reload();
  await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
  if (await page.locator('[role=dialog]').count()) await page.keyboard.press('Escape');
  eq(await page.evaluate(() => window.__logiplan.store.getState().ui.statsDock), 'never', 'the preference survives a reload');
  await page.evaluate(() => window.__logiplan.store.setUi({ statsDock: 'data' }));
  // a vehicle chosen in a warm-restarted plant (variants): switching to a copy keeps the app working
  await page.evaluate(() => window.__logiplan.store.select(null, []));
  await context.close();
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// perf: the frame pacing at 600x on the largest plant
// ---------------------------------------------------------------------------------------------------------------------------------------------------
await run('perf', async () => {
  const { page, context } = await session();
  await page.evaluate(async () => {
    const { bigPlant320 } = await import('/tests/helpers/big-plant.js');
    const built = bigPlant320({ vehicles: 100 });
    window.__logiplan.store.newProject(built.layout, 'Big plant 320');
    window.__logiplan.ctx.actions.fitView();
  });
  await frames(page, 3);
  await page.evaluate(async () => { const r = window.__logiplan.runner; r.setSpeed(600); await r.play(); });
  await page.waitForFunction(() => { const d = window.__logiplan.runner.detail(); return d && d.legs.count >= 800; }, null, { timeout: 300000, polling: 500 });
  const pick = await page.evaluate(() => {
    const { runner } = window.__logiplan; const d = runner.detail(); const w = d.windowOf('start'); let best = null;
    for (let i = 0; i < d.V.length; i++) { const rows = d.routesOf(i, w, [1, 0, 2, 3]).filter((r) => r.drawn > 0); const drawn = rows.reduce((a, r) => a + Math.max(1, r.pathIds.length), 0); if (!best || drawn > best.drawn) best = { id: runner.sim.vehicles[i].id, drawn }; }
    return best;
  });
  const measure = (ms) => page.evaluate(async (dur) => {
    const out = []; let last = performance.now(); const t0 = last;
    await new Promise((resolve) => { const tick = (t) => { out.push(t - last); last = t; if (t - t0 < dur) requestAnimationFrame(tick); else resolve(); }; requestAnimationFrame(tick); });
    out.shift();
    const s = [...out].sort((a, b) => a - b);
    return { n: out.length, mean: out.reduce((a, x) => a + x, 0) / out.length, p50: s[s.length >> 1], p95: s[Math.floor(s.length * 0.95)], max: s[s.length - 1], over50: out.filter((x) => x > 50).length };
  }, ms);
  const closed = []; const withDock = []; const dockNoRoutes = [];
  for (let round = 0; round < 3; round++) {
    await page.evaluate(() => window.__logiplan.store.select(null, []));
    await settle(page);
    closed.push(await measure(4000));
    await page.evaluate((id) => { window.__logiplan.store.select('vehicle', [id]); window.__logiplan.ctx.actions.showStatistics(); }, pick.id);
    await settle(page);
    withDock.push(await measure(4000));
    await setUi(page, { overlays: { routes: false } });
    await frames(page, 4);
    dockNoRoutes.push(await measure(4000));
    await setUi(page, { overlays: { routes: true } });
  }
  const mean = (xs, k) => xs.reduce((a, x) => a + x[k], 0) / xs.length;
  const line = (name, xs) => `${name}: mean ${mean(xs, 'mean').toFixed(1)} ms, p50 ${mean(xs, 'p50').toFixed(1)}, p95 ${mean(xs, 'p95').toFixed(1)}, frames over 50 ms ${mean(xs, 'over50').toFixed(1)} per 4 s`;
  console.log(`   100 vehicles at 600x (the runner is CPU-limited: ${await page.evaluate(() => window.__logiplan.runner.limited)}); a vehicle with ${pick.drawn} ways to draw`);
  console.log(`   ${line('nothing selected', closed)}`);
  console.log(`   ${line('dock + routes', withDock)}`);
  console.log(`   ${line('dock, routes off', dockNoRoutes)}`);
  ok(mean(withDock, 'mean') < mean(closed, 'mean') * 1.6, `the dock with routes costs less than 60 % more frame time than no dock (${mean(withDock, 'mean').toFixed(1)} against ${mean(closed, 'mean').toFixed(1)} ms)`);
  ok(withDock.every((r) => r.max < 500), 'no frame of the dock-and-routes view took half a second');
  const dockShare = (mean(dockNoRoutes, 'mean') - mean(closed, 'mean')) / Math.max(0.1, mean(withDock, 'mean') - mean(closed, 'mean'));
  note(`of the frame time added by the dock and the routes, ${Math.round(100 * Math.max(0, Math.min(1, dockShare)))} % is already there with the routes switched off: the cost at 600x on the largest plant is mostly the dock's own 4 Hz refresh and its overlay, not the route layer`);
  await context.close();
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
const open = findings.filter((d) => d.open);
const bySeverity = (s) => open.filter((d) => d.severity === s).map((d) => d.id).join(', ');
console.log(`\n${checks} guard checks passed; ${open.length} of ${findings.length} findings OPEN`);
for (const s of ['high', 'medium', 'low']) if (bySeverity(s)) console.log(`   ${s}: ${bySeverity(s)}`);
await browser.close();
await new Promise((r) => server.close(r));
if (open.length) process.exitCode = 1;
