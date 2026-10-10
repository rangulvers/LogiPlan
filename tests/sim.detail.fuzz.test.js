// Fuzz and property tests of the detail collector on hostile plants (docs/ENTITY-INSIGHTS-DESIGN.md 10.6, 10.7). HEAVY. The generators are the repository's own
// (tests/helpers/engine-review-gen.js hostilePlant, m1-sim-review-gen.js hostileTruckPlant with trucks, deadlocks, breakdowns, batteries, removals; the frozen dock plants).
//   * BALANCE: on 220 hostile truck plants, 40 hostile plants, the five dock plants and the five examples, no vehicle has fewer loaded legs than deliveries (less the one
//     that was unloading when the window began), at most 1 + the cancelled orders more, and the leg log holds exactly the legs the balance counts
//   * AUDIT every 120 s on dock-dense plants, breakdowns and batteries, deadlocks: the split of every vehicle adds up to the window and to the fleet shares of the report,
//     every logged path is a chain of linked road cells, leg start times never decrease per vehicle, the ring and the pool are consistent
//   * PROPERTY: no query returns a NaN or an Infinity; no share is above 100 %; a route share is at most 1 and its variants add up to the drawn trips
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../js/sim/engine.js';
import { EXAMPLES } from '../js/model/examples.js';
import { FLAG, NO_STATION, SLOT_KEYS } from '../js/sim/detail.js';
import { DOCKPLANT_SEEDS, dockPlantLayoutFile, readGolden } from './helpers/golden.js';
import { hostilePlant } from './helpers/engine-review-gen.js';
import { hostileTruckPlant } from './helpers/m1-sim-review-gen.js';
import { callEveryQuery } from './helpers/detail-digest.js';
import { assertFinite } from './helpers/detail-snapshot.js';

const REPORT_SLOTS = ['driving', 'waiting', 'loading', 'unloading', 'idle', 'parked', 'charging', 'broken'];
const example = (id, warmup = 600) => { const layout = EXAMPLES.find((e) => e.id === id).build(); layout.settings.warmup = warmup; return layout; };
const dockPlant = (seed) => JSON.parse(readGolden(dockPlantLayoutFile(seed)));
const total = (t) => SLOT_KEYS.reduce((n, k) => n + t[k], 0);

/** Run a truck plant with its demand actions (no removals) while counting the orders each vehicle had cancelled. */
function runCounting(layout, seconds, seed, actions = []) {
  const sim = new Simulation(layout, seed === undefined ? {} : { seed });
  sim.enableDetail();
  const cancelled = new Map();
  sim.on('orderCancelled', (p) => cancelled.set(p.vehicleId, (cancelled.get(p.vehicleId) || 0) + 1));
  const pending = actions.filter((a) => a.kind !== 'removeVehicle').map((a) => ({ ...a }));
  while (sim.time < seconds) {
    while (pending.length && pending[0].at <= sim.time + 1e-9) { const a = pending.shift(); if (a.value === 0) sim.logistics.setRuntime({ demandFactor: 0 }); else sim.setRuntime({ demandFactor: a.value }); }
    sim.step();
  }
  return { sim, cancelled };
}

/** Everything the balance promises, for one finished run; returns { vehicles, deliveries, surplus, zero, filed }. */
function balance(name, sim, cancelled) {
  const det = sim.detail;
  assert.ok(det && !det.failed, `${name}: the collector is attached`);
  const out = { vehicles: 0, deliveries: 0, surplus: 0, zero: 0, filed: det.balanceFiled };
  const rows = new Int32Array(det.nV);
  const L = det.legs;
  const wrapped = L.count > L.cap;
  for (let k = 0; k < L.size; k++) { const r = L.at(k); if (L.kind[r] === 1) rows[L.veh[r]]++; if (L.kind[r] === 1 && (L.flags[r] & FLAG.ZERO)) out.zero++; }
  for (let i = 0; i < det.nV; i++) {
    const vr = det.V[i];
    const delivered = vr.trips - det.base[i * 4] - det.credit[i];
    const diff = det.legsLoaded[i] - delivered;
    out.vehicles++; out.deliveries += vr.trips - det.base[i * 4]; if (diff > 0) out.surplus += diff;
    assert.ok(diff >= 0, `${name} ${vr.id}: ${det.legsLoaded[i]} loaded legs for ${delivered} deliveries (state ${vr.state})`);
    assert.ok(diff <= 1 + (cancelled.get(vr.id) || 0), `${name} ${vr.id}: ${diff} more loaded legs than deliveries (cancelled ${cancelled.get(vr.id) || 0})`);
    if (!wrapped) assert.equal(rows[i], det.legsLoaded[i], `${name} ${vr.id}: the log holds the legs the balance counts`);
  }
  return out;
}

test('BALANCE: 220 hostile truck plants, 40 hostile plants, the five dock plants and the five examples: every delivery has a loaded leg', () => {
  const tally = { plants: 0, vehicles: 0, deliveries: 0, surplus: 0, zero: 0, filed: 0 };
  const add = (b) => { tally.plants++; for (const k of ['vehicles', 'deliveries', 'surplus', 'zero', 'filed']) tally[k] += b[k]; };
  for (let seed = 1; seed <= 220; seed++) { const { layout, actions } = hostileTruckPlant(seed, { horizon: 1500 }); const { sim, cancelled } = runCounting(layout, 1500, seed, actions); add(balance(`truck plant ${seed}`, sim, cancelled)); }
  for (let seed = 1; seed <= 40; seed++) { let layout; try { layout = hostilePlant(seed); } catch { continue; } const { sim, cancelled } = runCounting(layout, 1200, seed); add(balance(`hostile ${seed}`, sim, cancelled)); }
  for (const seed of DOCKPLANT_SEEDS) { const { sim, cancelled } = runCounting(dockPlant(seed), 1800); add(balance(`dock plant ${seed}`, sim, cancelled)); }
  for (const e of EXAMPLES) { const { sim, cancelled } = runCounting(example(e.id), 5400, 1); add(balance(e.id, sim, cancelled)); }
  assert.ok(tally.plants >= 260, `${tally.plants} plants`);
  assert.ok(tally.deliveries > 3000, `${tally.deliveries} deliveries`);
  assert.ok(tally.zero > 0 && tally.filed > 0, `zero-length loaded legs exist (${tally.zero}) and some were found only by the balance (${tally.filed}): the spike had 49 and 36 on 270 plants`);
});

/** The audit of one finished or running simulation: see the header. */
function audit(name, sim) {
  const det = sim.detail;
  const rep = sim.kpis(); const dur = rep.window.duration; const g = sim.graph;
  if (!(dur > 0)) return; // still warming up: the report has no window yet
  for (const [fid, f] of Object.entries(rep.fleets)) {
    const vs = det.V.map((vr, i) => [vr, i]).filter(([vr]) => vr.fleetId === fid);
    const n = vs.length;
    if (!n) continue;
    const sums = Object.fromEntries(REPORT_SLOTS.map((k) => [k, 0]));
    for (const [, i] of vs) {
      const t = det.timeSplit(i);
      assert.ok(Math.abs(t.seconds - dur) <= sim.dt * 1.01, `${name}: seconds ${t.seconds} against the window ${dur}`);
      assert.ok(Math.abs(total(t) - t.seconds) < 1e-9);
      sums.driving += t.driving; sums.waiting += t.waiting + t.dockQueue;
      for (const k of ['loading', 'unloading', 'idle', 'parked', 'charging', 'broken']) sums[k] += t[k];
    }
    for (const k of REPORT_SLOTS) assert.ok(Math.abs(sums[k] / (n * dur) - f.shares[k]) * n < 1e-6, `${name}: ${fid} ${k} ${sums[k] / (n * dur)} against ${f.shares[k]}`);
  }
  const L = det.legs; const last = new Float64Array(det.nV).fill(-1);
  for (let k = 0; k < L.size; k++) {
    const r = L.at(k);
    assert.ok(L.t0[r] >= last[L.veh[r]] - 1e-9, `${name}: vehicle ${L.veh[r]}: a leg starts at ${L.t0[r]}, before the previous one at ${last[L.veh[r]]}`);
    last[L.veh[r]] = Math.max(last[L.veh[r]], L.t0[r]);
    assert.ok(L.dur[r] >= 0 && L.dur[r] <= sim.time + 1, `${name}: leg duration ${L.dur[r]}`);
    assert.ok(L.wait[r] <= L.dur[r] + 1e-3 || (L.flags[r] & FLAG.PAUSED) || (L.flags[r] & FLAG.PARTIAL), `${name}: a leg of ${L.dur[r]} s held up for ${L.wait[r]} s`);
    assert.ok(L.dockWait[r] <= L.wait[r] + 1e-6, `${name}: queue seconds are part of the held-up seconds`);
    const pid = L.path[r];
    if (pid >= 0) {
      const nodes = det.pool.nodes(pid);
      for (let j = 0; j + 1 < nodes.length; j++) if (g.edgeBetween(nodes[j], nodes[j + 1]) < 0) assert.fail(`${name}: path ${pid} is not a chain of linked cells at step ${j}`);
    } else assert.ok(pid === -1 || pid === -2);
  }
  assert.ok(det.pool.size <= det.pool.cap);
  assert.ok(det.bCount === Math.floor((sim.time - det.windowStart + 1e-9) / 30) || Math.abs(det.bCount - (sim.time - det.windowStart) / 30) < 1.01);
}

async function auditRun(name, layout, seconds, opts = {}) {
  const sim = new Simulation(layout, opts);
  sim.enableDetail();
  for (let t = 0; t < seconds; t += 120) { sim.advance(120); audit(name, sim); }
  return sim;
}

test('AUDIT: the five frozen dock plants every 120 s', async () => {
  for (const seed of DOCKPLANT_SEEDS) await auditRun(`dock plant ${seed}`, dockPlant(seed), 1800);
});

test('AUDIT: Two lines with breakdowns and short batteries, and the Congestion lab with fast vehicles (deadlocks), every 120 s', async () => {
  const layout = example('two-lines');
  for (const f of layout.fleets) { f.mtbf = 20 * 60; f.mttr = 4 * 60; f.battery = { enabled: true, runtimeMin: 60, chargeTimeMin: 15, lowPct: 25, resumePct: 80 }; }
  const a = await auditRun('two lines, breakdowns and batteries', layout, 7200, { seed: 5 });
  const L = a.detail.legs; let paused = 0; for (let k = 0; k < L.size; k++) if (L.flags[L.at(k)] & FLAG.PAUSED) paused++;
  assert.ok(paused > 0, 'breakdowns paused legs');
  const lab = example('congestion-lab'); lab.settings.deadlock = 'resolve'; for (const f of lab.fleets) f.speed *= 1.6;
  await auditRun('congestion lab, fast vehicles', lab, 5400, { seed: 7 });
});

test('AUDIT: twelve hostile plants (long vehicles, coarse ticks, dead ends, islands, empty fleets, batteries without chargers) every 120 s', async () => {
  let n = 0;
  for (let seed = 1; seed <= 60 && n < 12; seed += 3) {
    let layout; try { layout = hostilePlant(seed); } catch { continue; }
    await auditRun(`hostile ${seed}`, layout, 960, { seed }); n++;
  }
  assert.ok(n >= 12);
});

test('PROPERTY: no query returns a NaN or an Infinity, no share is above 100 %, a route share is at most 1 and its variants add up to the drawn trips', () => {
  const plants = [['two-lines', example('two-lines')], ['warehouse', example('warehouse-first-day')], ['dock 44', dockPlant(44)], ['dock 13', dockPlant(13)]];
  for (let seed = 1; seed <= 16; seed++) plants.push([`truck plant ${seed}`, hostileTruckPlant(seed, { horizon: 1200 }).layout]);
  for (const [name, layout] of plants) {
    const sim = new Simulation(layout, { seed: 2 });
    sim.enableDetail();
    for (const step of [0, 45, 700, 2100]) {
      sim.advance(step === 0 ? 0.1 : step);
      const det = sim.detail;
      callEveryQuery(det);
      for (const w of [det.windowOf('start'), det.windowOf('last30')]) {
        assertFinite(w);
        for (let i = 0; i < det.nV; i++) {
          const t = det.timeSplit(i, w); assertFinite(t, `${name} timeSplit`);
          if (t.seconds > 0) for (const k of SLOT_KEYS) assert.ok(t[k] / t.seconds <= 1 + 1e-9, `${name}: a share of ${t[k] / t.seconds}`);
          assertFinite(det.counts(i, w)); assertFinite(det.batteryOf(i, w), `${name} battery`);
          const routes = det.routesOf(i, w, [0, 1, 2, 3]); assertFinite(routes.map((r) => ({ ...r, meanTime: r.meanTime ?? 0, meanWait: r.meanWait ?? 0, meanDockWait: r.meanDockWait ?? 0, meanQty: r.meanQty ?? 0, metres: r.metres ?? 0, usualTime: r.usualTime ?? 0, usualWait: r.usualWait ?? 0 })));
          for (const r of routes) {
            assert.ok(r.pathShare >= 0 && r.pathShare <= 1 + 1e-12 && r.complete <= r.trips && r.drawn + r.undrawn === r.trips, `${name}: route ${JSON.stringify(r).slice(0, 200)}`);
            assert.ok(r.pathIds.reduce((n, p) => n + p.n, 0) === r.drawn, `${name}: the variants add up to the drawn trips`);
            if (r.meanTime !== null) assert.ok(r.meanWait <= r.meanTime + 1e-3 && r.meanDockWait <= r.meanWait + 1e-3, `${name}: waiting above the leg time`);
          }
          const round = det.roundOf(i, w); if (round) assert.ok(round.share > 0 && round.share <= 1 && round.count <= round.of);
          for (const q of det.queuesOf(i, w)) assert.ok(q.seconds <= t.waiting + t.dockQueue + 1e-3 && q.seconds >= 0);
        }
        for (let k = 0; k < det.nS; k++) {
          const sw = det.stationWindow(k, w); assertFinite({ ...sw, bufferWait: sw.bufferWait ?? 0, yardWait: sw.yardWait ?? 0, intakeWait: sw.intakeWait ?? 0 }, `${name} station`);
          for (const key of ['busy', 'starved', 'blocked', 'down', 'fill']) assert.ok(sw[key] >= 0 && sw[key] <= 1 + 1e-9, `${name}: station ${key} ${sw[key]}`);
          assert.ok(sw.busy + sw.starved + sw.blocked + sw.down <= 1 + 1e-9);
        }
      }
      for (let i = 0; i < det.nV; i++) {
        const h = det.hotspots(i, 8); assertFinite(h);
        for (const c of h.cells) assert.ok(c.seconds <= h.total + 1e-3);
        assert.ok(h.cells.reduce((n, c) => n + c.seconds, 0) <= det.timeSplit(i).waiting + det.timeSplit(i).dockQueue + 1e-3);
        assertFinite(det.idleSpots(i, 3)); assert.ok(det.workingSeries(i).every((x) => x >= -1e-9 && x <= 1 + 1e-6), `${name}: a working share above 100 %`);
      }
      const busy = det.busiestRoutes(det.windowOf('start'), 4); assertFinite(busy);
      assert.ok(busy.routes.reduce((n, r) => n + r.share, 0) <= 1 + 1e-9);
    }
  }
});

test('PROPERTY: enabled late, the window starts when it is enabled; the figures are those of that window and nothing more', () => {
  const sim = new Simulation(example('two-lines'), { seed: 1 });
  sim.advance(1500);
  const det = sim.enableDetail();
  assert.equal(det.windowStart, sim.time);
  sim.advance(900);
  for (let i = 0; i < det.nV; i++) assert.ok(Math.abs(total(det.timeSplit(i)) - 900) < 1e-6);
  assert.notEqual(det.windowStart, sim.kpis().window.start, 'the report\'s window started earlier: the dock says "counting since"');
  const w = det.windowOf('last30');
  assert.equal(w.zero, true);
  assert.equal(det.counts(0, w).trips <= sim.kpis().fleets[det.V[0].fleetId].vehicleTrips[det.V[0].id], true);
  assert.notEqual(NO_STATION, 0);
});
