// Adversarial review of the edit-feedback work in the REAL app (index.html + js/main.js) in real Chromium. Companion of
// tests/ui.runner.warm.review.test.js (lifecycle, determinism, honesty and insights in Node); this script attacks what only a browser shows:
// the lifecycle with real animation frames and a hidden tab, the card and the hint at 390 px, in light and dark, with long labels,
// contrast, touch targets, keyboard use and focus, the wording of the toast against the card, the "Compare properly..." button,
// jank (an independent animation-frame probe and long animation frames) and memory over 100 edits, and the preference across a reload.
//
// Two kinds of checks (same convention as the unit review): `ok` / `eq` are GUARDS (attacks that must not break anything; a failed one
// aborts the run), `defect(id, cond, text)` is a REAL defect found by the review: it is printed as OPEN while it fails and as FIXED once
// it holds (then turn it into a guard). The ids are those of the unit review file where the cause is the same (WARM-<n>).
//
// Run: node tests/e2e/edit-feedback-review.mjs [section]     sections: lifecycle ui honesty keyboard persistence perf
// Screenshots: e2e-output/edit-feedback-review-*.png (open them and look). Numbers of `perf` go to e2e-output/edit-feedback-review-perf.json.
// Every section asserts that the page logged no console error or warning.
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { withBrowser, OUT } from './browser.mjs';
import * as L from '../../js/model/layout.js';

const only = process.argv[2] || '';
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };
const defects = [];
/** A defect found by the review: OPEN while `cond` is false, FIXED when it holds. Never aborts. */
const defect = (id, cond, text) => {
  defects.push({ id, open: !cond, text });
  console.log(`   ${cond ? 'FIXED' : 'OPEN '} ${id}: ${text}`);
};

const DESKTOP = { width: 1440, height: 900 };
const NARROW = { width: 390, height: 800 };

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

  const snap = (page, name, opts = {}) => page.screenshot({ path: path.join(OUT, `edit-feedback-review-${name}.png`), ...opts });
  const noErrors = (what) => { eq(errors.splice(0), [], `${what}: console errors or warnings`); };
  const waitSim = (page, seconds) => page.waitForFunction((s) => window.__logiplan.runner.time >= s, seconds, { timeout: 120000 });
  const mark = (page) => page.evaluate(() => { window.__before = window.__logiplan.runner.sim; });
  const swapped = (page, timeout = 60000) => page.waitForFunction(() => window.__logiplan.runner.sim !== window.__before && !window.__logiplan.runner.priming, null, { timeout });
  const card = (page) => page.locator('[data-panel=impact]');
  const hint = (page) => page.locator('[data-panel=impact-hint]');

  /** Load an example (or a layout object), show `tabName` (through the store: a phone has no tab bar) and run at `speed` until `seconds`. */
  async function start(page, what, { tabName = 'results', speed = 1200, seconds = 1500, warmup = null } = {}) {
    await page.evaluate(async ([w, tabId, x, warm]) => {
      const { EXAMPLES } = await import('/js/model/examples.js');
      const layout = typeof w === 'string' ? EXAMPLES.find((e) => e.id === w).build() : w;
      if (warm !== null) layout.settings.warmup = warm;
      window.__logiplan.store.newProject(layout);
      window.__logiplan.store.setUi({ rightTab: tabId });
      window.__logiplan.runner.setSpeed(x);
      await window.__logiplan.runner.play();
    }, [what, tabName, speed, warmup]);
    await waitSim(page, seconds);
  }

  const edit = (page, label, source) => page.evaluate(async ([text, body]) => {
    const M = await import('/js/model/layout.js');
    // eslint-disable-next-line no-new-func
    const fn = new Function('l', 'M', body);
    window.__logiplan.store.commit(text, (l) => fn(l, M));
  }, [label, source]);

  const addForklifts = (page, count = 3, label = 'Add forklifts') => edit(page, label, `M.addFleet(l, 'forklift', { count: ${count} });`);
  const openDrawer = async (page) => {
    await page.evaluate(() => document.querySelector('[data-open-drawer], .topbar [aria-label*="panel" i]')?.click());
    await page.waitForTimeout(350);
  };
  const warmReady = (page) => page.waitForFunction(() => { const r = window.__logiplan.runner; return r.baseline && r.warm && !r.priming; }, null, { timeout: 60000 });

  const run = async (name, fn) => {
    if (only && only !== name) return;
    console.log(`-- ${name}`);
    await fn();
  };

  // ---------------------------------------------------------------------------------------------------------------
  // lifecycle in the real app
  // ---------------------------------------------------------------------------------------------------------------
  await run('lifecycle', async () => {
    const { page, context } = await openApp();
    await start(page, 'two-lines', { seconds: 1500 });
    // 20 commits in 200 ms, one per animation frame, the first ones while a previous priming is under way
    const burst = await page.evaluate(async () => {
      const M = await import('/js/model/layout.js');
      const r = window.__logiplan.runner; const s = window.__logiplan.store;
      const events = [];
      r.on('rebuild', (e) => events.push({ reason: e.reason, warm: e.warm, label: e.label }));
      const t0 = performance.now();
      let n = 0;
      await new Promise((resolve) => {
        const step = () => {
          s.commit(`Add Goods in ${n}`, (l) => { M.addStation(l, { type: 'source', x: 2 + 4 * (n % 10), y: 2 + 4 * Math.floor(n / 10) }); });
          if (++n < 20) requestAnimationFrame(step); else resolve();
        };
        step();
      });
      const elapsed = performance.now() - t0;
      return { elapsed, events };
    });
    ok(burst.elapsed < 600, `the burst took ${Math.round(burst.elapsed)} ms`);
    await page.waitForFunction(() => { const r = window.__logiplan.runner; return r.warm && !r.priming && r.sim.layout.stations.length === window.__logiplan.store.getState().layout.stations.length; }, null, { timeout: 60000 });
    const after = await page.evaluate(() => {
      const r = window.__logiplan.runner;
      return { playing: r.playing, time: r.time, stations: r.sim.layout.stations.length, store: window.__logiplan.store.getState().layout.stations.length, labels: r.baseline?.labels.length ?? null };
    });
    eq(after.stations, after.store, 'the displayed simulation has every edit of the burst');
    ok(after.playing, 'and keeps playing');
    const swaps = await page.evaluate(() => window.__logiplan.runner.baseline?.edits);
    ok(swaps >= 1 && swaps <= 3, `${swaps} warm restart(s) for 20 commits (a restart per commit would be 20)`);
    noErrors('burst');

    // the real Reset button during priming: cold, empty plant, no card, no stale primed simulation appears later
    await mark(page);
    await edit(page, 'Add forklifts', "M.addFleet(l, 'forklift', { count: 2 });");
    await page.waitForFunction(() => window.__logiplan.runner.priming, null, { timeout: 5000 });
    await page.getByRole('button', { name: 'Reset simulation' }).click();
    eq(await page.evaluate(() => window.__logiplan.runner.priming), false, 'Reset ends priming');
    await page.waitForTimeout(1500);
    const afterReset = await page.evaluate(() => ({ time: window.__logiplan.runner.time, warm: window.__logiplan.runner.warm, baseline: window.__logiplan.runner.baseline, playing: window.__logiplan.runner.playing, fleets: window.__logiplan.runner.sim.layout.fleets.length, storeFleets: window.__logiplan.store.getState().layout.fleets.length }));
    eq(afterReset.time, 0, 'Reset: back at 0:00 and paused (no late swap of the primed simulation)');
    eq(afterReset.warm, null, 'cold');
    eq(afterReset.baseline, null, 'no comparison');
    eq(afterReset.fleets, afterReset.storeFleets, 'the cold simulation includes the edit');
    ok(await card(page).isHidden(), 'no card');
    noErrors('reset during priming');

    // Play / Pause toggling during priming (real buttons): the displayed clock stands still, the last click wins
    await start(page, 'two-lines', { seconds: 1500 });
    await edit(page, 'Add forklifts', "M.addFleet(l, 'forklift', { count: 2 });");
    await page.waitForFunction(() => window.__logiplan.runner.priming, null, { timeout: 5000 });
    const frozenAt = await page.evaluate(() => window.__logiplan.runner.time);
    const pauseBtn = page.locator('.simbar button[aria-label="Pause simulation"], .simbar button[aria-label="Run simulation"]').first();
    for (let i = 0; i < 4; i++) await pauseBtn.click();
    const during = await page.evaluate(() => (window.__logiplan.runner.priming ? window.__logiplan.runner.time : null));
    if (during !== null) eq(during, frozenAt, 'the displayed clock does not move while priming, whatever the play button does');
    await page.waitForFunction(() => !window.__logiplan.runner.priming, null, { timeout: 30000 });
    const playingAfter = await page.evaluate(() => window.__logiplan.runner.playing);
    const label = await page.locator('.simbar button[aria-label="Pause simulation"], .simbar button[aria-label="Run simulation"]').first().getAttribute('aria-label');
    eq(label, playingAfter ? 'Pause simulation' : 'Run simulation', 'the play button agrees with the runner');
    noErrors('play/pause during priming');

    // a hidden tab (document.hidden emulated, animation frames keep coming in headless): no priming, no playing; back: priming resumes
    await start(page, 'two-lines', { seconds: 1500 });
    await edit(page, 'Add forklifts', "M.addFleet(l, 'forklift', { count: 2 });");
    await page.waitForFunction(() => window.__logiplan.runner.priming, null, { timeout: 5000 });
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    const p1 = await page.evaluate(() => window.__logiplan.runner.primeProgress);
    await page.waitForTimeout(800);
    const hiddenState = await page.evaluate(() => ({ progress: window.__logiplan.runner.primeProgress, playing: window.__logiplan.runner.playing, priming: window.__logiplan.runner.priming }));
    ok(hiddenState.priming === true || hiddenState.progress === 0, 'still priming (or finished before the tab was hidden)');
    if (hiddenState.priming) eq(hiddenState.progress, p1, 'no pre-roll while the tab is hidden');
    eq(hiddenState.playing, false, 'a hidden tab is paused');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => !window.__logiplan.runner.priming, null, { timeout: 30000 });
    ok(await page.evaluate(() => window.__logiplan.runner.warm !== null), 'priming completed after the tab came back');
    noErrors('hidden tab');

    // a variant switch during priming is a cold start of the other plant
    await start(page, 'two-lines', { seconds: 1500 });
    await edit(page, 'Add forklifts', "M.addFleet(l, 'forklift', { count: 2 });");
    await page.waitForFunction(() => window.__logiplan.runner.priming, null, { timeout: 5000 });
    await page.evaluate(async () => {
      const { EXAMPLES } = await import('/js/model/examples.js');
      const s = window.__logiplan.store;
      s.addScenario('B', EXAMPLES.find((e) => e.id === 'starter').build());
    });
    await page.waitForTimeout(1500);
    const sw = await page.evaluate(() => ({ priming: window.__logiplan.runner.priming, warm: window.__logiplan.runner.warm, baseline: window.__logiplan.runner.baseline, stations: window.__logiplan.runner.sim.layout.stations.length, store: window.__logiplan.store.getState().layout.stations.length }));
    eq(sw.stations, sw.store, 'the simulation is the plant on screen');
    eq([sw.priming, sw.warm, sw.baseline], [false, null, null], 'cold start, nothing to compare');
    noErrors('variant switch');
    await context.close();
  });

  // ---------------------------------------------------------------------------------------------------------------
  // the card and the hint: layout, themes, long labels, contrast, touch targets
  // ---------------------------------------------------------------------------------------------------------------
  const probe = (page) => page.evaluate(() => {
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,/]+/).map(Number); return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 }; };
    const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
    const bgOf = (el) => { const stack = []; for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } } let base = { r: 255, g: 255, b: 255, a: 1 }; for (const c of stack.reverse()) base = over(c, base); return base; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const ratio = (el) => { const bg = bgOf(el); const fg = over(parse(getComputedStyle(el).color), bg); const a = lum(fg); const b = lum(bg); return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); };
    const visible = (sel) => [...document.querySelectorAll(sel)].filter((e) => e.offsetParent && e.textContent.trim().length);
    const contrast = {};
    for (const [name, sel] of Object.entries({
      title: '.impact__title', labels: '.impact__labels', label: '.impact__label', before: '.impact__before', after: '.impact__after', unit: '.impact__unit',
      chipGood: '.impact__delta.delta--good', chipBad: '.impact__delta.delta--bad', chipNeutral: '.impact__delta:not(.delta--good):not(.delta--bad)',
      status: '.impact__status', windows: '.impact__windows', hintTag: '.impact-hint__tag', hintText: '.impact-hint__text',
    })) { const els = visible(sel); if (els.length) contrast[name] = Math.min(...els.map(ratio)); }
    const size = (sel) => { const e = document.querySelector(sel); if (!e || !e.offsetParent) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; };
    const c = document.querySelector('[data-panel=impact]');
    const cr = c && !c.hidden ? c.getBoundingClientRect() : null;
    return {
      contrast,
      sizes: { keep: size('.impact__actions .btn:first-child'), compare: size('.impact__actions .btn:last-child'), dismiss: size('.impact__dismiss'), hintMain: size('.impact-hint__main'), hintClose: size('.impact-hint__close') },
      scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth,
      card: cr ? { left: Math.round(cr.left), right: Math.round(cr.right), width: Math.round(cr.width) } : null,
      overflowing: [...document.querySelectorAll('[data-panel=impact] *')].filter((e) => e.offsetParent && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflow !== 'hidden' && getComputedStyle(e).overflowX !== 'hidden').map((e) => e.className).slice(0, 5),
      labels: (() => { const e = document.querySelector('.impact__labels'); return e ? { text: e.textContent, title: e.getAttribute('title'), clipped: e.scrollHeight > e.clientHeight + 1 } : null; })(),
      hint: (() => { const e = document.querySelector('.impact-hint__text'); return e ? { text: e.textContent, clipped: e.scrollWidth > e.clientWidth + 1, title: e.getAttribute('title') || e.parentElement.getAttribute('title') } : null; })(),
    };
  });

  await run('ui', async () => {
    const longLabels = [
      ['Rename Press line one to something really very long indeed 1234567890', "l.stations[1].name = 'Renamed press with an extraordinarily long station name that never ends';"],
      ['Add forklifts to the second line to see what happens', "M.addFleet(l, 'forklift', { count: 2 });"],
      ['Third edit with another long label that wraps', 'l.fleets[0].count += 1;'],
      ['Fourth edit label', 'l.fleets[0].count += 1;'],
    ];
    for (const [viewport, scheme, name] of [[DESKTOP, 'light', 'desktop-light'], [DESKTOP, 'dark', 'desktop-dark'], [NARROW, 'light', 'narrow-light'], [NARROW, 'dark', 'narrow-dark']]) {
      const { page, context } = await openApp({ viewport, colorScheme: scheme });
      await start(page, 'two-lines', { seconds: 1500 });
      for (const [label, body] of longLabels) await edit(page, label, body);
      await warmReady(page);
      await page.waitForTimeout(600);
      if (viewport.width < 900) await openDrawer(page);
      const state = await probe(page);
      ok(state.card && state.card.right <= state.innerW + 0.5 && state.card.left >= -0.5, `${name}: the card lies inside the viewport (${JSON.stringify(state.card)})`);
      ok(state.scrollW <= state.innerW, `${name}: no horizontal page scroll (${state.scrollW} > ${state.innerW})`);
      eq(state.overflowing, [], `${name}: nothing in the card overflows its box`);
      for (const [key, ratio] of Object.entries(state.contrast)) ok(ratio >= 4.5, `${name}: contrast of ${key} is ${ratio.toFixed(2)}:1`);
      ok(state.sizes.keep && state.sizes.keep.h >= 24 && state.sizes.compare.h >= 24 && state.sizes.dismiss.h >= 24 && state.sizes.dismiss.w >= 24, `${name}: card buttons are at least 24 px: ${JSON.stringify(state.sizes)}`);
      if (name === 'desktop-light') {
        defect('WARM-10a', state.labels.title === state.labels.text || state.labels.clipped === false, `the card cuts the list of edits to two lines with no way to read the rest ("${state.labels.text.slice(0, 60)}...", no title attribute)`);
        defect('WARM-10b', state.sizes.hintClose === null || (state.sizes.hintClose.w >= 24 && state.sizes.hintClose.h >= 24), `the "Hide this hint" button is ${JSON.stringify(state.sizes.hintClose)} px, under the 24 px minimum target of WCAG 2.2`);
      }
      if (name === 'narrow-light') {
        defect('WARM-10c', state.hint === null || !state.hint.clipped || Boolean(state.hint.title && state.hint.title.includes(state.hint.text.slice(0, 25))), `at 390 px the one-line hint is cut off ("${state.hint && state.hint.text.slice(0, 50)}...") and no title or other text gives it in full (the button title only says "${state.hint && state.hint.title}")`);
      }
      await card(page).scrollIntoViewIfNeeded();
      await snap(page, `card-${name}`);
      noErrors(`ui ${name}`);
      await context.close();
    }
  });

  // ---------------------------------------------------------------------------------------------------------------
  // honesty in the real app
  // ---------------------------------------------------------------------------------------------------------------
  await run('honesty', async () => {
    // WARM-1 in the DOM: renaming a station (a restart that cannot change anything) and the colour of the chips
    {
      const { page, context } = await openApp();
      await start(page, 'two-lines', { seconds: 3000 });
      await edit(page, 'Rename a station', "l.stations[1].name = 'Renamed';");
      await warmReady(page);
      await page.waitForTimeout(400);
      const chips = await card(page).locator('.impact__row').evaluateAll((rows) => rows.map((r) => ({ metric: r.dataset.metric, text: r.querySelector('.impact__delta').textContent.trim(), good: r.querySelector('.impact__delta').classList.contains('delta--good'), bad: r.querySelector('.impact__delta').classList.contains('delta--bad') })));
      const coloured = chips.filter((c) => c.good || c.bad);
      defect('WARM-1', coloured.length === 0, `a pure rename shows ${coloured.length} red or green chip(s): ${coloured.map((c) => `${c.metric} ${c.text}`).join(', ') || 'none'}`);
      await card(page).scrollIntoViewIfNeeded();
      await snap(page, 'rename-verdicts');
      noErrors('honesty rename');
      await context.close();
    }

    // WARM-3: the toast against the card when the warm-up is longer than the pre-roll cap
    {
      const { page, context } = await openApp();
      await start(page, 'two-lines', { seconds: 5400, warmup: 3600 });
      await addForklifts(page, 2, 'Add forklift fleet');
      await page.waitForFunction(() => window.__logiplan.runner.warm && !window.__logiplan.runner.priming, null, { timeout: 60000 });
      await page.waitForTimeout(300);
      const toast = (await page.locator('.toast-region').innerText()).replace(/\s+/g, ' ');
      const warming = await page.evaluate(() => window.__logiplan.runner.kpis().window.warmingUp);
      const cardText = (await card(page).innerText()).replace(/\s+/g, ' ');
      ok(warming, 'the updated plant is still warming up after the 40 minute pre-roll (warm-up 60 min)');
      ok(/still warming up/.test(cardText), 'the card says so');
      defect('WARM-3', !/warmed up/.test(toast), `the toast says "${toast.replace(/ See effect.*/, '')}" while the card says "still warming up"`);
      await snap(page, 'toast-vs-card');
      noErrors('honesty toast');
      await context.close();
    }

    // WARM-6: "Compare properly..." must lead to a comparison of the old and the new plant
    {
      const { page, context } = await openApp();
      await start(page, 'two-lines', { seconds: 1500 });
      await addForklifts(page, 3);
      await warmReady(page);
      await card(page).getByRole('button', { name: /Compare properly/ }).click();
      await page.waitForTimeout(500);
      eq(await page.evaluate(() => window.__logiplan.store.getState().ui.rightTab), 'experiments', 'the button opens the Experiments tab');
      const text = (await page.locator('#panel-experiments').innerText()).replace(/\s+/g, ' ');
      const scenarios = await page.evaluate(() => window.__logiplan.store.getState().project.scenarios.length);
      defect('WARM-6', scenarios >= 2 && !/Create a variant to compare/.test(text), `"Compare properly..." lands on "${(text.match(/Create a variant to compare[^.]*\./) || [''])[0]}" (${scenarios} variant): the old plant is not offered, so the old-versus-new comparison the button promises cannot be run`);
      await snap(page, 'compare-properly');
      noErrors('honesty compare');
      await context.close();
    }

    // WARM-2 in the DOM: a plant that cannot move
    {
      const { page, context } = await openApp();
      await start(page, 'starter', { seconds: 3000 });
      await edit(page, 'Erase all roads', "for (const key of Object.keys(l.roads)) { const [x, y] = key.split(',').map(Number); M.eraseRoadCell(l, x, y); }");
      await warmReady(page);
      await page.waitForFunction(() => window.__logiplan.runner.kpis().window.duration >= 650, null, { timeout: 60000 });
      await page.waitForTimeout(400);
      const rows = await card(page).locator('.impact__row').evaluateAll((els) => els.map((r) => ({ metric: r.dataset.metric, text: r.innerText.replace(/\s+/g, ' ').trim(), good: r.querySelector('.impact__delta').classList.contains('delta--good') })));
      const note = (await card(page).locator('.impact__note').innerText()).trim();
      defect('WARM-2', !rows.some((r) => r.good) && /no load|nothing/i.test(note), `a plant without roads: ${rows.filter((r) => r.good).map((r) => r.text).join('; ') || 'no green chip'}; note: "${note}"`);
      await card(page).scrollIntoViewIfNeeded();
      await snap(page, 'no-roads');
      noErrors('honesty broken');
      await context.close();
    }
  });

  // ---------------------------------------------------------------------------------------------------------------
  // keyboard and focus
  // ---------------------------------------------------------------------------------------------------------------
  await run('keyboard', async () => {
    const { page, context } = await openApp();
    await start(page, 'two-lines', { seconds: 1500 });
    await addForklifts(page, 2);
    await warmReady(page);
    await card(page).scrollIntoViewIfNeeded();
    // the card is a labelled region; the buttons have names; the dismiss button is reachable by Tab
    eq(await card(page).getAttribute('aria-labelledby') !== null, true, 'the card is labelled by its title');
    const names = await card(page).getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') || e.textContent.trim()));
    eq(names, ['Dismiss', 'Keep as baseline', 'Compare properly…'], 'the buttons have names, in reading order');
    const roles = await page.evaluate(() => ({
      progress: Boolean(document.querySelector('[data-panel=impact] [role=progressbar][aria-valuenow]')),
      chipStatus: [...document.querySelectorAll('.simbar .chip')].map((e) => e.getAttribute('role')),
      toastLive: document.querySelector('.toast-region')?.getAttribute('aria-live'),
      rowsList: document.querySelector('[data-panel=impact] ul.impact__rows') !== null,
      srWord: [...document.querySelectorAll('.impact__delta .sr-only')].every((e) => /better|worse|no clear change|for information|not comparable/.test(e.textContent)),
    }));
    ok(roles.progress, 'the progress bar has role and value');
    ok(roles.chipStatus.includes('status'), 'the run chip ("Updating…") is a status');
    eq(roles.toastLive, 'polite', 'the toast region announces politely');
    ok(roles.rowsList && roles.srWord, 'rows are a list and every chip has a hidden word for readers who cannot see colour');

    // Tab from the Results tab reaches Dismiss, then Keep; Enter and Space activate; the focus never falls to the page
    await page.locator('#tab-results').focus();
    const order = [];
    for (let i = 0; i < 4; i++) { await page.keyboard.press('Tab'); order.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.textContent.trim().slice(0, 30) || document.activeElement?.tagName)); }
    ok(order.includes('Dismiss') && order.includes('Keep as baseline'), `Tab reaches the buttons: ${order.join(' > ')}`);
    await page.getByRole('button', { name: 'Keep as baseline' }).focus();
    const playingBefore = await page.evaluate(() => window.__logiplan.runner.playing);
    await page.keyboard.press('Space'); // Space on a focused button presses it; it must not also play/pause the simulation
    await page.waitForFunction(() => document.querySelector('[data-panel=impact]').hidden, null, { timeout: 3000 });
    eq(await page.evaluate(() => window.__logiplan.runner.playing), playingBefore, 'Space on a button does not toggle the simulation');
    eq(await page.evaluate(() => document.activeElement && document.activeElement.id), 'tab-results', 'after Keep the focus is on the Results tab (the button went away)');
    // second edit: a baseline from the kept numbers; Enter on Dismiss
    await edit(page, 'More forklifts', "l.fleets[l.fleets.length - 1].count += 1;");
    await warmReady(page);
    await page.getByRole('button', { name: 'Dismiss' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('[data-panel=impact]').hidden, null, { timeout: 3000 });
    eq(await page.evaluate(() => document.activeElement && document.activeElement.id), 'tab-results', 'after Dismiss the focus is on the Results tab');
    eq(await page.evaluate(() => window.__logiplan.runner.baseline), null, 'dismissed');
    noErrors('keyboard');
    await context.close();
  });

  // ---------------------------------------------------------------------------------------------------------------
  // the preference across a reload and with the keyboard
  // ---------------------------------------------------------------------------------------------------------------
  await run('persistence', async () => {
    const { page, context } = await openApp();
    await page.locator('[data-tab=simulate]').click();
    const input = page.getByLabel('Keep results warm after edits');
    ok(await input.isChecked(), 'on by default');
    await input.focus();
    await page.keyboard.press('Space');
    ok(!(await input.isChecked()), 'Space on the focused switch turns it off');
    eq(await page.evaluate(() => window.__logiplan.store.getState().ui.warmRestart), false, 'the preference is stored');
    await page.waitForTimeout(900);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
    await page.keyboard.press('Escape');
    await page.locator('[data-tab=simulate]').click();
    ok(!(await page.getByLabel('Keep results warm after edits').isChecked()), 'off after a reload');
    // off: an edit of a plant that has run is a cold start (the old behaviour) and says so
    await start(page, 'two-lines', { tabName: 'results', seconds: 1500 });
    await mark(page);
    await addForklifts(page, 2, 'Add forklifts');
    await swapped(page);
    const cold = await page.evaluate(() => ({ time: window.__logiplan.runner.time, warm: window.__logiplan.runner.warm, baseline: window.__logiplan.runner.baseline }));
    ok(cold.time < 120 && cold.warm === null && cold.baseline === null, `cold restart with the switch off (${cold.time.toFixed(0)} s)`);
    // back on through the UI; the next edit is warm again
    await page.locator('[data-tab=simulate]').click();
    await page.getByLabel('Keep results warm after edits').focus();
    await page.keyboard.press('Space');
    eq(await page.evaluate(() => window.__logiplan.store.getState().ui.warmRestart), true, 'on again');
    noErrors('persistence');
    await context.close();
  });

  // ---------------------------------------------------------------------------------------------------------------
  // jank and memory
  // ---------------------------------------------------------------------------------------------------------------
  /** Before the app loads: an independent animation-frame loop that records the gap between frames and long animation frames. */
  const jankProbe = () => {
    window.__p = { gaps: [], loaf: [], on: false };
    let last = 0;
    const loop = (t) => {
      if (last && window.__p.on) window.__p.gaps.push([t - last, Boolean(window.__logiplan && window.__logiplan.runner.priming)]);
      last = t;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__p.loaf.push({ duration: e.duration, blocking: e.blockingDuration, priming: Boolean(window.__logiplan && window.__logiplan.runner.priming), scripts: e.scripts.map((s) => `${(s.sourceURL || '').split('/').slice(-2).join('/')}:${s.sourceFunctionName || '(anonymous)'} ${Math.round(s.duration)}ms`) }); }).observe({ type: 'long-animation-frame', buffered: true });
    } catch { /* not supported: the gaps remain */ }
  };

  /** A 160 x 160 plant with `vehicles` AGVs (streets every 12 cells, 48 stations on bays). */
  function bigPlant(vehicles) {
    const layout = L.createLayout({ name: 'Big plant', cols: 160, rows: 160, cellSize: 2 });
    for (let k = 4; k < 160; k += 12) {
      L.paintRoadPath(layout, [[2, k], [157, k]]);
      L.paintRoadPath(layout, [[k, 2], [k, 157]]);
    }
    const sources = []; const procs = []; const sinks = []; const depots = [];
    let n = 0;
    const place = (type, name, x, y, params, bay) => {
      const st = L.addStation(layout, { type, name, x, y, w: 3, h: 2, params });
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

  const stats = (list) => { const s = list.slice().sort((a, b) => a - b); return { n: s.length, max: s.length ? Math.round(s[s.length - 1]) : 0, p95: s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]) : 0 }; };

  async function measureEdits(page, rounds) {
    const out = [];
    for (let i = 0; i < rounds; i++) {
      await page.evaluate(() => {
        window.__p.gaps.length = 0; window.__p.loaf.length = 0; window.__p.on = true; window.__swapAt = 0; window.__t0 = performance.now();
        window.__logiplan.runner.on('rebuild', (e) => { if (e.warm && !window.__swapAt) window.__swapAt = performance.now(); });
        window.__logiplan.store.commit(`One more vehicle ${Math.random()}`, (l) => { l.fleets[0].count += 1; });
      });
      await page.waitForFunction(() => window.__swapAt, null, { timeout: 120000, polling: 50 });
      await page.waitForTimeout(250);
      out.push(await page.evaluate(() => ({
        toSwap: window.__swapAt - window.__t0,
        primingGaps: window.__p.gaps.filter((g) => g[1]).map((g) => g[0]),
        otherGaps: window.__p.gaps.filter((g) => !g[1]).map((g) => g[0]),
        loaf: window.__p.loaf.map((e) => ({ duration: Math.round(e.duration), priming: e.priming, scripts: e.scripts })),
      })));
    }
    return out;
  }

  await run('perf', async () => {
    const results = {};
    const { page, context } = await openApp({ init: jankProbe });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); await cdp.send('HeapProfiler.collectGarbage'); const m = await cdp.send('Performance.getMetrics'); return m.metrics.find((x) => x.name === 'JSHeapUsedSize').value / 1e6; };

    for (const id of ['starter', 'two-lines', 'congestion-lab']) {
      await start(page, id, { seconds: 1500, speed: 600 });
      const rounds = await measureEdits(page, 3);
      const gaps = rounds.flatMap((r) => r.primingGaps);
      const s = stats(gaps);
      const loaf = rounds.flatMap((r) => r.loaf.filter((e) => e.priming));
      results[id] = { toSwapMs: rounds.map((r) => Math.round(r.toSwap)), primingFrameGaps: s, longFramesWhilePriming: loaf };
      console.log(`   ${id}: edit -> swap ${results[id].toSwapMs.join(', ')} ms; frame gaps while priming n=${s.n} p95=${s.p95} ms max=${s.max} ms; long frames while priming ${JSON.stringify(loaf.map((e) => e.duration))}`);
      ok(s.max <= 100, `${id}: no frame gap over 100 ms while priming: ${s.max} ms`);
      ok(loaf.length === 0, `${id}: no long animation frame while priming: ${JSON.stringify(loaf)}`);
      ok(results[id].toSwapMs.every((ms) => ms < 1500), `${id}: every edit is shown within 1.5 s`);
    }

    // the big plant: the old simulation stands still while priming; how long, and how smooth is the page meanwhile?
    await start(page, bigPlant(100), { seconds: 400, speed: 600 });
    const bigRounds = await measureEdits(page, 3);
    const bigGaps = stats(bigRounds.flatMap((r) => r.primingGaps));
    const bigLoaf = bigRounds.flatMap((r) => r.loaf);
    results.big100 = { toSwapMs: bigRounds.map((r) => Math.round(r.toSwap)), primingFrameGaps: bigGaps, longFrames: bigLoaf };
    console.log(`   big plant (160 x 160, 100 vehicles): edit -> swap ${results.big100.toSwapMs.join(', ')} ms; priming frame gaps p95=${bigGaps.p95} ms max=${bigGaps.max} ms; long frames ${JSON.stringify(bigLoaf.map((e) => `${e.duration} ms${e.priming ? ' (priming)' : ''} [${e.scripts.join('; ')}]`))}`);
    ok(bigGaps.max <= 100, `big plant: no frame gap over 100 ms while priming: ${bigGaps.max} ms`);
    ok(bigRounds.every((r) => r.toSwap < 5000), 'big plant: the pre-roll ends within 5 s');
    ok(bigLoaf.filter((e) => e.priming).length === 0, 'big plant: the pre-roll itself never produces a long animation frame (the one at the moment of the edit is the app\'s own validation of the 160 x 160 plant, not priming)');

    // memory over 100 edits, a real-engine run; the undo history is capped at 100 steps, so the heap must level off, not grow without end
    await start(page, 'starter', { seconds: 1500, speed: 1200 });
    const edits = async (n, offset) => {
      for (let i = 0; i < n; i++) {
        await mark(page);
        await page.evaluate((k) => window.__logiplan.store.commit(`Edit ${k}`, (l) => { l.fleets[0].count = k % 2 ? 3 : 2; l.stations[0].name = `Goods ${k}`; }), i + offset);
        await swapped(page);
      }
    };
    await edits(20, 0);
    const h20 = await heap();
    await edits(100, 20);
    const h120 = await heap();
    await edits(100, 120);
    const h220 = await heap();
    const state = await page.evaluate(() => ({ labels: window.__logiplan.runner.baseline?.labels.length, edits: window.__logiplan.runner.baseline?.edits, toasts: document.querySelectorAll('.toast').length, nodes: document.querySelectorAll('*').length }));
    results.memory = { h20, h120, h220, ...state };
    console.log(`   heap after 20 / 120 / 220 edits: ${h20.toFixed(1)} / ${h120.toFixed(1)} / ${h220.toFixed(1)} MB; labels ${state.labels}, toasts ${state.toasts}, DOM nodes ${state.nodes}`);
    ok(h220 - h120 < 2, `the heap levels off (${(h220 - h120).toFixed(2)} MB more over the second hundred edits)`);
    ok(state.labels <= 12 && state.toasts <= 6, 'labels and toasts stay bounded');
    writeFileSync(path.join(OUT, 'edit-feedback-review-perf.json'), JSON.stringify(results, null, 2));
    noErrors('perf');
    await context.close();
  });

  const open = defects.filter((d) => d.open);
  console.log(`\n${checks} guard checks passed; ${open.length} of ${defects.length} defect checks OPEN${open.length ? `: ${[...new Set(open.map((d) => d.id))].join(', ')}` : ''}`);
}, { viewport: DESKTOP });
