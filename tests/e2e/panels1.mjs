// Behavioural + visual check of the Properties, What-if (simulate) and Checks panels in real Chromium.
// Run: node tests/e2e/panels1.mjs      Screenshots: e2e-output/panels1-*.png (open them and look).
// Uses the real store, the real model/validate/graph modules and the real panel code; only the shell (ctx) is faked.
import assert from 'node:assert/strict';
import path from 'node:path';
import { withBrowser, OUT } from './browser.mjs';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

await withBrowser(async ({ page, url, errors }) => {
  await page.goto(url('/tests/e2e/panels1-harness.html'));
  await page.waitForFunction(() => window.ready);

  // ---- helpers ---------------------------------------------------------------------------------------
  const P = () => page.locator('#body > .is-shown');
  const label = (text) => P().getByLabel(text, { exact: true });
  const button = (name) => P().getByRole('button', { name, exact: true });
  const lay = () => page.evaluate(() => structuredClone(window.harness.layout()));
  const state = () => page.evaluate(() => { const s = window.harness.store.getState(); return { selection: s.ui.selection, undoLabel: s.undoLabel, canUndo: s.canUndo }; });
  const select = (kind, ids) => page.evaluate(([k, i]) => window.harness.store.select(k, i), [kind, ids]);
  const undo = () => page.evaluate(() => window.harness.store.undo());
  const calls = () => page.evaluate(() => structuredClone(window.harness.calls));
  const toasts = () => page.evaluate(() => structuredClone(window.harness.toasts));
  const tab = (key) => page.evaluate((k) => window.harness.showTab(k), key);
  const station = async (id) => (await lay()).stations.find((s) => s.id === id);
  const reset = () => page.evaluate(() => window.harness.reset());
  const text = async () => (await P().innerText()).replace(/\s+/g, ' ');
  const shot = async (name, theme = 'light') => {
    await page.evaluate(() => { document.getElementById('toasts').replaceChildren(); document.body.classList.add('tall'); });
    await page.locator('#pane').screenshot({ path: path.join(OUT, `panels1-${name}-${theme}.png`) });
    await page.evaluate(() => document.body.classList.remove('tall'));
  };
  const edit = async (fn, arg) => { await page.evaluate(async ([src, a]) => { const L = await import('/js/model/layout.js'); window.harness.store.commit('Test edit', (d) => new Function('L', 'd', 'a', src)(L, d, a)); }, [fn, arg]); };
  const freeSpot = (w, h) => page.evaluate(async ([ww, hh]) => {
    const L = await import('/js/model/layout.js');
    const layout = window.harness.layout();
    for (let y = 1; y < layout.grid.rows - hh - 1; y++) {
      for (let x = 1; x < layout.grid.cols - ww - 1; x++) if (L.isRectFree(layout, { x: x - 1, y: y - 1, w: ww + 2, h: hh + 2 })) return { x, y };
    }
    return null;
  }, [w, h]);
  /** Type into a (number/text) field like a person: select all, type, no blur. */
  const type = async (loc, value) => { await loc.focus(); await page.keyboard.press('Control+A'); await page.keyboard.type(String(value)); };

  // ============================================================================================ PLANT SETTINGS
  const original = await lay();
  ok(/plant settings/i.test(await text()), 'nothing selected shows the plant settings');
  ok((await text()).includes('3 Workstations') && (await text()).includes('1 Goods in'), 'summary counts stations by type');
  ok((await text()).includes('112 × 66 m = 7,392 m²'), 'floor area from grid and scale');
  ok((await text()).includes('10 in 2 fleets'), 'vehicle summary');
  await shot('plant');

  await button('Fit view').click();
  eq((await calls()).at(-1), ['fitView'], 'Fit view calls ctx.actions.fitView');

  // rename: the plant name is the project name of the top bar (not an undo step); the field is never overwritten while focused
  const projectName = () => page.evaluate(() => window.harness.store.getState().project.name);
  const name = label('Plant name');
  await type(name, 'Factory North');
  eq(await projectName(), 'Factory North', 'typing the plant name renames the project');
  eq((await state()).undoLabel, null, 'a project rename is not an undo step');
  await page.evaluate(() => window.harness.store.renameProject('Changed elsewhere'));
  eq(await name.inputValue(), 'Factory North', 'focused field is not overwritten by a store update');
  ok(await name.evaluate((el) => el === document.activeElement), 'focus kept');
  await name.blur();
  await page.waitForTimeout(30);
  eq(await name.inputValue(), 'Changed elsewhere', 'after blur the field shows the stored value');
  await type(name, '   ');
  await name.blur();
  await page.waitForTimeout(30);
  eq(await projectName(), 'Changed elsewhere', 'an empty name is refused and the stored name comes back');
  eq(await name.inputValue(), 'Changed elsewhere', 'the field shows it again');
  await page.evaluate((n) => window.harness.store.renameProject(n), original.name);

  // the Stations list: a button per station selects it and brings it into view (the keyboard way to pick a station)
  const stationButtons = P().locator('button[data-station]');
  const typeWord = { source: 'Goods in', process: 'Workstation', storage: 'Storage', sink: 'Goods out', depot: 'Depot' };
  eq(await stationButtons.count(), original.stations.length, 'every station of a small plant is listed');
  eq(await P().locator('button[data-role=more]').count(), 0, 'with no "Show all" button');
  const first = original.stations[0];
  await P().getByRole('button', { name: `Select ${first.name} (${typeWord[first.type]})` }).click();
  eq((await calls()).at(-1), ['focus', { stationIds: [first.id] }], 'a press on a station asks the shell to select and show it');
  await page.evaluate(() => window.harness.store.clearSelection()); // the harness's focus() selects, which swaps the form
  for (let i = 0; i < 6; i++) await edit("L.addStation(d, { type: 'storage', x: a.x, y: a.y, w: 2, h: 2 })", await freeSpot(2, 2));
  eq(await stationButtons.count(), 12, 'a big plant lists the first twelve stations');
  eq(await P().locator('button[data-role=more]').innerText(), `Show all ${original.stations.length + 6} stations`, 'with a button for the rest');
  await P().locator('button[data-role=more]').click();
  eq(await stationButtons.count(), original.stations.length + 6, 'Show all lists every station');
  ok(await P().locator('button[data-role=more]').evaluate((el) => el === document.activeElement), 'and the button keeps the keyboard focus');
  await P().locator('button[data-role=more]').click();
  eq(await stationButtons.count(), 12, 'Show fewer folds the list again');
  for (let i = 0; i < 6; i++) await undo();
  eq(await stationButtons.count(), original.stations.length, 'undo takes the new stations out of the list');

  // notes
  await type(label('Notes'), 'Check crane capacity.');
  ok((await lay()).notes === 'Check crane capacity.', 'notes edit');
  await undo();

  // scale (live) and its effect on the summary
  await type(label('Metres per cell'), '2.5');
  eq((await lay()).grid.cellSize, 2.5);
  ok((await text()).includes('140 × 82.5 m'), 'summary follows the scale');
  await undo();
  eq((await lay()).grid.cellSize, 2);

  // lane side
  await button('Left-hand traffic').click();
  eq((await lay()).settings.handedness, 'left');
  eq((await button('Left-hand traffic').getAttribute('aria-pressed')), 'true');
  await undo();
  eq((await button('Right-hand traffic').getAttribute('aria-pressed')), 'true', 'undo is reflected in the control');

  // grid: invalid input is explained and not committed
  const cols = label('Columns');
  await type(cols, '5');
  ok(await P().locator('.field.is-invalid .field__error').first().isVisible(), 'invalid grid width shows a message');
  ok((await P().locator('.field.is-invalid .field__error').first().innerText()).includes('between 8 and 160'));
  await cols.press('Enter');
  eq((await lay()).grid.cols, 56, 'invalid width is not applied');
  await cols.blur();
  eq(await cols.inputValue(), '56', 'field reverts');

  // grid: growing needs no confirmation
  await type(cols, '60'); await cols.press('Enter');
  await page.waitForTimeout(30);
  eq((await lay()).grid.cols, 60);
  eq(await page.evaluate(() => window.harness.confirms.length), 0, 'growing the plant does not ask');
  await undo();

  // grid: shrinking removes things -> confirmation with the number of removed things; cancel keeps everything
  await page.evaluate(() => { window.harness.confirmAnswer = false; });
  await type(cols, '30'); await cols.press('Enter');
  await page.waitForTimeout(50);
  const asked = await page.evaluate(() => structuredClone(window.harness.confirms));
  eq(asked.length, 1, 'shrinking asks once');
  ok(/removes .*road cells?/.test(asked[0].text) && asked[0].danger === true, `confirm text names the loss: ${asked[0].text}`);
  eq((await lay()), original, 'cancel changes nothing');
  eq(await cols.inputValue(), '56', 'cancel restores the field');
  // ... and accepting applies it as one undoable step
  await page.evaluate(() => { window.harness.confirmAnswer = true; });
  await type(cols, '30'); await cols.press('Enter');
  await page.waitForTimeout(50);
  eq((await lay()).grid.cols, 30, 'accepted');
  ok((await lay()).stations.length < original.stations.length, 'content outside the grid is gone');
  eq((await state()).undoLabel, 'Resize plant to 30 × 33');
  await undo();
  eq(await lay(), original, 'undo brings everything back');

  // ============================================================================================ STATIONS
  // ---- source
  await select('station', ['s1']);
  ok((await text()).includes('Goods in') && (await P().locator('.chip--source .swatch').count()) === 1, 'type chip with swatch');
  ok(await P().locator('.chip--source svg').count() === 1, 'type chip with icon');
  eq(await label('Name').inputValue(), 'Goods receiving');
  await type(label('Loads per arrival'), '3');
  eq((await station('s1')).params.batch, 3);
  eq((await state()).undoLabel, 'Change loads per arrival of “Goods receiving”');
  await undo();
  eq((await station('s1')).params.batch, 1, 'undo restores the parameter');
  await type(label('Output buffer slots per destination'), '9');
  eq((await station('s1')).params.outCap, 9);
  await type(label('Start delay'), '30');
  eq((await station('s1')).params.startDelay, 30);
  await label('Variation').selectOption('exp');
  eq((await station('s1')).params.interArrival.kind, 'exp', 'arrival pattern via distField');
  await type(label('Average'), '90');
  eq((await station('s1')).params.interArrival.mean, 90);
  // invalid: zero loads per arrival
  await type(label('Loads per arrival'), '0');
  ok((await P().locator('.field.is-invalid .field__error').first().innerText()).includes('between 1 and 100'), 'invalid message with the allowed range');
  eq((await station('s1')).params.batch, 1, 'invalid value not committed');
  await page.keyboard.type('.5');
  ok((await P().locator('.field.is-invalid .field__error').first().innerText()).includes('whole number'), 'fraction rejected for whole-number fields');
  await label('Loads per arrival').blur();
  eq(await label('Loads per arrival').inputValue(), '1', 'reverts to the last valid value');
  await shot('station-source');

  // typing is not interrupted by live updates, even when the same value changes underneath
  await type(label('Loads per arrival'), '7');
  await page.evaluate(() => { window.harness.startLive(50); });
  await page.evaluate(() => window.harness.store.commit('External edit', (d) => { d.stations.find((s) => s.id === 's1').params.batch = 5; }));
  await page.waitForTimeout(250);
  eq(await label('Loads per arrival').inputValue(), '7', 'live ticks never overwrite the field being typed in');
  await page.keyboard.type('2');
  eq((await station('s1')).params.batch, 72 > 100 ? 100 : 72, 'typing continues where it was');
  await page.evaluate(() => window.harness.stopLive());
  await label('Loads per arrival').blur();
  await page.waitForTimeout(30);
  eq(await label('Loads per arrival').inputValue(), '72');
  await reset();

  // ---- rename keeps focus
  await select('station', ['s5']);
  await type(label('Name'), 'Press line 2');
  eq((await station('s5')).name, 'Press line 2');
  eq((await state()).undoLabel, 'Rename station “Press line”');
  await label('Name').blur();
  await undo();
  eq((await station('s5')).name, 'Press line');

  // ---- process: every parameter
  await shot('station-process');
  await type(label('Average'), '60');
  eq((await station('s5')).params.cycle.mean, 60, 'cycle time');
  await P().getByRole('button', { name: 'Increase Machines in parallel' }).click();
  eq((await station('s5')).params.machines, 2, 'machines stepper');
  await type(label('Loads produced per cycle'), '2');
  eq((await station('s5')).params.outPerCycle, 2);
  await type(label('Input slots per incoming flow'), '8');
  eq((await station('s5')).params.inCap, 8);
  await type(label('Output slots per outgoing flow'), '10');
  eq((await station('s5')).params.outCap, 10);
  // breakdowns: minutes in the UI, seconds stored, 0 = never
  await type(label('Time between breakdowns'), '180');
  eq((await station('s5')).params.mtbf, 10800, 'MTBF stored in seconds');
  await type(label('Repair time'), '15');
  eq((await station('s5')).params.mttr, 900, 'MTTR stored in seconds');
  ok((await text()).includes('available about 92 %') || (await text()).includes('available about 91 %'), 'availability explained');
  await type(label('Time between breakdowns'), '0');
  eq((await station('s5')).params.mtbf, 0);
  ok((await text()).includes('never'), 'never breaks down');
  await type(label('Repair time'), '-3');
  ok((await P().locator('.field.is-invalid .field__error').first().innerText()).includes('between 0 and'), 'negative repair time rejected');
  await label('Repair time').blur();
  // everything undoes to the start (one coalesced step per field)
  for (let i = 0; i < 8; i++) await undo();
  eq((await station('s5')).params, original.stations.find((s) => s.id === 's5').params, 'all edits undo');

  // ---- storage
  await select('station', ['s4']);
  await type(label('Capacity'), '55');
  eq((await station('s4')).params.capacity, 55);
  await type(label('Minimum dwell time'), '120');
  eq((await station('s4')).params.dwell, 120);
  await shot('station-storage');
  await undo(); await undo();

  // ---- sink: information only
  await select('station', ['s3']);
  ok((await text()).includes('There is nothing to set up'), 'sink is info only');
  await shot('station-sink');

  // ---- depot: chargers cannot exceed the parking slots
  await select('station', ['s8']);
  const slots = (await station('s8')).params.slots;
  await type(label('Charging slots'), '99');
  ok((await P().locator('.field.is-invalid .field__error').first().innerText()).includes(`between 0 and ${slots}`), 'chargers limited by slots');
  eq((await station('s8')).params.chargers, original.stations.find((s) => s.id === 's8').params.chargers, 'not committed');
  await label('Charging slots').blur();
  await type(label('Parking slots'), '1');
  eq((await station('s8')).params.slots, 1);
  eq((await station('s8')).params.chargers, 1, 'fewer slots pull the chargers down');
  eq(await label('Charging slots').inputValue(), '1');
  await type(label('Charging slots'), '3');
  ok((await P().locator('.field.is-invalid .field__error').first().innerText()).includes('between 0 and 1'), 'new limit is applied after the slots changed');
  await label('Charging slots').blur();
  await shot('station-depot');
  await undo();

  // ---- size: steppers, rejection, edge of the plant
  await select('station', ['s4']);
  const w0 = (await station('s4')).w;
  await P().getByRole('button', { name: 'Increase Width (cells)' }).click();
  eq((await station('s4')).w, w0 + 1, 'width stepper');
  eq((await state()).undoLabel, 'Resize station “Central warehouse”');
  await undo();
  await label('Width (cells)').fill('90');
  ok((await toasts()).at(-1).msg.includes('past the edge'), 'beyond the grid is explained');
  eq((await station('s4')).w, w0, 'rejected');
  await label('Width (cells)').blur();
  await page.waitForTimeout(30);
  eq(await label('Width (cells)').inputValue(), String(w0), 'stepper shows the real size again');

  const spot = await freeSpot(2, 2);
  ok(spot, 'a free spot exists for the test station');
  await page.evaluate(async (s) => {
    const L = await import('/js/model/layout.js');
    window.harness.store.commit('Test: add station and obstacle', (d) => {
      L.addStation(d, { type: 'sink', name: 'Test sink', x: s.x, y: s.y, w: 2, h: 2 });
      L.addObstacle(d, { x: s.x + 2, y: s.y, w: 1, h: 1, kind: 'wall' });
    });
  }, spot);
  const testId = (await lay()).stations.find((s) => s.name === 'Test sink').id;
  await select('station', [testId]);
  await P().getByRole('button', { name: 'Increase Width (cells)' }).click();
  ok((await toasts()).at(-1).msg.startsWith('Something is in the way'), 'blocked resize says what is wrong');
  eq((await station(testId)).w, 2, 'blocked resize leaves the station alone');
  eq(await label('Width (cells)').inputValue(), '2', 'stepper snaps back');

  // docks and connected flows of a lone station
  ok((await text()).includes('No road touches this station'), 'warning when no dock');
  ok((await P().locator('.chip--warn').count()) === 1);
  ok((await text()).includes('Nothing is sent here yet'), 'a Goods out nobody feeds says so');
  ok(await P().locator('[data-loads=in] select').isVisible(), 'with a picker for the origin');
  await shot('station-no-dock-no-flows');

  // delete with undo toast; duplicate selects the copy
  await button('Duplicate').click();
  const afterDup = await lay();
  eq(afterDup.stations.length, original.stations.length + 2, 'duplicate adds a station');
  const copy = (await state()).selection.ids[0];
  ok(copy !== testId && afterDup.stations.some((s) => s.id === copy && s.name.startsWith('Test sink')), 'copy is selected');
  await button('Delete').click();
  eq((await lay()).stations.length, original.stations.length + 1);
  const del = (await toasts()).at(-1);
  ok(del.msg.startsWith('Deleted') && del.action === 'Undo', 'delete offers undo');
  await page.locator('.toast__action').click();
  eq((await lay()).stations.length, original.stations.length + 2, 'toast undo brings it back');
  await reset();

  // flows of the warehouse (2 outgoing + 1 incoming): where loads go and come from, shares, the flow settings button selects the flow
  await select('station', ['s4']);
  const outRows = P().locator('[data-loads=out] li[data-flow]');
  const inRows = P().locator('[data-loads=in] li[data-flow]');
  eq(await outRows.count(), 2, 'two flows leave the warehouse');
  eq(await inRows.count(), 1, 'one arrives');
  ok((await inRows.first().innerText()).includes('Goods receiving'), 'the row shows the origin');
  ok((await outRows.first().innerText()).includes('Press line') && (await outRows.first().innerText()).includes('67 %'), 'and the destination with its share');
  await shot('station-flows');
  await outRows.first().getByRole('button', { name: /^Flow settings/ }).click();
  eq((await state()).selection, { kind: 'flow', ids: ['f2'] }, 'the flow settings button selects the flow');
  ok((await text()).includes('Central warehouse → Press line'), 'flow summary');
  await shot('flow-summary');
  await button('Edit in Flows tab').click();
  eq((await calls()).at(-1), ['setRightTab', 'flows']);

  // ---- fleet summary
  await select('fleet', ['v2']);
  ok((await text()).includes('AGVs') && (await text()).includes('Home depot'), 'fleet summary');
  await button('Edit in Fleet tab').click();
  eq((await calls()).at(-1), ['setRightTab', 'fleet']);
  await shot('fleet-summary');

  // ============================================================================================ LIVE STATUS
  await select('station', ['s5']);
  ok((await P().locator('[aria-label="Live status"]').isHidden()), 'no status strip without a simulation');
  await page.evaluate(() => window.harness.setSim('stub'));
  ok(await P().locator('[aria-label="Live status"]').isVisible(), 'status strip with a simulation');
  ok((await P().locator('[aria-label="Live status"]').innerText()).includes('Working'), 'process state');
  ok((await P().locator('[aria-label="Live status"]').innerText()).includes('1 of 2 machines working'));
  ok((await P().locator('[aria-label="Live status"]').innerText()).includes('Input buffer 2/4'));
  await shot('station-process-live');
  await select('station', ['s1']);
  ok((await P().locator('[aria-label="Live status"]').innerText()).includes('Yard is backing up'), 'blocked source');
  await select('station', ['s4']);
  ok((await P().locator('[aria-label="Live status"]').innerText()).includes('Stored 14/40'), 'storage fill');
  await page.evaluate(() => window.harness.setSim('real'));
  for (const id of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) {
    await select('station', [id]);
    const strip = P().locator('[aria-label="Live status"]');
    ok(await strip.isVisible(), `real simulation status for ${id}`);
  }
  await select('station', ['s7']);
  await shot('station-process-real-sim');
  await page.evaluate(() => window.harness.setSim('none'));

  // ============================================================================================ OTHER SELECTIONS
  // ---- obstacle
  const o1 = original.obstacles[0];
  await select('obstacle', [o1.id]);
  ok((await text()).includes('Obstacle'), 'obstacle form');
  await button(o1.kind === 'rack' ? 'Wall' : 'Rack').click();
  eq((await lay()).obstacles[0].kind, o1.kind === 'rack' ? 'wall' : 'rack', 'obstacle kind');
  await P().getByRole('button', { name: 'Increase Height (cells)' }).click();
  ok((await lay()).obstacles[0].h === o1.h + 1 || (await toasts()).at(-1).msg.startsWith('Something is in the way'), 'obstacle size or explained rejection');
  await shot('obstacle');
  await reset();

  // ---- label
  const l1 = original.labels[0];
  await select('label', [l1.id]);
  await type(label('Text'), 'Dock A');
  eq((await lay()).labels[0].text, 'Dock A');
  await type(label('Text size'), '2');
  eq((await lay()).labels[0].size, 2);
  await type(label('Text size'), '20');
  ok((await P().locator('.field.is-invalid .field__error').first().innerText()).includes('between 0.25 and 8'));
  await label('Text size').blur();
  await shot('label');
  await reset();

  // ---- road cell
  const cellKey = await page.evaluate(async () => {
    const L = await import('/js/model/layout.js');
    const layout = window.harness.layout();
    const key = Object.keys(layout.roads).find((k) => {
      const [x, y] = k.split(',').map(Number);
      return [[0, -1], [1, 0], [0, 1], [-1, 0]].every(([dx, dy]) => L.roadAt(layout, x + dx, y + dy) && L.hasLink(layout, x, y, 0) !== undefined);
    });
    return key || Object.keys(layout.roads).find((k) => { const [x, y] = k.split(',').map(Number); return L.hasLink(layout, x, y, 1) && L.hasLink(layout, x + 1, y, 3); });
  });
  const [cx, cy] = cellKey.split(',').map(Number);
  await select('cell', [cellKey]);
  ok((await text()).includes('Road cell') && (await text()).includes('Directions'), 'road cell form');
  const linkSelects = P().locator('details:has(summary:has-text("Directions")) select');
  const nLinks = await linkSelects.count();
  ok(nLinks >= 1, 'one link control per neighbouring road cell');
  const bits = () => page.evaluate(([x, y]) => structuredClone(window.harness.layout().roads), [cx, cy]);
  const east = P().getByLabel('→ To the east', { exact: true });
  if (await east.count()) {
    const before = await bits();
    await east.selectOption('in');
    const afterIn = await bits();
    ok((afterIn[`${cx},${cy}`].out & 2) === 0 && (afterIn[`${cx + 1},${cy}`].out & 8) !== 0, 'one-way into this cell: neighbour -> this only');
    await east.selectOption('out');
    const afterOut = await bits();
    ok((afterOut[`${cx},${cy}`].out & 2) !== 0 && (afterOut[`${cx + 1},${cy}`].out & 8) === 0, 'one-way out of this cell');
    await east.selectOption('none');
    const afterNone = await bits();
    ok((afterNone[`${cx},${cy}`].out & 2) === 0 && (afterNone[`${cx + 1},${cy}`].out & 8) === 0, 'not linked');
    await east.selectOption('both');
    eq(await bits(), before, 'back to two-way restores the original');
    eq(await east.inputValue(), 'both');
    await undo(); await undo(); await undo(); await undo();
    eq(await bits(), before, 'undo');
  }
  // speed limit: dragging is one undo step
  const limit = label('Speed limit');
  await limit.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
  eq((await lay()).roads[cellKey].limit, 0.8, 'speed limit applied live');
  ok((await P().locator('.field__value').first().innerText()).includes('80 %'), 'readout');
  await undo();
  ok((await lay()).roads[cellKey].limit === undefined, 'a drag is one undo step');
  await limit.press('Home');
  eq((await lay()).roads[cellKey].limit, 0.1, 'slider minimum is 10 %');
  await P().getByRole('button', { name: 'Reset Speed limit' }).click();
  ok((await lay()).roads[cellKey].limit === undefined, 'reset removes the limit');
  await shot('road-cell');
  await button('Remove road cell').click();
  ok(!(await lay()).roads[cellKey], 'road cell removed');
  eq((await state()).selection.kind, null, 'selection cleared');
  ok((await toasts()).at(-1).msg.includes('road cell'));
  await page.locator('.toast__action').click();
  ok((await lay()).roads[cellKey], 'undo from the toast');
  await reset();

  // ---- multiple
  await select('station', ['s5', 's6', 's7']);
  ok((await text()).includes('3 stations selected') && (await text()).includes('3 Workstations'), 'multi summary');
  await shot('multi-stations');
  await button('Duplicate').click();
  eq((await state()).selection.ids.length, 3, 'the copies are selected');
  eq((await lay()).stations.length, original.stations.length + 3);
  await button('Delete').click();
  eq((await lay()).stations.length, original.stations.length, 'delete removes all selected');
  await reset();
  await select('cell', [cellKey, `${cx + 1},${cy}`]);
  ok((await text()).includes('2 road cells selected'), 'multi road cells');
  await button('Delete').click();
  ok(!(await lay()).roads[cellKey] && !(await lay()).roads[`${cx + 1},${cy}`]);
  await reset();

  // ============================================================================================ WHAT-IF
  await tab('simulate');
  ok(/what-if/i.test(await text()), 'simulate panel');
  const settings = async () => (await lay()).settings;
  await shot('simulate');
  ok(await button('Reset all factors to 1×').isDisabled(), 'reset-all disabled while everything is 1');
  const demand = label('Demand');
  await demand.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  ok(near((await settings()).demandFactor, 1.25), 'demand slider applies live');
  ok((await P().locator('.field__value').first().innerText()) === '1.25×', 'live readout');
  eq(await page.evaluate(() => window.harness.store.getState().undoLabel), 'Change demand', 'readable undo label');
  await undo();
  eq((await settings()).demandFactor, 1, 'a drag is one undo step');
  await page.evaluate(() => window.harness.store.redo());
  ok(near((await settings()).demandFactor, 1.25));
  ok(await demand.evaluate((el) => el === document.activeElement), 'slider keeps focus while the store updates');
  // reset button of the slider
  await P().getByRole('button', { name: 'Reset Demand' }).click();
  eq((await settings()).demandFactor, 1, 'slider reset');
  // other sliders and the reset-all button
  await label('Vehicle speed').focus();
  await page.keyboard.press('End');
  eq((await settings()).speedFactor, 2, 'vehicle speed up to 2x');
  await label('Process time').focus();
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  ok(near((await settings()).processFactor, 1.2), '1.2 = machines 20 % slower');
  ok((await text()).includes('Vehicle speed 2×, process time 1.2×'), 'summary of changed factors');
  await shot('simulate-changed');
  await button('Reset all factors to 1×').click();
  eq([(await settings()).demandFactor, (await settings()).speedFactor, (await settings()).processFactor], [1, 1, 1], 'reset all');
  await undo();
  eq((await settings()).speedFactor, 2, 'reset all is a single undo step');
  await undo(); await undo();
  eq((await settings()).speedFactor, 1);
  // imported value outside the slider range is shown truthfully
  await page.evaluate(() => window.harness.store.commit('Test edit', (d) => { d.settings.demandFactor = 5; }));
  eq(await label('Demand').inputValue(), '5');
  ok((await P().locator('.field__value').first().innerText()) === '5×');
  await undo();

  // strategy and rules
  await label('Dispatch strategy').selectOption('oldest');
  eq((await settings()).dispatch, 'oldest');
  ok((await text()).includes('waited longest'), 'strategy is explained');
  await label('Routing').selectOption('congestion');
  eq((await settings()).routing, 'congestion');
  await button('Left-hand traffic').click();
  eq((await settings()).handedness, 'left');
  await label('Deadlock handling').selectOption('ignore');
  eq((await settings()).deadlock, 'ignore');
  ok((await text()).includes('gridlock'), 'deadlock handling explained');
  await undo(); await undo(); await undo(); await undo();
  eq((await settings()).dispatch, 'nearest');

  // seed
  await type(label('Random seed'), '4242');
  eq((await settings()).seed, 4242);
  await page.evaluate(() => window.harness.startLive(50));
  await type(label('Random seed'), '77');
  await page.waitForTimeout(200);
  eq(await label('Random seed').inputValue(), '77', 'seed field is not touched by live updates');
  await page.evaluate(() => window.harness.stopLive());
  await label('Random seed').blur();
  await button('New seed').click();
  const seed2 = (await settings()).seed;
  ok(seed2 !== 77 && seed2 > 0, 'new seed');
  eq(await label('Random seed').inputValue(), String(seed2), 'field shows the new seed');
  await undo();

  // experiment length
  await type(label('Run length'), '12');
  eq((await settings()).duration, 43200, 'run length in hours');
  await type(label('Warm-up'), '30');
  eq((await settings()).warmup, 1800, 'warm-up in minutes');
  ok((await text()).includes('measured over the last 11.5 h'), 'measured window explained');
  await type(label('Warm-up'), '900');
  ok((await text()).includes('warm-up must be shorter'), 'warm-up beyond the run is flagged');
  await type(label('Run length'), '0');
  ok((await P().locator('.field.is-invalid .field__error').first().innerText()).includes('between 0.1 and 720'), 'invalid run length');
  await label('Run length').blur();
  await shot('simulate-run-length');
  await reset();
  await button('How to read the results').click();
  eq((await calls()).at(-1), ['setRightTab', 'results']);

  // ============================================================================================ CHECKS
  await tab('checks');
  ok((await text()).includes('No problems found'), 'clean plant: empty state');
  ok(await P().locator('.empty__icon svg').count() === 1, 'green check icon');
  eq(await page.evaluate(() => window.harness.panels.checks.count), 0);
  await shot('checks-clean');

  const noDock = await freeSpot(3, 3);
  await page.evaluate(async (s) => {
    const L = await import('/js/model/layout.js');
    window.harness.store.commit('Test: make problems', (d) => {
      for (const f of d.fleets) f.count = 0;
      L.addStation(d, { type: 'process', name: 'Press line', x: s.x, y: s.y, w: 3, h: 3 });
      d.settings.warmup = d.settings.duration;
    });
  }, noDock);
  const expected = await page.evaluate(() => {
    const issues = window.harness.ctx.issues();
    const n = (sev) => issues.filter((i) => i.severity === sev).length;
    return { error: n('error'), warning: n('warning'), info: n('info') };
  });
  ok(expected.error >= 1 && expected.warning >= 2 && expected.info >= 1, `the test plant has all three severities: ${JSON.stringify(expected)}`);
  ok((await P().locator('h3').allInnerTexts()).join() === 'Errors,Warnings,Notes', 'grouped by severity');
  const chips = await P().locator('.chip').allInnerTexts();
  ok(chips.some((c) => c.includes(`${expected.error} error`)) && chips.some((c) => c.includes(`${expected.warning} warning`)) && chips.some((c) => c.includes('note')), `summary chips ${chips}`);
  eq(await page.evaluate(() => window.harness.panels.checks.count), expected.error + expected.warning, 'count = errors + warnings');
  eq(await page.evaluate(() => window.harness.badge), expected.error + expected.warning, 'onCount callback fired');
  eq(await page.evaluate(() => {
    const log = [];
    const panel = window.harness.panels.checks;
    const shellCallback = panel.onCount;
    panel.onCount = (n) => log.push(n);
    panel.onCount = shellCallback;
    return log;
  }), [expected.error + expected.warning], 'assigning onCount delivers the current count at once');
  // a kind of problem that repeats more than three times keeps its first three callouts; the rest sits behind a button
  const fold = P().locator('button[data-role=fold]');
  eq(await fold.count(), 1, 'one folded kind of error');
  const kept = await P().locator('.callout--error').count();
  ok(kept < expected.error && /^Show \d+ more similar errors$/.test(await fold.innerText()), `the repeats are folded: ${kept} of ${expected.error} shown, "${await fold.innerText()}"`);
  await shot('checks-problems');
  await fold.click();
  eq(await P().locator('.callout--error').count(), expected.error, 'the button shows every error');
  eq(await fold.innerText(), 'Show fewer', 'and turns into "Show fewer"');
  ok(await fold.evaluate((el) => el === document.activeElement), 'keyboard focus stays on the button after the redraw');
  await fold.click();
  eq(await P().locator('.callout--error').count(), kept, 'folded again');

  // Show navigates
  const firstShow = P().locator('.callout--warn button', { hasText: 'Show' }).first();
  await firstShow.click();
  const focusCall = (await calls()).at(-1);
  eq(focusCall[0], 'focus');
  ok(focusCall[1].stationIds || focusCall[1].flowIds || focusCall[1].fleetIds || focusCall[1].cells, 'focus got the refs');
  eq(await page.evaluate(() => window.harness.tab), 'properties', 'navigated to the thing');
  await tab('checks');
  eq(await P().locator('.callout button:has-text("Show")').count() > 0, true);

  // cheap updates: no new validation, DOM untouched, focus kept
  const runs = await page.evaluate(() => window.harness.issueRuns);
  const listNode = await P().locator('section').first().elementHandle();
  await P().locator('.callout--warn button', { hasText: 'Show' }).first().focus();
  await page.evaluate(() => { for (let i = 0; i < 20; i++) window.harness.updateAll(); });
  eq(await page.evaluate(() => window.harness.issueRuns), runs, 'update() does not re-validate');
  ok(await listNode.evaluate((n) => n.isConnected), 'the list is not rebuilt when nothing changed');
  await page.evaluate(() => window.harness.store.commit('Test edit', (d) => { d.name = 'Renamed'; }));
  ok(await P().locator('.callout--warn button', { hasText: 'Show' }).first().evaluate((el) => el === document.activeElement), 'focus survives an unrelated edit');

  // dismiss a note, remembered; restore
  const info = P().locator('.callout--info').first();
  const infoText = await info.innerText();
  await P().locator('.callout--info button', { hasText: 'Dismiss' }).first().click();
  const notesBefore = expected.info;
  eq(await P().locator('.callout--info').count(), notesBefore - 1, 'dismissed note disappears');
  eq(await page.evaluate(() => window.harness.panels.checks.count), expected.error + expected.warning, 'dismissing a note does not change the badge');
  ok(!(await P().innerText()).includes(infoText.split('\n')[0]) || notesBefore > 1);
  await page.evaluate(() => window.harness.store.commit('Test edit', (d) => { d.name = 'Renamed again'; }));
  eq(await P().locator('.callout--info').count(), notesBefore - 1, 'dismissed notes stay dismissed across redraws');
  await button('Show 1 dismissed note again').click();
  eq(await P().locator('.callout--info').count(), notesBefore, 'restored');
  await shot('checks-after-restore');

  // fixing the plant empties the list again and the badge follows
  for (let i = 0; i < 4; i++) await undo();
  await reset();
  await tab('checks');
  ok((await text()).includes('No problems found'), 'clean again');
  eq(await page.evaluate(() => window.harness.badge), 0, 'badge back to 0');

  // ============================================================================================ ROBUSTNESS
  await tab('properties');
  // a road cell form follows its neighbours: removing one rebuilds the list of links
  await select('cell', [cellKey]);
  const linksBefore = await P().locator('details:has(summary:has-text("Directions")) select').count();
  await page.evaluate(async ([x, y]) => {
    const L = await import('/js/model/layout.js');
    const layout = window.harness.layout();
    const dir = [[0, -1], [1, 0], [0, 1], [-1, 0]].find(([dx, dy]) => L.roadAt(layout, x + dx, y + dy));
    window.harness.store.commit('Test: remove a neighbour', (d) => { L.eraseRoadCell(d, x + dir[0], y + dir[1]); });
  }, [cx, cy]);
  eq(await P().locator('details:has(summary:has-text("Directions")) select').count(), linksBefore - 1, 'link list follows the neighbours');
  eq((await state()).selection.kind, 'cell', 'the cell stays selected');
  await reset();

  // a dock cell names its station; a flow summary shows its share of the origin's output
  const dock = await page.evaluate(async () => { const L = await import('/js/model/layout.js'); const [x, y] = L.docksOf(window.harness.layout(), 's5')[0]; return `${x},${y}`; });
  await select('cell', [dock]);
  ok((await text()).includes('Dock of Press line'), 'a dock cell names its station');
  await select('flow', ['f2']);
  ok((await text()).includes('Share of Central warehouse\u2019s output 67 % (weight 2)'), `flow share: ${await text()}`);

  // undoing the creation of the selected thing falls back to the plant settings
  await select('station', ['s1']);
  await button('Duplicate').click();
  ok(/Goods in/.test(await text()) && (await state()).selection.ids[0] !== 's1', 'copy selected');
  await undo();
  ok(/plant settings/i.test(await text()), 'selection pruned: back to the plant settings');
  await reset();

  // a simulation that is older than the layout (rebuild pending) has no state for a new station: no strip, no error
  await page.evaluate(() => window.harness.setSim('stub'));
  const lone = await freeSpot(2, 2);
  await page.evaluate(async (s) => {
    const L = await import('/js/model/layout.js');
    window.harness.store.commit('Test: add station', (d) => { L.addStation(d, { type: 'sink', name: 'Newcomer', x: s.x, y: s.y, w: 2, h: 2 }); });
  }, lone);
  await select('station', [(await lay()).stations.find((s) => s.name === 'Newcomer').id]);
  ok(await P().locator('[aria-label="Live status"]').isHidden(), 'no status strip for a station the simulation does not know yet');
  await page.evaluate(() => window.harness.setSim('none'));
  await reset();

  // live ticks never disturb text, slider or select while they are in use
  await select('station', ['s5']);
  await page.evaluate(() => window.harness.startLive(40));
  await type(label('Name'), 'Typing while the simulation runs');
  await page.waitForTimeout(200);
  eq(await label('Name').inputValue(), 'Typing while the simulation runs', 'name field survives live ticks');
  ok(await label('Name').evaluate((el) => el === document.activeElement), 'and keeps focus');
  await label('Variation').focus();
  await page.waitForTimeout(150);
  ok(await label('Variation').evaluate((el) => el === document.activeElement), 'select keeps focus');
  await page.evaluate(() => window.harness.stopLive());
  await reset();

  // every control in every form has an accessible name
  const unnamed = () => page.evaluate(() => {
    const nameOf = (el) => el.getAttribute('aria-label') || (el.labels && [...el.labels].map((l) => l.textContent).join(' ').trim()) || (el.textContent || el.title || '').trim();
    const root = document.querySelector('#body > .is-shown');
    return [...root.querySelectorAll('input, select, textarea, button, summary')].filter((el) => el.offsetParent !== null && !nameOf(el)).map((el) => el.outerHTML.slice(0, 90));
  });
  const forms = [['plant', null], ['source', ['station', ['s1']]], ['process', ['station', ['s5']]], ['storage', ['station', ['s4']]], ['sink', ['station', ['s3']]], ['depot', ['station', ['s8']]],
    ['multi', ['station', ['s5', 's6']]], ['obstacle', ['obstacle', [original.obstacles[0].id]]], ['label', ['label', [original.labels[0].id]]], ['cell', ['cell', [cellKey]]],
    ['flow', ['flow', ['f2']]], ['fleet', ['fleet', ['v1']]]];
  await page.evaluate(() => window.harness.setSim('stub'));
  for (const [name, sel] of forms) {
    if (sel) await select(...sel); else await page.evaluate(() => window.harness.store.clearSelection());
    eq(await unnamed(), [], `all controls are named in the ${name} form`);
  }
  await page.evaluate(() => window.harness.setSim('none'));
  await tab('simulate');
  eq(await unnamed(), [], 'all controls are named in the what-if panel');
  await tab('checks');
  eq(await unnamed(), [], 'all controls are named in the checks panel');
  await tab('properties');

  // ============================================================================================ NARROW + DARK
  await page.setViewportSize({ width: 390, height: 800 });
  await page.evaluate(() => document.body.classList.add('narrow'));
  const overflowX = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const narrowCases = [
    ['plant', 'properties', null], ['source', 'properties', ['station', ['s1']]], ['process', 'properties', ['station', ['s5']]],
    ['storage', 'properties', ['station', ['s4']]], ['depot', 'properties', ['station', ['s8']]], ['sink', 'properties', ['station', ['s3']]],
    ['multi', 'properties', ['station', ['s5', 's6']]], ['obstacle', 'properties', ['obstacle', [original.obstacles[0].id]]],
    ['flow', 'properties', ['flow', ['f2']]], ['cell', 'properties', ['cell', [cellKey]]], ['label', 'properties', ['label', [original.labels[0].id]]], ['simulate', 'simulate', null],
  ];
  await page.evaluate(() => window.harness.setSim('stub'));
  for (const [name, which, sel] of narrowCases) {
    await tab(which);
    if (sel) await select(...sel); else await page.evaluate(() => window.harness.store.clearSelection());
    eq(await overflowX(), 0, `no horizontal scroll at 390 px (${name})`);
    await shot(`narrow-${name}`);
  }
  await page.evaluate(() => window.harness.setSim('none'));
  await page.evaluate(async (s) => {
    const L = await import('/js/model/layout.js');
    window.harness.store.commit('Test: make problems', (d) => { for (const f of d.fleets) f.count = 0; L.addStation(d, { type: 'process', name: 'Press line', x: s.x, y: s.y, w: 3, h: 3 }); });
  }, noDock);
  await tab('checks');
  eq(await overflowX(), 0, 'checks fit 390 px');
  await shot('narrow-checks');

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { document.body.classList.remove('narrow'); document.documentElement.dataset.theme = 'dark'; });
  await shot('checks', 'dark');
  await tab('simulate'); await shot('simulate', 'dark');
  await page.evaluate(() => window.harness.setSim('stub'));
  await tab('properties');
  for (const [name, sel] of [['plant', null], ['process', ['station', ['s5']]], ['source', ['station', ['s1']]], ['depot', ['station', ['s8']]], ['cell', ['cell', [cellKey]]], ['multi', ['station', ['s5', 's6']]]]) {
    if (sel) await select(...sel); else await page.evaluate(() => window.harness.store.clearSelection());
    await shot(name, 'dark');
  }

  eq(errors, [], 'no console errors or warnings');
  console.log(`panels1: ${checks} checks passed, screenshots in e2e-output/panels1-*.png`);
});
