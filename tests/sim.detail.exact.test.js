// The detail collector against the engine's own report (docs/ENTITY-INSIGHTS-DESIGN.md 10.3, acceptance S1.3). Every figure the collector shares with the KPI report must be
// the report's figure; what only the collector has (legs, paths, cell tables, the Goods-in yard) is checked against independent tallies. HEAVY: five examples for 1.5 to 2
// simulated hours, the five frozen dock plants, a plant with breakdowns and batteries observed tick by tick, 3 h of the warehouse example.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../js/sim/engine.js';
import { EXAMPLES } from '../js/model/examples.js';
import { DRIVE_KEYS, FLAG, SLOT_KEYS } from '../js/sim/detail.js';
import { DOCKPLANT_SEEDS, dockPlantLayoutFile, readGolden } from './helpers/golden.js';

const example = (id, warmup = 600) => { const layout = EXAMPLES.find((e) => e.id === id).build(); layout.settings.warmup = warmup; return layout; };
const dockPlant = (seed) => JSON.parse(readGolden(dockPlantLayoutFile(seed)));
const REPORT_SLOTS = ['driving', 'waiting', 'loading', 'unloading', 'idle', 'parked', 'charging', 'broken'];
const PLANTS = [['starter', 1.5], ['two-lines', 1.5], ['congestion-lab', 1.5], ['dock-lab', 2], ['warehouse-first-day', 2]];

/** Compare the collector with the report of a finished run; returns the worst differences for the log line. */
function audit(name, sim) {
  const det = sim.detail;
  const rep = sim.kpis();
  const dur = rep.window.duration;
  const w = det.windowOf('start');
  const worst = { share: 0, seconds: 0, waiting: 0, trips: 0, sub: 0, hot: 0, station: 0, fill: 0, counters: 0, dockq: 0 };
  let sumWaitC = 0; let sumWaitR = 0; let dockQ = 0;
  for (const [fid, f] of Object.entries(rep.fleets)) {
    const vs = det.V.map((vr, i) => [vr, i]).filter(([vr]) => vr.fleetId === fid);
    const n = vs.length;
    if (n === 0) continue;
    const sums = Object.fromEntries(REPORT_SLOTS.map((k) => [k, 0]));
    for (const [vr, i] of vs) {
      const t = det.timeSplit(i, w);
      worst.seconds = Math.max(worst.seconds, Math.abs(t.seconds - dur));
      worst.sub = Math.max(worst.sub, Math.abs(t.drivingLoaded + t.drivingEmpty + t.drivingDepot - t.driving));
      sums.driving += t.driving; sums.waiting += t.waiting + t.dockQueue; sums.loading += t.loading; sums.unloading += t.unloading; sums.idle += t.idle; sums.parked += t.parked; sums.charging += t.charging; sums.broken += t.broken;
      dockQ += t.dockQueue;
      const c = det.counts(i, w);
      worst.trips = Math.max(worst.trips, Math.abs(c.trips - f.vehicleTrips[vr.id]));
      let loaded = 0; for (const g of det.routesOf(i, w, [1])) loaded += g.trips;
      assert.ok(loaded >= c.trips - det.credit[i] && loaded - c.trips <= 1 + 3, `${name} ${vr.id}: ${loaded} loaded legs for ${c.trips} deliveries (credit ${det.credit[i]})`);
    }
    for (const k of REPORT_SLOTS) worst.share = Math.max(worst.share, Math.abs(sums[k] / (n * dur) - f.shares[k]) * n);
    sumWaitC += sums.waiting; sumWaitR += f.shares.waiting * n * dur;
  }
  worst.waiting = Math.abs(sumWaitC - sumWaitR);
  // the cells: every second the engine booked on a cell is in a table of some vehicle
  const heat = sim.heat();
  const byNode = new Float64Array(sim.graph.nodeCount);
  let folded = 0;
  for (let i = 0; i < det.nV; i++) {
    if (det.curNode[i] >= 0) byNode[det.curNode[i]] += det.curSecs[i];
    for (const T of [det.hot, det.hotStray]) { for (let k = i * 24; k < (i + 1) * 24; k++) if (T.keys[k] >= 0) byNode[T.keys[k]] += T.secs[k]; folded += T.other[i]; }
  }
  const top = rep.traffic.hotspots.slice(0, 3);
  for (const h of top) worst.hot = Math.max(worst.hot, Math.abs(byNode[h.node] - h.wait) / Math.max(1, h.wait));
  if (folded === 0) for (let nd = 0; nd < byNode.length; nd++) worst.hot = Math.max(worst.hot, Math.abs(byNode[nd] - heat.nodeWait[nd]) / Math.max(1, heat.nodeWait[nd]));
  // the dock queue against the dock book (which books once a second, sample and hold)
  const dockBook = Object.values(rep.stations).reduce((s, st) => s + (st.dockWaitTotal || 0), 0);
  worst.dockq = Math.abs(dockQ - dockBook) / Math.max(30, dockBook);
  // stations
  det.stations.forEach((st, i) => {
    const r = rep.stations[st.id];
    if (!r) return;
    const sw = det.stationWindow(i, w);
    if (st.type === 'process') worst.station = Math.max(worst.station, Math.abs(sw.busy - r.utilization), Math.abs(sw.starved - r.starved), Math.abs(sw.blocked - r.blocked), Math.abs(sw.down - r.down));
    if (st.type === 'storage') worst.fill = Math.max(worst.fill, Math.abs(sw.fill - r.avgFill));
    worst.counters = Math.max(worst.counters, Math.abs(sw.produced - r.produced), Math.abs(sw.consumed - r.consumed), Math.abs(sw.arrivals - r.arrivals));
    for (const s of [sw.busy, sw.starved, sw.blocked, sw.down, sw.fill]) assert.ok(s >= 0 && s <= 1 + 1e-9, `${name} ${st.id}: a share of ${s}`);
  });
  // the packed paths decode to the routes they were interned from
  let bad = 0;
  for (const vr of det.V) {
    const r = vr.route;
    if (!r || r.nodes.length < 2) continue;
    const id = det.pool.intern(r);
    if (id < 0) continue;
    const nodes = det.pool.nodes(id);
    if (nodes.length !== r.nodes.length || nodes.some((x, k) => x !== r.nodes[k])) bad++;
  }
  assert.equal(bad, 0, `${name}: packed paths decode to their routes`);
  assert.ok(det.memoryBytes < 3.5 * 1024 * 1024);
  return { worst, folded, sumWaitC, sumWaitR, dockQ, dockBook };
}

for (const [id, hours] of PLANTS) {
  test(`exact: ${id} for ${hours} h: time split, waiting, trips, hot spots, dock queue and station figures equal the report`, () => {
    const sim = new Simulation(example(id), { seed: 1 });
    sim.enableDetail();
    sim.advance(3600 * hours);
    const { worst, sumWaitC, sumWaitR, dockQ, dockBook } = audit(id, sim);
    assert.ok(worst.share < 1e-9, `time split against fleet shares: ${worst.share}`);
    assert.ok(worst.seconds <= sim.dt * 1.01, `seconds per vehicle against the window: ${worst.seconds}`);
    assert.ok(worst.waiting < 1e-6 * Math.max(1, sumWaitR), `waiting seconds ${sumWaitC} against ${sumWaitR}`);
    assert.ok(worst.sub < 1e-6, `the three driving sub-slots add up to driving: ${worst.sub}`);
    assert.equal(worst.trips, 0, 'deliveries equal the report\'s vehicleTrips');
    assert.ok(worst.hot < 0.01, `top-3 hot spots (and every cell when nothing was folded): ${worst.hot}`);
    assert.ok(worst.dockq <= 0.03, `dock queue ${dockQ} against the dock book ${dockBook}: ${worst.dockq}`);
    assert.equal(worst.counters, 0, 'station counters are exact');
    assert.ok(worst.station < 0.01 && worst.fill < 0.01, `sampled station shares: ${worst.station}, fill ${worst.fill}`);
  });
}

for (const seed of DOCKPLANT_SEEDS) {
  test(`exact: frozen dock plant ${seed} for 30 min: the same figures equal the report`, () => {
    const sim = new Simulation(dockPlant(seed));
    sim.enableDetail();
    sim.advance(1800);
    const { worst, sumWaitC, sumWaitR } = audit(`dock plant ${seed}`, sim);
    assert.ok(worst.share < 1e-9, `${worst.share}`);
    assert.ok(worst.seconds <= sim.dt * 1.01);
    assert.ok(worst.waiting < 1e-6 * Math.max(1, sumWaitR), `${sumWaitC} against ${sumWaitR}`);
    assert.ok(worst.sub < 1e-6);
    assert.equal(worst.trips, 0);
    assert.ok(worst.hot < 0.01, `hot spots ${worst.hot}`);
    assert.equal(worst.counters, 0);
    assert.ok(worst.station < 0.01 && worst.fill < 0.01);
  });
}

test('exact: "Last 30 min" is the difference of two ring rows: it equals a direct reading of a second run at the row\'s time, and covers 30 minutes', () => {
  const run = (until) => { const sim = new Simulation(example('two-lines'), { seed: 1 }); const det = sim.enableDetail(); sim.advance(until); return { sim, det }; };
  const { sim, det } = run(2990);
  const w = det.windowOf('last30');
  assert.ok(w.seconds >= 1800 && w.seconds < 1800 + 30 + sim.dt, `covers ${w.seconds} s`);
  const direct = run(w.t0).det;
  const now = det.windowOf('start');
  let worst = 0; let worstCount = 0;
  for (let i = 0; i < det.nV; i++) {
    const a = det.timeSplit(i, w); const b = det.timeSplit(i, now); const c = direct.timeSplit(i, direct.windowOf('start'));
    for (const k of [...SLOT_KEYS, ...DRIVE_KEYS]) worst = Math.max(worst, Math.abs(a[k] - (b[k] - c[k])));
    assert.ok(Math.abs(a.seconds - w.seconds) < sim.dt * 1.01, 'the split adds up to the window');
    const ca = det.counts(i, w); const cb = det.counts(i, now); const cc = direct.counts(i, direct.windowOf('start'));
    worstCount = Math.max(worstCount, Math.abs(ca.trips - (cb.trips - cc.trips)), Math.abs(ca.loaded - (cb.loaded - cc.loaded)), Math.abs(ca.empty - (cb.empty - cc.empty)));
  }
  assert.ok(worst < 2e-3, `the float32 ring reads to half an ulp (about 1.2e-4 s at 2000 s of accumulated time); worst ${worst}`);
  assert.ok(worst / w.seconds < 1e-5, `relative to the 30 minutes (the design's "to 1e-5"): ${worst / w.seconds}`);
  assert.ok(worstCount < 0.01, `deliveries and metres: ${worstCount}`);
});

test('exact: the lowest battery of both windows equals an observer that reads the charge after every tick; charge stops are in the window they ended in', () => {
  const layout = example('two-lines', 300);
  for (const f of layout.fleets) f.battery = { enabled: true, runtimeMin: 45, chargeTimeMin: 12, lowPct: 25, resumePct: 80 };
  const sim = new Simulation(layout, { seed: 4 });
  const det = sim.enableDetail();
  const series = Array.from({ length: det.nV }, () => []);
  const step = sim.step.bind(sim);
  sim.step = (dt) => { step(dt); for (let i = 0; i < det.nV; i++) series[i].push(sim.time, det.V[i].battery); };
  sim.advance(300 + 3 * 3600 + 17);
  const wS = det.windowOf('start'); const wL = det.windowOf('last30');
  const direct = (i, t0) => { let m = 1; const s = series[i]; for (let k = 0; k < s.length; k += 2) if (s[k] > t0 + 1e-9 && s[k + 1] < m) m = s[k + 1]; return m; };
  let worstS = 0; let worstL = 0; let worstSub = 0; let worstSubL = 0; let stops = 0;
  for (let i = 0; i < det.nV; i++) {
    worstS = Math.max(worstS, Math.abs(det.batteryOf(i, wS).min - direct(i, det.windowStart)));
    worstL = Math.max(worstL, Math.abs(det.batteryOf(i, wL).min - direct(i, det.ringT[wL.row])));
    for (const [w, set] of [[wS, 'S'], [wL, 'L']]) { const t = det.timeSplit(i, w); const e = Math.abs(t.drivingLoaded + t.drivingEmpty + t.drivingDepot - t.driving); if (set === 'S') worstSub = Math.max(worstSub, e); else worstSubL = Math.max(worstSubL, e); }
    const ss = det.batteryOf(i, wS).stops.length; const sl = det.batteryOf(i, wL).stops.length;
    assert.ok(sl <= ss, 'stops in the last 30 minutes are among those since start');
    stops += ss;
  }
  assert.ok(stops > 0, 'vehicles charged, or the test checks nothing');
  assert.ok(worstS < 1e-6, `since start: ${worstS}`); assert.ok(worstL < 1e-5, `last 30 min: ${worstL}`);
  assert.ok(worstSub < 1e-6 && worstSubL < 1e-3, `sub-slots ${worstSub} ${worstSubL}`);
});

test('exact: the rows of "where it is held up" never exceed the Waiting tile, in both windows, and no share is above 100 % (plants with breakdowns, a congested one, docks)', () => {
  let worstRatio = 0; let worstRatioL = 0; let shareMax = 0; let rows = 0;
  for (const [id, hours, mtbf] of [['two-lines', 2.5, true], ['congestion-lab', 2, false], ['dock-lab', 2.5, false], ['warehouse-first-day', 3, false]]) {
    const layout = example(id);
    if (mtbf) for (const f of layout.fleets) { f.mtbf = 25 * 60; f.mttr = 5 * 60; }
    const sim = new Simulation(layout, { seed: 1 });
    const det = sim.enableDetail();
    sim.advance(3600 * hours);
    for (const w of [det.windowOf('start'), det.windowOf('last30')]) {
      for (let i = 0; i < det.nV; i++) {
        const t = det.timeSplit(i, w); const tile = t.waiting + t.dockQueue;
        const q = det.queuesOf(i, w).reduce((n, x) => n + x.seconds, 0);
        let cells = 0; let total = 0;
        if (w.kind === 'start' || w.zero) { const h = det.hotspots(i, 24); cells = h.cells.reduce((n, x) => n + x.seconds, 0); total = h.total; for (const c of h.cells) shareMax = Math.max(shareMax, c.seconds / Math.max(1e-9, total)); }
        rows++;
        assert.ok(q <= tile + 1e-6, `${id} ${det.V[i].id} ${w.kind}: queue rows ${q} above the tile ${tile}`);
        if (tile > 5) { const r = (q + cells) / tile; if (w.kind === 'start') worstRatio = Math.max(worstRatio, r); else worstRatioL = Math.max(worstRatioL, r); }
        for (const x of Object.values(t)) assert.ok(Number.isFinite(x) && x >= 0, `${id} ${det.V[i].id} ${w.kind}: ${x}`);
      }
    }
  }
  assert.ok(worstRatio <= 1.03 && worstRatioL <= 1.03, `rows over tile ${worstRatio} / ${worstRatioL}`);
  assert.ok(shareMax <= 1 + 1e-9, `a cell share of ${shareMax}`);
  assert.ok(rows > 50);
});

test('exact: Goods in with trucks (Warehouse first day, 3 h): the yard wait per pallet equals an independent tally that reads truck.releaseAt, in both windows', () => {
  const sim = new Simulation(EXAMPLES.find((e) => e.id === 'warehouse-first-day').build(), { seed: 1 });
  const det = sim.enableDetail();
  const trucks = new Map(); const log = []; const closeAt = [];
  sim.on('truckArrived', (p) => trucks.set(p.truck.id, p.truck));
  sim.on('orderPickedUp', (p) => {
    for (const l of p.order.loads) { const tk = l.tk >= 0 ? trucks.get(l.tk) : null; const rel = tk ? tk.releaseAt : l.createdAt; log.push({ t: p.t, from: p.order.from, yard: Math.max(0, l.readyAt - rel), buf: p.t - l.readyAt }); }
  });
  const step = sim.step.bind(sim); let lastB = 0;
  sim.step = (dt) => { step(dt); if (sim.detail && sim.detail.bCount !== lastB) { lastB = sim.detail.bCount; closeAt[lastB] = sim.time; } };
  sim.advance(3 * 3600);
  const si = det.stIndex.get('s1');
  assert.equal(sim.stations[si].type, 'source');
  const mean = (a, k) => a.reduce((n, x) => n + x[k], 0) / a.length;
  const wS = det.windowOf('start'); const sw = det.stationWindow(si, wS);
  const after = log.filter((x) => x.from === 's1' && x.t > det.windowStart);
  assert.ok(after.length > 100);
  assert.equal(sw.pallets, after.length);
  assert.ok(Math.abs(sw.yardWait - mean(after, 'yard')) < 1e-6, `${sw.yardWait} against ${mean(after, 'yard')}`);
  const wL = det.windowOf('last30'); const swl = det.stationWindow(si, wL);
  const jb = Math.max(0, det.bCount - 60);
  const afterL = log.filter((x) => x.from === 's1' && x.t > (jb === 0 ? det.windowStart : closeAt[jb]) + 1e-9);
  assert.ok(Math.abs(swl.yardWait - mean(afterL, 'yard')) < 0.01, `last 30 min: ${swl.yardWait} against ${mean(afterL, 'yard')} (${afterL.length} pallets)`);
  // the buffer wait per order is the report's own figure
  const flow = Object.values(sim.kpis().flows).find((f) => f.from === 's1');
  assert.ok(Math.abs(sw.bufferWait - flow.avgPickupWait) < 1e-6 * Math.max(1, flow.avgPickupWait), `${sw.bufferWait} against ${flow.avgPickupWait}`);
  // release to pickup = yard + buffer; "waiting now" counts the loads that are ready and not claimed
  const live = det.queueNow(si);
  let ready = 0; for (const link of sim.stations[si].outLinks) for (let k = link.claimed; k < link.queue.length; k++) if (!(link.queue[k].readyAt > sim.time)) ready++;
  assert.equal(live.loads, ready);
  const y = det.yardWait.get(si);
  assert.equal(y.n, sw.pallets); assert.ok(y.percentile(0.9) >= y.percentile(0.5));
  assert.ok(det.pickWait.get(si).n >= sw.orders);
});

test('exact: legs of a vehicle that started before the window are partial: trips, but not in the time statistics; the window counts from the reset', () => {
  const sim = new Simulation(example('two-lines'), { seed: 1 });
  const det = sim.enableDetail();
  sim.advance(590);
  const rep0 = det.legs.count;
  assert.ok(rep0 > 0, 'legs were logged during the warm-up');
  sim.advance(70);
  assert.ok(Math.abs(det.windowStart - sim.kpis().window.start) < 1e-9, 'the window starts with the statistics window');
  let partial = 0;
  for (let k = 0; k < det.legs.size; k++) { const r = det.legs.at(k); if (det.legs.flags[r] & FLAG.PARTIAL) { partial++; assert.equal(det.legs.t0[r], det.windowStart); } }
  assert.ok(partial > 0, 'drives in progress at the end of the warm-up became partial legs');
  assert.ok(det.legs.count < rep0 + 100);
});
