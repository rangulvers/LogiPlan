// Cost of trucks and dock doors (docs/WAREHOUSE-DESIGN.md 10.5, acceptance A1.16 for the simulation side): a plant whose Goods in and Goods out have trucks
// must still simulate at least 500 times faster than real time (CPU time, as tests/sim.traffic.perf.test.js measures), and a plant WITHOUT trucks pays one
// pointer test per station and tick, which no test can see: the legacy numbers are compared with scripts/perf-baseline.mjs --root (a manual line of the
// pull request). The measured factors are logged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dist } from '../js/model/defaults.js';
import { EXAMPLES } from '../js/model/examples.js';
import { convertToDoors } from '../js/model/doors.js';
import { updateStation } from '../js/model/layout.js';
import { Simulation } from '../js/sim/engine.js';
import { microPlant } from './helpers/trucks-gen.js';

const cpuSeconds = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1e6;
};

const REQUIRED_FACTOR = 500; // real-time factor (CPU time) that must be reached on any machine
const TARGET_FACTOR = 2000; // the target of the design for a new example (10.5): logged, not asserted (a busy CI machine)
const HOURS = 2;

/** An example with "Add dock doors" pressed on every Goods in and Goods out, the way the inspector button does it. */
function withDoors(example) {
  const layout = example.build();
  for (const st of layout.stations) {
    if (st.type !== 'source' && st.type !== 'sink') continue;
    const trucks = convertToDoors(st);
    if (trucks) updateStation(layout, st.id, { ops: { trucks } });
  }
  return layout;
}

/** The reference warehouse of 8.1 in miniature: a Goods in with 3 doors in rate mode, a Storage, a Goods out with 2 doors, 5 forklifts. */
function firstDay() {
  return microPlant({
    storage: true,
    inbound: { doors: 3, checkIn: 300, checkOut: 300, interArrival: dist('normal', 1800, 0.3), pallets: dist('uniform', 24, 0.25) },
    outbound: { doors: 2, checkIn: 300, checkOut: 300, interArrival: dist('normal', 1800, 0.3), pallets: dist('uniform', 24, 0.25), staging: 4, maxDwell: 3600 },
    fleet: { count: 5 },
  });
}

/** CPU seconds per simulated hour: the best of three fresh simulations (the first one also warms the code up). */
function costPerHour(build) {
  let best = Infinity;
  let trucks = 0;
  for (let round = 0; round < 3; round++) {
    const sim = new Simulation(build(), { seed: 1 });
    const t0 = cpuSeconds();
    sim.advance(HOURS * 3600);
    best = Math.min(best, (cpuSeconds() - t0) / HOURS);
    trucks = sim.logistics.truckSeq;
  }
  return { cost: best, trucks };
}

test('A1.16 (sim): the three examples with dock doors on every Goods in and Goods out simulate at least 500x real time (target 2000x), and the doors really work', (t) => {
  for (const example of EXAMPLES) {
    const { cost, trucks } = costPerHour(() => withDoors(example));
    const factor = 3600 / cost;
    t.diagnostic(`${example.name} with doors: ${cost.toFixed(3)} CPU s per simulated hour = ${Math.round(factor)}x real time, ${trucks} trucks in ${HOURS} h`);
    assert.ok(trucks >= 2, `${example.name}: trucks came (${trucks})`);
    assert.ok(factor >= REQUIRED_FACTOR, `${example.name}: ${Math.round(factor)}x real time, required ${REQUIRED_FACTOR}x`);
  }
});

test('A1.16 (sim): a first-day warehouse (3 doors in, 2 doors out, 5 forklifts) simulates at least 500x real time (target 2000x)', (t) => {
  const { cost, trucks } = costPerHour(firstDay);
  const factor = 3600 / cost;
  t.diagnostic(`first day: ${cost.toFixed(3)} CPU s per simulated hour = ${Math.round(factor)}x real time, ${trucks} trucks in ${HOURS} h`);
  assert.ok(trucks >= 6);
  assert.ok(factor >= REQUIRED_FACTOR, `${Math.round(factor)}x real time, required ${REQUIRED_FACTOR}x`);
  if (factor < TARGET_FACTOR) t.diagnostic(`below the target of ${TARGET_FACTOR}x`);
});
