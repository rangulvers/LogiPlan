// Canvas guidance in the REAL app (index.html + js/main.js) in real Chromium, driven with real mouse, keyboard and touch input:
// how a planner connects stations on the plan and sees where vehicles are heading.
//
//   handle     select a Goods in: the flow handle shows on the edge facing its nearest destination, with hover text
//   drag       drag from the handle to the Assembly: rubber band, glowing targets, flow created, selected, undoable
//   invalid    release on a station that cannot receive, on empty ground, on a pair that is connected already
//   click      click the handle (no drag): connect mode; click the target; Esc cancels; wrong clicks keep or end it
//   placement  place a Goods in / Goods out: toast with a Connect action that starts connect mode
//   flowtool   the Flow tool highlights valid receivers too
//   jobs       run the plant: dashed lines from vehicles to their docks, "n waiting" badge on a Goods in nobody collects
//              from (flow restricted to a fleet without vehicles), light and dark, 20 and 60 px per metre, the Jobs toggle
//   touch      the same by finger (handle drag, tap), larger handle on a coarse pointer
//   narrow     390 px wide: nothing overflows, handle and badges are visible
//   perf       the jobs overlay costs well under a frame
//
// Run: node tests/e2e/guidance-canvas.mjs [section]      Screenshots: e2e-output/guidance-canvas-*.png (open them and look).
import assert from 'node:assert/strict';
import path from 'node:path';
import { withBrowser, OUT } from './browser.mjs';

const only = process.argv[2] || '';
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

const DESKTOP = { width: 1440, height: 900 };
const NARROW = { width: 390, height: 800 };
const HANDLE_HINT = 'Drag to another station to send loads there';
const CREATED = 'Flow created. Vehicles will serve it automatically.';
// a second input into the Assembly adds one sentence: the workstation then waits for both
const CREATED_BOTH = `${CREATED} Assembly now needs a load from both of its inputs before every cycle.`;

await withBrowser(async ({ browser, url, errors }) => {
  const origin = new URL(url('/')).origin;
  const foreign = [];

  // ---- plumbing -------------------------------------------------------------------------------------------------

  async function session({ viewport = DESKTOP, colorScheme = 'light', hasTouch = false, isMobile = false } = {}) {
    const context = await browser.newContext({ viewport, colorScheme, hasTouch, isMobile, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[console.${m.type()}] ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    page.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
    page.on('request', (r) => { if (!r.url().startsWith(origin) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) foreign.push(r.url()); });
    return { context, page };
  }

  /**
   * Open the app with a prepared plant: the Starter (s1 Goods receiving, s2 Assembly, s3 Dispatch, s4 AGV parking) plus
   * Goods in 2 (s5), which touches the loop road but has no flow yet. `restricted` also gives it a flow to Dispatch that only
   * a fleet without vehicles may serve, so its loads wait for a vehicle that never comes.
   */
  async function openPlant({ restricted = false, extra = true, theme = 'light', ...rest } = {}) {
    const s = await session({ colorScheme: theme, ...rest });
    const { page } = s;
    await page.goto(url('/index.html'));
    await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
    await page.locator('[role=dialog]').first().waitFor();
    await page.keyboard.press('Escape');
    await page.locator('[role=dialog]').waitFor({ state: 'detached' });
    const built = await page.evaluate(async (opts) => {
      const { store } = window.__logiplan;
      const { EXAMPLES } = await import('/js/model/examples.js');
      const L = await import('/js/model/layout.js');
      const layout = EXAMPLES.find((e) => e.id === 'starter').build();
      if (opts.extra) {
        const s5 = L.addStation(layout, { type: 'source', x: 14, y: 7, w: 3, h: 2, name: 'Goods in 2' });
        if (!s5) return 'could not place Goods in 2';
        if (opts.restricted) {
          const fleet = L.addFleet(layout, 'forklift', { count: 0, name: 'Forklift' });
          if (!L.addFlow(layout, 's5', 's3', { fleetId: fleet.id })) return 'could not add the restricted flow';
        }
      }
      store.loadProject({ name: 'Canvas guidance', scenarios: [{ id: 'sc1', name: 'A', layout }], activeId: 'sc1' });
      return 'ok';
    }, { restricted, extra });
    assert.equal(built, 'ok');
    await frames(page, 3);
    return s;
  }

  const frames = (page, n = 2) => page.evaluate((count) => new Promise((resolve) => {
    const next = (left) => (left ? requestAnimationFrame(() => next(left - 1)) : resolve());
    next(count);
  }), n);
  const snap = (page, name, opts = {}) => page.screenshot({ path: path.join(OUT, `guidance-canvas-${name}.png`), ...opts });
  // the pixel readbacks of this script itself make Chromium warn about willReadFrequently: that is not the app's
  const noErrors = (what) => { eq(errors.splice(0).filter((e) => !/willReadFrequently/.test(e)), [], `${what}: console errors or warnings`); };
  const layoutOf = (page) => page.evaluate(() => structuredClone(window.__logiplan.store.getState().layout));
  const stateOf = (page) => page.evaluate(() => {
    const s = window.__logiplan.store.getState();
    return { canUndo: s.canUndo, canRedo: s.canRedo, undoLabel: s.undoLabel, tool: s.ui.tool, selection: structuredClone(s.ui.selection), overlays: structuredClone(s.ui.overlays) };
  });
  const flowPairs = async (page) => (await layoutOf(page)).flows.map((f) => `${f.from}>${f.to}`);
  const status = (page) => page.evaluate(() => document.querySelector('[data-region=status-text]')?.textContent || '');
  const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('.toast .toast__msg')].map((t) => t.textContent));
  const clearToasts = (page) => page.evaluate(() => document.querySelectorAll('.toast__close').forEach((b) => b.click()));
  const viewOf = (page) => page.evaluate(() => {
    const v = window.__logiplan.ctx.renderer.view;
    const c = v.connect;
    return {
      handle: v.connectHandle ? { ...v.connectHandle } : null,
      connect: c ? { role: c.role, anchorId: c.anchorId, valid: [...c.valid].sort(), exists: [...c.exists].sort(), over: c.over, overStatus: c.overStatus, snap: c.snap, verb: c.verb } : null,
      flowPreview: v.flowPreview ? structuredClone(v.flowPreview) : null,
    };
  });
  const cursorOf = (page) => page.evaluate(() => document.getElementById('plant').style.cursor);

  /** Page coordinates of a point inside grid cell (cx, cy); (fx, fy) in 0..1 is the position within the cell. */
  const cellXY = (page, cx, cy, fx = 0.5, fy = 0.5) => page.evaluate(([x, y, a, b]) => {
    const { camera, canvas } = window.__logiplan.ctx;
    const cs = window.__logiplan.store.getState().layout.grid.cellSize;
    const [px, py] = camera.worldToScreen((x + a) * cs, (y + b) * cs);
    const r = canvas.getBoundingClientRect();
    return [r.left + px, r.top + py];
  }, [cx, cy, fx, fy]);

  /**
   * Page coordinates of the centre of the flow handle (found through the renderer's own hit test, scanning around the selected
   * station), plus the number of 2 px sample points that hit it, or null.
   */
  const findHandle = (page) => page.evaluate(() => {
    const { ctx, store } = window.__logiplan;
    const state = store.getState();
    const s = state.ui.selection.kind === 'station' ? state.layout.stations.find((e) => e.id === state.ui.selection.ids[0]) : null;
    const r = ctx.canvas.getBoundingClientRect();
    let x0 = 0;
    let y0 = 0;
    let x1 = r.width;
    let y1 = r.height;
    if (s) {
      const cs = state.layout.grid.cellSize;
      const a = ctx.camera.worldToScreen(s.x * cs, s.y * cs);
      const b = ctx.camera.worldToScreen((s.x + s.w) * cs, (s.y + s.h) * cs);
      x0 = Math.max(0, a[0] - 70);
      y0 = Math.max(0, a[1] - 70);
      x1 = Math.min(r.width, b[0] + 70);
      y1 = Math.min(r.height, b[1] + 70);
    }
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let y = y0; y < y1; y += 2) {
      for (let x = x0; x < x1; x += 2) {
        if (ctx.renderer.hitTest(x, y).kind === 'connect-handle') { sx += x; sy += y; n++; }
      }
    }
    return n ? [r.left + sx / n, r.top + sy / n, n] : null;
  });

  /** Press at `from`, move through `via` to `to`, and release unless `keep`. Points are [x, y] page coordinates. */
  async function drag(page, from, to, { via = [], steps = 10, keep = false } = {}) {
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    for (const p of via) await page.mouse.move(p[0], p[1], { steps });
    await page.mouse.move(to[0], to[1], { steps });
    if (!keep) {
      await page.mouse.up();
      await frames(page);
    }
  }

  /** Select Goods in 2 with a real click on its brick. */
  async function selectGoodsIn2(page) {
    const [x, y] = await cellXY(page, 15, 7, 0.5, 0.5);
    await page.mouse.click(x, y);
    await frames(page);
    eq((await stateOf(page)).selection, { kind: 'station', ids: ['s5'] }, 'Goods in 2 is selected');
  }

  async function setZoom(page, ppm, atWorld) {
    await page.evaluate(([z, w]) => {
      const { camera, canvas } = window.__logiplan.ctx;
      camera.zoomTo(z, canvas.clientWidth / 2, canvas.clientHeight / 2);
      if (w) camera.centerOn(w[0], w[1]);
    }, [ppm, atWorld || null]);
    await frames(page, 3);
  }

  /** Colour (r, g, b) of the plan canvas at page point (x, y). */
  const pixel = (page, x, y) => page.evaluate(([px, py]) => {
    const { canvas } = window.__logiplan.ctx;
    const r = canvas.getBoundingClientRect();
    const s = canvas.width / r.width;
    const d = canvas.getContext('2d').getImageData(Math.round((px - r.left) * s), Math.round((py - r.top) * s), 1, 1).data;
    return [d[0], d[1], d[2]];
  }, [x, y]);

  async function run(name, fn) {
    if (only && only !== name) return;
    const t0 = Date.now();
    await fn();
    noErrors(name);
    console.log(`  ok  ${name} (${Math.round((Date.now() - t0) / 100) / 10} s)`);
  }

  // ---- the flow handle -----------------------------------------------------------------------------------------------

  await run('handle', async () => {
    const { page, context } = await openPlant();
    eq((await viewOf(page)).handle, null, 'nothing selected: no handle');
    await selectGoodsIn2(page);
    const v = await viewOf(page);
    eq(v.handle && v.handle.id, 's5', 'the handle belongs to the selected Goods in');
    const found = await findHandle(page);
    ok(found, 'the renderer reports the handle as a hit of kind connect-handle');
    const [hx, hy] = found;
    const [sx, sy] = await cellXY(page, 15, 8, 0.5, 1); // bottom edge of Goods in 2: the Assembly is below and to the right
    ok(hy > sy && Math.abs(hx - sx) < 12, `the handle sits below the station, on the edge that faces the Assembly (handle ${Math.round(hx)},${Math.round(hy)}, edge ${Math.round(sx)},${Math.round(sy)})`);
    await page.mouse.move(hx, hy);
    await frames(page);
    ok((await status(page)).includes(HANDLE_HINT), `hover text on the status line: ${await status(page)}`);
    eq(await page.evaluate(() => document.getElementById('plant').title), HANDLE_HINT, 'tooltip on the canvas');
    eq((await viewOf(page)).handle.hover, true, 'the handle grows on hover');
    const preview = (await viewOf(page)).connect;
    eq(preview && [preview.role, preview.valid, preview.over], ['from', ['s2', 's3'], null], 'hovering the handle previews the stations it can connect to');
    ok((await cursorOf(page)) !== 'default', 'cursor changes over the handle');
    await snap(page, 'handle-hover-light');
    // not for stations that cannot send; not with another tool; hidden while moving the station
    await page.mouse.move(hx + 200, hy + 200);
    const [gx, gy] = await cellXY(page, 38, 14);
    await page.mouse.click(gx, gy); // Dispatch (a sink)
    await frames(page);
    eq((await viewOf(page)).handle, null, 'a Goods out has no handle: it cannot send loads');
    const [d1x, d1y] = await cellXY(page, 14, 12);
    await page.mouse.click(d1x, d1y); // AGV parking
    await frames(page);
    eq((await viewOf(page)).handle, null, 'a depot has no handle');
    await selectGoodsIn2(page);
    await page.keyboard.press('r');
    await frames(page);
    eq((await viewOf(page)).handle, null, 'no handle while another tool is active');
    await page.keyboard.press('v');
    await frames(page);
    ok((await viewOf(page)).handle, 'the handle is back with the Select tool');
    // dragging the station itself hides the handle and moves the station; the handle follows afterwards
    const before = (await layoutOf(page)).stations.find((s) => s.id === 's5');
    const [mx, my] = await cellXY(page, 15, 7, 0.5, 0.5);
    await drag(page, [mx, my], [mx + 70, my - 46], { keep: true });
    eq((await viewOf(page)).handle, null, 'no handle while the station is dragged');
    await page.mouse.up();
    await frames(page);
    const after = (await layoutOf(page)).stations.find((s) => s.id === 's5');
    ok(after.x !== before.x || after.y !== before.y, 'the station moved');
    ok((await viewOf(page)).handle, 'the handle shows again after the move');
    await page.keyboard.press('Control+z');
    await frames(page);
    await context.close();
  });

  // ---- drag from the handle -------------------------------------------------------------------------------------------

  await run('drag', async () => {
    const { page, context } = await openPlant();
    await selectGoodsIn2(page);
    const [hx, hy] = await findHandle(page);
    const target = await cellXY(page, 20, 13);
    await page.mouse.move(hx, hy);
    await page.mouse.down();
    await page.mouse.move(hx + 10, hy + 25, { steps: 4 });
    const mid = await cellXY(page, 17, 10);
    await page.mouse.move(mid[0], mid[1], { steps: 6 });
    await frames(page);
    let v = await viewOf(page);
    eq(v.connect && v.connect.role, 'from', 'connecting from the Goods in');
    eq(v.connect.valid, ['s2', 's3'], 'the Assembly and Dispatch can receive loads; Goods in 1 and the parking cannot');
    eq(v.connect.over, null, 'nothing under the pointer yet');
    eq(v.flowPreview && v.flowPreview.fromId, 's5', 'the rubber band starts at Goods in 2');
    ok((await status(page)).includes('Goods in 2'), `status line explains the gesture: ${await status(page)}`);
    await snap(page, 'drag-mid-light');
    await page.mouse.move(target[0], target[1], { steps: 8 });
    await frames(page);
    v = await viewOf(page);
    eq([v.connect.over, v.connect.overStatus, v.connect.snap], ['s2', 'valid', 's2'], 'over the Assembly: valid, the band snaps to it');
    ok((await status(page)).includes('to send loads from Goods in 2 to Assembly'), `status: ${await status(page)}`);
    await snap(page, 'drag-over-light');
    // the highlight is on the canvas: the Assembly gets a green outline (pixel just outside its brick), a dimmed brick elsewhere
    const [ax, ay] = await cellXY(page, 19, 13, 0.0, 0.5);
    const edge = await pixel(page, ax - 3, ay);
    ok(edge[1] > edge[0] + 20 && edge[1] > edge[2] + 5, `green glow next to the Assembly: rgb(${edge})`);
    const before = await stateOf(page);
    await page.mouse.up();
    await frames(page);
    eq(await flowPairs(page), ['s1>s2', 's2>s3', 's5>s2'], 'the flow Goods in 2 > Assembly was added');
    const after = await stateOf(page);
    eq(after.undoLabel, 'Connect Goods in 2 → Assembly', 'one undo step with a human label');
    ok(before.undoLabel !== after.undoLabel);
    eq(after.selection.kind, 'flow', 'the new flow is selected');
    eq(await toasts(page), [CREATED_BOTH], 'toast: flow created, and what a second input means for the Assembly');
    eq((await viewOf(page)).connect, null, 'the highlight is gone');
    eq((await viewOf(page)).flowPreview, null, 'the rubber band is gone');
    await snap(page, 'drag-done-light');
    await page.keyboard.press('Control+z');
    await frames(page);
    eq(await flowPairs(page), ['s1>s2', 's2>s3'], 'undo removes the flow');
    await page.keyboard.press('Control+Shift+z');
    await frames(page);
    eq((await flowPairs(page)).length, 3, 'redo brings it back');
    await context.close();
  });

  // ---- wrong releases ----------------------------------------------------------------------------------------------------

  await run('invalid', async () => {
    const { page, context } = await openPlant();
    await selectGoodsIn2(page);
    const start = await stateOf(page);
    let handle = await findHandle(page);
    // 1. onto the parking: a depot cannot receive loads
    const depot = await cellXY(page, 14, 12);
    await drag(page, handle, depot, { keep: true });
    let v = await viewOf(page);
    eq([v.connect.over, v.connect.overStatus, v.connect.snap], ['s4', 'invalid', null], 'over the parking: invalid, no snap');
    ok((await status(page)).includes('Parking & charging cannot receive loads'), `status says why: ${await status(page)}`);
    ok((await cursorOf(page)) === 'not-allowed', 'cursor says no');
    await snap(page, 'drag-invalid-light');
    await page.mouse.up();
    await frames(page);
    eq(await flowPairs(page), ['s1>s2', 's2>s3'], 'nothing was added');
    ok((await toasts(page)).some((t) => t.startsWith('Parking & charging cannot receive loads.')), `toast explains: ${(await toasts(page)).join(' | ')}`);
    eq((await stateOf(page)).undoLabel, start.undoLabel, 'no undo step was created');
    await clearToasts(page);
    // 2. onto another Goods in
    handle = await findHandle(page);
    await drag(page, handle, await cellXY(page, 9, 5));
    eq(await flowPairs(page), ['s1>s2', 's2>s3'], 'a Goods in cannot receive loads');
    ok((await toasts(page)).some((t) => t.startsWith('Goods in cannot receive loads.')), (await toasts(page)).join(' | '));
    await clearToasts(page);
    // 3. onto empty ground: gentle hint, nothing added, the station stays selected with its handle
    handle = await findHandle(page);
    await drag(page, handle, await cellXY(page, 28, 3));
    eq(await flowPairs(page), ['s1>s2', 's2>s3'], 'empty ground connects nothing');
    ok((await toasts(page)).some((t) => t.startsWith('Nothing connected.')), (await toasts(page)).join(' | '));
    eq((await stateOf(page)).selection, { kind: 'station', ids: ['s5'] }, 'the station stays selected');
    ok(await findHandle(page), 'and keeps its handle');
    await clearToasts(page);
    // 4. Esc during a drag cancels it
    handle = await findHandle(page);
    await drag(page, handle, await cellXY(page, 20, 13), { keep: true });
    ok((await viewOf(page)).connect, 'dragging');
    await page.keyboard.press('Escape');
    await frames(page);
    await page.mouse.up();
    await frames(page);
    eq(await flowPairs(page), ['s1>s2', 's2>s3'], 'Esc cancelled the drag');
    eq((await viewOf(page)).connect, null);
    eq((await viewOf(page)).flowPreview, null);
    await clearToasts(page);
    // 5. onto a pair that is connected already: the existing flow is selected
    handle = await findHandle(page);
    await drag(page, handle, await cellXY(page, 20, 13));
    eq((await flowPairs(page)).length, 3, 'first connect Goods in 2 > Assembly');
    await clearToasts(page);
    await page.mouse.click(...(await cellXY(page, 15, 7)));
    await frames(page);
    handle = await findHandle(page);
    const second = await cellXY(page, 20, 13);
    await drag(page, handle, second, { keep: true });
    v = await viewOf(page);
    eq([v.connect.over, v.connect.overStatus], ['s2', 'exists'], 'over a connected pair: already connected');
    await snap(page, 'drag-exists-light');
    await page.mouse.up();
    await frames(page);
    eq((await flowPairs(page)).length, 3, 'no second flow for the same pair');
    eq((await stateOf(page)).selection.kind, 'flow', 'the existing flow is selected');
    ok((await toasts(page)).some((t) => t.includes('already sends loads to')), (await toasts(page)).join(' | '));
    await context.close();
  });

  // ---- click, then click ---------------------------------------------------------------------------------------------------

  await run('click', async () => {
    const { page, context } = await openPlant();
    await selectGoodsIn2(page);
    let handle = await findHandle(page);
    await page.mouse.click(handle[0], handle[1]);
    await frames(page);
    let v = await viewOf(page);
    eq(v.handle, null, 'the handle gives way to the connect mode');
    eq(v.connect && v.connect.valid, ['s2', 's3'], 'valid receivers glow');
    ok((await status(page)).includes('Where should Goods in 2 send its loads?'), `status: ${await status(page)}`);
    eq(await flowPairs(page), ['s1>s2', 's2>s3'], 'a plain click adds nothing');
    const over = await cellXY(page, 38, 14);
    await page.mouse.move(over[0], over[1], { steps: 12 });
    await frames(page);
    v = await viewOf(page);
    eq([v.connect.over, v.connect.overStatus, v.connect.verb], ['s3', 'valid', 'Click'], 'hovering Dispatch: click to connect');
    ok(v.flowPreview && v.flowPreview.fromId === 's5', 'the rubber band follows the pointer');
    await snap(page, 'click-mode-light');
    // a click on a station that cannot receive keeps the mode and explains
    const depot = await cellXY(page, 14, 12);
    await page.mouse.click(depot[0], depot[1]);
    await frames(page);
    ok((await viewOf(page)).connect, 'still connecting after a wrong station');
    ok((await toasts(page)).some((t) => t.startsWith('Parking & charging cannot receive loads.')), (await toasts(page)).join(' | '));
    await clearToasts(page);
    // the right one
    await page.mouse.click(over[0], over[1]);
    await frames(page);
    eq(await flowPairs(page), ['s1>s2', 's2>s3', 's5>s3'], 'Goods in 2 now sends loads to Dispatch');
    eq((await stateOf(page)).undoLabel, 'Connect Goods in 2 → Dispatch');
    eq((await stateOf(page)).selection.kind, 'flow');
    eq((await viewOf(page)).connect, null, 'connect mode is over');
    eq(await toasts(page), [CREATED]);
    await page.keyboard.press('Control+z');
    await frames(page);
    // Esc cancels
    await selectGoodsIn2(page);
    handle = await findHandle(page);
    await page.mouse.click(handle[0], handle[1]);
    await frames(page);
    ok((await viewOf(page)).connect, 'connect mode again');
    await page.keyboard.press('Escape');
    await frames(page);
    eq((await viewOf(page)).connect, null, 'Esc ends connect mode');
    eq(await flowPairs(page), ['s1>s2', 's2>s3']);
    eq((await stateOf(page)).selection, { kind: 'station', ids: ['s5'] }, 'the station stays selected');
    ok(await findHandle(page), 'the handle is back');
    // a click on empty ground ends it with a hint
    await clearToasts(page);
    await page.mouse.click(...(await findHandle(page)).slice(0, 2));
    await frames(page);
    await page.mouse.click(...(await cellXY(page, 30, 3)));
    await frames(page);
    eq((await viewOf(page)).connect, null, 'a click on empty ground ends the mode');
    ok((await toasts(page)).some((t) => t.startsWith('Nothing connected. Click on')), (await toasts(page)).join(' | '));
    // choosing another tool ends it
    await selectGoodsIn2(page);
    await page.mouse.click(...(await findHandle(page)).slice(0, 2));
    await frames(page);
    ok((await viewOf(page)).connect, 'connect mode before the tool change');
    await page.keyboard.press('e');
    await frames(page);
    eq((await viewOf(page)).connect, null, 'a tool change ends the mode');
    await page.keyboard.press('v');
    // the same mode through the app's action, which panel buttons use; a station that cannot send is refused with a message
    await clearToasts(page);
    eq(await page.evaluate(() => window.__logiplan.ctx.actions.startConnect({ fromId: 's5' })), true, 'ctx.actions.startConnect starts the mode');
    eq((await viewOf(page)).connect && (await viewOf(page)).connect.anchorId, 's5');
    await page.mouse.click(...(await cellXY(page, 20, 13)));
    await frames(page);
    ok((await flowPairs(page)).includes('s5>s2'), 'and a click on the Assembly connects');
    eq(await page.evaluate(() => window.__logiplan.ctx.actions.startConnect({ fromId: 's3' })), false, 'Dispatch cannot send loads');
    ok((await toasts(page)).some((t) => t.includes('cannot send loads')), (await toasts(page)).join(' | '));
    await context.close();
  });

  // ---- after placing a station ---------------------------------------------------------------------------------------------

  await run('placement', async () => {
    const { page, context } = await openPlant({ extra: false });
    // Goods in: tool 1, click on free ground that touches the loop road
    await page.keyboard.press('1');
    await frames(page);
    await page.mouse.click(...(await cellXY(page, 15, 7)));
    await frames(page);
    let t = await toasts(page);
    eq(t, ['Goods in placed. Next: where do its loads go?'], 'toast after placing a Goods in');
    ok(await page.locator('.toast__action', { hasText: 'Connect' }).count(), 'with a Connect action');
    await snap(page, 'placement-toast-light');
    await page.locator('.toast__action', { hasText: 'Connect' }).click();
    await frames(page);
    let v = await viewOf(page);
    eq(v.connect && v.connect.role, 'from', 'the action starts connect mode from the new Goods in');
    eq((await stateOf(page)).tool, 'select', 'the Select tool is active');
    ok((await status(page)).includes('send its loads'), await status(page));
    await page.mouse.click(...(await cellXY(page, 20, 13)));
    await frames(page);
    ok((await flowPairs(page)).includes('s5>s2'), `Goods in 1 > Assembly: ${(await flowPairs(page)).join(', ')}`);
    eq((await stateOf(page)).undoLabel, 'Connect Goods in 1 → Assembly');
    // Goods out: tool 4; "What feeds it?" and the click goes to the sender
    await clearToasts(page);
    await page.keyboard.press('4');
    await frames(page);
    await page.mouse.click(...(await cellXY(page, 26, 7)));
    await frames(page);
    t = await toasts(page);
    eq(t, ['Goods out placed. What feeds it?'], 'toast after placing a Goods out');
    await page.locator('.toast__action', { hasText: 'Connect' }).click();
    await frames(page);
    v = await viewOf(page);
    eq(v.connect && [v.connect.role, v.connect.anchorId], ['to', 's6'], 'the action asks what feeds the new Goods out');
    ok(v.connect.valid.includes('s2') && v.connect.valid.includes('s5'), `senders glow: ${v.connect.valid}`);
    ok(!v.connect.valid.includes('s3'), 'Dispatch cannot send loads');
    ok((await status(page)).includes('What feeds Goods out 1?'), await status(page));
    const from = await cellXY(page, 20, 13);
    await page.mouse.move(from[0], from[1], { steps: 8 });
    await frames(page);
    v = await viewOf(page);
    eq(v.flowPreview && [v.flowPreview.toId, v.flowPreview.fromPoint.length], ['s6', 2], 'the band runs from the pointer to the sink');
    eq(v.connect.over, 's2');
    await snap(page, 'placement-feeds-light');
    await page.mouse.click(from[0], from[1]);
    await frames(page);
    ok((await flowPairs(page)).includes('s2>s6'), `Assembly > Goods out 1: ${(await flowPairs(page)).join(', ')}`);
    eq((await stateOf(page)).undoLabel, 'Connect Assembly → Goods out 1');
    // a second placement replaces the first toast instead of stacking up; an unplaceable spot shows no hint
    await clearToasts(page);
    await page.keyboard.press('1');
    await page.mouse.click(...(await cellXY(page, 24, 3)));
    await frames(page);
    const firstCount = (await toasts(page)).length;
    await page.mouse.click(...(await cellXY(page, 30, 3)));
    await frames(page);
    eq((await toasts(page)).filter((x) => x.startsWith('Goods in placed')).length, 1, `one placement hint at a time (${firstCount} before)`);
    await page.mouse.click(...(await cellXY(page, 30, 3))); // occupied now: cannot place
    await frames(page);
    await page.keyboard.press('Escape');
    // a depot takes part in no flows: no hint
    await clearToasts(page);
    await page.keyboard.press('5');
    await page.mouse.click(...(await cellXY(page, 3, 18)));
    await frames(page);
    eq((await toasts(page)).filter((x) => /placed/.test(x)), [], 'no hint for a depot');
    await context.close();
  });

  // ---- the Flow tool -----------------------------------------------------------------------------------------------------------

  await run('flowtool', async () => {
    const { page, context } = await openPlant();
    await page.keyboard.press('f');
    await frames(page);
    await page.mouse.click(...(await cellXY(page, 15, 7))); // pick the sender
    await frames(page);
    await page.mouse.move(...(await cellXY(page, 20, 13)), { steps: 8 });
    await frames(page);
    let v = await viewOf(page);
    eq(v.connect && v.connect.valid, ['s2', 's3'], 'the Flow tool highlights the valid receivers too');
    eq([v.connect.over, v.connect.overStatus], ['s2', 'valid']);
    await snap(page, 'flowtool-light');
    await page.mouse.move(...(await cellXY(page, 14, 12)), { steps: 6 });
    await frames(page);
    v = await viewOf(page);
    eq([v.connect.over, v.connect.overStatus], ['s4', 'invalid'], 'the parking is marked as unable to receive');
    await page.keyboard.press('Escape');
    await frames(page);
    eq((await viewOf(page)).connect, null, 'Esc clears the highlight');
    // creating a flow with the tool still works and is one undo step
    await page.mouse.click(...(await cellXY(page, 15, 7)));
    await page.mouse.click(...(await cellXY(page, 20, 13)));
    await frames(page);
    eq((await flowPairs(page)).length, 3);
    eq((await viewOf(page)).connect, null);
    await context.close();
  });

  // ---- vehicles and waiting loads ----------------------------------------------------------------------------------------------

  /**
   * Step the paused simulation until a vehicle drives to a target more than `minM` metres away. Returns what the overlay should
   * draw: { id, state, target, from: [x, y], to: [x, y] } with metres.
   */
  const driveUntilJob = (page, minM = 7) => page.evaluate(async (min) => {
    const { runner } = window.__logiplan;
    const jobs = await import('/js/ui/render/jobs.js');
    runner.pause();
    for (let i = 0; i < 120; i++) {
      await runner.step(2);
      const sim = runner.sim;
      for (const v of sim.vehicles) {
        const target = jobs.jobTarget(v);
        if (!target || v.visible === false) continue;
        const entry = sim.layout.stations.find((s) => s.id === target);
        const out = [0, 0];
        const cs = sim.layout.grid.cellSize;
        jobs.dockPoint(sim.graph, v, target, { x: entry.x * cs, y: entry.y * cs, w: entry.w * cs, h: entry.h * cs }, v.x, v.y, out);
        if (Math.hypot(out[0] - v.x, out[1] - v.y) > min) return { id: v.id, state: v.state, target, from: [v.x, v.y], to: out, time: sim.time };
      }
    }
    return null;
  }, minM);

  /** Number of canvas pixels inside the page rectangle that differ between the overlay on and off. */
  const overlayDiff = (page, rect) => page.evaluate(async ([x0, y0, x1, y1]) => {
    const { store, ctx } = window.__logiplan;
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const read = () => {
      const c = ctx.canvas;
      const b = c.getBoundingClientRect();
      const s = c.width / b.width;
      const sx = Math.max(0, Math.round((x0 - b.left) * s));
      const sy = Math.max(0, Math.round((y0 - b.top) * s));
      const w = Math.max(1, Math.min(c.width - sx, Math.round((x1 - x0) * s)));
      const h = Math.max(1, Math.min(c.height - sy, Math.round((y1 - y0) * s)));
      return c.getContext('2d').getImageData(sx, sy, w, h).data;
    };
    store.setUi({ overlays: { jobs: true } });
    await frame();
    const on = read();
    store.setUi({ overlays: { jobs: false } });
    await frame();
    const off = read();
    store.setUi({ overlays: { jobs: true } });
    await frame();
    let diff = 0;
    for (let i = 0; i < on.length; i += 4) if (Math.abs(on[i] - off[i]) + Math.abs(on[i + 1] - off[i + 1]) + Math.abs(on[i + 2] - off[i + 2]) > 30) diff++;
    return diff;
  }, rect);

  /** How many canvas pixels inside the page rectangle satisfy `test(r, g, b)` (a function body string over r, g, b). */
  const countPixels = (page, [x0, y0, x1, y1], test) => page.evaluate(([a, b, c, d, body]) => {
    const canvas = window.__logiplan.ctx.canvas;
    const r = canvas.getBoundingClientRect();
    const s = canvas.width / r.width;
    const sx = Math.max(0, Math.round((a - r.left) * s));
    const sy = Math.max(0, Math.round((b - r.top) * s));
    const data = canvas.getContext('2d').getImageData(sx, sy, Math.max(1, Math.round((c - a) * s)), Math.max(1, Math.round((d - b) * s))).data;
    const fn = new Function('r', 'g', 'b', `return (${body});`);
    let n = 0;
    for (let i = 0; i < data.length; i += 4) if (fn(data[i], data[i + 1], data[i + 2])) n++;
    return n;
  }, [x0, y0, x1, y1, String(test).replace(/^\(?r, g, b\)? => /, '')]);

  const worldToPage = (page, [x, y]) => page.evaluate(([wx, wy]) => {
    const { camera, canvas } = window.__logiplan.ctx;
    const [px, py] = camera.worldToScreen(wx, wy);
    const r = canvas.getBoundingClientRect();
    return [r.left + px, r.top + py];
  }, [x, y]);

  await run('jobs', async () => {
    const { page, context } = await openPlant({ restricted: true });
    ok((await stateOf(page)).overlays.jobs === true, 'the Jobs overlay is on by default');
    ok(await page.getByRole('button', { name: 'Jobs' }).count(), 'there is a Jobs toggle in the display options');
    eq(await page.getByRole('button', { name: 'Jobs' }).getAttribute('aria-pressed'), 'true');
    const job = await driveUntilJob(page);
    ok(job, 'a vehicle with an order was found');
    await frames(page, 4);
    // lines: pixels differ between the overlay on and off around the vehicle -> dock segment
    const a = await worldToPage(page, job.from);
    const b = await worldToPage(page, job.to);
    const box = [Math.min(a[0], b[0]) - 8, Math.min(a[1], b[1]) - 8, Math.max(a[0], b[0]) + 8, Math.max(a[1], b[1]) + 8];
    const lineDiff = await overlayDiff(page, box);
    ok(lineDiff > 25, `a dashed line is drawn from the vehicle to its dock (${lineDiff} pixels differ, vehicle ${job.id} ${job.state} -> ${job.target})`);
    await snap(page, `jobs-default-light`);

    // the colour tells the phase: sample the canvas along the line (amber while picking up, blue while delivering)
    const hue = await page.evaluate(([from, to, state]) => {
      const { camera, canvas } = window.__logiplan.ctx;
      const b = canvas.getBoundingClientRect();
      const s = canvas.width / b.width;
      const p0 = camera.worldToScreen(from[0], from[1]);
      const p1 = camera.worldToScreen(to[0], to[1]);
      const x0 = Math.max(0, Math.floor(Math.min(p0[0], p1[0]) * s) - 4);
      const y0 = Math.max(0, Math.floor(Math.min(p0[1], p1[1]) * s) - 4);
      const w = Math.min(canvas.width - x0, Math.ceil(Math.abs(p1[0] - p0[0]) * s) + 8);
      const h = Math.min(canvas.height - y0, Math.ceil(Math.abs(p1[1] - p0[1]) * s) + 8);
      const d = canvas.getContext('2d').getImageData(x0, y0, w, h).data;
      let best = null;
      for (let i = 1; i < 40; i++) {
        const t = i / 40;
        const cx = Math.round((p0[0] + (p1[0] - p0[0]) * t) * s) - x0;
        const cy = Math.round((p0[1] + (p1[1] - p0[1]) * t) * s) - y0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const k = ((cy + dy) * w + (cx + dx)) * 4;
          if (cx + dx < 0 || cy + dy < 0 || cx + dx >= w || cy + dy >= h) continue;
          const r = d[k];
          const g = d[k + 1];
          const bl = d[k + 2];
          const amber = r > 190 && g > 100 && g < 200 && bl < 90 && r - bl > 110;
          const blue = bl > 190 && r < 90 && g > 90 && g < 170;
          if (state === 'toPickup' ? amber : blue) best = [r, g, bl];
        }
      }
      return best;
    }, [job.from, job.to, job.state]);
    ok(hue, `the line is ${job.state === 'toPickup' ? 'amber' : 'blue'} (found ${hue})`);

    // waiting loads: Goods in 2 sends to Dispatch, but only a fleet without vehicles may serve that flow
    await page.evaluate(async () => { await window.__logiplan.runner.step(300); });
    await frames(page, 4);
    const waiting = await page.evaluate(async () => {
      const { runner } = window.__logiplan;
      const jobs = await import('/js/ui/render/jobs.js');
      const rt = runner.sim.logistics.stationById.get('s5');
      return { n: jobs.waitingLoads(rt, runner.sim.time), high: jobs.waitingIsHigh(rt, jobs.waitingLoads(rt, runner.sim.time)), cap: jobs.bufferSize(rt) };
    });
    ok(waiting.n >= 2, `loads wait at Goods in 2 (${waiting.n} of ${waiting.cap})`);
    eq(waiting.high, false, 'not yet a problem');
    await setZoom(page, 24, [30, 16]);
    const [bx, by] = await cellXY(page, 16, 7, 1, 0); // top right corner of Goods in 2
    const badgeDiff = await overlayDiff(page, [bx - 110, by - 34, bx + 8, by + 6]);
    ok(badgeDiff > 200, `the badge "n waiting" is drawn above the top right corner of Goods in 2 (${badgeDiff} pixels)`);
    await snap(page, 'jobs-waiting-amber-light');
    const amberPx = await countPixels(page, [bx - 110, by - 34, bx + 8, by + 6], (r, g, b) => r > 215 && g > 140 && g < 190 && b < 80);
    ok(amberPx > 60, `the badge is amber while the buffer has room (${amberPx} amber pixels)`);
    // a long wait fills the buffer: the badge turns red
    await page.evaluate(async () => { await window.__logiplan.runner.step(700); });
    await frames(page, 4);
    const high = await page.evaluate(async () => {
      const { runner } = window.__logiplan;
      const jobs = await import('/js/ui/render/jobs.js');
      const rt = runner.sim.logistics.stationById.get('s5');
      const n = jobs.waitingLoads(rt, runner.sim.time);
      return { n, high: jobs.waitingIsHigh(rt, n), cap: jobs.bufferSize(rt) };
    });
    eq(high.high, true, `${high.n} of ${high.cap} loads wait: that is a problem`);
    await snap(page, 'jobs-waiting-red-light');
    const redPx = await countPixels(page, [bx - 110, by - 34, bx + 8, by + 6], (r, g, b) => r > 170 && r < 235 && g < 75 && b < 75);
    ok(redPx > 60, `the badge is red when the buffer is nearly full (${redPx} red pixels)`);

    // zoom: 20 px per metre (default) with chips, and 60 px per metre
    await page.evaluate(async () => { await window.__logiplan.runner.step(1); });
    const job2 = await driveUntilJob(page, 5);
    ok(job2, 'a second vehicle trip was found');
    const mid2 = [(job2.from[0] + job2.to[0]) / 2, (job2.from[1] + job2.to[1]) / 2];
    await setZoom(page, 20, mid2);
    await snap(page, 'jobs-20ppm-light');
    await setZoom(page, 60, job2.from);
    await snap(page, 'jobs-60ppm-vehicle-light');
    await setZoom(page, 60, job2.to);
    await snap(page, 'jobs-60ppm-dock-light');

    // the Jobs toggle switches everything off
    await page.getByRole('button', { name: 'Jobs' }).click();
    await frames(page);
    eq((await stateOf(page)).overlays.jobs, false);
    eq(await page.getByRole('button', { name: 'Jobs' }).getAttribute('aria-pressed'), 'false');
    await page.getByRole('button', { name: 'Jobs' }).click();
    await frames(page);
    eq((await stateOf(page)).overlays.jobs, true);
    await context.close();
  });

  await run('jobs-dark', async () => {
    const { page, context } = await openPlant({ restricted: true, theme: 'dark' });
    await page.evaluate(async () => { await window.__logiplan.runner.step(300); });
    const job = await driveUntilJob(page);
    ok(job, 'a vehicle with an order was found');
    await frames(page, 4);
    const mid = [(job.from[0] + job.to[0]) / 2, (job.from[1] + job.to[1]) / 2];
    await setZoom(page, 20, mid);
    await snap(page, 'jobs-20ppm-dark');
    await setZoom(page, 60, job.from);
    await snap(page, 'jobs-60ppm-vehicle-dark');
    await setZoom(page, 60, job.to);
    await snap(page, 'jobs-60ppm-dock-dark');
    await setZoom(page, 24, [30, 16]);
    await snap(page, 'jobs-waiting-dark');
    await context.close();
  });

  await run('handle-dark', async () => {
    const { page, context } = await openPlant({ theme: 'dark' });
    await selectGoodsIn2(page);
    const handle = await findHandle(page);
    await page.mouse.move(handle[0], handle[1]);
    await frames(page);
    await snap(page, 'handle-hover-dark');
    await page.mouse.down();
    await page.mouse.move(...(await cellXY(page, 20, 13)), { steps: 12 });
    await frames(page);
    await snap(page, 'drag-over-dark');
    await page.mouse.up();
    await context.close();
  });

  // ---- by finger ---------------------------------------------------------------------------------------------------------------

  await run('touch', async () => {
    const { page, context } = await openPlant({ viewport: NARROW, hasTouch: true, isMobile: true });
    const cdp = await context.newCDPSession(page);
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], id) => ({ x, y, id })) });
    await page.evaluate(() => document.getElementById('plant').scrollIntoView());
    await page.evaluate(() => { window.__logiplan.ctx.actions.fitView(); });
    await frames(page, 3);
    const station = await cellXY(page, 15, 7);
    await page.touchscreen.tap(station[0], station[1]);
    await frames(page);
    eq((await stateOf(page)).selection, { kind: 'station', ids: ['s5'] }, 'a tap selects the Goods in');
    const handle = await findHandle(page);
    ok(handle, 'the handle shows by touch');
    ok(handle[2] > 40, `the touch handle is a comfortable target (${handle[2]} sample points of 2 px)`);
    await snap(page, 'touch-handle-light');
    const target = await cellXY(page, 20, 13);
    await touch('touchStart', [[handle[0], handle[1]]]);
    for (let i = 1; i <= 10; i++) await touch('touchMove', [[handle[0] + ((target[0] - handle[0]) * i) / 10, handle[1] + ((target[1] - handle[1]) * i) / 10]]);
    await frames(page);
    const v = await viewOf(page);
    eq([v.connect && v.connect.over, v.connect && v.connect.overStatus], ['s2', 'valid'], 'the finger is over the Assembly');
    await snap(page, 'touch-drag-light');
    await touch('touchEnd', []);
    await frames(page);
    ok((await flowPairs(page)).includes('s5>s2'), 'the flow was created by touch');
    // tap the handle, then tap the target
    await page.keyboard.press('Control+z').catch(() => {});
    await page.evaluate(() => window.__logiplan.store.undo());
    await frames(page);
    await page.touchscreen.tap(station[0], station[1]);
    await frames(page);
    const h2 = await findHandle(page);
    await page.touchscreen.tap(h2[0], h2[1]);
    await frames(page);
    ok((await viewOf(page)).connect, 'a tap on the handle starts connect mode');
    await page.touchscreen.tap(target[0], target[1]);
    await frames(page);
    ok((await flowPairs(page)).includes('s5>s2'), 'and a tap on the Assembly connects');
    await context.close();
  });

  // ---- narrow screen -------------------------------------------------------------------------------------------------------------

  await run('narrow', async () => {
    const { page, context } = await openPlant({ viewport: NARROW, restricted: true });
    const over = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth - innerWidth, body: document.body.scrollWidth - innerWidth }));
    ok(over.doc <= 0 && over.body <= 0, `no horizontal page scroll at 390 px: ${JSON.stringify(over)}`);
    const bar = await page.evaluate(() => {
      const el = document.querySelector('.overlays');
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, scrollW: el.scrollWidth, clientW: el.clientWidth };
    });
    ok(bar.left >= -1 && bar.right <= 391, `the display options stay inside the screen: ${JSON.stringify(bar)}`);
    const job = await driveUntilJob(page, 5);
    ok(job, 'a vehicle with an order was found');
    await page.evaluate(async () => { await window.__logiplan.runner.step(300); });
    await page.evaluate(() => window.__logiplan.ctx.actions.fitView());
    await frames(page, 4);
    await snap(page, 'narrow-jobs-light');
    await page.evaluate(() => window.__logiplan.store.select('station', ['s5']));
    await frames(page, 3);
    ok(await findHandle(page), 'the handle shows on a narrow screen');
    await snap(page, 'narrow-handle-light');
    await context.close();
  });

  // ---- cost ------------------------------------------------------------------------------------------------------------------------

  await run('perf', async () => {
    const { page, context } = await openPlant({ extra: false });
    const result = await page.evaluate(async () => {
      const { store, runner, ctx } = window.__logiplan;
      const { EXAMPLES } = await import('/js/model/examples.js');
      const L = await import('/js/model/layout.js');
      const jobs = await import('/js/ui/render/jobs.js');
      const layout = EXAMPLES.find((e) => e.id === 'two-lines').build();
      L.updateFleet(layout, layout.fleets[0].id, { count: 30 });
      store.loadProject({ name: 'perf', scenarios: [{ id: 'sc1', name: 'A', layout }], activeId: 'sc1' });
      ctx.actions.fitView();
      runner.pause();
      await runner.step(900);
      const rr = ctx.renderer;
      rr.render(1);
      const fr = rr._fr;
      const c = rr.ctx;
      const flush = () => c.getImageData(0, 0, 1, 1); // the canvas rasterises lazily: read a pixel so the cost is counted
      const bench = (fn) => {
        for (let i = 0; i < 30; i++) fn();
        flush();
        const t0 = performance.now();
        for (let i = 0; i < 300; i++) { fn(); if (i % 10 === 9) flush(); }
        flush();
        return (performance.now() - t0) / 300;
      };
      c.setTransform(fr.dpr, 0, 0, fr.dpr, 0, 0);
      const real = { vehicles: rr.sim.vehicles.length, working: rr.sim.vehicles.filter((v) => jobs.jobTarget(v) !== null).length };
      real.lines = bench(() => jobs.drawJobLines(c, fr));
      real.badges = bench(() => jobs.drawWaitingBadges(c, fr));
      // a stress case: 100 vehicles, every one with an order, spread over the plant
      const real_sim = rr.sim;
      const stations = real_sim.layout.stations.filter((s) => s.type !== 'depot');
      const cs = real_sim.layout.grid.cellSize;
      const fake = Array.from({ length: 100 }, (_, i) => {
        const x = ((i * 37) % 97) / 97 * real_sim.layout.grid.cols * cs;
        const y = ((i * 53) % 89) / 89 * real_sim.layout.grid.rows * cs;
        return { id: `x#${i}`, fleetId: 'x', state: i % 2 ? 'toPickup' : 'toDrop', visible: true, x, y, heading: 0, prevX: x, prevY: y, prevHeading: 0,
          order: { from: stations[i % stations.length].id, to: stations[(i + 3) % stations.length].id }, tv: null, route: null, fleet: { length: 1.2 } };
      });
      rr.sim = { ...real_sim, vehicles: fake, graph: real_sim.graph, logistics: real_sim.logistics, time: real_sim.time, layout: real_sim.layout };
      rr.render(1);
      const stress = bench(() => jobs.drawJobLines(c, rr._fr));
      // leave the stress sim in place for the allocation measurement below
      window.__overlayFrames = (n) => { const f = rr._fr; c.setTransform(f.dpr, 0, 0, f.dpr, 0, 0); for (let i = 0; i < n; i++) { jobs.drawJobLines(c, f); jobs.drawWaitingBadges(c, f); } };
      return { real, stress, zoom: fr.zoom };
    });
    // allocation: the sampling heap profiler, counting only what the two overlay functions allocate themselves
    const cdp = await context.newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    await page.evaluate(() => window.__overlayFrames(600));
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.startSampling', { samplingInterval: 64, includeObjectsCollectedByMinorGC: true, includeObjectsCollectedByMajorGC: true });
    await page.evaluate(() => window.__overlayFrames(1000));
    const { profile } = await cdp.send('HeapProfiler.stopSampling');
    let allocated = 0;
    const walk = (node) => {
      if (node.selfSize > 0 && /jobs\.js$/.test(node.callFrame.url)) allocated += node.selfSize;
      node.children.forEach(walk);
    };
    walk(profile.head);
    result.allocKb = allocated / 1000 / 1024;
    console.log(`     perf: ${result.real.vehicles} vehicles, ${result.real.working} with an order, at ${result.zoom.toFixed(1)} px/m: lines ${result.real.lines.toFixed(3)} ms, badges ${result.real.badges.toFixed(3)} ms per frame; 100 lines: ${result.stress.toFixed(2)} ms; ${result.allocKb.toFixed(2)} KB allocated per frame by jobs.js`);
    ok(result.real.lines + result.real.badges < 1, `the overlay of a normal plant costs ${(result.real.lines + result.real.badges).toFixed(2)} ms per frame (limit 1 ms)`);
    ok(result.allocKb < 8, `the overlay allocates ${result.allocKb.toFixed(2)} KB per frame for 100 vehicles (limit 8 KB: no objects, arrays or strings are made per frame)`);
    ok(result.stress < 6, `a hundred lines cost ${result.stress.toFixed(2)} ms per frame including rasterising in this software-rendered browser (limit 6 ms)`);
    await context.close();
  });

  eq(foreign, [], 'the app never contacts another host');
  console.log(`guidance-canvas: ${checks} checks passed`);
});
