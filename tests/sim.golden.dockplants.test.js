// Golden test of five frozen dock-dense plants (docs/WAREHOUSE-DESIGN.md 10.1, added after the review of milestone M0).
// The three examples and the two dock-lab plants of sim.golden.docks.test.js feel only some of the dock-choice settings (the review changed
// twelve constants of the dock choice and the dock book by 25 to 100 % and those fixtures noticed four), and the warehouse milestones edit
// exactly that code (door queues, the choice of a dock, putaway). These five plants, picked from 60 by greedy cover, notice all twelve, also
// when each is changed by only 4 to 30 % (24 deliberate changes in a scratch copy, none slipped). The layouts are frozen inputs (tests/fixtures/golden/layout.dockplant-<seed>.json), so the net does
// not depend on a generator or on the layout API; the KPI texts are what the tree before M0 (commit eccdca8) made of them.
// Fixtures: tests/fixtures/golden/ (tests/helpers/golden.js; scripts/rebaseline-golden.mjs re-records the KPI texts, never the layouts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../js/sim/engine.js';
import { normalizeLayout, checkInvariants } from '../js/model/layout.js';
import {
  DOCKPLANT_SEEDS, DOCKPLANT_SECONDS, describeDifference, dockPlantKpisFile, dockPlantKpisText, dockPlantLayoutFile, readGolden,
} from './helpers/golden.js';

for (const seed of DOCKPLANT_SEEDS) {
  test(`golden dock plant ${seed}: the KPI report equals the fixture bit for bit`, () => {
    const expected = readGolden(dockPlantKpisFile(seed));
    const actual = dockPlantKpisText(Simulation, readGolden(dockPlantLayoutFile(seed)));
    assert.ok(actual === expected, describeDifference(expected, actual, `The KPI report of dock plant ${seed} after ${DOCKPLANT_SECONDS} s`));
  });
}

test('golden dock plants: the layouts are legacy files that normalizeLayout leaves as they are (schema 1, no ops, no calendar)', () => {
  for (const seed of DOCKPLANT_SEEDS) {
    const text = readGolden(dockPlantLayoutFile(seed));
    const layout = JSON.parse(text);
    assert.equal(layout.schema, 1, `plant ${seed}`);
    assert.equal(JSON.stringify(normalizeLayout(layout)), text, `plant ${seed}: normalizeLayout(x) is x`);
    assert.deepEqual(checkInvariants(layout), [], `plant ${seed}`);
    assert.ok(!('calendar' in layout) && layout.stations.every((s) => !('ops' in s)), `plant ${seed}: nothing of the warehouse module`);
  }
});

test('golden dock plants: the fixtures hold real dock figures (a station whose work is shared between several dock cells, in every plant)', () => {
  for (const seed of DOCKPLANT_SEEDS) {
    const report = JSON.parse(readGolden(dockPlantKpisFile(seed)));
    const docked = Object.values(report.stations).filter((s) => Array.isArray(s.docks));
    const visits = docked.reduce((n, s) => n + s.docks.reduce((m, d) => m + d.visits, 0), 0);
    assert.ok(visits >= 15, `plant ${seed}: ${visits} dock visits`);
    assert.ok(docked.some((s) => s.docks.filter((d) => d.visits > 0).length >= 2), `plant ${seed}: no station uses two of its docks, so the dock choice decides nothing`);
  }
});
