// Guidance journeys through the REAL app (index.html + js/main.js) in headless Chromium: the feedback scenario "how do we model the AGV
// to pick up a new Goods in?" end to end, plus the coaching surfaces around it (Next steps card, Getting started list, guide chip,
// Fix buttons of the Checks tab, dismissals) in light and dark, at 1440 px and 390 px.
//
// Run: node tests/e2e/guidance-logic.mjs [section]
//   sections: feedback checks chip checklist persist layout
// Screenshots: e2e-output/gl-*.png (open them and look). Every section asserts that the page logged no console error or warning.
import assert from 'node:assert/strict';
import path from 'node:path';
import { withBrowser, OUT } from './browser.mjs';

const only = process.argv[2] || '';
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

const DESKTOP = { width: 1440, height: 900 };
const NARROW = { width: 390, height: 800 };

await withBrowser(async ({ browser, url, errors }) => {
  // ---- plumbing -------------------------------------------------------------------------------------------------

  async function openApp({ viewport = DESKTOP, colorScheme = 'light', context: shared = null } = {}) {
    const context = shared || await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[console.${m.type()}] ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    await page.goto(url('/index.html'));
    await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
    await closeWelcome(page);
    return { page, context };
  }

  async function closeWelcome(page) {
    if (await page.locator('[role=dialog]').count()) {
      await page.keyboard.press('Escape');
      await page.locator('[role=dialog]').waitFor({ state: 'detached' });
    }
  }

  const snap = (page, name) => page.screenshot({ path: path.join(OUT, `gl-${name}.png`) });
  const frames = (page, n = 3) => page.evaluate((count) => new Promise((resolve) => {
    const next = (left) => (left ? requestAnimationFrame(() => next(left - 1)) : resolve());
    next(count);
  }), n);
  const noErrors = (what) => { eq(errors.splice(0), [], `${what}: console errors or warnings`); };
  const layoutOf = (page) => page.evaluate(() => structuredClone(window.__logiplan.store.getState().layout));
  const stateOf = (page) => page.evaluate(() => {
    const s = window.__logiplan.store.getState();
    return { undoLabel: s.undoLabel, canUndo: s.canUndo, selection: structuredClone(s.ui.selection), tab: s.ui.rightTab, tool: s.ui.tool };
  });
  const runnerOf = (page) => page.evaluate(() => { const r = window.__logiplan.runner; return { playing: r.playing, time: r.time, hasSim: Boolean(r.sim) }; });
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  const tab = async (page, id) => {
    await page.locator(`[data-tab=${id}]`).click();
    await page.locator(`#panel-${id}`).waitFor({ state: 'visible' });
    await frames(page);
  };
  const cellXY = (page, cx, cy) => page.evaluate(([x, y]) => {
    const { camera, canvas } = window.__logiplan.ctx;
    const cs = window.__logiplan.store.getState().layout.grid.cellSize;
    const [px, py] = camera.worldToScreen((x + 0.5) * cs, (y + 0.5) * cs);
    const r = canvas.getBoundingClientRect();
    return [r.left + px, r.top + py];
  }, [cx, cy]);
  async function clickCell(page, cx, cy) {
    const [x, y] = await cellXY(page, cx, cy);
    await page.mouse.click(x, y);
    await frames(page);
  }
  async function pickExample(page, namePart) {
    await page.getByRole('button', { name: 'Examples' }).first().click();
    const dialog = page.locator('[role=dialog]');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: new RegExp(namePart, 'i') }).first().click();
    const confirm = page.locator('[role=dialog]').getByRole('button', { name: 'Open example' });
    if (await confirm.count()) await confirm.click();
    await dialog.first().waitFor({ state: 'detached' });
    await frames(page, 4);
  }
  /** The Goods in tool, then a click next to the road: a new station through the real editor. Returns its id. */
  async function placeGoodsIn(page, cx, cy) {
    const before = (await layoutOf(page)).stations.map((s) => s.id);
    await page.locator('[data-tool=source]').click();
    await clickCell(page, cx, cy);
    await page.locator('[data-tool=select]').click();
    const after = (await layoutOf(page)).stations;
    const created = after.find((s) => !before.includes(s.id));
    ok(created, 'the Goods in tool placed a station');
    return created;
  }

  /** Press Tab from the Properties tab until the focus is on an element matching `selector` (at most `max` presses). */
  async function tabTo(page, selector, max = 80) {
    await page.locator('[data-tab=properties]').focus();
    for (let i = 0; i < max; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate((s) => document.activeElement?.matches(s) === true, selector)) return;
    }
    assert.fail(`Tab never reached ${selector}`);
  }

  const card = (page) => page.locator('#panel-properties .guide:not(.guide-check)');
  const step = (page, id) => page.locator(`#panel-properties [data-step="${id}"]`);
  const chip = (page) => page.locator('[data-guide-chip]');
  const chipButton = (page) => page.locator('[data-guide-chip-button]');
  const badgeText = async (page) => {
    const badge = page.locator('[data-tab=checks] .badge');
    return (await badge.isVisible()) ? (await badge.innerText()).trim() : '';
  };

  const run = async (name, fn) => {
    if (only && only !== name) return;
    console.log(`-- ${name}`);
    await fn();
  };

  // ---------------------------------------------------------------------------------------------------------------
  // The feedback: "it is not clear how we can model the AGV to pick up a new goods entry when we add multiple goods entries"
  await run('feedback', async () => {
    const { page, context } = await openApp();
    await pickExample(page, 'Starter');
    const starter = await layoutOf(page);
    eq(starter.flows.length, 2, 'the Starter plant has two flows');
    eq(starter.fleets.map((f) => f.count), [2], 'and two AGVs');

    // a complete plant that never ran
    ok(await card(page).isVisible(), 'the Next steps card is on top of the Properties tab');
    eq(await card(page).locator('.guide__title').innerText(), 'Next steps', 'titled Next steps');
    ok(await step(page, 'run:press-play').isVisible(), 'the plant is complete: "Press play to watch it run"');
    eq(await chipButton(page).innerText(), '1 step to finish', 'the chip over the plan counts it');
    eq(await badgeText(page), '', 'no problems in the Checks tab');
    await snap(page, 'feedback-1-starter-light');

    // add a second Goods in with the real tool, next to the road
    const second = await placeGoodsIn(page, 3, 14);
    const layout = await layoutOf(page);
    eq(layout.stations.length, starter.stations.length + 1, 'a second Goods in is on the plan');
    eq(layout.flows.length, 2, 'it has no flow yet');
    eq((await stateOf(page)).selection, { kind: 'station', ids: [second.id] }, 'the new station is selected');
    // while the station is selected its form asks the question ("Where do loads go?"): the card does not ask it a second time
    eq(await step(page, `connect-out:${second.id}`).count(), 0, 'the card does not repeat the choice the form shows right below it');
    const ask = page.locator('#panel-properties [data-loads=out]');
    ok(await ask.getByRole('button', { name: /Connect/ }).isVisible(), 'the form offers Connect');
    eq(await ask.locator('select').inputValue(), 's2', 'with the Assembly preselected');
    await page.keyboard.press('Escape'); // nothing selected: the card is the guide again
    await page.waitForFunction(() => window.__logiplan.store.getState().ui.selection.kind === null);
    const row = step(page, `connect-out:${second.id}`);
    await row.waitFor();
    eq(await row.locator('.guide-step__title').innerText(), `${second.name} is not connected yet`, 'the card names the new Goods in');
    ok((await row.locator('.guide-step__text').innerText()).includes('Where should its loads go?'), 'it asks where the loads should go');
    ok((await row.locator('.guide-step__text').innerText()).includes('Vehicles pick up from every connected Goods in automatically.'), 'and teaches that vehicles serve every connected Goods in');
    ok(await row.getByRole('button', { name: /^Connect / }).isVisible(), 'the card offers Connect');
    const options = await row.locator('select option').allInnerTexts();
    ok(options.length >= 2, `the other end can be chosen: ${options.join(' | ')}`);
    eq(await row.locator('select').inputValue(), 's2', 'the suggestion (the Assembly workstation) is preselected');
    ok(options[0].startsWith('Assembly') || options.some((o) => o.startsWith('Assembly')), 'Assembly is among the choices');
    ok(await step(page, 'run:press-play').count() === 0, 'while something is open, "press play" waits');
    eq(await chipButton(page).innerText(), '1 step to finish', 'the chip counts the open step');
    ok((await chipButton(page).getAttribute('class')).includes('guide-chip__button--warn'), 'the chip is amber while a step is a warning');
    eq(await badgeText(page), '1', 'the Checks tab shows the warning');
    await snap(page, 'feedback-2-unconnected-light');

    // typing a new name: the field keeps the focus and the step follows the name
    await clickCell(page, 3, 14); // select the Goods in again: the Name field is in its form
    const nameField = page.locator('#panel-properties').getByLabel('Name', { exact: true });
    await nameField.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('Dock 9', { delay: 40 });
    eq(await nameField.evaluate((el) => el === document.activeElement), true, 'typing in the Properties form keeps the keyboard focus');
    eq(await nameField.inputValue(), 'Dock 9', 'and the text');
    second.name = 'Dock 9';
    await page.locator('[data-tool=select]').click();
    await page.mouse.click(...(await cellXY(page, 30, 3))); // empty ground: deselect
    await page.waitForFunction(() => document.querySelector('#panel-properties [data-step^="connect-out:"] .guide-step__title')?.textContent === 'Dock 9 is not connected yet');
    eq(await row.locator('.guide-step__title').innerText(), 'Dock 9 is not connected yet', 'the step names the station by its new name');
    eq(await row.locator('select').inputValue(), 's2', 'the choice was not reset');

    // Connect: the arrow appears, the warning goes, the badge clears
    await row.getByRole('button', { name: /^Connect / }).click();
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.flows.length === 3);
    await frames(page, 4);
    const connected = await layoutOf(page);
    const flow = connected.flows.find((f) => f.from === second.id);
    ok(flow && flow.to === 's2', `the new flow runs ${second.name} -> Assembly`);
    eq((await stateOf(page)).undoLabel, `Connect ${second.name} → Assembly`, 'one undo step with a clear label');
    eq((await stateOf(page)).selection, { kind: 'flow', ids: [flow.id] }, 'the new flow is selected');
    ok(await page.locator('.toast').filter({ hasText: 'Flow created. Vehicles will serve it automatically.' }).count() === 1, 'the toast says what happens next');
    ok(await page.locator('.toast .toast__action', { hasText: 'Undo' }).count() >= 1, 'with an Undo action');
    eq(await step(page, `connect-out:${second.id}`).count(), 0, 'the step is gone');
    ok(await page.evaluate(() => document.activeElement?.closest('.guide') === null), 'a mouse user is not handed a focused button (Space still plays and pauses)');
    eq(await page.evaluate(() => window.__logiplan.ctx.issues().filter((i) => i.severity !== 'info').length), 0, 'the plant has no warning left');
    await page.waitForFunction(() => !document.querySelector('[data-tab=checks] .badge:not([hidden])'));
    eq(await badgeText(page), '', 'the Checks badge cleared');
    ok(!(await chipButton(page).getAttribute('class')).includes('guide-chip__button--warn'), 'the chip is calm again');
    ok(await step(page, 'run:press-play').isVisible(), 'now: "Press play to watch it run"');
    const note = step(page, 'info:vehicles-serve-all');
    ok(await note.isVisible(), 'and the note that vehicles serve every Goods in automatically');
    eq(await note.locator('.guide-step__title').innerText(), 'Your AGVs serve every Goods in automatically', 'in words the planner knows');
    ok((await note.locator('.guide-step__text').innerText()).includes('Change this in Simulate › Dispatch strategy.'), 'with where to change the strategy');
    await snap(page, 'feedback-3-connected-light');

    // undo / redo walk back and forth
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.flows.length === 2);
    await row.waitFor();
    await page.keyboard.press('Control+Shift+z');
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.flows.length === 3);
    await step(page, 'run:press-play').waitFor();

    // run it: the SAME vehicles serve both Goods in
    await step(page, 'run:press-play').getByRole('button', { name: /Run/ }).click();
    await page.waitForFunction(() => window.__logiplan.runner.playing && window.__logiplan.runner.sim);
    ok(await step(page, 'run:press-play').count() === 0, 'running: the play step is gone');
    await page.evaluate(() => {
      const { runner } = window.__logiplan;
      window.__deliveries = [];
      runner.sim.on('orderDelivered', ({ order }) => window.__deliveries.push([order.flowId, order.vehicleId]));
      runner.setSpeed(600);
    });
    await page.waitForFunction(() => window.__logiplan.runner.time >= 3000, null, { timeout: 90000 });
    const result = await page.evaluate(() => {
      const { runner } = window.__logiplan;
      const kpis = runner.kpis();
      const byFlow = {};
      for (const [flowId, vehicleId] of window.__deliveries) (byFlow[flowId] ||= new Set()).add(vehicleId);
      return {
        flows: Object.fromEntries(Object.entries(kpis.flows).map(([id, f]) => [id, f.delivered])),
        vehicles: Object.fromEntries(Object.entries(byFlow).map(([id, set]) => [id, [...set].sort()])),
        fleets: Object.keys(kpis.fleets),
        trips: Object.values(kpis.fleets).map((f) => f.trips),
      };
    });
    console.log('   delivered per flow:', JSON.stringify(result.flows), 'vehicles per flow:', JSON.stringify(result.vehicles));
    ok(result.flows[flow.id] > 0, `the new flow delivered loads: ${result.flows[flow.id]}`);
    ok(result.flows.f1 > 0, `the original flow still delivers: ${result.flows.f1}`);
    eq(result.fleets.length, 1, 'there is one fleet');
    const serving = result.vehicles[flow.id] || [];
    const serving1 = result.vehicles.f1 || [];
    ok(serving.length > 0 && serving.every((v) => v.startsWith('v1#')), `the new flow was served by the AGVs of the existing fleet: ${serving.join(', ')}`);
    ok(serving.some((v) => serving1.includes(v)), `at least one AGV serves both Goods in: ${serving.join(', ')} / ${serving1.join(', ')}`);

    // after five simulated minutes: Open Results; once read, All set
    const open = step(page, 'run:open-results');
    await open.waitFor();
    eq(await open.locator('.guide-step__title').innerText(), 'Open Results to find the bottleneck', 'the card sends the planner to the Results');
    await open.getByRole('button', { name: /Open Results/ }).click();
    await page.locator('#panel-results').waitFor({ state: 'visible' });
    eq((await stateOf(page)).tab, 'results', 'the Results tab opened');
    await tab(page, 'properties');
    await page.locator('#panel-properties .guide__allset').waitFor({ state: 'visible' });
    eq(await card(page).locator('.guide__title').innerText(), 'All set', 'nothing left: All set');
    ok(await card(page).locator('.guide__allset .btn').isVisible(), 'with a Run / Pause button');
    ok(await page.locator('#panel-properties .guide-check').isHidden(), 'the Getting started list is done and gone');
    eq(await chip(page).isHidden(), true, 'the chip is gone');
    await snap(page, 'feedback-4-allset-light');
    await context.close();
    noErrors('feedback');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('checks', async () => {
    const { page, context } = await openApp();
    await pickExample(page, 'Starter');
    const second = await placeGoodsIn(page, 3, 14);
    await tab(page, 'checks');
    const fix = page.locator('#panel-checks [data-role=fix]');
    ok(await fix.count() >= 1, 'the Checks tab has a Fix next to the issue');
    const callout = page.locator('#panel-checks .callout').filter({ hasText: `“${second.name}” creates loads but no flow` });
    ok(await callout.isVisible(), 'the unconnected Goods in is listed');
    ok(await callout.locator('select').isVisible(), 'with the inline choice of the destination');
    ok(await callout.getByRole('button', { name: /^Connect / }).isVisible(), 'and Connect');
    ok(await callout.getByRole('button', { name: /Show on the plan/ }).isVisible(), 'next to Show');
    await snap(page, 'checks-1-connect-light');
    const options = await callout.locator('select option').allInnerTexts();
    const dispatch = options.find((o) => o.startsWith('Dispatch'));
    await callout.locator('select').selectOption({ label: dispatch });
    await callout.getByRole('button', { name: /^Connect / }).click();
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.flows.length === 3);
    eq((await layoutOf(page)).flows.at(-1).to, 's3', 'the planner chose the destination, not the suggestion');
    eq(await page.locator('#panel-checks .callout').filter({ hasText: 'creates loads but no flow' }).count(), 0, 'the warning is gone');

    // no vehicles: Add vehicles
    await page.evaluate(() => window.__logiplan.store.commit('Remove vehicles', (d) => { d.fleets.length = 0; }));
    await frames(page, 4);
    const noFleet = page.locator('#panel-checks .callout').filter({ hasText: 'there are no vehicles' });
    await noFleet.waitFor();
    await noFleet.getByRole('button', { name: /Add vehicles/ }).click();
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.fleets.length === 1);
    eq((await layoutOf(page)).fleets[0].count, 2, 'two vehicles were added');
    eq((await stateOf(page)).undoLabel, 'Add AGV fleet', 'with a clear label');
    await page.locator('#panel-checks .callout').filter({ hasText: 'there are no vehicles' }).waitFor({ state: 'detached' });
    ok(true, 'the error is gone');

    // a station off the road: Show and the hint
    const far = await page.evaluate(() => {
      const { store } = window.__logiplan;
      let id = null;
      return import('/js/model/layout.js').then((m) => { store.commit('Add station', (d) => { id = m.addStation(d, { type: 'process', x: 2, y: 20 })?.id ?? null; }); return id; });
    });
    ok(far, 'a workstation off the road was added');
    await frames(page, 4);
    const lonely = page.locator('#panel-checks .callout').filter({ hasText: 'is not next to any road' });
    await lonely.first().waitFor();
    ok((await lonely.first().innerText()).includes('Select the station and drag it next to a road.'), 'the hint says how to fix it');
    await lonely.first().getByRole('button', { name: /Show on the plan/ }).click();
    eq((await stateOf(page)).selection, { kind: 'station', ids: [far] }, 'Show selects the station');
    await snap(page, 'checks-2-dock-light');
    await context.close();
    noErrors('checks');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('chip', async () => {
    const { page, context } = await openApp();
    await pickExample(page, 'Starter');
    await placeGoodsIn(page, 3, 14);
    await page.locator('[data-tool=select]').click();
    const button = chipButton(page);
    ok(await button.isVisible(), 'the guide chip is on the plan');
    eq(await button.getAttribute('aria-expanded'), 'false', 'closed');
    const pop = page.locator('.guide-pop');
    ok(await pop.isHidden(), 'the popover is closed');

    // mouse: open, steps inside, close with the x
    await button.click();
    await pop.waitFor({ state: 'visible' });
    eq(await button.getAttribute('aria-expanded'), 'true', 'the chip says it is open');
    ok(await pop.locator('[data-step^="connect-out:"]').isVisible(), 'the same steps as the card');
    ok((await pop.innerText()).includes('every free vehicle serves every flow'), 'with the one-line model');
    await snap(page, 'chip-1-open-light');
    await pop.getByRole('button', { name: 'Close the list of next steps' }).click();
    await pop.waitFor({ state: 'hidden' });
    eq(await page.evaluate(() => document.activeElement?.hasAttribute('data-guide-chip-button')), true, 'focus returns to the chip');

    // keyboard: Enter opens, Tab reaches the steps, Escape closes and keeps the selection
    await page.locator('[data-tool=select]').click();
    await button.focus();
    await page.keyboard.press('Enter');
    await pop.waitFor({ state: 'visible' });
    await page.keyboard.press('Tab');
    ok(await page.evaluate(() => document.activeElement?.closest('.guide-pop') !== null), 'Tab moves into the popover');
    const selectionBefore = (await stateOf(page)).selection;
    await page.keyboard.press('Escape');
    await pop.waitFor({ state: 'hidden' });
    eq(await page.evaluate(() => document.activeElement?.hasAttribute('data-guide-chip-button')), true, 'Escape returns focus to the chip');
    eq((await stateOf(page)).selection, selectionBefore, 'and does not clear the selection of the plan');

    // clicking the plan closes it
    await button.click();
    await pop.waitFor({ state: 'visible' });
    await page.mouse.click(900, 300);
    await pop.waitFor({ state: 'hidden' });

    // it connects from the popover and goes away with the last step
    await button.click();
    await pop.locator('[data-step^="connect-out:"]').getByRole('button', { name: /^Connect / }).click();
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.flows.length === 3);
    await frames(page, 4);
    eq(await button.innerText(), '1 step to finish', 'one step is left: press play');
    await pop.locator('[data-step="run:press-play"]').getByRole('button', { name: /^Run/ }).click();
    await page.waitForFunction(() => window.__logiplan.runner.playing);
    await chip(page).waitFor({ state: 'hidden' });

    // geometry: above the scale bar, clear of the zoom buttons, lifted above the heatmap legend
    await page.evaluate(() => window.__logiplan.runner.pause());
    await page.evaluate(() => window.__logiplan.store.commit('Unconnect', (d) => { d.flows.pop(); }));
    await chip(page).waitFor({ state: 'visible' });
    const geometry = () => page.evaluate(() => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
      return { chip: box(document.querySelector('[data-guide-chip-button]')), stage: box(document.querySelector('.stage')), zoom: box(document.querySelector('.stage__zoom')) };
    });
    let g = await geometry();
    ok(g.chip.b <= g.stage.b - 38, `the chip is above the scale bar (${Math.round(g.stage.b - g.chip.b)} px above the stage bottom)`);
    ok(g.chip.r < g.zoom.l || g.chip.b < g.zoom.t || g.chip.l > g.zoom.r, 'the chip does not touch the zoom buttons');
    await page.locator('[data-heat=traffic]').click();
    await frames(page, 3);
    g = await geometry();
    ok(g.chip.b <= g.stage.b - 90, `with a heatmap legend the chip is lifted above it (${Math.round(g.stage.b - g.chip.b)} px)`);
    await snap(page, 'chip-2-heat-light');
    await context.close();
    noErrors('chip');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('checklist', async () => {
    const { page, context } = await openApp();
    const list = page.locator('#panel-properties .guide-check');
    ok(await list.isVisible(), 'a new planner sees Getting started');
    eq(await list.locator('.guide-check__count').innerText(), '0 of 6', 'nothing done yet');
    eq(await list.locator('.guide-check__row').count(), 6, 'six steps');
    eq(await list.locator('.guide-check__title').allInnerTexts(), ['Draw roads', 'Place stations next to the road', 'Connect them with flows', 'Add vehicles', 'Run the simulation', 'Read the results'], 'in teaching order');
    eq(await list.locator('[aria-current=step] .guide-check__title').innerText(), 'Draw roads', 'the first one is the current step');
    await snap(page, 'checklist-1-new-light');

    // a row performs the step: Draw roads picks the road tool
    await list.getByRole('button', { name: /Draw roads/ }).click();
    eq((await stateOf(page)).tool, 'road', 'the row chose the Road tool');
    // draw a road with the real tool, the row ticks itself
    const [x1, y1] = await cellXY(page, 10, 12);
    const [x2, y2] = await cellXY(page, 24, 12);
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move((x1 + x2) / 2, y1, { steps: 6 });
    await page.mouse.move(x2, y2, { steps: 6 });
    await page.mouse.up();
    await frames(page, 4);
    await page.locator('[data-tool=select]').click();
    eq(await list.locator('.guide-check__count').innerText(), '1 of 6', 'drawing a road ticks the first step');
    eq(await list.locator('.guide-check__row.is-done').count(), 1, 'one row is done');
    eq(await list.locator('[aria-current=step] .guide-check__title').innerText(), 'Place stations next to the road', 'and the next one is current');
    eq(await list.locator('.progress').getAttribute('aria-valuenow'), '1', 'the progress bar follows');
    ok(await card(page).isHidden(), 'the Next steps card does not say "Place a Goods in and a Workstation" a second time: the list shows it');

    // collapse and hide
    await list.getByRole('button', { name: 'Collapse the getting started list' }).click();
    ok(await list.locator('.guide-check__list').isHidden(), 'collapsed');
    await list.getByRole('button', { name: 'Expand the getting started list' }).click();
    ok(await list.locator('.guide-check__list').isVisible(), 'expanded again');
    await list.getByRole('button', { name: 'Hide the getting started list' }).click();
    ok(await list.isHidden(), 'dismissed');
    ok((await card(page).innerText()).includes('Place a Goods in and a Workstation next to the road'), 'and with the list gone the Next steps card says it');
    eq(await page.evaluate(() => JSON.parse(localStorage.getItem('logiplan:guidance-dismissed'))), ['checklist'], 'remembered in localStorage');
    await page.reload();
    await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready');
    await closeWelcome(page);
    await frames(page, 4);
    ok(await page.locator('#panel-properties .guide-check').isHidden(), 'it stays hidden after a reload');
    await context.close();

    // the keyboard way: hiding the list does not drop the focus on the page
    const fresh = await openApp();
    await tabTo(fresh.page, '.guide-check [aria-label="Hide the getting started list"]');
    await fresh.page.keyboard.press('Enter');
    await fresh.page.locator('#panel-properties .guide-check').waitFor({ state: 'hidden' });
    ok(await fresh.page.evaluate(() => document.activeElement?.closest('#panel-properties .guide') !== null), 'the focus moved on to the Next steps card');
    await fresh.context.close();
    noErrors('checklist');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('persist', async () => {
    const { page, context } = await openApp();
    await pickExample(page, 'Congestion');
    const note = step(page, 'info:vehicles-serve-all');
    ok(await note.isVisible(), 'the Congestion lab has several Goods in: the note is shown');
    const mouseOnly = await note.getByRole('button', { name: 'Not now' }).count();
    ok(mouseOnly === 1, 'the note offers Not now');
    await tabTo(page, '[data-step="info:vehicles-serve-all"] .guide-step__dismiss');
    await page.keyboard.press('Enter');
    await note.waitFor({ state: 'detached' });
    eq(await page.evaluate(() => JSON.parse(localStorage.getItem('logiplan:guidance-dismissed'))), ['info:vehicles-serve-all'], 'the dismissal is stored');
    eq(await page.evaluate(() => document.activeElement === document.body), false, 'a keyboard user keeps the focus: it moved on to the next control');
    ok(await page.evaluate(() => document.activeElement?.closest('#panel-properties .guide') !== null), 'inside the card');
    await page.waitForTimeout(700); // the autosave of the plant
    await page.reload();
    await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready');
    await closeWelcome(page);
    await frames(page, 4);
    eq(await page.evaluate(() => window.__logiplan.store.getState().layout.name.length > 0), true, 'the plant came back');
    eq(await step(page, 'info:vehicles-serve-all').count(), 0, 'the dismissed note stays away after a reload');
    // a different, still-undismissed step is not affected
    await page.evaluate(() => window.__logiplan.store.commit('No fleets', (d) => { d.fleets.length = 0; }));
    await frames(page, 4);
    ok(await step(page, 'no-fleet').isVisible(), 'other steps still show');
    await context.close();
    noErrors('persist');
  });

  // ---------------------------------------------------------------------------------------------------------------
  await run('layout', async () => {
    // dark, desktop
    {
      const { page, context } = await openApp({ colorScheme: 'dark' });
      await pickExample(page, 'Starter');
      await placeGoodsIn(page, 3, 14);
      await frames(page, 3);
      await snap(page, 'layout-1-dark');
      await page.locator('[data-guide-chip-button]').click();
      await page.locator('.guide-pop').waitFor({ state: 'visible' });
      await snap(page, 'layout-2-dark-popover');
      ok(await overflow(page) <= 0, 'dark: no horizontal page overflow');
      await context.close();
    }
    // narrow, light and dark: chip above the tool strip, popover, drawer with the card
    for (const scheme of ['light', 'dark']) {
      const { page, context } = await openApp({ viewport: NARROW, colorScheme: scheme });
      await page.evaluate(async () => { await window.__logiplan.ctx.actions.loadExample('starter'); });
      await frames(page, 4);
      await page.evaluate(async () => {
        const m = await import('/js/model/layout.js');
        window.__logiplan.store.commit('Add Goods in', (d) => { m.addStation(d, { type: 'source', x: 2, y: 9 }); });
      });
      await frames(page, 4);
      const g = await page.evaluate(() => {
        const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; };
        return { chip: box(document.querySelector('[data-guide-chip-button]')), palette: box(document.querySelector('.palette')), zoom: box(document.querySelector('.stage__zoom')), stage: box(document.querySelector('.stage')) };
      });
      ok(g.chip.b <= g.palette.t, `narrow: the chip is above the tool strip (${Math.round(g.palette.t - g.chip.b)} px)`);
      ok(g.chip.b <= g.stage.b - 38, 'narrow: and above the scale bar');
      ok(g.chip.r < g.zoom.l || g.chip.b < g.zoom.t, 'narrow: clear of the zoom buttons');
      ok(await overflow(page) <= 0, 'narrow: no horizontal page overflow');
      await snap(page, `layout-3-narrow-${scheme}`);
      await page.locator('[data-guide-chip-button]').click();
      await page.locator('.guide-pop').waitFor({ state: 'visible' });
      const pop = await page.evaluate(() => { const r = document.querySelector('.guide-pop').getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, w: innerWidth }; });
      ok(pop.l >= 0 && pop.r <= pop.w && pop.t >= 0, `narrow: the popover fits the screen (${Math.round(pop.l)}..${Math.round(pop.r)} of ${pop.w})`);
      await snap(page, `layout-4-narrow-popover-${scheme}`);
      await page.locator('[data-guide-chip-button]').click();
      await page.locator('.topbar__panel-toggle').click();
      await page.locator('#panel-properties .guide').first().waitFor({ state: 'visible' });
      await page.waitForTimeout(500); // the drawer slides in
      ok(await overflow(page) <= 0, 'narrow drawer: no horizontal page overflow');
      const inside = await page.evaluate(() => {
        const side = document.querySelector('.side').getBoundingClientRect();
        return [...document.querySelectorAll('#panel-properties .guide *')].filter((e) => e.getBoundingClientRect().width > 0).every((e) => e.getBoundingClientRect().right <= side.right + 1);
      });
      ok(inside, 'narrow drawer: nothing of the card sticks out of the panel');
      await snap(page, `layout-5-narrow-drawer-${scheme}`);
      await context.close();
    }
    noErrors('layout');
  });

  console.log(`guidance-logic: ${checks} checks passed`);
});
