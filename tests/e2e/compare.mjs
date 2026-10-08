// Behavioural + visual check of the Experiments tab (js/ui/compare.js) and the report (js/ui/report.js) in real Chromium.
// Run: node tests/e2e/compare.mjs [section]
//   sections: initial compare progress cancel stale sweep apply persist errors golden report exports a11y shots
// Screenshots: e2e-output/compare-*.png (open them and look). Uses the real store, runner, renderer and the REAL simulation
// experiments (js/sim/experiments.js); only the shell (ctx) is faked (tests/e2e/compare-harness.html). Runs are kept short:
// the harness plant is the congestion lab with doubled demand, experiments of 2 h with 2 repetitions take about 3 s.
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { withBrowser, OUT } from './browser.mjs';
import { importProject } from '../../js/model/serialize.js';

const only = process.argv[2] || '';
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

await withBrowser(async ({ page, context, url, errors, shot }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // Playwright's Locator has no isFocused(); this one is true when the element is document.activeElement
  Object.getPrototypeOf(page.locator('body')).isFocused = function isFocused() { return this.evaluate((el) => el === document.activeElement); };

  // ---- helpers ---------------------------------------------------------------------------------------
  const P = page.locator('[data-panel="experiments"]');
  const cmp = (name) => P.locator(`[data-cmp="${name}"]`);
  const runBtn = cmp('run');
  const lay = () => page.evaluate(() => structuredClone(window.harness.store.getState().layout));
  const fleetCount = async () => (await lay()).fleets[0].count;
  const undoLabel = () => page.evaluate(() => window.harness.store.getState().undoLabel);
  const toasts = () => page.evaluate(() => structuredClone(window.harness.toasts));
  const idle = () => page.waitForFunction(() => document.querySelector('[data-panel="experiments"]').dataset.state === 'idle', null, { timeout: 180000 });
  const edit = (src, arg) => page.evaluate(async ([code, a]) => {
    const L = await import('/js/model/layout.js');
    window.harness.store.commit('Test edit', (d) => new Function('L', 'd', 'a', code)(L, d, a));
  }, [src, arg]);
  const setReps = async (n) => { await P.getByLabel('Repetitions', { exact: true }).fill(String(n)); };
  const setHours = async (h) => { await P.getByLabel('Run length', { exact: true }).fill(String(h)); };
  const mode = (name) => P.getByRole('button', { name, exact: true }).click();
  const text = (loc) => loc.innerText().then((t) => t.replace(/\s+/g, ' ').trim());
  const rowCells = (metric) => P.locator(`[data-cmp="table"] tr[data-metric="${metric}"] td`);
  const cellText = async (metric) => (await rowCells(metric).allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());

  /** Run a comparison with 2 repetitions and wait for the result. */
  const compareRun = async (reps = 2) => {
    await setReps(reps);
    await runBtn.click();
    await cmp('compare-result').waitFor({ state: 'visible', timeout: 180000 });
    await idle();
  };
  const sweepRun = async (reps = 2) => {
    await mode('Parameter sweep');
    await setReps(reps);
    await runBtn.click();
    await cmp('sweep-result').waitFor({ state: 'visible', timeout: 180000 });
    await idle();
  };

  const run = async (name, fn, query = '') => {
    if (only && !name.startsWith(only)) return;
    console.log(`-- ${name}`);
    await page.goto(url(`/tests/e2e/compare-harness.html${query}`));
    await page.waitForFunction(() => window.ready);
    await fn();
  };

  /** Every visible text of `root` against its effective background: the lowest contrast ratio and where. */
  const worstContrast = async (root) => {
    await page.mouse.move(2, 2); // a hovered control has a hover background: measure the resting state
    return contrastOf(root);
  };
  const contrastOf = (root) => page.evaluate((selector) => {
    const parse = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
    const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
    const backdrop = (el) => {
      const layers = [];
      for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { layers.push(c); if (c.a === 1) break; } }
      return layers.reduceRight((acc, c) => over(c, acc), { r: 255, g: 255, b: 255, a: 1 });
    };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    let worst = { ratio: 99, text: '' };
    const walker = document.createTreeWalker(document.querySelector(selector), NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n.textContent.trim();
      const el = n.parentElement;
      if (!t || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden' || el.closest('.sr-only, [hidden], canvas')) continue;
      const fg = parse(getComputedStyle(el).color);
      const bg = backdrop(el);
      const L1 = lum(over(fg, bg));
      const L2 = lum(bg);
      const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      if (ratio < worst.ratio) worst = { ratio, text: t.slice(0, 40), color: getComputedStyle(el).color };
    }
    return worst;
  }, root);

  // ============================================================================================== INITIAL
  await run('initial', async () => {
    eq(await P.locator('[data-cmp="variants"] li').count(), 3, 'a row per scenario');
    eq(await P.locator('[data-cmp="variants"] input:checked').count(), 3, 'all ticked');
    const rows = await P.locator('[data-cmp="variants"] li').allInnerTexts();
    ok(rows[0].includes('Baseline') && rows[0].includes('(open now)'), 'the open variant is marked');
    ok(rows[1].includes('7 AGVs') && rows[2].includes('9 AGVs'));
    eq(await P.getByLabel('Run length', { exact: true }).inputValue(), '2', 'run length follows the plant settings (2 h)');
    eq(await P.getByLabel('Warm-up', { exact: true }).inputValue(), '5', 'warm-up follows the plant settings (5 min)');
    eq(await P.getByLabel('Repetitions', { exact: true }).inputValue(), '3');
    ok(await runBtn.isEnabled(), 'three variants can run');
    ok((await text(cmp('run-note'))).startsWith('9 simulation runs of 2 h each.'), `summary: ${await text(cmp('run-note'))}`);
    ok((await text(P)).includes('Results are measured over the last 1.9 h of each run.'));
    ok(await cmp('empty').isVisible(), 'a hint that nothing ran yet');

    // fewer than two ticked variants: run disabled, with the reason
    await P.locator('[data-scenario] input').nth(1).uncheck();
    await P.locator('[data-scenario] input').nth(2).uncheck();
    ok(await runBtn.isDisabled(), 'one variant cannot be compared');
    ok((await text(cmp('run-note'))).includes('Tick at least two variants'), await text(cmp('run-note')));
    await P.locator('[data-scenario] input').nth(1).check();
    ok(await runBtn.isEnabled());
    eq(await P.locator('[data-cmp="variants"] input:checked').count(), 2);

    // the warm-up has to be shorter than the run
    await P.getByLabel('Warm-up', { exact: true }).fill('200');
    ok(await runBtn.isDisabled(), 'a warm-up longer than the run measures nothing');
    ok((await text(cmp('run-note'))).includes('warm-up must be shorter'));
    await P.getByLabel('Warm-up', { exact: true }).fill('5');
    ok(await runBtn.isEnabled());

    // a new scenario shows up ticked, a deleted one disappears
    await page.evaluate(() => window.harness.store.addScenario('Fourth', null));
    eq(await P.locator('[data-cmp="variants"] li').count(), 4);
    ok(await P.locator('[data-scenario]').last().locator('input').isChecked(), 'new scenarios are ticked');
    await page.evaluate(() => window.harness.store.deleteScenario(window.harness.store.getState().project.activeId));
    eq(await P.locator('[data-cmp="variants"] li').count(), 3);
  });

  await run('initial-single', async () => {
    eq(await P.locator('[data-cmp="variants"] li').count(), 1);
    ok(await runBtn.isDisabled());
    const hint = await text(cmp('variants-hint'));
    ok(hint.includes('Create a variant to compare') && hint.includes('Click the + next to the plant tabs in the top bar'), hint);
    await shot('compare-single-variant');
  }, '?variants=1');

  await run('initial-empty', async () => {
    await page.evaluate(() => window.harness.store.newProject());
    ok(await runBtn.isDisabled(), 'an empty plant has one variant: nothing to compare');
    await mode('Parameter sweep');
    ok(await runBtn.isDisabled());
    ok((await text(cmp('sweep-values'))).includes('nothing to sweep yet'), await text(cmp('sweep-values')));
    eq(await P.getByLabel('Setting to change', { exact: true }).inputValue(), '');
    eq(await text(cmp('sweep-current')), '');
    await shot('compare-empty-plant');
  });

  // ============================================================================================== COMPARE
  await run('compare', async () => {
    await compareRun(2);
    const result = cmp('compare-result');
    ok(await result.isVisible());
    const headline = await text(cmp('headline'));
    ok(/^B - 7 AGVs delivers \d+ % more per hour than A - Baseline, with a \d+ % shorter mean lead time\.$/.test(headline), headline);
    // the table
    const heads = await P.locator('[data-cmp="table"] thead th').allInnerTexts();
    eq(heads.map((t) => t.replace(/\s+/g, ' ').trim()), ['Measure', 'A Baseline reference', 'B 7 AGVs', 'C 9 AGVs']);
    const metrics = await P.locator('[data-cmp="table"] tbody tr').evaluateAll((trs) => trs.map((tr) => tr.dataset.metric));
    ok(metrics[0] === 'throughput' && metrics.includes('leadMean') && metrics.includes('waitShare'), metrics.join());
    ok(!metrics.includes('minBattery'), 'a measure nobody can report has no row');
    ok((await text(P.locator('.cmp-note'))).includes('Lowest battery level'), 'and is named under the table');
    const tp = await cellText('throughput');
    ok(tp[0].startsWith('37.') || tp[0].startsWith('38.'), tp[0]);
    ok(/^4\d\.\d \+\d+ %( \d+\.\d–\d+\.\d)?$/.test(tp[1]), `throughput of B with change and (when the runs differ) range: ${tp[1]}`);
    eq(await rowCells('throughput').evaluateAll((tds) => tds.map((td) => td.className)), ['num is-worst', 'num is-best', 'num'], 'A is the worst, B the best');
    ok(!/%/.test(tp[0]) && !tp[0].includes('+'), `the reference has no change: ${tp[0]}`);
    const lead = await cellText('leadMean');
    ok(/^3\d\.\d −\d+ % /.test(lead[1]), `lead time in minutes with a negative change: ${lead[1]}`);
    ok((await text(P.locator('tr[data-metric="leadMean"] th'))).endsWith('min'), 'unit shown with the row');
    eq(await rowCells('leadMean').evaluateAll((tds) => tds.map((td) => td.className)), ['num is-worst', 'num is-best', 'num']);
    // a change that is good is green, one that is bad is red
    ok(await P.locator('tr[data-metric="throughput"] td').nth(1).locator('.delta--good').count() === 1);
    ok(await P.locator('tr[data-metric="waitShare"] td').nth(2).locator('.delta--bad').count() === 1, 'more waiting in traffic is bad');
    // the glyph is in the cell (best = check, worst = exclamation) so colour is not the only signal
    const glyph = await P.locator('tr[data-metric="throughput"] td.is-best .cmp-cell__main').evaluate((el) => getComputedStyle(el, '::before').content);
    ok(glyph !== 'none' && glyph !== 'normal', `glyph before the best value: ${glyph}`);
    // the bar chart
    ok(await cmp('bar-chart').locator('canvas').count() === 1);
    const label = await cmp('bar-chart').locator('canvas').getAttribute('aria-label');
    ok(label.includes('Throughput by variant') || (await cmp('bar-chart').innerHTML()).includes('Throughput by variant'), label);
    await P.getByLabel('Show in the chart').selectOption('leadMean');
    ok((await cmp('bar-chart').innerHTML()).includes('Mean lead time by variant'), 'the chart follows the selected measure');
    // copy as table
    await cmp('copy').click();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    const lines = clip.split('\n');
    eq(lines[0], 'Measure\tUnit\tA - Baseline\tB - 7 AGVs\tC - 9 AGVs');
    ok(/^Throughput\tloads\/h\t3\d\.\d\t4\d\.\d\t4\d\.\d$/.test(lines[1]), lines[1]);
    ok(lines.every((l) => l.split('\t').length === 5), 'every row has five columns');
    ok((await toasts()).some((t) => t.message.startsWith('Table copied') && t.kind === 'success'));
    // the meta line
    ok((await text(P.locator('.cmp-meta'))).includes('3 variants · 2 runs of 2 h each, first 5 min ignored'));
    // the run left the tab usable again
    ok(await runBtn.isEnabled());
    eq(await P.locator('[data-cmp="progress"]').isVisible(), false, 'the progress block is gone after a successful run');
    // getLastResults feeds the report
    const last = await page.evaluate(() => { const r = window.harness.getLastResults(); return { kinds: [r.compare?.kind ?? null, r.sweep?.kind ?? null], variants: r.compare.variants.map((v) => v.label), reps: r.compare.settings.replications }; });
    eq(last, { kinds: ['compare', null], variants: ['A - Baseline', 'B - 7 AGVs', 'C - 9 AGVs'], reps: 2 });
    // a single repetition has no ranges
    await setReps(1);
    await runBtn.click();
    await idle();
    eq(await P.locator('.cmp-cell__range').count(), 0, 'one run per variant: no ranges');
  });

  // ============================================================================================== PROGRESS
  await run('progress', async () => {
    await setHours(6);
    await setReps(2);
    await runBtn.click();
    await cmp('progress').waitFor({ state: 'visible' });
    ok(await runBtn.isDisabled(), 'the run button is disabled while running');
    ok(await P.getByLabel('Run length', { exact: true }).isDisabled(), 'the inputs are locked while running');
    ok(await P.locator('[data-scenario] input').first().isDisabled());
    ok(await cmp('cancel').isFocused(), 'focus moves to Cancel, it is not lost with the disabled button');
    eq((await P.locator('[data-cmp="status"] li').allInnerTexts()).length, 3, 'a status row per variant');
    const seen = new Set();
    let sawRunning = false;
    let sawEta = false;
    let last = -1;
    const deadline = Date.now() + 120000;
    while (await cmp('progress').isVisible() && Date.now() < deadline) {
      const value = Number(await cmp('progress').getByRole('progressbar').getAttribute('aria-valuenow'));
      ok(value >= last, `progress never goes back (${last} -> ${value})`);
      last = value;
      seen.add(value);
      const states = await P.locator('[data-cmp="status"] li').evaluateAll((lis) => lis.map((li) => li.dataset.state));
      if (states.includes('running')) sawRunning = true;
      if (/left/.test(await text(cmp('eta')))) sawEta = true;
      await page.waitForTimeout(150);
    }
    ok(seen.size >= 4, `the bar moves in several steps (${[...seen].join(',')})`);
    ok(sawRunning, 'a variant is marked running');
    ok(sawEta, 'an estimate of the time left appears');
    await cmp('compare-result').waitFor({ state: 'visible' });
    // while the experiment ran, the page was never blocked: a click on another tab answered at once
  });

  await run('responsive', async () => {
    await setHours(6);
    await setReps(3);
    await runBtn.click();
    await cmp('progress').waitFor({ state: 'visible' });
    // measure how long the main thread is unavailable while the experiment runs: longest gap between animation frames
    const worst = await page.evaluate(() => new Promise((resolve) => {
      let worstGap = 0;
      let last = performance.now();
      const until = last + 2500;
      const tick = (now) => {
        worstGap = Math.max(worstGap, now - last);
        last = now;
        if (now < until) requestAnimationFrame(tick); else resolve(worstGap);
      };
      requestAnimationFrame(tick);
    }));
    ok(worst < 250, `the page keeps painting while the experiment runs (longest frame gap ${Math.round(worst)} ms)`);
    await cmp('cancel').click();
    await idle();
  });

  // ============================================================================================== CANCEL
  await run('cancel', async () => {
    await compareRun(2);
    const before = await page.evaluate(() => window.harness.getLastResults().compare.at);
    const tableBefore = await text(cmp('table'));
    await setHours(24);
    await setReps(5);
    await runBtn.click();
    await cmp('progress').waitFor({ state: 'visible' });
    await page.waitForFunction(() => Number(document.querySelector('[data-cmp="progress"] [role="progressbar"]').getAttribute('aria-valuenow')) >= 1);
    ok(await cmp('cancel').isEnabled());
    const t0 = Date.now();
    await cmp('cancel').click();
    await idle();
    ok(Date.now() - t0 < 2000, `cancel takes effect within a moment (${Date.now() - t0} ms)`);
    ok(await runBtn.isEnabled(), 'the tab can run again');
    ok(await cmp('progress').isVisible(), 'the progress block stays to show what happened');
    const states = await P.locator('[data-cmp="status"] li').evaluateAll((lis) => lis.map((li) => li.dataset.state));
    ok(states.includes('cancelled'), states.join());
    ok(!states.includes('running'), 'nothing is left running');
    ok(await cmp('cancel').isDisabled());
    eq(await P.locator('[data-cmp="error"]').innerText(), '', 'a cancel is not an error');
    eq(await page.evaluate(() => window.harness.getLastResults().compare.at), before, 'the previous result is kept');
    eq(await text(cmp('table')), tableBefore, 'and still shown');
    ok(await runBtn.isFocused(), 'focus is back on the run button');
    ok(await P.getByLabel('Run length', { exact: true }).isEnabled(), 'inputs are unlocked');
    ok((await P.locator('[role="status"]').allInnerTexts()).some((t) => t.includes('cancelled')), 'announced for screen readers');
    // a sweep cancelled after two points keeps them
    await mode('Parameter sweep');
    await setHours(4);
    await setReps(1);
    await runBtn.click();
    await page.waitForFunction(() => document.querySelectorAll('[data-cmp="status"] li[data-state="done"]').length >= 2, null, { timeout: 120000 });
    ok(/^Testing the values: \d of 6 done\.$/.test(await text(cmp('recommendation'))), `while it runs: ${await text(cmp('recommendation'))}`);
    ok(await P.locator('[data-cmp="apply"]:not([disabled])').count() === 0, 'nothing can be applied while the sweep runs');
    eq(await P.locator('[data-cmp="sweep-result"] .callout').count(), 0, 'and it is not called "stopped early" yet');
    await cmp('cancel').click();
    await idle();
    const partial = await page.evaluate(() => window.harness.getLastResults().sweep);
    ok(partial && partial.points.length >= 2 && partial.points.length < partial.values.length, 'the finished points stay');
    ok((await text(cmp('sweep-result'))).includes('Stopped early'), 'and the result says it stopped early');
  });

  // ============================================================================================== STALE
  await run('stale', async () => {
    await compareRun(2);
    eq(await cmp('stale').count(), 0, 'a fresh result has no banner');
    // cosmetic changes do not matter
    await edit('L.setName(d, "A better name"); L.addLabel(d, { x: 3, y: 3, text: "Hello" })');
    eq(await cmp('stale').count(), 0, 'renaming and labelling do not date a result');
    // a change the simulation notices does
    await edit('L.updateFleet(d, d.fleets[0].id, { count: 6 })');
    await cmp('stale').waitFor();
    const banner = await text(cmp('stale'));
    ok(banner.includes('These results are out of date') && banner.includes('was changed after this comparison ran'), banner);
    ok(await cmp('rerun').isEnabled());
    // undo brings it back to date
    await page.evaluate(() => { window.harness.store.undo(); });
    eq(await cmp('stale').count(), 0, 'undoing the change makes the result current again');
    await edit('L.updateFleet(d, d.fleets[0].id, { count: 6 })');
    await cmp('stale').waitFor();
    // "Run again" runs and clears the banner
    await cmp('rerun').click();
    await idle();
    eq(await cmp('stale').count(), 0, 'a new run replaces the old result');
    // another variant changed
    await page.evaluate(() => { const s = window.harness.store; const id = s.getState().project.scenarios[1].id; s.switchScenario(id); });
    await edit('L.updateFleet(d, d.fleets[0].id, { speed: 3 })');
    await page.evaluate(() => { const s = window.harness.store; s.switchScenario(s.getState().project.scenarios[0].id); });
    await cmp('stale').waitFor();
    ok((await text(cmp('stale'))).includes('B - 7 AGVs was changed'), 'the banner names the variant that changed');
    // a variant that was deleted
    await page.evaluate(() => { const s = window.harness.store; s.deleteScenario(s.getState().project.scenarios[2].id); });
    ok((await text(cmp('stale'))).includes('B - 7 AGVs was changed') || (await text(cmp('stale'))).includes('no longer exists'), await text(cmp('stale')));
    // the hidden tab catches up when it comes back
    await page.evaluate(() => window.harness.showTab('other'));
    await edit('L.updateFleet(d, d.fleets[0].id, { count: 8 })');
    await page.evaluate(() => window.harness.showTab('experiments'));
    ok((await text(cmp('stale'))).length > 0, 'a hidden tab shows the current state when it comes back');
  });

  // ============================================================================================== SWEEP
  await run('sweep', async () => {
    await mode('Parameter sweep');
    ok(await cmp('sweep-setup').isVisible() && !(await P.locator('[data-mode="compare"]').isVisible()));
    ok((await text(runBtn)).includes('Run sweep'), 'the button says what it does');
    const select = P.getByLabel('Setting to change', { exact: true });
    const groups = await select.locator('optgroup').evaluateAll((gs) => gs.map((g) => [g.label, [...g.querySelectorAll('option')].map((o) => o.textContent)]));
    eq(groups.map((g) => g[0]), ['Vehicles', 'Workstations', 'Goods in', 'Whole plant'], 'settings grouped for the planner');
    eq(groups[0][1], ['AGV: number of vehicles', 'AGV: speed', 'AGV: capacity per vehicle']);
    ok(groups[3][1].includes('Demand factor'));
    eq(await select.inputValue(), 'fleet.v1.count');
    ok((await text(cmp('sweep-current'))).includes('Currently 5 vehicles.'));
    eq([await P.getByLabel('From', { exact: true }).inputValue(), await P.getByLabel('To', { exact: true }).inputValue(), await P.getByLabel('Step', { exact: true }).inputValue()], ['3', '8', '1'], 'range prefilled with the suggested values');
    eq(await text(cmp('sweep-values')), 'Will test 6 values: 3, 4, 5, 6, 7, 8 vehicles');
    ok((await text(cmp('run-note'))).startsWith('18 simulation runs of 2 h each.'), await text(cmp('run-note')));
    // editing the range
    await P.getByLabel('From', { exact: true }).fill('2');
    await P.getByLabel('To', { exact: true }).fill('10');
    await P.getByLabel('Step', { exact: true }).fill('4');
    eq(await text(cmp('sweep-values')), 'Will test 4 values: 2, 5, 6, 10 vehicles', 'the value in use is always tested');
    await P.getByLabel('Step', { exact: true }).fill('0');
    ok((await text(cmp('sweep-values'))).includes('step must be greater than zero'));
    ok(await runBtn.isDisabled(), 'an invalid range cannot run');
    await P.getByLabel('Step', { exact: true }).fill('1');
    ok((await text(cmp('sweep-values'))).includes('9 values'));
    await P.getByLabel('To', { exact: true }).fill('100');
    ok((await text(cmp('sweep-values'))).includes('at most 25'), await text(cmp('sweep-values')));
    await P.getByRole('button', { name: 'Use suggested values' }).click();
    eq(await text(cmp('sweep-values')), 'Will test 6 values: 3, 4, 5, 6, 7, 8 vehicles', 'reset to the suggestions');
    // another setting brings its own range
    await select.selectOption('speedFactor');
    ok((await text(cmp('sweep-values'))).includes('0.5×, 0.75×, 1×, 1.25×, 1.5×, 2×'), await text(cmp('sweep-values')));
    await select.selectOption('fleet.v1.count');
    // run
    await setReps(2);
    await runBtn.click();
    await cmp('progress').waitFor({ state: 'visible' });
    eq(await P.locator('[data-cmp="status"] li').count(), 6, 'a status row per value');
    await cmp('sweep-result').waitFor({ state: 'visible' });
    await idle();
    const rec = await text(cmp('recommendation'));
    ok(/^Throughput stops improving beyond [67] vehicles: from there it is within 5 % of the best result\.$/.test(rec), rec);
    eq(await P.locator('[data-cmp="sweep-table"] tbody tr').count(), 6);
    const values = await P.locator('[data-cmp="sweep-table"] tbody tr').evaluateAll((trs) => trs.map((tr) => tr.dataset.value));
    eq(values, ['3', '4', '5', '6', '7', '8']);
    eq(await P.locator('[data-cmp="sweep-table"] td.is-best').count(), 1, 'one best row');
    const bestRow = await P.locator('[data-cmp="sweep-table"] tr:has(td.is-best)').getAttribute('data-value');
    ok(['6', '7', '8'].includes(bestRow), `the best number of vehicles is 6 to 8: ${bestRow}`);
    const current = P.locator('[data-cmp="sweep-table"] tr[data-value="5"]');
    ok((await text(current)).includes('in use'), 'the value in use is marked');
    ok(await current.locator('[data-cmp="apply"]').isDisabled(), 'applying the value in use does nothing');
    ok(await P.locator('[data-cmp="sweep-table"] tr[data-value="6"] [data-cmp="apply"]').isEnabled());
    eq(await text(P.locator('[data-cmp="sweep-table"] tr[data-value="6"] [data-cmp="apply"]')), 'Apply this value');
    ok(await cmp('line-chart').locator('canvas').count() === 1, 'the line chart');
    // the measure follows the select without a new run
    await P.getByLabel('Measure to plot', { exact: true }).selectOption('leadMean');
    ok((await text(P.locator('[data-cmp="sweep-table"] thead'))).includes('Mean lead time (min)'));
    ok((await text(cmp('recommendation'))).startsWith('Mean lead time'), await text(cmp('recommendation')));
    await P.getByLabel('Measure to plot', { exact: true }).selectOption('fleetUtilization');
    ok((await text(cmp('recommendation'))).includes('no better or worse direction'), await text(cmp('recommendation')));
    eq(await P.locator('[data-cmp="sweep-table"] td.is-best').count(), 0, 'no best row for a measure without direction');
    await P.getByLabel('Measure to plot', { exact: true }).selectOption('throughput');
    // copy as table
    await cmp('copy-sweep').click();
    const tsv = (await page.evaluate(() => navigator.clipboard.readText())).split('\n');
    eq(tsv[0], 'AGV: number of vehicles (vehicles)\tThroughput (loads/h)\tLowest\tHighest');
    eq(tsv.length, 7);
  });

  // ============================================================================================== APPLY
  await run('apply', async () => {
    await sweepRun(2);
    eq(await fleetCount(), 5);
    const stack = await page.evaluate(() => window.harness.store.getState().canUndo);
    ok(stack === true, 'the harness plant has an edit already');
    // the button
    await P.locator('[data-cmp="sweep-table"] tr[data-value="7"] [data-cmp="apply"]').click();
    eq(await fleetCount(), 7, 'the value is applied to the plant');
    eq(await undoLabel(), 'Apply AGV: number of vehicles = 7', 'one readable undo step');
    const t = (await toasts()).at(-1);
    ok(t.message === 'AGV: number of vehicles is now 7 vehicles.' && t.action === 'Undo' && t.kind === 'success', JSON.stringify(t));
    eq(await cmp('stale').count(), 0, 'applying a value of the swept setting does not date the sweep');
    ok(await P.locator('[data-cmp="sweep-table"] tr[data-value="7"] [data-cmp="apply"]').isDisabled(), 'the value in use moved to the new row');
    ok((await text(P.locator('[data-cmp="sweep-table"] tr[data-value="7"]'))).includes('in use'));
    ok(await P.locator('[data-cmp="sweep-table"] tr[data-value="5"] [data-cmp="apply"]').isEnabled());
    // undo
    await page.evaluate(() => window.harness.store.undo());
    eq(await fleetCount(), 5, 'Undo takes it back');
    eq(await cmp('stale').count(), 0, 'undoing is the very layout the sweep ran on');
    // the toast's Undo button
    await P.locator('[data-cmp="sweep-table"] tr[data-value="8"] [data-cmp="apply"]').click();
    eq(await fleetCount(), 8);
    await page.locator('.toast__action').click();
    eq(await fleetCount(), 5, 'the Undo in the toast works');
    // a click on the chart (keyboard: Home selects the first point, Enter applies it)
    const canvas = cmp('line-chart').locator('canvas');
    await canvas.focus();
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    eq(await fleetCount(), 3, 'Enter on a chart point applies that value');
    eq(await undoLabel(), 'Apply AGV: number of vehicles = 3');
    // pointer click on a point
    await page.evaluate(() => window.harness.store.undo());
    const box = await canvas.boundingBox();
    // the 7-vehicle point is the 5th of 6 values: scan the canvas width for the click that applies 7
    let applied = false;
    for (let x = box.x + box.width * 0.5; x < box.x + box.width && !applied; x += 6) {
      await page.mouse.move(x, box.y + box.height * 0.3);
      await page.mouse.click(x, box.y + box.height * 0.3);
      applied = (await fleetCount()) !== 5;
    }
    ok(applied, 'a pointer click on the chart applies a value');
    await page.evaluate(() => window.harness.store.undo());
    // a change of the plant elsewhere dates the sweep
    await edit('L.updateSettings(d, { demandFactor: 1.5 })');
    await cmp('stale').waitFor();
    ok((await text(cmp('stale'))).includes('The plant was changed after this sweep ran'));
    // applying when the fleet is gone does not break anything
    await edit('L.removeFleet(d, d.fleets[0].id)');
    await P.locator('[data-cmp="sweep-table"] tr[data-value="6"] [data-cmp="apply"]').click();
    const last = (await toasts()).at(-1);
    ok(last.kind === 'warn' && last.message.includes('does not exist in the open plant'), `nothing to change is said, not thrown: ${last.message}`);
    // the sweep belongs to its variant
    await page.evaluate(() => { const s = window.harness.store; s.switchScenario(s.getState().project.scenarios[1].id); });
    ok((await text(cmp('stale'))).includes('different one') || (await text(cmp('stale'))).includes('was run on variant'), await text(cmp('stale')));
  });

  // ============================================================================================== PERSIST
  await run('persist', async () => {
    await compareRun(2);
    await sweepRun(2);
    await mode('Compare variants');
    const before = { compare: await text(cmp('table')) };
    // the tab is torn down and built again (e.g. the shell re-creates it): both results come back
    await page.evaluate(() => window.harness.mountCompare());
    eq(await text(cmp('table')), before.compare, 'the comparison is still there');
    await mode('Parameter sweep');
    await cmp('sweep-result').waitFor({ state: 'visible' });
    ok(await cmp('recommendation').isVisible(), 'and the sweep');
    await mode('Compare variants');
    // hidden: no work while hidden, but the state is right when shown again
    await page.evaluate(() => window.harness.showTab('other'));
    await edit('L.updateFleet(d, d.fleets[0].id, { speed: 2.5 })');
    await page.evaluate(() => window.harness.showTab('experiments'));
    await cmp('stale').waitFor();
  });

  await run('hidden-run', async () => {
    await setReps(1);
    await runBtn.click();
    await cmp('progress').waitFor({ state: 'visible' });
    await page.evaluate(() => window.harness.showTab('other'));
    await page.waitForFunction(() => window.harness.toasts.some((t) => t.message === 'Comparison finished.'), null, { timeout: 120000 });
    ok((await toasts()).some((t) => t.message === 'Comparison finished.' && t.kind === 'success'), 'a run that finishes while the tab is hidden says so');
    await page.evaluate(() => window.harness.showTab('experiments'));
    ok(await cmp('compare-result').isVisible(), 'and the result is there when the planner comes back');
    eq(await P.evaluate((el) => el.dataset.state), 'idle');
  });

  // ============================================================================================== ERRORS
  await run('errors', async () => {
    await page.evaluate(() => window.harness.mountCompare({ experiments: { runReplications: async (layout, opts) => {
      opts.onProgress?.({ fraction: 0.5, simTime: 1, label: '' });
      if (layout.fleets[0].count === 7) throw new Error('The simulation engine could not start (test)');
      return { runs: [], summary: {} };
    } } }));
    await setReps(1);
    await runBtn.click();
    await cmp('error').locator('.callout').waitFor();
    await idle();
    const err = await text(cmp('error'));
    ok(err.includes('The experiment could not run') && err.includes('B - 7 AGVs could not be simulated: The simulation engine could not start (test)'), err);
    const states = await P.locator('[data-cmp="status"] li').evaluateAll((lis) => lis.map((li) => li.dataset.state));
    eq(states, ['done', 'failed', 'waiting'], 'the failed variant is marked, the rest did not run');
    ok(await runBtn.isEnabled(), 'the tab is usable after an error');
    ok(await runBtn.isFocused());
    eq(await P.locator('[data-cmp="compare-result"]').isVisible(), false, 'a failed run shows no result');
    // the next run clears the error
    await edit('L.updateFleet(d, d.fleets[0].id, { count: 4 })');
    await P.locator('[data-scenario] input').nth(1).uncheck();
    await runBtn.click();
    await idle();
    eq(await cmp('error').locator('.callout').count(), 0, 'the error is cleared by the next run');
    await page.evaluate(() => window.harness.mountCompare());
  });

  // ============================================================================================== GOLDEN RULE
  await run('golden', async () => {
    const hours = P.getByLabel('Run length', { exact: true });
    await hours.focus();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('3');
    await edit('L.setName(d, "Renamed while typing")');
    await edit('L.updateSettings(d, { duration: 36000 })');
    eq(await hours.inputValue(), '3', 'an edited field is not overwritten by a change of the plant');
    ok(await hours.isFocused(), 'and keeps its focus');
    await hours.blur();
    await edit('L.updateSettings(d, { duration: 18000 })');
    eq(await hours.inputValue(), '3', 'a field the planner changed no longer follows the plant');
    const warm = P.getByLabel('Warm-up', { exact: true });
    await edit('L.updateSettings(d, { warmup: 1200 })');
    eq(await warm.inputValue(), '20', 'an untouched field follows the plant');
    // the setting select is not rebuilt under the planner's hands
    await mode('Parameter sweep');
    const select = P.getByLabel('Setting to change', { exact: true });
    await select.focus();
    await edit('L.addFleet(d, "forklift")');
    ok(await select.isFocused(), 'the select keeps focus while the plant changes');
    const optionsWhileFocused = await select.locator('option').count();
    await page.keyboard.press('Tab');
    await edit('L.setNotes(d, "x")');
    ok(await select.locator('option').count() > optionsWhileFocused, 'the new fleet appears once the select lost focus');
  });

  // ============================================================================================== REPORT
  await run('report', async () => {
    await page.evaluate(async () => { await window.harness.runner.step(2 * 3600); });
    await compareRun(2);
    await sweepRun(2);
    // hostile names in the plant
    await edit(`const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>"\\'&';
      L.setName(d, hostile); L.setNotes(d, hostile + '\\nline two');
      L.updateStation(d, d.stations[0].id, { name: hostile });
      L.updateFleet(d, d.fleets[0].id, { name: hostile });
      L.addLabel(d, { x: 3, y: 3, text: hostile });`);
    const doc = await page.evaluate(() => window.harness.report.exportReportHtml(window.harness.ctx));
    const file = path.join(OUT, 'compare-report.html');
    writeFileSync(file, doc);
    ok(doc.length > 50000, `report size ${doc.length}`);
    const second = await context.newPage();
    const requests = [];
    const secondErrors = [];
    second.on('request', (r) => requests.push(r.url()));
    second.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') secondErrors.push(m.text()); });
    second.on('pageerror', (e) => secondErrors.push(e.message));
    let dialogs = 0;
    second.on('dialog', async (d) => { dialogs++; await d.dismiss(); });
    await second.setViewportSize({ width: 1000, height: 1200 });
    await second.goto(`file://${file}`);
    await second.waitForLoadState('networkidle');
    eq(requests, [`file://${file}`], 'the report makes no request except for itself');
    eq(secondErrors, [], 'no console output from the report');
    eq(dialogs, 0, 'the hostile names ran no script');
    eq(await second.evaluate(() => document.scripts.length), 0, 'no script element');
    eq(await second.evaluate(() => document.querySelectorAll('iframe, object, embed, link, form, a').length), 0);
    eq(await second.evaluate(() => [...document.querySelectorAll('*')].filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name))).length), 0, 'no event handler attributes');
    eq(await second.evaluate(() => document.querySelectorAll('img').length), 1, 'only the layout picture; the hostile img is text');
    ok(await second.evaluate(() => { const img = document.querySelector('img'); return img.complete && img.naturalWidth > 500 && img.src.startsWith('data:image/png;base64,'); }), 'the layout picture is embedded and decodes');
    const body = await second.evaluate(() => document.body.innerText);
    ok(body.includes('<script>alert(1)</script><img src=x onerror=alert(2)>"\'&'), 'the hostile name is shown as text');
    for (const part of ['Plant report', 'Results of the simulation', 'Insights', 'Experiments', 'Comparison of variants', 'Parameter sweep: AGV: number of vehicles', 'Assumptions', 'Generated with LogiPlan', 'Checks']) {
      ok(body.includes(part), `the report has "${part}"`);
    }
    ok(body.includes('B - 7 AGVs delivers') && body.includes('Throughput stops improving beyond'), 'the experiment results are in');
    ok(body.includes('The figures cover'), 'a note on the measured window');
    eq(await second.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
    const pageColor = () => second.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
    eq(await pageColor(), 'rgb(255, 255, 255)', 'a light page');
    await second.screenshot({ path: path.join(OUT, 'compare-report-desktop.png'), fullPage: true });
    await second.emulateMedia({ colorScheme: 'dark' });
    eq(await pageColor(), 'rgb(255, 255, 255)', 'the report stays light in a dark browser');
    // narrow screen
    await second.setViewportSize({ width: 390, height: 800 });
    eq(await second.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no sideways page scroll at 390 px');
    await second.screenshot({ path: path.join(OUT, 'compare-report-narrow.png'), fullPage: true });
    // print: A4, light, tables do not run off the page
    await second.emulateMedia({ media: 'print' });
    await second.pdf({ path: path.join(OUT, 'compare-report.pdf'), format: 'A4', printBackground: true });
    ok(readFileSync(path.join(OUT, 'compare-report.pdf')).length > 20000, 'a PDF can be made from it');
    await second.close();
    // without a simulation and without experiments
    await page.reload();
    await page.waitForFunction(() => window.ready);
    const bare = await page.evaluate(() => window.harness.report.exportReportHtml(window.harness.ctx));
    ok(bare.includes('No simulation has run in this session yet') && !bare.includes('<h2>Experiments</h2>'));
    const without = await page.evaluate(() => window.harness.report.exportReportHtml(window.harness.ctx, { includeComparison: false }));
    ok(!without.includes('Comparison of variants'));
  });

  // ============================================================================================== EXPORTS
  await run('exports', async () => {
    await page.evaluate(async () => { await window.harness.runner.step(1800); });
    await compareRun(1);
    // "Create report" in the tab downloads the report
    const [download] = await Promise.all([page.waitForEvent('download'), cmp('report').click()]);
    ok(/^logiplan-report-congestion-lab-\d{4}-\d{2}-\d{2}\.html$/.test(download.suggestedFilename()), download.suggestedFilename());
    const saved = readFileSync(await download.path(), 'utf8');
    ok(saved.startsWith('<!doctype html>') && saved.includes('Comparison of variants'), 'the downloaded report includes the comparison');
    ok((await toasts()).at(-1).message.startsWith('Report saved as logiplan-report-'));
    // PNG at 2x
    const [png] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => window.harness.report.exportLayoutPng(window.harness.ctx))]);
    eq(png.suggestedFilename(), 'congestion-lab-layout.png');
    const bytes = readFileSync(await png.path());
    eq([...bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a PNG');
    const width2 = bytes.readUInt32BE(16);
    const [png1] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => window.harness.report.exportLayoutPng(window.harness.ctx, { scale: 1 }))]);
    const width1 = readFileSync(await png1.path()).readUInt32BE(16);
    ok(Math.abs(width2 / width1 - 2) < 0.05, `2x is twice as wide as 1x (${width2} vs ${width1})`);
    ok(width2 > 1500, `the whole plant, large enough to print (${width2} px)`);
    // JSON: the project, with all variants
    const [json] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => window.harness.report.exportLayoutJson(window.harness.ctx))]);
    ok(/\.json$/.test(json.suggestedFilename()), json.suggestedFilename());
    const project = importProject(readFileSync(await json.path(), 'utf8'));
    eq(project.scenarios.map((s) => s.name), ['Baseline', '7 AGVs', '9 AGVs'], 'every variant is in the file');
    // print: a window opens with the report, print is called once the pictures are decoded
    await context.addInitScript(() => { window.__printed = 0; window.print = () => { window.__printed++; }; });
    await page.reload();
    await page.waitForFunction(() => window.ready);
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.evaluate(() => window.harness.report.printReport(window.harness.ctx))]);
    await popup.waitForFunction(() => window.__printed >= 1, null, { timeout: 10000 });
    ok(await popup.evaluate(() => document.querySelector('h1').textContent === 'Congestion lab' && document.images[0].naturalWidth > 100), 'the print window shows the finished report');
    eq(await popup.evaluate(() => window.__printed), 1, 'printed once');
    await popup.close();
    // a blocked pop-up window falls back to a download
    await page.evaluate(() => { window.open = () => null; });
    const [fallback] = await Promise.all([page.waitForEvent('download'), page.evaluate(() => window.harness.report.printReport(window.harness.ctx))]);
    ok(/^logiplan-report-/.test(fallback.suggestedFilename()));
    ok((await toasts()).some((t) => t.kind === 'warn' && t.message.includes('blocked the print window')), 'and the planner is told');
  });

  // ============================================================================================== A11Y
  await run('a11y', async () => {
    await compareRun(1);
    await sweepRun(1);
    for (const m of ['Compare variants', 'Parameter sweep']) {
      await mode(m);
      const unnamed = await P.evaluate((root) => [...root.querySelectorAll('button, input, select, textarea, [role="button"]')]
        .filter((el) => el.getClientRects().length)
        .filter((el) => {
          const name = el.getAttribute('aria-label') || el.labels?.[0]?.textContent || el.textContent || el.getAttribute('title');
          return !(name || '').trim();
        }).map((el) => el.outerHTML.slice(0, 80)));
      eq(unnamed, [], `${m}: every control has a name`);
    }
    // keyboard: tab order reaches the run button, Space toggles a checkbox, Enter runs
    await mode('Compare variants');
    const first = P.locator('[data-scenario] input').first();
    await first.focus();
    await page.keyboard.press('Space');
    ok(!(await first.isChecked()), 'Space unticks a variant');
    await page.keyboard.press('Space');
    ok(await first.isChecked());
    let reached = false;
    for (let i = 0; i < 14 && !reached; i++) { await page.keyboard.press('Tab'); reached = await runBtn.isFocused(); }
    ok(reached, 'the run button can be reached with Tab');
    // tables scroll with the keyboard and are named
    ok(await P.locator('.table-wrap[tabindex="0"][role="region"][aria-label]').count() >= 1);
    ok(await P.locator('[data-cmp="table"] th[scope="row"]').count() > 5, 'row headers are real headers');
    for (const [theme, label] of [['light', 'light'], ['dark', 'dark']]) {
      await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
      await mode('Compare variants');
      const c1 = await worstContrast('[data-panel="experiments"]');
      ok(c1.ratio >= 4.5, `${label} compare: lowest contrast ${c1.ratio.toFixed(2)} on "${c1.text}" (${c1.color})`);
      await mode('Parameter sweep');
      const c2 = await worstContrast('[data-panel="experiments"]');
      ok(c2.ratio >= 4.5, `${label} sweep: lowest contrast ${c2.ratio.toFixed(2)} on "${c2.text}" (${c2.color})`);
    }
  });

  // ============================================================================================== SHOTS
  const shots = async (suffix, viewport, query) => {
    await page.setViewportSize(viewport);
    await page.goto(url(`/tests/e2e/compare-harness.html${query}`));
    await page.waitForFunction(() => window.ready);
    await page.evaluate(async () => { await window.harness.runner.step(2 * 3600); });
    await P.getByLabel('Repetitions', { exact: true }).fill('3');
    await cmp('run').click();
    await cmp('compare-result').waitFor({ state: 'visible', timeout: 180000 });
    await idle();
    await page.waitForTimeout(300);
    const pane = page.locator('.pane');
    await pane.screenshot({ path: path.join(OUT, `compare-table-${suffix}.png`) });
    await mode('Parameter sweep');
    await cmp('run').click();
    await cmp('sweep-result').waitFor({ state: 'visible', timeout: 180000 });
    await idle();
    await page.waitForTimeout(300);
    await pane.screenshot({ path: path.join(OUT, `compare-sweep-${suffix}.png`) });
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${suffix}: no sideways page scroll`);
    const worst = await worstContrast('[data-panel="experiments"]');
    ok(worst.ratio >= 4.5, `${suffix}: lowest contrast ${worst.ratio.toFixed(2)} on "${worst.text}"`);
  };
  if (!only || only === 'shots') {
    console.log('-- shots');
    await shots('desktop-light', { width: 1440, height: 900 }, '?tall=1&theme=light&w=420');
    await shots('desktop-dark', { width: 1440, height: 900 }, '?tall=1&theme=dark&w=420');
    await shots('narrow-light', { width: 390, height: 800 }, '?tall=1&narrow=1&theme=light');
    await shots('narrow-dark', { width: 390, height: 800 }, '?tall=1&narrow=1&theme=dark');
    // the live screen as a planner sees it (canvas next to the panel), scrolled to the result
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(url('/tests/e2e/compare-harness.html?theme=light&w=420'));
    await page.waitForFunction(() => window.ready);
    await P.getByLabel('Repetitions', { exact: true }).fill('3');
    await cmp('run').click();
    await cmp('compare-result').waitFor({ state: 'visible', timeout: 180000 });
    await idle();
    await cmp('compare-result').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shot('compare-screen-desktop-light');
  }

  eq(errors, [], 'no console errors or warnings in the whole session');
  console.log(`OK: ${checks} checks`);
}, { viewport: { width: 1440, height: 900 } });
