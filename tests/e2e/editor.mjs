// Behavioural + visual check of the canvas editor (js/ui/editor.js) in real Chromium, with real mouse, keyboard and
// touch events. Run: node tests/e2e/editor.mjs   (screenshots: e2e-output/editor-*.png)
//
// The page is tests/e2e/editor-harness.html: the real store, camera, renderer and editor on a realistic plant, with a
// stand-in for the app shell (tool palette, undo buttons, status line, toasts). Every section opens a fresh page.
import assert from 'node:assert/strict';
import path from 'node:path';
import { withBrowser, OUT } from './browser.mjs';

await withBrowser(async ({ page, url, errors, browser }) => {
  // ---- plumbing -------------------------------------------------------------------------------------------------

  async function open(layout = 'empty', query = '') {
    await page.goto(url(`/tests/e2e/editor-harness.html?layout=${layout}${query}`));
    await page.waitForFunction(() => window.harness && window.harness.ready);
  }

  /** Client position of a cell: at(cx, cy) is its centre, at(cx, cy, 0, 0) its top-left corner. */
  const at = (cx, cy, fx = 0.5, fy = 0.5) => page.evaluate(([a, b, c, d]) => window.harness.cellToClient(a, b, c, d), [cx, cy, fx, fy]);
  /** Client position of a fractional cell coordinate (e.g. a rectangle corner), nudged 1 px into the cell. */
  const atCells = (x, y) => at(Math.floor(x), Math.floor(y), x - Math.floor(x) + 0.03, y - Math.floor(y) + 0.03);
  const layout = () => page.evaluate(() => window.harness.layout());
  const ui = () => page.evaluate(() => window.harness.state().ui);
  const undoLabel = () => page.evaluate(() => window.harness.state().undoLabel);
  const redoLabel = () => page.evaluate(() => window.harness.state().redoLabel);
  const view = () => page.evaluate(() => {
    const v = window.harness.view();
    return { ghost: v.ghost, paintPreview: v.paintPreview, flowPreview: v.flowPreview, marquee: v.marquee, hover: v.hover, resizeHandles: v.resizeHandles, tool: v.tool };
  });
  const status = () => page.evaluate(() => window.harness.status());
  const toasts = () => page.evaluate(() => window.harness.toasts.map((t) => t.message));
  const cursor = () => page.evaluate(() => document.getElementById('plant').style.cursor);
  const station = async (id) => (await layout()).stations.find((s) => s.id === id);
  const selection = async () => (await ui()).selection;
  const roadCount = async () => Object.keys((await layout()).roads).length;
  const road = async (cx, cy) => (await layout()).roads[`${cx},${cy}`];
  const sel = (kind, ...ids) => ({ kind, ids });
  const NONE = { kind: null, ids: [] };
  const rectOf = (s) => [s.x, s.y, s.w, s.h];
  const flowPoint = (id) => page.evaluate((i) => window.harness.flowPoint(i), id);

  const hold = async (mods) => { for (const m of mods) await page.keyboard.down(m); };
  const free = async (mods) => { for (const m of [...mods].reverse()) await page.keyboard.up(m); };
  /** Move the pointer to a cell (`[cx, cy]` or `[cx, cy, fx, fy]`). */
  const move = async (cell, steps = 1) => { const p = await at(...cell); await page.mouse.move(p.x, p.y, { steps }); };
  const click = async (cell, { mods = [], double = false } = {}) => {
    await move(cell);
    await hold(mods);
    if (double) { const p = await at(...cell); await page.mouse.dblclick(p.x, p.y); }
    else { await page.mouse.down(); await page.mouse.up(); }
    await free(mods);
  };
  /** Press on the first cell and move through the others; the button stays down when `keep` is set. */
  const drag = async (cells, { mods = [], steps = 4, keep = false, button = 'left' } = {}) => {
    await move(cells[0]);
    await hold(mods);
    await page.mouse.down({ button });
    for (const c of cells.slice(1)) await move(c, steps);
    if (!keep) {
      await page.mouse.up({ button });
      await free(mods);
    }
  };
  const release = async (mods = []) => { await page.mouse.up(); await free(mods); };
  const press = (k) => page.keyboard.press(k);
  const frame = (p = page) => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const snap = async (name, p = page) => { await frame(p); await p.screenshot({ path: path.join(OUT, `editor-${name}.png`) }); };
  const theme = async (mode) => { await page.evaluate((m) => window.harness.setTheme(m), mode); await frame(); };

  let section = '';
  const test = async (name, fn) => {
    section = name;
    await fn();
    console.log(`  ok  ${name}`);
  };

  // ---- tools, shortcuts and two-way sync with the palette --------------------------------------------------------------

  await test('tool shortcuts, cursors and the two-way sync with the palette', async () => {
    await open();
    assert.equal((await ui()).tool, 'select');
    assert.equal(await page.evaluate(() => window.harness.editor.tool), 'select');
    const keys = { v: 'select', h: 'pan', r: 'road', o: 'oneway', z: 'speedzone', e: 'erase', 1: 'source', 2: 'process', 3: 'storage', 4: 'sink', 5: 'depot', w: 'obstacle', t: 'label', f: 'flow' };
    const cursors = { select: 'default', pan: 'grab', label: 'text' };
    for (const [k, tool] of Object.entries(keys)) {
      await press(k);
      assert.equal((await ui()).tool, tool, `key ${k}`);
      assert.equal(await page.evaluate(() => window.harness.editor.tool), tool);
      assert.equal(await page.locator('[data-tool][aria-pressed="true"]').getAttribute('data-tool'), tool, 'the palette follows the keyboard');
      assert.equal(await cursor(), cursors[tool] || 'crosshair', `cursor of ${tool}`);
      assert.equal((await view()).tool, tool, 'renderer.view.tool is mirrored');
    }
    await page.locator('[data-tool="road"]').click();
    assert.equal(await page.evaluate(() => window.harness.editor.tool), 'road', 'a palette button (store.setUi) switches the editor');
    assert.equal(await cursor(), 'crosshair');
    await page.evaluate(() => window.harness.editor.setTool('storage'));
    assert.equal((await ui()).tool, 'storage', 'editor.setTool writes the store');
    assert.equal(await page.locator('[data-tool="storage"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => window.harness.editor.setTool('warp-drive')), false, 'unknown tools are refused');
    assert.equal((await ui()).tool, 'storage');
    assert.match(await status(), /Storage/);
  });

  await test('shortcuts stay out of the way of text fields, dialogs and browser shortcuts', async () => {
    await open();
    await page.locator('#project-name').focus();
    await page.keyboard.type('rotor 1');
    assert.equal(await page.locator('#project-name').inputValue(), 'rotor 1Test plant', 'typing goes into the field');
    assert.equal((await ui()).tool, 'select', 'no tool was switched while typing');
    await page.keyboard.press('Control+z');
    assert.equal(await undoLabel(), null);
    await page.locator('#project-name').blur();
    await page.evaluate(() => { const d = document.createElement('div'); d.setAttribute('role', 'dialog'); d.id = 'dlg'; document.body.append(d); });
    await press('r');
    assert.equal((await ui()).tool, 'select', 'a dialog is open: no shortcuts');
    await page.evaluate(() => document.getElementById('dlg').remove());
    await press('r');
    assert.equal((await ui()).tool, 'road');
    const prevented = await page.evaluate(() => {
      const out = {};
      const keys = { ctrlR: { key: 'r', ctrlKey: true }, ctrlW: { key: 'w', ctrlKey: true }, cmdT: { key: 't', metaKey: true }, altLeft: { key: 'ArrowLeft', altKey: true }, ctrlF: { key: 'f', ctrlKey: true } };
      for (const [name, init] of Object.entries(keys)) {
        const e = new KeyboardEvent('keydown', { ...init, cancelable: true, bubbles: true });
        window.dispatchEvent(e);
        out[name] = e.defaultPrevented;
      }
      return out;
    });
    assert.deepEqual(prevented, { ctrlR: false, ctrlW: false, cmdT: false, altLeft: false, ctrlF: false }, 'browser shortcuts are left alone');
    assert.equal((await ui()).tool, 'road', 'and they did not switch tools');
  });

  // ---- road tools ------------------------------------------------------------------------------------------------------

  await test('road: free-hand loop is ONE undo step with a live preview and two-way links; undo and redo', async () => {
    await open();
    await press('r');
    await move([5, 5]);
    assert.equal((await view()).hover.kind, 'cell');
    assert.deepEqual((await view()).hover.cell, [5, 5]);
    assert.match(await status(), /^Cell 5, 5 \(10 m, 10 m\) · Drag to draw a two-way road\. Shift = straight line/);
    await drag([[5, 5], [20, 5], [20, 15], [5, 15], [5, 5]], { keep: true });
    const mid = await view();
    assert.equal(mid.paintPreview.cells.length > 40, true, 'live preview');
    assert.equal(mid.paintPreview.oneWay, false);
    assert.equal(await roadCount(), 0, 'nothing is committed before the button is released');
    assert.equal(await undoLabel(), null);
    assert.match(await status(), /^Road: 50 cells \(100 m\)/);
    await snap('01-road-preview-light');
    await release();
    assert.equal(await roadCount(), 50);
    assert.equal(await undoLabel(), 'Draw road', 'one commit with a readable label');
    assert.equal((await view()).paintPreview, null, 'no stale preview');
    const E = 2, S = 4, W = 8, N = 1;
    assert.deepEqual([(await road(5, 5)).out, (await road(10, 5)).out, (await road(20, 5)).out, (await road(20, 10)).out], [E | S, E | W, W | S, S | N]);
    await snap('02-road-done-light');
    await press('Control+z');
    assert.equal(await roadCount(), 0);
    assert.equal(await redoLabel(), 'Draw road');
    await press('Control+Shift+Z');
    assert.equal(await roadCount(), 50);
    await press('Control+z');
    await press('Control+y');
    assert.equal(await roadCount(), 50, 'Ctrl+Y redoes too');
  });

  await test('road: a fast mouse leaves gaps that are filled with an L-shaped path; a click paints one plate', async () => {
    await open();
    await press('r');
    await move([2, 2]);
    await page.mouse.down();
    await move([8, 6], 1); // one single mouse move across 6 x 4 cells
    await page.mouse.up();
    assert.equal(await roadCount(), 6 + 4 + 1);
    for (const c of [[3, 2], [8, 2], [8, 3], [8, 6]]) assert.ok(await road(...c), `cell ${c}`);
    assert.equal(await road(5, 4), undefined, 'the gap is filled along an L, not as a diagonal blob');
    await page.mouse.move(...Object.values(await at(30, 20)));
    await page.mouse.down();
    await page.mouse.move(1900, 700, { steps: 3 }); // far outside the window: the pointer stays captured
    await page.mouse.up();
    assert.ok(await road(39, 20), 'the stroke follows the pointer to the edge of the plant');
    assert.equal(await road(40, 20), undefined, 'and no further');
    await press('Control+z');
    await click([12, 12]);
    assert.equal(await roadCount(), 12);
    assert.deepEqual(await road(12, 12), { out: 0 }, 'a single plate with no links');
    assert.equal(await undoLabel(), 'Draw road');
    await click([12, 12]);
    await press('Control+z');
    assert.equal(await road(12, 12), undefined, 'clicking an existing plate changed nothing, so one undo removed the plate');
  });

  await test('road: Shift draws a straight L-shaped line from the start, also when pressed in mid-stroke', async () => {
    await open();
    await press('r');
    await drag([[2, 10], [9, 13]], { mods: ['Shift'] });
    assert.equal(await roadCount(), 8 + 3, 'horizontal leg first, then the vertical one');
    assert.ok(await road(9, 10) && await road(9, 13));
    assert.equal(await road(5, 12), undefined);
    await press('Control+z');
    await drag([[2, 4], [6, 4], [6, 7]], { keep: true });
    assert.equal((await view()).paintPreview.cells.length, 5 + 3);
    await hold(['Shift']);
    assert.deepEqual((await view()).paintPreview.cells.at(-1), [6, 7]);
    assert.equal((await view()).paintPreview.cells.length, 5 + 3, 'the L from (2,4) to (6,7): 5 + 3 cells');
    await move([4, 9], 2);
    assert.equal((await view()).paintPreview.cells.length, 3 + 5, 'Shift: straight from the start (2,4) to (4,9)');
    assert.deepEqual((await view()).paintPreview.cells.at(-1), [4, 9]);
    await free(['Shift']);
    await move([5, 9], 1);
    assert.equal((await view()).paintPreview.cells.length, 9, 'without Shift the stroke continues free-hand from where the straight line ended');
    await release();
    assert.equal(await undoLabel(), 'Draw road');
  });

  await test('road: a stroke that hits a station stops there and shows the rest in red; nothing is painted inside', async () => {
    await open();
    await press('2');
    await click([20, 10]); // a workstation on cells 19..21 x 9..11
    await press('r');
    await drag([[14, 10], [26, 10]], { keep: true });
    const v = await view();
    assert.deepEqual(v.paintPreview.cells.at(-1), [18, 10]);
    assert.deepEqual(v.paintPreview.blocked[0], [19, 10]);
    assert.equal(v.paintPreview.blocked.length, 8, 'the blocked part: the 3 station cells and the 5 beyond');
    assert.match(await status(), /station or wall is in the way/);
    await snap('03-road-blocked-light');
    await release();
    assert.equal(await roadCount(), 5, 'painted only up to the station');
    for (let x = 14; x <= 18; x++) assert.ok(await road(x, 10), `cell ${x}`);
    assert.equal(await road(22, 10), undefined);
    await drag([[20, 10], [24, 10]]);
    assert.equal(await roadCount(), 5, 'starting on a station paints nothing');
    assert.match((await toasts()).at(-1), /cannot be placed on stations or walls/);
  });

  await test('road: Alt+drag erases while a road tool is active', async () => {
    await open();
    await press('r');
    await drag([[3, 3], [12, 3]]);
    assert.equal(await roadCount(), 10);
    await drag([[5, 3], [8, 3]], { mods: ['Alt'] });
    assert.equal(await roadCount(), 6);
    assert.equal(await undoLabel(), 'Erase road');
    assert.deepEqual([(await road(4, 3)).out, (await road(9, 3)).out], [8, 2], 'the links into the erased cells are gone');
  });

  await test('one-way: links follow the drag direction; the preview shows chevrons', async () => {
    await open();
    await press('o');
    assert.match(await status(), /one-way/i);
    await drag([[4, 6], [10, 6]], { keep: true });
    const pv = (await view()).paintPreview;
    assert.equal(pv.oneWay, true);
    assert.equal(pv.dir, 1, 'east');
    assert.match(await status(), /^One-way road: 7 cells/);
    await snap('04-oneway-preview-light');
    await release();
    assert.equal(await undoLabel(), 'Draw one-way road');
    const east = [];
    for (let x = 4; x <= 10; x++) east.push((await road(x, 6)).out);
    assert.deepEqual(east, [2, 2, 2, 2, 2, 2, 0], 'east only; the last cell has no exit');
    await drag([[10, 8], [4, 8]]);
    const west = [];
    for (let x = 4; x <= 10; x++) west.push((await road(x, 8)).out);
    assert.deepEqual(west, [0, 8, 8, 8, 8, 8, 8], 'dragging west gives west links');
  });

  await test('Esc in the middle of a stroke cancels it without a commit; a second Esc leaves the tool', async () => {
    await open();
    await press('r');
    await drag([[3, 3], [9, 3]], { keep: true });
    assert.ok((await view()).paintPreview);
    await press('Escape');
    assert.equal((await view()).paintPreview, null);
    assert.equal(await roadCount(), 0);
    assert.equal((await ui()).tool, 'road', 'the first Esc only cancelled the gesture');
    await move([12, 3], 3);
    await page.mouse.up();
    assert.equal(await roadCount(), 0, 'releasing the button afterwards commits nothing');
    await press('Escape');
    assert.equal((await ui()).tool, 'select');
    assert.equal(await undoLabel(), null);
  });

  await test('speed zone: paints the limit on road cells (Z again cycles the limit, Alt removes it)', async () => {
    await open();
    await press('r');
    await drag([[3, 8], [14, 8]]);
    await press('z');
    assert.equal((await ui()).toolOptions.factor, 0.5);
    assert.match(await status(), /50 %/);
    await drag([[5, 7], [5, 9], [9, 9], [9, 8], [10, 8]], { keep: true });
    assert.equal((await view()).paintPreview.cells.length, 3, 'only road cells are previewed');
    await snap('05-speedzone-preview-light');
    await release();
    assert.equal(await undoLabel(), 'Set speed zone');
    for (const x of [5, 9, 10]) assert.equal((await road(x, 8)).limit, 0.5, `cell ${x}`);
    assert.equal((await road(7, 8)).limit, undefined);
    await press('z');
    assert.equal((await ui()).toolOptions.factor, 0.25);
    assert.match(await status(), /25 %/);
    await drag([[12, 8], [13, 8]]);
    assert.equal((await road(13, 8)).limit, 0.25);
    await drag([[3, 8], [14, 8]], { mods: ['Alt'] });
    assert.equal(await undoLabel(), 'Clear speed zone');
    assert.equal((await road(9, 8)).limit, undefined);
    const before = await undoLabel();
    await drag([[3, 12], [8, 12]]);
    assert.equal(await undoLabel(), before, 'no road under the stroke: no commit');
  });

  await test('eraser: sweeps roads, carves walls cell by cell, removes labels; one undo step each', async () => {
    await open('starter');
    const before = await layout();
    await press('e');
    assert.match(await status(), /Drag to erase roads, walls and labels/);
    await drag([[5, 18], [5, 14], [5, 12]], { steps: 3 });
    assert.equal(await undoLabel(), 'Erase road');
    assert.equal(await road(5, 12), undefined);
    await press('Control+z');
    await drag([[16, 16], [12, 16], [7, 16]], { keep: true, steps: 3 });
    const pv = (await view()).paintPreview;
    assert.equal(pv.cells.length, 10);
    assert.deepEqual(pv.blocked, pv.cells, 'shown in red');
    await snap('06-erase-preview-light');
    await release();
    assert.equal(await undoLabel(), 'Erase rack');
    const racks = (await layout()).obstacles.filter((o) => o.kind === 'rack');
    assert.equal(racks.reduce((n, o) => n + o.w * o.h, 0), 18 - 9, 'the 9 cells of the lower row are gone, the upper row is still there');
    await press('Control+z');
    await click([12, 4]); // the "Inbound" label sits at 12, 4.2
    assert.equal((await layout()).labels.some((l) => l.text === 'Inbound'), false);
    assert.equal(await undoLabel(), 'Erase label');
    await press('Control+z');
    assert.deepEqual(await layout(), before, 'every erase was undone completely');
    await click([26, 13]);
    assert.equal((await layout()).obstacles.some((o) => o.x === 26 && o.y === 13), false, 'a single-cell column disappears');
    assert.equal(await undoLabel(), 'Erase column');
  });

  // ---- placing bricks ---------------------------------------------------------------------------------------------------

  await test('stations: ghost on hover (green/red), click places, the tool stays, the new station is selected', async () => {
    await open();
    await press('2');
    await move([10, 8]);
    let g = (await view()).ghost;
    assert.equal(g.kind, 'station');
    assert.equal(g.type, 'process');
    assert.deepEqual(g.rect, { x: 9, y: 7, w: 3, h: 3 }, 'default size, centred on the pointer cell');
    assert.equal(g.valid, true);
    assert.match(await status(), /^Workstation · 3 × 3 cells \(6 × 6 m\)$/);
    await snap('07-place-ghost-light');
    await page.mouse.down();
    await page.mouse.up();
    assert.deepEqual(rectOf(await station('s1')), [9, 7, 3, 3]);
    assert.equal((await station('s1')).name, 'Workstation 1');
    assert.equal(await undoLabel(), 'Add workstation');
    assert.deepEqual(await selection(), sel('station', 's1'), 'the new station is selected');
    assert.equal((await ui()).tool, 'process', 'the tool stays active');
    g = (await view()).ghost;
    assert.equal(g.valid, false, 'the ghost over the new station is red');
    await snap('08-place-invalid-light');
    await page.mouse.down();
    await page.mouse.up();
    assert.equal((await layout()).stations.length, 1, 'clicking on an occupied spot places nothing');
    assert.match((await toasts()).at(-1), /Cannot place Workstation here: another station is in the way\./);
    await click([20, 8]);
    assert.equal((await station('s2')).name, 'Workstation 2');
    assert.equal((await layout()).stations.length, 2);
  });

  await test('stations: press-drag sizes the brick from any direction, at least 1 x 1, clamped to the baseplate', async () => {
    await open();
    await press('1');
    await drag([[20, 5], [25, 8]], { keep: true });
    assert.deepEqual((await view()).ghost.rect, { x: 20, y: 5, w: 6, h: 4 });
    assert.match(await status(), /6 × 4 cells \(12 × 8 m\)/);
    await release();
    assert.deepEqual(rectOf(await station('s1')), [20, 5, 6, 4]);
    assert.equal((await station('s1')).type, 'source');
    assert.equal((await station('s1')).name, 'Goods in 1');
    await press('4');
    await drag([[12, 20], [8, 17]]);
    assert.deepEqual(rectOf(await station('s2')), [8, 17, 5, 4], 'dragging up and to the left works the same');
    await press('3');
    await drag([[30, 20], [60, 40]]);
    assert.deepEqual(rectOf(await station('s3')), [30, 20, 10, 4], 'clamped to the 40 x 24 baseplate');
    await press('5');
    await move([2, 2]);
    const p = await at(2, 2);
    await page.mouse.down();
    await page.mouse.move(p.x + 2, p.y + 1);
    await page.mouse.up();
    assert.deepEqual(rectOf(await station('s4')), [1, 2, 3, 2], 'a tiny jiggle within one cell is still a click: default size');
    await press('2');
    await drag([[10, 14], [10, 14]]);
    assert.deepEqual(rectOf(await station('s5')), [9, 13, 3, 3]);
    assert.equal(await undoLabel(), 'Add workstation');
  });

  await test('stations: invalid spots (on a road, off the plate) are red and refuse to place', async () => {
    await open();
    await press('r');
    await drag([[5, 5], [15, 5]]);
    await press('2');
    await move([10, 5]);
    assert.equal((await view()).ghost.valid, false);
    assert.match(await status(), /a road is in the way/);
    await page.mouse.down();
    await page.mouse.up();
    assert.equal((await layout()).stations.length, 0);
    await move([0, 0]);
    assert.deepEqual((await view()).ghost.rect, { x: 0, y: 0, w: 3, h: 3 }, 'pushed back inside the plate');
    assert.equal((await view()).ghost.valid, true);
    await drag([[6, 7], [12, 4]]);
    assert.equal((await layout()).stations.length, 0, 'a dragged rectangle that covers the road is refused');
    assert.match((await toasts()).at(-1), /road is in the way/);
  });

  await test('stations: Shift+click places one brick and returns to Select; Esc leaves the tool', async () => {
    await open();
    await press('5');
    await click([10, 10], { mods: ['Shift'] });
    assert.equal((await layout()).stations.length, 1);
    assert.equal((await ui()).tool, 'select');
    assert.deepEqual(await selection(), sel('station', 's1'));
    await press('1');
    await move([20, 10]);
    assert.ok((await view()).ghost);
    await press('Escape');
    assert.equal((await ui()).tool, 'select');
    assert.equal((await view()).ghost, null, 'no ghost is left behind');
  });

  await test('obstacle: W picks the type (W again cycles), click places 1 x 1, drag sizes, selected after placing', async () => {
    await open();
    await press('w');
    assert.equal((await ui()).toolOptions.kind, 'wall');
    await press('w');
    assert.equal((await ui()).toolOptions.kind, 'rack');
    assert.match(await status(), /rack/i);
    await move([6, 6]);
    assert.equal((await view()).ghost.kind, 'obstacle');
    assert.equal((await view()).ghost.obstacleKind, 'rack');
    await click([6, 6]);
    assert.deepEqual((await layout()).obstacles[0], { id: 'o1', x: 6, y: 6, w: 1, h: 1, kind: 'rack' });
    assert.equal(await undoLabel(), 'Add rack');
    assert.deepEqual(await selection(), sel('obstacle', 'o1'));
    await press('w');
    assert.equal((await ui()).toolOptions.kind, 'column');
    await press('w');
    assert.equal((await ui()).toolOptions.kind, 'wall');
    await drag([[10, 10], [20, 10]]);
    assert.deepEqual((await layout()).obstacles[1], { id: 'o2', x: 10, y: 10, w: 11, h: 1, kind: 'wall' });
    assert.equal(await undoLabel(), 'Add wall');
    await click([12, 10]);
    assert.equal((await layout()).obstacles.length, 2, 'cannot place a wall on a wall');
    await page.evaluate(() => window.harness.editor.setToolOptions({ kind: 'column' }));
    assert.equal((await view()).ghost.obstacleKind, 'column', 'setToolOptions updates the ghost');
  });

  // ---- select tool ------------------------------------------------------------------------------------------------------

  await test('select: click selects (station, obstacle, label, flow, road cell, fleet); empty ground clears; selecting never commits', async () => {
    await open('starter');
    await click([20, 13]);
    assert.deepEqual(await selection(), sel('station', 's2'));
    assert.equal((await view()).resizeHandles, true);
    await click([26, 13]);
    assert.deepEqual(await selection(), sel('obstacle', 'o2'));
    await click([23, 11]);
    assert.deepEqual(await selection(), sel('label', 'l2'), 'the label is hit by its text box');
    const fp = await flowPoint('f2');
    await page.mouse.click(fp.x, fp.y);
    assert.deepEqual(await selection(), sel('flow', 'f2'), 'the flow curve between Assembly and Dispatch');
    await click([10, 9]);
    assert.deepEqual(await selection(), sel('cell', '10,9'), 'a road cell: kind "cell", id "cx,cy"');
    await click([30, 3]);
    assert.deepEqual(await selection(), NONE, 'empty ground clears the selection');
    assert.equal(await page.evaluate(() => window.harness.placeVehicle(5, 12)), 'v1#1');
    await click([5, 12]);
    assert.deepEqual(await selection(), sel('fleet', 'v1'), 'a vehicle selects its fleet');
    assert.equal(await undoLabel(), null);
  });

  await test('select: Shift+click toggles, Ctrl+A selects all stations, Esc clears', async () => {
    await open('starter');
    await click([20, 13]);
    await click([9, 6], { mods: ['Shift'] });
    assert.deepEqual(await selection(), sel('station', 's2', 's1'));
    await click([38, 14], { mods: ['Shift'] });
    assert.deepEqual((await selection()).ids, ['s2', 's1', 's3']);
    await click([9, 6], { mods: ['Shift'] });
    assert.deepEqual((await selection()).ids, ['s2', 's3'], 'Shift+click on a selected item removes it');
    await click([20, 13]);
    assert.deepEqual(await selection(), sel('station', 's2'), 'a plain click on one of several selects just that one');
    await press('Escape');
    assert.deepEqual(await selection(), NONE);
    await press('Control+a');
    assert.equal((await selection()).ids.length, 4);
    assert.equal((await selection()).kind, 'station');
    await press('Escape');
    assert.deepEqual(await selection(), NONE);
    assert.equal(await undoLabel(), null);
  });

  await test('select: marquee selects what it touches (partly inside counts), Shift adds, an empty area clears', async () => {
    await open('starter');
    await drag([[2, 3], [10, 8]], { keep: true });
    assert.ok((await view()).marquee, 'rubber band while dragging');
    assert.match(await status(), /1 station in the area/);
    await snap('09-marquee-light');
    await release();
    assert.deepEqual(await selection(), sel('station', 's1'));
    assert.equal((await view()).marquee, null);
    await drag([[14, 10], [22, 14]], { mods: ['Shift'] });
    assert.deepEqual((await selection()).ids.sort(), ['s1', 's2', 's4']);
    await drag([[1, 18], [3, 20]]);
    assert.deepEqual(await selection(), NONE, 'a marquee that touches nothing clears the selection');
    await drag([[24, 12], [31, 17]]);
    assert.deepEqual(await selection(), sel('obstacle', 'o2', 'o3', 'o4', 'o5'), 'only obstacles in the area: the columns');
    await drag([[22, 10], [26, 12]]);
    assert.equal((await selection()).kind, 'label');
    assert.equal(await undoLabel(), null);
  });

  await test('select: drag moves a station (one undo step, snapped; the ghost is green); Esc cancels; clicking commits nothing', async () => {
    await open('starter');
    await drag([[20, 13], [24, 16]], { keep: true });
    const g = (await view()).ghost;
    assert.deepEqual(g.rect, { x: 23, y: 15, w: 3, h: 3 });
    assert.equal(g.valid, true);
    assert.equal(g.kind, 'station');
    assert.match(await status(), /^Move by \+4, \+3 cells \(\+8, \+6 m\)$/);
    assert.deepEqual(rectOf(await station('s2')), [19, 12, 3, 3], 'the station stays put until release');
    await snap('10-move-ghost-light');
    await release();
    assert.deepEqual(rectOf(await station('s2')), [23, 15, 3, 3]);
    assert.equal(await undoLabel(), 'Move station');
    assert.equal((await view()).ghost, null);
    await press('Control+z');
    assert.deepEqual(rectOf(await station('s2')), [19, 12, 3, 3]);
    await drag([[20, 13], [26, 13]], { keep: true });
    assert.ok((await view()).ghost);
    await press('Escape');
    assert.equal((await view()).ghost, null);
    await release();
    assert.deepEqual(rectOf(await station('s2')), [19, 12, 3, 3], 'Esc cancelled the move');
    assert.equal(await undoLabel(), null);
    await click([20, 13]);
    await click([20, 13]);
    assert.equal(await undoLabel(), null, 'clicking selected things changes nothing');
    await drag([[20, 13], [21, 13]]);
    assert.deepEqual(rectOf(await station('s2')), [20, 12, 3, 3], 'one cell is enough');
    await drag([[20, 13], [20.3, 13]].map(([x, y]) => [Math.floor(x), y, x - Math.floor(x) + 0.5, 0.5]));
    assert.deepEqual(rectOf(await station('s2')), [20, 12, 3, 3], 'a drag of less than half a cell snaps back: no move, no commit');
  });

  await test('select: moving onto a road is refused (red ghost, no commit, a toast says why); a group moves as one step', async () => {
    await open('starter');
    await click([20, 13]);
    await drag([[20, 13], [20, 9]], { keep: true });
    assert.equal((await view()).ghost.valid, false);
    assert.match(await status(), /^Cannot move here: a road is in the way\.$/);
    await snap('11-move-invalid-light');
    await release();
    assert.deepEqual(rectOf(await station('s2')), [19, 12, 3, 3]);
    assert.equal(await undoLabel(), null);
    assert.match((await toasts()).at(-1), /Cannot move here: a road is in the way/);
    await click([20, 13]);
    await click([9, 6], { mods: ['Shift'] });
    await drag([[20, 13], [23, 15]], { keep: true });
    assert.ok((await view()).marquee, 'the group box stands in for the single ghost');
    await snap('12-move-group-light');
    await release();
    assert.deepEqual([rectOf(await station('s1')), rectOf(await station('s2'))], [[11, 7, 3, 2], [22, 14, 3, 3]]);
    assert.equal(await undoLabel(), 'Move 2 items');
    await press('Control+z');
    assert.deepEqual(rectOf(await station('s1')), [8, 5, 3, 2], 'one undo moves both back');
    assert.deepEqual(rectOf(await station('s2')), [19, 12, 3, 3]);
  });

  await test('select: labels and obstacles move by dragging too, each as one undo step', async () => {
    await open('starter');
    await drag([[27, 17], [29, 18]], { keep: true });
    assert.ok((await view()).marquee, 'a one-cell box marks where the label would land');
    assert.equal((await view()).ghost, null);
    await release();
    const label = (await layout()).labels.find((l) => l.id === 'l3');
    assert.deepEqual([label.x, label.y], [29, 18.4]);
    assert.equal(await undoLabel(), 'Move label');
    await drag([[26, 15], [27, 16]], { keep: true });
    assert.deepEqual((await view()).ghost, { kind: 'obstacle', obstacleKind: 'column', rect: { x: 27, y: 16, w: 1, h: 1 }, valid: true });
    await release();
    assert.deepEqual((await layout()).obstacles.find((o) => o.id === 'o3'), { id: 'o3', x: 27, y: 16, w: 1, h: 1, kind: 'column' });
    assert.equal(await undoLabel(), 'Move column');
    await drag([[26, 13], [26, 9]]);
    assert.equal((await layout()).obstacles.find((o) => o.id === 'o2').y, 13, 'a column cannot be dropped on the road');
    await press('Control+z');
    await press('Control+z');
    assert.equal(await undoLabel(), null);
  });

  await test('select: eight resize handles, resize in one step, never below 1 x 1; blocked sizes are red', async () => {
    await open();
    await press('2');
    await drag([[18, 10], [21, 13]]);
    await press('v');
    const r = { x: 18, y: 10, w: 4, h: 4 };
    assert.deepEqual(rectOf(await station('s1')), [18, 10, 4, 4]);
    assert.equal((await view()).resizeHandles, true);
    const fractions = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };
    const out = { nw: [-2, -1], n: [0, -2], ne: [1, -1], e: [2, 0], se: [1, 2], s: [0, 1], sw: [-1, 1], w: [-1, 0] };
    const expected = { nw: [16, 9, 6, 5], n: [18, 8, 4, 6], ne: [18, 9, 5, 5], e: [18, 10, 6, 4], se: [18, 10, 5, 6], s: [18, 10, 4, 5], sw: [17, 10, 5, 5], w: [17, 10, 5, 4] };
    const cursors = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
    for (const name of Object.keys(fractions)) {
      const [fx, fy] = fractions[name];
      const start = await atCells(r.x + r.w * fx, r.y + r.h * fy);
      await page.mouse.move(start.x, start.y);
      assert.equal(await cursor(), cursors[name], `cursor over the ${name} handle`);
      await page.mouse.down();
      const end = await atCells(r.x + r.w * fx + out[name][0], r.y + r.h * fy + out[name][1]);
      await page.mouse.move(end.x, end.y, { steps: 4 });
      assert.match(await status(), /^Size \d+ × \d+ cells/);
      assert.equal((await view()).ghost.valid, true);
      await page.mouse.up();
      assert.deepEqual(rectOf(await station('s1')), expected[name], `handle ${name}`);
      assert.equal(await undoLabel(), 'Resize station');
      await press('Control+z');
      assert.deepEqual(rectOf(await station('s1')), [18, 10, 4, 4], 'undone');
    }
    const east = await atCells(22, 12);
    await page.mouse.move(east.x, east.y);
    await page.mouse.down();
    await move([5, 12], 5);
    assert.equal((await view()).ghost.rect.w, 1, 'never smaller than one cell');
    await snap('13-resize-ghost-light');
    await page.mouse.up();
    assert.deepEqual(rectOf(await station('s1')), [18, 10, 1, 4]);
    await press('Control+z');
    await press('r');
    await drag([[26, 8], [26, 16]]);
    await press('v');
    const se = await atCells(22, 14);
    await page.mouse.move(se.x, se.y);
    await page.mouse.down();
    await move([27, 15], 5);
    assert.equal((await view()).ghost.valid, false, 'the road at x = 26 is in the way');
    assert.match(await status(), /^Cannot resize here: a road is in the way\.$/);
    await page.mouse.up();
    assert.deepEqual(rectOf(await station('s1')), [18, 10, 4, 4]);
    assert.match((await toasts()).at(-1), /Cannot resize here/);
  });

  await test('select: Delete removes a station with its flows (Undo in the toast), nudge with the arrows, Ctrl+D duplicates', async () => {
    await open('starter');
    await click([20, 13]);
    await press('Delete');
    assert.equal(await undoLabel(), 'Delete station');
    assert.equal((await layout()).stations.length, 3);
    assert.equal((await layout()).flows.length, 0, 'both flows of Assembly went with it');
    assert.equal((await toasts()).at(-1), 'Deleted station and 2 flows.');
    await page.locator('.toast__action', { hasText: 'Undo' }).click();
    assert.equal((await layout()).stations.length, 4);
    assert.equal((await layout()).flows.length, 2);
    await click([38, 14]);
    assert.deepEqual(rectOf(await station('s3')), [37, 13, 3, 2]);
    await press('ArrowUp');
    assert.deepEqual(rectOf(await station('s3')), [37, 12, 3, 2]);
    assert.equal(await undoLabel(), 'Nudge station');
    await press('Shift+ArrowDown');
    assert.deepEqual(rectOf(await station('s3')), [37, 17, 3, 2], 'Shift = 5 cells');
    for (let i = 0; i < 3; i++) await press('ArrowDown');
    assert.deepEqual(rectOf(await station('s3')), [37, 20, 3, 2]);
    await press('Control+z');
    assert.deepEqual(rectOf(await station('s3')), [37, 13, 3, 2], 'rapid nudges are one undo step');
    const before = await undoLabel();
    await press('ArrowLeft');
    assert.deepEqual(rectOf(await station('s3')), [37, 13, 3, 2], 'the road at x = 36 blocks the nudge');
    assert.equal(await undoLabel(), before);
    assert.match(await status(), /^Cannot move: a road is in the way\.$/);
    await press('ArrowRight');
    assert.equal(await undoLabel(), before, 'and so does the edge of the plate');
    await press('Control+d');
    assert.equal(await undoLabel(), 'Duplicate station');
    assert.equal((await layout()).stations.length, 5);
    const copy = (await selection()).ids[0];
    assert.equal(copy, 's5', 'the copy is selected');
    assert.equal((await station(copy)).name, 'Dispatch 2');
    assert.deepEqual(rectOf(await station(copy)), [37, 16, 3, 2], 'right of it is off the plate, so the copy goes below with one cell between');
    await press('Control+z');
    assert.equal((await layout()).stations.length, 4);
  });

  await test('select: Delete works on obstacles, labels, flows and road cells; a fleet is left alone', async () => {
    await open('starter');
    await click([26, 13]);
    await press('Delete');
    assert.equal(await undoLabel(), 'Delete column');
    await click([23, 11]);
    await press('Backspace');
    assert.equal(await undoLabel(), 'Delete label');
    const fp = await flowPoint('f2');
    await page.mouse.click(fp.x, fp.y);
    await press('Delete');
    assert.equal(await undoLabel(), 'Delete flow');
    assert.equal((await layout()).flows.length, 1);
    await click([10, 9]);
    await press('Delete');
    assert.equal(await undoLabel(), 'Delete road');
    assert.equal(await road(10, 9), undefined);
    await page.evaluate(() => window.harness.placeVehicle(5, 12));
    await click([5, 12]);
    const n = (await layout()).fleets.length;
    await press('Delete');
    assert.equal((await layout()).fleets.length, n, 'a fleet is deleted in the fleet panel, not with the canvas key');
  });

  await test('select: double-click on a label edits its text; double-click on empty ground fits the plant', async () => {
    await open('starter');
    await click([23, 11], { double: true });
    const input = page.locator('.popover input');
    assert.equal(await input.count(), 1);
    assert.equal(await input.inputValue(), 'Assembly hall');
    assert.equal(await page.evaluate(() => document.activeElement.tagName), 'INPUT', 'the text box has the focus');
    await snap('14-label-edit-light');
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Final assembly');
    await press('Enter');
    assert.equal(await input.count(), 0);
    assert.equal((await layout()).labels.find((l) => l.id === 'l2').text, 'Final assembly');
    assert.equal(await undoLabel(), 'Edit label');
    await page.mouse.wheel(0, -600);
    const zoomed = await page.evaluate(() => window.harness.camera.zoom);
    await click([30, 3], { double: true });
    const fit = await page.evaluate(() => window.harness.camera.zoom);
    assert.ok(fit < zoomed, 'fit view zoomed back out');
    await click([23, 11], { double: true });
    await press('Escape');
    assert.equal((await layout()).labels.find((l) => l.id === 'l2').text, 'Final assembly', 'Esc cancels the edit');
    assert.equal(await input.count(), 0);
  });

  await test('hover: the status line gives cell and metres plus what is under the pointer; the cursor shows what a drag does', async () => {
    await open('starter');
    await move([20, 13]);
    assert.match(await status(), /^Cell 20, 13 \(40 m, 26 m\) · Assembly \(Workstation, 3 × 3 cells \(6 × 6 m\)\)$/);
    assert.deepEqual((await view()).hover, { kind: 'station', id: 's2' });
    assert.equal(await cursor(), 'pointer');
    await click([20, 13]);
    await move([20, 14]);
    assert.equal(await cursor(), 'move', 'over a selected item the cursor says it can be dragged');
    const fp = await flowPoint('f2');
    await page.mouse.move(fp.x, fp.y);
    assert.equal((await view()).hover.kind, 'flow');
    assert.match(await status(), /Flow Assembly → Dispatch/);
    await move([10, 9]);
    assert.equal((await view()).hover.kind, 'cell');
    assert.match(await status(), /Road cell/);
    await move([30, 3]);
    assert.equal((await view()).hover, null);
    await page.mouse.move(2, 2);
    assert.equal(await status(), '', 'the status line is cleared when the pointer leaves the canvas');
  });

  // ---- flows ------------------------------------------------------------------------------------------------------------

  await test('flow: drag from sender to receiver, click-click mode, invalid pairs, duplicates, Esc', async () => {
    await open('starter');
    await press('f');
    assert.match(await status(), /Click a Goods in, Workstation or Storage/);
    await click([38, 14]);
    assert.equal((await toasts()).at(-1), 'Goods out cannot send loads.');
    assert.equal((await view()).flowPreview, null);
    await click([14, 13]);
    assert.equal((await toasts()).at(-1), 'Parking & charging cannot send loads.');
    await drag([[9, 6], [38, 14]], { keep: true });
    const fp = (await view()).flowPreview;
    assert.equal(fp.fromId, 's1');
    assert.deepEqual(fp.toPoint, [77, 28], 'the rubber band snaps to the middle of a valid receiving station');
    assert.match(await status(), /^Connect Goods receiving to Dispatch$/);
    await snap('15-flow-drag-light');
    await release();
    assert.match(await undoLabel(), /^Connect .+ → .+$/);
    assert.deepEqual((await layout()).flows.map((f) => [f.from, f.to]), [['s1', 's2'], ['s2', 's3'], ['s1', 's3']]);
    assert.deepEqual(await selection(), sel('flow', 'f3'));
    assert.equal((await view()).flowPreview, null);
    await press('Control+z');
    await click([9, 6]);
    assert.equal((await view()).flowPreview.fromId, 's1', 'a click on the sender waits for the second click');
    await move([30, 8], 4);
    assert.ok((await view()).flowPreview, 'the rubber band follows the pointer');
    await snap('16-flow-pending-light');
    await click([38, 14]);
    assert.deepEqual((await layout()).flows.map((f) => f.id), ['f1', 'f2', 'f3']);
    assert.match(await undoLabel(), /^Connect .+ → .+$/);
    await press('Control+z');
    await click([20, 13]);
    await click([38, 14]);
    assert.deepEqual(await selection(), sel('flow', 'f2'), 'a duplicate selects the existing flow');
    assert.match((await toasts()).at(-1), /Assembly already sends loads to Dispatch\./);
    assert.equal((await layout()).flows.length, 2);
    await click([20, 13]);
    await click([9, 6]);
    assert.equal((await toasts()).at(-1), 'Goods in cannot receive loads.');
    assert.ok((await view()).flowPreview, 'still waiting for a valid receiver');
    await click([30, 3]);
    assert.equal((await view()).flowPreview, null, 'a click on empty ground cancels');
    await click([20, 13]);
    await press('Escape');
    assert.equal((await view()).flowPreview, null);
    assert.equal((await ui()).tool, 'flow', 'the first Esc only cancelled the pending flow');
    await press('Escape');
    assert.equal((await ui()).tool, 'select');
    await press('f');
    await drag([[20, 13], [30, 3]]);
    assert.equal((await layout()).flows.length, 2, 'a drag released on empty ground connects nothing');
    assert.equal((await view()).flowPreview, null);
  });

  // ---- labels -----------------------------------------------------------------------------------------------------------

  await test('label: click opens an inline box; Enter adds the label (selected), Esc cancels, blur commits text and drops an empty box', async () => {
    await open();
    await press('t');
    await click([10, 6]);
    const input = page.locator('.popover input');
    assert.equal(await input.count(), 1);
    assert.equal(await page.evaluate(() => document.activeElement.tagName), 'INPUT');
    await page.keyboard.type('Goods in rtwf1');
    assert.equal((await ui()).tool, 'label', 'typing letters in the box does not switch tools');
    await snap('17-label-box-light');
    await press('Enter');
    assert.equal(await input.count(), 0);
    assert.deepEqual((await layout()).labels, [{ id: 'l1', x: 10.5, y: 6.5, text: 'Goods in rtwf1' }]);
    assert.equal(await undoLabel(), 'Add label');
    assert.deepEqual(await selection(), sel('label', 'l1'));
    await click([20, 6]);
    await page.keyboard.type('draft');
    await press('Escape');
    assert.equal(await input.count(), 0);
    assert.equal((await layout()).labels.length, 1, 'Esc cancelled');
    assert.equal((await ui()).tool, 'label', 'Esc closed the box, not the tool');
    await click([20, 6]);
    await page.locator('#project-name').focus();
    assert.equal(await input.count(), 0);
    assert.equal((await layout()).labels.length, 1, 'blur with an empty box cancels');
    await click([20, 6]);
    await page.keyboard.type('Shipping');
    await page.locator('#project-name').focus();
    assert.equal((await layout()).labels.at(-1).text, 'Shipping', 'blur with text commits');
    assert.equal((await layout()).labels.at(-1).x, 20.5);
  });

  // ---- camera -----------------------------------------------------------------------------------------------------------

  await test('camera: wheel zooms at the cursor, Space+drag, middle button and the pan tool pan, double-click fits', async () => {
    await open('starter');
    const cam = () => page.evaluate(() => ({ x: window.harness.camera.x, y: window.harness.camera.y, zoom: window.harness.camera.zoom }));
    const world = (p) => page.evaluate(([x, y]) => { const r = window.harness.canvas.getBoundingClientRect(); return window.harness.camera.screenToWorld(x - r.left, y - r.top); }, [p.x, p.y]);
    const p = await at(30, 8);
    await page.mouse.move(p.x, p.y);
    const w0 = await world(p);
    const z0 = (await cam()).zoom;
    await page.mouse.wheel(0, -300);
    const z1 = (await cam()).zoom;
    assert.ok(z1 > z0 * 1.3, 'wheel up zooms in');
    const w1 = await world(p);
    assert.ok(Math.hypot(w1[0] - w0[0], w1[1] - w0[1]) < 0.05, 'the point under the cursor stays under the cursor');
    await page.mouse.wheel(0, 300);
    assert.ok((await cam()).zoom < z1, 'wheel down zooms out');
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -50);
    await page.keyboard.up('Control');
    assert.ok((await cam()).zoom > z0, 'a trackpad pinch (ctrl+wheel) zooms as well');
    const c0 = await cam();
    await page.keyboard.down(' ');
    assert.equal(await cursor(), 'grab');
    await page.mouse.move(600, 400);
    await page.mouse.down();
    assert.equal(await cursor(), 'grabbing');
    await page.mouse.move(700, 450, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up(' ');
    const c1 = await cam();
    assert.ok(Math.abs((c0.x - c1.x) * c1.zoom - 100) < 1 && Math.abs((c0.y - c1.y) * c1.zoom - 50) < 1, 'the plant follows the pointer 1:1');
    assert.equal((await ui()).tool, 'select', 'Space is only a modifier');
    assert.equal(await undoLabel(), null, 'panning edits nothing');
    await page.mouse.move(600, 400);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(560, 380, { steps: 4 });
    await page.mouse.up({ button: 'middle' });
    const c2 = await cam();
    assert.ok(Math.abs((c1.x - c2.x) * c2.zoom + 40) < 1);
    await press('h');
    await page.mouse.move(600, 400);
    await page.mouse.down();
    await page.mouse.move(640, 420, { steps: 4 });
    await page.mouse.up();
    const c3 = await cam();
    assert.ok(Math.abs((c2.x - c3.x) * c3.zoom - 40) < 1);
    assert.equal(await cursor(), 'grab');
    await press('v');
    const empty = await page.evaluate(() => window.harness.emptyPoint());
    await page.mouse.dblclick(empty.x, empty.y);
    const fit = await cam();
    assert.deepEqual([fit.x, fit.y], [40, 24], 'double-click on empty ground = ctx.actions.fitView()');
  });

  // ---- teardown ---------------------------------------------------------------------------------------------------------

  await test('cancel() and destroy() leave no stale state and no listeners behind', async () => {
    await open();
    await press('r');
    await drag([[3, 3], [9, 3]], { keep: true });
    await page.evaluate(() => window.harness.editor.cancel());
    const v = await view();
    assert.equal(v.paintPreview, null);
    assert.equal(v.ghost, null);
    await release();
    assert.equal(await roadCount(), 0, 'cancel() really abandoned the gesture');
    await press('2');
    await move([10, 10]);
    assert.ok((await view()).ghost);
    await page.evaluate(() => window.harness.destroyEditor());
    const after = await view();
    assert.deepEqual([after.ghost, after.hover, after.paintPreview, after.flowPreview, after.marquee, after.resizeHandles], [null, null, null, null, null, false]);
    assert.equal(await page.evaluate(() => document.getElementById('plant').style.touchAction), '');
    await press('v');
    assert.equal((await ui()).tool, 'process', 'a destroyed editor does not react to keys');
    await click([10, 10]);
    assert.equal((await layout()).stations.length, 0, 'nor to the pointer');
    await page.evaluate(() => window.harness.createEditor());
    assert.equal(await page.evaluate(() => window.harness.editor.tool), 'process', 'a new editor picks the tool up from the store');
    await click([10, 10]);
    assert.equal((await layout()).stations.length, 1);
  });

  await test('with the app\'s runner present the editor leaves rendering to it', async () => {
    await open('empty', '&runner=1');
    await press('r');
    await drag([[3, 3], [9, 3]]);
    assert.equal(await roadCount(), 7);
    await page.evaluate(() => window.harness.stopLoop());
    await frame();
    const f0 = await page.evaluate(() => window.harness.frames());
    await move([12, 12]);
    await page.evaluate(() => window.harness.editor.redraw());
    await frame();
    assert.equal(await page.evaluate(() => window.harness.frames()), f0, 'the editor did not draw a frame itself');
    await open('empty');
    const g0 = await page.evaluate(() => window.harness.frames());
    await press('r');
    await move([12, 12]);
    await frame();
    assert.ok(await page.evaluate(() => window.harness.frames()) > g0, 'without a runner the editor draws after a change');
  });

  await test('with the real simulation runner: vehicles are clickable, edits work while it runs, the run restarts after a layout change', async () => {
    await open('starter', '&runner=real');
    await page.evaluate(() => { window.harness.runner.setSpeed(60); return window.harness.runner.play(); });
    await page.waitForFunction(() => window.harness.renderer.sim && window.harness.renderer.sim.time > 30 && window.harness.renderer.sim.vehicles.some((v) => v.visible));
    const simBefore = await page.evaluate(() => window.harness.runner.sim.time); // placing the brick below restarts the run after 250 ms, so read the clock first
    await press('2');
    await click([30, 4]);
    assert.equal((await layout()).stations.length, 5, 'placing a brick while the simulation runs');
    assert.equal(await undoLabel(), 'Add workstation');
    await press('v');
    await page.evaluate(() => window.harness.runner.pause());
    await frame();
    const spot = await page.evaluate(() => {
      const v = window.harness.renderer.sim.vehicles.find((x) => x.visible);
      const [sx, sy] = window.harness.camera.worldToScreen(v.x, v.y);
      const r = window.harness.canvas.getBoundingClientRect();
      return { x: r.left + sx, y: r.top + sy, fleet: v.fleetId };
    });
    await page.mouse.click(spot.x, spot.y);
    assert.deepEqual(await selection(), sel('fleet', spot.fleet), 'a click on a running vehicle selects its fleet');
    await snap('29-running-fleet-selected-light');
    await page.evaluate(() => { window.__sim = window.harness.runner.sim; });
    await drag([[30, 4], [34, 4]]);
    assert.equal((await station('s5')).x, 33, 'moving a brick with a simulation attached');
    await page.waitForFunction(() => window.harness.runner.sim !== window.__sim, null, { timeout: 5000 });
    assert.ok(simBefore > 30);
    assert.deepEqual(await selection(), sel('station', 's5'), 'the selection survives the restart of the simulation');
    await page.evaluate(() => window.harness.runner.play());
    await press('r');
    await drag([[2, 20], [8, 20]]);
    assert.ok(await road(8, 20), 'drawing while the simulation plays');
    await press('Control+z');
    assert.equal(await road(8, 20), undefined);
  });

  // ---- touch ------------------------------------------------------------------------------------------------------------

  await test('touch: one finger uses the tool, two fingers pan and pinch-zoom and cancel the stroke, a tap places a brick', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, deviceScaleFactor: 2 });
    const tp = await context.newPage();
    const touchErrors = [];
    tp.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') touchErrors.push(m.text()); });
    tp.on('pageerror', (e) => touchErrors.push(e.message));
    await tp.goto(url('/tests/e2e/editor-harness.html?layout=empty'));
    await tp.waitForFunction(() => window.harness && window.harness.ready);
    const cdp = await context.newCDPSession(tp);
    // a point may carry an explicit `id`; touchEnd lists the points that are lifted (an empty list lifts all of them)
    const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: p.id ?? i + 1 })) });
    const tat = (cx, cy) => tp.evaluate(([a, b]) => window.harness.cellToClient(a, b), [cx, cy]);
    const cam = () => tp.evaluate(() => ({ x: window.harness.camera.x, y: window.harness.camera.y, zoom: window.harness.camera.zoom }));
    const roads = () => tp.evaluate(() => Object.keys(window.harness.layout().roads).length);
    const stations = () => tp.evaluate(() => window.harness.layout().stations.map((s) => [s.x, s.y, s.w, s.h]));
    const preview = () => tp.evaluate(() => window.harness.view().paintPreview);
    await tp.evaluate(() => { window.harness.camera.zoomTo(16); window.harness.camera.centerOn(16, 16); window.harness.render(); });
    await tp.keyboard.press('r');
    await touch('touchStart', [await tat(3, 4)]);
    for (let i = 1; i <= 8; i++) await touch('touchMove', [await tat(3 + i, 4)]);
    await touch('touchEnd', []);
    assert.equal(await roads(), 9, 'one finger draws a road');
    assert.equal(await tp.evaluate(() => window.harness.state().undoLabel), 'Draw road');
    const z0 = (await cam()).zoom;
    const c = { x: 195, y: 350 };
    await touch('touchStart', [{ x: c.x - 40, y: c.y }, { x: c.x + 40, y: c.y }]);
    for (let i = 1; i <= 6; i++) await touch('touchMove', [{ x: c.x - 40 - i * 10, y: c.y }, { x: c.x + 40 + i * 10, y: c.y }]);
    await touch('touchEnd', []);
    const z1 = (await cam()).zoom;
    assert.ok(Math.abs(z1 / z0 - 2.5) < 0.01, `a pinch from 80 px to 200 px zooms 2.5x (${z0} -> ${z1})`);
    assert.equal(await roads(), 9, 'the first finger of the pinch drew nothing');
    const c1 = await cam();
    await touch('touchStart', [{ x: 150, y: 300 }, { x: 250, y: 300 }]);
    for (let i = 1; i <= 5; i++) await touch('touchMove', [{ x: 150 + i * 10, y: 300 + i * 6 }, { x: 250 + i * 10, y: 300 + i * 6 }]);
    await touch('touchEnd', []);
    const c2 = await cam();
    assert.ok(Math.abs((c1.x - c2.x) * c2.zoom - 50) < 1 && Math.abs((c1.y - c2.y) * c2.zoom - 30) < 1, 'two fingers pan 1:1');
    await tp.evaluate(() => { window.harness.camera.zoomTo(16); window.harness.camera.centerOn(16, 16); window.harness.render(); });
    await touch('touchStart', [await tat(3, 8)]);
    await touch('touchMove', [await tat(6, 8)]);
    assert.ok(await preview(), 'stroke in progress');
    const q = await tat(6, 8);
    await touch('touchStart', [q, { x: q.x + 60, y: q.y + 60 }]);
    assert.equal(await preview(), null, 'the second finger abandons the stroke');
    await touch('touchMove', [q, { x: q.x + 80, y: q.y + 80 }]);
    await touch('touchEnd', []);
    assert.equal(await roads(), 9, 'and nothing was committed');
    await tp.evaluate(() => { window.harness.camera.zoomTo(16); window.harness.camera.centerOn(16, 16); window.harness.render(); });
    const a = { ...(await tat(3, 10)), id: 1 };
    const b = { ...(await tat(10, 10)), id: 2 };
    await touch('touchStart', [a, b]);
    await touch('touchEnd', [a]);
    await touch('touchMove', [{ ...(await tat(8, 10)), id: 2 }]);
    await touch('touchMove', [{ ...(await tat(6, 10)), id: 2 }]);
    assert.equal(await preview(), null, 'the finger that stays after a pinch starts no stroke');
    await touch('touchEnd', [{ ...(await tat(6, 10)), id: 2 }]);
    assert.equal(await roads(), 9, 'and draws nothing');
    await touch('touchStart', [await tat(3, 12)]);
    await touch('touchMove', [await tat(6, 12)]);
    await touch('touchEnd', []);
    assert.equal(await roads(), 13, 'the next single-finger stroke works again');
    await tp.keyboard.press('2');
    await touch('touchStart', [await tat(8, 12)]);
    await touch('touchEnd', []);
    assert.deepEqual(await stations(), [[7, 11, 3, 3]], 'a tap places a default-size brick');
    assert.equal(await tp.evaluate(() => window.harness.view().ghost), null, 'no ghost hangs around after a touch');
    await snap('18-touch-narrow-light', tp);
    await tp.evaluate(() => window.harness.setTheme('dark'));
    await snap('19-touch-narrow-dark', tp);
    assert.deepEqual(touchErrors, []);
    await context.close();
  });

  // ---- visuals ----------------------------------------------------------------------------------------------------------

  await test('screenshots: a worked plant in light and dark with tools in action', async () => {
    await open('two-lines');
    await press('Control+a');
    await snap('20-two-lines-all-selected-light');
    await press('Escape');
    await click([24, 11]);
    await drag([[24, 11], [26, 22]], { keep: true });
    await snap('21-two-lines-move-light');
    await press('Escape');
    await release();
    await theme('dark');
    await press('r');
    await drag([[1, 9], [4, 9], [4, 16]], { keep: true });
    await snap('22-road-preview-dark');
    await release();
    await press('o');
    await drag([[1, 20], [4, 20]], { keep: true });
    await snap('23-oneway-preview-dark');
    await release();
    await press('v');
    await click([24, 11]);
    await snap('24-select-handles-dark');
    await press('f');
    await drag([[11, 3], [24, 11]], { keep: true });
    await snap('25-flow-drag-dark');
    await release();
    await press('Escape');
    await press('2');
    await move([52, 12]);
    await snap('26-place-ghost-dark');
    await press('Escape');
    await page.setViewportSize({ width: 390, height: 800 });
    await page.evaluate(() => { window.harness.camera.fit(window.harness.layout(), window.harness.canvas.clientWidth, window.harness.canvas.clientHeight, 8); window.harness.render(); });
    await snap('27-two-lines-narrow-dark');
    await theme('light');
    await snap('28-two-lines-narrow-light');
  });

  assert.deepEqual(errors, [], `console errors: ${errors.join('\n')}`);
  console.log(`editor.mjs: all browser checks passed (last section: ${section})`);
});
