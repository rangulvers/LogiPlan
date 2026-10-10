// Ladder example 10 of the gallery, `components-plant` (docs/EXAMPLES-DESIGN.md 6.5): the validation of the plant and of every edit of its tips, the figures of
// its five tips (seeds 1 to 5, 8 simulated hours after a 2 hour warm-up, the tolerance rule of 8.4) and the findings the Results tab gives.
// The road edits are the explicit cells of tests/helpers/ladder/components-plant.js (no module state of the builder is needed).
// Heavy tier: about 91 CPU seconds on worker threads (tests/helpers/ladder-runs.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES } from '../js/model/examples.js';
import { validateLayout } from '../js/model/validate.js';
import * as L from '../js/model/layout.js';
import { edits, claims } from './helpers/ladder/components-plant.js';
import { runVariants, checkClaims, seedsWith, hasFinding } from './helpers/ladder-runs.js';

const ID = 'components-plant';
const example = EXAMPLES.find((e) => e.id === ID);
const variants = { base: { example: ID }, ...Object.fromEntries(Object.keys(edits).map((edit) => [edit, { example: ID, edit }])) };
let measured = null;
const runs = () => (measured ??= runVariants(variants));
const isRoad = (l, x, y) => L.roadAt(l, x, y) !== undefined && L.roadAt(l, x, y) !== null;

test('components-plant: zero validation issues, for the plant and for every edit of the tips', () => {
  assert.deepEqual(validateLayout(example.build()), []);
  for (const [name, edit] of Object.entries(edits)) {
    const layout = example.build();
    edit(layout);
    assert.deepEqual(validateLayout(layout), [], `edit ${name}`);
  }
});

test('components-plant: the road edits of tips 3 and 4 take out the cells the tips describe (the mid street, the cross aisle, with or without the crossing cell)', () => {
  const base = example.build();
  for (let x = 14; x <= 66; x++) assert.ok(isRoad(base, x, 19), `mid street (${x}, 19)`);
  for (let y = 7; y <= 31; y++) assert.ok(isRoad(base, 34, y), `cross aisle (34, ${y})`);
  const noMid = example.build();
  edits.noMid(noMid);
  for (let x = 14; x <= 66; x++) assert.ok(!isRoad(noMid, x, 19), `erased (${x}, 19)`);
  assert.ok(isRoad(noMid, 34, 10) && isRoad(noMid, 13, 19) === isRoad(base, 13, 19), 'the rest of the plant is as before');
  const noCross = example.build();
  edits.noCross(noCross);
  assert.ok(isRoad(noCross, 34, 19), 'the crossing cell stays');
  assert.ok(!isRoad(noCross, 34, 10) && !isRoad(noCross, 34, 28), 'the cross aisle is gone either side of it');
  const noCrossAll = example.build();
  edits.noCrossAll(noCrossAll);
  assert.ok(!isRoad(noCrossAll, 34, 19), 'the crossing cell goes too, the mid street is cut in two');
});

test('components-plant: every figure of the five tips is reproduced (mean of seeds 1 to 5 over 8 hours)', async () => {
  assert.deepEqual(checkClaims(claims, await runs(), example.tips), []);
  assert.deepEqual([...new Set(claims.map((c) => c.tip))], [1, 2, 3, 4, 5], 'every tip has its numbers');
});

test('components-plant: the findings - the paint shop is the bottleneck in 3 of 5 runs, critical at demand 1.2, the press line is named next, no mid street is a critical traffic finding', async () => {
  const res = await runs();
  assert.ok(seedsWith(res.base, (m) => hasFinding(m, 'bottleneck', { text: 'Paint shop' })) >= 3, 'tip 1: the findings call the paint shop the bottleneck in 3 of 5 runs');
  assert.equal(seedsWith(res.base, (m) => m.ins.some((i) => i.severity === 'critical' && !i.id.startsWith('bottleneck'))), 0, 'at base nothing is critical but (in one run of five) the bottleneck itself');
  assert.equal(seedsWith(res.d12, (m) => hasFinding(m, 'bottleneck', { severity: 'critical', text: 'Paint shop' })), 5, 'tip 2: critical in 5 of 5 runs');
  assert.ok(seedsWith(res.d12, (m) => hasFinding(m, 'outbound-short')) >= 3, 'tip 2: trucks begin to leave short');
  assert.ok(seedsWith(res.d12paint2, (m) => hasFinding(m, 'bottleneck', { text: 'Press line' })) >= 2, 'tip 2: the findings name the press line in 2 of 5 runs');
  assert.equal(seedsWith(res.noMid, (m) => hasFinding(m, 'traffic', { severity: 'critical' })), 5, 'tip 3: the Traffic finding turns critical');
  for (const run of ['base', 'noMid', 'noCrossAll']) assert.equal(seedsWith(res[run], (m) => m.dl === 0), 5, `${run}: no deadlock`);
});
