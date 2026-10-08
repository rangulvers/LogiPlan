// Meta-test: the invariant checker used by the fuzz tests (tests/helpers/logistics-invariants.js) must have teeth.
// A healthy mid-run state passes; every kind of corruption below is reported, so a passing fuzz run means something.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutFromAscii } from './helpers/ascii.js';
import { assertInvariants, checkInvariants, createWorld, eventDigest, physicalLoads } from './helpers/logistics-invariants.js';
import { dist } from '../js/model/defaults.js';

/** A plant with every station type and a fleet that is busy: P depot, A source -> B process -> S storage -> D sink. */
function busyWorld() {
  const layout = layoutFromAscii(['P..A....B....S....D', '+'.repeat(19)], {
    stations: {
      P: { type: 'depot', params: { slots: 4, chargers: 1 } },
      A: { type: 'source', params: { interArrival: dist('const', 6), startDelay: 0, outCap: 3 } },
      B: { type: 'process', params: { cycle: dist('const', 14), machines: 2, inCap: 3, outCap: 2 } },
      S: { type: 'storage', params: { capacity: 6, dwell: 20 } },
      D: 'sink',
    },
    flows: [['A', 'B'], ['B', 'S'], ['S', 'D']],
    fleets: [{ count: 3, home: 'P', speed: 2, loadTime: 3, unloadTime: 3 }],
  });
  const w = createWorld(layout, { dt: 0.25, check: true });
  w.run(170);
  return w;
}

const corrupt = (mutate, expected) => {
  const w = busyWorld();
  assert.deepEqual(checkInvariants(w.lg), [], 'the healthy state passes');
  mutate(w.lg);
  const bad = checkInvariants(w.lg);
  assert.ok(bad.some((m) => expected.test(m)), `expected ${expected}, got ${JSON.stringify(bad)}`);
  assert.throws(() => assertInvariants(w.lg, 'corrupted'), /logistics invariants violated \(corrupted\)/);
};

test('invariants: the busy reference state is healthy and actually busy', () => {
  const w = busyWorld();
  const lg = w.lg;
  assert.deepEqual(checkInvariants(lg), []);
  assert.ok(lg.activeOrders.size >= 1, 'orders in flight');
  assert.ok(physicalLoads(lg).length >= 5, 'loads everywhere');
  assert.ok(lg.completed >= 1 && lg.ordersDelivered >= 5);
  assert.ok(lg.vehicles.some((v) => v.load.length > 0) || lg.vehicles.some((v) => v.state === 'toPickup'));
  assert.ok([...lg.stationById.values()].some((s) => s.inboundTotal > 0));
  assert.ok(lg.stationById.get('B').machines.some((m) => m.state === 'busy'));
});

test('invariants: load conservation violations are reported', () => {
  corrupt((lg) => { lg.stationById.get('A').yardQ.push({ id: 9999, createdAt: 0, origin: 'A', readyAt: 0, claimed: false }); }, /liveLoads \d+ != physical/);
  corrupt((lg) => { lg.completed++; }, /created \d+ != live/);
  corrupt((lg) => { lg.liveLoads++; }, /liveLoads/);
  corrupt((lg) => { lg.stationById.get('A').yardQ.push(physicalLoads(lg)[0].load); }, /exists twice/);
});

test('invariants: capacity violations are reported', () => {
  corrupt((lg) => { const l = lg.stationById.get('A').outLinks[0]; for (let i = 0; i < 4; i++) l.queue.push(lg.createLoad(lg.stationById.get('A'), 0, 0, 'source')); }, /outQ f1 holds \d+ > outCap/);
  corrupt((lg) => { const s = lg.stationById.get('S'); for (let i = 0; i < 7; i++) s.outLinks[0].queue.push(lg.createLoad(s, 0, 0, 'source')); }, /storage holds/);
  corrupt((lg) => { const b = lg.stationById.get('B'); for (let i = 0; i < 4; i++) b.inLinks[0].queue.push(lg.createLoad(lg.stationById.get('A'), 0, 0, 'source')); }, /inQ f1/);
  corrupt((lg) => { lg.stationById.get('B').inbound.set('f1', -1); lg.stationById.get('B').inboundTotal -= 1; }, /negative|reserve/);
  corrupt((lg) => { lg.stationById.get('S').inbound.set('f2', lg.stationById.get('S').inbound.get('f2') + 1); lg.stationById.get('S').inboundTotal++; }, /active orders reserve/);
  corrupt((lg) => { lg.stationById.get('S').inboundTotal += 2; }, /inboundTotal/);
});

test('invariants: claim and order violations are reported', () => {
  corrupt((lg) => { const l = lg.stationById.get('A').outLinks[0]; l.claimed += 1; }, /claimed counter|prefix/);
  corrupt((lg) => {
    const q = lg.stationById.get('B').outLinks[0].queue;
    const target = q.length ? q : lg.stationById.get('A').outLinks[0].queue;
    target[target.length - 1].claimed = !target[target.length - 1].claimed;
  }, /claimed/);
  corrupt((lg) => { const o = [...lg.activeOrders.values()][0]; const v = lg.vehicles.find((x) => x.order === o); v.order = null; }, /has no vehicle/);
  corrupt((lg) => { const [a, b] = lg.vehicles.filter((x) => x.order); if (a && b) b.order = a.order; else lg.vehicles[0].order = [...lg.activeOrders.values()][0]; }, /two vehicles|names/);
  corrupt((lg) => { const o = [...lg.activeOrders.values()][0]; o.loads[0].claimed = false; }, /not marked claimed/);
  corrupt((lg) => { const orders = [...lg.activeOrders.values()]; orders[orders.length - 1].qty += 1; }, /qty/);
});

test('invariants: vehicle and depot violations are reported', () => {
  corrupt((lg) => { const v = lg.vehicles.find((x) => x.state !== 'toDrop' && x.state !== 'unloading'); v.load = [lg.createLoad(lg.stationById.get('A'), 0, 0, 'source')]; }, /carries/);
  corrupt((lg) => { lg.vehicles[0].battery = 1.5; }, /battery/);
  corrupt((lg) => { lg.vehicles[0].tv.onRoad = !lg.vehicles[0].tv.onRoad; }, /onRoad|visible/);
  corrupt((lg) => { lg.vehicles[0].visible = !lg.vehicles[0].visible; }, /visible/);
  corrupt((lg) => { lg.stationById.get('P').reservedSlots = 9; }, /reserves|over-booked/);
  corrupt((lg) => { lg.stationById.get('P').reservedChargers = 2; }, /chargers|reserves/);
  corrupt((lg) => { const p = lg.stationById.get('P'); const v = lg.vehicles.find((x) => x.state !== 'parked'); p.parked.push(v); }, /listed as parked|over-booked/);
  corrupt((lg) => { const v = lg.vehicles[0]; v.state = 'dead'; }, /dead but not disabled|onRoad|visible/);
});

test('invariants: machine violations are reported', () => {
  corrupt((lg) => { const m = lg.stationById.get('B').machines[0]; m.state = 'blocked'; m.holding.length = 0; }, /blocked but holds nothing/);
  corrupt((lg) => { const m = lg.stationById.get('B').machines[0]; m.state = 'idle'; m.inputs = 1; }, /idle but holds/);
  corrupt((lg) => { const m = lg.stationById.get('B').machines[0]; m.state = 'busy'; m.cycleTime = 0; }, /busy without a cycle time/);
  corrupt((lg) => { const m = lg.stationById.get('B').machines[0]; m.progress = NaN; }, /progress/);
});

test('invariants: the event digest is sensitive to the log and stable for equal logs', () => {
  const a = busyWorld();
  const b = busyWorld();
  assert.equal(eventDigest(a.events), eventDigest(b.events));
  b.events.pop();
  assert.notEqual(eventDigest(a.events), eventDigest(b.events));
  assert.equal(eventDigest([]), '0:' + eventDigest([]).split(':')[1]);
});
