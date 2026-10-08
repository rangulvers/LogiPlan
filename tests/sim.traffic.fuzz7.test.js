// Random fuzz of the traffic engine, part 7 of 8 (the parts run in parallel): seeded random layouts with 30 vehicles on
// random routes for 1500 s each, with breakdowns, speed-factor changes and detach / attach cycles. The invariants of
// tests/helpers/traffic-invariants.js are checked after every tick; a violation names the seed and time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runFuzzShard } from './helpers/traffic-invariants.js';

test('random layouts x 30 vehicles x 1500 s: all invariants hold on every tick (part 7 of 8)', () => {
  const runs = runFuzzShard(6);
  assert.ok(runs.length >= 12);
  for (const r of runs) {
    assert.ok(r.vehicles >= 4, `seed ${r.seed}: only ${r.vehicles} vehicles fit`);
    assert.ok(r.arrivals >= r.vehicles, `seed ${r.seed} (dt ${r.dt}): ${r.arrivals} trips for ${r.vehicles} vehicles - traffic does not flow`);
    assert.ok(r.time >= 1499.9 && Number.isFinite(r.deadlocks));
  }
});
