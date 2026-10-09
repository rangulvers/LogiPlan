// Golden test of two small plants with several dock cells at one Goods in (docs/WAREHOUSE-DESIGN.md Appendix C: "six docks in a row" and
// "three separate side roads", 8 forklifts, 3 simulated hours, seed 3). Added to the safety net of the three examples because the
// examples never let the dock choice decide anything in their first hour: with the dock book switched off their KPI texts stay the same.
// Here the choice matters (Appendix C: the bays give visits 311, 155, 2 with the dock book and 397, 0, 0 without), so a change of the
// dock book, of the dispatcher's use of it or of the dock cells of a station shows up as a different KPI text.
// Fixtures: tests/fixtures/golden/ (tests/helpers/golden.js; scripts/rebaseline-golden.mjs re-records them).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../js/sim/engine.js';
import * as L from '../js/model/layout.js';
import { DOCK_VARIANTS, describeDifference, dockKpisFile, dockKpisText, readGolden } from './helpers/golden.js';

for (const variant of DOCK_VARIANTS) {
  test(`golden docks ${variant}: the KPI report equals the fixture bit for bit`, () => {
    const expected = readGolden(dockKpisFile(variant));
    const actual = dockKpisText(Simulation, L, variant);
    assert.ok(actual === expected, describeDifference(expected, actual, `The KPI report of the dock lab (${variant})`));
  });
}

test('golden docks: the fixtures hold real dock figures (visits per dock cell)', () => {
  for (const variant of DOCK_VARIANTS) {
    const report = JSON.parse(readGolden(dockKpisFile(variant)));
    const goodsIn = Object.values(report.stations).find((s) => s.name === 'Goods in');
    assert.equal(goodsIn.docks.length, variant === 'row' ? 6 : 3, `${variant}: dock cells of Goods in`);
    assert.ok(goodsIn.docks.reduce((n, d) => n + d.visits, 0) > 100, `${variant}: many visits`);
  }
  const bays = Object.values(JSON.parse(readGolden(dockKpisFile('bays'))).stations).find((s) => s.name === 'Goods in');
  assert.ok(bays.docks.filter((d) => d.visits > 20).length >= 2, 'with side roads at least two docks share the work');
});
