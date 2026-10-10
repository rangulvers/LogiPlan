// Trucks and dock doors, attacked with random plants (docs/WAREHOUSE-DESIGN.md 6.3, milestone M1; acceptance A1.3, A1.4, A1.8 and A1.9 at scale).
//
// 200 random plants with trucks (tests/helpers/trucks-gen.js fuzzPlant: a busy Manhattan grid for even seeds, a hostile plant with one-way roads
// and extreme settings for odd ones) run with EVERY invariant asserted after EVERY tick: conservation created = live + retired with the pallets that
// trucks hold counted as live (tests/helpers/logistics-invariants.js), the claimed-prefix rule, capacities, and the truck invariants of 6.3.5
// (docked <= doors open, FIFO gate, a pallet on at most one truck, loaded <= plan, `left` = pallets not picked up, room >= 0, staged <= staging
// space). A live Stats rides along: report.ops has no NaN or Infinity anywhere, its counters equal those of the truck desks, and its shape is the
// documented one. The runs also assert that the generator reaches the corners of the engine (so a passing run means something).
//
// Heavy tier (scripts/test-tiers.mjs): about a minute of CPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWorld, eventDigest, nonFinitePaths } from './helpers/logistics-invariants.js';
import { createRealWorld } from './helpers/logistics-review-gen.js';
import { attachStats, fuzzPlant, runTrucks, truckDigest } from './helpers/trucks-gen.js';

const DTS = [0.1, 0.25, 0.5, 1];
const styleOf = (seed) => (seed % 2 === 0 ? 'busy' : 'hostile');
/** Simulated seconds of a plant: the finest ticks get the shortest runs (the checks cost the same per tick), a hostile plant carries many more pallets than a busy one. */
const secondsOf = (seed) => [600, 400, 1500, 700][seed % 4];
const truckStations = (w) => w.lg.stations.filter((st) => st.trucks !== null);

const STATION_KEYS = 'name,role,doors,trucks,gateWait,doorTime,turnaround,doorUtilization,gateQueue,doorsBusyNow,fillRate,gateQueueSeries';

/** report.ops of a world with Stats: the shape, no NaN, and every counter equal to the desk's. */
function checkReport(w, label) {
  const report = w.stats.report();
  assert.deepEqual(Object.keys(report.ops), ['trucks'], `${label}: report.ops holds the trucks section`);
  assert.deepEqual(nonFinitePaths(report.ops), [], `${label}: no NaN or Infinity in report.ops`);
  const stations = truckStations(w);
  assert.deepEqual(Object.keys(report.ops.trucks).sort(), stations.map((st) => st.id).sort(), `${label}: one entry per truck station`);
  for (const st of stations) {
    const entry = report.ops.trucks[st.id];
    const desk = st.trucks;
    assert.equal(Object.keys(entry).join(), STATION_KEYS, `${label}/${st.id}: keys`);
    assert.equal(entry.role, desk.role);
    assert.equal(entry.doors, desk.doors);
    assert.deepEqual(entry.trucks, { arrived: desk.arrived, docked: desk.nDocked, departed: desk.departed, short: desk.short, noShow: desk.noShow, turnedAway: desk.turnedAway }, `${label}/${st.id}: counters`);
    assert.ok(entry.doorUtilization >= 0 && entry.doorUtilization <= 1, `${label}/${st.id}: doorUtilization ${entry.doorUtilization}`);
    assert.ok(entry.gateQueue.now === desk.gate.length && entry.gateQueue.max >= entry.gateQueue.now && entry.gateQueue.mean >= 0 && entry.gateQueue.mean <= entry.gateQueue.max + 1e-9, `${label}/${st.id}: gate queue ${JSON.stringify(entry.gateQueue)}`);
    assert.equal(entry.doorsBusyNow, desk.docked.length);
    if (entry.gateWait.mean !== null) assert.ok(entry.gateWait.mean <= entry.gateWait.max + 1e-9 && entry.gateWait.p90 <= entry.gateWait.max + 1e-9, `${label}/${st.id}: gate wait ${JSON.stringify(entry.gateWait)}`);
    if (desk.role === 'in') assert.equal(entry.fillRate, null, 'a Goods in has no fill rate');
    else if (entry.fillRate !== null) assert.ok(entry.fillRate >= 0 && entry.fillRate <= 1);
    assert.equal(entry.gateQueueSeries.length, report.series.t.length, `${label}/${st.id}: one gate queue point per point of the series`);
  }
  return report;
}

test('A1.3 / A1.4: 200 random plants with trucks keep every invariant on every tick, report.ops is clean and agrees with the desks, with runtime what-ifs in between', () => {
  const PLANTS = 200;
  const cover = {
    plants: 0, rate: 0, timetable: 0, goodsIn: 0, goodsOut: 0, arrivals: 0, departedIn: 0, departedOut: 0, shortOut: 0, fullOut: 0, noShow: 0, turnedAway: 0,
    closing: 0, staged: 0, gateQueue: 0, doorsAllBusy: 0, whatIf: 0, completed: 0, jitter: 0,
  };
  for (let seed = 1; seed <= PLANTS; seed++) {
    const seconds = secondsOf(seed);
    const layout = fuzzPlant(seed, { style: styleOf(seed), horizon: seconds });
    const w = attachStats(createWorld(layout, { dt: DTS[seed % 4], seed }));
    const segment = seconds / 3;
    const factors = [null, [0, 3, 0.5, 1][seed % 4], 1];
    let closing = false;
    let staged = false;
    let gateQueue = false;
    for (let part = 0; part < 3; part++) {
      if (factors[part] !== null && seed % 3 !== 0) { w.lg.setRuntime({ demandFactor: factors[part] }); cover.whatIf++; }
      // every tick: the invariants; in between, look at what the trucks do
      const ticks = Math.round(segment / w.dt);
      for (let i = 0; i < ticks; i++) {
        runTrucks(w, w.dt);
        for (const st of truckStations(w)) {
          const d = st.trucks;
          if (!closing && d.docked.some((k) => k.closing)) closing = true;
          if (!staged && d.staged.length > 0) staged = true;
          if (!gateQueue && d.gate.length > 0) gateQueue = true;
        }
      }
      checkReport(w, `seed ${seed} part ${part}`);
    }
    cover.plants++;
    if (closing) cover.closing++;
    if (staged) cover.staged++;
    if (gateQueue) cover.gateQueue++;
    cover.completed += w.lg.completed;
    for (const st of truckStations(w)) {
      const d = st.trucks;
      if (d.mode === 'rate') cover.rate++;
      else cover.timetable++;
      if (d.cfg.jitter > 0 && d.mode === 'schedule') cover.jitter++;
      cover.arrivals += d.arrived;
      cover.noShow += d.noShow;
      cover.turnedAway += d.turnedAway;
      if (d.docked.length === d.doors) cover.doorsAllBusy++;
      if (d.role === 'in') {
        cover.goodsIn++;
        cover.departedIn += d.departed;
      } else {
        cover.goodsOut++;
        cover.departedOut += d.departed;
        cover.shortOut += d.short;
        cover.fullOut += d.departed - d.short;
      }
    }
  }
  if (process.env.TRUCKS_FUZZ_VERBOSE) console.log(JSON.stringify(cover));
  // the generator really reaches the corners (thresholds well below what one run shows, above what a broken generator gives)
  assert.equal(cover.plants, PLANTS);
  assert.ok(cover.rate >= 100 && cover.timetable >= 60, `rate ${cover.rate}, timetable ${cover.timetable}`);
  assert.ok(cover.goodsIn >= 150 && cover.goodsOut >= 150, `Goods in ${cover.goodsIn}, Goods out ${cover.goodsOut}`);
  assert.ok(cover.arrivals >= 5000, `arrivals ${cover.arrivals}`);
  // (300 before the rows of a timetable got streams of their own, M1-SIM-REV-4: the draws changed, 287 to 310 depending on the draws; the bar is a sanity bar for the generator)
  assert.ok(cover.departedIn >= 250 && cover.departedOut >= 300, `departed in ${cover.departedIn}, out ${cover.departedOut}`);
  assert.ok(cover.shortOut >= 100 && cover.fullOut >= 100, `outbound short ${cover.shortOut}, full ${cover.fullOut}`);
  assert.ok(cover.noShow >= 300 && cover.turnedAway >= 100, `no-shows ${cover.noShow}, turned away ${cover.turnedAway}`);
  assert.ok(cover.closing >= 20 && cover.staged >= 30 && cover.gateQueue >= 100, `closing ${cover.closing}, staged ${cover.staged}, gate queue ${cover.gateQueue}`);
  assert.ok(cover.doorsAllBusy >= 100 && cover.jitter >= 30, `doors all busy ${cover.doorsAllBusy}, jitter ${cover.jitter}`);
  assert.ok(cover.whatIf >= 100 && cover.completed >= 10000, `what-ifs ${cover.whatIf}, completed ${cover.completed}`);
});

test('A1.3 / A1.4 on the real traffic system: 24 busy plants with trucks, invariants on every tick, a live Stats with a clean report.ops', () => {
  for (let seed = 301; seed <= 324; seed++) {
    const layout = fuzzPlant(seed * 2, { style: 'busy' });
    const w = createRealWorld(layout, { dt: 0.2, seed, check: true, stats: true });
    w.run(300);
    checkReport(w, `real seed ${seed}`);
    w.run(300);
    const report = checkReport(w, `real seed ${seed} end`);
    const stats = Object.values(report.ops.trucks);
    assert.ok(stats.length >= 1);
  }
});

// ---- determinism, dt, forks at scale (A1.8, A1.9) ----------------------------------------------------------------------

/** The nominal times and plans of everything that happened at the gate of one station before `until`: arrivals, turned away, no-shows. */
function gateRecord(events, stationId, until) {
  return events
    .filter((e) => ['truckArrived', 'truckTurnedAway', 'truckNoShow'].includes(e.name) && e.payload.stationId === stationId && e.payload.at <= until)
    .map((e) => `${e.name === 'truckNoShow' ? 'no-show' : 'truck'}@${e.payload.at.toFixed(6)}${e.name === 'truckNoShow' ? '' : `x${e.payload.truck ? e.payload.truck.plan : e.payload.plan}`}`);
}

test('A1.9 at scale: the same seed gives the same digests on 20 random plants, and a different seed does not', () => {
  for (let seed = 1; seed <= 20; seed++) {
    const layout = fuzzPlant(seed, { style: styleOf(seed) });
    const run = (s) => {
      const w = createWorld(layout, { dt: 0.5, seed: s });
      w.run(600);
      return [eventDigest(w.events), truckDigest(w.events)];
    };
    const [d1, t1] = run(seed);
    const [d2, t2] = run(seed);
    assert.equal(d1, d2, `seed ${seed}`);
    assert.equal(t1, t2, `seed ${seed}`);
    if (t1.length > 200) assert.notEqual(run(seed + 1000)[1], t1, `seed ${seed}: another seed gives other trucks`);
  }
});

test('A1.8 at scale: the arrival times and pallets of the trucks do not depend on dt (40 random plants, dt 0.1 against 0.25 and 1)', () => {
  let compared = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const layout = fuzzPlant(seed, { style: styleOf(seed) });
    const until = 600;
    const records = [0.1, 0.25, 1].map((dt) => {
      const w = createWorld(layout, { dt, seed });
      w.run(until + 5);
      return truckStations(w).map((st) => gateRecord(w.events, st.id, until));
    });
    assert.deepEqual(records[1], records[0], `seed ${seed}: dt 0.25 sees the trucks of dt 0.1`);
    assert.deepEqual(records[2], records[0], `seed ${seed}: dt 1 sees the trucks of dt 0.1`);
    compared += records[0].reduce((n, list) => n + list.length, 0);
  }
  assert.ok(compared >= 500, `${compared} gate events compared`);
});

test('A1.9 at scale: taking the trucks away from one station does not change the arrival times of the others (fork independence, 40 random plants)', () => {
  let compared = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const layout = fuzzPlant(seed, { style: styleOf(seed) });
    const withTrucks = layout.stations.filter((st) => st.ops && st.ops.trucks);
    if (withTrucks.length < 2) continue;
    // the same plant without the trucks of the last truck station (it becomes a legacy station with its own draws)
    const reduced = structuredClone(layout);
    const gone = withTrucks[withTrucks.length - 1].id;
    delete reduced.stations.find((st) => st.id === gone).ops;
    const record = (lay) => {
      const w = createWorld(lay, { dt: 0.5, seed });
      w.run(700);
      return withTrucks.filter((st) => st.id !== gone).map((st) => gateRecord(w.events, st.id, 690));
    };
    const a = record(layout);
    const b = record(reduced);
    assert.deepEqual(b, a, `seed ${seed}: the other truck stations see exactly the same trucks without ${gone}`);
    compared += a.reduce((n, list) => n + list.length, 0);
  }
  assert.ok(compared >= 100, `${compared} gate events compared`);
});
