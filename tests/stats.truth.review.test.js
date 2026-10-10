// Adversarial review of the TRUTH of the numbers and the HONESTY of the sentences of the Statistics dock (docs/ENTITY-INSIGHTS-DESIGN.md 3, 4 and 5):
// js/ui/panels/stats-model.js driven exactly as the dock drives it (liveInput: the real Simulation with the collector on, sim.kpis(), sim.insights()), against oracles that were
// written from the DEFINITIONS of the design and never from js/sim/detail.js or from the model:
//   * an independent per-tick OBSERVER (tests/helpers/stats-truth-gen.js Observer) reads the public fields of every vehicle after every tick, classifies the tick itself, follows
//     the loaded legs by the states and the edges, and keeps snapshots every 30 s so that any window can be read;
//   * plants with a KNOWN answer (a straight corridor with exactly one route and 58 m between the two docks; two sinks fed 2 : 1 by the flow weights; a loop; a battery fleet;
//     a workstation that is saturated so that its real output is the capacity) built with the layout.js mutators;
//   * the Results tab (sim.kpis()) for everything the report holds; real n - 1 simulations for the fleet question; direct measurements (odometers, the dock book, the graph).
//
//   TRUTH-1  .. 10   what is TRUE and stays true (regression tests; they pass)
//     1  every tile, piece of the time split, driven share, battery figure and trip time of every vehicle equals the observer, Since start and Last 30 min
//     2  a corridor with exactly one route: one row, 58 m, always the same way, the usual round, the other drives, 27 trips an hour (loop time 132 s)
//     3  two sinks fed 2 : 1: the rows, their order, their metres (from the docks' cells)
//     4  the usual round of a loop against the observer's sequence of loaded trips
//     5  the report agrees: vehicle tiles against the Results fleet table, per vehicle and per fleet
//     6  the windows: 30.0 to 30.5 minutes, equal to Since start below 30, "indicative", "counting since"
//     7  the fleet question against a real simulation with one vehicle less (forecast within 5 points of the simulated busy share)
//     8  hostile plants (3 + 3 here, 40 + 40 with STATS_TRUTH_HEAVY): breakdowns, batteries, deadlocks, trucks, docks: every vehicle number equals the observer, no NaN, nothing above 100 %, the strips equal the report, the rows add up
//     9  one vehicle, no vehicle, a vehicle removed under a running collector
//    10  the words "usual", "N ways" and "always the same way" against the observer's count of the ways actually driven
//   STAT-REV-n       one test per REAL defect the review found. Each failed against the model as reviewed (marked `todo` then) and passes since the fixes of the core fixer (js/ui/panels/stats-model.js,
//                    js/sim/detail.js): they stay as regression tests. Severity: high = a false number or sentence, an inconsistency with the Results tab, a share above 100 %;
//                    medium = misleading, unclear definition or label, a threshold that fires wrongly; low = polish. Two tests were themselves too crude and were corrected (said where they are):
//                    STAT-REV-4 (it read a sentence that EXCLUDES the depot drives as a claim that includes them) and STAT-REV-17 (it measured the simulation and could not fail on the model).
//
//     STAT-REV-1  high    Output per hour of a workstation: "capacity about N/h" multiplies by the process factor, but the factor multiplies the CYCLE TIMES (1.2 = 20 % slower)
//     STAT-REV-2  high    Goods in with two outgoing flows: "In buffer: most 6 of 3" (the room is per flow; the model reads one flow's)
//     STAT-REV-3  high    Gate wait "none, a door was always free": with no truck at all (3), and from the MEAN under 60 s while a truck waited 5 minutes (3b)
//     STAT-REV-4  high    Fleet "Empty share": the rule says "on the way to a pickup or to a depot", the number excludes the depot drives (report.emptyShare)
//     STAT-REV-5  high    Road cell: every dock cell (a two-way dead end) is called "one-way"; "one vehicle at a time" follows the out-degree, not the engine's `controlled` (a merge is missed)
//     STAT-REV-6  high    Fleet question ignores charging, broken and dead time: "Spare capacity" while removing a vehicle costs 9-21 % output and doubles the wait (6); "could take over" for a dead fleet (6b)
//     STAT-REV-7  high    Fleet question, queueing: "Vehicles queue (19 % of their moving time)" quotes the PLANT's share for a fleet that queues 1 %
//     STAT-REV-8  medium  Depot: "Parked now 0 vehicles of 8 slots" with 3 vehicles charging in it (the average and "slots used" count them)
//     STAT-REV-9  medium  Fleet "Load wait" has no "waiting now" for fleets whose flows are not bound to them (4 of 5 examples; honesty rule 9)
//     STAT-REV-10 medium  Storage "Stays" (Little's law) printed as a plain estimate while the stock grows (honesty rule 7)
//     STAT-REV-11 medium  The dock queue share and the "Queue for X's dock" rows leave out the open leg: the numerator is not in the window of the denominator (up to 12 points, 8 % of the seconds)
//     STAT-REV-12 medium  "Counted since 0:49" / "counting since 0:49" for a start at 0:50 (float noise of the clock, floor of the minute); also warm-up 300 s prints 0:04
//     STAT-REV-13 medium  Rounded parts that do not add up: the three driven shares (18 % of the vehicles) and the 11 pieces of the time split (64 %)
//     STAT-REV-14 medium  "fleet 16.9 · 34.7 loads/h": the loads per hour are the vehicle's own, printed behind the fleet's trips
//     STAT-REV-15 medium  "AGV 1 made no trip in 60 min: it was parked 0 % and without a job 0 %" for a vehicle that was dead 98 % of the time
//     STAT-REV-16 medium  "Counted since 0:50 (warm-up excluded)" after a plant change restarted the window; the notice ends in ". (at 0:50)."
//     STAT-REV-17 medium  "Needed: the work of 4 vehicles does not fit into 3" for a saturated fleet whose n - 1 run loses almost no output (Warehouse first day: 7 of 8 seeds lose under 4 %); HEAVY
//     STAT-REV-18 low     A rate printed from a few minutes ("24.0/h" from two trips in 5 min); only the header says "indicative"
//     STAT-REV-19 medium  The sparkline's sentence says "busy share of each 30 seconds ... now 77 %, lowest 16 %" but the figures are a moving average of three buckets (latest bucket 32 %, lowest 0 %)
//     STAT-REV-20 medium  Goods out "Lead time 16 min, this Goods out" is the collector's mean of 2 loads (switched on late) beside "7 shipped in 25 min" of the report; the card says 25 min
//     STAT-REV-21 low     "Avg loaded trip": the rule says "from arriving at the pickup"; the number starts when the loading is done (54 s; with the loading 66 s)
//     STAT-REV-22 medium  "49 % of the metres AGV 1 drives are empty" for every vehicle that shuttles (Dock lab 5 of 5, Warehouse 4 of 4): threshold 35 % (design) against the insights' 60 %
//
// Observed and NOT made a test (by design in the code, said in the report): a delivery on the cell the vehicle stands on is a 0 s trip and lowers "Avg loaded trip" (hostile dock plants: half);
// the empty drives counted include drives that were re-targeted on the way; the report is cached 250 ms (up to 150 simulated seconds at 600x) while the collector is read live.
//
// STATS_TRUTH_HEAVY=1 runs the larger sizes (all five examples, 40 + 40 hostile plants, the n - 1 table of six fleets on three seeds).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as G from './helpers/stats-truth-gen.js';
import { liveInput, runExample, modelProblems, everySelection } from './helpers/stats-fixtures.js';
import * as M from '../js/ui/panels/stats-model.js';
import { Simulation } from '../js/sim/engine.js';
import { EXAMPLES } from '../js/model/examples.js';
import { hostilePlant } from './helpers/engine-review-gen.js';
import { hostileTruckPlant } from './helpers/m1-sim-review-gen.js';

const { buildStatsModel } = M;
const HEAVY = process.env.STATS_TRUTH_HEAVY === '1';
const heavy = (name, fn) => test(name, HEAVY ? {} : { skip: 'expensive: set STATS_TRUTH_HEAVY=1' }, fn);

const example = (id) => EXAMPLES.find((e) => e.id === id).build();
const tileOf = (m, id) => m.tiles.find((t) => t.id === id);
const blockOf = (m, type) => m.blocks.find((b) => b.type === type);
const factOf = (m, id) => (blockOf(m, 'facts') ? blockOf(m, 'facts').facts.find((f) => f.id === id) : undefined);
const vehicleModel = (sim, id, window = 'start') => buildStatsModel(liveInput(sim, { kind: 'vehicle', ids: [id] }, { window }));
const near = (a, b, eps, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} is not ${b} (eps ${eps})`);

/** One run per plant and file, shared by the tests that only READ it. */
const cache = new Map();
const shared = (key, make) => { if (!cache.has(key)) cache.set(key, make()); return cache.get(key); };
const exampleRun = (id, seconds = id === 'two-lines' ? 4000 : 3600, seed = 1) => shared(`${id}/${seconds}/${seed}`, () => G.observedRun(example(id), { seed, seconds, snapshots: true }));

// =============================================================================================================
// TRUTH
// =============================================================================================================

test('TRUTH-1: every number of every vehicle equals an independent per-tick observer, Since start and Last 30 min (examples and plants with a known answer)', () => {
  const runs = [
    ['two-lines', exampleRun('two-lines')],
    ['dock-lab', exampleRun('dock-lab')],
    ['warehouse-first-day', exampleRun('warehouse-first-day')],
    ['corridor x3', shared('corridor3', () => G.observedRun(G.corridorPlant({ vehicles: 3, interArrival: 20 }).layout, { seconds: 3000, snapshots: true }))],
    ['shuttle', shared('shuttle', () => G.observedRun(G.shuttlePlant().layout, { seconds: 3600, snapshots: true }))],
  ];
  if (HEAVY) for (const id of ['congestion-lab', 'starter']) runs.push([id, exampleRun(id)]);
  let checked = 0;
  for (const [name, { sim, obs }] of runs) {
    const det = sim.detail;
    for (const kind of ['start', 'last30']) {
      for (let i = 0; i < det.V.length; i++) {
        const m = vehicleModel(sim, det.V[i].id, kind);
        assert.equal(m.status, 'ready');
        const loose = kind === 'last30' ? { share: 2e-4, rate: 2e-3, seconds: 0.15 } : {};
        assert.deepEqual(G.vehicleDiscrepancies(m, obs, det, i, kind, loose), [], `${name} ${det.V[i].id} ${kind}`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 40, `${checked} vehicle windows`);
});

test('TRUTH-2: a corridor with exactly one route: one row, 58 m, always the same way, the usual round, 27 trips an hour', () => {
  const { sim, obs } = shared('corridor1', () => G.observedRun(G.corridorPlant({ vehicles: 1 }).layout, { seconds: 3600, snapshots: true }));
  const det = sim.detail;
  const m = vehicleModel(sim, 'v1#1');
  const trips = blockOf(m, 'trips');
  assert.equal(trips.rows.length, 1, 'one pair of stations, one row');
  const r = trips.rows[0];
  assert.equal(r.name, 'Goods in A → Goods out B');
  assert.equal(r.metres, G.CORRIDOR_METRES, '29 steps of 2 m from dock cell to dock cell');
  assert.equal(r.usual, '', 'one way only: the row does not repeat it; the sentence says it');
  assert.match(factOf(m, 'main').text, /; always the same way\.$/);
  // the loop time of the plant: 54 s loaded + 54 s empty + 12 s loading + 12 s unloading = 132 s, so 27.3 trips an hour; the source (one load per 50 s) is never the limit
  near(tileOf(m, 'trips').raw, 3600 / 132, 0.5, 'trips per hour');
  const w = det.windowOf('start');
  const legs = obs.legs[0].filter((l) => l.closed && l.t1 >= w.t0);
  assert.equal(r.trips, legs.length, 'the row counts the loaded drives the observer saw (closed, in the window)');
  near(r.meanTime, legs.filter((l) => l.t0 >= w.t0).reduce((a, l) => a + l.driven, 0) / legs.filter((l) => l.t0 >= w.t0).length, 0.06, 'mean loaded time');
  assert.equal(tileOf(m, 'held').value, '0 %');
  const round = trips.round;
  assert.ok(round, 'a usual round');
  assert.deepEqual(round.jobs, ['Goods in A → Goods out B', 'Goods in A → Goods out B']);
  assert.equal(round.count, round.of, 'every pair of consecutive trips is the same pair: 100 %');
  assert.match(round.text, /^(\d+) of \1 pairs of trips \(100 %\)/);
  const emptyStarts = obs.starts[0].toPickup.filter((t) => t >= w.t0 - 1e-9).length;
  assert.match(trips.other.text, new RegExp(`^${emptyStarts} empty · 0 to depot or charger$`));
  // the odometers: the model says 49 % empty of the metres; the observer's odometers agree
  const o = obs.window(0, w.t0);
  assert.match(tileOf(m, 'driven').ref.text, new RegExp(`loaded ${G.roundTo((100 * o.loaded) / (o.loaded + o.empty))} % · empty ${G.roundTo((100 * o.empty) / (o.loaded + o.empty))} % · to depot 0 %`));
});

test('TRUTH-3: two sinks fed 2 : 1 by the flow weights: two rows, the busier first, their metres are the distances of the docks', () => {
  const p = G.splitPlant();
  const { sim } = shared('split', () => G.observedRun(p.layout, { seconds: 7200, observe: false }));
  const m = vehicleModel(sim, 'v1#1');
  const rows = blockOf(m, 'trips').rows;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.name), ['Goods in A → Goods out B', 'Goods in A → Goods out C']);
  const steps = (a, b) => Math.abs(a[1] - 14) + Math.abs(a[0] - b[0]) + Math.abs(b[1] - 14);
  assert.equal(rows[0].metres, steps(p.dock.A, p.dock.B) * G.CELL, 'A to B');
  assert.equal(rows[1].metres, steps(p.dock.A, p.dock.C) * G.CELL, 'A to C');
  const ratio = rows[0].trips / rows[1].trips;
  assert.ok(ratio > 1.4 && ratio < 2.6, `the weights 2 : 1 give about twice as many trips to B: ${rows[0].trips} to ${rows[1].trips}`);
  near(rows[0].trips + rows[1].trips, sim.detail.counts(0, sim.detail.windowOf('start')).trips, 1, 'every delivery is a trip of one of the two rows (a delivery in progress may differ by one)');
});

test('TRUTH-4: the usual round of a loop is the most frequent pair of consecutive trips of the observer (ties: the pair seen first, at least 3 times)', () => {
  const { sim, obs } = shared('shuttle', () => G.observedRun(G.shuttlePlant().layout, { seconds: 3600, snapshots: true }));
  const det = sim.detail;
  for (const kind of ['start', 'last30']) {
    const w = det.windowOf(kind);
    const legs = obs.legs[0].filter((l) => l.closed && !l.dropped && l.from !== null && (kind === 'start' ? l.t1 >= w.t0 : l.t0 >= w.t0));
    const seen = new Map();
    let of = 0;
    for (let k = 0; k + 1 < legs.length; k++) {
      of++;
      const key = `${legs[k].from}>${legs[k].to}|${legs[k + 1].from}>${legs[k + 1].to}`;
      if (!seen.has(key)) seen.set(key, { n: 0, first: of });
      seen.get(key).n++;
    }
    let best = null;
    for (const [key, e] of seen) if (best === null || e.n > best.n || (e.n === best.n && e.first < best.first)) best = { key, ...e };
    const m = vehicleModel(sim, 'v1#1', kind);
    const round = blockOf(m, 'trips').round;
    assert.ok(best && best.n >= 3 && round, `${kind}: a round`);
    assert.equal(round.count, best.n, `${kind}: how often`);
    assert.equal(round.of, of, `${kind}: of how many pairs`);
    const name = (id) => sim.layout.stations.find((s) => s.id === id).name;
    assert.deepEqual(round.jobs, best.key.split('|').map((p) => p.split('>').map(name).join(' → ')), `${kind}: which pair`);
    near(round.share, best.n / of, 1e-12, `${kind}: share`);
  }
});

test('TRUTH-5: the Results tab agrees: every vehicle against the fleet table, per vehicle and per fleet, on all five examples', () => {
  for (const id of HEAVY ? ['starter', 'two-lines', 'congestion-lab', 'dock-lab', 'warehouse-first-day'] : ['two-lines', 'dock-lab', 'warehouse-first-day']) {
    const { sim } = exampleRun(id);
    const rep = sim.kpis();
    const hours = rep.window.duration / 3600;
    const det = sim.detail;
    for (const [fid, f] of Object.entries(rep.fleets)) {
      const mates = det.V.filter((v) => v.fleetId === fid).map((v) => vehicleModel(sim, v.id));
      let trips = 0; let busy = 0; let held = 0; let driven = 0;
      for (const m of mates) {
        const id2 = m.ids[0];
        near(tileOf(m, 'trips').raw, f.vehicleTrips[id2] / hours, 1e-9, `${id} ${id2}: the report counts ${f.vehicleTrips[id2]} deliveries`);
        trips += tileOf(m, 'trips').raw; busy += tileOf(m, 'busy').raw; held += tileOf(m, 'held').raw; driven += tileOf(m, 'driven').raw;
      }
      const n = mates.length;
      near(trips / n, f.tripsPerVehicleHour, 1e-9, `${id}/${fid}: trips per vehicle and hour`);
      near(busy / n, f.utilization, 1e-9, `${id}/${fid}: busy is the fleet utilization`);
      near(held / n, f.shares.waiting, 1e-9, `${id}/${fid}: held up is shares.waiting`);
      near(driven / n, f.distancePerVehicle / hours / 1000, 1e-9, `${id}/${fid}: driven per hour is the odometer`);
    }
  }
});

test('TRUTH-6: the windows: Last 30 min is 30.0 to 30.5 minutes, the same as Since start below 30, "indicative" below 20, "counting since" when switched on late', () => {
  const { sim } = exampleRun('two-lines');
  const det = sim.detail;
  const last = det.windowOf('last30');
  assert.ok(last.seconds >= 1800 - 1e-6 && last.seconds <= 1830.2, `Last 30 min is ${last.seconds} s`);
  const m = vehicleModel(sim, 'v2#1', 'last30');
  assert.ok(m.window.seconds >= 1800 && m.window.seconds <= 1830.2);
  assert.equal(m.window.equalsStart, false);
  assert.match(m.window.text, /^30 min measured$/);
  // below 30 minutes it IS Since start, and says so; below 20 minutes every verdict is "indicative"
  const young = runExample('two-lines', { seconds: 15 * 60 });
  const a = vehicleModel(young, 'v2#1', 'last30');
  const b = vehicleModel(young, 'v2#1', 'start');
  assert.equal(a.window.equalsStart, true);
  assert.match(a.window.text, /the same as Since start until 30 minutes have passed/);
  assert.deepEqual(a.tiles.map((t) => t.value), b.tiles.map((t) => t.value), 'the same numbers');
  assert.equal(a.window.indicative, true);
  assert.match(b.window.text, /^15 min measured, warm-up excluded, indicative$/);
  const old = runExample('two-lines', { seconds: 21 * 60 });
  assert.equal(vehicleModel(old, 'v2#1').window.indicative, false);
  // switched on late: the window counts from that moment and says so (the report's window is longer)
  const late = new Simulation(example('two-lines'), { seed: 1 });
  late.advance(1500);
  late.enableDetail();
  late.advance(900);
  const lm = vehicleModel(late, 'v2#1');
  assert.equal(lm.window.late, true);
  assert.match(lm.window.text, /^counting since 0:\d\d/);
  near(lm.window.seconds, 900, 0.3);
  assert.ok(late.kpis().window.start < 700 && late.kpis().window.duration > 1500, 'the report counts from the end of the warm-up');
});

test('TRUTH-7: the fleet question against a real simulation with one vehicle less: the forecast is within 5 points of the simulated busy share', () => {
  const cases = [['two-lines', 'v2']];
  if (HEAVY) cases.push(['dock-lab', 'v1'], ['two-lines', 'v1'], ['starter', 'v1'], ['congestion-lab', 'v1'], ['warehouse-first-day', 'v1']);
  let checked = 0;
  for (const [id, fid] of cases) {
    for (const seed of HEAVY ? [1, 2, 3] : [1]) {
      const T = HEAVY ? 7200 : 3600;
      const base = runExample(id, { seconds: T, seed, detail: false }).kpis();
      const q = M.fleetQuestion(base, base.fleets[fid], base.window.duration);
      const n = base.fleets[fid].count;
      const less = runExample(id, { seconds: T, seed, detail: false, mutate: (l) => { l.fleets.find((f) => f.id === fid).count = n - 1; } }).kpis();
      if (q.verdict === 'queueing') { assert.equal(q.forecast, null); continue; }
      const real = less.fleets[fid].utilization;
      // a forecast above 100 % saturates at 100 % in the simulation: that is what "needed" says
      const want = Math.min(1, q.forecast);
      assert.ok(Math.abs(real - want) <= 0.05, `${id}/${fid} seed ${seed}: forecast ${q.forecast.toFixed(3)}, simulated busy share with ${n - 1} vehicles ${real.toFixed(3)}`);
      checked++;
    }
  }
  assert.ok(checked >= 1);
});

test('TRUTH-8: hostile plants: no NaN, nothing above 100 %, the strips equal the report, the rows add up, the time split adds up (both windows)', () => {
  const N = HEAVY ? 40 : 3;
  let models = 0;
  let compared = 0;
  const check = (name, layout, actions, seconds) => {
    layout.settings.warmup = 300;
    const sim = new Simulation(layout, {});
    sim.enableDetail();
    const obs = new G.Observer(sim, { snapshots: true });
    const pending = actions.filter((a) => a.kind !== 'removeVehicle').map((a) => ({ ...a }));
    while (sim.time < seconds) {
      while (pending.length && pending[0].at <= sim.time + 1e-9) { const a = pending.shift(); if (a.value === 0) sim.logistics.setRuntime({ demandFactor: 0 }); else sim.setRuntime({ demandFactor: a.value }); }
      sim.step();
      obs.tick();
    }
    const rep = sim.kpis();
    const hours = rep.window.duration / 3600;
    for (const win of ['start', 'last30']) {
      for (const sel of everySelection(sim.layout, { cells: 3 })) {
        const m = buildStatsModel(liveInput(sim, sel, { window: win }));
        models++;
        assert.deepEqual(modelProblems(m), [], `${name} ${win} ${JSON.stringify(sel)}`);
        if (m.status !== 'ready' || sel.ids.length !== 1) continue;
        if (sel.kind === 'vehicle') {
          // against the observer: breakdowns, batteries, deadlocks, trucks and docks included (the mean loaded trip is left out: a delivery on the cell the vehicle stands on is a 0 s trip)
          const i = sim.detail.vehicleIndex(sel.ids[0]);
          assert.deepEqual(G.vehicleDiscrepancies(m, obs, sim.detail, i, win, { share: 3e-4, rate: 3e-3, seconds: 0.15, mean: Infinity }), [], `${name} ${sel.ids[0]} ${win}`);
          compared++;
        }
        if (sel.kind === 'vehicle' && win === 'start') {
          const fid = M.parseVehicleId(sel.ids[0]).fleetId;
          near(tileOf(m, 'trips').raw, (rep.fleets[fid].vehicleTrips[sel.ids[0]] || 0) / hours, 1e-9, `${name} ${sel.ids[0]} trips`);
          const held = blockOf(m, 'time').held;
          if (held) near(sumOf(held.rows.map((r) => r.seconds)), held.total, 1e-6, `${name} ${sel.ids[0]}: the rows add up to the held-up number`);
          const split = blockOf(m, 'time').split.items;
          const total = sumOf(split.map((p) => p.share));
          assert.ok(total <= 1 + 1e-9 && total >= 1 - 12 * 0.004 - 1e-9, `${name} ${sel.ids[0]}: the pieces of the split add up to ${total}`);
        }
        if (sel.kind === 'station' && win === 'start' && rep.stations[sel.ids[0]]) {
          const st = rep.stations[sel.ids[0]];
          if (st.type === 'process') near(tileOf(m, 'busy').raw, st.utilization, 1e-12, `${name} ${sel.ids[0]} busy`);
          if (st.type === 'storage') near(tileOf(m, 'in').raw, st.arrivals / hours, 1e-9, `${name} ${sel.ids[0]} in`);
        }
        if (sel.kind === 'fleet' && win === 'start') {
          near(tileOf(m, 'busy').raw, rep.fleets[sel.ids[0]].utilization, 1e-12, `${name} ${sel.ids[0]} fleet busy`);
          near(tileOf(m, 'held').raw, rep.fleets[sel.ids[0]].shares.waiting, 1e-12, `${name} ${sel.ids[0]} fleet held up`);
        }
      }
    }
  };
  for (let seed = 1; seed <= N; seed++) {
    let layout = null;
    try { layout = hostilePlant(seed); } catch { layout = null; }
    if (layout) check(`hostile ${seed}`, layout, [], HEAVY ? 2400 : 900);
    const t = hostileTruckPlant(seed, { horizon: 1500 });
    check(`truck plant ${seed}`, t.layout, t.actions, HEAVY ? 2400 : 900);
  }
  assert.ok(models > (HEAVY ? 3000 : 200) && compared > (HEAVY ? 800 : 30), `${models} models, ${compared} vehicle windows against the observer`);
});

const sumOf = (a) => a.reduce((x, y) => x + y, 0);

test('TRUTH-9: one vehicle, no vehicle, a vehicle removed under a running collector: honest words and no NaN', () => {
  // one vehicle: no fleet question, no peer to compare with (the fleet value is its own)
  const one = shared('corridor1', () => G.observedRun(G.corridorPlant({ vehicles: 1 }).layout, { seconds: 3600, snapshots: true }));
  const m1 = vehicleModel(one.sim, 'v1#1');
  assert.deepEqual(modelProblems(m1), []);
  assert.equal(factOf(m1, 'fleet'), undefined, 'a fleet of one cannot be compared with itself');
  assert.equal(tileOf(m1, 'trips').ref.arrow, '', 'no arrow against oneself');
  assert.match(tileOf(m1, 'trips').ref.text, new RegExp(`^fleet ${tileOf(m1, 'trips').value.replace('/h', '').replace('.', '\\.')}$`));
  const fleet1 = buildStatsModel(liveInput(one.sim, { kind: 'fleet', ids: ['v1'] }));
  assert.equal(tileOf(fleet1, 'question').value, 'One vehicle');
  // no vehicle at all
  const layout0 = G.corridorPlant({ vehicles: 1 }).layout;
  layout0.fleets[0].count = 0;
  const sim0 = new Simulation(layout0, { seed: 1 });
  sim0.enableDetail();
  sim0.advance(900);
  assert.equal(sim0.vehicles.length, 0);
  for (const sel of [{ kind: 'vehicle', ids: ['v1#1'] }, { kind: 'fleet', ids: ['v1'] }, { kind: 'station', ids: [layout0.stations[0].id] }, { kind: 'flow', ids: [layout0.flows[0].id] }]) {
    const m = buildStatsModel(liveInput(sim0, sel));
    assert.deepEqual(modelProblems(m), [], JSON.stringify(sel));
  }
  assert.equal(buildStatsModel(liveInput(sim0, { kind: 'vehicle', ids: ['v1#1'] })).status, 'gone');
  assert.equal(tileOf(buildStatsModel(liveInput(sim0, { kind: 'fleet', ids: ['v1'] })), 'question').value, 'None');
  // a vehicle removed under the running collector: it is gone, the rest keeps its id, the window restarts and says so
  const sim = runExample('two-lines', { seconds: 2400 });
  sim.logistics.removeVehicle(sim.vehicles.find((v) => v.id === 'v2#2'));
  sim.advance(300);
  assert.equal(sim.detailError, null);
  const gone = vehicleModel(sim, 'v2#2');
  assert.equal(gone.status, 'gone');
  assert.match(gone.statusText, /not part of the run/);
  assert.deepEqual(modelProblems(gone), []);
  const kept = vehicleModel(sim, 'v2#3');
  assert.equal(kept.status, 'ready');
  assert.deepEqual(modelProblems(kept), []);
  assert.ok(blockOf(kept, 'facts').how.some((t) => /statistics start counting again/.test(t)), 'the restart is said');
  near(kept.window.seconds, 300, 0.3, 'the window began at the removal');
});

test('TRUTH-10: "usual", "N ways" and "always the same way" agree with the ways the observer saw the vehicles drive (distinct sequences of edges)', () => {
  let rows = 0;
  for (const id of ['dock-lab', 'warehouse-first-day', 'two-lines']) {
    const { sim, obs } = exampleRun(id);
    const det = sim.detail;
    for (const kind of ['start', 'last30']) {
      const w = det.windowOf(kind);
      for (let i = 0; i < det.V.length; i++) {
        const m = vehicleModel(sim, det.V[i].id, kind);
        for (const r of blockOf(m, 'trips').rows) {
          const key = r.focusId.replace('loaded:', '');
          const legs = obs.legs[i].filter((l) => l.closed && l.from !== null && `${l.from}>${l.to}` === key && (kind === 'start' ? l.t1 >= w.t0 : l.t0 >= w.t0));
          const complete = legs.filter((l) => l.t0 >= w.t0 - 1e-9).length;
          const drawn = legs.filter((l) => !l.relocated && l.edges.length > 0);
          const counts = new Map();
          for (const l of drawn) counts.set(l.edges.join(','), (counts.get(l.edges.join(',')) || 0) + 1);
          const variants = counts.size;
          const modal = Math.max(0, ...counts.values()) / Math.max(1, drawn.length);
          rows++;
          assert.equal(r.trips, legs.length, `${id} ${det.V[i].id} ${kind} ${r.name}: trips`);
          if (complete < 5) { assert.equal(r.usual, 'too few trips for a usual route', `${id} ${det.V[i].id} ${r.name}`); continue; }
          if (variants <= 1) { assert.equal(r.usual, '', `${id} ${det.V[i].id} ${r.name}: one way`); continue; }
          if (modal >= 0.5) assert.equal(r.usual, `${Math.round(modal * 100)} % the same way`, `${id} ${det.V[i].id} ${r.name}`);
          else assert.equal(r.usual, `${variants} ways, the most used ${Math.round(modal * 100)} %`, `${id} ${det.V[i].id} ${r.name}`);
        }
      }
    }
  }
  assert.ok(rows > 60, `${rows} rows`);
});

// =============================================================================================================
// DEFECTS
// =============================================================================================================

test('STAT-REV-1 (high): "capacity about N/h" of a workstation multiplies by the process factor, which multiplies the CYCLE TIMES: 2 means half the capacity', () => {
  for (const [factor, cycle] of [[1, 60], [2, 60], [1.5, 60]]) {
    const { layout, ids } = G.processPlant({ machines: 1, cycle, processFactor: factor });
    const { sim } = G.observedRun(layout, { seconds: 5400, observe: false });
    const rep = sim.kpis().stations[ids.P];
    assert.ok(rep.utilization > 0.97, `the workstation is saturated (busy ${rep.utilization}): its real output is its capacity`);
    const m = buildStatsModel(liveInput(sim, { kind: 'station', ids: [ids.P] }));
    const out = tileOf(m, 'output');
    const printed = Number(/capacity about ([\d.]+)\/h/.exec(out.ref.text)[1]);
    near(printed, out.raw, 0.1 * out.raw, `process factor ${factor}: the capacity line says ${printed}/h, the saturated workstation really made ${out.raw}/h`);
  }
});

test('STAT-REV-2 (high): the room of a Goods in is per outgoing flow; with two flows "most 6 of 3" is printed', () => {
  const { layout, ids } = G.twoFlowSourcePlant({ outCap: 3, interArrival: 6 });
  const { sim } = G.observedRun(layout, { seconds: 1800, observe: false });
  const m = buildStatsModel(liveInput(sim, { kind: 'station', ids: [ids.A] }));
  const mm = /most (\d+) of (\d+)/.exec(tileOf(m, 'buffer').ref.text);
  assert.ok(mm, tileOf(m, 'buffer').ref.text);
  assert.ok(Number(mm[1]) <= Number(mm[2]), `"${tileOf(m, 'buffer').ref.text}": the most that was in the buffer cannot exceed its room`);
  assert.equal(Number(mm[2]), sim.logistics.stationById.get(ids.A).outCapacity(), 'the room is what the station says');
});

test('STAT-REV-3 (high): "Gate wait: none, a door was always free" is said when no truck has arrived at all', () => {
  const early = runExample('warehouse-first-day', { seconds: 120, seed: 2 });
  const rep = early.kpis().ops.trucks.s1;
  assert.equal(rep.trucks.docked, 0, 'precondition: no truck has reached a door');
  const g = tileOf(buildStatsModel(liveInput(early, { kind: 'station', ids: ['s1'] })), 'gate');
  assert.doesNotMatch(`${g.value} ${g.ref.text}`, /none|always free/, `no truck came, so nothing can be said about the gate: "${g.value}", "${g.ref.text}"`);
});

test('STAT-REV-3b (high): "Gate wait: none, a door was always free" is said from the MEAN (under 60 s) although one truck waited 5 minutes at the gate', () => {
  const sim = runExample('warehouse-first-day', { seconds: 3 * 3600, seed: 2 });
  const gw = sim.kpis().ops.trucks.s1.gateWait;
  assert.ok(gw.mean < 60 && gw.max > 120, `precondition: mean ${gw.mean} s, longest ${gw.max} s`);
  const gate = tileOf(buildStatsModel(liveInput(sim, { kind: 'station', ids: ['s1'] })), 'gate');
  assert.doesNotMatch(`${gate.value} ${gate.ref.text}`, /none|always free/, `a truck waited ${Math.round(gw.max)} s at the gate: "${gate.value}", "${gate.ref.text}"`);
});

test('STAT-REV-4 (high): the rule of "Empty share" says "on the way to a pickup or to a depot"; the number (report.emptyShare) is empty / (loaded + empty + park) and leaves the depot drives out', () => {
  const { layout } = G.batteryPlant({ vehicles: 2 });
  const { sim } = G.observedRun(layout, { seconds: 7200, observe: false });
  let L = 0; let E = 0; let P = 0;
  for (const v of sim.vehicles) { L += v.loadedDistance; E += v.emptyDistance; P += v.parkDistance; }
  assert.ok(P > 0.1 * (L + E + P), 'precondition: a fifth of the metres go to the charger');
  const m = buildStatsModel(liveInput(sim, { kind: 'fleet', ids: ['v1'] }));
  const raw = tileOf(m, 'empty').raw;
  // the rule may name the depot drives in order to EXCLUDE them ("are in the total, but they are not counted as empty"): that is not a claim that they are in the number
  const claimsDepot = /depot|charger|park/i.test(M.DEFINITIONS['fleet.empty'].text) && !/not counted as empty|are not empty|left out|excluded/i.test(M.DEFINITIONS['fleet.empty'].text);
  const withDepot = (E + P) / (L + E + P);
  const withoutDepot = E / (L + E + P);
  assert.notEqual(Math.round(withDepot * 100), Math.round(withoutDepot * 100), 'precondition: the two readings differ');
  near(raw, claimsDepot ? withDepot : withoutDepot, 0.03, `the rule says ${claimsDepot ? 'empty and to a depot' : 'empty only'} (${tileOf(m, 'empty').def}); the tile shows ${Math.round(raw * 100)} % against ${Math.round(withDepot * 100)} % with and ${Math.round(withoutDepot * 100)} % without the depot drives`);
});

test('STAT-REV-5 (high): every dock cell (a two-way dead end) is called "one-way", and a merge of two one-way roads is not said to hold one vehicle at a time', () => {
  const bad = [];
  let docks = 0;
  let cells = 0;
  for (const id of ['two-lines', 'congestion-lab']) {
    const sim = runExample(id, { seconds: 600 });
    const g = sim.graph;
    for (const node of g.nodes) {
      const key = `${node % g.cols},${Math.floor(node / g.cols)}`;
      if (!sim.layout.roads[key]) continue;
      const m = buildStatsModel(liveInput(sim, { kind: 'cell', ids: [key] }));
      const what = tileOf(m, 'what');
      const text = `${what.value}: ${what.ref.text}`;
      const oneWay = g.out[node].length > 0 && g.out[node].every((e) => g.edges[e].rev < 0);
      cells++;
      if (what.value === 'Dock') docks++;
      if (/one-way/.test(text) !== oneWay) bad.push(`${id} ${key} says "${text}" but ${oneWay ? 'every road there is one-way' : 'the road has a reverse link (two-way)'}`);
      // a dead end holds one vehicle at a time too (a reversal), so it may say so or not; every other controlled cell (a junction, a merge) must say it, and no other cell may
      if (g.deadEnd[node] !== 1 && /one vehicle at a time/.test(text) !== (g.controlled[node] === 1)) bad.push(`${id} ${key} says "${text}" but controlled=${g.controlled[node]}`);
    }
  }
  assert.ok(docks >= 8 && cells > 300, `${docks} dock cells, ${cells} road cells`);
  assert.deepEqual(bad.slice(0, 6), [], `${bad.length} road cells are described wrongly`);
});

test('STAT-REV-6 (high): the fleet question counts a vehicle that charges as available: "Spare capacity" while removing a vehicle costs output and doubles the wait', () => {
  // Two lines with a 75 minute charge: the AGVs spend 23 % of their time on the chargers
  const slow = (l) => { l.fleets.find((f) => f.id === 'v2').battery.chargeTimeMin = 75; };
  const base = runExample('two-lines', { seconds: 7200, seed: 1, detail: false, mutate: slow }).kpis();
  const q = M.fleetQuestion(base, base.fleets.v2, base.window.duration);
  const less = runExample('two-lines', { seconds: 7200, seed: 1, detail: false, mutate: (l) => { slow(l); l.fleets.find((f) => f.id === 'v2').count = 6; } }).kpis();
  const outDrop = 1 - less.throughput.perHour / base.throughput.perHour;
  const waitRise = less.fleets.v2.avgPickupWait / base.fleets.v2.avgPickupWait - 1;
  assert.ok(base.fleets.v2.shares.charging > 0.15, 'precondition: a fifth of the time on the chargers');
  assert.ok(outDrop > 0.03, `precondition: one AGV less costs output (${(100 * outDrop).toFixed(1)} %; the wait for a vehicle rises ${(100 * waitRise).toFixed(0)} % on this seed and by 50 to 100 % on others)`);
  assert.notEqual(q.verdict, 'spare', `"${q.text.slice(0, 80)}" but with one AGV less the output falls ${(100 * outDrop).toFixed(1)} % and the wait for a vehicle rises ${(100 * waitRise).toFixed(0)} %`);
});

test('STAT-REV-6b (high): the fleet question says "the other 1 could take over" for a fleet whose vehicles are all dead', () => {
  const dead = G.batteryPlant({ vehicles: 2, runtimeMin: 6 });
  for (const s of dead.layout.stations) if (s.type === 'depot') s.params.chargers = 0;
  const run = G.observedRun(dead.layout, { seconds: 3600, observe: false });
  const rep = run.sim.kpis();
  assert.ok(rep.fleets.v1.shares.broken > 0.9, 'precondition: the fleet is dead');
  const fq = M.fleetQuestion(rep, rep.fleets.v1, rep.window.duration);
  assert.doesNotMatch(fq.text, /could take over/, `"${fq.text.slice(0, 80)}" for a fleet that is ${Math.round(100 * rep.fleets.v1.shares.broken)} % dead`);
  assert.notEqual(fq.verdict, 'spare');
});

test('STAT-REV-7 (high): "Vehicles queue (19 % of their moving time)" quotes the largest of the plant\'s and the fleet\'s share, also for a fleet that queues 1 %', () => {
  const layout = hostilePlant(9);
  layout.settings.warmup = 300;
  const sim = new Simulation(layout, {});
  sim.advance(2400);
  const rep = sim.kpis();
  const f = rep.fleets.v1;
  const own = M.fleetWaitShare(f);
  assert.ok(f.count >= 2 && own < 0.05 && rep.traffic.waitShare >= 0.12, `precondition: the fleet queues ${own}, the plant ${rep.traffic.waitShare}`);
  const q = M.fleetQuestion(rep, f, rep.window.duration);
  assert.equal(q.verdict, 'queueing');
  const said = Number(/\((\d+) %/.exec(q.text)[1]);
  assert.ok(Math.abs(said - own * 100) <= 1 || /plant/i.test(q.text), `"${q.text.slice(0, 90)}": this fleet's vehicles queue ${(own * 100).toFixed(1)} % of their moving time`);
});

test('STAT-REV-8 (medium): "Parked now" of a depot counts only the state parked: 3 vehicles charge in it and it says "0 vehicles of 8 slots", while "Parked on average" and "Slots used" count them', () => {
  const { sim } = exampleRun('two-lines');
  const depot = sim.layout.stations.find((s) => s.name === 'AGV charging');
  const rt = sim.logistics.stationById.get(depot.id);
  assert.ok(rt.charging.length > 0, `precondition: ${rt.charging.length} vehicles are charging`);
  const m = buildStatsModel(liveInput(sim, { kind: 'station', ids: [depot.id] }));
  assert.equal(tileOf(m, 'parked').raw, rt.parked.length + rt.charging.length, `"Parked now ${tileOf(m, 'parked').value} ${tileOf(m, 'parked').ref.text}" with ${rt.charging.length} vehicles charging on ${rt.slots} slots`);
});

test('STAT-REV-9 (medium): the fleet "Load wait" has no "waiting now" when its flows are not bound to the fleet (honesty rule 9: a mean over loads that were picked up cannot see a load that is still waiting)', () => {
  const missing = [];
  for (const id of HEAVY ? ['warehouse-first-day', 'dock-lab', 'starter', 'congestion-lab'] : ['warehouse-first-day', 'dock-lab']) {
    const { sim } = exampleRun(id);
    for (const f of sim.layout.fleets) {
      const wait = tileOf(buildStatsModel(liveInput(sim, { kind: 'fleet', ids: [f.id] })), 'wait');
      if (wait.raw !== null && !/waiting now: \d+/.test(wait.ref.text)) missing.push(`${id}/${f.id}: Load wait ${wait.value} with "${wait.ref.text}"`);
    }
  }
  assert.deepEqual(missing, []);
});

test('STAT-REV-10 (medium): "Stays" (Little\'s law) is printed as a plain estimate while the stock grows (245 loads in, 173 out); honesty rule 7 withdraws it', () => {
  const { sim } = exampleRun('warehouse-first-day');
  const rep = sim.kpis().stations.s2;
  const cap = sim.logistics.stationById.get('s2').capacity;
  const growth = rep.arrivals - rep.produced;
  assert.ok(growth > 0.25 * rep.avgFill * cap, `precondition: ${rep.arrivals} in, ${rep.produced} out, mean stock ${(rep.avgFill * cap).toFixed(0)}`);
  const stay = tileOf(buildStatsModel(liveInput(sim, { kind: 'station', ids: ['s2'] })), 'stay');
  assert.ok(stay.value === '–' || /grow|rising|not steady|steady/i.test(`${stay.ref.text} ${stay.def}`.replace(/It assumes the stock is steady/, '')), `"Stays ${stay.value}" with "${stay.ref.text}" while the stock grows by ${growth} loads`);
});

test('STAT-REV-11 (medium): the queue share of the held-up sentence and the "Queue for X\'s dock" rows leave out the open leg: numerator and denominator are not of the same window', () => {
  const { sim, obs } = exampleRun('congestion-lab');
  const det = sim.detail;
  const w = det.windowOf('start');
  const bad = [];
  let facts = 0;
  for (let i = 0; i < det.V.length; i++) {
    const m = vehicleModel(sim, det.V[i].id);
    const f = factOf(m, 'held');
    const mm = f && /(\d+) % of that in the queue for a dock, about ([\d.]+) min in every hour/.exec(f.text);
    if (!mm) continue;
    facts++;
    const o = obs.window(i, w.t0);
    const trueShare = Math.round((100 * o.dockQueue) / o.held);
    if (Math.abs(Number(mm[1]) - trueShare) > 3) bad.push(`${det.V[i].id}: says ${mm[1]} % of the held-up time is the queue for a dock, the observer counts ${trueShare} %`);
  }
  assert.ok(facts >= 8, `${facts} sentences`);
  assert.deepEqual(bad.slice(0, 5), [], `${bad.length} of ${facts} sentences`);
});

test('STAT-REV-12 (medium): the minute of "Counted since" / "counting since" is wrong when the start is 1e-9 s below a whole minute (float clock): warm-up 300 s prints 0:04, a start at 0:50 prints 0:49', () => {
  const bad = [];
  for (const warmup of [300, 1800, 3000]) {
    const layout = example('starter');
    layout.settings.warmup = warmup;
    const sim = new Simulation(layout, { seed: 1 });
    sim.enableDetail();
    sim.advance(warmup + 120);
    const want = `${Math.floor(warmup / 3600)}:${String(Math.floor((warmup % 3600) / 60)).padStart(2, '0')}`;
    const m = buildStatsModel(liveInput(sim, { kind: 'vehicle', ids: ['v1#1'] }));
    if (!m.window.counted.includes(`Counted since ${want} `)) bad.push(`warm-up ${warmup} s: "${m.window.counted}" (expected 0:..: ${want})`);
  }
  for (const t of [3000]) {
    const sim = new Simulation(example('starter'), { seed: 1 });
    sim.advance(t);
    sim.enableDetail();
    sim.advance(120);
    const want = `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, '0')}`;
    const m = buildStatsModel(liveInput(sim, { kind: 'vehicle', ids: ['v1#1'] }));
    if (!m.window.text.includes(`counting since ${want}`)) bad.push(`switched on at ${t} s: "${m.window.text}" (expected ${want})`);
  }
  assert.deepEqual(bad, []);
});

test('STAT-REV-13 (medium): rounded parts that do not add up: "loaded · empty · to depot" (the rule says "add up to 100 %") and the legend of the 11 pieces', () => {
  const off = { driven: 0, split: 0, n: 0 };
  for (const id of ['two-lines', 'dock-lab', 'congestion-lab']) {
    const { sim } = exampleRun(id);
    for (const win of ['start', 'last30']) {
      for (const v of sim.detail.V) {
        const m = vehicleModel(sim, v.id, win);
        off.n++;
        const d = /loaded (\d+) % · empty (\d+) % · to depot (\d+) %/.exec(tileOf(m, 'driven').ref.text);
        if (d && Number(d[1]) + Number(d[2]) + Number(d[3]) !== 100) off.driven++;
        const legend = sumOf(blockOf(m, 'time').split.items.map((p) => Number(p.text.replace(/[^\d]/g, ''))));
        if (legend !== 100) off.split++;
      }
    }
  }
  assert.deepEqual({ driven: off.driven, split: off.split }, { driven: 0, split: 0 }, `of ${off.n} vehicle windows`);
});

test('STAT-REV-14 (medium): "fleet 16.9 · 34.7 loads/h": the loads per hour are the vehicle\'s own, behind the fleet\'s trips', () => {
  const { sim } = exampleRun('two-lines');
  const det = sim.detail;
  const w = det.windowOf('start');
  const i = det.vehicleIndex('v1#1');
  const hours = w.seconds / 3600;
  const own = det.counts(i, w).qty / hours;
  const mates = det.V.map((v, k) => [v, k]).filter(([v]) => v.fleetId === 'v1');
  const fleet = sumOf(mates.map(([, k]) => det.counts(k, w).qty / hours)) / mates.length;
  assert.ok(Math.abs(own - fleet) > 2, `precondition: the vehicle (${own.toFixed(1)} loads/h) differs from its fleet (${fleet.toFixed(1)})`);
  const ref = tileOf(vehicleModel(sim, 'v1#1'), 'trips').ref.text;
  const mm = /^fleet [\d.]+ · ([\d.]+) loads\/h$/.exec(ref);
  assert.ok(mm, ref);
  assert.ok(Math.abs(Number(mm[1]) - fleet) < 0.1 || /this vehicle|its own|own/.test(ref), `"${ref}" prints ${mm[1]} loads/h after "fleet": that is this vehicle's (${own.toFixed(1)}), the fleet's is ${fleet.toFixed(1)}`);
});

test('STAT-REV-15 (medium): "made no trip in 60 min: it was parked 0 % and without a job 0 %" for a vehicle that was dead 98 % of the time', () => {
  const dead = G.batteryPlant({ vehicles: 2, runtimeMin: 6 });
  for (const s of dead.layout.stations) if (s.type === 'depot') s.params.chargers = 0;
  const { sim } = G.observedRun(dead.layout, { seconds: 3600, observe: false });
  const m = vehicleModel(sim, 'v1#1');
  const t = M.parseVehicleId('v1#1');
  assert.ok(t.n === 1 && sim.vehicles[0].state === 'dead' && blockOf(m, 'time').split.items.find((p) => p.key === 'broken').share > 0.9, 'precondition: the vehicle is dead');
  const f = factOf(m, 'none');
  assert.ok(f, 'a sentence about the vehicle that did nothing');
  assert.match(f.text, /dead|broken|out of service|battery|empty/i, `"${f.text}"`);
});

test('STAT-REV-16 (medium): after a plant change restarted the window the dock says "Counted since 0:50 (warm-up excluded)" and the notice reads ". (at 0:50)."', () => {
  const sim = runExample('two-lines', { seconds: 2400 });
  sim.logistics.removeVehicle(sim.vehicles.find((v) => v.id === 'v2#2'));
  sim.advance(300);
  assert.ok(sim.detail.notices.length > 0, 'precondition: the collector restarted');
  const m = vehicleModel(sim, 'v2#3');
  assert.doesNotMatch(`${m.window.text} ${m.window.counted}`, /warm-up excluded/, `the window began because the plant changed: "${m.window.text}" / "${m.window.counted}"`);
  assert.ok(!blockOf(m, 'facts').how.some((t) => /\.\s\(at \d+:\d\d\)\./.test(t)), blockOf(m, 'facts').how.join(' | '));
});

heavy('STAT-REV-17 (medium): a saturated fleet is not called "Needed: the work of 4 vehicles does not fit into 3" when the simulation with one vehicle less loses almost no output (7 of 8 seeds under 4 %)', () => {
  // The review measured the simulation (median output loss with one forklift less) and asserted it was 3 % or more, which no change of the model could do. The contract is the model\'s:
  // a fleet that is busy all the time (cut off at 100 %) has no verdict "needed", no "does not fit" and no count; the arithmetic says it cannot tell. The measurement stays as the evidence.
  const drops = [];
  for (const seed of [1, 2, 3, 5, 6]) {
    const T = 3 * 3600;
    const base = runExample('warehouse-first-day', { seconds: T, seed, detail: false }).kpis();
    const q = M.fleetQuestion(base, base.fleets.v1, base.window.duration);
    assert.ok(q.censored && q.verdict === 'limit', `seed ${seed}: the saturated fleet is cut off and said to be at its limit, not ${q.verdict}`);
    assert.doesNotMatch(q.text, /does not fit|Needed|Spare|about \d+ vehicles/);
    const less = runExample('warehouse-first-day', { seconds: T, seed, detail: false, mutate: (l) => { l.fleets.find((f) => f.id === 'v1').count = 3; } }).kpis();
    drops.push(1 - less.throughput.perHour / base.throughput.perHour);
  }
  drops.sort((a, b) => a - b);
  assert.ok(drops.every(Number.isFinite), 'the evidence was measured');
  // the review measured a median loss of 0.6 % to 1.2 % (7 of 8 seeds under 4 %) on this plant: "does not fit into 3" would have been false. Printed, not asserted: the model must not
  // depend on how the simulation happens to behave.
  console.log(`    STAT-REV-17 evidence: output loss with 3 forklifts instead of 4: ${drops.map((d) => (100 * d).toFixed(1)).join(', ')} %`);
});

test('STAT-REV-22 (medium): "49 % of the metres AGV 1 drives are empty" is said of every vehicle that shuttles (Dock lab 5 of 5, Warehouse first day 4 of 4): half is structural, insights.js warns from 60 %', () => {
  const { sim, obs } = shared('corridor1', () => G.observedRun(G.corridorPlant({ vehicles: 1 }).layout, { seconds: 3600, snapshots: true }));
  const w = sim.detail.windowOf('start');
  const o = obs.window(0, w.t0);
  assert.ok(Math.abs(o.empty / (o.loaded + o.empty) - 0.5) < 0.03, 'precondition: a pure shuttle drives half of its metres empty, whatever the plant');
  const m = vehicleModel(sim, 'v1#1');
  assert.equal(factOf(m, 'empty'), undefined, `"${factOf(m, 'empty') && factOf(m, 'empty').text}" is no finding: a shuttle cannot drive less empty`);
  // and the examples with a shuttle: the sentence is for every vehicle of the fleet
  const told = [];
  for (const id of ['dock-lab', 'warehouse-first-day']) {
    const { sim: s2 } = exampleRun(id);
    for (const v of s2.detail.V) if (factOf(vehicleModel(s2, v.id), 'empty')) told.push(`${id}/${v.id}`);
  }
  assert.deepEqual(told, [], 'the sentence about empty metres on every vehicle of a shuttle plant');
});

test('STAT-REV-20 (medium): switched on late, a Goods out shows the collector\'s lead time of 2 loads (since the switch-on) beside the report\'s 7 shipped; the card says "25 min measured"', () => {
  const layout = example('two-lines');
  const sim = new Simulation(layout, { seed: 1 });
  sim.advance(1800);
  sim.enableDetail();
  sim.advance(300);
  const rep = sim.kpis();
  const sink = layout.stations.find((s) => s.type === 'sink').id;
  const m = buildStatsModel(liveInput(sim, { kind: 'station', ids: [sink] }));
  assert.ok(rep.leadTime.count >= 5 && sim.detail.sinkLead.get(sim.detail.stIndex.get(sink)).count < rep.leadTime.count, 'precondition: the collector saw fewer loads than the report');
  const lead = tileOf(m, 'lead');
  assert.ok(Math.abs(lead.raw - rep.leadTime.mean) < 1 || /based on \d+ loads?|only \d+ loads?|since \d+:\d\d/.test(lead.ref.text), `"Lead time ${lead.value}, ${lead.ref.text}" is the mean of ${sim.detail.sinkLead.get(sim.detail.stIndex.get(sink)).count} loads, the report's is ${(rep.leadTime.mean / 60).toFixed(1)} min over ${rep.leadTime.count}`);
});

test('STAT-REV-21 (low): the rule of "Avg loaded trip" says "from arriving at the pickup", the number starts when the loading is done (54 s, the 12 s of loading are not in it)', () => {
  const { sim, obs } = shared('corridor1', () => G.observedRun(G.corridorPlant({ vehicles: 1 }).layout, { seconds: 3600, snapshots: true }));
  const w = sim.detail.windowOf('start');
  const legs = obs.legs[0].filter((l) => l.closed && l.t0 >= w.t0 && l.loadStart !== null);
  assert.ok(legs.length > 20);
  const fromLeaving = legs.reduce((a, l) => a + l.driven, 0) / legs.length;
  const fromArriving = legs.reduce((a, l) => a + (l.t1 - l.loadStart), 0) / legs.length;
  assert.ok(fromArriving - fromLeaving > 10, `precondition: loading takes ${(fromArriving - fromLeaving).toFixed(1)} s`);
  const m = vehicleModel(sim, 'v1#1');
  const t = tileOf(m, 'loaded');
  const says = /arriving at the pickup|arrival at the pickup/i.test(M.DEFINITIONS['vehicle.loaded'].text) ? fromArriving : fromLeaving;
  near(t.raw, says, 1, `the rule says "${M.DEFINITIONS['vehicle.loaded'].text.slice(0, 120)}"; the tile shows ${t.raw.toFixed(1)} s, from leaving the pickup ${fromLeaving.toFixed(1)} s, from arriving ${fromArriving.toFixed(1)} s`);
});

test('STAT-REV-18 (low): a rate is printed from a few minutes ("Trips per hour 24.0/h" from two trips in 5 min); only the header says "indicative", the tile does not', () => {
  const sim = runExample('two-lines', { seconds: 5 * 60 });
  const m = vehicleModel(sim, 'v2#1');
  assert.equal(m.window.indicative, true);
  const t = tileOf(m, 'trips');
  assert.match(`${t.ref.text} ${t.def}`, /indicative|only \d+ trips?|based on \d+/, `"${t.value}${t.unit}" is a rate from ${Math.round(t.raw * m.window.hours)} trips in ${m.window.text}`);
});

test('STAT-REV-19 (medium): the sparkline says "Busy share of each 30 seconds ... now 77 %, lowest 16 %" but prints a moving average of three buckets (the latest bucket is 32 %, the lowest 0 %)', () => {
  const { sim } = exampleRun('two-lines');
  const bad = [];
  for (const v of sim.detail.V) {
    const raw = sim.detail.workingSeries(sim.detail.vehicleIndex(v.id), 60);
    const label = blockOf(vehicleModel(sim, v.id), 'time').spark.label;
    const say = (w) => Number(new RegExp(`${w} (\\d+) %`).exec(label)[1]);
    const want = { now: Math.round(100 * raw[raw.length - 1]), lowest: Math.round(100 * Math.min(...raw)), highest: Math.round(100 * Math.max(...raw)) };
    if (!/average|smooth/i.test(label)) for (const w of Object.keys(want)) if (Math.abs(say(w) - want[w]) > 2) bad.push(`${v.id}: "${w} ${say(w)} %", the 30 s buckets say ${want[w]} %`);
  }
  assert.deepEqual(bad.slice(0, 4), [], `${bad.length} wrong figures of ${sim.detail.V.length} sparklines`);
});
