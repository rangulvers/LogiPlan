// Smart road drawing + the plan that grows, TOGETHER, in the REAL app (index.html + js/main.js) in headless Chromium.
//
// One planner who has never seen the tool builds a small plant from an empty plan with the real mouse, keyboard and a finger (CDP touch events);
// the store, the camera and the renderer view are only READ to check what happened. Run: node tests/e2e/roads-canvas-combined.mjs [section]
// Screenshots: e2e-output/rc-*.png (open them and look: light and dark, desktop and 390 px).
//
//   session   an empty plant; a long aisle drawn with a jittery hand (smart mode: straight, no jogs); the same aisle carried on past the right
//             edge (the plan grows, nothing moves on the screen); a straight branch with Shift; a deliberate corner; a Goods in placed beyond the
//             LEFT edge (the content shifts, the view follows); road to its dock; Workstation and Goods out; flows by dragging the flow handle;
//             vehicles; play and watch loads arrive. Then ALL of it is undone step by step (every step is exactly the state before it, the
//             grid size included, and nothing jumps on the screen) and redone; reload (autosave); export the project file and open it again; a
//             share link into a fresh browser; the simulation of the grown plant equals that of the same plant on a trimmed and on a bigger plan
//   running   the plan grows on the LEFT while a simulation runs: the old simulation stands on screen until its warm replacement arrives; its
//             vehicles are drawn that far along (runner.simShift) so none leaves its road, and the shift is gone when the replacement is in
//   touch     a finger (390 x 800) draws a straight aisle in smart mode, carries it past the edge, taps an edge chip; the stage stays usable
//   dark      the same moments in dark mode (extension preview, chips, draw control)
//   keyboard  Properties > Plant settings with the keyboard only: extend by 8 cells on each side, trim to content, undo, focus ring visible
//   narrow    the 390 px layout of a grown plan, light and dark: no horizontal scroll, the options bar and the size line fit
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { withBrowser, OUT } from './browser.mjs';
import { createRng } from '../../js/util/rng.js';

const only = process.argv[2] || '';
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };
const match = (text, re, msg) => { assert.match(text, re, msg); checks++; };

const DESKTOP = { width: 1440, height: 900 };
const NARROW = { width: 390, height: 800 };
const E = 2;
const S = 4;
const W = 8;
const N = 1;
const TICK = 0.05; // px: how exactly a thing must stay where it was on the screen

await withBrowser(async ({ browser, url, errors }) => {
  const origin = new URL(url('/')).origin;

  // ---- plumbing -------------------------------------------------------------------------------------------------

  async function openApp({ viewport = DESKTOP, colorScheme = 'light', touch = false, context = null, fresh = true } = {}) {
    const ctx = context || await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch, acceptDownloads: true });
    const page = await ctx.newPage();
    page.setDefaultTimeout(30000);
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[console.${m.type()}] ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    page.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
    page.on('request', (r) => { if (!r.url().startsWith(origin) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) errors.push(`[foreign request] ${r.url()}`); });
    await page.goto(url('/index.html'));
    await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
    if (fresh) await newPlant(page);
    return { page, context: ctx };
  }

  /** What a first-time visitor does: the welcome dialog is up, "Create empty plant". */
  async function newPlant(page) {
    await page.locator('[role=dialog]').first().waitFor();
    await page.getByRole('button', { name: 'Create empty plant' }).click();
    await page.locator('[role=dialog]').waitFor({ state: 'detached' });
    await frames(page, 4);
  }

  const shot = (page, name) => page.screenshot({ path: path.join(OUT, `rc-${name}.png`) });
  const frames = (page, n = 3) => page.evaluate((count) => new Promise((resolve) => {
    const next = (left) => (left ? requestAnimationFrame(() => next(left - 1)) : resolve());
    next(count);
  }), n);
  const noErrors = (what) => { eq(errors.splice(0).filter((e) => !/willReadFrequently/.test(e)), [], `${what}: console errors or warnings`); };
  const layoutOf = (page) => page.evaluate(() => structuredClone(window.__logiplan.store.getState().layout));
  const stateOf = (page) => page.evaluate(() => {
    const s = window.__logiplan.store.getState();
    const { camera } = window.__logiplan.ctx;
    return {
      undoLabel: s.undoLabel, redoLabel: s.redoLabel, canUndo: s.canUndo, canRedo: s.canRedo, tool: s.ui.tool, toolOptions: structuredClone(s.ui.toolOptions),
      cols: s.layout.grid.cols, rows: s.layout.grid.rows, roads: Object.keys(s.layout.roads).length, stations: s.layout.stations.length, flows: s.layout.flows.length,
      cam: { x: camera.x, y: camera.y, zoom: camera.zoom }, selection: structuredClone(s.ui.selection), dirty: s.dirty,
    };
  });
  const viewOf = (page) => page.evaluate(() => {
    const v = window.__logiplan.ctx.renderer.view;
    return {
      paintPreview: v.paintPreview ? structuredClone(v.paintPreview) : null, ghost: v.ghost ? structuredClone(v.ghost) : null,
      extension: v.extension ? { ...v.extension } : null, chips: v.extendChips, hover: v.hover ? structuredClone(v.hover) : null,
    };
  });
  const statusOf = (page) => page.locator('[data-region="status-text"]').innerText();
  const toastsOf = (page) => page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent));
  const press = (page, k) => page.keyboard.press(k);
  const roadKeys = async (page) => Object.keys((await layoutOf(page)).roads);
  const outOf = async (page, cx, cy) => (await layoutOf(page)).roads[`${cx},${cy}`]?.out;
  /** Cells whose links are a corner of a two-way road (two links at a right angle). */
  const cornersOf = async (page) => {
    const roads = (await layoutOf(page)).roads;
    return Object.entries(roads).filter(([, r]) => [N | E, E | S, S | W, W | N].includes(r.out)).map(([k]) => k);
  };
  const rowOf = (keys, row) => keys.filter((k) => k.endsWith(`,${row}`)).map((k) => Number(k.split(',')[0])).sort((a, b) => a - b);
  const colOf = (keys, col) => keys.filter((k) => k.startsWith(`${col},`)).map((k) => Number(k.split(',')[1])).sort((a, b) => a - b);
  const range = (list) => (list.length ? [list[0], list[list.length - 1], list.length] : null);

  /** Client position of a fractional cell position (ux, uy); it may lie outside the plan. */
  const at = (page, ux, uy) => page.evaluate(([x, y]) => {
    const { camera, canvas } = window.__logiplan.ctx;
    const cs = window.__logiplan.store.getState().layout.grid.cellSize;
    const [px, py] = camera.worldToScreen(x * cs, y * cs);
    const r = canvas.getBoundingClientRect();
    return [r.left + px, r.top + py];
  }, [ux, uy]);
  const centre = (cx, cy) => [cx + 0.5, cy + 0.5];
  const moveTo = async (page, ux, uy) => { const [x, y] = await at(page, ux, uy); await page.mouse.move(x, y); };
  const walk = async (page, list) => { for (const [x, y] of list) await moveTo(page, x, y); };

  /** Pointer positions from `from` to `to` (fractional cells) every `step` cells, each with `across` cells of noise across the line and `along` along it. */
  function samples(rng, from, to, { step = 0.4, across = 0, along = 0 } = {}) {
    const dist = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const n = Math.max(1, Math.ceil(dist / step));
    const horizontal = Math.abs(to[0] - from[0]) >= Math.abs(to[1] - from[1]);
    const out = [];
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const x = from[0] + (to[0] - from[0]) * t;
      const y = from[1] + (to[1] - from[1]) * t;
      const a = (rng.next() * 2 - 1) * across;
      const b = (rng.next() * 2 - 1) * along;
      out.push(i === n && !across && !along ? [x, y] : horizontal ? [x + b, y + a] : [x + a, y + b]);
    }
    return out;
  }

  /** Where everything stands on the screen: [x, y] of the middle of each road cell, station and label. The things that exist in two states must stand still between them. */
  const screenPoints = (page) => page.evaluate(() => {
    const { camera } = window.__logiplan.ctx;
    const l = window.__logiplan.store.getState().layout;
    const cs = l.grid.cellSize;
    const at = (x, y) => camera.worldToScreen(x * cs, y * cs);
    return [
      ...Object.keys(l.roads).map((k) => { const [x, y] = k.split(',').map(Number); return at(x + 0.5, y + 0.5); }),
      ...l.stations.map((s) => at(s.x + s.w / 2, s.y + s.h / 2)),
      ...l.obstacles.map((o) => at(o.x + o.w / 2, o.y + o.h / 2)),
      ...l.labels.map((t) => at(t.x, t.y)),
    ];
  });
  /** Is every point of `small` also in `big` (within TICK px)? Returns the first point that is not, or null. */
  function missing(small, big) {
    const grid = new Map();
    const key = (x, y) => `${Math.round(x)},${Math.round(y)}`;
    for (const [x, y] of big) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const k = key(x + dx, y + dy);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push([x, y]);
      }
    }
    for (const [x, y] of small) {
      const near = grid.get(key(x, y)) || [];
      if (!near.some(([bx, by]) => Math.abs(bx - x) <= TICK && Math.abs(by - y) <= TICK)) return [x, y];
    }
    return null;
  }

  /** Record every commit of the store (label and the layout after it) in window.__hist, from now on. */
  const startHistory = (page) => page.evaluate(() => {
    const { store } = window.__logiplan;
    window.__hist = [{ label: 'start', layout: structuredClone(store.getState().layout) }];
    store.subscribe((state, info) => {
      if (info.type === 'commit') window.__hist.push({ label: state.lastCommit && state.lastCommit.label, layout: structuredClone(state.layout) });
    });
  });
  const historyOf = (page) => page.evaluate(() => window.__hist);

  /** Zoom out by wheel notches over the middle of the canvas, as a planner does to get room around the plan. */
  async function zoomOut(page, notches) {
    const box = await page.locator('canvas').first().boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < notches; i++) await page.mouse.wheel(0, 120);
    await frames(page, 4);
  }

  async function pickTool(page, key) {
    await press(page, key);
    await frames(page, 2);
  }
  /** Page coordinates of the '+' chip on a side of the baseplate (null when it is not offered at this zoom). */
  const chipXY = (page, side) => page.evaluate(async (wanted) => {
    const G = await import('/js/ui/editor/grow.js');
    const { camera, canvas } = window.__logiplan.ctx;
    const l = window.__logiplan.store.getState().layout;
    const [ox, oy] = camera.worldToScreen(0, 0);
    const chips = G.edgeChips({ ox, oy, cellPx: l.grid.cellSize * camera.zoom, cols: l.grid.cols, rows: l.grid.rows, w: canvas.clientWidth, h: canvas.clientHeight }, { coarse: matchMedia('(pointer: coarse)').matches });
    const c = chips.find((e) => e.side === wanted);
    const r = canvas.getBoundingClientRect();
    return c ? [r.left + c.chip.x, r.top + c.chip.y] : null;
  }, side);


  const run = async (name, fn) => {
    if (only && only !== name) return;
    const t0 = Date.now();
    await fn();
    console.log(`  ok  ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  };

  // ---- the whole session -----------------------------------------------------------------------------------------

  await run('session', async () => {
    const { page, context } = await openApp();
    page.setDefaultTimeout(60000);
    await startHistory(page);
    let st = await stateOf(page);
    eq([st.cols, st.rows, st.roads], [48, 32, 0], 'an empty plant of 48 x 32 cells');
    await shot(page, 's01-empty');
    const card = page.locator('.stage__empty .empty');
    ok(await card.isVisible(), 'the empty-plant card is up');
    const zoom0 = (await stateOf(page)).cam.zoom;
    await zoomOut(page, 3); // the wheel over the card (it sits in the middle of the plan) zooms the plan under it
    ok((await stateOf(page)).cam.zoom < zoom0 * 0.7, 'the wheel zooms even over the empty-plant card');
    await shot(page, 's02-zoomed-out');
    const rng = createRng(2026);

    // 1. a long aisle, drawn with a shaky hand: ONE straight road, no jog, no corner
    await pickTool(page, 'r');
    eq((await stateOf(page)).toolOptions.drawMode, 'smart', 'smart is the mode a new planner gets');
    await moveTo(page, ...centre(6, 16));
    await page.mouse.down();
    await walk(page, samples(rng, centre(6, 16), centre(24, 16), { across: 0.9, along: 0.3 }));
    await moveTo(page, 32.5, 16.5 + 0.8); // a fast jump of eight cells
    await walk(page, samples(rng, [32.5, 17.3], centre(40, 16), { across: 0.9, along: 0.3 }));
    await page.waitForTimeout(250);
    ok(Number(await card.evaluate((el) => getComputedStyle(el).opacity)) < 0.3, 'the empty-plant card steps aside while a stroke is drawn (the road would hide behind it)');
    let v = await viewOf(page);
    ok(v.paintPreview.cells.every((c) => c[1] === 16), 'the preview of the aisle is one row');
    eq(v.paintPreview.cells.length, 35, 'cells 6..40');
    eq(v.paintPreview.label.text, '70 m · 35 cells', 'the length label at the pointer');
    await shot(page, 's03-aisle-preview');
    await page.mouse.up();
    let keys = await roadKeys(page);
    eq(range(rowOf(keys, 16)), [6, 40, 35], 'one straight aisle of 35 cells in the row of the press');
    eq(keys.length, 35, 'no cell outside that row');
    eq(await cornersOf(page), [], 'no corner, no jog');
    eq((await stateOf(page)).undoLabel, 'Draw road', 'one undo step with a readable label');
    await shot(page, 's04-aisle');
    noErrors('aisle');

    // 2. keep drawing past the right edge: the plan shows what it will add, grows on release, nothing moves on the screen
    const beforeGrow = await screenPoints(page);
    const camBefore = (await stateOf(page)).cam;
    await moveTo(page, ...centre(52, 16));
    await frames(page, 2);
    match(await statusOf(page), /Beyond the edge: a road drawn here extends the plan/, 'hovering beyond the edge with the Road tool says that drawing there extends the plan');
    await moveTo(page, ...centre(40, 16));
    await page.mouse.down();
    await walk(page, samples(rng, centre(40, 16), centre(52, 16), { across: 0.8, along: 0.2 }));
    v = await viewOf(page);
    eq(v.extension && v.extension.right, 8, 'beyond the edge a block of 8 columns is shown (cell 52: 5 beyond + 1 spare)');
    match(await statusOf(page), /The plan grows by 8 columns on the right\./, 'the status line says what will happen');
    eq((await stateOf(page)).cols, 48, 'nothing is added before the button is released');
    await walk(page, samples(rng, centre(52, 16), centre(58, 16), { across: 0.8, along: 0.2 }));
    v = await viewOf(page);
    eq(v.extension && v.extension.right, 16, 'further out: 16 columns');
    await shot(page, 's05-grow-preview');
    await page.mouse.up();
    st = await stateOf(page);
    eq([st.cols, st.rows, st.undoLabel], [64, 32, 'Draw road'], 'released: 64 columns, ONE step, the label of the road');
    keys = await roadKeys(page);
    eq(range(rowOf(keys, 16)), [6, 58, 53], 'the aisle runs on to cell 58, still one row');
    eq(await cornersOf(page), [], 'still no corner');
    eq(st.cam, camBefore, 'growing on the right does not move the view');
    eq(missing(beforeGrow, await screenPoints(page)), null, 'every road cell stands exactly where it stood on the screen');
    eq((await viewOf(page)).extension, null, 'the preview is gone');
    await shot(page, 's06-grown-right');
    noErrors('past the edge');

    // 3. a straight branch down from the middle of the aisle: hold Shift, wobble as much as you like
    await moveTo(page, ...centre(30, 16));
    await page.keyboard.down('Shift');
    await page.mouse.down();
    await walk(page, samples(rng, centre(30, 16), centre(30, 27), { across: 0.9, along: 0.2 }));
    v = await viewOf(page);
    eq(v.paintPreview.guide && v.paintPreview.guide.axis, 'v', 'Shift: the axis is locked and drawn as a guide');
    await shot(page, 's07-shift-branch-preview');
    await page.mouse.up();
    await page.keyboard.up('Shift');
    keys = await roadKeys(page);
    eq(range(colOf(keys, 30)), [16, 27, 12], 'a straight branch of 12 cells');
    eq(await cornersOf(page), [], 'a T junction is not a corner, the branch has none');
    eq((await stateOf(page)).undoLabel, 'Draw road');
    noErrors('shift branch');

    // 4. a deliberate corner: down, then right, in one stroke
    await moveTo(page, ...centre(46, 16));
    await page.mouse.down();
    await walk(page, samples(rng, centre(46, 16), centre(46, 24), { across: 0.5 }));
    await walk(page, samples(rng, centre(46, 24), centre(54, 24), { across: 0.5 }));
    await shot(page, 's08-corner-preview');
    await page.mouse.up();
    eq(await cornersOf(page), ['46,24'], 'exactly one corner, where the pointer turned');
    eq((await stateOf(page)).undoLabel, 'Draw road');
    await shot(page, 's09-corner');
    noErrors('corner');

    // 5. a Goods in beyond the LEFT edge: the content shifts, the view follows
    await zoomOut(page, 1);
    const preLeft = await screenPoints(page);
    await pickTool(page, '1');
    await moveTo(page, -4.5, 16.5);
    await frames(page, 2);
    v = await viewOf(page);
    ok(v.ghost && v.ghost.valid, 'the ghost of the Goods in follows the pointer out of the plan');
    ok(v.extension && v.extension.left === 8, 'a block of 8 columns on the left is shown');
    await shot(page, 's10-goods-in-left-preview');
    await page.mouse.down();
    await page.mouse.up();
    st = await stateOf(page);
    eq([st.cols, st.rows, st.stations, st.undoLabel], [72, 32, 1, 'Add goods in'], 'one step: 8 columns more on the left, the Goods in');
    let layout = await layoutOf(page);
    const goodsIn = layout.stations[0];
    ok(goodsIn.x >= 0 && goodsIn.x + goodsIn.w <= 8, `the brick stands on the new ground (x ${goodsIn.x}..${goodsIn.x + goodsIn.w})`);
    eq(rowOf(Object.keys(layout.roads), 16)[0], 14, 'the aisle moved 8 cells to the right');
    eq(missing(preLeft, await screenPoints(page)), null, 'nothing moved on the screen when the plan grew on the left');
    await shot(page, 's11-goods-in-placed');
    noErrors('left edge');

    // 6. the road to its dock: from the west end of the aisle to the brick, which stops it with a red tail
    await pickTool(page, 'r');
    await moveTo(page, ...centre(14, 16));
    await page.mouse.down();
    await walk(page, samples(rng, centre(14, 16), centre(1, 16), { across: 0.6 }));
    v = await viewOf(page);
    ok(v.paintPreview.blocked.length > 0, 'the brick is in the way: the rest of the stroke is the red tail');
    await shot(page, 's12-road-to-dock-preview');
    await page.mouse.up();
    layout = await layoutOf(page);
    const dock = goodsIn.x + goodsIn.w;
    eq(rowOf(Object.keys(layout.roads), 16)[0], dock, 'the road ends beside the brick: its dock');
    eq(layout.stations[0].x, goodsIn.x, 'the brick did not move');
    noErrors('road to dock');

    // 7. a Workstation and a Goods out beside the aisle (ghost rect read from the renderer, then clicked)
    const place = async (key, ux, wantBottom, wantTop) => {
      await pickTool(page, key);
      for (let row = 10; row < 26; row++) {
        await moveTo(page, ux + 0.5, row + 0.5);
        await frames(page, 1);
        const g = (await viewOf(page)).ghost;
        if (g && g.valid && (wantBottom ? g.rect.y + g.rect.h === 16 : g.rect.y === 17)) { await page.mouse.down(); await page.mouse.up(); return g.rect; }
      }
      throw new Error(`no place beside the aisle for ${key}`);
    };
    const wsRect = await place('2', 40, true);
    const outRect = await place('4', 52, false);
    layout = await layoutOf(page);
    eq(layout.stations.map((s) => s.type), ['source', 'process', 'sink'], 'three stations');
    ok(wsRect.y + wsRect.h === 16 && outRect.y === 17, 'both touch the aisle: they dock on it');
    await shot(page, 's13-three-stations');
    noErrors('stations');

    // 8. flows: drag the round flow handle of a selected station onto the next one
    const stationXY = async (name) => page.evaluate((n) => {
      const { camera, canvas } = window.__logiplan.ctx;
      const l = window.__logiplan.store.getState().layout;
      const s = l.stations.find((e) => e.name === n);
      const cs = l.grid.cellSize;
      const [px, py] = camera.worldToScreen((s.x + s.w / 2) * cs, (s.y + s.h / 2) * cs);
      const r = canvas.getBoundingClientRect();
      return [r.left + px, r.top + py];
    }, name);
    const findHandle = () => page.evaluate(() => {
      const { ctx, store } = window.__logiplan;
      const state = store.getState();
      const s = state.ui.selection.kind === 'station' ? state.layout.stations.find((e) => e.id === state.ui.selection.ids[0]) : null;
      const r = ctx.canvas.getBoundingClientRect();
      const cs = state.layout.grid.cellSize;
      const a = ctx.camera.worldToScreen(s.x * cs, s.y * cs);
      const b = ctx.camera.worldToScreen((s.x + s.w) * cs, (s.y + s.h) * cs);
      let sx = 0; let sy = 0; let n = 0;
      for (let y = Math.max(0, a[1] - 70); y < Math.min(r.height, b[1] + 70); y += 2) {
        for (let x = Math.max(0, a[0] - 70); x < Math.min(r.width, b[0] + 70); x += 2) {
          if (ctx.renderer.hitTest(x, y).kind === 'connect-handle') { sx += x; sy += y; n++; }
        }
      }
      return n ? [r.left + sx / n, r.top + sy / n] : null;
    });
    const connect = async (from, to) => {
      await pickTool(page, 'v');
      const [fx, fy] = await stationXY(from);
      await page.mouse.click(fx, fy);
      await frames(page, 3);
      const handle = await findHandle();
      ok(handle, `${from}: the flow handle shows`);
      const [tx, ty] = await stationXY(to);
      await page.mouse.move(handle[0], handle[1]);
      await page.mouse.down();
      await page.mouse.move(tx, ty, { steps: 12 });
      await page.mouse.up();
      await frames(page, 3);
    };
    await connect('Goods in 1', 'Workstation 1');
    await connect('Workstation 1', 'Goods out 1');
    layout = await layoutOf(page);
    eq(layout.flows.map((f) => `${f.from}>${f.to}`), ['s1>s2', 's2>s3'], 'two flows: Goods in > Workstation > Goods out');
    await shot(page, 's14-flows');

    // 9. vehicles, from the Fleet tab
    await page.getByRole('tab', { name: 'Fleet' }).click();
    await page.locator('#panel-fleet').getByRole('button', { name: 'Add fleet' }).first().click();
    await frames(page, 3);
    layout = await layoutOf(page);
    eq(layout.fleets.length, 1, 'one fleet');
    await page.getByRole('tab', { name: 'Properties' }).click();
    await shot(page, 's15-vehicles');
    noErrors('flows and vehicles');

    // 10. play and watch: loads arrive, vehicles drive
    await press(page, ' ');
    await page.selectOption('select[aria-label="Simulation speed"]', '120');
    await page.waitForFunction(() => window.__logiplan.runner.sim && window.__logiplan.runner.sim.time >= 900, null, { timeout: 120000 });
    await shot(page, 's16-running');
    const live = await page.evaluate(() => {
      const r = window.__logiplan.runner;
      const k = r.kpis();
      return { time: r.sim.time, completed: r.sim.logistics.completed, moving: r.sim.vehicles.filter((veh) => veh.tv.odometer > 0).length, flows: Object.values(k.flows).map((f) => f.delivered) };
    });
    ok(live.completed > 0, `loads reached Goods out (${live.completed} after ${Math.round(live.time)} s)`);
    ok(live.moving > 0, 'vehicles drove');
    await page.getByRole('button', { name: 'Pause simulation' }).click();
    await frames(page, 3);

    // 11. undo the whole session, step by step: each step is exactly the state before it, and nothing jumps on the screen
    const hist = await historyOf(page);
    const labels = hist.map((h) => h.label);
    console.log(`     ${hist.length - 1} undo steps: ${labels.slice(1).join(' | ')}`);
    ok(hist.length - 1 >= 11, `a session of ${hist.length - 1} steps`);
    const finalLayout = await layoutOf(page);
    eq(finalLayout, hist[hist.length - 1].layout, 'the history ends with the plant on screen');
    const finalZoom = (await stateOf(page)).cam.zoom;
    const growthSteps = [];
    let pointsNow = await screenPoints(page);
    for (let k = hist.length - 1; k >= 1; k--) {
      await press(page, 'Control+z');
      await frames(page, 2);
      const now = await layoutOf(page);
      eq(now, hist[k - 1].layout, `undo of "${labels[k]}": the plant is exactly the one before it (${hist[k - 1].layout.grid.cols} x ${hist[k - 1].layout.grid.rows})`);
      const pointsThen = await screenPoints(page);
      eq(missing(pointsThen, pointsNow), null, `undo of "${labels[k]}": nothing that stays has moved on the screen`);
      eq((await stateOf(page)).cam.zoom, finalZoom, 'the zoom did not change');
      if (hist[k].layout.grid.cols !== hist[k - 1].layout.grid.cols || hist[k].layout.grid.rows !== hist[k - 1].layout.grid.rows) growthSteps.push(labels[k]);
      pointsNow = pointsThen;
    }
    eq(growthSteps, ['Add goods in', 'Draw road'], 'two steps changed the size of the plan: the Goods in on the left and the aisle on the right');
    st = await stateOf(page);
    eq([st.cols, st.rows, st.roads, st.stations, st.canUndo, st.canRedo], [48, 32, 0, 0, false, true], 'all undone: the empty 48 x 32 plant');
    await shot(page, 's17-all-undone');
    for (let k = 1; k < hist.length; k++) {
      await press(page, 'Control+Shift+z');
      await frames(page, 2);
      eq(await layoutOf(page), hist[k].layout, `redo of "${labels[k]}": exactly the plant after it`);
      const pointsThen = await screenPoints(page);
      eq(missing(pointsNow, pointsThen), null, `redo of "${labels[k]}": nothing that was there has moved on the screen`);
      pointsNow = pointsThen;
    }
    eq(await layoutOf(page), finalLayout, 'redone: the plant is the one you built');
    st = await stateOf(page);
    eq([st.cols, st.rows, st.canRedo], [72, 32, false], 'back at 72 x 32 cells, nothing left to redo');
    await shot(page, 's18-all-redone');
    noErrors('undo and redo');

    // 12. reload: the autosave brings the plant back, the welcome dialog stays away
    await page.waitForTimeout(700);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
    await frames(page, 4);
    eq(await page.locator('[role=dialog]').count(), 0, 'no welcome dialog for a planner who comes back');
    eq(await layoutOf(page), finalLayout, 'after a reload the plant is exactly as it was, with its 72 x 32 cells');
    await shot(page, 's19-reloaded');
    noErrors('reload');

    // 13. export the project file and open it again: the size of the plan is kept
    await page.getByRole('button', { name: /Export/ }).first().click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: /Project file \(JSON\)/ }).click(),
    ]);
    const dir = mkdtempSync(path.join(tmpdir(), 'logiplan-rc-'));
    const file = path.join(dir, download.suggestedFilename());
    await download.saveAs(file);
    const exported = JSON.parse(readFileSync(file, 'utf8'));
    eq([exported.scenarios[0].layout.grid.cols, exported.scenarios[0].layout.grid.rows], [72, 32], 'the project file holds the 72 x 32 plan');
    await page.evaluate(() => window.__logiplan.store.newProject()); // start over, as another day at another computer
    await frames(page, 3);
    eq((await stateOf(page)).cols, 48, 'a new plant is 48 x 32 again');
    await page.getByRole('button', { name: /Export/ }).first().click();
    await page.getByRole('menuitem', { name: /Open a project file/ }).click();
    await page.locator('input[type=file]').setInputFiles(file);
    await page.locator('[role=dialog]').waitFor({ state: 'detached' });
    await frames(page, 4);
    eq(await layoutOf(page), finalLayout, 'the imported plant is exactly the exported one, 72 x 32 cells');
    await shot(page, 's20-imported');
    noErrors('export and import');

    // 14. a share link of a grown plant opens the same plant in a fresh browser
    await page.getByRole('button', { name: /^Share/ }).first().click();
    const link = await page.locator('[role=dialog] input[readonly]').inputValue();
    match(link, /#p=[zp]\./, 'a share link');
    await shot(page, 's21-share');
    await page.keyboard.press('Escape');
    const other = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 1 });
    const friend = await other.newPage();
    friend.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[friend console.${m.type()}] ${m.text()}`); });
    await friend.goto(link);
    await friend.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
    await friend.waitForFunction(() => window.__logiplan.store.getState().layout.stations.length > 0);
    const shared = await layoutOf(friend);
    eq([shared.grid.cols, shared.grid.rows], [72, 32], 'the link opens a 72 x 32 plan');
    eq(shared, finalLayout, 'and it is the same plant');
    eq(await friend.locator('[role=dialog]').count(), 0, 'no welcome dialog on top of a shared plant');
    await friend.screenshot({ path: path.join(OUT, 'rc-s22-friend.png') });
    await other.close();
    noErrors('share link');

    // 15. the simulation of the grown plant is the one of the same plant on a trimmed and on a bigger plan
    const sameness = await page.evaluate(async () => {
      const L = await import('/js/model/layout.js');
      const { Simulation } = await import('/js/sim/engine.js');
      const base = window.__logiplan.store.getState().layout;
      const trimmed = L.cloneLayout(base);
      const t = L.trimGrid(trimmed, { margin: 0 });
      const bigger = L.cloneLayout(base);
      L.growGrid(bigger, { left: 16, top: 24, right: 40, bottom: 8 });
      const strip = (value) => {
        if (Array.isArray(value)) return value.map(strip);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !['node', 'nodes', 'cx', 'cy'].includes(key)).map(([key, x]) => [key, strip(x)]));
        return value;
      };
      const kpis = (layout) => { const sim = new Simulation(layout); sim.advance(3600); return strip(JSON.parse(JSON.stringify(sim.kpis()))); };
      const worst = { rel: 0, path: '' };
      const compare = (a, b, p = '') => {
        if (typeof a === 'number' && typeof b === 'number') {
          const rel = Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));
          if (rel > worst.rel) { worst.rel = rel; worst.path = p; }
          return;
        }
        if (a && b && typeof a === 'object' && typeof b === 'object') {
          const ka = Object.keys(a); const kb = Object.keys(b);
          if (ka.join() !== kb.join()) { worst.rel = Infinity; worst.path = `${p} keys`; return; }
          for (const key of ka) compare(a[key], b[key], `${p}.${key}`);
          return;
        }
        if (a !== b) { worst.rel = Infinity; worst.path = p; }
      };
      const a = kpis(base);
      const b = kpis(trimmed);
      const c = kpis(bigger);
      compare(a, b, 'trimmed');
      const trimmedWorst = { ...worst };
      worst.rel = 0; worst.path = '';
      compare(a, c, 'bigger');
      return { trimmed: [trimmed.grid.cols, trimmed.grid.rows], trimmedChanged: t.changed, bigger: [bigger.grid.cols, bigger.grid.rows], vsTrimmed: trimmedWorst, vsBigger: { ...worst }, total: a.throughput.total, trips: Object.values(a.fleets).map((f) => f.trips) };
    });
    console.log(`     simulation on 3 plans: ${JSON.stringify(sameness)}`);
    ok(sameness.total > 0, 'the plant produces something');
    ok(sameness.vsTrimmed.rel <= 1e-9, `the trimmed ${sameness.trimmed.join(' x ')} plan simulates the same (${sameness.vsTrimmed.rel})`);
    ok(sameness.vsBigger.rel <= 1e-9, `the bigger ${sameness.bigger.join(' x ')} plan simulates the same (${sameness.vsBigger.rel})`);
    noErrors('session');
    await context.close();
  });

  // ---- growing while a simulation runs ---------------------------------------------------------------------------

  await run('running', async () => {
    const { page, context } = await openApp({ fresh: false });
    page.setDefaultTimeout(60000);
    await page.keyboard.press('Escape');
    await page.locator('[role=dialog]').waitFor({ state: 'detached' });
    await page.evaluate(async () => {
      const { EXAMPLES } = await import('/js/model/examples.js');
      window.__logiplan.store.newProject(EXAMPLES.find((e) => e.id === 'two-lines').build());
      window.__logiplan.ctx.actions.fitView();
    });
    await frames(page, 4);
    await zoomOut(page, 2);
    await page.locator('canvas').first().focus();
    await page.keyboard.press(' ');
    await page.selectOption('select[aria-label="Simulation speed"]', '30');
    await page.waitForFunction(() => window.__logiplan.runner.sim && window.__logiplan.runner.sim.time >= 300, null, { timeout: 120000 });
    await shot(page, 'r01-running');
    // sample every animation frame: where the vehicles of the DISPLAYED simulation are drawn, on the plan as it is now
    await page.evaluate(() => {
      window.__frames = [];
      const tick = () => {
        const { runner, store, ctx } = window.__logiplan;
        const l = store.getState().layout;
        const cs = l.grid.cellSize;
        const sim = ctx.renderer.sim;
        if (sim) {
          const shift = runner.simShift || { dx: 0, dy: 0 };
          const visible = sim.vehicles.filter((v) => v.visible !== false);
          const onRoad = visible.filter((v) => l.roads[`${Math.floor(v.x / cs) + shift.dx},${Math.floor(v.y / cs) + shift.dy}`]).length;
          const rect = ctx.canvas.getBoundingClientRect();
          let hits = 0;
          for (const v of visible) {
            const [px, py] = ctx.camera.worldToScreen(v.x + shift.dx * cs, v.y + shift.dy * cs);
            if (px > 0 && py > 0 && px < rect.width && py < rect.height && ctx.renderer.hitTest(px, py).kind === 'vehicle') hits++;
          }
          window.__frames.push({ shift: runner.simShift ? { ...runner.simShift } : null, priming: runner.priming, vehicles: visible.length, onRoad, hits, simCols: sim.layout.grid.cols, cols: l.grid.cols });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const chip = await chipXY(page, 'left');
    ok(chip, 'the + chip on the left edge');
    await page.mouse.move(chip[0], chip[1]);
    await frames(page, 2);
    const before = (await stateOf(page)).cols;
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(40);
    await shot(page, 'r02-just-grown-old-simulation');
    const early = await page.evaluate(() => ({ shift: window.__logiplan.runner.simShift, priming: window.__logiplan.runner.priming }));
    eq([(await stateOf(page)).cols, (await stateOf(page)).undoLabel], [before + 8, 'Extend plan'], 'the chip added 8 columns on the left');
    await page.waitForFunction(() => { const r = window.__logiplan.runner; return r.sim && r.sim.layout.grid.cols === window.__logiplan.store.getState().layout.grid.cols && !r.priming; }, null, { timeout: 30000 });
    await page.waitForTimeout(300);
    const samples = await page.evaluate(() => window.__frames);
    const moved = samples.filter((f) => f.shift);
    ok(moved.length >= 3, `the old simulation stood on screen beside the grown plan for ${moved.length} frames (first look: ${JSON.stringify(early)})`);
    eq([...new Set(moved.map((f) => `${f.shift.dx},${f.shift.dy}`))], ['8,0'], 'it was 8 cells off in x, nothing in y');
    ok(moved.every((f) => f.onRoad === f.vehicles), `every vehicle of the old simulation was on a road of the new plan in all ${moved.length} frames (${moved.reduce((n, f) => n + f.vehicles, 0)} vehicles drawn)`);
    ok(moved.some((f) => f.hits > 0), 'and the renderer finds them where they are drawn (hit test)');
    ok(samples.filter((f) => !f.shift).every((f) => f.onRoad === f.vehicles), 'the same before the edit and after the replacement came in');
    eq(await page.evaluate(() => window.__logiplan.runner.simShift), null, 'the replacement simulation needs no shift');
    await shot(page, 'r03-replaced');
    // undo takes the room back: the new simulation is shifted the other way until its replacement arrives
    await page.evaluate(() => { window.__frames.length = 0; });
    await press(page, 'Control+z');
    await frames(page, 2);
    eq(await page.evaluate(() => window.__logiplan.runner.simShift), { dx: -8, dy: 0 }, 'undo of the growth shifts the displayed simulation back by 8 cells');
    await page.waitForFunction(() => { const r = window.__logiplan.runner; return r.sim && r.sim.layout.grid.cols === window.__logiplan.store.getState().layout.grid.cols && !r.priming; }, null, { timeout: 30000 });
    const back = await page.evaluate(() => window.__frames);
    ok(back.filter((f) => f.shift).every((f) => f.onRoad === f.vehicles), 'undo: no vehicle off its road either');
    noErrors('running');
    await context.close();
  });

  // ---- a finger ---------------------------------------------------------------------------------------------------

  await run('touch', async () => {
    const { page, context } = await openApp({ viewport: NARROW, touch: true });
    const cdp = await context.newCDPSession(page);
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i + 1 })) });
    const rng = createRng(77);
    await shot(page, 't01-empty-phone');
    // two fingers pinch the view out, for room around the plan
    const box = await page.locator('canvas').first().boundingBox();
    const mx = box.x + box.width / 2;
    const my = box.y + box.height / 2;
    await touch('touchStart', [[mx - 90, my], [mx + 90, my]]);
    for (let i = 1; i <= 6; i++) await touch('touchMove', [[mx - 90 + i * 5, my], [mx + 90 - i * 5, my]]);
    await touch('touchEnd', []);
    await frames(page, 4);
    const zoomed = (await stateOf(page)).cam.zoom;
    const cellPx = await page.evaluate(() => window.__logiplan.ctx.camera.zoom * window.__logiplan.store.getState().layout.grid.cellSize);
    ok(cellPx >= 3 && cellPx <= 6, `the plan fits the phone with room around it (a cell is ${cellPx.toFixed(1)} px)`);
    await page.locator('[data-tool="road"]').tap();
    await frames(page, 2);
    eq((await stateOf(page)).tool, 'road');
    eq((await stateOf(page)).toolOptions.drawMode, 'smart', 'smart mode is the default for a finger too');
    await shot(page, 't02-road-tool-phone');

    // a finger draws an aisle of 40 cells with +-1.5 cells of wobble, and goes on past the edge
    const start = await at(page, ...centre(5, 16));
    await touch('touchStart', [start]);
    const list = samples(rng, centre(5, 16), centre(52, 16), { step: 0.5, across: 1.5, along: 0.4 });
    for (const [x, y] of list) await touch('touchMove', [await at(page, x, y)]);
    await page.waitForTimeout(250);
    ok(Number(await page.locator('.stage__empty .empty').evaluate((el) => getComputedStyle(el).opacity)) < 0.3, 'the empty-plant card steps aside under a finger too');
    const v = await viewOf(page);
    ok(v.paintPreview.cells.every((c) => c[1] === 16), `the finger's wobble made no jog (${v.paintPreview.cells.length} cells)`);
    ok(v.extension && v.extension.right >= 8, 'beyond the edge the block of new ground is shown under the finger');
    ok(v.paintPreview.label.above === true, 'the length label sits above the finger');
    await shot(page, 't03-finger-past-edge');
    await touch('touchEnd', []);
    await frames(page, 2);
    let st = await stateOf(page);
    ok(st.cols > 48 && st.cols % 8 === 0, `the plan grew to ${st.cols} columns, in whole blocks`);
    eq(st.undoLabel, 'Draw road', 'one step');
    const keys = await roadKeys(page);
    eq(range(rowOf(keys, 16)), [5, 52, 48], 'one straight road of 48 cells, no corner');
    eq(await cornersOf(page), [], 'no corner');
    eq(st.cam.zoom, zoomed, 'the zoom did not change');
    await shot(page, 't04-finger-done');

    // the chips are always there on a touch screen: a tap on the bottom one adds a block of rows
    const chip = await chipXY(page, 'bottom');
    ok(chip, 'the + chip on the lower edge is offered on a phone');
    await shot(page, 't05-chips');
    const rows = st.rows;
    await touch('touchStart', [chip]);
    await touch('touchEnd', []);
    await frames(page, 3);
    st = await stateOf(page);
    eq([st.rows, st.undoLabel], [rows + 8, 'Extend plan'], 'a tap on the chip: 8 rows more, one step called "Extend plan"');
    await page.getByRole('button', { name: /^Undo/ }).tap();
    await frames(page, 2);
    eq((await stateOf(page)).rows, rows, 'the Undo button takes it back');
    eq(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, 'no horizontal page scroll');
    noErrors('touch');
    await context.close();
  });

  // ---- dark ---------------------------------------------------------------------------------------------------------

  await run('dark', async () => {
    const { page, context } = await openApp({ colorScheme: 'dark' });
    const rng = createRng(31);
    await zoomOut(page, 3);
    await pickTool(page, 'r');
    await shot(page, 'd01-road-tool');
    await moveTo(page, ...centre(6, 16));
    await page.mouse.down();
    await walk(page, samples(rng, centre(6, 16), centre(30, 16), { across: 0.8 }));
    await page.mouse.up();
    // hovering over a chip shows the block it would add
    const chip = await chipXY(page, 'right');
    ok(chip, 'the + chip on the right edge');
    await page.mouse.move(chip[0], chip[1]);
    await frames(page, 3);
    let v = await viewOf(page);
    eq(v.hover, null, 'no cell hover on a chip');
    ok(v.extension && v.extension.right === 8 && v.extension.hint, 'the chip previews 8 columns');
    await shot(page, 'd02-chip-hover');
    // a stroke past the edge
    await moveTo(page, ...centre(30, 16));
    await page.mouse.down();
    await walk(page, samples(rng, centre(30, 16), centre(56, 16), { across: 0.8 }));
    await shot(page, 'd03-grow-preview');
    await page.mouse.up();
    // Shift with the guide
    await moveTo(page, ...centre(20, 16));
    await page.keyboard.down('Shift');
    await page.mouse.down();
    await walk(page, samples(rng, centre(20, 16), centre(20, 28), { across: 0.8 }));
    await shot(page, 'd04-shift-guide');
    await page.mouse.up();
    await page.keyboard.up('Shift');
    // a Goods in beyond the top edge
    await pickTool(page, '1');
    await moveTo(page, 12.5, -3.5);
    await frames(page, 2);
    await shot(page, 'd05-brick-top');
    await page.mouse.down();
    await page.mouse.up();
    const st = await stateOf(page);
    ok(st.rows >= 40, `the plan grew upwards (${st.rows} rows)`);
    await shot(page, 'd06-grown-top');
    noErrors('dark');
    await context.close();
  });

  // ---- keyboard only ------------------------------------------------------------------------------------------------

  await run('keyboard', async () => {
    const { page, context } = await openApp();
    const rng = createRng(5);
    await pickTool(page, 'r');
    await moveTo(page, ...centre(10, 12));
    await page.mouse.down();
    await walk(page, samples(rng, centre(10, 12), centre(30, 12), { across: 0.5 }));
    await page.mouse.up();
    await pickTool(page, 'v');
    await press(page, 'Escape');
    await page.getByRole('tab', { name: 'Properties' }).click();
    const panel = page.locator('#panel-properties');
    const size = panel.locator('[data-role=plan-size]');
    if (!(await size.isVisible())) await panel.getByText('Grid and scale').click();
    match(await size.innerText(), /Plan size: 48 × 32 cells, 96 × 64 m/, 'the plan size is written out');
    const order = [];
    const focusOrder = async () => page.evaluate(() => document.activeElement && (document.activeElement.dataset.extend || document.activeElement.dataset.role || document.activeElement.tagName));
    await panel.locator('[data-extend=left]').focus();
    for (let i = 0; i < 5; i++) { order.push(await focusOrder()); await press(page, 'Tab'); }
    eq(order, ['left', 'top', 'right', 'bottom', 'trim'], 'Tab walks Left, Up, Right, Down, Trim to content');
    await panel.locator('[data-extend=left]').focus();
    const ring = await page.evaluate(() => { const cs = getComputedStyle(document.activeElement); return { outline: cs.outlineStyle, width: parseFloat(cs.outlineWidth), shadow: cs.boxShadow }; });
    ok(ring.outline !== 'none' || ring.shadow !== 'none', `the focused button has a visible focus ring (${ring.outline} ${ring.width}px)`);
    await shot(page, 'k01-focus');
    const before = await screenPoints(page);
    const cam = (await stateOf(page)).cam;
    await press(page, 'Enter'); // left
    let st = await stateOf(page);
    eq([st.cols, st.rows, st.undoLabel], [56, 32, 'Extend plan'], 'Enter on Left: 8 columns on the left, one step');
    eq(missing(before, await screenPoints(page)), null, 'the road did not move on the screen');
    ok(st.cam.x !== cam.x, 'the view moved with the content');
    await press(page, 'Tab');
    await press(page, 'Space'); // up
    st = await stateOf(page);
    eq([st.cols, st.rows], [56, 40], 'Space on Up: 8 rows on top');
    eq(missing(before, await screenPoints(page)), null, 'still nothing moved on the screen');
    await press(page, 'Tab');
    await press(page, 'Enter'); // right
    await press(page, 'Tab');
    await press(page, 'Enter'); // down
    st = await stateOf(page);
    eq([st.cols, st.rows], [64, 48], 'Right and Down');
    await frames(page, 3);
    match(await size.innerText(), /Plan size: 64 × 48 cells, 128 × 96 m/, 'the size line follows');
    await shot(page, 'k02-extended');
    await press(page, 'Tab');
    ok((await focusOrder()) === 'trim', 'Tab arrives at Trim to content');
    match(await panel.locator('[data-role=trim-note]').innerText(), /64 × 48 → \d+ × \d+ cells/, 'the note says what trimming does');
    await press(page, 'Enter');
    st = await stateOf(page);
    eq(st.undoLabel, 'Trim plan to content', 'trimmed: one step');
    ok(st.cols < 64 && st.rows < 48, `the plan shrank to ${st.cols} x ${st.rows}`);
    eq(missing(before, await screenPoints(page)), null, 'trimming moved nothing on the screen');
    await shot(page, 'k03-trimmed');
    for (let i = 0; i < 5; i++) await press(page, 'Control+z');
    st = await stateOf(page);
    eq([st.cols, st.rows, st.canUndo], [48, 32, true], 'five Ctrl+Z take it all back to the plan with the road (48 x 32)');
    eq(missing(before, await screenPoints(page)), null, 'and the road is where it was');
    noErrors('keyboard');
    await context.close();
  });

  // ---- 390 px, light and dark ---------------------------------------------------------------------------------------

  await run('narrow', async () => {
    for (const colorScheme of ['light', 'dark']) {
      const { page, context } = await openApp({ viewport: NARROW, colorScheme });
      const rng = createRng(61);
      await zoomOut(page, 2);
      await pickTool(page, 'r');
      const bar = await page.locator('.stage__options .stagebar').boundingBox();
      ok(bar.x >= -0.5 && bar.x + bar.width <= NARROW.width + 0.5, `${colorScheme}: the draw options fit 390 px (${Math.round(bar.x)}..${Math.round(bar.x + bar.width)})`);
      await moveTo(page, ...centre(4, 16));
      await page.mouse.down();
      await walk(page, samples(rng, centre(4, 16), centre(44, 16), { across: 0.8 }));
      await page.mouse.up();
      await moveTo(page, ...centre(44, 16));
      await page.mouse.down();
      await walk(page, samples(rng, centre(44, 16), centre(55, 16), { across: 0.8 }));
      await shot(page, `n01-preview-${colorScheme}`);
      await page.mouse.up();
      const st = await stateOf(page);
      ok(st.cols >= 56, `${colorScheme}: the plan grew (${st.cols} x ${st.rows})`);
      eq(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, `${colorScheme}: no horizontal page scroll`);
      await shot(page, `n02-grown-${colorScheme}`);
      await page.getByRole('button', { name: 'Details panel' }).click();
      await frames(page, 4);
      await shot(page, `n03-panel-${colorScheme}`);
      noErrors(`narrow ${colorScheme}`);
      await context.close();
    }
  });

  console.log(`\nAll combined road and canvas checks passed (${checks} checks).`);
});
