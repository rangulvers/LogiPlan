// The plan that grows, in the REAL app (index.html + js/main.js) in real Chromium, driven with a real mouse and touch: a road, a brick or
// a drag beyond an edge of the baseplate extends the plan by whole blocks of 8 cells in the same undo step (the content shifts when the
// plan grows on the left or top and the view follows, so nothing moves on screen), undo and redo take it back and forth, the '+' chips on
// the edges and the Plant settings buttons extend and trim it, a drag held at the edge of the canvas pans the view, the limit of 320 x 320
// cells is refused with a clear message, and a plant on a 320 x 320 baseplate runs at speed with a responsive page.
//
// Run: node tests/e2e/canvas-grow.mjs [section]       sections: draw place chips properties autopan limit large shots
// Screenshots: e2e-output/grow-*.png (open them and look: light and dark, desktop and 390 px). Measured frame times and speeds of `large`
// are printed and written to e2e-output/grow-perf.json. Every section asserts that the page logged no console error or warning.
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { withBrowser, OUT } from './browser.mjs';
import { EXAMPLES } from '../../js/model/examples.js';
import * as L from '../../js/model/layout.js';
import { blockPlant } from '../helpers/engine-review-gen.js';

const only = process.argv[2] || '';
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

const DESKTOP = { width: 1440, height: 900 };
const NARROW = { width: 390, height: 800 };
const MAX = 320;

await withBrowser(async ({ browser, url, errors }) => {
  const origin = new URL(url('/')).origin;

  // ---- plumbing -------------------------------------------------------------------------------------------------

  async function session({ viewport = DESKTOP, colorScheme = 'light', hasTouch = false, isMobile = false, init = null } = {}) {
    const context = await browser.newContext({ viewport, colorScheme, hasTouch, isMobile, deviceScaleFactor: 1 });
    if (init) await context.addInitScript(init);
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[console.${m.type()}] ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    page.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
    page.on('request', (r) => { if (!r.url().startsWith(origin) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) errors.push(`[foreign request] ${r.url()}`); });
    return { context, page };
  }

  async function openApp(opts = {}) {
    const s = await session(opts);
    await s.page.goto(url('/index.html'));
    await s.page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
    await s.page.locator('[role=dialog]').first().waitFor();
    await s.page.keyboard.press('Escape');
    await s.page.locator('[role=dialog]').waitFor({ state: 'detached' });
    return s;
  }

  const snap = (page, name, opts = {}) => page.screenshot({ path: path.join(OUT, `grow-${name}.png`), ...opts });
  const noErrors = (what) => { eq(errors.splice(0), [], `${what}: console errors or warnings`); };
  const frames = (page, n = 2) => page.evaluate((count) => new Promise((resolve) => {
    const next = (left) => (left ? requestAnimationFrame(() => next(left - 1)) : resolve());
    next(count);
  }), n);
  const percentile = (list, p) => { const s = list.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
  const round1 = (v) => Math.round(v * 10) / 10;

  /** The plan, the view and the undo state as the page sees them right now. */
  const plan = (page) => page.evaluate(() => {
    const { store, ctx } = window.__logiplan;
    const s = store.getState();
    const l = s.layout;
    return {
      cols: l.grid.cols, rows: l.grid.rows, roads: Object.keys(l.roads).length, stations: l.stations.map((e) => ({ id: e.id, name: e.name, x: e.x, y: e.y, w: e.w, h: e.h })),
      labels: l.labels.length, cam: { x: ctx.camera.x, y: ctx.camera.y, zoom: ctx.camera.zoom }, undo: s.undoLabel, canUndo: s.canUndo, redo: s.redoLabel, canRedo: s.canRedo,
    };
  });
  const view = (page) => page.evaluate(() => {
    const v = window.__logiplan.ctx.renderer.view;
    return { extension: v.extension ? { ...v.extension } : null, chips: v.extendChips, hover: v.extendHover, ghost: v.ghost ? { valid: v.ghost.valid, rect: { ...v.ghost.rect } } : null };
  });
  const status = (page) => page.locator('[data-region=status-text]').innerText();
  const toastTexts = (page) => page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent));
  /** Page coordinates of the centre of cell (cx, cy) (it may lie outside the plan). */
  const cellXY = (page, cx, cy) => page.evaluate(([x, y]) => {
    const { camera, canvas } = window.__logiplan.ctx;
    const cs = window.__logiplan.store.getState().layout.grid.cellSize;
    const [px, py] = camera.worldToScreen((x + 0.5) * cs, (y + 0.5) * cs);
    const r = canvas.getBoundingClientRect();
    return [r.left + px, r.top + py];
  }, [cx, cy]);
  /** Page coordinates of the centre of a station (by name). */
  const stationXY = (page, name) => page.evaluate((n) => {
    const { camera, canvas } = window.__logiplan.ctx;
    const l = window.__logiplan.store.getState().layout;
    const s = l.stations.find((e) => e.name === n);
    const cs = l.grid.cellSize;
    const [px, py] = camera.worldToScreen((s.x + s.w / 2) * cs, (s.y + s.h / 2) * cs);
    const r = canvas.getBoundingClientRect();
    return [Math.round((r.left + px) * 100) / 100, Math.round((r.top + py) * 100) / 100];
  }, name);
  /** Page coordinates of the '+' chip on a side of the baseplate (null when the chip is not offered at this zoom). */
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
  /** Replace the plant by an empty one of this size (or by a layout) and fit it. */
  const loadPlant = (page, { cols = 48, rows = 32, layout = null } = {}) => page.evaluate(async ({ c, r, lay }) => {
    const M = await import('/js/model/layout.js');
    window.__logiplan.store.newProject(lay || M.createLayout({ name: 'Grow test', cols: c, rows: r }));
    window.__logiplan.ctx.actions.fitView();
  }, { c: cols, r: rows, lay: layout }).then(() => frames(page, 3)); // the panels follow in the next animation frame
  /** Zoom out (the camera, about the middle of the canvas) by `notches` wheel steps, so that there is room around the plan. */
  async function zoomOut(page, notches = 2) {
    await page.evaluate((n) => { const { camera } = window.__logiplan.ctx; camera.zoomAt(Math.exp(-120 * 0.0015) ** n, camera.width / 2, camera.height / 2); }, notches);
    await frames(page, 3);
  }
  // Dismiss through the close button: the toaster merges a repeated message into the live toast, so removing the element
  // by hand would leave it in its list and hide the next identical toast.
  const closeToasts = (page) => page.evaluate(() => document.querySelectorAll('.toast__close').forEach((b) => b.click()));
  async function withStations(page) {
    await page.evaluate(async () => {
      const M = await import('/js/model/layout.js');
      window.__logiplan.store.commit('Test plant', (l) => {
        M.paintRoadPath(l, [[16, 14], [30, 14]]);
        M.addStation(l, { type: 'source', name: 'North', x: 17, y: 10, w: 3, h: 2 });
        M.addStation(l, { type: 'sink', name: 'South', x: 25, y: 16, w: 3, h: 2 });
      });
    });
  }
  const run = async (name, fn) => {
    if (only && only !== name) return;
    console.log(`-- ${name}`);
    await fn();
  };

  // ---------------------------------------------------------------------------------------------------------------
  // draw: a road beyond the edges
  // ---------------------------------------------------------------------------------------------------------------
  await run('draw', async () => {
    const { page, context } = await openApp();
    await loadPlant(page);
    await zoomOut(page, 2);
    await page.keyboard.press('r');
    const start = await plan(page);
    eq([start.cols, start.rows], [48, 32], 'a fresh plant is 48 x 32');

    // beyond the right edge
    let [x0, y0] = await cellXY(page, 30, 6);
    let [x1, y1] = await cellXY(page, 53, 6);
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x1, y1, { steps: 10 });
    await frames(page);
    let v = await view(page);
    eq(v.extension, { left: 0, top: 0, right: 8, bottom: 0, ok: true, limited: false, hint: false }, 'while dragging: a block of 8 columns is shown on the right');
    eq(v.chips, false, 'the chips step aside during a gesture');
    ok(/The plan grows by 8 columns on the right\./.test(await status(page)), `the status line says so: "${await status(page)}"`);
    eq((await plan(page)).cols, 48, 'nothing is committed before the release');
    await snap(page, '01-draw-right-preview');
    await page.mouse.up();
    let p = await plan(page);
    eq([p.cols, p.rows, p.roads, p.undo], [56, 32, 24, 'Draw road'], 'released: one step "Draw road", 8 columns more, the 24 cells of the road');
    eq(p.cam, start.cam, 'growing on the right does not move the view');
    eq((await view(page)).extension, null, 'the preview is gone');
    await snap(page, '02-draw-right-done');
    await page.keyboard.press('Control+z');
    p = await plan(page);
    eq([p.cols, p.roads, p.canUndo], [48, 0, false], 'one undo takes the road and the room back');
    eq(p.cam, start.cam, 'the view stays');

    // beyond the top left corner, with something already on the plan
    await withStations(page);
    const before = await plan(page);
    const north = await stationXY(page, 'North');
    [x0, y0] = await cellXY(page, -4, -3);
    [x1, y1] = await cellXY(page, 6, -3);
    const [x2, y2] = await cellXY(page, 6, 9);
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x1, y1, { steps: 8 });
    await page.mouse.move(x2, y2, { steps: 8 });
    await frames(page);
    v = await view(page);
    eq([v.extension.left, v.extension.top, v.extension.right, v.extension.bottom], [8, 8, 0, 0], 'left and top at once');
    await snap(page, '03-draw-topleft-preview');
    await page.mouse.up();
    p = await plan(page);
    eq([p.cols, p.rows, p.undo], [56, 40, 'Draw road'], 'both sides in one step');
    const shifted = p.stations.find((s) => s.name === 'North');
    eq([shifted.x - before.stations.find((s) => s.name === 'North').x, shifted.y - before.stations.find((s) => s.name === 'North').y], [8, 8], 'the content moved by the cells added on the left and above');
    const cs = 2;
    ok(Math.abs(p.cam.x - before.cam.x - 8 * cs) < 1e-9 && Math.abs(p.cam.y - before.cam.y - 8 * cs) < 1e-9, 'and the view by the same distance');
    eq(await stationXY(page, 'North'), north, 'a station did not move on the screen');
    await page.keyboard.press('Control+z');
    p = await plan(page);
    eq([p.cols, p.rows, p.stations.find((s) => s.name === 'North').x], [48, 32, 17], 'undo: size and content are back');
    eq(await stationXY(page, 'North'), north, 'and still nothing moved on the screen');
    await page.keyboard.press('Control+Shift+z');
    p = await plan(page);
    eq([p.cols, p.rows], [56, 40], 'redo grows it again');
    eq(await stationXY(page, 'North'), north, 'redo keeps the view still too');

    // a click of a road tool beyond the edge draws a single plate there and grows the plan
    await page.keyboard.press('Control+z');
    const [cx, cy] = await cellXY(page, 54, 20);
    await page.mouse.click(cx, cy);
    p = await plan(page);
    eq([p.cols, p.rows, p.roads - before.roads], [56, 32, 1], 'a click beyond the right edge draws one plate there and adds a block (cell 54: 7 cells beyond + 1 spare = 8)');
    noErrors('draw');
    await context.close();
  });

  // ---------------------------------------------------------------------------------------------------------------
  // place: bricks placed, moved and resized beyond the edges
  // ---------------------------------------------------------------------------------------------------------------
  await run('place', async () => {
    const { page, context } = await openApp();
    await loadPlant(page);
    await withStations(page);
    await zoomOut(page, 2);
    const base = await plan(page);
    const south = await stationXY(page, 'South');

    // a Workstation beyond the left edge: ghost and block while the pointer rests, placed with a click
    await page.keyboard.press('2');
    let [x, y] = await cellXY(page, -4, 20);
    await page.mouse.move(x, y);
    await frames(page);
    let v = await view(page);
    ok(v.ghost && v.ghost.valid && v.ghost.rect.x < 0, 'the ghost follows the pointer out of the plan');
    eq(v.extension && v.extension.left, 8, 'a block of baseplate shows what the click would add');
    await snap(page, '04-place-left-preview');
    await page.mouse.click(x, y);
    let p = await plan(page);
    eq([p.cols, p.undo], [56, 'Add workstation'], 'placed: 8 columns more, one undo step');
    const placed = p.stations.find((s) => s.name === 'Workstation 1');
    ok(placed && placed.x >= 0 && placed.x + placed.w <= 8, `the new brick sits on the new ground (x = ${placed && placed.x})`);
    eq(await stationXY(page, 'South'), south, 'the old stations did not move on screen');
    await page.keyboard.press('Control+z');
    p = await plan(page);
    eq([p.cols, p.stations.length], [48, 2], 'undo takes brick and room back');
    eq(await stationXY(page, 'South'), south);
    await page.keyboard.press('Control+Shift+z');
    p = await plan(page);
    eq([p.cols, p.stations.length], [56, 3], 'redo');
    eq(await stationXY(page, 'South'), south);
    await page.keyboard.press('Control+z');

    // Select: drag a station. Inside the plan it may not stick out; the pointer beyond the edge lets it grow the plan
    await page.keyboard.press('v');
    [x, y] = await stationXY(page, 'North');
    await page.mouse.click(x, y);
    await page.mouse.move(x, y);
    await page.mouse.down();
    const [bx, by] = await cellXY(page, 47, 11); // the last column: the brick (3 wide, grabbed at its middle) would stick out on the right
    await page.mouse.move(bx, by, { steps: 8 });
    await frames(page);
    v = await view(page);
    eq(v.ghost && v.ghost.valid, false, 'with the pointer still inside the plan the station may not leave it');
    ok(/Move the pointer past the edge to extend the plan/.test(await status(page)), `the status line says how: "${await status(page)}"`);
    const [ex, ey] = await cellXY(page, 52, 11);
    await page.mouse.move(ex, ey, { steps: 8 });
    await frames(page);
    v = await view(page);
    eq(v.ghost && v.ghost.valid, true, 'with the pointer beyond the edge it may');
    eq(v.extension && v.extension.right, 8, 'and the block shows');
    await snap(page, '05-move-right-preview');
    await page.mouse.up();
    p = await plan(page);
    eq([p.cols, p.undo], [56, 'Move station'], 'moved beyond the right edge: 8 columns more, one step');
    const moved = p.stations.find((s) => s.name === 'North');
    ok(moved.x + moved.w > 48, `the station reaches into the new columns (x = ${moved.x})`);
    await page.keyboard.press('Control+z');
    p = await plan(page);
    eq([p.cols, p.stations.find((s) => s.name === 'North').x], [48, base.stations.find((s) => s.name === 'North').x]);
    eq(await stationXY(page, 'North'), [x, y], 'undo of the move: the view did not move');

    // the same towards the top left corner: the content shifts, the other station stays where it is on the screen
    [x, y] = await stationXY(page, 'North');
    await page.mouse.click(x, y);
    await page.mouse.move(x, y);
    await page.mouse.down();
    const [tx, ty] = await cellXY(page, -3, -2);
    await page.mouse.move(tx, ty, { steps: 10 });
    await page.mouse.up();
    p = await plan(page);
    eq([p.cols, p.rows, p.undo], [56, 40, 'Move station'], 'beyond the top left corner: 8 columns on the left and 8 rows above');
    eq(await stationXY(page, 'South'), south, 'the station that was not touched stays where it was on the screen');
    await page.keyboard.press('Control+z');
    eq(await stationXY(page, 'South'), south, 'also after the undo');

    // resize by the right edge handle, dragged out of the plan
    [x, y] = await stationXY(page, 'South');
    await page.mouse.click(x, y);
    const handle = await page.evaluate(() => {
      const { camera, canvas } = window.__logiplan.ctx;
      const l = window.__logiplan.store.getState().layout;
      const s = l.stations.find((e) => e.name === 'South');
      const cs = l.grid.cellSize;
      const [px, py] = camera.worldToScreen((s.x + s.w) * cs, (s.y + s.h / 2) * cs);
      const r = canvas.getBoundingClientRect();
      return [r.left + px, r.top + py];
    });
    await page.mouse.move(handle[0], handle[1]);
    await page.mouse.down();
    const [rx, ry] = await cellXY(page, 52, 17);
    await page.mouse.move(rx, ry, { steps: 8 });
    await page.mouse.up();
    p = await plan(page);
    ok(/^Resize/.test(p.undo) && p.cols > 48, `resized beyond the right edge: ${p.undo}, ${p.cols} columns`);
    const wide = p.stations.find((s) => s.name === 'South');
    ok(wide.x + wide.w > 48, 'the station reaches into the new columns');
    noErrors('place');
    await context.close();
  });

  // ---------------------------------------------------------------------------------------------------------------
  // chips: the '+' on the four edges
  // ---------------------------------------------------------------------------------------------------------------
  await run('chips', async () => {
    const { page, context } = await openApp();
    await loadPlant(page);
    await withStations(page);
    await zoomOut(page, 2);
    const [mx, my] = await cellXY(page, 24, 16);
    await page.mouse.move(mx, my);
    await frames(page);
    let v = await view(page);
    eq(v.chips, true, 'the chips show with Select while the mouse is over the canvas');
    for (const side of ['left', 'top', 'right', 'bottom']) ok(await chipXY(page, side), `a chip on the ${side}`);
    await snap(page, '06-chips');
    const south = await stationXY(page, 'South');

    // hover the left chip: the block it adds shows, lightly; the status line says what a click does
    const left = await chipXY(page, 'left');
    await page.mouse.move(left[0], left[1], { steps: 4 });
    await frames(page);
    v = await view(page);
    eq([v.hover, v.extension && v.extension.left, v.extension && v.extension.hint], ['left', 8, true], 'hovering a chip previews its block');
    eq(await page.evaluate(() => getComputedStyle(window.__logiplan.ctx.canvas).cursor), 'pointer');
    ok(/Click to extend the plan to the left by 8 columns \(then 56 × 32 cells\)/.test(await status(page)), `status: "${await status(page)}"`);
    await snap(page, '07-chip-hover');
    await page.mouse.click(left[0], left[1]);
    let p = await plan(page);
    eq([p.cols, p.undo], [56, 'Extend plan'], 'a click extends by one block as one step "Extend plan"');
    eq(await stationXY(page, 'South'), south, 'the content moved with the plan, so nothing moves on screen');
    eq(p.stations.find((s) => s.name === 'South').x, 25 + 8);
    await page.keyboard.press('Control+z');
    p = await plan(page);
    eq([p.cols, p.stations.find((s) => s.name === 'South').x], [48, 25]);
    eq(await stationXY(page, 'South'), south, 'undo too');

    // the other three, one after the other; each is its own step
    for (const side of ['top', 'right', 'bottom']) {
      const c = await chipXY(page, side);
      await page.mouse.click(c[0], c[1]);
    }
    p = await plan(page);
    eq([p.cols, p.rows], [56, 48], 'top, right and bottom: 8 + 8 rows and 8 columns');
    for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
    p = await plan(page);
    eq([p.cols, p.rows, p.canUndo], [48, 32, true], 'three undo steps (the Test plant edit is still there)');
    eq(await stationXY(page, 'South'), south);

    // not offered during a gesture, for the eraser and the pan tool, and not at a tiny zoom
    await page.keyboard.press('e');
    await page.mouse.move(mx, my + 3);
    await frames(page);
    eq((await view(page)).chips, false, 'not for the eraser');
    await page.keyboard.press('h');
    await frames(page);
    eq((await view(page)).chips, false, 'not for the pan tool');
    await page.keyboard.press('r');
    await page.mouse.move(mx, my);
    await frames(page);
    eq((await view(page)).chips, true, 'but for the road tool');
    await page.keyboard.press('v');
    await page.evaluate(() => { const { camera } = window.__logiplan.ctx; camera.zoomAt(0.1, camera.width / 2, camera.height / 2); });
    await frames(page);
    eq(await chipXY(page, 'left'), null, 'hidden at a tiny zoom');
    await page.keyboard.press('0');
    await page.mouse.move(mx + 1, my);
    await frames(page);
    noErrors('chips');
    await context.close();
  });

  // ---------------------------------------------------------------------------------------------------------------
  // properties: the keyboard route
  // ---------------------------------------------------------------------------------------------------------------
  await run('properties', async () => {
    const { page, context } = await openApp();
    await loadPlant(page);
    await withStations(page);
    await page.locator('[data-tab=properties]').click();
    const size = page.locator('[data-role=plan-size]');
    await size.waitFor();
    eq(await size.innerText(), 'Plan size: 48 × 32 cells, 96 × 64 m');
    const north = await stationXY(page, 'North');
    await size.scrollIntoViewIfNeeded();
    await snap(page, '08-properties-plan-size', { clip: { x: 1080, y: 0, width: 360, height: 900 } });
    // keyboard: Tab to the Left button, Enter
    await page.locator('[data-extend=left]').focus();
    await page.keyboard.press('Enter');
    let p = await plan(page);
    eq([p.cols, p.undo], [56, 'Extend plan'], 'Extend left by 8 cells, one undo step');
    await frames(page, 3);
    eq(await size.innerText(), 'Plan size: 56 × 32 cells, 112 × 64 m');
    eq(await stationXY(page, 'North'), north, 'the view stays');
    await page.locator('[data-extend=top]').click(); // the buttons say Up and Down; the attribute is the model's side name
    await page.locator('[data-extend=bottom]').click();
    await page.locator('[data-extend=right]').click();
    p = await plan(page);
    await frames(page, 3);
    eq([p.cols, p.rows], [64, 48], 'up, down and right too');
    eq(await stationXY(page, 'North'), north);
    // trim
    const note = page.locator('[data-role=trim-note]');
    const trimmed = await note.innerText();
    ok(/^64 × 48 → \d+ × \d+ cells, \d+ × \d+ m\./.test(trimmed), `the trim button says what it will do: "${trimmed}"`);
    await page.locator('[data-role=trim]').click();
    p = await plan(page);
    eq(p.undo, 'Trim plan to content');
    const content = await page.evaluate(async () => { const M = await import('/js/model/layout.js'); const l = window.__logiplan.store.getState().layout; return M.contentBounds(l); });
    eq([p.cols, p.rows], [content.w + 8, content.h + 8], 'trimmed to the content plus 4 empty cells on every side');
    eq(await stationXY(page, 'North'), north, 'the view stays for a trim too');
    ok(await page.locator('[data-role=trim]').isDisabled(), 'nothing left to trim');
    ok(/no empty edge to trim/.test(await note.innerText()), await note.innerText());
    for (let i = 0; i < 5; i++) await page.keyboard.press('Control+z');
    p = await plan(page);
    eq([p.cols, p.rows], [48, 32], 'five undo steps (trim, right, bottom, top, left) bring the plan back');
    eq(await stationXY(page, 'North'), north);
    // an empty plan has nothing to trim to
    await loadPlant(page, { cols: 40, rows: 30 });
    ok(await page.locator('[data-role=trim]').isDisabled(), 'an empty plan cannot be trimmed');
    ok(/empty/.test(await note.innerText()), await note.innerText());
    // the buttons stop at the largest plan
    await loadPlant(page, { cols: MAX, rows: 40 });
    ok(await page.locator('[data-extend=left]').isDisabled() && await page.locator('[data-extend=right]').isDisabled(), 'left and right are off at 320 columns');
    ok(await page.locator('[data-extend=top]').isEnabled(), 'up still works at 40 rows');
    noErrors('properties');
    await context.close();
  });

  // ---------------------------------------------------------------------------------------------------------------
  // autopan: a drag held at the edge of the canvas
  // ---------------------------------------------------------------------------------------------------------------
  await run('autopan', async () => {
    const { page, context } = await openApp();
    await loadPlant(page);
    await page.keyboard.press('r');
    const rect = await page.evaluate(() => { const r = window.__logiplan.ctx.canvas.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });
    const start = await plan(page);
    const [sx, sy] = await cellXY(page, 20, 8);
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(rect.left + rect.width / 2, rect.top + rect.height / 2, { steps: 6 });
    const mid = await plan(page);
    eq(mid.cam, start.cam, 'in the middle of the canvas the view stands still');
    await page.mouse.move(rect.left + rect.width - 8, rect.top + 100, { steps: 6 });
    await page.waitForTimeout(700);
    const held = await plan(page);
    ok(held.cam.x > start.cam.x + 6, `the view looked right while the pointer rested 8 px from the edge: camera x ${round1(start.cam.x)} -> ${round1(held.cam.x)} m`);
    eq(held.cam.zoom, start.cam.zoom, 'the zoom is untouched');
    const v = await view(page);
    ok(v.extension && v.extension.right >= 8, `the plan block grew with the stroke: right ${v.extension && v.extension.right}`);
    await snap(page, '09-autopan');
    // back into the middle: the view stops at once
    await page.mouse.move(rect.left + rect.width / 2, rect.top + 100, { steps: 4 });
    const before = await plan(page);
    await page.waitForTimeout(300);
    eq((await plan(page)).cam, before.cam, 'the pointer left the zone: the pan stops at once');
    // at the edge again, then released: the road is made, one step, the view is where the pan left it
    await page.mouse.move(rect.left + rect.width - 6, rect.top + 100, { steps: 3 });
    await page.waitForTimeout(250);
    await page.mouse.up();
    const done = await plan(page);
    ok(done.cols > 48 && done.undo === 'Draw road', `released: ${done.cols} columns, "${done.undo}"`);
    const after = done.cam;
    await page.waitForTimeout(300);
    eq((await plan(page)).cam, after, 'after the release nothing pans');
    // the pan tool and a marquee do not auto-pan
    await page.keyboard.press('v');
    await page.keyboard.press('0');
    await page.waitForTimeout(400);
    const [mx, my] = await cellXY(page, 5, 25);
    await page.mouse.move(mx, my);
    await page.mouse.down();
    await page.mouse.move(rect.left + rect.width - 6, my, { steps: 6 });
    const m0 = (await plan(page)).cam;
    await page.waitForTimeout(400);
    eq((await plan(page)).cam, m0, 'a marquee does not pan the view');
    await page.mouse.up();
    noErrors('autopan');
    await context.close();
  });

  // ---------------------------------------------------------------------------------------------------------------
  // limit: 320 x 320 cells
  // ---------------------------------------------------------------------------------------------------------------
  await run('limit', async () => {
    const { page, context } = await openApp();
    await loadPlant(page, { cols: MAX - 4, rows: 40 });
    await zoomOut(page, 1);
    await page.keyboard.press('r');
    // a road into the limit stops at its edge and says so
    let [x0, y0] = await cellXY(page, MAX - 20, 5);
    let [x1, y1] = await cellXY(page, MAX + 6, 5);
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x1, y1, { steps: 8 });
    await frames(page);
    ok(/The plan cannot grow beyond 320 × 320 cells\. The road stops at its edge\./.test(await status(page)), `status: "${await status(page)}"`);
    await page.mouse.up();
    let p = await plan(page);
    eq([p.cols, p.roads], [MAX, 20], 'the plan is full-size and the road ends at its edge (20 cells)');
    ok((await toastTexts(page)).some((t) => /The plan cannot grow beyond 320 × 320 cells\. The road stops at its edge\./.test(t)), 'with a toast');
    await closeToasts(page);
    // a brick beyond the limit is refused
    await page.keyboard.press('3');
    [x0, y0] = await cellXY(page, MAX + 5, 20);
    await page.mouse.move(x0, y0);
    await frames(page);
    ok((await view(page)).ghost.valid === false, 'the ghost is red');
    await page.mouse.click(x0, y0);
    const toasts = await toastTexts(page);
    ok(toasts.some((t) => t === 'The plan cannot grow beyond 320 × 320 cells.'), `refused with a toast: ${JSON.stringify(toasts)}`);
    eq((await plan(page)).stations.length, 0, 'nothing placed');
    await closeToasts(page);
    // a chip at the limit
    await page.keyboard.press('v');
    await page.mouse.move(...(await cellXY(page, MAX - 30, 20)));
    await frames(page);
    const right = await chipXY(page, 'right');
    if (right) {
      await page.mouse.click(right[0], right[1]);
      ok((await toastTexts(page)).some((t) => /The plan cannot grow beyond 320 × 320 cells\./.test(t)), 'the chip says why it does nothing');
      eq((await plan(page)).cols, MAX);
    }
    // a move beyond the limit
    await closeToasts(page);
    await page.evaluate(async (max) => { const M = await import('/js/model/layout.js'); window.__logiplan.store.commit('Station', (l) => { M.addStation(l, { type: 'storage', name: 'Edge', x: max - 14, y: 10, w: 12, h: 10 }); }); }, MAX);
    const [ex, ey] = await stationXY(page, 'Edge');
    await page.mouse.click(ex, ey);
    await page.mouse.move(ex, ey);
    await page.mouse.down();
    const [fx, fy] = await cellXY(page, MAX + 12, 10);
    await page.mouse.move(fx, fy, { steps: 8 });
    await frames(page);
    ok(/the plan cannot grow beyond 320 × 320 cells/.test(await status(page)), `status: "${await status(page)}"`);
    await page.mouse.up();
    ok((await toastTexts(page)).some((t) => t === 'The plan cannot grow beyond 320 × 320 cells.'), 'refused with a toast');
    eq((await plan(page)).stations[0].x, MAX - 14, 'the station did not move');
    noErrors('limit');
    await context.close();
  });

  // ---------------------------------------------------------------------------------------------------------------
  // large: a plant on a 320 x 320 baseplate runs at speed and the page stays responsive
  // ---------------------------------------------------------------------------------------------------------------
  /** A page script (before the app loads): every animation-frame interval and callback duration. */
  const frameProbe = () => {
    window.__probe = { intervals: [], callbacks: [], last: 0, on: false };
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf((t) => {
      const p = window.__probe;
      if (p.on) { if (p.last) p.intervals.push(t - p.last); p.last = t; } else p.last = 0;
      const start = performance.now();
      try { cb(t); } finally { if (p.on) p.callbacks.push(performance.now() - start); }
    });
  };
  await run('large', async () => {
    const results = {};
    const { page, context } = await openApp({ init: frameProbe });
    const probe = async (ms) => {
      await page.evaluate(() => { const p = window.__probe; p.intervals.length = 0; p.callbacks.length = 0; p.last = 0; p.on = true; });
      await page.waitForTimeout(ms);
      return page.evaluate(() => { const p = window.__probe; p.on = false; return { intervals: p.intervals.slice(), callbacks: p.callbacks.slice() }; });
    };
    const stats = (m) => ({ frames: m.intervals.length, median: round1(percentile(m.intervals, 0.5)), p95: round1(percentile(m.intervals, 0.95)), max: round1(Math.max(0, ...m.intervals)), cbP95: round1(percentile(m.callbacks, 0.95)), cbMax: round1(Math.max(0, ...m.callbacks)) });

    // 1. the Two lines example in the corner of a 320 x 320 baseplate, run at speed
    const two = EXAMPLES.find((e) => e.id === 'two-lines').build();
    L.growGrid(two, { right: MAX, bottom: MAX });
    eq([two.grid.cols, two.grid.rows], [MAX, MAX], 'a 320 x 320 baseplate');
    await page.evaluate((layout) => { window.__logiplan.store.newProject(layout); window.__logiplan.ctx.actions.fitView(); }, two);
    await frames(page, 3);
    await snap(page, '10-large-fit');
    await page.locator('[data-tab=results]').click();
    for (const speed of [60, 300, 600]) {
      await page.evaluate((s) => { const r = window.__logiplan.runner; r.reset(); r.setSpeed(s); r.play(); }, speed);
      await page.waitForTimeout(700);
      const m = await probe(2500);
      const r = await page.evaluate(() => { const rn = window.__logiplan.runner; return { time: rn.time, limited: rn.limited, speed: rn.speed }; });
      const st = stats(m);
      results[`two-lines-320-${speed}x`] = { ...st, limited: r.limited, simTime: Math.round(r.time) };
      console.log(`   Two lines on 320 x 320 at ${speed}x: frame interval median ${st.median} ms, p95 ${st.p95} ms, max ${st.max} ms; callback p95 ${st.cbP95} ms; speed limited: ${r.limited}`);
      ok(st.median < 24, `${speed}x: the page keeps its frame rate (median interval ${st.median} ms)`);
      ok(st.p95 < 60, `${speed}x: no stalls (p95 ${st.p95} ms)`);
      if (speed <= 300) ok(!r.limited, `${speed}x is reached on 320 x 320 (not "speed limited")`);
    }
    await page.evaluate(() => window.__logiplan.runner.pause());

    // 2. panning, zooming and hovering over the large plan while it runs
    await page.evaluate(() => { const r = window.__logiplan.runner; r.reset(); r.setSpeed(60); r.play(); });
    await page.waitForTimeout(500);
    await page.evaluate(() => { const p = window.__probe; p.intervals.length = 0; p.callbacks.length = 0; p.last = 0; p.on = true; });
    const cx = 560;
    const cy = 450;
    for (let i = 0; i < 12; i++) { await page.mouse.move(cx + i * 7, cy + i * 3); await page.mouse.wheel(0, i % 2 ? 90 : -90); await page.waitForTimeout(30); }
    await page.keyboard.down('Space');
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 0; i < 20; i++) await page.mouse.move(cx + i * 12, cy - i * 5);
    await page.mouse.up();
    await page.keyboard.up('Space');
    const interactive = await page.evaluate(() => { const p = window.__probe; p.on = false; return { intervals: p.intervals.slice(), callbacks: p.callbacks.slice() }; });
    const ist = stats(interactive);
    results.interact = ist;
    console.log(`   Zoom, pan and hover on 320 x 320 while running at 60x: frame interval median ${ist.median} ms, p95 ${ist.p95} ms, max ${ist.max} ms; callback p95 ${ist.cbP95} ms, max ${ist.cbMax} ms`);
    ok(ist.cbP95 < 30, `interaction on 320 x 320 stays smooth (callback p95 ${ist.cbP95} ms)`);
    const hit = await page.evaluate(() => {
      const { renderer } = window.__logiplan.ctx;
      const t0 = performance.now();
      for (let i = 0; i < 2000; i++) renderer.hitTest(100 + (i * 7) % 900, 100 + (i * 13) % 700);
      return (performance.now() - t0) / 2000;
    });
    results.hitTestMs = round1(hit * 1000) / 1000;
    console.log(`   hit test on 320 x 320: ${(hit * 1000).toFixed(0)} us per call`);
    ok(hit < 0.5, `a hit test takes ${hit.toFixed(3)} ms`);
    await page.evaluate(() => window.__logiplan.runner.pause());

    // 3. a plant that fills the baseplate: 16000 road cells, 300 stations, 50 vehicles
    const stress = blockPlant(MAX, MAX, 12, 25, 2);
    const roads = Object.keys(stress.roads).length;
    const commitMs = await page.evaluate(async (layout) => {
      window.__logiplan.store.newProject(layout);
      window.__logiplan.ctx.actions.fitView();
      const M = await import('/js/model/layout.js');
      const t0 = performance.now();
      window.__logiplan.store.commit('Add a wall', (l) => { M.addObstacle(l, { x: 1, y: 1, w: 1, h: 1, kind: 'wall' }); });
      return performance.now() - t0;
    }, stress);
    await frames(page, 3);
    console.log(`   Stress plant: ${roads} road cells, ${stress.stations.length} stations; one commit (clone, checks, notify) ${commitMs.toFixed(0)} ms`);
    results.stressCommitMs = Math.round(commitMs);
    ok(commitMs < 500, `an edit of the full-size plant is applied in ${commitMs.toFixed(0)} ms`);
    await page.evaluate(() => { const r = window.__logiplan.runner; r.setSpeed(10); r.play(); });
    await page.waitForTimeout(1500);
    const sm = stats(await probe(2500));
    results.stressRunning = sm;
    console.log(`   Stress plant running at 10x: frame interval median ${sm.median} ms, p95 ${sm.p95} ms, max ${sm.max} ms; callback p95 ${sm.cbP95} ms`);
    ok(sm.cbP95 < 40, `the full-size plant is drawn and run within the frame budget (callback p95 ${sm.cbP95} ms)`);
    await snap(page, '11-large-stress');
    writeFileSync(path.join(OUT, 'grow-perf.json'), JSON.stringify(results, null, 2));
    noErrors('large');
    await context.close();
  });

  // ---------------------------------------------------------------------------------------------------------------
  // shots: light and dark, desktop and 390 px (look at the PNGs)
  // ---------------------------------------------------------------------------------------------------------------
  await run('shots', async () => {
    for (const scheme of ['light', 'dark']) {
      const { page, context } = await openApp({ colorScheme: scheme });
      await loadPlant(page, { layout: EXAMPLES.find((e) => e.id === 'two-lines').build() });
      await zoomOut(page, 2);
      await page.mouse.move(...(await cellXY(page, 28, 16)));
      await frames(page);
      await snap(page, `${scheme}-chips`);
      const left = await chipXY(page, 'bottom');
      await page.mouse.move(left[0], left[1], { steps: 3 });
      await frames(page);
      await snap(page, `${scheme}-chip-hover`);
      await page.keyboard.press('r');
      const [x0, y0] = await cellXY(page, 3, 8);
      const [x1, y1] = await cellXY(page, -5, 8);
      const [x2, y2] = await cellXY(page, -5, -4);
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      await page.mouse.move(x1, y1, { steps: 6 });
      await page.mouse.move(x2, y2, { steps: 6 });
      await frames(page);
      await snap(page, `${scheme}-extension`);
      await page.mouse.up();
      await frames(page);
      await snap(page, `${scheme}-after`);
      await context.close();
    }
    for (const scheme of ['light', 'dark']) {
      const { page, context } = await openApp({ viewport: NARROW, colorScheme: scheme, hasTouch: true, isMobile: true });
      await loadPlant(page, { layout: EXAMPLES.find((e) => e.id === 'starter').build() });
      await frames(page, 3);
      await snap(page, `${scheme}-narrow-chips`);
      const bottom = await chipXY(page, 'bottom');
      ok(bottom, 'a chip below the plan at 390 px (the left and right ones need room beside the plan: zoom out)');
      const sides = [await chipXY(page, 'left'), await chipXY(page, 'right')];
      eq(sides, [null, null], 'a plan that fills the width of the phone has no room beside it for chips (they appear once it is zoomed out)');
      console.log(`   390 px: chips on the left ${Boolean(sides[0])}, right ${Boolean(sides[1])}, top ${Boolean(await chipXY(page, 'top'))}, bottom ${Boolean(bottom)}`);
      await page.touchscreen.tap(bottom[0], bottom[1]);
      await frames(page, 2);
      const p = await plan(page);
      eq([p.rows, p.undo], [24 + 8, 'Extend plan'], 'a tap on a chip extends the plan (touch)');
      await snap(page, `${scheme}-narrow-extended`);
      await context.close();
    }
    noErrors('shots');
  });

  console.log(`\n${checks} checks passed`);
}, { viewport: DESKTOP });
