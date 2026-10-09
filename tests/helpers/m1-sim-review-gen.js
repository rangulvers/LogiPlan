// Helper of tests/m1.sim.review.test.js: the adversarial review of the truck engine of milestone M1 (SIMULATION angle).
//
// Written independently of tests/helpers/trucks-gen.js on purpose (a second generator finds what the first one's author did not think of).
// Plants are built ONLY through the public model mutators (layout.js), run on the REAL engine (Simulation: real traffic, real Stats) and audited
// with a checker that recomputes everything from the raw state instead of trusting the counters of the engine.
//
//   hostileTruckPlant(seed, opts)       a random plant full of corners (see below) plus a plan of what-if actions for the run
//   audit(sim, ledger)                  every invariant of 6.3.5 and the conservation law, recomputed from scratch (throws a descriptive Error)
//   makeLedger(sim)                     listens to the events of a run: an independent tally of the truck events and the loads
//   runAudited(sim, seconds, opts)      step tick by tick, apply the planned actions, audit after every tick
//   walk(value)                         every number inside a report, with its path (for the "no NaN anywhere" check)
//   legacyPlant(seed)                   a random plant WITHOUT any trucks (the old-tree comparison)
//   digest(sim)                         a short text of everything observable at the end of a run (kpis, ops, truck events)
//
// Corners reached by hostileTruckPlant: one door and 32 doors, more doors than docks, staging 0 and 50, maxDwell 0 and 1 s, jitter up to 2 h,
// no-shows up to 50 %, timetables of 0 to 500 rows (rows at the same second, at time 0, beyond the horizon, in the past of the clock), pallets
// 1 and 200, a Goods in that feeds several flows, flows with batchMin / batchMax / perCycle / maxWait, restricted fleets, battery and breakdown
// fleets, no vehicles at all, a one-way ring, a dead-end street, a Goods in with no flow, a Goods out with no supply.

import { createRng } from '../../js/util/rng.js';
import {
  addFlow, addFleet, addStation, createLayout, normalizeLayout, paintRoadPath, updateCalendar, updateSettings,
} from '../../js/model/layout.js';
import { SampleSet, WARMUP_EPS } from '../../js/sim/stats.js';
import { flowSpace } from '../../js/sim/logistics/stations.js';
import { TruckDesk } from '../../js/sim/logistics/trucks.js';

const pick = (rng, list) => list[rng.int(list.length)];
const chance = (rng, p) => rng.next() < p;

// ---- the plant -----------------------------------------------------------------------------------------------------------------------

const COLS = 44;
const ROWS = 30;
const RING = { left: 3, right: 40, top: 12, bottom: 20 };
const DIST_KINDS = ['const', 'normal', 'uniform', 'exp'];

function ringPath() {
  const { left, right, top, bottom } = RING;
  return [[left, top], [right, top], [right, bottom], [left, bottom], [left, top]];
}

/** The raw `ops.trucks` block of one station (the sanitizer clamps it); `window` = [first, last] second of the clock day the rows fall in. */
function trucksBlock(rng, role, window, wild) {
  const mode = chance(rng, 0.4) ? 'schedule' : 'rate';
  const trucks = {
    doors: pick(rng, wild ? [1, 1, 2, 3, 5, 32] : [1, 2, 2, 3, 4]),
    checkIn: pick(rng, wild ? [0, 0, 1, 60, 300, 1800] : [0, 30, 120, 300]),
    checkOut: pick(rng, wild ? [0, 0, 1, 60, 300, 1800] : [0, 30, 120, 300]),
    mode,
    interArrival: { kind: pick(rng, DIST_KINDS), mean: pick(rng, wild ? [60, 90, 300, 1200, 3600] : [120, 300, 900]), spread: rng.next() },
    pallets: { kind: pick(rng, DIST_KINDS), mean: pick(rng, wild ? [1, 2, 6, 24, 200] : [2, 6, 12, 24]), spread: rng.next() },
    jitter: pick(rng, wild ? [0, 0, 5, 300, 7200] : [0, 0, 60]),
    noShow: pick(rng, wild ? [0, 0, 0.1, 0.5] : [0, 0, 0.1]),
    maxDwell: pick(rng, wild ? [0, 1, 30, 600, 3600] : [0, 300, 1200, 3600]),
    staging: pick(rng, wild ? [0, 0, 1, 4, 50] : [0, 2, 4]),
  };
  if (mode === 'schedule') {
    const count = pick(rng, wild ? [0, 1, 3, 10, 60, 500] : [2, 6, 15]);
    const rows = [];
    for (let i = 0; i < count; i++) {
      const where = rng.next();
      let at;
      if (where < 0.5) at = window[0] + rng.int(Math.max(1, window[1] - window[0])); // inside the run
      else if (where < 0.65) at = window[0]; // exactly at time 0 of the run
      else if (where < 0.8 && rows.length > 0) at = rows[rng.int(rows.length)].at; // the same second as another row
      else if (where < 0.9) at = window[1] + 1 + rng.int(40000); // beyond the horizon
      else at = rng.int(86400); // anywhere in the day: some are in the past of the clock
      rows.push({ at: ((at % 86400) + 86400) % 86400, pallets: chance(rng, 0.3) ? null : pick(rng, [1, 1, 3, 12, 24, 200]) });
    }
    trucks.schedule = rows;
  }
  return trucks;
}

/**
 * A random plant with trucks, built with the layout.js mutators, and the actions to apply while it runs.
 * @param {number} seed
 * @param {{ wild?: boolean, horizon?: number, noTrucks?: boolean, vehicles?: number }} [opts]
 *   `wild`: draw from the extremes of every range (default: every third seed is tame); `horizon`: seconds the timetable rows are spread over;
 *   `noTrucks`: the same plant without any `ops` (the neutrality comparison); `vehicles`: force the number of forklifts of the first fleet
 * @returns {{ layout: object, actions: Array<{ at: number, kind: string, value?: number, index?: number }>, notes: object }}
 */
export function hostileTruckPlant(seed, { wild = seed % 3 !== 0, horizon = 1800, noTrucks = false, vehicles } = {}) {
  const rng = createRng(seed * 104729 + 7);
  const startTod = pick(rng, [0, 6 * 3600, 86400 - 600, 86400 - 1800]);
  const window = [startTod, startTod + horizon];
  const layout = createLayout({ name: `hostile ${seed}`, cols: COLS, rows: ROWS, cellSize: 2 });
  const oneWayRing = chance(rng, 0.2);
  const deadEnd = !oneWayRing && chance(rng, 0.2);
  if (deadEnd) paintRoadPath(layout, [[RING.left, RING.top], [RING.right, RING.top]]); // a single street
  else paintRoadPath(layout, ringPath(), { oneWay: oneWayRing });

  // slots along the street: stations above the top road, below the bottom road (or both above and below the single street)
  const slots = [];
  for (const x of [5, 13, 21, 29]) slots.push({ x, side: 'top' });
  for (const x of [5, 13, 21, 29]) slots.push({ x, side: deadEnd ? 'top2' : 'bottom' });
  const kinds = ['source', 'sink'];
  const extra = 1 + rng.int(5);
  for (let i = 0; i < extra; i++) kinds.push(pick(rng, ['source', 'sink', 'storage', 'storage', 'process']));
  if (chance(rng, 0.6)) kinds.push('depot');
  const stations = [];
  const taken = new Set();
  for (const type of kinds) {
    let slotIndex = -1;
    for (let tries = 0; tries < 20 && slotIndex < 0; tries++) {
      const i = rng.int(slots.length);
      if (!taken.has(i)) slotIndex = i;
    }
    if (slotIndex < 0) break;
    taken.add(slotIndex);
    const slot = slots[slotIndex];
    const w = pick(rng, [2, 3, 5, 7]);
    const spur = chance(rng, 0.4) ? 2 : 0; // a short side road to the station: docks that do not share a lane
    let y;
    if (slot.side === 'top') y = RING.top - 2 - spur;
    else if (slot.side === 'bottom') y = RING.bottom + 1 + spur;
    else y = RING.top + 1 + spur; // 'top2': below the single street
    if (spur > 0) {
      const x = slot.x + rng.int(w);
      if (slot.side === 'top') paintRoadPath(layout, [[x, RING.top], [x, RING.top - spur]]);
      else if (slot.side === 'bottom') paintRoadPath(layout, [[x, RING.bottom], [x, RING.bottom + spur]]);
      else paintRoadPath(layout, [[x, RING.top], [x, RING.top + spur]]);
    }
    const params = {};
    if (type === 'source') Object.assign(params, { interArrival: { kind: 'exp', mean: pick(rng, [30, 120, 600]), spread: 0.3 }, batch: pick(rng, [1, 2, 4]), outCap: pick(rng, [0, 2, 6, 12]), startDelay: pick(rng, [0, 0, 45]) });
    if (type === 'process') Object.assign(params, { cycle: { kind: 'uniform', mean: pick(rng, [5, 40, 120]), spread: 0.3 }, machines: 1 + rng.int(3), inCap: pick(rng, [2, 6]), outCap: pick(rng, [2, 6]), mtbf: pick(rng, [0, 0, 600]), mttr: 60 });
    if (type === 'storage') Object.assign(params, { capacity: pick(rng, [3, 20, 500]), dwell: pick(rng, [0, 0, 20]) });
    if (type === 'depot') Object.assign(params, { slots: 8, chargers: pick(rng, [0, 2, 8]) });
    const spec = { type, x: slot.x, y, w, h: 2, params };
    const station = addStation(layout, spec);
    if (station) stations.push(station);
  }
  const ofType = (type) => stations.filter((s) => s.type === type);
  const depot = ofType('depot')[0] || null;

  // flows: sources / storages / processes to storages / processes / sinks, at most one per ordered pair
  const from = stations.filter((s) => ['source', 'storage', 'process'].includes(s.type));
  const to = stations.filter((s) => ['storage', 'process', 'sink'].includes(s.type));
  const flows = [];
  const wanted = 1 + rng.int(7);
  for (let tries = 0; tries < 60 && flows.length < wanted; tries++) {
    const a = pick(rng, from);
    const b = pick(rng, to);
    if (!a || !b || a === b) continue;
    const flow = addFlow(layout, a.id, b.id, {
      weight: pick(rng, [1, 1, 3]), perCycle: pick(rng, [1, 1, 2]), batchMin: pick(rng, [1, 1, 1, 2, 5]), batchMax: pick(rng, [0, 0, 0, 3]),
      maxWait: pick(rng, [0, 0, 0, 30, 600]), priority: pick(rng, [1, 1, 2, 3]),
    });
    if (flow) flows.push(flow);
  }

  // a Goods in that feeds several flows: its pallets are split by the weighted round-robin and picked up from different queues
  const firstSource = stations.find((st) => st.type === 'source');
  if (firstSource && chance(rng, 0.45)) {
    for (const target of to) {
      if (flows.filter((f) => f.from === firstSource.id).length >= 3) break;
      const flow = target !== firstSource && chance(rng, 0.7) ? addFlow(layout, firstSource.id, target.id, { weight: pick(rng, [1, 2, 3]), batchMin: pick(rng, [1, 1, 2]) }) : null;
      if (flow) flows.push(flow);
    }
  }

  // fleets: restricted, battery and breakdown fleets, or none at all
  const fleetCount = chance(rng, 0.1) ? 0 : 1 + rng.int(2);
  const fleets = [];
  for (let i = 0; i < fleetCount; i++) {
    const preset = pick(rng, ['forklift', 'forklift', 'agv', 'tugger']);
    const count = i === 0 && vehicles !== undefined ? vehicles : pick(rng, [0, 1, 2, 3, 5, 8]);
    const patch = { count, capacity: pick(rng, [1, 1, 2, 4]), loadTime: pick(rng, [0, 5, 20]), unloadTime: pick(rng, [0, 5, 20]), length: 1.6, idle: pick(rng, ['park', 'stay']) };
    if (depot && chance(rng, 0.7)) patch.home = depot.id;
    if (chance(rng, 0.25)) Object.assign(patch, { mtbf: pick(rng, [300, 1800]), mttr: pick(rng, [20, 300]) });
    if (chance(rng, 0.2)) patch.battery = { enabled: true, runtimeMin: pick(rng, [5, 20, 480]), chargeTimeMin: 10, lowPct: 25, resumePct: 80 };
    const fleet = addFleet(layout, preset, patch);
    if (fleet) fleets.push(fleet);
  }
  if (fleets.length > 1) for (const flow of flows) if (chance(rng, 0.25)) flow.fleetId = pick(rng, fleets).id; // restricted fleets

  // trucks (raw blocks: the sanitizer of the mutator clamps them). Sources and sinks: most of them get trucks.
  let any = false;
  for (const st of stations) {
    if (st.type !== 'source' && st.type !== 'sink') continue;
    if (noTrucks || !(chance(rng, 0.85) || (!any && st === stations.find((s) => s.type === st.type)))) continue;
    const block = trucksBlock(rng, st.type === 'sink' ? 'out' : 'in', window, wild);
    st.ops = { trucks: block }; // normalizeLayout (below) sanitizes it and stamps the schema
    any = true;
  }
  if (!noTrucks && layout.stations.some((s) => s.ops && s.ops.trucks.mode === 'schedule')) updateCalendar(layout, { startTod, startDay: rng.int(7) });
  else if (!noTrucks && chance(rng, 0.3)) updateCalendar(layout, { startTod, startDay: 0 });
  updateSettings(layout, { dt: pick(rng, [0.1, 0.1, 0.25]), seed, warmup: pick(rng, [0, 0, 0, 240]), demandFactor: pick(rng, [1, 1, 0.5, 3]) });

  // what-if actions while it runs
  const actions = [];
  if (chance(rng, 0.5)) actions.push({ at: 200 + rng.int(horizon / 2), kind: 'demand', value: pick(rng, [0, 3, 0.3]) });
  if (chance(rng, 0.3)) actions.push({ at: horizon / 2 + rng.int(horizon / 2), kind: 'demand', value: 1 });
  if (chance(rng, 0.4)) actions.push({ at: 100 + rng.int(horizon), kind: 'removeVehicle', index: rng.int(8) });
  actions.sort((a, b) => a.at - b.at);
  return { layout: normalizeLayout(layout), actions, notes: { oneWayRing, deadEnd, stations: stations.length, flows: flows.length, fleets: fleets.length, startTod } };
}

/** The same plant without any vehicle (and no fleet restriction): trucks arrive and hold their doors, nothing is unloaded. Cheap to run: for arrival times. */
export function withoutVehicles(layout) {
  const copy = JSON.parse(JSON.stringify(layout));
  copy.fleets = [];
  for (const flow of copy.flows) flow.fleetId = null;
  return normalizeLayout(copy);
}

/** A random plant without any truck option and without the kinds of station M1 touches: for the old-tree comparison (the text is the same on both trees). */
export function legacyPlant(seed) {
  return hostileTruckPlant(seed, { noTrucks: true, wild: false }).layout;
}

// ---- the ledger: an independent tally of the events -------------------------------------------------------------------------------------

/**
 * Listen to a simulation and tally what the events say, so that report.ops and the desks can be checked against something that does not come
 * from the engine's own counters.
 */
export function makeLedger(sim) {
  const ledger = {
    events: [], created: 0, completed: 0, byStation: new Map(), loadsSeen: new Set(), createdAtOf: new Map(),
    leadErrors: [], problems: [], trucks: new Map(), lastArrivalAt: new Map(), readyAt: new Map(), sim,
    // the measurement window as the Stats see it: it starts at once without a warm-up, else after the tick that reaches the warm-up
    windowStart: sim.settings.warmup > 0 ? Infinity : 0, duration: 0, integral: new Map(),
  };
  const station = (id) => {
    if (!ledger.byStation.has(id)) {
      ledger.byStation.set(id, {
        arrived: 0, docked: 0, departed: 0, short: 0, noShow: 0, turnedAway: 0, ready: 0, planSum: 0, loadedSum: 0, plannedOfDeparted: 0,
        gateWaits: [], doorTimes: [], turnarounds: [], arrivals: [], dockedLog: [], palletsCreated: 0,
      });
    }
    return ledger.byStation.get(id);
  };
  ledger.station = station;
  /** Call after every sim.step(): integrates the gate queue and the doors in use over the measurement window, tick by tick, like Stats does. */
  ledger.tick = () => {
    if (ledger.windowStart === Infinity) {
      if (sim.time + WARMUP_EPS >= sim.settings.warmup) { ledger.windowStart = sim.time; ledger.resetCounters(); }
      return;
    }
    ledger.duration += sim.dt;
    for (const st of sim.logistics.stations) {
      if (st.trucks === null) continue;
      if (!ledger.integral.has(st.id)) ledger.integral.set(st.id, { gate: 0, docked: 0, gateMax: 0 });
      const cell = ledger.integral.get(st.id);
      cell.gate += st.trucks.gate.length * sim.dt;
      cell.docked += st.trucks.docked.length * sim.dt;
      if (st.trucks.gate.length > cell.gateMax) cell.gateMax = st.trucks.gate.length;
    }
  };
  /**
   * Stats.reset() also runs when the number of vehicles changes (Stats._stale: a vehicle removed from the running plant): the window starts again at
   * the next tick, like a warm-up that ends then. Call it right after removing a vehicle.
   */
  ledger.restart = () => {
    if (ledger.windowStart === Infinity) return; // still warming up: the end of the warm-up resets anyway
    ledger.windowStart = sim.time; ledger.duration = 0; ledger.integral = new Map(); ledger.resetCounters();
  };
  /** The warm-up is over: what the events said so far belongs to the discarded part. */
  ledger.resetCounters = () => { ledger.window = new Map(); };
  ledger.window = new Map();
  ledger.windowOf = (id) => {
    if (!ledger.window.has(id)) {
      ledger.window.set(id, { arrived: 0, docked: 0, departed: 0, short: 0, noShow: 0, turnedAway: 0, planned: 0, loaded: 0, waits: [], doors: [], turns: [] });
    }
    return ledger.window.get(id);
  };
  sim.on('*', (p, name) => {
    ledger.events.push({ name, t: p.t, stationId: p.stationId, truckId: p.truck ? p.truck.id : null });
    if (name === 'loadCreated') {
      ledger.created++;
      ledger.createdAtOf.set(p.load.id, p.load.createdAt);
      if (p.load.tk >= 0) { /* tk is set right after the event for a truck pallet */ }
    } else if (name === 'loadCompleted') {
      ledger.completed++;
      const created = ledger.createdAtOf.get(p.load.id);
      if (created === undefined) ledger.leadErrors.push(`load ${p.load.id} completed but never created`);
      else if (Math.abs(p.leadTime - Math.max(0, p.t - created)) > 1e-9) ledger.leadErrors.push(`load ${p.load.id}: lead ${p.leadTime} != ${p.t} - ${created}`);
      if (p.load.tk >= 0) {
        // a pallet of a truck is born when the truck arrives: its lead time contains the wait at the gate and the check-in
        const life = ledger.trucks.get(p.load.tk);
        const desk = life && ledger.sim.logistics.stationById.get(life.station).trucks;
        if (!life) ledger.leadErrors.push(`pallet ${p.load.id} carries the id of truck ${p.load.tk}, which never arrived`);
        else if (created !== life.at) ledger.leadErrors.push(`pallet ${p.load.id} of truck ${p.load.tk} created at ${created}, the truck arrived at ${life.at}`);
        else if (life.dockedAt < 0 || p.leadTime < life.dockedAt - life.at + desk.checkIn - 1e-6) ledger.leadErrors.push(`pallet ${p.load.id}: lead ${p.leadTime} is less than gate wait ${life.dockedAt - life.at} + check-in ${desk.checkIn}`);
      }
      ledger.createdAtOf.delete(p.load.id);
    } else if (name.startsWith('truck')) {
      grammar(ledger, name, p);
      if (ledger.windowStart !== Infinity) {
        const w = ledger.windowOf(p.stationId);
        switch (name) {
          case 'truckArrived': w.arrived++; break;
          case 'truckDocked': w.docked++; w.waits.push(Math.max(0, p.wait)); break;
          case 'truckNoShow': w.noShow++; break;
          case 'truckTurnedAway': w.turnedAway++; break;
          case 'truckDeparted':
            w.departed++; w.doors.push(Math.max(0, p.doorTime)); w.turns.push(Math.max(0, p.turnaround));
            if (ledger.sim.logistics.stationById.get(p.stationId).trucks.role === 'out') { w.planned += p.truck.plan; w.loaded += p.truck.loaded; if (p.short) w.short++; }
            break;
          default: break;
        }
      }
      const s = station(p.stationId);
      switch (name) {
        case 'truckArrived': s.arrived++; s.arrivals.push(p.at); s.planSum += p.truck.plan; break;
        case 'truckDocked': s.docked++; s.gateWaits.push(p.wait); s.dockedLog.push({ id: p.truck.id, t: p.t, door: p.door, at: p.truck.at }); break;
        case 'truckReady': s.ready++; break;
        case 'truckDeparted':
          s.departed++;
          s.doorTimes.push(p.doorTime);
          s.turnarounds.push(p.turnaround);
          if (p.short) s.short++;
          s.plannedOfDeparted += p.truck.plan;
          s.loadedSum += p.truck.loaded;
          break;
        case 'truckNoShow': s.noShow++; break;
        case 'truckTurnedAway': s.turnedAway++; break;
        default: break;
      }
    }
  });
  return ledger;
}

/**
 * The life of a truck as the events tell it: arrived, docked, ready, departed - each once, in this order, at non-decreasing times; the nominal
 * arrival time is the same in every event of the truck; arrivals of one station come in non-decreasing nominal time; a door is never used by
 * two trucks at once; the arithmetic of the departure payload (turnaround = gate wait + door time).
 */
function grammar(ledger, name, p) {
  const bad = (m) => ledger.problems.push(`${name} ${p.stationId} t=${p.t}: ${m}`);
  if (name === 'truckNoShow' || name === 'truckTurnedAway') {
    if (!(p.at <= p.t + 1e-9)) bad(`nominal time ${p.at} after the tick ${p.t}`);
    return;
  }
  const k = p.truck;
  let life = ledger.trucks.get(k.id);
  if (name === 'truckArrived') {
    if (life) bad(`truck ${k.id} arrived twice`);
    const last = ledger.lastArrivalAt.get(p.stationId);
    if (last !== undefined && p.at < last - 1e-9) bad(`arrival at ${p.at} after one at ${last}`);
    ledger.lastArrivalAt.set(p.stationId, p.at);
    if (!(p.at <= p.t + 1e-9)) bad(`nominal arrival ${p.at} after the tick ${p.t}`);
    ledger.trucks.set(k.id, { station: p.stationId, at: p.at, stage: 1, t: p.t, door: -1, dockedAt: -1 });
    return;
  }
  if (!life) { bad(`truck ${k.id} has no arrival`); return; }
  if (life.station !== p.stationId) bad(`truck ${k.id} changed station`);
  if (p.t < life.t - 1e-9) bad(`time goes back (${p.t} < ${life.t})`);
  life.t = p.t;
  if (name === 'truckDocked') {
    if (life.stage !== 1) bad(`docked at stage ${life.stage}`);
    life.stage = 2; life.door = p.door; life.dockedAt = p.t;
    if (Math.abs(p.wait - (p.t - life.at)) > 1e-9) bad(`wait ${p.wait} != ${p.t} - ${life.at}`);
    if (p.wait < -1e-9) bad(`negative wait ${p.wait}`);
    for (const [id, other] of ledger.trucks) if (id !== k.id && other.station === p.stationId && other.stage >= 2 && other.stage < 4 && other.door === p.door) bad(`door ${p.door} used by trucks ${id} and ${k.id}`);
  } else if (name === 'truckReady') {
    if (life.stage !== 2) bad(`ready at stage ${life.stage}`);
    life.stage = 3;
    ledger.readyAt.set(k.id, p.t);
    const desk = ledger.sim.logistics.stationById.get(p.stationId).trucks;
    const spent = p.t - life.dockedAt;
    if (spent < desk.checkIn - 1e-6 || spent > desk.checkIn + ledger.sim.dt + 1e-6) bad(`check-in took ${spent} s, the setting is ${desk.checkIn} s`);
  } else if (name === 'truckDeparted') {
    if (life.stage !== 3) bad(`departed at stage ${life.stage}`);
    life.stage = 4;
    if (Math.abs(p.turnaround - (p.gateWait + p.doorTime)) > 1e-6) bad(`turnaround ${p.turnaround} != gate ${p.gateWait} + door ${p.doorTime}`);
    if (Math.abs(p.doorTime - (p.t - life.dockedAt)) > 1e-6) bad(`door time ${p.doorTime} != ${p.t} - ${life.dockedAt}`);
    const desk = ledger.sim.logistics.stationById.get(p.stationId).trucks;
    if (p.doorTime < desk.checkIn + desk.checkOut - 1e-6) bad(`door time ${p.doorTime} is less than check-in ${desk.checkIn} + check-out ${desk.checkOut}`);
    if (desk.role === 'out') {
      // a Goods out truck leaves full, or short only after it has waited maxDwell for its pallets (maxDwell 0: never short)
      if (p.short && desk.maxDwell === 0) bad(`truck ${k.id} left short although maxDwell is 0 (until full)`);
      if (p.short && p.doorTime < desk.checkIn + desk.maxDwell + desk.checkOut - ledger.sim.dt - 1e-6) bad(`truck ${k.id} left short after ${p.doorTime} s, before check-in + maxDwell + check-out = ${desk.checkIn + desk.maxDwell + desk.checkOut}`);
      if (!p.short && k.loaded !== k.plan) bad(`truck ${k.id} left "full" with ${k.loaded}/${k.plan}`);
      if (p.short && k.loaded >= k.plan) bad(`truck ${k.id} left "short" with ${k.loaded}/${k.plan}`);
    }
    if (Math.abs(p.gateWait - (life.dockedAt - life.at)) > 1e-6) bad(`gate wait ${p.gateWait} != ${life.dockedAt} - ${life.at}`);
  }
}

// ---- the audit ---------------------------------------------------------------------------------------------------------------------------

const EPS = 1e-6;
const fifoMemory = new WeakMap(); // desk -> Map(truck id -> loaded at the end of the previous audited tick)

/** Every load that physically exists in the plant, with where it is (own traversal; no helper of the engine). */
function allLoads(lg) {
  const found = [];
  const add = (where, list) => { for (const load of list) found.push({ load, where }); };
  for (const st of lg.stations) {
    if (st.yardQ) add(`${st.id}.yard`, st.yardQ);
    if (st.pool) add(`${st.id}.pool`, st.pool);
    for (const link of st.outLinks) add(`${st.id}.out`, link.queue);
    for (const link of st.inLinks) add(`${st.id}.in`, link.queue);
    for (const m of st.machines || []) add(`${st.id}.holding`, m.holding);
    if (st.trucks) {
      for (const k of [...st.trucks.gate, ...st.trucks.docked]) add(`${st.id}.truck${k.id}`, k.pending);
      add(`${st.id}.staged`, st.trucks.staged);
    }
  }
  for (const vr of lg.vehicles) add(`${vr.id}`, vr.load);
  return found;
}

/**
 * Check the plant after a tick. Throws an Error that names the first few violations.
 * @param {object} sim a Simulation
 * @param {object} [ledger] from makeLedger (extra cross-checks against the events)
 * @param {string} [label]
 */
export function audit(sim, ledger = null, label = '', tally = null) {
  const lg = sim.logistics;
  const bad = [];
  const fail = (m) => bad.push(m);

  // ---- conservation, from the raw state
  const found = allLoads(lg);
  const ids = new Set();
  for (const { load, where } of found) {
    if (ids.has(load.id)) fail(`load ${load.id} exists twice (${where})`);
    ids.add(load.id);
  }
  let inCycles = 0;
  for (const st of lg.stations) for (const m of st.machines || []) inCycles += m.inputs;
  const created = lg.createdBySources + lg.createdByProcesses;
  if (lg.liveLoads !== found.length + inCycles) fail(`live ${lg.liveLoads} != present ${found.length} + in cycles ${inCycles}`);
  if (created !== lg.liveLoads + lg.completed + lg.loadsConsumed) fail(`created ${created} != live ${lg.liveLoads} + completed ${lg.completed} + consumed ${lg.loadsConsumed}`);
  if (ledger) {
    if (ledger.created !== created) fail(`loadCreated events ${ledger.created} != created ${created}`);
    if (ledger.completed !== lg.completed) fail(`loadCompleted events ${ledger.completed} != completed ${lg.completed}`);
    for (const m of ledger.leadErrors) fail(m);
    ledger.leadErrors.length = 0;
    for (const m of ledger.problems) fail(m);
    ledger.problems.length = 0;
  }

  // ---- the trucks
  for (const st of lg.stations) {
    const desk = st.trucks;
    if (desk === null) {
      if (st.type === 'source' || st.type === 'sink') continue;
      continue;
    }
    if (!(desk instanceof TruckDesk)) { fail(`${st.id}: st.trucks is not a TruckDesk`); continue; }
    const tag = `${st.id}`;
    const { gate, docked, staged } = desk;
    if (docked.length > desk.doorsOpen()) fail(`${tag}: ${docked.length} docked > ${desk.doorsOpen()} doors open`);
    if (docked.length > desk.doors) fail(`${tag}: ${docked.length} docked > ${desk.doors} doors`);
    // FIFO: arrival order at the gate, and nobody docked while an earlier arrival waits
    for (let i = 1; i < gate.length; i++) if (gate[i - 1].id >= gate[i].id || gate[i - 1].at > gate[i].at + EPS) fail(`${tag}: gate not FIFO at ${i}`);
    if (gate.length > 0) for (const k of docked) if (k.id > gate[0].id) fail(`${tag}: truck ${k.id} docked while truck ${gate[0].id} waits`);
    const doors = new Set();
    for (const k of docked) {
      if (doors.has(k.door)) fail(`${tag}: door ${k.door} used twice`);
      doors.add(k.door);
      if (!(k.door >= 0 && k.door < desk.doors)) fail(`${tag}: door number ${k.door} outside 0..${desk.doors - 1}`);
      if (k.dockedAt + EPS < k.at) fail(`${tag}: truck ${k.id} docked at ${k.dockedAt} before arriving at ${k.at}`);
      if (k.dockedAt > sim.time + EPS) fail(`${tag}: truck ${k.id} docked in the future`);
    }
    // a rate-mode station keeps a next arrival while the demand is positive
    if (desk.mode === 'rate' && lg.runtime.demandFactor > 0 && !Number.isFinite(desk.nextArrival)) fail(`${tag}: rate mode with demand ${lg.runtime.demandFactor} but no next arrival`);
    const yardOf = new Map(); // truck id -> pallets present in yard / buffers / pending
    const count = (list) => { for (const l of list) if (l.tk >= 0) yardOf.set(l.tk, (yardOf.get(l.tk) || 0) + 1); };
    if (st.yardQ) count(st.yardQ);
    for (const link of st.outLinks) count(link.queue);
    for (const k of [...gate, ...docked]) count(k.pending);
    // pallets of a truck that has left the plant do not exist (the truck is gone only when left == 0)
    const known = new Set([...gate, ...docked].map((k) => k.id));
    if (desk.role === 'in') {
      for (const id of yardOf.keys()) if (!known.has(id)) fail(`${tag}: pallets of departed truck ${id} still here`);
      for (const k of [...gate, ...docked]) {
        const here = yardOf.get(k.id) || 0;
        if (k.left !== here) fail(`${tag}: truck ${k.id} left ${k.left} but ${here} pallets are here`);
        if (k.state === 'checkout' && k.left !== 0) fail(`${tag}: truck ${k.id} in check-out with ${k.left} pallets left`);
        if (k.state === 'work' && k.left === 0) fail(`${tag}: truck ${k.id} still at work with nothing left`);
        if (k.loaded !== 0) fail(`${tag}: inbound truck loaded ${k.loaded}`);
      }
      if (staged.length) fail(`${tag}: inbound desk has staged pallets`);
      // the pallets that were created at arrival and have not been picked up: sum over trucks <= created pallets still alive
    } else {
      if (staged.length > desk.stagingCap) fail(`${tag}: staged ${staged.length} > staging space ${desk.stagingCap}`);
      let remaining = 0;
      for (const k of docked) {
        if (k.loaded > k.plan) fail(`${tag}: truck ${k.id} loaded ${k.loaded} > plan ${k.plan}`);
        if (k.state === 'work') remaining += k.plan - k.loaded;
        if (k.state === 'checkin' && k.loaded > 0) fail(`${tag}: truck ${k.id} loaded during check-in`);
        if (k.state === 'checkout' && k.loaded < k.plan && !k.closing) fail(`${tag}: truck ${k.id} left for check-out short without closing`);
        if (k.state === 'work' && k.loaded >= k.plan) fail(`${tag}: truck ${k.id} full but still at work`);
      }
      // closing is a matter of time only: maxDwell after the end of check-in (the first tick that starts at or after it)
      for (const k of docked) {
        if (k.state !== 'work' && k.state !== 'checkout') continue;
        const readyAt = ledger ? ledger.readyAt.get(k.id) : undefined;
        if (readyAt === undefined || desk.maxDwell === 0) continue;
        const shouldClose = sim.time - sim.dt + 1e-9 >= readyAt + desk.maxDwell;
        if (k.state === 'work' && k.closing !== shouldClose) fail(`${tag}: truck ${k.id} closing=${k.closing} but ready at ${readyAt}, maxDwell ${desk.maxDwell}, now ${sim.time}`);
      }
      // flowSpace, from the formula of 6.3.3, for every flow into this Goods out
      let formula = desk.stagingCap - staged.length - st.inboundTotal;
      for (const k of docked) if (k.state === 'work' && !k.closing) formula += k.plan - k.loaded;
      formula = Math.max(0, formula);
      for (const link of st.inbound.keys()) {
        const flow = lg.flowById.get(link);
        if (flow && flowSpace(flow) !== formula) fail(`${tag}: flowSpace ${flowSpace(flow)} != formula ${formula}`);
      }
      // THE reservation invariant: every promised pallet has a place (staging space or a truck's remaining room)
      if (st.inboundTotal > desk.stagingCap - staged.length + remaining) {
        fail(`${tag}: ${st.inboundTotal} pallets are on their way but only ${desk.stagingCap - staged.length} staging + ${remaining} truck places exist`);
      }
      // loaded FIFO: a pallet goes to the earliest-docked truck at work with room, so a later truck gained pallets only if every earlier truck at work is full
      const before = fifoMemory.get(desk) || new Map();
      const now = new Map();
      for (const k of docked) now.set(k.id, k.loaded);
      for (let a = 0; a < docked.length; a++) {
        if (!(docked[a].state === 'work' && docked[a].loaded < docked[a].plan)) continue;
        for (let b = a + 1; b < docked.length; b++) {
          const was = before.get(docked[b].id) ?? 0;
          if (docked[b].loaded > was && before.has(docked[a].id)) fail(`${tag}: truck ${docked[b].id} was loaded (${was} -> ${docked[b].loaded}) while the earlier truck ${docked[a].id} at work has room (${docked[a].loaded}/${docked[a].plan})`);
        }
      }
      fifoMemory.set(desk, now);
      // staged pallets only wait when no truck at work can take them
      if (staged.length > 0 && docked.some((k) => k.state === 'work' && k.loaded < k.plan)) fail(`${tag}: ${staged.length} pallets staged although a truck at work has room`);
      for (const l of staged) if (l.claimed) fail(`${tag}: staged pallet claimed`);
      // a Goods out pallet is loaded or staged: it never sits in an output buffer there
    }
    // counters of the desk against its lists
    if (desk.arrived !== gate.length + desk.nDocked) fail(`${tag}: arrived ${desk.arrived} != gate ${gate.length} + docked ${desk.nDocked}`);
    if (desk.nDocked - desk.departed !== docked.length) fail(`${tag}: docked ${desk.nDocked} - departed ${desk.departed} != ${docked.length}`);
    if (desk.short > desk.departed) fail(`${tag}: short > departed`);
    if (ledger) {
      const s = ledger.station(st.id);
      if (s.arrived !== desk.arrived || s.docked !== desk.nDocked || s.departed !== desk.departed || s.short !== desk.short || s.noShow !== desk.noShow || s.turnedAway !== desk.turnedAway) {
        fail(`${tag}: events (${s.arrived}/${s.docked}/${s.departed}/${s.short}/${s.noShow}/${s.turnedAway}) != counters (${desk.arrived}/${desk.nDocked}/${desk.departed}/${desk.short}/${desk.noShow}/${desk.turnedAway})`);
      }
    }
    if (tally) {
      if (docked.length === desk.doors) tally.allDoorsBusy++;
      if (gate.length > 0) tally.gateQueue++;
      if (staged.length > 0) tally.staged++;
      if (docked.some((k) => k.closing)) tally.closing++;
      if (docked.some((k) => k.state === 'checkin')) tally.checkIn++;
      if (desk.role === 'out' && st.inboundTotal > 0) tally.inbound++;
      if (desk.role === 'out' && st.inboundTotal > 0 && docked.some((k) => k.closing && k.state === 'work')) tally.closingWaits++;
      if (desk.role === 'out' && docked.some((k) => k.state === 'work')) tally.outWork++;
      if (desk.role === 'in' && st.yardQ.length > 0) tally.yard++;
    }
    const room = st.type === 'sink' ? desk.room(st) : 0;
    if (!(room >= 0) || !Number.isFinite(room)) fail(`${tag}: room ${room}`);
  }
  if (bad.length > 0) throw new Error(`audit failed${label ? ` (${label})` : ''} at t=${sim.time.toFixed(2)}:\n  ${bad.slice(0, 8).join('\n  ')}`);
}

// ---- report.ops against the ledger -------------------------------------------------------------------------------------------------------

const close = (a, b) => (a === null || b === null ? a === b : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)));

/**
 * Compare report.ops.trucks with what the ledger saw (events and the per-tick integrals of the measurement window). Returns the differences.
 * @returns {string[]}
 */
export function compareOps(sim, report, ledger) {
  const diffs = [];
  const trucks = (report.ops && report.ops.trucks) || {};
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const pct = (a) => { if (!a.length) return null; const set = new SampleSet(); for (const v of a) set.add(v); return set.percentile(0.9); };
  for (const st of sim.logistics.stations) {
    if (st.trucks === null) continue;
    const r = trucks[st.id];
    const tag = st.id;
    if (!r) { diffs.push(`${tag}: no entry in report.ops.trucks`); continue; }
    const w = ledger.windowOf(st.id);
    const cell = ledger.integral.get(st.id) || { gate: 0, docked: 0, gateMax: 0 };
    const dur = ledger.duration;
    const eq = (what, got, want) => { if (!close(got, want)) diffs.push(`${tag}: ${what} ${got} != ${want}`); };
    for (const key of ['arrived', 'docked', 'departed', 'short', 'noShow', 'turnedAway']) eq(key, r.trucks[key], w[key]);
    eq('gateWait.mean', r.gateWait.mean, mean(w.waits));
    eq('gateWait.max', r.gateWait.max, w.waits.length ? Math.max(...w.waits) : null);
    eq('gateWait.p90', r.gateWait.p90, pct(w.waits));
    eq('doorTime.mean', r.doorTime.mean, mean(w.doors));
    eq('doorTime.p90', r.doorTime.p90, pct(w.doors));
    eq('turnaround.mean', r.turnaround.mean, mean(w.turns));
    eq('turnaround.p90', r.turnaround.p90, pct(w.turns));
    eq('doorUtilization', r.doorUtilization, dur > 0 ? Math.min(1, cell.docked / (st.trucks.doors * dur)) : 0);
    eq('gateQueue.mean', r.gateQueue.mean, dur > 0 ? cell.gate / dur : 0);
    eq('gateQueue.max', r.gateQueue.max, Math.max(cell.gateMax, st.trucks.gate.length));
    eq('gateQueue.now', r.gateQueue.now, st.trucks.gate.length);
    eq('doorsBusyNow', r.doorsBusyNow, st.trucks.docked.length);
    eq('fillRate', r.fillRate, st.trucks.role === 'out' && w.planned > 0 ? Math.min(1, w.loaded / w.planned) : null);
    if (r.role !== st.trucks.role || r.doors !== st.trucks.doors) diffs.push(`${tag}: role/doors ${r.role}/${r.doors}`);
  }
  return diffs;
}

// ---- running -----------------------------------------------------------------------------------------------------------------------------

/**
 * Step a simulation tick by tick for `seconds`, apply the planned actions when the clock reaches them, and audit after every tick.
 * @param {object} sim Simulation
 * @param {number} seconds
 * @param {{ actions?: Array, ledger?: object, every?: number, label?: string }} [opts]
 */
export function runAudited(sim, seconds, { actions = [], ledger = null, every = 1, label = '', tally = null } = {}) {
  const pending = [...actions].sort((a, b) => a.at - b.at);
  const end = sim.time + seconds - sim.dt * 1e-6;
  let n = 0;
  while (sim.time < end) {
    while (pending.length > 0 && pending[0].at <= sim.time + 1e-9) {
      const removed = apply(sim, pending.shift());
      if (removed && ledger) ledger.restart();
    }
    sim.step();
    if (ledger) ledger.tick();
    if (++n % every === 0) audit(sim, ledger, label, tally);
  }
  audit(sim, ledger, label, tally);
}

function apply(sim, action) {
  if (action.kind === 'demand') {
    if (action.value === 0) sim.logistics.setRuntime({ demandFactor: 0 }); // the engine's setRuntime clamps to 0.05; only the brain accepts 0
    else sim.setRuntime({ demandFactor: action.value });
  } else if (action.kind === 'removeVehicle') {
    const vehicles = sim.logistics.vehicles;
    if (vehicles.length > 0) return sim.logistics.removeVehicle(vehicles[action.index % vehicles.length]);
  }
  return false;
}

// ---- generic helpers ---------------------------------------------------------------------------------------------------------------------

/** A fresh coverage tally for runAudited: how many audited tick x station states had each corner. */
export const newTally = () => ({ allDoorsBusy: 0, gateQueue: 0, staged: 0, closing: 0, closingWaits: 0, checkIn: 0, inbound: 0, outWork: 0, yard: 0 });

/** Every number inside `value` with its path. */
export function walk(value, path = '$', out = []) {
  if (typeof value === 'number') out.push([path, value]);
  else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`, out);
  return out;
}

/** Paths of the numbers that are not finite. */
export function nonFinite(value) {
  return walk(value).filter(([, n]) => !Number.isFinite(n)).map(([p, n]) => `${p}=${n}`);
}

/** Everything observable at the end of a run as text: kpis, ops, the truck events (names, nominal times, ids). */
export function digest(sim, ledger = null) {
  const kpis = sim.kpis();
  const events = ledger ? ledger.events.map((e) => `${e.name}:${e.stationId ?? ''}:${e.truckId ?? ''}:${(e.t ?? 0).toFixed(6)}`).join('|') : '';
  return `${JSON.stringify(kpis)}#${events}`;
}
