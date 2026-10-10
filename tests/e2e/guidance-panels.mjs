// "Who serves which flow" in the side panels and the Help, driven through the REAL app (index.html + js/main.js) in headless Chromium:
// the feedback "it is not clear how we can model the AGV to pick up a new goods entry when we add multiple goods entries".
//   inspector  the station form: "Where do loads go?" / "Where do loads come from?", Add destination, weights, remove, undo, focus
//   fleet      "Jobs this fleet serves": any fleet / only this fleet, the switch, warnings, the vehicles per flow
//   flows      "Served by" lines, the explainer, the live chips while the simulation runs (cheaply), typing while it runs
//   help       the "How vehicles find work" page and its diagram, the welcome tips
//   layout     light and dark, 1440 px and 390 px: nothing sticks out, nothing shifts
//
// Run: node tests/e2e/guidance-panels.mjs [section]
// Screenshots: e2e-output/gp-*.png (open them and look). Every section asserts that the page logged no console error or warning.
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

  async function openApp({ viewport = DESKTOP, colorScheme = 'light', keepWelcome = false } = {}) {
    const context = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`[console.${m.type()}] ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    await page.goto(url('/index.html'));
    await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
    if (!keepWelcome) await closeDialogs(page);
    return { page, context };
  }

  async function closeDialogs(page) {
    while (await page.locator('[role=dialog]').count()) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(60);
    }
  }

  const snap = (page, name) => page.screenshot({ path: path.join(OUT, `gp-${name}.png`) });
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
  const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  const tab = async (page, id) => {
    await page.evaluate((t) => window.__logiplan.ctx.actions.setRightTab(t), id);
    await page.locator(`#panel-${id}`).waitFor({ state: 'visible' });
    await frames(page);
  };
  const select = async (page, kind, ids) => {
    await page.evaluate(([k, i]) => window.__logiplan.store.select(k, i), [kind, ids]);
    await frames(page, 3);
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
  /** The Goods in tool, then a click next to the road: a new station through the real editor. */
  async function placeGoodsIn(page, cx, cy) {
    const before = (await layoutOf(page)).stations.map((s) => s.id);
    await page.locator('[data-tool=source]').click();
    await clickCell(page, cx, cy);
    await page.locator('[data-tool=select]').click();
    const created = (await layoutOf(page)).stations.find((s) => !before.includes(s.id));
    ok(created, 'the Goods in tool placed a station');
    return created;
  }
  /** Run a model edit on the layout (a test fixture) and let the panels follow. */
  const edit = async (page, label, fn) => {
    await page.evaluate(async ([l, src]) => {
      const m = await import('/js/model/layout.js');
      // eslint-disable-next-line no-new-func
      window.__logiplan.store.commit(l, (d) => new Function('m', 'd', src)(m, d));
    }, [label, fn]);
    await frames(page, 3);
  };
  const focusIn = (page, selector) => page.evaluate((s) => Boolean(document.activeElement?.closest(s)), selector);

  const P = (page) => page.locator('#panel-properties');
  const OUT_BLOCK = (page) => P(page).locator('[data-loads=out]');
  const IN_BLOCK = (page) => P(page).locator('[data-loads=in]');
  const toasts = (page) => page.locator('.toast');
  /** The headings of the groups of flows that are on screen ('Any fleet', 'Only this fleet'), lower case (the kit sets them in capitals). */
  const visibleGroups = async (scope) => (await scope.locator('h4:visible').allInnerTexts()).map((t) => t.toLowerCase());

  const run = async (name, fn) => {
    if (only && only !== name) return;
    console.log(`-- ${name}`);
    await fn();
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Properties: where do the loads of this station go, and where do they come from?
  // ---------------------------------------------------------------------------------------------------------------
  await run('inspector', async () => {
    const { page, context } = await openApp();
    await pickExample(page, 'Starter');
    const starter = await layoutOf(page);
    const second = await placeGoodsIn(page, 3, 14);
    eq((await stateOf(page)).selection, { kind: 'station', ids: [second.id] }, 'the new Goods in is selected');
    await tab(page, 'properties');

    // the problem as the planner meets it: a second Goods in, no flow
    const out = OUT_BLOCK(page);
    await out.waitFor();
    eq(await out.locator('h3').innerText(), 'Where do loads go?', 'a section that asks the planner’s question');
    eq(await IN_BLOCK(page).count(), 0, 'a Goods in creates its loads itself: nothing comes from anywhere');
    const callout = out.locator('.callout');
    ok(await callout.isVisible(), 'a prominent callout');
    ok((await callout.getAttribute('class')).includes('callout--warn'), 'in the warning tone');
    eq(await callout.locator('.callout__title').innerText(), 'Not connected yet');
    eq(await callout.locator('.callout__text').innerText(), 'Loads pile up at this gate. Pick a destination.', 'it says what happens and what to do');
    const pickerSelect = callout.locator('select');
    ok(await pickerSelect.isVisible(), 'the picker sits right in the callout');
    const options = await pickerSelect.locator('option').allInnerTexts();
    eq(options, ['Assembly (Workstation)', 'Dispatch (Goods out)'], 'every legal destination, closest first');
    eq(await pickerSelect.inputValue(), 's2', 'the best guess (the Assembly) is preselected');
    eq(await out.locator('label.sr-only').first().innerText(), `Where should ${second.name} send its loads?`, 'the choice has a label');
    ok((await callout.getByRole('button', { name: /^Connect / }).getAttribute('aria-label')).startsWith(`Connect ${second.name} to Assembly`), 'the button says which two stations it connects');
    const heights = await page.evaluate(() => {
      const top = (sel) => document.querySelector(sel).getBoundingClientRect().top;
      const sections = [...document.querySelectorAll('#panel-properties summary')].map((s) => s.textContent.trim().slice(0, 12));
      return { out: top('#panel-properties [data-loads=out]'), deliveries: top('#panel-properties details'), sections };
    });
    ok(heights.out < heights.deliveries, `the section sits above the parameters (${Math.round(heights.out)} < ${Math.round(heights.deliveries)})`);
    await snap(page, 'inspector-1-unconnected-light');

    // choose another destination and back: the choice survives updates
    await pickerSelect.selectOption('s3');
    await frames(page, 3);
    eq(await pickerSelect.inputValue(), 's3', 'the planner’s choice is kept');
    await pickerSelect.selectOption('s2');

    // Connect: one undo step, the selection stays, the row appears, the callout goes
    await callout.getByRole('button', { name: /^Connect / }).click();
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.flows.length === 3);
    await frames(page, 4);
    eq((await stateOf(page)).undoLabel, `Connect ${second.name} → Assembly`, 'an undoable commit with a clear label');
    eq((await stateOf(page)).selection, { kind: 'station', ids: [second.id] }, 'the planner stays on the station');
    const flow = (await layoutOf(page)).flows.find((f) => f.from === second.id);
    ok(flow && flow.to === 's2', 'the flow runs from the new Goods in to the Assembly');
    const row = out.locator(`li[data-flow="${flow.id}"]`);
    ok(await row.isVisible(), 'a row for the new flow');
    ok((await row.innerText()).includes('Assembly'), 'with the destination chip');
    eq(await out.locator('.callout').count(), 0, 'the callout is gone');
    ok(await out.getByRole('button', { name: 'Add destination' }).isVisible(), 'and an Add destination button takes its place');
    eq(await row.locator('.stepper').isVisible(), false, 'one destination takes all loads: no weight to set');
    ok(await focusIn(page, '[data-loads=out]'), 'the keyboard focus stays in the section');
    ok(/Connected .* to Assembly\./.test(await out.locator('[role=status]').innerText()), 'a screen reader hears what happened');
    await snap(page, 'inspector-2-connected-light');

    // undo and redo go back and forth
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.flows.length === 2);
    await out.locator('.callout').waitFor();
    await page.keyboard.press('Control+Shift+z');
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.flows.length === 3);
    await row.waitFor();

    // a second destination: the picker opens on demand, closes after Connect, and shares appear
    const add = out.getByRole('button', { name: 'Add destination' });
    eq(await add.getAttribute('aria-expanded'), 'false');
    await add.click();
    eq(await add.getAttribute('aria-expanded'), 'true');
    ok(await out.locator('select').isVisible(), 'the picker opens');
    ok(await page.evaluate(() => document.activeElement?.tagName === 'SELECT'), 'and takes the focus');
    eq(await out.locator('select option').allInnerTexts(), ['Dispatch (Goods out)'], 'only what is not connected yet');
    await page.keyboard.press('Escape');
    eq((await stateOf(page)).selection.kind, 'station', 'Escape closes the picker without clearing the selection');
    ok(await out.locator('select').isHidden(), 'the picker is closed');
    ok(await page.evaluate(() => document.activeElement?.textContent.includes('Add destination')), 'and the focus is back on the button');
    await add.click();
    await out.getByRole('button', { name: /^Connect / }).click();
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.flows.length === 4);
    await frames(page, 4);
    const flows = (await layoutOf(page)).flows.filter((f) => f.from === second.id);
    eq(flows.map((f) => f.to), ['s2', 's3'], 'two destinations');
    const rows = out.locator('li[data-flow]');
    eq(await rows.count(), 2);
    eq(await rows.locator('.tnum').filter({ hasText: '%' }).allInnerTexts(), ['50 %', '50 %'], 'the shares of the output');
    ok(await rows.first().locator('.stepper').isVisible(), 'the weight stepper appears with several destinations');
    ok((await out.innerText()).includes('Weights are relative'), 'and a line that explains weights');
    eq(await out.getByRole('button', { name: 'Add destination' }).count(), 0, 'no button once every destination is connected');
    ok(await focusIn(page, '[data-loads=out]'), 'and the keyboard focus moved to the new row, not to the page');
    ok((await out.innerText()).includes('Every possible destination is connected already.'));
    eq(await out.locator('.badge').innerText(), '2', 'the count sits next to the title');
    await snap(page, 'inspector-3-two-destinations-light');

    // the weight: stepper, undo, typing keeps the focus
    const weight1 = rows.first().locator('.stepper__input');
    await rows.first().getByRole('button', { name: /^Raise the weight/ }).click();
    await frames(page, 3);
    eq((await layoutOf(page)).flows.find((f) => f.id === flows[0].id).weight, 2, 'the plus button raises the weight');
    eq(await rows.locator('.tnum').filter({ hasText: '%' }).allInnerTexts(), ['67 %', '33 %'], 'the shares follow');
    ok((await stateOf(page)).undoLabel.startsWith('Change weight of flow'), `labelled for the undo list: ${(await stateOf(page)).undoLabel}`);
    await page.keyboard.press('Control+z');
    await frames(page, 3);
    eq((await layoutOf(page)).flows.find((f) => f.id === flows[0].id).weight, 1, 'one undo step');
    await weight1.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('3', { delay: 50 });
    await frames(page, 6);
    eq(await weight1.evaluate((el) => el === document.activeElement), true, 'typing a weight keeps the keyboard focus');
    eq(await weight1.inputValue(), '3');
    eq((await layoutOf(page)).flows.find((f) => f.id === flows[0].id).weight, 3, 'the weight is committed as it is typed');
    eq(await rows.locator('.tnum').filter({ hasText: '%' }).allInnerTexts(), ['75 %', '25 %']);
    await page.keyboard.type('x', { delay: 20 }); // not a number: ignored, nothing breaks
    await page.keyboard.press('Control+a');
    await page.keyboard.type('0', { delay: 30 });
    eq((await layoutOf(page)).flows.find((f) => f.id === flows[0].id).weight, 3, 'a weight below the minimum is not committed');
    await page.keyboard.press('Tab');
    await frames(page, 3);
    eq(await weight1.inputValue(), '3', 'and the field shows the real value again when it is left');

    // remove: keyboard, undo toast, focus stays in the section
    const removeButton = rows.nth(1).getByRole('button', { name: /^Remove flow/ });
    await removeButton.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.flows.length === 3);
    await frames(page, 4);
    eq(await rows.count(), 1, 'the row is gone');
    ok((await stateOf(page)).undoLabel.startsWith('Remove flow'), `undoable: ${(await stateOf(page)).undoLabel}`);
    ok(await focusIn(page, '[data-loads=out]'), 'the keyboard focus did not fall to the page: it moved to a neighbour');
    const toast = toasts(page).filter({ hasText: 'Removed the flow' });
    ok(await toast.count() >= 1, 'a toast says what happened');
    await toast.last().locator('.toast__action', { hasText: 'Undo' }).click();
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.flows.length === 4);
    await frames(page, 4);
    eq(await rows.count(), 2, 'Undo brings it back');
    // the flow settings button opens the Flows tab on that flow
    await rows.first().getByRole('button', { name: /^Flow settings/ }).click();
    await page.locator('#panel-flows').waitFor({ state: 'visible' });
    eq((await stateOf(page)).selection, { kind: 'flow', ids: [flows[0].id] }, 'the flow is selected for editing');
    await tab(page, 'properties');
    ok((await P(page).innerText()).includes('Served by'), 'a selected flow says who serves it');
    ok((await P(page).innerText()).includes('Any fleet (AGV ×2)'), 'any fleet, with the vehicles that serve it');
    await select(page, 'station', [second.id]);

    // the other end: a workstation takes what several flows bring
    await select(page, 'station', ['s2']);
    ok(await OUT_BLOCK(page).isVisible() && await IN_BLOCK(page).isVisible(), 'a workstation has both sections');
    eq(await IN_BLOCK(page).locator('h3').innerText(), 'Where do loads come from?');
    const inRows = IN_BLOCK(page).locator('li[data-flow]');
    eq(await inRows.count(), 2, 'two flows feed the Assembly');
    eq((await inRows.first().innerText()).includes('Goods receiving'), true, 'with their origins');
    ok(await inRows.first().locator('.stepper').isVisible(), 'each says how many loads one cycle needs');
    const perCycle = inRows.first().locator('.stepper__input');
    await inRows.first().getByRole('button', { name: /^Raise the loads per cycle/ }).click();
    await frames(page, 3);
    eq((await layoutOf(page)).flows.find((f) => f.id === 'f1').perCycle, 2, 'the loads per cycle are edited inline');
    eq(await perCycle.inputValue(), '2');
    ok((await IN_BLOCK(page).innerText()).includes(`One cycle uses 2 loads from Goods receiving and 1 load from ${second.name}.`), 'the bill of materials in one sentence');
    ok((await IN_BLOCK(page).innerText()).includes('Every possible origin is connected already.'), 'nothing left to add');
    ok((await stateOf(page)).undoLabel.startsWith('Change loads per cycle of flow'));
    await snap(page, 'inspector-4-workstation-light');

    // a Goods out only receives; a depot takes part in no flow
    await select(page, 'station', ['s3']);
    eq(await OUT_BLOCK(page).count(), 0, 'a Goods out sends nothing');
    ok(await IN_BLOCK(page).isVisible(), 'it only receives');
    await select(page, 'station', ['s4']);
    eq(await OUT_BLOCK(page).count() + await IN_BLOCK(page).count(), 0, 'a depot has no flow sections');
    ok((await P(page).innerText()).includes('Parking spot for idle vehicles'), 'a short explanation instead');
    ok((await P(page).innerText()).includes('It is not part of any flow'), 'that says why');

    // the last flow out of a workstation can be removed: the section says what that means
    await select(page, 'station', ['s2']);
    const toDispatch = OUT_BLOCK(page).locator('li[data-flow="f2"]');
    await toDispatch.getByRole('button', { name: /^Remove flow/ }).click();
    await page.waitForFunction(() => !window.__logiplan.store.getState().layout.flows.some((f) => f.id === 'f2'));
    await frames(page, 4);
    const info = OUT_BLOCK(page).locator('.callout');
    ok((await info.getAttribute('class')).includes('callout--info'), 'a workstation that ends the line is a hint, not a warning');
    eq(await info.locator('.callout__title').innerText(), 'Nothing leaves this workstation');
    ok(await page.evaluate(() => document.activeElement?.closest('[data-loads=out]') !== null), 'the focus moved into the picker of the section');
    await page.keyboard.press('Control+z');
    await frames(page, 3);

    // old dead end gone: no "Connected flows" duplicate at the bottom
    eq(await P(page).locator('summary', { hasText: 'Connected flows' }).count(), 0, 'one place for the flows of a station');
    await context.close();
    noErrors('inspector');
    void starter;
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Edges: nothing to connect to yet, a storage, and no layout at all
  // ---------------------------------------------------------------------------------------------------------------
  await run('edges', async () => {
    const { page, context } = await openApp();
    await page.evaluate(async () => {
      const m = await import('/js/model/layout.js');
      const { store } = window.__logiplan;
      store.newProject(m.createLayout({ cols: 30, rows: 20 }));
      store.commit('Add a Goods in', (d) => { m.addStation(d, { type: 'source', x: 4, y: 4 }); });
    });
    await frames(page, 3);
    await tab(page, 'properties');
    await select(page, 'station', ['s1']);
    const out = OUT_BLOCK(page);
    await out.waitFor();
    eq(await out.locator('.callout__title').innerText(), 'Not connected yet', 'a lone Goods in is not connected');
    ok(await out.locator('select').isHidden(), 'there is nothing to pick yet');
    eq(await out.locator('.field__hint:visible').innerText(), 'Nothing can receive loads yet. Place a Workstation, Storage or Goods out next to the road.', 'so the section says what to place');
    await out.getByRole('button', { name: 'Workstation' }).click();
    eq((await stateOf(page)).tool, 'process', 'and the button picks the Workstation tool');
    await page.locator('[data-tool=select]').click();
    ok((await P(page).innerText()).includes('No road touches this station'), 'a station off the road says so too');

    // a storage does both: nothing leaves it (warning), nothing feeds it (a note), and the Goods in is on offer as origin
    await edit(page, 'Add a Storage', 'm.addStation(d, { type: "storage", x: 14, y: 4 });');
    await select(page, 'station', ['s2']);
    eq(await OUT_BLOCK(page).locator('.callout__title').innerText(), 'Nothing leaves this storage');
    ok((await OUT_BLOCK(page).locator('.callout').getAttribute('class')).includes('callout--warn'), 'a storage that keeps everything is a warning');
    eq(await IN_BLOCK(page).locator('.callout__title').innerText(), 'Nothing is sent here yet');
    ok((await IN_BLOCK(page).locator('.callout').getAttribute('class')).includes('callout--info'), 'an empty storage is a note');
    const [goodsIn, storage] = (await layoutOf(page)).stations;
    eq(await IN_BLOCK(page).locator('select option').allInnerTexts(), [`${goodsIn.name} (Goods in)`], 'the Goods in is the only origin');
    await IN_BLOCK(page).getByRole('button', { name: /^Connect / }).click();
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.flows.length === 1);
    await frames(page, 4);
    eq((await stateOf(page)).undoLabel, `Connect ${goodsIn.name} \u2192 ${storage.name}`, 'an undoable commit');
    eq((await stateOf(page)).selection, { kind: 'station', ids: ['s2'] }, 'the planner stays on the storage');
    const inRow = IN_BLOCK(page).locator('li[data-flow]');
    eq(await inRow.count(), 1, 'one origin');
    eq(await inRow.locator('.stepper').isVisible(), false, 'a storage takes what comes: no loads per cycle');
    ok(await focusIn(page, '[data-loads=in]'), 'the focus is on the new row (there is nothing left to add)');
    eq(await IN_BLOCK(page).locator('.field__hint:visible').innerText(), 'Every possible origin is connected already.');
    ok((await OUT_BLOCK(page).locator('.field__hint:visible').innerText()).startsWith('Nothing can receive its loads yet.'), 'and the storage has nowhere to send its loads');
    await OUT_BLOCK(page).getByRole('button', { name: 'Goods out' }).click();
    eq((await stateOf(page)).tool, 'sink', 'the button picks the Goods out tool');
    await snap(page, 'edges-1-storage-light');

    // a flow selected on the plan, a fleet, nothing: the Properties tab follows
    await select(page, 'flow', ['f1']);
    ok((await P(page).innerText()).includes('Nobody yet: there are no vehicles'), 'a flow without any vehicle says that nobody serves it');
    await page.evaluate(() => window.__logiplan.store.clearSelection());
    await frames(page, 3);
    ok(await OUT_BLOCK(page).count() === 0, 'with nothing selected the sections are gone');
    await context.close();
    noErrors('edges');
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Fleet: which jobs does this fleet serve?
  // ---------------------------------------------------------------------------------------------------------------
  await run('fleet', async () => {
    const { page, context } = await openApp();
    await pickExample(page, 'Starter');
    await placeGoodsIn(page, 3, 14);
    await edit(page, 'Connect', 'm.addFlow(d, "s5", "s2");');
    await tab(page, 'fleet');
    const card = page.locator('#panel-fleet [data-fleet=v1]');
    const jobs = card.locator('details', { has: page.locator('summary', { hasText: 'Jobs this fleet serves' }) });
    ok(await jobs.isVisible(), 'the section is on every fleet card');
    eq(await jobs.evaluate((el) => el.open), true, 'open by default: it is the model the planner has to learn');
    ok((await jobs.innerText()).includes('Vehicles are not assigned to stations.'), 'it starts with the model');
    ok((await jobs.innerText()).includes('A free vehicle takes whichever flow needs transport next'), 'in words');
    ok((await jobs.innerText()).includes('Restrict a flow to a fleet to dedicate it.'), 'and how to dedicate vehicles');
    ok((await jobs.innerText()).includes('the nearest job first'), 'quoting the strategy of the plant');
    eq(await jobs.locator('summary .section__aside').innerText(), '3 flows', 'the header counts the flows');
    eq(await jobs.locator('p[aria-live]').innerText(), '3 flows share these 2 AGVs', 'the count of flows per vehicles');
    eq(await visibleGroups(jobs), ['any fleet'], 'only the group that has flows');
    eq(await jobs.locator('li[data-flow]').count(), 3);
    const row = (id) => jobs.locator(`li[data-flow="${id}"]`);
    ok((await row('f1').innerText()).includes('Goods receiving') && (await row('f1').innerText()).includes('Assembly'), 'each flow shows from and to');
    await snap(page, 'fleet-1-any-light');

    // dedicate a flow: the switch commits, the row moves, the Flows tab follows
    const sw = row('f1').locator('input.switch__input');
    eq(await sw.isChecked(), false);
    await row('f1').locator('label.switch').click();
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.flows.find((f) => f.id === 'f1').fleetId === 'v1');
    await frames(page, 4);
    eq((await stateOf(page)).undoLabel, 'Dedicate flow “Goods receiving → Assembly” to AGV', 'one undo step with a clear label');
    eq(await visibleGroups(jobs), ['any fleet', 'only this fleet'], 'the flow moved to its own group');
    eq(await jobs.locator('h4', { hasText: 'Only this fleet' }).locator('xpath=../..').locator('li[data-flow]').evaluateAll((els) => els.map((e) => e.dataset.flow)), ['f1']);
    eq(await sw.isChecked(), true, 'the switch is on');
    eq(await jobs.locator('p[aria-live]').innerText(), '3 flows share these 2 AGVs', 'a dedicated flow still counts for this fleet');
    await tab(page, 'flows');
    const served = (id) => page.locator(`#panel-flows [data-served-by="${id}"]`);
    eq(await served('f1').innerText(), 'Served by: only AGV ×2', 'the Flows tab says only the AGVs serve it');
    eq(await served('f2').innerText(), 'Served by: any fleet (AGV ×2)', 'and the others any fleet');
    await tab(page, 'fleet');
    await page.keyboard.press('Control+z');
    await frames(page, 3);
    eq((await layoutOf(page)).flows.find((f) => f.id === 'f1').fleetId, null, 'undo releases the flow');
    eq(await visibleGroups(jobs), ['any fleet']);

    // the keyboard: Space on the switch, the focus stays on it although its row moves
    await sw.focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.flows.find((f) => f.id === 'f1').fleetId === 'v1');
    await frames(page, 4);
    ok(await page.evaluate(() => document.activeElement?.matches('li[data-flow="f1"] input.switch__input')), 'the focus stays on the switch after the row moved');
    eq(await sw.getAttribute('aria-label'), 'Only this fleet serves Goods receiving → Assembly', 'a name that says which flow');
    await page.keyboard.press('Space');
    await frames(page, 4);
    eq((await layoutOf(page)).flows.find((f) => f.id === 'f1').fleetId, null, 'Space again releases it');
    ok(await page.evaluate(() => document.activeElement?.matches('li[data-flow="f1"] input.switch__input')), 'still focused');

    // a second fleet: every open flow is served by both; a dedicated one by one
    await edit(page, 'Add forklifts', 'const f = m.addFleet(d, "forklift", { count: 1 }); f.name = "Forklift";');
    await frames(page, 3);
    const forklift = page.locator('#panel-fleet [data-fleet=v2]');
    const forkJobs = forklift.locator('details', { has: page.locator('summary', { hasText: 'Jobs this fleet serves' }) });
    eq(await forkJobs.locator('p[aria-live]').innerText(), '3 flows share this forklift', 'singular for one vehicle');
    await forkJobs.locator('li[data-flow="f2"] label.switch').click();
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.flows.find((f) => f.id === 'f2').fleetId === 'v2');
    await frames(page, 4);
    eq(await jobs.locator('li[data-flow]').count(), 2, 'the AGV card lost the flow dedicated to the forklifts');
    ok((await jobs.innerText()).includes('1 other flow is dedicated to other fleets.'), 'and says so');
    eq(await jobs.locator('p[aria-live]').innerText(), '2 flows share these 2 AGVs');
    await tab(page, 'flows');
    eq(await served('f1').innerText(), 'Served by: any fleet (AGV ×2, Forklift ×1)', 'any fleet lists every fleet with vehicles');
    eq(await served('f2').innerText(), 'Served by: only Forklift ×1');
    await snap(page, 'fleet-2-two-fleets-flows-light');

    // a flow dedicated to a fleet without vehicles: a warning in both places, and a fix
    await edit(page, 'No forklifts', 'm.updateFleet(d, "v2", { count: 0 });');
    ok(await served('f2').locator('svg').first().isVisible(), 'the flow card warns');
    ok((await served('f2').innerText()).includes('only Forklift, which has no vehicles'), 'and says what is wrong');
    ok((await served('f2').innerText()).includes('Raise the number of Forklift vehicles, or set the flow to any fleet.'), 'and what to do');
    eq(await served('f1').innerText(), 'Served by: any fleet (AGV ×2)', 'a fleet without vehicles is not named for the open flows');
    await tab(page, 'fleet');
    const warn = forklift.locator('.callout--warn');
    ok(await warn.isVisible(), 'the fleet card warns too');
    ok((await warn.innerText()).includes('dedicated to Forklift, which has no vehicles'), 'naming the flow and the fleet');
    eq(await forkJobs.locator('p[aria-live]').innerText(), 'Forklift has no vehicles yet, so it serves no flow.');
    await forklift.scrollIntoViewIfNeeded();
    await frames(page, 2);
    await snap(page, 'fleet-3-warning-light');
    await warn.getByRole('button', { name: /^Add 2 vehicles/ }).click();
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.fleets.find((f) => f.id === 'v2').count === 2);
    await frames(page, 4);
    eq(await forklift.locator('.callout--warn').count(), 0, 'the warning is gone once the fleet has vehicles');
    eq(await forkJobs.locator('p[aria-live]').innerText(), '3 flows share these 2 forklifts', 'and the line counts again');
    await edit(page, 'Release', 'm.updateFleet(d, "v2", { count: 0 });');
    await forklift.locator('.callout--warn').getByRole('button', { name: 'Set to any fleet' }).click();
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.flows.find((f) => f.id === 'f2').fleetId === null);
    await frames(page, 4);
    eq(await forklift.locator('.callout--warn').count(), 0, 'Set to any fleet frees the flow and clears the warning');
    ok((await stateOf(page)).undoLabel.startsWith('Release flow'), `undoable: ${(await stateOf(page)).undoLabel}`);

    // no vehicles anywhere: every flow says so
    await edit(page, 'No vehicles', 'm.updateFleet(d, "v1", { count: 0 });');
    await tab(page, 'flows');
    eq(await served('f1').innerText().then((t) => t.startsWith('Served by: nobody yet')), true, 'nobody can serve the flows');
    ok((await served('f1').innerText()).includes('Add vehicles in the Fleet tab.'), 'with the way out');
    await served('f1').getByRole('button', { name: 'Open Fleet tab' }).click();
    await page.locator('#panel-fleet').waitFor({ state: 'visible' });
    eq((await stateOf(page)).tab, 'fleet', 'the button opens the Fleet tab');
    const nobody = page.locator('#panel-fleet [data-fleet=v1] .callout--warn');
    ok(await nobody.isVisible(), 'the fleet card warns that nothing can carry the flows');
    eq(await nobody.locator('.callout__title').innerText(), 'No vehicle can carry your flows yet');
    ok((await nobody.innerText()).includes('3 flows are waiting for vehicles'), 'and counts them');
    eq(await jobs.locator('p[aria-live]').innerText(), 'AGV has no vehicles yet, so it serves no flow.');
    await nobody.getByRole('button', { name: /^Add 2 vehicles/ }).click();
    await page.waitForFunction(() => window.__logiplan.store.getState().layout.fleets.find((f) => f.id === 'v1').count === 2);
    await frames(page, 4);
    eq(await nobody.count(), 0, 'with vehicles the warning is gone');
    eq(await jobs.locator('p[aria-live]').innerText(), '3 flows share these 2 AGVs');
    await tab(page, 'flows');
    ok((await served('f1').innerText()).startsWith('Served by: any fleet (AGV \u00d72)'), 'and the flows are served again');
    await context.close();
    noErrors('fleet');
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Flows: the explainer, "Served by", the live numbers
  // ---------------------------------------------------------------------------------------------------------------
  await run('flows', async () => {
    const { page, context } = await openApp();
    await pickExample(page, 'Starter');
    await placeGoodsIn(page, 3, 14);
    await edit(page, 'Connect', 'm.addFlow(d, "s5", "s2");');
    await tab(page, 'flows');
    const explainer = page.locator('#panel-flows [data-explainer=vehicles]');
    ok(await explainer.isVisible(), 'the explainer is on top of the Flows tab');
    eq(await explainer.locator('summary').innerText(), 'How vehicles find work');
    eq(await explainer.locator('details').evaluate((el) => el.open), true, 'open the first time');
    const text = await explainer.locator('p').innerText();
    ok(text.includes('A flow says where loads go.'), 'what a flow is');
    ok(text.includes('every free vehicle serves every flow'), 'who serves it');
    ok(text.includes('a second Goods in only needs a flow of its own'), 'what to do for a second Goods in');
    ok(text.includes('the nearest job first'), 'how a vehicle chooses');
    ok(text.includes('dedicate vehicles'), 'and how to dedicate them');
    const top = await page.evaluate(() => {
      const panel = document.querySelector('#panel-flows [data-panel=flows]');
      const kids = [...panel.children].map((c) => c.getAttribute('data-explainer') || c.getAttribute('data-guidance') || c.className.slice(0, 20));
      return kids;
    });
    ok(top.indexOf('vehicles') <= 1, `the explainer is at the top: ${top.slice(0, 3).join(' | ')}`);
    const cards = page.locator('#panel-flows [data-flow]');
    eq(await cards.count(), 3);
    for (const id of ['f1', 'f2', 'f3']) ok((await page.locator(`#panel-flows [data-served-by="${id}"]`).innerText()).startsWith('Served by: any fleet (AGV ×2)'), `${id} says who serves it`);
    await snap(page, 'flows-1-explainer-light');

    // collapse: remembered across a reload
    await explainer.locator('summary').click();
    eq(await explainer.locator('details').evaluate((el) => el.open), false);
    await page.reload();
    await page.waitForFunction(() => document.getElementById('app')?.dataset.state === 'ready' && window.__logiplan);
    await closeDialogs(page);
    await tab(page, 'flows');
    eq(await page.locator('#panel-flows [data-explainer=vehicles] details').evaluate((el) => el.open), false, 'a closed explainer stays closed');
    await page.locator('#panel-flows [data-explainer=vehicles] summary').click();
    await page.locator('#panel-flows [data-explainer=vehicles]').getByRole('button', { name: 'More in Help' }).click();
    await page.locator('[role=dialog]').waitFor();
    eq(await page.locator('[role=dialog] [role=tab][aria-selected=true]').innerText(), 'How vehicles find work', 'More in Help opens that page');
    await closeDialogs(page);

    // while it runs: the live chips, from the cached report
    await pickExample(page, 'Starter');
    await placeGoodsIn(page, 3, 14);
    await edit(page, 'Connect', 'm.addFlow(d, "s5", "s2");');
    await tab(page, 'flows');
    ok(await page.locator('#panel-flows [data-served-by="f1"] .chip').count() === 2 && await page.locator('#panel-flows [data-served-by="f1"] .chip').first().isHidden(), 'no live numbers without a simulation');
    await page.evaluate(() => { const { runner } = window.__logiplan; runner.setSpeed(600); void runner.play(); });
    await page.waitForFunction(() => window.__logiplan.runner.time > 400, null, { timeout: 60000 });
    await frames(page, 6);
    const chips = page.locator('#panel-flows [data-served-by="f3"] .chip');
    ok(await chips.first().isVisible() && await chips.nth(1).isVisible(), 'while the simulation runs the chips show');
    ok(/^\d+ loads? waiting$/.test(await chips.first().innerText()), `loads waiting: ${await chips.first().innerText()}`);
    ok(/^\d+ delivered$/.test(await chips.nth(1).innerText()), `delivered: ${await chips.nth(1).innerText()}`);
    // the numbers are the ones of the cached report, not a fresh walk over the simulation
    await page.waitForFunction(() => window.__logiplan.runner.time > 1800, null, { timeout: 90000 });
    await frames(page, 6);
    const live = await page.evaluate(() => {
      const kpis = window.__logiplan.runner.kpis();
      const read = (id) => [...document.querySelectorAll(`#panel-flows [data-served-by="${id}"] .chip`)].map((c) => Number(c.textContent.match(/\d+/)[0]));
      return { f1: read('f1'), f3: read('f3'), report: { f1: kpis.flows.f1, f3: kpis.flows.f3 } };
    });
    ok(live.f1[1] > 0 && live.f3[1] > 0, `both flows delivered loads: ${live.f1[1]} and ${live.f3[1]}`);
    ok(live.f1[1] <= live.report.f1.delivered && live.report.f1.delivered - live.f1[1] <= 6, `the chip follows the report (${live.f1[1]} of ${live.report.f1.delivered})`);
    // cheap: reading the live numbers does not make the simulation compute its report more often than the runner does (cached, 4 Hz)
    const calls = await page.evaluate(() => new Promise((resolve) => {
      const sim = window.__logiplan.runner.sim;
      const orig = sim.stats.report.bind(sim.stats);
      let n = 0;
      sim.stats.report = (...a) => { n++; return orig(...a); };
      const t0 = performance.now();
      setTimeout(() => { sim.stats.report = orig; resolve({ n, seconds: (performance.now() - t0) / 1000 }); }, 3000);
    }));
    ok(calls.n / calls.seconds <= 6, `the Flows tab asks for the report at most about 4 times a second: ${(calls.n / calls.seconds).toFixed(1)}/s`);

    // typing while it runs: the panel updates 4 times a second and must not take the focus
    await edit(page, 'Second destination', 'm.addFlow(d, "s5", "s3");');
    await tab(page, 'properties');
    await select(page, 'station', ['s5']);
    await page.locator('#panel-properties [data-loads=out] li[data-flow] .stepper').first().waitFor({ state: 'visible' });
    const w = page.locator('#panel-properties [data-loads=out] li[data-flow] .stepper__input').first();
    await w.click();
    await page.keyboard.press('Control+a');
    for (const ch of ['4', '5']) {
      await page.keyboard.type(ch);
      await page.waitForTimeout(400);
      eq(await w.evaluate((el) => el === document.activeElement), true, `still focused after typing ${ch} while the simulation runs`);
    }
    eq(await w.inputValue(), '45', 'every key arrived');
    await tab(page, 'flows');
    // heights are stable: the chips exist, they do not come and go
    const h1 = await page.locator('#panel-flows [data-flow="f3"]').evaluate((el) => el.getBoundingClientRect().height);
    await page.waitForTimeout(1200);
    const h2 = await page.locator('#panel-flows [data-flow="f3"]').evaluate((el) => el.getBoundingClientRect().height);
    ok(Math.abs(h1 - h2) <= 1, `a flow card keeps its height while the numbers change (${h1} -> ${h2})`);
    await page.locator('#panel-flows [data-flow="f3"]').scrollIntoViewIfNeeded();
    await frames(page, 2);
    await snap(page, 'flows-2-live-light');
    await page.evaluate(() => window.__logiplan.runner.pause());
    await context.close();
    noErrors('flows');
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Help and welcome
  // ---------------------------------------------------------------------------------------------------------------
  await run('help', async () => {
    const { page, context } = await openApp({ keepWelcome: true });
    // the welcome tips rotate: one per visit, the first one about connecting a new Goods in
    const dialog = page.locator('[role=dialog]');
    await dialog.waitFor();
    const tipId = () => dialog.locator('[data-tip]').getAttribute('data-tip');
    eq(await tipId(), 'second-goods-in', 'the first visit shows the tip about a second Goods in');
    const tipBox = dialog.locator('[data-tip]');
    ok((await tipBox.innerText()).includes('Adding a second Goods in?'), 'its title');
    ok((await tipBox.innerText()).includes('Give it a flow of its own'), 'and what to do');
    ok(await tipBox.locator('xpath=ancestor::*[@role="dialog"]').count() === 1, 'it is part of the welcome dialog');
    ok(await page.evaluate(() => document.activeElement?.closest('[data-example]') !== null || document.activeElement?.textContent === 'Continue'), 'the first focus is on the way into the plant, not on the tip');
    await snap(page, 'welcome-1-tip-light');
    await tipBox.getByRole('button', { name: 'Next tip' }).click();
    eq(await tipId(), 'vehicles-not-tied', 'Next tip shows the next one');
    ok((await tipBox.innerText()).includes('Only this fleet'), 'about dedicating a fleet');
    await tipBox.getByRole('button', { name: 'Next tip' }).click();
    eq(await tipId(), 'dock', 'and the third');
    ok((await tipBox.innerText()).includes('road cell that touches the station'), 'about the dock');
    // the rest of the round: the tip about drawing straight roads with Shift comes after the dock tip, then it starts again
    const round = ['second-goods-in', 'vehicles-not-tied', 'dock'];
    for (let i = 0; i < 8; i++) {
      await tipBox.getByRole('button', { name: 'Next tip' }).click();
      const id = await tipId();
      if (id === 'second-goods-in') break;
      round.push(id);
    }
    eq(await tipId(), 'second-goods-in', 'then it starts again');
    ok(round.includes('shift-straight'), 'one of the tips is about Shift');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    const seen = [];
    for (let i = 0; i < 4; i++) {
      await page.getByRole('button', { name: 'Examples' }).first().click();
      await dialog.waitFor();
      seen.push(await tipId());
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
    }
    eq(seen, [1, 2, 3, 4].map((i) => round[i % round.length]), 'every visit shows the next tip');

    // the Help page
    await page.getByRole('button', { name: 'Help' }).first().click();
    await dialog.waitFor();
    const tabs = dialog.locator('[role=tab]');
    eq(await tabs.allInnerTexts(), ['Quick start', 'Tools & shortcuts', 'How vehicles find work', 'Trucks and dock doors', 'Statistics of an item', 'How the simulation works', 'Tips'], 'a first-class page of the Help');
    await tabs.nth(2).click();
    const help = dialog.locator('[data-help=vehicles]');
    await help.waitFor();
    const diagram = help.locator('svg[role=img]');
    ok(await diagram.isVisible(), 'the diagram is drawn');
    const box = await diagram.boundingBox();
    ok(box.width > 300 && box.height > 120, `with a real size (${Math.round(box.width)} x ${Math.round(box.height)})`);
    const svgText = await diagram.evaluate((el) => [...el.querySelectorAll('text')].map((t) => t.textContent));
    for (const word of ['Goods in 1', 'Goods in 2', 'Assembly', 'flow 1', 'flow 2', 'pickup dock', 'drop-off dock', 'One fleet serves both flows']) ok(svgText.includes(word), `the diagram shows "${word}"`);
    ok((await diagram.getAttribute('aria-label')).includes('One vehicle drives along the road and serves both flows.'), 'and has a text alternative');
    const helpText = await help.innerText();
    for (const heading of ['The loop', 'What a dock is', 'More than one Goods in', 'Dedicating vehicles', 'Priority, batch size and capacity', 'When loads pile up', 'Where to see it']) ok(helpText.includes(heading), `the page has "${heading}"`);
    for (const phrase of ['Vehicles are not assigned to stations.', 'A load appears at a Goods in', 'It drives to the pickup dock and loads.', 'It drives to the destination dock and unloads.', 'a road cell that touches a station',
      'Only this fleet', 'Urgent, then High, then Normal', 'second dock', 'bypass lane', 'Jobs']) ok(helpText.includes(phrase), `and says: ${phrase}`);
    eq(await help.locator('ol li').count(), 6, 'the loop has six steps');
    // keyboard: arrows move between the pages
    await tabs.nth(2).focus();
    await page.keyboard.press('ArrowRight');
    eq(await dialog.locator('[role=tab][aria-selected=true]').innerText(), 'Trucks and dock doors'); // the page of the warehouse module follows "How vehicles find work"
    await page.keyboard.press('ArrowLeft');
    eq(await dialog.locator('[role=tab][aria-selected=true]').innerText(), 'How vehicles find work');
    await snap(page, 'help-1-vehicles-light');
    await dialog.locator('.modal__body').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await snap(page, 'help-2-vehicles-end-light');
    // the other pages mention it too
    await tabs.nth(0).click();
    ok((await dialog.innerText()).includes('every free vehicle serves every flow'), 'the quick start says it as well');
    await tabs.nth(6).click(); // the tips page is the last of seven since the statistics page was added
    ok((await dialog.innerText()).includes('Adding a second Goods in?'), 'the tips page too');
    await closeDialogs(page);
    await context.close();
    noErrors('help');
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Light and dark, wide and narrow
  // ---------------------------------------------------------------------------------------------------------------
  await run('layout', async () => {
    async function prepare(page, narrow = false, connect = true) {
      if (narrow) { // the top bar folds Examples into a menu at this width: load the example and add the station directly
        await page.evaluate(async () => { await window.__logiplan.ctx.actions.loadExample('starter'); });
        await frames(page, 4);
        await edit(page, 'Add Goods in', 'm.addStation(d, { type: "source", x: 2, y: 9 });');
      } else {
        await pickExample(page, 'Starter');
        await placeGoodsIn(page, 3, 14);
      }
      if (connect) await connectAll(page);
    }
    async function connectAll(page) {
      await edit(page, 'Connect', 'm.addFlow(d, "s5", "s2"); m.addFlow(d, "s5", "s3"); m.updateFlow(d, "f3", { weight: 2 });');
      await edit(page, 'Forklifts', 'const f = m.addFleet(d, "forklift", { count: 1 }); f.name = "Forklift"; m.updateFlow(d, "f2", { fleetId: f.id });');
    }
    const insidePanel = (page, selector) => page.evaluate((sel) => {
      const side = document.querySelector('.side').getBoundingClientRect();
      const bad = [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > side.right + 1; });
      return bad.map((e) => `${e.tagName}.${String(e.className).slice(0, 30)}`);
    }, selector);

    for (const scheme of ['light', 'dark']) {
      const { page, context } = await openApp({ colorScheme: scheme });
      await prepare(page);
      await select(page, 'station', ['s5']);
      await tab(page, 'properties');
      await snap(page, `layout-desktop-${scheme}-1-station`);
      eq(await insidePanel(page, '#panel-properties [data-loads] *'), [], `${scheme}: the station sections stay inside the panel`);
      await select(page, 'station', ['s2']);
      await snap(page, `layout-desktop-${scheme}-2-workstation`);
      await tab(page, 'fleet');
      await snap(page, `layout-desktop-${scheme}-3-fleet`);
      eq(await insidePanel(page, '#panel-fleet [data-fleet] *'), [], `${scheme}: the fleet cards stay inside the panel`);
      await tab(page, 'flows');
      await page.evaluate(() => { const { runner } = window.__logiplan; runner.setSpeed(300); void runner.play(); });
      await page.waitForFunction(() => window.__logiplan.runner.time > 200, null, { timeout: 60000 });
      await frames(page, 6);
      await page.locator('#panel-flows [data-flow="f3"]').scrollIntoViewIfNeeded();
      await frames(page, 2);
      await snap(page, `layout-desktop-${scheme}-4-flows-live`);
      eq(await insidePanel(page, '#panel-flows [data-flow] *'), [], `${scheme}: the flow cards stay inside the panel`);
      await page.evaluate(() => window.__logiplan.runner.pause());
      await page.evaluate(() => window.__logiplan.ctx.dialogs.openHelp({ tab: 'vehicles' }));
      await page.locator('[data-help=vehicles]').waitFor();
      await snap(page, `layout-desktop-${scheme}-5-help`);
      await closeDialogs(page);
      ok(await overflow(page) <= 0, `${scheme}: no horizontal page overflow`);
      await context.close();
    }

    for (const scheme of ['light', 'dark']) {
      const { page, context } = await openApp({ viewport: NARROW, colorScheme: scheme });
      await prepare(page, true, false);
      await select(page, 'station', ['s5']);
      await page.locator('.topbar__panel-toggle').click();
      await page.locator('#panel-properties [data-loads=out]').waitFor({ state: 'visible' });
      await page.waitForTimeout(500); // the drawer slides in
      // the problem as it looks on a phone: a Goods in without a flow, the callout with its picker
      await page.locator('#panel-properties [data-loads=out]').scrollIntoViewIfNeeded();
      eq(await insidePanel(page, '#panel-properties [data-loads] *'), [], `narrow ${scheme}: the callout stays inside the drawer`);
      await snap(page, `layout-narrow-${scheme}-0-callout`);
      await connectAll(page);
      ok(await overflow(page) <= 0, `narrow ${scheme}: no horizontal page overflow`);
      eq(await insidePanel(page, '#panel-properties [data-loads] *'), [], `narrow ${scheme}: the sections stay inside the drawer`);
      await page.locator('#panel-properties [data-loads=out]').scrollIntoViewIfNeeded();
      await snap(page, `layout-narrow-${scheme}-1-station`);
      await tab(page, 'fleet');
      await page.locator('#panel-fleet [data-fleet=v1]').scrollIntoViewIfNeeded();
      await frames(page, 2);
      eq(await insidePanel(page, '#panel-fleet [data-fleet] *'), [], `narrow ${scheme}: the fleet cards stay inside the drawer`);
      await page.locator('#panel-fleet summary', { hasText: 'Jobs this fleet serves' }).first().scrollIntoViewIfNeeded();
      await snap(page, `layout-narrow-${scheme}-2-fleet`);
      await tab(page, 'flows');
      await frames(page, 2);
      eq(await insidePanel(page, '#panel-flows [data-flow] *'), [], `narrow ${scheme}: the flow cards stay inside the drawer`);
      await snap(page, `layout-narrow-${scheme}-3-flows`);
      await page.locator('#panel-flows [data-flow="f3"]').scrollIntoViewIfNeeded();
      await snap(page, `layout-narrow-${scheme}-4-flow-card`);
      // the Help at 390 px: the diagram scales, nothing sticks out
      await page.evaluate(() => window.__logiplan.ctx.dialogs.openHelp({ tab: 'vehicles' }));
      await page.locator('[data-help=vehicles]').waitFor();
      await frames(page, 2);
      const fits = await page.evaluate(() => {
        const modal = document.querySelector('[role=dialog]').getBoundingClientRect();
        const bad = [...document.querySelectorAll('[data-help=vehicles] *')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > modal.right + 1; });
        const svg = document.querySelector('[data-help=vehicles] svg').getBoundingClientRect();
        return { bad: bad.length, svgWidth: svg.width, modalWidth: modal.width };
      });
      eq(fits.bad, 0, `narrow ${scheme}: nothing in the help sticks out of the dialog`);
      ok(fits.svgWidth >= 280, `narrow ${scheme}: the diagram keeps a readable size (${Math.round(fits.svgWidth)} px)`);
      await snap(page, `layout-narrow-${scheme}-5-help`);
      await closeDialogs(page);
      ok(await overflow(page) <= 0, `narrow ${scheme}: still no horizontal page overflow`);
      await context.close();
    }
    noErrors('layout');
  });

  console.log(`guidance-panels: ${checks} checks passed`);
});
