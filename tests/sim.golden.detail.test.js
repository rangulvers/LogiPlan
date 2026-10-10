// Golden neutrality of the detail collector (docs/ENTITY-INSIGHTS-DESIGN.md 6.7, acceptance S1.1): every recorded golden run, repeated with sim.enableDetail(), must still
// equal its fixture text character for character. The collector only reads; it must never move a KPI by one bit. (tests/sim.golden.*.test.js are the runs without it.)
//   * the 13 recorded KPI texts: three legacy examples x seeds 1 and 2, the two dock-lab variants, the five frozen dock-dense plants
//   * the collector switched on, off, on again in the middle of a run changes nothing (KPI text and heat map)
//   * the two warehouse examples (no fixture): kpis, heat and vehicle poses with the collector on equal those without
//   * a plain `new Simulation(layout)` has no collector (`detail === null`) and no listener of its own
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../js/sim/engine.js';
import { EXAMPLES } from '../js/model/examples.js';
import * as L from '../js/model/layout.js';
import {
  DOCKPLANT_SEEDS, DOCKPLANT_SECONDS, DOCK_SECONDS, DOCK_SEED, DOCK_VARIANTS, GOLDEN_SECONDS, GOLDEN_SEEDS, GOLDEN_WARMUP, LEGACY_EXAMPLE_IDS, describeDifference, dockKpisFile, dockLabLayout,
  dockPlantKpisFile, dockPlantLayoutFile, kpisFile, readGolden,
} from './helpers/golden.js';

const same = (actual, expected, what) => assert.ok(actual === expected, describeDifference(expected, actual, what));

for (const id of LEGACY_EXAMPLE_IDS) {
  for (const seed of GOLDEN_SEEDS) {
    test(`golden ${id} seed ${seed} with the collector on: the KPI report equals the fixture bit for bit`, () => {
      const layout = EXAMPLES.find((e) => e.id === id).build();
      layout.settings.warmup = GOLDEN_WARMUP;
      const sim = new Simulation(layout, { seed });
      const det = sim.enableDetail();
      sim.advance(GOLDEN_SECONDS);
      same(JSON.stringify(sim.kpis()), readGolden(kpisFile(id, seed)), `The KPI report of ${id} with seed ${seed} and the collector on`);
      assert.ok(det.legs.count > 0 && sim.detail === det, 'the collector was really running');
    });
  }
}

for (const variant of DOCK_VARIANTS) {
  test(`golden docks-${variant} with the collector on: the KPI report equals the fixture bit for bit`, () => {
    const sim = new Simulation(dockLabLayout(L, variant), { seed: DOCK_SEED });
    const det = sim.enableDetail();
    sim.advance(DOCK_SECONDS);
    same(JSON.stringify(sim.kpis()), readGolden(dockKpisFile(variant)), `The KPI report of the ${variant} dock plant with the collector on`);
    assert.ok(det.legs.count > 0);
  });
}

for (const seed of DOCKPLANT_SEEDS) {
  test(`golden dock plant ${seed} with the collector on: the KPI report equals the fixture bit for bit`, () => {
    const sim = new Simulation(JSON.parse(readGolden(dockPlantLayoutFile(seed))));
    const det = sim.enableDetail();
    sim.advance(DOCKPLANT_SECONDS);
    same(JSON.stringify(sim.kpis()), readGolden(dockPlantKpisFile(seed)), `The KPI report of the frozen dock plant ${seed} with the collector on`);
    assert.ok(det.nV > 0);
  });
}

test('golden: the collector switched on, off and on again in the middle of a run changes no figure (KPI text, heat map, positions)', () => {
  for (const [id, seed] of [['two-lines', 1], ['congestion-lab', 2]]) {
    const run = (toggle) => {
      const layout = EXAMPLES.find((e) => e.id === id).build();
      layout.settings.warmup = GOLDEN_WARMUP;
      const sim = new Simulation(layout, { seed });
      if (toggle) {
        sim.enableDetail(); sim.advance(900);
        sim.disableDetail(); sim.advance(900);
        sim.enableDetail(); sim.advance(GOLDEN_SECONDS - 1800);
      } else sim.advance(GOLDEN_SECONDS);
      return JSON.stringify(sim.kpis()) + JSON.stringify(Array.from(sim.heat().nodeWait)) + JSON.stringify(sim.vehicles.map((v) => [v.x, v.y, v.state]));
    };
    same(run(true), run(false), `${id} with the collector toggled`);
    assert.ok(run(false).startsWith(readGolden(kpisFile(id, seed))), `${id}: the run without a collector is still the fixture`);
  }
});

test('the warehouse examples (no fixture): kpis, heat map and vehicle poses with the collector on equal those without', () => {
  for (const id of ['dock-lab', 'warehouse-first-day']) {
    const run = (on) => {
      const sim = new Simulation(EXAMPLES.find((e) => e.id === id).build(), { seed: 1 });
      if (on) sim.enableDetail();
      sim.advance(7200);
      return JSON.stringify(sim.kpis()) + JSON.stringify(Array.from(sim.heat().nodeWait)) + JSON.stringify(sim.vehicles.map((v) => [v.x, v.y, v.state]));
    };
    same(run(true), run(false), `${id} with the collector on`);
  }
});

test('a plain Simulation has no collector and no listeners; experiments and headless runs never create one', async () => {
  const { runSimulation } = await import('../js/sim/experiments.js');
  const sim = new Simulation(EXAMPLES.find((e) => e.id === 'starter').build(), { seed: 1 });
  assert.equal(sim.detail, null);
  assert.equal(sim._listeners.size, 0);
  sim.advance(600);
  assert.equal(sim.detail, null);
  let seen = 0;
  const RealStep = Simulation.prototype.step;
  Simulation.prototype.step = function stepWatch(dt) { if (this.detail !== null) seen++; return RealStep.call(this, dt); };
  try { await runSimulation(EXAMPLES.find((e) => e.id === 'starter').build(), { duration: 600, warmup: 60, seed: 1 }); } finally { Simulation.prototype.step = RealStep; }
  assert.equal(seen, 0, 'runSimulation never turns the collector on');
});
