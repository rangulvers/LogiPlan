// What the Statistics dock SHOWS, in the REAL app in real Chromium: the view-model (js/ui/panels/stats-model.js) and the view (js/ui/panels/stats-view.js) behind the shell's dock.
// (docs/ENTITY-INSIGHTS-DESIGN.md 9.1: S1.9 the numbers, S1.10 the windows, S1.13 the strips of the other kinds, S1.14 accessibility, the view part. The shell itself, the gesture rule,
// the dock states and the camera are tests/e2e/stats-dock.mjs; the pixels of the routes are the overlay's.)
//
//   content    Two lines at 600x to 40 minutes: a vehicle chosen with the keyboard in the Fleet tab shows six numbers with a counting rule each, the three blocks, the time split as a
//              bar with a sentence, the trips as buttons; no NaN / undefined / Infinity anywhere; the window switch changes the numbers and the label of the battery tile
//   keyboard   Fleet tab -> Enter -> the focus is in the dock -> Tab through the controls to a trip row -> the route is drawn (renderer.view.stats.focus) -> Enter pins it -> Esc unpins
//              (the selection stays) -> Esc clears the selection and closes the dock; the (i) of a number opens its rule in place
//   in place   with the simulation running at 600x the dock refreshes several times a second and keeps its nodes: a focused trip row keeps its focus, a tile stays the same element
//   kinds      one click on a workstation, a Goods in, a storage, a Goods out, a depot, a flow, a fleet, a road cell, several stations, several vehicles: six numbers each, no console error;
//              the window switch is disabled where there is no 30-minute figure and says why
//   help       the Help dialog has the page "Statistics of an item" with every counting rule
//   phone      390 px: the sheet shows the numbers, every control of the content is at least 40 px high on the coarse pointer (the (i), the links, the disclosure, the trip rows)
//   a11y       no aria-live inside the dock, the region is labelled, tables have column headers
//
// Run: node tests/e2e/stats-view.mjs        Screenshots: e2e-output/stats-view-*.png (open them and look)
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from '../../scripts/serve.mjs';
import { OUT } from './browser.mjs';

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };
mkdirSync(OUT, { recursive: true });

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const problems = [];

async function session({ viewport = { width: 1440, height: 900 }, colorScheme = 'light', touch = false } = {}) {
  const context = await browser.newContext({ viewport, colorScheme, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[console.${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`[requestfailed] ${r.url()}`));
  await page.goto(`${origin}/index.html`);
  await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
  if (await page.locator('[role=dialog]').count()) {
    await page.keyboard.press('Escape');
    await page.locator('[role=dialog]').waitFor({ state: 'detached' });
  }
  return { context, page };
}

const frames = (page, n = 3) => page.evaluate((count) => new Promise((resolve) => { const next = (left) => (left ? requestAnimationFrame(() => next(left - 1)) : resolve()); next(count); }), n);

async function measured(page, example = 'two-lines', seconds = 2400) {
  await page.evaluate(async (id) => { await window.__logiplan.ctx.actions.loadExample(id); }, example);
  await frames(page, 3);
  await page.evaluate(async () => { const r = window.__logiplan.runner; r.setSpeed(600); await r.play(); });
  await page.waitForFunction((s) => { const w = window.__logiplan.runner.kpis()?.window; return Boolean(w) && w.warmingUp !== true && w.duration >= s; }, seconds, { timeout: 180000 });
  await page.evaluate(() => window.__logiplan.runner.pause());
  await frames(page, 4);
}

const dockText = (page) => page.locator('.stats-dock').innerText();
const tileTexts = (page) => page.evaluate(() => [...document.querySelectorAll('.stats-dock .insight__strip .tile')].map((t) => ({
  label: t.querySelector('.tile__name').textContent, value: t.querySelector('.tile__num').textContent + (t.querySelector('small').hidden ? '' : t.querySelector('small').textContent), ref: t.querySelector('.tile__ref').textContent.trim(),
})));
const stats = (page) => page.evaluate(() => { const s = window.__logiplan.ctx.renderer.view.stats; return s ? { open: s.open, window: s.window, focus: s.focus } : null; });
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `stats-view-${name}.png`) });
const BAD = /NaN|Infinity|undefined|\[object|null/;
const selectAndOpen = async (page, kind, ids) => {
  await page.evaluate(([k, i]) => { const { store, ctx } = window.__logiplan; store.select(k, i); ctx.actions.showStatistics({ focus: false }); }, [kind, ids]);
  await frames(page, 4);
};

try {
  // ============================================================ desktop, Two lines ============================================================
  {
    const { page, context } = await session();
    await measured(page);

    // ---- the keyboard route to a vehicle: Fleet tab, Enter ----
    await page.evaluate(() => window.__logiplan.store.setUi({ rightTab: 'fleet' }));
    await frames(page, 3);
    const agv = page.locator('[data-panel=fleet] [data-role=vehicles] button[data-vehicle^="v2#"]').first();
    const id = await agv.getAttribute('data-vehicle');
    await agv.focus();
    await page.keyboard.press('Enter');
    await frames(page, 6);
    ok(await page.evaluate(() => !document.querySelector('.stats-dock').hidden && document.activeElement === document.querySelector('.stats-dock')), 'Enter in the Fleet tab opens the dock and the focus is in it');
    eq(await page.locator('.stats-dock').getAttribute('aria-label'), `Statistics for AGVs ${id.split('#')[1]}`, 'the region is labelled with the vehicle');

    // ---- the six numbers, each with its counting rule ----
    const tiles = await tileTexts(page);
    eq(tiles.length, 6, 'six numbers');
    eq(tiles.map((t) => t.label.replace(/ · since start$/, '')), ['Trips per hour', 'Busy, incl. waiting', 'Held up', 'Driven', 'Avg loaded trip', 'Lowest battery'], 'the words of the design');
    ok(tiles.every((t) => t.value.length > 0 && !BAD.test(t.value + t.ref)), `every number has a value and none is NaN: ${JSON.stringify(tiles.map((t) => t.value))}`);
    ok(/^\d+(\.\d)? ?\/h$/.test(tiles[0].value) && /^\d+ ?%$/.test(tiles[1].value) && /^\d+ ?%$/.test(tiles[2].value), `the headline numbers read like numbers: ${tiles.slice(0, 3).map((t) => t.value)}`);
    const defs = await page.evaluate(() => [...document.querySelectorAll('.stats-dock .insight__strip .def')].map((b) => ({ tag: b.tagName, label: b.getAttribute('aria-label'), tip: b.dataset.tip, expanded: b.getAttribute('aria-expanded') })));
    eq(defs.length, 6, 'an (i) behind every number');
    ok(defs.every((d) => d.tag === 'BUTTON' && d.label.startsWith('How is this counted?') && d.tip.length > 40 && d.expanded === 'false'), 'a button with the counting rule as its label');

    // the (i) opens the rule in place
    const first = page.locator('.stats-dock .insight__strip .tile').nth(1);
    await first.locator('.def').click();
    ok(await first.locator('[role=note]').isVisible(), 'a click on the (i) shows the rule under the number (touch screens have no hover)');
    ok((await first.locator('[role=note]').innerText()).includes('Waiting counts as busy'), 'the rule of "Busy, incl. waiting"');
    await first.locator('.def').click();
    ok(!(await first.locator('[role=note]').isVisible()), 'and a second click closes it');

    // ---- the blocks: open the dock ----
    await page.locator('.stats-dock .insight__details').click();
    await frames(page, 4);
    const blocks = await page.evaluate(() => [...document.querySelectorAll('.stats-dock .insight__block')].map((b) => ({ block: b.dataset.block, h: b.querySelector('h3').innerText.replace(/\s+/g, ' ') })));
    eq(blocks.map((b) => b.block), ['time', 'facts', 'trips'], 'the three blocks of the design');
    eq(blocks.map((b) => b.h.split(' ')[0]), ['WHERE', 'WORTH', 'TRIPS'], 'their headings');
    const bar = await page.evaluate(() => { const b = document.querySelector('.stats-dock .progress'); return { role: b.getAttribute('role'), label: b.getAttribute('aria-label'), pieces: b.children.length }; });
    eq(bar.role, 'img', 'the stacked bar is an image');
    ok(/^Time split: Driving loaded \d+ %/.test(bar.label) && bar.pieces >= 5, `with a sentence: ${bar.label}`);
    const spark = await page.evaluate(() => { const s = document.querySelector('.stats-dock .split__chart'); return s ? { role: s.getAttribute('role'), label: s.getAttribute('aria-label') } : null; });
    ok(spark && spark.role === 'img' && /^Busy share of each 30 seconds/.test(spark.label), 'the sparkline is an image with a sentence too');
    eq(await page.locator('.stats-dock [aria-live]').count(), 0, 'S1.14: nothing inside the dock is aria-live');
    ok((await page.locator('.stats-dock .facts li').count()) >= 1, 'at least one sentence under "worth knowing"');
    const trips = await page.evaluate(() => [...document.querySelectorAll('.stats-dock ol.trips > li > button.trip')].map((b) => ({ label: b.getAttribute('aria-label'), focus: b.dataset.focus, pressed: b.getAttribute('aria-pressed') })));
    ok(trips.length >= 1 && trips.every((t) => /^\d: .+ to .+, \d+ trips?/.test(t.label) && /^loaded:s\d+>s\d+$/.test(t.focus) && t.pressed === 'false'), `trip rows are buttons with a sentence and the id of their route: ${JSON.stringify(trips[0])}`);
    ok(!BAD.test(await dockText(page)), 'S1.9: no NaN, undefined or Infinity anywhere in the dock');
    await shot(page, 'vehicle-open-light');

    // ---- the keyboard journey to a trip row: Tab, Tab, ... ----
    await page.locator('.stats-dock').focus();
    let reached = false;
    for (let k = 0; k < 60 && !reached; k++) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => document.activeElement && document.activeElement.classList.contains('trip'));
    }
    ok(reached, 'Tab leads from the dock into the trip rows (S1.14)');
    const focusedId = await page.evaluate(() => document.activeElement.dataset.focus);
    eq((await stats(page)).focus, { id: focusedId, pinned: false }, 'focusing a row draws its route: renderer.view.stats.focus names it');
    await page.keyboard.press('Enter');
    await frames(page, 2);
    eq((await stats(page)).focus, { id: focusedId, pinned: true }, 'Enter pins it');
    eq(await page.evaluate(() => document.activeElement.getAttribute('aria-pressed')), 'true', 'the row says it is pressed');
    await page.keyboard.press('Escape');
    await frames(page, 2);
    eq((await stats(page)).focus, null, 'Esc lets go of the pin');
    eq(await page.evaluate(() => window.__logiplan.store.getState().ui.selection.kind), 'vehicle', 'and keeps the selection');
    ok(await page.evaluate(() => !document.querySelector('.stats-dock').hidden), 'and the dock');
    await page.keyboard.press('Escape');
    await frames(page, 3);
    eq(await page.evaluate(() => window.__logiplan.store.getState().ui.selection.kind), null, 'a second Esc clears the selection (the editor\'s)');
    ok(await page.evaluate(() => document.querySelector('.stats-dock').hidden), 'and closes the dock');

    // ---- the window switch: Last 30 min ----
    await selectAndOpen(page, 'vehicle', [id]);
    const before = await tileTexts(page);
    await page.locator('.stats-dock [data-window=last30]').click();
    await frames(page, 4);
    const after = await tileTexts(page);
    eq(after[5].label, 'Lowest, 30 min', 'the battery tile says which window it is about');
    ok(after.some((t, k) => t.value !== before[k].value), 'the numbers moved to the last 30 minutes');
    ok(/30 min measured/.test(await page.locator('.stats-dock .insight__live').innerText()), 'and the header says how long that was');
    eq(await page.evaluate(() => document.querySelector('.stats-dock').dataset.state), 'open', 'the dock stayed open (it remembers its state)');
    const rows = await page.evaluate(() => [...document.querySelectorAll('.stats-dock [data-role=held] .hbar')].map((r) => r.children[0].textContent));
    ok(rows.length === 0 || rows[rows.length - 1].startsWith('Other places (road cells: since start only)'), `Last 30 min: no road-cell rows, and the last row says why: ${JSON.stringify(rows)}`);
    eq((await stats(page)).window, 'last30', 'the overlay is told the window');
    await page.locator('.stats-dock [data-window=start]').click();
    await frames(page, 3);

    // ---- in place: the dock refreshes while the simulation runs and keeps its nodes ----
    await page.evaluate(() => { const row = document.querySelector('.stats-dock ol.trips button.trip'); row.focus(); window.__row = row; window.__tile = document.querySelector('.stats-dock .insight__strip .tile'); window.__bar = document.querySelector('.stats-dock .progress'); window.__texts = document.querySelector('.stats-dock').innerText; });
    await page.evaluate(async () => { const r = window.__logiplan.runner; r.setSpeed(600); await r.play(); });
    await page.waitForTimeout(3500);
    await page.evaluate(() => window.__logiplan.runner.pause());
    await frames(page, 4);
    const kept = await page.evaluate(() => ({
      row: window.__row.isConnected && document.querySelector('.stats-dock ol.trips button.trip') === window.__row, tile: document.querySelector('.stats-dock .insight__strip .tile') === window.__tile,
      bar: document.querySelector('.stats-dock .progress') === window.__bar, focus: document.activeElement === window.__row, changed: document.querySelector('.stats-dock').innerText !== window.__texts,
    }));
    ok(kept.tile && kept.bar, 'S1.9 in place: the tile and the bar are the same elements after a few seconds of refreshes');
    ok(kept.row && kept.focus, `a trip row that had the focus still has it (the dock does not replace a row it can update): ${JSON.stringify(kept)}`);
    ok(kept.changed, 'and the numbers moved');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await frames(page, 2);

    // ---- every kind of item: six numbers, no console error ----
    const kinds = await page.evaluate(() => {
      const l = window.__logiplan.store.getState().layout;
      const st = (t) => l.stations.find((s) => s.type === t);
      const roads = Object.keys(l.roads);
      return [
        ['station', [st('process').id], 'a workstation'], ['station', [st('source').id], 'a Goods in'], ['station', [st('storage').id], 'a storage'], ['station', [st('sink').id], 'a Goods out'], ['station', [st('depot').id], 'a depot'],
        ['flow', [l.flows[0].id], 'a flow'], ['fleet', [l.fleets[0].id], 'a fleet'], ['cell', [roads[Math.floor(roads.length / 2)]], 'a road cell'],
        ['station', l.stations.filter((s) => s.type === 'process').map((s) => s.id), 'several workstations'], ['vehicle', ['v2#1', 'v2#2', 'v2#3'], 'several vehicles'], ['flow', l.flows.slice(0, 2).map((f) => f.id), 'several flows'],
      ];
    });
    for (const [kind, ids, what] of kinds) {
      await selectAndOpen(page, kind, ids);
      const t = await tileTexts(page);
      eq(t.length, 6, `${what}: six numbers`);
      ok(t.every((x) => x.label.length > 0 && x.value.length > 0 && !BAD.test(x.value + x.ref)), `${what}: ${JSON.stringify(t.map((x) => x.value))}`);
      ok(!BAD.test(await dockText(page)), `${what}: no NaN anywhere`);
      eq(await page.locator('.stats-dock [aria-live]').count(), 0, `${what}: no aria-live`);
      const last = await page.locator('.stats-dock [data-window=last30]').isDisabled();
      const vehicles = kind === 'vehicle';
      eq(last, !vehicles, `${what}: the 30-minute switch is ${vehicles ? 'enabled' : 'disabled (and says why)'}`);
      if (!vehicles) ok((await page.locator('.stats-dock [data-window=last30]').getAttribute('title')).length > 20, `${what}: the disabled switch carries its reason`);
    }
    await selectAndOpen(page, 'station', [kinds[1][1][0]]);
    await frames(page, 3);
    ok((await page.locator('.stats-dock table.compare').count()) === 0 || (await page.locator('.stats-dock table.compare th[scope=col]').count()) >= 4, 'a table has column headers');
    await shot(page, 'station-light');

    // ---- the Help page ----
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Help' }).first().click();
    await page.getByRole('tab', { name: 'Statistics of an item' }).click();
    const help = await page.locator('[role=dialog] [data-help=statistics]').innerText();
    ok(help.includes('Statistics dock') && help.includes('Busy, incl. waiting') && help.includes('Waits for material') && help.includes('Workload arithmetic'), 'the Help page lists the rules');
    eq(await page.locator('[role=dialog] [data-help=statistics] [aria-live]').count(), 0);
    await page.keyboard.press('Escape');
    await context.close();
  }

  // ============================================================ dark ============================================================
  {
    const { page, context } = await session({ colorScheme: 'dark' });
    await measured(page, 'two-lines', 1800);
    await selectAndOpen(page, 'vehicle', ['v2#1']);
    await page.locator('.stats-dock .insight__details').click();
    await frames(page, 4);
    await shot(page, 'vehicle-open-dark');
    await selectAndOpen(page, 'station', ['s5']);
    await shot(page, 'station-dark');
    await context.close();
  }

  // ============================================================ the other plants of the examples ============================================================
  // Congestion lab (queues, the fleet question says "queueing"), Dock lab (trucks and yards), Warehouse first day (everything starts empty): the same six numbers, no NaN, the blocks open.
  for (const example of ['congestion-lab', 'dock-lab', 'warehouse-first-day']) {
    const { page, context } = await session();
    await measured(page, example, 2400);
    await page.evaluate(() => window.__logiplan.store.setUi({ rightTab: 'fleet' }));
    await frames(page, 3);
    const vehicleIds = await page.evaluate(() => [...document.querySelectorAll('[data-panel=fleet] [data-role=vehicles] button[data-vehicle]')].map((b) => b.dataset.vehicle));
    ok(vehicleIds.length > 0, `${example}: the Fleet tab lists vehicles`);
    const kindsHere = await page.evaluate(() => {
      const l = window.__logiplan.store.getState().layout;
      const out = [];
      for (const type of ['process', 'source', 'storage', 'sink', 'depot']) { const s = l.stations.find((x) => x.type === type); if (s) out.push(['station', [s.id], type]); }
      if (l.flows[0]) out.push(['flow', [l.flows[0].id], 'flow']);
      if (l.fleets[0]) out.push(['fleet', [l.fleets[0].id], 'fleet']);
      return out;
    });
    const picks = [['vehicle', [vehicleIds[0]], 'first vehicle'], ['vehicle', [vehicleIds[vehicleIds.length - 1]], 'last vehicle'], ...kindsHere];
    for (const [kind, ids, what] of picks) {
      await selectAndOpen(page, kind, ids);
      const t = await tileTexts(page);
      eq(t.length, 6, `${example}, ${what}: six numbers`);
      ok(t.every((x) => x.label.length > 0 && x.value.length > 0 && !BAD.test(x.value + x.ref)), `${example}, ${what}: ${JSON.stringify(t.map((x) => x.value))}`);
      ok(!BAD.test(await dockText(page)), `${example}, ${what}: no NaN anywhere`);
      const shares = (await dockText(page)).match(/\d+(?:\.\d+)? ?%/g) || [];
      ok(shares.every((p) => parseFloat(p) <= 100), `${example}, ${what}: no share above 100 %: ${shares.filter((p) => parseFloat(p) > 100)}`);
    }
    // a vehicle with the blocks open and the 30-minute window
    await selectAndOpen(page, 'vehicle', [vehicleIds[0]]);
    await page.locator('.stats-dock .insight__details').click();
    await frames(page, 4);
    eq(await page.locator('.stats-dock .insight__block').count(), 3, `${example}: the three blocks`);
    await page.locator('.stats-dock [data-window=last30]').click();
    await frames(page, 4);
    const last = await tileTexts(page);
    ok(last.length === 6 && last.every((x) => !BAD.test(x.value + x.ref)) && /30 min/.test(await page.locator('.stats-dock .insight__live').innerText()), `${example}: the header says the 30 minutes were measured: ${JSON.stringify(last.map((x) => x.label))}`);
    ok(!BAD.test(await dockText(page)), `${example}: no NaN in the 30-minute window`);
    await shot(page, `${example}-vehicle`);
    await context.close();
  }

  // ============================================================ phone ============================================================
  {
    const { page, context } = await session({ viewport: { width: 390, height: 844 }, touch: true });
    await measured(page, 'two-lines', 1800);
    await selectAndOpen(page, 'vehicle', ['v2#1']);
    await frames(page, 4);
    await shot(page, 'phone-peek');
    await page.locator('.insight__grip').click();
    await frames(page, 4);
    await shot(page, 'phone-half');
    await page.locator('.insight__grip').click();
    await frames(page, 4);
    await shot(page, 'phone-full');
    const small = await page.evaluate(() => {
      const dock = document.querySelector('.stats-dock');
      const out = [];
      for (const b of dock.querySelectorAll('.insight__strip button, .insight__body button')) {
        const r = b.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        out.push({ cls: b.className, role: b.dataset.role || '', w: Math.round(r.width), h: Math.round(r.height) });
      }
      return out;
    });
    ok(small.length >= 10, `${small.length} controls in the content of the sheet`);
    const tooSmall = small.filter((c) => c.h < 40 || c.w < 40);
    ok(tooSmall.length === 0, `S1.14: every control of the content is at least 40 px on the coarse pointer; too small: ${JSON.stringify(tooSmall)}`);
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll on the page');
    ok(await page.evaluate(() => { const b = document.querySelector('.stats-dock .insight__body'); return b.scrollWidth <= b.clientWidth + 1; }), 'and none inside the sheet');
    await context.close();
  }

  assert.deepEqual(problems, [], 'no console error, no page error, no failed request');
  console.log(`stats-view e2e: ${checks} checks passed`);
} finally {
  await browser.close();
  await new Promise((r) => server.close(r));
}
