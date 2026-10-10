// Determinism of the detail collector (docs/ENTITY-INSIGHTS-DESIGN.md 6.5, acceptance S1.4): what it recorded is a pure function of the plant and the seed, not of how the run
// was cut into slices, and asking a question changes nothing it records next.
//   * a straight run, a repeat, 7.3 s slices (the warm restart's pre-roll), a run cut in two and a pre-roll of a fresh simulation end with the same digest (seeds 1 to 3)
//   * a run in which EVERY query is called every 7 s ends with the same digest as a run without queries (three plants)
//   * ticks of 0.3 s and 0.5 s: slices do not matter there either
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../js/sim/engine.js';
import { EXAMPLES } from '../js/model/examples.js';
import { callEveryQuery, detailDigest } from './helpers/detail-digest.js';

const make = (id, seed, warmup = 600, dt) => {
  const layout = EXAMPLES.find((e) => e.id === id).build();
  layout.settings.warmup = warmup;
  if (dt) layout.settings.dt = dt;
  const sim = new Simulation(layout, { seed });
  sim.enableDetail();
  return sim;
};
const sliced = (sim, until, slice) => { while (until - sim.time > sim.dt * 1e-6) sim.advance(Math.min(slice, until - sim.time)); return sim; };

for (const id of ['two-lines', 'warehouse-first-day']) {
  for (const seed of [1, 2, 3]) {
    test(`${id} seed ${seed}: straight, repeat, 7.3 s slices and a run cut in two record the same`, () => {
      const a = make(id, seed); a.advance(2400);
      const b = make(id, seed); b.advance(2400);
      const c = sliced(make(id, seed), 2400, 7.3);
      const d = make(id, seed); d.advance(900); d.advance(1500);
      const da = detailDigest(a.detail);
      assert.equal(detailDigest(b.detail), da, 'repeat');
      assert.equal(detailDigest(c.detail), da, '7.3 s slices');
      assert.equal(detailDigest(d.detail), da, 'cut at 900 s');
      assert.ok(a.detail.legs.count > 30, 'the digest covers a real record');
    });
  }
}

test('warm restart: a collector enabled before the pre-roll of a new simulation equals a straight run to the same time; the old one goes with the old simulation', () => {
  for (const seed of [1, 2, 3]) {
    const old = make('two-lines', seed); old.advance(1805);
    const fresh = sliced(make('two-lines', seed), 1200, 12 / 1000 * 600);
    const straight = make('two-lines', seed); straight.advance(1200);
    assert.equal(detailDigest(fresh.detail), detailDigest(straight.detail), `seed ${seed}`);
    assert.ok(old.detail.legs.count > 0);
  }
});

for (const dt of [0.3, 0.5]) {
  test(`ticks of ${dt} s: slices and repeats record the same`, () => {
    const a = make('two-lines', 1, 600, dt); a.advance(2000);
    const c = sliced(make('two-lines', 1, 600, dt), 2000, 7.3);
    const d = make('two-lines', 1, 600, dt); d.advance(777); d.advance(1223);
    assert.equal(detailDigest(c.detail), detailDigest(a.detail));
    assert.equal(detailDigest(d.detail), detailDigest(a.detail));
  });
}

for (const id of ['two-lines', 'warehouse-first-day', 'dock-lab']) {
  test(`${id}: calling every query every 7 s does not change what is recorded`, () => {
    const quiet = make(id, 2); quiet.advance(3600);
    const asked = make(id, 2);
    while (3600 - asked.time > asked.dt * 1e-6) { asked.advance(Math.min(7, 3600 - asked.time)); callEveryQuery(asked.detail); }
    assert.equal(detailDigest(asked.detail), detailDigest(quiet.detail));
    assert.equal(JSON.stringify(asked.kpis()), JSON.stringify(quiet.kpis()));
  });
}

test('the digest is sensitive: other seeds, other plants and one more second all record differently', () => {
  const a = make('two-lines', 1); a.advance(2400);
  const b = make('two-lines', 2); b.advance(2400);
  const c = make('two-lines', 1); c.advance(2401);
  const d = make('warehouse-first-day', 1); d.advance(2400);
  const digests = new Set([a, b, c, d].map((s) => detailDigest(s.detail)));
  assert.equal(digests.size, 4);
});
