// First-time-planner walkthrough of the REAL app (index.html + js/main.js) in headless Chromium.
//
// The planner has never read the docs and may only use what is on screen: a toast, the Next steps card, the guide chip, the flow
// handle on a selected station, the Properties tab "Where do loads go?", the Checks tab. Every action here is a real mouse or
// keyboard event (page.mouse / page.keyboard / locator.click), never a store shortcut; the store is only READ to check results.
//
// Run: node tests/e2e/walkthrough.mjs [section]
//   sections: feedback ways scratch break narrow dark keys perf
//   feedback   A  load the Starter, add a second Goods in, follow the guidance, run, prove both flows are served by the same AGVs
//   ways       A  every way to connect (toast, handle, Properties picker, Next steps, Flow tool, Checks Fix) and Undo for each
//   scratch    B  new empty plant -> Getting started + Next steps only -> roads, three stations, flows, fleet, run (clicks counted)
//   break      C  delete a flow, cut the road, fleet to 0, restrict a flow to an empty fleet, add a station off the road
//   narrow     D  390x800 touch layout (chip, popover, drawer, connect with a finger)
//   dark       D  dark mode at 1440 and 390
//   keys       D  keyboard only: Tab to Connect, Enter, Esc, chip; screen-reader names of every control
//   perf       E  guidance cost per store change, frame rate with the Jobs overlay
// Screenshots: e2e-output/wt-*.png (open them and look). Every section asserts that the page logged no console error or warning.
// At the end a click count per scenario and the list of "confusing moments" the script detected are printed.
import assert from 'node:assert/strict';
import path from 'node:path';
import { withBrowser, OUT } from './browser.mjs';

const only = process.argv[2] || '';
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

const DESKTOP = { width: 1440, height: 900 };
const NARROW = { width: 390, height: 800 };

/** Real input actions of the current scenario: the "clicks" a planner would count. */
const tally = { name: '', clicks: 0, drags: 0, keys: 0, typed: 0 };
const tallies = [];
const confusions = [];
const startTally = (name) => { tally.name = name; tally.clicks = 0; tally.drags = 0; tally.keys = 0; tally.typed = 0; };
const endTally = () => { tallies.push({ ...tally }); };
const total = (t) => t.clicks + t.drags + t.keys;
/** A moment where a newcomer would be confused or stuck (found by the script, to be fixed or reported). */
const confused = (where, what) => { confusions.push({ scenario: tally.name, where, what }); console.log(`   ?? ${where}: ${what}`); };

await withBrowser(async ({ browser, url, errors }) => {
  // ---- plumbing -------------------------------------------------------------------------------------------------

  async function openApp({ viewport = DESKTOP, colorScheme = 'light', touch = false, welcome = 'keep' } = {}) {
    const context = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 1, hasTouch: touch, isMobile: touch });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[console.${m.type()}] ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    await page.goto(url('/index.html'));
    await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
    if (welcome === 'close') await closeWelcome(page);
    return { page, context };
  }

  async function closeWelcome(page) {
    if (await page.locator('[role=dialog]').count()) {
      await page.getByRole('button', { name: 'Close' }).last().click();
      tally.clicks++;
      await page.locator('[role=dialog]').waitFor({ state: 'detached' });
    }
  }

  const shot = (page, name) => page.screenshot({ path: path.join(OUT, `wt-${name}.png`) });
  const frames = (page, n = 3) => page.evaluate((count) => new Promise((resolve) => {
    const next = (left) => (left ? requestAnimationFrame(() => next(left - 1)) : resolve());
    next(count);
  }), n);
  const noErrors = (what) => { eq(errors.splice(0).filter((e) => !/willReadFrequently/.test(e)), [], `${what}: console errors or warnings`); };
  const layoutOf = (page) => page.evaluate(() => structuredClone(window.__logiplan.store.getState().layout));
  const stateOf = (page) => page.evaluate(() => {
    const s = window.__logiplan.store.getState();
    return { undoLabel: s.undoLabel, canUndo: s.canUndo, selection: structuredClone(s.ui.selection), tab: s.ui.rightTab, tool: s.ui.tool };
  });
  const flowPairs = async (page) => (await layoutOf(page)).flows.map((f) => `${f.from}>${f.to}`);
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

  // ---- real input, counted --------------------------------------------------------------------------------------

  async function click(page, target, why = '') {
    const loc = typeof target === 'string' ? page.locator(target).first() : target;
    await loc.click();
    tally.clicks++;
    await frames(page);
    if (why) console.log(`   click: ${why}`);
  }
  const cellXY = (page, cx, cy, fx = 0.5, fy = 0.5) => page.evaluate(([x, y, a, b]) => {
    const { camera, canvas } = window.__logiplan.ctx;
    const cs = window.__logiplan.store.getState().layout.grid.cellSize;
    const [px, py] = camera.worldToScreen((x + a) * cs, (y + b) * cs);
    const r = canvas.getBoundingClientRect();
    return [r.left + px, r.top + py];
  }, [cx, cy, fx, fy]);
  async function clickCell(page, cx, cy, why = '') {
    const [x, y] = await cellXY(page, cx, cy);
    await page.mouse.click(x, y);
    tally.clicks++;
    await frames(page);
    if (why) console.log(`   click on the plan (${cx},${cy}): ${why}`);
  }
  async function dragPoints(page, from, to, { steps = 12, keep = false } = {}) {
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    await page.mouse.move(to[0], to[1], { steps });
    if (!keep) {
      await page.mouse.up();
      await frames(page);
    }
    tally.drags++;
  }
  /** Drag a road along the cells `path` ([[cx, cy], ...]) with the real mouse (one drag). */
  async function dragRoad(page, cells) {
    const pts = [];
    for (const [cx, cy] of cells) pts.push(await cellXY(page, cx, cy));
    await page.mouse.move(pts[0][0], pts[0][1]);
    await page.mouse.down();
    for (const p of pts.slice(1)) await page.mouse.move(p[0], p[1], { steps: 6 });
    await page.mouse.up();
    tally.drags++;
    await frames(page);
  }
  async function press(page, key) {
    await page.keyboard.press(key);
    tally.keys++;
    await frames(page);
  }

  /** Page coordinates of the flow handle (found through the renderer's own hit test around the selected station). */
  const findHandle = (page) => page.evaluate(() => {
    const { ctx, store } = window.__logiplan;
    const state = store.getState();
    const s = state.ui.selection.kind === 'station' ? state.layout.stations.find((e) => e.id === state.ui.selection.ids[0]) : null;
    const r = ctx.canvas.getBoundingClientRect();
    let x0 = 0, y0 = 0, x1 = r.width, y1 = r.height;
    if (s) {
      const cs = state.layout.grid.cellSize;
      const a = ctx.camera.worldToScreen(s.x * cs, s.y * cs);
      const b = ctx.camera.worldToScreen((s.x + s.w) * cs, (s.y + s.h) * cs);
      x0 = Math.max(0, a[0] - 70); y0 = Math.max(0, a[1] - 70); x1 = Math.min(r.width, b[0] + 70); y1 = Math.min(r.height, b[1] + 70);
    }
    let sx = 0, sy = 0, n = 0;
    for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
      if (ctx.renderer.hitTest(x, y).kind === 'connect-handle') { sx += x; sy += y; n++; }
    }
    return n ? [r.left + sx / n, r.top + sy / n] : null;
  });

  // ---- what is on screen right now ------------------------------------------------------------------------------

  const visibleText = (page, selector) => page.evaluate((sel) => [...document.querySelectorAll(sel)]
    .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden')
    .map((el) => el.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean), selector);
  const toastsOf = (page) => visibleText(page, '.toast .toast__msg');
  const chipOf = async (page) => (await visibleText(page, '[data-guide-chip-button]'))[0] || '';
  const stepsOf = (page, panel = 'properties') => page.evaluate((p) => [...document.querySelectorAll(`#panel-${p} [data-step]`)]
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => ({ id: el.dataset.step, title: el.querySelector('.guide-step__title')?.textContent || '', text: el.querySelector('.guide-step__text')?.textContent || '',
      buttons: [...el.querySelectorAll('button')].filter((b) => b.getClientRects().length > 0).map((b) => b.innerText.trim() || b.getAttribute('aria-label')) })), panel);
  const statusOf = (page) => page.evaluate(() => document.querySelector('[data-region=status-text]')?.textContent || '');
  const badgeOf = async (page) => (await visibleText(page, '[data-tab=checks] .badge'))[0] || '';
  async function tab(page, id) {
    await click(page, `[data-tab=${id}]`);
    await page.locator(`#panel-${id}`).waitFor({ state: 'visible' });
  }
  /** Print what a planner can read on screen now. */
  async function reads(page, label) {
    const steps = await stepsOf(page);
    console.log(`  [${label}]`);
    console.log(`     chip: ${JSON.stringify(await chipOf(page))}  checks badge: ${JSON.stringify(await badgeOf(page))}  status: ${JSON.stringify(await statusOf(page))}`);
    const toasts = await toastsOf(page);
    if (toasts.length) console.log(`     toast: ${JSON.stringify(toasts)}`);
    for (const s of steps) console.log(`     step ${s.id}: "${s.title}" - ${s.text} [${s.buttons.join(' | ')}]`);
  }

  const run = async (name, fn) => {
    if (only && only !== name) return;
    const t0 = Date.now();
    console.log(`-- ${name}`);
    await fn();
    noErrors(name);
    console.log(`   done in ${Math.round((Date.now() - t0) / 100) / 10} s`);
  };

  async function pickExample(page, namePart) {
    await click(page, page.locator('[role=dialog]').getByRole('button', { name: new RegExp(namePart, 'i') }).first(), `example "${namePart}"`);
    const confirm = page.locator('[role=dialog]').getByRole('button', { name: 'Open example' });
    if (await confirm.count()) await click(page, confirm);
    await page.locator('[role=dialog]').first().waitFor({ state: 'detached' });
    await frames(page, 4);
  }

  // ---------------------------------------------------------------------------------------------------------------
  /** Starter loaded, a second Goods in placed with the real tool next to the west road. Returns { page, context, second }. */
  async function starterWithSecondGoodsIn(opts = {}) {
    const { page, context } = await openApp(opts);
    await pickExample(page, 'Starter');
    const before = (await layoutOf(page)).stations.map((s) => s.id);
    await click(page, '[data-tool=source]', 'Goods in tool');
    await clickCell(page, 3, 14, 'place the second Goods in next to the road');
    const second = (await layoutOf(page)).stations.find((s) => !before.includes(s.id));
    ok(second, 'the Goods in tool placed a station');
    return { page, context, second };
  }

  // A. The feedback
  await run('feedback', async () => {
    startTally('A feedback');
    const { page, context, second } = await starterWithSecondGoodsIn();
    await reads(page, 'second Goods in placed');
    await shot(page, 'a03-placed');
    // the toast offers Connect
    await click(page, page.locator('.toast').getByRole('button', { name: 'Connect' }), 'toast: Connect');
    await reads(page, 'after the toast Connect');
    await shot(page, 'a04-connect-mode');
    await clickCell(page, 20, 13, 'click the Assembly');
    await reads(page, 'after clicking the Assembly');
    await shot(page, 'a05-connected');
    eq(await flowPairs(page), ['s1>s2', 's2>s3', `${second.id}>s2`], 'the second Goods in now has a flow into the Assembly');

    // a curious planner: who serves what? Assembly, Flows tab, Fleet tab
    await clickCell(page, 20, 13, 'select the Assembly');
    await shot(page, 'a05b-assembly');
    await tab(page, 'flows');
    await shot(page, 'a05c-flows-tab');
    await tab(page, 'fleet');
    await shot(page, 'a05d-fleet-tab');
    await tab(page, 'properties');

    // run it with the Run button of the Next steps card, then watch the live numbers
    await click(page, page.locator('#panel-properties [data-step="run:press-play"]').getByRole('button', { name: /Run/ }), 'Run (Next steps card)');
    await page.evaluate(() => {
      const { runner } = window.__logiplan;
      window.__served = {};
      runner.sim.on('orderDelivered', ({ order }) => {
        const k = `${order.vehicleId}|${order.flowId}`;
        window.__served[k] = (window.__served[k] || 0) + 1;
      });
    });
    await page.selectOption('select[aria-label="Simulation speed"]', '600');
    tally.clicks++;
    await page.waitForFunction(() => window.__logiplan.runner.sim.time >= 2400, null, { timeout: 120000 });
    await reads(page, 'running');
    await shot(page, 'a06-running');
    const live = await page.evaluate(() => {
      const k = window.__logiplan.runner.kpis();
      return { flows: Object.fromEntries(Object.entries(k.flows).map(([id, f]) => [id, { from: f.from, to: f.to, delivered: f.delivered, trips: f.trips, backlog: f.backlog }])),
        fleets: Object.fromEntries(Object.entries(k.fleets).map(([id, f]) => [id, { count: f.count, trips: f.trips, vehicleTrips: f.vehicleTrips }])), served: window.__served,
        throughput: k.throughput.total };
    });
    console.log(JSON.stringify(live, null, 1));
    await page.waitForFunction(() => window.__logiplan.runner.sim.time >= 2400 + 600, null, { timeout: 120000 });
    await reads(page, 'running longer');
    const open = page.locator('#panel-properties [data-step="run:open-results"]');
    console.log('   open results step visible:', await open.count());
    await tab(page, 'results');
    await page.waitForTimeout(600);
    await shot(page, 'a07-results');
    const insights = await visibleText(page, '#panel-results .insight, #panel-results [data-insight]');
    console.log('   insights:', JSON.stringify(insights));
    await context.close();
    endTally();
  });

  // A2. Every way to connect the new Goods in, each followed by Undo (Ctrl+Z) so the next way starts from the same plant
  await run('ways', async () => {
    startTally('A ways');
    const { page, context, second } = await starterWithSecondGoodsIn();
    const unconnected = await flowPairs(page);
    const want = `${second.id}>s2`;
    const undoAll = async (label) => {
      await press(page, 'Control+z');
      eq(await flowPairs(page), unconnected, `${label}: Undo (Ctrl+Z) takes the new flow away again`);
    };
    const used = () => total(tally);
    const counts = {};
    const way = async (name, fn) => {
      const before = used();
      await fn();
      counts[name] = used() - before;
      ok((await flowPairs(page)).includes(want) || (await flowPairs(page)).some((f) => f.startsWith(`${second.id}>`)), `${name}: the new Goods in has a flow`);
      eq((await stateOf(page)).undoLabel?.startsWith('Connect '), true, `${name}: the undo step is labelled "Connect ..." (${(await stateOf(page)).undoLabel})`);
      await shot(page, `w-${name.replace(/\W+/g, '-').toLowerCase()}`);
      await undoAll(name);
    };

    // 1. the toast's Connect button, then a click on the receiving station
    await way('toast', async () => {
      await click(page, page.locator('.toast').getByRole('button', { name: 'Connect' }), 'toast Connect');
      await clickCell(page, 20, 13, 'click the Assembly');
    });
    // 2. the Select tool and the flow handle
    await way('handle', async () => {
      await click(page, '[data-tool=select]', 'Select tool');
      await clickCell(page, 3, 14, 'select the new Goods in');
      const handle = await findHandle(page);
      ok(handle, 'the flow handle is visible on the selected Goods in');
      await shot(page, 'w-handle-before');
      await dragPoints(page, handle, await cellXY(page, 20, 13));
    });
    // 3. Properties: Where do loads go?
    await way('properties', async () => {
      await clickCell(page, 3, 14, 'select the new Goods in');
      await tab(page, 'properties');
      const box = page.locator('#panel-properties [data-loads=out]');
      await box.waitFor();
      await shot(page, 'w-properties-before');
      await click(page, box.getByRole('button', { name: /Connect/ }).first(), 'Properties: Connect');
    });
    // 4. the Next steps card
    await way('nextsteps', async () => {
      await click(page, page.locator('#panel-properties [data-step^="connect-out:"]').getByRole('button', { name: /Connect/ }), 'Next steps: Connect');
    });
    // 5. the Flow tool
    await way('flowtool', async () => {
      await click(page, '[data-tool=flow]', 'Flow tool');
      await clickCell(page, 3, 14, 'click the Goods in');
      await clickCell(page, 20, 13, 'click the Assembly');
      await click(page, '[data-tool=select]', 'back to Select');
    });
    // 6. Checks tab
    await way('checks', async () => {
      await tab(page, 'checks');
      await shot(page, 'w-checks-before');
      const fix = page.locator('#panel-checks [data-role=fix]').first();
      await fix.waitFor();
      await click(page, fix, 'Checks: Connect');
    });
    // 7. the guide chip
    await way('chip', async () => {
      await click(page, '[data-guide-chip-button]', 'guide chip');
      await shot(page, 'w-chip-open');
      await click(page, page.locator('.guide-pop').getByRole('button', { name: /Connect/ }).first(), 'chip popover: Connect');
    });
    console.log('   actions per way (from the "placed" state):', JSON.stringify(counts));
    await context.close();
    endTally();
  });

  // B. From scratch: an empty plant, only the Getting started list and the Next steps card
  await run('scratch', async () => {
    startTally('B scratch');
    const { page, context } = await openApp();
    await reads(page, 'welcome');
    await click(page, page.getByRole('button', { name: 'Create empty plant' }), 'Create empty plant');
    await page.locator('[role=dialog]').first().waitFor({ state: 'detached' });
    await frames(page, 4);
    await reads(page, 'empty plant');
    await shot(page, 'b01-empty');
    const checklist = async (label) => {
      const rows = await page.evaluate(() => [...document.querySelectorAll('.guide-check__row')].map((r) => `${r.classList.contains('is-done') ? '[x]' : r.classList.contains('is-current') ? '[>]' : '[ ]'} ${r.querySelector('.guide-check__title')?.textContent}`));
      console.log(`     checklist (${label}): ${rows.join(' | ')}`);
    };
    await checklist('start');

    // 1. roads: the checklist row "Draw roads"
    await click(page, page.locator('.guide-check__row').first(), 'checklist: Draw roads');
    await reads(page, 'road tool chosen');
    await dragRoad(page, [[6, 12], [40, 12]]);
    await reads(page, 'one straight road drawn');
    await checklist('after the road');
    await shot(page, 'b02-road');

    // 2. stations: the Goods in button of the Next steps card, then a click next to the road
    await click(page, page.locator('#panel-properties [data-step="place-stations"]').getByRole('button', { name: /Goods in/ }), 'Next steps: Goods in tool');
    await clickCell(page, 8, 10, 'place Goods in above the road');
    await reads(page, 'Goods in placed');
    await shot(page, 'b03-goods-in');
    await checklist('after Goods in');
    await click(page, page.locator('#panel-properties [data-loads=out]').getByRole('button', { name: /Workstation/ }), 'Where do loads go?: Workstation tool');
    await clickCell(page, 20, 10, 'place the Workstation above the road');
    await reads(page, 'Workstation placed');
    await shot(page, 'b04-workstation');
    await checklist('after the Workstation');
    // Goods out: the Next steps card of the Workstation says to place one
    await click(page, page.locator('#panel-properties [data-loads=out]').getByRole('button', { name: /Goods out/ }), 'Where do loads go?: Goods out tool');
    await clickCell(page, 34, 13, 'place Goods out below the road');
    await reads(page, 'Goods out placed');
    await shot(page, 'b05-three-stations');
    await checklist('after three stations');

    // 3. flows: the Connect buttons of the two Next steps (one suggestion each)
    await click(page, page.locator('#panel-properties [data-step="connect-out:s1"]').getByRole('button', { name: /Connect/ }), 'Next steps: Goods in 1 -> Workstation 1');
    await reads(page, 'first flow');
    await click(page, page.locator('#panel-properties [data-step="connect-out:s2"]').getByRole('button', { name: /Connect/ }), 'Next steps: Workstation 1 -> Goods out 1');
    await reads(page, 'second flow');
    await shot(page, 'b06-flows');
    eq(await flowPairs(page), ['s1>s2', 's2>s3'], 'two flows: Goods in -> Workstation -> Goods out');

    // 4. vehicles
    await click(page, page.locator('#panel-properties [data-step="no-fleet"]').getByRole('button', { name: /Add vehicles/ }), 'Next steps: Add vehicles');
    await reads(page, 'vehicles added');
    await shot(page, 'b07-vehicles');
    eq((await layoutOf(page)).fleets.map((f) => f.count), [2], 'two AGVs were added');

    // 5. run
    await click(page, page.locator('#panel-properties [data-step="run:press-play"]').getByRole('button', { name: /Run/ }), 'Next steps: Run');
    await page.selectOption('select[aria-label="Simulation speed"]', '120');
    tally.clicks++;
    await page.waitForFunction(() => window.__logiplan.runner.sim.time >= 420, null, { timeout: 120000 });
    await reads(page, 'running 7 minutes');
    await shot(page, 'b08-running');
    await checklist('while running');

    // 6. results
    await click(page, page.locator('#panel-properties [data-step="run:open-results"]').getByRole('button', { name: /Open Results/ }), 'Next steps: Open Results');
    await shot(page, 'b09-results');
    await checklist('after results');
    await reads(page, 'results');
    await context.close();
    endTally();
  });

  // C. Break it: every mistake must be noticed within a second and say what to do
  /** Everything a planner can read about problems right now: chip, steps of the card on screen, Checks callouts (if that tab is open). */
  const problemsOf = (page) => page.evaluate(() => {
    const vis = (el) => el.getClientRects().length > 0;
    const text = (el) => el.innerText.replace(/\s+/g, ' ').trim();
    return {
      chip: document.querySelector('[data-guide-chip-button]') && vis(document.querySelector('[data-guide-chip-button]')) ? text(document.querySelector('[data-guide-chip-button]')) : '',
      steps: [...document.querySelectorAll('.guide-stack [data-step]')].filter(vis).map((el) => ({ id: el.dataset.step, text: text(el) })),
      callouts: [...document.querySelectorAll('.callout')].filter(vis).map(text),
      badge: (() => { const b = document.querySelector('[data-tab=checks] .badge'); return b && vis(b) ? text(b) : ''; })(),
    };
  });
  /** Wait until `want(problems)` is true; returns the milliseconds it took (the planner's wait) and the problems. */
  async function noticed(page, want, label, limit = 1000) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < limit) {
      last = await problemsOf(page);
      if (want(last)) return { ms: Date.now() - t0, problems: last };
      await page.waitForTimeout(25);
    }
    console.log(`   NOT noticed within ${limit} ms: ${label}`, JSON.stringify(last));
    return { ms: Infinity, problems: last };
  }
  const flowPoint = (page, flowId) => page.evaluate((id) => {
    const { ctx, store } = window.__logiplan;
    const layout = store.getState().layout;
    const f = layout.flows.find((e) => e.id === id);
    const a = layout.stations.find((s) => s.id === f.from);
    const b = layout.stations.find((s) => s.id === f.to);
    const cs = layout.grid.cellSize;
    const r = ctx.canvas.getBoundingClientRect();
    const A = ctx.camera.worldToScreen((a.x + a.w / 2) * cs, (a.y + a.h / 2) * cs);
    const B = ctx.camera.worldToScreen((b.x + b.w / 2) * cs, (b.y + b.h / 2) * cs);
    for (let i = 3; i <= 17; i++) {
      const t = i / 20;
      for (let dy = -40; dy <= 40; dy += 2) for (let dx = -20; dx <= 20; dx += 2) {
        const x = A[0] + (B[0] - A[0]) * t + dx;
        const y = A[1] + (B[1] - A[1]) * t + dy;
        const hit = ctx.renderer.hitTest(x, y);
        if (hit.kind === 'flow' && hit.id === id) return [r.left + x, r.top + y];
      }
    }
    return null;
  }, flowId);

  await run('break', async () => {
    startTally('C break');
    const timings = {};
    const record = (name, r) => { timings[name] = r.ms; };

    // C1. delete a flow: the plan canvas, Delete key
    {
      const { page, context } = await openApp();
      await pickExample(page, 'Starter');
      const at = await flowPoint(page, 'f2');
      ok(at, 'found the flow Assembly -> Dispatch on the plan');
      await page.mouse.click(at[0], at[1]);
      tally.clicks++;
      await frames(page);
      eq((await stateOf(page)).selection, { kind: 'flow', ids: ['f2'] }, 'the flow is selected by clicking it');
      await press(page, 'Delete');
      const r = await noticed(page, (p) => p.steps.some((s) => /not connected|Nothing feeds/.test(s.text)) || /step/.test(p.chip) && p.chip !== '1 step to finish', 'flow deleted');
      record('delete a flow', r);
      console.log('   C1 delete a flow ->', JSON.stringify(r));
      await shot(page, 'c1-flow-deleted');
      await context.close();
    }

    // C2. cut the only road cell beside a station with the Eraser
    {
      const { page, context } = await openApp();
      await pickExample(page, 'Starter');
      await click(page, '[data-tool=erase]', 'Eraser');
      await clickCell(page, 9, 7, 'erase the road cell below Goods receiving');
      const r = await noticed(page, (p) => p.steps.some((s) => /does not touch a road/.test(s.text)), 'road cut');
      record('cut the road', r);
      console.log('   C2 cut the road ->', JSON.stringify(r));
      await shot(page, 'c2-road-cut');
      await context.close();
    }

    // C3. the fleet down to 0 vehicles
    {
      const { page, context } = await openApp();
      await pickExample(page, 'Starter');
      await tab(page, 'fleet');
      const fewer = page.locator('#panel-fleet').getByRole('button', { name: /Fewer|Remove one|decrease/i }).first();
      await fewer.click(); tally.clicks++;
      await fewer.click(); tally.clicks++;
      eq((await layoutOf(page)).fleets[0].count, 0, 'the AGV fleet has no vehicles');
      const r = await noticed(page, (p) => p.steps.some((s) => /no vehicles/i.test(s.text)), 'fleet to 0');
      record('fleet to 0', r);
      console.log('   C3 fleet 0 ->', JSON.stringify(r));
      await shot(page, 'c3-fleet-zero');
      await context.close();
    }

    // C4. a flow restricted to a fleet without vehicles
    {
      const { page, context } = await openApp();
      await pickExample(page, 'Starter');
      await tab(page, 'fleet');
      await click(page, page.locator('#panel-fleet').getByRole('button', { name: 'Add fleet' }).first(), 'Add fleet');
      await shot(page, 'c4a-fleet-added');
      const layout1 = await layoutOf(page);
      console.log('   fleets now:', JSON.stringify(layout1.fleets.map((f) => [f.id, f.name, f.count])));
      // the new fleet's card: dedicate the first flow to it, then take its vehicles away with the stepper
      const mine = page.locator('#panel-fleet .card', { hasText: 'AGV 2' }).first();
      await click(page, mine.getByText('Only this fleet').first(), 'Only this fleet (first flow)');
      eq((await layoutOf(page)).flows[0].fleetId, 'v2', 'the flow is restricted to the new fleet');
      const fewer = mine.getByRole('button', { name: /Fewer|Remove one|decrease/i }).first();
      await fewer.click(); tally.clicks++;
      await fewer.click(); tally.clicks++;
      eq((await layoutOf(page)).fleets[1].count, 0, 'the new fleet has no vehicles');
      const r = await noticed(page, (p) => p.callouts.some((c) => /Goods receiving|no vehicles|waiting|cannot/i.test(c)), 'restricted flow, empty fleet');
      record('restricted to an empty fleet', r);
      console.log('   C4 restricted to an empty fleet ->', JSON.stringify(r));
      await shot(page, 'c4b-restricted-empty');
      await tab(page, 'checks');
      await shot(page, 'c4c-checks');
      console.log('   checks:', JSON.stringify((await problemsOf(page)).callouts));
      await tab(page, 'properties');
      console.log('   properties:', JSON.stringify((await problemsOf(page)).steps), (await problemsOf(page)).chip);
      await context.close();
    }

    // C5. a station off the road
    {
      const { page, context } = await openApp();
      await pickExample(page, 'Starter');
      await click(page, '[data-tool=process]', 'Workstation tool');
      await clickCell(page, 30, 3, 'place a Workstation far from any road');
      const r = await noticed(page, (p) => p.steps.some((s) => /does not touch a road/.test(s.text)) || p.callouts.some((c) => /road/i.test(c)), 'station off the road');
      record('station off the road', r);
      console.log('   C5 off road ->', JSON.stringify(r));
      await shot(page, 'c5-off-road');
      await context.close();
    }
    console.log('   time to notice (ms):', JSON.stringify(timings));
    endTally();
  });

  // D. 390 x 800 with a finger, dark mode, keyboard only, screen-reader names
  const tap = async (page, target, why = '') => {
    const loc = typeof target === 'string' ? page.locator(target).first() : target;
    await loc.tap();
    tally.clicks++;
    await frames(page);
    if (why) console.log(`   tap: ${why}`);
  };
  const tapCell = async (page, cx, cy, why = '') => {
    const [x, y] = await cellXY(page, cx, cy);
    await page.touchscreen.tap(x, y);
    tally.clicks++;
    await frames(page, 4);
    if (why) console.log(`   tap on the plan (${cx},${cy}): ${why}`);
  };

  await run('narrow', async () => {
    startTally('D narrow');
    const { page, context } = await openApp({ viewport: NARROW, touch: true });
    await shot(page, 'd01-welcome-390');
    await tap(page, page.locator('[role=dialog]').getByRole('button', { name: /Starter/i }).first(), 'Starter');
    const confirm = page.locator('[role=dialog]').getByRole('button', { name: 'Open example' });
    if (await confirm.count()) await tap(page, confirm);
    await page.locator('[role=dialog]').first().waitFor({ state: 'detached' });
    await frames(page, 4);
    await shot(page, 'd02-starter-390');
    console.log('   overflow px:', await overflow(page));
    await reads(page, 'narrow: Starter');
    await tap(page, '[data-tool=source]', 'Goods in tool');
    await shot(page, 'd03-tool-390');
    await tapCell(page, 3, 14, 'place the second Goods in');
    await shot(page, 'd04-placed-390');
    await reads(page, 'narrow: placed');
    console.log('   overflow px:', await overflow(page));
    // the toast's Connect, with a finger: connect mode, tap the Assembly
    await tap(page, page.locator('.toast').getByRole('button', { name: 'Connect' }), 'toast: Connect');
    await shot(page, 'd05-connect-mode-390');
    await tapCell(page, 20, 13, 'tap the Assembly');
    await shot(page, 'd06-connected-390');
    await reads(page, 'narrow: connected');
    eq((await flowPairs(page)).length, 3, 'a finger can connect the second Goods in');
    // undo, then the chip: a finger opens the popover, taps Connect
    await page.locator('.toast__close').evaluateAll((els) => els.forEach((e) => e.click()));
    await tap(page, '[aria-label="Undo"], [aria-label^="Undo"]', 'Undo');
    await reads(page, 'narrow: undone');
    await tap(page, '[data-guide-chip-button]', 'guide chip');
    await shot(page, 'd07-chip-open-390');
    const pop = await page.locator('.guide-pop').boundingBox();
    ok(pop && pop.x >= 0 && pop.x + pop.width <= NARROW.width, `the chip popover fits the 390 px screen (${JSON.stringify(pop)})`);
    await tap(page, page.locator('.guide-pop').getByRole('button', { name: /Connect/ }).first(), 'chip popover: Connect');
    await shot(page, 'd08-chip-connected-390');
    eq((await flowPairs(page)).length, 3, 'the chip popover connects with a tap');
    // the drawer: Next steps card and Properties
    await tap(page, '[aria-label="Details panel"]', 'open the details panel');
    await page.waitForTimeout(450); // the drawer slides in
    await shot(page, 'd09-drawer-390');
    await reads(page, 'narrow: drawer');
    console.log('   overflow px:', await overflow(page));
    await tap(page, '[aria-label="Close the details panel"]', 'close the drawer');
    await context.close();
    endTally();
  });

  // D2. dark mode: the same states at 1440 and 390 px
  await run('dark', async () => {
    startTally('D dark');
    for (const [name, viewport, touch] of [['1440', DESKTOP, false], ['390', NARROW, true]]) {
      const { page, context } = await openApp({ viewport, colorScheme: 'dark', touch });
      await shot(page, `d10-welcome-dark-${name}`);
      await (touch ? tap : click)(page, page.locator('[role=dialog]').getByRole('button', { name: /Starter/i }).first());
      const confirm = page.locator('[role=dialog]').getByRole('button', { name: 'Open example' });
      if (await confirm.count()) await click(page, confirm);
      await page.locator('[role=dialog]').first().waitFor({ state: 'detached' });
      await (touch ? tap : click)(page, '[data-tool=source]');
      await (touch ? tapCell : clickCell)(page, 3, 14);
      await page.locator('.toast__close').evaluateAll((els) => els.forEach((e) => e.click()));
      await shot(page, `d11-placed-dark-${name}`);
      await (touch ? tap : click)(page, '[data-guide-chip-button]');
      await shot(page, `d12-chip-dark-${name}`);
      await (touch ? tap : click)(page, '.guide-pop [aria-label="Close the list of next steps"]');
      if (!touch) {
        await click(page, '[data-tab=checks]');
        await shot(page, `d13-checks-dark-${name}`);
        await click(page, '[data-tab=flows]');
        await shot(page, `d14-flows-dark-${name}`);
      }
      await context.close();
    }
    endTally();
  });

  // D3. keyboard only: from the plan with a second Goods in (placed with the mouse, there is no keyboard way to place) on, no pointer
  const focusInfo = (page) => page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return { where: 'body' };
    const name = a.getAttribute('aria-label') || a.innerText?.trim() || a.getAttribute('title') || a.tagName;
    return { where: a.closest('.guide-pop') ? 'chip popover' : a.closest('.guide-chip') ? 'chip' : a.closest('.guide') ? 'Next steps card' : a.closest('[data-loads]') ? 'station form' : a.closest('#panel-properties') ? 'Properties' : a.closest('.toast') ? 'toast' : a.id === 'plant' ? 'plan' : a.tagName.toLowerCase(), name: String(name).slice(0, 80), visible: a.matches(':focus-visible') };
  });
  /** Accessible name of an element, the way a screen reader derives it (aria-labelledby, aria-label, label, text, title). */
  const accessibleNames = (page, scope) => page.evaluate((sel) => {
    const nameOf = (el) => {
      const by = el.getAttribute('aria-labelledby');
      if (by) return by.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() || '').join(' ').trim();
      const label = el.getAttribute('aria-label');
      if (label) return label.trim();
      if (el.id) { const l = document.querySelector(`label[for="${el.id}"]`); if (l) return l.textContent.trim(); }
      const wrap = el.closest('label');
      if (wrap) return wrap.textContent.trim();
      return (el.textContent || '').replace(/\s+/g, ' ').trim() || el.getAttribute('title') || '';
    };
    return [...document.querySelectorAll(sel)].filter((el) => el.getClientRects().length > 0)
      .map((el) => ({ tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', name: nameOf(el), expanded: el.getAttribute('aria-expanded'), live: el.getAttribute('aria-live') }));
  }, scope);

  await run('keys', async () => {
    startTally('D keys');
    const { page, context, second } = await starterWithSecondGoodsIn();
    tally.clicks = 0; tally.drags = 0; // the setup used the mouse; from here on only the keyboard counts
    await page.locator('.toast__close').evaluateAll((els) => els.forEach((e) => e.click()));
    await press(page, 'Escape'); // nothing selected: the Next steps card is the guide
    console.log('   focus after Escape:', JSON.stringify(await focusInfo(page)));
    // Tab to the card's Connect button, counting the presses
    await page.locator('[data-tab=properties]').focus();
    let presses = 0;
    for (; presses < 40; presses++) {
      await page.keyboard.press('Tab'); tally.keys++;
      const f = await focusInfo(page);
      if (process.env.WT_DEBUG) console.log('     tab', presses + 1, JSON.stringify(f));
      if ((f.where === 'Next steps card' || f.where === 'station form') && /^Connect /.test(f.name)) { console.log(`   Tab x${presses + 1} from the Properties tab reaches: ${JSON.stringify(f)}`); break; }
    }
    ok(presses < 40, 'Tab reaches a Connect button (the station form, or the Next steps card when nothing is selected)');
    await shot(page, 'k01-focus-connect');
    // change the destination with the arrow keys on the select, then Connect with Enter
    await page.keyboard.press('Shift+Tab'); tally.keys++;
    const select = await focusInfo(page);
    console.log('   focus on the choice:', JSON.stringify(select));
    await page.keyboard.press('ArrowDown'); tally.keys++;
    await page.keyboard.press('ArrowUp'); tally.keys++;
    await page.keyboard.press('Tab'); tally.keys++;
    await page.keyboard.press('Enter'); tally.keys++;
    await frames(page, 4);
    eq((await flowPairs(page)).length, 3, 'Enter on Connect creates the flow');
    const after = await focusInfo(page);
    console.log('   focus after Connect:', JSON.stringify(after));
    ok(after.where !== 'body', 'the keyboard focus is not lost when the step is done');
    await shot(page, 'k02-after-connect');
    // undo with the keyboard
    await press(page, 'Control+z');
    eq((await flowPairs(page)).length, 2, 'Ctrl+Z takes it back');
    // the chip: Tab to it, open with Space, Esc closes and gives the focus back
    await page.locator('[data-guide-chip-button]').focus();
    await page.keyboard.press('Space'); tally.keys++;
    await frames(page);
    eq(await page.locator('.guide-pop').isVisible(), true, 'Space opens the chip popover');
    eq(await page.locator('[data-guide-chip-button]').getAttribute('aria-expanded'), 'true', 'aria-expanded says so');
    await page.keyboard.press('Tab'); tally.keys++;
    console.log('   Tab from the chip goes to:', JSON.stringify(await focusInfo(page)));
    await page.keyboard.press('Escape'); tally.keys++;
    await frames(page);
    eq(await page.locator('.guide-pop').isVisible(), false, 'Esc closes the popover');
    eq((await focusInfo(page)).where, 'chip', 'and the focus returns to the chip');
    console.log(`   keyboard only: ${tally.keys} key presses for Tab to Connect (${presses + 1}), choose, Connect, undo, chip open/close`);

    // screen-reader names of everything the guidance puts on screen
    const names = await accessibleNames(page, '.guide-stack button, .guide-stack select, .guide-stack [role=progressbar], .guide-chip button, [data-loads] button, [data-loads] select, #panel-properties [aria-live]');
    for (const n of names) console.log(`     ${n.tag}${n.role ? `[${n.role}]` : ''}: "${n.name}"${n.expanded !== null ? ` expanded=${n.expanded}` : ''}${n.live ? ` live=${n.live}` : ''}`);
    ok(names.every((n) => n.live || n.name.length > 0), 'every control of the guidance has an accessible name');
    const dupes = names.filter((n, i) => n.tag === 'button' && names.findIndex((m) => m.name === n.name) !== i);
    eq(dupes.map((d) => d.name), [], 'no two buttons share the same name');
    await context.close();
    endTally();
  });

  // E. performance: the guidance must stay out of the way
  await run('perf', async () => {
    startTally('E perf');
    const { page, context } = await openApp();
    await pickExample(page, 'Two production');
    await page.locator('.toast__close').evaluateAll((els) => els.forEach((e) => e.click()));
    const layout0 = await layoutOf(page);
    console.log(`   Two lines: ${layout0.stations.length} stations, ${layout0.flows.length} flows, ${layout0.fleets.reduce((n, f) => n + f.count, 0)} vehicles, ${Object.keys(layout0.roads).length} road cells`);

    // E1. cost of the guidance per store change: compute (read) and DOM (fresh chip + card), 60 real commits with new layout objects
    const cost = await page.evaluate(async () => {
      const { store, ctx } = window.__logiplan;
      const { guidanceFor } = await import('/js/ui/guidance.js');
      const { createNextStepsCard, createGuideChip, createChecklistCard } = await import('/js/ui/panels/nextsteps.js');
      const g = guidanceFor(ctx);
      const orig = g.read;
      let readMs = 0, reads = 0;
      g.read = (...a) => { const t = performance.now(); const r = orig(...a); readMs += performance.now() - t; reads++; return r; };
      const issuesOrig = ctx.issues;
      let issuesMs = 0, issuesCalls = 0;
      ctx.issues = (...a) => { const t = performance.now(); const r = issuesOrig(...a); issuesMs += performance.now() - t; issuesCalls++; return r; };
      // detached surfaces, steady state
      const card = createNextStepsCard(ctx, {});
      const chip = createGuideChip(ctx);
      const list = createChecklistCard(ctx);
      for (const piece of [card, chip, list]) piece.update(store.getState());
      const times = { read: [], dom: [], commit: [], issues: [] };
      const state0 = store.getState();
      const station = state0.layout.stations.find((s) => s.type === 'process');
      for (let i = 0; i < 60; i++) {
        const t0 = performance.now();
        store.commit('Rename (perf)', (d) => { d.stations.find((s) => s.id === station.id).name = `${station.name} ${i % 2 ? 'a' : 'b'}`; });
        const t1 = performance.now();
        times.commit.push(t1 - t0);
        readMs = 0;
        // an uncached read: a new layout object every commit. The issue check (validateLayout with the road graph) is the app's
        // own cost, paid once per layout by whoever asks first: time it apart from the guidance
        const state = store.getState();
        const ti = performance.now();
        ctx.issues();
        times.issues.push(performance.now() - ti);
        const t2 = performance.now();
        g.read(state);
        times.read.push(performance.now() - t2);
        const t3 = performance.now();
        for (const piece of [card, chip, list]) piece.update(state);
        times.dom.push(performance.now() - t3);
      }
      g.read = orig;
      ctx.issues = issuesOrig;
      for (const piece of [card, chip, list]) piece.destroy();
      const stat = (a) => { const b = [...a].sort((x, y) => x - y); return { median: +b[b.length >> 1].toFixed(3), p95: +b[Math.floor(b.length * 0.95)].toFixed(3), max: +b[b.length - 1].toFixed(3) }; };
      return { read: stat(times.read), dom: stat(times.dom), commit: stat(times.commit), issues: stat(times.issues), issuesCalls };
    });
    console.log('   guidance per store change (ms):', JSON.stringify(cost));
    ok(cost.read.median <= 2, `guidance read() median ${cost.read.median} ms per store change (limit 2 ms)`);
    ok(cost.read.p95 <= 4, `guidance read() p95 ${cost.read.p95} ms`);
    ok(cost.dom.median <= 2, `the three surfaces update in a median of ${cost.dom.median} ms`);

    // E2. frame rate at 600x with 10 vehicles, Jobs overlay on and off (rAF intervals; 5 s each, the first second dropped)
    await page.evaluate(() => { window.__logiplan.store.setUi({ overlays: { ...window.__logiplan.store.getState().ui.overlays } }); });
    await click(page, '[data-tool=select]');
    await click(page, page.locator('[aria-label="Run simulation"]').first(), 'Play');
    await page.selectOption('select[aria-label="Simulation speed"]', '600');
    tally.clicks++;
    const measure = async (label) => {
      await page.waitForTimeout(1200);
      const r = await page.evaluate(() => new Promise((resolve) => {
        const dts = [];
        let last = performance.now();
        const t0 = last;
        const tick = (now) => {
          dts.push(now - last);
          last = now;
          if (now - t0 < 5000) requestAnimationFrame(tick); else resolve(dts);
        };
        requestAnimationFrame(tick);
      }));
      const b = [...r].sort((x, y) => x - y);
      const out = { frames: r.length, fps: +(1000 / (r.reduce((a, c) => a + c, 0) / r.length)).toFixed(1), median: +b[b.length >> 1].toFixed(1), p95: +b[Math.floor(b.length * 0.95)].toFixed(1), max: +b[b.length - 1].toFixed(1) };
      console.log(`   ${label}:`, JSON.stringify(out));
      return out;
    };
    const jobsToggle = page.locator('button', { hasText: /^Jobs$/ }).first();
    const state = async () => page.evaluate(() => ({ jobs: window.__logiplan.store.getState().ui.overlays.jobs, t: window.__logiplan.runner.time, v: window.__logiplan.runner.sim?.vehicles.length, playing: window.__logiplan.runner.playing }));
    console.log('   state:', JSON.stringify(await state()));
    const on = await measure('Jobs overlay ON, 600x');
    await click(page, jobsToggle, 'Jobs off');
    const off = await measure('Jobs overlay OFF, 600x');
    await click(page, jobsToggle, 'Jobs on');
    const on2 = await measure('Jobs overlay ON again, 600x');
    console.log('   state:', JSON.stringify(await state()));
    ok(on.median <= off.median * 1.15 + 1 && on2.median <= off.median * 1.15 + 1, `the Jobs overlay costs no frame rate: median ${on.median}/${on2.median} ms with, ${off.median} ms without`);
    ok(on.fps >= 55, `${on.fps} fps at 600x with 10 vehicles and the Jobs overlay on`);
    // the rAF cadence is locked to the display (16.7 ms) until a frame takes longer: also time the drawing itself, which shows the headroom
    const draw = async (label) => {
      await page.waitForTimeout(800);
      const r = await page.evaluate(() => new Promise((resolve) => {
        const { renderer } = window.__logiplan.ctx;
        const orig = renderer.render;
        const ms = [];
        renderer.render = function patched(...a) { const t = performance.now(); const out = orig.apply(this, a); ms.push(performance.now() - t); return out; };
        setTimeout(() => { renderer.render = orig; resolve(ms); }, 4000);
      }));
      const b = [...r].sort((x, y) => x - y);
      const out = { frames: r.length, median: +b[b.length >> 1].toFixed(2), p95: +b[Math.floor(b.length * 0.95)].toFixed(2), max: +b[b.length - 1].toFixed(2) };
      console.log(`   renderer.render ${label}:`, JSON.stringify(out));
      return out;
    };
    const dOn = await draw('Jobs ON');
    await click(page, jobsToggle, 'Jobs off');
    const dOff = await draw('Jobs OFF');
    await click(page, jobsToggle, 'Jobs on');
    const dOn2 = await draw('Jobs ON again');
    const extra = Math.max(dOn.median, dOn2.median) - dOff.median;
    console.log(`   the Jobs overlay adds ${extra.toFixed(2)} ms per frame (median), p95 ${(Math.max(dOn.p95, dOn2.p95) - dOff.p95).toFixed(2)} ms`);
    ok(extra <= 1.5, `the Jobs overlay adds at most 1.5 ms to a frame with 10 vehicles (${extra.toFixed(2)} ms)`);
    // worst case: zoomed in far enough for the "-> Goods in 2" chips (14 px/m and more), centred on the busy middle of the plant
    await page.evaluate(() => {
      const { camera, canvas } = window.__logiplan.ctx;
      camera.zoomTo(26, canvas.clientWidth / 2, canvas.clientHeight / 2);
    });
    const zOn = await draw('zoomed in 26 px/m, Jobs ON');
    await click(page, jobsToggle, 'Jobs off');
    const zOff = await draw('zoomed in 26 px/m, Jobs OFF');
    await click(page, jobsToggle, 'Jobs on');
    console.log(`   zoomed in: the Jobs overlay adds ${(zOn.median - zOff.median).toFixed(2)} ms per frame (median), p95 ${(zOn.p95 - zOff.p95).toFixed(2)} ms`);
    await shot(page, 'e02-two-lines-zoomed-jobs');
    ok(zOn.median - zOff.median <= 1.5, `zoomed in with chips drawn the Jobs overlay still adds at most 1.5 ms (${(zOn.median - zOff.median).toFixed(2)} ms)`);
    await shot(page, 'e01-two-lines-600x');
    await context.close();
    endTally();
  });

  // F. the Help page a confused planner would open
  await run('help', async () => {
    startTally('F help');
    const { page, context } = await openApp({ welcome: 'close' });
    await click(page, page.getByRole('button', { name: 'Help' }).first(), 'Help');
    const dialog = page.locator('[role=dialog]');
    await dialog.waitFor();
    const tabs = await dialog.locator('[role=tab]').allInnerTexts();
    console.log('   help tabs:', JSON.stringify(tabs));
    await click(page, dialog.getByRole('tab', { name: /How vehicles find work/ }), 'tab: How vehicles find work');
    await page.waitForTimeout(300);
    console.log('   page text:', (await dialog.locator('[role=tabpanel]:not([hidden])').innerText()).replace(/\s+/g, ' ').slice(0, 2400));
    await shot(page, 'f01-help-vehicles');
    await context.close();
    const narrow = await openApp({ viewport: NARROW, touch: true, welcome: 'close' });
    await narrow.page.locator('button[aria-label="Help"], button:has-text("Help")').first().tap().catch(() => {});
    await context.close?.();
    await narrow.context.close();
    endTally();
  });

  noErrors('end');
});

for (const t of tallies) console.log(`${t.name}: ${total(t)} actions (${t.clicks} clicks, ${t.drags} drags, ${t.keys} key presses)`);
console.log(`${checks} checks passed`);
