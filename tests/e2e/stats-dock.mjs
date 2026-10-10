// The Statistics dock of js/ui/panels/stats-dock.js in the REAL app in real Chromium: the shell only (selection of a vehicle, the gesture rule, the states, the grip,
// the keyboard, the phone sheet, the floating controls and the camera). What the dock shows inside is the model builder's stats-model.js and stats-view.js; this
// script does not look at it, so it passes with their real files and with the marked placeholder of the shell.
// (docs/ENTITY-INSIGHTS-DESIGN.md 9.1: S1.6 selection, S1.7 the gesture rule, S1.8 dock states, S1.14 the dock part of accessibility.)
//
//   select     a click on a vehicle selects the VEHICLE ("v2#1"), not its fleet; Shift toggles; a marquee still selects stations; Delete does nothing for it; the hover
//              text says "Click for statistics"; Properties shows the fleet summary titled with the vehicle; the Fleet tab lists the vehicles as buttons and Enter
//              selects one and opens the dock with the keyboard focus in it; the selection survives a warm restart; a fleet cut below the vehicle falls back to the fleet
//   gesture    (a) pressing and dragging an unselected station by 5 cells: it moves exactly 5 cells, the canvas box and the camera are identical, the dock did not open
//              (also with the dock open for another item); (b) a click on a vehicle opens the dock after pointerup, not on pointerdown, the canvas size and the zoom are
//              identical (the camera may pan by the least to bring the vehicle out from under the dock); (c) clicking empty ground to deselect moves nothing
//   states     compact the first time, details, minimise, X closes it until the next click, the state and height survive a reload, the page works with localStorage
//              blocked, the grip resizes up to 44 vh and the zoom buttons stay above the dock, I toggles, [ and ] cycle, Esc clears the selection, a wall closes the dock
//   phone      390 px: the sheet opens at peek (as high as its content, nothing cut off), the grip taps to half and full, the plan stays tappable, the zoom buttons
//              step aside at full, every control of the sheet is at least 40 px high on the coarse pointer
//   simulate   the Simulate tab: "Collect statistics for clicked items" drops and restores the collector of the running simulation, "Statistics on click" sets the preference
//   a11y       the region is labelled with the item, nothing inside the dock is aria-live (one polite status next to it), the grip is a focusable separator
//
// Without js/ui/panels/stats-model.js and stats-view.js (the model builder's files) the dock shows its marked placeholder and the browser logs two 404s on the first
// open; this script tolerates exactly those and says so at the end. Every other script that asserts a clean console AND opens the dock (integration.mjs: a click on a
// running vehicle) fails in that state until the files exist.
//
// Run: node tests/e2e/stats-dock.mjs        Screenshots: e2e-output/stats-dock-*.png (open them and look)
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../../scripts/serve.mjs';
import { ROOT, OUT } from './browser.mjs';

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };
const modelFiles = existsSync(path.join(ROOT, 'js/ui/panels/stats-model.js')) && existsSync(path.join(ROOT, 'js/ui/panels/stats-view.js'));

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const problems = [];

/** A new visitor. `blockStorage` makes localStorage throw on access (a private window with blocked site data). */
async function session({ viewport = { width: 1440, height: 900 }, colorScheme = 'light', touch = false, blockStorage = false } = {}) {
  const context = await browser.newContext({ viewport, colorScheme, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 });
  if (blockStorage) await context.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('denied', 'SecurityError'); } }); });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    if (!modelFiles && /Failed to load resource/.test(m.text())) return; // the model builder's files are not installed yet: the shell falls back to its placeholder
    problems.push(`[console.${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => { if (modelFiles || !/stats-(model|view)\.js/.test(r.url())) problems.push(`[requestfailed] ${r.url()}`); });
  await page.goto(`${origin}/index.html`);
  await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
  if (await page.locator('[role=dialog]').count()) {
    await page.keyboard.press('Escape');
    await page.locator('[role=dialog]').waitFor({ state: 'detached' });
  }
  return { context, page };
}

const frames = (page, n = 3) => page.evaluate((count) => new Promise((resolve) => { const next = (left) => (left ? requestAnimationFrame(() => next(left - 1)) : resolve()); next(count); }), n);

/** Load an example, let it run past its warm-up and `seconds` more at 600x, then pause: the dock has data to show. */
async function measured(page, example = 'two-lines', seconds = 90) {
  await page.evaluate(async (id) => { await window.__logiplan.ctx.actions.loadExample(id); }, example);
  await frames(page, 3);
  await page.evaluate(async () => { const r = window.__logiplan.runner; r.setSpeed(600); await r.play(); });
  await page.waitForFunction((s) => { const w = window.__logiplan.runner.kpis()?.window; return Boolean(w) && w.warmingUp !== true && w.duration >= s; }, seconds, { timeout: 120000 });
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
/** Where a vehicle is on the screen. */
const vehicleAt = (page, pick = "v.visible && v.state !== 'parked'", skip = []) => page.evaluate(([cond, skipIds]) => {
  const { ctx, runner } = window.__logiplan;
  const r = ctx.canvas.getBoundingClientRect();
  const v = runner.sim.vehicles.find((x) => !skipIds.includes(x.id) && new Function('v', `return ${cond}`)(x));
  const [px, py] = ctx.camera.worldToScreen(v.x, v.y);
  return { x: r.left + px, y: r.top + py, id: v.id, fleetId: v.fleetId, name: v.name };
}, [pick, skip]);
const stationAt = (page, id) => page.evaluate((sid) => {
  const { ctx, store } = window.__logiplan;
  const l = store.getState().layout;
  const s = l.stations.find((x) => x.id === sid);
  const cs = l.grid.cellSize;
  const r = ctx.canvas.getBoundingClientRect();
  const [px, py] = ctx.camera.worldToScreen((s.x + s.w / 2) * cs, (s.y + s.h / 2) * cs);
  return { x: r.left + px, y: r.top + py, id: s.id, cell: [s.x, s.y], cellPx: cs * ctx.camera.zoom };
}, id);
/** A free spot of bare ground (no station, no road, no vehicle) on the visible plan. */
const emptyGround = (page) => page.evaluate(() => {
  const { ctx, store } = window.__logiplan;
  const r = ctx.canvas.getBoundingClientRect();
  for (let y = 120; y < r.height - 260; y += 30) {
    for (let x = 40; x < r.width - 40; x += 30) {
      const hit = ctx.renderer.hitTest(x, y);
      if (hit.kind === 'cell' && !(store.getState().layout.roads[`${hit.cell[0]},${hit.cell[1]}`])) {
        const [wx, wy] = ctx.camera.screenToWorld(x, y);
        const cs = store.getState().layout.grid.cellSize;
        if (wx >= 0 && wy >= 0 && wx < store.getState().layout.grid.cols * cs && wy < store.getState().layout.grid.rows * cs) return { x: r.left + x, y: r.top + y };
      }
    }
  }
  return null;
});

try {
  // ============================================================ desktop ============================================================
  {
    const { page, context } = await session();
    await measured(page);
    const quiet = await page.evaluate(() => ({ hasDetail: Boolean(window.__logiplan.runner.detail()), pref: window.__logiplan.store.getState().ui.statsDock }));
    eq(quiet, { hasDetail: true, pref: 'data' }, 'the runner switched the collector on; "Statistics on click" starts at "when the simulation has data"');
    ok((await dock(page)).hidden, 'the dock is closed at first');

    // ---- select: S1.6 ----
    const v1 = await vehicleAt(page);
    await page.mouse.move(v1.x, v1.y);
    await frames(page, 2);
    ok(/Click for statistics/.test(await status(page)), `the hover text says "Click for statistics" (was: ${await status(page)})`);
    ok(new RegExp(`Vehicle ${v1.name}\\.`).test(await status(page)), 'with the vehicle’s name');
    await page.mouse.click(v1.x, v1.y);
    await frames(page, 4);
    eq(await selection(page), { kind: 'vehicle', ids: [v1.id] }, 'a click on a vehicle selects the vehicle, not its fleet');
    const opened = await dock(page);
    ok(!opened.hidden, 'and opens the dock');
    eq([opened.state, opened.kind, opened.label], ['compact', 'vehicle', `Statistics for ${v1.name}`], 'compact the first time, labelled with the item');
    await page.locator('[data-tab="properties"], #tab-properties').first().click().catch(() => {});
    const props = await page.locator('[data-panel=inspector]').innerText();
    ok(props.includes(v1.name) && /Edit the fleet in the Fleet tab/.test(props), 'Properties shows the fleet summary titled with the vehicle');
    await page.screenshot({ path: path.join(OUT, 'stats-dock-compact-light.png') });

    const v2 = await vehicleAt(page, "v.visible && v.state !== 'parked'", [v1.id]);
    await page.keyboard.down('Shift');
    await page.mouse.click(v2.x, v2.y);
    await page.keyboard.up('Shift');
    eq((await selection(page)).ids.sort(), [v1.id, v2.id].sort(), 'Shift adds a second vehicle');
    await page.keyboard.down('Shift');
    await page.mouse.click(v2.x, v2.y);
    await page.keyboard.up('Shift');
    eq(await selection(page), { kind: 'vehicle', ids: [v1.id] }, 'and takes it away again');
    const layoutBefore = await page.evaluate(() => window.__logiplan.store.getState().layout);
    await page.keyboard.press('Delete');
    await page.keyboard.press('ArrowRight');
    ok(await page.evaluate((l) => window.__logiplan.store.getState().layout === window.__logiplan.store.getState().layout && JSON.stringify(window.__logiplan.store.getState().layout) === JSON.stringify(l), layoutBefore), 'Delete and the arrow keys do nothing to a vehicle');
    eq((await selection(page)).kind, 'vehicle', 'and keep it selected');

    // a marquee still selects stations: drag from bare ground beside the plant's stations over all of them
    await page.keyboard.press('Escape');
    await frames(page, 2);
    const marquee = await page.evaluate(() => {
      const { ctx, store } = window.__logiplan;
      const r = ctx.canvas.getBoundingClientRect();
      const l = store.getState().layout;
      const cs = l.grid.cellSize;
      const pts = l.stations.flatMap((s) => [ctx.camera.worldToScreen(s.x * cs, s.y * cs), ctx.camera.worldToScreen((s.x + s.w) * cs, (s.y + s.h) * cs)]);
      const x0 = Math.min(...pts.map((p) => p[0])); const y0 = Math.min(...pts.map((p) => p[1]));
      const x1 = Math.max(...pts.map((p) => p[0])); const y1 = Math.max(...pts.map((p) => p[1]));
      for (let d = 8; d < 90; d += 4) {
        for (const [sx, sy] of [[x0 - d, y0 - d], [x0 - d, y0 + d], [x0 + d, y0 - d]]) {
          const hit = ctx.renderer.hitTest(sx, sy);
          if (hit.kind === 'cell' && !l.roads[`${hit.cell[0]},${hit.cell[1]}`] && sy > 110) return { sx: r.left + sx, sy: r.top + sy, ex: r.left + x1 + 30, ey: r.top + y1 + 30 };
        }
      }
      return null;
    });
    ok(marquee !== null, 'bare ground beside the stations to start a marquee on');
    await page.mouse.move(marquee.sx, marquee.sy);
    await page.mouse.down();
    await page.mouse.move(marquee.ex, marquee.ey, { steps: 8 });
    await page.mouse.up();
    await frames(page, 3);
    const picked = await selection(page);
    ok(picked.kind === 'station' && picked.ids.length >= 2, `a marquee still selects the stations it covers (${picked.kind} x ${picked.ids.length})`);
    ok((await dock(page)).hidden, 'a marquee never opens the dock');
    await page.keyboard.press('Escape');

    // ---- the Fleet tab: vehicles as buttons, Enter selects, the keyboard focus goes to the dock ----
    await page.evaluate(() => window.__logiplan.store.setUi({ rightTab: 'fleet' }));
    await frames(page, 3);
    const rows = page.locator('[data-panel=fleet] [data-role=vehicles] button[data-vehicle]');
    ok((await rows.count()) >= 3, 'the Fleet tab lists the vehicles as buttons');
    const first = rows.first();
    const firstId = await first.getAttribute('data-vehicle');
    await first.focus();
    eq((await selection(page)).kind, null, 'focusing a vehicle button does not select the fleet behind the planner’s back');
    await page.keyboard.press('Enter');
    await frames(page, 4);
    eq(await selection(page), { kind: 'vehicle', ids: [firstId] }, 'Enter on a vehicle button selects that vehicle');
    ok(!(await dock(page)).hidden, 'and opens the dock');
    ok(await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('stats-dock')), 'the keyboard focus is in the dock, so Tab leads into it');
    await page.keyboard.press('Escape');
    await frames(page, 3);
    eq(await selection(page), { kind: null, ids: [] }, 'Esc clears the selection ...');
    ok((await dock(page)).hidden, '... and closes the dock');
    await page.evaluate(() => window.__logiplan.store.setUi({ rightTab: 'properties' }));

    // ---- the selection survives a warm restart; a fleet cut below the vehicle falls back to the fleet ----
    await page.evaluate((id) => window.__logiplan.store.select('vehicle', [id]), v1.id);
    await page.evaluate(() => { window.__simBefore = window.__logiplan.runner.sim; });
    await page.evaluate(async (fleetId) => { // one vehicle less in ANOTHER fleet: a structural edit that keeps the selected vehicle
      const L = await import('/js/model/layout.js');
      const other = window.__logiplan.store.getState().layout.fleets.find((f) => f.id !== fleetId && f.count > 1);
      window.__logiplan.store.commit('One vehicle less', (d) => { L.updateFleet(d, other.id, { count: other.count - 1 }); });
    }, v1.fleetId);
    await page.waitForFunction(() => window.__logiplan.runner.sim !== window.__simBefore && !window.__logiplan.runner.priming, null, { timeout: 60000 });
    ok(await page.evaluate(() => Boolean(window.__logiplan.runner.detail())), 'the replacement simulation has the statistics collector too');
    eq(await selection(page), { kind: 'vehicle', ids: [v1.id] }, 'the vehicle is still selected after the edit and the warm restart');
    const count = await page.evaluate((id) => window.__logiplan.store.getState().layout.fleets.find((f) => f.id === id.split('#')[0]).count, v1.id);
    await page.evaluate(async ([id, n]) => { const L = await import('/js/model/layout.js'); window.__logiplan.store.commit('Fewer vehicles', (d) => { L.updateFleet(d, id.split('#')[0], { count: n }); }); }, [v1.id, 0]);
    await frames(page, 3);
    eq(await selection(page), { kind: 'fleet', ids: [v1.fleetId] }, 'no vehicle left: its fleet is selected');
    ok((await page.locator('.toast-region').innerText()).includes('no longer exists'), 'and a toast says so');
    await page.evaluate(([id, n]) => window.__logiplan.store.undo() && n, [v1.id, count]);
    await page.evaluate(() => window.__logiplan.store.clearSelection());
    await frames(page, 2);

    // ---- the gesture rule: S1.7 ----
    const stations = await page.evaluate(() => window.__logiplan.store.getState().layout.stations.map((s) => ({ id: s.id, type: s.type, x: s.x, y: s.y, w: s.w, h: s.h })));
    ok(stations.length >= 3, 'the plant has stations');
    // (a) press and drag an unselected station by 5 cells with the dock enabled
    const target = stations.find((s) => s.type === 'storage') || stations[0];
    const t0 = await stationAt(page, target.id);
    const before = await view(page);
    await page.mouse.move(t0.x, t0.y);
    await page.mouse.down();
    await frames(page, 2);
    eq((await selection(page)), { kind: 'station', ids: [target.id] }, 'the press selected the unselected station');
    ok((await dock(page)).hidden, 'but the dock did not open on pointerdown');
    await page.mouse.move(t0.x + t0.cellPx * 2.5, t0.y, { steps: 4 });
    await page.mouse.move(t0.x + t0.cellPx * 5, t0.y, { steps: 4 });
    await page.mouse.up();
    await frames(page, 4);
    const moved = await page.evaluate((id) => { const s = window.__logiplan.store.getState().layout.stations.find((x) => x.id === id); return [s.x, s.y]; }, target.id);
    eq(moved, [target.x + 5, target.y], 'the station moved exactly 5 cells');
    eq(await view(page), before, 'the canvas box and the camera are identical before and after');
    ok((await dock(page)).hidden, 'a drag never opens the dock');
    await page.evaluate(() => window.__logiplan.store.undo());
    await page.evaluate(() => window.__logiplan.store.clearSelection());
    await frames(page, 2);

    // (b) a click on a vehicle opens the dock after pointerup
    const before2 = await view(page);
    const vc = await vehicleAt(page);
    await page.mouse.move(vc.x, vc.y);
    await page.mouse.down();
    await frames(page, 2);
    ok((await dock(page)).hidden, 'the dock is closed while the button is down');
    await page.mouse.up();
    await frames(page, 4);
    const afterClick = await dock(page);
    ok(!afterClick.hidden, 'and open after pointerup');
    const after2 = await view(page);
    eq(after2.canvas, before2.canvas, 'the canvas size is unchanged');
    eq(after2.camera.zoom, before2.camera.zoom, 'the zoom is identical (a pan is allowed)');
    // the item is brought out from under the dock by the least pan: put a vehicle at the very bottom, click it, and look where it ends up
    await page.evaluate(() => window.__logiplan.store.clearSelection());
    await frames(page, 2);
    await page.evaluate((id) => {
      const { ctx, runner } = window.__logiplan;
      const v = runner.sim.vehicles.find((x) => x.id === id);
      const r = ctx.canvas.getBoundingClientRect();
      const [, py] = ctx.camera.worldToScreen(v.x, v.y);
      ctx.camera.pan(0, r.height - 90 - py); // the vehicle 90 px above the bottom edge: exactly where the dock will be
    }, vc.id);
    await frames(page, 3);
    await page.evaluate(() => document.querySelectorAll('[data-region=toasts] > *').forEach((t) => t.remove())); // a toast floats over the bottom of the plan
    const low = await vehicleAt(page, `v.id === '${vc.id}'`);
    const zoomBefore = (await view(page)).camera.zoom;
    await page.mouse.click(low.x, low.y);
    await page.waitForTimeout(500); // the pan glides for 150 ms
    await frames(page, 3);
    const dockBox = await dock(page);
    const here = await vehicleAt(page, `v.id === '${vc.id}'`);
    ok(!dockBox.hidden && here.y < dockBox.top - 8, `the vehicle (y ${Math.round(here.y)}) is out from under the dock (top ${Math.round(dockBox.top)}); ${JSON.stringify({ low, sel: await selection(page), dockBox, status: await status(page), hit: await page.evaluate(([x, y]) => { const r = window.__logiplan.ctx.canvas.getBoundingClientRect(); return window.__logiplan.ctx.renderer.hitTest(x - r.left, y - r.top); }, [low.x, low.y]) })}`);
    eq((await view(page)).camera.zoom, zoomBefore, 'the reveal panned, it did not zoom');
    await page.keyboard.press('Escape');
    await frames(page, 2);

    // (c) clicking empty ground to deselect moves nothing
    const hold = await vehicleAt(page);
    await page.mouse.click(hold.x, hold.y);
    await frames(page, 3);
    ok(!(await dock(page)).hidden);
    const stable = await view(page);
    const bare = await emptyGround(page);
    ok(bare !== null, 'bare ground exists');
    await page.mouse.click(bare.x, bare.y);
    await frames(page, 4);
    eq(await selection(page), { kind: null, ids: [] }, 'the click on empty ground deselects');
    eq(await view(page), stable, 'and moves nothing: the canvas and the camera are the same');
    ok((await dock(page)).hidden, 'and the dock closes');

    // the dock dims while a drag runs on the plan (and takes no pointer), also with the dock open for another item
    await page.mouse.click(hold.x, hold.y);
    await frames(page, 3);
    const s2 = await page.evaluate(() => { // a station that is on the free part of the plan, not under the dock or the bars
      const { ctx, store } = window.__logiplan;
      const l = store.getState().layout;
      const cs = l.grid.cellSize;
      const r = ctx.canvas.getBoundingClientRect();
      const top = document.querySelector('.stats-dock').getBoundingClientRect().top;
      return l.stations.map((st) => { const [px, py] = ctx.camera.worldToScreen((st.x + st.w / 2) * cs, (st.y + st.h / 2) * cs); return { x: r.left + px, y: r.top + py }; }).find((p) => p.y < top - 40 && p.y > r.top + 110 && p.x > r.left + 60 && p.x < r.right - 80);
    });
    ok(Boolean(s2), 'a station on the free part of the plan');
    await page.mouse.move(s2.x, s2.y);
    await page.mouse.down();
    await page.mouse.move(s2.x + 40, s2.y + 10, { steps: 4 });
    await frames(page, 2);
    const dim = await page.evaluate(() => { const el = document.querySelector('.stats-dock'); const cs = getComputedStyle(el); return { cls: el.classList.contains('is-dragging'), opacity: cs.opacity, events: cs.pointerEvents }; });
    await page.waitForTimeout(300); // the opacity eases in over 160 ms
    dim.opacity = await page.evaluate(() => getComputedStyle(document.querySelector('.stats-dock')).opacity);
    eq(dim, { cls: true, opacity: '0.5', events: 'none' }, 'half transparent and no pointer while a drag runs');
    await page.keyboard.press('Escape'); // abandons the drag
    await page.mouse.up();
    await frames(page, 6);
    await page.waitForTimeout(300);
    eq(await page.evaluate(() => getComputedStyle(document.querySelector('.stats-dock')).opacity), '1', 'back to full after the gesture');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__logiplan.store.clearSelection());

    // ---- states: S1.8 ----
    await page.evaluate(() => window.__logiplan.ctx.actions.fitView()); // (the checks above moved the camera on purpose)
    await frames(page, 8);
    await page.evaluate(() => { try { localStorage.removeItem('logiplan:stats-dock'); } catch { /* none */ } });
    const st = stations[0];
    const sp = await stationAt(page, st.id);
    await page.mouse.click(sp.x, sp.y);
    await frames(page, 3);
    let d = await dock(page);
    eq([d.hidden, d.state], [false, 'compact'], 'a click on a station: the dock opens compact');
    const compactHeight = d.height;
    ok(compactHeight >= 140 && compactHeight < 330, `the compact dock is about 150 px high (${Math.round(compactHeight)})`);
    eq(await page.evaluate(() => structuredClone(window.__logiplan.ctx.renderer.view.stats)), { open: true, window: 'start', focus: null }, 'the shell tells the route overlay: open, the window, nothing hovered (renderer.view.stats)');
    // "fit the whole plan" with the dock open fits into the free part of the canvas, above the dock (camera coveredAtBottom); the canvas itself keeps its size
    const fittedBelow = await page.evaluate(async () => {
      const { plantBounds } = await import('/js/ui/camera.js');
      const { ctx, store } = window.__logiplan;
      const bounds = plantBounds(store.getState().layout);
      const bottomOf = () => { const r = ctx.canvas.getBoundingClientRect(); return r.top + ctx.camera.worldToScreen(bounds.x, bounds.y + bounds.h)[1]; };
      const before = bottomOf();
      ctx.actions.fitView();
      return { before, after: bottomOf(), dockTop: document.querySelector('.stats-dock').getBoundingClientRect().top };
    });
    ok(fittedBelow.after <= fittedBelow.dockTop, `fit with the dock open: the plan ends above it (${Math.round(fittedBelow.after)} <= ${Math.round(fittedBelow.dockTop)}; before the fit it ended at ${Math.round(fittedBelow.before)})`);
    const zoomBox = await page.evaluate(() => document.querySelector('.stage__zoom').getBoundingClientRect().toJSON());
    ok(zoomBox.bottom <= d.top + 1, 'the zoom buttons sit above the dock');
    const covered = await page.evaluate(() => document.querySelector('.stage').style.getPropertyValue('--dock-covered'));
    ok(parseFloat(covered) >= compactHeight, `--dock-covered is set on the stage (${covered})`);
    await page.getByRole('button', { name: 'Show details' }).click();
    await frames(page, 3);
    d = await dock(page);
    eq(d.state, 'open', 'details open the blocks');
    ok(d.height > compactHeight + 100 && d.height <= 900 * 0.44 + 1, `open: higher than compact, at most 44 vh (${Math.round(d.height)} of 396)`);
    await page.screenshot({ path: path.join(OUT, 'stats-dock-open-light.png') });
    // the grip: drag up by a lot, the height stops at 44 vh
    const grip = page.locator('.stats-dock .insight__grip');
    const g = await grip.boundingBox();
    await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2, g.y - 600, { steps: 8 });
    await page.mouse.up();
    await frames(page, 3);
    d = await dock(page);
    ok(Math.abs(d.height - 396) <= 2, `dragged past the top the dock stops at 44 vh (${Math.round(d.height)} px of 396)`);
    // and smaller: drag down to an in-between height
    const g2 = await grip.boundingBox();
    await page.mouse.move(g2.x + g2.width / 2, g2.y + g2.height / 2);
    await page.mouse.down();
    await page.mouse.move(g2.x + g2.width / 2, g2.y + 110, { steps: 6 });
    await page.mouse.up();
    await frames(page, 3);
    d = await dock(page);
    ok(d.state === 'open' && d.height < 396 && d.height > 230, `dragged down a bit it is a smaller open dock (${Math.round(d.height)} px)`);
    const keptHeight = d.height;
    const zoom2 = await page.evaluate(() => document.querySelector('.stage__zoom').getBoundingClientRect().bottom);
    ok(zoom2 <= d.top + 1, 'the zoom buttons follow the dock up');
    await page.getByRole('button', { name: 'Minimise statistics' }).click();
    await frames(page, 3);
    eq((await dock(page)).state, 'compact', 'minimise');
    await page.getByRole('button', { name: 'Show details' }).click();
    // reload: the state and the height are remembered
    const remembered = await page.evaluate(() => localStorage.getItem('logiplan:stats-dock'));
    ok(remembered && JSON.parse(remembered).state === 'open', `remembered in localStorage (${remembered})`);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
    if (await page.locator('[role=dialog]').count()) { await page.keyboard.press('Escape'); await page.locator('[role=dialog]').waitFor({ state: 'detached' }); }
    await page.evaluate(() => window.__logiplan.store.select('station', ['s1']));
    await page.keyboard.press('i');
    await frames(page, 3);
    d = await dock(page);
    eq(d.state, 'open', 'a new visit opens it the way it was left');
    ok(Math.abs(d.height - keptHeight) <= 2, `with the same height (${Math.round(d.height)} against ${Math.round(keptHeight)})`);
    // I toggles, X closes until the next click
    await page.keyboard.press('i');
    await frames(page, 2);
    ok((await dock(page)).hidden, 'I closes it');
    await page.keyboard.press('i');
    await frames(page, 2);
    ok(!(await dock(page)).hidden, 'and opens it, whatever the preference says');
    await page.evaluate(() => window.__logiplan.store.setUi({ statsDock: 'never' }));
    await page.getByRole('button', { name: 'Close statistics' }).click();
    ok((await dock(page)).hidden, 'X closes it');
    eq((await selection(page)).kind, 'station', 'the selection stays');
    await page.keyboard.press('i');
    await frames(page, 2);
    ok(!(await dock(page)).hidden, 'I opens it although "Statistics on click" says never');
    await page.keyboard.press('i');
    // [ and ] cycle through the stations
    await page.keyboard.press('i');
    const idBefore = (await selection(page)).ids[0];
    await page.keyboard.press(']');
    await frames(page, 2);
    ok((await selection(page)).ids[0] !== idBefore && (await selection(page)).kind === 'station', '] selects the next station');
    await page.keyboard.press('[');
    eq((await selection(page)).ids[0], idBefore, 'and [ the previous one');
    // clicking with "never": nothing opens
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await frames(page, 2);
    ok((await dock(page)).hidden, 'Esc cleared the selection and closed the dock');
    await page.mouse.click(sp.x, sp.y);
    await frames(page, 3);
    ok((await dock(page)).hidden, 'a click opens nothing while "Statistics on click" is never');
    await page.evaluate(() => window.__logiplan.store.setUi({ statsDock: 'data' }));
    // a wall closes the dock
    await page.evaluate(() => { const { store } = window.__logiplan; store.commit('Add a wall', (dr) => { dr.obstacles.push({ id: 'o_e2e', x: 1, y: 1, w: 2, h: 1, kind: 'wall' }); }); store.select('station', ['s1']); });
    await page.keyboard.press('i');
    await frames(page, 2);
    ok(!(await dock(page)).hidden);
    await page.evaluate(() => window.__logiplan.store.select('obstacle', ['o_e2e']));
    await frames(page, 3);
    ok((await dock(page)).hidden, 'selecting a wall closes the dock');
    ok(/Walls and labels have no statistics/.test(await status(page)), `and the status line says why (was: ${await status(page)})`);

    // ---- a11y: S1.14 (dock part) ----
    await page.evaluate(() => window.__logiplan.store.select('station', ['s1']));
    await page.keyboard.press('i');
    await frames(page, 3);
    const a11y = await page.evaluate(() => {
      const el = document.querySelector('.stats-dock');
      const live = [...el.querySelectorAll('*')].filter((n) => n.hasAttribute('aria-live') || ['status', 'alert', 'log'].includes(n.getAttribute('role')));
      const grip = el.querySelector('.insight__grip');
      const announcer = document.querySelector('[data-role=stats-announce]');
      return { role: el.getAttribute('role'), label: el.getAttribute('aria-label'), live: live.length, gripRole: grip.getAttribute('role'), gripTab: grip.tabIndex, announcerOutside: Boolean(announcer) && !el.contains(announcer), announcerLive: announcer && announcer.getAttribute('aria-live') };
    });
    eq([a11y.role, a11y.live, a11y.gripRole, a11y.gripTab, a11y.announcerOutside, a11y.announcerLive], ['region', 0, 'separator', 0, true, 'polite'], 'region, nothing aria-live inside, a focusable separator, one polite status next to it');
    ok(/^Statistics for /.test(a11y.label), `labelled with the item (${a11y.label})`);
    const motion = async () => page.evaluate(() => getComputedStyle(document.querySelector('.stats-dock')).transitionDuration);
    const normal = await motion();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await motion();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    ok(normal !== '0s' && reduced === '0s', `reduced motion: the dock does not animate (${normal} -> ${reduced})`);
    await page.keyboard.press('i');

    // dark
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => window.__logiplan.store.select('vehicle', ['v2#1']));
    await page.keyboard.press('i');
    await frames(page, 3);
    await page.screenshot({ path: path.join(OUT, 'stats-dock-compact-dark.png') });
    await context.close();
  }

  // ======================================================= localStorage blocked =======================================================
  {
    const { page, context } = await session({ blockStorage: true });
    await measured(page, 'two-lines', 40);
    const v = await vehicleAt(page);
    await page.mouse.click(v.x, v.y);
    await frames(page, 4);
    eq([(await selection(page)).kind, (await dock(page)).hidden, (await dock(page)).state], ['vehicle', false, 'compact'], 'with localStorage blocked the dock still opens');
    await page.getByRole('button', { name: 'Show details' }).click();
    eq((await dock(page)).state, 'open', 'and still changes state');
    await page.getByRole('button', { name: 'Close statistics' }).click();
    ok((await dock(page)).hidden);
    await context.close();
  }

  // ================================================== the Simulate tab: the two switches ==================================================
  {
    const { page, context } = await session();
    await measured(page, 'two-lines', 40);
    await page.evaluate(() => window.__logiplan.store.setUi({ rightTab: 'simulate' }));
    await frames(page, 3);
    const panel = page.locator('[data-panel=simulate]');
    const collect = panel.getByLabel('Collect statistics for clicked items');
    const onClick = panel.getByLabel('Statistics on click');
    ok(await collect.isChecked(), 'Simulate: "Collect statistics for clicked items" is on by default');
    eq(await onClick.inputValue(), 'data', '"Statistics on click" starts at "When the simulation has data"');
    eq(await onClick.locator('option').allInnerTexts(), ['When the simulation has data', 'Always', 'Never'], 'with the three choices');
    await panel.getByText('Collect statistics for clicked items', { exact: true }).click();
    await frames(page, 2);
    eq(await page.evaluate(() => [window.__logiplan.store.getState().ui.detail, window.__logiplan.runner.detail()]), [false, null], 'switched off: the running simulation drops its collector');
    await panel.getByText('Collect statistics for clicked items', { exact: true }).click();
    await frames(page, 2);
    ok(await page.evaluate(() => window.__logiplan.store.getState().ui.detail === true && Boolean(window.__logiplan.runner.detail())), 'switched on again: the running simulation gets one (counting from now)');
    await onClick.selectOption('never');
    eq(await page.evaluate(() => window.__logiplan.store.getState().ui.statsDock), 'never', 'the select sets the preference');
    await onClick.selectOption('always');
    eq(await page.evaluate(() => window.__logiplan.store.getState().ui.statsDock), 'always', 'and "Always" too');
    // a collector that failed (the engine dropped it and kept the reason): the dock says so and Count again starts a new one
    await page.evaluate(() => { const { store, runner } = window.__logiplan; store.setUi({ statsDock: 'data', rightTab: 'properties' }); store.select('vehicle', [runner.sim.vehicles[0].id]); });
    await page.evaluate(() => window.__logiplan.ctx.actions.showStatistics()); // (the keyboard focus is in the select of the Simulate tab, where the key I types)
    await frames(page, 3);
    ok(!(await dock(page)).hidden, 'the dock is open');
    ok(await page.locator('.stats-dock [data-role=stopped]').isHidden(), 'no notice while the collector runs');
    await page.evaluate(() => { const { runner, store } = window.__logiplan; runner.sim.disableDetail(); runner.sim.detailError = new Error('forced failure of the test'); store.setUi({ rightTab: 'checks' }); }); // (a running simulation refreshes the dock four times a second; this one is paused)
    await frames(page, 6);
    await page.evaluate(() => window.__logiplan.store.setUi({ rightTab: 'properties' }));
    await page.waitForFunction(() => !document.querySelector('.stats-dock [data-role=stopped]').hidden);
    ok((await page.locator('.stats-dock [data-role=stopped]').innerText()).includes('Statistics stopped: forced failure of the test'), 'the dock says that the statistics stopped, and why');
    await page.locator('.stats-dock [data-role=count-again]').click();
    await frames(page, 3);
    ok(await page.evaluate(() => Boolean(window.__logiplan.runner.detail()) && window.__logiplan.runner.sim.detailError === null), 'Count again: a new collector, counting from now');
    ok(await page.locator('.stats-dock [data-role=stopped]').isHidden(), 'and the notice is gone');
    await context.close();
  }

  // ============================================================== phone ==============================================================
  {
    const { page, context } = await session({ viewport: { width: 390, height: 844 }, touch: true });
    await measured(page, 'two-lines', 40);
    await page.evaluate(() => window.__logiplan.ctx.actions.fitView());
    await frames(page, 4);
    const before = await view(page);
    const v = await page.evaluate(() => {
      const { ctx, runner } = window.__logiplan;
      const r = ctx.canvas.getBoundingClientRect();
      const list = runner.sim.vehicles.filter((x) => x.visible && x.state !== 'parked').map((x) => { const [px, py] = ctx.camera.worldToScreen(x.x, x.y); return { id: x.id, x: r.left + px, y: r.top + py }; }).filter((p) => p.y < r.top + r.height * 0.5 && p.y > r.top + 90);
      return list[0];
    });
    ok(Boolean(v), 'a vehicle in the upper half of the phone screen');
    await page.touchscreen.tap(v.x, v.y);
    await frames(page, 4);
    let d = await dock(page);
    eq([d.hidden, d.snap], [false, 'peek'], 'a tap on a vehicle opens the sheet at peek');
    eq((await selection(page)).kind, 'vehicle', 'and selected the vehicle');
    eq((await view(page)).canvas, before.canvas, 'the canvas is not resized by the sheet');
    ok(d.left <= 1 && d.width >= 388, `the sheet spans the width (${Math.round(d.width)} px)`);
    const tools = await page.evaluate(() => document.querySelector('.palette').getBoundingClientRect().top);
    ok(d.bottom <= tools + 1, 'above the tool strip');
    await page.evaluate(() => document.querySelectorAll('[data-region=toasts] > *').forEach((t) => t.remove())); // the toast of the example floats over the sheet
    const peek = await page.evaluate(() => {
      const el = document.querySelector('.stats-dock');
      const box = el.getBoundingClientRect();
      const shown = [...el.querySelectorAll('.insight__strip .tile')].filter((t) => t.offsetParent !== null).map((t) => t.getBoundingClientRect().bottom);
      return { tilesShown: shown.length, clipped: shown.some((b) => b > box.bottom + 1), headBottom: el.querySelector('.insight__head').getBoundingClientRect().bottom <= box.bottom + 1 };
    });
    ok(peek.headBottom && !peek.clipped, `peek is as high as its content: nothing is cut off (${JSON.stringify(peek)})`);
    await page.screenshot({ path: path.join(OUT, 'stats-dock-phone-peek.png') });
    const grip = page.locator('.stats-dock .insight__grip');
    await grip.tap();
    await frames(page, 3);
    d = await dock(page);
    eq(d.snap, 'half', 'a tap on the grip: half');
    const stageH = await page.evaluate(() => document.querySelector('.stage').getBoundingClientRect().height);
    ok(Math.abs(d.height - stageH * 0.54) <= 3, `half is 54 % of the stage (${Math.round(d.height)} of ${Math.round(stageH * 0.54)})`);
    await page.screenshot({ path: path.join(OUT, 'stats-dock-phone-half.png') });
    // touch targets: 40 px on a coarse pointer (kit --control-h): every button, segmented item, switch and the grip of the dock
    ok(await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'the emulated phone has a coarse pointer');
    const targets = await page.evaluate(() => [...document.querySelectorAll('.stats-dock button, .stats-dock [role=separator], .stats-dock label.switch, .stats-dock .insight__crumb .link')]
      .filter((n) => n.offsetParent !== null)
      .map((n) => { const r = n.getBoundingClientRect(); return { what: n.getAttribute('aria-label') || n.textContent.trim().slice(0, 24) || n.className, w: Math.round(r.width), h: Math.round(r.height) }; }));
    ok(targets.length >= 4, `controls found in the sheet (${targets.length})`);
    eq(targets.filter((t) => t.h < 40), [], 'every control of the sheet is at least 40 px high');
    eq(targets.filter((t) => t.w < 40 && /Close|Resize/.test(t.what)), [], 'and the icon buttons 40 px wide');
    // the plan stays tappable above the sheet: tap another vehicle there
    // (the simulation is paused, so the vehicles stand still: pan the plan until another vehicle is in the middle of the part the sheet leaves free)
    await page.waitForTimeout(450); // a sheet that grew has brought the vehicle out from under it with a camera glide (150 ms): let it end before the test pans the camera itself
    const other = await page.evaluate(() => {
      const { ctx, runner, store } = window.__logiplan;
      const r = ctx.canvas.getBoundingClientRect();
      const dockTop = document.querySelector('.stats-dock').getBoundingClientRect().top;
      const cs = store.getState().layout.grid.cellSize;
      const running = runner.sim.vehicles.filter((x) => x.visible && x.state !== 'parked');
      // one that stands alone (no other vehicle within two cells), so that the tap cannot land on its neighbour
      const v = running.find((x) => x.id !== store.getState().ui.selection.ids[0] && running.every((o) => o === x || Math.hypot(o.x - x.x, o.y - x.y) > 2 * cs));
      if (!v) return null;
      const [px, py] = ctx.camera.worldToScreen(v.x, v.y);
      ctx.camera.pan(r.width / 2 - px, (r.top + 90 + dockTop - 30) / 2 - r.top - py);
      const [qx, qy] = ctx.camera.worldToScreen(v.x, v.y);
      return { id: v.id, x: r.left + qx, y: r.top + qy, dockTop };
    });
    await frames(page, 3);
    ok(Boolean(other), 'another vehicle on the part of the plan the sheet leaves free');
    await page.touchscreen.tap(other.x, other.y);
    await frames(page, 3);
    eq((await selection(page)).ids[0], other.id, 'a tap on the plan above the sheet selects that vehicle');
    ok(!(await dock(page)).hidden, 'and does not close the sheet');
    await grip.tap();
    await frames(page, 3);
    eq((await dock(page)).snap, 'full', 'next: full');
    const zoomShown = await page.evaluate(() => getComputedStyle(document.querySelector('.stage__zoom')).display);
    eq(zoomShown, 'none', 'at full the zoom buttons step aside');
    await grip.tap();
    await frames(page, 3);
    eq((await dock(page)).snap, 'peek', 'and round to peek');
    await context.close();
  }

  if (problems.length) throw new Error(`console errors or warnings:\n${[...new Set(problems)].join('\n')}`);
  console.log(`stats-dock e2e: ${checks} checks passed${modelFiles ? '' : ' (the model builder’s files are not installed: the marked placeholder was shown inside the dock)'}`);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
