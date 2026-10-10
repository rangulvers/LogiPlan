// Behavioural + visual check of the Fleet and Flows panels and of the dialogs in real Chromium.
// Run: node tests/e2e/panels2.mjs [section]      sections: fleet fleet-add flows flows-add flows-chain dialogs welcome help share transfer a11y shots
// Screenshots: e2e-output/panels2-*.png (open them and look). Uses the real store, the real model modules, the real panel and
// dialog code; only the shell (ctx) is faked (tests/e2e/panels2-harness.html).
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { withBrowser, OUT } from './browser.mjs';

const only = process.argv[2] || '';
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };
const near = (a, b, msg, eps = 1e-6) => ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);

await withBrowser(async ({ page, context, url, errors }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  // ---- helpers ---------------------------------------------------------------------------------------
  const P = () => page.locator('#body > .is-shown');
  const dialog = () => page.locator('[role="dialog"]');
  const topDialog = () => page.locator('[role="dialog"]').last();
  const lay = () => page.evaluate(() => structuredClone(window.harness.layout()));
  const state = () => page.evaluate(() => { const s = window.harness.store.getState(); return { selection: s.ui.selection, undoLabel: s.undoLabel, canUndo: s.canUndo, dirty: s.dirty, project: s.project.name }; });
  const undo = () => page.evaluate(() => window.harness.store.undo());
  const calls = () => page.evaluate(() => structuredClone(window.harness.calls));
  const toasts = () => page.evaluate(() => structuredClone(window.harness.toasts));
  const tab = (key) => page.evaluate((k) => window.harness.showTab(k), key);
  const reset = async (id) => { await page.evaluate((i) => window.harness.reset(i), id); await page.evaluate(() => window.harness.setSim('none')); };
  const fleetOf = async (id) => (await lay()).fleets.find((f) => f.id === id);
  const flowOf = async (id) => (await lay()).flows.find((f) => f.id === id);
  const card = (id) => P().locator(`[data-fleet="${id}"], [data-flow="${id}"]`);
  const type = async (loc, value) => { await loc.focus(); await page.keyboard.press('Control+A'); await page.keyboard.type(String(value)); };
  const edit = (fn, arg) => page.evaluate(async ([src, a]) => {
    const L = await import('/js/model/layout.js');
    window.harness.store.commit('Test edit', (d) => new Function('L', 'd', 'a', src)(L, d, a));
  }, [fn, arg]);
  const inDialog = (el) => el.evaluate((node) => !!node.closest('[role="dialog"]'));
  const focusInside = () => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
  /** No dialog is open (waits a moment: closing can follow an asynchronous step such as reading a file). */
  const noDialog = async (msg) => {
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 0, null, { timeout: 3000 }).catch(() => {});
    eq(await dialog().count(), 0, msg);
  };

  /** Close whatever dialog is open, the way a person would. */
  const closeAll = async () => {
    for (let i = 0; i < 4 && (await dialog().count()); i++) await page.keyboard.press('Escape');
  };

  const run = async (name, fn) => {
    if (only && only !== name) return;
    console.log(`-- ${name}`);
    await page.goto(url('/tests/e2e/panels2-harness.html')); // a fresh page per section: no patched prototypes or open dialogs carry over
    await page.waitForFunction(() => window.ready);
    await fn();
  };

  // ============================================================================================== FLEET
  await run('fleet', async () => {
    await tab('fleet');
    ok((await P().innerText()).includes('2 fleets · 10 vehicles'), 'fleet summary');
    eq(await P().locator('[data-fleet]').count(), 2, 'a card per fleet');
    eq(await P().locator('.empty').isVisible(), false, 'no empty state with fleets');

    // ---- the count stepper in the header: most used knob, one undo step per burst
    const forklifts = card('v1');
    const count = forklifts.getByLabel('Vehicles', { exact: true });
    eq(await count.inputValue(), '3');
    await forklifts.getByRole('button', { name: 'Increase Vehicles' }).click();
    eq((await fleetOf('v1')).count, 4, 'stepper +');
    await forklifts.getByRole('button', { name: 'Increase Vehicles' }).click();
    await forklifts.getByRole('button', { name: 'Decrease Vehicles' }).click();
    eq((await fleetOf('v1')).count, 4);
    eq((await state()).undoLabel, 'Change vehicle count of fleet “Forklifts”', 'readable undo label');
    await undo();
    eq((await fleetOf('v1')).count, 3, 'a burst of stepping is ONE undo step');
    await type(count, '12');
    eq((await fleetOf('v1')).count, 12, 'typing a count');
    await count.blur();
    await undo();
    eq((await fleetOf('v1')).count, 3, 'typing a count is one undo step');
    ok((await P().innerText()).includes('2 fleets · 10 vehicles'), 'summary back');

    // ---- golden rule: a focused field is never overwritten, the stored value shows after blur
    const speed = forklifts.getByLabel('Top speed', { exact: true });
    await type(speed, '4');
    eq((await fleetOf('v1')).speed, 4);
    ok((await forklifts.innerText()).includes('= 14.4 km/h'), 'km/h hint follows the value');
    await edit('L.updateFleet(d, "v1", { speed: 5 })');
    eq(await speed.inputValue(), '4', 'focused field is not overwritten by an external edit');
    await speed.blur();
    await page.waitForTimeout(30);
    await page.evaluate(() => window.harness.updateAll());
    eq(await speed.inputValue(), '5', 'after blur the field shows the stored value');
    await undo(); await undo();
    eq((await fleetOf('v1')).speed, 3);

    // ---- invalid input: explained, not committed
    await type(speed, '99'); // '9' is a valid speed and is applied on the way; '99' is not
    ok(await forklifts.locator('.field.is-invalid .field__error').first().isVisible(), 'out-of-range speed shows a message');
    eq((await fleetOf('v1')).speed, 9, 'the invalid text is not committed');
    await speed.blur();
    eq(await speed.inputValue(), '9', 'field reverts to the last valid value');
    await edit('L.updateFleet(d, "v1", { speed: 3 })');

    // ---- name: header follows, label is readable
    await type(forklifts.getByLabel('Fleet name'), 'Reach trucks');
    ok((await forklifts.locator('.section__header').first().innerText()).includes('Reach trucks'), 'header shows the name');
    eq((await state()).undoLabel, 'Rename fleet “Forklifts”');
    await forklifts.getByLabel('Fleet name').blur();
    await undo();
    eq((await fleetOf('v1')).name, 'Forklifts');

    // ---- vehicle type: values replaced only after a confirm when the planner changed some
    const type_ = forklifts.getByLabel('Vehicle type');
    ok((await forklifts.innerText()).includes('Changed from the standard Forklift: length and capacity'), 'says what differs from the standard');
    await type_.focus(); // a person's select has focus; Playwright's selectOption does not move it
    await type_.selectOption('agv');
    await dialog().waitFor();
    ok((await dialog().innerText()).includes('length and capacity') && (await dialog().innerText()).includes('standard AGV values'), `confirm names the changes: ${await dialog().innerText()}`);
    eq(await page.evaluate(() => document.activeElement.textContent), 'Switch type', 'the safe-looking primary button has focus (not a danger question)');
    await dialog().getByRole('button', { name: 'Cancel' }).click();
    await noDialog('cancel closes the confirm');
    eq(await type_.inputValue(), 'forklift', 'declined: the select goes back');
    eq((await fleetOf('v1')).preset, 'forklift');
    ok(await page.evaluate(() => document.activeElement.tagName === 'SELECT'), 'focus returns to the select');
    await type_.selectOption('agv');
    await dialog().waitFor();
    await dialog().getByRole('button', { name: 'Switch type' }).click();
    const agv = await fleetOf('v1');
    eq([agv.preset, agv.speed, agv.capacity, agv.length, agv.loadTime], ['agv', 1.5, 1, 1.2, 12], 'AGV values applied');
    eq((await state()).undoLabel, 'Change vehicle type of “Forklifts” to AGV');
    await undo();
    eq((await fleetOf('v1')).capacity, 2, 'undo restores the planner’s values');
    // reset button, then an unmodified fleet switches without asking
    await forklifts.getByRole('button', { name: 'Reset to standard values' }).click();
    eq([(await fleetOf('v1')).capacity, (await fleetOf('v1')).speed, (await fleetOf('v1')).length], [1, 3, 2.6], 'reset applies the standard Forklift values');
    ok(await forklifts.getByRole('button', { name: 'Reset to standard values' }).isHidden(), 'reset button hides when nothing differs');
    await type_.selectOption('tugger');
    await noDialog('an unmodified fleet switches type without a question');
    eq([(await fleetOf('v1')).preset, (await fleetOf('v1')).capacity], ['tugger', 4]);
    // custom keeps the values
    await edit('L.updateFleet(d, "v1", { speed: 2.5 })');
    await type_.selectOption('custom');
    await noDialog('switching to Custom loses nothing, so it does not ask');
    eq([(await fleetOf('v1')).preset, (await fleetOf('v1')).speed], ['custom', 2.5], 'custom keeps the planner’s values');
    ok((await forklifts.innerText()).includes('Your own vehicle'), 'custom explains itself');
    await type_.selectOption('forklift');
    await dialog().waitFor(); // custom values differ from the custom defaults -> asks
    await dialog().getByRole('button', { name: 'Cancel' }).click();
    await reset();

    // ---- colour: eight swatches, a radio group with arrow keys
    const picker = card('v1').getByRole('radiogroup', { name: 'Colour' });
    eq(await picker.getByRole('radio').count(), 8, 'eight colours (the ninth is hidden while the colour is in the palette)');
    eq(await picker.locator('[aria-checked="true"]').getAttribute('aria-label'), 'Orange', 'current colour is checked');
    await picker.getByRole('radio', { name: 'Violet' }).click();
    eq((await fleetOf('v1')).color, '#7048e8');
    ok((await card('v1').locator('.section__header .swatch').first().evaluate((el) => el.style.background)).length > 0, 'header swatch follows');
    await picker.getByRole('radio', { name: 'Violet' }).focus();
    await page.keyboard.press('ArrowRight');
    eq((await fleetOf('v1')).color, '#495057', 'arrow key moves and selects');
    await page.keyboard.press('ArrowRight');
    eq((await fleetOf('v1')).color, '#2d7ff9', 'arrow keys wrap around');
    await edit('L.updateFleet(d, "v1", { color: "#123456" })');
    eq(await picker.getByRole('radio').count(), 9, 'a colour outside the palette gets its own swatch');
    await reset();

    // ---- battery
    const agvs = card('v2');
    await agvs.locator('summary', { hasText: 'Battery' }).click();
    eq(await agvs.getByLabel('Runtime per charge').inputValue(), '2', 'runtime shown in hours');
    eq(await agvs.getByLabel('Charge time').inputValue(), '15');
    await type(agvs.getByLabel('Runtime per charge'), '3.5');
    eq((await fleetOf('v2')).battery.runtimeMin, 210, 'hours become minutes');
    await type(agvs.getByLabel('Go charging below'), '30');
    eq((await fleetOf('v2')).battery.lowPct, 30);
    ok((await agvs.innerText()).includes('A full battery lasts 3.5 h'), 'summary text');
    await type(agvs.getByLabel('Go charging below'), '95');
    await page.evaluate(() => document.activeElement.blur());
    eq((await fleetOf('v2')).battery.resumePct, 95, 'the model keeps "back to work" at least as high as "go charging"');
    await page.waitForTimeout(60); // the panel re-reads its fields a moment after focus leaves
    eq(await agvs.getByLabel('Back to work at').inputValue(), '95', 'leaving a field shows what the model made of it, without another edit');
    ok(await agvs.getByText('No depot has charging places').count() === 0, 'no warning while a depot has chargers');
    await edit('const depot = d.stations.find((s) => s.type === "depot" && s.params.chargers > 0); L.updateStation(d, depot.id, { params: { chargers: 0 } })');
    ok(await agvs.getByText('No depot has charging places').isVisible(), 'warning when the battery is on and no depot can charge');
    await agvs.getByRole('button', { name: 'Show depots' }).click();
    eq((await calls()).at(-1)[0], 'focus', 'Show depots focuses the depots');
    // switching the battery off hides its fields; the other fleet switches it on
    await agvs.locator('label.switch', { hasText: 'Model the battery' }).click();
    eq((await fleetOf('v2')).battery.enabled, false);
    eq(await agvs.getByLabel('Runtime per charge').isVisible(), false, 'fields hide while the battery model is off');
    const forks = card('v1');
    await forks.locator('summary', { hasText: 'Battery' }).click();
    await forks.locator('label.switch', { hasText: 'Model the battery' }).click();
    eq((await fleetOf('v1')).battery.enabled, true);
    ok(await forks.getByText('No depot has charging places').isVisible(), 'warning for the other fleet too');
    await reset();

    // ---- breakdowns
    const f2 = card('v2');
    await f2.locator('summary', { hasText: 'Breakdowns' }).click();
    await type(f2.getByLabel('Time between breakdowns'), '120');
    eq((await fleetOf('v2')).mtbf, 7200, 'minutes become seconds');
    ok((await f2.innerText()).includes('Also set a repair time'), 'asks for a repair time');
    await type(f2.getByLabel('Repair time'), '10');
    eq((await fleetOf('v2')).mttr, 600);
    ok((await f2.innerText()).includes('available about 92 % of the time'), `availability text: ${await f2.innerText()}`);
    ok((await f2.locator('summary', { hasText: 'Breakdowns' }).innerText()).includes('every 2 h'), 'section aside');
    await reset();

    // ---- parking
    const f1 = card('v1');
    await f1.locator('summary', { hasText: 'Parking' }).click();
    const home = f1.getByLabel('Home depot');
    eq((await home.locator('option').allInnerTexts()).length, 3, 'any depot + the two depots of the plant');
    eq(await home.inputValue(), 's2', 'home depot of the fleet');
    await home.selectOption('');
    eq((await fleetOf('v1')).home, null, 'any depot');
    await f1.getByRole('button', { name: 'Stay on road' }).click();
    eq((await fleetOf('v1')).idle, 'stay');
    eq(await f1.getByRole('button', { name: 'Stay on road' }).getAttribute('aria-pressed'), 'true');
    ok((await f1.innerText()).includes('can block the lane behind it'), 'hint explains the policy');
    await reset();

    // ---- duplicate and delete
    await card('v1').getByRole('button', { name: 'Duplicate fleet' }).click();
    eq((await lay()).fleets.map((f) => f.name), ['Forklifts', 'AGVs', 'Forklifts 2'], 'duplicate gets a numbered name');
    eq((await state()).selection, { kind: 'fleet', ids: ['v3'] }, 'the copy is selected');
    ok(await card('v3').evaluate((el) => el.classList.contains('card--selected')), 'and highlighted');
    // a copy that no flow depends on is deleted without a question, with Undo in the toast
    await card('v3').getByRole('button', { name: 'Delete fleet' }).click();
    await noDialog('no confirm when no flow is restricted to the fleet');
    eq((await lay()).fleets.length, 2);
    const toast = (await toasts()).at(-1);
    eq([toast.msg, toast.action], ['Deleted fleet “Forklifts 2”.', 'Undo']);
    await page.locator('.toast__action').click();
    eq((await lay()).fleets.length, 3, 'Undo in the toast brings the fleet back');
    await undo(); // the duplicate itself
    // a fleet with restricted flows asks first
    await card('v1').getByRole('button', { name: 'Delete fleet' }).click();
    await dialog().waitFor();
    const text = await dialog().innerText();
    ok(text.includes('2 flows are restricted') && text.includes('Goods receiving → Central warehouse') && text.includes('Final assembly → Dispatch'), `names the restricted flows: ${text}`);
    eq(await page.evaluate(() => document.activeElement.textContent), 'Cancel', 'danger question starts on Cancel');
    await dialog().getByRole('button', { name: 'Cancel' }).click();
    eq((await lay()).fleets.length, 2, 'cancel keeps the fleet');
    await card('v1').getByRole('button', { name: 'Delete fleet' }).click();
    await dialog().getByRole('button', { name: 'Delete fleet' }).click();
    const after = await lay();
    eq(after.fleets.map((f) => f.id), ['v2']);
    eq(after.flows.filter((f) => f.fleetId === null).map((f) => f.id), ['f1', 'f6'], 'flows of the deleted fleet are now served by any fleet');
    await undo();
    eq((await lay()).flows.find((f) => f.id === 'f1').fleetId, 'v1', 'undo restores the restriction');
    await reset();

    // ---- collapse
    const toggle = card('v1').locator('.section__header').first();
    eq(await toggle.getAttribute('aria-expanded'), 'true');
    await toggle.click();
    eq(await toggle.getAttribute('aria-expanded'), 'false');
    eq(await card('v1').getByLabel('Top speed', { exact: true }).isVisible(), false, 'collapsed card hides its form');
    ok(await card('v1').getByLabel('Vehicles', { exact: true }).isVisible(), 'but keeps the count in the header');
    await toggle.click();
    ok(await card('v1').getByLabel('Top speed', { exact: true }).isVisible());

    // ---- selection both ways
    await page.evaluate(() => window.harness.store.select('fleet', ['v2']));
    ok(await card('v2').evaluate((el) => el.classList.contains('card--selected')), 'selecting a fleet on the plan highlights its card');
    eq(await card('v1').evaluate((el) => el.classList.contains('card--selected')), false);
    await card('v1').getByLabel('Top speed', { exact: true }).focus();
    eq((await state()).selection, { kind: 'fleet', ids: ['v1'] }, 'working in a card selects its fleet');
    await page.evaluate(() => document.activeElement.blur());

    // ---- live status
    eq(await P().locator('[aria-label="Live status"]:visible').count(), 0, 'no status without a simulation');
    await page.evaluate(() => window.harness.setSim('stub'));
    const status = await card('v2').locator('[aria-label="Live status"]').innerText();
    ok(/\d+ working/.test(status) && /\d+ waiting/.test(status) && /\d+ idle/.test(status), `live counts: ${status}`);
    ok(/charging/.test(status) && !/out of service/.test(status), 'rare groups show only when there are some');
    const nums = (await card('v2').locator('[aria-label="Live status"] > span:not([hidden])').allInnerTexts()).map((t) => Number(t.match(/\d+/)[0]));
    eq(nums.reduce((a, b) => a + b, 0), 7, 'the groups add up to the fleet size');
    await page.evaluate(() => window.harness.setSim('none'));

    // ---- the same with the real engine: every vehicle is counted once, and the numbers move while it runs
    await page.evaluate(() => window.harness.setSim('real', 600));
    const real = async (id) => (await card(id).locator('[aria-label="Live status"] > span:not([hidden])').allInnerTexts()).map((t) => Number(t.match(/\d+/)[0])).reduce((a, b) => a + b, 0);
    eq([await real('v1'), await real('v2')], [3, 7], 'live counts of the real simulation add up to the fleet sizes');
    const before = await card('v2').locator('[aria-label="Live status"]').innerText();
    await page.evaluate(() => { window.harness.runner.sim.advance(137); window.harness.updateAll(); });
    eq([await real('v1'), await real('v2')], [3, 7], 'still complete after the simulation advanced');
    ok(before.length > 0, 'status text present');
    await edit('L.updateFleet(d, "v2", { count: 9 })'); // a structural change: the old simulation does not know the new vehicles yet
    ok(await card('v2').locator('[aria-label="Live status"]').isVisible(), 'the panel survives a layout that is ahead of the simulation');
    await page.evaluate(() => window.harness.setSim('none'));
  });

  await run('fleet-add', async () => {
    // ---- split menu
    await tab('fleet');
    const addMain = P().getByRole('button', { name: 'Add fleet' });
    const caret = P().getByRole('button', { name: 'Choose another vehicle type' });
    await addMain.click();
    eq((await lay()).fleets.at(-1).preset, 'agv', 'the main button adds an AGV fleet');
    eq((await lay()).fleets.at(-1).name, 'AGV');
    eq((await state()).undoLabel, 'Add AGV fleet');
    ok(await page.evaluate(() => document.activeElement.closest('[data-fleet="v3"]') !== null), 'focus moves to the new card');
    eq((await state()).selection, { kind: 'fleet', ids: ['v3'] });
    await caret.click();
    eq(await caret.getAttribute('aria-expanded'), 'true');
    const items = P().getByRole('menuitem');
    eq(await items.count(), 4, 'four vehicle types');
    eq(await items.allInnerTexts().then((t) => t.map((x) => x.split('\n')[0])), ['AGV', 'Forklift', 'Tugger train', 'Custom vehicle']);
    ok(await page.evaluate(() => document.activeElement.textContent.startsWith('AGV')), 'first item has focus');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    eq((await lay()).fleets.at(-1).preset, 'tugger', 'keyboard picks the tugger train');
    eq(await caret.getAttribute('aria-expanded'), 'false', 'menu closes after picking');
    await caret.focus();
    await page.keyboard.press('ArrowDown');
    ok(await P().getByRole('menu').isVisible(), 'ArrowDown opens the menu');
    await page.keyboard.press('Escape');
    eq(await P().getByRole('menu').isVisible(), false, 'Escape closes it');
    eq(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Choose another vehicle type', 'and returns focus to the arrow');
    await caret.click();
    await page.mouse.click(700, 500);
    eq(await P().getByRole('menu').isVisible(), false, 'a click elsewhere closes it');
    await caret.click();
    await P().getByRole('menuitem', { name: /Custom vehicle/ }).click();
    eq((await lay()).fleets.at(-1).preset, 'custom');

    // ---- empty state
    await page.evaluate(() => window.harness.store.commit('Remove fleets', (d) => { d.fleets.length = 0; d.flows.forEach((f) => { f.fleetId = null; }); }));
    ok(await P().locator('.empty').isVisible(), 'empty state');
    ok((await P().locator('.empty').innerText()).includes('Add your first vehicle fleet'));
    eq(await P().locator('[data-fleet]:visible').count(), 0);
    await P().locator('.empty').getByRole('button', { name: 'Forklift' }).click();
    eq((await lay()).fleets.map((f) => f.preset), ['forklift'], 'a type button in the empty state adds that fleet');
    eq(await P().locator('.empty').isVisible(), false);
  });

  // ============================================================================================== FLOWS
  await run('flows', async () => {
    await tab('flows');
    ok((await P().innerText()).includes('6 flows'), 'flow summary');
    eq(await P().locator('[data-flow]').count(), 6);
    eq(await P().locator('[data-flow] .section__header[aria-expanded="true"]').count(), 0, 'cards start collapsed when there are many');
    const head = await card('f2').innerText();
    ok(head.includes('Central warehouse') && head.includes('Press line') && head.includes('67 % of output') && head.includes('Served by: only AGVs'), `summary line: ${head}`);

    // ---- output split bar: percentages add up to 100
    const split = P().locator('[aria-label^="Central warehouse sends"]');
    eq(await split.getAttribute('aria-label'), 'Central warehouse sends: Press line 67 %, Machining 33 %');
    eq(await P().locator('.progress__bar').count(), 2);
    ok((await P().innerText()).includes('67 %') && (await P().innerText()).includes('33 %'), 'legend shows the shares');

    // ---- selecting a row selects the flow on the plan, and vice versa
    await card('f3').locator('.section__header').first().click();
    eq((await state()).selection, { kind: 'flow', ids: ['f3'] }, 'clicking a row selects the flow');
    eq(await card('f3').locator('.section__header').first().getAttribute('aria-expanded'), 'true', 'and opens it');
    ok(await card('f3').evaluate((el) => el.classList.contains('card--selected')), 'highlighted');
    await card('f3').locator('.section__header').first().click();
    eq(await card('f3').locator('.section__header').first().getAttribute('aria-expanded'), 'false', 'clicking the selected row closes it');
    await page.evaluate(() => window.harness.store.select('flow', ['f6']));
    eq(await card('f6').locator('.section__header').first().getAttribute('aria-expanded'), 'true', 'selecting on the plan opens the card');
    ok(await card('f6').evaluate((el) => { const r = el.getBoundingClientRect(); const pane = document.getElementById('body').getBoundingClientRect(); return r.top >= pane.top - 1 && r.bottom <= pane.bottom + 1; }), 'and scrolls it into view');
    eq(await card('f3').evaluate((el) => el.classList.contains('card--selected')), false, 'previous highlight is gone');

    // ---- fields of the open card
    const f6 = card('f6');
    eq(await f6.getByLabel('Loads per cycle').count(), 0, 'no "per cycle" for a flow into Goods out');
    await card('f4').locator('.section__header').first().click();
    const f4 = card('f4');
    eq(await f4.getByLabel('Loads per cycle').inputValue(), '2', 'a flow into a workstation has it');
    await type(f4.getByLabel('Loads per cycle'), '3');
    eq((await flowOf('f4')).perCycle, 3);
    eq((await state()).undoLabel, 'Change loads per cycle of flow “Press line → Final assembly”');
    await f4.getByLabel('Loads per cycle').blur();
    await undo();
    eq((await flowOf('f4')).perCycle, 2);
    await card('f2').locator('.section__header').first().click();
    const f2 = card('f2');
    await type(f2.getByLabel('Weight'), '1');
    eq((await flowOf('f2')).weight, 1);
    ok((await f2.innerText()).includes('50 % of the loads from Central warehouse go this way'), 'weight hint shows the share');
    ok((await P().locator('[aria-label^="Central warehouse sends"]').getAttribute('aria-label')).includes('Press line 50 %, Machining 50 %'), 'split bar follows');
    await f2.getByLabel('Weight').blur();
    await undo();
    await f2.getByRole('button', { name: 'Urgent' }).click();
    eq((await flowOf('f2')).priority, 3, 'priority segmented');
    eq(await f2.getByRole('button', { name: 'Urgent' }).getAttribute('aria-pressed'), 'true');
    ok((await card('f2').innerText()).includes('Urgent'), 'summary shows the priority');
    await type(f2.getByLabel('At least'), '3');
    await type(f2.getByLabel('At most'), '2');
    const f2b = await flowOf('f2');
    eq([f2b.batchMin, f2b.batchMax], [2, 2], 'a largest batch below the smallest pulls the smallest down');
    await f2.getByLabel('At most').blur();
    await type(f2.getByLabel('Longest wait for a batch'), '90');
    eq((await flowOf('f2')).maxWait, 90);
    ok((await f2.innerText()).includes('after waiting 1.5 min'), 'max wait explained');
    await f2.getByLabel('Longest wait for a batch').blur();
    const fleetSel = f2.getByLabel('Vehicles');
    eq((await fleetSel.locator('option').allInnerTexts()), ['Any fleet', 'Forklifts (3)', 'AGVs (7)']);
    await fleetSel.selectOption('v1');
    eq((await flowOf('f2')).fleetId, 'v1', 'fleet restriction');
    await fleetSel.selectOption('');
    eq((await flowOf('f2')).fleetId, null, '"Any fleet" clears it');
    await edit('L.updateFleet(d, "v1", { count: 0 })');
    await fleetSel.selectOption('v1');
    ok((await f2.innerText()).includes('Forklifts has no vehicles'), 'warns about a restricted fleet without vehicles');
    await reset();

    // ---- delete with Undo
    await card('f5').getByRole('button', { name: 'Delete flow Machining → Final assembly' }).click();
    eq((await lay()).flows.length, 5);
    eq((await toasts()).at(-1).msg, 'Deleted flow “Machining → Final assembly”.');
    await page.locator('.toast__action').click();
    eq((await lay()).flows.length, 6, 'Undo brings it back');

    // ---- renaming a station updates chips and options without a rebuild
    await edit('L.updateStation(d, "s5", { name: "Presses" })');
    ok((await card('f2').innerText()).includes('Presses'), 'chip follows the station name');
  });

  await run('flows-add', async () => {
    await tab('flows');
    const from = P().getByLabel('From', { exact: true });
    const to = P().getByLabel('To', { exact: true });
    const add = P().getByRole('button', { name: 'Add flow', exact: true });
    const fromOpts = await from.locator('option').allInnerTexts();
    eq(fromOpts, ['Goods receiving (Goods in)', 'Central warehouse (Storage)', 'Press line (Workstation)', 'Machining (Workstation)', 'Final assembly (Workstation)'], 'only stations that can send loads');
    const toOpts = await to.locator('option').allInnerTexts();
    ok(!toOpts.some((o) => o.includes('Goods receiving')) && !toOpts.some((o) => o.includes('Forklift park')), 'only stations that can receive loads, never Goods in or Depots');
    ok(toOpts.some((o) => o.includes('Dispatch')), 'Goods out is offered');

    // existing pairs are visible but disabled, with the reason in the label
    await from.selectOption('s4');
    const disabled = await to.locator('option:disabled').allInnerTexts();
    eq(disabled, ['Press line (Workstation) – already connected', 'Machining (Workstation) – already connected']);
    ok(await to.evaluate((el) => !el.selectedOptions[0].disabled), 'a free target is chosen automatically');
    eq(await to.inputValue(), 's3', 'the first free target');
    ok(await add.isEnabled());
    ok((await P().innerText()).includes('Loads leaving Central warehouse will go to Dispatch.'), 'preview sentence');
    await add.click();
    const created = (await lay()).flows.at(-1);
    eq([created.from, created.to], ['s4', 's3'], 'flow added');
    eq((await state()).undoLabel, 'Add flow “Central warehouse → Dispatch”');
    eq((await state()).selection, { kind: 'flow', ids: [created.id] }, 'new flow is selected');
    eq(await card(created.id).locator('.section__header').first().getAttribute('aria-expanded'), 'true', 'and open');
    await undo();

    // every target of a start used up: a helpful reason, button disabled
    await edit('for (const t of ["s3", "s7"]) L.addFlow(d, "s4", t);');
    await from.selectOption('s4');
    ok(await add.isDisabled(), 'button disabled');
    ok((await P().innerText()).includes('Every possible flow from Central warehouse exists already'), 'with the reason');
    await reset();

    // a sink or a depot cannot send; the only stations: a Workstation and nothing else
    await page.evaluate(async () => {
      const L = await import('/js/model/layout.js');
      window.harness.store.newProject(L.createLayout({ cols: 30, rows: 20 }));
    });
    ok(await add.isDisabled());
    ok((await P().innerText()).includes('Place a Goods in, Workstation or Storage on the plan first'), 'empty plant: says what to place');
    await edit('L.addStation(d, { type: "process", x: 2, y: 2 })');
    ok(await add.isDisabled());
    ok((await P().innerText()).includes('No other station can receive loads from Workstation 1 yet'), 'a lone workstation has no target');
    await edit('L.addStation(d, { type: "sink", x: 8, y: 2 })');
    ok(await add.isEnabled(), 'enabled once a target exists');
    await add.click();
    eq((await lay()).flows.length, 1);
    ok(await P().locator('[data-flow]').count() === 1, 'card appears');
    eq(await P().locator('[data-flow] .section__header').first().getAttribute('aria-expanded'), 'true', 'a plant with few flows opens its cards');

    // ---- empty state and the flow tool
    await undo();
    ok(await P().locator('.empty').isVisible());
    ok((await P().locator('.empty').innerText()).includes('Flows say where loads go next. Pick two stations above or use the Flow tool (F).'));
    await P().locator('.empty').getByRole('button', { name: 'Use the Flow tool' }).click();
    eq((await calls()).at(-1), ['setTool', 'flow']);
    await P().getByRole('button', { name: /Flow tool/ }).first().click();
    eq((await calls()).at(-1), ['setTool', 'flow'], 'header button too');
  });

  await run('flows-chain', async () => {
    await tab('flows');
    await edit('d.flows.length = 0');
    ok(await P().locator('.empty').isVisible());
    const chain = P().locator('details', { hasText: 'Chain stations in order' });
    await chain.locator('summary').click();
    const create = chain.getByRole('button', { name: 'Create flows' });
    ok(await create.isDisabled(), 'nothing to create yet');
    ok((await chain.innerText()).includes('Start with the station where the loads begin.'));
    // only stations that can send are offered first
    eq(await chain.locator('button.btn--sm').allInnerTexts().then((t) => t.slice(0, 5)), ['Goods receiving', 'Central warehouse', 'Press line', 'Machining', 'Final assembly']);
    await chain.getByRole('button', { name: 'Goods receiving' }).click();
    ok(await page.evaluate(() => document.activeElement.tagName === 'BUTTON'), 'focus stays on a button after picking');
    ok(await chain.getByRole('button', { name: 'Goods receiving' }).count() === 0, 'a station is offered once');
    ok(await chain.getByRole('button', { name: 'Forklift park' }).count() === 0, 'depots never');
    await chain.getByRole('button', { name: 'Central warehouse' }).click();
    await chain.getByRole('button', { name: 'Press line' }).click();
    await chain.getByRole('button', { name: 'Final assembly' }).click();
    await chain.getByRole('button', { name: 'Dispatch' }).click();
    ok((await chain.innerText()).includes('Will create 4 flows'), `preview: ${await chain.innerText()}`);
    ok(await chain.getByRole('button', { name: 'Create flows' }).isEnabled());
    // a sink ends the chain: no more stations offered
    eq(await chain.locator('button.btn--sm').allInnerTexts().then((t) => t.filter((x) => !['Create flows', 'Remove last', 'Start over'].includes(x.trim()))), [], 'nothing can follow Goods out');
    await chain.getByRole('button', { name: 'Remove last' }).click();
    ok((await chain.innerText()).includes('Will create 3 flows'));
    await chain.getByRole('button', { name: 'Dispatch' }).click();
    await chain.getByRole('button', { name: 'Create flows' }).click();
    const flows = (await lay()).flows;
    eq(flows.map((f) => `${f.from}>${f.to}`), ['s1>s4', 's4>s5', 's5>s7', 's7>s3'], 'consecutive stations are connected');
    eq((await state()).undoLabel, 'Chain 5 stations with flows');
    eq((await state()).selection.kind, 'flow');
    eq((await state()).selection.ids.length, 4, 'the new flows are selected');
    eq((await toasts()).at(-1).msg, 'Created 4 flows.');
    ok((await chain.innerText()).includes('Start with the station'), 'the helper starts over');
    await undo();
    eq((await lay()).flows.length, 0, 'one undo step for the whole chain');

    // existing flows are skipped, not duplicated
    await edit('L.addFlow(d, "s1", "s4")');
    for (const name of ['Goods receiving', 'Central warehouse', 'Machining']) await chain.getByRole('button', { name }).click();
    ok((await chain.innerText()).includes('Will create 1 flow; 1 already exists'), `skips what exists: ${await chain.innerText()}`);
    await chain.getByRole('button', { name: 'Create flows' }).click();
    eq((await lay()).flows.map((f) => `${f.from}>${f.to}`), ['s1>s4', 's4>s6']);
    await chain.getByRole('button', { name: 'Goods receiving' }).click();
    await chain.getByRole('button', { name: 'Central warehouse' }).click();
    ok(await chain.getByRole('button', { name: 'Create flows' }).isDisabled(), 'nothing new to create');
    ok((await chain.innerText()).includes('All these flows exist already'));
    await chain.getByRole('button', { name: 'Start over' }).click();
    // a station deleted while it is in the chain shortens the chain
    await chain.getByRole('button', { name: 'Press line' }).click();
    await chain.getByRole('button', { name: 'Final assembly' }).click();
    await edit('L.removeStation(d, "s7")');
    ok(!(await chain.innerText()).includes('Final assembly'), 'removed stations leave the chain');
  });

  // ============================================================================================== DIALOGS
  await run('dialogs', async () => {
    // ---- show(): aria, scroll lock, focus trap, Escape, backdrop, focus restore
    const opener = page.locator('#open-help');
    await opener.focus();
    await opener.click();
    await dialog().waitFor();
    eq(await dialog().getAttribute('aria-modal'), 'true', 'aria-modal');
    ok((await dialog().getAttribute('aria-labelledby')).length > 0, 'labelled by its title');
    eq(await page.evaluate(() => document.body.style.overflow), 'hidden', 'page scroll is locked');
    ok(await focusInside(), 'focus moved into the dialog');
    for (let i = 0; i < 14; i++) { await page.keyboard.press('Tab'); ok(await focusInside(), `Tab ${i} stays inside`); }
    for (let i = 0; i < 14; i++) { await page.keyboard.press('Shift+Tab'); ok(await focusInside(), `Shift+Tab ${i} stays inside`); }
    await page.keyboard.press('Escape');
    await noDialog('Escape closes');
    eq(await page.evaluate(() => document.activeElement.id), 'open-help', 'focus returns to the opener');
    eq(await page.evaluate(() => document.body.style.overflow), '', 'scroll lock released');

    await opener.click();
    await dialog().waitFor();
    await page.mouse.click(4, 4); // the backdrop, outside the modal
    await noDialog('click on the backdrop closes');
    eq(await page.evaluate(() => document.activeElement.id), 'open-help');
    await opener.click();
    await dialog().getByRole('button', { name: 'Close', exact: true }).first().click();
    await noDialog('close button closes');
    // a press that starts inside and ends on the backdrop must not close
    await opener.click();
    const box = await dialog().boundingBox();
    await page.mouse.move(box.x + 20, box.y + 60);
    await page.mouse.down();
    await page.mouse.move(4, 4);
    await page.mouse.up();
    eq(await dialog().count(), 1, 'drag from inside to the backdrop does not close');
    await closeAll();

    // ---- stacking: only the top dialog reacts to Escape
    await opener.click();
    await dialog().waitFor();
    await page.evaluate(() => { window.__answer = window.harness.ctx.dialogs.confirm({ title: 'Really?', text: 'Sure?', confirmLabel: 'Yes' }); });
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 2);
    ok(await topDialog().innerText().then((t) => t.includes('Really?')), 'the confirm is on top');
    await page.keyboard.press('Escape');
    eq(await dialog().count(), 1, 'Escape closed only the top dialog');
    eq(await page.evaluate(() => window.__answer), false, 'Escape answers "no"');
    ok((await dialog().innerText()).includes('Help'), 'the help dialog is still open');
    ok(await focusInside(), 'focus went back into the dialog below');
    await page.keyboard.press('Escape');
    await noDialog('second Escape closes the lower one');
    eq(await page.evaluate(() => document.body.style.overflow), '', 'scroll lock released after the whole stack closed');

    // ---- confirm
    await page.evaluate(() => { window.__answer = window.harness.ctx.dialogs.confirm({ title: 'Delete it?', text: 'This cannot be undone.', confirmLabel: 'Delete', danger: true }); });
    await dialog().waitFor();
    eq(await page.evaluate(() => document.activeElement.textContent), 'Cancel', 'danger confirm starts on Cancel');
    ok(await dialog().getByRole('button', { name: 'Delete' }).evaluate((b) => b.classList.contains('btn--danger')), 'danger style');
    await dialog().getByRole('button', { name: 'Delete' }).click();
    eq(await page.evaluate(() => window.__answer), true, 'confirm resolves true');
    await noDialog();
    await page.evaluate(() => { window.__answer = window.harness.ctx.dialogs.confirm({ title: 'Go on?', text: 'Fine?' }); });
    await dialog().waitFor();
    eq(await page.evaluate(() => document.activeElement.textContent), 'OK', 'a normal question starts on the confirm button');
    await page.keyboard.press('Enter');
    eq(await page.evaluate(() => window.__answer), true, 'Enter confirms');

    // ---- prompt
    await page.evaluate(() => { window.__answer = window.harness.ctx.dialogs.prompt({ title: 'Name the scenario', label: 'Name', value: 'B', confirmLabel: 'Rename' }); });
    await dialog().waitFor();
    eq(await page.evaluate(() => document.activeElement.tagName), 'INPUT', 'the field has focus');
    eq(await page.evaluate(() => window.getSelection().toString() || document.activeElement.value.slice(document.activeElement.selectionStart, document.activeElement.selectionEnd)), 'B', 'its text is selected');
    await page.keyboard.type('Fast layout');
    await page.keyboard.press('Enter');
    eq(await page.evaluate(() => window.__answer), 'Fast layout', 'prompt resolves with the text');
    await noDialog();
    await page.evaluate(() => { window.__answer = window.harness.ctx.dialogs.prompt({ title: 'Name', label: 'Name' }); });
    await dialog().waitFor();
    ok(await dialog().getByRole('button', { name: 'OK' }).isDisabled(), 'confirm waits for some text');
    await page.keyboard.press('Enter');
    eq(await dialog().count(), 1, 'Enter on empty text does nothing');
    await page.keyboard.press('Escape');
    eq(await page.evaluate(() => window.__answer), null, 'cancel resolves null');

    // ---- show() with custom actions: close:false and onClick returning false keep it open
    await page.evaluate(() => {
      window.__log = [];
      const body = document.createElement('p');
      body.textContent = 'Custom body';
      window.__handle = window.harness.ctx.dialogs.show({
        title: 'Custom', body, size: 'sm',
        actions: [
          { label: 'Stay', close: false, onClick: () => window.__log.push('stay') },
          { label: 'Refuse', onClick: () => { window.__log.push('refuse'); return false; } },
          { label: 'Leave', variant: 'primary', onClick: async () => { window.__log.push('leave'); } },
        ],
      });
    });
    await dialog().getByRole('button', { name: 'Stay' }).click();
    await dialog().getByRole('button', { name: 'Refuse' }).click();
    eq(await dialog().count(), 1, 'close:false and a false result keep the dialog open');
    await dialog().getByRole('button', { name: 'Leave' }).click();
    await noDialog('an async action closes when done');
    eq(await page.evaluate(() => window.__log), ['stay', 'refuse', 'leave']);
    await page.evaluate(() => {
      window.__handle2 = window.harness.ctx.dialogs.show({ title: 'Again', body: document.createElement('p') });
    });
    await page.evaluate(() => { window.__handle2.close(); window.__handle2.close(); });
    await noDialog('close() is idempotent');
  });

  // ---------------------------------------------------------------------------------------------- welcome
  await run('welcome', async () => {
    await page.evaluate(() => {
      window.__toDataURLCalls = 0;
      const original = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function patched(...args) { window.__toDataURLCalls++; return original.apply(this, args); };
    });
    await page.locator('#open-welcome').click();
    await dialog().waitFor();
    eq(await dialog().locator('.modal__title').innerText(), 'Welcome to LogiPlan');
    const text = await dialog().innerText();
    ok(text.includes('Continue where you left off') && text.includes('Two lines + warehouse'), 'a project with work offers to continue');
    eq(await dialog().locator('[data-example]').count(), 5, 'five examples: the three legacy ones and the two of the warehouse module');
    ok(text.includes('Starter: dock → assembly → shipping'), 'example names');
    ok(text.includes('4 stations · 2 flows · 2 vehicles'), 'facts line');
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"] [data-example] img').length === 5, null, { timeout: 15000 });
    const thumbs = await dialog().locator('[data-example] img').evaluateAll((imgs) => imgs.map((i) => ({ ok: i.complete && i.naturalWidth > 100, src: i.src.slice(0, 22), w: i.naturalWidth, h: i.naturalHeight })));
    ok(thumbs.every((t) => t.ok && t.src === 'data:image/png;base64,'), `previews are real PNG images: ${JSON.stringify(thumbs)}`);
    eq(await page.evaluate(() => window.__toDataURLCalls), 5, 'one throw-away render per example');
    await closeAll();
    await page.locator('#open-welcome').click();
    await dialog().waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"] [data-example] img').length === 5);
    eq(await page.evaluate(() => window.__toDataURLCalls), 5, 'previews are cached: no new render');
    await closeAll();

    // dark theme gets its own previews
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.locator('#open-welcome').click();
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"] [data-example] img').length === 5);
    eq(await page.evaluate(() => window.__toDataURLCalls), 10, 'a new theme draws new previews');
    await closeAll();
    await page.evaluate(() => { delete document.documentElement.dataset.theme; });

    await reset('starter');

    // continue closes and changes nothing
    await page.locator('#open-welcome').click();
    await dialog().getByRole('button', { name: 'Continue' }).click();
    await noDialog();
    eq((await state()).project, 'Starter plant', 'continue keeps the project');

    // pick an example: the shell action runs and the dialog closes
    await page.locator('#open-welcome').click();
    await dialog().locator('[data-example="two-lines"]').click();
    await noDialog('picking an example closes the welcome');
    eq((await calls()).at(-1), ['loadExample', 'two-lines']);
    eq((await state()).project, 'Two lines + warehouse');
    // ... unless the shell declined (unsaved work): the welcome stays
    await edit('L.setName(d, "Edited")');
    await page.locator('#open-welcome').click();
    await dialog().locator('[data-example="starter"]').click();
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 2);
    await topDialog().getByRole('button', { name: 'Cancel' }).click();
    eq(await dialog().count(), 1, 'the welcome stays when the replacement was declined');
    eq((await state()).project, 'Two lines + warehouse', 'nothing was replaced');
    await closeAll();

    // empty plant
    await reset();
    await page.locator('#open-welcome').click();
    await dialog().getByLabel('Plant name').fill('Hall 7');
    await dialog().getByRole('button', { name: 'Large' }).click();
    ok((await dialog().innerText()).includes('80 × 52 cells = 160 × 104 m'), 'the plant size in metres');
    await type(dialog().getByLabel('Metres per cell'), '3');
    ok((await dialog().innerText()).includes('80 × 52 cells = 240 × 156 m'), 'follows the scale');
    await dialog().getByRole('button', { name: 'Create empty plant' }).click();
    await noDialog();
    const empty = await lay();
    eq([empty.grid.cols, empty.grid.rows, empty.grid.cellSize, empty.stations.length, empty.name], [80, 52, 3, 0, 'Hall 7']);
    eq((await state()).project, 'Hall 7', 'the project takes the name');
    eq((await calls()).at(-1), ['fitView']);
    // a fresh empty plant has nothing to continue
    await page.locator('#open-welcome').click();
    ok(!(await dialog().innerText()).includes('Continue where you left off'), 'no continue card for an untouched plant');
    await closeAll();
    // unsaved work asks first
    await edit('L.addStation(d, { type: "source", x: 2, y: 2 })');
    await page.locator('#open-welcome').click();
    await dialog().getByRole('button', { name: 'Create empty plant' }).click();
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 2);
    await topDialog().getByRole('button', { name: 'Cancel' }).click();
    eq((await lay()).stations.length, 1, 'declined: the plant is kept');
    await dialog().getByRole('button', { name: 'Create empty plant' }).click();
    await topDialog().getByRole('button', { name: 'Start new plant' }).click();
    eq((await lay()).stations.length, 0, 'accepted: a new plant');
    await noDialog();

    // don't show again
    await page.locator('#open-welcome').click();
    const box = dialog().getByLabel('Don’t show this again');
    eq(await box.isChecked(), false);
    await box.check();
    eq(await page.evaluate(() => localStorage.getItem('logiplan:welcome-hidden')), '1', 'remembered in localStorage');
    await closeAll();
    eq(await page.evaluate(() => window.harness.ctx.dialogs.openWelcome({ auto: true })), null, 'auto-open honours it');
    await noDialog('and shows nothing');
    await page.locator('#open-welcome').click();
    await dialog().waitFor();
    ok(await dialog().getByLabel('Don’t show this again').isChecked(), 'the box shows the stored choice');
    await dialog().getByLabel('Don’t show this again').uncheck();
    eq(await page.evaluate(() => localStorage.getItem('logiplan:welcome-hidden')), null, 'forgotten again');
    await closeAll();
    await page.evaluate(() => { window.harness.ctx.dialogs.openWelcome({ auto: true }); });
    await dialog().waitFor();
    await closeAll();
    // blocked storage must not break anything
    await page.evaluate(() => { Storage.prototype.setItem = () => { throw new Error('blocked'); }; Storage.prototype.getItem = () => { throw new Error('blocked'); }; });
    await page.locator('#open-welcome').click();
    await dialog().getByLabel('Don’t show this again').check();
    eq(await dialog().count(), 1, 'a blocked localStorage is ignored');
    await closeAll();

    // a browser that cannot draw the previews still gets a complete welcome screen (icons instead of pictures)
    await page.goto(url('/tests/e2e/panels2-harness.html'));
    await page.waitForFunction(() => window.ready);
    await page.evaluate(() => { HTMLCanvasElement.prototype.toDataURL = () => { throw new Error('no canvas'); }; });
    await page.locator('#open-welcome').click();
    await dialog().waitFor();
    await page.waitForTimeout(400);
    eq(await dialog().locator('[data-example] img').count(), 0, 'no pictures when drawing fails');
    eq(await dialog().locator('[data-example] svg.icon--grid').count(), 5, 'a placeholder icon per example');
    await dialog().locator('[data-example="starter"]').click();
    await noDialog('and the examples still open');
    eq((await state()).project, 'Starter plant');
  });

  // ---------------------------------------------------------------------------------------------- help
  await run('help', async () => {
    await page.locator('#open-help').click();
    const d = dialog();
    eq(await d.locator('.modal__title').innerText(), 'Help');
    const tabs = d.getByRole('tab');
    eq(await tabs.allInnerTexts(), ['Quick start', 'Tools & shortcuts', 'How vehicles find work', 'Trucks and dock doors', 'Statistics of an item', 'How the simulation works', 'Tips']);
    eq(await tabs.first().getAttribute('aria-selected'), 'true');
    ok((await d.getByRole('tabpanel').first().innerText()).includes('Every station needs a road cell that touches it'), 'quick start content');
    // arrow keys move between tabs (automatic activation), Home and End jump
    await tabs.first().focus();
    await page.keyboard.press('ArrowRight');
    eq(await tabs.nth(1).getAttribute('aria-selected'), 'true');
    ok(await page.evaluate(() => document.activeElement.textContent === 'Tools & shortcuts'), 'focus follows');
    eq(await d.getByRole('tabpanel').count(), 1, 'one visible panel');
    const rows = await d.locator('table').first().locator('tbody tr').count();
    eq(rows, 14, 'a row for every tool');
    const keys = await d.locator('table').first().locator('tbody tr td:nth-child(2)').allInnerTexts();
    eq(keys, ['V', 'H', 'R', 'O', 'Z', 'E', '1', '2', '3', '4', '5', 'W', 'T', 'F'], 'keys come from the editor’s key table');
    ok((await d.innerText()).includes('Ctrl') && (await d.innerText()).includes('Undo'), 'other shortcuts');
    await page.keyboard.press('End');
    eq(await tabs.nth(6).getAttribute('aria-selected'), 'true'); // seven pages since the statistics page was added after the trucks page
    await page.keyboard.press('ArrowRight');
    eq(await tabs.first().getAttribute('aria-selected'), 'true', 'arrow keys wrap around');
    await page.keyboard.press('ArrowLeft');
    eq(await tabs.nth(6).getAttribute('aria-selected'), 'true');
    ok((await d.getByRole('tabpanel').innerText()).includes('side road (a bay)'), 'tips');
    await tabs.nth(2).click();
    ok((await d.getByRole('tabpanel').innerText()).includes('Vehicles are not assigned to stations.'), 'how vehicles find work');
    await tabs.nth(5).click(); // "How the simulation works" (the trucks page is nth(3), the statistics page nth(4))
    const sim = await d.getByRole('tabpanel').innerText();
    for (const word of ['dock', 'one-way', 'Junctions', 'deadlock', 'Throughput', 'Lead time', 'bottleneck', 'seed', 'battery']) ok(sim.toLowerCase().includes(word.toLowerCase()), `simulation text mentions ${word}`);
    await closeAll();
    // the shell can open a given tab
    await page.evaluate(() => { window.harness.ctx.dialogs.openHelp({ tab: 'tips' }); });
    eq(await dialog().getByRole('tab', { selected: true }).innerText(), 'Tips');
    await closeAll();
  });

  // ---------------------------------------------------------------------------------------------- share
  await run('share', async () => {
    await page.locator('#open-share').click();
    const d = dialog();
    const link = d.getByLabel('Link to this project');
    await link.waitFor();
    eq(await link.getAttribute('readonly'), '', 'read-only field');
    const value = await link.inputValue();
    const base = await page.evaluate(() => location.href.split('#')[0]);
    ok(value.startsWith(`${base}#p=`), 'the current address without its old hash plus #p=');
    ok(/^[^#]+#p=[zp]\.[\w-]+$/.test(value), 'URL-safe payload');
    ok((await d.innerText()).includes(`The link is ${value.length.toLocaleString('en-US')} characters long.`), 'length is shown');
    ok(await d.getByText('This link is very long').count() === 0, 'a short link has no warning');
    ok(await page.evaluate(() => document.activeElement.id !== '' || document.activeElement.tagName === 'INPUT'), 'the link is focused and selected for copying');
    // round trip: opening the link gives back the very same plant
    const same = await page.evaluate(async (v) => {
      const { decodeShare } = await import('/js/model/serialize.js');
      const project = await decodeShare(v);
      const state = window.harness.store.getState();
      return JSON.stringify(project.scenarios[0].layout) === JSON.stringify(state.layout) && project.name === state.project.name;
    }, value);
    ok(same, 'decoding the link returns the same layout');
    // copy
    await edit('L.setName(d, "Edited")');
    eq((await state()).dirty, true);
    await d.getByRole('button', { name: 'Copy link' }).click();
    await d.getByText('Link copied.').waitFor();
    eq(await page.evaluate(() => navigator.clipboard.readText()), value, 'the clipboard holds the link');
    eq((await state()).dirty, false, 'sharing counts as saving');
    // fallback when the async clipboard is refused
    await page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('denied')); });
    await d.getByRole('button', { name: 'Copy link' }).click();
    await page.waitForFunction(() => /Link copied|Press Ctrl\+C/.test(document.querySelector('[role="dialog"]').innerText));
    // download instead
    await edit('L.setName(d, "Edited again")');
    const [download] = await Promise.all([page.waitForEvent('download'), d.getByRole('button', { name: 'Download project file' }).click()]);
    eq(download.suggestedFilename(), 'two-lines-warehouse.logiplan.json');
    eq(await dialog().count(), 1, 'downloading keeps the dialog open');
    eq((await state()).dirty, false, 'a downloaded file counts as saved');
    await d.getByRole('button', { name: 'Done' }).click();
    await noDialog();
    eq(await page.evaluate(() => document.activeElement.id), 'open-share', 'focus returns to the Share button');

    // a very long link warns and offers the file
    await page.evaluate(async () => {
      const L = await import('/js/model/layout.js');
      const layout = L.createLayout({ cols: 160, rows: 160, cellSize: 2 });
      let seed = 12345;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
      for (let stroke = 0; stroke < 120; stroke++) {
        let x = Math.floor(rnd() * 160);
        let y = Math.floor(rnd() * 160);
        const cells = [[x, y]];
        for (let i = 0; i < 160; i++) {
          const dir = Math.floor(rnd() * 4);
          x = Math.min(159, Math.max(0, x + [0, 1, 0, -1][dir]));
          y = Math.min(159, Math.max(0, y + [-1, 0, 1, 0][dir]));
          cells.push([x, y]);
        }
        L.paintRoadPath(layout, cells.filter((c, i) => i === 0 || Math.abs(c[0] - cells[i - 1][0]) + Math.abs(c[1] - cells[i - 1][1]) === 1), { oneWay: rnd() < 0.5 });
      }
      window.harness.store.newProject(layout);
    });
    await page.locator('#open-share').click();
    await dialog().getByText('This link is very long').waitFor();
    const long = await dialog().getByLabel('Link to this project').inputValue();
    ok(long.length > 8000, `the link is long: ${long.length}`);
    ok((await dialog().innerText()).includes('Download the project file and send that instead'), 'suggests the file');
    ok(await dialog().getByRole('button', { name: 'Download project file' }).isVisible());
  });

  // ---------------------------------------------------------------------------------------------- import / export
  await run('transfer', async () => {
    const exported = await page.evaluate(async () => {
      const { exportProject } = await import('/js/model/serialize.js');
      return exportProject(window.harness.store.getState().project);
    });
    const other = await page.evaluate(async () => {
      const { exportProject } = await import('/js/model/serialize.js');
      const { EXAMPLES } = await import('/js/model/examples.js');
      const L = EXAMPLES.find((e) => e.id === 'congestion-lab').build();
      return exportProject({ name: 'Imported lab', activeId: 'a', scenarios: [{ id: 'a', name: 'A', layout: L }, { id: 'b', name: 'B', layout: L }] });
    });
    const file = (name, text, mimeType = 'application/json') => ({ name, mimeType, buffer: Buffer.from(text) });

    await page.locator('#open-importExport').click();
    const d = dialog();
    eq(await d.locator('.modal__title').innerText(), 'Import and export');
    ok((await d.innerText()).includes('“Two lines + warehouse” with 1 scenario'), 'export summary');

    // ---- export
    await edit('L.setName(d, "Changed")');
    eq((await state()).dirty, true);
    const [download] = await Promise.all([page.waitForEvent('download'), d.getByRole('button', { name: 'Download project file' }).click()]);
    eq(download.suggestedFilename(), 'two-lines-warehouse.logiplan.json');
    const saved = readFileSync(await download.path(), 'utf8');
    const savedProject = JSON.parse(saved);
    eq([savedProject.app, savedProject.name, savedProject.scenarios.length, savedProject.scenarios[0].layout.name], ['logiplan', 'Two lines + warehouse', 1, 'Changed'], 'the file holds the current project');
    eq((await state()).dirty, false, 'exporting marks the project as saved');
    eq(JSON.parse(exported).scenarios[0].layout.stations.length, savedProject.scenarios[0].layout.stations.length);

    // ---- friendly errors, shown inline, dialog stays open
    const input = d.locator('input[type="file"]');
    await input.setInputFiles(file('notes.txt', 'just some words', 'text/plain'));
    await d.getByText('This does not look like a LogiPlan project file or share link').waitFor();
    eq(await dialog().count(), 1, 'an unreadable file keeps the dialog open');
    await input.setInputFiles(file('broken.json', '{ "stations": [ oops'));
    await d.getByText('This file is not valid JSON').waitFor();
    await input.setInputFiles(file('other.json', '{"hello": "world"}'));
    await d.getByText('does not look like a LogiPlan project or layout').waitFor();
    eq((await state()).project, 'Two lines + warehouse', 'nothing was replaced by the failed attempts');
    await d.getByRole('button', { name: 'Open pasted text' }).click();
    await d.getByText('There is nothing to open yet').waitFor();

    // ---- unsaved work: confirm first; declining keeps everything
    await edit('L.setName(d, "Unsaved")');
    await input.setInputFiles(file('lab.json', other));
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length === 2);
    ok((await topDialog().innerText()).includes('replaces the project you are working on'), 'asks before replacing unsaved work');
    await topDialog().getByRole('button', { name: 'Cancel' }).click();
    eq((await state()).project, 'Two lines + warehouse');
    eq(await dialog().count(), 1, 'declining keeps the import dialog');
    await input.setInputFiles(file('lab.json', other));
    await topDialog().getByRole('button', { name: 'Open project' }).click();
    await noDialog('opening closes the dialog');
    const lab = await page.evaluate(() => { const s = window.harness.store.getState(); return { name: s.project.name, scenarios: s.project.scenarios.length, dirty: s.dirty, layout: s.layout.name }; });
    eq(lab, { name: 'Imported lab', scenarios: 2, dirty: false, layout: 'Congestion lab' }, 'the file replaced the project');
    eq((await calls()).at(-1), ['fitView'], 'the view is fitted');
    eq((await toasts()).at(-1).msg, 'Opened “Imported lab” with 2 scenarios.');
    eq(await page.evaluate(() => document.activeElement.id), 'open-importExport', 'focus returns to the opener');

    // ---- clean project: no question; pasted text and pasted links
    await page.locator('#open-importExport').click();
    await dialog().getByLabel('Or paste the project text or a share link').fill(exported);
    await dialog().getByRole('button', { name: 'Open pasted text' }).click();
    await noDialog('a clean project is replaced without asking');
    eq((await state()).project, 'Two lines + warehouse', 'pasted JSON opens');
    const link = await page.evaluate(async () => {
      const { shareUrl } = await import('/js/model/serialize.js');
      const { EXAMPLES } = await import('/js/model/examples.js');
      return shareUrl('https://example.test/app/', { name: 'Linked', activeId: 'a', scenarios: [{ id: 'a', name: 'A', layout: EXAMPLES[0].build() }] });
    });
    await page.locator('#open-importExport').click();
    await dialog().getByLabel('Or paste the project text or a share link').fill(`Here you go: ${link} (valid for ever)`);
    await dialog().getByRole('button', { name: 'Open pasted text' }).click();
    await noDialog();
    eq((await state()).project, 'Linked', 'a pasted share link opens');
    await page.locator('#open-importExport').click();
    await dialog().getByLabel('Or paste the project text or a share link').fill('https://example.test/app/#p=z.%%%broken');
    await dialog().getByRole('button', { name: 'Open pasted text' }).click();
    await dialog().getByText('damaged').waitFor();
    // a newer format opens with a warning toast
    const newer = JSON.stringify({ ...JSON.parse(exported), schema: 99, scenarios: JSON.parse(exported).scenarios.map((s) => ({ ...s, layout: { ...s.layout, schema: 99 } })) });
    await dialog().locator('input[type="file"]').setInputFiles(file('future.json', newer));
    await noDialog();
    ok((await toasts()).some((t) => t.kind === 'warn' && t.msg.includes('newer version')), 'warnings of importProject reach the planner');

    // ---- drag and drop
    await page.locator('#open-importExport').click();
    const zone = dialog().getByText('Drop a project file here').locator('xpath=..');
    await zone.evaluate((el, text) => {
      const data = new DataTransfer();
      data.items.add(new File([text], 'dropped.json', { type: 'application/json' }));
      el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
    }, other);
    await noDialog('a dropped file opens');
    eq((await state()).project, 'Imported lab', 'drag and drop works');
    await page.locator('#open-importExport').click();
    const highlighted = await dialog().getByText('Drop a project file here').locator('xpath=..').evaluate((el) => {
      el.dispatchEvent(new DragEvent('dragover', { dataTransfer: new DataTransfer(), bubbles: true, cancelable: true }));
      return el.style.borderColor;
    });
    ok(highlighted.includes('--accent') || highlighted.includes('var('), `drop zone highlights while dragging: ${highlighted}`);
    await closeAll();
  });

  // ============================================================================================== ACCESSIBILITY
  /** Interactive elements without an accessible name, duplicate ids and broken id references inside `root`. */
  const audit = (selector) => page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const visible = (el) => el.getClientRects().length > 0;
    const nameOf = (el) => {
      const labelled = el.getAttribute('aria-labelledby');
      const byRef = labelled ? labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ') : '';
      const byLabel = el.labels ? [...el.labels].map((l) => l.textContent).join(' ') : '';
      return (el.getAttribute('aria-label') || byRef || byLabel || el.textContent || el.getAttribute('title') || '').trim();
    };
    const controls = [...root.querySelectorAll('button, input, select, textarea, a[href], [role="radio"], [role="tab"], [role="menuitem"]')].filter(visible);
    const unnamed = controls.filter((el) => !nameOf(el)).map((el) => el.outerHTML.slice(0, 140));
    const positive = controls.filter((el) => el.tabIndex > 0).map((el) => el.outerHTML.slice(0, 80));
    const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    const refs = [...root.querySelectorAll('[aria-controls], [aria-labelledby], [for]')].flatMap((el) => ['aria-controls', 'aria-labelledby', 'for'].map((a) => el.getAttribute(a)).filter(Boolean).flatMap((v) => v.split(/\s+/)));
    const dangling = refs.filter((id) => !document.getElementById(id));
    const imagesWithoutAlt = [...root.querySelectorAll('img:not([alt])')].length;
    return { count: controls.length, unnamed, positive, duplicates, dangling, imagesWithoutAlt };
  }, selector);
  const clean = (r, what) => {
    ok(r.count > 10, `${what}: audited ${r.count} controls`);
    eq(r.unnamed, [], `${what}: every control has a name`);
    eq(r.positive, [], `${what}: no positive tabindex`);
    eq(r.duplicates, [], `${what}: no duplicate ids`);
    eq(r.dangling, [], `${what}: every id reference resolves`);
    eq(r.imagesWithoutAlt, 0, `${what}: images have alt text`);
  };

  await run('a11y', async () => {
    await tab('fleet');
    await page.evaluate(() => {
      for (const d of document.querySelectorAll('[data-panel=fleet] details')) d.open = true;
      window.harness.setSim('stub');
    });
    clean(await audit('[data-panel=fleet]'), 'fleet panel');
    await P().getByRole('button', { name: 'Choose another vehicle type' }).click();
    clean(await audit('[data-panel=fleet]'), 'fleet panel with the vehicle menu open');
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.harness.store.commit('x', (d) => { d.fleets.length = 0; d.flows.forEach((f) => { f.fleetId = null; }); }));
    ok((await audit('[data-panel=fleet]')).unnamed.length === 0, 'fleet empty state is labelled');
    await page.evaluate(() => window.harness.reset());
    await tab('flows');
    await page.evaluate(() => {
      for (const c of document.querySelectorAll('[data-panel=flows] [data-flow] .section__header[aria-expanded=false]')) c.click();
      for (const d of document.querySelectorAll('[data-panel=flows] details')) d.open = true;
    });
    clean(await audit('[data-panel=flows]'), 'flows panel');
    for (const name of ['welcome', 'help', 'share', 'importExport']) {
      await page.locator(`#open-${name}`).click();
      if (name === 'welcome') await page.waitForFunction(() => document.querySelectorAll('[role="dialog"] [data-example] img').length === 5);
      if (name === 'share') await page.getByLabel('Link to this project').waitFor();
      if (name === 'help') {
        for (const label of ['Tools & shortcuts', 'How the simulation works', 'Tips']) {
          await dialog().getByRole('tab', { name: label }).click();
          eq((await audit('[role="dialog"]')).unnamed, [], `help tab ${label}: every control has a name`);
        }
      }
      const r = await audit('[role="dialog"]');
      eq(r.unnamed, [], `${name} dialog: every control has a name`);
      eq(r.duplicates, [], `${name} dialog: no duplicate ids`);
      eq(r.dangling, [], `${name} dialog: every id reference resolves`);
      eq(r.imagesWithoutAlt, 0, `${name} dialog: images have alt text`);
      await closeAll();
    }
  });

  // ============================================================================================== SCREENSHOTS
  await run('shots', async () => {
    const shotPane = async (name, theme, size) => {
      await page.evaluate(() => { document.getElementById('toasts').replaceChildren(); document.body.classList.add('tall'); });
      await page.locator('#pane').screenshot({ path: path.join(OUT, `panels2-${name}-${theme}${size === 'narrow' ? '-narrow' : ''}.png`) });
      await page.evaluate(() => document.body.classList.remove('tall'));
    };
    const shotPage = (name, theme, size) => page.screenshot({ path: path.join(OUT, `panels2-${name}-${theme}${size === 'narrow' ? '-narrow' : ''}.png`) });
    const setup = async (theme, size) => {
      await page.setViewportSize(size === 'narrow' ? { width: 390, height: 800 } : { width: 1440, height: 900 });
      await page.goto(url(`/tests/e2e/panels2-harness.html?theme=${theme}${size === 'narrow' ? '&narrow=1' : ''}`));
      await page.waitForFunction(() => window.ready);
    };
    for (const size of ['desktop', 'narrow']) {
      for (const theme of ['light', 'dark']) {
        await setup(theme, size);
        // fleet panel: live counts, a collapsed card, the battery warning
        await page.evaluate(() => { window.harness.setSim('stub'); window.harness.store.select('fleet', ['v2']); });
        await page.evaluate(async () => {
          const f = document.querySelector('[data-fleet="v2"]');
          for (const title of ['Battery', 'Breakdowns']) [...f.querySelectorAll('summary')].find((s) => s.textContent.includes(title)).click();
        });
        await shotPane('fleet', theme, size);
        await page.evaluate(() => window.harness.setSim('none'));
        // fleet empty state
        await page.evaluate(() => window.harness.store.commit('x', (d) => { d.fleets.length = 0; d.flows.forEach((f) => { f.fleetId = null; }); }));
        await shotPane('fleet-empty', theme, size);
        // flows
        await page.evaluate(() => { window.harness.reset(); window.harness.showTab('flows'); window.harness.store.select('flow', ['f2']); });
        await shotPane('flows', theme, size);
        await page.evaluate(() => { document.querySelector('[data-panel=flows] details.section summary').scrollIntoView(); });
        await page.evaluate(async () => {
          const chain = [...document.querySelectorAll('[data-panel=flows] details')].find((d) => d.textContent.includes('Chain stations in order'));
          chain.open = true;
          for (const name of ['Goods receiving', 'Central warehouse', 'Press line']) [...chain.querySelectorAll('button')].find((b) => b.textContent.trim() === name).click();
        });
        await shotPane('flows-chain', theme, size);
        await page.evaluate(() => { window.harness.store.commit('x', (d) => { d.flows.length = 0; }); });
        await shotPane('flows-empty', theme, size);
        await page.evaluate(() => window.harness.reset());
        // dialogs
        for (const name of ['welcome', 'help', 'share', 'importExport']) {
          await page.evaluate(() => window.harness.showTab('fleet'));
          await page.locator(`#open-${name}`).evaluate((b) => b.click());
          if (name === 'welcome') await page.waitForFunction(() => document.querySelectorAll('[role="dialog"] [data-example] img').length === 5, null, { timeout: 15000 });
          if (name === 'share') await page.getByLabel('Link to this project').waitFor();
          await page.waitForTimeout(250);
          await shotPage(`dialog-${name}`, theme, size);
          if (name === 'help') {
            for (const [i, label] of ['Tools & shortcuts', 'How the simulation works', 'Tips'].entries()) {
              await dialog().getByRole('tab', { name: label }).click();
              await shotPage(`dialog-help-${i + 2}`, theme, size);
            }
          }
          await closeAll();
        }
        await page.evaluate(() => { window.harness.ctx.dialogs.confirm({ title: 'Delete fleet “Forklifts”?', text: '2 flows are restricted to this fleet (Goods receiving → Central warehouse, Final assembly → Dispatch). After deleting it, any other fleet may serve those flows. You can undo this afterwards.', confirmLabel: 'Delete fleet', danger: true }); });
        await page.waitForTimeout(250);
        await shotPage('dialog-confirm', theme, size);
        await closeAll();
      }
    }
  });

  eq(errors, [], 'no console errors or warnings');
  console.log(`panels2: ${checks} checks passed`);
});
