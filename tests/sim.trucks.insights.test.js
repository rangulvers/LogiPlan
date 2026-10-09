// The insight rules of trucks and dock doors (docs/WAREHOUSE-DESIGN.md 6.9 and Appendix B; js/sim/insights-ops.js): gate-queue-long, doors-bottleneck,
// unload-limited-by-vehicles, doors-idle and outbound-short. They are tested the way the built-in rules are: engineered plants that must trigger
// each one (and must not trigger the others), the exact edges of every threshold on mutated copies of a real report, silence for a plant without trucks,
// the thresholds that repeat those of insights.js, and the rules that exclude each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dist } from '../js/model/defaults.js';
import { DOOR_TARGET_UTILISATION } from '../js/model/doors.js';
import { EXAMPLES } from '../js/model/examples.js';
import { legacyExamples } from './helpers/golden.js';
import { Simulation } from '../js/sim/engine.js';
import {
  DOCK_BUSY_SHARE as BUILT_IN_DOCK_BUSY, DOCK_MIN_VISITS as BUILT_IN_DOCK_VISITS, DOCK_WAIT_PER_VISIT as BUILT_IN_DOCK_WAIT, EXTENSION_RULES,
  FLEET_PICKUP_WAIT, generateInsights,
} from '../js/sim/insights.js';
import * as ops from '../js/sim/insights-ops.js';
import * as L from '../js/model/layout.js';
import { validateLayout } from '../js/model/validate.js';
import { createWorld } from './helpers/logistics-invariants.js';
import { attachStats, fuzzPlant, microPlant } from './helpers/trucks-gen.js';

const CONST = (mean) => dist('const', mean, 0);
const OPS_IDS = ['gate-queue-long', 'doors-bottleneck', 'unload-limited-by-vehicles', 'doors-idle', 'outbound-short'];
const isOps = (i) => OPS_IDS.some((id) => i.id === id || i.id.startsWith(`${id}:`));
const find = (insights, rule, station) => insights.find((i) => i.id === `${rule}:${station}`);

/** Run a layout and return { report, insights, layout } after `hours` of simulated time. */
function run(layout, hours = 4, seed = 3) {
  const sim = new Simulation(layout, { seed });
  sim.advance(hours * 3600);
  const report = sim.kpis();
  return { report, layout: sim.layout, insights: generateInsights(report, sim.layout) };
}

/** A copy of `report` with the numbers of one truck station changed: paths such as 'gateWait.mean' or 'trucks.short'. */
function changed(report, station, patch, stationPatch = null) {
  const copy = structuredClone(report);
  for (const [path, value] of Object.entries(patch)) {
    const keys = path.split('.');
    let at = copy.ops.trucks[station];
    for (const key of keys.slice(0, -1)) at = at[key];
    at[keys[keys.length - 1]] = value;
  }
  if (stationPatch) Object.assign(copy.stations[station], stationPatch);
  return copy;
}

// ---- engineered plants ---------------------------------------------------------------------------------------------------

const PLANTS = {
  // one door that needs about 135 s per truck, a truck every 110 s, forklifts to spare: the doors are the limit
  overloadedDoor: () => microPlant({ storage: true, inbound: { doors: 1, checkIn: 60, checkOut: 30, interArrival: CONST(110), pallets: CONST(5) }, fleet: { count: 6 } }),
  // four doors and one slow forklift: trucks hold their doors for the time the forklift needs
  slowVehicles: () => microPlant({ storage: true, inbound: { doors: 4, checkIn: 30, checkOut: 30, interArrival: CONST(300), pallets: CONST(10) }, fleet: { count: 1, loadTime: 20, unloadTime: 20 } }),
  // four doors for a truck every 25 minutes
  idleDoors: () => microPlant({ storage: true, inbound: { doors: 4, checkIn: 60, checkOut: 30, interArrival: CONST(1500), pallets: CONST(4) }, fleet: { count: 4 } }),
  // a truck of 24 pallets every 10 minutes, but only 36 pallets an hour arrive: the trucks wait their 5 minutes and leave short
  shortTrucks: () => microPlant({ storage: true, aParams: { interArrival: CONST(100), batch: 1 }, outbound: { doors: 1, checkIn: 30, checkOut: 30, interArrival: CONST(600), pallets: CONST(24), maxDwell: 300, staging: 0 }, fleet: { count: 3 } }),
  // two doors for a truck every 150 s (busy about 40 %), plenty of forklifts: nothing to say
  balanced: () => microPlant({ storage: true, inbound: { doors: 2, checkIn: 60, checkOut: 30, interArrival: CONST(150), pallets: CONST(4) }, fleet: { count: 4 } }),
};

test('A1.12 (sim): gate-queue-long and doors-bottleneck fire when the doors are the limit, and unload-limited-by-vehicles does not', () => {
  const { insights, report } = run(PLANTS.overloadedDoor());
  const queue = find(insights, 'gate-queue-long', 'A');
  const bottleneck = find(insights, 'doors-bottleneck', 'A');
  assert.ok(queue && bottleneck, insights.map((i) => i.id).join());
  const minutes = report.ops.trucks.A.gateWait.mean / 60;
  assert.ok(minutes > 15 && minutes < 45, `a mean wait of ${minutes.toFixed(0)} min is a warning (15 to 45 min)`);
  assert.equal(queue.severity, 'warning');
  assert.equal(bottleneck.severity, 'warning');
  assert.equal(find(insights, 'unload-limited-by-vehicles', 'A'), undefined);
  assert.equal(find(insights, 'doors-idle', 'A'), undefined);
  assert.deepEqual(queue.refs.stationIds, ['A']);
  assert.deepEqual(bottleneck.refs.stationIds, ['A']);
  assert.match(queue.title, /wait .* at the gate of A/);
  assert.match(queue.suggestion, /Open another door: \d+ doors would be busy about \d+ ?%/, 'a number of doors with the arithmetic');
  assert.match(bottleneck.title, /The doors of A are the bottleneck: busy \d+ ?% of the time/);
  assert.match(bottleneck.suggestion, /\d+ doors would be busy about/);
  const doors = Number(bottleneck.suggestion.match(/(\d+) doors would be busy/)[1]);
  assert.ok(doors >= 2 && doors <= 4, `${doors} doors for one door at 100 %`);
});

test('A1.12 (sim): unload-limited-by-vehicles fires when the doors are held by slow unloading, and says so instead of doors-bottleneck', () => {
  const { insights, report } = run(PLANTS.slowVehicles());
  const vehicles = find(insights, 'unload-limited-by-vehicles', 'A');
  assert.ok(vehicles, insights.map((i) => i.id).join());
  assert.equal(vehicles.severity, 'warning');
  assert.match(vehicles.title, /not the problem, the vehicles are/);
  assert.match(vehicles.suggestion, /More doors would only let more trucks wait inside/);
  assert.equal(find(insights, 'doors-bottleneck', 'A'), undefined, 'the two rules never speak about the same station');
  const queue = find(insights, 'gate-queue-long', 'A');
  assert.ok(queue, 'the symptom is still reported');
  assert.ok(!/Open another door/.test(queue.suggestion), 'but its advice is about the vehicles, not about doors');
  assert.ok(report.ops.trucks.A.doorTime.mean > 600, 'a truck holds its door for a long time');
});

test('A1.12 (sim): doors-idle fires for four doors and a truck every 25 minutes, as an info, and nothing else of this module fires', () => {
  const { insights, report } = run(PLANTS.idleDoors());
  const idle = find(insights, 'doors-idle', 'A');
  assert.ok(idle, insights.map((i) => i.id).join());
  assert.equal(idle.severity, 'info');
  assert.match(idle.title, /A has 4 doors, but they are busy only \d+ ?% of the time/);
  assert.match(idle.suggestion, /\d+ doors? would carry the same trucks/);
  assert.deepEqual(insights.filter(isOps).map((i) => i.id), ['doors-idle:A']);
  assert.ok(report.ops.trucks.A.doorUtilization < ops.DOORS_IDLE_SHARE);
});

test('A1.12 (sim): outbound-short fires when trucks leave a Goods out without a full load, and names the cause', () => {
  const { insights, report } = run(PLANTS.shortTrucks());
  const short = find(insights, 'outbound-short', 'C');
  assert.ok(short, insights.map((i) => i.id).join());
  assert.equal(short.severity, 'warning');
  assert.match(short.title, /^\d+ of \d+ trucks left C without a full load\.$/);
  assert.match(short.detail, /the full 5 min/);
  assert.match(short.detail, /\d+ ?% of the planned pallets were loaded/);
  assert.ok(report.ops.trucks.C.trucks.short / report.ops.trucks.C.trucks.departed >= ops.OUTBOUND_SHORT_SHARE);
  assert.deepEqual(short.refs.stationIds, ['C']);
  assert.equal(find(insights, 'doors-bottleneck', 'C'), undefined, 'the trucks wait for pallets, the doors are not the problem');
});

test('a balanced plant gets none of the five findings; a Goods in and a Goods out with enough room are both silent', () => {
  const { insights, report } = run(PLANTS.balanced());
  assert.deepEqual(insights.filter(isOps), []);
  const a = report.ops.trucks.A;
  assert.ok(a.doorUtilization > ops.DOORS_IDLE_SHARE && a.doorUtilization < ops.DOORS_BUSY_SHARE, `utilization ${a.doorUtilization}`);
  const both = run(microPlant({
    storage: true,
    inbound: { doors: 2, checkIn: 60, checkOut: 30, interArrival: CONST(200), pallets: CONST(4) },
    outbound: { doors: 1, checkIn: 30, checkOut: 30, interArrival: CONST(400), pallets: CONST(4), maxDwell: 1800, staging: 2 },
    fleet: { count: 4 },
  }));
  assert.deepEqual(both.insights.filter(isOps).map((i) => i.id), [], 'staging and a long wait let every truck leave full');
});

// ---- the edges of the thresholds ----------------------------------------------------------------------------------------------

test('the thresholds are the ones of Appendix B, in seconds, and the copies of the built-in constants are equal to them', () => {
  assert.equal(ops.GATE_WAIT_WARNING, 15 * 60);
  assert.equal(ops.GATE_WAIT_CRITICAL, 45 * 60);
  assert.equal(ops.DOORS_BUSY_SHARE, 0.85);
  assert.equal(ops.DOORS_BUSY_SHARE, DOOR_TARGET_UTILISATION, 'the doors are called the bottleneck at the load the door check aims below');
  assert.equal(ops.DOORS_GATE_WAIT, 5 * 60);
  assert.equal(ops.UNLOAD_BLOCKED_SHARE, 0.25);
  assert.equal(ops.DOORS_IDLE_SHARE, 0.3);
  assert.equal(ops.DOORS_IDLE_GATE_WAIT, 60);
  assert.equal(ops.DOORS_IDLE_MIN_DOORS, 2);
  assert.equal(ops.OUTBOUND_SHORT_SHARE, 0.1);
  assert.equal(ops.MIN_TRUCKS, 3);
  // insights-ops.js cannot import insights.js (insights.js imports it), so it repeats these; they must not drift
  assert.equal(ops.UNLOAD_PICKUP_WAIT, FLEET_PICKUP_WAIT);
  assert.equal(ops.DOCK_BUSY_SHARE, BUILT_IN_DOCK_BUSY);
  assert.equal(ops.DOCK_WAIT_PER_VISIT, BUILT_IN_DOCK_WAIT);
  assert.equal(ops.DOCK_MIN_VISITS, BUILT_IN_DOCK_VISITS);
});

test('gate-queue-long: warning from a mean wait of 15 minutes, critical from 45, nothing below, and nothing before three trucks have come', () => {
  const layout = PLANTS.balanced();
  const base = run(layout, 2).report;
  const at = (wait, patch = {}) => generateInsights(changed(base, 'A', { 'gateWait.mean': wait, 'gateQueue.mean': 0, ...patch }), layout).find((i) => i.id === 'gate-queue-long:A');
  assert.equal(at(ops.GATE_WAIT_WARNING - 1), undefined);
  assert.equal(at(ops.GATE_WAIT_WARNING).severity, 'warning');
  assert.equal(at(ops.GATE_WAIT_CRITICAL - 1).severity, 'warning');
  assert.equal(at(ops.GATE_WAIT_CRITICAL).severity, 'critical');
  assert.equal(at(ops.GATE_WAIT_CRITICAL * 4).severity, 'critical');
  assert.equal(at(ops.GATE_WAIT_CRITICAL, { 'trucks.arrived': ops.MIN_TRUCKS - 1 }), undefined, 'two trucks are noise');
  assert.ok(at(ops.GATE_WAIT_WARNING, { 'trucks.arrived': ops.MIN_TRUCKS }));
  // trucks that are still waiting count: by Little's law the queue says what the few trucks that got a door do not
  const queue = (mean) => generateInsights(changed(base, 'A', { 'gateWait.mean': 10, 'gateQueue.mean': mean, 'trucks.arrived': 20 }), layout).find((i) => i.id === 'gate-queue-long:A');
  const duration = base.window.duration;
  assert.equal(queue((ops.GATE_WAIT_WARNING - 1) * 20 / duration), undefined);
  assert.ok(queue(ops.GATE_WAIT_WARNING * 20 / duration + 1e-6), 'a queue that only grows is not hidden by the trucks that did get a door');
});

test('doors-bottleneck: from 85 % busy and 5 minutes of waiting, not before', () => {
  const layout = PLANTS.balanced();
  const base = run(layout, 2).report;
  const at = (util, wait, patch = {}) => generateInsights(changed(base, 'A', { doorUtilization: util, 'gateWait.mean': wait, 'gateQueue.mean': 0, ...patch }), layout).find((i) => i.id === 'doors-bottleneck:A');
  assert.ok(at(ops.DOORS_BUSY_SHARE, ops.DOORS_GATE_WAIT));
  assert.equal(at(ops.DOORS_BUSY_SHARE - 1e-4, ops.DOORS_GATE_WAIT), undefined);
  assert.equal(at(ops.DOORS_BUSY_SHARE, ops.DOORS_GATE_WAIT - 1), undefined);
  assert.equal(at(1, ops.DOORS_GATE_WAIT * 10, { 'trucks.arrived': 2 }), undefined, 'two trucks are noise');
  const finding = at(0.95, 600);
  assert.match(finding.suggestion, /Open another door: 3 doors would be busy about 6\d ?%/, '2 doors at 95 % carry the same trucks with 3 doors at 63 %');
});

test('doors-idle: two doors or more, under 30 % busy, trucks wait under a minute', () => {
  const layout = PLANTS.idleDoors();
  const base = run(layout, 2).report;
  const at = (util, wait, doors = 4) => generateInsights(changed(base, 'A', { doorUtilization: util, 'gateWait.mean': wait, 'gateQueue.mean': 0, doors }), layout).find((i) => i.id === 'doors-idle:A');
  assert.ok(at(ops.DOORS_IDLE_SHARE - 1e-4, ops.DOORS_IDLE_GATE_WAIT - 1));
  assert.equal(at(ops.DOORS_IDLE_SHARE, 0), undefined);
  assert.equal(at(0.1, ops.DOORS_IDLE_GATE_WAIT), undefined);
  assert.ok(at(0.1, 0, ops.DOORS_IDLE_MIN_DOORS), 'two doors are enough to have one too many');
  assert.equal(at(0.1, 0, ops.DOORS_IDLE_MIN_DOORS - 1), undefined, 'one door is never too many');
  assert.equal(at(0.45, 0, 2), undefined, 'two doors at 45 %: one door could not carry that');
});

test('outbound-short: from 10 % of the trucks short, with at least three trucks gone', () => {
  const layout = PLANTS.shortTrucks();
  const base = run(layout, 2).report;
  const at = (departed, short) => generateInsights(changed(base, 'C', { 'trucks.departed': departed, 'trucks.short': short }), layout).find((i) => i.id === 'outbound-short:C');
  assert.ok(at(10, 1));
  assert.ok(at(20, 2));
  assert.equal(at(20, 1), undefined);
  assert.equal(at(10000, 999), undefined);
  assert.equal(at(ops.MIN_TRUCKS - 1, ops.MIN_TRUCKS - 1), undefined);
  assert.ok(at(ops.MIN_TRUCKS, 1));
  assert.equal(generateInsights(changed(base, 'C', { 'trucks.departed': 10, 'trucks.short': 1 }), layout).filter((i) => i.id === 'outbound-short:A').length, 0, 'a Goods in cannot leave short');
});

test('unload-limited-by-vehicles needs evidence (the Goods in blocked a quarter of the time, or pallets waiting two minutes for a vehicle); without it the doors are blamed', () => {
  const layout = PLANTS.slowVehicles();
  const { report } = run(layout, 4);
  const flow = Object.keys(report.flows).find((id) => report.flows[id].trips > 0);
  const at = (blocked, pickup) => {
    const copy = changed(report, 'A', {}, { blocked });
    copy.flows[flow].avgPickupWait = pickup;
    return generateInsights(copy, layout).filter(isOps).map((i) => i.id);
  };
  assert.ok(at(ops.UNLOAD_BLOCKED_SHARE, 0).includes('unload-limited-by-vehicles:A'));
  assert.ok(at(0, ops.UNLOAD_PICKUP_WAIT).includes('unload-limited-by-vehicles:A'));
  const neither = at(ops.UNLOAD_BLOCKED_SHARE - 1e-4, ops.UNLOAD_PICKUP_WAIT - 1);
  assert.ok(!neither.includes('unload-limited-by-vehicles:A'), neither.join());
  assert.ok(neither.includes('doors-bottleneck:A') || neither.includes('gate-queue-long:A'), 'the doors are blamed instead');
  for (const [blocked, pickup] of [[1, 0], [0, 1000], [0.3, 500], [0, 0]]) {
    const ids = at(blocked, pickup);
    assert.ok(!(ids.includes('doors-bottleneck:A') && ids.includes('unload-limited-by-vehicles:A')), `${blocked}/${pickup}: ${ids.join()}`);
  }
});

// ---- registration, silence, exclusion ---------------------------------------------------------------------------------------

test('the five rules are registered in EXTENSION_RULES in the order of Appendix B, and are silent for every plant without trucks', () => {
  assert.deepEqual(EXTENSION_RULES.map((r) => r.name), ['gateQueueLong', 'doorsBottleneck', 'unloadLimitedByVehicles', 'doorsIdle', 'outboundShort']);
  assert.deepEqual(EXTENSION_RULES, [...ops.OPS_INSIGHT_RULES]);
  assert.ok(Object.isFrozen(ops.OPS_INSIGHT_RULES));
  for (const example of legacyExamples(EXAMPLES)) {
    const sim = new Simulation(example.build(), { seed: 1 });
    sim.advance(1800);
    const report = sim.kpis();
    assert.equal(report.ops, undefined);
    assert.deepEqual(generateInsights(report, sim.layout).filter(isOps), [], example.name);
  }
});

test('the findings read well: no NaN, undefined or Infinity in any text, and the ids, severities and refs have the documented shape (engineered and 60 random plants)', () => {
  const texts = [];
  const check = (insights, label) => {
    for (const i of insights.filter(isOps)) {
      assert.match(i.id, /^(gate-queue-long|doors-bottleneck|unload-limited-by-vehicles|doors-idle|outbound-short):[\w-]+$/, label);
      assert.ok(['critical', 'warning', 'info'].includes(i.severity) && i.severity !== 'good', `${label}: ${i.id} is ${i.severity}`);
      for (const field of ['title', 'detail', 'suggestion']) {
        assert.equal(typeof i[field], 'string', `${label}: ${i.id}.${field}`);
        assert.ok(!/NaN|undefined|Infinity|null|\[object/.test(i[field]), `${label}: ${i.id}.${field} = ${i[field]}`);
        texts.push(i[field]);
      }
      assert.ok(Array.isArray(i.refs.stationIds) && i.refs.stationIds.length === 1 && i.id.endsWith(`:${i.refs.stationIds[0]}`), `${label}: refs ${JSON.stringify(i.refs)}`);
    }
    // the rules that exclude each other (per station)
    const byStation = {};
    for (const i of insights.filter(isOps)) (byStation[i.refs.stationIds[0]] ||= new Set()).add(i.id.split(':')[0]);
    for (const [station, rules] of Object.entries(byStation)) {
      assert.ok(!(rules.has('doors-bottleneck') && rules.has('unload-limited-by-vehicles')), `${label}/${station}: doors and vehicles blamed at once`);
      assert.ok(!(rules.has('doors-idle') && (rules.has('gate-queue-long') || rules.has('doors-bottleneck'))), `${label}/${station}: idle doors and a queue at once`);
      assert.ok(!(rules.has('doors-bottleneck') && rules.has('outbound-short')), `${label}/${station}: doors and supply blamed at once`);
    }
  };
  for (const [name, make] of Object.entries(PLANTS)) check(run(make()).insights, name);
  for (let seed = 1; seed <= 60; seed++) {
    const w = attachStats(createWorld(fuzzPlant(seed, { style: seed % 2 === 0 ? 'busy' : 'hostile' }), { dt: 0.5, seed }));
    w.run(1500);
    check(generateInsights(w.stats.report(), w.layout), `fuzz ${seed}`);
  }
  assert.ok(texts.length >= 30, `${texts.length} texts checked`);
});

test('a warning of these rules keeps the "good" insight away', () => {
  const warned = run(PLANTS.overloadedDoor()).insights;
  assert.ok(warned.some((i) => i.id === 'doors-bottleneck:A' && i.severity === 'warning'));
  assert.ok(!warned.some((i) => i.severity === 'good'));
});

test('the older `supply` rule leaves a Goods in with trucks alone (a truck fills the yard by design) and still speaks for a source without trucks (M1-SIM-REV-3)', () => {
  const { report, layout } = run(PLANTS.balanced());
  const piled = (r, id) => { Object.assign(r.stations[id], { blocked: 0.6, yardNow: 30, yardMax: 40 }); return r; };
  const withTrucks = piled(structuredClone(report), 'A');
  assert.equal(find(generateInsights(withTrucks, layout), 'supply', 'A'), undefined, 'a pile in the yard of a truck station is the truck being unloaded');
  const without = piled(structuredClone(report), 'A');
  delete without.ops;
  assert.ok(find(generateInsights(without, layout), 'supply', 'A'), 'the same numbers on a report without trucks speak: the rule is unchanged for a legacy plant');
  // a Goods out is not a source; and a source WITHOUT trucks in a plant that has a truck station elsewhere is still judged
  const other = piled(structuredClone(report), 'A');
  other.ops.trucks.A.role = 'out';
  assert.ok(find(generateInsights(other, layout), 'supply', 'A'), 'only a station that receives trucks is left to the truck rules');
});

test('doors-bottleneck on a Goods out whose trucks mostly wait for pallets says that more doors move the wait, and the rule on a Goods in does not', () => {
  // 51 pallets an hour for trucks of 24 every 25 minutes (57.6 an hour): the trucks fill one after the other, a second door only moves the wait
  const out = run(microPlant({
    storage: true, aParams: { interArrival: dist('const', 3600 / 51, 0), batch: 1 },
    outbound: { doors: 1, checkIn: 300, checkOut: 300, interArrival: CONST(1500), pallets: CONST(24), maxDwell: 14400, staging: 4 }, fleet: { count: 4 }, settings: { warmup: 1800 },
  }), 8);
  const bottleneck = find(out.insights, 'doors-bottleneck', 'C');
  assert.ok(bottleneck, 'the rule follows Appendix B and speaks (85 % busy, 5 minutes at the gate)');
  assert.match(bottleneck.suggestion, /^Open another door: 2 doors would be busy about \d+ % of the time\./);
  assert.match(bottleneck.suggestion, /more doors only move the wait from the gate to the door/);
  const inbound = find(run(PLANTS.overloadedDoor()).insights, 'doors-bottleneck', 'A');
  assert.ok(inbound);
  assert.doesNotMatch(inbound.suggestion, /move the wait/);
});

test('docks in a row say "one lane" in the insight and in the plan check alike, also when a second road lies behind them (M1-MODEL-REV-3)', () => {
  const plant = (behind) => {
    const l = L.createLayout({ name: 'Dock lab', cols: 40, rows: 24, cellSize: 2 });
    L.paintRoadPath(l, [[4, 10], [30, 10], [30, 18], [4, 18], [4, 10]]);
    if (behind) { for (let x = 4; x <= 30; x++) L.paintRoadPath(l, [[x, 10], [x, 11]]); L.paintRoadPath(l, [[4, 11], [30, 11]]); }
    const src = L.addStation(l, { type: 'source', name: 'Goods in', x: 10, y: 8, w: 6, h: 2, ops: { trucks: { doors: 6, checkIn: 60, checkOut: 60, interArrival: CONST(168), pallets: CONST(12) } } });
    const sink = L.addStation(l, { type: 'sink', name: 'Goods out', x: 31, y: 13, w: 3, h: 2 });
    const park = L.addStation(l, { type: 'depot', name: 'Park', x: 8, y: 19, w: 3, h: 2, params: { slots: 8 } });
    L.paintRoadPath(l, [[9, 18], [9, 19]]);
    L.addFlow(l, src.id, sink.id);
    L.addFleet(l, 'forklift', { name: 'FL', count: 8, home: park.id, capacity: 1 });
    return { layout: L.normalizeLayout(l), id: src.id };
  };
  for (const behind of [false, true]) {
    const { layout, id } = plant(behind);
    assert.ok(validateLayout(layout).some((i) => i.id === `docks-share-lane:${id}`), `the plan check warns (road behind: ${behind})`);
    const { insights } = run(layout, 3);
    const unbalanced = find(insights, 'docks-unbalanced', id);
    assert.ok(unbalanced, `the docks are unbalanced (road behind: ${behind})`);
    assert.match(unbalanced.detail, /the docks lie one behind the other on one lane/, `road behind: ${behind}`);
  }
});
