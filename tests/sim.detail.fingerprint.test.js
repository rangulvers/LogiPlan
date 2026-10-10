// Full-state fingerprint of 80 hostile plants with the detail collector switched on, off and on again in the middle of a run (docs/ENTITY-INSIGHTS-DESIGN.md 6.7, 13.3 t8;
// acceptance S1.1): positions, states, odometers, counters and the KPI text must equal those of a run that never had a collector. HEAVY.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../js/sim/engine.js';
import { fingerprint, hostilePlant } from './helpers/engine-review-gen.js';
import { hostileTruckPlant } from './helpers/m1-sim-review-gen.js';

/** One plant: the fingerprint after 1200 s without a collector, and with one switched on at 0, off at 300, on at 600. */
function compare(layout, seed) {
  const plain = new Simulation(layout, { seed });
  plain.advance(1200);
  const toggled = new Simulation(layout, { seed });
  toggled.enableDetail(); toggled.advance(300);
  toggled.disableDetail(); toggled.advance(300);
  toggled.enableDetail(); toggled.advance(600);
  return [fingerprint(plain), fingerprint(toggled), toggled];
}

test('fingerprint: 40 hostile plants and 40 hostile truck plants run identically with the collector on, off and on in the middle', () => {
  let same = 0; let made = 0; let attached = 0;
  const check = (name, layout) => {
    const [a, b, sim] = compare(layout, 3);
    assert.equal(b, a, `${name}: the state differs when the collector is toggled`);
    same++;
    if (sim.detail !== null) attached++;
  };
  for (let seed = 1; seed <= 40; seed++) { let layout; try { layout = hostilePlant(seed); } catch { continue; } made++; check(`hostile ${seed}`, layout); }
  for (let seed = 1; seed <= 40; seed++) { made++; check(`truck plant ${seed}`, hostileTruckPlant(seed, { horizon: 1200 }).layout); }
  assert.equal(same, made);
  assert.ok(made >= 70, `${made} plants (the spike had 80 of 80)`);
  assert.ok(attached >= made - 2, `${attached} of ${made} collectors still attached at the end (a plant without a fleet may drop nothing, a failure would show here)`);
});
