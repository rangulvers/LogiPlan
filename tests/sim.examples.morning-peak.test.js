// Ladder example 9 of the gallery, `morning-peak` (docs/EXAMPLES-DESIGN.md 6.4): the validation of the plant and of every edit of its tips (four doors at
// the supplier gate give exactly one doors-too-few warning, the check of the Checks tab that says 4.8 are needed), the figures of its six tips (seeds 1 to 5,
// 8 simulated hours = the clock at 14:00, the tolerance rule of 8.4), the queue that is not yet there at 10:00 and the findings of the Results tab.
// Heavy tier: about 42 CPU seconds on worker threads (tests/helpers/ladder-runs.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES } from '../js/model/examples.js';
import { validateLayout } from '../js/model/validate.js';
import { edits, claims } from './helpers/ladder/morning-peak.js';
import { runVariants, checkClaims, seedsWith, hasFinding, meanMetric } from './helpers/ladder-runs.js';

const ID = 'morning-peak';
const example = EXAMPLES.find((e) => e.id === ID);
// the base run is read at 10:00 (4 hours after the start at 06:00) as well: a wait is booked when a truck reaches a door, so the queue of the peak is not in the figures yet
const variants = { base: { example: ID, snapshots: [4] }, ...Object.fromEntries(Object.keys(edits).map((edit) => [edit, { example: ID, edit }])) };
let measured = null;
const runs = () => (measured ??= runVariants(variants));

test('morning-peak: zero validation issues, except one doors-too-few warning with four doors (tip 6)', () => {
  assert.deepEqual(validateLayout(example.build()), []);
  for (const [name, edit] of Object.entries(edits)) {
    const layout = example.build();
    edit(layout);
    const issues = validateLayout(layout);
    if (name === 'doors4') {
      assert.deepEqual(issues.map((i) => `${i.severity}:${i.code}`), ['warning:doors-too-few']);
      assert.match(issues[0].message, /4\.8/, 'the Checks tab says that 4.8 doors are needed at the busiest hour');
    } else assert.deepEqual(issues, [], `edit ${name}`);
  }
});

test('morning-peak: every figure of the six tips is reproduced (mean of seeds 1 to 5 over 8 hours, the clock at 14:00)', async () => {
  assert.deepEqual(checkClaims(claims, await runs(), example.tips), []);
  assert.deepEqual([...new Set(claims.map((c) => c.tip))], [1, 2, 3, 4, 5, 6], 'every tip has its numbers');
});

test('morning-peak: at 10:00 the gate looks quiet (the wait is booked when a truck reaches a door), at 14:00 it is not', async () => {
  const { base } = await runs();
  assert.ok(meanMetric(base, 'Suppliers_gate', 4) < 3, `10:00 gate wait ${meanMetric(base, 'Suppliers_gate', 4).toFixed(1)} min`);
  assert.ok(meanMetric(base, 'Suppliers_gate', 8) > 15, `14:00 gate wait ${meanMetric(base, 'Suppliers_gate', 8).toFixed(1)} min`);
});

test('morning-peak: the Results tab says it is the forklifts and not the doors, the gate queue is long, a two-way ring costs meetings, six forklifts send trucks away short', async () => {
  const res = await runs();
  assert.equal(seedsWith(res.base, (m) => hasFinding(m, 'fleet-saturated', { text: 'Forklifts' })), 5);
  assert.equal(seedsWith(res.base, (m) => hasFinding(m, 'unload-limited-by-vehicles', { text: 'Suppliers' })), 5);
  assert.equal(seedsWith(res.base, (m) => hasFinding(m, 'gate-queue-long', { text: 'Suppliers' })), 5);
  assert.equal(seedsWith(res.twoWay, (m) => hasFinding(m, 'traffic')), 5, 'tip 5: the Traffic finding appears');
  for (const gate of ['Stores west', 'Stores east', 'Express']) {
    assert.equal(seedsWith(res.f6, (m) => hasFinding(m, 'outbound-short', { text: gate })), 5, `tip 3: trucks leave ${gate} short`);
  }
  assert.equal(seedsWith(res.base, (m) => m.dl === 0), 5, 'no deadlock');
});
