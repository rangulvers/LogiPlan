// Ladder example 3, `yard-shuttle` (docs/EXAMPLES-DESIGN.md 6.3): the validation of the plant and of every edit of its tips (a minimum batch of 8 against a
// truck of 4 or 1 gives exactly two batch-exceeds-capacity warnings, nothing else gives an issue), the figures of its five tips (seeds 1 to 5, 8 simulated
// hours, the tolerance rule of 8.4) and the findings the Results tab gives.
// Heavy tier: about 7 CPU seconds on worker threads (tests/helpers/ladder-runs.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES } from '../js/model/examples.js';
import { validateLayout } from '../js/model/validate.js';
import { edits, claims } from './helpers/ladder/yard-shuttle.js';
import { runVariants, checkClaims, seedsWith, hasFinding } from './helpers/ladder-runs.js';

const ID = 'yard-shuttle';
const example = EXAMPLES.find((e) => e.id === ID);
const variants = { base: { example: ID }, ...Object.fromEntries(Object.keys(edits).map((edit) => [edit, { example: ID, edit }])) };
let measured = null;
const runs = () => (measured ??= runVariants(variants));

test('yard-shuttle: zero validation issues, except two batch-exceeds-capacity warnings for a truck of 4 and of 1 (tip 4)', () => {
  assert.deepEqual(validateLayout(example.build()), []);
  for (const [name, edit] of Object.entries(edits)) {
    const layout = example.build();
    edit(layout);
    const issues = validateLayout(layout);
    if (name === 'cap4' || name === 'cap1') {
      assert.deepEqual(issues.map((i) => `${i.severity}:${i.code}`), ['warning:batch-exceeds-capacity', 'warning:batch-exceeds-capacity'], name);
      if (name === 'cap4') assert.ok(issues.every((i) => i.message.includes('at most 4 can ever be ready')), 'the Checks tab says what the tip quotes');
    } else assert.deepEqual(issues, [], `edit ${name}`);
  }
});

test('yard-shuttle: every figure of the five tips is reproduced (mean of seeds 1 to 5 over 8 hours)', async () => {
  assert.deepEqual(checkClaims(claims, await runs(), example.tips), []);
  assert.deepEqual([...new Set(claims.map((c) => c.tip))], [1, 2, 3, 4, 5], 'every tip has its numbers');
});

test('yard-shuttle: the Results tab finds nothing at base or with two trucks, calls the truck saturated at a longest wait of 300 s (critical) and at capacity 4 (warning)', async () => {
  const res = await runs();
  assert.equal(seedsWith(res.base, (m) => m.ins.length === 0), 5);
  assert.equal(seedsWith(res.two, (m) => m.ins.length === 0), 5);
  assert.equal(seedsWith(res.wait300, (m) => hasFinding(m, 'fleet-saturated', { severity: 'critical' })), 5);
  assert.equal(seedsWith(res.cap4, (m) => hasFinding(m, 'fleet-saturated', { severity: 'warning' })), 5);
  assert.equal(seedsWith(res.base, (m) => m.dl === 0), 5, 'no deadlock');
});
