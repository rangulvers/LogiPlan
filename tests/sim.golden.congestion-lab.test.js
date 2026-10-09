// Golden test of the example "Congestion lab" (docs/WAREHOUSE-DESIGN.md 10.1): the safety net of the warehouse module.
// After one simulated hour (warm-up 600 s) with seeds 1 and 2 the KPI report, written with JSON.stringify, must equal the recorded
// fixture character for character, i.e. bit for bit. A plant that uses none of the new features must never change its results.
// Fixtures: tests/fixtures/golden/ (tests/helpers/golden.js says what is in them; scripts/rebaseline-golden.mjs re-records them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../js/sim/engine.js';
import { EXAMPLES } from '../js/model/examples.js';
import {
  GOLDEN_SEEDS, GOLDEN_SECONDS, GOLDEN_WARMUP, describeDifference, goldenKpisText, kpisFile, layoutFile, readGolden,
} from './helpers/golden.js';

const ID = 'congestion-lab';
const example = EXAMPLES.find((e) => e.id === ID);

test('golden congestion-lab: the example is still the recorded layout', () => {
  assert.ok(example, `example ${ID} exists`);
  const expected = readGolden(layoutFile(ID));
  const actual = JSON.stringify(example.build());
  assert.ok(actual === expected, describeDifference(expected, actual, 'The layout of the example'));
});

for (const seed of GOLDEN_SEEDS) {
  test(`golden congestion-lab seed ${seed}: the KPI report equals the fixture bit for bit`, () => {
    const expected = readGolden(kpisFile(ID, seed));
    const actual = goldenKpisText(Simulation, example, seed);
    assert.ok(actual === expected, describeDifference(expected, actual, `The KPI report of ${ID} with seed ${seed}`));
  });

  test(`golden congestion-lab seed ${seed}: the fixture is a real measurement, not an empty report`, () => {
    const report = JSON.parse(readGolden(kpisFile(ID, seed)));
    assert.equal(report.window.warmingUp, false);
    assert.ok(Math.abs(report.window.start - GOLDEN_WARMUP) < 1 && Math.abs(report.window.duration - (GOLDEN_SECONDS - GOLDEN_WARMUP)) < 1, 'the window is the hour minus the warm-up');
    assert.ok(report.throughput.total > 0, 'loads were delivered');
    assert.ok(Object.keys(report.stations).length >= 4 && Object.keys(report.fleets).length >= 1, 'stations and fleets are reported');
    assert.ok(report.series.t.length >= 10, 'the time series has points');
    assert.ok(Object.values(report.fleets).some((f) => f.trips > 0), 'vehicles drove');
  });
}
