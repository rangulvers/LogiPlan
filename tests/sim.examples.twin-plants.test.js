// Ladder example 11 of the gallery, `twin-plants` (docs/EXAMPLES-DESIGN.md 5, 6.6): the validation of the plant and of every edit of its tips, the figures of
// its six tips (seeds 1 to 5, 8 simulated hours after a 2 hour warm-up, the tolerance rule of 8.4), the findings the Results tab gives, and the stationarity
// of the campus (E18): 24 simulated hours, seeds 1 to 5, no critical finding, no deadlock, no storage at 80 % of its capacity, no more than 1.6 times as many
// loads in the plant at hour 24 as at hour 8. The base run is 24 hours long and read at hour 8 and at hour 24 (tip 1 quotes both).
// Heavy tier: about 170 CPU seconds on worker threads (tests/helpers/ladder-runs.js), its own shard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES } from '../js/model/examples.js';
import { validateLayout } from '../js/model/validate.js';
import { edits, claims } from './helpers/ladder/twin-plants.js';
import { runVariants, checkClaims, seedsWith, hasFinding, meanMetric } from './helpers/ladder-runs.js';

const ID = 'twin-plants';
const example = EXAMPLES.find((e) => e.id === ID);
const variants = { base: { example: ID, hours: 24, snapshots: [8] }, ...Object.fromEntries(Object.keys(edits).map((edit) => [edit, { example: ID, edit }])) };
let measured = null;
const runs = () => (measured ??= runVariants(variants));

test('twin-plants: zero validation issues, for the plant and for every edit of the tips', () => {
  assert.deepEqual(validateLayout(example.build()), []);
  for (const [name, edit] of Object.entries(edits)) {
    const layout = example.build();
    edit(layout);
    assert.deepEqual(validateLayout(layout), [], `edit ${name}`);
  }
});

test('twin-plants: the edit of tip 6 hands the frame shuttle to any vehicle, the edit of tip 3 halves exactly the two bracket flows', () => {
  const name = (l, id) => l.stations.find((s) => s.id === id).name;
  const layout = example.build();
  const shuttle = (l) => l.flows.filter((f) => name(l, f.from) === 'A Frame dispatch' && name(l, f.to) === 'B Frame receiving');
  assert.equal(shuttle(layout).length, 1);
  assert.notEqual(shuttle(layout)[0].fleetId, null, 'a dedicated fleet at the start');
  edits.anyFrame(layout);
  assert.equal(shuttle(layout)[0].fleetId, null, 'any vehicle after the edit');
  const base = example.build();
  const half = example.build();
  edits.brkHalf(half);
  const changed = half.flows.filter((f, i) => f.weight !== base.flows[i].weight);
  assert.deepEqual(changed.map((f) => [name(half, f.from), name(half, f.to), f.weight]), [['Central warehouse', 'A Weld 1', 0.5], ['Central warehouse', 'A Weld 2', 0.5]]);
});

test('twin-plants: every figure of the six tips is reproduced (mean of seeds 1 to 5 over 8 hours; the 186 loads after 24 hours)', async () => {
  assert.deepEqual(checkClaims(claims, await runs(), example.tips), []);
  assert.deepEqual([...new Set(claims.map((c) => c.tip))], [1, 2, 3, 4, 5, 6], 'every tip has its numbers');
});

test('twin-plants: the findings - the one warning at base is the AGVs of plant A, the press lines and the moulding are the bottlenecks at demand 1.5, retail and export trucks leave short', async () => {
  const res = await runs();
  assert.equal(seedsWith(res.base, (m) => hasFinding(m, 'fleet-saturated', { severity: 'warning', text: 'AGVs A' })), 5, 'tip 1: the AGVs of plant A, in every run');
  assert.equal(seedsWith(res.base, (m) => m.ins.every((i) => i.severity === 'info' || i.id.startsWith('fleet-saturated') || i.id.startsWith('breakdowns'))), 5,
    'tip 1: no other warning than the fleet (a Paint machine that broke down for long may add one)');
  assert.ok(seedsWith(res.d15, (m) => hasFinding(m, 'bottleneck', { text: 'Press' })) >= 3, 'tip 4: the press lines are named in at least 3 of 5 runs');
  assert.ok(seedsWith(res.d15, (m) => hasFinding(m, 'bottleneck', { text: 'Moulding' })) >= 3, 'tip 4: the moulding is named in at least 3 of 5 runs');
  for (const gate of ['B Retail gate', 'B Export gate']) assert.equal(seedsWith(res.d15, (m) => hasFinding(m, 'outbound-short', { text: gate })), 5, `tip 4: trucks leave ${gate} short`);
  assert.equal(seedsWith(res.brkHalf, (m) => m.ins.filter((i) => i.severity === 'critical' && i.id.startsWith('blocked') && i.title.includes('A Press')).length === 2), 5,
    'tip 3: both press lines are blocked (critical), in every run');
});

test('twin-plants: tip 3 - with half the brackets the other parts pile up in the central warehouse (about 5 times as full as before)', async () => {
  const res = await runs();
  const ratio = meanMetric(res.brkHalf, 'Centrehouse_fill') / meanMetric(res.base, 'Centrehouse_fill');
  assert.ok(ratio > 4 && ratio < 6.5, `${ratio.toFixed(1)} times as full`);
});

test('twin-plants: the campus settles (E18) - 24 hours, seeds 1 to 5: no critical finding, no deadlock, no storage at 80 %, at most 1.6 times the loads of hour 8', async () => {
  const { base } = await runs();
  for (const rec of base) {
    for (const hour of [8, 24]) {
      const m = rec.at[hour];
      const where = `seed ${rec.seed}, hour ${hour}`;
      assert.equal(m.dl, 0, `${where}: no deadlock`);
      assert.deepEqual(m.ins.filter((i) => i.severity === 'critical'), [], `${where}: no critical finding`);
      for (const [key, value] of Object.entries(m)) if (key.endsWith('_fmax')) assert.ok(value < 80, `${where}: ${key} ${value.toFixed(0)} %`);
    }
    assert.ok(rec.at[24].wipNow <= 1.6 * rec.at[8].wipNow, `seed ${rec.seed}: ${rec.at[8].wipNow} loads at hour 8, ${rec.at[24].wipNow} at hour 24`);
  }
});
