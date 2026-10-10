// The fixtures of the statistics (tests/fixtures/stats/*.json) are the contract between the simulation and the model / overlay builders: query outputs of the collector for
// fixed plants and seeds, in the exact shape of its API (docs/ENTITY-INSIGHTS-DESIGN.md 6.4; the shape is documented at the top of tests/helpers/detail-snapshot.js and of
// js/sim/detail.js). This file proves
//   * each fixture is what the LIVE collector answers today (structure, strings and integers exactly, numbers to 1e-9 relative): a change of the API or of a number fails here
//     until the fixtures are written again (node tests/helpers/detail-snapshot.js --write) and the pull request says why
//   * each fixture is complete and consistent on its own (every vehicle and station, both windows, every path a query mentions, no NaN)
//   * the fake collector of tests/helpers/fake-sim.js answers every query like the live one, so the model and overlay tests that use it test against the real API
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../js/sim/engine.js';
import { FIXTURE_SPECS, FORMAT, assertFinite, buildFixture, readFixture, snapshotDetail } from './helpers/detail-snapshot.js';
import { createFakeDetail, fixtureDetailSim } from './helpers/fake-sim.js';
import { EXAMPLES } from '../js/model/examples.js';

/** Structure, strings and integers exactly; non-integer numbers to `tol` relative (the sampled station figures move with the sampling, nothing else should). */
function sameShape(actual, expected, where = '$', tol = 1e-9) {
  if (typeof expected === 'number' && typeof actual === 'number') {
    if (Number.isInteger(expected) && Number.isInteger(actual)) return assert.equal(actual, expected, where);
    return assert.ok(Math.abs(actual - expected) <= tol * Math.max(1, Math.abs(actual), Math.abs(expected)), `${where}: ${actual} against ${expected}`);
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${where}: an array`);
    assert.equal(actual.length, expected.length, `${where}: length`);
    return expected.forEach((e, i) => sameShape(actual[i], e, `${where}[${i}]`, tol));
  }
  if (expected !== null && typeof expected === 'object') {
    assert.ok(actual !== null && typeof actual === 'object', `${where}: an object`);
    assert.deepEqual(Object.keys(actual), Object.keys(expected), `${where}: keys`);
    return Object.keys(expected).forEach((k) => sameShape(actual[k], expected[k], `${where}.${k}`, tol));
  }
  return assert.equal(actual, expected, where);
}

for (const name of Object.keys(FIXTURE_SPECS)) {
  test(`fixture ${name}: it is what the live collector answers today`, async () => {
    const fixture = readFixture(name);
    const live = JSON.parse(JSON.stringify(await buildFixture(name)));
    try { sameShape(live, fixture); } catch (error) {
      error.message = `${name} is not what the live collector answers any more: ${error.message}\nIf the change is intended (the collector, the engine, an example or an insight changed): node tests/helpers/detail-snapshot.js --write ${name}, and say why in the pull request.`;
      throw error;
    }
  });

  test(`fixture ${name}: complete and consistent on its own`, () => {
    const f = readFixture(name);
    assert.equal(f.format, FORMAT);
    assertFinite(f);
    assert.ok(f.about.length > 20 && f.source && typeof f.time === 'number');
    assert.equal(f.vehicles.length, f.detail.nV); assert.equal(f.stations.length, f.detail.nS);
    f.vehicles.forEach((v, i) => assert.equal(v.index, i));
    f.stations.forEach((s, i) => assert.equal(s.index, i));
    for (const kind of ['start', 'last30']) {
      const q = f.queries[kind];
      assert.equal(q.vehicles.length, f.vehicles.length, `${kind}: a query result per vehicle`);
      assert.equal(q.stations.length, f.stations.length, `${kind}: a query result per station`);
      assert.equal(f.windows[kind].kind, kind);
      q.vehicles.forEach((v, i) => {
        assert.equal(v.index, i);
        assert.ok(Math.abs(Object.keys(v.timeSplit).filter((k) => !k.startsWith('driving') || k === 'driving').filter((k) => k !== 'seconds').reduce((n, k) => n + v.timeSplit[k], 0) - v.timeSplit.seconds) < 1e-6, `${kind} vehicle ${i}: the split adds up`);
        assert.equal(kind === 'start', v.hotspots !== null, 'cell tables are since start only');
        for (const r of v.routes) {
          assert.ok(r.pathShare >= 0 && r.pathShare <= 1 && r.drawn + r.undrawn === r.trips);
          if (r.pathId >= 0) assert.ok(String(r.pathId) in f.paths, `path ${r.pathId} is in the fixture`);
          for (const p of r.pathIds) assert.ok(String(p.id) in f.paths);
        }
      });
      for (const r of q.busiestRoutes.routes) if (r.pathId >= 0) assert.ok(String(r.pathId) in f.paths);
      for (const r of q.loadedRoutes) if (r.pathId >= 0) assert.ok(String(r.pathId) in f.paths);
    }
    for (const [id, nodes] of Object.entries(f.paths)) { assert.ok(nodes.length >= 2, `path ${id}`); assert.ok(nodes.every((n) => Number.isInteger(n) && n >= 0 && n < f.graph.cols * f.graph.rows)); }
    assert.equal(f.report.fleets && Object.keys(f.report.fleets).length > 0, true);
    assert.ok(Array.isArray(f.insights));
    assert.deepEqual(Object.keys(f.report), ['window', 'throughput', 'leadTime', 'wip', 'stations', 'fleets', 'flows', 'traffic', 'orders', 'series', ...(f.report.ops ? ['ops'] : [])]);
  });
}

test('the fake collector answers every query exactly as the live collector does (both windows, every vehicle and station)', async () => {
  for (const name of ['two-lines-agv1.json', 'warehouse-goods-in.json']) {
    const spec = FIXTURE_SPECS[name];
    const layout = EXAMPLES.find((e) => e.id === spec.example).build();
    if (spec.warmup !== null) layout.settings.warmup = spec.warmup;
    const sim = new Simulation(layout, { seed: spec.seed });
    const det = sim.enableDetail();
    sim.advance(spec.seconds);
    const fixture = readFixture(name);
    const fake = createFakeDetail(fixture);
    const norm = (x) => JSON.parse(JSON.stringify(x));
    for (const kind of ['start', 'last30']) {
      const w = det.windowOf(kind); const fw = fake.windowOf(kind);
      sameShape(fw, norm(w), `${name} window ${kind}`);
      det.V.forEach((_, i) => {
        sameShape(fake.timeSplit(i, fw), norm(det.timeSplit(i, w)), `${name} timeSplit ${kind} ${i}`);
        sameShape(fake.counts(i, fw), norm(det.counts(i, w)), `counts ${kind} ${i}`);
        sameShape(fake.batteryOf(i, fw), norm(det.batteryOf(i, w)), `batteryOf ${kind} ${i}`);
        sameShape(fake.routesOf(i, fw, [0, 1, 2, 3]), norm(det.routesOf(i, w, [0, 1, 2, 3])), `routesOf ${kind} ${i}`);
        sameShape(fake.routesOf(i, fw, [1]), norm(det.routesOf(i, w, [1])), `routesOf loaded ${kind} ${i}`);
        sameShape(fake.roundOf(i, fw), norm(det.roundOf(i, w, 2)), `roundOf ${kind} ${i}`);
        sameShape(fake.queuesOf(i, fw), norm(det.queuesOf(i, w)), `queuesOf ${kind} ${i}`);
        if (kind === 'start') { sameShape(fake.hotspots(i, 8), norm(det.hotspots(i, 8)), `hotspots ${i}`); sameShape(fake.idleSpots(i, 3), norm(det.idleSpots(i, 3)), `idleSpots ${i}`); }
        sameShape(fake.workingSeries(i), norm(det.workingSeries(i)), `workingSeries ${i}`);
        sameShape(fake.metresToGo(i), norm(det.metresToGo(i)), `metresToGo ${i}`);
      });
      det.stations.forEach((_, i) => {
        sameShape(fake.stationWindow(i, fw), norm(det.stationWindow(i, w)), `stationWindow ${kind} ${i}`);
        sameShape(fake.visitsTo(i, fw), norm(det.visitsTo(i, w)), `visitsTo ${kind} ${i}`);
        sameShape(fake.queueNow(i), norm(det.queueNow(i)), `queueNow ${i}`);
      });
      sameShape(fake.busiestRoutes(fw, 4), norm(det.busiestRoutes(w, 4)), `busiestRoutes ${kind}`);
      sameShape(fake.loadedRoutes({}, fw), norm(det.loadedRoutes({}, w)), `loadedRoutes ${kind}`);
    }
    for (const id of Object.keys(fixture.paths)) assert.deepEqual(Array.from(fake.pool.nodes(Number(id))), Array.from(det.pool.nodes(Number(id))), `path ${id}`);
    assert.equal(fake.pool.len[Number(Object.keys(fixture.paths)[0])], det.pool.len[Number(Object.keys(fixture.paths)[0])]);
    for (const [k, h] of det.pickWait) assert.ok(Math.abs(fake.pickWait.get(k).percentile(0.9) - h.percentile(0.9)) < 1e-9);
    for (const [k, h] of det.yardWait) assert.ok(Math.abs(fake.yardWait.get(k).percentile(0.5) - h.percentile(0.5)) < 1e-9);
    for (const [k, s] of det.sinkLead) assert.ok(Math.abs(fake.sinkLead.get(k).percentile(0.9) - s.percentile(0.9)) < 1e-9);
    assert.equal(fake.vehicleIndex(det.V[2].id), 2); assert.equal(fake.vehicleIndex('nope'), -1);
    assert.equal(fake.timeSplit(99, fw0()).seconds, 0, 'a bad index answers like the live collector');
    // a fixture is data: what a query returns can be changed without touching the fixture
    const a = fake.timeSplit(0, fake.windowOf('start')); a.driving = -5;
    assert.notEqual(fake.timeSplit(0, fake.windowOf('start')).driving, -5);
    const wrapped = fixtureDetailSim(fixture);
    assert.equal(wrapped.detail.sim, wrapped); assert.equal(typeof wrapped.kpis().window.duration, 'number');
  }
});
function fw0() { return { kind: 'start' }; }

test('snapshotDetail refuses a simulation without a collector, and a snapshot never holds a NaN', () => {
  const sim = new Simulation(EXAMPLES.find((e) => e.id === 'starter').build(), { seed: 1 });
  assert.throws(() => snapshotDetail(sim), /no collector/);
  assert.throws(() => assertFinite({ a: [1, { b: NaN }] }), /non-finite number at \$\.a\[1\]\.b/);
  assert.throws(() => assertFinite({ a: Infinity }), /non-finite/);
  assert.doesNotThrow(() => assertFinite({ a: [1, null, 'x'] }));
});
