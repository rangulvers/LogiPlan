// Dock choice in the REAL app (index.html + js/main.js) in real Chromium: the plant of the bug report (a Goods in and a Goods out with three
// docking spurs each off one main road) is loaded and run, and what a planner sees is checked.
//
//   overlay    the Jobs overlay marks every dock at the station edge: hollow = free, ring = a vehicle is on its way, filled = a vehicle stands
//              on it (read back from the canvas pixels at the marker positions); off with the Jobs switch; light and dark; cheap to draw
//   results    the Results tab lists the docks of every used station with a bar for how busy each was and its visits: all three docks of the
//              Goods in and the Goods out are used with 4 AGVs; a click on the station name selects it on the plan
//   insight    a saturated single dock says so in the insights ("Vehicles queue at ...: its only dock is busy ...") and the plant of the report,
//              fixed, says nothing about docks
//   help       the Help page "How vehicles find work" explains which dock a vehicle uses
//
// Run: node tests/e2e/docks.mjs [section]      Screenshots: e2e-output/docks-*.png (open them and look).
import assert from 'node:assert/strict';
import path from 'node:path';
import { withBrowser, OUT } from './browser.mjs';
import { layoutFromAscii } from '../helpers/ascii.js';

const only = process.argv[2] || '';
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

const W = 22;
const row = (f) => Array.from({ length: W }, (_, x) => f(x)).join('');
const SPURS = [
  row((x) => (x >= 1 && x <= 9 ? 'A' : x >= 11 && x <= 19 ? 'B' : '.')),
  row((x) => (x >= 1 && x <= 9 ? 'A' : x >= 11 && x <= 19 ? 'B' : '.')),
  row((x) => ([2, 5, 8, 12, 15, 18].includes(x) ? '+' : '.')),
  row((x) => (x >= 1 && x <= 20 ? '+' : '.')),
];
const plant = (lines, vehicles, interArrival, name) => {
  const layout = layoutFromAscii(lines, {
    stations: { A: { type: 'source', name: 'Goods in', params: { interArrival: { kind: 'const', mean: interArrival, spread: 0 }, outCap: 20 } }, B: { type: 'sink', name: 'Goods out' } },
    flows: [['A', 'B']],
    fleets: [{ count: vehicles, preset: 'agv', loadTime: 12, unloadTime: 12, idle: 'stay' }],
    settings: { warmup: 0, seed: 3 },
  });
  layout.name = name;
  layout.stations.find((s) => s.id === 'A').name = 'Goods in';
  layout.stations.find((s) => s.id === 'B').name = 'Goods out';
  return layout;
};
const THREE_SPURS = plant(SPURS, 4, 20, 'Three spurs');
const ONE_SPUR = plant(['AAA...BBB', 'AAA...BBB', '.+.....+.', '.+++++++.'], 4, 15, 'One spur each');

await withBrowser(async ({ browser, url, errors }) => {
  const origin = new URL(url('/')).origin;
  const foreign = [];
  const frames = (page, n = 2) => page.evaluate((count) => new Promise((resolve) => {
    const next = (left) => (left ? requestAnimationFrame(() => next(left - 1)) : resolve());
    next(count);
  }), n);
  const noErrors = (what) => { eq(errors.splice(0).filter((e) => !/willReadFrequently/.test(e)), [], `${what}: console errors or warnings`); };

  async function open({ layout, theme = 'light', viewport = { width: 1440, height: 900 } }) {
    const context = await browser.newContext({ viewport, colorScheme: theme, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[console.${m.type()}] ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    page.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
    page.on('request', (r) => { if (!r.url().startsWith(origin) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) foreign.push(r.url()); });
    await page.goto(url('/index.html'));
    await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
    await page.locator('[role=dialog]').first().waitFor();
    await page.keyboard.press('Escape');
    await page.locator('[role=dialog]').waitFor({ state: 'detached' });
    await page.evaluate((l) => window.__logiplan.store.replaceLayout(l, { label: 'Load plant' }), layout);
    await frames(page, 3);
    return { context, page };
  }

  async function run(name, fn) {
    if (only && only !== name) return;
    const t0 = Date.now();
    await fn();
    noErrors(name);
    console.log(`  ok  ${name} (${Math.round((Date.now() - t0) / 100) / 10} s)`);
  }

  const step = (page, seconds) => page.evaluate(async (s) => { await window.__logiplan.runner.step(s); }, seconds);
  const zoomTo = async (page, ppm) => {
    await page.evaluate((z) => {
      const { ctx, store } = window.__logiplan;
      const cs = store.getState().layout.grid.cellSize;
      ctx.camera.zoomTo(z, ctx.canvas.clientWidth / 2, ctx.canvas.clientHeight / 2);
      ctx.camera.centerOn(11 * cs, 2 * cs);
    }, ppm);
    await frames(page, 3);
  };

  /** Dock markers where the overlay puts them (on the cell, 0.36 cells toward the station), with the status of the dock and the page position. */
  const markers = (page) => page.evaluate(() => {
    const { runner, ctx } = window.__logiplan;
    const sim = runner.sim;
    const g = sim.graph;
    const cs = g.cellSize;
    const r = ctx.canvas.getBoundingClientRect();
    return sim.logistics.docks.cellList.map((cell) => {
      const st = sim.layout.stations.find((s) => s.id === (g.stationsAt.get(cell.node) || [])[0]);
      const x = g.x(cell.node);
      const y = g.y(cell.node);
      const dx = x < st.x * cs ? 1 : x > (st.x + st.w) * cs ? -1 : 0;
      const dy = y < st.y * cs ? 1 : y > (st.y + st.h) * cs ? -1 : 0;
      const [px, py] = ctx.camera.worldToScreen(x + dx * 0.36 * cs, y + dy * 0.36 * cs);
      return { node: cell.node, status: sim.logistics.docks.status(cell.node), x: r.left + px, y: r.top + py };
    });
  });

  /** The colours of the 11 x 11 pixels around page point (x, y) of the plan canvas (a marker is a ring of about 3 px radius). */
  const around = (page, x, y) => page.evaluate(([px, py]) => {
    const { canvas } = window.__logiplan.ctx;
    const r = canvas.getBoundingClientRect();
    const s = canvas.width / r.width;
    const d = canvas.getContext('2d').getImageData(Math.round((px - r.left) * s) - 5, Math.round((py - r.top) * s) - 5, 11, 11).data;
    const out = [];
    for (let i = 0; i < d.length; i += 4) out.push([d[i], d[i + 1], d[i + 2]]);
    return out;
  }, [x, y]);
  const isGreen = ([r, g, b]) => g > 140 && r < 90 && b < 140 && g - r > 60;
  const isAmber = ([r, g, b]) => r > 200 && g > 120 && g < 200 && b < 90;
  const isLight = ([r, g, b]) => r > 200 && g > 200 && b > 200;

  // ---- the Jobs overlay marks the docks -----------------------------------------------------------------------------

  await run('overlay', async () => {
    for (const theme of ['light', 'dark']) {
      const { context, page } = await open({ layout: THREE_SPURS, theme });
      await step(page, 400);
      await zoomTo(page, 30);
      // look at several moments: markers of all three kinds must show up, each in its own colour
      const seen = { free: 0, reserved: 0, occupied: 0 };
      const fine = { free: 0, reserved: 0, occupied: 0 };
      for (let k = 0; k < 40; k++) {
        await step(page, 7);
        await frames(page, 2);
        for (const m of await markers(page)) {
          seen[m.status]++;
          const px = await around(page, m.x, m.y);
          if (m.status === 'occupied' && px.some(isGreen)) fine.occupied++;
          if (m.status === 'reserved' && px.some(isAmber)) fine.reserved++;
          if (m.status === 'free' && px.some(isLight)) fine.free++;
        }
      }
      ok(seen.free > 20 && seen.reserved > 3 && seen.occupied > 10, `${theme}: free, reserved and occupied docks all occur: ${JSON.stringify(seen)}`);
      ok(fine.occupied >= 0.8 * seen.occupied, `${theme}: an occupied dock shows a filled green dot (${fine.occupied} of ${seen.occupied})`);
      ok(fine.reserved >= 0.7 * seen.reserved, `${theme}: a reserved dock shows an amber ring (${fine.reserved} of ${seen.reserved})`);
      ok(fine.free >= 0.8 * seen.free, `${theme}: a free dock shows a light outline (${fine.free} of ${seen.free})`);
      await page.screenshot({ path: path.join(OUT, `docks-overlay-${theme}.png`) });
      // the Jobs switch hides them
      await page.evaluate(() => { const s = window.__logiplan.store; s.setUi({ overlays: { ...s.getState().ui.overlays, jobs: false } }); });
      await frames(page, 3);
      const free = (await markers(page)).filter((m) => m.status === 'free');
      ok(free.length > 0);
      let lit = 0;
      for (const m of free) if ((await around(page, m.x, m.y)).filter(isLight).length >= 6) lit++;
      ok(lit <= Math.floor(free.length / 3), `${theme}: with the Jobs overlay off no hollow dot is left (${lit} of ${free.length})`);
      await context.close();
    }
  });

  await run('perf', async () => {
    const { context, page } = await open({ layout: THREE_SPURS });
    await step(page, 400);
    await zoomTo(page, 30);
    const ms = await page.evaluate(async () => {
      const { runner } = window.__logiplan;
      const jobs = await import('/js/ui/render/jobs.js');
      const sim = runner.sim;
      const cs = sim.graph.cellSize;
      const g = document.createElement('canvas').getContext('2d');
      const scene = { stationById: new Map(sim.layout.stations.map((s) => [s.id, { x: s.x * cs, y: s.y * cs, w: s.w * cs, h: s.h * cs }])) };
      const fr = { theme: { dock: '#ffffff' }, scene, sim, zoom: 30, cs, ox: 0, oy: 0, w: 1400, h: 900 };
      for (let i = 0; i < 50; i++) jobs.drawDockMarkers(g, fr, sim);
      const t0 = performance.now();
      for (let i = 0; i < 500; i++) jobs.drawDockMarkers(g, fr, sim);
      return (performance.now() - t0) / 500;
    });
    ok(ms < 0.3, `drawing the markers of a six-dock plant takes ${ms.toFixed(3)} ms per frame`);
    await context.close();
  });

  // ---- the Results tab lists the docks ----------------------------------------------------------------------------------

  await run('results', async () => {
    const { context, page } = await open({ layout: THREE_SPURS });
    await step(page, 1800);
    await page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('results'));
    await frames(page, 4);
    const sec = page.locator('details[data-section=docks]');
    await sec.waitFor();
    if (!(await sec.evaluate((e) => e.open))) await sec.locator('summary').click();
    await frames(page, 3);
    const rows = await sec.evaluate((e) => [...e.querySelectorAll('[data-dock-station]')].map((li) => ({
      id: li.dataset.dockStation,
      name: li.querySelector('.dash-link').textContent,
      docks: [...li.querySelectorAll('.dash-docks__dock')].map((d) => ({ cell: d.querySelector('.dash-docks__cell').textContent, text: d.querySelector('.dash-docks__val').textContent, aria: d.querySelector('[role=img]').getAttribute('aria-label'), w: d.querySelector('.progress__bar').style.getPropertyValue('--w') })),
    })));
    eq(rows.map((r) => r.name).sort(), ['Goods in', 'Goods out'], 'a block per station that was used');
    for (const r of rows) {
      eq(r.docks.length, 3, `${r.name}: its three docks are listed`);
      const visits = r.docks.map((d) => Number(/(\d+) visits?/.exec(d.text)[1]));
      ok(visits.filter((v) => v >= 20).length >= 2, `${r.name}: at least two docks were used a lot (${visits})`);
      ok(r.docks.every((d) => /^\d+(\.\d)? % · \d+ visits?( · idle vehicle on it \d+(\.\d)? %)?$/.test(d.text) && /^Dock \(\d+, \d+\): busy \d+(\.\d)? % of the time, \d+ visits?(, idle vehicle on it \d+(\.\d)? % of the time)?$/.test(d.aria)), `${r.name}: readable text and label ${r.docks[0].text} / ${r.docks[0].aria}`);
      ok(r.docks.some((d) => parseInt(d.w, 10) > 15), `${r.name}: a bar for a busy dock`);
    }
    await page.screenshot({ path: path.join(OUT, 'docks-results.png') });
    // a click on the station name selects it on the plan
    await sec.locator('[data-dock-station="B"] .dash-link').click();
    await frames(page, 2);
    eq(await page.evaluate(() => window.__logiplan.store.getState().ui.selection), { kind: 'station', ids: ['B'] }, 'the station is selected');
    await context.close();
  });

  await run('insight', async () => {
    // the plant of the report, fixed: nothing to say about docks
    const fixed = await open({ layout: THREE_SPURS });
    await step(fixed.page, 3600);
    const ids = await fixed.page.evaluate(() => window.__logiplan.runner.insights().map((i) => i.id));
    ok(!ids.some((id) => id.startsWith('dock')), `no dock insight for the fixed plant: ${ids}`);
    await fixed.context.close();
    // one dock per station, saturated: the queue is named
    const { context, page } = await open({ layout: ONE_SPUR });
    await step(page, 3600);
    const found = await page.evaluate(() => window.__logiplan.runner.insights().filter((i) => i.id.startsWith('dock')).map((i) => ({ id: i.id, title: i.title, suggestion: i.suggestion })));
    ok(found.length >= 1, 'a dock insight');
    const hit = found.find((i) => i.id === 'dock-bottleneck:B') || found[0];
    ok(/^Vehicles queue at Goods out: its only dock is busy \d+ % of the time and vehicles waited/.test(hit.title), hit.title);
    ok(/Add a second dock - any road cell touching the station - or a bypass bay\./.test(hit.suggestion), hit.suggestion);
    await page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('results'));
    await frames(page, 4);
    const text = await page.locator('[data-panel=dashboard]').innerText();
    ok(text.includes('Vehicles queue at Goods out'), 'and the Results tab shows it');
    await page.screenshot({ path: path.join(OUT, 'docks-insight.png') });
    await context.close();
  });

  await run('help', async () => {
    const { context, page } = await open({ layout: THREE_SPURS });
    await page.evaluate(() => window.__logiplan.ctx.dialogs.openHelp({ tab: 'vehicles' }));
    await page.locator('[role=dialog]').waitFor();
    eq(await page.locator('[role=dialog] [role=tab][aria-selected=true]').innerText(), 'How vehicles find work');
    await frames(page, 3);
    const text = await page.locator('[role=dialog]').innerText();
    for (const phrase of ['Which dock does a vehicle use?', 'soonest', 'more docks mean more vehicles loading at the same time', 'hollow when it is free']) ok(text.includes(phrase), `the page says: ${phrase}`);
    await page.screenshot({ path: path.join(OUT, 'docks-help.png') });
    await context.close();
  });

  eq(foreign, [], 'no request leaves the app');
}, { viewport: { width: 1440, height: 900 } });

console.log(`docks.mjs: ${checks} checks passed`);
