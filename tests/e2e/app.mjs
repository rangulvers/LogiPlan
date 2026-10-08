// End-to-end smoke test of the whole app (index.html + js/main.js + js/ui/app.js) in real Chromium.
// Run: node tests/e2e/app.mjs [section]
//   sections: unit session first example ctx run tabs focus theme variants menus shortcuts palette resize persist share failure errors drop unload subpath narrow widths print a11y
// Screenshots: e2e-output/app-*.png (open them and look). Everything here drives the real app with real modules: the only thing
// replaced is the clock of the simulation (a fast speed instead of waiting), and the failures of the `failure` section are provoked
// through the public ctx. Every section asserts that the page logged no console error or warning.
import assert from 'node:assert/strict';
import path from 'node:path';
import { withBrowser, OUT } from './browser.mjs';
import {
  RIGHT_TABS, clampSideWidth, easeInOut, focusRect, runChip, selectionFor, shortcutFor, stepSpeed,
} from '../../js/ui/app.js';
import { SPEEDS } from '../../js/ui/runner.js';
import { EXAMPLES } from '../../js/model/examples.js';

const only = process.argv[2] || '';
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

const DESKTOP = { width: 1440, height: 900 };
const NARROW = { width: 390, height: 800 };
const TAB_IDS = ['properties', 'fleet', 'flows', 'simulate', 'results', 'experiments', 'checks'];

await withBrowser(async ({ browser, url, errors }) => {
  const requests = [];
  const snap = (page, name, opts = {}) => page.screenshot({ path: path.join(OUT, `${name}.png`), ...opts });

  /** A fresh browser context (own localStorage): a new visitor. */
  async function session({ viewport = DESKTOP, scale = 1, colorScheme = 'light', reducedMotion = 'no-preference' } = {}) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: scale, acceptDownloads: true, colorScheme, reducedMotion });
    const page = await context.newPage();
    page.setDefaultTimeout(60000); // other test runs may share this machine: waiting for the simulation can take a while
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[console.${m.type()}] ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    page.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
    page.on('request', (r) => requests.push(r.url()));
    return { context, page };
  }

  /** Open the app as a new visitor and (unless `welcome`) dismiss the welcome dialog. */
  async function openApp(opts = {}) {
    const { welcome = false, query = '', ...rest } = opts;
    const s = await session(rest);
    await s.page.goto(url(`/index.html${query}`));
    await s.page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
    if (!welcome) {
      await s.page.locator('[role=dialog]').waitFor();
      await s.page.keyboard.press('Escape');
      await s.page.locator('[role=dialog]').waitFor({ state: 'detached' });
    }
    return s;
  }

  async function loadExample(page, id = 'two-lines') {
    await page.evaluate(async (exampleId) => { await window.__logiplan.ctx.actions.loadExample(exampleId); }, id);
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.stations.length > 0);
    await page.waitForTimeout(150);
  }

  const state = (page) => page.evaluate(() => {
    const s = window.__logiplan.store.getState();
    return { dirty: s.dirty, tab: s.ui.rightTab, tool: s.ui.tool, theme: s.ui.theme, stations: s.layout.stations.length, name: s.project.name, scenarios: s.project.scenarios.map((x) => x.name), active: s.project.activeId, undo: s.undoLabel, selection: s.ui.selection };
  });
  const runnerState = (page) => page.evaluate(() => { const r = window.__logiplan.runner; return { playing: r.playing, time: r.time, speed: r.speed, limited: r.limited }; });
  const clock = (page) => page.locator('.simbar__clock').innerText();
  const chip = (page) => page.locator('.simbar > .chip[role=status]').innerText();
  /** The chrome follows the store one animation frame later: let two frames pass before reading it. */
  const frames = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const noErrors = (what) => { eq(errors.splice(0), [], `${what}: console errors or warnings`); };
  const overflow = (page) => page.evaluate(() => ({ doc: document.documentElement.scrollWidth - innerWidth, body: document.body.scrollWidth - innerWidth }));
  /** Number of canvas pixels within `tol` of an RGB colour (sampled every other pixel). */
  const canvasHas = (page, rgb, tol = 28) => page.evaluate(([[r, g, b], t]) => {
    const c = document.getElementById('plant');
    const copy = Object.assign(document.createElement('canvas'), { width: c.width, height: c.height }); // reading the live canvas twice makes Chromium warn
    const cx = copy.getContext('2d', { willReadFrequently: true });
    cx.drawImage(c, 0, 0);
    const d = cx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 8) if (Math.abs(d[i] - r) < t && Math.abs(d[i + 1] - g) < t && Math.abs(d[i + 2] - b) < t) n++;
    return n;
  }, [rgb, tol]);

  const run = async (name, fn) => {
    if (only && only !== name) return;
    console.log(`-- ${name}`);
    await fn();
  };

  // ---------------------------------------------------------------------------------------------------------------
  await run('unit', async () => {
    eq(clampSideWidth(1000, 1440), 720, 'panel never wider than 720');
    eq(clampSideWidth(1000, 900), 540, 'panel never wider than 60 % of the window');
    eq(clampSideWidth(100, 1440), 300, 'panel never narrower than 300');
    eq(clampSideWidth(NaN, 1440), 360, 'junk gives the default');
    eq([easeInOut(0), easeInOut(0.5), easeInOut(1)], [0, 0.5, 1], 'ease endpoints');
    ok(easeInOut(0.25) < 0.25 && easeInOut(0.75) > 0.75, 'ease is slow at the ends');
    eq(selectionFor({ stationIds: ['s1'], flowIds: ['f1'] }), { kind: 'station', ids: ['s1'] }, 'stations win');
    eq(selectionFor({ flowIds: ['f1'], cells: [[1, 2]] }), { kind: 'flow', ids: ['f1'] }, 'flows before cells');
    eq(selectionFor({ cells: [[3, 4], [5, 6]] }), { kind: 'cell', ids: ['3,4', '5,6'] }, 'cells become keys');
    eq(selectionFor({}), null, 'nothing named');
    eq(selectionFor(null), null, 'null refs');
    const layout = EXAMPLES[0].build();
    const [a, b] = layout.stations;
    const cs = layout.grid.cellSize;
    eq(focusRect(layout, { stationIds: [a.id] }), { x: a.x * cs, y: a.y * cs, w: a.w * cs, h: a.h * cs }, 'one station');
    const both = focusRect(layout, { stationIds: [a.id, b.id] });
    ok(both.x <= Math.min(a.x, b.x) * cs && both.x + both.w >= Math.max(a.x + a.w, b.x + b.w) * cs, 'two stations union');
    eq(focusRect(layout, { cells: [[2, 3], [4, 6]] }), { x: 2 * cs, y: 3 * cs, w: 3 * cs, h: 4 * cs }, 'cells union');
    eq(focusRect(layout, { stationIds: ['nope'] }), null, 'unknown station');
    const flow = layout.flows[0];
    ok(focusRect(layout, { flowIds: [flow.id] }).w > 0, 'a flow covers both ends');
    const fleet = layout.fleets[0];
    const vehicles = [{ fleetId: fleet.id, x: 10, y: 12 }, { fleetId: 'other', x: 99, y: 99 }];
    eq(focusRect(layout, { fleetIds: [fleet.id] }, vehicles), { x: 10 - cs / 2, y: 12 - cs / 2, w: cs, h: cs }, 'fleet = its vehicles');
    eq(runChip({ playing: false, time: 0, warmup: 600, started: false }).key, 'ready', 'chip: ready');
    eq(runChip({ playing: true, time: 10, warmup: 600, started: true }).label, 'Warming up', 'chip: warming');
    eq(runChip({ playing: true, time: 700, warmup: 600, started: true }).label, 'Running', 'chip: running');
    eq(runChip({ playing: false, time: 700, warmup: 600, started: true }).label, 'Paused', 'chip: paused');
    eq(runChip({ playing: true, time: 0, warmup: 0, started: true }).label, 'Running', 'chip: no warm-up');
    eq([stepSpeed(10, 1), stepSpeed(10, -1), stepSpeed(1200, 1), stepSpeed(1, -1)], [30, 5, 1200, 1], 'speed steps stop at the ends');
    eq(shortcutFor({ key: 's', ctrlKey: true }), 'save', 'Ctrl+S');
    eq(shortcutFor({ key: 'S', metaKey: true }), 'save', 'Cmd+S');
    eq(shortcutFor({ key: 's', ctrlKey: true, shiftKey: true }), null, 'Ctrl+Shift+S is not ours');
    eq(shortcutFor({ key: 'k', ctrlKey: true }), null, 'Ctrl+K is nobody\'s');
    eq(['.', '+', '=', '-', '_', '?', '0'].map((key) => shortcutFor({ key })), ['step', 'faster', 'faster', 'slower', 'slower', 'help', 'fit'], 'plain keys');
    eq([shortcutFor({ key: 'f' }), shortcutFor({}), shortcutFor({ key: '+', altKey: true })], [null, null, null], 'F is the flow tool; key-less events and Alt are ignored');
    eq(RIGHT_TABS.map((t) => t.id), TAB_IDS, 'tab order of the spec');
  });

  // ---------------------------------------------------------------------------------------------------------------
  // The quality gate of docs/ARCHITECTURE.md 8: a whole session (load, edit, run, compare, export) without a console error.
  await run('session', async () => {
    const { page, context } = await openApp({ welcome: true });
    const dialog = page.locator('[role=dialog]');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Create empty plant' }).click();
    await dialog.waitFor({ state: 'detached' });
    eq(await state(page).then((x) => x.stations), 0, 'an empty plant to start from');
    /** Client position of a point `fy` of the way down cell (cx, cy). A brick snaps to round(pointer - size / 2): 2-high ones need fy off the .5 edge. */
    const at = (cx, cy, fy = 0.5) => page.evaluate(([x, y, f]) => {
      const { camera, canvas, store } = window.__logiplan.ctx;
      const cs = store.getState().layout.grid.cellSize;
      const [sx, sy] = camera.worldToScreen((x + 0.5) * cs, (y + f) * cs);
      const r = canvas.getBoundingClientRect();
      return { x: r.left + sx, y: r.top + sy };
    }, [cx, cy, fy]);
    const click = async (cx, cy, fy) => { const p = await at(cx, cy, fy); await page.mouse.move(p.x, p.y); await page.mouse.click(p.x, p.y); };
    const drag = async (path) => {
      const p0 = await at(...path[0]);
      await page.mouse.move(p0.x, p0.y);
      await page.mouse.down();
      for (const cell of path.slice(1)) { const p = await at(...cell); await page.mouse.move(p.x, p.y, { steps: 6 }); }
      await page.mouse.up();
    };
    // edit: a road loop, three stations, two flows
    await page.keyboard.press('r');
    await drag([[10, 10], [30, 10], [30, 20], [10, 20], [10, 10]]);
    eq(await page.evaluate(() => window.__logiplan.store.getState().undoLabel), 'Draw road', 'drawing a road is one named step');
    await page.keyboard.press('1');
    await click(12, 8, 0.75);
    await page.keyboard.press('2');
    await click(21, 22);
    await page.keyboard.press('4');
    await click(12, 21, 0.75);
    await page.keyboard.press('f');
    const stations = await page.evaluate(() => window.__logiplan.store.getState().layout.stations.map((x) => ({ id: x.id, type: x.type, cx: x.x + Math.floor(x.w / 2), cy: x.y + Math.floor(x.h / 2) })));
    eq(stations.map((x) => x.type), ['source', 'process', 'sink'], 'Goods in, Workstation, Goods out placed with the number keys');
    await click(stations[0].cx, stations[0].cy);
    await click(stations[1].cx, stations[1].cy);
    await page.keyboard.press('f');
    await click(stations[1].cx, stations[1].cy);
    await click(stations[2].cx, stations[2].cy);
    await page.keyboard.press('Escape');
    eq(await page.evaluate(() => window.__logiplan.store.getState().layout.flows.length), 2, 'two flows drawn with the Flow tool');
    await snap(page, 'app-34-session-edited');
    // vehicles, from the Fleet tab
    await page.locator('[data-tab=fleet]').click();
    await frames(page);
    await page.getByRole('button', { name: 'Add fleet', exact: true }).click();
    eq(await page.evaluate(() => window.__logiplan.store.getState().layout.fleets.length), 1, 'a fleet was added in the Fleet tab');
    await frames(page);
    eq(await page.evaluate(() => window.__logiplan.ctx.issues().filter((i) => i.severity !== 'info').map((i) => i.code)), [], 'the plant has no problem left');
    await page.waitForFunction(() => document.querySelector('[role=tab][data-tab=checks] .badge').hidden, null, { timeout: 3000 });
    ok(true, 'and the Checks tab has no badge');
    // run
    await page.getByRole('button', { name: 'Run simulation' }).click();
    await page.selectOption('.simbar__speed', '1200');
    await page.locator('[data-tab=results]').click();
    await page.waitForFunction(() => window.__logiplan.runner.time > 4000, null, { timeout: 30000 });
    await page.waitForTimeout(500);
    ok(await page.evaluate(() => window.__logiplan.runner.kpis().throughput.total > 0), 'loads were delivered');
    ok(/Throughput/.test(await page.locator('#panel-results').innerText()), 'the Results tab shows them');
    await snap(page, 'app-35-session-running');
    // an edit while running rebuilds the simulation and keeps it running
    await page.evaluate(async () => {
      const { updateFleet } = await import('/js/model/layout.js');
      const store = window.__logiplan.store;
      store.commit('More vehicles', (d) => { updateFleet(d, d.fleets[0].id, { count: 3 }); });
    });
    await page.waitForFunction(() => window.__logiplan.runner.time < 3000, null, { timeout: 5000 });
    ok(await page.evaluate(() => window.__logiplan.runner.playing), 'a structural edit restarts the simulation and keeps it playing');
    await page.keyboard.press('Escape');
    await page.mouse.click(1000, 800);
    await page.keyboard.press('Space');
    // a variant, and the comparison of the two
    await page.getByRole('button', { name: /Add a variant/ }).click();
    await page.evaluate(async () => {
      const { updateFleet } = await import('/js/model/layout.js');
      window.__logiplan.store.commit('Fewer vehicles', (d) => { updateFleet(d, d.fleets[0].id, { count: 1 }); });
    });
    await page.locator('[data-tab=experiments]').click();
    await frames(page);
    const panel = page.locator('#panel-experiments');
    await panel.getByLabel('Run length').fill('0.3');
    await panel.getByLabel('Warm-up').fill('1');
    await panel.getByRole('button', { name: /Decrease/ }).click();
    await panel.getByRole('button', { name: /Decrease/ }).click();
    await panel.getByRole('button', { name: 'Run comparison' }).click();
    await panel.locator('[data-cmp=table]').waitFor({ timeout: 60000 });
    ok((await panel.locator('[data-cmp=table]').innerText()).includes('Throughput'), 'the comparison table appears');
    await snap(page, 'app-36-session-compared');
    // export
    const files = [];
    for (const entry of ['Project file (JSON)', 'Layout picture (PNG)', 'Report (HTML)']) {
      await page.getByRole('button', { name: 'Export', exact: true }).click();
      const download = page.waitForEvent('download');
      await page.getByRole('menuitem', { name: entry }).click();
      files.push((await download).suggestedFilename());
    }
    ok(files[0].endsWith('.json') && files[1].endsWith('.png') && files[2].startsWith('logiplan-report-'), `three exports (${files.join(', ')})`);
    await page.keyboard.press('Control+z');
    await context.close();
    noErrors('session');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('first', async () => {
    const { page, context } = await openApp({ welcome: true });
    const dialog = page.locator('[role=dialog]');
    await dialog.waitFor();
    ok((await dialog.innerText()).includes('Welcome to LogiPlan'), 'welcome dialog on the first visit');
    eq(await dialog.locator('button', { hasText: /Starter|Two production|Congestion/ }).count(), 3, 'three examples offered');
    await snap(page, 'app-01-first-visit-light');
    ok((await page.title()).includes('LogiPlan'), 'title');
    // skeleton and landmarks
    eq(await page.evaluate(() => ['header', 'nav[aria-label="Tools"]', 'main', 'aside', 'footer'].map((s) => document.querySelectorAll(s).length)), [1, 1, 1, 1, 1], 'landmarks');
    eq(await page.evaluate(() => document.querySelectorAll('script:not([src])').length), 0, 'no inline scripts');
    eq(await page.evaluate(() => document.documentElement.lang), 'en', 'lang');
    eq(await page.evaluate(() => ['description', 'theme-color', 'viewport'].map((n) => document.querySelectorAll(`meta[name="${n}"]`).length > 0)), [true, true, true], 'meta tags');
    ok(await page.evaluate(() => document.querySelector('meta[property="og:title"]')?.content.includes('LogiPlan')), 'open graph');
    ok(await page.evaluate(() => document.querySelector('link[rel=icon]')?.getAttribute('href') === 'favicon.svg'), 'favicon, relative');
    eq(await page.evaluate(() => [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => l.getAttribute('href'))), ['css/tokens.css', 'css/components.css', 'css/layout.css'], 'stylesheets, relative');
    eq(await page.evaluate(() => [...document.querySelectorAll('script[src]')].map((l) => l.getAttribute('src'))), ['js/main.js'], 'one module script');
    ok(requests.every((r) => r.startsWith('http://127.0.0.1')), `no external requests: ${requests.filter((r) => !r.startsWith('http://127.0.0.1')).join(', ')}`);
    // the empty plant behind the dialog
    eq(await page.evaluate(() => window.__logiplan.store.getState().layout.stations.length), 0, 'a fresh plant is empty');
    eq(await page.evaluate(() => ['store', 'runner', 'ctx'].every((k) => k in window.__logiplan)), true, 'window.__logiplan');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    ok(await page.locator('.stage__empty').isVisible(), 'empty-plant hint after closing the welcome');
    eq(await page.locator('.side__bar [role=tab][data-tab=checks] .badge').innerText(), '1', 'an empty plant has one problem: no stations');
    await snap(page, 'app-02-empty-plant');
    // ?welcome shows it again, also with a saved project
    await page.goto(url('/index.html?welcome'));
    await page.locator('[role=dialog]').waitFor();
    ok(true, '?welcome opens the welcome dialog');
    await context.close();
    noErrors('first visit');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('example', async () => {
    const { page, context } = await openApp({ welcome: true });
    const dialog = page.locator('[role=dialog]');
    await dialog.waitFor();
    await dialog.locator('button', { hasText: 'Two production lines' }).first().click();
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.stations.length > 0);
    await page.waitForTimeout(300);
    const s = await state(page);
    eq(s.stations, 8, 'the example has its stations');
    eq(s.dirty, false, 'a loaded example is not unsaved work');
    eq(s.name, 'Two lines + warehouse', 'project named after the example');
    ok(await page.locator('.toast').first().innerText().then((t) => t.includes('Opened the example')), 'toast says what happened');
    ok(!(await page.locator('.stage__empty').isVisible()), 'empty hint gone');
    ok((await canvasHas(page, [245, 184, 46])) > 200, 'workstations are drawn (amber bricks)');
    ok((await canvasHas(page, [47, 125, 246])) > 80, 'goods-in is drawn (blue brick)');
    // the whole plant is in view after the load
    const fit = await page.evaluate(() => {
      const { camera, canvas, store } = window.__logiplan.ctx;
      const g = store.getState().layout.grid;
      const [x0, y0] = camera.worldToScreen(0, 0);
      const [x1, y1] = camera.worldToScreen(g.cols * g.cellSize, g.rows * g.cellSize);
      return { x0, y0, x1, y1, w: canvas.clientWidth, h: canvas.clientHeight };
    });
    ok(fit.x0 >= 0 && fit.y0 >= 0 && fit.x1 <= fit.w && fit.y1 <= fit.h, `plant fitted into the canvas ${JSON.stringify(fit)}`);
    eq(await page.title(), 'Two lines + warehouse – LogiPlan', 'title follows the project');
    eq(await page.locator('.statusbar__meta').innerText(), '56 × 33 cells · 112 × 66 m', 'plant size in the status line');
    await snap(page, 'app-03-example-light');
    // a view that is still the whole-plant fit follows the size of the stage; one the planner moved does not
    const inside = () => page.evaluate(() => {
      const { camera, canvas, store } = window.__logiplan.ctx;
      const g = store.getState().layout.grid;
      const [x0, y0] = camera.worldToScreen(0, 0);
      const [x1, y1] = camera.worldToScreen(g.cols * g.cellSize, g.rows * g.cellSize);
      return x0 >= 0 && y0 >= 0 && x1 <= canvas.clientWidth && y1 <= canvas.clientHeight;
    });
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.waitForTimeout(300);
    eq(await inside(), true, 'a smaller window: the plant is still fitted');
    await page.getByRole('button', { name: 'Zoom in' }).click();
    const zoomed = await page.evaluate(() => window.__logiplan.ctx.camera.zoom);
    await page.setViewportSize({ width: 1300, height: 800 });
    await page.waitForTimeout(300);
    eq(await page.evaluate(() => window.__logiplan.ctx.camera.zoom), zoomed, 'a view the planner moved stays as it is');
    await page.keyboard.press('0');
    await page.waitForTimeout(400);
    await page.setViewportSize(DESKTOP);
    await page.waitForTimeout(300);
    eq(await inside(), true, 'back to the full size: fitted again');
    // loading another example over unsaved work asks first
    await page.evaluate(() => window.__logiplan.store.commit('Rename plant', (d) => { d.name = 'Changed'; }));
    const asked = page.evaluate(() => window.__logiplan.ctx.actions.loadExample('starter'));
    await page.locator('[role=dialog]').waitFor();
    ok((await page.locator('[role=dialog]').innerText()).includes('Open this example?'), 'asks before replacing unsaved work');
    await snap(page, 'app-04-confirm-replace');
    await page.getByRole('button', { name: 'Cancel' }).click();
    eq(await asked, false, 'declined: resolves false');
    eq((await state(page)).stations, 8, 'declined: nothing changed');
    const loaded = page.evaluate(() => window.__logiplan.ctx.actions.loadExample('starter'));
    await page.locator('[role=dialog]').waitFor();
    await page.getByRole('button', { name: 'Open example' }).click();
    eq(await loaded, true, 'accepted: resolves true');
    eq((await state(page)).name, EXAMPLES.find((e) => e.id === 'starter').build().name, 'accepted: replaced');
    eq(await page.evaluate(() => window.__logiplan.ctx.actions.loadExample('nope')), false, 'unknown example');
    await context.close();
    noErrors('example');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('ctx', async () => {
    const { page, context } = await openApp();
    await loadExample(page, 'starter');
    // graph() and issues(): cached per layout object, exact when asked outside the panel updates
    eq(await page.evaluate(() => {
      const { ctx } = window.__logiplan;
      const l = ctx.store.getState().layout;
      return [ctx.graph() === ctx.graph(), ctx.issues() === ctx.issues(), ctx.graph().nodeCount === l.grid.cols * l.grid.rows, Array.isArray(ctx.issues())];
    }), [true, true, true, true], 'the same layout gives the same graph and the same issues');
    eq(await page.evaluate(async () => {
      const { ctx } = window.__logiplan;
      const { addStation } = await import('/js/model/layout.js');
      const before = ctx.issues();
      ctx.store.commit('Add station', (d) => { addStation(d, { type: 'storage', x: 1, y: 1 }); });
      const after = ctx.issues();
      return [before === after, after.some((i) => i.code === 'station-no-dock'), before.some((i) => i.code === 'station-no-dock')];
    }), [false, true, false], 'asked right after an edit, issues() is exact');
    // setTool and setRightTab
    await page.evaluate(() => { window.__logiplan.ctx.actions.setTool('depot'); window.__logiplan.ctx.actions.setRightTab('flows'); });
    await frames(page);
    eq([(await state(page)).tool, (await state(page)).tab, await page.locator('[data-tool=depot]').getAttribute('aria-pressed'), await page.locator('[role=tab][data-tab=flows]').getAttribute('aria-selected')], ['depot', 'flows', 'true', 'true'], 'setTool and setRightTab drive the palette and the tabs');
    await page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('no-such-tab'));
    eq((await state(page)).tab, 'flows', 'an unknown tab name is ignored');
    // setStatus
    await page.evaluate(() => window.__logiplan.ctx.setStatus('Cell 3, 4 (6 m, 8 m)'));
    eq(await page.locator('.statusbar__text').innerText(), 'Cell 3, 4 (6 m, 8 m)', 'setStatus shows the text');
    await page.evaluate(() => { window.__logiplan.ctx.setStatus(''); window.__logiplan.ctx.actions.setTool('select'); });
    await frames(page);
    ok((await page.locator('.statusbar__text').innerText()).startsWith('Click to select'), 'an empty status shows the hint of the tool');
    // toasts
    const toast = (message, opts) => page.evaluate(([m, o]) => { window.__logiplan.ctx.toast(m, o); }, [message, opts]);
    const toasts = () => page.locator('.toast-region .toast');
    await page.evaluate(() => document.querySelector('.toast-region').replaceChildren());
    eq(await page.locator('.toast-region').getAttribute('aria-live'), 'polite', 'a polite live region');
    await toast('Saved it', { kind: 'success', ms: 600 });
    eq([await toasts().count(), await toasts().first().getAttribute('class'), await toasts().first().getAttribute('role')], [1, 'toast toast--success', 'status'], 'success toast');
    await toasts().first().waitFor({ state: 'detached', timeout: 3000 });
    ok(true, 'and it goes away after its time');
    await toast('That failed', { kind: 'error', ms: 5000 });
    eq(await toasts().first().getAttribute('role'), 'alert', 'errors are announced at once');
    await toasts().first().getByRole('button', { name: 'Dismiss' }).click();
    eq(await toasts().count(), 0, 'the close button');
    await toast('Same', { kind: 'warn', ms: 5000 });
    await toast('Same', { kind: 'warn', ms: 5000 });
    eq(await toasts().count(), 1, 'the same message twice is shown once');
    await toast('Two', { ms: 5000 });
    await toast('Three', { ms: 5000 });
    await toast('Four', { ms: 5000 });
    eq(await toasts().allInnerTexts().then((t) => t.map((x) => x.trim())), ['Two', 'Three', 'Four'], 'at most three, the oldest makes room');
    await snap(page, 'app-37-toasts');
    await page.evaluate(() => document.querySelector('.toast-region').replaceChildren());
    await page.evaluate(() => { window.__undone = 0; window.__logiplan.ctx.toast('Plant deleted', { kind: 'info', ms: 5000, action: { label: 'Undo', onClick: () => { window.__undone++; } } }); });
    await toasts().first().getByRole('button', { name: 'Undo' }).click();
    eq([await page.evaluate(() => window.__undone), await toasts().count()], [1, 0], 'an action runs and closes the toast');
    // hovering holds a toast; leaving lets it go
    await toast('Hold on', { ms: 500 });
    const box = await toasts().first().boundingBox();
    await page.mouse.move(box.x + 20, box.y + 10);
    await page.waitForTimeout(1000);
    eq(await toasts().count(), 1, 'under the pointer a toast stays');
    await page.mouse.move(5, 5);
    await toasts().first().waitFor({ state: 'detached', timeout: 4000 });
    ok(true, 'and leaves soon after the pointer does');
    // a long message stays longer than a short one (it has to be read)
    const shortLived = await page.evaluate(() => new Promise((resolve) => {
      const region = document.querySelector('.toast-region');
      const t0 = performance.now();
      window.__logiplan.ctx.toast('Short', {});
      const watch = () => { if (!region.querySelector('.toast')) resolve(performance.now() - t0); else requestAnimationFrame(watch); };
      watch();
    }));
    ok(shortLived >= 3300 && shortLived < 4500, `a short message stays about 3.5 s (${Math.round(shortLived)} ms)`);
    // a new plant after confirming
    await page.evaluate(() => window.__logiplan.store.commit('Rename plant', (d) => { d.notes = 'x'; }));
    const created = page.evaluate(() => window.__logiplan.ctx.actions.newProject());
    await page.locator('[role=dialog]').waitFor();
    ok((await page.locator('[role=dialog]').innerText()).includes('Start a new plant?'), 'a new plant asks first when there is unsaved work');
    await page.getByRole('button', { name: 'Start new plant' }).click();
    eq(await created, true, 'confirmed');
    eq((await state(page)).stations, 0, 'an empty plant');
    eq(await page.evaluate(() => window.__logiplan.ctx.actions.newProject()), true, 'nothing unsaved: no question');
    await context.close();
    noErrors('ctx');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('run', async () => {
    const { page, context } = await openApp();
    await loadExample(page);
    eq([await clock(page), await chip(page)], ['0:00:00', 'Ready'], 'before the first run');
    eq(await page.locator('.simbar__speed option').allInnerTexts(), SPEEDS.map((x) => `${x}×`), 'the runner speeds');
    await page.getByRole('button', { name: 'Run simulation' }).click();
    await page.waitForFunction(() => window.__logiplan.runner.time > 4);
    ok((await clock(page)) !== '0:00:00', 'the clock advances');
    eq(await chip(page), 'Warming up', 'warm-up first');
    eq(await page.getByRole('button', { name: 'Pause simulation' }).count(), 1, 'the button turns into Pause');
    await snap(page, 'app-05-running-warmup-light');
    await page.selectOption('.simbar__speed', '1200');
    eq((await runnerState(page)).speed, 1200, 'speed select drives the runner');
    await page.waitForFunction(() => document.querySelector('.simbar > .chip[role=status]').textContent === 'Running', null, { timeout: 15000 });
    ok(true, 'warm-up ends: Running');
    // Space plays and pauses when the focus is on the plan
    await page.mouse.click(1000, 800); // empty plan area
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !window.__logiplan.runner.playing);
    eq(await chip(page), 'Paused', 'Space pauses');
    const t0 = (await runnerState(page)).time;
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.__logiplan.runner.playing);
    await page.waitForFunction((t) => window.__logiplan.runner.time > t + 50, t0);
    ok(true, 'Space plays again');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => !window.__logiplan.runner.playing);
    // step, with the button and with the key
    await page.selectOption('.simbar__speed', '10');
    const t1 = (await runnerState(page)).time;
    await page.getByRole('button', { name: 'Step forward 1 second' }).click();
    await page.waitForFunction((t) => window.__logiplan.runner.time >= t + 1, t1);
    const t2 = (await runnerState(page)).time;
    ok(t2 - t1 < 3, `one step is about a second (${t2 - t1})`);
    await page.mouse.click(1000, 800);
    await page.keyboard.press('.');
    await page.waitForFunction((t) => window.__logiplan.runner.time >= t + 1, t2);
    ok(true, '. steps');
    // + and - change the speed through the runner's speeds
    await page.keyboard.press('+');
    eq((await runnerState(page)).speed, 30, '+ faster');
    eq(await page.locator('.simbar__speed').inputValue(), '30', 'the select follows');
    await page.keyboard.press('-');
    await page.keyboard.press('-');
    eq((await runnerState(page)).speed, 5, '- slower');
    // the sim bar on the live plan
    await page.getByRole('button', { name: 'Reset simulation' }).click();
    eq([await clock(page), await chip(page)], ['0:00:00', 'Ready'], 'reset: back to the start');
    // results follow the run
    await page.locator('[data-tab=results]').click();
    await page.getByRole('button', { name: 'Run simulation' }).first().click();
    await page.selectOption('.simbar__speed', '1200');
    await page.waitForFunction(() => window.__logiplan.runner.time > 1500, null, { timeout: 20000 });
    await page.waitForTimeout(600);
    const dash = await page.locator('#panel-results').innerText();
    ok(/Throughput/.test(dash) && /Lead time/.test(dash), 'the Results tab shows live KPIs');
    await snap(page, 'app-06-results-live-light');
    // changing the layout while running keeps running and rebuilds (structural) or not (cosmetic)
    await page.evaluate(() => window.__logiplan.store.commit('Rename plant', (d) => { d.notes = 'x'; }));
    await page.waitForTimeout(400);
    ok((await runnerState(page)).playing, 'a cosmetic edit does not stop the run');
    await page.keyboard.press('Space');
    await context.close();
    noErrors('run');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('tabs', async () => {
    const { page, context } = await openApp();
    await loadExample(page);
    const tabs = page.locator('.side__bar [role=tab]');
    eq(await tabs.count(), 7, 'seven tabs');
    eq(await tabs.evaluateAll((els) => els.map((e) => e.dataset.tab)), TAB_IDS, 'in the order of the spec');
    for (const id of TAB_IDS) {
      await page.locator(`[role=tab][data-tab=${id}]`).click();
      await page.waitForTimeout(250);
      const info = await page.evaluate((tab) => {
        const shown = [...document.querySelectorAll('[role=tabpanel]')].filter((p) => !p.hidden);
        const panel = document.getElementById(`panel-${tab}`);
        return {
          shown: shown.map((p) => p.id), selected: [...document.querySelectorAll('.side__bar [role=tab]')].filter((t) => t.getAttribute('aria-selected') === 'true').map((t) => t.dataset.tab),
          height: panel.getBoundingClientRect().height, text: panel.innerText.trim().length, stored: window.__logiplan.store.getState().ui.rightTab,
          labelled: panel.getAttribute('aria-labelledby'), controls: document.getElementById(`tab-${tab}`).getAttribute('aria-controls'),
        };
      }, id);
      eq(info.shown, [`panel-${id}`], `${id}: exactly one panel visible`);
      eq(info.selected, [id], `${id}: exactly one tab selected`);
      eq(info.stored, id, `${id}: the choice is kept in store.ui.rightTab`);
      ok(info.height > 100 && info.text > 20, `${id}: the panel has content (${info.height}px, ${info.text} chars)`);
      eq([info.labelled, info.controls], [`tab-${id}`, `panel-${id}`], `${id}: tab and panel reference each other`);
      await snap(page, `app-07-tab-${id}-light`);
    }
    // arrow keys move and activate; Home and End jump
    await page.locator('[role=tab][data-tab=properties]').click();
    await page.keyboard.press('ArrowRight');
    eq((await state(page)).tab, 'fleet', 'ArrowRight');
    ok(await page.evaluate(() => document.activeElement.dataset.tab === 'fleet'), 'focus moved with it');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    eq((await state(page)).tab, 'checks', 'ArrowLeft wraps around');
    await page.keyboard.press('Home');
    eq((await state(page)).tab, 'properties', 'Home');
    await page.keyboard.press('End');
    eq((await state(page)).tab, 'checks', 'End');
    await frames(page);
    eq(await page.evaluate(() => [...document.querySelectorAll('.side__bar [role=tab]')].map((t) => t.tabIndex)), [-1, -1, -1, -1, -1, -1, 0], 'one tab stop (roving tabindex)');
    // the arrow keys did not nudge anything on the plan
    eq((await state(page)).undo, null, 'no edit came out of the arrow keys');
    // the Checks badge follows the plan
    eq(await page.locator('[role=tab][data-tab=checks] .badge').isVisible(), false, 'a healthy plant has no badge');
    await page.evaluate(async () => {
      const { addStation } = await import('/js/model/layout.js');
      window.__logiplan.store.commit('Add station', (d) => { addStation(d, { type: 'storage', x: 2, y: 2 }); });
    });
    await page.waitForFunction(() => !document.querySelector('[role=tab][data-tab=checks] .badge').hidden, null, { timeout: 3000 });
    const badge = Number(await page.locator('[role=tab][data-tab=checks] .badge').innerText());
    ok(badge >= 1, `the badge counts problems (${badge})`);
    eq(await page.locator('[role=tab][data-tab=checks]').getAttribute('aria-label'), `Checks, ${badge} ${badge === 1 ? 'problem' : 'problems'}`, 'badge in the accessible name');
    await page.locator('[role=tab][data-tab=checks]').click();
    await page.waitForTimeout(300);
    ok((await page.locator('#panel-checks').innerText()).length > 50, 'the Checks tab lists them');
    await snap(page, 'app-08-checks-problems-light');
    // "Show" selects the thing and brings it into view
    const show = page.locator('#panel-checks button', { hasText: 'Show' }).first();
    ok(await show.count() > 0, 'a Show button exists');
    await show.click();
    await page.waitForTimeout(400);
    ok((await state(page)).selection.kind !== null, 'Show selects the referenced item');
    await context.close();
    noErrors('tabs');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('focus', async () => {
    const { page, context } = await openApp();
    await loadExample(page);
    const final = await page.evaluate(() => window.__logiplan.store.getState().layout.stations.find((s) => s.name.startsWith('Final')).id);
    /** Is the centre of station `id` on the canvas? */
    const onScreen = (id) => page.evaluate((stationId) => {
      const { camera, canvas, store } = window.__logiplan.ctx;
      const l = store.getState().layout;
      const s = l.stations.find((x) => x.id === stationId);
      const [x, y] = camera.worldToScreen((s.x + s.w / 2) * l.grid.cellSize, (s.y + s.h / 2) * l.grid.cellSize);
      return x > 0 && y > 0 && x < canvas.clientWidth && y < canvas.clientHeight;
    }, id);
    const cam = () => page.evaluate(() => { const c = window.__logiplan.ctx.camera; return { x: c.x, y: c.y, zoom: c.zoom }; });
    await page.evaluate(() => { const { camera } = window.__logiplan.ctx; camera.zoom = 40; camera.x = 3; camera.y = 3; });
    eq(await onScreen(final), false, 'out of view before');
    const samples = await page.evaluate((id) => new Promise((resolve) => {
      const { camera } = window.__logiplan.ctx;
      const xs = [];
      const t0 = performance.now();
      window.__logiplan.ctx.actions.focus({ stationIds: [id] });
      const tick = () => { xs.push(camera.x); if (performance.now() - t0 < 500) requestAnimationFrame(tick); else resolve(xs); };
      tick();
    }), final);
    ok(new Set(samples).size > 4, `the camera glides (${new Set(samples).size} distinct positions)`);
    ok(samples.every((x, i) => i === 0 || x >= samples[i - 1] - 1e-9), 'monotonically, without overshoot');
    eq(await onScreen(final), true, 'in view afterwards');
    const sel = (await state(page)).selection;
    eq([sel.kind, sel.ids], ['station', [final]], 'the station is selected');
    // already visible: the camera stays where it is
    const before = await cam();
    await page.evaluate((id) => window.__logiplan.ctx.actions.focus({ stationIds: [id] }), final);
    await page.waitForTimeout(300);
    eq(await cam(), before, 'a station that is already comfortably in view does not move the camera');
    // a flow shows both of its ends
    await page.evaluate(() => { const { camera } = window.__logiplan.ctx; camera.zoom = 45; camera.x = 3; camera.y = 3; });
    const flow = await page.evaluate(() => { const l = window.__logiplan.store.getState().layout; const f = l.flows[0]; return { id: f.id, from: f.from, to: f.to }; });
    await page.evaluate((id) => window.__logiplan.ctx.actions.focus({ flowIds: [id] }), flow.id);
    await page.waitForTimeout(400);
    eq([await onScreen(flow.from), await onScreen(flow.to), (await state(page)).selection.kind], [true, true, 'flow'], 'a flow: both ends in view, the flow selected');
    // cells that are no road are looked at, not selected
    await page.evaluate(() => { const { camera } = window.__logiplan.ctx; camera.zoom = 60; camera.x = 90; camera.y = 60; });
    await page.evaluate(() => window.__logiplan.ctx.actions.focus({ cells: [[1, 1]] }));
    await page.waitForTimeout(400);
    const moved = await cam();
    ok(moved.x < 20 && moved.y < 20, `the camera went to the cell (${JSON.stringify(moved)})`);
    // a user who prefers less motion gets the move at once
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => { const { camera } = window.__logiplan.ctx; camera.zoom = 40; camera.x = 3; camera.y = 3; });
    await page.evaluate((id) => window.__logiplan.ctx.actions.focus({ stationIds: [id] }), final);
    eq(await onScreen(final), true, 'reduced motion: there at once');
    // nothing to look at: nothing happens
    const same = await cam();
    await page.evaluate(() => window.__logiplan.ctx.actions.focus({}));
    await page.evaluate(() => window.__logiplan.ctx.actions.focus({ stationIds: ['nope'] }));
    eq(await cam(), same, 'empty or unknown refs leave the view alone');
    // the user taking over ends a glide
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(() => { const { camera } = window.__logiplan.ctx; camera.zoom = 40; camera.x = 3; camera.y = 3; window.__logiplan.ctx.actions.focus({ stationIds: [window.__logiplan.store.getState().layout.stations[0].id] }); });
    await page.mouse.move(700, 450);
    await page.mouse.wheel(0, 1);
    const stopped = await cam();
    await page.waitForTimeout(300);
    eq(await cam(), stopped, 'the wheel stops the glide');
    await context.close();
    noErrors('focus');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('theme', async () => {
    const { page, context } = await openApp({ colorScheme: 'light' });
    await loadExample(page);
    const themeButton = page.getByRole('button', { name: 'Colour theme' });
    const html = () => page.evaluate(() => ({ attr: document.documentElement.dataset.theme ?? null, bg: getComputedStyle(document.body).backgroundColor, canvas: window.__logiplan.ctx.renderer.theme.bg, metas: [...document.querySelectorAll('meta[name=theme-color]')].map((m) => m.content) }));
    const light = await html();
    eq(light.attr, null, 'auto: no attribute');
    await themeButton.click();
    eq(await page.getByRole('menuitemradio').allInnerTexts(), ['Automatic (system)', 'Light', 'Dark'], 'three choices');
    eq(await page.locator('[role=menuitemradio][aria-checked=true]').innerText(), 'Automatic (system)', 'auto is checked');
    await snap(page, 'app-09-theme-menu-light');
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await page.waitForTimeout(250);
    const dark = await html();
    eq(dark.attr, 'dark', 'dark: attribute');
    ok(dark.bg !== light.bg && dark.canvas !== light.canvas, 'page and canvas both changed');
    eq(new Set(dark.metas).size, 1, 'address bar colour follows the page');
    eq((await state(page)).theme, 'dark', 'kept in the store');
    eq(await page.evaluate(() => document.activeElement === document.querySelector('[aria-label="Colour theme"]')), true, 'focus returned to the button');
    await snap(page, 'app-10-theme-dark');
    // the busy states in the dark too: a running simulation with live results, an open menu, the Checks tab with a problem
    await page.locator('[data-tab=results]').click();
    await page.locator('.simbar').getByRole('button', { name: 'Run simulation' }).click();
    await page.selectOption('.simbar__speed', '1200');
    await page.waitForFunction(() => window.__logiplan.runner.time > 1500, null, { timeout: 20000 });
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await snap(page, 'app-10b-dark-running-menu');
    await page.keyboard.press('Escape');
    await page.locator('.simbar').getByRole('button', { name: 'Pause simulation' }).click();
    await page.evaluate(async () => {
      const { addStation } = await import('/js/model/layout.js');
      window.__logiplan.store.commit('Add station', (d) => { addStation(d, { type: 'storage', x: 2, y: 2 }); });
    });
    await page.locator('[data-tab=checks]').click();
    await page.waitForTimeout(500);
    await snap(page, 'app-10c-dark-checks');
    await page.evaluate(() => window.__logiplan.store.undo());
    await page.getByRole('button', { name: 'Colour theme' }).click();
    await page.getByRole('menuitemradio', { name: 'Light' }).click();
    await page.waitForTimeout(250);
    eq((await html()).attr, 'light', 'light: attribute');
    eq((await html()).canvas, light.canvas, 'light canvas = automatic canvas on a light system');
    // auto follows the system
    await page.getByRole('button', { name: 'Colour theme' }).click();
    await page.getByRole('menuitemradio', { name: /Automatic/ }).click();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(300);
    const sysDark = await html();
    eq(sysDark.attr, null, 'auto: no attribute');
    eq(sysDark.canvas, dark.canvas, 'auto follows a dark system, canvas included');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(300);
    eq((await html()).canvas, light.canvas, 'and back');
    // the choice survives a reload
    await page.getByRole('button', { name: 'Colour theme' }).click();
    await page.getByRole('menuitemradio', { name: 'Dark' }).click();
    await page.waitForTimeout(700);
    await page.reload();
    await page.waitForFunction(() => window.__logiplan && document.getElementById('app').dataset.state === 'ready');
    eq((await html()).attr, 'dark', 'dark after a reload');
    await context.close();
    noErrors('theme');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('variants', async () => {
    const { page, context } = await openApp();
    await loadExample(page, 'starter');
    const tabs = () => page.locator('.variants__tab').evaluateAll((els) => els.map((e) => `${e.textContent}${e.getAttribute('aria-selected') === 'true' ? '*' : ''}`));
    /** The tabs follow the store one animation frame later: wait for them. */
    const tabsAre = async (expected, msg) => {
      await page.waitForFunction((want) => [...document.querySelectorAll('.variants__tab')].map((e) => `${e.textContent}${e.getAttribute('aria-selected') === 'true' ? '*' : ''}`).join('|') === want, expected.join('|'), { timeout: 3000 }).catch(() => {});
      eq(await tabs(), expected, msg);
    };
    await tabsAre(['A*'], 'one variant at the start');
    const undo = page.locator('[aria-label^="Undo"], [aria-label^="Nothing to undo"]').first();
    eq(await undo.isDisabled(), true, 'nothing to undo yet');
    // an edit names itself in the tooltip
    await page.locator('[data-tool=obstacle]').click();
    await page.mouse.click(720, 780);
    await page.waitForTimeout(250);
    const label = (await state(page)).undo;
    ok(label, `the edit has a label (${label})`);
    eq(await undo.getAttribute('aria-label'), `Undo ${label}`, 'undo names the edit');
    ok((await undo.getAttribute('data-tip')).startsWith(`Undo ${label} (`), 'tooltip too');
    await undo.hover();
    await page.waitForTimeout(600);
    await snap(page, 'app-11-undo-tooltip');
    await undo.click();
    eq((await state(page)).undo, null, 'undo works');
    const redo = page.locator('[aria-label^="Redo"]');
    ok((await redo.getAttribute('aria-label')).includes(label), 'redo names it');
    await redo.click();
    eq((await state(page)).undo, label, 'redo works');
    // add, switch, rename, duplicate, delete
    const obstacles = await page.evaluate(() => window.__logiplan.store.getState().layout.obstacles.length);
    await page.getByRole('button', { name: /Add a variant/ }).click();
    await tabsAre(['A', 'B*'], 'B added and opened');
    eq(await page.evaluate(() => window.__logiplan.store.getState().layout.obstacles.length), obstacles, 'B starts as a copy of A');
    await page.locator('.variants__tab', { hasText: 'A' }).click();
    await tabsAre(['A*', 'B'], 'switch back');
    await page.keyboard.press('Tab');
    await page.locator('.variants__tab[aria-selected=true]').focus();
    await page.keyboard.press('ArrowRight');
    await tabsAre(['A', 'B*'], 'arrow keys switch variants');
    await page.getByRole('button', { name: 'Variant options' }).click();
    await snap(page, 'app-12-variant-menu');
    await page.getByRole('menuitem', { name: /Rename/ }).click();
    await page.keyboard.type('Wide aisle');
    await page.keyboard.press('Enter');
    await tabsAre(['A', 'Wide aisle*'], 'renamed');
    await page.getByRole('button', { name: 'Variant options' }).click();
    await page.getByRole('menuitem', { name: 'Duplicate' }).click();
    await tabsAre(['A', 'Wide aisle', 'Wide aisle copy*'], 'duplicated');
    await snap(page, 'app-13-variants');
    await page.getByRole('button', { name: 'Variant options' }).click();
    await page.getByRole('menuitem', { name: /Delete/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete variant' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.variants__tab').length === 2);
    ok(true, 'deleted');
    // project name
    const name = page.getByRole('textbox', { name: 'Project name' });
    await name.fill('Plant Ulm');
    await name.press('Enter');
    eq((await state(page)).name, 'Plant Ulm', 'project renamed');
    await frames(page);
    eq(await page.title(), 'Plant Ulm – LogiPlan', 'title follows');
    await name.fill('   ');
    await name.press('Enter');
    eq(await name.inputValue(), 'Plant Ulm', 'an empty name is refused and the old one comes back');
    await name.fill('Typing…');
    await name.press('Escape');
    eq(await name.inputValue(), 'Plant Ulm', 'Esc takes the edit back');
    // unsaved / saved
    await frames(page);
    eq(await page.locator('.savechip__text').innerText(), 'Unsaved', 'edits make the project unsaved');
    const download = page.waitForEvent('download');
    await page.locator('.savechip').click();
    ok((await download).suggestedFilename().endsWith('.json'), 'the chip downloads the project file');
    await page.waitForFunction(() => document.querySelector('.savechip__text').textContent === 'Saved');
    ok(true, 'and it is saved');
    await context.close();
    noErrors('variants');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('menus', async () => {
    const { page, context } = await openApp();
    await loadExample(page);
    const exportButton = page.getByRole('button', { name: 'Export', exact: true });
    await exportButton.click();
    eq(await exportButton.getAttribute('aria-expanded'), 'true', 'expanded');
    const items = await page.getByRole('menuitem').allInnerTexts();
    eq(items.map((t) => t.split('\n')[0]), ['Project file (JSON)', 'Layout picture (PNG)', 'Report (HTML)', 'Print or save as PDF…', 'Open a project file…'], 'export entries');
    ok(await page.evaluate(() => document.activeElement.textContent.startsWith('Project file')), 'the first entry has focus');
    await page.keyboard.press('ArrowDown');
    ok(await page.evaluate(() => document.activeElement.textContent.startsWith('Layout picture')), 'arrow down');
    await page.keyboard.press('End');
    ok(await page.evaluate(() => document.activeElement.textContent.startsWith('Open a project')), 'End');
    await page.keyboard.press('ArrowDown');
    ok(await page.evaluate(() => document.activeElement.textContent.startsWith('Project file')), 'wraps');
    await page.keyboard.press('Escape');
    eq(await page.locator('[role=menu]').count(), 0, 'Esc closes');
    ok(await page.evaluate(() => document.activeElement.getAttribute('aria-label') === 'Export'), 'focus back on the button');
    await exportButton.click();
    await page.mouse.click(600, 600);
    eq(await page.locator('[role=menu]').count(), 0, 'a click outside closes');
    await exportButton.focus();
    await page.keyboard.press('ArrowDown');
    eq(await page.locator('[role=menu]').count(), 1, 'ArrowDown opens it from the button');
    await snap(page, 'app-14-export-menu-light');
    // the files
    const download = async (entry) => {
      const d = page.waitForEvent('download');
      await page.getByRole('menuitem', { name: entry }).click();
      return d;
    };
    ok((await download('Project file (JSON)')).suggestedFilename().endsWith('.json'), 'JSON');
    await exportButton.click();
    ok((await (await download('Layout picture (PNG)')).suggestedFilename()).endsWith('.png'), 'PNG');
    await exportButton.click();
    const report = await download('Report (HTML)');
    ok((await report.suggestedFilename()).startsWith('logiplan-report-'), 'report');
    await exportButton.click();
    const popup = page.waitForEvent('popup');
    await page.getByRole('menuitem', { name: /Print/ }).click();
    const printed = await popup;
    await printed.waitForLoadState();
    ok((await printed.content()).includes('LogiPlan'), 'print opens the report in a window');
    await printed.close();
    await exportButton.click();
    await page.getByRole('menuitem', { name: /Open a project file/ }).click();
    ok((await page.getByRole('dialog').innerText()).includes('Import and export'), 'import opens its dialog');
    await page.keyboard.press('Escape');
    // the other top-bar buttons
    await page.getByRole('button', { name: 'Share' }).click();
    ok((await page.getByRole('dialog').innerText()).includes('Share'), 'Share opens its dialog');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Help' }).click();
    ok((await page.getByRole('dialog').innerText()).includes('Quick start'), 'Help opens its dialog');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Examples' }).click();
    ok((await page.getByRole('dialog').innerText()).includes('Welcome'), 'Examples opens the welcome dialog');
    await page.keyboard.press('Escape');
    ok(await page.evaluate(() => document.activeElement.getAttribute('aria-label') === 'Examples'), 'focus returns to the opener');
    await context.close();
    noErrors('menus');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('shortcuts', async () => {
    const { page, context } = await openApp();
    await loadExample(page);
    await page.mouse.click(1000, 800);
    // Help
    await page.keyboard.press('?');
    ok(await page.locator('[role=dialog]').count() === 1, '? opens help');
    await page.keyboard.press('Space'); // inside a dialog: must not run the simulation
    eq((await runnerState(page)).playing, false, 'no shortcuts behind a dialog');
    await page.keyboard.press('Escape');
    // fit
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await page.getByRole('button', { name: 'Zoom in' }).click();
    const zoomed = await page.evaluate(() => window.__logiplan.ctx.camera.zoom);
    await page.mouse.click(1000, 800);
    await page.keyboard.press('0');
    await page.waitForTimeout(500);
    const fitted = await page.evaluate(() => window.__logiplan.ctx.camera.zoom);
    ok(fitted < zoomed, `0 fits the plant again (${zoomed.toFixed(1)} -> ${fitted.toFixed(1)})`);
    await page.getByRole('button', { name: 'Zoom out' }).click();
    ok(await page.evaluate(() => window.__logiplan.ctx.camera.zoom) < fitted, 'zoom out');
    await page.getByRole('button', { name: 'Fit the whole plant into view' }).click();
    await page.waitForTimeout(500);
    ok(Math.abs(await page.evaluate(() => window.__logiplan.ctx.camera.zoom) - fitted) < 0.01, 'the fit button animates to the same view');
    // Ctrl+S saves the project file
    const save = page.waitForEvent('download');
    await page.keyboard.press('Control+s');
    ok((await save).suggestedFilename().endsWith('.json'), 'Ctrl+S downloads the project');
    // typing in a field is not a shortcut
    const name = page.getByRole('textbox', { name: 'Project name' });
    await name.click();
    const speed = (await runnerState(page)).speed;
    await page.keyboard.type('1.2+3-0? .');
    ok((await name.inputValue()).includes('1.2+3-0? .'), 'the text arrived in the field');
    eq([(await runnerState(page)).speed, (await state(page)).tool, await page.locator('[role=dialog]').count()], [speed, 'select', 0], 'no tool, speed or dialog came out of typing');
    await name.press('Escape');
    // tool keys belong to the editor and the palette follows
    await page.mouse.click(1000, 800);
    await page.keyboard.press('r');
    await frames(page);
    eq((await state(page)).tool, 'road', 'R selects the road tool');
    eq(await page.locator('[data-tool=road]').getAttribute('aria-pressed'), 'true', 'the palette follows');
    await page.keyboard.press('Escape');
    await frames(page);
    eq((await state(page)).tool, 'select', 'Esc leaves the tool');
    // the status line
    await page.mouse.move(700, 450);
    await page.waitForTimeout(200);
    ok((await page.locator('.statusbar__text').innerText()).startsWith('Cell '), 'hovering shows the cell');
    await page.mouse.move(700, 40);
    await page.waitForTimeout(200);
    ok((await page.locator('.statusbar__text').innerText()).startsWith('Click to select'), 'leaving shows the hint of the tool again');
    await context.close();
    noErrors('shortcuts');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('palette', async () => {
    const { page, context } = await openApp();
    await loadExample(page);
    const tools = await page.locator('.palette [data-tool]').evaluateAll((els) => els.map((e) => [e.dataset.tool, e.getAttribute('aria-label'), e.dataset.tip, e.getAttribute('aria-pressed')]));
    eq(tools.map((t) => t[0]), ['select', 'pan', 'road', 'oneway', 'speedzone', 'erase', 'source', 'process', 'storage', 'sink', 'depot', 'obstacle', 'label', 'flow'], 'all tools, in the groups of the spec');
    ok(tools.every((t) => /\([A-Z0-9]\)$/.test(t[2])), 'every tooltip names its shortcut');
    eq(tools.filter((t) => t[3] === 'true').map((t) => t[0]), ['select'], 'one tool pressed');
    eq(await page.locator('.palette .toolbar__sep').count(), 3, 'three rules between four groups');
    await page.locator('[data-tool=process]').click();
    await frames(page);
    eq((await state(page)).tool, 'process', 'a click selects the tool');
    await page.keyboard.press('v');
    await page.waitForFunction(() => document.querySelector('[data-tool=select]').getAttribute('aria-pressed') === 'true');
    ok(true, 'and a key moves the button');
    // roving tabindex and arrow keys
    eq(await page.locator('.palette [data-tool][tabindex="0"]').count(), 1, 'one tab stop');
    await page.locator('[data-tool=select]').focus();
    await page.keyboard.press('ArrowDown');
    eq(await page.evaluate(() => document.activeElement.dataset.tool), 'pan', 'ArrowDown moves focus');
    eq((await state(page)).tool, 'select', 'without choosing');
    await page.keyboard.press('End');
    eq(await page.evaluate(() => document.activeElement.dataset.tool), 'flow', 'End');
    await page.keyboard.press('Enter');
    await frames(page);
    eq((await state(page)).tool, 'flow', 'Enter chooses');
    // options of the slow-zone and obstacle tools
    await page.locator('[data-tool=speedzone]').click();
    await frames(page);
    ok(await page.locator('.stage__options').isVisible(), 'slow zone: options shown');
    await page.locator('.stage__options [data-value="0.25"]').click();
    eq(await page.evaluate(() => window.__logiplan.store.getState().ui.toolOptions.factor), 0.25, 'the limit is chosen');
    await snap(page, 'app-15-tool-options-light');
    await page.locator('[data-tool=obstacle]').click();
    await frames(page);
    await page.locator('.stage__options [data-value="rack"]').click();
    eq(await page.evaluate(() => window.__logiplan.store.getState().ui.toolOptions.kind), 'rack', 'the obstacle type is chosen');
    await page.locator('[data-tool=road]').click();
    await frames(page);
    ok(!(await page.locator('.stage__options').isVisible()), 'other tools: no options');
    // overlays
    const flag = (name) => page.locator(`[data-overlay=${name}]`);
    await flag('docks').click();
    await frames(page);
    eq(await page.evaluate(() => window.__logiplan.store.getState().ui.overlays.docks), true, 'docks on');
    eq(await flag('docks').getAttribute('aria-pressed'), 'true', 'pressed');
    await page.locator('[data-heat=traffic]').click();
    await frames(page);
    eq(await page.evaluate(() => window.__logiplan.store.getState().ui.overlays.heat), 'traffic', 'heatmap: traffic');
    eq(await page.locator('[data-heat=traffic]').getAttribute('aria-pressed'), 'true', 'heat button pressed');
    await flag('grid').click();
    await flag('ids').click();
    await snap(page, 'app-16-overlays-light');
    eq(await page.evaluate(() => { const o = window.__logiplan.ctx.renderer.view.overlays; return [o.grid, o.ids, o.docks, o.heat]; }), [false, true, true, 'traffic'], 'the renderer got them');
    await context.close();
    noErrors('palette');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('resize', async () => {
    const { page, context } = await openApp();
    await loadExample(page);
    const width = () => page.evaluate(() => Math.round(document.querySelector('.side').getBoundingClientRect().width));
    eq(await width(), 360, 'default width');
    const handle = page.locator('.side__resize');
    eq(await handle.getAttribute('role'), 'separator', 'it is a separator');
    /** Press on the handle where it is now, drag to x, release. */
    const dragTo = async (x, { shotName } = {}) => {
      const box = await handle.boundingBox();
      const y = box.y + box.height / 2;
      await page.mouse.move(box.x + box.width / 2, y);
      await page.mouse.down();
      await page.mouse.move(x, y, { steps: 6 });
      if (shotName) await snap(page, shotName);
      await page.mouse.up();
    };
    const labels = () => page.locator('.side__bar .tab__label').evaluateAll((els) => els.filter((e) => e.getClientRects().length > 0).length);
    eq(await labels(), 1, 'a normal panel names only the open tab (the others are icons)');
    const edge = (await handle.boundingBox()).x + 4;
    await dragTo(edge - 100, { shotName: 'app-17-resizing-light' });
    const wide = await width();
    ok(Math.abs(wide - 460) < 6, `dragging the edge left widens the panel (${wide})`);
    eq(await page.evaluate(() => localStorage.getItem('logiplan:side-width')), String(wide), 'the width is remembered');
    await dragTo(1400);
    eq(await width(), 300, 'not narrower than 300');
    await dragTo(0);
    eq(await width(), 720, 'not wider than 720');
    eq(await labels(), 7, 'a wide panel names every tab');
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    eq(await width(), 704, 'ArrowRight narrows by 16');
    await page.keyboard.press('Home');
    eq(await width(), 300, 'Home: minimum');
    await page.keyboard.press('Enter');
    eq(await width(), 360, 'Enter: default');
    await page.keyboard.press('ArrowLeft');
    eq(await handle.getAttribute('aria-valuenow'), '376', 'the value is announced');
    await handle.dblclick();
    eq(await width(), 360, 'double click resets');
    await handle.focus();
    await page.keyboard.press('ArrowLeft');
    await page.reload();
    await page.waitForFunction(() => window.__logiplan);
    eq(await width(), 376, 'remembered after a reload');
    // the canvas follows
    const canvasWidth = await page.evaluate(() => document.getElementById('plant').clientWidth);
    const backing = await page.evaluate(() => document.getElementById('plant').width);
    eq(backing, canvasWidth, 'the canvas backing store matches its box');
    await context.close();
    noErrors('resize');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('persist', async () => {
    const { page, context } = await openApp();
    await loadExample(page);
    await page.locator('[data-tab=simulate]').click();
    await page.evaluate(() => window.__logiplan.store.commit('Rename plant', (d) => { d.name = 'Plant Ulm'; }));
    await page.getByRole('button', { name: 'Add a variant: a copy of the current one' }).click();
    await page.waitForTimeout(800); // the autosave waits 400 ms
    await page.reload();
    await page.waitForFunction(() => window.__logiplan && document.getElementById('app').dataset.state === 'ready');
    await page.waitForTimeout(500);
    const s = await state(page);
    eq(s.stations, 8, 'the plant is back');
    eq(s.scenarios, ['A', 'B'], 'with its variants');
    eq(s.tab, 'simulate', 'and the tab');
    eq(await page.locator('[role=dialog]').count(), 0, 'no welcome for a returning visitor');
    ok(!(await page.locator('.stage__empty').isVisible()), 'no empty hint');
    ok((await canvasHas(page, [245, 184, 46])) > 200, 'it is drawn');
    eq(await page.locator('.side__bar [role=tab][aria-selected=true]').getAttribute('data-tab'), 'simulate', 'the tab is selected');
    // a saved but empty plant is still a first visit
    const idle = await openApp({ welcome: true });
    await idle.page.keyboard.press('Escape');
    await idle.page.locator('[data-tab=fleet]').click();
    await idle.page.waitForTimeout(800);
    ok(await idle.page.evaluate(() => localStorage.getItem('logiplan:v1') !== null), 'something was saved (the tab choice)');
    await idle.page.reload();
    await idle.page.locator('[role=dialog]').waitFor();
    ok(true, 'an empty saved plant: the welcome dialog is offered again');
    eq((await state(idle.page)).tab, 'fleet', 'and the tab choice is back');
    await idle.context.close();
    // "don't show again"
    const fresh = await openApp({ welcome: true });
    await fresh.page.locator('[role=dialog]').waitFor();
    await fresh.page.getByLabel('Don’t show this again').check();
    await fresh.page.keyboard.press('Escape');
    await fresh.page.reload();
    await fresh.page.waitForFunction(() => window.__logiplan);
    await fresh.page.waitForTimeout(500);
    eq(await fresh.page.locator('[role=dialog]').count(), 0, "\"Don't show again\" is honoured");
    await fresh.context.close();
    // a corrupt save does not break the start
    const broken = await session();
    await broken.page.addInitScript(() => { localStorage.setItem('logiplan:v1', '{ not json'); });
    await broken.page.goto(url('/index.html'));
    await broken.page.waitForFunction(() => window.__logiplan);
    await broken.page.locator('.toast').first().waitFor();
    ok((await broken.page.locator('.toast').first().innerText()).includes('could not be read'), 'a corrupt save is reported');
    await broken.context.close();
    errors.splice(0); // the store reports the corrupt save through console.error, by design
    // storage that cannot be used at all (blocked cookies, some private modes): the app still works, and says it cannot save
    const blocked = await session();
    await blocked.page.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } }); });
    await blocked.page.goto(url('/index.html'));
    await blocked.page.waitForFunction(() => window.__logiplan && document.getElementById('app').dataset.state === 'ready');
    await blocked.page.locator('[role=dialog]').waitFor();
    await blocked.page.keyboard.press('Escape');
    await blocked.page.evaluate(async () => { await window.__logiplan.ctx.actions.loadExample('starter'); });
    await blocked.page.locator('[data-tool=road]').click();
    await blocked.page.waitForFunction(() => window.__logiplan.store.getState().ui.tool === 'road');
    await blocked.page.evaluate(() => window.__logiplan.store.commit('Rename plant', (d) => { d.notes = 'edit'; }));
    await blocked.page.waitForFunction(() => document.querySelector('.savechip__text').textContent === 'Not saved');
    ok((await blocked.page.locator('.savechip').getAttribute('title')).includes('No browser storage'), 'without storage the chip says so');
    const handle = blocked.page.locator('.side__resize');
    await handle.focus();
    await blocked.page.keyboard.press('ArrowLeft');
    eq(await handle.getAttribute('aria-valuenow'), '376', 'the panel still resizes');
    await blocked.context.close();
    await context.close();
    noErrors('persist');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('share', async () => {
    const a = await openApp();
    await loadExample(a.page, 'congestion-lab');
    const link = await a.page.evaluate(async () => {
      const { encodeShare } = await import('/js/model/serialize.js');
      return encodeShare(window.__logiplan.store.getState().project);
    });
    ok(/^[zp]\./.test(link), 'a share payload');
    await a.context.close();
    // a new visitor opens the link
    const b = await session();
    await b.page.goto(url(`/index.html#p=${link}`));
    await b.page.waitForFunction(() => window.__logiplan?.store.getState().layout.stations.length > 0);
    eq((await state(b.page)).name, 'Congestion lab', 'the shared plant is open');
    eq(await b.page.evaluate(() => location.hash), '', 'the address is cleaned');
    await b.page.waitForTimeout(300);
    eq(await b.page.locator('[role=dialog]').count(), 0, 'no welcome on top of a shared plant');
    ok((await b.page.locator('.toast').first().innerText()).includes('share link'), 'a toast says so');
    await snap(b.page, 'app-18-share-link-opened');
    // unsaved work: ask first, and keep it when declined
    await b.page.evaluate(() => window.__logiplan.store.commit('Rename plant', (d) => { d.name = 'My own work'; }));
    await b.page.evaluate((l) => { location.hash = `#p=${l}`; }, link);
    await b.page.locator('[role=dialog]').waitFor();
    ok((await b.page.locator('[role=dialog]').innerText()).includes('Open the shared plant?'), 'asks before replacing unsaved work');
    await b.page.getByRole('button', { name: 'Cancel' }).click();
    eq(await b.page.evaluate(() => window.__logiplan.store.getState().layout.name), 'My own work', 'declined: kept');
    eq(await b.page.evaluate(() => location.hash), '', 'the address is cleaned anyway');
    await b.page.evaluate((l) => { location.hash = `#p=${l}`; }, link);
    await b.page.locator('[role=dialog]').waitFor();
    await b.page.getByRole('button', { name: 'Open shared plant' }).click();
    await b.page.waitForFunction(() => window.__logiplan.store.getState().layout.name === 'Congestion lab');
    ok(true, 'accepted: replaced');
    // a damaged link
    await b.page.evaluate(() => { location.hash = '#p=z.not-a-real-link'; });
    await b.page.locator('.toast', { hasText: /damaged|newer version/ }).waitFor();
    ok(true, 'a damaged link is explained');
    await b.context.close();
    noErrors('share');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('failure', async () => {
    const { page, context } = await openApp();
    await loadExample(page);
    await page.evaluate(() => { window.__orig = window.__logiplan.ctx.issues; window.__logiplan.ctx.issues = () => { throw new Error('boom'); }; });
    await page.locator('[data-tab=checks]').click();
    await page.waitForTimeout(300);
    const card = page.locator('#panel-checks .panel-error');
    ok(await card.isVisible(), 'a failing panel shows an error card');
    ok((await card.innerText()).includes('The Checks panel stopped working'), 'in words');
    await snap(page, 'app-19-panel-error-light');
    eq(errors.length, 1, `one console.error, once (${errors.join(' | ').slice(0, 200)})`);
    ok(errors[0].includes('Checks panel'), 'it names the panel');
    errors.splice(0);
    await card.getByRole('button', { name: 'Reload panel' }).click();
    ok(await card.isVisible(), 'the panel still fails: the card stays');
    eq(errors.length, 0, 'the same error is not reported twice');
    // everything else keeps working
    await page.locator('[data-tab=fleet]').click();
    await frames(page);
    ok((await page.locator('#panel-fleet').innerText()).length > 30, 'the other panels work');
    await page.getByRole('button', { name: 'Run simulation' }).click();
    await page.waitForFunction(() => window.__logiplan.runner.time > 2);
    ok(true, 'the simulation runs');
    eq(await page.locator('.side__bar [role=tab]').count(), 7, 'the tab bar is intact');
    await page.evaluate(() => { window.__logiplan.ctx.issues = window.__orig; });
    await page.locator('[data-tab=checks]').click();
    await frames(page);
    await card.getByRole('button', { name: 'Reload panel' }).click();
    await page.waitForTimeout(200);
    eq(await page.locator('#panel-checks .panel-error').count(), 0, 'reloaded: the panel is back');
    ok((await page.locator('#panel-checks').innerText()).length > 20, 'with its content');
    // a panel that fails later, while updating
    await page.evaluate(() => { window.__logiplan.ctx.issues = () => { throw new Error('later'); }; });
    await page.evaluate(() => window.__logiplan.store.commit('Rename plant', (d) => { d.notes = 'new note'; }));
    await page.waitForSelector('#panel-checks .panel-error');
    ok(true, 'an update failure also becomes a card');
    ok(errors.length === 1 && errors[0].includes('later'), 'and is reported once');
    errors.splice(0);
    await page.evaluate(() => { window.__logiplan.ctx.issues = window.__orig; });
    await page.getByRole('button', { name: 'Pause simulation' }).click();
    await context.close();
    noErrors('failure');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('errors', async () => {
    const { page, context } = await openApp();
    await loadExample(page);
    const somethingWrong = () => page.locator('.toast', { hasText: 'Something went wrong' }).count();
    eq(await somethingWrong(), 0, 'no toast yet');
    // not ours: the benign ResizeObserver notice and a browser extension
    await page.evaluate(() => {
      window.dispatchEvent(new ErrorEvent('error', { message: 'ResizeObserver loop completed with undelivered notifications.' }));
      window.dispatchEvent(new ErrorEvent('error', { message: 'x is not defined', filename: 'chrome-extension://abc/content.js' }));
    });
    await page.waitForTimeout(150);
    eq(await somethingWrong(), 0, 'errors of extensions and the ResizeObserver notice are not toasted');
    // ours: one toast, however many errors follow
    await page.evaluate(() => { setTimeout(() => { throw new Error('first'); }); setTimeout(() => { throw new Error('second'); }); });
    await page.locator('.toast', { hasText: 'Something went wrong' }).waitFor();
    await page.evaluate(() => { Promise.reject(new Error('third')); });
    await page.waitForTimeout(300);
    eq(await somethingWrong(), 1, 'an uncaught error toasts once, an error storm does not pile up');
    ok((await page.locator('.toast', { hasText: 'Something went wrong' }).innerText()).includes('saved in this browser'), 'and says the work is safe');
    await snap(page, 'app-31-something-went-wrong');
    eq(errors.splice(0).length, 3, 'the page reported the three errors, nothing else');
    ok(await page.evaluate(() => window.__logiplan.runner.time >= 0), 'the app keeps working');
    await context.close();
    // an app that cannot be built says so instead of "Loading..." forever
    const broken = await session();
    await broken.page.route('**/index.html', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace('data-region="zoom"', 'data-region="zoom-missing"') });
    });
    await broken.page.goto(url('/index.html'));
    await broken.page.locator('[data-region=loading]', { hasText: 'could not start' }).waitFor();
    ok((await broken.page.locator('[data-region=loading]').innerText()).includes('"zoom" region'), 'the reason is shown');
    await snap(broken.page, 'app-32-start-failure');
    eq(errors.splice(0).length, 1, 'and logged once');
    await broken.context.close();
    noErrors('errors');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('drop', async () => {
    const { page, context } = await openApp();
    await loadExample(page);
    const drop = (selector, { files = true } = {}) => page.evaluate(([sel, withFiles]) => {
      const data = new DataTransfer();
      if (withFiles) data.items.add(new File(['{}'], 'plant.json', { type: 'application/json' }));
      else data.setData('text/plain', 'just text');
      const over = new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true });
      document.querySelector(sel).dispatchEvent(over);
      const drop = new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true });
      document.querySelector(sel).dispatchEvent(drop);
      return [over.defaultPrevented, drop.defaultPrevented];
    }, [selector, files]);
    eq(await drop('#plant'), [true, true], 'a file dropped on the plan does not make the browser leave the app');
    await page.locator('[role=dialog]').waitFor();
    ok((await page.locator('[role=dialog]').innerText()).includes('Import and export'), 'it opens the import dialog instead');
    ok((await page.locator('.toast', { hasText: 'drop it on the dashed area' }).count()) === 1, 'and says where to drop');
    await snap(page, 'app-33-file-drop');
    eq(await drop('[role=dialog]'), [true, true], 'dropping beside the drop area inside the dialog is refused too');
    eq(await page.locator('[role=dialog]').count(), 1, 'without opening a second dialog');
    await page.keyboard.press('Escape');
    eq(await drop('#plant', { files: false }), [false, false], 'text and links are none of our business');
    eq(await page.locator('[role=dialog]').count(), 0, 'no dialog for those');
    await context.close();
    noErrors('drop');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('unload', async () => {
    const { page, context } = await openApp();
    await loadExample(page);
    const dialogs = [];
    page.on('dialog', (d) => { dialogs.push(d.type()); d.accept(); });
    const leave = () => page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });
    eq(await leave(), false, 'clean project: no warning');
    await page.evaluate(() => window.__logiplan.store.commit('Rename plant', (d) => { d.notes = 'edit'; }));
    eq((await state(page)).dirty, true, 'dirty');
    eq(await leave(), false, 'dirty but the autosave holds it: no warning');
    eq(await page.evaluate(() => localStorage.getItem('logiplan:v1').includes('"edit"')), true, 'it was flushed to storage');
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); }; });
    await page.evaluate(() => window.__logiplan.store.commit('Rename plant', (d) => { d.notes = 'edit 2'; }));
    await page.waitForTimeout(100);
    eq(await leave(), true, 'dirty and the autosave cannot hold it: warn');
    await page.waitForTimeout(900);
    eq(await page.locator('.savechip__text').innerText(), 'Not saved', 'the chip says so');
    ok((await page.locator('.savechip').getAttribute('title')).includes('Click to download'), 'and what to do');
    await snap(page, 'app-20-not-saved-light');
    await page.reload().catch(() => {});
    await context.close();
    errors.splice(0);
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('subpath', async () => {
    // GitHub Pages serves a project site from /<repo>/: every URL of the app must be relative
    const { page, context } = await session();
    const first = requests.length;
    await context.route('**/repo-name/**', (route) => route.continue({ url: route.request().url().replace('/repo-name/', '/') }));
    await page.goto(url('/repo-name/index.html'));
    await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
    await page.locator('[role=dialog]').waitFor();
    await page.keyboard.press('Escape');
    await page.evaluate(async () => { await window.__logiplan.ctx.actions.loadExample('starter'); });
    await page.getByRole('button', { name: 'Run simulation' }).click();
    await page.waitForFunction(() => window.__logiplan.runner.time > 3); // the engine is loaded on demand: a relative import() too
    const strays = requests.slice(first).filter((u) => !u.includes('/repo-name/'));
    eq(strays, [], 'every request, stylesheets, scripts and the on-demand engine included, stays under the sub path');
    eq(await page.locator('.brand__logo').evaluate((img) => img.complete && img.naturalWidth > 0), true, 'the logo loads');
    ok(await page.evaluate(() => getComputedStyle(document.querySelector('.topbar')).display === 'flex'), 'layout.css loads');
    await context.close();
    noErrors('subpath');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('narrow', async () => {
    const { page, context } = await openApp({ viewport: NARROW, scale: 2, welcome: true });
    const dialog = page.locator('[role=dialog]');
    await dialog.waitFor();
    await snap(page, 'app-21-narrow-welcome-light');
    await dialog.locator('button', { hasText: 'Two production lines' }).first().click();
    await dialog.waitFor({ state: 'detached' });
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.stations.length > 0);
    await page.waitForTimeout(500);
    eq((await overflow(page)).doc <= 0, true, 'no horizontal page scroll');
    const layout = await page.evaluate(() => {
      const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right) }; };
      return { top: r('.topbar'), stage: r('.stage'), palette: r('.palette'), status: r('.statusbar'), side: r('.side'), vh: innerHeight, vw: innerWidth };
    });
    ok(layout.stage.top >= layout.top.bottom - 1 && layout.palette.top >= layout.stage.bottom - 1 && layout.status.top >= layout.palette.bottom - 1, 'top bar, stage, tools, status line stack');
    ok(layout.status.bottom <= layout.vh, '100 dvh: nothing below the screen');
    ok(layout.side.left >= layout.vw, 'the side panel waits outside the screen');
    await snap(page, 'app-22-narrow-example-light');
    // the tools are a labelled strip you can scroll
    const strip = await page.evaluate(() => { const p = document.querySelector('.palette'); return { scroll: p.scrollWidth > p.clientWidth, label: getComputedStyle(document.querySelector('.tool__label')).display }; });
    eq(strip, { scroll: true, label: 'block' }, 'a horizontal strip with visible labels');
    await page.locator('.palette [data-tool=flow]').scrollIntoViewIfNeeded();
    await page.locator('.palette [data-tool=flow]').click();
    eq((await state(page)).tool, 'flow', 'a tool at the end of the strip works');
    await page.locator('.palette [data-tool=select]').scrollIntoViewIfNeeded();
    await page.locator('.palette [data-tool=select]').click();
    // a closed drawer takes no keyboard focus
    await page.locator('.topbar__name').focus();
    const stopsInside = [];
    for (let i = 0; i < 45; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement.closest('.side') !== null)) stopsInside.push(i);
    }
    eq(stopsInside, [], 'Tab never enters the closed drawer');
    // the drawer
    const toggle = page.locator('.topbar__panel-toggle');
    eq(await toggle.getAttribute('aria-expanded'), 'false', 'closed at the start');
    await toggle.click();
    await page.waitForTimeout(400);
    eq(await toggle.getAttribute('aria-expanded'), 'true', 'open');
    const open = await page.evaluate(() => { const b = document.querySelector('.side').getBoundingClientRect(); return { right: Math.round(b.right), left: Math.round(b.left), vw: innerWidth, focus: document.activeElement?.dataset?.tab ?? null, scrim: !document.querySelector('.scrim').hidden }; });
    ok(open.right === open.vw && open.left > 0 && open.left < open.vw / 2, `a drawer from the right (${JSON.stringify(open)})`);
    eq([open.focus, open.scrim], ['properties', true], 'focus moves into it, a scrim covers the plan');
    await snap(page, 'app-23-narrow-drawer-light');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    eq(await toggle.getAttribute('aria-expanded'), 'false', 'Esc closes it');
    ok(await page.evaluate(() => document.activeElement === document.querySelector('.topbar__panel-toggle')), 'and returns focus to the button');
    await toggle.click();
    await page.locator('.side__close').click();
    await page.waitForTimeout(400);
    eq(await toggle.getAttribute('aria-expanded'), 'false', 'the close button');
    await toggle.click();
    await page.mouse.click(10, 400);
    await page.waitForTimeout(400);
    eq(await toggle.getAttribute('aria-expanded'), 'false', 'a tap on the scrim');
    // every tab can be reached
    await toggle.click();
    for (const id of TAB_IDS) {
      await page.locator(`.side__bar [data-tab=${id}]`).click();
      await page.waitForTimeout(200);
      ok(await page.locator(`#panel-${id}`).isVisible(), `${id} is visible in the drawer`);
      ok((await overflow(page)).doc <= 0, `${id}: no horizontal page scroll`);
    }
    await page.locator('.side__bar [data-tab=results]').click();
    await snap(page, 'app-24-narrow-results-light');
    // setRightTab opens the drawer, focus() closes it
    await page.locator('.side__close').click();
    await page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('fleet'));
    await page.waitForTimeout(400);
    eq(await toggle.getAttribute('aria-expanded'), 'true', 'setRightTab opens the drawer');
    await page.evaluate(() => window.__logiplan.ctx.actions.focus({ stationIds: [window.__logiplan.store.getState().layout.stations[0].id] }));
    await page.waitForTimeout(400);
    eq(await toggle.getAttribute('aria-expanded'), 'false', 'focus() closes it so the plan is visible');
    // top bar: menus and the variants row
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.waitForTimeout(150);
    const more = await page.getByRole('menuitem').allInnerTexts();
    ok(more.some((t) => t.startsWith('Examples')) && more.some((t) => t.startsWith('Share')) && more.some((t) => t.startsWith('Project file')) && more.some((t) => t.startsWith('Help')), 'the overflow menu has the top-bar actions');
    eq(await page.getByRole('menuitemradio').count(), 3, 'and the theme choices');
    const menuBox = await page.locator('.topbar [role=menu]').boundingBox();
    ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= 390 && menuBox.y + menuBox.height <= 800, `the menu is on screen (${JSON.stringify(menuBox)})`);
    await snap(page, 'app-25-narrow-menu-light');
    await page.keyboard.press('Escape');
    // the same in the dark
    await page.evaluate(() => window.__logiplan.store.setUi({ theme: 'dark' }));
    await page.waitForTimeout(300);
    await snap(page, 'app-26-narrow-dark');
    await page.locator('.topbar__panel-toggle').click();
    await page.locator('.side__bar [data-tab=checks]').click();
    await page.waitForTimeout(400);
    await snap(page, 'app-26b-narrow-dark-drawer');
    await page.locator('.side__close').click();
    await page.waitForTimeout(400);
    // a window that grows past 900 px drops the drawer
    await toggle.click();
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.waitForTimeout(400);
    eq(await page.evaluate(() => [document.getElementById('app').classList.contains('is-drawer-open'), document.querySelector('.scrim').hidden]), [false, true], 'wide again: no drawer state left behind');
    ok(await page.locator('.side').isVisible(), 'the panel is a column again');
    await context.close();
    noErrors('narrow');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('widths', async () => {
    const { page, context } = await openApp();
    await loadExample(page);
    for (const w of [1920, 1440, 1240, 1239, 1100, 960, 900, 899, 700, 600, 480, 390, 360]) {
      await page.setViewportSize({ width: w, height: 800 });
      await page.waitForTimeout(250);
      const info = await page.evaluate(() => {
        const inView = (el) => { const b = el.getBoundingClientRect(); return b.width > 0 && b.left >= -0.5 && b.right <= innerWidth + 0.5; };
        const bar = document.querySelector('.topbar');
        const shown = [...bar.querySelectorAll('button, input, a')].filter((e) => e.getClientRects().length > 0);
        return { doc: document.documentElement.scrollWidth - innerWidth, topbar: bar.scrollWidth - bar.clientWidth, clipped: shown.filter((e) => !inView(e)).map((e) => e.getAttribute('aria-label') || e.textContent), bottom: document.querySelector('.statusbar').getBoundingClientRect().bottom, vh: innerHeight, canvas: [document.getElementById('plant').clientWidth, document.getElementById('plant').width / (devicePixelRatio || 1)] };
      });
      ok(info.doc <= 0 && info.topbar <= 0, `${w}: no horizontal overflow (${JSON.stringify(info)})`);
      eq(info.clipped, [], `${w}: every top-bar control is on screen`);
      ok(info.bottom <= info.vh + 0.5, `${w}: the status line is on screen`);
      eq(Math.round(info.canvas[0]), Math.round(info.canvas[1]), `${w}: the canvas matches its box`);
      if ([1440, 1100, 900, 899, 600].includes(w)) await snap(page, `app-27-width-${w}-light`);
    }
    // short windows: the status line steps aside in landscape phones, the tools scroll on a short desktop window
    await page.setViewportSize({ width: 800, height: 420 });
    await page.waitForTimeout(250);
    eq(await page.locator('.statusbar').isVisible(), false, 'a phone held sideways: no status line');
    ok((await overflow(page)).doc <= 0, 'and no overflow');
    await snap(page, 'app-28b-landscape-phone-light');
    await page.setViewportSize({ width: 1280, height: 560 });
    await page.waitForTimeout(250);
    eq(await page.evaluate(() => getComputedStyle(document.querySelector('.palette')).overflowY), 'auto', 'a short desktop window scrolls the tool column');
    await snap(page, 'app-28-short-window-light');
    await context.close();
    noErrors('widths');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('print', async () => {
    const { page, context } = await openApp();
    await loadExample(page);
    await page.emulateMedia({ media: 'print' });
    await page.waitForTimeout(300);
    const hidden = await page.evaluate(() => ['.topbar', '.palette', '.side', '.statusbar', '.stage__top', '.stage__zoom', '.toast-region'].map((s) => getComputedStyle(document.querySelector(s)).display));
    eq(hidden, ['none', 'none', 'none', 'none', 'none', 'none', 'none'], 'print hides the chrome');
    ok(await page.locator('#plant').isVisible(), 'the plan stays');
    await snap(page, 'app-29-print-view');
    await page.emulateMedia({ media: 'screen' });
    await context.close();
    noErrors('print');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('a11y', async () => {
    const { page, context } = await openApp();
    await loadExample(page);
    for (const id of TAB_IDS) {
      await page.locator(`[data-tab=${id}]`).click();
      await page.waitForTimeout(200);
      const bad = await page.evaluate(() => {
        const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby'))?.textContent || el.labels?.[0]?.textContent || el.textContent || el.title || el.placeholder || '').trim();
        const controls = [...document.querySelectorAll('button, [role=tab], [role=separator][tabindex], select, input:not([type=hidden]), textarea, a[href]')].filter((e) => e.getClientRects().length > 0);
        return controls.filter((e) => !name(e)).map((e) => `${e.tagName}.${e.className}`);
      });
      eq(bad, [], `${id}: every control has an accessible name`);
    }
    const ids = await page.evaluate(() => { const seen = new Map(); for (const el of document.querySelectorAll('[id]')) seen.set(el.id, (seen.get(el.id) || 0) + 1); return [...seen].filter(([, n]) => n > 1).map(([id]) => id); });
    eq(ids, [], 'no duplicate ids');
    // keyboard: the first Tab stops are the skip link, the brand, the name; the plan canvas is reachable
    await page.waitForTimeout(700);
    await page.reload();
    await page.waitForFunction(() => window.__logiplan && document.getElementById('app').dataset.state === 'ready');
    await page.keyboard.press('Tab');
    ok(await page.evaluate(() => document.activeElement.classList.contains('skip-link')), 'the skip link comes first');
    await page.keyboard.press('Enter');
    ok(await page.evaluate(() => document.activeElement.id === 'plant'), 'and takes you to the plan');
    eq(await page.evaluate(() => location.hash), '', 'without changing the address');
    // every tab stop shows a focus ring
    const stops = [];
    await page.locator('.topbar a.brand').focus();
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        const cs = getComputedStyle(el);
        return { who: `${el.tagName}.${el.className}|${el.getAttribute('aria-label') ?? el.textContent.trim().slice(0, 20)}`, ring: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 || cs.boxShadow !== 'none', body: el === document.body };
      });
      if (info.body) break;
      stops.push(info);
    }
    ok(stops.length > 20, `plenty of tab stops (${stops.length})`);
    eq(stops.filter((s) => !s.ring).map((s) => s.who), [], 'every tab stop shows a focus ring');
    // forced colours and reduced motion do not break the shell
    await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
    await page.waitForTimeout(300);
    await snap(page, 'app-30-forced-colors');
    await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' });
    await context.close();
    noErrors('a11y');
  });

  console.log(`\n${checks} checks passed`);
});
