// Dock choice in the whole simulation. The report that started it: a Goods in and a Goods out with three docking spurs each off one main
// road - every vehicle used the SAME dock although the other two stood free, so vehicles queued on the road and adding vehicles only lengthened
// the queue (2 / 4 / 6 AGVs: 125 / 138 / 137.5 loads per hour of the 180 offered, the share of vehicle time waiting in traffic 0.2 / 54 / 69 %).
//
//   the reproduction  the free docks are used (the two nearest docks of each station take a fifth or more of the visits each, none takes more
//                     than two thirds), throughput reaches the offered load with 4 or more AGVs and never falls when a vehicle is added,
//                     the queue in front of the station is gone (waiting share a quarter of what it was); with the dock book switched off the
//                     old behaviour is reproduced exactly, so the numbers above are the bug and this is the fix
//   no choice, no change  stations with one dock (and docks lined up on one lane, where the nearest stays the best) behave exactly as before
//   lined up          docks on one through lane never deadlock and lose nothing against the old ranking; a free spur dock is used while the lane is taken
//   robustness        random plants with breakdowns, batteries, depots and one-way roads: the dock book is consistent with the vehicles on EVERY
//                     tick, together with every traffic and logistics invariant
//   determinism       same plant and seed: identical KPIs, however the run is cut into advance() calls
//   KPIs and insights docks[] and dockWaitTotal in the report; dock-bottleneck fires for a saturated single dock and stays silent for docks that
//                     are balanced and idle; docks-unbalanced only with a reason
//   speed             dock evaluation adds a few percent at most on the Two-lines example
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Simulation } from '../js/sim/engine.js';
import { EXAMPLES } from '../js/model/examples.js';
import { FLEET_PRESETS } from '../js/model/defaults.js';
import { generateInsights } from '../js/sim/insights.js';
import { checkDockInvariants } from '../js/sim/logistics/docks.js';
import { layoutFromAscii } from './helpers/ascii.js';
import { combPlant, legacy } from './helpers/docks-review-gen.js';
import { assertAllFinite, createSimChecker, lineLayout, randomPlant } from './helpers/sim-invariants.js';
import { dockRows } from '../js/ui/dashboard.js';
import { dockMarkerPoints } from '../js/ui/render/jobs.js';

// ---------------------------------------------------------------------------------------------------------------------
// The reproduction of the report
// ---------------------------------------------------------------------------------------------------------------------

const W = 22;
const row = (f) => Array.from({ length: W }, (_, x) => f(x)).join('');
/** Goods in (A) and Goods out (B), three docking spurs each off one two-way main road; 180 loads/h offered. */
const SPURS = [
  row((x) => (x >= 1 && x <= 9 ? 'A' : x >= 11 && x <= 19 ? 'B' : '.')),
  row((x) => (x >= 1 && x <= 9 ? 'A' : x >= 11 && x <= 19 ? 'B' : '.')),
  row((x) => ([2, 5, 8, 12, 15, 18].includes(x) ? '+' : '.')),
  row((x) => (x >= 1 && x <= 20 ? '+' : '.')),
];
const spurPlant = (vehicles, { interArrival = 20, loadTime = 12, idle = 'stay', settings = {}, fleet = {} } = {}) => layoutFromAscii(SPURS, {
  stations: { A: { type: 'source', params: { interArrival: { kind: 'const', mean: interArrival, spread: 0 }, outCap: 20 } }, B: 'sink' },
  flows: [['A', 'B']],
  fleets: [{ count: vehicles, preset: 'agv', loadTime, unloadTime: loadTime, idle, ...fleet }],
  settings: { warmup: 0, seed: 3, ...settings },
});

/** Run a plant for `hours`; `legacy` switches the dock book off (the old static ranking). */
function run(layout, hours, { legacy = false } = {}) {
  const sim = new Simulation(layout);
  if (legacy) sim.logistics.docks.enabled = false;
  sim.advance(hours * 3600);
  return { sim, kpi: sim.kpis() };
}

/** Visits per dock of a station, in dock order (west to east on the main road). */
const visits = (kpi, id) => kpi.stations[id].docks.map((d) => d.visits);
const shares = (kpi, id) => {
  const v = visits(kpi, id);
  const total = v.reduce((a, b) => a + b, 0);
  return v.map((x) => x / total);
};

// Measured over 2 simulated hours on this plant (the numbers of the report, then the fixed behaviour):
//   AGVs        2      3      4      5      6
//   old       125.0    -    138.0    -    137.5   loads/h, waiting in traffic 0.2 / - / 54 / - / 69 %
//   now       125.0  156.5  178.5  178.5  178.5   loads/h, waiting in traffic 0.1 / 0.1 / 13 / 7 / 14 %
const FLEETS = [2, 3, 4, 5, 6];
const reproduction = new Map();
const result = (n, legacy = false) => {
  const key = `${n}:${legacy}`;
  if (!reproduction.has(key)) reproduction.set(key, run(spurPlant(n), 2, { legacy }));
  return reproduction.get(key);
};

test('the report: with the old ranking every loading uses ONE dock and adding vehicles only lengthens the queue', () => {
  for (const n of [2, 4, 6]) {
    const { kpi } = result(n, true);
    for (const id of ['A', 'B']) {
      const top = Math.max(...shares(kpi, id));
      assert.ok(top >= 0.97, `${n} AGVs, ${id}: ${(top * 100).toFixed(1)} % of the visits use one dock`);
    }
  }
  const [two, four, six] = [2, 4, 6].map((n) => result(n, true).kpi);
  assert.ok(four.throughput.perHour < 145 && six.throughput.perHour < 145, `${four.throughput.perHour.toFixed(1)} / ${six.throughput.perHour.toFixed(1)} loads/h of 180 offered`);
  assert.ok(two.traffic.waitShare < 0.01 && four.traffic.waitShare > 0.4 && six.traffic.waitShare > 0.5, 'the waiting grows with the vehicles: 0.2 / 54 / 69 %');
  assert.ok(six.stations.B.dockWaitTotal > 3600, 'and the book sees the queue in front of the dock');
});

test('the fix: the free docks are used - the two nearest docks of each station take a fifth or more of the visits, none takes more than two thirds', () => {
  for (const n of [4, 5, 6]) {
    const { kpi } = result(n);
    for (const id of ['A', 'B']) {
      const s = shares(kpi, id);
      const sorted = s.slice().sort((a, b) => b - a);
      assert.ok(sorted[0] <= 2 / 3, `${n} AGVs, ${id}: the busiest dock takes ${(sorted[0] * 100).toFixed(0)} % of the visits (${s.map((x) => (x * 100).toFixed(0))})`);
      assert.ok(sorted[1] >= 0.2, `${n} AGVs, ${id}: the second dock takes ${(sorted[1] * 100).toFixed(0)} %`);
    }
  }
});

test('the fix: with 6 AGVs the plant delivers what is offered (170 or more of 180 loads/h), and throughput never falls when a vehicle is added', () => {
  const tp = FLEETS.map((n) => result(n).kpi.throughput.perHour);
  assert.ok(tp[4] >= 170, `6 AGVs: ${tp[4].toFixed(1)} loads/h`);
  for (let i = 1; i < tp.length; i++) assert.ok(tp[i] >= 0.97 * tp[i - 1], `${FLEETS[i - 1]} -> ${FLEETS[i]} AGVs: ${tp[i - 1].toFixed(1)} -> ${tp[i].toFixed(1)} loads/h`);
  assert.ok(tp[2] >= 170, 'four AGVs are enough now');
  const old = result(6, true).kpi.throughput.perHour;
  assert.ok(tp[4] > 1.2 * old, `against ${old.toFixed(1)} before`);
  assert.ok(result(6).kpi.stations.A.yardMax < 20, 'the Goods in no longer backs up (62 loads before)');
});

test('the fix: vehicles no longer queue in front of the station - the dock queue is gone and the waiting share is a fraction of what it was', () => {
  for (const n of [4, 6]) {
    const now = result(n).kpi;
    const before = result(n, true).kpi;
    assert.ok(now.traffic.waitShare < 0.2, `${n} AGVs: ${(now.traffic.waitShare * 100).toFixed(1)} % of the driving time (what remains is vehicles taking turns at the three T-junctions)`);
    assert.ok(now.traffic.waitShare < before.traffic.waitShare / 3, `against ${(before.traffic.waitShare * 100).toFixed(0)} % before`);
    for (const id of ['A', 'B']) assert.ok(now.stations[id].dockWaitTotal < 0.1 * before.stations[id].dockWaitTotal + 120, `${id}: queue for a dock ${now.stations[id].dockWaitTotal.toFixed(0)} against ${before.stations[id].dockWaitTotal.toFixed(0)} vehicle-seconds`);
  }
  assert.ok(result(2).kpi.traffic.waitShare < 0.01, 'two AGVs never got in each other\'s way and still do not');
});

test('the fix: a vehicle changes its mind at most once per approach (no flapping), and the book is consistent on every tick', () => {
  const sim = new Simulation(spurPlant(6));
  const checker = createSimChecker(sim);
  const book = sim.logistics.docks;
  const seen = new Map(); // reservation -> the docks it has been at
  let max = 0;
  for (let i = 0; i < 36000; i++) {
    sim.step();
    checker.check();
    for (const v of sim.vehicles) {
      if (v.dock === null) continue;
      const nodes = seen.get(v.dock) || [];
      if (nodes[nodes.length - 1] !== v.dock.node) nodes.push(v.dock.node);
      seen.set(v.dock, nodes);
      max = Math.max(max, nodes.length - 1);
    }
    if (i % 50 === 0) assert.deepEqual(checkDockInvariants(sim.logistics), [], `t=${sim.time.toFixed(1)}`);
  }
  assert.ok(book.switches >= 5, `vehicles did switch now and then (${book.switches} times in an hour)`);
  assert.equal(max, 1, 'but never twice on one approach');
  assert.equal(checkDockInvariants(sim.logistics).length, 0);
});

test('demand, speed, dispatch and routing what-ifs keep working with the dock book (runtime changes do not disturb reservations)', () => {
  const sim = new Simulation(spurPlant(5));
  const book = (n) => {
    for (let i = 0; i < n; i++) {
      sim.step();
      if (i % 10 === 0) assert.deepEqual(checkDockInvariants(sim.logistics), [], `t=${sim.time.toFixed(1)}`);
    }
  };
  book(6000);
  sim.setRuntime({ speedFactor: 2, demandFactor: 1.4, dispatch: 'oldest', routing: 'congestion' });
  book(6000);
  sim.setRuntime({ speedFactor: 0.5, demandFactor: 0.5, dispatch: 'balanced', routing: 'shortest' });
  book(6000);
  assert.deepEqual(checkDockInvariants(sim.logistics), []);
  assert.ok(sim.logistics.completed > 40, `${sim.logistics.completed} loads delivered`);
  assertAllFinite(sim.kpis());
});

// ---------------------------------------------------------------------------------------------------------------------
// No choice, no change
// ---------------------------------------------------------------------------------------------------------------------

/** One dock per station (a spur each), four AGVs, a minute of loading. */
const singleDock = () => layoutFromAscii([
  'AAA...BBB',
  'AAA...BBB',
  '.+.....+.',
  '.+++++++.',
], {
  stations: { A: { type: 'source', params: { interArrival: { kind: 'const', mean: 15, spread: 0 }, outCap: 50 } }, B: 'sink' },
  flows: [['A', 'B']],
  fleets: [{ count: 4, preset: 'agv', loadTime: 12, unloadTime: 12, idle: 'stay' }],
  settings: { warmup: 0, seed: 3 },
});

/** A KPI report as text: identical text = identical run. */
const text = (kpi) => JSON.stringify(kpi);

test('stations with one dock behave exactly as before: the report of a run with the dock book is identical to one without', () => {
  const plants = [
    ['a spur dock each, saturated', singleDock(), 1],
    ['Starter (every station has one dock)', EXAMPLES.find((e) => e.id === 'starter').build(), 1],
    ['a production line on a through lane (3 lined-up docks per station)', lineLayout({ vehicles: 4, gap: 6, arrival: 30, cycle: 10, settings: { seed: 5 } }), 1],
  ];
  for (const [name, layout, hours] of plants) {
    const on = run(layout, hours).kpi;
    const off = run(layout, hours, { legacy: true }).kpi;
    assert.equal(text(on), text(off), name);
    assert.ok(on.throughput.total > 5, `${name}: it did something`);
  }
});

test('a saturated single dock still queues (nothing can be chosen) and says so: dock-bottleneck, with its only dock named', () => {
  const { kpi, sim } = run(singleDock(), 1);
  assert.ok(kpi.stations.B.docks.length === 1 && kpi.stations.A.docks.length === 1);
  const b = kpi.stations.B;
  assert.ok(b.docks[0].busyShare > 0.7 && b.dockWaitTotal > 600, `busy ${(b.docks[0].busyShare * 100).toFixed(0)} %, queue ${b.dockWaitTotal.toFixed(0)} vehicle-s`);
  const insight = generateInsights(kpi, sim.layout).find((i) => i.id === 'dock-bottleneck:B');
  assert.ok(insight, 'the insight is there');
  assert.match(insight.title, /^Vehicles queue at B: its only dock is busy \d+ % of the time and vehicles waited [\d.]+ (s|min|h)\.$/);
  assert.match(insight.suggestion, /Add a second dock - any road cell touching the station - or a bypass bay\./);
  assert.deepEqual(insight.refs.stationIds, ['B']);
  assert.deepEqual(insight.refs.cells, [[b.docks[0].cx, b.docks[0].cy]]);
  assert.ok(!generateInsights(kpi, sim.layout).some((i) => i.id === 'docks-unbalanced:B'), 'one dock cannot be unbalanced');
});

test('idle vehicles that stay on the road and stand on a dock: the dock is taken (heldShare) but not busy (busyShare), and the advice is to let them park, not to add a dock', () => {
  const layout = layoutFromAscii(['AAA....BBB', 'AAA....BBB', '.+......+.', '.++++++++.'], {
    stations: { A: { type: 'source', params: { interArrival: { kind: 'exp', mean: 120, spread: 0 }, outCap: 20 } }, B: 'sink' },
    flows: [['A', 'B']],
    fleets: [{ count: 4, preset: 'agv', idle: 'stay' }],
    settings: { warmup: 0, seed: 2 },
  });
  const { kpi, sim } = run(layout, 4);
  const dock = kpi.stations.B.docks[0];
  assert.ok(dock.busyShare < 0.3, `served ${(dock.busyShare * 100).toFixed(0)} % of the time`);
  assert.ok(dock.heldShare > 0.5, `taken by an idle vehicle ${(dock.heldShare * 100).toFixed(0)} % of the time`);
  assert.ok(dock.busyShare + dock.heldShare <= 1 + 1e-9);
  assert.ok(dock.waitBefore > 600, 'and vehicles do queue behind them');
  const insights = generateInsights(kpi, sim.layout);
  assert.ok(!insights.some((i) => i.id === 'dock-bottleneck:B'), 'a second dock would be taken by the idle vehicles too');
  const hit = insights.find((i) => i.id === 'dock-idle-vehicles:B');
  assert.ok(hit, 'the insight is there');
  assert.match(hit.title, /^Idle vehicles stand on the dock of B \d+ % of the time and vehicles queue behind them\.$/);
  assert.match(hit.suggestion, /Park in depot/);
  assert.deepEqual(hit.refs.stationIds, ['B']);
  const rows = dockRows(kpi);
  assert.match(rows.find((r) => r.id === 'B').docks[0].heldText, /^idle vehicle on it \d+ %$/, 'the Results tab says so next to the busy share');
});

test('vehicles longer than a cell (tugger 3.5 m, forklift 2.6 m on 2 m cells) on one-cell spurs: the dock book never leaves a plant worse than 10 % below the old rule (it unlocked a gridlock of 1 load against 48 without the long-vehicle rule)', () => {
  for (const [preset, vehicles, spurs, interArrival] of [['tugger', 9, 5, 30], ['tugger', 9, 3, 30], ['tugger', 9, 3, 15], ['forklift', 9, 5, 30], ['forklift', 9, 3, 15]]) {
    const p = FLEET_PRESETS[preset];
    const fleet = { length: p.length, speed: p.speed, accel: p.accel, decel: p.decel, loadTime: p.loadTime, unloadTime: p.unloadTime, capacity: p.capacity };
    const layout = combPlant({ spurs, vehicles, spurLength: 1, interArrival, fleet, loadTime: p.loadTime, unloadTime: p.unloadTime, seed: 1 });
    const on = new Simulation(layout);
    on.advance(1800);
    const off = new Simulation(layout);
    legacy(off);
    off.advance(1800);
    const a = on.kpis();
    const b = off.kpis();
    assert.ok(a.throughput.total >= 0.9 * b.throughput.total, `${preset} x${vehicles}, ${spurs} spurs, a load every ${interArrival} s: ${a.throughput.total} loads against ${b.throughput.total}`);
    assert.ok(a.traffic.deadlocks <= b.traffic.deadlocks + 3, `${preset}: ${a.traffic.deadlocks} deadlocks against ${b.traffic.deadlocks}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Docks lined up on one lane, and the three-spur plant with its insights
// ---------------------------------------------------------------------------------------------------------------------

/** A through lane with the docks of both stations lined up along it, plus one spur dock beside each. */
const laneAndSpur = (vehicles) => layoutFromAscii([
  '..AAAA+.........BBBB+...',
  '..AAAA+.........BBBB+...',
  '++++++++++++++++++++++++',
], {
  stations: { A: { type: 'source', params: { interArrival: { kind: 'const', mean: 30, spread: 0 }, outCap: 20 } }, B: 'sink' },
  flows: [['A', 'B']],
  fleets: [{ count: vehicles, preset: 'agv', loadTime: 20, unloadTime: 20, idle: 'stay' }],
  settings: { warmup: 0, seed: 3 },
});

test('docks lined up on a through lane (plus a spur dock): no deadlock, nothing lost against the old ranking, the spur dock gets its share', () => {
  for (const n of [3, 5]) {
    const sim = new Simulation(laneAndSpur(n));
    const checker = createSimChecker(sim);
    for (let i = 0; i < 36000; i++) { sim.step(); checker.check(); }
    const now = sim.kpis();
    const before = run(laneAndSpur(n), 1, { legacy: true }).kpi;
    assert.equal(now.traffic.deadlocks, 0, `${n} AGVs: no deadlock`);
    assert.ok(now.throughput.perHour >= 0.98 * before.throughput.perHour, `${n} AGVs: ${now.throughput.perHour.toFixed(1)} against ${before.throughput.perHour.toFixed(1)} loads/h`);
    assert.deepEqual(checker.stuck({ seconds: 600 }), []);
    for (const id of ['A', 'B']) {
      const spur = now.stations[id].docks.filter((d) => d.cy <= 1);
      assert.equal(spur.length, 2, `${id} has a spur with two docks beside the station`);
      const used = spur.reduce((a, d) => a + d.visits, 0);
      // (the vehicles come from the east: A's spur is the first dock they pass, B's lies behind all four lane docks and is a last resort)
      if (n === 5 && id === 'A') assert.ok(used > 0, `${id}: the spur is used when the lane is taken (${used} visits)`);
    }
  }
});

test('a balanced plant says nothing about docks: the three spurs with 4 and 6 AGVs have neither dock-bottleneck nor docks-unbalanced', () => {
  for (const n of [4, 6]) {
    const { kpi, sim } = result(n);
    const ids = generateInsights(kpi, sim.layout).map((i) => i.id);
    assert.ok(!ids.some((id) => id.startsWith('dock')), `${n} AGVs: ${ids.join()}`);
  }
});

test('with the old ranking the same plant reports the one-dock imbalance and its reason', () => {
  const { kpi, sim } = result(6, true);
  const ins = generateInsights(kpi, sim.layout).filter((i) => i.id.startsWith('docks-unbalanced') || i.id.startsWith('dock-bottleneck'));
  const skew = ins.find((i) => i.id === 'docks-unbalanced:B');
  assert.ok(skew, ins.map((i) => i.id).join());
  assert.match(skew.title, /takes 100 % of the visits while .* hardly used/);
  assert.match(skew.detail, /a long way round|one behind the other|cannot get back/);
  assert.ok(skew.suggestion.length > 20);
});

test('dock KPIs: docks[] per station with cell, visits, busy share and queue time that add up; a window reset starts them again', () => {
  const sim = new Simulation(spurPlant(6, { settings: { warmup: 600 } }));
  sim.advance(3600);
  const kpi = sim.kpis();
  assertAllFinite(kpi);
  for (const [id, s] of Object.entries(kpi.stations)) {
    const docks = sim.graph.docks.get(id) || [];
    assert.equal(s.docks.length, docks.length, id);
    assert.deepEqual(s.docks.map((d) => d.node), docks, 'in node order');
    assert.ok(Math.abs(s.dockWaitTotal - s.docks.reduce((a, d) => a + d.waitBefore, 0)) < 1e-6);
    for (const d of s.docks) {
      assert.equal(d.cx, sim.graph.cx(d.node));
      assert.equal(d.cy, sim.graph.cy(d.node));
      assert.ok(d.busyShare >= 0 && d.busyShare <= 1 && d.visits >= 0 && d.waitBefore >= 0);
    }
  }
  const a = kpi.stations.A;
  const delivered = kpi.throughput.total;
  assert.ok(Math.abs(a.docks.reduce((n, d) => n + d.visits, 0) - delivered) <= 12, 'about one visit per load loaded');
  assert.ok(a.docks.some((d) => d.busyShare > 0.2));
  const window = kpi.window.duration;
  assert.ok(Math.abs(window - 3000) < 1, `the warm-up (600 s) is not in the window (${window})`);
  assert.ok(a.docks.reduce((n, d) => n + d.visits, 0) < 3600 / 20 * 0.9 * (window / 3600) * 1.2, 'visits are counted in the window only');
});

test('the Results tab lists the docks of stations with several docks or a queue (dockRows), the longest queue first; junk in the report does not throw', () => {
  const rows = dockRows(result(6).kpi);
  assert.deepEqual(rows.map((r) => r.name).sort(), ['A', 'B'], 'both stations have three docks');
  for (const r of rows) {
    assert.equal(r.docks.length, 3);
    assert.ok(r.docks.every((d) => /^\(\d+, \d+\)$/.test(d.label) && /^\d+(\.\d)? %$/.test(d.busyText) && /^\d+ visits?$/.test(d.visitsText) && d.busy >= 0 && d.busy <= 1));
    assert.ok(r.waitText === '' || /^queued /.test(r.waitText));
  }
  assert.ok(rows[0].wait >= rows[1].wait, 'longest queue first');
  const single = run(singleDock(), 1).kpi;
  assert.deepEqual(dockRows(single).map((r) => r.name), ['B'], 'a single dock appears when vehicles queue for it (5 s per visit or more: the sink here)');
  const calm = run(EXAMPLES.find((e) => e.id === 'starter').build(), 1).kpi;
  assert.deepEqual(dockRows(calm), [], 'and not when nobody did (the Starter: one dock each, no queue)');
  assert.deepEqual(dockRows(null), []);
  assert.deepEqual(dockRows({ stations: { x: { docks: 'junk', dockWaitTotal: 'many' }, y: { docks: [null, { visits: NaN }], dockWaitTotal: -3 } } }).map((r) => r.id), ['y']);
});

test('the dock markers sit on the dock cell, toward the station it serves (so a vehicle on the cell does not hide them)', () => {
  const sim = new Simulation(spurPlant(2));
  const cs = sim.graph.cellSize;
  const scene = { stationById: new Map(sim.layout.stations.map((s) => [s.id, { x: s.x * cs, y: s.y * cs, w: s.w * cs, h: s.h * cs }])) };
  const pts = dockMarkerPoints(sim.logistics.docks, sim.graph, scene);
  assert.equal(pts.length, 6);
  for (const m of pts) {
    const x = sim.graph.x(m.node);
    const y = sim.graph.y(m.node);
    assert.ok(Math.abs(m.x - x) < 1e-9, 'straight above the cell centre (the station is above the spur)');
    assert.ok(Math.abs(y - m.y - 0.36 * cs) < 1e-9, `0.36 cells toward the station: ${y - m.y}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Robustness: random plants, breakdowns, batteries, depots
// ---------------------------------------------------------------------------------------------------------------------

test('60 seeded random plants (one-way roads, breakdowns, batteries, depots, several docks per station): every invariant and the dock book on every tick', () => {
  let dockStations = 0;
  let reservations = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const layout = randomPlant(seed);
    layout.settings.warmup = 0;
    const sim = new Simulation(layout);
    dockStations += [...sim.graph.docks.values()].filter((d) => d.length > 1).length;
    const checker = createSimChecker(sim);
    const ticks = Math.round(900 / sim.dt);
    for (let i = 1; i <= ticks; i++) {
      sim.step();
      checker.check();
      const problems = checkDockInvariants(sim.logistics);
      assert.deepEqual(problems, [], `seed ${seed}, t=${sim.time.toFixed(1)}`);
      if (sim.vehicles.some((v) => v.dock !== null)) reservations++;
    }
    assertAllFinite(sim.kpis());
  }
  assert.ok(dockStations >= 60, `the plants have stations with several docks (${dockStations})`);
  assert.ok(reservations > 5000, 'and the vehicles reserve them');
});

test('the three-spur plant with breakdowns, batteries and a depot: reservations of broken and dead vehicles never leak', () => {
  const layout = layoutFromAscii([
    ...SPURS.slice(0, 3),
    row((x) => (x >= 1 && x <= 20 ? '+' : '.')),
    row((x) => (x === 21 ? '+' : '.')),
  ], {
    stations: { A: { type: 'source', params: { interArrival: { kind: 'const', mean: 25, spread: 0 }, outCap: 20 } }, B: 'sink' },
    flows: [['A', 'B']],
    fleets: [{ count: 6, preset: 'agv', loadTime: 12, unloadTime: 12, idle: 'stay', mtbf: 300, mttr: 60, battery: { enabled: true, runtimeMin: 25, chargeTimeMin: 10, lowPct: 20, resumePct: 80 } }],
    settings: { warmup: 0, seed: 9 },
  });
  const sim = new Simulation(layout);
  const checker = createSimChecker(sim);
  let broke = 0;
  for (let i = 0; i < 54000; i++) {
    sim.step();
    checker.check();
    assert.deepEqual(checkDockInvariants(sim.logistics), [], `t=${sim.time.toFixed(1)}`);
    for (const v of sim.vehicles) if (v.state === 'broken' && v.dock !== null) broke++;
  }
  assert.ok(broke > 0, 'a vehicle broke down while it held a reservation');
});

// ---------------------------------------------------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------------------------------------------------

test('same plant and seed: identical KPIs - also when the run is cut into pieces of different length', () => {
  const layout = spurPlant(6);
  const whole = new Simulation(layout);
  whole.advance(5400);
  const pieces = new Simulation(layout);
  for (const s of [1.3, 600, 77.7, 1000, 0.5, 2000, 700]) pieces.advance(s);
  pieces.advance(5400 - pieces.time);
  assert.equal(whole.time, pieces.time);
  assert.equal(text(whole.kpis()), text(pieces.kpis()));
  const again = new Simulation(layout);
  again.advance(5400);
  assert.equal(text(whole.kpis()), text(again.kpis()));
  assert.equal(whole.logistics.docks.switches, again.logistics.docks.switches);
  const other = new Simulation(layout, { seed: 4 });
  other.advance(5400);
  assert.ok(whole.logistics.docks.switches >= 0 && other.logistics.docks.switches >= 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// Speed
// ---------------------------------------------------------------------------------------------------------------------

test('the dock book is cheap: the Two-lines example runs within a few percent of the time with the book switched off', () => {
  const layout = EXAMPLES.find((e) => e.id === 'two-lines').build();
  // CPU time of this process (user + system), not wall-clock time: in CI this file runs beside other test processes, and a neighbour that
  // takes the core for a moment would stretch one of the two ~300 ms runs by 20 % and fail a comparison that has nothing to do with the code
  // (x1.24 was seen under load, on the CI runner after a merge, although the best of six runs of each was compared: a noisy neighbour lasts
  // for seconds, longer than one block of twelve runs). So the order of the two variants alternates, and a block that exceeds the bound is
  // measured again, up to three blocks in all: a real slowdown of the evaluation shows in every block, a passing neighbour in one.
  const time = (legacy) => {
    const sim = new Simulation(layout);
    if (legacy) sim.logistics.docks.enabled = false;
    const t0 = process.cpuUsage();
    sim.advance(3600);
    const used = process.cpuUsage(t0);
    return (used.user + used.system) / 1000;
  };
  const block = () => {
    const on = [];
    const off = [];
    for (let i = 0; i < 6; i++) {
      if (i % 2 === 0) { on.push(time(false)); off.push(time(true)); } else { off.push(time(true)); on.push(time(false)); }
    }
    const best = { on: Math.min(...on), off: Math.min(...off) };
    return { ...best, ratio: best.on / best.off };
  };
  time(false); // warm up the JIT
  const blocks = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    blocks.push(block());
    // 'off' still keeps the books (reservations, statistics): what is compared is the evaluation. The bound is loose for a busy machine;
    // the measured overhead against the code without any dock book is in the report of the change.
    if (blocks[attempt].ratio < 1.15) break;
  }
  const last = blocks[blocks.length - 1];
  assert.ok(
    last.ratio < 1.15,
    `with the dock evaluation ${last.on.toFixed(0)} ms of CPU, without ${last.off.toFixed(0)} ms (x${last.ratio.toFixed(3)}); blocks: ${blocks.map((b) => 'x' + b.ratio.toFixed(3)).join(', ')}`,
  );
});
