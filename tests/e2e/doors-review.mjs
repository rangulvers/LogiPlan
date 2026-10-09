// Independent review of milestone M1 (trucks and dock doors) from the USER'S side, in the REAL app (index.html + js/main.js) in real Chromium.
// The reviewer played a planner of a pallet warehouse who knows the work but not the tool, and then a hostile tester: the journeys cold (Starter + doors, a plant
// built from scratch with the mouse, rate against timetable, German and English Excel, the Doors card, undo, reload, share link, the Dock lab turned into a row,
// one whole day, Compare and a sweep over doors), nonsense in every field, double clicks, Escape/Tab/Enter/Space in the dialog, 360 px and 4K, the canvas
// at every zoom, 20 truck stations at 600x, a station with 32 doors, the station removed under an open dialog, variants switched while running, dark mode,
// reduced motion, the keyboard and the accessibility tree.
//
// Two kinds of checks (the convention of tests/e2e/edit-feedback-review.mjs):
//   ok / eq             GUARDS: attacks that must not break anything; a failed one aborts the run.
//   defect(id, cond, severity, text)   a FINDING of the review: printed as OPEN while `cond` is false and as FIXED once it holds (then turn it into a guard
//                       with `fixed`). severity: high = crash, data loss, a wrong number shown to the user or a blocked journey; medium = confusing or
//                       ugly enough that a planner would misread it or give up; low = polish. The run exits with code 1 while any finding is OPEN.
//
// Run: node tests/e2e/doors-review.mjs [section]
//   sections: cold scratch paste timetable demand day canvas hostile a11y keyboard compare
// Screenshots: e2e-output/doors-review-*.png (open them and look). Every section asserts that the page logged no console error or warning and made no
// request outside the app.
import assert from 'node:assert/strict';
import path from 'node:path';
import { withBrowser, OUT } from './browser.mjs';
import { loadavg } from 'node:os';

const only = process.argv[2] || '';
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

const DESKTOP = { width: 1440, height: 900 };
const NARROW = { width: 360, height: 780 };

await withBrowser(async ({ browser, url, errors }) => {
  const origin = new URL(url('/')).origin;
  const foreign = [];

  // ---- plumbing ------------------------------------------------------------------------------------------------------------------------------------

  async function session({ viewport = DESKTOP, colorScheme = 'light', locale = 'en-US', reducedMotion = 'no-preference' } = {}) {
    const context = await browser.newContext({ viewport, colorScheme, locale, reducedMotion, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[console.${m.type()}] ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    page.on('requestfailed', (r) => errors.push(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`));
    page.on('request', (r) => { if (!r.url().startsWith(origin) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) foreign.push(r.url()); });
    await page.goto(url('/index.html'));
    await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
    await page.locator('[role=dialog]').first().waitFor();
    return { context, page };
  }
  /** The welcome gallery, a click on an example, like a planner. */
  async function openExample(id, opts) {
    const s = await session(opts);
    await s.page.locator(`[role=dialog] [data-example="${id}"]`).click();
    await s.page.locator('[role=dialog]').waitFor({ state: 'detached' });
    await frames(s.page, 3);
    return s;
  }
  async function openEmpty(opts) {
    const s = await session(opts);
    await s.page.getByRole('button', { name: 'Create empty plant' }).click();
    await s.page.locator('[role=dialog]').waitFor({ state: 'detached' });
    await frames(s.page, 3);
    return s;
  }
  const frames = (page, n = 2) => page.evaluate((count) => new Promise((resolve) => { const next = (left) => (left ? requestAnimationFrame(() => next(left - 1)) : resolve()); next(count); }), n);
  const snap = (page, name, opts = {}) => page.screenshot({ path: path.join(OUT, `doors-review-${name}.png`), ...opts });
  const noErrors = (what) => {
    eq(errors.splice(0).filter((e) => !/willReadFrequently/.test(e)), [], `${what}: console errors or warnings`);
    eq(foreign.splice(0), [], `${what}: requests outside the app`);
  };
  const run = async (name, fn) => {
    if (only && only !== name) return;
    const t0 = Date.now();
    console.log(`-- ${name}`);
    await fn();
    noErrors(name);
    console.log(`   (${Math.round((Date.now() - t0) / 100) / 10} s)`);
  };

  const layoutOf = (page) => page.evaluate(() => window.__logiplan.store.getState().layout);
  const trucksOf = async (page, idOrType) => (await layoutOf(page)).stations.find((s) => s.id === idOrType || s.type === idOrType)?.ops?.trucks;
  const setTab = (page, t) => page.evaluate((x) => window.__logiplan.ctx.actions.setRightTab(x), t);
  const select = (page, idOrType) => page.evaluate((k) => { const { store } = window.__logiplan; const s = store.getState().layout.stations.find((x) => x.id === k || x.type === k); store.select('station', [s.id]); }, idOrType);
  const clearSelection = (page) => page.evaluate(() => window.__logiplan.store.select(null, []));
  const step = (page, seconds) => page.evaluate(async (s) => { await window.__logiplan.runner.step(s); }, seconds);
  const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('[data-region=toasts] > *')].map((t) => t.textContent));
  const closeToasts = async (page) => { for (const b of await page.locator('[data-region=toasts] button').all()) await b.click().catch(() => {}); await frames(page, 3); };
  const openDrawer = async (page) => {
    const toggle = page.locator('.topbar__panel-toggle');
    if ((await toggle.count()) && (await toggle.isVisible()) && (await toggle.getAttribute('aria-expanded')) !== 'true') { await toggle.click(); await page.waitForTimeout(500); }
  };
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const brickPx = (page, type) => page.evaluate((t) => {
    const { ctx, store } = window.__logiplan;
    const layout = store.getState().layout;
    const s = layout.stations.find((x) => x.type === t || x.id === t);
    const cs = layout.grid.cellSize;
    const r = ctx.canvas.getBoundingClientRect();
    const [x0, y0] = ctx.camera.worldToScreen(s.x * cs, s.y * cs);
    const [x1, y1] = ctx.camera.worldToScreen((s.x + s.w) * cs, (s.y + s.h) * cs);
    return { x: r.left + x0, y: r.top + y0, w: x1 - x0, h: y1 - y0 };
  }, type);
  const cellPx = (page, col, row) => page.evaluate(([c, r]) => {
    const { ctx, store } = window.__logiplan;
    const cs = store.getState().layout.grid.cellSize;
    const rect = ctx.canvas.getBoundingClientRect();
    const [x, y] = ctx.camera.worldToScreen((c + 0.5) * cs, (r + 0.5) * cs);
    return { x: rect.left + x, y: rect.top + y };
  }, [col, row]);
  async function drag(page, a, b) {
    const p = await cellPx(page, a[0], a[1]);
    const q = await cellPx(page, b[0], b[1]);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(q.x, q.y, { steps: 8 });
    await page.mouse.up();
    await frames(page, 2);
  }
  const tool = (page, name) => page.getByRole('button', { name, exact: true }).first().click();
  const zoomOn = (page, stationId, zoom) => page.evaluate(([id, z]) => {
    const { ctx, store } = window.__logiplan;
    const s = store.getState().layout.stations.find((x) => x.id === id);
    const cs = store.getState().layout.grid.cellSize;
    ctx.camera.zoomTo(z, ctx.canvas.clientWidth / 2, ctx.canvas.clientHeight / 2);
    ctx.camera.centerOn((s.x + s.w / 2) * cs, (s.y + s.h / 2) * cs);
  }, [stationId, zoom]);
  /** Put the trucks controls of a station on the screen in the Properties tab (opens the drawer on a phone). */
  async function showTrucks(page, idOrType) {
    await select(page, idOrType);
    await setTab(page, 'properties');
    await openDrawer(page);
    await frames(page, 3);
  }
  /** The paste dialog: open it, put `text` in, return what it says (the summary, the number of good rows and the preview table). */
  async function pasteSees(page, text) {
    await page.locator('[data-role=paste]').scrollIntoViewIfNeeded();
    await page.locator('[data-role=paste]').click();
    const dlg = page.locator('[role=dialog]');
    await dlg.waitFor();
    await dlg.locator('[data-role=paste-text]').fill(text);
    await frames(page, 2);
    const out = {
      summary: await dlg.locator('[data-role=paste-summary]').innerText(),
      good: await dlg.locator('tr[data-kind=good]').count(),
      bad: await dlg.locator('tr[data-kind=bad]').count(),
      table: await dlg.locator('[data-role=paste-preview]').innerText().catch(() => ''),
      use: await dlg.getByRole('button', { name: /^Use / }).innerText(),
      dlg,
    };
    return out;
  }
  const closePaste = async (page) => { await page.keyboard.press('Escape'); await page.locator('[role=dialog]').waitFor({ state: 'detached' }); };
  /** Rows in the timetable, as hours (6, 7.5 ...), straight from the store. */
  const hoursOf = async (page, id = 's1') => (await trucksOf(page, id)).schedule.map((r) => r.at / 3600);

  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  // cold: a new user, the Starter, the real mouse
  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  await run('cold', async () => {
    const { page, context } = await openExample('starter');
    await snap(page, 'cold-01-starter');
    const before = JSON.stringify(await layoutOf(page));
    // a click on the brick selects it; the quiet block with its one button is what a new planner meets
    const b = await brickPx(page, 'source');
    await page.mouse.click(b.x + b.w / 2, b.y + b.h / 2);
    await frames(page, 3);
    await setTab(page, 'properties');
    ok(await page.locator('[data-role=trucks-off]').isVisible(), 'the quiet block with "Add dock doors" is there');
    ok(!(await page.locator('[data-role=trucks-on]').isVisible()), 'and nothing of the controls yet');
    await page.locator('[data-role=add-doors]').click();
    await frames(page, 4);
    const trucks = await trucksOf(page, 'source');
    eq([trucks.doors, trucks.pallets.mean, trucks.interArrival.mean], [2, 24, 4320], 'one pallet every 3 minutes becomes 24 pallets every 72 minutes');
    ok(/now receives trucks: 2 doors, 24 pallets per truck, about one truck every 72 min\./.test((await toasts(page)).join(' ')), 'the toast says what happened');
    await snap(page, 'cold-02-doors-added');
    await page.getByRole('button', { name: 'Increase Doors' }).dblclick();
    eq((await trucksOf(page, 'source')).doors, 4, 'a double click on + is two steps');
    await page.evaluate(() => { const s = window.__logiplan.store; while (s.getState().canUndo) s.undo(); });
    await frames(page, 3);
    eq(JSON.stringify(await layoutOf(page)), before, 'undo takes the Starter back byte for byte');
    await page.locator('[data-role=add-doors]').dblclick();
    await frames(page, 4);
    eq((await trucksOf(page, 'source')).doors, 2, 'a double click on "Add dock doors" adds the doors once');

    // The Help page and what the plant did: the page promises one door where one road cell touches the station.
    await page.getByRole('button', { name: 'Help' }).first().click();
    await page.locator('[role=dialog]').waitFor();
    await page.locator('[role=dialog] [role=tab]', { hasText: 'Trucks and dock doors' }).click();
    await page.waitForTimeout(300);
    const help = await page.locator('[role=dialog] [role=tabpanel]:not([hidden])').innerText();
    await snap(page, 'cold-03-help');
    ok(/Add dock doors/.test(help), 'the Help page for trucks exists');
    defect('UX-4', !/two doors, or one when only one road cell touches it/.test(help) || (await trucksOf(page, 'source')).doors === 1, 'medium',
      'Help says "A station gets two doors, or one when only one road cell touches it", but "Add dock doors" gives the Starter (one road cell) 2 doors and the Checks tab warns at once');
    defect('UX-15', !/cold restart/i.test(help), 'low', 'the Help heading "Timetables, clock and cold restart" uses the engineers\' word; the toast and the plant settings say "starts again at ..."');
    await page.keyboard.press('Escape');
    await page.locator('[role=dialog]').waitFor({ state: 'detached' });

    // Checks: advice that leads in a circle
    await setTab(page, 'checks');
    await page.waitForTimeout(500);
    let checksText = await page.locator('[data-panel=checks]').innerText();
    ok(/has 2 doors but only 1 road cell touches it/.test(checksText), 'Checks: one warning about the second door');
    await select(page, 'source');
    await setTab(page, 'properties');
    await frames(page, 3);
    const root = page.locator('[data-role=trucks-on]');
    await root.getByLabel('Average').first().fill('10');
    await root.getByLabel('Average').nth(1).fill('26');
    await page.getByRole('button', { name: 'Increase Doors' }).dblclick();
    await frames(page, 3);
    await setTab(page, 'checks');
    await page.waitForTimeout(500);
    checksText = await page.locator('[data-panel=checks]').innerText();
    ok(/needs about 4\.9 doors busy at once/.test(checksText), 'Checks: 6 trucks an hour of 26 pallets need 4.9 doors (Appendix A)');
    await snap(page, 'cold-04-too-few');
    await page.locator('[data-panel=checks] button', { hasText: /^Use \d+ doors/ }).first().click();
    await page.waitForTimeout(600);
    checksText = await page.locator('[data-panel=checks]').innerText();
    await snap(page, 'cold-05-after-fix');
    defect('UX-5', !/but only 1 road cell touches it/.test(checksText) && !/a door beyond them cannot be unloaded any faster/.test(checksText), 'medium',
      'the Fix "Use 6 doors" on a station with one dock cell is followed by a new warning on the same station ("has 6 doors but only 1 road cell touches it"): the two checks give circular advice');
    await context.close();
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  // the plant from scratch, with the mouse, then doors
  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  await run('scratch', async () => {
    const { page, context } = await openEmpty();
    await tool(page, 'Road');
    await drag(page, [6, 8], [30, 8]);
    await drag(page, [30, 8], [30, 24]);
    await drag(page, [30, 24], [6, 24]);
    await drag(page, [6, 24], [6, 8]);
    await tool(page, 'Goods in'); await drag(page, [10, 6], [15, 7]);
    await tool(page, 'Storage'); await drag(page, [20, 9], [29, 16]);
    await tool(page, 'Goods out'); await drag(page, [10, 25], [15, 26]);
    await tool(page, 'Parking'); await drag(page, [3, 12], [5, 13]);
    await tool(page, 'Flow');
    await drag(page, [12, 6], [24, 12]);
    await drag(page, [24, 12], [12, 25]);
    await page.keyboard.press('Escape');
    await tool(page, 'Select');
    ok(/Add dock doors/.test(await page.locator('#panel-properties').innerText()), 'once the plant has flows, the Next steps card offers "Add dock doors"');
    await page.getByRole('button', { name: 'Add vehicles' }).first().click();
    await frames(page, 3);
    const b = await brickPx(page, 'source');
    await page.mouse.click(b.x + b.w / 2, b.y + b.h / 2);
    await frames(page, 3);
    await page.locator('[data-role=add-doors]').click();
    await frames(page, 4);
    eq((await trucksOf(page, 'source')).doors, 2, 'doors on the plant built from scratch');
    await setTab(page, 'checks');
    await page.waitForTimeout(500);
    const checks = await page.locator('[data-panel=checks]').innerText();
    ok(/docks of “Goods in 1” lie in a row on one lane/.test(checks), 'a Goods in drawn along a road: the Checks tab says "lie in a row on one lane"');
    await snap(page, 'scratch-01-checks');
    await page.locator('.simbar').getByRole('button', { name: 'Run simulation' }).click();
    await page.evaluate(() => window.__logiplan.runner.setSpeed(600));
    await page.waitForFunction(() => window.__logiplan.runner.time > 5400, null, { timeout: 120000 });
    await page.evaluate(() => window.__logiplan.runner.pause());
    await setTab(page, 'results');
    await frames(page, 4);
    const doors = await page.locator('details[data-section=doors]').innerText();
    ok(/Trucks served/.test(doors) && !/NaN|undefined|Infinity/.test(doors), 'the Doors card has figures and no NaN');
    await snap(page, 'scratch-02-results');
    await context.close();
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  // paste: German Excel, English Excel, and what a planner really copies
  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  await run('paste', async () => {
    const { page, context } = await openExample('warehouse-first-day');
    await showTrucks(page, 's1');
    await page.locator('[data-role=mode] button', { hasText: 'Use a timetable' }).click();
    await frames(page, 3);
    // German Excel
    let seen = await pasteSees(page, 'Ankunft;Paletten\n06.00;24,0\n6:30 Uhr;18\n08:00;\n25:70;4');
    eq([seen.good, seen.bad], [3, 1], 'German Excel: header skipped, three rows read, one bad row marked');
    ok(/row 5 “25:70” is not a time\. Nothing is applied until you press Use 3 rows\./.test(seen.summary), seen.summary);
    eq(await hoursOf(page), [], 'nothing is applied while the preview is open');
    await snap(page, 'paste-01-german');
    await closePaste(page);
    eq(await hoursOf(page), [], 'Escape applies nothing');
    seen = await pasteSees(page, 'Ankunft;Paletten\n06.00;24,0\n6:30 Uhr;18\n08:00;');
    await seen.dlg.getByRole('button', { name: 'Use 3 rows' }).click();
    await seen.dlg.waitFor({ state: 'detached' });
    eq(await hoursOf(page), [6, 6.5, 8], 'after "Use 3 rows" the timetable is there');
    // English Excel (tab) in a 24-hour style
    seen = await pasteSees(page, '06:00\t24\n07:30\t18\n09:00\t26');
    eq([seen.good, seen.bad], [3, 0], 'English Excel with tabs');
    await closePaste(page);
    // what US-English Excel really copies from a time cell: "6:00 AM", "6:00:00 AM" or "6:00:00"
    const hint = /24[- ]?h|HH:MM|AM\/PM|a\.m\./i;
    const us = await pasteSees(page, '6:00 AM\t24\n7:30 AM\t18\n1:00 PM\t26');
    const usSec = await (async () => { await page.locator('[data-role=paste-text]').fill('6:00:00\t24\n7:30:00\t18'); await frames(page, 2); return { good: await page.locator('tr[data-kind=good]').count(), summary: await page.locator('[data-role=paste-summary]').innerText() }; })();
    await snap(page, 'paste-02-us-ampm');
    defect('UX-2', (us.good > 0 || hint.test(us.summary)) && (usSec.good > 0 || hint.test(usSec.summary)), 'medium',
      `English (US) Excel copies times as "6:00 AM" or "6:00:00": the dialog answers "${us.summary.slice(0, 70)}" and "${usSec.summary.slice(0, 60)}" without saying what to change (24-hour, no seconds)`);
    await closePaste(page);
    // three columns (carrier, time, pallets), the usual export of a gate book
    const three = await pasteSees(page, 'DHL\t06:00\t24\nUPS\t07:30\t18');
    ok(/3 columns/.test(three.table + three.summary), 'three columns: the reason is named');
    await closePaste(page);
    // an Excel time that arrives as a day fraction
    const frac = await pasteSees(page, '0.25\t24\n0.3125\t18');
    const readAsMidnightQuarter = /00:25/.test(frac.table);
    defect('UX-21', !readAsMidnightQuarter, 'low', 'a time copied as the day fraction 0.25 (= 06:00) is read silently as 00:25 (the "6.05" German notation), while 0.3125 is refused');
    await closePaste(page);
    // hostile text: huge, HTML, only whitespace, one line of 100 KB
    for (const text of ['<script>window.__xss=1</script>\n06:00;24', ' \n\t\n', 'x'.repeat(100000), Array.from({ length: 2000 }, (_, i) => `${String(i % 24).padStart(2, '0')}:${String(i % 60).padStart(2, '0')};${(i % 50) + 1}`).join('\n')]) {
      const s = await pasteSees(page, text);
      ok(s.use.startsWith('Use'), `hostile paste (${text.length} characters) is answered: "${s.summary.slice(0, 60)}"`);
      await closePaste(page);
    }
    eq(await page.evaluate(() => window.__xss), undefined, 'pasted markup is text');
    await context.close();
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  // the timetable table: typing a time
  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  await run('timetable', async () => {
    for (const locale of ['en-US', 'de-DE']) {
      const { page, context } = await openExample('warehouse-first-day', { locale });
      await showTrucks(page, 's1');
      await page.locator('[data-role=mode] button').nth(1).click();
      await frames(page, 3);
      const rows = [6, 7, 8].map((h) => ({ at: h * 3600, pallets: 24 }));
      await page.evaluate(async (r) => { const M = await import('/js/model/layout.js'); window.__logiplan.store.commit('rows', (l) => { M.updateStation(l, 's1', { ops: { trucks: { schedule: r } } }); }); }, rows);
      await frames(page, 3);
      eq(await hoursOf(page), [6, 7, 8], `${locale}: three rows`);
      // a planner types 09:30 into the second row: click the hour part, press 0 9 3 0
      const input = page.locator('[data-row="1"] input[type=time]');
      await input.scrollIntoViewIfNeeded();
      const box = await input.boundingBox();
      await page.mouse.click(box.x + 12, box.y + box.height / 2);
      for (const key of ['0', '9', '3', '0']) { await page.keyboard.press(key); await page.waitForTimeout(150); }
      await page.keyboard.press('Tab');
      await frames(page, 3);
      const after = await hoursOf(page);
      await snap(page, `timetable-typed-${locale}`);
      defect(`UX-1-${locale}`, JSON.stringify(after) === JSON.stringify([6, 8, 9.5]), 'high',
        `${locale}: typing 09:30 in the second row of [06:00, 07:00, 08:00] must give [06:00, 08:00, 09:30]; it gave ${JSON.stringify(after)} (each valid segment commits and re-sorts the table, focus jumps to another row and the next keys edit that row)`);
      // pallets: invalid input reverts, empty means "drawn"
      const pal = page.locator('[data-row="0"] input[type=number]');
      for (const t of ['0', '-4', '1e9', '201']) {
        await pal.click(); await page.keyboard.press('Control+a'); await page.keyboard.press('Delete'); await page.keyboard.type(t); await page.keyboard.press('Tab'); await frames(page, 2);
        const stored = (await trucksOf(page, 's1')).schedule[0].pallets;
        ok(stored === null || (stored >= 1 && stored <= 200), `${locale}: pallets "${t}" never stores ${stored}`);
      }
      // delete with the keyboard: focus stays in the table
      await page.locator('[data-row="0"] [data-role=delete-row]').focus();
      await page.keyboard.press('Enter');
      await frames(page, 3);
      ok(await page.evaluate(() => !!document.activeElement.closest('[data-role=timetable]')), `${locale}: after deleting a row the focus is still in the table`);
      await context.close();
    }

    // Switching to a timetable on a plant that has trucks in rate mode
    const { page, context } = await openExample('warehouse-first-day');
    await showTrucks(page, 's1');
    await page.locator('[data-role=mode] button', { hasText: 'Use a timetable' }).click();
    await frames(page, 3);
    const tt = await trucksOf(page, 's1');
    await snap(page, 'timetable-switch-empty');
    defect('UX-8', tt.schedule.length > 0, 'medium',
      'switching "Generate from rate" to "Use a timetable" throws the plant\'s trucks away: the timetable starts empty, so no truck ever arrives until the planner fills the table (the Goods in of "Warehouse: first day" had a truck every 17 minutes)');
    // Once rows from 06:00 are in, the clock still starts at 00:00
    const pasted = await pasteSees(page, '06:00;24\n07:00;24');
    await pasted.dlg.getByRole('button', { name: /^Use / }).click();
    await frames(page, 3);
    const cal = (await layoutOf(page)).calendar;
    await clearSelection(page);
    await frames(page, 3);
    const clockText = await page.locator('[data-role=clock-section]').innerText();
    defect('UX-9', cal.startTod > 0 || /first (truck|arrival)|before the first/i.test(clockText), 'low',
      'a timetable whose first truck comes at 06:00 on a clock that starts at 00:00: at the default 10x the planner watches 36 minutes of an empty plant, and nothing says why or how to start closer to the first truck');
    // "Remove trucks" with a pasted timetable: the link says "Nothing you set before is lost"
    await select(page, 's1');
    await setTab(page, 'properties');
    await frames(page, 3);
    await closeToasts(page);
    eq((await trucksOf(page, 's1')).schedule.length, 2, 'two pasted rows');
    const title = await page.locator('[data-role=remove-trucks]').getAttribute('title');
    await page.locator('[data-role=remove-trucks]').click();
    await frames(page, 4);
    const afterRemove = (await toasts(page)).join(' | ');
    eq(await trucksOf(page, 's1'), undefined, 'the trucks are gone');
    await page.locator('[data-role=add-doors]').click();
    await frames(page, 4);
    eq((await trucksOf(page, 's1')).schedule.length, 0, 'and "Add dock doors" starts from the defaults, not from the old timetable');
    defect('UX-24', /undo/i.test(afterRemove), 'medium',
      `"Remove trucks" deletes the doors, check-in times and the pasted timetable in one click without a confirmation or a toast with Undo (toasts afterwards: "${afterRemove.slice(0, 80)}"), while its tooltip says "${title}" and the Help page "without losing anything you set before"`);
    await context.close();
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  // the demand slider and the numbers of the section
  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  await run('demand', async () => {
    const { page, context } = await openExample('warehouse-first-day');
    await page.evaluate(async () => { const M = await import('/js/model/layout.js'); window.__logiplan.store.commit('demand 2', (l) => { M.updateSettings(l, { demandFactor: 2 }); }); });
    await showTrucks(page, 's1');
    const text = await page.locator('[data-role=trucks-on]').innerText();
    ok(/About 7\.1 trucks an hour of 24 pallets/.test(text), 'with the demand slider at 2x the section counts 7.1 trucks an hour');
    ok(/Average 17 min/.test(text), 'while the field above still says 17 minutes between trucks');
    await snap(page, 'demand-2x');
    defect('UX-23', /demand/i.test(text.replace(/Demand slider/g, '')), 'medium',
      'with the demand slider at 2x the section says "Average 17 min" between trucks and, two lines below, "About 7.1 trucks an hour" and a door check for 7.1 trucks an hour: nothing in the section says that the slider doubled the trucks');
    await context.close();
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  // a day plant: feedback after an edit, Experiments, the cost of one day
  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  await run('day', async () => {
    const { page, context } = await openExample('warehouse-first-day');
    await showTrucks(page, 's1');
    await page.locator('[data-role=mode] button', { hasText: 'Use a timetable' }).click();
    await frames(page, 3);
    const rows = Array.from({ length: 12 }, (_, i) => `${String(6 + i).padStart(2, '0')}:00;24`).join('\n');
    const seen = await pasteSees(page, rows);
    await seen.dlg.getByRole('button', { name: /^Use / }).click();
    await frames(page, 3);
    // Experiments on a day plant
    await setTab(page, 'experiments');
    await frames(page, 3);
    const runLength = Number(await page.locator('#panel-experiments').getByLabel('Run length', { exact: true }).inputValue());
    const experimentsText = await page.locator('#panel-experiments').innerText();
    await snap(page, 'day-01-experiments');
    defect('UX-7', runLength >= 24 || /whole day|24 h|a day/i.test(experimentsText.replace(/Run length/, '')), 'medium',
      `Experiments on a day plant: run length ${runLength} h from 00:00, so a comparison measures the quiet night (the trucks come from 06:00) and nothing in the tab says that a day plant needs whole days`);
    // feedback after the second edit (the first one gets the toast of copy 7, once per session)
    await page.evaluate(() => window.__logiplan.runner.setSpeed(1200));
    await page.locator('.simbar').getByRole('button', { name: 'Run simulation' }).click();
    await page.waitForFunction(() => window.__logiplan.runner.time > 3000, null, { timeout: 120000 });
    await setTab(page, 'properties');
    await select(page, 's1');
    await frames(page, 3);
    await page.getByRole('button', { name: 'Increase Doors' }).click();
    await page.waitForTimeout(1500);
    await closeToasts(page);
    await page.waitForFunction(() => window.__logiplan.runner.time > 3000, null, { timeout: 120000 });
    await page.getByRole('button', { name: 'Increase Doors' }).click();
    await page.waitForTimeout(1500);
    const feedback = await page.evaluate(() => [...document.querySelectorAll('[data-region=toasts], [data-panel=impact-hint], [data-panel=impact], .simbar')].filter((e) => e.getClientRects().length && getComputedStyle(e).display !== 'none').map((e) => e.innerText).join(' | '));
    await snap(page, 'day-02-after-second-edit');
    defect('UX-6', /whole day|time of day|daily/i.test(feedback), 'medium',
      'after the second edit of a day plant the simulation silently starts again at 00:00: no card, no hint, no toast (design 6.2.7: "Time of day matters. Compare whole days", with an action that opens Experiments)');
    await page.evaluate(() => window.__logiplan.runner.pause());

    // one whole day, timed
    await clearSelection(page);
    await setTab(page, 'properties');
    await frames(page, 3);
    const copy = await page.locator('[data-role=clock-section]').innerText();
    const lower = Number(/roughly (\d+) to (\d+) seconds/.exec(copy)?.[1] ?? 0);
    const t0 = Date.now();
    await page.locator('[data-role=run-day]').click();
    await page.waitForTimeout(300);
    const dayToast = (await toasts(page)).join(' | ');
    await page.waitForFunction(() => window.__logiplan.runner.time >= 86399 && !window.__logiplan.runner.playing, null, { timeout: 180000 });
    const seconds = (Date.now() - t0) / 1000;
    const settings = (await layoutOf(page)).settings;
    eq([settings.duration, settings.warmup], [86400, 0], '"Run one day" sets the run length of the plant to 24 h and the warm-up to 0');
    defect('UX-25', /run length|warm-up|experiment length/i.test(dayToast), 'low',
      '"Run one day" (and "Run one week": 168 h) silently changes the plant\'s run length and warm-up for every later run, Compare and sweep (the next comparison runs 24 h or 168 h per repetition); the toast says only "Results cover the whole span"');
    console.log(`   one day took ${seconds.toFixed(1)} s of wall time (load average ${loadavg()[0].toFixed(1)}); the copy says "roughly ${lower} to ...  seconds"`);
    defect('UX-10', lower > 0 && lower <= 2.5 * seconds, 'low',
      `"Run one day" says "roughly 10 to 40 seconds" and the week asks for confirmation ("roughly 1 to 5 minutes"); measured here: ${seconds.toFixed(1)} s for the day (machine dependent: re-measure); one week took 10.9 s when tried by hand on the same plant`);
    await setTab(page, 'results');
    await frames(page, 4);
    ok(/24 h measured/.test(await page.locator('#panel-results').innerText()), 'Results say that a whole day was measured');
    await snap(page, 'day-03-results');
    await context.close();
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  // the canvas: door slots and the gate chip at every zoom
  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  await run('canvas', async () => {
    for (const theme of ['light', 'dark']) {
      const { page, context } = await openExample('warehouse-first-day', { colorScheme: theme });
      await page.evaluate(async () => { const M = await import('/js/model/layout.js'); window.__logiplan.store.commit('1 door', (l) => { M.updateStation(l, 's1', { ops: { trucks: { doors: 1 } } }); }); });
      await step(page, 13000);
      const gate = await page.evaluate(() => { const rt = window.__logiplan.runner.sim.logistics.stationById.get('s1'); return rt.trucks.gate.length; });
      ok(gate >= 3, `${theme}: one door and a truck every 17 minutes build a gate queue (${gate} trucks)`);
      await page.evaluate(() => { window.__texts = []; const o = CanvasRenderingContext2D.prototype.fillText; CanvasRenderingContext2D.prototype.fillText = function (t, ...a) { window.__texts.push(String(t)); return o.call(this, t, ...a); }; });
      const truckTexts = async (zoom) => {
        await zoomOn(page, 's1', zoom);
        await frames(page, 2);
        await page.evaluate(() => { window.__texts.length = 0; });
        await frames(page, 4);
        return page.evaluate(() => [...new Set(window.__texts.filter((t) => /^Gate \d|^\d+, \d|^\d+ doors?$/.test(t)))]);
      };
      const near = await truckTexts(12); // 24 px cells
      ok(near.some((t) => /^Gate \d+ trucks?, /.test(t)), `${theme}: at 24 px per cell the chip reads "Gate 4 trucks, 77 min": ${JSON.stringify(near)}`);
      await snap(page, `canvas-${theme}-z12`, { clip: { x: 60, y: 60, width: 1000, height: 780 } });
      const far = await truckTexts(6); // 12 px cells
      await snap(page, `canvas-${theme}-z6`, { clip: { x: 60, y: 60, width: 1000, height: 780 } });
      if (theme === 'light') {
        defect('UX-3', far.some((t) => /^Gate \d|^\d+, \d|^\d+ doors?$/.test(t)), 'medium',
          `at 12 px per cell (the fit zoom of a plant wider than about 70 cells, or a laptop window below 1100 px) the brick of a Goods in with a gate queue of 4 trucks and 77 minutes shows neither slots, nor the count of doors, nor the gate chip: ${JSON.stringify(far)} (design 7.2: the chip is drawn at all zoom levels except the flat swatch)`);
      }
      // flicker: sweep the zoom in 40 steps and check nothing throws
      for (let z = 3; z <= 40; z += 1) { await zoomOn(page, 's1', z); await frames(page, 1); }
      await context.close();
    }
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  // hostile: fields, names, 20 stations, 32 doors, removal under an open dialog, variants while running
  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  await run('hostile', async () => {
    {
      const { page, context } = await openExample('warehouse-first-day');
      await showTrucks(page, 's1');
      const root = page.locator('[data-role=trucks-on]');
      const range = { doors: [1, 32], checkIn: [0, 7200], checkOut: [0, 7200], mean: [60, 1e6], pal: [1, 200] };
      const typeInto = async (loc, text) => {
        await loc.scrollIntoViewIfNeeded();
        await loc.click(); await page.keyboard.press('Control+a'); await page.keyboard.press('Delete'); await page.keyboard.type(text); await frames(page, 2);
        const err = await loc.evaluate((el) => (el.closest('.field')?.querySelector('.field__error')?.textContent) || '');
        await page.keyboard.press('Tab'); await frames(page, 2);
        return err;
      };
      const fields = {
        doors: () => root.locator('[data-role=doors]'), checkIn: () => root.getByLabel('Check-in', { exact: true }), checkOut: () => root.getByLabel('Check-out', { exact: true }),
        mean: () => root.getByLabel('Average').first(), pal: () => root.getByLabel('Average').nth(1),
      };
      const stored = async () => { const t = await trucksOf(page, 's1'); return { doors: t.doors, checkIn: t.checkIn, checkOut: t.checkOut, mean: t.interArrival.mean, pal: t.pallets.mean }; };
      for (const text of ['', '-5', '0', '1e9', '1e3', '2.5', '99999', '0.0001', '33', 'e', '--', '.', '7']) {
        for (const [key, get] of Object.entries(fields)) {
          await typeInto(get(), text);
          const v = (await stored())[key];
          ok(Number.isFinite(v) && v >= range[key][0] && v <= range[key][1], `typing ${JSON.stringify(text)} into ${key} never stores ${v}`);
        }
      }
      // the messages and the silent cases
      const bigGap = await typeInto(fields.mean(), '99999999');
      defect('UX-11', !/\d{3,}\.\d{3,}/.test(bigGap), 'low', `the error of "Time between trucks" is "${bigGap}": the conversion artefact of seconds to minutes is shown to the planner`);
      await typeInto(fields.doors(), '2');
      const doorsErr = await typeInto(fields.doors(), '33');
      const doors33 = (await stored()).doors;
      defect('UX-12a', doorsErr !== '' || doors33 === 32, 'low', `typing 33 into Doors shows no message and ends at ${doors33} (the first digit was committed, the second rejected silently)`);
      await typeInto(fields.checkIn(), '5');
      await typeInto(fields.checkIn(), '2,5');
      const checkIn = (await stored()).checkIn;
      defect('UX-12b', checkIn !== 1500, 'low', `a German planner types "2,5" minutes of check-in in an English-locale browser and gets ${checkIn / 60} minutes (the comma is dropped by the number input; no message)`);
      await snap(page, 'hostile-fields');
      await context.close();
    }

    // names: markup, quotes and one very long word, in the toast, the dialog, the Doors card and Checks
    {
      const { page, context } = await openExample('starter', { viewport: { width: 390, height: 800 } });
      const evil = `<img src=x onerror="window.__xss=1">&amp;"' ${'W'.repeat(120)} end`;
      await page.evaluate(async (name) => { const M = await import('/js/model/layout.js'); window.__logiplan.store.commit('rename', (l) => { M.updateStation(l, l.stations.find((s) => s.type === 'source').id, { name }); }); }, evil);
      await showTrucks(page, 'source');
      await page.locator('[data-role=add-doors]').click();
      await frames(page, 4);
      await page.locator('[data-role=mode] button').nth(1).click();
      const seen = await pasteSees(page, '06:00;24');
      await seen.dlg.getByRole('button', { name: /^Use / }).click();
      await setTab(page, 'checks');
      await page.waitForTimeout(500);
      await step(page, 3600);
      await setTab(page, 'results');
      await frames(page, 4);
      eq(await page.evaluate(() => window.__xss), undefined, 'a station called <img onerror=...> stays text everywhere');
      ok((await overflow(page)) <= 0, 'a 120-letter station name does not widen the page at 390 px');
      const toastWide = await page.evaluate(() => [...document.querySelectorAll('[data-region=toasts] > *')].some((t) => t.scrollWidth > t.clientWidth + 1));
      await snap(page, 'hostile-long-name');
      defect('UX-20', !toastWide, 'low', 'the toast of "Add dock doors" lets a long station name run out of the toast at 390 px (no wrapping of long words)');
      await context.close();
    }

    // double clicks, a station removed under its open card and under the open paste dialog, variants switched while running
    {
      const { page, context } = await openExample('warehouse-first-day');
      await showTrucks(page, 's1');
      await page.getByRole('button', { name: 'Increase Doors' }).dblclick();
      eq((await trucksOf(page, 's1')).doors, 5, 'a double click on + is two steps');
      await page.locator('[data-role=mode] button', { hasText: 'Use a timetable' }).dblclick();
      eq((await trucksOf(page, 's1')).mode, 'schedule', 'a double click on the switch changes it once');
      await page.locator('[data-role=remove-trucks]').dblclick();
      await frames(page, 3);
      eq(await trucksOf(page, 's1'), undefined, 'a double click on "Remove trucks" removes once');
      await page.evaluate(() => { for (let i = 0; i < 3; i++) window.__logiplan.store.undo(); });
      await frames(page, 3);
      await showTrucks(page, 's1');
      await page.locator('[data-role=mode] button', { hasText: 'Use a timetable' }).click();
      await frames(page, 3);
      const seen = await pasteSees(page, '08:00\t10\n09:00\t12');
      await page.evaluate(async () => { const M = await import('/js/model/layout.js'); window.__logiplan.store.commit('remove', (l) => { M.removeStation(l, 's1'); }); });
      await frames(page, 4);
      await seen.dlg.getByRole('button', { name: /^Use / }).click();
      await frames(page, 3);
      ok((await toasts(page)).some((t) => /no trucks any more|no longer/.test(t)) || (await page.locator('[role=dialog]').count()) === 0, 'Use rows after the station was removed answers instead of throwing');
      if (await page.locator('[role=dialog]').count()) await page.keyboard.press('Escape');
      await setTab(page, 'results');
      await frames(page, 3);
      await context.close();
    }
    {
      const { page, context } = await openExample('warehouse-first-day');
      await page.getByRole('button', { name: 'Add a variant: a copy of the current one' }).click();
      await frames(page, 4);
      await showTrucks(page, 's1');
      await page.locator('[data-role=remove-trucks]').click();
      await setTab(page, 'results');
      await page.locator('.simbar').getByRole('button', { name: 'Run simulation' }).click();
      await page.evaluate(() => window.__logiplan.runner.setSpeed(600));
      for (let i = 0; i < 8; i++) {
        await page.getByRole('tab', { name: i % 2 ? /^B/ : /^A/ }).first().click();
        await page.waitForTimeout(300);
      }
      ok(await page.evaluate(() => window.__logiplan.runner.playing), 'switching variants eight times while running leaves it running');
      await context.close();
    }

    // 32 doors, and 20 truck stations at 600x
    {
      const { page, context } = await openExample('warehouse-first-day');
      await page.evaluate(async () => { const M = await import('/js/model/layout.js'); window.__logiplan.store.commit('32', (l) => { M.updateStation(l, 's1', { ops: { trucks: { doors: 32, interArrival: { kind: 'const', mean: 300, spread: 0 } } } }); }); });
      await showTrucks(page, 's1');
      await step(page, 5400);
      for (const z of [6, 12, 24, 40]) { await zoomOn(page, 's1', z); await frames(page, 3); }
      await snap(page, 'hostile-32-doors');
      ok(/Doors now: .*\./.test(await page.locator('[data-role=doors-now]').innerText()), 'the text twin of 32 doors');
      await context.close();
    }
    {
      const { page, context } = await openEmpty();
      await page.evaluate(async () => {
        const Lm = await import('/js/model/layout.js');
        const { convertToDoors: conv } = await import('/js/model/doors.js');
        const l = Lm.createLayout({ name: 'Big', cols: 110, rows: 60, cellSize: 2 });
        Lm.paintRoadPath(l, [[2, 10], [107, 10]]); Lm.paintRoadPath(l, [[2, 50], [107, 50]]); Lm.paintRoadPath(l, [[2, 10], [2, 50]]); Lm.paintRoadPath(l, [[107, 10], [107, 50]]);
        const st = [];
        for (let i = 0; i < 4; i++) st.push(Lm.addStation(l, { type: 'storage', name: `Storage ${i + 1}`, x: 8 + i * 22, y: 11, w: 12, h: 6, params: { capacity: 2000 } }));
        const park = Lm.addStation(l, { type: 'depot', name: 'Parking', x: 3, y: 30, w: 3, h: 2, params: { slots: 30 } });
        Lm.paintRoadPath(l, [[2, 30], [2, 31]]);
        const outs = [];
        for (let i = 0; i < 10; i++) {
          const s = Lm.addStation(l, { type: 'source', name: `Goods in ${i + 1}`, x: 6 + i * 10, y: 8, w: 5, h: 2, params: { interArrival: { kind: 'const', mean: 600, spread: 0 } } });
          Lm.updateStation(l, s.id, { ops: { trucks: { ...conv(Lm.getStation(l, s.id)), doors: 3 } } });
          Lm.addFlow(l, s.id, st[i % 4].id);
          const o = Lm.addStation(l, { type: 'sink', name: `Goods out ${i + 1}`, x: 6 + i * 10, y: 51, w: 5, h: 2 });
          Lm.updateStation(l, o.id, { ops: { trucks: { ...conv(Lm.getStation(l, o.id)), doors: 2 } } });
          outs.push(o);
        }
        st.forEach((s, i) => { for (let j = i; j < outs.length; j += 4) Lm.addFlow(l, s.id, outs[j].id); });
        Lm.addFleet(l, 'forklift', { count: 16, home: park.id });
        l.settings.warmup = 0;
        window.__logiplan.store.replaceLayout(l, { label: 'Big plant' });
      });
      eq((await layoutOf(page)).stations.filter((s) => s.ops && s.ops.trucks).length, 20, '20 truck stations');
      await page.evaluate(() => document.querySelector('[aria-label="Fit the whole plant into view"]')?.click());
      await setTab(page, 'results');
      await page.locator('.simbar').getByRole('button', { name: 'Run simulation' }).click();
      await page.evaluate(() => window.__logiplan.runner.setSpeed(600));
      await page.waitForFunction(() => window.__logiplan.runner.time > 3000, null, { timeout: 120000 });
      const perf = await page.evaluate(() => new Promise((resolve) => {
        const ts = []; let last = performance.now(); const t0 = last; const r = window.__logiplan.runner; const s0 = r.time;
        const tick = (now) => { ts.push(now - last); last = now; if (now - t0 < 5000) requestAnimationFrame(tick); else resolve({ frames: ts.length, mean: ts.reduce((a, b) => a + b, 0) / ts.length, p95: ts.slice().sort((a, b) => a - b)[Math.floor(ts.length * 0.95)], max: Math.max(...ts), speed: (r.time - s0) / 5 }); };
        requestAnimationFrame(tick);
      }));
      console.log(`   20 truck stations at 600x: frame mean ${perf.mean.toFixed(1)} ms, p95 ${perf.p95.toFixed(1)} ms, max ${perf.max.toFixed(1)} ms, speed ${perf.speed.toFixed(0)}x (load average ${loadavg()[0].toFixed(1)})`);
      ok(perf.mean < 45 && perf.speed > 400, 'a plant with 20 truck stations keeps 600x at a usable frame time');
      const cards = await page.locator('[data-door-station]').count();
      eq(cards, 20, 'one Doors card per truck station');
      const checksNow = await (async () => { await setTab(page, 'checks'); await page.waitForTimeout(600); return page.locator('[data-panel=checks]').innerText(); })();
      await snap(page, 'hostile-20-stations');
      ok(/Show \d+ more similar warnings/.test(checksNow), 'Checks groups the 20 row-of-docks warnings of a 20-station plant ("Show 17 more similar warnings")');
      await context.close();
    }
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  // accessibility and layout: names, focus, targets, contrast in both themes, reduced motion, 360 px
  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  await run('a11y', async () => {
    const contrast = (page, sel) => page.evaluate((root) => {
      const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return [0, 0, 0, 1]; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p[3] === undefined ? 1 : p[3]]; };
      const over = (t, b) => { const a = t[3]; return [t[0] * a + b[0] * (1 - a), t[1] * a + b[1] * (1 - a), t[2] * a + b[2] * (1 - a), 1]; };
      const bgOf = (el) => { const chain = []; for (let e = el; e; e = e.parentElement) chain.push(parse(getComputedStyle(e).backgroundColor)); let bg = [255, 255, 255, 1]; for (let i = chain.length - 1; i >= 0; i--) bg = over(chain[i], bg); return bg; };
      const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
      const ratio = (a, b) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);
      const out = [];
      const walker = document.createTreeWalker(document.querySelector(root) || document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n.textContent.trim(); if (!t) continue;
        const el = n.parentElement; const r = el.getBoundingClientRect(); if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
        let op = 1; for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
        const bg = bgOf(el); const fg = parse(getComputedStyle(el).color); const fgc = over([fg[0], fg[1], fg[2], fg[3] * op], bg);
        const size = parseFloat(getComputedStyle(el).fontSize); const bold = Number(getComputedStyle(el).fontWeight) >= 700;
        const rt = ratio(fgc, bg);
        if (rt < ((size >= 24 || (size >= 18.66 && bold)) ? 3 : 4.5)) out.push(`${t.slice(0, 30)} (${rt.toFixed(2)}:1, ${size}px)`);
      }
      return out;
    }, sel);

    for (const theme of ['light', 'dark']) {
      const { page, context } = await openExample('warehouse-first-day', { colorScheme: theme, reducedMotion: theme === 'dark' ? 'reduce' : 'no-preference' });
      // one door and a timetable of two rows: the door check is in its warning state
      await page.evaluate(async () => { const M = await import('/js/model/layout.js'); window.__logiplan.store.commit('1 door', (l) => { M.updateStation(l, 's1', { ops: { trucks: { doors: 1 } } }); }); });
      await showTrucks(page, 's1');
      await page.locator('[data-role=mode] button', { hasText: 'Use a timetable' }).click();
      await page.locator('[data-role=add-row]').click();
      await page.locator('[data-role=add-row]').click();
      await page.locator('[data-role=mode] button', { hasText: 'Generate from rate' }).click();
      await frames(page, 4);
      ok(await page.locator('[data-role=door-check].is-warn').count() === 1, `${theme}: the door check is in its warning state (1 door for 3.5 trucks an hour)`);
      const low = await contrast(page, '[data-role=trucks-section]');
      if (theme === 'light') eq(low, [], 'light: every text of the Trucks section reaches its contrast');
      else defect('UX-19', low.length === 0, 'low', `dark: text below 4.5:1 in the Trucks section: ${low.join('; ')}`);

      // names
      const names = await page.evaluate(() => {
        const root = document.querySelector('[data-role=trucks-section]');
        const nameOf = (el) => (el.getAttribute('aria-labelledby') ? el.getAttribute('aria-labelledby').split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ') : el.getAttribute('aria-label') || (el.labels && el.labels.length ? [...el.labels].map((l) => l.textContent).join(' ') : '') || el.title || el.textContent || '').trim();
        return [...root.querySelectorAll('button, input, select, textarea, summary')].filter((e) => e.getClientRects().length).map((e) => ({ name: nameOf(e), role: e.getAttribute('data-role') || '', h: Math.round(e.getBoundingClientRect().height), group: !!e.closest('[role=group], fieldset') }));
      });
      ok(names.length > 15 && names.every((n) => n.name !== ''), `${theme}: every control in the section has an accessible name (${names.length} controls)`);
      if (theme === 'light') {
        const dup = names.filter((n, i) => names.findIndex((m) => m.name === n.name) !== i);
        defect('UX-13', dup.every((n) => n.group), 'low', `the section has ${[...new Set(dup.map((n) => n.name))].join(', ')} twice (time between trucks, pallets per truck) and the fields are not in a labelled group: a screen reader hears "Average" without saying of what`);
        const small = names.filter((n) => n.h < 24);
        defect('UX-18', small.length === 0, 'low', `controls of the section below 24 px high (WCAG 2.5.8): ${small.map((n) => `${n.name.slice(0, 30)} ${n.h}px`).join('; ')}`);
        const hour12 = await page.evaluate(() => new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12);
        await page.locator('[data-role=mode] button', { hasText: 'Use a timetable' }).click();
        await frames(page, 3);
        defect('UX-14', !(hour12 && (await page.locator('[data-role=timetable] input[type=time]').count()) > 0), 'low',
          'the timetable and the clock use native time inputs, so an English browser shows "06:00 AM" and "12:00 AM" while the simulation bar says "Mon 00:00" and the paste dialog accepts only 24-hour times');
      }
      // focus visible on every stop of a keyboard walk through the section
      await page.locator('[data-role=doors]').focus();
      let hidden = 0;
      for (let i = 0; i < 28; i++) {
        const visible = await page.evaluate(() => {
          const a = document.activeElement; if (!a || !a.closest('[data-role=trucks-section]')) return null;
          const cs = getComputedStyle(a); const g = a.closest('.input-group, .stepper, .field, .trucks-row');
          const ring = (s) => (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none';
          return ring(cs) || (g && ring(getComputedStyle(g))) || a.type === 'time';
        });
        if (visible === false) hidden++;
        await page.keyboard.press('Tab');
      }
      eq(hidden, 0, `${theme}: every stop of the keyboard walk shows a focus ring`);
      // reduced motion: nothing in the section animates
      if (theme === 'dark') {
        const running = await page.evaluate(() => document.querySelector('[data-role=trucks-section]').getAnimations({ subtree: true }).length);
        eq(running, 0, 'prefers-reduced-motion: no animation runs in the Trucks section');
      }
      await context.close();
    }

    // the paste dialog: keyboard, focus trap, focus back
    {
      const { page, context } = await openExample('warehouse-first-day');
      await showTrucks(page, 's1');
      await page.locator('[data-role=mode] button', { hasText: 'Use a timetable' }).click();
      await page.locator('[data-role=paste]').focus();
      await page.keyboard.press('Enter');
      const dlg = page.locator('[role=dialog]');
      await dlg.waitFor();
      eq(await page.evaluate(() => document.activeElement.id), 'paste-text', 'the dialog opens with the cursor in the text box');
      eq(await dlg.getAttribute('aria-modal'), 'true', 'it is modal');
      await dlg.locator('[data-role=paste-text]').fill('06:00\t24');
      const seen = [];
      for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); seen.push(await page.evaluate(() => !!document.activeElement.closest('[role=dialog]'))); }
      ok(seen.every(Boolean), 'Tab never leaves the dialog');
      await page.keyboard.press('Escape');
      await dlg.waitFor({ state: 'detached' });
      eq(await page.evaluate(() => document.activeElement.getAttribute('data-role')), 'paste', 'Escape returns the focus to "Paste from spreadsheet"');
      eq(await hoursOf(page), [], 'and applies nothing');
      await page.locator('[data-role=paste]').focus();
      await page.keyboard.press('Space');
      await dlg.waitFor();
      await dlg.locator('[data-role=paste-text]').fill('06:00\t24');
      await dlg.getByRole('button', { name: 'Use 1 row' }).focus();
      await page.keyboard.press('Space');
      await dlg.waitFor({ state: 'detached' });
      eq(await hoursOf(page), [6], 'Space on "Use 1 row" applies it');
      await context.close();
    }

    // 360 px: nothing sticks out, in both themes
    for (const theme of ['light', 'dark']) {
      const { page, context } = await openExample('warehouse-first-day', { viewport: NARROW, colorScheme: theme });
      await showTrucks(page, 's1');
      await page.locator('[data-role=trucks-on]').scrollIntoViewIfNeeded();
      await snap(page, `narrow-${theme}-trucks`);
      ok((await overflow(page)) <= 0, `${theme}: Properties at 360 px does not scroll sideways`);
      await page.locator('[data-role=mode] button', { hasText: 'Use a timetable' }).click();
      const seen = await pasteSees(page, 'Ankunft;Paletten\n06:00;24\n7:30 Uhr;18\n25:70;4\n6:00 AM;20');
      await snap(page, `narrow-${theme}-paste`);
      ok((await overflow(page)) <= 0, `${theme}: the paste dialog at 360 px does not scroll sideways`);
      await seen.dlg.getByRole('button', { name: /^Use / }).click();
      await step(page, 6 * 3600);
      await setTab(page, 'results');
      await frames(page, 4);
      await page.locator('details[data-section=doors]').scrollIntoViewIfNeeded();
      await snap(page, `narrow-${theme}-doors`);
      ok((await overflow(page)) <= 0, `${theme}: the Doors card at 360 px does not scroll sideways`);
      await context.close();
    }
    // 4K
    {
      const { page, context } = await openExample('warehouse-first-day', { viewport: { width: 3840, height: 2160 } });
      await showTrucks(page, 's1');
      await step(page, 3 * 3600);
      await setTab(page, 'results');
      await frames(page, 4);
      await snap(page, 'wide-4k-results');
      ok((await overflow(page)) <= 0, '4K: no horizontal scroll');
      await context.close();
    }
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  // keyboard: the keys of the editor while the focus is in the panel
  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  await run('keyboard', async () => {
    const { page, context } = await openExample('warehouse-first-day');
    await showTrucks(page, 's1');
    await page.locator('[data-role=mode] button', { hasText: 'Use a timetable' }).click();
    for (let i = 0; i < 2; i++) { await page.locator('[data-role=add-row]').click(); await frames(page, 2); }
    const names = async () => (await layoutOf(page)).stations.map((s) => s.name);
    const all = await names();
    // keys inside the fields stay in the fields
    for (const sel of ['[data-row="0"] input[type=time]', '[data-row="0"] input[type=number]', '[data-role=doors]']) {
      await page.locator(sel).focus();
      for (const key of ['Delete', 'Backspace', 'Space', 'r', '1', 'p']) await page.keyboard.press(key);
    }
    eq(await names(), all, 'Delete, Backspace, Space and the tool keys typed into the timetable and the doors field change nothing on the plan');
    eq(await page.evaluate(() => window.__logiplan.runner.playing), false, 'and Space does not start the simulation');
    // a keyboard planner tabs to "Delete row 1: 06:00" and presses Delete
    await page.locator('[data-row="0"] [data-role=delete-row]').focus();
    await page.keyboard.press('Delete');
    await frames(page, 3);
    const after = await names();
    const toastText = (await toasts(page)).join(' | ');
    if (after.length < all.length) await page.evaluate(() => window.__logiplan.store.undo());
    defect('UX-26', after.length === all.length, 'high',
      `Delete pressed while the focus is on the "Delete row 1: 06:00" button of the timetable deletes the whole station and its flow instead of the row (toast: "${toastText.slice(-40)}"): the global Delete shortcut ignores buttons (isTypingTarget knows only input, textarea, select); Undo restores it`);
    await context.close();
  });

  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  // Compare (3 and 5 doors) and a sweep over doors
  // ---------------------------------------------------------------------------------------------------------------------------------------------------
  await run('compare', async () => {
    const { page, context } = await openExample('warehouse-first-day');
    await page.getByRole('button', { name: 'Add a variant: a copy of the current one' }).click();
    await frames(page, 4);
    await showTrucks(page, 's1');
    await page.getByRole('button', { name: 'Increase Doors' }).dblclick();
    eq((await trucksOf(page, 's1')).doors, 5, 'variant B has 5 doors');
    await setTab(page, 'experiments');
    await frames(page, 3);
    const panel = page.locator('#panel-experiments');
    await panel.getByLabel('Run length', { exact: true }).fill('2');
    await panel.getByLabel('Repetitions', { exact: true }).fill('1');
    await panel.getByRole('button', { name: 'Run comparison' }).click();
    await page.waitForFunction(() => /Comparison finished/.test(document.querySelector('#panel-experiments')?.innerText || ''), null, { timeout: 180000 });
    const text = await panel.innerText();
    ok(/Truck wait at the gate \(mean\)\s*\n\s*(s|min|h)\n/.test(text), 'Compare shows the gate wait with a unit that fits its size (seconds for a short wait, minutes for a long one)');
    ok(!/NaN|undefined|Infinity/.test(text), 'no NaN in the comparison');
    await snap(page, 'compare-01-variants');
    await panel.getByRole('button', { name: 'Parameter sweep' }).click();
    await frames(page, 3);
    const selects = panel.locator('select');
    const settingLabel = await selects.first().evaluate((s) => [...s.options].find((o) => o.value === 'doors:s1')?.textContent);
    eq(settingLabel, 'Goods in: number of doors', 'the sweep lists the doors of Goods in by name');
    await selects.first().selectOption('doors:s1');
    await selects.nth(1).selectOption('gateWaitMean');
    await panel.getByLabel('Run length', { exact: true }).fill('2');
    await panel.getByLabel('Repetitions', { exact: true }).fill('1');
    await panel.getByRole('button', { name: 'Run sweep' }).click();
    await page.waitForFunction(() => /Sweep finished/.test(document.querySelector('#panel-experiments')?.innerText || ''), null, { timeout: 180000 });
    const sweep = await panel.innerText();
    const unitInTable = /Truck wait at the gate \(mean\) \((s|min|h)\)/.exec(sweep)?.[1];
    ok(unitInTable, 'the sweep table names the unit of the gate wait');
    ok(!/NaN|undefined|Infinity/.test(sweep), 'no NaN in the sweep');
    await snap(page, 'compare-02-sweep');
    await context.close();
  });

  const open = findings.filter((d) => d.open);
  const bySeverity = (s) => open.filter((d) => d.severity === s).map((d) => d.id).join(', ');
  console.log(`\n${checks} guard checks passed; ${open.length} of ${findings.length} findings OPEN`);
  for (const s of ['high', 'medium', 'low']) if (bySeverity(s)) console.log(`   ${s}: ${bySeverity(s)}`);
  if (open.length) process.exitCode = 1;
}, { viewport: DESKTOP });
