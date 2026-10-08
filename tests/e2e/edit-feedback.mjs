// Edit feedback in the REAL app (index.html + js/main.js) in real Chromium: "when I add goods in / goods out / vehicles they are not
// taken into account for the simulation". The engine always included them; what made it feel ignored was that every edit restarted the
// simulation from an empty plant (Results said "Not counted yet" for the first 10 simulated minutes), that nothing showed what an edit
// had done, and that vehicles nobody needs sat parked unannounced. This script drives the measured scenario end to end:
// run Two lines, add a goods-in with a flow, a goods-out and a forklift fleet while it runs -> Results show numbers at once, the
// "Effect of your change" card compares the OLD plant (simulated afresh for the same window and seed) with the new one, edits in a row
// keep the original baseline, "Compare properly" adds the old plant as a variant, Keep and Dismiss work, the fleet status strip says
// how busy a fleet is, "Keep results warm after edits" off gives the old behaviour, and no frame is long.
//
// Run: node tests/e2e/edit-feedback.mjs [section]       sections: scenario controls unconnected fleet shots perf
// Screenshots: e2e-output/edit-feedback-*.png (open them and look). Pre-roll and frame times of `perf` are printed and written to
// e2e-output/edit-feedback-perf.json. Every section asserts that the page logged no console error or warning.
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { withBrowser, OUT } from './browser.mjs';
import { EXAMPLES } from '../../js/model/examples.js';
import * as L from '../../js/model/layout.js';
import { Simulation } from '../../js/sim/engine.js';
import { describeLabels } from '../../js/ui/panels/impact.js';

const only = process.argv[2] || '';
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

const DESKTOP = { width: 1440, height: 900 };
const NARROW = { width: 390, height: 800 };
/** The user's patience: after an edit the numbers and the card must be there within this many real milliseconds. */
const SHOW_WITHIN_MS = 1500;
/** No frame of the page may block longer than this (ms) while a replacement simulation is primed. */
const FRAME_LIMIT_MS = 50;

await withBrowser(async ({ browser, url, errors }) => {
  const origin = new URL(url('/')).origin;

  // ---- plumbing -------------------------------------------------------------------------------------------------

  async function session({ viewport = DESKTOP, colorScheme = 'light', init = null } = {}) {
    const context = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 1 });
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

  const snap = (page, name, opts = {}) => page.screenshot({ path: path.join(OUT, `edit-feedback-${name}.png`), ...opts });
  const noErrors = (what) => { eq(errors.splice(0), [], `${what}: console errors or warnings`); };
  const tab = async (page, id) => {
    await page.locator(`[data-tab=${id}]`).click();
    await page.locator(`#panel-${id}`).waitFor({ state: 'visible' });
  };
  const runnerState = (page) => page.evaluate(() => {
    const r = window.__logiplan.runner;
    return {
      time: r.time, playing: r.playing, priming: r.priming, warm: r.warm, speed: r.speed,
      baseline: r.baseline ? {
        labels: r.baseline.labels, edits: r.baseline.edits, simTime: r.baseline.simTime, throughput: r.baseline.report.throughput.perHour, duration: r.baseline.report.window.duration,
        paired: Boolean(r.baseline.control && r.baseline.after), controlWindow: r.baseline.control ? r.baseline.control.window : null, afterWindow: r.baseline.after ? r.baseline.after.window : null,
        hasLayout: Boolean(r.baseline.layout),
      } : null,
    };
  });
  const waitSim = (page, seconds) => page.waitForFunction((s) => window.__logiplan.runner.time >= s, seconds, { timeout: 120000 });
  /** Wait until a replacement simulation has been swapped in (the runner's sim is not `window.__before` any more) and priming is over. */
  const swapped = (page, timeout = 60000) => page.waitForFunction(() => window.__logiplan.runner.sim !== window.__before && !window.__logiplan.runner.priming, null, { timeout });
  const mark = (page) => page.evaluate(() => { window.__before = window.__logiplan.runner.sim; });

  /** Load an example, open the Results tab and run at `speed` until the clock passes `seconds`. */
  async function startExample(page, id, { tabName = 'results', speed = 600, seconds = 1500, drawerClosed = false } = {}) {
    const hadSim = await page.evaluate(async (exampleId) => {
      const { EXAMPLES: all } = await import('/js/model/examples.js');
      window.__before = window.__logiplan.runner.sim;
      window.__logiplan.store.newProject(all.find((e) => e.id === exampleId).build());
      return Boolean(window.__before);
    }, id);
    if (hadSim) await swapped(page); // another plant replaces the running one (a cold start after the debounce)
    if (drawerClosed) { // a phone: the panel is a drawer that is closed, so the tab and the speed are set without it
      await page.evaluate(([name, x]) => { window.__logiplan.store.setUi({ rightTab: name }); window.__logiplan.runner.setSpeed(x); void window.__logiplan.runner.play(); }, [tabName, speed]);
    } else {
      await tab(page, tabName);
      await page.locator('.simbar__speed').selectOption(String(speed));
      if (!(await page.evaluate(() => window.__logiplan.runner.playing))) await page.locator('.simbar').getByRole('button', { name: 'Run simulation' }).click();
    }
    await waitSim(page, seconds);
  }

  /** Goods in 2 with a road bay and a flow to the warehouse (edit 1 of the scenario), as one undo step. */
  const addGoodsIn = (page) => page.evaluate(async () => {
    const M = await import('/js/model/layout.js');
    window.__logiplan.store.commit('Add Goods in 2', (l) => {
      M.paintRoadPath(l, [[27, 6], [27, 4]]);
      const gi = M.addStation(l, { type: 'source', name: 'Goods in 2', x: 26, y: 2, w: 3, h: 2, params: { interArrival: { kind: 'normal', mean: 240, spread: 0.2 }, outCap: 6 } });
      M.addFlow(l, gi.id, l.stations.find((s) => s.name === 'Central warehouse').id, {});
    });
  });
  /** Page coordinates of the centre of grid cell (cx, cy). */
  const cellXY = (page, cx, cy) => page.evaluate(([x, y]) => {
    const { camera, canvas } = window.__logiplan.ctx;
    const cs = window.__logiplan.store.getState().layout.grid.cellSize;
    const [px, py] = camera.worldToScreen((x + 0.5) * cs, (y + 0.5) * cs);
    const r = canvas.getBoundingClientRect();
    return [r.left + px, r.top + py];
  }, [cx, cy]);
  const lastLabel = (page) => page.evaluate(() => window.__logiplan.store.getState().undoLabel);
  /** A Goods out next to the east road and a flow from the final assembly to it, with the real tools: key 4 (Goods out) and F (flow). */
  async function addGoodsOutWithTools(page) {
    await page.keyboard.press('4');
    const [x, y] = await cellXY(page, 51, 12);
    await page.mouse.move(x, y); // the ghost follows the pointer; a click places it
    await page.waitForTimeout(100);
    await page.mouse.click(x, y);
    const placed = await lastLabel(page);
    await page.keyboard.press('f');
    const [ax, ay] = await cellXY(page, 32, 24); // the final assembly
    await page.mouse.click(ax, ay);
    await page.waitForTimeout(100);
    await page.mouse.click(x, y);
    const connected = await lastLabel(page);
    await page.keyboard.press('v');
    return [placed, connected];
  }

  const card = (page) => page.locator('#panel-results [data-panel=impact]');
  const hint = (page) => page.locator('[data-panel=impact-hint]');
  const kpiText = (page, id) => page.locator(`#panel-results [data-kpi=${id}] .kpi__value`).innerText();

  const run = async (name, fn) => {
    if (only && only !== name) return;
    console.log(`-- ${name}`);
    await fn();
  };

  // ---------------------------------------------------------------------------------------------------------------
  // The measured scenario
  // ---------------------------------------------------------------------------------------------------------------
  await run('scenario', async () => {
    const { page, context } = await openApp();
    await startExample(page, 'two-lines');
    const first = await runnerState(page);
    ok(first.playing && first.time >= 1500, `Two lines runs: ${Math.round(first.time)} s`);
    eq(first.baseline, null, 'nothing to compare yet: no baseline on the first run');
    eq(await card(page).count(), 1, 'the card exists ...');
    ok(await card(page).isHidden(), '... but is not shown without a baseline');
    ok(await hint(page).isHidden(), 'and neither is the hint under the simulation bar');
    const throughputBefore = await kpiText(page, 'throughput');
    ok(/^\d/.test(throughputBefore), `Results show numbers before the edit: ${throughputBefore}`);

    // edit 1: a goods-in with a flow, while the simulation runs
    await mark(page);
    const t0 = await page.evaluate(() => performance.now());
    await addGoodsIn(page);
    await page.waitForFunction(() => {
      const r = window.__logiplan.runner;
      const card = document.querySelector('#panel-results [data-panel=impact]');
      const value = document.querySelector('#panel-results [data-kpi=throughput] .kpi__value');
      return r.sim !== window.__before && !r.priming && r.warm && card && !card.hidden && value && /^\d/.test(value.textContent);
    }, null, { polling: 'raf', timeout: SHOW_WITHIN_MS });
    const shownAfter = await page.evaluate((start) => performance.now() - start, t0);
    console.log(`   edit -> Results show numbers and the "Effect of your change" card after ${Math.round(shownAfter)} ms (limit ${SHOW_WITHIN_MS})`);
    ok(shownAfter <= SHOW_WITHIN_MS, `numbers and card within ${SHOW_WITHIN_MS} ms: ${Math.round(shownAfter)} ms`);
    const afterFirst = await runnerState(page);
    ok(afterFirst.playing, 'the simulation keeps running');
    ok(afterFirst.time >= 1200 && afterFirst.warm.preRoll >= 1200, `the clock continues from the pre-roll (${Math.round(afterFirst.time)} s), it did not go back to 0:00`);
    eq(afterFirst.baseline.labels, ['Add Goods in 2'], 'the baseline carries the label of the edit');
    ok(afterFirst.baseline.duration >= 600, `the baseline had ${Math.round(afterFirst.baseline.duration)} s measured`);
    ok(afterFirst.baseline.paired && afterFirst.baseline.hasLayout, 'the old plant was simulated next to the new one for the comparison, and its plant is kept');
    ok(Math.abs(afterFirst.baseline.controlWindow - afterFirst.baseline.afterWindow) < 1e-6 && afterFirst.baseline.afterWindow >= 600, `over the same measured window (${afterFirst.baseline.afterWindow} s)`);
    ok(!(await page.locator('#panel-results').innerText()).includes('Not counted yet'), 'Results do not say "Not counted yet"');
    ok(!(await page.locator('#panel-results .dash__notice').isVisible()), 'no warming-up notice');
    await page.waitForFunction(() => /measured since 0:10:00 \(pre-run\)/.test(document.querySelector('#panel-results .dash__status')?.textContent || ''));
    ok(true, 'the window is labelled: measuring since 0:10:00 (pre-run)');

    // the card: title, labels, six rows, sane numbers, honesty line
    eq(await card(page).locator('.impact__title').innerText(), 'Effect of your change', 'card title');
    eq(await card(page).locator('.impact__labels').innerText(), 'Add Goods in 2', 'card names the edit');
    eq(await card(page).locator('.impact__row').count(), 6, 'six rows');
    const rows = await card(page).locator('.impact__row').evaluateAll((els) => els.map((el) => ({
      metric: el.dataset.metric, text: el.innerText.replace(/\s+/g, ' ').trim(),
      before: el.querySelector('.impact__before').textContent, after: el.querySelector('.impact__after').textContent, delta: el.querySelector('.impact__delta').textContent.trim(),
    })));
    eq(rows.map((r) => r.metric), ['throughput', 'leadTime', 'wip', 'fleet', 'traffic', 'deadlocks'], 'rows in order');
    for (const r of rows) ok(!/NaN|undefined|null|Infinity/.test(r.text) && /\d/.test(r.before) && /\d/.test(r.after), `row ${r.metric} shows real numbers: ${r.text}`);
    const numbers = await page.evaluate(() => {
      const b = window.__logiplan.runner.baseline;
      return { before: b.control.report.throughput.perHour, after: b.after.report.throughput.perHour, leadBefore: b.control.report.leadTime.mean, leadAfter: b.after.report.leadTime.mean };
    });
    ok(numbers.before > 5 && numbers.before < 80, `throughput before is sane: ${numbers.before.toFixed(1)} /h`);
    ok(numbers.after > 5 && numbers.after < 120, `throughput after is sane: ${numbers.after.toFixed(1)} /h`);
    ok(numbers.leadBefore > 60 && numbers.leadBefore < 7200 && numbers.leadAfter > 60 && numbers.leadAfter < 7200, `lead times are sane: ${Math.round(numbers.leadBefore)} s, ${Math.round(numbers.leadAfter)} s`);
    const status = await card(page).locator('.impact__status').innerText();
    eq(status, 'Indicative: one run per plant, so small differences are not coloured.', 'honesty line');
    eq(await card(page).locator('.impact__progress').count(), 0, 'no progress bar: the compared window is fixed, not growing');
    eq(await card(page).locator('.impact__windows').innerText(), 'Both plants were simulated for the same 10 min after warm-up, with the same random seed.', 'the window and the seed are named');
    ok(await card(page).locator('.impact__live').getAttribute('aria-live') === 'polite', 'the honesty line and the notes are a polite live region');
    ok(await card(page).getByRole('button', { name: 'Keep as baseline' }).isEnabled(), 'Keep is available once the updated plant is ready');
    ok(await hint(page).isVisible(), 'the one-line hint shows under the simulation bar');
    ok(/Before → after/.test(await hint(page).innerText()), `hint: ${await hint(page).innerText()}`);
    const toast = page.locator('.toast').filter({ hasText: 'Plant changed: Add Goods in 2.' });
    eq(await toast.count(), 1, 'one toast tells what happened');
    ok((await toast.innerText()).includes('Updated simulation is warmed up – see Results for the effect.'), 'toast wording');
    ok(await toast.getByRole('button', { name: 'See effect' }).isVisible(), 'toast offers "See effect"');
    await card(page).scrollIntoViewIfNeeded();
    await snap(page, '01-effect-light');
    await hint(page).getByRole('button', { name: 'Hide this hint' }).click();
    ok(await hint(page).isHidden(), 'the hint can be closed on its own ...');
    ok(await card(page).isVisible(), '... and the card stays');

    // edit 2: a goods-out and its flow with the real tools, while the first comparison is still open -> the ORIGINAL baseline stays
    await mark(page);
    const [placed, connected] = await addGoodsOutWithTools(page);
    ok(placed && connected && placed !== connected, `the tools made two edits: "${placed}", "${connected}"`);
    await swapped(page);
    await page.waitForFunction((n) => window.__logiplan.runner.baseline.labels.length >= n, 3, { timeout: 10000 });
    await page.waitForFunction(() => !window.__logiplan.runner.priming);
    const afterSecond = await runnerState(page);
    eq(afterSecond.baseline.labels, ['Add Goods in 2', placed, connected], 'all edits are listed');
    eq(afterSecond.baseline.simTime, afterFirst.baseline.simTime, 'the baseline is still the one from before the first edit');
    eq(afterSecond.baseline.throughput, afterFirst.baseline.throughput, 'with the same numbers');
    ok(afterSecond.baseline.edits >= 2, `${afterSecond.baseline.edits} warm restarts counted`);
    await page.waitForFunction((text) => document.querySelector('#panel-results [data-panel=impact] .impact__labels')?.textContent === text, describeLabels(['Add Goods in 2', placed, connected]));
    ok(true, 'the card lists the edits');
    ok(await hint(page).isVisible(), 'the next edit brings the hint back');

    // edit 3: a forklift fleet through the real Fleet tab
    await mark(page);
    await tab(page, 'fleet');
    await page.getByRole('button', { name: 'Choose another vehicle type' }).click();
    await page.getByRole('menuitem', { name: /Forklift/ }).click();
    await swapped(page);
    const afterThird = await runnerState(page);
    eq(afterThird.baseline.labels, ['Add Goods in 2', placed, connected, 'Add Forklift fleet'], 'the fleet is the last edit');
    eq(afterThird.baseline.simTime, afterFirst.baseline.simTime, 'still the original baseline');
    await tab(page, 'results');
    eq(await card(page).locator('.impact__labels').innerText(), describeLabels(['Add Goods in 2', placed, connected, 'Add Forklift fleet']), 'the card names three and counts the rest');
    ok((await card(page).locator('.impact__labels').innerText()).endsWith('and 1 more'), 'more than three edits: "and 1 more"');

    // the card is a snapshot of the same window for both plants: it does not drift while the simulation runs on
    const figuresBefore = await card(page).locator('.impact__rows').innerText();
    await page.locator('.simbar__speed').selectOption('1200');
    await page.waitForFunction(() => window.__logiplan.runner.kpis().window.duration >= 1500, null, { timeout: 60000 });
    eq(await card(page).locator('.impact__rows').innerText(), figuresBefore, 'the figures of the card stay the same while the simulation runs on (the live numbers are in the sections below)');
    await card(page).scrollIntoViewIfNeeded();
    await snap(page, '02-measured-light');

    // "Compare properly…": the old plant becomes a variant next to the current one, ticked, and the running simulation is not touched
    const scenariosBefore = await page.evaluate(() => { window.__before = window.__logiplan.runner.sim; return window.__logiplan.store.getState().project.scenarios.length; });
    await card(page).getByRole('button', { name: 'Compare properly…' }).click();
    eq(await page.evaluate(() => window.__logiplan.store.getState().ui.rightTab), 'experiments', '"Compare properly…" opens the Experiments tab');
    const compare = await page.evaluate(() => {
      const s = window.__logiplan.store.getState();
      return { scenarios: s.project.scenarios.map((x) => x.name), active: s.project.scenarios.find((x) => x.id === s.project.activeId).name, same: window.__logiplan.runner.sim === window.__before, playing: window.__logiplan.runner.playing, stations: s.project.scenarios.map((x) => x.layout.stations.length) };
    });
    eq(scenariosBefore, 1, 'one plant before');
    eq(compare.scenarios.length, 2, 'now two variants');
    ok(/^Before: Add Goods in 2 and \d+ more$/.test(compare.scenarios[1]), `the old plant is named by the edits: "${compare.scenarios[1]}"`);
    ok(compare.stations[1] < compare.stations[0], `and is the plant without the new stations (${compare.stations[1]} < ${compare.stations[0]} stations)`);
    eq(compare.active, compare.scenarios[0], 'the planner stays on the current plant');
    ok(compare.same && compare.playing, 'the running simulation was not restarted by adding the variant');
    const ticked = await page.locator('#panel-experiments [data-cmp=variants] input[type=checkbox]').evaluateAll((els) => els.map((e) => e.checked));
    eq(ticked, [true, true], 'both plants are ticked in the Experiments tab');
    ok(!/Create a variant to compare/.test(await page.locator('#panel-experiments').innerText()), 'and nothing asks for a variant any more');
    await snap(page, '08-compare-properly');
    await tab(page, 'results');
    await card(page).getByRole('button', { name: 'Compare properly…' }).click();
    eq(await page.evaluate(() => window.__logiplan.store.getState().project.scenarios.length), 2, 'a second click does not add a second copy');
    await tab(page, 'results');

    // Keep as baseline: the card goes, the current numbers become the reference of the next edit
    await card(page).getByRole('button', { name: 'Keep as baseline' }).click();
    await page.waitForFunction(() => document.querySelector('#panel-results [data-panel=impact]').hidden);
    const kept = await runnerState(page);
    eq(kept.baseline.labels, [], 'kept: nothing to name any more');
    ok(kept.baseline.simTime > afterFirst.baseline.simTime, 'the kept numbers are newer');
    ok(await page.locator('.toast').filter({ hasText: 'Kept as baseline' }).count() >= 1, 'a toast confirms it');
    ok(await hint(page).isHidden(), 'the hint goes with the card');
    await mark(page);
    await page.evaluate(async () => {
      const M = await import('/js/model/layout.js');
      window.__logiplan.store.commit('Change process time of Machining', (l) => { l.stations.find((s) => s.name === 'Machining').params.cycle.mean = 55; });
    });
    await swapped(page);
    const afterKeep = await runnerState(page);
    eq(afterKeep.baseline.labels, ['Change process time of Machining'], 'the next edit is compared with the kept numbers');
    eq(afterKeep.baseline.simTime, kept.baseline.simTime, 'the kept baseline is the reference');
    await page.waitForFunction(() => !document.querySelector('#panel-results [data-panel=impact]').hidden);

    // Dismiss: the card goes, the next edit is compared with what was just before it
    await card(page).getByRole('button', { name: 'Dismiss' }).click();
    await page.waitForFunction(() => document.querySelector('#panel-results [data-panel=impact]').hidden);
    eq((await runnerState(page)).baseline, null, 'dismissed: no baseline');
    ok(await hint(page).isHidden(), 'the hint goes too');
    ok(await page.evaluate(() => document.activeElement && document.activeElement.id === 'tab-results'), 'keyboard focus moved to the Results tab instead of getting lost');
    noErrors('scenario');
    await context.close();
  });

  // ---------------------------------------------------------------------------------------------------------------
  // The switch, undo, reset, cold starts
  // ---------------------------------------------------------------------------------------------------------------
  await run('controls', async () => {
    const { page, context } = await openApp();
    await startExample(page, 'two-lines', { tabName: 'simulate' });
    const sw = page.getByLabel('Keep results warm after edits');
    const clickSwitch = () => page.locator('label.switch', { hasText: 'Keep results warm after edits' }).click(); // as a person does: on the label
    ok(await sw.isChecked(), 'on by default');
    ok((await page.locator('#panel-simulate').innerText()).includes('first runs silently for 20 min'), 'one sentence explains it, with the length of the pre-roll');
    await page.locator('label.switch', { hasText: 'Keep results warm after edits' }).scrollIntoViewIfNeeded();
    await snap(page, '03-simulate-switch');

    // warm restart off: the old behaviour (empty plant, clock back at 0:00, a message that says so)
    await clickSwitch();
    ok(!(await sw.isChecked()), 'the switch is off');
    eq(await page.evaluate(() => window.__logiplan.store.getState().ui.warmRestart), false, 'the switch writes the preference');
    await mark(page);
    await page.evaluate(async () => {
      const M = await import('/js/model/layout.js');
      window.__logiplan.store.commit('Add Goods in 2', (l) => {
        M.paintRoadPath(l, [[27, 6], [27, 4]]);
        const gi = M.addStation(l, { type: 'source', name: 'Goods in 2', x: 26, y: 2, w: 3, h: 2 });
        M.addFlow(l, gi.id, l.stations.find((s) => s.name === 'Central warehouse').id, {});
      });
    });
    await swapped(page);
    const cold = await runnerState(page);
    ok(cold.time < 60, `cold restart: the clock went back to the start (${cold.time.toFixed(1)} s)`);
    eq(cold.warm, null, 'not a warm simulation');
    eq(cold.baseline, null, 'and there is nothing to compare');
    ok(cold.playing, 'it keeps running');
    await page.locator('.toast').filter({ hasText: 'Plant changed: Add Goods in 2. Simulation reset to an empty plant at 0:00.' }).waitFor();
    ok(true, 'cold toast: "Plant changed: Add Goods in 2. Simulation reset to an empty plant at 0:00."');
    await tab(page, 'results');
    ok(await card(page).isHidden(), 'no impact card after a cold restart');
    await page.waitForFunction(() => /Warming up|Not counted yet/.test(document.querySelector('#panel-results').innerText), null, { timeout: 5000 });
    ok(true, 'Results are in the old state: warming up from an empty plant');

    // the preference survives a reload
    await page.waitForTimeout(700);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
    eq(await page.evaluate(() => window.__logiplan.store.getState().ui.warmRestart), false, 'the preference is remembered across a reload');
    await page.keyboard.press('Escape');

    // back on, and the explicit Reset button stays cold: empty plant, message, no baseline
    await tab(page, 'simulate');
    await page.locator('label.switch', { hasText: 'Keep results warm after edits' }).click();
    ok(await page.getByLabel('Keep results warm after edits').isChecked(), 'the switch is on again');
    eq(await page.evaluate(() => window.__logiplan.store.getState().ui.warmRestart), true, 'switched on again');
    await page.locator('.simbar__speed').selectOption('1200');
    await page.locator('.simbar').getByRole('button', { name: 'Run simulation' }).click();
    await waitSim(page, 1500);
    await mark(page);
    await page.evaluate(async () => {
      window.__logiplan.store.commit('Change process time of Machining', (l) => { l.stations.find((s) => s.name === 'Machining').params.cycle.mean = 55; });
    });
    await swapped(page);
    ok((await runnerState(page)).baseline, 'a baseline exists after a warm restart');
    await page.locator('.toast').filter({ hasText: 'Updated simulation is warmed up' }).getByRole('button', { name: 'See effect' }).click();
    eq(await page.evaluate(() => window.__logiplan.store.getState().ui.rightTab), 'results', '"See effect" in the toast opens the Results tab');
    await page.getByRole('button', { name: 'Reset simulation' }).click();
    await page.locator('.toast').filter({ hasText: 'Simulation reset to an empty plant at 0:00.' }).first().waitFor();
    const reset = await runnerState(page);
    eq(reset.time, 0, 'reset: clock at 0:00');
    eq(reset.baseline, null, 'reset: the baseline is dropped');
    eq(reset.warm, null, 'reset: a cold simulation');
    ok(!reset.playing, 'reset: paused');

    // the first play after loading a plant stays a cold start, and the first edit before anything ran is cold too
    await page.locator('.simbar').getByRole('button', { name: 'Run simulation' }).click();
    await page.waitForFunction(() => window.__logiplan.runner.time > 0 && window.__logiplan.runner.time < 100);
    ok(true, 'the next play starts from 0:00');

    // undo of a warm restart is itself a warm restart that names the undo
    await waitSim(page, 1500);
    await mark(page);
    await page.evaluate(async () => {
      window.__logiplan.store.commit('Change process time of Machining', (l) => { l.stations.find((s) => s.name === 'Machining').params.cycle.mean = 50; });
    });
    await swapped(page);
    await mark(page);
    await page.keyboard.press('Control+z');
    await swapped(page);
    const undone = await runnerState(page);
    eq(undone.baseline.labels, ['Change process time of Machining', 'Undo Change process time of Machining'], 'undo is an edit too, and named as such');
    noErrors('controls');
    await context.close();
  });

  // ---------------------------------------------------------------------------------------------------------------
  // The case that started it all: a new goods-in nothing is connected to. The card says nothing changed, the insights say why.
  // ---------------------------------------------------------------------------------------------------------------
  await run('unconnected', async () => {
    const { page, context } = await openApp();
    await startExample(page, 'two-lines', { tabName: 'results', speed: 600, seconds: 1500 });
    // an edit that cannot matter (a parking place no vehicle uses): the card says so and where to look if an effect was expected
    await mark(page);
    await page.evaluate(async () => {
      const M = await import('/js/model/layout.js');
      window.__logiplan.store.commit('Add parking', (l) => {
        M.paintRoadPath(l, [[36, 6], [36, 4]]);
        M.addStation(l, { type: 'depot', name: 'Unused parking', x: 35, y: 2, w: 3, h: 2, params: { slots: 4, chargers: 0 } });
      });
    });
    await swapped(page);
    await page.waitForFunction(() => /No figure changed clearly/.test(document.querySelector('#panel-results [data-panel=impact]')?.innerText || ''), null, { timeout: 15000 });
    ok(true, 'the card says that no figure changed clearly');
    ok(/Checks tab/.test(await card(page).locator('.impact__note').innerText()), 'and points to the Checks tab');
    await card(page).scrollIntoViewIfNeeded();
    await snap(page, '07-nothing-changed');

    // a goods-in that nothing is connected to: loads pile up in its yard, the insights say why
    await mark(page);
    await page.evaluate(async () => {
      const M = await import('/js/model/layout.js');
      window.__logiplan.store.commit('Add goods in', (l) => {
        M.paintRoadPath(l, [[27, 6], [27, 4]]);
        M.addStation(l, { type: 'source', name: 'Lonely goods in', x: 26, y: 2, w: 3, h: 2, params: { interArrival: { kind: 'const', mean: 60, spread: 0 }, outCap: 4 } });
      });
    });
    await swapped(page);
    await page.waitForFunction(() => window.__logiplan.runner.insights().some((i) => i.id.startsWith('source-unconnected-activity:')), null, { timeout: 90000 });
    await page.waitForFunction(() => /no flow takes them away/.test(document.querySelector('#panel-results [data-insight^="source-unconnected-activity:"]')?.textContent || ''), null, { timeout: 10000 });
    const text = await page.locator('#panel-results [data-insight^="source-unconnected-activity:"]').innerText();
    ok(/Lonely goods in receives loads, but no flow takes them away/.test(text), `the insight explains it: ${text.split('\n')[0]}`);
    ok(!(await page.locator('#panel-results [data-insight^="supply:"]').count()), 'and the goods-in is not also said to deliver more than the plant takes');
    eq(await card(page).locator('.impact__labels').innerText(), 'Add parking, Add goods in', 'the card names both edits');
    noErrors('unconnected');
    await context.close();
  });

  // ---------------------------------------------------------------------------------------------------------------
  // The fleet status strip and the insights about unused resources
  // ---------------------------------------------------------------------------------------------------------------
  await run('fleet', async () => {
    const { page, context } = await openApp();
    await startExample(page, 'two-lines', { tabName: 'fleet', seconds: 1500 });
    await page.waitForFunction(() => document.querySelectorAll('#panel-fleet [data-fleet-status]:not([hidden])').length === 2, null, { timeout: 10000 });
    const strips = await page.locator('#panel-fleet [data-fleet-status]').evaluateAll((els) => els.map((el) => ({
      id: el.dataset.fleetStatus, chips: [...el.querySelectorAll('.fleet-status__chip:not([hidden])')].map((c) => c.textContent.trim()), facts: [...el.querySelectorAll('.fleet-status__fact:not([hidden])')].map((f) => f.textContent.trim()),
    })));
    eq(strips.length, 2, 'one strip per fleet card');
    for (const s of strips) {
      const words = s.chips.map((c) => c.replace(/^\d+ /, ''));
      ok(['working', 'waiting', 'idle', 'parked'].every((w) => words.includes(w)), `${s.id}: chips say working, waiting, idle and parked: ${s.chips.join(' | ')}`);
      ok(s.facts.some((f) => /^\d+ trips? so far$/.test(f)), `${s.id}: trips so far: ${s.facts.join(' | ')}`);
      ok(s.facts.some((f) => /^[\d.]+ trips? per vehicle and hour$/.test(f)), `${s.id}: trips per vehicle and hour`);
    }
    ok(strips.some((s) => s.facts.some((f) => /^lowest battery \d+ %$/.test(f))), 'the AGV fleet (battery on) shows its lowest battery');
    // the counts add up to the vehicles of the fleet
    const sums = await page.evaluate(() => [...document.querySelectorAll('#panel-fleet [data-fleet-status]')].map((el) => {
      const total = [...el.querySelectorAll('.fleet-status__chip')].filter((c) => !c.hidden).reduce((n, c) => n + Number(c.textContent.trim().split(' ')[0]), 0);
      const fleet = window.__logiplan.store.getState().layout.fleets.find((f) => f.id === el.dataset.fleetStatus);
      return { total, count: fleet.count };
    }));
    for (const s of sums) eq(s.total, s.count, 'the chips add up to the vehicle count');
    await snap(page, '04-fleet-strip');

    // a fleet nobody needs: five AGVs carry everything of the Starter plant, three forklifts that stay at the depot hardly get a job
    await startExample(page, 'starter', { tabName: 'fleet', speed: 1200, seconds: 1500 });
    await page.evaluate(async () => {
      const M = await import('/js/model/layout.js');
      window.__logiplan.store.commit('Add Forklift fleet', (l) => {
        M.updateFleet(l, l.fleets[0].id, { count: 5 });
        M.addFleet(l, 'forklift', { name: 'Forklifts', count: 3, home: l.stations.find((s) => s.type === 'depot').id, idle: 'stay' });
      });
    });
    await page.waitForFunction(() => window.__logiplan.runner.warm && !window.__logiplan.runner.priming);
    await page.waitForFunction(() => window.__logiplan.runner.insights().some((i) => i.id.startsWith('fleet-unused:')), null, { timeout: 90000 });
    await page.waitForFunction(() => document.querySelector('#panel-fleet .fleet-status__badge:not([hidden])'), null, { timeout: 10000 });
    await page.evaluate(() => window.__logiplan.runner.pause()); // the strip is repainted at 4 Hz: compare it with the insights of a simulation that stands still
    await page.waitForTimeout(700);
    const insightIds = await page.evaluate(() => window.__logiplan.runner.insights().map((i) => i.id));
    const badges = await page.evaluate(() => [...document.querySelectorAll('#panel-fleet [data-fleet-status]')].map((el) => ({ id: el.dataset.fleetStatus, badge: el.querySelector('.fleet-status__badge:not([hidden])')?.textContent || '', title: el.querySelector('.fleet-status__badge:not([hidden])')?.title || '' })));
    eq(badges.length, 2, 'two fleet cards');
    // the strip says what Results say: the most specific idle verdict of the fleet, in the same order as js/ui/panels/fleet-status.js
    for (const b of badges) {
      const has = (rule) => insightIds.includes(`${rule}:${b.id}`);
      const expected = has('fleet-no-jobs') ? 'no jobs' : has('fleet-unused') ? 'barely used' : has('vehicle-idle-some') ? 'some idle' : has('fleet-oversized') ? 'mostly idle' : '';
      ok(b.badge === expected && (expected === '' || b.title.length > 20), `badge of ${b.id} agrees with the insights (${b.badge || 'none'}; insights: ${insightIds.filter((i) => i.endsWith(`:${b.id}`)).join(', ') || 'none'})`);
    }
    const unusedBadge = badges.find((b) => b.badge === 'barely used');
    ok(unusedBadge && /hardly work/.test(unusedBadge.title) && /Fleet → Jobs this fleet serves/.test(unusedBadge.title), `the badge explains why: ${unusedBadge && unusedBadge.title}`);
    ok(!insightIds.some((id) => id.startsWith('fleet-oversized:') && insightIds.includes(`fleet-unused:${id.split(':')[1]}`)), 'no fleet is both unused and oversized');
    await page.locator('#panel-fleet .fleet-status__badge', { hasText: 'barely used' }).scrollIntoViewIfNeeded();
    await snap(page, '06-fleet-barely-used');
    // the same verdict in the Results tab, with its advice
    await tab(page, 'results');
    await page.waitForFunction(() => /hardly work/.test(document.querySelector('#panel-results [data-insight^="fleet-unused:"]')?.textContent || ''), null, { timeout: 10000 });
    ok(true, 'the Insights list on the Results tab says the same');
    noErrors('fleet');
    await context.close();
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Screenshots: desktop, narrow, light, dark
  // ---------------------------------------------------------------------------------------------------------------
  await run('shots', async () => {
    for (const [name, viewport, colorScheme, panel] of [
      ['desktop-dark', DESKTOP, 'dark', 'results'], ['narrow-light', NARROW, 'light', 'results'], ['narrow-dark', NARROW, 'dark', 'results'], ['narrow-fleet', NARROW, 'light', 'fleet'],
    ]) {
      const { page, context } = await openApp({ viewport, colorScheme });
      await startExample(page, 'two-lines', { tabName: panel, speed: 1200, seconds: 1500, drawerClosed: viewport.width < 600 });
      await page.evaluate(async () => {
        const M = await import('/js/model/layout.js');
        window.__logiplan.store.commit('Add Forklift fleet', (l) => { M.addFleet(l, 'forklift', { name: 'Forklifts 2', count: 2, home: l.stations.find((s) => s.name === 'Forklift park').id }); });
        window.__logiplan.store.commit('Change process time of Press line', (l) => { l.stations.find((s) => s.name === 'Press line').params.cycle.mean = 40; });
      });
      await page.waitForFunction(() => window.__logiplan.runner.warm && !window.__logiplan.runner.priming && window.__logiplan.runner.baseline);
      await page.locator('.toast').first().waitFor();
      if (viewport.width < 600) {
        await page.locator('.topbar__panel-toggle').click();
        await page.waitForTimeout(400);
      }
      await page.waitForTimeout(600);
      if (panel === 'results') {
        ok(await card(page).isVisible(), `${name}: the card is visible`);
        const wide = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        ok(wide <= 0, `${name}: no horizontal page scroll (${wide} px)`);
        const box = await card(page).boundingBox();
        ok(box.x >= 0 && box.x + box.width <= viewport.width + 1, `${name}: the card fits the width (${Math.round(box.x)}..${Math.round(box.x + box.width)} of ${viewport.width})`);
      }
      await snap(page, name);
      noErrors(`shots ${name}`);
      await context.close();
    }
    // the "Updating…" state of the simulation bar, caught in the middle of the pre-roll of the biggest example
    const { page, context } = await openApp();
    await startExample(page, 'two-lines', { tabName: 'results', speed: 1200, seconds: 1500 });
    await page.evaluate(async () => {
      const M = await import('/js/model/layout.js');
      window.__logiplan.store.commit('Add Forklift fleet', (l) => { M.addFleet(l, 'forklift', { name: 'Forklifts 2', count: 2 }); });
    });
    await page.waitForFunction(() => window.__logiplan.runner.priming, null, { polling: 'raf', timeout: 5000 });
    eq(await page.locator('.simbar > .chip[role=status]').innerText(), 'Updating…', 'while priming the chip says Updating…');
    await snap(page, '05-updating-chip', { clip: { x: 0, y: 0, width: 760, height: 160 } });
    await page.waitForFunction(() => !window.__logiplan.runner.priming);
    ok((await page.locator('.simbar > .chip[role=status]').innerText()) === 'Running', 'and Running again afterwards');
    noErrors('shots updating');
    await context.close();
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Cost: pre-roll on the three examples and on a 160 x 160 plant with 100 vehicles; frame times while priming
  // ---------------------------------------------------------------------------------------------------------------

  /** A page script (before the app loads): measure every animation-frame callback and every long task, tagged with "priming". */
  const frameProbe = () => {
    window.__probe = { callbacks: [], intervals: [], long: [], last: 0 };
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => raf((t) => {
      const p = window.__probe;
      const priming = Boolean(window.__logiplan && window.__logiplan.runner.priming);
      if (p.last) p.intervals.push([t - p.last, priming]);
      p.last = t;
      const start = performance.now();
      try { cb(t); } finally { p.callbacks.push([performance.now() - start, priming]); }
    });
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__probe.long.push([e.startTime, e.duration, Boolean(window.__logiplan && window.__logiplan.runner.priming)]); }).observe({ type: 'longtask', buffered: true });
    } catch { /* long tasks are not reported: the callback timings remain */ }
  };

  const percentile = (list, p) => { const s = list.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };

  /** Edit a running plant `rounds` times (one more vehicle each time) and measure what the pre-roll costs in the page. */
  async function measurePriming(page, rounds) {
    const out = [];
    for (let i = 0; i < rounds; i++) {
      await page.evaluate(() => { window.__probe.callbacks.length = 0; window.__probe.intervals.length = 0; window.__probe.long.length = 0; window.__rec = { firstPriming: 0, swapped: 0, frames: 0, edit: performance.now() }; });
      await page.evaluate(() => {
        const r = window.__logiplan.runner;
        r.on('rebuild', (e) => { if (e.warm && !window.__rec.swapped) window.__rec.swapped = performance.now(); });
        const tick = () => {
          if (r.priming) { window.__rec.frames++; if (!window.__rec.firstPriming) window.__rec.firstPriming = performance.now(); }
          if (!window.__rec.swapped) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        window.__logiplan.store.commit(`One more vehicle ${Math.random()}`, (l) => { l.fleets[0].count += 1; });
      });
      await page.waitForFunction(() => window.__rec.swapped, null, { timeout: 120000, polling: 100 });
      await page.waitForTimeout(150);
      out.push(await page.evaluate(() => {
        const p = window.__probe;
        const during = (list) => list.filter((x) => x[x.length - 1]).map((x) => x[0]);
        const outside = (list) => list.filter((x) => !x[x.length - 1]).map((x) => x[0]);
        return {
          editToSwap: window.__rec.swapped - window.__rec.edit, primingMs: window.__rec.swapped - window.__rec.firstPriming, primingFrames: window.__rec.frames,
          callbacks: during(p.callbacks), intervals: during(p.intervals), idleIntervals: outside(p.intervals), idleCallbacks: outside(p.callbacks), longTasks: p.long.map((l) => l[1]),
        };
      }));
    }
    return out;
  }

  const summarize = (rounds) => {
    const callbacks = rounds.flatMap((r) => r.callbacks);
    const intervals = rounds.flatMap((r) => r.intervals);
    return {
      editToSwapMs: rounds.map((r) => Math.round(r.editToSwap)), primingMs: rounds.map((r) => Math.round(r.primingMs)), primingFrames: rounds.map((r) => r.primingFrames),
      callbackMax: Math.round(Math.max(0, ...callbacks) * 10) / 10, callbackP95: Math.round(percentile(callbacks, 0.95) * 10) / 10,
      intervalMax: Math.round(Math.max(0, ...intervals) * 10) / 10, intervalP95: Math.round(percentile(intervals, 0.95) * 10) / 10,
      idleIntervalMax: Math.round(Math.max(0, ...rounds.flatMap((r) => r.idleIntervals)) * 10) / 10, idleCallbackMax: Math.round(Math.max(0, ...rounds.flatMap((r) => r.idleCallbacks)) * 10) / 10,
      longTasks: rounds.flatMap((r) => r.longTasks).map((d) => Math.round(d)),
    };
  };

  /** The big plant of the cost measurement: streets every 12 cells on a 160 x 160 baseplate, 48 stations on bays, one fleet of 100 AGVs. */
  function bigPlant(vehicles = 100) {
    const layout = L.createLayout({ name: 'Big plant', cols: 160, rows: 160, cellSize: 2 });
    for (let k = 4; k < 160; k += 12) {
      L.paintRoadPath(layout, [[2, k], [157, k]]);
      L.paintRoadPath(layout, [[k, 2], [k, 157]]);
    }
    const sources = []; const procs = []; const sinks = []; const depots = [];
    let n = 0;
    const place = (type, name, x, y, params, bay) => {
      const st = L.addStation(layout, { type, name, x, y, w: 3, h: 2, params });
      if (!st) throw new Error(`station ${name}`);
      L.paintRoadPath(layout, bay);
      return st;
    };
    for (let row = 0; row < 12; row++) {
      const y = 4 + row * 12 + 3;
      [8, 44, 80, 116].forEach((x, i) => {
        const bay = [[x + 1, 4 + row * 12], [x + 1, y]];
        if (row % 4 === 0 && i === 0) sources.push(place('source', `In ${n++}`, x, y + 1, { interArrival: { kind: 'normal', mean: 40, spread: 0.2 }, outCap: 6 }, bay));
        else if (row % 4 === 3 && i === 3) sinks.push(place('sink', `Out ${n++}`, x, y + 1, {}, bay));
        else if (row % 3 === 1 && i === 1) depots.push(place('depot', `Depot ${n++}`, x, y + 1, { slots: 20, chargers: 0 }, bay));
        else procs.push(place('process', `Work ${n++}`, x, y + 1, { cycle: { kind: 'normal', mean: 60, spread: 0.1 }, inCap: 4, outCap: 4, machines: 2 }, bay));
      });
    }
    procs.forEach((p, i) => L.addFlow(layout, (i < 3 ? sources[i % sources.length] : procs[i - 3]).id, p.id, {}));
    procs.slice(-6).forEach((p, i) => L.addFlow(layout, p.id, sinks[i % sinks.length].id, {}));
    L.addFleet(layout, 'agv', { name: 'AGVs', count: vehicles, home: depots[0].id });
    return layout;
  }

  await run('perf', async () => {
    const results = {};
    const { page, context } = await openApp({ init: frameProbe });
    // the frame times while priming, on the Two lines example: the acceptance figure
    await startExample(page, 'two-lines', { tabName: 'results', speed: 600, seconds: 1500 });
    const two = summarize(await measurePriming(page, 4));
    results['two-lines'] = two;
    console.log(`   Two lines: edit -> swap ${two.editToSwapMs.join(', ')} ms, priming ${two.primingMs.join(', ')} ms in ${two.primingFrames.join(', ')} frames; frame callback max ${two.callbackMax} ms (p95 ${two.callbackP95}), frame interval max ${two.intervalMax} ms (p95 ${two.intervalP95}; while not priming: max ${two.idleIntervalMax}, callback max ${two.idleCallbackMax}), long tasks ${JSON.stringify(two.longTasks)}`);
    ok(two.callbackMax < FRAME_LIMIT_MS, `no frame callback over ${FRAME_LIMIT_MS} ms while priming Two lines: max ${two.callbackMax} ms`);
    ok(two.longTasks.every((d) => d <= FRAME_LIMIT_MS + 1), `no long task over ${FRAME_LIMIT_MS} ms: ${JSON.stringify(two.longTasks)}`);
    ok(two.editToSwapMs.every((ms) => ms <= SHOW_WITHIN_MS), `every edit is shown within ${SHOW_WITHIN_MS} ms: ${two.editToSwapMs.join(', ')}`);

    // the other examples
    for (const example of EXAMPLES.filter((e) => e.id !== 'two-lines')) {
      await startExample(page, example.id, { tabName: 'results', speed: 600, seconds: 1500 });
      const r = summarize(await measurePriming(page, 2));
      results[example.id] = r;
      console.log(`   ${example.name}: edit -> swap ${r.editToSwapMs.join(', ')} ms, priming ${r.primingMs.join(', ')} ms in ${r.primingFrames.join(', ')} frames; callback max ${r.callbackMax} ms, interval max ${r.intervalMax} ms`);
      ok(r.callbackMax < FRAME_LIMIT_MS, `${example.id}: no frame callback over ${FRAME_LIMIT_MS} ms while priming: ${r.callbackMax} ms`);
    }

    // the engine alone (no page): the cost of building and pre-rolling in Node, cold and warm
    const node = {};
    for (const example of EXAMPLES) {
      const layout = example.build();
      const times = [];
      for (let i = 0; i < 3; i++) {
        let t = performance.now();
        const sim = new Simulation(layout);
        const build = performance.now() - t;
        t = performance.now();
        sim.advance(1200);
        times.push([Math.round(build * 10) / 10, Math.round(performance.now() - t)]);
      }
      node[example.id] = times;
      console.log(`   Node, ${example.id}: build ${times.map((x) => x[0]).join(' / ')} ms, pre-roll of 1200 s ${times.map((x) => x[1]).join(' / ')} ms (1st / 2nd / 3rd run)`);
    }
    results.node = node;

    // the big plant
    const big = bigPlant(100);
    {
      let t = performance.now();
      const sim = new Simulation(big);
      const build = performance.now() - t;
      t = performance.now();
      sim.advance(1200);
      results.bigNode = { buildMs: Math.round(build), prerollMs: Math.round(performance.now() - t), vehicles: sim.vehicles.length, stations: big.stations.length, roadCells: Object.keys(big.roads).length };
      console.log(`   Node, 160 x 160 plant with ${sim.vehicles.length} vehicles (${big.stations.length} stations, ${results.bigNode.roadCells} road cells): build ${results.bigNode.buildMs} ms, pre-roll of 1200 s ${results.bigNode.prerollMs} ms`);
    }
    await page.evaluate((layout) => { window.__logiplan.store.newProject(layout, 'Big plant'); }, big);
    await page.locator('.simbar__speed').selectOption('600');
    if (!(await page.evaluate(() => window.__logiplan.runner.playing))) await page.locator('.simbar').getByRole('button', { name: 'Run simulation' }).click();
    await waitSim(page, 400);
    const bigRounds = await measurePriming(page, 2);
    const bigSummary = summarize(bigRounds);
    results.bigPlant = bigSummary;
    const sorted = bigRounds.flatMap((r) => r.callbacks).sort((a, b) => b - a);
    console.log(`   Browser, 160 x 160 plant, 100 vehicles: edit -> swap ${bigSummary.editToSwapMs.join(', ')} ms, priming ${bigSummary.primingMs.join(', ')} ms in ${bigSummary.primingFrames.join(', ')} frames; callback max ${bigSummary.callbackMax} ms (the slowest three: ${sorted.slice(0, 3).map((x) => x.toFixed(0)).join(', ')} ms), p95 ${bigSummary.callbackP95} ms`);
    ok(bigSummary.callbackP95 < 40, `the big plant stays interactive while priming: p95 frame callback ${bigSummary.callbackP95} ms`);
    ok(bigSummary.editToSwapMs.every((ms) => ms < 30000), 'and the pre-roll finishes');

    // a pre-roll that takes longer than 600 ms shows how far it has come, in steps of 20 % (a what-if moved first: the old plant is simulated again too)
    await page.evaluate(() => {
      const s = window.__logiplan.store;
      s.commit('Demand', (l) => { l.settings.demandFactor = 1.25; });
      s.commit('One more vehicle, again', (l) => { l.fleets[0].count += 1; });
    });
    await page.waitForFunction(() => /^Updating… \d+ %$/.test(document.querySelector('.simbar > .chip[role=status]')?.textContent || ''), null, { polling: 'raf', timeout: 15000 });
    const progress = await page.locator('.simbar > .chip[role=status]').innerText();
    ok(/^Updating… (20|40|60|80) %$/.test(progress), `the chip of a slow pre-roll shows its progress in steps of 20 %: "${progress}"`);
    await snap(page, '09-updating-progress', { clip: { x: 0, y: 0, width: 760, height: 160 } });
    await page.waitForFunction(() => !window.__logiplan.runner.priming, null, { timeout: 30000 });
    eq(await page.locator('.simbar > .chip[role=status]').innerText(), 'Running', 'and Running again afterwards');
    writeFileSync(path.join(OUT, 'edit-feedback-perf.json'), JSON.stringify(results, null, 2));
    noErrors('perf');
    await context.close();
  });

  console.log(`\n${checks} checks passed`);
}, { viewport: DESKTOP });
