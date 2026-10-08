// Road drawing modes in the REAL app (index.html + js/main.js) in headless Chromium: smart (default), straight (Shift) and free.
//
// Every stroke is made with the real mouse, keyboard or a finger (CDP touch events); the store, the renderer view and the layout are only READ
// to check the result. Run: node tests/e2e/roads-straight.mjs   (screenshots: e2e-output/roads-*.png, open them and look)
//
//   jitter    a hand-shaken horizontal and vertical drag (+-0.9 cell of noise, fast jumps) gives ONE straight road with no corner
//   corner    a deliberate L gives exactly one corner, a U two; moving back along the road retracts it, also through a corner
//   shift     Shift locks the axis of one straight line (the axis guide and the length label are drawn), Shift pressed and released in the middle
//   continue  Shift+click draws a line from the end of the previous stroke; hovering with Shift previews it; Esc forgets it
//   free      the Draw control (Smart | Straight | Free): clicks and keys, the choice survives a reload; Free keeps the wobble
//   oneway    one-way links follow the drag direction in smart and straight mode, the preview shows chevrons
//   blocked   a station in the way: the stroke stops before it with a red tail, nothing is painted inside
//   other     Alt-drag erases, the eraser and the slow-zone tool use the draw mode, one undo step per stroke
//   touch     a finger (390 x 800) draws in smart mode and is not thrown off by its own wobble; no Shift hint on a touch screen
//   dark      the preview, guide, label and control in dark mode
//   control   when the Draw control is visible, its names and what the status line says
import assert from 'node:assert/strict';
import path from 'node:path';
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

await withBrowser(async ({ browser, url, errors }) => {
  // ---- plumbing -------------------------------------------------------------------------------------------------

  async function openApp({ viewport = DESKTOP, colorScheme = 'light', touch = false } = {}) {
    const context = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[console.${m.type()}] ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    await page.goto(url('/index.html'));
    await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
    await page.getByRole('button', { name: 'Close' }).last().click();
    await page.locator('[role=dialog]').waitFor({ state: 'detached' });
    await reset(page);
    return { page, context };
  }

  /** An empty 48 x 32 plant with one small label in the corner (so the "plant is empty" card does not sit on the canvas). */
  async function reset(page, { stations = [] } = {}) {
    await page.evaluate(async (list) => {
      const L = await import('/js/model/layout.js');
      const layout = L.createLayout({ name: 'Draw test', cols: 48, rows: 32, cellSize: 2 });
      L.addLabel(layout, { x: 45, y: 1.5, text: 'N' });
      for (const s of list) L.addStation(layout, s);
      window.__logiplan.store.newProject(layout);
      window.__logiplan.store.setUi({ tool: 'select', toolOptions: { drawMode: 'smart' } });
    }, stations);
    await frames(page, 3);
  }

  const shot = (page, name) => page.screenshot({ path: path.join(OUT, `roads-${name}.png`) });
  const frames = (page, n = 3) => page.evaluate((count) => new Promise((resolve) => {
    const next = (left) => (left ? requestAnimationFrame(() => next(left - 1)) : resolve());
    next(count);
  }), n);
  const noErrors = (what) => { eq(errors.splice(0).filter((e) => !/willReadFrequently/.test(e)), [], `${what}: console errors or warnings`); };
  const layoutOf = (page) => page.evaluate(() => structuredClone(window.__logiplan.store.getState().layout));
  const stateOf = (page) => page.evaluate(() => {
    const s = window.__logiplan.store.getState();
    return { undoLabel: s.undoLabel, redoLabel: s.redoLabel, canUndo: s.canUndo, tool: s.ui.tool, toolOptions: structuredClone(s.ui.toolOptions) };
  });
  const viewOf = (page) => page.evaluate(() => {
    const v = window.__logiplan.ctx.renderer.view;
    return { paintPreview: v.paintPreview ? structuredClone(v.paintPreview) : null, hover: v.hover ? structuredClone(v.hover) : null };
  });
  const statusOf = (page) => page.locator('[data-region="status-text"]').innerText();
  const roadKeys = async (page) => Object.keys((await layoutOf(page)).roads);
  const roadCount = async (page) => (await roadKeys(page)).length;
  const outOf = async (page, cx, cy) => (await layoutOf(page)).roads[`${cx},${cy}`]?.out;
  const press = (page, k) => page.keyboard.press(k);
  /** Cells whose links are a corner of a two-way road (two links at a right angle). */
  const cornersOf = async (page) => {
    const roads = (await layoutOf(page)).roads;
    return Object.entries(roads).filter(([, r]) => [N | E, E | S, S | W, W | N].includes(r.out)).map(([k]) => k);
  };

  /** Client position of a fractional cell position (ux, uy). */
  const at = (page, ux, uy) => page.evaluate(([x, y]) => {
    const { camera, canvas } = window.__logiplan.ctx;
    const cs = window.__logiplan.store.getState().layout.grid.cellSize;
    const [px, py] = camera.worldToScreen(x * cs, y * cs);
    const r = canvas.getBoundingClientRect();
    return [r.left + px, r.top + py];
  }, [ux, uy]);
  const moveTo = async (page, ux, uy) => { const [x, y] = await at(page, ux, uy); await page.mouse.move(x, y); };

  /** Pointer positions from `from` to `to` (fractional cells) every `step` cells, each with `wobble` cells of noise across the line and along it. */
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
  const walk = async (page, list) => { for (const [x, y] of list) await moveTo(page, x, y); };
  const centre = (cx, cy) => [cx + 0.5, cy + 0.5];

  async function pickTool(page, key) {
    await press(page, key);
    await frames(page, 2);
  }

  const run = async (name, fn) => {
    if (only && only !== name) return;
    const t0 = Date.now();
    await fn();
    console.log(`  ok  ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  };

  // ---- jitter -------------------------------------------------------------------------------------------------------

  await run('jitter', async () => {
    const { page, context } = await openApp();
    await pickTool(page, 'r');
    eq((await stateOf(page)).toolOptions.drawMode, 'smart', 'smart is the default');
    const rng = createRng(11);

    // a horizontal drag, 24 cells, +-0.9 cell of noise across and +-0.3 along, one fast jump in the middle
    await moveTo(page, ...centre(5, 6));
    await page.mouse.down();
    await walk(page, samples(rng, centre(5, 6), centre(16, 6), { across: 0.9, along: 0.3 }));
    await moveTo(page, 24.5, 6.5 + 0.8); // a fast jump of 8 cells
    await walk(page, samples(rng, [24.5, 6.9], centre(29, 6), { across: 0.9, along: 0.3 }));
    let view = await viewOf(page);
    eq(view.paintPreview.cells.length, 25, 'live preview: cells 5..29 of row 6');
    ok(view.paintPreview.cells.every((c) => c[1] === 6), 'the preview is a single row');
    eq(view.paintPreview.label.text, '50 m · 25 cells', 'the length label: 25 cells of 2 m');
    eq(view.paintPreview.guide, null, 'no axis guide for a smart stroke');
    match(await statusOf(page), /^Road: 25 cells \(50 m\)/, 'the status line says the same');
    await shot(page, 'jitter-preview-light');
    eq(await roadCount(page), 0, 'nothing is committed before the button is released');
    await page.mouse.up();
    const keys = await roadKeys(page);
    eq(keys.length, 25, 'one straight road of 25 cells');
    ok(keys.every((k) => k.endsWith(',6')), 'no cell outside the row of the press');
    eq([await outOf(page, 5, 6), await outOf(page, 17, 6), await outOf(page, 29, 6)], [E, E | W, W], 'two-way links all the way');
    eq(await cornersOf(page), [], 'no corner');
    eq((await stateOf(page)).undoLabel, 'Draw road', 'one commit with a readable label');
    await press(page, 'Control+z');
    eq(await roadCount(page), 0, 'ONE undo takes the whole road back');
    await press(page, 'Control+y');
    eq(await roadCount(page), 25, 'and redo brings it back');
    await press(page, 'Control+z');

    // the same vertical, from the bottom to the top, 18 cells
    await moveTo(page, ...centre(40, 28));
    await page.mouse.down();
    await walk(page, samples(rng, centre(40, 28), centre(40, 11), { across: 0.9, along: 0.3 }));
    await page.mouse.up();
    const col = await roadKeys(page);
    eq(col.length, 18, 'a vertical road of 18 cells');
    ok(col.every((k) => k.startsWith('40,')), 'in one column');
    eq(await outOf(page, 40, 28), N, 'drawn upwards: the first cell links north');

    // a click is one plate, also with a 1-px tremor
    await press(page, 'Control+z');
    const [cx, cy] = await at(page, 12.5, 14.5);
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 1, cy + 1);
    await page.mouse.up();
    eq(await roadCount(page), 1, 'a click with a tremor is a single plate');
    eq(await outOf(page, 12, 14), 0, 'with no links');
    noErrors('jitter');
    await context.close();
  });

  // ---- corners ------------------------------------------------------------------------------------------------------

  await run('corner', async () => {
    const { page, context } = await openApp();
    await pickTool(page, 'r');
    const rng = createRng(5);

    // an L: 10 right, then 6 down, with a shaky hand
    await moveTo(page, ...centre(5, 12));
    await page.mouse.down();
    await walk(page, samples(rng, centre(5, 12), centre(15, 12), { across: 0.4 }));
    await walk(page, samples(rng, centre(15, 12), centre(15, 18), { across: 0.4 }));
    let view = await viewOf(page);
    eq(view.paintPreview.cells.length, 11 + 6, 'the preview of the L');
    eq(view.paintPreview.label.text, '34 m · 17 cells');
    await shot(page, 'corner-L-preview-light');
    await page.mouse.up();
    eq(await roadCount(page), 17);
    eq(await cornersOf(page), ['15,12'], 'exactly one corner, where the pointer turned');
    eq(await outOf(page, 15, 12), W | S, 'the corner links west and south');
    eq((await stateOf(page)).undoLabel, 'Draw road');
    await press(page, 'Control+z');
    eq(await roadCount(page), 0, 'one undo step');

    // a U: right, down, back left (two corners)
    await moveTo(page, ...centre(8, 5));
    await page.mouse.down();
    await walk(page, samples(rng, centre(8, 5), centre(22, 5), { across: 0.4 }));
    await walk(page, samples(rng, centre(22, 5), centre(22, 9), { across: 0.4 }));
    await walk(page, samples(rng, centre(22, 9), centre(10, 9), { across: 0.4 }));
    await page.mouse.up();
    eq((await cornersOf(page)).sort(), ['22,5', '22,9'], 'a U has two corners');
    eq(await roadCount(page), 15 + 4 + 12);
    await press(page, 'Control+z');

    // retraction: out 12 cells, back 5 (the road gets shorter), release
    await moveTo(page, ...centre(5, 20));
    await page.mouse.down();
    await walk(page, samples(rng, centre(5, 20), centre(17, 20), { across: 0.3 }));
    await walk(page, samples(rng, centre(17, 20), centre(12, 20), { across: 0.3 }));
    eq((await viewOf(page)).paintPreview.cells.length, 8, 'moving back along the road retracts it');
    await page.mouse.up();
    eq(await roadCount(page), 8);
    await press(page, 'Control+z');

    // retraction through a corner: 10 right, 6 down, back up and 4 to the left: a straight road of 6 cells
    await moveTo(page, ...centre(20, 20));
    await page.mouse.down();
    await walk(page, samples(rng, centre(20, 20), centre(30, 20), { across: 0.3 }));
    await walk(page, samples(rng, centre(30, 20), centre(30, 26), { across: 0.3 }));
    eq((await viewOf(page)).paintPreview.cells.length, 17);
    await walk(page, samples(rng, centre(30, 26), centre(30, 20), { across: 0.3 }));
    await walk(page, samples(rng, centre(30, 20), centre(25, 20), { across: 0.3 }));
    eq((await viewOf(page)).paintPreview.cells.length, 6, 'back through the corner: the whole second leg and half of the first are gone');
    await page.mouse.up();
    eq(await cornersOf(page), [], 'and no corner is left');
    noErrors('corner');
    await context.close();
  });

  // ---- shift --------------------------------------------------------------------------------------------------------

  await run('shift', async () => {
    const { page, context } = await openApp();
    await pickTool(page, 'r');
    const rng = createRng(21);

    // Shift held from the press: a diagonal drag locks to the dominant axis and never flips, the pointer may swing to the other axis
    await moveTo(page, ...centre(6, 20));
    await page.keyboard.down('Shift');
    await page.mouse.down();
    await walk(page, samples(rng, centre(6, 20), centre(14, 23), { step: 0.3 }));
    let view = await viewOf(page);
    eq(view.paintPreview.cells.length, 9, 'a straight line to the pointer\'s column: x = 6..14');
    ok(view.paintPreview.cells.every((c) => c[1] === 20), 'on the row of the press, however far the pointer is below it');
    eq(view.paintPreview.guide, { axis: 'h', cell: [6, 20] }, 'the locked axis is drawn');
    eq(view.paintPreview.label.text, '18 m · 9 cells');
    await walk(page, samples(rng, centre(14, 23), centre(14, 29), { step: 0.3 }));
    view = await viewOf(page);
    eq(view.paintPreview.cells.at(-1), [14, 20], 'swinging the pointer to the other axis does not flip the lock');
    eq(view.paintPreview.guide.axis, 'h');
    await shot(page, 'shift-lock-preview-light');
    await page.mouse.up();
    await page.keyboard.up('Shift');
    eq(await roadCount(page), 9);
    eq(await cornersOf(page), []);
    eq((await stateOf(page)).undoLabel, 'Draw road');
    await press(page, 'Control+z');

    // vertical lock
    await moveTo(page, ...centre(30, 4));
    await page.keyboard.down('Shift');
    await page.mouse.down();
    await walk(page, samples(rng, centre(30, 4), centre(32, 14), { step: 0.3 }));
    view = await viewOf(page);
    eq(view.paintPreview.guide, { axis: 'v', cell: [30, 4] });
    eq(view.paintPreview.cells.length, 11);
    await page.mouse.up();
    await page.keyboard.up('Shift');
    ok((await roadKeys(page)).every((k) => k.startsWith('30,')));
    await press(page, 'Control+z');

    // Shift pressed in the middle of a stroke: a straight line from where the stroke is; released again: smart from the new end
    await moveTo(page, ...centre(5, 3));
    await page.mouse.down();
    await walk(page, samples(rng, centre(5, 3), centre(12, 3), { across: 0.3 }));
    await page.keyboard.down('Shift');
    await walk(page, samples(rng, centre(12, 3), centre(12, 9), { step: 0.3 }));
    view = await viewOf(page);
    eq(view.paintPreview.guide, { axis: 'v', cell: [12, 3] }, 'a new straight line starts at the end of the smart part');
    eq(view.paintPreview.cells.length, 8 + 6);
    await page.keyboard.up('Shift');
    await walk(page, samples(rng, centre(12, 9), centre(19, 9), { across: 0.3 }));
    view = await viewOf(page);
    eq(view.paintPreview.guide, null, 'smart again');
    eq(view.paintPreview.cells.length, 8 + 6 + 7, 'the road goes on to the right from the end of the straight part');
    await page.mouse.up();
    eq(await roadCount(page), 21);
    eq((await cornersOf(page)).sort(), ['12,3', '12,9'], 'two corners');
    eq((await stateOf(page)).undoLabel, 'Draw road');
    await press(page, 'Control+z');
    eq(await roadCount(page), 0, 'all of it is one undo step');
    noErrors('shift');
    await context.close();
  });

  // ---- continue -----------------------------------------------------------------------------------------------------

  await run('continue', async () => {
    const { page, context } = await openApp();
    await pickTool(page, 'r');
    const rng = createRng(31);
    await moveTo(page, ...centre(5, 25));
    await page.mouse.down();
    await walk(page, samples(rng, centre(5, 25), centre(12, 25), { across: 0.3 }));
    await page.mouse.up();
    eq(await roadCount(page), 8);

    // hovering with Shift shows the line a click would draw: from the end of the road, L-shaped along the longer side first
    await moveTo(page, ...centre(20, 29));
    await page.keyboard.down('Shift');
    await frames(page, 2);
    let view = await viewOf(page);
    ok(view.paintPreview, 'a preview with Shift held');
    eq(view.paintPreview.cells[0], [12, 25], 'it starts at the end of the last stroke');
    eq(view.paintPreview.cells.at(-1), [20, 29]);
    eq(view.paintPreview.cells.length, 9 + 4);
    eq(view.paintPreview.label.text, '26 m · 13 cells');
    match(await statusOf(page), /Click to draw a line from the end of the last stroke/);
    await shot(page, 'continue-hover-light');
    await page.keyboard.up('Shift');
    await frames(page, 2);
    eq((await viewOf(page)).paintPreview, null, 'the preview goes with Shift');
    await page.keyboard.down('Shift');
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.up('Shift');
    eq(await roadCount(page), 8 + 12, 'the click drew 8 cells right and 4 down');
    eq(await cornersOf(page), ['20,25'], 'one corner, on the longer side first');
    eq((await stateOf(page)).undoLabel, 'Draw road');

    // chained: the next Shift+click goes on from (20, 29)
    await moveTo(page, ...centre(20, 31));
    await page.keyboard.down('Shift');
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.up('Shift');
    eq(await roadCount(page), 8 + 12 + 2);
    await press(page, 'Control+z');
    await press(page, 'Control+z');
    eq(await roadCount(page), 8, 'each Shift+click is one undo step');

    // after undo, and after Esc, the old end is forgotten: Shift+click is a plain click
    await moveTo(page, ...centre(30, 20));
    await page.keyboard.down('Shift');
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.up('Shift');
    eq(await roadCount(page), 9, 'after undo the click paints a single plate');

    // dragging with Shift is a new straight line, not a continuation
    await moveTo(page, ...centre(35, 8));
    await page.keyboard.down('Shift');
    await page.mouse.down();
    await walk(page, samples(rng, centre(35, 8), centre(35, 14), { step: 0.3 }));
    await page.mouse.up();
    await page.keyboard.up('Shift');
    eq(await roadCount(page), 9 + 7, 'a new line from the press cell: no L to the old end');
    ok(await outOf(page, 35, 8) !== undefined);

    await press(page, 'Escape');
    eq((await stateOf(page)).tool, 'select', 'with no stroke in progress, Esc leaves the tool');
    await pickTool(page, 'r');
    await moveTo(page, ...centre(40, 25));
    await page.keyboard.down('Shift');
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.up('Shift');
    eq(await roadCount(page), 9 + 7 + 1, 'Esc also forgets the end of the last stroke');
    noErrors('continue');
    await context.close();
  });

  // ---- free and the control -----------------------------------------------------------------------------------------

  await run('free', async () => {
    const { page, context } = await openApp();
    await pickTool(page, 'r');
    const draw = page.getByRole('group', { name: 'Draw mode' });
    ok(await draw.isVisible(), 'the Draw control is on screen with the Road tool');
    eq(await draw.locator('button').allInnerTexts(), ['Smart', 'Straight', 'Free']);
    eq(await draw.locator('[aria-pressed="true"]').allInnerTexts(), ['Smart']);
    ok(await page.locator('.drawmode__hint').isVisible(), 'with the Shift hint');
    eq((await page.locator('.drawmode__hint').innerText()).replace(/\s+/g, ' '), 'Shift = straight line');
    match(await statusOf(page), /Drag to draw\. Hold Shift for a straight line\./, 'the status line hint');
    await shot(page, 'control-smart-light');

    // Free keeps the wobble: a hand-shaken drag gives a ragged road
    await draw.getByRole('button', { name: 'Free' }).click();
    eq((await stateOf(page)).toolOptions.drawMode, 'free');
    await frames(page, 3);
    eq(await draw.locator('[aria-pressed="true"]').allInnerTexts(), ['Free']);
    await frames(page, 3);
    match(await statusOf(page), /Drag to draw freehand\. Hold Shift for a straight line\./);
    const rng = createRng(41);
    await moveTo(page, ...centre(5, 6));
    await page.mouse.down();
    await walk(page, samples(rng, centre(5, 6), centre(25, 6), { across: 1.6, step: 0.5 }));
    await shot(page, 'free-preview-light');
    await page.mouse.up();
    ok((await roadCount(page)) > 21, 'free: every cell the pointer visited');
    ok((await cornersOf(page)).length > 2, 'with the jogs of the wobble');
    await press(page, 'Control+z');

    // free with a fast single jump: the gap is filled with the horizontal-first L
    await moveTo(page, ...centre(2, 20));
    await page.mouse.down();
    await moveTo(page, ...centre(8, 24));
    await page.mouse.up();
    eq(await roadCount(page), 6 + 4 + 1);
    eq(await outOf(page, 8, 20), W | S, 'the L bends at the end of the longer leg');
    await press(page, 'Control+z');

    // Straight: every stroke is a straight line without holding Shift
    await draw.getByRole('button', { name: 'Straight' }).click();
    await frames(page, 3);
    match(await statusOf(page), /Every stroke is a straight line/);
    await moveTo(page, ...centre(5, 8));
    await page.mouse.down();
    await walk(page, samples(rng, centre(5, 8), centre(20, 10), { step: 0.4 }));
    eq((await viewOf(page)).paintPreview.guide, { axis: 'h', cell: [5, 8] });
    await page.mouse.up();
    eq(await roadCount(page), 16, 'a single straight line along the dominant axis');
    await press(page, 'Control+z');

    // the control by keyboard: focus Smart, press Space, the state follows
    await draw.getByRole('button', { name: 'Smart' }).focus();
    await press(page, 'Space');
    await frames(page, 3);
    eq((await stateOf(page)).toolOptions.drawMode, 'smart');
    eq(await draw.locator('[aria-pressed="true"]').allInnerTexts(), ['Smart']);
    eq((await stateOf(page)).tool, 'road', 'Space on a button did not switch tools or start the simulation');

    // the choice is a preference: saved, and back after a reload
    await draw.getByRole('button', { name: 'Free' }).click();
    await page.evaluate(() => window.__logiplan.store.persist());
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('logiplan:v1')).session.ui.toolOptions);
    eq(saved.drawMode, 'free', 'saved with the UI preferences');
    await page.reload();
    await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
    eq((await stateOf(page)).toolOptions.drawMode, 'free', 'restored after a reload');
    noErrors('free');
    await context.close();
  });

  // ---- one-way ------------------------------------------------------------------------------------------------------

  await run('oneway', async () => {
    const { page, context } = await openApp();
    await pickTool(page, 'o');
    match(await statusOf(page), /Drag to draw a one-way road in the driving direction\. Hold Shift for a straight line\./);
    const rng = createRng(51);
    // eastwards with a shaky hand
    await moveTo(page, ...centre(6, 8));
    await page.mouse.down();
    await walk(page, samples(rng, centre(6, 8), centre(20, 8), { across: 0.9 }));
    const view = await viewOf(page);
    eq(view.paintPreview.oneWay, true, 'chevrons in the preview');
    eq(view.paintPreview.dir, 1, 'pointing east');
    eq(view.paintPreview.label.text, '30 m · 15 cells');
    await shot(page, 'oneway-preview-light');
    await page.mouse.up();
    const east = [];
    for (let x = 6; x <= 20; x++) east.push(await outOf(page, x, 8));
    eq(east, [...Array(14).fill(E), 0], 'east links, the last cell has no exit');
    eq((await stateOf(page)).undoLabel, 'Draw one-way road');
    // westwards, with Shift
    await moveTo(page, ...centre(20, 12));
    await page.keyboard.down('Shift');
    await page.mouse.down();
    await walk(page, samples(rng, centre(20, 12), centre(8, 14), { step: 0.4 }));
    await page.mouse.up();
    await page.keyboard.up('Shift');
    const west = [];
    for (let x = 8; x <= 20; x++) west.push(await outOf(page, x, 12));
    eq(west, [0, ...Array(12).fill(W)], 'dragging west gives west links');
    // an L going south then west keeps its direction around the corner
    await moveTo(page, ...centre(30, 4));
    await page.mouse.down();
    await walk(page, samples(rng, centre(30, 4), centre(30, 12), { across: 0.3 }));
    await walk(page, samples(rng, centre(30, 12), centre(24, 12), { across: 0.3 }));
    await page.mouse.up();
    eq([await outOf(page, 30, 4), await outOf(page, 30, 11), await outOf(page, 30, 12), await outOf(page, 25, 12), await outOf(page, 24, 12)], [S, S, W, W, 0], 'around the corner');
    noErrors('oneway');
    await context.close();
  });

  // ---- blocked ------------------------------------------------------------------------------------------------------

  await run('blocked', async () => {
    const { page, context } = await openApp();
    await reset(page, { stations: [{ type: 'process', x: 20, y: 14, w: 3, h: 3 }] });
    await pickTool(page, 'r');
    const rng = createRng(61);
    await moveTo(page, ...centre(12, 15));
    await page.mouse.down();
    await walk(page, samples(rng, centre(12, 15), centre(32, 15), { across: 0.6 }));
    const view = await viewOf(page);
    eq(view.paintPreview.cells.at(-1), [19, 15], 'the road stops in front of the station');
    eq(view.paintPreview.blocked[0], [20, 15]);
    eq(view.paintPreview.blocked.length, 13, 'the 3 station cells and the 10 behind them are shown as blocked');
    match(await statusOf(page), /station or wall is in the way/);
    eq(view.paintPreview.label.text, '16 m · 8 cells', 'the label counts what will be painted');
    await shot(page, 'blocked-preview-light');
    await page.mouse.up();
    eq(await roadCount(page), 8, 'painted only up to the station');
    // starting on the station paints nothing
    const before = (await stateOf(page)).undoLabel;
    await moveTo(page, ...centre(21, 15));
    await page.mouse.down();
    await walk(page, samples(rng, centre(21, 15), centre(30, 15), { across: 0.3 }));
    await page.mouse.up();
    eq(await roadCount(page), 8);
    eq((await stateOf(page)).undoLabel, before, 'no commit');
    noErrors('blocked');
    await context.close();
  });

  // ---- other tools --------------------------------------------------------------------------------------------------

  await run('other', async () => {
    const { page, context } = await openApp();
    await pickTool(page, 'r');
    const rng = createRng(71);
    await moveTo(page, ...centre(5, 10));
    await page.mouse.down();
    await walk(page, samples(rng, centre(5, 10), centre(30, 10), { across: 0.5 }));
    await page.mouse.up();
    eq(await roadCount(page), 26);

    // Alt-drag erases, straight in smart mode: a hand-shaken drag takes out one row segment
    await moveTo(page, ...centre(10, 10));
    await page.keyboard.down('Alt');
    await page.mouse.down();
    await walk(page, samples(rng, centre(10, 10), centre(15, 10), { across: 0.9 }));
    eq((await viewOf(page)).paintPreview.cells.length, 6);
    await page.mouse.up();
    await page.keyboard.up('Alt');
    eq(await roadCount(page), 20, 'cells 10..15 are gone');
    eq((await stateOf(page)).undoLabel, 'Erase road');
    await press(page, 'Control+z');
    eq(await roadCount(page), 26);

    // the eraser: smart too
    await pickTool(page, 'e');
    match(await statusOf(page), /Drag to erase roads, walls and labels\. Hold Shift for a straight line\./);
    ok(await page.getByRole('group', { name: 'Draw mode' }).isVisible(), 'the eraser has the Draw control too');
    await moveTo(page, ...centre(20, 10));
    await page.mouse.down();
    await walk(page, samples(rng, centre(20, 10), centre(25, 10), { across: 0.9 }));
    await page.mouse.up();
    eq(await roadCount(page), 20);
    eq((await stateOf(page)).undoLabel, 'Erase road');
    await press(page, 'Control+z');

    // the slow zone
    await pickTool(page, 'z');
    ok(await page.getByRole('group', { name: 'Draw mode' }).isVisible() && await page.getByRole('group', { name: 'Speed limit of the slow zone' }).isVisible(), 'speed limit and draw mode side by side');
    await shot(page, 'control-speedzone-light');
    await moveTo(page, ...centre(8, 10));
    await page.mouse.down();
    await walk(page, samples(rng, centre(8, 10), centre(14, 10), { across: 0.9 }));
    await page.mouse.up();
    const roads = (await layoutOf(page)).roads;
    eq(Object.entries(roads).filter(([, r]) => r.limit === 0.5).map(([k]) => k).sort(), ['10,10', '11,10', '12,10', '13,10', '14,10', '8,10', '9,10']);
    eq((await stateOf(page)).undoLabel, 'Set speed zone');

    // the control is only there for the tools that have it
    for (const [key, visible] of [['v', false], ['2', false], ['w', false], ['f', false], ['o', true], ['r', true], ['e', true], ['z', true]]) {
      await pickTool(page, key);
      eq(await page.getByRole('group', { name: 'Draw mode' }).isVisible(), visible, `Draw control with key ${key}`);
    }
    await pickTool(page, 'w');
    ok(await page.getByRole('group', { name: 'Obstacle type' }).isVisible(), 'the wall tool keeps its own options');
    noErrors('other');
    await context.close();
  });

  // ---- Esc ----------------------------------------------------------------------------------------------------------

  await run('escape', async () => {
    const { page, context } = await openApp();
    await pickTool(page, 'r');
    const rng = createRng(81);
    await moveTo(page, ...centre(5, 5));
    await page.mouse.down();
    await walk(page, samples(rng, centre(5, 5), centre(15, 5), { across: 0.4 }));
    ok((await viewOf(page)).paintPreview);
    await press(page, 'Escape');
    eq((await viewOf(page)).paintPreview, null, 'Esc removes the preview');
    await moveTo(page, 20, 5.5);
    await page.mouse.up();
    eq(await roadCount(page), 0, 'releasing the button afterwards commits nothing');
    eq((await stateOf(page)).tool, 'road');
    noErrors('escape');
    await context.close();
  });

  // ---- touch --------------------------------------------------------------------------------------------------------

  await run('touch', async () => {
    const { page, context } = await openApp({ viewport: NARROW, touch: true });
    const cdp = await context.newCDPSession(page);
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y], i) => ({ x, y, id: i + 1 })) });
    await page.locator('[data-tool="road"]').tap();
    await frames(page, 2);
    eq((await stateOf(page)).tool, 'road');
    const draw = page.getByRole('group', { name: 'Draw mode' });
    ok(await draw.isVisible(), 'the Draw control on a phone');
    ok(!(await page.locator('.drawmode__hint').isVisible()), 'no "Shift = straight line" on a touch screen');
    const box = await page.locator('.stage__options .stagebar').boundingBox();
    ok(box.x >= 0 && box.x + box.width <= NARROW.width + 0.5, `the options bar fits the screen (${Math.round(box.x)}..${Math.round(box.x + box.width)})`);
    const rng = createRng(91);
    const cellPx = await page.evaluate(() => window.__logiplan.ctx.camera.zoom * window.__logiplan.store.getState().layout.grid.cellSize);
    // a finger: +-1.5 cells of wobble across, over 30 cells
    const start = await at(page, ...centre(6, 8));
    await touch('touchStart', [start]);
    const list = samples(rng, centre(6, 8), centre(36, 8), { step: 0.5, across: 1.5, along: 0.4 });
    for (const [x, y] of list) await touch('touchMove', [await at(page, x, y)]);
    const view = await viewOf(page);
    eq(view.paintPreview.cells.length, 31, `the finger's wobble (cell ${cellPx.toFixed(1)} px) made no jog`);
    ok(view.paintPreview.label.above === true, 'the label sits above the finger');
    await shot(page, 'touch-preview-light');
    await touch('touchEnd', []);
    const keys = await roadKeys(page);
    eq(keys.length, 31, 'one straight road of 31 cells');
    ok(keys.every((k) => k.endsWith(',8')));
    eq(await cornersOf(page), []);
    eq((await stateOf(page)).undoLabel, 'Draw road');
    // an L with the finger: the turn needs to be deliberate (a bigger offset than with a mouse on a cell this small)
    const a = await at(page, ...centre(6, 14));
    await touch('touchStart', [a]);
    for (const [x, y] of samples(rng, centre(6, 14), centre(20, 14), { step: 0.5, across: 0.6 })) await touch('touchMove', [await at(page, x, y)]);
    for (const [x, y] of samples(rng, centre(20, 14), centre(20, 24), { step: 0.5, across: 0.6 })) await touch('touchMove', [await at(page, x, y)]);
    await touch('touchEnd', []);
    eq(await cornersOf(page), ['20,14'], 'a deliberate L with a finger has one corner');
    await shot(page, 'touch-done-light');
    // Straight from the control: a finger cannot hold Shift
    await draw.getByRole('button', { name: 'Straight' }).tap();
    eq((await stateOf(page)).toolOptions.drawMode, 'straight');
    const b = await at(page, ...centre(6, 28));
    await touch('touchStart', [b]);
    for (const [x, y] of samples(rng, centre(6, 28), centre(30, 29), { step: 0.5 })) await touch('touchMove', [await at(page, x, y)]);
    await touch('touchEnd', []);
    ok((await roadKeys(page)).filter((k) => k.endsWith(',28')).length === 25, 'Straight from the control: a straight line with a finger');
    noErrors('touch');
    await context.close();
  });

  // ---- dark ---------------------------------------------------------------------------------------------------------

  await run('dark', async () => {
    const { page, context } = await openApp({ colorScheme: 'dark' });
    await pickTool(page, 'r');
    const rng = createRng(101);
    await moveTo(page, ...centre(6, 12));
    await page.keyboard.down('Shift');
    await page.mouse.down();
    await walk(page, samples(rng, centre(6, 12), centre(22, 14), { step: 0.4 }));
    await shot(page, 'shift-lock-preview-dark');
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await pickTool(page, 'o');
    await moveTo(page, ...centre(10, 18));
    await page.mouse.down();
    await walk(page, samples(rng, centre(10, 18), centre(10, 26), { across: 0.5 }));
    await walk(page, samples(rng, centre(10, 26), centre(26, 26), { across: 0.5 }));
    await shot(page, 'oneway-preview-dark');
    await page.mouse.up();
    await moveTo(page, ...centre(30, 20));
    await page.keyboard.down('Shift');
    await frames(page, 2);
    await shot(page, 'continue-hover-dark');
    await page.keyboard.up('Shift');
    await pickTool(page, 'z');
    await shot(page, 'control-speedzone-dark');
    noErrors('dark');
    await context.close();
  });

  // ---- narrow, light and dark -------------------------------------------------------------------------------------

  await run('narrow', async () => {
    for (const colorScheme of ['light', 'dark']) {
      const { page, context } = await openApp({ viewport: NARROW, colorScheme });
      await pickTool(page, 'z');
      const bar = await page.locator('.stage__options .stagebar').boundingBox();
      ok(bar.x >= -0.5 && bar.x + bar.width <= NARROW.width + 0.5, `${colorScheme}: the speed-zone options fit 390 px (${Math.round(bar.x)}..${Math.round(bar.x + bar.width)})`);
      eq(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, `${colorScheme}: no horizontal page scroll`);
      await shot(page, `control-speedzone-narrow-${colorScheme}`);
      await pickTool(page, 'r');
      const rng = createRng(111);
      await moveTo(page, ...centre(6, 6));
      await page.keyboard.down('Shift');
      await page.mouse.down();
      await walk(page, samples(rng, centre(6, 6), centre(30, 7), { step: 0.5 }));
      await shot(page, `shift-lock-narrow-${colorScheme}`);
      await page.mouse.up();
      await page.keyboard.up('Shift');
      noErrors(`narrow ${colorScheme}`);
      await context.close();
    }
  });

  console.log(`\nAll road drawing checks passed (${checks} checks).`);
});
