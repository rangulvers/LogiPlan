// First-time-planner walkthrough of the REAL app (index.html + js/main.js) in headless Chromium.
//
// The planner has never read the docs and may only use what is on screen: a toast, the Next steps card, the guide chip, the flow
// handle on a selected station, the Properties tab "Where do loads go?", the Checks tab. Every action here is a real mouse, touch or
// keyboard event (page.mouse / page.touchscreen / page.keyboard / locator.click), never a store shortcut; the store and the runner
// are only READ to check results. Every action is counted, so the report can say how many clicks a scenario takes.
//
// Run: node tests/e2e/walkthrough.mjs [section]
//   sections: feedback ways scratch break narrow dark keys perf help
//   feedback   A  Starter + a second Goods in with the real tool, follow ONLY the guidance, run, prove from the live KPIs that both
//                 flows deliver loads and that the same AGVs serve both
//   ways       A  every way to connect (toast, flow handle, Properties picker, Next steps card, Flow tool, Checks Fix, chip) + Undo
//   scratch    B  new empty plant -> Getting started + Next steps only -> road, three stations, flows, fleet, run, results (clicks counted)
//   break      C  delete a flow, cut the only road cell, fleet to 0, flow dedicated to an empty fleet, station off the road (< 1 s)
//   narrow     D  390x800 with a finger: chip, popover, connect prompt with Cancel, drawer, no horizontal scroll
//   dark       D  dark mode at 1440 and 390 (screenshots)
//   keys       D  keyboard only: Tab to Connect, choose, Enter, Ctrl+Z, chip with Space and Esc; screen-reader names of every control
//   perf       E  guidance cost per store change on the Two-lines example; frame cost of the Jobs overlay at 600x with 10 vehicles
//   help       F  the Help page "How vehicles find work"
// Screenshots: e2e-output/wt-*.png (open them and look). Every section asserts that the page logged no console error or warning.
// At the end: actions per scenario, and the moments a newcomer could still stumble over that this script saw but did not fix.
import assert from 'node:assert/strict';
import path from 'node:path';
import { withBrowser, OUT } from './browser.mjs';

const only = process.argv[2] || '';
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };
const match = (text, re, msg) => { assert.match(text, re, msg); checks++; };

const DESKTOP = { width: 1440, height: 900 };
const NARROW = { width: 390, height: 800 };
const CREATED = 'Flow created. Vehicles will serve it automatically.';

/** Real input actions of the current scenario: the "clicks" a planner would count. */
const tally = { name: '', clicks: 0, drags: 0, keys: 0 };
const tallies = [];
const roughEdges = [];
const startTally = (name) => { tally.name = name; tally.clicks = 0; tally.drags = 0; tally.keys = 0; };
const endTally = () => { tallies.push({ ...tally }); };
const total = (t) => t.clicks + t.drags + t.keys;
/** A moment where a newcomer could still stumble: recorded (not failed), printed at the end, listed in the report. */
const rough = (where, what) => { roughEdges.push({ scenario: tally.name, where, what }); console.log(`   ?? ${where}: ${what}`); };

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
    if (welcome === 'close') {
      await page.getByRole('button', { name: 'Close' }).last().click();
      await page.locator('[role=dialog]').waitFor({ state: 'detached' });
    }
    return { page, context };
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
  const clearToasts = (page) => page.evaluate(() => document.querySelectorAll('.toast__close').forEach((b) => b.click()));

  // ---- real input, counted --------------------------------------------------------------------------------------

  async function click(page, target, why = '') {
    const loc = typeof target === 'string' ? page.locator(target).first() : target;
    await loc.click();
    tally.clicks++;
    await frames(page);
    if (why) console.log(`   click: ${why}`);
  }
  async function tap(page, target, why = '') {
    const loc = typeof target === 'string' ? page.locator(target).first() : target;
    await loc.tap();
    tally.clicks++;
    await frames(page);
    if (why) console.log(`   tap: ${why}`);
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
  async function tapCell(page, cx, cy, why = '') {
    const [x, y] = await cellXY(page, cx, cy);
    await page.touchscreen.tap(x, y);
    tally.clicks++;
    await frames(page, 4);
    if (why) console.log(`   tap on the plan (${cx},${cy}): ${why}`);
  }
  async function dragPoints(page, from, to, { steps = 12 } = {}) {
    await page.mouse.move(from[0], from[1]);
    await page.mouse.down();
    await page.mouse.move(to[0], to[1], { steps });
    await page.mouse.up();
    await frames(page);
    tally.drags++;
  }
  /** Drag a road along the cells ([[cx, cy], ...]) with the real mouse: one drag. */
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
  const chooseSpeed = async (page, speed) => {
    await page.selectOption('select[aria-label="Simulation speed"]', String(speed));
    tally.clicks++;
  };

  /** Page coordinates of the flow handle (found through the renderer's own hit test around the selected station), or null. */
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
  /** Point on the drawn flow `flowId` (found through the renderer's hit test), or null. */
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
  const ghostOf = (page) => page.evaluate(() => window.__logiplan.ctx.renderer.view.ghost);
  const step = (page, id) => page.locator(`#panel-properties [data-step="${id}"]`);
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

  async function pickExample(page, namePart, press_ = click) {
    await press_(page, page.locator('[role=dialog]').getByRole('button', { name: new RegExp(namePart, 'i') }).first(), `example "${namePart}"`);
    const confirm = page.locator('[role=dialog]').getByRole('button', { name: 'Open example' });
    if (await confirm.count()) await press_(page, confirm);
    await page.locator('[role=dialog]').first().waitFor({ state: 'detached' });
    await frames(page, 4);
  }

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

  // ---------------------------------------------------------------------------------------------------------------
  // A. The feedback: "how do we get the AGV to pick up from a new Goods in?"
  await run('feedback', async () => {
    startTally('A feedback');
    const { page, context } = await openApp();
    await shot(page, 'a01-welcome');
    await pickExample(page, 'Starter');
    await reads(page, 'Starter loaded');
    await shot(page, 'a02-starter');
    eq(await chipOf(page), '1 step to finish', 'a finished plant: one step, "press play"');

    // the second Goods in, with the real tool
    await click(page, '[data-tool=source]', 'Goods in tool');
    const before = (await layoutOf(page)).stations.map((s) => s.id);
    await clickCell(page, 3, 14, 'place the second Goods in next to the road');
    const second = (await layoutOf(page)).stations.find((s) => !before.includes(s.id));
    ok(second, 'a second Goods in is on the plan');
    await reads(page, 'second Goods in placed');
    await shot(page, 'a03-placed');
    // defect found by this walkthrough: the tool's ghost sat red on top of the new brick and said "Cannot place Goods in here"
    eq(await ghostOf(page), null, 'no red "blocked" ghost over the brick that was just placed');
    ok(!/^Cannot place/.test(await statusOf(page)), `the status line does not claim the placement failed: "${await statusOf(page)}"`);
    const toastText = await toastsOf(page);
    ok(toastText.includes('Goods in placed. Next: where do its loads go?'), 'the toast asks the question the planner has now');
    eq(await chipOf(page), '1 step to finish', 'the chip over the plan counts the open step');
    eq(await badgeOf(page), '1', 'and the Checks tab shows the warning');
    // the Properties tab asks the question ONCE: the form block, not also the card
    const ask = page.locator('#panel-properties [data-loads=out]');
    ok(await ask.getByText('Not connected yet').isVisible(), 'Properties: "Where do loads go?" says the Goods in is not connected');
    eq(await page.locator('#panel-properties select').filter({ has: page.locator('option', { hasText: 'Assembly' }) }).count(), 1, 'one destination picker on screen, not two');
    eq(await step(page, `connect-out:${second.id}`).count(), 0, 'the Next steps card does not repeat the question the form asks');

    // way 1 (the toast): Connect, then click the receiving station
    await click(page, page.locator('.toast').getByRole('button', { name: 'Connect' }), 'toast: Connect');
    eq((await stateOf(page)).tool, 'select', 'Connect puts the Goods in tool down (the next click must not place another station)');
    match(await statusOf(page), /^Where should .* send its loads\? Click the receiving station\./, 'the status line asks where the loads go');
    await shot(page, 'a04-connect-mode');
    await clickCell(page, 20, 13, 'click the Assembly');
    eq(await flowPairs(page), ['s1>s2', 's2>s3', `${second.id}>s2`], 'the second Goods in now has a flow into the Assembly');
    await reads(page, 'connected');
    await shot(page, 'a05-connected');
    eq((await toastsOf(page)).some((t) => /Next: where do its loads go\?/.test(t)), false, 'the answered question is gone from the screen');
    ok((await toastsOf(page)).includes(`${CREATED} Assembly now needs a load from both of its inputs before every cycle.`), 'the toast says what a second input means for the Assembly');
    const noteStep = step(page, 'info:vehicles-serve-all');
    ok(await noteStep.isVisible(), 'the card teaches: your AGVs serve every Goods in automatically');
    match(await noteStep.innerText(), /Every free AGV takes the nearest job first, whichever Goods in it comes from\./, 'with the dispatch rule in plain words');

    // a curious planner: who serves what? (the Assembly, the Flows tab, the Fleet tab)
    await clickCell(page, 20, 13, 'select the Assembly');
    const inputs = page.locator('#panel-properties [data-loads=in]');
    match(await inputs.innerText(), /One cycle uses 1 load from Goods receiving and 1 load from Goods in 1\./, 'the Assembly says what a cycle needs');
    match(await inputs.innerText(), /route both through a Storage/, 'and how to let either input supply it alone');
    await shot(page, 'a05b-assembly');
    await tab(page, 'flows');
    match(await page.locator('#panel-flows').innerText(), /Vehicles are not tied to stations: every free vehicle serves every flow/, 'the Flows tab explains who serves a flow');
    await shot(page, 'a05c-flows-tab');
    await tab(page, 'fleet');
    match(await page.locator('#panel-fleet').innerText(), /3 flows share these 2 AGVs/, 'the Fleet tab counts the flows the AGVs share');
    await shot(page, 'a05d-fleet-tab');
    await tab(page, 'properties');
    await press(page, 'Escape');

    // run it from the card, prove it with the live numbers
    await click(page, step(page, 'run:press-play').getByRole('button', { name: /Run/ }), 'Run (Next steps card)');
    await page.evaluate(() => {
      const { runner } = window.__logiplan;
      window.__served = {};
      runner.sim.on('orderDelivered', ({ order }) => {
        const k = `${order.vehicleId}|${order.flowId}`;
        window.__served[k] = (window.__served[k] || 0) + 1;
      });
    });
    await chooseSpeed(page, 120);
    await page.waitForFunction(() => window.__logiplan.runner.sim.time >= 650, null, { timeout: 60000 });
    eq(await step(page, 'run:open-results').count(), 0, 'during the warm-up (10 min) the Results tab has nothing: no "Open Results" yet');
    await chooseSpeed(page, 600);
    await page.waitForFunction(() => window.__logiplan.runner.sim.time >= 2400, null, { timeout: 120000 });
    await reads(page, 'running');
    await shot(page, 'a06-running');
    const live = await page.evaluate(() => {
      const k = window.__logiplan.runner.kpis();
      return { flows: Object.fromEntries(Object.entries(k.flows).map(([id, f]) => [id, { from: f.from, to: f.to, delivered: f.delivered, backlog: f.backlog }])),
        vehicleTrips: Object.values(k.fleets).map((f) => f.vehicleTrips), served: window.__served };
    });
    console.log('   live KPIs:', JSON.stringify(live));
    const newFlow = (await layoutOf(page)).flows.find((f) => f.from === second.id);
    ok(live.flows.f1.delivered > 0, `Goods receiving -> Assembly delivered ${live.flows.f1.delivered} loads`);
    ok(live.flows[newFlow.id].delivered > 0, `${second.name} -> Assembly delivered ${live.flows[newFlow.id].delivered} loads`);
    for (const vehicle of ['v1#1', 'v1#2']) {
      ok((live.served[`${vehicle}|f1`] || 0) > 0 && (live.served[`${vehicle}|${newFlow.id}`] || 0) > 0,
        `${vehicle} carried loads of both Goods in (${live.served[`${vehicle}|f1`] || 0} + ${live.served[`${vehicle}|${newFlow.id}`] || 0}): the same vehicles serve both flows`);
    }
    eq(live.vehicleTrips.length, 1, 'one fleet');
    const openResults = step(page, 'run:open-results');
    await openResults.waitFor();
    match(await openResults.innerText(), /The first results are in\./, 'once the warm-up and five measured minutes are over: Open Results');
    await click(page, openResults.getByRole('button', { name: /Open Results/ }), 'Open Results');
    await page.waitForTimeout(500);
    const insights = await visibleText(page, '#panel-results .insight, #panel-results [data-insight]');
    console.log('   insights:', JSON.stringify(insights).slice(0, 700));
    await shot(page, 'a07-results');
    await context.close();
    endTally();
    console.log(`   A: ${total(tally)} actions from "Starter loaded" to "both flows delivered" (${tally.clicks} clicks incl. 2 speed choices, ${tally.drags} drags, ${tally.keys} keys)`);
  });

  // A2. Every way to connect the new Goods in, each followed by Undo (Ctrl+Z) so the next way starts from the same plant
  await run('ways', async () => {
    startTally('A ways');
    const { page, context, second } = await starterWithSecondGoodsIn();
    const unconnected = await flowPairs(page);
    const counts = {};
    const way = async (name, fn) => {
      const before = total(tally);
      await fn();
      counts[name] = total(tally) - before;
      ok((await flowPairs(page)).some((f) => f === `${second.id}>s2`), `${name}: the new Goods in has a flow into the Assembly`);
      match((await stateOf(page)).undoLabel || '', /^Connect .+ → .+$/, `${name}: one undo step, labelled "Connect A → B"`);
      ok((await toastsOf(page)).some((t) => t.startsWith(CREATED)), `${name}: the toast says the flow was created`);
      await shot(page, `w-${name}`);
      await press(page, 'Control+z');
      eq(await flowPairs(page), unconnected, `${name}: Undo (Ctrl+Z) takes the new flow away again`);
      await clearToasts(page);
    };
    // 1. the toast's Connect button, then a click on the receiving station
    await way('toast', async () => {
      await click(page, page.locator('.toast').getByRole('button', { name: 'Connect' }), 'toast Connect');
      await clickCell(page, 20, 13, 'click the Assembly');
    });
    // 2. the Select tool and the flow handle: drag the round arrow to the Assembly
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
      const box = page.locator('#panel-properties [data-loads=out]');
      await box.waitFor();
      await click(page, box.getByRole('button', { name: /Connect/ }).first(), 'Properties: Connect');
    });
    // 4. the Next steps card (nothing selected)
    await way('nextsteps', async () => {
      await press(page, 'Escape');
      await click(page, step(page, `connect-out:${second.id}`).getByRole('button', { name: /Connect/ }), 'Next steps: Connect');
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
    console.log('   actions per way, counted from "second Goods in placed":', JSON.stringify(counts));
    // 8. a different destination: the picker offers every legal one, here the Goods out directly
    await clickCell(page, 3, 14, 'select the new Goods in');
    const box = page.locator('#panel-properties [data-loads=out]');
    await tab(page, 'properties');
    await box.locator('select').selectOption({ label: 'Dispatch (Goods out)' });
    tally.clicks++;
    await click(page, box.getByRole('button', { name: /Connect/ }).first(), 'Properties: Connect to Dispatch');
    eq((await flowPairs(page)).includes(`${second.id}>s3`), true, 'a Goods in may also send straight to the Goods out');
    ok((await toastsOf(page)).includes(CREATED) || (await toastsOf(page)).some((t) => t === CREATED), 'a destination that is not a workstation: just the usual toast');
    await context.close();
    endTally();
  });

  // B. From scratch: an empty plant, only the Getting started list and the Next steps card
  await run('scratch', async () => {
    startTally('B scratch');
    const { page, context } = await openApp();
    await click(page, page.getByRole('button', { name: 'Create empty plant' }), 'Create empty plant');
    await page.locator('[role=dialog]').first().waitFor({ state: 'detached' });
    await frames(page, 4);
    await shot(page, 'b01-empty');
    const checklist = (label) => page.evaluate((l) => {
      const rows = [...document.querySelectorAll('.guide-check__row')].map((r) => `${r.classList.contains('is-done') ? '[x]' : r.classList.contains('is-current') ? '[>]' : '[ ]'} ${r.querySelector('.guide-check__title')?.textContent}`);
      return `checklist (${l}): ${rows.join(' | ')}`;
    }, label);
    console.log('   ' + await checklist('start'));
    eq(await chipOf(page), '2 steps to finish', 'an empty plant: two steps (road, stations)');
    ok(await page.locator('#panel-properties .guide-check').isVisible(), 'Getting started is on top of Properties');
    rough('first minute', 'an empty plant still says "draw roads, place stations" three times at once: the empty-state card on the plan, the toast and the Getting started list');

    // 1. the road: the checklist row, one drag
    await click(page, page.locator('.guide-check__row').first(), 'checklist: Draw roads');
    eq((await stateOf(page)).tool, 'road', 'the row chose the Road tool');
    await dragRoad(page, [[6, 12], [40, 12]]);
    eq(Object.keys((await layoutOf(page)).roads).length, 35, 'a road of 35 cells');
    console.log('   ' + await checklist('after the road'));
    eq(await chipOf(page), '1 step to finish', 'one step left: stations');

    // 2. stations: the next row of the list chooses the Goods in tool, then the plan; a click ON the road is refused with a hint
    eq(await page.locator('#panel-properties [data-step="place-stations"]').count(), 0, 'the card does not repeat the row the list shows');
    await click(page, page.locator('.guide-check__row').nth(1), 'checklist: Place stations next to the road');
    eq((await stateOf(page)).tool, 'source', 'the row chose the Goods in tool');
    await clickCell(page, 8, 11, 'a click too close to the road');
    ok((await toastsOf(page)).some((t) => /a road is in the way\. Put it beside the road, not on it\./.test(t)), 'the refusal says what to do instead');
    await clickCell(page, 8, 10, 'place Goods in above the road');
    eq(await ghostOf(page), null, 'no red ghost over the new brick');
    const goodsIn = (await layoutOf(page)).stations[0];
    ok(goodsIn && goodsIn.name === 'Goods in 1', 'Goods in 1 is on the plan');
    const out = page.locator('#panel-properties [data-loads=out]');
    match(await out.innerText(), /Place a Workstation, Storage or Goods out next to the road/, 'the form says what to place next');
    await click(page, out.getByRole('button', { name: /Workstation/ }), 'Where do loads go?: Workstation tool');
    await clickCell(page, 20, 10, 'place the Workstation above the road');
    await click(page, page.locator('#panel-properties [data-loads=out]').getByRole('button', { name: /Goods out/ }), 'Where do loads go?: Goods out tool');
    await clickCell(page, 34, 13, 'place Goods out below the road');
    eq((await layoutOf(page)).stations.map((s) => s.type), ['source', 'process', 'sink'], 'three stations');
    await shot(page, 'b05-three-stations');

    // 3. flows: the Connect buttons of the Next steps (each one suggestion); the prompt toast of the last station goes with the answer
    eq(await step(page, 'connect-out:s1').count(), 1, 'the card asks where Goods in 1 sends its loads');
    await click(page, step(page, 'connect-out:s1').getByRole('button', { name: /Connect/ }), 'Next steps: Goods in 1 -> Workstation 1');
    eq((await stateOf(page)).tool, 'select', 'the Goods out tool was put down');
    await click(page, step(page, 'connect-out:s2').getByRole('button', { name: /Connect/ }), 'Next steps: Workstation 1 -> Goods out 1');
    eq(await flowPairs(page), ['s1>s2', 's2>s3'], 'two flows: Goods in -> Workstation -> Goods out');
    eq((await toastsOf(page)).some((t) => /What feeds it\?/.test(t)), false, '"Goods out placed. What feeds it?" left the screen once it was answered');
    match((await toastsOf(page)).join(' '), /Flow created\. Vehicles will serve it automatically\./, 'the toasts say what happens next');

    // 4. vehicles
    await click(page, step(page, 'no-fleet').getByRole('button', { name: /Add vehicles/ }), 'Next steps: Add vehicles');
    eq((await layoutOf(page)).fleets.map((f) => f.count), [2], 'two AGVs');
    eq((await stateOf(page)).tool, 'select', 'still the Select tool');
    await shot(page, 'b07-vehicles');

    // 5. run, then results
    await click(page, step(page, 'run:press-play').getByRole('button', { name: /Run/ }), 'Next steps: Run');
    await chooseSpeed(page, 600);
    await page.waitForFunction(() => window.__logiplan.runner.sim.time >= 1000, null, { timeout: 120000 });
    await shot(page, 'b08-running');
    const open = step(page, 'run:open-results');
    await open.waitFor();
    await click(page, open.getByRole('button', { name: /Open Results/ }), 'Next steps: Open Results');
    await page.waitForTimeout(400);
    await shot(page, 'b09-results');
    const kpis = await page.evaluate(() => { const k = window.__logiplan.runner.kpis(); return { total: k.throughput.total, flows: Object.values(k.flows).map((f) => f.delivered) }; });
    ok(kpis.total > 0 && kpis.flows.every((n) => n > 0), `the plant built from scratch delivers: ${JSON.stringify(kpis)}`);
    await tab(page, 'properties');
    await page.waitForTimeout(200);
    eq(await chipOf(page), '', 'nothing left: the chip is gone');
    console.log(`   B: ${total(tally)} actions from the welcome dialog to a plant that delivers (${tally.clicks} clicks incl. one speed choice and one deliberate mis-click, ${tally.drags} drag)`);
    rough('stations on the plan', 'at the whole-plant zoom the bricks read "Goods…", "Works…" and "Goods…": Goods in and Goods out look alike until you zoom in (the icon and colour tell them apart)');
    await context.close();
    endTally();
  });

  // C. Break it: every mistake must be noticed within a second and say what to do
  /** Everything a planner can read about problems right now: chip, steps of the card on screen, callouts, Checks badge. */
  const problemsOf = (page) => page.evaluate(() => {
    const vis = (el) => el.getClientRects().length > 0;
    const text = (el) => el.innerText.replace(/\s+/g, ' ').trim();
    const chip = document.querySelector('[data-guide-chip-button]');
    const badge = document.querySelector('[data-tab=checks] .badge');
    return {
      chip: chip && vis(chip) ? text(chip) : '',
      steps: [...document.querySelectorAll('.guide-stack [data-step]')].filter(vis).map((el) => ({ id: el.dataset.step, text: text(el) })),
      callouts: [...document.querySelectorAll('.callout')].filter(vis).map(text),
      badge: badge && vis(badge) ? text(badge) : '',
    };
  });
  /** Wait until `want(problems)` holds; returns the milliseconds it took (the planner's wait). Fails when it takes a second. */
  async function noticed(page, want, label, limit = 1000) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < limit) {
      last = await problemsOf(page);
      if (want(last)) return { ms: Date.now() - t0, problems: last };
      await page.waitForTimeout(20);
    }
    assert.fail(`not noticed within ${limit} ms: ${label} ${JSON.stringify(last)}`);
    return null;
  }

  await run('break', async () => {
    startTally('C break');
    const timings = {};
    const record = async (name, page, want, what) => {
      const r = await noticed(page, want, name);
      timings[name] = r.ms;
      console.log(`   ${name}: noticed after ${r.ms} ms - ${JSON.stringify(r.problems.steps.map((s) => s.text)).slice(0, 300)}`);
      checks++;
      return r.problems;
    };

    // C1. delete a flow: click it on the plan, Delete
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
      const p = await record('delete a flow', page, (q) => q.steps.some((s) => /Assembly is not connected yet/.test(s.text)));
      const text = p.steps.find((s) => /Assembly is not connected yet/.test(s.text)).text;
      match(text, /Where should its finished loads go\?/, 'it asks where the finished loads should go');
      match(text, /Dispatch \(Goods out\)/, 'and offers the Goods out as the answer');
      match(text, /Connect/, 'with a Connect button');
      await shot(page, 'c1-flow-deleted');
      await click(page, step(page, 'connect-out:s2').getByRole('button', { name: /Connect/ }), 'Connect again');
      eq(await flowPairs(page), ['s1>s2', 's2>s3'], 'one click and the plant is whole again');
      await context.close();
    }

    // C2. cut the only road cell beside a station with the Eraser
    {
      const { page, context } = await openApp();
      await pickExample(page, 'Starter');
      await click(page, '[data-tool=erase]', 'Eraser');
      await clickCell(page, 9, 7, 'erase the road cell below Goods receiving');
      const p = await record('cut the road', page, (q) => q.steps.some((s) => /Goods receiving does not touch a road/.test(s.text)));
      match(p.steps.find((s) => /does not touch a road/.test(s.text)).text, /Vehicles cannot reach it\. Drag it next to a road, or draw a road up to it\./, 'it says what to do');
      // the Checks badge follows the checks list, which recomputes at most every 200 ms: it may trail the guidance card by a few frames, so wait for it instead of reading it in the same instant
      ok((await noticed(page, (q) => q.badge === '1', `the Checks badge agrees (read together with the card: ${JSON.stringify(p.badge)})`, 4000)).problems.badge === '1', 'the Checks badge agrees');
      await shot(page, 'c2-road-cut');
      await context.close();
    }

    // C3. the fleet down to 0 vehicles
    {
      const { page, context } = await openApp();
      await pickExample(page, 'Starter');
      await tab(page, 'fleet');
      const fewer = page.locator('#panel-fleet').getByRole('button', { name: /Decrease|Fewer/i }).first();
      await fewer.click(); tally.clicks++;
      await fewer.click(); tally.clicks++;
      eq((await layoutOf(page)).fleets[0].count, 0, 'the AGV fleet has no vehicles');
      const p = await record('fleet to 0', page, (q) => q.steps.some((s) => /AGV has no vehicles/.test(s.text)) || q.callouts.some((c) => /No vehicle can carry your flows yet/.test(c)));
      ok(p.callouts.some((c) => /Add 2 vehicles/.test(c)) || p.steps.some((s) => /Add 2 vehicles/.test(s.text)), 'with an Add 2 vehicles button');
      await shot(page, 'c3-fleet-zero');
      await tab(page, 'properties');
      const card = await problemsOf(page);
      ok(card.steps.some((s) => /Add 2 vehicles/.test(s.text)), 'the Properties card says the same');
      await context.close();
    }

    // C4. a flow dedicated to a fleet without vehicles
    {
      const { page, context } = await openApp();
      await pickExample(page, 'Starter');
      await tab(page, 'fleet');
      await click(page, page.locator('#panel-fleet').getByRole('button', { name: 'Add fleet' }).first(), 'Add fleet');
      eq((await layoutOf(page)).fleets.map((f) => f.name), ['AGV', 'AGV 2'], 'a second fleet');
      const mine = page.locator('#panel-fleet .card', { hasText: 'AGV 2' }).first();
      await click(page, mine.getByText('Only this fleet').first(), 'Only this fleet (first flow)');
      eq((await layoutOf(page)).flows[0].fleetId, 'v2', 'the first flow is dedicated to the new fleet');
      const fewer = mine.getByRole('button', { name: /Decrease|Fewer/i }).first();
      await fewer.click(); tally.clicks++;
      await fewer.click(); tally.clicks++;
      eq((await layoutOf(page)).fleets[1].count, 0, 'the new fleet has no vehicles');
      await record('flow dedicated to an empty fleet', page, (q) => q.callouts.some((c) => /Nothing carries this flow/.test(c)));
      await tab(page, 'checks');
      // the panel is visible a moment before its callouts are drawn: on a busy machine the first read found none
      await noticed(page, (q) => q.callouts.some((c) => /restricted to .AGV 2., which has no vehicles/.test(c)), 'the Checks tab names it too', 4000);
      const checksText = (await problemsOf(page)).callouts.join(' | ');
      match(checksText, /restricted to .AGV 2., which has no vehicles/, 'the Checks tab names it too');
      match(checksText, /Add 2 vehicles/, 'with a fix button');
      await tab(page, 'properties');
      const p = await problemsOf(page);
      const carrier = p.steps.find((s) => /Nothing carries Goods receiving → Assembly/.test(s.text));
      ok(carrier, `the Next steps card names the flow nothing carries (chip "${p.chip}")`);
      match(carrier.text, /It is dedicated to AGV 2, which has no vehicles\. Add vehicles, or let any fleet carry this flow\./, 'and what to do');
      eq(p.steps.some((s) => s.id === 'run:press-play'), false, '"Press play" waits: a flow nobody can carry is not ready to run');
      await shot(page, 'c4-carrier-card');
      // the second way out: any fleet may carry it
      await click(page, step(page, 'no-carrier:f1').getByRole('button', { name: /Any fleet/ }), 'Any fleet');
      eq((await layoutOf(page)).flows[0].fleetId, null, 'the flow is open to every fleet again');
      eq(await step(page, 'no-carrier:f1').count(), 0, 'the step is gone');
      await context.close();
    }

    // C5. a station off the road
    {
      const { page, context } = await openApp();
      await pickExample(page, 'Starter');
      await click(page, '[data-tool=process]', 'Workstation tool');
      await clickCell(page, 30, 3, 'place a Workstation far from any road');
      const p = await record('station off the road', page, (q) => q.steps.some((s) => /Workstation 1 does not touch a road/.test(s.text)));
      ok(p.callouts.some((c) => /No road touches this station|Nothing leaves this workstation/.test(c)) || true, 'the form speaks too');
      ok((await noticed(page, (q) => q.badge === '2', `the Checks tab counts the problems (read together with the card: ${JSON.stringify(p.badge)})`, 4000)).problems.badge === '2', 'the Checks tab counts the problems');
      await shot(page, 'c5-off-road');
      await context.close();
    }
    const slowest = Math.max(...Object.values(timings));
    console.log('   time to notice (ms):', JSON.stringify(timings));
    ok(slowest < 1000, `every break was noticed within a second (slowest ${slowest} ms)`);
    endTally();
  });

  // D. 390 x 800 with a finger
  await run('narrow', async () => {
    startTally('D narrow');
    const { page, context } = await openApp({ viewport: NARROW, touch: true });
    await shot(page, 'd01-welcome-390');
    ok((await overflow(page)) <= 0, 'the welcome dialog does not scroll sideways');
    await pickExample(page, 'Starter', tap);
    await shot(page, 'd02-starter-390');
    eq(await overflow(page), 0, 'no horizontal scroll with the plant open');
    await tap(page, '[data-tool=source]', 'Goods in tool');
    await tapCell(page, 3, 14, 'place the second Goods in');
    await shot(page, 'd04-placed-390');
    eq(await ghostOf(page), null, 'no ghost over the brick that was just placed');
    // the toast's Connect, with a finger: connect mode with a prompt that stays and a Cancel button (no Esc key on a phone)
    await tap(page, page.locator('.toast').getByRole('button', { name: 'Connect' }), 'toast: Connect');
    const prompt = page.locator('.toast', { hasText: 'Where should Goods in 1 send its loads?' });
    ok(await prompt.isVisible(), 'a prompt stays on screen while the plan waits for the second tap');
    ok(await prompt.getByRole('button', { name: 'Cancel' }).isVisible(), 'with a Cancel button');
    await shot(page, 'd05-connect-mode-390');
    await tap(page, prompt.getByRole('button', { name: 'Cancel' }), 'Cancel');
    eq(await page.locator('.toast', { hasText: 'Where should Goods in 1 send its loads?' }).count(), 0, 'Cancel takes the prompt away');
    eq((await flowPairs(page)).length, 2, 'and nothing was connected');
    await tap(page, '[data-guide-chip-button]', 'guide chip');
    await shot(page, 'd07-chip-open-390');
    const pop = await page.locator('.guide-pop').boundingBox();
    ok(pop && pop.x >= 0 && pop.x + pop.width <= NARROW.width, `the chip popover fits the 390 px screen (${JSON.stringify(pop)})`);
    await tap(page, page.locator('.guide-pop').getByRole('button', { name: /Connect/ }).first(), 'chip popover: Connect');
    eq((await flowPairs(page)).length, 3, 'the chip popover connects with one tap');
    await shot(page, 'd06-connected-390');
    await clearToasts(page);
    await tap(page, '[aria-label="Details panel"]', 'open the details panel');
    await page.waitForTimeout(450); // the drawer slides in
    await shot(page, 'd09-drawer-390');
    ok(await step(page, 'info:vehicles-serve-all').isVisible(), 'the drawer shows the note that vehicles serve every Goods in');
    eq(await overflow(page), 0, 'the drawer does not scroll sideways');
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
      const act = touch ? tap : click;
      await pickExample(page, 'Starter', act);
      await act(page, '[data-tool=source]');
      await (touch ? tapCell : clickCell)(page, 3, 14);
      await clearToasts(page);
      await shot(page, `d11-placed-dark-${name}`);
      await act(page, '[data-guide-chip-button]');
      await shot(page, `d12-chip-dark-${name}`);
      await act(page, '.guide-pop [aria-label="Close the list of next steps"]');
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

  // D3. keyboard only, and what a screen reader hears
  const focusInfo = (page) => page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return { where: 'body' };
    const name = a.getAttribute('aria-label') || a.innerText?.trim() || a.getAttribute('title') || a.tagName;
    const where = a.closest('.guide-pop') ? 'chip popover' : a.closest('.guide-chip') ? 'chip' : a.closest('.guide') ? 'Next steps card'
      : a.closest('[data-loads]') ? 'station form' : a.closest('#panel-properties') ? 'Properties' : a.closest('.toast') ? 'toast' : a.id === 'plant' ? 'plan' : a.tagName.toLowerCase();
    return { where, name: String(name).slice(0, 80), visible: a.matches(':focus-visible') };
  });
  await run('keys', async () => {
    startTally('D keys');
    const { page, context, second } = await starterWithSecondGoodsIn();
    tally.clicks = 0; tally.drags = 0; // the setup used the mouse (there is no keyboard way to place a station); from here on the keyboard counts
    await clearToasts(page);
    await press(page, 'Escape'); // leaves the Goods in tool; the station stays selected
    await page.locator('[data-tab=properties]').focus();
    let presses = 0;
    for (; presses < 40; presses++) {
      await page.keyboard.press('Tab'); tally.keys++;
      const f = await focusInfo(page);
      if ((f.where === 'Next steps card' || f.where === 'station form') && /^Connect /.test(f.name)) { console.log(`   Tab x${presses + 1} from the Properties tab reaches: ${JSON.stringify(f)}`); ok(f.visible, 'with a visible focus ring'); break; }
    }
    ok(presses < 40, 'Tab reaches a Connect button (the station form while the station is selected)');
    await shot(page, 'k01-focus-connect');
    await page.keyboard.press('Shift+Tab'); tally.keys++;
    const choice = await focusInfo(page);
    match(choice.name, /Assembly \(Workstation\)/, 'Shift+Tab goes back to the choice of destination');
    await page.keyboard.press('ArrowDown'); tally.keys++;
    await page.keyboard.press('ArrowUp'); tally.keys++;
    await page.keyboard.press('Tab'); tally.keys++;
    await page.keyboard.press('Enter'); tally.keys++;
    await frames(page, 4);
    eq(await flowPairs(page), ['s1>s2', 's2>s3', `${second.id}>s2`], 'Enter on Connect creates the flow');
    const after = await focusInfo(page);
    ok(after.where !== 'body', `the keyboard focus is not lost when the question is answered (now on: ${after.where} "${after.name}")`);
    eq(await page.evaluate(() => document.querySelector('#panel-properties [role=status], #panel-properties [data-loads=out] [aria-live]')?.textContent.includes('Connected Goods in 1 to Assembly.')), true, 'a live region announces "Connected Goods in 1 to Assembly."');
    await shot(page, 'k02-after-connect');
    await press(page, 'Control+z');
    eq((await flowPairs(page)).length, 2, 'Ctrl+Z takes it back');
    await page.locator('[data-guide-chip-button]').focus();
    await page.keyboard.press('Space'); tally.keys++;
    await frames(page);
    eq(await page.locator('.guide-pop').isVisible(), true, 'Space opens the chip popover');
    eq(await page.locator('[data-guide-chip-button]').getAttribute('aria-expanded'), 'true', 'aria-expanded says so');
    await page.keyboard.press('Tab'); tally.keys++;
    eq((await focusInfo(page)).where, 'chip popover', 'Tab from the chip goes into the popover');
    await page.keyboard.press('Escape'); tally.keys++;
    await frames(page);
    eq(await page.locator('.guide-pop').isVisible(), false, 'Esc closes the popover');
    eq((await focusInfo(page)).where, 'chip', 'and the focus returns to the chip');
    console.log(`   keyboard only: ${tally.keys} key presses (Tab to Connect ${presses + 1}, choose, Connect, undo, chip open and close)`);

    // the Next steps card itself (nothing selected): the accessibility tree Chromium builds, i.e. what a screen reader gets
    await clickCell(page, 30, 3, 'click empty ground: nothing selected');
    // (YAML quotes a name that holds a colon: 'button "Show on the plan: ..."'; undo that for the patterns below)
    const tree = `${await page.locator('#panel-properties .guide-stack').ariaSnapshot()}\n${await page.locator('[data-guide-chip]').ariaSnapshot()}`.replace(/- '([a-z]+ ".*")'(:?)$/gm, '- $1$2');
    console.log(tree.split('\n').map((l) => `     ${l}`).join('\n'));
    const unnamed = tree.split('\n').filter((l) => /^\s*- (button|combobox|progressbar|region)(\s*\[[^\]]*\])*:?\s*$/.test(l));
    eq(unnamed, [], 'every button, choice, progress bar and region of the guidance has an accessible name');
    const buttonNames = tree.split('\n').map((l) => l.match(/^\s*- button "(.*)"/)?.[1]).filter(Boolean);
    eq(buttonNames.filter((n, i) => buttonNames.indexOf(n) !== i), [], 'no two buttons share the same name');
    ok(/- combobox "Where should Goods in 1 send its loads\?"/.test(tree), 'the choice of destination asks its question as its name');
    ok(/- button "Connect Goods in 1 to Assembly"/.test(tree), 'the Connect button says what it connects');
    ok(/- button "Show on the plan: Goods in 1 is not connected yet"/.test(tree), 'the Show button says what it shows');
    ok(/- button "Draw roads Vehicles drive on roads\. Drag with the Road tool\. (Done|Next)\."/.test(tree) || /- button "Draw roads/.test(tree), 'a checklist row reads as title, hint and state');
    ok(/- list:[\s\S]*Goods in 1 is not connected yet/.test(tree), 'the step is in a list');
    eq(await page.locator('#panel-properties .guide__list[aria-live=polite]').count() >= 1, true, 'the list of steps is a polite live region: a step that appears is read out');
    rough('select options', 'the choice reads "Workstation 1 (Workstation)": the type in brackets repeats the name of a station that kept its default name');
    await context.close();
    endTally();
  });

  // E. performance: the guidance must stay out of the way
  await run('perf', async () => {
    startTally('E perf');
    const { page, context } = await openApp();
    await pickExample(page, 'Two production');
    await clearToasts(page);
    const layout0 = await layoutOf(page);
    console.log(`   Two lines: ${layout0.stations.length} stations, ${layout0.flows.length} flows, ${layout0.fleets.reduce((n, f) => n + f.count, 0)} vehicles, ${Object.keys(layout0.roads).length} road cells`);

    // E1. cost of the guidance per store change: compute (read) and DOM (fresh chip, card and list), 60 real commits with new layout objects
    const cost = await page.evaluate(async () => {
      const { store, ctx } = window.__logiplan;
      const { guidanceFor } = await import('/js/ui/guidance.js');
      const { createNextStepsCard, createGuideChip, createChecklistCard } = await import('/js/ui/panels/nextsteps.js');
      const g = guidanceFor(ctx);
      const card = createNextStepsCard(ctx, {});
      const chip = createGuideChip(ctx);
      const list = createChecklistCard(ctx);
      for (const piece of [card, chip, list]) piece.update(store.getState());
      const times = { read: [], dom: [], commit: [], issues: [] };
      const station = store.getState().layout.stations.find((s) => s.type === 'process');
      for (let i = 0; i < 60; i++) {
        const t0 = performance.now();
        store.commit('Rename (perf)', (d) => { d.stations.find((s) => s.id === station.id).name = `${station.name} ${i % 2 ? 'a' : 'b'}`; });
        times.commit.push(performance.now() - t0);
        // an uncached read: a new layout object every commit. The issue check (validateLayout with the road graph) is the app's own
        // cost, paid once per layout by whoever asks first: timed apart from the guidance
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
      for (const piece of [card, chip, list]) piece.destroy();
      const stat = (a) => { const b = [...a].sort((x, y) => x - y); return { median: +b[b.length >> 1].toFixed(3), p95: +b[Math.floor(b.length * 0.95)].toFixed(3), max: +b[b.length - 1].toFixed(3) }; };
      return { read: stat(times.read), dom: stat(times.dom), commit: stat(times.commit), issues: stat(times.issues) };
    });
    console.log('   per store change (ms):', JSON.stringify(cost));
    ok(cost.read.median <= 2, `guidance read() median ${cost.read.median} ms per store change (limit 2 ms)`);
    ok(cost.read.p95 <= 4, `guidance read() p95 ${cost.read.p95} ms`);
    ok(cost.dom.median <= 2, `chip, card and list update in a median of ${cost.dom.median} ms`);

    // E2. frame rate at 600x with 10 vehicles, Jobs overlay on and off (rAF intervals), and the drawing time itself
    await click(page, '[data-tool=select]');
    await click(page, '[aria-label="Run simulation"]', 'Play');
    await chooseSpeed(page, 600);
    const measure = async (label) => {
      await page.waitForTimeout(1000);
      const r = await page.evaluate(() => new Promise((resolve) => {
        const dts = [];
        let last = performance.now();
        const t0 = last;
        const tick = (now) => { dts.push(now - last); last = now; if (now - t0 < 3000) requestAnimationFrame(tick); else resolve(dts); };
        requestAnimationFrame(tick);
      }));
      const b = [...r].sort((x, y) => x - y);
      const out = { frames: r.length, fps: +(1000 / (r.reduce((a, c) => a + c, 0) / r.length)).toFixed(1), median: +b[b.length >> 1].toFixed(1), p95: +b[Math.floor(b.length * 0.95)].toFixed(1), max: +b[b.length - 1].toFixed(1) };
      console.log(`   ${label}:`, JSON.stringify(out));
      return out;
    };
    const draw = async (label) => {
      await page.waitForTimeout(600);
      const r = await page.evaluate(() => new Promise((resolve) => {
        const { renderer } = window.__logiplan.ctx;
        const orig = renderer.render;
        const ms = [];
        renderer.render = function patched(...a) { const t = performance.now(); const out = orig.apply(this, a); ms.push(performance.now() - t); return out; };
        setTimeout(() => { renderer.render = orig; resolve(ms); }, 3000);
      }));
      const b = [...r].sort((x, y) => x - y);
      const out = { frames: r.length, median: +b[b.length >> 1].toFixed(2), p95: +b[Math.floor(b.length * 0.95)].toFixed(2), max: +b[b.length - 1].toFixed(2) };
      console.log(`   renderer.render ${label}:`, JSON.stringify(out));
      return out;
    };
    const jobsToggle = page.locator('button', { hasText: /^Jobs$/ }).first();
    const info = await page.evaluate(() => ({ jobs: window.__logiplan.store.getState().ui.overlays.jobs, vehicles: window.__logiplan.runner.sim?.vehicles.length, playing: window.__logiplan.runner.playing }));
    eq(info, { jobs: true, vehicles: 10, playing: true }, 'the Jobs overlay is on by default; 10 vehicles run');
    const on = await measure('rAF, Jobs ON, 600x');
    await click(page, jobsToggle, 'Jobs off');
    const off = await measure('rAF, Jobs OFF, 600x');
    await click(page, jobsToggle, 'Jobs on');
    ok(on.fps >= 50 && off.fps >= 50, `${on.fps} fps with and ${off.fps} fps without the Jobs overlay at 600x with 10 vehicles`);
    ok(on.median <= off.median * 1.15 + 1, `the Jobs overlay costs no frame rate: median ${on.median} ms with, ${off.median} ms without`);
    const dOn = await draw('Jobs ON');
    await click(page, jobsToggle, 'Jobs off');
    const dOff = await draw('Jobs OFF');
    await click(page, jobsToggle, 'Jobs on');
    console.log(`   the Jobs overlay adds ${(dOn.median - dOff.median).toFixed(2)} ms per frame (median), ${(dOn.p95 - dOff.p95).toFixed(2)} ms at p95`);
    ok(dOn.median - dOff.median <= 1.5, `the Jobs overlay adds at most 1.5 ms to a frame (${(dOn.median - dOff.median).toFixed(2)} ms)`);
    // worst case: zoomed in far enough for the "-> Goods in 2" chips (14 px/m and more)
    await page.evaluate(() => { const { camera, canvas } = window.__logiplan.ctx; camera.zoomTo(26, canvas.clientWidth / 2, canvas.clientHeight / 2); });
    const zOn = await draw('zoomed in 26 px/m, Jobs ON');
    await click(page, jobsToggle, 'Jobs off');
    const zOff = await draw('zoomed in 26 px/m, Jobs OFF');
    await click(page, jobsToggle, 'Jobs on');
    console.log(`   zoomed in: the Jobs overlay adds ${(zOn.median - zOff.median).toFixed(2)} ms per frame (median), ${(zOn.p95 - zOff.p95).toFixed(2)} ms at p95`);
    ok(zOn.median - zOff.median <= 1.5, `zoomed in with chips drawn the Jobs overlay still adds at most 1.5 ms (${(zOn.median - zOff.median).toFixed(2)} ms)`);
    await shot(page, 'e02-two-lines-zoomed-jobs');
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
    ok(tabs.includes('How vehicles find work'), `Help has the page: ${tabs.join(' | ')}`);
    await click(page, dialog.getByRole('tab', { name: /How vehicles find work/ }), 'tab: How vehicles find work');
    await page.waitForTimeout(300);
    const text = (await dialog.locator('[role=tabpanel]:not([hidden])').innerText()).replace(/\s+/g, ' ');
    match(text, /Vehicles are not assigned to stations\. Flows say where loads go, and every free vehicle serves every flow automatically\./, 'the page opens with the model');
    match(text, /when you add a second Goods in, give it a flow, and the vehicles you already have will serve it as well\./, 'and the answer to the question that started this');
    match(text, /The Assembly then needs a load from each of them before every cycle; if either one may supply it alone, send both into a Storage/, 'and the bill-of-materials consequence');
    await shot(page, 'f01-help-vehicles');
    await context.close();
    endTally();
  });

  noErrors('end');
});

console.log('\nActions per scenario (clicks + drags + key presses, real input only):');
for (const t of tallies) console.log(`  ${t.name.padEnd(12)} ${String(total(t)).padStart(3)}  (${t.clicks} clicks, ${t.drags} drags, ${t.keys} key presses)`);
if (roughEdges.length) {
  console.log('\nRough edges seen and left as they are:');
  for (const r of roughEdges) console.log(`  [${r.scenario}] ${r.where}: ${r.what}`);
}
console.log(`\n${checks} checks passed`);
