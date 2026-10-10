// Ladder example 2, `charging-corner` (docs/EXAMPLES-DESIGN.md 6.2, 3.4): the validation of the plant and of every edit of its tips, the figures of its five
// tips (seeds 1 to 5, 8 simulated hours, the tolerance rule of 8.4), the charging wave hour by hour and the findings the Results tab gives on the way.
// Heavy tier: about 32 CPU seconds on worker threads (tests/helpers/ladder-runs.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES } from '../js/model/examples.js';
import { validateLayout } from '../js/model/validate.js';
import { edits, claims } from './helpers/ladder/charging-corner.js';
import { runVariants, checkClaims, seedsWith, hasFinding } from './helpers/ladder-runs.js';

const ID = 'charging-corner';
const example = EXAMPLES.find((e) => e.id === ID);
const variants = {
  // the base run is read at 3, 4.5, 5 and 6 hours as well (the findings of tip 1), and hour by hour (the wave); one charger is read hour by hour too (tip 3)
  base: { example: ID, snapshots: [3, 4.5, 5, 6], hourly: 8 },
  ...Object.fromEntries(Object.keys(edits).map((edit) => [edit, { example: ID, edit, ...(edit === 'ch1' ? { hourly: 8 } : {}) }])),
};
let measured = null;
const runs = () => (measured ??= runVariants(variants));
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
/** Mean over the seeds of the lead time (minutes) of the pallets that left in hour `h` (1-based). */
const leadInHour = (records, h) => mean(records.map((r) => r.hourly.lead[h - 1]));

test('charging-corner: zero validation issues, for the plant and for every edit of the tips', () => {
  assert.deepEqual(validateLayout(example.build()), []);
  for (const [name, edit] of Object.entries(edits)) {
    const layout = example.build();
    edit(layout);
    assert.deepEqual(validateLayout(layout), [], `edit ${name}`);
  }
});

test('charging-corner: every figure of the five tips is reproduced (mean of seeds 1 to 5 over 8 hours)', async () => {
  assert.deepEqual(checkClaims(claims, await runs(), example.tips), []);
  assert.deepEqual([...new Set(claims.map((c) => c.tip))], [1, 2, 3, 4, 5], 'every tip has its numbers');
});

test('charging-corner: the wave of tip 1 - the lead time jumps from 4 to about 20 minutes in hours 4 and 5 and is back at 4 from hour 6 on', async () => {
  const { base } = await runs();
  for (const h of [1, 2, 3, 6, 7, 8]) assert.ok(Math.abs(leadInHour(base, h) - 4.2) < 0.6, `hour ${h}: ${leadInHour(base, h).toFixed(1)} min`);
  assert.ok(leadInHour(base, 4) > 15 && leadInHour(base, 4) < 30, `hour 4: ${leadInHour(base, 4).toFixed(1)} min`);
  assert.ok(leadInHour(base, 5) > 12 && leadInHour(base, 5) < 26, `hour 5: ${leadInHour(base, 5).toFixed(1)} min`);
});

test('charging-corner: tip 3 - with one charger the wave never ends (a pallet waits about 50 minutes from hour 5 on)', async () => {
  const { ch1 } = await runs();
  assert.ok(leadInHour(ch1, 4) > 20, `hour 4: ${leadInHour(ch1, 4).toFixed(1)} min`);
  for (const h of [5, 6, 7, 8]) assert.ok(leadInHour(ch1, h) > 40 && leadInHour(ch1, h) < 65, `hour ${h}: ${leadInHour(ch1, h).toFixed(1)} min`);
});

test('charging-corner: the Results tab on the way - clean at hour 3 and hour 8, the supply warning at 4.5 h, the saturated fleet at hour 5, in every run', async () => {
  const { base, ch1, low0 } = await runs();
  assert.equal(seedsWith(base, (m) => m.ins.length === 0, 3), 5, 'hour 3: no finding');
  assert.equal(seedsWith(base, (m) => hasFinding(m, 'supply', { severity: 'warning' }), 4.5), 5, 'hour 4.5: Goods in delivers more than the plant takes');
  assert.equal(seedsWith(base, (m) => hasFinding(m, 'fleet-saturated', { severity: 'warning' }), 5), 5, 'hour 5: the forklifts are saturated');
  assert.equal(seedsWith(base, (m) => m.ins.length === 0, 8), 5, 'hour 8: "No bottlenecks, congestion or deadlocks found"');
  assert.equal(seedsWith(ch1, (m) => hasFinding(m, 'supply', { severity: 'critical' })), 5, 'one charger: the supply finding is critical');
  assert.equal(seedsWith(low0, (m) => hasFinding(m, 'battery', { severity: 'critical' })), 5, 'flat batteries: the Battery finding is critical');
  assert.equal(seedsWith(low0, (m) => m.dead === 6), 5, 'all six forklifts stop where they stand');
});
