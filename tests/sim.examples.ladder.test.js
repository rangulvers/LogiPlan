// The six ladder examples in the simulation (docs/EXAMPLES-DESIGN.md 8.3, 8.5; acceptance E15 to E18): two simulated hours at seed 1 are healthy (a sane report,
// no deadlock, nobody stands still), the engine runs each at least 500 times real time (the target of 2000 is logged), goods leave within 90 minutes, and the
// components plant settles over 24 simulated hours. (The twin plants' 24 hours are read in tests/sim.examples.twin-plants.test.js from the run its tip 1 needs.)
// The per-tick invariants over 30 simulated minutes of every example are tests/sim.integration.test.js. Heavy tier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLES } from '../js/model/examples.js';
import { Simulation } from '../js/sim/engine.js';
import { createSimChecker } from './helpers/sim-invariants.js';
import { runVariants } from './helpers/ladder-runs.js';

const LADDER = ['hello-pallet', 'charging-corner', 'yard-shuttle', 'morning-peak', 'components-plant', 'twin-plants'];
const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1e6; };
const build = (id) => EXAMPLES.find((e) => e.id === id).build();

for (const id of LADDER) {
  test(`${id}: 2 simulated hours at seed 1 are healthy and goods leave within 90 minutes (E15, E17)`, () => {
    const sim = new Simulation(build(id), { seed: 1 });
    const checker = createSimChecker(sim, { traffic: false, logistics: false });
    let firstLoad = null;
    sim.on('loadCompleted', (p) => { if (firstLoad === null) firstLoad = p.t / 60; });
    sim.advance(2 * 3600);
    checker.checkReport(); // finite numbers, shares that sum to 1, ordered percentiles
    const report = sim.kpis();
    assert.equal(report.traffic.deadlocks, 0, 'no deadlock');
    assert.deepEqual(checker.stuck({ seconds: 900 }), [], 'nobody stands still for 15 minutes');
    assert.ok(sim.logistics.completed > 0, 'goods left the plant');
    assert.ok(firstLoad !== null && firstLoad <= 90, `the first load left at minute ${firstLoad === null ? 'never' : firstLoad.toFixed(0)}`);
  });

  test(`${id}: at least 500 times real time (best of 3 runs of an hour after the warm-up; the target is 2000) (E16)`, () => {
    let best = Infinity;
    for (let run = 0; run < 3; run++) {
      const sim = new Simulation(build(id), { seed: 1 });
      sim.advance(600);
      const t0 = cpu();
      sim.advance(3600);
      best = Math.min(best, cpu() - t0);
    }
    const factor = 3600 / Math.max(best, 1e-6);
    console.log(`# ${id}: ${Math.round(factor)} x real time (${best.toFixed(3)} CPU s per simulated hour; gate 500, target 2000)`);
    assert.ok(factor >= 500, `${Math.round(factor)} x real time`);
  });
}

test('components-plant settles (E18): 24 simulated hours, seeds 1 to 3: no deadlock, nothing critical at hour 24, no storage at 80 %, at most 1.6 times the loads of hour 8', async () => {
  const { base } = await runVariants({ base: { example: 'components-plant', hours: 24, snapshots: [8] } }, { seeds: [1, 2, 3] });
  for (const rec of base) {
    for (const hour of [8, 24]) {
      const m = rec.at[hour];
      assert.equal(m.dl, 0, `seed ${rec.seed}, hour ${hour}: no deadlock`);
      for (const [key, value] of Object.entries(m)) if (key.endsWith('_fmax')) assert.ok(value < 80, `seed ${rec.seed}, hour ${hour}: ${key} ${value.toFixed(0)} %`);
    }
    assert.deepEqual(rec.at[24].ins.filter((i) => i.severity === 'critical'), [], `seed ${rec.seed}: nothing critical at hour 24`);
    assert.ok(rec.at[24].wipNow <= 1.6 * rec.at[8].wipNow, `seed ${rec.seed}: ${rec.at[8].wipNow} loads at hour 8, ${rec.at[24].wipNow} at hour 24`);
  }
});
