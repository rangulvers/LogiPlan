// Ladder example 1, `hello-pallet` (docs/EXAMPLES-DESIGN.md 6.1): the validation of the plant and of every edit its tips describe, the figures of its four
// tips (seeds 1 to 5, 8 simulated hours, the tolerance rule of 8.4) and the findings the Results tab gives at base and at demand 1.5.
// Heavy tier: about 8 CPU seconds on worker threads (tests/helpers/ladder-runs.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES } from '../js/model/examples.js';
import { validateLayout } from '../js/model/validate.js';
import { edits, claims } from './helpers/ladder/hello-pallet.js';
import { runVariants, checkClaims, seedsWith, hasFinding } from './helpers/ladder-runs.js';

const ID = 'hello-pallet';
const example = EXAMPLES.find((e) => e.id === ID);
const variants = { base: { example: ID }, ...Object.fromEntries(Object.keys(edits).map((edit) => [edit, { example: ID, edit }])) };
let measured = null;
const runs = () => (measured ??= runVariants(variants));

test('hello-pallet: zero validation issues, for the plant and for every edit of the tips', () => {
  assert.deepEqual(validateLayout(example.build()), []);
  for (const [name, edit] of Object.entries(edits)) {
    const layout = example.build();
    edit(layout);
    assert.deepEqual(validateLayout(layout), [], `edit ${name}`);
  }
});

test('hello-pallet: every figure of the four tips is reproduced (mean of seeds 1 to 5 over 8 hours)', async () => {
  assert.deepEqual(checkClaims(claims, await runs(), example.tips), []);
  assert.deepEqual([...new Set(claims.map((c) => c.tip))], [1, 2, 3, 4], 'every tip has its numbers');
});

test('hello-pallet: the Results tab finds nothing at base and calls the forklift saturated and the supply too big at demand 1.5, in every run', async () => {
  const res = await runs();
  assert.equal(seedsWith(res.base, (m) => m.ins.length === 0), 5, 'no finding except "No bottlenecks, congestion or deadlocks found"');
  assert.equal(seedsWith(res.d15, (m) => hasFinding(m, 'fleet-saturated', { severity: 'critical' })), 5);
  assert.equal(seedsWith(res.d15, (m) => hasFinding(m, 'supply')), 5);
  assert.equal(seedsWith(res.base, (m) => m.dl === 0), 5, 'no deadlock');
});
