// Containment of the detail collector (docs/ENTITY-INSIGHTS-DESIGN.md 6.6, acceptance S1.2): the collector is optional and must not be able to stop or change a run.
//   * Logistics.removeVehicle in the middle of a run with the collector on, on every hostile truck plant that has such an action: step() never throws, the collector stays
//     attached (it re-allocates and restarts its window with a notice), the kpis equal the run without a collector, and the split adds up to the restarted window.
//     The first reference collector threw "Cannot read properties of undefined (reading 'stateSince')" on every later tick in 70 of the 94 plants with a removal.
//   * a listener that throws and an afterTick that throws on a hostile plant: the run completes, sim.detail === null, sim.detailError is set, the kpis are equal
//     (the same two forced failures on the Two lines example are in sim.detail.regress.test.js, STAT-THROW).
// HEAVY: every plant is run twice (with and without the collector) for 1500 simulated seconds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../js/sim/engine.js';
import { SLOT_KEYS } from '../js/sim/detail.js';
import { hostileTruckPlant } from './helpers/m1-sim-review-gen.js';

const HORIZON = 1500;
const SEEDS = 220;
const total = (t) => SLOT_KEYS.reduce((n, k) => n + t[k], 0);

/** Run a hostile truck plant with its actions (demand changes, vehicle removals), with or without the collector. */
function run(layout, actions, seed, on, hooks = {}) {
  const sim = new Simulation(layout, { seed });
  if (on) { const det = sim.enableDetail(); if (hooks.detail) hooks.detail(det); }
  const pending = actions.map((a) => ({ ...a }));
  while (sim.time < HORIZON) {
    while (pending.length && pending[0].at <= sim.time + 1e-9) {
      const a = pending.shift();
      if (a.kind === 'demand') { if (a.value === 0) sim.logistics.setRuntime({ demandFactor: 0 }); else sim.setRuntime({ demandFactor: a.value }); }
      else if (a.kind === 'removeVehicle' && sim.logistics.vehicles.length) sim.logistics.removeVehicle(sim.logistics.vehicles[a.index % sim.logistics.vehicles.length]);
    }
    sim.step();
  }
  return sim;
}

test(`containment: removeVehicle mid-run with the collector on, on every hostile truck plant of seeds 1 to ${SEEDS} that removes a vehicle`, () => {
  let withRemoval = 0; let notices = 0; let stillAttached = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const { layout, actions } = hostileTruckPlant(seed, { horizon: HORIZON });
    if (!actions.some((a) => a.kind === 'removeVehicle')) continue;
    withRemoval++;
    const off = run(layout, actions, seed, false);
    const on = run(layout, actions, seed, true); // must not throw out of step()
    assert.equal(JSON.stringify(on.kpis()), JSON.stringify(off.kpis()), `seed ${seed}: the collector changed a figure`);
    assert.equal(on.detailError, null, `seed ${seed}: dropped (${on.detailError})`);
    const det = on.detail;
    assert.notEqual(det, null, `seed ${seed}: the collector was dropped`);
    stillAttached++;
    if (det.notices.length) notices++;
    for (let i = 0; i < det.nV; i++) assert.ok(Math.abs(total(det.timeSplit(i)) - (on.time - det.windowStart)) < 1e-6, `seed ${seed} vehicle ${i}: the split does not add up to the window`);
    assert.equal(det.nV, on.vehicles.length);
  }
  assert.ok(withRemoval >= 80, `${withRemoval} plants with a removal (the spike had 94 in seeds 1 to 220)`);
  assert.equal(stillAttached, withRemoval);
  assert.ok(notices >= 0.5 * withRemoval, `${notices} of ${withRemoval} runs show the "counting again" notice (a removal of the last vehicle of a plant that already lost it shows none)`);
});

test('containment: a listener that throws and an afterTick that throws on hostile truck plants: the run completes, the collector is dropped, the kpis are equal', () => {
  let n = 0;
  for (let seed = 3; seed <= 63; seed += 6) {
    const { layout, actions } = hostileTruckPlant(seed, { horizon: HORIZON });
    const plain = actions.filter((a) => a.kind !== 'removeVehicle');
    const reference = JSON.stringify(run(layout, plain, seed, false).kpis());
    for (const how of ['listener', 'afterTick']) {
      const sim = run(layout, plain, seed, true, {
        detail: (det) => {
          if (how === 'listener') { det.onCompleted = () => { throw new Error('boom'); }; det.onDelivered = () => { throw new Error('boom'); }; det.onPicked = () => { throw new Error('boom'); }; } else {
            const orig = det.afterTick.bind(det); let k = 0;
            det.afterTick = (dt, fresh) => { if (++k === 400) throw new Error('boom'); orig(dt, fresh); };
          }
        },
      });
      assert.equal(JSON.stringify(sim.kpis()), reference, `seed ${seed} ${how}`);
      if (sim.detail === null) { assert.ok(sim.detailError instanceof Error && /boom/.test(sim.detailError.message), `seed ${seed} ${how}: reason kept`); n++; } else assert.equal(how, 'listener', 'a plant without any delivery has nothing for a listener to throw on');
    }
  }
  assert.ok(n >= 10, `${n} forced failures were contained and dropped`);
});
