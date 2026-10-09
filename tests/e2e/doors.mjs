// Trucks and dock doors (milestone M1, UI) in the REAL app (index.html + js/main.js) in real Chromium: what a planner sees and does.
//
//   inspector  Trucks and doors in the Properties tab: "Add dock doors" (one undo step, the toast with the numbers), doors stepper, check-in in minutes, the
//              switch to a timetable (which creates the clock), the timetable table (add, edit, delete a row, keyboard), the live door check with "Use N doors"
//   paste      Paste from spreadsheet: German Excel text (semicolon, decimal comma, 06.00, 6:30 Uhr) is previewed, bad rows are marked in place, NOTHING is
//              applied until "Use N rows", Cancel and Escape change nothing, one undo takes the rows back
//   clock      Plant settings: the clock, "Run one day", the time of day in the simulation bar
//   restart    an edit of a day plant restarts the simulation at its clock (time 0) and the impact card is not shown; a stationary truck plant restarts warm
//   canvas     door slots along the lower edge of the brick (states by glyph and colour, gate chip amber from 15 min and red from 45), the plan still hit-tests,
//              far zoom does not break, the dock share bars follow the Docks overlay
//   results    the Doors card per station with trucks (hidden without), numbers after a run, a report without `ops` shows a note and no NaN
//   checks     the warnings of the four checks with their Fix buttons: Use N doors, Show docks (one button, not two), Add a row
//   help       the page "Trucks and dock doors"
//   share      the doors survive the share link and the project file
//   layout     light and dark, 1440 px and 390 px: nothing sticks out of the panel, screenshots in e2e-output/doors-*.png (open them and look)
//
// What this script can NOT prove without the numbers of a long live run (the integrator extends it): the figures of the Doors card against a hand-computed plant, the
// look of the canvas while the gate really queues for an hour. It runs against the simulation that is in the tree, so it checks that numbers appear and are finite.
//
// Run: node tests/e2e/doors.mjs [section]
import assert from 'node:assert/strict';
import path from 'node:path';
import { withBrowser, OUT } from './browser.mjs';
import * as L from '../../js/model/layout.js';
import { EXAMPLES } from '../../js/model/examples.js';
import { convertToDoors } from '../../js/model/doors.js';
import { defaultTrucks } from '../../js/model/ops.js';

const only = process.argv[2] || '';
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

const NARROW = { width: 390, height: 800 };

/** The Starter example as it is. */
const starter = () => EXAMPLES.find((e) => e.id === 'starter').build();

/** A small plant on a through road: a Goods in whose three docks lie in a row, a Goods out, three forklifts. Optionally with trucks. */
function rowPlant({ trucks = null, outTrucks = false, docks = 3 } = {}) {
  const layout = L.createLayout({ name: 'Dock doors', cols: 36, rows: 18, cellSize: 2 });
  L.paintRoadPath(layout, [[3, 12], [32, 12]]);
  const src = L.addStation(layout, { type: 'source', name: 'Goods receiving', x: 8, y: 9, w: docks, h: 3, params: { interArrival: { kind: 'const', mean: 180, spread: 0 } } });
  const sink = L.addStation(layout, { type: 'sink', name: 'Dispatch', x: 22, y: 9, w: 3, h: 3 });
  L.addFlow(layout, src.id, sink.id);
  const park = L.addStation(layout, { type: 'depot', name: 'Parking', x: 3, y: 14, w: 3, h: 2, params: { slots: 4 } });
  L.paintRoadPath(layout, [[4, 12], [4, 13]]);
  L.addFleet(layout, 'forklift', { count: 3, home: park.id });
  if (trucks) L.updateStation(layout, src.id, { ops: { trucks } });
  if (outTrucks) L.updateStation(layout, sink.id, { ops: { trucks: convertToDoors(L.getStation(layout, sink.id)) } });
  layout.settings.warmup = 0;
  return { layout, src, sink };
}

/** The numbers of Appendix A: 6 trucks an hour of 26 pallets, 4 doors. */
const BUSY = { ...defaultTrucks(), doors: 4, interArrival: { kind: 'const', mean: 600, spread: 0 }, pallets: { kind: 'const', mean: 26, spread: 0 } };

await withBrowser(async ({ browser, url, errors }) => {
  const origin = new URL(url('/')).origin;
  const foreign = [];
  const frames = (page, n = 2) => page.evaluate((count) => new Promise((resolve) => {
    const next = (left) => (left ? requestAnimationFrame(() => next(left - 1)) : resolve());
    next(count);
  }), n);
  const noErrors = (what) => { eq(errors.splice(0).filter((e) => !/willReadFrequently/.test(e)), [], `${what}: console errors or warnings`); };
  const shot = (page, name) => page.screenshot({ path: path.join(OUT, `doors-${name}.png`) });

  async function open({ layout, theme = 'light', viewport = { width: 1440, height: 900 }, select = null, tab = 'properties' }) {
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
    await page.evaluate(([l, ids]) => {
      const { store, ctx } = window.__logiplan;
      store.replaceLayout(l, { label: 'Load plant' });
      if (ids) store.select('station', ids);
      ctx.actions.setRightTab('properties');
    }, [layout, select]);
    if (viewport.width < 900) {
      const toggle = page.locator('.topbar__panel-toggle');
      if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
      await page.waitForTimeout(450); // the drawer slides in
    }
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

  const layoutOf = (page) => page.evaluate(() => window.__logiplan.store.getState().layout);
  const stationOf = async (page, type) => (await layoutOf(page)).stations.find((s) => s.type === type);
  const state = (page) => page.evaluate(() => { const s = window.__logiplan.store.getState(); return { label: s.lastCommit.label, canUndo: s.canUndo, selection: s.ui.selection }; });
  const step = (page, seconds) => page.evaluate(async (s) => { await window.__logiplan.runner.step(s); }, seconds);
  /** The runner refreshes its report a few times a second, not on every step: wait until it covers everything that has been simulated. */
  const fresh = (page) => page.waitForFunction(() => { const r = window.__logiplan.runner; const k = r.kpis(); return k && k.window.end >= r.time - 1; }, null, { timeout: 30000 });
  const toasts = (page) => page.evaluate(() => [...document.querySelectorAll('[data-region=toasts] > *')].map((t) => t.textContent));
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const insidePanel = (page, selector) => page.evaluate((sel) => {
    const side = document.querySelector('.side').getBoundingClientRect();
    const bad = [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > side.right + 1 || r.left < side.left - 1); });
    return bad.map((e) => `${e.tagName}.${String(e.className).slice(0, 30)}`);
  }, selector);
  const panel = (page) => page.locator('#panel-properties');

  // ---- the section in the inspector -----------------------------------------------------------------------------------

  await run('inspector', async () => {
    const { context, page } = await open({ layout: starter(), select: null });
    const src = await stationOf(page, 'source');
    await page.evaluate((id) => window.__logiplan.store.select('station', [id]), src.id);
    await frames(page, 3);
    const off = page.locator('[data-role=trucks-off]');
    await off.waitFor({ state: 'visible' });
    ok(!(await page.locator('[data-role=trucks-on]').isVisible()), 'without trucks: only the quiet block with one button');
    eq(await off.locator('button').first().innerText(), 'Add dock doors');
    ok(!(await page.locator('[data-role=legacy-arrivals]').first().isHidden()), 'the legacy arrival fields are there');

    // keyboard: focus the button, press Enter
    await page.locator('[data-role=add-doors]').focus();
    await page.keyboard.press('Enter');
    await frames(page, 3);
    const onSection = page.locator('[data-role=trucks-on]');
    ok(await onSection.isVisible(), 'the controls appear');
    ok(await onSection.evaluate((e) => e.open), 'and the section is open');
    const stateAfter = await state(page);
    eq(stateAfter.label, 'Add dock doors', 'one undo step with that label');
    const trucks = (await stationOf(page, 'source')).ops.trucks;
    eq([trucks.doors, trucks.pallets.mean, trucks.interArrival.mean, trucks.checkIn, trucks.mode], [2, 24, 4320, 300, 'rate'], 'one pallet every 180 s becomes 24 pallets every 72 minutes');
    eq((await layoutOf(page)).schema, 2);
    const first = (await toasts(page)).join(' ');
    ok(/Goods receiving now receives trucks: 2 doors, 24 pallets per truck, about one truck every 72 min\. That is the same 20 pallets an hour as before, but they now arrive in bunches\./.test(first), first);
    ok(await page.locator('[data-role=legacy-arrivals]').first().isHidden(), 'the legacy arrival fields are hidden while trucks are on');
    ok((await page.locator('[data-role=trucks-note]').isVisible()), 'and a note says where the arrivals come from');
    ok((await page.locator('[data-role=out-buffer] .field__label').innerText()).startsWith('Staging space (pallets) per destination'), 'the output buffer is relabelled');
    await shot(page, 'inspector-on-light-desktop');

    // undo and redo
    await page.evaluate(() => window.__logiplan.store.undo());
    await frames(page, 3);
    ok(await off.isVisible() && !(await onSection.isVisible()), 'undo: the plant is as before');
    eq((await stationOf(page, 'source')).ops, undefined, 'no `ops` left on the station');
    eq((await layoutOf(page)).schema, 1, 'and the schema is back at 1');
    ok(!(await page.locator('[data-role=legacy-arrivals]').first().isHidden()), 'the legacy fields are back');
    await page.evaluate(() => window.__logiplan.store.redo());
    await frames(page, 3);
    ok(await onSection.isVisible(), 'redo: the doors are back');

    // doors stepper, check-in, the rate
    await page.getByRole('button', { name: 'Increase Doors' }).click();
    await page.getByRole('button', { name: 'Increase Doors' }).click();
    eq((await stationOf(page, 'source')).ops.trucks.doors, 4);
    eq(await onSection.locator('.section__aside').innerText(), '4 doors');
    await page.getByLabel('Check-in', { exact: true }).fill('10');
    eq((await stationOf(page, 'source')).ops.trucks.checkIn, 600, 'minutes are stored as seconds');
    await page.locator('[data-role=trucks-on]').getByLabel('Average').first().fill('60');
    const gap = (await stationOf(page, 'source')).ops.trucks.interArrival;
    eq([gap.kind, gap.mean], ['normal', 3600], 'the average changes, the kind stays');
    await frames(page, 3);
    ok(/About 1 truck an hour of 24 pallets: 24 pallets an hour\./.test(await page.locator('[data-role=rate-summary]').innerText()), 'the rate in words');

    // typing in a field commits as one undo step per burst
    const undoSteps = async () => page.evaluate(() => window.__logiplan.store.getState().canUndo);
    ok(await undoSteps());

    // the door check: 4 doors, 1 truck an hour of 24 pallets: fine; make it hard
    const check = page.locator('[data-role=door-check-text]');
    ok(/doors busy at once/.test(await check.innerText()), await check.innerText());
    ok(await page.locator('[data-role=door-check-formula]').isVisible(), 'the arithmetic is printed');
    ok(await page.locator('[data-role=use-doors]').isHidden(), 'enough doors: no button');
    await page.locator('[data-role=trucks-on]').getByLabel('Average').first().fill('10');
    await frames(page, 3);
    ok(/You have 4 doors, so trucks will queue at the gate\./.test(await check.innerText()), await check.innerText());
    const use = page.locator('[data-role=use-doors]');
    ok(await use.isVisible(), 'a button appears');
    ok(/^Use \d+ doors$/.test(await use.innerText()), await use.innerText());
    const proposed = Number(/\d+/.exec(await use.innerText())[0]);
    await use.click();
    eq((await stationOf(page, 'source')).ops.trucks.doors, proposed, 'it sets the doors');
    eq((await state(page)).label, 'Set dock doors');
    ok(await use.isHidden(), 'and the warning is gone');

    // Remove trucks: back to the legacy fields, nothing was deleted
    await page.locator('[data-role=remove-trucks]').click();
    await frames(page, 3);
    ok(await off.isVisible(), 'removed');
    eq((await stationOf(page, 'source')).ops, undefined);
    eq((await stationOf(page, 'source')).params.interArrival.mean, 180, 'the old arrival interval is still there');
    await context.close();
  });

  // ---- the timetable ----------------------------------------------------------------------------------------------------

  await run('timetable', async () => {
    const { layout, src } = rowPlant({ trucks: defaultTrucks() });
    const { context, page } = await open({ layout, select: [src.id] });
    await page.locator('[data-role=mode] button', { hasText: 'Use a timetable' }).click();
    await frames(page, 3);
    const trucks = () => stationOf(page, 'source').then((s) => s.ops.trucks);
    eq((await trucks()).mode, 'schedule');
    ok(!!(await layoutOf(page)).calendar, 'the first timetable creates the clock');
    ok(await page.locator('[data-role=timetable]').isVisible(), 'the table');
    ok(/No rows yet/.test(await page.locator('[data-role=timetable]').innerText()));
    const t = (await toasts(page)).join(' ');
    ok(/This plant follows a daily timetable\. After an edit the simulation starts again at 00:00 instead of continuing, so the figures always describe a whole day\./.test(t), `the cold restart is explained once: ${t}`);
    ok(await page.locator('[data-role=mode] [aria-pressed=true]').innerText() === 'Use a timetable');

    await page.locator('[data-role=add-row]').click();
    await frames(page, 2);
    eq((await trucks()).schedule, [{ at: 21600, pallets: 24 }], 'the first row: 06:00, an average truck');
    const row = page.locator('[data-row="0"]');
    eq(await row.locator('input[type=time]').inputValue(), '06:00');
    await page.locator('[data-role=add-row]').click();
    eq((await trucks()).schedule.map((r) => r.at), [21600, 25200], 'the next row an hour later');

    // edit the second row's time to before the first: the model sorts, the focus follows the row
    const second = page.locator('[data-row="1"] input[type=time]');
    await second.fill('05:15');
    await second.blur();
    await frames(page, 3);
    eq((await trucks()).schedule.map((r) => r.at), [18900, 21600], 'sorted by time');
    eq(await page.locator('[data-row="0"] input[type=time]').inputValue(), '05:15');
    // an empty number of pallets means: drawn from the distribution
    const pallets = page.locator('[data-row="0"] input[type=number]');
    await pallets.fill('');
    await pallets.blur();
    eq((await trucks()).schedule[0].pallets, null);
    await pallets.fill('300');
    await pallets.blur();
    eq((await trucks()).schedule[0].pallets, null, 'out of range: refused, the value stays');
    eq(await pallets.inputValue(), '');
    await pallets.fill('18');
    await pallets.blur();
    eq((await trucks()).schedule[0].pallets, 18);
    ok(/2 trucks a day, 42 pallets, at most 2 in any hour/.test(await page.locator('[data-role=timetable-summary]').innerText()), await page.locator('[data-role=timetable-summary]').innerText());
    // labels for a screen reader
    eq(await pallets.getAttribute('aria-label'), 'Pallets, row 1 (empty: drawn from the pallets per truck)');
    eq(await page.locator('[data-row="0"] [data-role=delete-row]').getAttribute('aria-label'), 'Delete row 1: 05:15');

    // delete with the keyboard: the focus does not fall to the page
    await page.locator('[data-row="0"] [data-role=delete-row]').focus();
    await page.keyboard.press('Enter');
    await frames(page, 3);
    eq((await trucks()).schedule.map((r) => r.at), [21600]);
    ok(await page.evaluate(() => document.activeElement?.closest('[data-role=timetable]') !== null), 'the focus stays in the table');
    // variation
    await page.getByLabel('Trucks arrive up to', { exact: false }).fill('10');
    eq((await trucks()).jitter, 600);
    await page.getByLabel('No-shows').fill('5');
    eq((await trucks()).noShow, 0.05);
    // one door too few for the timetable? 1 row: no warning; back to rate
    await page.locator('[data-role=mode] button', { hasText: 'Generate from rate' }).click();
    await frames(page, 3);
    eq((await trucks()).mode, 'rate');
    eq((await layoutOf(page)).calendar, undefined, 'the clock goes with the last timetable (it still had its default start)');
    await shot(page, 'timetable-light-desktop');
    await context.close();
  });

  // ---- paste from spreadsheet ----------------------------------------------------------------------------------------------

  await run('paste', async () => {
    const { layout, src } = rowPlant({ trucks: { ...defaultTrucks(), mode: 'schedule', schedule: [{ at: 21600, pallets: 24 }, { at: 25200, pallets: 12 }] } });
    const { context, page } = await open({ layout, select: [src.id] });
    const schedule = async () => (await stationOf(page, 'source')).ops.trucks.schedule;
    const before = await schedule();
    await page.locator('[data-role=paste]').click();
    const dialog = page.locator('[role=dialog]');
    await dialog.waitFor();
    ok(await dialog.getByRole('button', { name: 'Use rows' }).isDisabled(), 'nothing to use yet');
    const text = 'Ankunft;Paletten\n06.00;24,0\n6:30 Uhr;18\n25:70;4\n08:00;\n0900;300\nfoo';
    await dialog.locator('[data-role=paste-text]').fill(text);
    await frames(page, 2);
    const summary = await dialog.locator('[data-role=paste-summary]').innerText();
    eq(summary, '3 rows read, 3 skipped: row 4 “25:70” is not a time (and 2 more). Nothing is applied until you press Use 3 rows.');
    eq(await dialog.locator('[data-kind=good]').count(), 3);
    eq(await dialog.locator('[data-kind=bad]').count(), 3, 'the three bad rows are marked in place');
    eq(await dialog.locator('[data-kind=header]').count(), 1);
    ok((await dialog.locator('[data-kind=bad]').first().innerText()).includes('“25:70” is not a time'));
    eq(await schedule(), before, 'NOTHING is applied while the preview is open');
    ok(/The 2 rows of the timetable now will be replaced\./.test(await dialog.locator('[data-role=paste-replaces]').innerText()));
    await shot(page, 'paste-light-desktop');
    // Cancel changes nothing
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'detached' });
    eq(await schedule(), before, 'Cancel changes nothing');
    ok(await page.evaluate(() => document.activeElement?.dataset.role === 'paste'), 'the focus returns to the button that opened the dialog');
    // so does Escape
    await page.locator('[data-role=paste]').click();
    await dialog.locator('[data-role=paste-text]').fill('07:00;20');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    eq(await schedule(), before, 'Escape changes nothing');
    // use the rows
    await page.locator('[data-role=paste]').click();
    await dialog.locator('[data-role=paste-text]').fill(text);
    await dialog.getByRole('button', { name: 'Use 3 rows' }).click();
    await dialog.waitFor({ state: 'detached' });
    eq(await schedule(), [{ at: 21600, pallets: 24 }, { at: 23400, pallets: 18 }, { at: 28800, pallets: null }], 'the rows read, sorted, replace the timetable');
    eq((await state(page)).label, 'Paste timetable into “Goods receiving”');
    await page.evaluate(() => window.__logiplan.store.undo());
    eq(await schedule(), before, 'one undo takes the pasted rows back');
    // tab separated, as a spreadsheet copies it
    await page.locator('[data-role=paste]').click();
    await dialog.locator('[data-role=paste-text]').fill('6:00\t24\n7:30\t18');
    await dialog.getByRole('button', { name: 'Use 2 rows' }).click();
    eq((await schedule()).length, 2);
    // an unreadable paste cannot be used
    await page.locator('[data-role=paste]').click();
    await dialog.locator('[data-role=paste-text]').fill('hello\nworld');
    ok(await dialog.getByRole('button', { name: 'Use rows' }).isDisabled(), 'no readable row: the button stays disabled');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await context.close();
  });

  // ---- the clock ----------------------------------------------------------------------------------------------------------------

  await run('clock', async () => {
    const { layout } = rowPlant({ trucks: { ...defaultTrucks(), mode: 'schedule', schedule: [{ at: 21600, pallets: 24 }] } });
    const { context, page } = await open({ layout });
    const clock = page.locator('[data-role=clock-section]');
    await clock.waitFor({ state: 'visible' });
    eq(await page.locator('[data-role=clock-time]').inputValue(), '00:00');
    await page.locator('[data-role=clock-time]').fill('06:00');
    await page.locator('[data-role=clock-time]').blur();
    eq((await layoutOf(page)).calendar, { startTod: 21600, startDay: 0 });
    await page.locator('[data-role=clock-day]').selectOption('2');
    eq((await layoutOf(page)).calendar.startDay, 2);
    await frames(page, 3);
    eq(await clock.locator('.section__aside').innerText(), '06:00 Wed');
    // the chip of the simulation bar
    eq(await page.locator('[data-role=day-clock]').innerText(), 'Wed 06:00');
    await step(page, 2580);
    await frames(page, 4);
    eq(await page.locator('[data-role=day-clock]').innerText(), 'Wed 06:42', 'the time of day follows the simulation');
    // Run one day: the whole day from the start of the clock, exactly that span, then it stops
    await page.locator('[data-role=run-day]').click();
    await page.waitForFunction(() => window.__logiplan.runner.sim && window.__logiplan.runner.time >= 86399 && !window.__logiplan.runner.playing, null, { timeout: 120000 });
    const settings = (await layoutOf(page)).settings;
    eq([settings.duration, settings.warmup], [86400, 0]);
    eq((await state(page)).label, 'Run one day');
    const span = await page.evaluate(() => { const r = window.__logiplan.runner; return { time: r.time, playing: r.playing, window: r.kpis().window }; });
    ok(span.time >= 86399 && span.time < 86500, `exactly one day was simulated (${Math.round(span.time)} s)`);
    eq(span.window.start, 0, 'nothing was thrown away as warm-up');
    ok(/^[A-Z][a-z]{2} \d\d:\d\d$/.test(await page.locator('[data-role=day-clock]').innerText()), 'the clock chip shows the time of day');
    // Run one week asks first
    await page.locator('[data-role=run-week]').click();
    const ask = page.locator('[role=dialog]');
    await ask.waitFor();
    ok(/Run one week\?/.test(await ask.innerText()));
    await ask.getByRole('button', { name: 'Cancel' }).click();
    eq((await layoutOf(page)).settings.duration, 86400, 'declined: nothing changed');
    // a plant without a timetable has no clock section and no chip
    await page.evaluate(() => { const { store } = window.__logiplan; const s = store.getState().layout.stations.find((x) => x.type === 'source'); store.select('station', [s.id]); });
    await page.locator('[data-role=mode] button', { hasText: 'Generate from rate' }).click();
    await page.evaluate(() => window.__logiplan.store.clearSelection());
    await frames(page, 3);
    ok(await page.locator('[data-role=day-clock]').isHidden(), 'no time of day without a timetable');
    ok(await page.locator('[data-role=clock-section]').isVisible(), 'the clock stays: the planner chose its start (06:00 on Wednesday)');
    ok(await page.locator('[data-role=clock-unused]').isVisible(), 'and says that no timetable uses it');
    await page.locator('[data-role=remove-clock]').click();
    await frames(page, 3);
    eq((await layoutOf(page)).calendar, undefined, 'Remove the clock');
    ok(await page.locator('[data-role=clock-section]').isHidden());
    await context.close();
  });

  // ---- restart policy -----------------------------------------------------------------------------------------------------------

  await run('restart', async () => {
    // a day plant restarts cold
    const day = rowPlant({ trucks: { ...BUSY, mode: 'schedule', schedule: [{ at: 0, pallets: 24 }, { at: 600, pallets: 24 }, { at: 1200, pallets: 24 }] } });
    const { context, page } = await open({ layout: day.layout, select: [day.src.id] });
    await step(page, 900);
    ok((await page.evaluate(() => window.__logiplan.runner.time)) >= 899, 'it ran for 15 minutes');
    await page.getByRole('button', { name: 'Increase Doors' }).click();
    await page.waitForFunction(() => window.__logiplan.runner.sim && window.__logiplan.runner.sim.time < 5 && window.__logiplan.runner.sim.layout.stations.find((s) => s.type === 'source').ops.trucks.doors === 5, null, { timeout: 15000 });
    eq(await page.evaluate(() => [window.__logiplan.runner.priming, window.__logiplan.runner.baseline]), [false, null], 'cold: no pre-roll, no baseline');
    const text = (await toasts(page)).join(' ');
    ok(/After an edit the simulation starts again at 00:00|The simulation starts again at 00:00/.test(text), `the toast says why the clock went back: ${text}`);
    await page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('results'));
    await frames(page, 4);
    ok(await page.locator('[data-panel=impact]').count() === 0 || await page.locator('[data-panel=impact]').first().isHidden(), 'the effect-of-your-change card is not shown for a day plant');
    ok(await page.locator('[data-panel=impact-hint]').isHidden(), 'nor the hint under the simulation bar');
    await context.close();

    // a stationary truck plant restarts warm
    const rate = rowPlant({ trucks: { ...defaultTrucks(), doors: 3 } });
    const second = await open({ layout: rate.layout, select: [rate.src.id] });
    await second.page.evaluate(() => { window.__logiplan.runner.setSpeed(1200); });
    await step(second.page, 900);
    await second.page.getByRole('button', { name: 'Increase Doors' }).click();
    await second.page.waitForFunction(() => window.__logiplan.runner.sim && window.__logiplan.runner.sim.layout.stations.find((s) => s.type === 'source').ops.trucks.doors === 4, null, { timeout: 30000 });
    const t = await second.page.evaluate(() => window.__logiplan.runner.sim.time);
    ok(t >= 600, `warm: the new simulation was pre-rolled (${Math.round(t)} s)`);
    ok(await second.page.evaluate(() => Boolean(window.__logiplan.runner.warm)), 'the runner says it is a warm start');
    await second.context.close();
  });

  // ---- the plan -------------------------------------------------------------------------------------------------------------------

  /** Inject a runtime into the displayed simulation (what the truck desks would hold) and look at the brick. */
  async function inject(page, runtime) {
    await page.evaluate((rt) => {
      const { runner, store } = window.__logiplan;
      const sim = runner.sim;
      const layout = store.getState().layout;
      for (const [type, desk] of Object.entries(rt)) {
        const s = layout.stations.find((x) => x.type === type);
        const st = sim.logistics.stationById.get(s.id);
        const now = sim.time;
        st.trucks = {
          gate: (desk.gate || []).map((minutes, i) => ({ id: 100 + i, at: now - minutes * 60 })),
          docked: desk.docked || [],
          staged: desk.staged || [],
        };
      }
    }, runtime);
    await frames(page, 3);
  }

  async function brickRect(page, type) {
    return page.evaluate((t) => {
      const { ctx, store } = window.__logiplan;
      const layout = store.getState().layout;
      const s = layout.stations.find((x) => x.type === t);
      const cs = layout.grid.cellSize;
      const r = ctx.canvas.getBoundingClientRect();
      const [x0, y0] = ctx.camera.worldToScreen(s.x * cs, s.y * cs);
      const [x1, y1] = ctx.camera.worldToScreen((s.x + s.w) * cs, (s.y + s.h) * cs);
      return { x: r.left + x0, y: r.top + y0, w: x1 - x0, h: y1 - y0 };
    }, type);
  }

  /** Count the pixels of the lower band of a brick that satisfy `test([r, g, b])`. */
  async function countInBand(page, rect, test) {
    const fn = test.toString();
    return page.evaluate(([r, src, fnText]) => {
      const { canvas } = window.__logiplan.ctx;
      const box = canvas.getBoundingClientRect();
      const s = canvas.width / box.width;
      const x = Math.round((r.x - box.left) * s);
      const w = Math.round(r.w * s);
      const h = Math.round(r.h * 0.38 * s);
      const y = Math.round((r.y - box.top + r.h * 0.55) * s);
      const d = canvas.getContext('2d').getImageData(x, y, w, h).data;
      const check = new Function(`return (${fnText})`)();
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (check([d[i], d[i + 1], d[i + 2]])) n++;
      return n;
    }, [rect, null, fn]);
  }

  const isGreen = ([r, g, b]) => Math.abs(r - 47) < 30 && Math.abs(g - 179) < 30 && Math.abs(b - 107) < 40;
  const isOrange = ([r, g, b]) => Math.abs(r - 247) < 20 && Math.abs(g - 107) < 25 && Math.abs(b - 21) < 40;
  const isAmber = ([r, g, b]) => Math.abs(r - 245) < 12 && Math.abs(g - 165) < 14 && Math.abs(b - 36) < 40;
  const isRed = ([r, g, b]) => Math.abs(r - 201) < 12 && Math.abs(g - 42) < 14 && Math.abs(b - 42) < 14;

  await run('canvas', async () => {
    for (const theme of ['light', 'dark']) {
      const { layout } = rowPlant({ trucks: { ...defaultTrucks(), doors: 4 }, outTrucks: true });
      const { context, page } = await open({ layout, theme });
      await step(page, 5);
      await page.evaluate(() => {
        const { ctx, store } = window.__logiplan;
        const s = store.getState().layout.stations.find((x) => x.type === 'source');
        const cs = store.getState().layout.grid.cellSize;
        ctx.camera.zoomTo(32, ctx.canvas.clientWidth / 2, ctx.canvas.clientHeight / 2);
        ctx.camera.centerOn((s.x + 6) * cs, (s.y + 2) * cs);
      });
      await frames(page, 3);
      const rect = await brickRect(page, 'source');
      // no trucks yet: free slots only, no gate chip
      eq(await countInBand(page, rect, isGreen), 0, `${theme}: no green while every door is free`);
      eq(await countInBand(page, rect, isAmber) + await countInBand(page, rect, isRed), 0, `${theme}: no chip without a queue`);
      // trucks at the doors: one in check-in, two working, one waiting
      await inject(page, { source: { gate: [], docked: [{ id: 1, state: 'checkin', door: 0 }, { id: 2, state: 'work', door: 1 }, { id: 3, state: 'work', door: 2 }, { id: 4, state: 'work', door: 3, waiting: true }] } });
      ok(await countInBand(page, rect, isGreen) > 60, `${theme}: working doors are green`);
      ok(await countInBand(page, rect, isOrange) > 30, `${theme}: a door that waits is orange (and carries a pause mark)`);
      // a queue at the gate: neutral, amber from 15 minutes, red from 45
      await inject(page, { source: { gate: [3, 1], docked: [] } });
      eq(await countInBand(page, rect, isAmber) + await countInBand(page, rect, isRed), 0, `${theme}: 3 minutes: the chip is neutral`);
      await inject(page, { source: { gate: [20, 5], docked: [] } });
      ok(await countInBand(page, rect, isAmber) > 80, `${theme}: 20 minutes: amber`);
      await inject(page, { source: { gate: [50, 20, 5], docked: [] } });
      ok(await countInBand(page, rect, isRed) > 80, `${theme}: 50 minutes: red`);
      await shot(page, `canvas-gate-${theme}-desktop`);
      // the plan still hit-tests: the band belongs to the brick
      const hit = await page.evaluate(([r]) => window.__logiplan.ctx.renderer.hitTest(r.x + r.w / 2 - document.querySelector('canvas').getBoundingClientRect().left, r.y + r.h * 0.8 - document.querySelector('canvas').getBoundingClientRect().top), [rect]);
      eq(hit.kind, 'station', `${theme}: a click on the doors hits the station`);
      // far zoom: the brick is a swatch, nothing throws
      await page.evaluate(() => { const { ctx } = window.__logiplan; ctx.camera.zoomTo(1.2, ctx.canvas.clientWidth / 2, ctx.canvas.clientHeight / 2); });
      await frames(page, 3);
      await page.evaluate(() => { const { ctx } = window.__logiplan; ctx.camera.zoomTo(5, ctx.canvas.clientWidth / 2, ctx.canvas.clientHeight / 2); });
      await frames(page, 3);
      await shot(page, `canvas-far-${theme}-desktop`);
      await context.close();
    }
  });

  await run('shares', async () => {
    const { layout } = rowPlant({ trucks: { ...defaultTrucks(), doors: 3 } });
    const { context, page } = await open({ layout });
    await step(page, 3600);
    await page.evaluate(() => {
      const { ctx, store } = window.__logiplan;
      store.setUi({ overlays: { ...store.getState().ui.overlays, docks: true } });
      const s = store.getState().layout.stations.find((x) => x.type === 'source');
      const cs = store.getState().layout.grid.cellSize;
      ctx.camera.zoomTo(34, ctx.canvas.clientWidth / 2, ctx.canvas.clientHeight / 2);
      ctx.camera.centerOn((s.x + 1.5) * cs, (s.y + 2) * cs);
    });
    await frames(page, 4);
    const rect = await brickRect(page, 'source');
    await shot(page, 'canvas-shares-light-desktop');
    await context.close();
  });

  // ---- results -----------------------------------------------------------------------------------------------------------------------

  await run('results', async () => {
    // without trucks: no Doors section
    const plain = await open({ layout: starter() });
    await step(plain.page, 1800);
    await plain.page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('results'));
    await frames(plain.page, 4);
    eq(await plain.page.locator('details[data-section=doors]').count(), 0, 'a plant without trucks has nothing of the Doors card in the page');
    await plain.context.close();

    const { layout, src, sink } = rowPlant({ trucks: { ...defaultTrucks(), doors: 2, interArrival: { kind: 'const', mean: 900, spread: 0 }, pallets: { kind: 'const', mean: 8, spread: 0 } }, outTrucks: true });
    const { context, page } = await open({ layout });
    await step(page, 3 * 3600);
    await page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('results'));
    await frames(page, 5);
    const sec = page.locator('details[data-section=doors]');
    await sec.waitFor({ state: 'visible' });
    if (!(await sec.evaluate((e) => e.open))) await sec.locator('summary').click();
    await frames(page, 3);
    const cards = await sec.evaluate((e) => [...e.querySelectorAll('[data-door-station]')].map((li) => ({
      id: li.dataset.doorStation, name: li.querySelector('.dash-link').textContent, text: li.innerText, metrics: Object.fromEntries([...li.querySelectorAll('[data-metric]')].map((m) => [m.dataset.metric, m.querySelector('dd').innerText.replace(/\n/g, ' | ')])),
    })));
    eq(cards.map((c) => c.id), [src.id, sink.id], 'one card per station with trucks, in plant order');
    ok(cards.every((c) => !/NaN|undefined|Infinity/.test(c.text)), 'no NaN in the card');
    ok(/^\d+/.test(cards[0].metrics.served), `trucks served: ${cards[0].metrics.served}`);
    ok(/min|s|h/.test(cards[0].metrics.doorTime), `door time: ${cards[0].metrics.doorTime}`);
    ok('short' in cards[1].metrics && !('short' in cards[0].metrics), 'trucks that left short: Goods out only');
    ok(/Doors busy/.test(cards[0].text), 'door utilisation');
    ok(/lead time of loads from this Goods in includes the wait/.test(cards[0].text), 'the card says what the lead time includes');
    await shot(page, 'results-light-desktop');
    // a click on the station name selects it
    await sec.locator(`[data-door-station="${src.id}"] .dash-link`).click();
    await frames(page, 3);
    eq((await state(page)).selection, { kind: 'station', ids: [src.id] });

    // the words of the picture on the plan: the inspector says how the doors stand
    await page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('properties'));
    await page.waitForFunction(() => /^Doors now: .*(free|working|checking|waiting|held).*(at the gate|No truck at the gate)/.test(document.querySelector('[data-role=doors-now]')?.textContent || ''), null, { timeout: 10000 });
    ok(await page.locator('[data-role=doors-now]').isVisible(), `the inspector says how the doors stand: ${await page.locator('[data-role=doors-now]').innerText()}`);

    // a report without `ops`: the configuration and a note, no numbers, no NaN
    await page.evaluate(() => {
      const { runner } = window.__logiplan;
      const real = runner.kpis.bind(runner);
      runner.kpis = () => { const r = real(); if (!r) return r; const { ops, ...rest } = r; return rest; };
    });
    await page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('properties'));
    await frames(page, 2);
    await page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('results'));
    await frames(page, 5);
    const text = await sec.innerText();
    ok(/no truck figures/.test(text), 'a note instead of numbers');
    ok(!/NaN|undefined|Infinity/.test(text));
    await context.close();
  });

  // ---- checks ----------------------------------------------------------------------------------------------------------------------------

  await run('checks', async () => {
    const { layout, src } = rowPlant({ trucks: { ...BUSY, doors: 4 } });
    const { context, page } = await open({ layout });
    await page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('checks'));
    await frames(page, 4);
    const checksPanel = page.locator('[data-panel=checks]');
    const text = await checksPanel.innerText();
    ok(/needs about 4\.9 doors busy at once \(6 trucks an hour, 49 minutes at a door each\), but it has 4/.test(text), 'doors-too-few quotes the arithmetic');
    ok(/The docks of “Goods receiving” lie in a row on one lane\./.test(text), 'docks-share-lane');
    const lane = checksPanel.locator(`[data-issue="docks-share-lane:${src.id}"]`);
    eq(await lane.count(), 1, 'one button for the docks in a row, not two');
    eq(await lane.first().innerText(), 'Show docks');
    await lane.first().click();
    await frames(page, 3);
    eq((await state(page)).selection, { kind: 'station', ids: [src.id] }, 'the station is selected and the plan shows its docks');
    // the Fix of doors-too-few
    const fix = checksPanel.locator(`[data-issue="doors-too-few:${src.id}"][data-role=fix]`);
    eq(await fix.innerText(), 'Use 6 doors');
    await fix.click();
    await frames(page, 4);
    eq((await stationOf(page, 'source')).ops.trucks.doors, 6);
    eq((await state(page)).label, 'Set dock doors');
    ok(!/doors busy at once/.test(await checksPanel.innerText()), 'the warning is gone');
    await page.evaluate(() => window.__logiplan.store.undo());
    await frames(page, 4);
    eq((await stationOf(page, 'source')).ops.trucks.doors, 4, 'undo takes the fix back');
    // an empty timetable: Add a row
    await page.evaluate((id) => window.__logiplan.store.commit('Use a timetable', (d) => { d.stations.find((s) => s.id === id).ops.trucks.mode = 'schedule'; d.stations.find((s) => s.id === id).ops.trucks.schedule = []; d.calendar = { startTod: 0, startDay: 0 }; d.schema = 2; }), src.id);
    await frames(page, 4);
    const add = checksPanel.locator(`[data-issue="timetable-empty:${src.id}"][data-role=fix]`);
    eq(await add.innerText(), 'Add a row');
    await add.click();
    await frames(page, 3);
    eq((await stationOf(page, 'source')).ops.trucks.schedule, [{ at: 21600, pallets: 24 }]);
    // too many doors for the road cells: Extend the road
    const spur = L.createLayout({ name: 'Spur', cols: 30, rows: 16, cellSize: 2 });
    L.paintRoadPath(spur, [[8, 10], [8, 12], [20, 12]]); // one road cell touches the station
    const a = L.addStation(spur, { type: 'source', name: 'Goods in', x: 8, y: 8, w: 5, h: 2 });
    const b = L.addStation(spur, { type: 'sink', name: 'Goods out', x: 18, y: 9, w: 2, h: 2 });
    L.addFlow(spur, a.id, b.id);
    L.updateStation(spur, a.id, { ops: { trucks: { ...defaultTrucks(), doors: 3 } } });
    await page.evaluate((l) => window.__logiplan.store.replaceLayout(l, { label: 'Load' }), spur);
    await page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('properties'));
    await page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('checks'));
    await page.waitForTimeout(450); // the list of issues is recomputed at most every 200 ms while the panels update
    await frames(page, 4);
    const extend = checksPanel.locator('[data-role=fix]', { hasText: 'Extend the road' });
    eq(await extend.count(), 1, 'three doors, one road cell: the Fix extends the road');
    const docks = () => page.evaluate(() => { const l = window.__logiplan.store.getState().layout; const s = l.stations.find((x) => x.type === 'source'); let n = 0; for (let i = 0; i < s.w; i++) for (const y of [s.y - 1, s.y + s.h]) if (l.roads[`${s.x + i},${y}`]) n++; return n; });
    const before = await docks();
    await extend.click();
    await frames(page, 3);
    eq((await state(page)).label, 'Extend dock road');
    eq(await docks(), before + 2, 'two more road cells touch the station');
    ok(!/has 3 doors but only/.test(await checksPanel.innerText()), 'the warning is gone');
    await page.evaluate(() => window.__logiplan.store.undo());
    eq(await docks(), before, 'one undo takes the road back');
    await context.close();
  });

  await run('experiments', async () => {
    const { layout } = rowPlant({ trucks: { ...defaultTrucks(), doors: 2 }, outTrucks: true });
    const { context, page } = await open({ layout });
    await page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('experiments'));
    await frames(page, 6);
    const params = await page.locator('[data-panel=compare] select, #panel-experiments select').evaluateAll((selects) => selects.flatMap((sel) => [...sel.options].map((o) => o.textContent)));
    ok(params.some((t) => /Goods receiving: number of doors/.test(t)), `the sweep offers the number of doors (${params.filter((t) => /door|truck|pallet/i.test(t)).join(' | ')})`);
    ok(params.some((t) => /Goods receiving: time between trucks/.test(t)), 'and the time between trucks');
    ok(params.some((t) => /Goods receiving: pallets per truck/.test(t)), 'and the pallets per truck');
    ok(params.some((t) => /Dispatch: number of doors/.test(t)), 'also for the Goods out');
    ok(params.some((t) => /Truck wait at the gate \(mean\)/.test(t)), 'the metrics include the wait at the gate');
    ok(params.some((t) => /Door utilization/.test(t)) && params.some((t) => /left without a full load/.test(t)), 'the door utilization and the trucks that left short');
    await shot(page, 'experiments-light-desktop');
    await context.close();
  });

  await run('insights', async () => {
    // 6 trucks an hour of 26 pallets into 4 doors and 3 forklifts: the gate queue grows, and the Results tab says so in the usual list
    const { layout } = rowPlant({ trucks: BUSY });
    const { context, page } = await open({ layout });
    await step(page, 5 * 3600);
    const ids = await page.evaluate(() => window.__logiplan.runner.insights().map((i) => i.id));
    ok(ids.some((id) => /gate-queue-long|doors-bottleneck|unload-limited/.test(id)), `an insight about the trucks: ${ids.join(', ')}`);
    await page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('results'));
    await frames(page, 6);
    const text = await page.locator('[data-panel=dashboard]').innerText();
    ok(/gate|door/i.test(await page.locator('[data-section=insights]').innerText()), 'the Results tab lists it with the others');
    ok(!/NaN|undefined/.test(text));
    await shot(page, 'insights-light-desktop');
    await context.close();
  });

  await run('help', async () => {
    const { context, page } = await open({ layout: starter() });
    await page.evaluate(() => window.__logiplan.ctx.dialogs.openHelp({ tab: 'trucks' }));
    await page.locator('[role=dialog]').waitFor();
    eq(await page.locator('[role=dialog] [role=tab][aria-selected=true]').innerText(), 'Trucks and dock doors');
    await frames(page, 3);
    const text = await page.locator('[role=dialog]').innerText();
    for (const phrase of ['What a door is', 'Why a row of docks blocks', 'How to read the gate queue', 'The door check', 'Gate 5 trucks, 38 min', 'Timetables, clock and cold restart']) ok(text.includes(phrase), `the page says: ${phrase}`);
    ok(await page.locator('[role=dialog] svg[role=img]').count() >= 1, 'with its diagram');
    await page.locator('[data-help=trucks] svg[role=img]').first().scrollIntoViewIfNeeded();
    await frames(page, 3);
    await shot(page, 'help-light-desktop');
    await context.close();
    const dark = await open({ layout: starter(), theme: 'dark', viewport: NARROW });
    await dark.page.evaluate(() => window.__logiplan.ctx.dialogs.openHelp({ tab: 'trucks' }));
    await dark.page.locator('[role=dialog]').waitFor();
    await dark.page.locator('[data-help=trucks] svg[role=img]').first().scrollIntoViewIfNeeded();
    await frames(dark.page, 3);
    ok((await overflow(dark.page)) <= 0, 'dark 390 px: no horizontal page overflow');
    const diagram = await dark.page.locator('[data-help=trucks] svg[role=img]').first().boundingBox();
    ok(diagram.x >= 0 && diagram.x + diagram.width <= NARROW.width, 'the diagram scales into the dialog at 390 px');
    await shot(dark.page, 'help-dark-narrow');
    await dark.context.close();
  });

  await run('share', async () => {
    const { layout } = rowPlant({ trucks: { ...BUSY, mode: 'schedule', schedule: [{ at: 21600, pallets: 24 }, { at: 25200, pallets: null }] }, outTrucks: true });
    L.updateCalendar(layout, { startTod: 21600, startDay: 1 });
    const { context, page } = await open({ layout });
    const round = await page.evaluate(async () => {
      const serialize = await import('/js/model/serialize.js');
      const { store } = window.__logiplan;
      const project = store.getState().project;
      const link = await serialize.shareUrl('http://localhost/', project);
      const back = await serialize.decodeShare(link.split('#p=')[1]);
      const file = serialize.importProject(serialize.exportProject(project));
      const pick = (p) => JSON.stringify([p.scenarios[0].layout.stations.map((s) => s.ops ?? null), p.scenarios[0].layout.calendar, p.scenarios[0].layout.schema]);
      return { same: pick(back) === pick(project) && pick(file) === pick(project), schema: back.scenarios[0].layout.schema };
    });
    eq(round, { same: true, schema: 2 }, 'the doors, the timetable and the clock survive the share link and the project file');
    await context.close();
  });

  // ---- the journey of A1.15 (docs/WAREHOUSE-DESIGN.md 9.2), in the real app on the Starter -------------------------------------------------------

  /** Open the app on its welcome screen and take an example from the gallery with a click, like a planner. */
  async function openExample(id, { theme = 'light', viewport = { width: 1440, height: 900 } } = {}) {
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
    await page.locator(`[role=dialog] [data-example="${id}"]`).click();
    await page.locator('[role=dialog]').waitFor({ state: 'detached' });
    await frames(page, 3);
    return { context, page };
  }

  /** The brick of a station type on the screen (x, y, w, h in page pixels). */
  const brickOf = async (page, type) => page.evaluate((t) => {
    const { ctx, store } = window.__logiplan;
    const layout = store.getState().layout;
    const s = layout.stations.find((x) => x.type === t);
    const cs = layout.grid.cellSize;
    const r = ctx.canvas.getBoundingClientRect();
    const [x0, y0] = ctx.camera.worldToScreen(s.x * cs, s.y * cs);
    const [x1, y1] = ctx.camera.worldToScreen((s.x + s.w) * cs, (s.y + s.h) * cs);
    return { x: r.left + x0, y: r.top + y0, w: x1 - x0, h: y1 - y0 };
  }, type);

  /** The text of every metric of the Doors card of a station, as { served: '7', gateWait: '0 s', ... } (the first line of each). */
  const doorsCard = (page, stationId) => page.locator(`[data-door-station="${stationId}"]`).evaluate((li) => ({
    text: li.innerText,
    metrics: Object.fromEntries([...li.querySelectorAll('[data-metric]')].map((m) => [m.dataset.metric, m.querySelector('dd').innerText.split('\n')[0]])),
  }));

  await run('journey', async () => {
    // 1. the Starter from the gallery, the Goods in picked on the plan with a click
    const { context, page } = await openExample('starter');
    const before = JSON.stringify(await layoutOf(page));
    ok((await layoutOf(page)).schema === 1 && (await stationOf(page, 'source')).ops === undefined, 'the Starter is a legacy plant: schema 1, no options');
    await page.evaluate(() => { window.__logiplan.ctx.actions.setRightTab('properties'); window.__logiplan.runner.setSpeed(1200); });
    const brick = await brickOf(page, 'source');
    await page.mouse.click(brick.x + brick.w / 2, brick.y + brick.h / 2);
    await frames(page, 3);
    const src = await stationOf(page, 'source');
    eq((await state(page)).selection, { kind: 'station', ids: [src.id] }, 'a click on the plan selects Goods receiving');

    // the plant before the doors: what it delivers in four simulated hours
    await step(page, 4 * 3600);
    await fresh(page);
    const legacy = await page.evaluate(() => { const k = window.__logiplan.runner.kpis(); return { perHour: k.throughput.perHour, ops: k.ops }; });
    eq(legacy.ops, undefined, 'a legacy report has no truck figures');
    ok(legacy.perHour > 15 && legacy.perHour < 25, `the Starter delivers about 20 pallets an hour (${legacy.perHour.toFixed(1)})`);

    // 2. Add dock doors: one undo step, the toast with the numbers, the pallet rate stays
    await page.locator('[data-role=add-doors]').click();
    await frames(page, 4);
    eq((await state(page)).label, 'Add dock doors', 'one undo step');
    const trucks = (await stationOf(page, 'source')).ops.trucks;
    eq([trucks.doors, trucks.pallets.mean, trucks.interArrival.mean], [2, 24, 4320], '24 pallets every 72 minutes: the rate of one pallet every 3 minutes');
    ok(/receives trucks: 2 doors, 24 pallets per truck, about one truck every 72 min\. That is the same 20 pallets an hour as before/.test((await toasts(page)).join(' ')), 'the toast says it');
    ok(await page.locator('[data-role=trucks-on]').isVisible(), 'the Trucks and doors controls are there');
    // the first impression of a plant with one dock and two doors: the Checks tab says why a second door helps little, as a warning, not an error
    await page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('checks'));
    await page.waitForTimeout(450);
    await frames(page, 3);
    const checks = await page.locator('[data-panel=checks]').innerText();
    ok(/has 2 doors but only 1 road cell touches it\. Vehicles serve the doors through that cell, so a door beyond them cannot be unloaded any faster/.test(checks), checks);
    eq(await page.locator('#tab-checks').getAttribute('aria-label'), 'Checks, 1 problem', 'one warning in the Checks tab, not a wall of them');
    ok(!(await page.locator('[data-panel=checks]').innerText()).includes('Error'), 'and no error');
    await page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('properties'));

    // 3. Play: the real play button, at 1200x, until about three simulated hours have gone by, then Pause
    await page.getByRole('button', { name: 'Run simulation' }).click();
    await page.waitForFunction(() => window.__logiplan.runner.sim && window.__logiplan.runner.sim.time >= 3 * 3600 + 600, null, { timeout: 120000 });
    await page.getByRole('button', { name: 'Pause simulation' }).click();
    await frames(page, 3);
    ok(!(await page.evaluate(() => window.__logiplan.runner.playing)), 'paused');

    // 4. the Doors card shows numbers (the Goods in has served trucks; nothing is NaN)
    await page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('results'));
    await frames(page, 5);
    const sec = page.locator('details[data-section=doors]');
    await sec.waitFor({ state: 'visible' });
    if (!(await sec.evaluate((e) => e.open))) await sec.locator('summary').click();
    await frames(page, 3);
    const card = await doorsCard(page, src.id);
    ok(Number(card.metrics.served) >= 1, `trucks served: ${card.metrics.served}`);
    ok(/^\d+(\.\d+)? (min|h)$/.test(card.metrics.doorTime), `door time: ${card.metrics.doorTime}`);
    ok(!/NaN|undefined|Infinity/.test(card.text), 'no NaN in the card');
    ok(/Doors busy/.test(card.text) && /\(measured\)/.test(card.text), 'the door check line uses the measured door time after a run');
    await shot(page, 'journey-results-light-desktop');

    // 5. undo restores the plant byte for byte, and the Doors card is gone
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.schema === 1);
    eq(JSON.stringify(await layoutOf(page)), before, 'undo: the Starter again, byte for byte');
    await frames(page, 5);
    ok(!(await page.locator('details[data-section=doors]').first().isVisible().catch(() => false)), 'and no Doors card without trucks (hidden, not just empty)');
    await page.keyboard.press('Control+Shift+z');
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.schema === 2);
    eq((await stationOf(page, 'source')).ops.trucks.doors, 2, 'redo: the doors are back');

    // 6. the share link round trip: the link of the Share dialog opens in a fresh browser with the doors in it
    await page.getByRole('button', { name: 'Share' }).first().click();
    const dialog = page.locator('[role=dialog]');
    await dialog.waitFor();
    const field = dialog.getByLabel('Link to this project');
    await field.waitFor();
    const link = await field.inputValue();
    ok(/#p=/.test(link), 'a share link');
    await dialog.getByRole('button', { name: 'Done' }).click();
    await dialog.waitFor({ state: 'detached' });
    const other = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const shared = await other.newPage();
    shared.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    await shared.goto(link.replace(/^https?:\/\/[^/]+/, origin));
    await shared.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
    await shared.waitForFunction(() => window.__logiplan.store.getState().layout.stations.some((s) => s.ops && s.ops.trucks));
    const sharedTrucks = (await stationOf(shared, 'source')).ops.trucks;
    eq([sharedTrucks.doors, sharedTrucks.pallets.mean, sharedTrucks.interArrival.mean, (await layoutOf(shared)).schema], [2, 24, 4320, 2], 'the share link keeps the doors');
    await other.close();

    // 7. a pasted timetable (German Excel) is applied only after "Use N rows"
    await page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('properties'));
    await page.locator('[data-role=mode] button', { hasText: 'Use a timetable' }).click();
    await frames(page, 3);
    const schedule = async () => (await stationOf(page, 'source')).ops.trucks.schedule;
    eq(await schedule(), [], 'a new timetable has no rows');
    await page.locator('[data-role=paste]').click();
    const paste = page.locator('[role=dialog]');
    await paste.locator('[data-role=paste-text]').fill('Ankunft;Paletten\n06.00;24,0\n6:30 Uhr;18\n08:00;\n25:70;4');
    await frames(page, 2);
    ok(/3 rows read, 1 skipped: row 5 “25:70” is not a time\. Nothing is applied until you press Use 3 rows\./.test(await paste.locator('[data-role=paste-summary]').innerText()), 'the preview says what it read');
    eq(await schedule(), [], 'while the preview is open nothing is applied');
    await paste.getByRole('button', { name: 'Use 3 rows' }).click();
    await paste.waitFor({ state: 'detached' });
    eq(await schedule(), [{ at: 21600, pallets: 24 }, { at: 23400, pallets: 18 }, { at: 28800, pallets: null }], 'after "Use 3 rows" the timetable is there');

    // 8. (A1.13 live) a day plant restarts cold on an edit, then one whole day runs, then a stationary truck plant restarts warm
    await step(page, 900);
    await page.getByRole('button', { name: 'Increase Doors' }).click();
    await page.waitForFunction(() => window.__logiplan.runner.sim && window.__logiplan.runner.sim.time < 5 && window.__logiplan.runner.sim.layout.stations.find((s) => s.type === 'source').ops.trucks.doors === 3, null, { timeout: 20000 });
    eq(await page.evaluate(() => [window.__logiplan.runner.priming, window.__logiplan.runner.baseline]), [false, null], 'a day plant restarts cold after an edit');
    await page.evaluate(() => window.__logiplan.ctx.actions.clearSelection?.() || window.__logiplan.store.clearSelection());
    await page.locator('[data-role=run-day]').click();
    await page.waitForFunction(() => window.__logiplan.runner.sim && window.__logiplan.runner.time >= 86399 && !window.__logiplan.runner.playing, null, { timeout: 180000 });
    await fresh(page);
    const day = await page.evaluate(() => { const r = window.__logiplan.runner; return { time: r.time, kpis: r.kpis() }; });
    ok(day.time >= 86399 && day.time < 86500, `one whole day (${Math.round(day.time)} s)`);
    eq(day.kpis.ops.trucks[src.id].trucks.arrived, 3, 'the timetable of three rows brought three trucks in that day');
    await page.evaluate((id) => window.__logiplan.store.select('station', [id]), src.id);
    await page.locator('[data-role=mode] button', { hasText: 'Generate from rate' }).click();
    await frames(page, 3);
    eq((await layoutOf(page)).calendar, undefined, 'back to a rate: the clock goes, the plant is stationary again');
    await step(page, 900); // a plant that has not run yet has nothing to continue: warm restarts need time on the clock
    await page.getByRole('button', { name: 'Increase Doors' }).click();
    await page.waitForFunction(() => window.__logiplan.runner.sim && window.__logiplan.runner.sim.layout.stations.find((s) => s.type === 'source').ops.trucks.doors === 4, null, { timeout: 60000 });
    ok(await page.evaluate(() => Boolean(window.__logiplan.runner.warm)), 'a stationary truck plant restarts warm');
    await context.close();
  });

  // ---- hand-computed figures of a live run (A1.15, the integrator's part) --------------------------------------------------------------------------------

  /**
   * A plant whose truck figures can be worked out on paper. Goods in: a truck of 6 pallets every 20 minutes, the first one at time 0 (startDelay 0, no variation at
   * all: constant gap, constant pallets), 2 doors, 5 minutes of check-in and of check-out. Two forklifts carry the pallets to a Goods out, which is close.
   */
  async function referencePlant({ doors = 2, gap = 1200 } = {}) {
    const layout = L.createLayout({ name: 'Reference', cols: 30, rows: 14, cellSize: 2 });
    L.paintRoadPath(layout, [[3, 9], [26, 9]]);
    const src = L.addStation(layout, { type: 'source', name: 'Goods receiving', x: 6, y: 6, w: 3, h: 3, params: { outCap: 6 } });
    const sink = L.addStation(layout, { type: 'sink', name: 'Dispatch', x: 14, y: 6, w: 3, h: 3 });
    L.addFlow(layout, src.id, sink.id);
    const park = L.addStation(layout, { type: 'depot', name: 'Parking', x: 3, y: 11, w: 3, h: 2, params: { slots: 4 } });
    L.paintRoadPath(layout, [[4, 9], [4, 10]]);
    L.addFleet(layout, 'forklift', { count: 2, home: park.id, length: 2 });
    L.updateStation(layout, src.id, { ops: { trucks: { ...defaultTrucks(), doors, checkIn: 300, checkOut: 300, mode: 'rate', interArrival: { kind: 'const', mean: gap, spread: 0 }, pallets: { kind: 'const', mean: 6, spread: 0 } } } });
    layout.settings.warmup = 0;
    return { layout, src };
  }

  await run('reference', async () => {
    const { layout, src } = await referencePlant();
    const { context, page } = await open({ layout, select: [src.id] });
    const T = 10900; // 3 h and a bit: trucks come at 0, 1200, ..., 10800 s
    await step(page, T);
    await fresh(page);
    await page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('results'));
    await frames(page, 5);
    const sec = page.locator('details[data-section=doors]');
    await sec.waitFor({ state: 'visible' });
    if (!(await sec.evaluate((e) => e.open))) await sec.locator('summary').click();
    await frames(page, 3);
    const entry = await page.evaluate((id) => window.__logiplan.runner.kpis().ops.trucks[id], src.id);
    // arrivals: 10 trucks (t = 0, 1200, ..., 9 x 1200 = 10800); the one that came at 10800 has been at a door for 100 s only
    eq(entry.trucks.arrived, 10, 'ten trucks in 10,900 s at one every 1,200 s, the first at 0');
    eq(entry.trucks.docked, 10, 'two doors and 20 minutes between trucks: nobody waits for a door');
    eq(entry.trucks.departed, 9, 'nine have left (the last arrived 100 s ago)');
    eq(entry.trucks.turnedAway + entry.trucks.noShow + entry.trucks.short, 0);
    ok(entry.gateWait.mean < 1, `nobody waits at the gate (${entry.gateWait.mean} s)`);
    // door time: check-in 300 + unloading 6 pallets by two forklifts (a pallet is "taken" when it is loaded, 20 s each, about 40 s per round trip) + check-out 300
    ok(entry.doorTime.mean >= 600 && entry.doorTime.mean <= 600 + 6 * 60, `door time ${entry.doorTime.mean.toFixed(0)} s is 600 s of paperwork plus less than 6 minutes of unloading`);
    // doors busy: nine finished trucks and the tenth (100 s) hold doors for 9 x doorTime + 100 s of 2 doors x 10,900 s
    const expected = (9 * entry.doorTime.mean + 100) / (2 * T);
    ok(Math.abs(entry.doorUtilization - expected) < 0.01, `doors busy ${(entry.doorUtilization * 100).toFixed(1)} % against ${(expected * 100).toFixed(1)} % worked out from the door time`);
    ok(entry.doorUtilization > 0.27 && entry.doorUtilization < 0.34, `about 30 %: ${(entry.doorUtilization * 100).toFixed(1)} %`);
    // the card says the same thing in words
    const card = await doorsCard(page, src.id);
    eq(card.metrics.served, '9', 'trucks served on the card');
    const minutes = /^(\d+(?:\.\d)?) min$/.exec(card.metrics.doorTime);
    ok(minutes && Math.abs(Number(minutes[1]) - entry.doorTime.mean / 60) < 0.06, `door time on the card: ${card.metrics.doorTime} (${(entry.doorTime.mean / 60).toFixed(2)} min)`);
    eq(card.metrics.gateWait, '0 s', 'gate wait on the card');
    ok(new RegExp(`Doors busy\\s*${Math.round(entry.doorUtilization * 100)} %`).test(card.text.replace(/\n/g, ' ')) || card.text.includes(`${Math.round(entry.doorUtilization * 100)} %`), `doors busy on the card (${Math.round(entry.doorUtilization * 100)} %): ${card.text.replace(/\n/g, ' | ')}`);
    // the door check before a run (assumed 90 s per pallet): 3 trucks an hour x (300 + 6 x 90 + 300 = 1140 s = 19 min) = 0.95 doors
    await page.evaluate(() => window.__logiplan.runner.kpis = () => null); // pretend nothing has been measured
    await page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('properties'));
    await frames(page, 4);
    const text = await page.locator('[data-role=door-check-text]').innerText();
    ok(/At the busiest hour you need about 1 door busy at once \(3 trucks an hour, 19 minutes at a door each\)\. You have 2 doors, busy about 48 % of the time\./.test(text), text);
    ok(/The 90 s per pallet is an assumption\. In a run your vehicles decide how long a truck stays at its door/.test(await page.locator('[data-role=door-check-note]').innerText()), 'and says who sets the door time');
    await context.close();
  });

  await run('reference-queue', async () => {
    // One door and a truck every 10 minutes, but a truck holds the door for D = 600 s of paperwork + about 211 s of unloading = about 811 s: the gate queue grows by D - 600 s
    // for every truck. Truck k (k = 0, 1, ...) arrives at 600 k and takes the door at D k, so it waits (D - 600) k seconds. After T = 10,900 s:
    //   arrived  = trucks with 600 k <= T            -> k = 0..18 = 19
    //   docked   = trucks with D k <= T              -> k = 0..13 = 14   (13 x 811 = 10,543; 14 x 811 = 11,354)
    //   departed = trucks with D (k + 1) <= T        -> k = 0..12 = 13
    //   queue now = 19 - 14 = 5 trucks; the longest wait of a truck that has docked: (D - 600) x 13; the mean over the 14 that have: (D - 600) x 6.5
    //   doors busy: one door, never free: 100 %
    const { layout, src } = await referencePlant({ doors: 1, gap: 600 });
    const { context, page } = await open({ layout, select: [src.id] });
    const T = 10900;
    await step(page, T);
    await fresh(page);
    const entry = await page.evaluate((id) => window.__logiplan.runner.kpis().ops.trucks[id], src.id);
    const D = entry.doorTime.mean;
    ok(D > 805 && D < 820, `a truck holds the door for ${D.toFixed(1)} s (600 s of paperwork and about 211 s of work)`);
    eq([entry.trucks.arrived, entry.trucks.docked, entry.trucks.departed], [19, 14, 13], '19 trucks came, 14 got a door, 13 left');
    eq(entry.gateQueue.now, 5, 'five trucks wait at the gate');
    ok(Math.abs(entry.gateWait.mean - (D - 600) * 6.5) < 0.02 * (D - 600) * 6.5, `mean wait at the gate ${(entry.gateWait.mean / 60).toFixed(1)} min against ${((D - 600) * 6.5 / 60).toFixed(1)} min worked out`);
    ok(Math.abs(entry.gateWait.max - (D - 600) * 13) < 0.02 * (D - 600) * 13, `the longest wait ${(entry.gateWait.max / 60).toFixed(1)} min against ${((D - 600) * 13 / 60).toFixed(1)} min`);
    ok(entry.doorUtilization > 0.995, `the one door is never free (${(entry.doorUtilization * 100).toFixed(1)} %)`);
    await page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('results'));
    await frames(page, 5);
    const sec = page.locator('details[data-section=doors]');
    await sec.waitFor({ state: 'visible' });
    if (!(await sec.evaluate((e) => e.open))) await sec.locator('summary').click();
    await frames(page, 3);
    const card = await doorsCard(page, src.id);
    eq([card.metrics.served, card.metrics.queue], ['13', '5'], 'the card: 13 served, 5 at the gate');
    ok(/^\d+(\.\d)? min$/.test(card.metrics.gateWait), `the gate wait on the card: ${card.metrics.gateWait}`);
    ok(/100 %/.test(card.text), 'doors busy 100 %');
    // the picture on the plan: the gate chip says the same (5 trucks, the longest has waited about 20 minutes: amber)
    await page.evaluate(() => { const { ctx, store } = window.__logiplan; const s = store.getState().layout.stations.find((x) => x.type === 'source'); const cs = store.getState().layout.grid.cellSize; ctx.camera.zoomTo(40, ctx.canvas.clientWidth / 2, ctx.canvas.clientHeight / 2); ctx.camera.centerOn((s.x + 1.5) * cs, (s.y + 1.5) * cs); });
    await frames(page, 4);
    const gate = await page.evaluate(() => { const { runner, store } = window.__logiplan; const rt = runner.sim.logistics.stationById.get(store.getState().layout.stations.find((x) => x.type === 'source').id); return { queued: rt.trucks.gate.length, longest: runner.time - rt.trucks.gate[0].at }; });
    eq(gate.queued, 5, 'the desk of the simulation holds five trucks at the gate');
    ok(Math.abs(gate.longest - (10900 - 600 * 14)) < 5, `the oldest truck at the gate arrived at 8,400 s and has waited ${Math.round(gate.longest)} s`);
    await shot(page, 'reference-queue-light-desktop');
    await context.close();
  });

  // ---- layout, light and dark, desktop and narrow ----------------------------------------------------------------------------------------

  await run('layout', async () => {
    for (const theme of ['light', 'dark']) {
      for (const [size, viewport] of [['desktop', { width: 1440, height: 900 }], ['narrow', NARROW]]) {
        const { layout, src } = rowPlant({ trucks: { ...BUSY, mode: 'schedule', schedule: [{ at: 21600, pallets: 24 }, { at: 25200, pallets: 18 }, { at: 30600, pallets: null }], jitter: 600, noShow: 0.05 }, outTrucks: true });
        const { context, page } = await open({ layout, theme, viewport, select: [src.id] });
        await step(page, 600);
        await page.locator('[data-role=trucks-on]').scrollIntoViewIfNeeded();
        await frames(page, 3);
        eq(await insidePanel(page, '#panel-properties [data-role=trucks-section] *'), [], `${theme} ${size}: the section stays inside the panel`);
        ok((await overflow(page)) <= 0, `${theme} ${size}: no horizontal page overflow`);
        await page.locator('[data-role=door-check]').scrollIntoViewIfNeeded();
        await shot(page, `inspector-check-${theme}-${size}`);
        await page.locator('[data-role=timetable]').scrollIntoViewIfNeeded();
        await shot(page, `inspector-timetable-${theme}-${size}`);
        // the paste dialog
        await page.locator('[data-role=paste]').click();
        const dialog = page.locator('[role=dialog]');
        await dialog.locator('[data-role=paste-text]').fill('Ankunft;Paletten\n06.00;24,0\n6:30 Uhr;18\n25:70;4\n08:00;\n0900;300\nfoo');
        await frames(page, 2);
        const box = await dialog.boundingBox();
        if (box) ok(box.x >= -1 && box.x + box.width <= viewport.width + 1, `${theme} ${size}: the paste dialog fits the screen`);
        await shot(page, `paste-${theme}-${size}`);
        await page.keyboard.press('Escape');
        // the plan with doors and the Doors card
        if (size === 'desktop') {
          await page.evaluate(() => { const { ctx, store } = window.__logiplan; ctx.actions.fitView(); store.clearSelection(); });
          await frames(page, 3);
          await shot(page, `plan-${theme}-${size}`);
          await page.evaluate(() => window.__logiplan.ctx.actions.setRightTab('results'));
          await frames(page, 4);
          await shot(page, `results-${theme}-${size}`);
        }
        await context.close();
      }
    }
  });

  eq(foreign, [], 'no request leaves the app');
}, { viewport: { width: 1440, height: 900 } });

console.log(`doors.mjs: ${checks} checks passed`);
