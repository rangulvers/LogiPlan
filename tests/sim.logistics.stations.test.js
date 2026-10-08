// Logistics: what happens inside stations - arrivals, the yard, output splitting, machine cycles, bills of
// materials, breakdowns, blocking, storage and sinks. Most tests run without vehicles (loads are injected or
// stay where they are) so each rule is checked in isolation, with exactly computable expectations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutFromAscii } from './helpers/ascii.js';
import { createWorld, drainOut, injectLoads } from './helpers/logistics-invariants.js';
import { Swrr } from '../js/sim/logistics/swrr.js';
import { dist } from '../js/model/defaults.js';

const OFF = dist('const', 0); // a source with mean inter-arrival 0 never produces
const times = (events, name) => events.filter((e) => e.name === name).map((e) => e.payload.t);

/** Stations without roads or vehicles: only the station logic is under test. */
function bare(stations, flows = [], settings = {}) {
  return layoutFromAscii([Object.keys(stations).join('.')], { stations, flows, fleets: [], settings });
}

// ---- smooth weighted round-robin ---------------------------------------------------------------------------------

test('swrr: weights 3:1 give exactly 75/25 over any 4 picks and never bunch', () => {
  const s = new Swrr([3, 1]);
  const picks = Array.from({ length: 400 }, () => s.pick(() => true));
  for (let i = 0; i < 400; i += 4) assert.equal(picks.slice(i, i + 4).filter((p) => p === 0).length, 3);
  assert.ok(!picks.join('').includes('0000'), 'the minority entry is spread out (a a b a, never a a a a)');
  assert.deepEqual(picks.slice(0, 8), [0, 0, 1, 0, 0, 0, 1, 0]);
});

test('swrr: ineligible entries are skipped without distorting later shares; zero weights are never picked', () => {
  const s = new Swrr([1, 1, 0]);
  assert.equal(s.pick((i) => i === 1), 1);
  assert.equal(s.pick(() => false), -1);
  const counts = [0, 0, 0];
  for (let i = 0; i < 100; i++) counts[s.pick(() => true)]++;
  assert.deepEqual(counts, [50, 50, 0]);
  const only = new Swrr([0, 0]);
  const fallback = [0, 0];
  for (let i = 0; i < 10; i++) fallback[only.pick(() => true)]++;
  assert.deepEqual(fallback, [5, 5], 'all-zero weights share equally rather than stranding loads');
  assert.equal(s.pick((i) => i === 2), -1, 'an entry without a share receives nothing even when every other entry is full: the loads wait');
  assert.equal(new Swrr([]).pick(() => true), -1);
  assert.deepEqual(Array.from({ length: 5 }, () => new Swrr([NaN, -2, 3]).pick(() => true)), [2, 2, 2, 2, 2], 'junk weights get no share');
});

// ---- sources -----------------------------------------------------------------------------------------------------------

test('source: first arrival at startDelay, then a constant interval, loads carry their exact creation time', () => {
  const layout = bare({ A: { type: 'source', params: { interArrival: dist('const', 10), startDelay: 5 } } });
  const w = createWorld(layout, { dt: 0.5, check: true });
  w.run(100);
  const created = w.named('loadCreated').map((p) => p.load.createdAt);
  assert.deepEqual(created, [5, 15, 25, 35, 45, 55, 65, 75, 85, 95]);
  const st = w.lg.stationById.get('A');
  assert.equal(st.arrivals, 10);
  assert.equal(st.produced, 10);
  assert.equal(w.lg.liveLoads, 10);
  assert.equal(st.yard, 10, 'no outgoing flow: everything accumulates in the yard');
  assert.equal(st.state, 'blocked');
});

test('source: batch creates that many loads per arrival, all with the arrival time', () => {
  const layout = bare({ A: { type: 'source', params: { interArrival: dist('const', 20), batch: 3, startDelay: 0 } } });
  const w = createWorld(layout, { dt: 1, check: true });
  w.run(50);
  const created = w.named('loadCreated').map((p) => p.load.createdAt);
  assert.deepEqual(created, [0, 0, 0, 20, 20, 20, 40, 40, 40]);
  assert.equal(w.lg.stationById.get('A').arrivals, 3, 'a batch is one arrival event');
  assert.equal(w.lg.stationById.get('A').produced, 9);
});

test('source: mean inter-arrival of random distributions is right over thousands of arrivals', () => {
  for (const [kind, spread, tol] of [['exp', 0, 0.06], ['normal', 0.3, 0.02], ['uniform', 0.8, 0.03]]) {
    const layout = bare({ A: { type: 'source', params: { interArrival: dist(kind, 30, spread), startDelay: 0 } } });
    const w = createWorld(layout, { dt: 1, seed: 7 });
    w.run(90000);
    const created = w.named('loadCreated').map((p) => p.load.createdAt);
    const gaps = created.slice(1).map((c, i) => c - created[i]);
    assert.ok(gaps.length > 2500, `${kind}: ${gaps.length} arrivals`);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    assert.ok(Math.abs(mean - 30) < 30 * tol, `${kind}: mean gap ${mean.toFixed(2)} should be 30 +- ${(30 * tol).toFixed(1)}`);
  }
});

test('source: demandFactor scales the arrival rate; changing it live takes effect at once', () => {
  const make = (settings) => createWorld(bare({ A: { type: 'source', params: { interArrival: dist('const', 20), startDelay: 0 } } }, [], settings), { dt: 1 });
  const base = make({});
  base.run(200);
  const fast = make({ demandFactor: 4 });
  fast.run(200);
  assert.equal(base.lg.stationById.get('A').arrivals, 10);
  assert.equal(fast.lg.stationById.get('A').arrivals, 40);

  const live = make({});
  live.run(100); // arrivals at 0, 20, 40, 60, 80
  live.lg.setRuntime({ demandFactor: 4 });
  live.run(100); // pending arrival (t=100) stays, then every 5 s
  assert.equal(live.lg.stationById.get('A').arrivals, 5 + 20);
  assert.equal(live.lg.runtime.demandFactor, 4);
});

test('source: raising demandFactor pulls a distant pending arrival closer proportionally', () => {
  const w = createWorld(bare({ A: { type: 'source', params: { interArrival: dist('const', 100), startDelay: 0 } } }), { dt: 1 });
  w.run(10); // arrival at 0 done, next one pending at 100
  w.lg.setRuntime({ demandFactor: 10 });
  w.run(100);
  assert.deepEqual(w.named('loadCreated').map((p) => p.load.createdAt).slice(0, 3), [0, 19, 29], 'pending 90 s left become 9 s; later gaps are 10 s');
});

test('source: demandFactor 0 stops arrivals and restarts them when raised again; mean 0 never produces', () => {
  const w = createWorld(bare({ A: { type: 'source', params: { interArrival: dist('const', 10), startDelay: 0 } } }, [], { demandFactor: 0 }), { dt: 1, check: true });
  w.run(100);
  assert.equal(w.lg.stationById.get('A').arrivals, 0);
  w.lg.setRuntime({ demandFactor: 1 });
  w.run(35);
  assert.deepEqual(w.named('loadCreated').map((p) => p.load.createdAt), [100, 110, 120, 130], 'first arrival at once (startDelay long past), then every 10 s');
  const off = createWorld(bare({ A: { type: 'source', params: { interArrival: OFF } } }), { dt: 1 });
  off.run(100);
  off.lg.setRuntime({ demandFactor: 5 });
  off.run(100);
  assert.equal(off.lg.stationById.get('A').arrivals, 0);
});

test('source: loads that find the output buffer full wait in the yard (unbounded backlog) and the source reports blocked', () => {
  const layout = bare({
    A: { type: 'source', params: { interArrival: dist('const', 5), outCap: 3, startDelay: 0 } },
    B: { type: 'process' },
  }, [['A', 'B']]);
  const w = createWorld(layout, { dt: 1, check: true });
  w.run(99);
  const a = w.lg.stationById.get('A');
  assert.equal(a.arrivals, 20);
  assert.equal(a.outQ.get('f1').length, 3, 'buffer holds outCap loads');
  assert.equal(a.yard, 17, 'the rest is backlog');
  assert.equal(a.state, 'blocked');
  assert.equal(a.fill, 1);
  assert.equal(a.fillLabel, '3/3 +17');
  assert.equal(w.lg.liveLoads, 20);
  // the yard drains into the buffer as soon as there is room, oldest load first
  const oldest = a.yardQ[0];
  assert.ok(oldest.createdAt < a.yardQ[1].createdAt);
  drainOut(w.lg, 'f1', 1);
  w.step();
  assert.equal(a.outQ.get('f1').at(-1), oldest);
  assert.equal(a.yard, 16);
  assert.equal(a.outQ.get('f1').length, 3);
});

test('source: output is split over outgoing flows by weight, exactly 75/25 for 3:1', () => {
  const layout = bare({
    A: { type: 'source', params: { interArrival: dist('const', 1), outCap: 1000, startDelay: 0 } },
    B: { type: 'storage', params: { capacity: 1000 } },
    C: { type: 'storage', params: { capacity: 1000 } },
  }, [['A', 'B', { weight: 3 }], ['A', 'C', { weight: 1 }]]);
  const w = createWorld(layout, { dt: 1, check: true });
  w.run(100);
  const a = w.lg.stationById.get('A');
  assert.equal(a.outQ.get('f1').length, 75);
  assert.equal(a.outQ.get('f2').length, 25);
  w.run(2);
  assert.ok(Math.abs(a.outQ.get('f1').length - 76.5) <= 1 && a.outQ.get('f1').length + a.outQ.get('f2').length === 102);
});

test('source: a full flow is skipped by the splitter and the others take the surplus', () => {
  const layout = bare({
    A: { type: 'source', params: { interArrival: dist('const', 1), outCap: 4, startDelay: 0 } },
    B: { type: 'storage', params: { capacity: 1000 } },
    C: { type: 'storage', params: { capacity: 1000 } },
  }, [['A', 'B', { weight: 1 }], ['A', 'C', { weight: 1 }]]);
  const w = createWorld(layout, { dt: 1, check: true });
  w.run(20);
  const a = w.lg.stationById.get('A');
  assert.equal(a.outQ.get('f1').length, 4);
  assert.equal(a.outQ.get('f2').length, 4);
  assert.equal(a.yard, 12);
  drainOut(w.lg, 'f2', 4); // only C drains
  w.run(3);
  assert.equal(a.outQ.get('f2').length, 4, 'free capacity at C absorbs the yard at once, B stays full');
  assert.equal(a.outQ.get('f1').length, 4);
  assert.equal(a.yard, 12 + 3 - 4);
});

// ---- workstations -------------------------------------------------------------------------------------------------------

/** One workstation B fed from a disabled source A (inject loads), emptying into a sink or nowhere. */
function bench(params = {}, { sink = false, settings = {} } = {}) {
  const stations = { A: { type: 'source', params: { interArrival: OFF } }, B: { type: 'process', params } };
  if (sink) stations.C = 'sink';
  return bare(stations, sink ? [['A', 'B'], ['B', 'C']] : [['A', 'B']], settings);
}

test('process: a constant cycle completes exactly on time and the next one starts at once', () => {
  const w = createWorld(bench({ cycle: dist('const', 30), inCap: 10 }), { dt: 0.5, check: true });
  injectLoads(w.lg, 'f1', 5, { side: 'in', createdAt: 0 });
  const b = w.lg.stationById.get('B');
  w.run(15);
  assert.equal(b.machines[0].state, 'busy');
  assert.ok(Math.abs(b.machines[0].progress - 0.5) < 0.02);
  assert.equal(b.inCount, 4, 'the input leaves the queue when the cycle starts');
  assert.equal(w.lg.liveLoads, 5, 'but is still counted as work in process');
  w.run(15); // 30 s: ticks up to t=29.5 done
  assert.equal(w.lg.completed, 0);
  w.step();
  assert.equal(w.lg.completed, 1);
  assert.equal(b.produced, 1);
  assert.equal(b.consumed, 1);
  w.run(29.5);
  assert.equal(w.lg.completed, 1);
  w.step();
  assert.equal(w.lg.completed, 2, 'second cycle: exactly 60 s');
  assert.deepEqual(times(w.events, 'loadCompleted'), [30, 60]);
});

test('process: leftover time of a finished cycle carries into the next, so throughput does not depend on dt', () => {
  for (const dt of [0.1, 0.25, 0.5, 1, 2]) {
    const w = createWorld(bench({ cycle: dist('const', 7.3), inCap: 50 }), { dt });
    injectLoads(w.lg, 'f1', 50, { side: 'in', createdAt: 0 });
    w.run(73 + dt); // the 10th cycle ends at exactly 73 s, whatever the tick length (no 11th before 80.3 s)
    assert.equal(w.lg.completed, 10, `dt ${dt}: ${w.lg.completed} cycles of 7.3 s in 73 s`);
  }
});

test('process: two parallel machines double the capacity', () => {
  const done = (machines) => {
    const w = createWorld(bench({ cycle: dist('const', 20), machines, inCap: 20 }), { dt: 0.5, check: true });
    injectLoads(w.lg, 'f1', 20, { side: 'in', createdAt: 0 });
    w.run(101);
    assert.equal(w.lg.stationById.get('B').machines.length, machines);
    return w.lg.completed;
  };
  assert.equal(done(1), 5);
  assert.equal(done(2), 10);
  assert.equal(done(3), 15);
});

test('process: bill of materials - a cycle needs perCycle loads from every incoming flow', () => {
  const layout = layoutFromAscii(['A.B.C.D'], {
    stations: {
      A: { type: 'source', params: { interArrival: OFF } }, B: { type: 'source', params: { interArrival: OFF } },
      C: { type: 'process', params: { cycle: dist('const', 10), inCap: 5, outPerCycle: 1 } }, D: 'sink',
    },
    flows: [['A', 'C', { perCycle: 2 }], ['B', 'C', { perCycle: 1 }], ['C', 'D']], fleets: [],
  });
  const w = createWorld(layout, { dt: 1, check: true });
  const c = w.lg.stationById.get('C');
  injectLoads(w.lg, 'f1', 3, { side: 'in', createdAt: 0 });
  w.run(5);
  assert.equal(c.state, 'starved', 'A has enough but B is missing');
  injectLoads(w.lg, 'f2', 1, { side: 'in', createdAt: 0 });
  w.step();
  assert.equal(c.state, 'busy');
  assert.equal(c.inQ.get('f1').length, 1, '2 of 3 consumed');
  assert.equal(c.inQ.get('f2').length, 0);
  assert.equal(c.machines[0].inputs, 3);
  w.run(10);
  assert.equal(c.produced, 1);
  assert.equal(c.consumed, 3);
  assert.equal(c.state, 'starved', 'one A load is left, a second needs two');
  assert.equal(c.outQ.get('f3').length, 1, 'the output waits for pickup');
});

test('process: outPerCycle makes several outputs, split by weight over the outgoing flows', () => {
  const layout = layoutFromAscii(['A.B.C.D'], {
    stations: {
      A: { type: 'source', params: { interArrival: OFF } },
      B: { type: 'process', params: { cycle: dist('const', 10), outPerCycle: 4, inCap: 5, outCap: 20 } },
      C: { type: 'storage', params: { capacity: 100 } }, D: { type: 'storage', params: { capacity: 100 } },
    },
    flows: [['A', 'B'], ['B', 'C', { weight: 3 }], ['B', 'D', { weight: 1 }]], fleets: [],
  });
  const w = createWorld(layout, { dt: 1, check: true });
  injectLoads(w.lg, 'f1', 5, { side: 'in', createdAt: 0 });
  w.run(51);
  const b = w.lg.stationById.get('B');
  assert.equal(b.produced, 20);
  assert.equal(b.outQ.get('f2').length, 15);
  assert.equal(b.outQ.get('f3').length, 5);
  assert.equal(w.lg.liveLoads, 20);
});

test('process: the output carries the oldest input createdAt (end-to-end lead time)', () => {
  const layout = layoutFromAscii(['A.B.C.D'], {
    stations: {
      A: { type: 'source', params: { interArrival: OFF } }, B: { type: 'source', params: { interArrival: OFF } },
      C: { type: 'process', params: { cycle: dist('const', 10), inCap: 5 } }, D: 'sink',
    },
    flows: [['A', 'C', { perCycle: 2 }], ['B', 'C'], ['C', 'D']], fleets: [],
  });
  const w = createWorld(layout, { dt: 1, check: true });
  injectLoads(w.lg, 'f1', 1, { side: 'in', createdAt: 7 });
  injectLoads(w.lg, 'f1', 1, { side: 'in', createdAt: 3 });
  injectLoads(w.lg, 'f2', 1, { side: 'in', createdAt: 5 });
  w.run(11);
  const outputs = w.named('loadCreated').filter((p) => p.load.origin === 'C');
  assert.equal(outputs.length, 1);
  assert.equal(outputs[0].load.createdAt, 3);
  assert.equal(outputs[0].load.origin, 'C');
});

test('process without an outgoing flow completes its output immediately, with the end-to-end lead time', () => {
  const w = createWorld(bench({ cycle: dist('const', 10), outPerCycle: 2, inCap: 5 }), { dt: 1, check: true });
  injectLoads(w.lg, 'f1', 1, { side: 'in', createdAt: 4 });
  w.run(11);
  assert.equal(w.lg.completed, 2);
  assert.equal(w.lg.liveLoads, 0);
  const done = w.named('loadCompleted');
  assert.deepEqual(done.map((p) => [p.stationId, p.leadTime, p.t]), [['B', 6, 10], ['B', 6, 10]]);
  assert.equal(done[0].station, w.lg.stationById.get('B'));
});

test('process: blocked after service when the output buffer is full, released as soon as there is room', () => {
  const layout = layoutFromAscii(['A.B.C'], {
    stations: { A: { type: 'source', params: { interArrival: OFF } }, B: { type: 'process', params: { cycle: dist('const', 10), inCap: 10, outCap: 2 } }, C: 'sink' },
    flows: [['A', 'B'], ['B', 'C']], fleets: [],
  });
  const w = createWorld(layout, { dt: 1, check: true });
  injectLoads(w.lg, 'f1', 6, { side: 'in', createdAt: 0 });
  const b = w.lg.stationById.get('B');
  w.run(35);
  assert.equal(b.outQ.get('f2').length, 2, 'two finished loads fill the buffer');
  assert.equal(b.machines[0].state, 'blocked');
  assert.equal(b.machines[0].holding.length, 1, 'the third is held in the machine');
  assert.equal(b.state, 'blocked');
  assert.equal(b.inCount, 3, 'no new cycle starts while blocked');
  w.run(50);
  assert.equal(b.machines[0].state, 'blocked', 'still blocked: nobody picks up');
  drainOut(w.lg, 'f2', 1); // a vehicle takes one
  w.step();
  assert.equal(b.machines[0].holding.length, 0);
  assert.equal(b.machines[0].state, 'busy', 'released and straight into the next cycle');
  assert.equal(b.inCount, 2);
});

test('process: a breakdown freezes the running cycle and it resumes after the repair', () => {
  const layout = bench({ cycle: dist('const', 100), mtbf: 40, mttr: 30, inCap: 5 });
  const w = createWorld(layout, { dt: 0.5, seed: 3, check: true });
  const b = w.lg.stationById.get('B');
  injectLoads(w.lg, 'f1', 1, { side: 'in', createdAt: 0 });
  let frozen = null;
  for (let i = 0; i < 4000 && w.lg.completed === 0; i++) {
    w.step();
    const m = b.machines[0];
    if (m.state === 'down') {
      if (frozen !== null) assert.equal(m.remaining, frozen, 'no progress while down');
      frozen = m.remaining;
    } else frozen = null;
  }
  assert.equal(w.lg.completed, 1, 'the cycle finishes eventually');
  const downs = times(w.events, 'machineDown');
  const ups = times(w.events, 'machineUp');
  assert.ok(downs.length >= 1, 'with mtbf 40 s the machine fails during a 100 s cycle');
  assert.equal(b.breakdowns, downs.length);
  const finished = times(w.events, 'loadCompleted')[0];
  const downtime = downs.reduce((sum, d, i) => sum + Math.min(ups[i] ?? finished, finished) - d, 0);
  assert.ok(Math.abs(finished - (100 + downtime)) <= downs.length * 0.5 + 1e-6, `finished at ${finished}, cycle 100 + downtime ${downtime}`);
  for (let i = 0; i < ups.length; i++) assert.ok(ups[i] > downs[i]);
});

test('process: aggregate state is down only if all machines are down, busy if any is busy', () => {
  const w = createWorld(bench({ machines: 3, inCap: 5 }), { dt: 1 });
  const b = w.lg.stationById.get('B');
  assert.equal(b.state, 'starved');
  const [m1, m2, m3] = b.machines;
  m1.state = 'down'; m2.state = 'down';
  assert.equal(b.state, 'starved', 'one machine is idle');
  m3.state = 'down';
  assert.equal(b.state, 'down');
  m3.state = 'blocked';
  assert.equal(b.state, 'blocked');
  m1.state = 'busy';
  assert.equal(b.state, 'busy');
  const none = createWorld(bench({ machines: 0 }), { dt: 1 });
  assert.equal(none.lg.stationById.get('B').machines.length, 0);
  none.run(10);
  assert.equal(none.lg.stationById.get('B').state, 'down', 'no machines, no production');
});

test('process: processFactor stretches new cycles and rescales a running one live', () => {
  const w = createWorld(bench({ cycle: dist('const', 40), inCap: 10 }, { settings: { processFactor: 1.5 } }), { dt: 1, check: true });
  injectLoads(w.lg, 'f1', 3, { side: 'in', createdAt: 0 });
  w.run(59);
  assert.equal(w.lg.completed, 0);
  w.run(2);
  assert.equal(w.lg.completed, 1, '40 s x 1.5 = 60 s');
  w.lg.setRuntime({ processFactor: 0.5 }); // the running second cycle (1 s in) has 59 s left -> 59/3 s
  const m = w.lg.stationById.get('B').machines[0];
  assert.ok(Math.abs(m.remaining - 59 / 3) < 1.1, `remaining ${m.remaining}`);
  w.run(25);
  assert.equal(w.lg.completed, 2);
});

test('process: a failure strikes at its scheduled time inside a tick and freezes exactly the work done until then', () => {
  for (const dt of [0.1, 0.5, 1]) {
    const w = createWorld(bench({ cycle: dist('const', 20), mtbf: 1e9, mttr: 1e7, inCap: 5 }), { dt, seed: 4, check: true });
    const m = w.lg.stationById.get('B').machines[0];
    m.failAt = 7.3; // a failure between two ticks of every dt
    injectLoads(w.lg, 'f1', 1, { side: 'in', createdAt: 0 });
    w.run(10);
    assert.equal(m.state, 'down', `dt ${dt}`);
    assert.ok(Math.abs(m.remaining - 12.7) < 1e-9, `dt ${dt}: ${20 - m.remaining} s of work were done, not the 7.3 s before the failure`);
    assert.ok(m.upAt > 7.3 && m.repairLeft > 1e6);
    assert.equal(w.named('machineDown').length, 1);
  }
});

test('process: with breakdowns the share of time a machine is up is mtbf / (mtbf + mttr), whatever the tick length', () => {
  for (const dt of [0.5, 0.1]) {
    const w = createWorld(bench({ machines: 100, cycle: dist('const', 50), mtbf: 4, mttr: 1, inCap: 5 }), { dt, seed: 11 });
    const b = w.lg.stationById.get('B');
    let down = 0;
    const ticks = Math.round(2000 / dt);
    for (let i = 0; i < ticks; i++) {
      w.step();
      for (const m of b.machines) if (m.state === 'down') down++;
    }
    const share = down / (ticks * 100);
    assert.ok(Math.abs(share - 0.2) < 0.012, `dt ${dt}: down ${share.toFixed(3)} of the time, expected 0.2`);
    assert.ok(b.breakdowns > 30000);
  }
});

test('process: a repair ends at its exact time and the cycle goes on with the rest of the tick', () => {
  const w = createWorld(bench({ cycle: dist('const', 40), mtbf: 1e9, mttr: 1e7, inCap: 5 }), { dt: 1, check: true });
  const m = w.lg.stationById.get('B').machines[0];
  injectLoads(w.lg, 'f1', 1, { side: 'in', createdAt: 0 });
  m.failAt = 3.5;
  w.run(5); // the failure falls into the tick that ends at 4
  assert.equal(m.state, 'down');
  assert.equal(m.downFrom, 'busy');
  assert.equal(m.remaining, 36.5);
  m.upAt = 6.25; // repaired during the tick that ends at 7
  m.repairLeft = m.upAt - 5;
  w.run(2);
  assert.equal(m.state, 'down', 'still down at 6');
  assert.equal(m.remaining, 36.5, 'frozen');
  w.step();
  assert.equal(m.state, 'busy');
  assert.equal(m.remaining, 35.75, 'works from 6.25 to 7');
  assert.equal(m.repairLeft, 0);
  assert.ok(m.failAt > 1e6, 'the next failure is scheduled from the repair');
  assert.deepEqual(times(w.events, 'machineUp'), [7]);
});

test('process: a machine that is idle (or blocked) can fail too - breakdowns run on calendar time', () => {
  const w = createWorld(bench({ cycle: dist('const', 10), mtbf: 1e9, mttr: 1e7, inCap: 5 }), { dt: 1, check: true });
  const m = w.lg.stationById.get('B').machines[0];
  m.failAt = 3.5;
  w.run(5);
  assert.equal(m.state, 'down');
  assert.equal(m.downFrom, 'idle');
  assert.equal(w.lg.stationById.get('B').state, 'down');
});

test('process: a processFactor change takes effect at the moment it is made, not one tick earlier', () => {
  for (const dt of [0.25, 1]) {
    const w = createWorld(bench({ cycle: dist('const', 30), inCap: 5 }), { dt, check: true });
    injectLoads(w.lg, 'f1', 1, { side: 'in', createdAt: 0 });
    w.run(10); // the cycle began at 0: 20 s of work are left at the moment of the change
    w.lg.setRuntime({ processFactor: 2 });
    w.run(60);
    assert.deepEqual(times(w.events, 'loadCompleted'), [50], `dt ${dt}: 10 s done + 20 s x 2 = 40 s more`);
  }
});

test('setRuntime: a negative demandFactor is junk like any other and keeps the current setting', () => {
  const w = createWorld(bare({ A: { type: 'source', params: { interArrival: dist('const', 10), startDelay: 0 } } }), { dt: 1 });
  w.lg.setRuntime({ demandFactor: 2 });
  w.lg.setRuntime({ demandFactor: -3 });
  assert.equal(w.lg.runtime.demandFactor, 2);
  w.run(100);
  assert.ok(w.lg.stationById.get('A').arrivals >= 19, 'arrivals go on at the doubled rate');
});

// ---- storage, sink -------------------------------------------------------------------------------------------------------

/** A -> S -> B on a line with a forklift fleet; S is a storage with the given params. */
function storageLine(storageParams, { toSink = true, source = {} } = {}) {
  return layoutFromAscii(['A.......S.......B', '+++++++++++++++++'], {
    stations: {
      A: { type: 'source', params: { interArrival: dist('const', 4), outCap: 2, startDelay: 0, ...source } },
      S: { type: 'storage', params: storageParams },
      B: 'sink',
    },
    flows: toSink ? [['A', 'S'], ['S', 'B']] : [['A', 'S']],
    fleets: [{ count: 2, preset: 'forklift', loadTime: 1, unloadTime: 1 }],
  });
}

test('storage: a load may leave only after its dwell time has passed', () => {
  const w = createWorld(storageLine({ capacity: 50, dwell: 60 }), { dt: 0.25, check: true });
  w.run(400);
  const stored = new Map(); // load id -> time it entered the storage
  for (const e of w.named('orderDelivered')) if (e.order.flowId === 'f1') for (const l of e.order.loads) stored.set(l.id, e.order.deliveredAt);
  const picks = w.named('orderPickedUp').filter((e) => e.order.flowId === 'f2');
  assert.ok(picks.length > 10, `${picks.length} loads were picked up from the storage`);
  const s = w.lg.stationById.get('S');
  assert.equal(s.consumed, w.lg.flowById.get('f1').delivered, 'consumed = loads received');
  assert.equal(s.arrivals, s.consumed);
  assert.equal(s.produced, picks.reduce((n, e) => n + e.order.qty, 0), 'produced = loads released to vehicles');
  for (const { order } of picks) for (const l of order.loads) assert.ok(order.pickedAt >= stored.get(l.id) + 60 - 1e-9, `load ${l.id} left after ${order.pickedAt - stored.get(l.id)} s`);
  assert.ok(w.lg.completed > 5);
});

test('storage: capacity is a hard limit; back-pressure holds loads at the source', () => {
  const w = createWorld(storageLine({ capacity: 3, dwell: 0 }, { toSink: false }), { dt: 0.25, check: true });
  w.run(300);
  const s = w.lg.stationById.get('S');
  assert.equal(s.outCount, 3);
  assert.equal(s.held, 3);
  assert.equal(s.state, 'full');
  assert.equal(s.fill, 1);
  assert.equal(s.fillLabel, '3/3');
  assert.equal(s.pool.length, 3, 'without outgoing flow the loads stay in the storage');
  assert.equal(s.inboundTotal, 0, 'no vehicle is sent for loads that cannot be stored');
  const a = w.lg.stationById.get('A');
  assert.equal(a.outQ.get('f1').length, 2);
  assert.ok(a.yard > 50, `the source backs up (yard ${a.yard})`);
  assert.equal(w.lg.liveLoads, a.arrivals);
});

test('storage: loads are routed to outgoing flows on arrival, by weight', () => {
  const layout = layoutFromAscii(['A.......S.......B.C', '+++++++++++++++++++'], {
    stations: { A: { type: 'source', params: { interArrival: dist('const', 3), outCap: 3, startDelay: 0 } }, S: { type: 'storage', params: { capacity: 100, dwell: 10000 } }, B: 'sink', C: 'sink' },
    flows: [['A', 'S'], ['S', 'B', { weight: 2 }], ['S', 'C', { weight: 1 }]],
    fleets: [{ count: 4, preset: 'forklift', loadTime: 1, unloadTime: 1 }],
  });
  const w = createWorld(layout, { dt: 0.5, check: true });
  w.run(400);
  const s = w.lg.stationById.get('S');
  const [b, c] = [s.outQ.get('f2').length, s.outQ.get('f3').length];
  assert.ok(b + c > 40, `${b + c} loads were stored`);
  assert.ok(Math.abs(b - 2 * c) <= 2, `2:1 split, got ${b}:${c}`);
});

test('sink: lead time is the end-to-end difference, exactly computable on a simple line', () => {
  // A (1 cell, dock = its road cell) ...... B (1 cell): vehicle drives to A, loads, drives to B, unloads.
  const layout = layoutFromAscii(['A......B', '++++++++'], {
    stations: { A: { type: 'source', params: { interArrival: dist('const', 1000), startDelay: 10 } }, B: 'sink' },
    flows: [['A', 'B']], fleets: [{ count: 1, speed: 2, accel: 1, decel: 1, loadTime: 6, unloadTime: 4 }],
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  const v = w.lg.vehicles[0];
  const startCell = w.graph.cx(v.tv.node);
  assert.ok(startCell >= 1 && startCell <= 6, 'the vehicle starts on a plain road cell');
  w.run(100);
  assert.equal(w.lg.completed, 1);
  const [done] = w.named('loadCompleted');
  const toA = startCell * 2 / 2; // cells -> 2 m each at 2 m/s
  const toB = 7 * 2 / 2;
  assert.equal(done.load.createdAt, 10);
  assert.equal(done.t, 10 + toA + 6 + toB + 4, 'create -> drive -> load -> drive -> unload, all at tick granularity');
  assert.equal(done.leadTime, toA + 6 + toB + 4);
  const [order] = w.named('orderDelivered');
  assert.equal(order.waitForPickup, toA + 6, 'load ready until it is on the vehicle');
  assert.equal(order.transit, toB + 4);
  assert.equal(w.lg.stationById.get('B').consumed, 1);
  assert.equal(w.lg.stationById.get('B').arrivals, 1);
});

// ---- throughput of a chain ---------------------------------------------------------------------------------------------

function chain({ interArrival, cycle, machines = 1 }) {
  return layoutFromAscii(['A....B....C', '+++++++++++'], {
    stations: {
      A: { type: 'source', params: { interArrival: dist('const', interArrival), outCap: 4, startDelay: 0 } },
      B: { type: 'process', params: { cycle: dist('const', cycle), machines, inCap: 4, outCap: 4 } },
      C: 'sink',
    },
    flows: [['A', 'B'], ['B', 'C']],
    fleets: [{ count: 4, preset: 'forklift', loadTime: 2, unloadTime: 2 }],
  });
}

test('chain A -> B -> C: throughput equals the bottleneck rate (workstation-limited)', () => {
  const w = createWorld(chain({ interArrival: 10, cycle: 20 }), { dt: 0.25, check: true });
  w.run(600);
  const before = w.lg.completed;
  w.run(3000);
  const rate = w.lg.completed - before;
  assert.ok(Math.abs(rate - 150) <= 2, `3000 s at one load per 20 s: ${rate}`);
  const a = w.lg.stationById.get('A');
  assert.ok(a.yard > 100, 'the surplus piles up in the yard');
  assert.equal(w.lg.stationById.get('B').machines[0].state === 'busy' || w.lg.stationById.get('B').machines[0].state === 'idle', true);
});

test('chain A -> B -> C: throughput equals the bottleneck rate (supply-limited, and doubled by a second machine only if useful)', () => {
  const slow = createWorld(chain({ interArrival: 30, cycle: 20 }), { dt: 0.25, check: true });
  slow.run(600);
  const before = slow.lg.completed;
  slow.run(3000);
  assert.ok(Math.abs(slow.lg.completed - before - 100) <= 2, `source gives one load per 30 s: ${slow.lg.completed - before}`);
  const fast = createWorld(chain({ interArrival: 10, cycle: 20, machines: 2 }), { dt: 0.25, check: true });
  fast.run(600);
  const b2 = fast.lg.completed;
  fast.run(3000);
  assert.ok(Math.abs(fast.lg.completed - b2 - 300) <= 3, `two machines keep up with the source: ${fast.lg.completed - b2}`);
});

// ---- structure & robustness ----------------------------------------------------------------------------------------------

test('flows: runtime flows follow layout order; invalid flows are ignored', () => {
  const layout = layoutFromAscii(['A.B.C.D.E'], {
    stations: { A: 'source', B: 'process', C: 'sink', D: 'depot', E: 'storage' },
    flows: [['B', 'C'], ['A', 'B'], ['C', 'B'], ['B', 'D'], ['D', 'B'], ['B', 'B'], ['A', 'Z'], ['E', 'C'], ['A', 'A']],
    fleets: [],
  });
  const w = createWorld(layout, { dt: 1 });
  assert.deepEqual(w.lg.flows.map((f) => f.id), ['f1', 'f2', 'f8']);
  assert.deepEqual(w.lg.flows.map((f) => [f.from.id, f.to.id]), [['B', 'C'], ['A', 'B'], ['E', 'C']]);
  assert.ok(w.lg.flows.every((f) => f.delivered === 0 && f.trips === 0 && f.def === layout.flows.find((d) => d.id === f.id)));
  assert.deepEqual(w.lg.stations.map((s) => s.id), ['A', 'B', 'C', 'D', 'E']);
  assert.equal(w.lg.stationById.get('B').def, layout.stations[1]);
});

test('stations: fill and fillLabel describe the buffers', () => {
  const layout = layoutFromAscii(['A.B.C.D'], {
    stations: {
      A: { type: 'source', params: { interArrival: OFF, outCap: 4 } }, B: { type: 'process', params: { inCap: 4, cycle: dist('const', 100) } },
      C: { type: 'storage', params: { capacity: 8 } }, D: { type: 'depot', params: { slots: 4, chargers: 1 } },
    },
    flows: [['A', 'B'], ['A', 'C']], fleets: [],
  });
  const w = createWorld(layout, { dt: 1 });
  injectLoads(w.lg, 'f1', 3, { side: 'out' });
  injectLoads(w.lg, 'f2', 3, { side: 'out' });
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((id) => w.lg.stationById.get(id));
  assert.equal(a.outCount, 6);
  assert.equal(a.fill, 6 / 8);
  assert.equal(a.fillLabel, '6/8');
  injectLoads(w.lg, 'f1', 2, { side: 'in' });
  assert.equal(b.inCount, 2);
  assert.equal(b.fill, 2 / 4);
  assert.equal(b.fillLabel, '2/4');
  assert.equal(c.fill, 0);
  assert.equal(d.fill, 0);
  assert.equal(d.fillLabel, '0/4');
  assert.equal(d.slots, 4);
  assert.equal(d.chargers, 1);
});

test('odd parameters (NaN, negative, missing) never throw and never produce NaN', () => {
  const layout = layoutFromAscii(['A.B.C.D'], {
    stations: {
      A: { type: 'source', params: { interArrival: { kind: 'bogus', mean: NaN, spread: 9 }, batch: -3, outCap: NaN, startDelay: -5 } },
      B: { type: 'process', params: { cycle: { kind: 'normal', mean: -4, spread: NaN }, machines: 2.7, outPerCycle: -1, inCap: Infinity, outCap: 'x', mtbf: -1, mttr: NaN } },
      C: { type: 'storage', params: { capacity: NaN, dwell: -3 } }, D: { type: 'depot', params: { slots: 'many', chargers: 99 } },
    },
    flows: [['A', 'B', { weight: NaN, perCycle: 0, batchMin: -1, batchMax: NaN, maxWait: -4, priority: 99, fleetId: 7 }], ['B', 'C', { weight: -1 }]],
    fleets: [],
  });
  layout.stations[1].params.cycle = undefined;
  const w = createWorld(layout, { dt: 1, check: true });
  w.run(120);
  for (const st of w.lg.stations) for (const key of ['produced', 'consumed', 'arrivals', 'fill', 'inCount', 'outCount']) assert.ok(Number.isFinite(st[key]), `${st.id}.${key}`);
  assert.equal(w.lg.stationById.get('B').machines.length, 2);
  assert.equal(w.lg.stationById.get('D').chargers <= w.lg.stationById.get('D').slots, true);
});

test('setRuntime ignores junk and applies speedFactor to the traffic system', () => {
  const w = createWorld(bare({ A: 'source' }), { dt: 1 });
  w.lg.setRuntime({ speedFactor: 2, processFactor: 0.5, demandFactor: 3, dispatch: 'oldest', routing: 'congestion' });
  assert.deepEqual(w.lg.runtime, { dispatch: 'oldest', routing: 'congestion', demandFactor: 3, speedFactor: 2, processFactor: 0.5 });
  assert.equal(w.traffic.speedFactor, 2);
  w.lg.setRuntime({ speedFactor: -1, processFactor: NaN, demandFactor: 'x', dispatch: 'toString', routing: 7 });
  assert.deepEqual(w.lg.runtime, { dispatch: 'oldest', routing: 'congestion', demandFactor: 3, speedFactor: 2, processFactor: 0.5 });
  w.lg.setRuntime(undefined);
  w.lg.setRuntime({ demandFactor: 0 });
  assert.equal(w.lg.runtime.demandFactor, 0, 'zero demand is a legal setting');
  assert.equal(createWorld(bare({ A: 'source' }), { dt: 1 }).traffic.speedFactor, 1);
  assert.equal(createWorld(bare({ A: 'source' }, [], { speedFactor: 1.5 }), { dt: 1 }).traffic.speedFactor, 1.5, 'layout settings are applied at construction');
});
